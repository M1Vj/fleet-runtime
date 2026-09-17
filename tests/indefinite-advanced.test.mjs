import test from "node:test";
import assert from "node:assert/strict";

import {
  ProxyPool,
  isMitmOrCertError,
  HARVEST_SOURCES,
} from "../scripts/lib/indefinite-dispatcher.mjs";

test("indefinite advanced: isMitmOrCertError detection and quarantine", () => {
  assert.equal(isMitmOrCertError("unable to verify the first certificate"), true);
  assert.equal(isMitmOrCertError("DEPTH_ZERO_SELF_SIGNED_CERT"), true);
  assert.equal(isMitmOrCertError("EPROTO 1402949:ssl alert"), true);
  assert.equal(isMitmOrCertError("mitm block page detected"), true);
  assert.equal(isMitmOrCertError("connect ETIMEDOUT"), false);
  assert.equal(isMitmOrCertError("ECONNRESET"), false);

  const pool = new ProxyPool(null);
  pool.loadProxiesFromLines(["http://127.0.0.1:8080"]);

  // Trigger MITM error
  pool.recordFailure("http://127.0.0.1:8080", "DEPTH_ZERO_SELF_SIGNED_CERT");
  const stats = pool.stats.get("http://127.0.0.1:8080");
  assert.equal(stats.state, "open");
  // Cooldown should be at least 15 minutes (900,000ms)
  assert.ok(stats.cooldownUntil >= Date.now() + 890000);
});

test("indefinite advanced: session affinity maintains preferred route", () => {
  const pool = new ProxyPool(null);
  pool.loadProxiesFromLines([
    "http://127.0.0.1:8001",
    "http://127.0.0.1:8002",
    "http://127.0.0.1:8003",
  ]);

  // Set different latencies
  pool.recordSuccess("http://127.0.0.1:8001", 100);
  pool.recordSuccess("http://127.0.0.1:8002", 500);
  pool.recordSuccess("http://127.0.0.1:8003", 900);

  // First pick with session A
  const pickedA1 = pool.pickCandidate(null, "session-A");
  assert.equal(pickedA1, "http://127.0.0.1:8001");

  // Subsequent pick with session A should return the affinity route
  const pickedA2 = pool.pickCandidate(null, "session-A");
  assert.equal(pickedA2, "http://127.0.0.1:8001");

  // If session A's proxy fails, it fails over to the next best
  pool.recordFailure("http://127.0.0.1:8001", "TIMEOUT", 60000);
  const pickedA3 = pool.pickCandidate(null, "session-A");
  assert.equal(pickedA3, "http://127.0.0.1:8002");
});

test("indefinite advanced: HARVEST_SOURCES definition and parsing", () => {
  assert.ok(Array.isArray(HARVEST_SOURCES));
  assert.ok(HARVEST_SOURCES.length >= 5);
  for (const src of HARVEST_SOURCES) {
    assert.match(src, /^https:\/\/raw\.githubusercontent\.com\//);
  }
});
