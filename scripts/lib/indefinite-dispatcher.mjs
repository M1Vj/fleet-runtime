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

export function isPrivateOrReservedHost(hostname) {
  const host = String(hostname || "").toLowerCase().trim().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host === "metadata.google.internal" || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [_, a, b, c, d] = ipv4Match.map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) return true;
    if (a === 0 || a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
  }
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc00:") || host.startsWith("fd00:")) {
    return true;
  }
  return false;
}

function normalizeProxyRoute(proxyUrl) {
  if (typeof proxyUrl !== "string") return null;
  const value = proxyUrl.trim();
  if (!value || value.length > 512 || value.startsWith("#")) return null;
  try {
    const raw = value.startsWith("http://") || value.startsWith("https://") ? value : `http://${value}`;
    const parsed = new URL(raw);
    const port = Number(parsed.port) || 80;
    if (!parsed.hostname || port <= 0 || port > 65535) return null;
    if (isPrivateOrReservedHost(parsed.hostname)) return null;
    return `http://${parsed.hostname.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

export const HARVEST_SOURCES = [
  "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
  "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
  "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/http_proxies.txt",
  "https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/http.txt",
];

export function isMitmOrCertError(reason = "") {
  const r = String(reason || "").toLowerCase();
  return (
    r.includes("cert") ||
    r.includes("self-signed") ||
    r.includes("self_signed") ||
    r.includes("self signed") ||
    r.includes("unable to verify") ||
    r.includes("unable_to_verify") ||
    r.includes("eproto") ||
    r.includes("depth_zero") ||
    r.includes("tls") ||
    r.includes("mitm")
  );
}

export function harvestProxiesFromUrl(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const client = parsed.protocol === "http:" ? http : https;
      const req = client.get(url, { timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve([]);
        }
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > 512 * 1024) {
            req.destroy();
            resolve([]);
          }
        });
        res.on("end", () => {
          const lines = data.split("\n").map((l) => l.trim()).filter(Boolean);
          const parsedLines = lines.map(normalizeProxyRoute).filter(Boolean);
          resolve(parsedLines);
        });
      });
      req.on("error", () => resolve([]));
      req.on("timeout", () => { req.destroy(); resolve([]); });
    } catch {
      resolve([]);
    }
  });
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
    let cooldown = customCooldownMs > 0 ? customCooldownMs : Math.min(600000, this.defaultCooldownMs * Math.pow(2, Math.min(5, s.failures - 1)));
    if (isMitmOrCertError(reason)) {
      cooldown = Math.max(cooldown, 15 * 60 * 1000);
      s.state = "open";
    } else if (s.failures >= 3) {
      s.state = "open";
    }
    s.cooldownUntil = this.now() + cooldown;
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

  pickCandidate(excludeSet = null, affinityKey = null) {
    if (affinityKey && this.affinityMap.has(affinityKey)) {
      const preferred = this.affinityMap.get(affinityKey);
      if (!excludeSet || !excludeSet.has(preferred)) {
        const s = this.stats.get(preferred);
        if (s && s.cooldownUntil <= this.now() && s.latencyEwma <= this.maxAffinityLatencyMs) {
          return preferred;
        }
      }
    }
    const healthy = this.getHealthyProxies(excludeSet);
    if (healthy.length === 0) return null;
    healthy.sort((a, b) => {
      const sA = this.stats.get(a)?.latencyEwma ?? 1000;
      const sB = this.stats.get(b)?.latencyEwma ?? 1000;
      return sA - sB;
    });
    const chosen = healthy[0];
    if (affinityKey && chosen) {
      this.affinityMap.set(affinityKey, chosen);
    }
    return chosen;
  }

  async harvest(sources = HARVEST_SOURCES, options = {}) {
    const timeoutMs = options.timeoutMs || 4000;
    const added = [];
    const existing = new Set(this.proxies);
    for (const src of sources) {
      const candidates = await harvestProxiesFromUrl(src, timeoutMs);
      for (const c of candidates) {
        if (!existing.has(c)) {
          existing.add(c);
          this.proxies.push(c);
          this.ensureStats(c);
          added.push(c);
        }
      }
      if (added.length >= 100) break;
    }
    return added;
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

    if (url.pathname === "/harvest" && req.method === "POST") {
      pool.harvest().then((added) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", added: added.length, total: pool.proxies.length }));
      }).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
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
    const affinityKey = req.headers ? (req.headers["x-session-id"] || req.headers["session-id"] || req.headers["x-correlation-id"] || null) : null;

    const isApiHost = targetHost === "opencode.ai";
    const useDirect = !isApiHost || !pool.isDirectRateLimited();

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
      const candidate = pool.pickCandidate(tried, affinityKey);
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
          const customCooldown = (res.statusCode === 407 || res.statusCode === 403) ? 15 * 60 * 1000 : 0;
          pool.recordFailure(candidate, `STATUS_${res.statusCode}`, customCooldown);
          tryNextProxy();
          return;
        }

        connected = true;
        if (proxySocket.unref) proxySocket.unref();
        const latency = Date.now() - t0;
        pool.recordSuccess(candidate, latency);
        logger("INFO", `[TUNNEL_ESTABLISHED] Connected via ${candidate} (${latency}ms) to ${target}`);

        let firstByteReceived = false;
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length > 0) proxySocket.write(head);
        proxySocket.pipe(clientSocket);
        clientSocket.pipe(proxySocket);

        // Fast-fail handshake watchdog: if proxy stalls on TLS handshake after 200 CONNECT, kill in 3000ms
        const handshakeTimer = setTimeout(() => {
          if (!firstByteReceived) {
            pool.recordFailure(candidate, "TLS_HANDSHAKE_STALL", 300000);
            proxySocket.destroy();
            clientSocket.destroy();
          }
        }, 3000);

        proxySocket.once("data", () => {
          firstByteReceived = true;
          clearTimeout(handshakeTimer);
        });

        proxySocket.setTimeout(180000, () => {
          clearTimeout(handshakeTimer);
          proxySocket.destroy();
          clientSocket.destroy();
        });
        clientSocket.setTimeout(180000, () => {
          clearTimeout(handshakeTimer);
          clientSocket.destroy();
          proxySocket.destroy();
        });

        proxySocket.on("error", () => {
          clearTimeout(handshakeTimer);
          clientSocket.destroy();
        });
        clientSocket.on("error", () => {
          clearTimeout(handshakeTimer);
          proxySocket.destroy();
        });
        proxySocket.on("close", () => {
          clearTimeout(handshakeTimer);
          clientSocket.destroy();
        });
        clientSocket.on("close", () => {
          clearTimeout(handshakeTimer);
          proxySocket.destroy();
        });
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        pool.recordFailure(candidate, "TIMEOUT");
        tryNextProxy();
      });

      proxyReq.on("error", (err) => {
        const customCooldown = isMitmOrCertError(err.message) ? 15 * 60 * 1000 : 0;
        pool.recordFailure(candidate, err.message, customCooldown);
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
