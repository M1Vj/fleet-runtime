import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_AUTH_COOLDOWN_MS,
  DEFAULT_QUOTA_COOLDOWN_MS,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  DEFAULT_TRANSPORT_COOLDOWN_MS,
  DEFAULT_UNKNOWN_COOLDOWN_MS,
  PROVIDER_RETRY_MAX_MS,
  clampCooldownMs,
  classifyFailure,
  clearAllModelRetries,
  collectSlots,
  hasNumberedSlots,
  healthPath,
  isAuthFailure,
  isModelCoolingDown,
  isQuotaClassFailure,
  isRateLimitedText,
  isTransportFailure,
  loadHealth,
  modelRetryWaitMs,
  recordFailure,
  recordModelRetry,
  recordSuccess,
  recordTransportFailure,
  resolveCooldownForClass,
  resolveCooldownMs,
  resolveRateLimitCooldownMs,
  resolveRetryMaxMs,
  resolveTransportCooldownMs,
  resolveUnknownCooldownMs,
  selectSlot,
  slotEnvName,
  snapshotModelRetries,
  stripSlotKeys,
} from "../scripts/lib/credential-pool.mjs";

const T0 = Date.parse("2026-09-10T00:00:00.000Z");

function freshRoot() {
  return mkdtempSync(path.join(tmpdir(), "fleetpool-"));
}

function env3() {
  return {
    FLEET_OPENCODE_AUTH: "test-slot-1",
    FLEET_OPENCODE_AUTH_2: "test-slot-2",
    FLEET_OPENCODE_AUTH_3: "test-slot-3",
  };
}

test("slot env names follow the legacy + numbered convention", () => {
  assert.equal(slotEnvName(1), "FLEET_OPENCODE_AUTH");
  assert.equal(slotEnvName(2), "FLEET_OPENCODE_AUTH_2");
  assert.equal(slotEnvName(9), "FLEET_OPENCODE_AUTH_9");
});

test("collectSlots probes _2.._9 and ignores empties", () => {
  const slots = collectSlots({
    FLEET_OPENCODE_AUTH: "test-slot-1",
    FLEET_OPENCODE_AUTH_2: "",
    FLEET_OPENCODE_AUTH_3: "test-slot-3",
  });
  assert.deepEqual(slots.map((s) => s.slot), [1, 3]);
  assert.equal(hasNumberedSlots({ FLEET_OPENCODE_AUTH: "test-slot-1" }), false);
  assert.equal(hasNumberedSlots({ FLEET_OPENCODE_AUTH_2: "test-slot-2" }), true);
});

test("missing pool reports missing, never throws", () => {
  assert.deepEqual(selectSlot({ env: {}, stateRoot: freshRoot(), nowMs: T0 }), { missing: true });
});

test("fresh pool selects slot 1 first", () => {
  const sel = selectSlot({ env: env3(), stateRoot: freshRoot(), nowMs: T0 });
  assert.equal(sel.slot, 1);
  assert.equal(sel.value, "test-slot-1");
  assert.equal(sel.total, 3);
});

test("selection rotates least-recently-healthy", () => {
  const root = freshRoot();
  recordSuccess(root, 1, T0);
  assert.equal(selectSlot({ env: env3(), stateRoot: root, nowMs: T0 + 500 }).slot, 2);
  recordSuccess(root, 2, T0 + 1000);
  assert.equal(selectSlot({ env: env3(), stateRoot: root, nowMs: T0 + 1500 }).slot, 3);
  recordSuccess(root, 3, T0 + 2000);
  // All healthy: oldest success (slot 1) goes first again.
  assert.equal(selectSlot({ env: env3(), stateRoot: root, nowMs: T0 + 2500 }).slot, 1);
});

test("auth-class failure cools the slot down, other failures do not", () => {
  const root = freshRoot();
  assert.equal(recordFailure(root, 1, "opencode run failed: 429 rate limit exceeded", { nowMs: T0 }), true);
  // Non-auth failure leaves the pool untouched (no state written).
  assert.equal(recordFailure(root, 2, "timeout after 480s with no output", { nowMs: T0 }), false);
  assert.equal(existsSync(healthPath(root)), true);
  const health = loadHealth(root);
  assert.equal(health["1"].consecutiveErrors, 1);
  assert.equal(health["1"].cooldownUntil, T0 + DEFAULT_AUTH_COOLDOWN_MS);
  assert.equal(health["2"], undefined);
  assert.equal(selectSlot({ env: env3(), stateRoot: root, nowMs: T0 + 1000 }).slot, 2);
});

test("expired cooldowns rejoin, back to slot 1 first", () => {
  const root = freshRoot();
  recordFailure(root, 1, "401 Unauthorized", { nowMs: T0 });
  recordFailure(root, 2, "quota exceeded", { nowMs: T0 });
  assert.equal(selectSlot({ env: env3(), stateRoot: root, nowMs: T0 + 1000 }).slot, 3);
  const sel = selectSlot({ env: env3(), stateRoot: root, nowMs: T0 + DEFAULT_AUTH_COOLDOWN_MS + 1000 });
  assert.equal(sel.slot, 1);
});

test("success clears cooldown and error count", () => {
  const root = freshRoot();
  recordFailure(root, 1, "429 Too Many Requests", { nowMs: T0 });
  assert.equal(selectSlot({ env: env3(), stateRoot: root, nowMs: T0 + 1000 }).slot, 2);
  recordSuccess(root, 1, T0 + 2000);
  const health = loadHealth(root);
  assert.equal(health["1"].consecutiveErrors, 0);
  assert.equal(health["1"].cooldownUntil, 0);
  assert.ok(health["1"].lastOk);
  assert.equal(selectSlot({ env: env3(), stateRoot: root, nowMs: T0 + 3000 }).slot, 2);
});

test("all slots cooling down returns the exhausted signal", () => {
  const root = freshRoot();
  recordFailure(root, 1, "429 rate limit", { nowMs: T0 });
  recordFailure(root, 2, "CreditsError: out of credits", { nowMs: T0 });
  recordFailure(root, 3, "403 payment required", { nowMs: T0 });
  assert.deepEqual(selectSlot({ env: env3(), stateRoot: root, nowMs: T0 + 1000 }), { exhausted: true, total: 3 });
});

test("failure-pattern matching covers quota/auth/429 classes", () => {
  for (const tail of [
    "CreditsError: out of credits",
    "credit balance exhausted",
    "HTTP 429 Too Many Requests",
    "rate_limit exceeded, retry later",
    "rate limit exceeded",
    "quota exceeded for this account",
    "401 Unauthorized",
    "403 payment required",
    "auth expired, re-login",
  ]) {
    assert.equal(isAuthFailure(tail), true, tail);
  }
  for (const tail of ["timeout after 480s", "exit code 1", "", "model hung with no output", "variant not supported"]) {
    assert.equal(isAuthFailure(tail), false, JSON.stringify(tail));
  }
});

test("cooldown defaults to 15 min and honors FLEET_AUTH_COOLDOWN_MS", () => {
  assert.equal(DEFAULT_AUTH_COOLDOWN_MS, 15 * 60 * 1000);
  assert.equal(resolveCooldownMs({}), DEFAULT_AUTH_COOLDOWN_MS);
  assert.equal(resolveCooldownMs({ FLEET_AUTH_COOLDOWN_MS: "60000" }), 60000);
  assert.equal(resolveCooldownMs({ FLEET_AUTH_COOLDOWN_MS: "soon" }), DEFAULT_AUTH_COOLDOWN_MS);
  assert.equal(resolveCooldownMs({ FLEET_AUTH_COOLDOWN_MS: "0" }), DEFAULT_AUTH_COOLDOWN_MS);
  assert.equal(resolveCooldownMs({ FLEET_AUTH_COOLDOWN_MS: "-5" }), DEFAULT_AUTH_COOLDOWN_MS);
});

test("health state carries slot numbers only, never key material", () => {
  const root = freshRoot();
  recordSuccess(root, 1, T0);
  recordFailure(root, 2, "429 rate limit; key sk-testfakekey1234567890 rejected", { nowMs: T0 });
  const raw = readFileSync(healthPath(root), "utf8");
  assert.ok(!raw.includes("test-slot-"), "pool state must not persist slot values");
  assert.ok(!raw.includes("sk-testfakekey1234567890"), "pool state must not persist key material");
  assert.ok(raw.includes("[redacted]"));
  const health = JSON.parse(raw);
  assert.deepEqual(Object.keys(health.slots).sort(), ["1", "2"]);
});

test("corrupt health file degrades to a healthy pool", () => {
  const root = freshRoot();
  const p = healthPath(root);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, "not-json{{{", "utf8");
  assert.deepEqual(loadHealth(root), {});
  assert.equal(selectSlot({ env: env3(), stateRoot: root, nowMs: T0 }).slot, 1);
});

test("stripSlotKeys removes every slot key, keeps the rest", () => {
  const env = {
    FLEET_OPENCODE_AUTH: "test-slot-1",
    FLEET_OPENCODE_AUTH_2: "test-slot-2",
    FLEET_OPENCODE_AUTH_9: "test-slot-9",
    OPENCODE_AUTH_CONTENT: "test-slot-1",
    PATH: "/usr/bin",
  };
  stripSlotKeys(env);
  assert.equal(env.FLEET_OPENCODE_AUTH, undefined);
  assert.equal(env.FLEET_OPENCODE_AUTH_2, undefined);
  assert.equal(env.FLEET_OPENCODE_AUTH_9, undefined);
  assert.equal(env.OPENCODE_AUTH_CONTENT, "test-slot-1");
  assert.equal(env.PATH, "/usr/bin");
});

test("auth regex tightened: matches auth-class, never matches author", () => {
  for (const tail of ["auth failed", "auth error: expired token", "401 Unauthorized", "CreditsError: out of credits", "HTTP 429 Too Many Requests"]) {
    assert.equal(isAuthFailure(tail), true, tail);
  }
  for (const tail of ["author of the change", "co-authored commit", "authentication note without failure tokens", "timeout after 480s", ""]) {
    assert.equal(isAuthFailure(tail), false, JSON.stringify(tail));
  }
});

test("exhausted pool signals without throwing; flag writer files async alert-intent", async () => {
  const root = freshRoot();
  recordFailure(root, 1, "429 rate limit", { nowMs: T0 });
  recordFailure(root, 2, "CreditsError: out of credits", { nowMs: T0 });
  recordFailure(root, 3, "403 payment required", { nowMs: T0 });
  let sel = null;
  try {
    sel = selectSlot({ env: env3(), stateRoot: root, nowMs: T0 + 1000 });
  } catch (err) {
    assert.fail(`selectSlot must not throw on exhaustion: ${err.message}`);
  }
  assert.deepEqual(sel, { exhausted: true, total: 3 });
  const { writeAuthExhaustedFlag, authExhaustedPath } = await import("../scripts/lib/model.mjs");
  let ok = false;
  try {
    ok = writeAuthExhaustedFlag({ stateRoot: root, total: sel.total, cooldownMs: 900000 });
  } catch (err) {
    assert.fail(`flag writer must not throw: ${err.message}`);
  }
  assert.equal(ok, true);
  const flagPath = authExhaustedPath(root);
  assert.equal(existsSync(flagPath), true);
  const flag = JSON.parse(readFileSync(flagPath, "utf8"));
  assert.equal(flag.slots, 3);
  assert.ok(flag.exhaustedAt);
  assert.ok(!JSON.stringify(flag).includes("test-slot-"));
  const events = readFileSync(path.join(root, "state", "events.jsonl"), "utf8");
  assert.ok(events.includes("credential-pool-exhausted"));
});

test("mid-run transport failure cools briefly; caller kills and auth stay out", () => {
  const root = freshRoot();
  for (const tail of ["socket hang up", "read ECONNRESET", "connect ECONNREFUSED 1.2.3.4:3128", "Proxy CONNECT timeout (2000ms)".replace("CONNECT timeout", "connect timeout"), "broken pipe"]) {
    assert.equal(isTransportFailure(tail), true, tail);
  }
  for (const tail of ["timeout after 480s with no output", "aborted by client", "SIGTERM", "exit code 1", "", "model hung with no output"]) {
    assert.equal(isTransportFailure(tail), false, JSON.stringify(tail));
  }
  // Transport cools slot 1 briefly; next call rotates to slot 2.
  assert.equal(recordTransportFailure(root, 1, "socket hang up", { nowMs: T0 }), true);
  // Auth-class input refused here (belongs to recordFailure).
  assert.equal(recordTransportFailure(root, 2, "429 rate limit", { nowMs: T0 }), false);
  const health = loadHealth(root);
  assert.equal(health["1"].consecutiveErrors, 1);
  assert.equal(health["1"].cooldownUntil, T0 + DEFAULT_TRANSPORT_COOLDOWN_MS);
  assert.equal(health["2"], undefined);
  assert.equal(selectSlot({ env: env3(), stateRoot: root, nowMs: T0 + 1000 }).slot, 2);
  // Short cooldown rejoins well before the 15-min auth cooldown.
  assert.equal(selectSlot({ env: env3(), stateRoot: root, nowMs: T0 + DEFAULT_TRANSPORT_COOLDOWN_MS + 1000 }).slot, 1);
});

test("transport cooldown defaults to 5 min and honors FLEET_TRANSPORT_COOLDOWN_MS", () => {
  assert.equal(DEFAULT_TRANSPORT_COOLDOWN_MS, 5 * 60 * 1000);
  assert.equal(resolveTransportCooldownMs({}), DEFAULT_TRANSPORT_COOLDOWN_MS);
  assert.equal(resolveTransportCooldownMs({ FLEET_TRANSPORT_COOLDOWN_MS: "60000" }), 60000);
  assert.equal(resolveTransportCooldownMs({ FLEET_TRANSPORT_COOLDOWN_MS: "soon" }), DEFAULT_TRANSPORT_COOLDOWN_MS);
  assert.equal(resolveTransportCooldownMs({ FLEET_TRANSPORT_COOLDOWN_MS: "0" }), DEFAULT_TRANSPORT_COOLDOWN_MS);
  assert.equal(resolveTransportCooldownMs({ FLEET_TRANSPORT_COOLDOWN_MS: "-5" }), DEFAULT_TRANSPORT_COOLDOWN_MS);
});

test("failure classification: 429 text is rate_limited ONLY, never quota-class", () => {
  assert.equal(classifyFailure("opencode run failed: 429 Too Many Requests"), "rate_limited");
  assert.equal(classifyFailure("429 rate limit exceeded, retry later"), "rate_limited");
  assert.equal(classifyFailure("quota exceeded for this account"), "quota");
  assert.equal(classifyFailure("CreditsError: out of credits"), "quota");
  assert.equal(classifyFailure("401 Unauthorized"), "auth");
  assert.equal(classifyFailure("socket hang up"), "transport");
  assert.equal(classifyFailure("429 socket hang up"), "rate_limited");
  assert.equal(classifyFailure("timeout after 480s with no output"), "unknown");
  assert.equal(isRateLimitedText("Error 429, slow down"), true);
  assert.equal(isQuotaClassFailure("429 Too Many Requests"), false);
  assert.equal(isQuotaClassFailure("quota exceeded"), true);
});

test("class cooldown split: quota 30-min reserve, transport 5-min, unknown short", () => {
  assert.equal(DEFAULT_QUOTA_COOLDOWN_MS, 30 * 60 * 1000);
  assert.equal(resolveCooldownForClass("quota", {}), PROVIDER_RETRY_MAX_MS);
  assert.equal(resolveCooldownForClass("quota", { FLEET_QUOTA_COOLDOWN_MS: "60000" }), 60000);
  assert.equal(resolveCooldownForClass("auth", {}), DEFAULT_AUTH_COOLDOWN_MS);
  assert.equal(resolveCooldownForClass("auth", { FLEET_AUTH_COOLDOWN_MS: "60000" }), 60000);
  assert.equal(resolveCooldownForClass("transport", {}), DEFAULT_TRANSPORT_COOLDOWN_MS);
  assert.equal(resolveCooldownForClass("rate_limited", {}), DEFAULT_RATE_LIMIT_COOLDOWN_MS);
  assert.equal(resolveCooldownForClass("unknown", {}), DEFAULT_UNKNOWN_COOLDOWN_MS);
  assert.equal(resolveCooldownForClass("nope", {}), DEFAULT_AUTH_COOLDOWN_MS);
});

test("retry clamp caps computed cooldowns at 15 min (env-overridable)", () => {
  assert.equal(PROVIDER_RETRY_MAX_MS, 15 * 60 * 1000);
  assert.equal(resolveRetryMaxMs({}), PROVIDER_RETRY_MAX_MS);
  assert.equal(resolveRetryMaxMs({ FLEET_RETRY_MAX_MS: "60000" }), 60000);
  assert.equal(clampCooldownMs(30 * 60 * 1000, {}), 15 * 60 * 1000);
  assert.equal(clampCooldownMs(60 * 1000, {}), 60 * 1000);
  // Quota reserve (30 min) is clamped to the 15-min retry max on write.
  const root = freshRoot();
  recordFailure(root, 1, "quota exceeded", { nowMs: T0, cooldownMs: resolveCooldownForClass("quota", {}) });
  assert.equal(loadHealth(root)["1"].cooldownUntil, T0 + 15 * 60 * 1000);
  // A raised max lets the full quota reserve through.
  process.env.FLEET_RETRY_MAX_MS = String(45 * 60 * 1000);
  const root2 = freshRoot();
  try {
    recordFailure(root2, 1, "quota exceeded", { nowMs: T0, cooldownMs: resolveCooldownForClass("quota", process.env) });
  } finally {
    delete process.env.FLEET_RETRY_MAX_MS;
  }
  assert.equal(loadHealth(root2)["1"].cooldownUntil, T0 + 30 * 60 * 1000);
});

test("model retry map: per-model cooldown, 256-key cap, unknown fallback", () => {
  clearAllModelRetries();
  assert.equal(modelRetryWaitMs("opencode/a", { nowMs: T0 }), 0);
  assert.ok(recordModelRetry("opencode/a", T0 + 120000, { nowMs: T0 }));
  assert.equal(modelRetryWaitMs("opencode/a", { nowMs: T0 + 1000 }), 119000);
  assert.equal(isModelCoolingDown("opencode/a", { nowMs: T0 + 1000 }), true);
  assert.equal(modelRetryWaitMs("opencode/b", { nowMs: T0 + 1000 }), 0);
  assert.equal(modelRetryWaitMs("opencode/a", { nowMs: T0 + 120001 }), 0);
  // Key hygiene: hostile ids sanitize, empties share the global fallback.
  assert.ok(recordModelRetry("", T0 + 60000, { nowMs: T0 }));
  assert.equal(modelRetryWaitMs("", { nowMs: T0 + 1000 }), 59000);
  assert.equal(modelRetryWaitMs("   ", { nowMs: T0 + 1000 }), 59000);
  clearAllModelRetries();
  for (let i = 0; i < 260; i++) recordModelRetry(`opencode/m${i}`, T0 + 60000, { nowMs: T0 });
  // 256 capped map entries + the always-present unknown-model fallback key.
  assert.equal(Object.keys(snapshotModelRetries({ nowMs: T0 })).length, 257);
  assert.equal(modelRetryWaitMs("opencode/m0", { nowMs: T0 }), 0);
  assert.equal(modelRetryWaitMs("opencode/m259", { nowMs: T0 }), 60000);
  clearAllModelRetries();
});
