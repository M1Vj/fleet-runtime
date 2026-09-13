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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LEGACY_AUTH_ENV = "FLEET_OPENCODE_AUTH";
export const MAX_AUTH_SLOTS = 9;
export const DEFAULT_AUTH_COOLDOWN_MS = 15 * 60 * 1000;
export const AUTH_COOLDOWN_ENV = "FLEET_AUTH_COOLDOWN_MS";

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
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ updatedUtc: new Date().toISOString(), slots: slots || {} }));
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
    cooldownUntil: nowMs + cooldownMs,
    consecutiveErrors: (Number(prev.consecutiveErrors) || 0) + 1,
    lastAuthError: scrubTail(stderrTail).slice(-200),
  };
  saveHealth(stateRoot, health);
  return true;
}
