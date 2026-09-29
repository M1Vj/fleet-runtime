import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  CONNECT_RELAY_TARGET,
  ProxyPool,
  isAllowedConnectTarget,
  isPrivateOrReservedHost,
  parseConnectTarget,
  startIndefiniteDispatcher,
  stopIndefiniteDispatcher,
} from "../scripts/lib/indefinite-dispatcher.mjs";
import {
  ensureValidJsonString,
  sanitizeRequestBody,
} from "../scripts/lib/request-sanitizer.mjs";

test("ProxyPool handles empty and commented proxy lists gracefully", () => {
  const tmpFile = path.join(tmpdir(), `test-proxies-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, "# Comment line\n\nhttp://198.51.100.1:8080\n# Another comment\n203.0.113.2:3128\n", "utf8");
  try {
    const pool = new ProxyPool(tmpFile);
    assert.equal(pool.proxies.length, 2);
    assert.equal(pool.proxies[0], "http://198.51.100.1:8080");
    assert.equal(pool.proxies[1], "http://203.0.113.2:3128");

    const candidate = pool.pickCandidate();
    assert.ok(candidate);
    assert.ok(pool.getHealthyProxies().includes(candidate));
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("isPrivateOrReservedHost blocks loopback, RFC1918, link-local, and cloud metadata", () => {
  assert.equal(isPrivateOrReservedHost("127.0.0.1"), true);
  assert.equal(isPrivateOrReservedHost("127.0.0.2"), true);
  assert.equal(isPrivateOrReservedHost("localhost"), true);
  assert.equal(isPrivateOrReservedHost("metadata"), true);
  assert.equal(isPrivateOrReservedHost("169.254.169.254"), true);
  assert.equal(isPrivateOrReservedHost("metadata.google.internal"), true);
  assert.equal(isPrivateOrReservedHost("10.0.0.5"), true);
  assert.equal(isPrivateOrReservedHost("172.16.0.1"), true);
  assert.equal(isPrivateOrReservedHost("192.168.1.1"), true);
  assert.equal(isPrivateOrReservedHost("::"), true);
  assert.equal(isPrivateOrReservedHost("::1"), true);
  assert.equal(isPrivateOrReservedHost("0:0:0:0:0:0:0:1"), true);
  assert.equal(isPrivateOrReservedHost("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateOrReservedHost("::ffff:7f00:1"), true);
  assert.equal(isPrivateOrReservedHost("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateOrReservedHost("::ffff:169.254.169.254"), true);
  assert.equal(isPrivateOrReservedHost("fe80::1"), true);
  assert.equal(isPrivateOrReservedHost("fc00::1"), true);
  assert.equal(isPrivateOrReservedHost("2130706433"), true);
  assert.equal(isPrivateOrReservedHost("198.51.100.1"), false);
  assert.equal(isPrivateOrReservedHost("203.0.113.2"), false);
  assert.equal(isPrivateOrReservedHost("::ffff:198.51.100.1"), false);
});

test("ProxyPool tracks latency EWMA and isolates failing proxies", () => {
  const pool = new ProxyPool(null);
  pool.loadProxiesFromLines(["http://proxy-a:8080", "http://proxy-b:8080"]);

  assert.equal(pool.proxies.length, 2);

  // Record success on proxy-a with 200ms latency
  pool.recordSuccess("http://proxy-a:8080", 200);
  const statsA = pool.stats.get("http://proxy-a:8080");
  assert.ok(statsA.latencyEwma < 1000);

  // Record failure on proxy-b
  pool.recordFailure("http://proxy-b:8080", "TIMEOUT", 10000);
  const statsB = pool.stats.get("http://proxy-b:8080");
  assert.equal(statsB.failures, 1);
  assert.ok(statsB.cooldownUntil > Date.now());

  // Healthy proxies should now exclude proxy-b
  const healthy = pool.getHealthyProxies();
  assert.equal(healthy.length, 1);
  assert.equal(healthy[0], "http://proxy-a:8080");

  // pickCandidate should return proxy-a
  assert.equal(pool.pickCandidate(), "http://proxy-a:8080");
});

test("ProxyPool tracks direct rate limiting", () => {
  const pool = new ProxyPool(null);
  assert.equal(pool.isDirectRateLimited(), false);

  pool.setDirectRateLimited(Date.now() + 5000);
  assert.equal(pool.isDirectRateLimited(), true);

  const pool2 = new ProxyPool(null);
  assert.equal(pool2.isDirectRateLimited(), false);
  pool2.recordDirectRateLimited(60000);
  assert.equal(pool2.isDirectRateLimited(), true);
});

function rawConnect(boundPort, target) {
  return new Promise((resolve) => {
    const socket = net.connect(boundPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target.split("\r")[0].split("\n")[0]}\r\n\r\n`);
    });
    socket.once("error", (err) => resolve({ socket, status: "error: " + err.message, head: "" }));
    socket.once("close", () => resolve({ socket, status: "closed", head: "" }));
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end !== -1) {
        socket.removeListener("data", onData);
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        const code = Number((/^HTTP\/1\.\d\s+(\d{3})/.exec(statusLine) || [])[1]);
        resolve({ socket, status: Number.isInteger(code) && code > 0 ? code : statusLine, head: buf.slice(end + 4) });
      }
    };
    socket.on("data", onData);
  });
}

async function rawConnectStatus(boundPort, target) {
  const { socket, status } = await rawConnect(boundPort, target);
  try { socket.destroy(); } catch {}
  return status;
}

async function rawConnectRelay(boundPort, target, payload) {
  const { socket, status, head } = await rawConnect(boundPort, target);
  try {
    assert.equal(status, 200, `CONNECT ${target} must establish with 200, got ${status}`);
    const echoed = await new Promise((resolve, reject) => {
      let buf = head || "";
      const timer = setTimeout(() => reject(new Error("relay echo timeout")), 5000);
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (buf.length >= payload.length) {
          clearTimeout(timer);
          resolve(buf.slice(0, payload.length));
        }
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.write(payload);
    });
    return echoed;
  } finally {
    try { socket.destroy(); } catch {}
  }
}

test("Indefinite Dispatcher lifecycle, health endpoint, and scoped CONNECT relay", async () => {
  const dispatcher = startIndefiniteDispatcher({
    port: 0, // ephemeral port
    stateRoot: tmpdir(),
  });
  assert.ok(dispatcher);
  assert.ok(dispatcher.server);

  try {
    // Wait briefly for server to bind port
    await new Promise((r) => setTimeout(r, 100));
    const boundPort = dispatcher.server.address().port;
    assert.ok(boundPort > 0);

    // Query /health endpoint
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${boundPort}/health`, (resp) => {
        let data = "";
        resp.on("data", (chunk) => { data += chunk; });
        resp.on("end", () => resolve({ status: resp.statusCode, body: data }));
      }).on("error", reject);
    });

    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, "healthy");
    assert.equal(parsed.service, "fleet-indefinite-dispatcher");

    // Scoped CONNECT relay (2026-09-29): only targets normalizing to
    // opencode.ai:443 are relayed via direct TCP; every other target is
    // refused with 405 and the connection terminated. Raw sockets are used
    // throughout: they speak the same authority-form CONNECT bytes as real
    // HTTPS_PROXY clients, while http.request's CONNECT path surfaces
    // non-2xx refusals as a bare close on this Node version.
    const refuseTargets = [
      "169.254.169.254:80",
      "evil.com:443",
      "opencode.ai:80",
      "user@opencode.ai:443",
      "93.184.216.34:443",
    ];
    for (const target of refuseTargets) {
      const status = await rawConnectStatus(boundPort, target);
      assert.strictEqual(status, 405, `tunnel request to ${target} must be refused with 405, got ${status}`);
    }

    // Non-authority-form targets go over a raw socket (the HTTP client
    // cannot frame them). None may ever establish (200). Note: a raw CRLF
    // inside the request line is split by the HTTP parser itself, so the
    // server only ever sees the first line's target — embedded-CRLF
    // rejection is covered at the parser level in the matrix test above.
    const rawRefuseTargets = [
      "opencode.ai:443/extra",
      "opencode.ai:443?x=1",
      "opencode%2eai:443",
      "[::1]:443",
    ];
    for (const target of rawRefuseTargets) {
      const status = await rawConnectStatus(boundPort, target);
      assert.notEqual(status, 200, `tunnel to ${JSON.stringify(target)} must never be established`);
      assert.ok(
        status === 405 || status === "closed" || String(status).startsWith("error"),
        `tunnel to ${JSON.stringify(target)} must be refused, got ${status}`,
      );
    }

    // Allowlisted target relays with byte flow: point the relay seam at a
    // loopback echo server, CONNECT (mixed case + bare host forms), then
    // assert the 200 establishes and payload bytes round-trip.
    const echoServer = net.createServer((socket) => {
      socket.on("data", (chunk) => socket.write(chunk));
    });
    await new Promise((resolve) => echoServer.listen(0, "127.0.0.1", resolve));
    const echoPort = echoServer.address().port;
    const savedRelayHost = CONNECT_RELAY_TARGET.host;
    const savedRelayPort = CONNECT_RELAY_TARGET.port;
    CONNECT_RELAY_TARGET.host = "127.0.0.1";
    CONNECT_RELAY_TARGET.port = echoPort;
    try {
      for (const target of ["opencode.ai:443", "OPENCODE.AI:443", "opencode.ai"]) {
        const echoed = await rawConnectRelay(boundPort, target, "relay-probe-bytes");
        assert.equal(echoed, "relay-probe-bytes", `CONNECT ${target} must relay bytes through the tunnel`);
      }
    } finally {
      CONNECT_RELAY_TARGET.host = savedRelayHost;
      CONNECT_RELAY_TARGET.port = savedRelayPort;
      await new Promise((resolve) => echoServer.close(resolve));
    }
  } finally {
    await stopIndefiniteDispatcher();
  }
});

test("parseConnectTarget allow/refuse matrix (opencode.ai:443 only)", () => {
  for (const target of ["opencode.ai:443", "OPENCODE.AI:443", "Opencode.AI:443", "opencode.ai", "  opencode.ai:443  "]) {
    assert.equal(isAllowedConnectTarget(target), true, `${JSON.stringify(target)} must be allowed`);
  }
  const parsed = parseConnectTarget("OPENCODE.AI:443");
  assert.deepEqual(parsed, { host: "opencode.ai", port: 443, allowed: true });

  for (const target of [
    "169.254.169.254:80",
    "evil.com:443",
    "opencode.ai:80",
    "opencode.ai:444",
    "models.opencode.ai:443",
    "user@opencode.ai:443",
    "user:pass@opencode.ai:443",
    "93.184.216.34:443",
    "[::1]:443",
    "opencode.ai:443/extra",
    "opencode.ai:443?x=1",
    "opencode.ai:443#frag",
    "opencode%2eai:443",
    "opencode.ai:443\r\nX-Inject: 1",
    "opencode.ai:443\n",
    "",
    "   ",
    "opencode.ai:",
    ":443",
    "opencode.ai:notaport",
    "opencode.ai:99999",
    "http://opencode.ai:443",
    null,
    undefined,
    443,
  ]) {
    assert.equal(isAllowedConnectTarget(target), false, `${JSON.stringify(target)} must be refused`);
  }
  assert.equal(parseConnectTarget("evil.com:443").allowed, false);
  assert.equal(parseConnectTarget("not authority form"), null);
  assert.equal(parseConnectTarget("x".repeat(256)), null);
});

test("Request Sanitizer eliminates invalid_request_error artifacts", () => {
  // 1. JSON String Validation
  assert.deepEqual(ensureValidJsonString('{"foo":"bar"}'), { valid: true, value: '{"foo":"bar"}' });
  const wrapped = ensureValidJsonString("raw unparsed string");
  assert.equal(wrapped.valid, false);
  assert.deepEqual(JSON.parse(wrapped.value), { raw_unparsed: "raw unparsed string" });

  // 2. Model Alias Normalization
  const modelPayload = Buffer.from(JSON.stringify({ model: "opencode/union-alpha", messages: [] }));
  const sanitizedModel = sanitizeRequestBody(modelPayload);
  assert.equal(JSON.parse(sanitizedModel.toString()).model, "opencode/muse-spark-1.3-contributor-free");

  // 3. Strip encrypted reasoning content on forceFullStrip
  const payloadWithReasoning = Buffer.from(JSON.stringify({
    model: "opencode/muse-spark-1.3-contributor-free",
    input: [
      { type: "reasoning", content: "internal chain of thought" },
      { type: "message", role: "user", content: "hello", encrypted_content: "secret" },
    ],
  }));

  const cleaned = sanitizeRequestBody(payloadWithReasoning, "req-1", { forceFullStrip: true });
  const parsedClean = JSON.parse(cleaned.toString());

  // Reasoning item should be pruned
  assert.equal(parsedClean.input.length, 1);
  assert.equal(parsedClean.input[0].type, "message");
  // Encrypted content should be deleted
  assert.equal(parsedClean.input[0].encrypted_content, undefined);
});

test("ProxyPool pruneDeadProxies cycles out dead, MITM, and latency-spiking proxies", () => {
  const pool = new ProxyPool(null);
  pool.loadProxiesFromLines([
    "http://good-proxy:8080",
    "http://failing-proxy:8080",
    "http://mitm-proxy:8080",
    "http://lagging-proxy:8080",
    "http://extreme-latency-proxy:8080",
  ]);

  assert.equal(pool.proxies.length, 5);

  // 1. Good proxy
  pool.recordSuccess("http://good-proxy:8080", 250);

  // 2. Failing proxy (3 failures, 0 successes)
  pool.recordFailure("http://failing-proxy:8080", "ECONNRESET");
  pool.recordFailure("http://failing-proxy:8080", "ECONNRESET");
  pool.recordFailure("http://failing-proxy:8080", "ECONNRESET");

  // 3. MITM proxy
  pool.recordFailure("http://mitm-proxy:8080", "DEPTH_ZERO_SELF_SIGNED_CERT");

  // 4. Lagging proxy (latency > 6000 with multiple failures)
  const lagStats = pool.ensureStats("http://lagging-proxy:8080");
  lagStats.latencyEwma = 7500;
  lagStats.failures = 2;

  // 5. Extreme latency proxy (> 10000)
  const extStats = pool.ensureStats("http://extreme-latency-proxy:8080");
  extStats.latencyEwma = 12000;

  // Set affinity to failing proxy
  pool.affinityMap.set("session-dead", "http://failing-proxy:8080");
  pool.affinityMap.set("session-good", "http://good-proxy:8080");

  // Prune dead proxies
  const pruned = pool.pruneDeadProxies();
  assert.equal(pruned.length, 4);
  assert.ok(pruned.includes("http://failing-proxy:8080"));
  assert.ok(pruned.includes("http://mitm-proxy:8080"));
  assert.ok(pruned.includes("http://lagging-proxy:8080"));
  assert.ok(pruned.includes("http://extreme-latency-proxy:8080"));

  // Only good-proxy remains in pool
  assert.equal(pool.proxies.length, 1);
  assert.equal(pool.proxies[0], "http://good-proxy:8080");
  assert.equal(pool.getHealthyProxies().length, 1);
  assert.equal(pool.pickCandidate(), "http://good-proxy:8080");

  // Dead affinity is cleaned up, good affinity is preserved
  assert.equal(pool.affinityMap.has("session-dead"), false);
  assert.equal(pool.affinityMap.get("session-good"), "http://good-proxy:8080");
});

test("ProxyPool saveToFile persists pruned proxy list to disk", () => {
  const tmpFile = path.join(tmpdir(), `prune-persist-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, "http://survivor:8080\nhttp://dead:8080\n", "utf8");

  try {
    const pool = new ProxyPool(tmpFile);
    assert.equal(pool.proxies.length, 2);

    // Fail dead proxy 3 times with 0 successes
    pool.recordFailure("http://dead:8080", "ECONNRESET");
    pool.recordFailure("http://dead:8080", "ECONNRESET");
    pool.recordFailure("http://dead:8080", "ECONNRESET");

    // Success on survivor
    pool.recordSuccess("http://survivor:8080", 150);

    const pruned = pool.pruneDeadProxies();
    assert.equal(pruned.length, 1);
    assert.equal(pruned[0], "http://dead:8080");

    // Read file from disk to verify persistence
    const saved = fs.readFileSync(tmpFile, "utf8").trim();
    assert.equal(saved, "http://survivor:8080");
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

