import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CIRCUIT_OPEN_MS,
  gatewayCircuitOpen,
  gatewayDown,
  markGatewayDown,
  markGatewayUp,
  readHealth,
  healthSnapshot,
} from "../scripts/lib/gateway-health.mjs";

function freshRoot() {
  return mkdtempSync(path.join(tmpdir(), "fleetgw-"));
}

test("breaker is 30 minutes", () => {
  assert.equal(CIRCUIT_OPEN_MS, 30 * 60 * 1000);
});

test("circuit closed with no health state", () => {
  const root = freshRoot();
  assert.equal(gatewayCircuitOpen(root), false);
  assert.equal(gatewayDown(root), false);
  assert.equal(readHealth(root), null);
  const snap = healthSnapshot(root);
  assert.deepEqual(snap, { open: false, ageMs: -1, data: null });
});

test("circuit opens on failure with telemetry, closes on recovery", () => {
  const root = freshRoot();
  markGatewayDown(root, "boom", { attempts: 3, modelMode: "m@xhigh", chain: ["opencode/a"] });
  assert.equal(gatewayCircuitOpen(root), true);
  const snap = healthSnapshot(root);
  assert.equal(snap.open, true);
  assert.equal(snap.data.reason, "boom");
  assert.equal(snap.data.attempts, 3);
  assert.deepEqual(snap.data.chain, ["opencode/a"]);
  markGatewayUp(root);
  assert.equal(gatewayCircuitOpen(root), false);
  assert.ok(readHealth(root).recoveredAt);
});

test("stale failure (older than 30min) no longer opens the circuit", () => {
  const root = freshRoot();
  markGatewayDown(root, "old");
  const p = path.join(root, "state", "gateway-health.json");
  const data = JSON.parse(readFileSync(p, "utf8"));
  data.downSince = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  writeFileSync(p, JSON.stringify(data));
  assert.equal(gatewayCircuitOpen(root), false);
});

test("recorded reasons are secret-scrubbed", () => {
  const root = freshRoot();
  const token = `ghp_${"A".repeat(36)}`;
  markGatewayDown(root, `auth failed ${token}`);
  const stored = JSON.stringify(readHealth(root));
  assert.ok(!stored.includes(token));
  assert.ok(stored.includes("[redacted]"));
});
