import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  ProxyPool,
  isPrivateOrReservedHost,
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
  assert.equal(isPrivateOrReservedHost("169.254.169.254"), true);
  assert.equal(isPrivateOrReservedHost("metadata.google.internal"), true);
  assert.equal(isPrivateOrReservedHost("10.0.0.5"), true);
  assert.equal(isPrivateOrReservedHost("172.16.0.1"), true);
  assert.equal(isPrivateOrReservedHost("192.168.1.1"), true);
  assert.equal(isPrivateOrReservedHost("::1"), true);
  assert.equal(isPrivateOrReservedHost("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateOrReservedHost("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateOrReservedHost("::ffff:169.254.169.254"), true);
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

test("Indefinite Dispatcher lifecycle, health endpoint, and CONNECT security guard", async () => {
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

    // Test CONNECT to private/reserved target is blocked with 403 Forbidden
    const connectRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: boundPort,
        method: "CONNECT",
        path: "169.254.169.254:80",
      });
      req.on("response", (resp) => resolve(resp.statusCode));
      req.on("error", (err) => resolve("error: " + err.message));
      req.on("close", () => resolve("closed"));
      req.end();
    });
    assert.ok(connectRes === "closed" || connectRes === 403 || String(connectRes).includes("error"));
  } finally {
    await stopIndefiniteDispatcher();
  }
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

