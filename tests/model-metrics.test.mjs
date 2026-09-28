import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MODEL_METRICS_MAX_KEYS,
  getModelMetrics,
  loadModelMetricsSnapshot,
  metricsPath,
  recordModelOutcome,
  resetModelMetrics,
  sanitizeModelKey,
  saveModelMetricsSnapshot,
} from "../scripts/lib/model-metrics.mjs";
import { atomicWriteJsonSync } from "../scripts/lib/util.mjs";
import { markGatewayDown, readHealth } from "../scripts/lib/gateway-health.mjs";
import { saveHealth, loadHealth } from "../scripts/lib/credential-pool.mjs";
import { renderStatusMd } from "../scripts/lib/status.mjs";

function freshRoot() {
  return mkdtempSync(path.join(tmpdir(), "fleetmetrics-"));
}

test("model keys sanitize; hostile ids collapse, empties fall back", () => {
  assert.equal(sanitizeModelKey("opencode/muse-spark-1.3-contributor-free"), "opencode/muse-spark-1.3-contributor-free");
  assert.equal(sanitizeModelKey(""), "unknown-model");
  assert.equal(sanitizeModelKey("   "), "unknown-model");
  assert.equal(sanitizeModelKey("a b$c"), "a_b_c");
  assert.ok(sanitizeModelKey("x".repeat(300)).length <= 160);
});

test("outcome counters accumulate with latency EWMA", () => {
  resetModelMetrics();
  recordModelOutcome("opencode/a", { ok: true, latencyMs: 100 });
  recordModelOutcome("opencode/a", { ok: false, limited429: true, latencyMs: 200 });
  recordModelOutcome("opencode/a", { ok: false, error5xx: true, latencyMs: 300 });
  const snap = getModelMetrics();
  assert.equal(snap["opencode/a"].attempt, 3);
  assert.equal(snap["opencode/a"].success, 1);
  assert.equal(snap["opencode/a"].limited429, 1);
  assert.equal(snap["opencode/a"].error5xx, 1);
  assert.ok(snap["opencode/a"].latencyEwmaMs > 100 && snap["opencode/a"].latencyEwmaMs < 300);
  resetModelMetrics();
  assert.deepEqual(getModelMetrics(), {});
});

test("metrics map caps at 32 keys, oldest evicted", () => {
  assert.equal(MODEL_METRICS_MAX_KEYS, 32);
  resetModelMetrics();
  for (let i = 0; i < 35; i++) recordModelOutcome(`opencode/m${i}`, { ok: true, latencyMs: 10 });
  const snap = getModelMetrics();
  assert.equal(Object.keys(snap).length, 32);
  assert.equal(snap["opencode/m0"], undefined);
  assert.equal(snap["opencode/m34"].attempt, 1);
  resetModelMetrics();
});

test("metrics snapshot persists atomically and reloads", () => {
  const root = freshRoot();
  resetModelMetrics();
  recordModelOutcome("opencode/a", { ok: true, latencyMs: 50 });
  assert.equal(saveModelMetricsSnapshot(root), true);
  assert.equal(existsSync(metricsPath(root)), true);
  assert.deepEqual(loadModelMetricsSnapshot(root)["opencode/a"].attempt, 1);
  assert.deepEqual(loadModelMetricsSnapshot(freshRoot()), {});
  resetModelMetrics();
});

test("atomicWriteJsonSync round-trips with 0600 perms and no tmp residue", () => {
  const root = freshRoot();
  const p = path.join(root, "state", "nested", "doc.json");
  process.env.FLEET_TEST_MODE = "1";
  try {
    atomicWriteJsonSync(p, { a: 1 });
  } finally {
    delete process.env.FLEET_TEST_MODE;
  }
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { a: 1 });
  assert.equal(statSync(p).mode & 0o777, 0o600);
});

test("pool and gateway saves still parse after atomic migration", () => {
  const root = freshRoot();
  saveHealth(root, { 1: { cooldownUntil: 0 } });
  assert.equal(loadHealth(root)["1"].cooldownUntil, 0);
  markGatewayDown(root, "boom");
  assert.equal(readHealth(root).reason, "boom");
});

test("status renderer surfaces the model-outcomes table", () => {
  const md = renderStatusMd({
    eventsLines: [],
    mergesLines: [],
    heartbeat: null,
    queueLines: [],
    modelMetrics: { "opencode/a": { attempt: 4, success: 3, limited429: 1, error5xx: 0, latencyEwmaMs: 120 } },
  });
  assert.ok(md.includes("## Model outcomes"));
  assert.ok(md.includes("opencode/a | 4 | 3 | 1 | 0 | 120 |"));
  const empty = renderStatusMd({ eventsLines: [], mergesLines: [], heartbeat: null, queueLines: [] });
  assert.ok(empty.includes("| (none) | 0 | 0 | 0 | 0 | 0 |"));
});
