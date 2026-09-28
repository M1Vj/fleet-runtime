// Multi-credential rotation pool for fleet model auth (local-first,
// Actions-mirrorable).
//
// Slot convention: FLEET_OPENCODE_AUTH (slot 1, legacy) plus
// FLEET_OPENCODE_AUTH_2..FLEET_OPENCODE_AUTH_9 (numbered slots, probed in
// order; empty values ignored). Pool health persists at
// <FLEET_STATE_ROOT>/state/credential-health.json — private control-repository state
// state, never committed to the public runtime repo. Per-slot shape:
// { cooldownUntil, consecutiveErrors, lastOk, lastAuthError }.
//
// Selection: least-recently-healthy non-cooldown slot (ties break to the
// lowest slot number, so recovery rounds back to slot 1 first).
// Auth/quota/429-class failures cool a slot down; successes clear it;
// expired cooldowns rejoin automatically. All slots cooling down returns
// { exhausted: true } so the caller emits STALLED + files/updates the
// onboarding alert (existing watchdog/retro conventions).
//
// This module is pure w.r.t. secrets: persisted state and every return value
// except the in-memory `value` handed to the model caller carry slot NUMBERS
// only — never key material. Failure tails are scrubbed before persisting.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteJsonSync } from "./util.mjs";

export const LEGACY_AUTH_ENV = "FLEET_OPENCODE_AUTH";
export const MAX_AUTH_SLOTS = 9;
export const DEFAULT_AUTH_COOLDOWN_MS = 15 * 60 * 1000;
export const AUTH_COOLDOWN_ENV = "FLEET_AUTH_COOLDOWN_MS";

// Mid-run transport faults (port of the local indefinite MIDSTREAM_ lesson):
// a slot whose model call dies mid-run on a genuine transport error gets a
// SHORT cooldown so the next call rotates, instead of retrying the same
// broken slot. Deliberately narrow: bare "timeout" never matches (a slow
// model killed by our own watchdog is caller-caused, not slot fault — the
// same guard as the local !req.aborted rule), and auth-class strings stay
// with recordFailure (checked first by callers).
export const TRANSPORT_FAILURE_RE = /socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|connect timeout|socket timeout|handshake (timeout|failure)|read ECONNRESET|broken pipe|stream error|connection reset by peer|connection refused/i;
export const DEFAULT_TRANSPORT_COOLDOWN_MS = 5 * 60 * 1000;
export const TRANSPORT_COOLDOWN_ENV = "FLEET_TRANSPORT_COOLDOWN_MS";

export function isTransportFailure(stderrTail) {
  return TRANSPORT_FAILURE_RE.test(String(stderrTail || ""));
}

export function resolveTransportCooldownMs(env = process.env) {
  const raw = Number.parseInt(String(env[TRANSPORT_COOLDOWN_ENV] || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRANSPORT_COOLDOWN_MS;
}

// Cools the slot briefly on genuine mid-run transport failures. Returns true
// when the slot was cooled down. Auth-class input is refused here (use
// recordFailure); caller-caused kills must be filtered by the caller via
// the timedOut flag before calling.
export function recordTransportFailure(stateRoot, slot, stderrTail, { nowMs = Date.now(), cooldownMs = DEFAULT_TRANSPORT_COOLDOWN_MS } = {}) {
  if (!isTransportFailure(stderrTail) || isAuthFailure(stderrTail)) return false;
  const health = loadHealth(stateRoot);
  const prev = health[String(slot)] || {};
  health[String(slot)] = {
    ...prev,
    cooldownUntil: nowMs + clampCooldownMs(cooldownMs),
    consecutiveErrors: (Number(prev.consecutiveErrors) || 0) + 1,
    lastTransportError: scrubTail(stderrTail).slice(-200),
  };
  saveHealth(stateRoot, health);
  return true;
}

// Auth/quota/429-class failure signatures, matched against scrubbed stderr
// tails (covers CreditsError/credits-exhausted, 429 rate limits, 401/403).
// Tightened: bare 'auth' overmatched ('author'); use explicit auth tokens
// plus word-adjacent login so 'author' never cools a slot down.
export const AUTH_FAILURE_RE = /429|401|403|rate.?limit|quota|credits?|payment|unauthorized|login|auth[-_ ]?(failed|error|expired|invalid|missing|required)/i;

export function isAuthFailure(stderrTail) {
  return AUTH_FAILURE_RE.test(String(stderrTail || ""));
}

export function slotEnvName(n) {
  return n <= 1 ? LEGACY_AUTH_ENV : `${LEGACY_AUTH_ENV}_${n}`;
}

// Configured slots in slot order. Empty values are ignored so a half-filled
// _2.._9 range just works and current single-key deploys see exactly slot 1.
export function collectSlots(env = process.env) {
  const slots = [];
  for (let n = 1; n <= MAX_AUTH_SLOTS; n++) {
    const value = String(env[slotEnvName(n)] || "");
    if (value) slots.push({ slot: n, value });
  }
  return slots;
}

export function hasNumberedSlots(env = process.env) {
  for (let n = 2; n <= MAX_AUTH_SLOTS; n++) {
    if (String(env[slotEnvName(n)] || "")) return true;
  }
  return false;
}

export function resolveCooldownMs(env = process.env) {
  const raw = Number.parseInt(String(env[AUTH_COOLDOWN_ENV] || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTH_COOLDOWN_MS;
}

// --- Retry clamp + per-class cooldowns (fleet-local port, no daemon) ---
// Computed cooldowns are clamped to PROVIDER_RETRY_MAX_MS (15 min,
// env-overridable via FLEET_RETRY_MAX_MS) so a misconfigured override can
// never park the pool for hours. Per-class split:
//   auth          -> FLEET_AUTH_COOLDOWN_MS (default 15 min)
//   quota         -> 30-min reserve (FLEET_QUOTA_COOLDOWN_MS, default 30 min)
//   transport     -> 5-min (FLEET_TRANSPORT_COOLDOWN_MS, default 5 min)
//   rate_limited  -> short model-level only (FLEET_RATE_LIMIT_COOLDOWN_MS)
//   unknown       -> short model-level only (FLEET_UNKNOWN_COOLDOWN_MS)
// Text-only 429 evidence is rate_limited ONLY: it cools the model retry map
// briefly and must NEVER set a quota-class (30-min) slot cooldown.
export const PROVIDER_RETRY_MAX_MS = 15 * 60 * 1000;
export const RETRY_MAX_ENV = "FLEET_RETRY_MAX_MS";
export const DEFAULT_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
export const QUOTA_COOLDOWN_ENV = "FLEET_QUOTA_COOLDOWN_MS";
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 2 * 60 * 1000;
export const RATE_LIMIT_COOLDOWN_ENV = "FLEET_RATE_LIMIT_COOLDOWN_MS";
export const DEFAULT_UNKNOWN_COOLDOWN_MS = 60 * 1000;
export const UNKNOWN_COOLDOWN_ENV = "FLEET_UNKNOWN_COOLDOWN_MS";

export function resolveRetryMaxMs(env = process.env) {
  const raw = Number.parseInt(String(env[RETRY_MAX_ENV] || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : PROVIDER_RETRY_MAX_MS;
}

export function clampCooldownMs(ms, env = process.env) {
  return Math.min(Number(ms) || 0, resolveRetryMaxMs(env));
}

function resolvePositive(env, name, fallback) {
  const raw = Number.parseInt(String(env[name] || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function resolveQuotaCooldownMs(env = process.env) {
  return resolvePositive(env, QUOTA_COOLDOWN_ENV, DEFAULT_QUOTA_COOLDOWN_MS);
}

export function resolveRateLimitCooldownMs(env = process.env) {
  return resolvePositive(env, RATE_LIMIT_COOLDOWN_ENV, DEFAULT_RATE_LIMIT_COOLDOWN_MS);
}

export function resolveUnknownCooldownMs(env = process.env) {
  return resolvePositive(env, UNKNOWN_COOLDOWN_ENV, DEFAULT_UNKNOWN_COOLDOWN_MS);
}

// kind: "auth" | "quota" | "transport" | "rate_limited" | "unknown".
// Returns the class cooldown clamped to the retry max.
export function resolveCooldownForClass(kind, env = process.env) {
  switch (kind) {
    case "quota": return clampCooldownMs(resolveQuotaCooldownMs(env), env);
    case "transport": return clampCooldownMs(resolveTransportCooldownMs(env), env);
    case "rate_limited": return clampCooldownMs(resolveRateLimitCooldownMs(env), env);
    case "unknown": return clampCooldownMs(resolveUnknownCooldownMs(env), env);
    case "auth":
    default: return clampCooldownMs(resolveCooldownMs(env), env);
  }
}

// Bare-429 / rate-limit text evidence (quota-class must NOT match here).
export const RATE_LIMIT_429_RE = /429|too many requests|rate.?limit/i;
// Strong quota evidence only: exhausted credits, billing, usage caps.
// A bare "429" never matches — it stays rate_limited per the product rule.
export const QUOTA_CLASS_RE = /quota|credits?\s*(exhausted|insufficient)|out of credits|billing|payment|usage.?limit|free\s*usage/i;

export function isRateLimitedText(stderrTail) {
  return RATE_LIMIT_429_RE.test(String(stderrTail || ""));
}

export function isQuotaClassFailure(stderrTail) {
  return QUOTA_CLASS_RE.test(String(stderrTail || ""));
}

// classifyFailure(text) -> "auth" | "quota" | "transport" | "rate_limited" | "unknown".
// Precedence mirrors the runOnce bookkeeping order: auth-class text wins
// over transport (checked first by callers), and 429/rate-limit text WITHOUT
// strong quota evidence is rate_limited ONLY — never quota.
export function classifyFailure(stderrTail) {
  const text = String(stderrTail || "");
  if (isTransportFailure(text) && !isAuthFailure(text)) return "transport";
  if (isQuotaClassFailure(text)) return "quota";
  if (isAuthFailure(text)) return isRateLimitedText(text) ? "rate_limited" : "auth";
  return "unknown";
}

// --- Per-model retry map (fleet-local, in-memory, 256-key cap) ---
// Consulted before each ladder round so a rate-limited model is skipped
// without burning a slot attempt. Unknown/empty model IDs share a single
// global fallback entry. Only sanitized IDs are stored.
export const MODEL_RETRY_MAX_KEYS = 256;
export const UNKNOWN_MODEL_KEY = "unknown-model";

const modelRetryAt = new Map();
let globalRetryAt = 0;

export function sanitizeModelId(modelId) {
  const clean = String(modelId || "").trim().slice(0, 160).replace(/[^A-Za-z0-9/_@.:-]/g, "_");
  return clean || UNKNOWN_MODEL_KEY;
}

function evictModelRetries() {
  while (modelRetryAt.size > MODEL_RETRY_MAX_KEYS) {
    const oldest = modelRetryAt.keys().next().value;
    modelRetryAt.delete(oldest);
  }
}

export function recordModelRetry(modelId, retryAtMs, { nowMs = Date.now(), cooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS } = {}) {
  const at = Number.isFinite(Number(retryAtMs)) ? Number(retryAtMs) : nowMs + cooldownMs;
  const key = sanitizeModelId(modelId);
  if (key === UNKNOWN_MODEL_KEY) {
    globalRetryAt = at;
    return { key, retryAt: at };
  }
  modelRetryAt.set(key, at);
  evictModelRetries();
  return { key, retryAt: at };
}

export function modelRetryWaitMs(modelId, { nowMs = Date.now() } = {}) {
  const key = sanitizeModelId(modelId);
  const at = key === UNKNOWN_MODEL_KEY ? globalRetryAt : (modelRetryAt.get(key) || 0);
  return Math.max(0, at - nowMs);
}

export function isModelCoolingDown(modelId, opts = {}) {
  return modelRetryWaitMs(modelId, opts) > 0;
}

export function clearModelRetry(modelId) {
  const key = sanitizeModelId(modelId);
  if (key === UNKNOWN_MODEL_KEY) {
    globalRetryAt = 0;
    return true;
  }
  return modelRetryAt.delete(key);
}

export function clearAllModelRetries() {
  modelRetryAt.clear();
  globalRetryAt = 0;
}

export function snapshotModelRetries({ nowMs = Date.now() } = {}) {
  const out = {};
  for (const [key, at] of modelRetryAt) out[key] = Math.max(0, at - nowMs);
  out[UNKNOWN_MODEL_KEY] = Math.max(0, globalRetryAt - nowMs);
  return out;
}

export function healthPath(stateRoot) {
  return path.join(stateRoot || process.cwd(), "state", "credential-health.json");
}

// Slots map keyed by slot number ("1".."9"); {} when absent/unparseable so a
// corrupt health file can never break model calls.
export function loadHealth(stateRoot) {
  try {
    const p = healthPath(stateRoot);
    if (!existsSync(p)) return {};
    const data = JSON.parse(readFileSync(p, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const slots = data.slots;
    return slots && typeof slots === "object" && !Array.isArray(slots) ? slots : {};
  } catch {
    return {};
  }
}

export function saveHealth(stateRoot, slots) {
  const p = healthPath(stateRoot);
  atomicWriteJsonSync(p, { updatedUtc: new Date().toISOString(), slots: slots || {} });
}

// Scrub secret-shaped substrings before persisting failure tails. Pool state
// must never carry key material.
function scrubTail(s) {
  return String(s || "")
    .replace(/(gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+|xox[bpas]-[A-Za-z0-9-]+)/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]");
}

function lastOkMs(entry) {
  if (!entry || !entry.lastOk) return -1;
  const t = Date.parse(entry.lastOk);
  return Number.isNaN(t) ? -1 : t;
}

// Remove every slot key from a child-process env copy. Numbered slots do not
// match the generic TOKEN|SECRET|... strip pattern, so they are removed
// explicitly — the child sees only OPENCODE_AUTH_CONTENT.
export function stripSlotKeys(envObj = {}) {
  for (let n = 1; n <= MAX_AUTH_SLOTS; n++) delete envObj[slotEnvName(n)];
  return envObj;
}

export function selectSlot({ env = process.env, stateRoot, nowMs = Date.now() } = {}) {
  const slots = collectSlots(env);
  if (slots.length === 0) return { missing: true };
  const now = nowMs;
  const health = loadHealth(stateRoot);
  const avail = [];
  for (const s of slots) {
    const h = health[String(s.slot)] || {};
    const until = Number(h.cooldownUntil) || 0;
    if (until > now) continue; // cooling down
    avail.push(s);
  }
  if (avail.length === 0) return { exhausted: true, total: slots.length };
  // Least-recently-healthy first; slot-number tiebreak rounds recovery back
  // to slot 1 first (owner's "go back to account 1" behavior).
  avail.sort((a, b) => {
    const d = lastOkMs(health[String(a.slot)]) - lastOkMs(health[String(b.slot)]);
    return d !== 0 ? d : a.slot - b.slot;
  });
  return { slot: avail[0].slot, value: avail[0].value, total: slots.length };
}

export function recordSuccess(stateRoot, slot, nowMs = Date.now()) {
  const health = loadHealth(stateRoot);
  health[String(slot)] = {
    ...(health[String(slot)] || {}),
    cooldownUntil: 0,
    consecutiveErrors: 0,
    lastOk: new Date(nowMs).toISOString(),
  };
  saveHealth(stateRoot, health);
  return health[String(slot)];
}

// Cools the slot down on auth-class failures only; other failures leave the
// pool untouched. Returns true when the slot was cooled down.
export function recordFailure(stateRoot, slot, stderrTail, { nowMs = Date.now(), cooldownMs = DEFAULT_AUTH_COOLDOWN_MS } = {}) {
  if (!isAuthFailure(stderrTail)) return false;
  const health = loadHealth(stateRoot);
  const prev = health[String(slot)] || {};
  health[String(slot)] = {
    ...prev,
    cooldownUntil: nowMs + clampCooldownMs(cooldownMs),
    consecutiveErrors: (Number(prev.consecutiveErrors) || 0) + 1,
    lastAuthError: scrubTail(stderrTail).slice(-200),
  };
  saveHealth(stateRoot, health);
  return true;
}
