import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { URL, fileURLToPath } from "node:url";

import { sanitizeRequestBody } from "./request-sanitizer.mjs";
import {
  DEFAULT_MODEL_CHAIN,
  classifyProviderResponse,
} from "../../packages/indefinite-core/index.mjs";

const DEFAULT_PORT = 58444;
const DEFAULT_HOST = "127.0.0.1";

function normalizeProxyRoute(proxyUrl) {
  if (typeof proxyUrl !== "string") return null;
  const value = proxyUrl.trim();
  if (!value || value.length > 512 || value.startsWith("#")) return null;
  try {
    const raw = value.startsWith("http://") || value.startsWith("https://") ? value : `http://${value}`;
    const parsed = new URL(raw);
    const port = Number(parsed.port) || 80;
    if (!parsed.hostname || port <= 0 || port > 65535) return null;
    return `http://${parsed.hostname.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

export class ProxyPool {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.proxies = [];
    this.stats = new Map();
    this.alpha = 0.25;
    this.defaultCooldownMs = options.defaultCooldownMs || 60000;
    this.directRateLimitedUntil = 0;
    this.affinityMap = new Map();
    this.maxAffinityLatencyMs = options.maxAffinityLatencyMs || 2500;
    if (filePath) this.reload();
  }

  loadProxiesFromLines(lines) {
    const parsed = (lines || [])
      .map(normalizeProxyRoute)
      .filter(Boolean);
    this.proxies = [...new Set(parsed)];
    for (const p of this.proxies) {
      this.ensureStats(p);
    }
  }

  reload() {
    try {
      if (!this.filePath || !fs.existsSync(this.filePath)) {
        this.proxies = [];
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
      this.loadProxiesFromLines(lines);
    } catch {
      this.proxies = [];
    }
  }

  ensureStats(proxyUrl) {
    if (!this.stats.has(proxyUrl)) {
      this.stats.set(proxyUrl, {
        latencyEwma: 1000,
        failures: 0,
        state: "closed",
        cooldownUntil: 0,
        successes: 0,
        lastSuccessAt: 0,
        lastFailureAt: 0,
      });
    }
    return this.stats.get(proxyUrl);
  }

  recordSuccess(proxyUrl, latencyMs = 0) {
    const s = this.ensureStats(proxyUrl);
    s.successes++;
    s.lastSuccessAt = this.now();
    s.cooldownUntil = 0;
    s.failures = 0;
    s.state = "closed";
    const sample = Math.max(1, Number(latencyMs) || 0);
    s.latencyEwma = s.latencyEwma ? Math.round(this.alpha * sample + (1 - this.alpha) * s.latencyEwma) : sample;
  }

  recordFailure(proxyUrl, reason = "FAILED", customCooldownMs = 0) {
    const s = this.ensureStats(proxyUrl);
    s.failures++;
    s.lastFailureAt = this.now();
    const cooldown = customCooldownMs > 0 ? customCooldownMs : Math.min(600000, this.defaultCooldownMs * Math.pow(2, Math.min(5, s.failures - 1)));
    s.cooldownUntil = this.now() + cooldown;
    if (s.failures >= 3) s.state = "open";
  }

  isDirectRateLimited() {
    return this.directRateLimitedUntil > this.now();
  }

  setDirectRateLimited(retryAtMs) {
    this.directRateLimitedUntil = Math.max(this.directRateLimitedUntil, Number(retryAtMs) || (this.now() + 60000));
  }

  getHealthyProxies(excludeSet = null) {
    const now = this.now();
    return this.proxies.filter((p) => {
      if (excludeSet && excludeSet.has(p)) return false;
      const s = this.stats.get(p);
      return s && s.cooldownUntil <= now;
    });
  }

  pickCandidate(excludeSet = null) {
    const healthy = this.getHealthyProxies(excludeSet);
    if (healthy.length === 0) return null;
    healthy.sort((a, b) => {
      const sA = this.stats.get(a)?.latencyEwma ?? 1000;
      const sB = this.stats.get(b)?.latencyEwma ?? 1000;
      return sA - sB;
    });
    return healthy[0];
  }
}

let activeDispatcherInstance = null;

export function getDispatcherInstance() {
  return activeDispatcherInstance;
}

export function startIndefiniteDispatcher(options = {}) {
  if (activeDispatcherInstance) {
    return activeDispatcherInstance;
  }

  const port = Number(options.port || process.env.FLEET_DISPATCHER_PORT || DEFAULT_PORT);
  const host = options.host || DEFAULT_HOST;
  const stateRoot = options.stateRoot || process.env.FLEET_STATE_ROOT || process.cwd();
  const logger = typeof options.logger === "function" ? options.logger : (level, msg) => {
    if (process.env.FLEET_OPENCODE_DEBUG === "1" || process.env.FLEET_DIAG_LOG === "1") {
      process.stderr.write(`[INDEFINITE_DISPATCHER][${level}] ${msg}\n`);
    }
  };

  let proxyPath = options.proxyFile || process.env.FLEET_PROXY_FILE;
  if (!proxyPath) {
    const candidates = [
      path.join(stateRoot, "state", "fleet-proxies.txt"),
      path.join(process.cwd(), "state", "fleet-proxies.txt"),
      path.join(process.cwd(), "..", "state", "fleet-proxies.txt"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        proxyPath = c;
        break;
      }
    }
  }

  const pool = new ProxyPool(proxyPath, {
    defaultCooldownMs: 60000,
  });

  const activeSockets = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);

    if (url.pathname === "/health" || url.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        status: "healthy",
        service: "fleet-indefinite-dispatcher",
        port,
        healthyProxies: pool.getHealthyProxies().length,
        totalProxies: pool.proxies.length,
        directRateLimited: pool.isDirectRateLimited(),
      }));
    }

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks);
      const sanitizedBody = sanitizeRequestBody(rawBody, "req_" + Date.now());

      const targetHost = req.headers.host || "opencode.ai";
      const forwardHeaders = { ...req.headers };
      delete forwardHeaders.host;
      forwardHeaders["content-length"] = sanitizedBody.length;

      const directOptions = {
        hostname: targetHost,
        port: 80,
        path: req.url,
        method: req.method,
        headers: forwardHeaders,
        timeout: 120000,
      };

      const forwardReq = http.request(directOptions, (forwardRes) => {
        res.writeHead(forwardRes.statusCode, forwardRes.headers);
        forwardRes.pipe(res);
      });

      forwardReq.on("error", (err) => {
        logger("WARN", `HTTP forward error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { type: "BadGateway", message: err.message } }));
        }
      });

      forwardReq.write(sanitizedBody);
      forwardReq.end();
    });
  });

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    if (socket.unref) socket.unref();
    if (socket.setNoDelay) socket.setNoDelay(true);
    socket.on("close", () => activeSockets.delete(socket));
  });

  // HTTPS CONNECT Tunneling
  server.on("connect", (req, clientSocket, head) => {
    activeSockets.add(clientSocket);
    if (clientSocket.unref) clientSocket.unref();
    clientSocket.on("close", () => activeSockets.delete(clientSocket));
    if (clientSocket.setNoDelay) clientSocket.setNoDelay(true);

    const match = /^([^\s:/?#@]+):(\d{1,5})$/.exec(req.url);
    if (!match) {
      clientSocket.destroy();
      return;
    }
    const targetHost = match[1];
    const targetPort = Number(match[2]);
    const target = `${targetHost}:${targetPort}`;

    const useDirect = !pool.isDirectRateLimited() && (pool.proxies.length === 0 || targetHost !== "opencode.ai");

    if (useDirect) {
      const directSocket = net.connect(targetPort, targetHost, () => {
        if (directSocket.unref) directSocket.unref();
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length > 0) directSocket.write(head);
        directSocket.pipe(clientSocket);
        clientSocket.pipe(directSocket);
      });
      directSocket.setTimeout(180000, () => {
        directSocket.destroy();
        clientSocket.destroy();
      });
      clientSocket.setTimeout(180000, () => {
        clientSocket.destroy();
        directSocket.destroy();
      });
      directSocket.on("error", (err) => {
        logger("WARN", `Direct CONNECT to ${target} failed: ${err.message}`);
        clientSocket.destroy();
      });
      clientSocket.on("error", () => directSocket.destroy());
      directSocket.on("close", () => clientSocket.destroy());
      return;
    }

    let attempt = 0;
    const maxAttempts = Math.min(6, Math.max(1, pool.getHealthyProxies().length));
    const tried = new Set();
    let connected = false;

    function tryNextProxy() {
      if (connected || clientSocket.destroyed) return;
      attempt++;
      const candidate = pool.pickCandidate(tried);
      if (candidate) tried.add(candidate);

      if (!candidate || attempt > maxAttempts) {
        logger("INFO", `[TUNNEL_FALLBACK_DIRECT] Proxies exhausted, connecting directly to ${target}`);
        const fallbackSocket = net.connect(targetPort, targetHost, () => {
          if (fallbackSocket.unref) fallbackSocket.unref();
          connected = true;
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head && head.length > 0) fallbackSocket.write(head);
          fallbackSocket.pipe(clientSocket);
          clientSocket.pipe(fallbackSocket);
        });
        fallbackSocket.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => fallbackSocket.destroy());
        fallbackSocket.on("close", () => clientSocket.destroy());
        return;
      }

      const pu = new URL(candidate);
      const t0 = Date.now();

      const proxyReq = http.request({
        host: pu.hostname,
        port: pu.port,
        method: "CONNECT",
        path: target,
        timeout: 3500,
      });

      proxyReq.on("connect", (res, proxySocket) => {
        if (connected || clientSocket.destroyed) {
          proxySocket.destroy();
          return;
        }
        if (res.statusCode !== 200) {
          proxySocket.destroy();
          pool.recordFailure(candidate, `STATUS_${res.statusCode}`);
          tryNextProxy();
          return;
        }

        connected = true;
        if (proxySocket.unref) proxySocket.unref();
        const latency = Date.now() - t0;
        pool.recordSuccess(candidate, latency);
        logger("INFO", `[TUNNEL_ESTABLISHED] Connected via ${candidate} (${latency}ms) to ${target}`);

        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length > 0) proxySocket.write(head);
        proxySocket.pipe(clientSocket);
        clientSocket.pipe(proxySocket);

        proxySocket.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => proxySocket.destroy());
        proxySocket.on("close", () => clientSocket.destroy());
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        pool.recordFailure(candidate, "TIMEOUT");
        tryNextProxy();
      });

      proxyReq.on("error", (err) => {
        pool.recordFailure(candidate, err.message);
        tryNextProxy();
      });

      proxyReq.end();
    }

    tryNextProxy();
  });

  let effectivePort = port;
  const instance = {
    server,
    port: effectivePort,
    host,
    pool,
    stop: () => Promise.resolve(),
  };

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      logger("WARN", `Port ${effectivePort} in use, retrying with ephemeral port (port 0)...`);
      try {
        server.listen(0, host, () => {
          server.unref();
          effectivePort = server.address().port;
          instance.port = effectivePort;
          logger("INFO", `Fleet Indefinite Dispatcher listening on ephemeral port ${host}:${effectivePort}`);
        });
      } catch (listenErr) {
        logger("ERROR", `Failed to bind ephemeral port: ${listenErr.message}`);
      }
    } else {
      logger("ERROR", `Dispatcher server error: ${err.message}`);
    }
  });

  try {
    server.listen(effectivePort, host, () => {
      server.unref();
      effectivePort = server.address().port;
      instance.port = effectivePort;
      logger("INFO", `Fleet Indefinite Dispatcher listening on ${host}:${effectivePort} with ${pool.proxies.length} proxies`);
    });
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      try {
        server.listen(0, host, () => {
          server.unref();
        });
      } catch {}
    }
  }

  const stop = () => {
    return new Promise((resolve) => {
      for (const s of activeSockets) {
        try { s.destroy(); } catch {}
      }
      activeSockets.clear();
      try {
        server.close(() => {
          if (activeDispatcherInstance === instance) {
            activeDispatcherInstance = null;
          }
          resolve();
        });
      } catch {
        resolve();
      }
    });
  };

  instance.stop = stop;
  activeDispatcherInstance = instance;
  return instance;
}

export function stopIndefiniteDispatcher() {
  if (activeDispatcherInstance) {
    const inst = activeDispatcherInstance;
    activeDispatcherInstance = null;
    return inst.stop();
  }
  return Promise.resolve();
}
