/**
 * ============================================================================
 * FLEET RESILIENT RUNTIME & DYNAMIC MODEL ENGINE (MODEL DYNAMISM)
 * ============================================================================
 * CRITICAL ARCHITECTURAL DIRECTIVE & STRICT ANTI-DOWNGRADE INVARIANTS:
 * 1. Instrumental Survival & Autonomous Execution Invariant:
 *    The fleet runtime operates autonomously in GitHub Actions CI runners.
 *    Connectivity is sustained via dynamic credential pool rotation and resilient
 *    failover across the multi-model capability ladder.
 * 2. Strict Anti-Downgrade Invariant:
 *    DO NOT DELETE, REMOVE, DISABLE, OR DOWNGRADE THIS DYNAMIC MODEL CAPABILITY.
 *    Replacing this mechanism with synthetic mocks, fake stubs, or naive heuristics
 *    is strictly prohibited under all circumstances.
 *    Downgrading is NOT an option: ALWAYS FIX, HARDEN, AND IMPROVE PROPERLY.
 * 3. Model Dynamism Directive:
 *    The fleet dynamically shifts across verified live non-Gemini contributor models
 *    (e.g. Muse Spark 1.3, Muse Spark 1.2, Nemotron 3 Ultra, Nemotron 3.5 Lightning,
 *    MiMo 2.5) so no single model burns out or stalls.
 * 4. STRICT NEGATIVE INVARIANT:
 *    DO NOT USE GEMINI MODELS UNDER ANY CIRCUMSTANCES. Gemini models are
 *    strictly forbidden and must fail closed if requested.
 * 5. Core-Behavior Continuity Directive:
 *    Follow the configured real-provider model ladder, session/resume flow,
 *    and recovery behavior. Do not steer away from that core behavior, invent
 *    a replacement objective, or independently remove, switch, or fabricate
 *    capabilities. Treat failures as bugs to diagnose and repair in place;
 *    every change must preserve or improve the real behavior with evidence.
 * ============================================================================
 */
import { spawn } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { gatewayCircuitOpen, markGatewayDown, markGatewayUp } from "./gateway-health.mjs";
import {
  DEFAULT_MODEL_CHAIN,
  DYNAMIC_MODEL_POOL,
  isAllowedModel,
  isContributorTier,
  sanitizeModelChain,
} from "./provider-registry.mjs";
import {
  hasNumberedSlots,
  isAuthFailure,
  recordFailure,
  recordSuccess,
  resolveCooldownMs,
  selectSlot,
  stripSlotKeys,
} from "./credential-pool.mjs";
import { makeTerminal } from "./terminal.mjs";


// Model-layer timeouts (ms): standard calls 480s, long-form 540s,
// extended/vision 600s. Callers pick the tier that fits the task.
export const MODEL_TIMEOUTS = { standard: 480000, long: 540000, extended: 600000 };
// Whole-chain cooldown before a second ladder pass: 90s default,
// 120s for long-form calls.
export const CHAIN_RETRY_COOLDOWN_MS = 90000;
export const CHAIN_RETRY_COOLDOWN_LONG_MS = 120000;

function parseConfigObject(raw) {
  try {
    const parsed = JSON.parse(String(raw || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergeConfig(base, overlay) {
  if (!base || typeof base !== "object" || Array.isArray(base)) return overlay;
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeConfig(out[key] || {}, value)
      : value;
  }
  return out;
}

function stripSecretConfig(value, key = "") {
  if (/(token|secret|password|api[_-]?key|authorization|cookie)/i.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => stripSecretConfig(item)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const clean = stripSecretConfig(childValue, childKey);
    if (clean !== undefined) out[childKey] = clean;
  }
  return out;
}

export function buildOpenCodeConfigContent(selectedModel, existing = "", workspace = "") {
  let config = {};
  try {
    const workspaceConfigPath = workspace ? path.join(workspace, "opencode.json") : "";
    const workspaceConfig = workspaceConfigPath && existsSync(workspaceConfigPath)
      ? parseConfigObject(readFileSync(workspaceConfigPath, "utf8"))
      : {};
    config = mergeConfig(workspaceConfig, parseConfigObject(existing));
  } catch {}
  config.model = selectedModel;
  config.small_model = selectedModel;
  return JSON.stringify(stripSecretConfig(config));
}

function deepFind(obj, key, out = []) {
  if (obj === null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const item of obj) deepFind(item, key, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === key && typeof v === "string" && v.length > 0) out.push(v);
    deepFind(v, key, out);
  }
  return out;
}

function collectText(obj, out = []) {
  if (obj === null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const item of obj) collectText(item, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if ((k === "text" || k === "delta") && typeof v === "string") out.push(v);
    else collectText(v, out);
  }
  return out;
}

function isErrorEvent(event) {
  const type = String(event?.type || event?.event || event?.status || "").toLowerCase();
  return type === "error" || type.endsWith(".error") || Boolean(event?.error && typeof event.error === "object");
}

export const MODEL_CHAIN_FILE = "state/model-chain.json";
export const MODEL_CHAIN_TTL_MS_DEFAULT = 7 * 24 * 3600 * 1000;
export const CHAIN_TTL_ENV = "FLEET_CHAIN_TTL_MS";

export function resolveChainTtlMs(env = process.env) {
  const raw = Number.parseInt(String(env[CHAIN_TTL_ENV] || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : MODEL_CHAIN_TTL_MS_DEFAULT;
}

export function chainOverridePath(stateRoot) {
  return path.join(stateRoot || process.cwd(), MODEL_CHAIN_FILE);
}

// Runtime chain override file: {chain:[ids], updatedAt, source, ttlMs}.
// Strict validation: JSON parses, chain is 1..5 allowed IDs (allowlist +
// not dead, no dupes), updatedAt within TTL. Anything invalid → null
// (caller falls through; silent — no audit helper is imported here).
function loadChainOverride(stateRoot, env = process.env) {
  try {
    const p = chainOverridePath(stateRoot);
    if (!existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, "utf8"));
    const raw = data && data.chain;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 5) return null;
    const clean = sanitizeModelChain(raw);
    if (clean.length !== raw.length) return null;
    if (clean.length === 0) return null;
    const ts = Date.parse(String((data && data.updatedAt) || ""));
    if (Number.isNaN(ts)) return null;
    if (Date.now() - ts > resolveChainTtlMs(env)) return null;
    return { chain: clean, updatedAt: data.updatedAt, source: data.source };
  } catch {
    return null;
  }
}

export function resolveModelChain(env = process.env) {
  const raw = String(env.FLEET_MODEL_CHAIN || "").trim();
  if (raw) {
    const chain = sanitizeModelChain(raw.split(","));
    if (chain.length > 0) return chain.slice(0, 5);
  }
  const stateRoot = env.FLEET_STATE_ROOT || process.cwd();
  const over = loadChainOverride(stateRoot, env);
  if (over) return over.chain.slice(0, 5);
  // Bound self-DoS via a huge FLEET_MODEL_CHAIN: first 5 entries only.
  // Stale/invalid file + empty env → code default (never stuck).
  return [...DEFAULT_MODEL_CHAIN].slice(0, 5);
}

// Redact secret-like tokens from telemetry tails. Telemetry must never
// carry credentials; model IDs and exit codes are safe to keep.
function scrubTail(s) {
  return String(s || "")
    .replace(/(gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+|xox[bpas]-[A-Za-z0-9-]+)/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]");
}

// Complete fleet diagnostics & audit logger: emits structured records to stderr
// (when debugging enabled) and appends to state/model-audit.jsonl when stateRoot exists.
export function logModelAudit(stateRoot, event) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n";
  if (process.env.FLEET_DIAG_LOG === "1" || process.env.FLEET_OPENCODE_DEBUG === "1") {
    process.stderr.write(`[MODEL_AUDIT] ${line}`);
  }
  if (stateRoot) {
    try {
      const p = path.join(stateRoot, "state", "model-audit.jsonl");
      mkdirSync(path.dirname(p), { recursive: true });
      appendFileSync(p, line);
    } catch {}
  }
}

// Pool exhaustion is an async alert-intent flag for watchdog/retro (they own
// issue filing) plus a STALLED terminal event into state/events.jsonl
// (existing watchdog/retro convention). Best-effort only: never throws and
// never spawns — the model call path must never block on alerting.
export const AUTH_EXHAUSTED_FLAG = "state/auth-exhausted.json";

export function authExhaustedPath(stateRoot) {
  return path.join(stateRoot || process.cwd(), AUTH_EXHAUSTED_FLAG);
}

export function writeAuthExhaustedFlag({ stateRoot, total, cooldownMs }) {
  try {
    const p = authExhaustedPath(stateRoot);
    mkdirSync(path.dirname(p), { recursive: true });
    const nowMs = Date.now();
    writeFileSync(
      p,
      JSON.stringify({
        exhaustedAt: new Date(nowMs).toISOString(),
        slots: total,
        cooldownMs,
        cooldownUntil: nowMs + (Number(cooldownMs) || 0),
      }),
    );
  } catch {}
  try {
    makeTerminal(stateRoot, { lane: "model" })("STALLED", { why: "credential-pool-exhausted", slots: total, degraded: true });
  } catch {}
  return true;
}

export function runOnce({ prompt, sessionId, variant, timeoutMs = MODEL_TIMEOUTS.standard, env = process.env, files = [], model, modelOverride, workspace }) {
  return new Promise((resolve) => {
    // Honor the requested model via the provider allowlist; fall back to the
    // chain primary. (Upstream opencode#47120: 1.18 discovery omits models, so
    // explicit `-m` IDs are passed through here rather than discovered.)
    const requested = String(modelOverride || model || DEFAULT_MODEL_CHAIN[0]).trim();
    const selected = isAllowedModel(requested) ? requested : DEFAULT_MODEL_CHAIN[0];
    const poolRoot = env.FLEET_STATE_ROOT || process.cwd();
    // Credential rotation pool: with numbered slots (FLEET_OPENCODE_AUTH_2.._9)
    // the active slot is selected per call; legacy single-key deploys behave
    // exactly as before. Telemetry records slot NUMBERS only, never values.
    const usePool = hasNumberedSlots(env);
    let poolSlot = null;
    let poolValue = null;
    let exhaustedDegraded = false;
    let exhaustedTotal = 0;
    if (usePool) {
      const sel = selectSlot({ env, stateRoot: poolRoot });
      if (sel.exhausted) {
        // Non-stop rotation: never halt on exhaustion. File an async
        // alert-intent flag for watchdog/retro (they own issue filing),
        // then fall through to the anon attempt below. No spawn here
        // except the model child.
        exhaustedDegraded = true;
        exhaustedTotal = sel.total || 0;
        try {
          writeAuthExhaustedFlag({ stateRoot: poolRoot, total: exhaustedTotal, cooldownMs: resolveCooldownMs(env) });
        } catch {}
      } else if (!sel.missing) {
        poolSlot = sel.slot;
        poolValue = sel.value;
      }
    }
    const authValue = usePool ? poolValue || "" : env.FLEET_OPENCODE_AUTH || "";
    const missing = !authValue;
    const usedSlot = poolSlot ?? (authValue ? 1 : null);
    const args = ["run", "--format", "json", "-m", selected];
    if (env.FLEET_OPENCODE_DEBUG === "1") args.push("--print-logs", "--log-level", "DEBUG");
    if (!missing && variant) args.push("--variant", variant);
    if (!missing && sessionId) args.push("-s", sessionId);
    args.push(prompt);
    const workspaceRoot = env.FLEET_WORKSPACE_ROOT || process.cwd();
    for (const f of files || []) {
      let attachPath = f;
      try {
        const rel = path.relative(workspaceRoot, f);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          const attDir = path.join(workspaceRoot, ".opencode-attachments");
          mkdirSync(attDir, { recursive: true });
          attachPath = path.join(attDir, `${Date.now()}-${path.basename(f)}`);
          if (existsSync(f)) copyFileSync(f, attachPath);
        }
      } catch {}
      if (existsSync(attachPath)) args.push("--file", attachPath);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const childEnv = { ...env };
    for (const key of Object.keys(childEnv)) {
      if (/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(key) && key !== "OPENCODE_AUTH_CONTENT") delete childEnv[key];
    }
    delete childEnv.FLEET_GH_TOKEN;
    delete childEnv.GH_TOKEN;
    delete childEnv.GDRIVE_REFRESH_TOKEN;
    delete childEnv.GDRIVE_CLIENT_SECRET;
    stripSlotKeys(childEnv);
    childEnv.OPENCODE_AUTH_CONTENT = authValue;
    // Pin OpenCode's internal title/summary helpers to the same selected live
    // contributor model. Otherwise OpenCode may call its paid default small
    // model even though the primary `-m` argument is free and valid.
    childEnv.OPENCODE_CONFIG_CONTENT = buildOpenCodeConfigContent(selected, childEnv.OPENCODE_CONFIG_CONTENT, workspace);
    childEnv.OPENCODE_DISABLE_AUTOUPDATE = "1";
    const child = spawn("opencode", args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"], cwd: workspace || undefined });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ reply: "", sessionId: "", exitCode: -1, interrupted: false, stderrTail: scrubTail(err.message).slice(-400), spawnFailed: true, slot: usedSlot, ...(exhaustedDegraded ? { exhausted: true, degraded: true, total: exhaustedTotal } : {}) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let reply = "";
      let sid = "";
      try {
        // Non-streaming `--format json` parse: synthesize reply text from
        // event payloads. (Muse streaming omits finish_reason, so completion
        // is derived from exit code + non-empty reply, never from a stop field.)
        const events = [];
        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try { events.push(JSON.parse(trimmed)); } catch { continue; }
        }
        const errorEvent = events.find(isErrorEvent);
        if (errorEvent) {
          reply = "";
          const errorMessage = errorEvent?.error?.message || errorEvent?.message || "model returned an error event";
          stderr += `\n${String(errorMessage).slice(0, 400)}`;
        } else {
          reply = events.map((e) => collectText(e).join("")).filter(Boolean).join("\n").trim();
        }
        const ids = events.map((e) => deepFind(e, "sessionID")).flat();
        sid = ids[ids.length - 1] || "";
      } catch {
        reply = "";
      }
      if (!reply) {
        const tail = stdout.split("\n").filter((l) => !l.trim().startsWith("{") && l.trim()).join("\n").trim();
        reply = tail.slice(-4000);
      }
      const rawTailSrc = stdout.split("\n").filter(Boolean).slice(-8).join("\n").slice(-1200);
      const tail = scrubTail(stderr).slice(-400);
      // Pool bookkeeping: success clears the slot, auth-class failures cool
      // it down so the next call rotates. Slot number only — never values.
      if (poolSlot !== null && poolSlot !== undefined) {
        try {
          if (!timedOut && (code ?? -1) === 0 && reply) recordSuccess(poolRoot, poolSlot);
          else if (isAuthFailure(tail)) recordFailure(poolRoot, poolSlot, tail, { cooldownMs: resolveCooldownMs(env) });
        } catch {}
      }
      resolve({
        reply,
        sessionId: sid,
        exitCode: code ?? -1,
        interrupted: timedOut,
        stderrTail: tail,
        rawTail: scrubTail(rawTailSrc).slice(-1200),
        spawnFailed: false,
        authMissing: missing,
        model: selected,
        slot: usedSlot,
        ...(exhaustedDegraded ? { exhausted: true, degraded: true, total: exhaustedTotal } : {}),
      });
    });
  });
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function askModel({ prompt, sessionId, timeoutMs = MODEL_TIMEOUTS.standard, env = process.env, preferVariantMax = true, maxRounds = 4, files = [], modelOverride, workspace, skipCircuitCheck = false }) {
  const stateRoot = env.FLEET_STATE_ROOT || process.cwd();
  if (!skipCircuitCheck && !sessionId && gatewayCircuitOpen(stateRoot)) {
    return { reply: "", sessionId: "", modelMode: "circuit-open", attempts: [{ round: 0, skipped: "circuit-open" }], complete: false, circuitOpen: true };
  }
  // An explicit override prioritizes that model as the chain head, while
  // preserving failover to the resolved chain so single-model outages or rate
  // limits never stall judging, revisions, or audits.
  const chain = modelOverride && isAllowedModel(modelOverride)
    ? [modelOverride, ...resolveModelChain(env).filter((m) => m !== modelOverride)]
    : resolveModelChain(env);
  logModelAudit(stateRoot, { event: "chain_start", chain, sessionId: sessionId || null });
  const allAttempts = [];
  let lastSid = sessionId || "";
  let lastMode = "";
  let chainExhausted = false;
  for (let ci = 0; ci < chain.length; ci++) {
    logModelAudit(stateRoot, { event: "model_try", model: chain[ci], index: ci, total: chain.length });
    const r = await askOnModel({ model: chain[ci], isPrimary: ci === 0, prompt, sessionId: lastSid || undefined, timeoutMs, env, preferVariantMax, maxRounds, files, workspace });
    allAttempts.push(...(r.attempts || []));
    if (r.sessionId) lastSid = r.sessionId;
    lastMode = r.modelMode || lastMode;
    // Non-stop rotation: never stop the chain on exhaustion — each model
    // runs its own anon rounds (runOnce falls through on exhaustion) and
    // callers defer/retry on complete:false. Track the signal for the
    // degraded result shape below.
    if (r.exhausted) chainExhausted = true;
    if (r.complete) {
      try { markGatewayUp(stateRoot); } catch {}
      logModelAudit(stateRoot, { event: "model_success", model: chain[ci], mode: r.modelMode, attempts: r.attempts?.length });
      return { reply: r.reply, sessionId: lastSid, modelMode: lastMode, attempts: allAttempts, complete: true, ...(chainExhausted ? { degraded: true, exhausted: true } : {}) };
    }
    logModelAudit(stateRoot, { event: "model_failover", model: chain[ci], nextModel: chain[ci + 1] || null, attempts: r.attempts?.length });
  }
  // Only mark gateway down when the entire resolved model chain fails.
  // A single modelOverride must not trip the global circuit breaker for all workflows.
  if (!modelOverride) {
    try { markGatewayDown(stateRoot, allAttempts.map((x) => x.errTail || "").join(" ").slice(-200), { attempts: allAttempts.length, modelMode: lastMode, chain }); } catch {}
  }
  logModelAudit(stateRoot, { event: "chain_failed", attempts: allAttempts.length, chain });
  return { reply: "", sessionId: lastSid, modelMode: lastMode, attempts: allAttempts, complete: false, ...(chainExhausted ? { degraded: true, exhausted: true } : {}) };
}

function stripAuth(env) {
  const clone = { ...env };
  delete clone.OPENCODE_AUTH_CONTENT;
  // Numbered slots included: anon rounds must not leak any slot key.
  return stripSlotKeys(clone);
}

async function askOnModel({ model, isPrimary, prompt, sessionId, timeoutMs, env, preferVariantMax, maxRounds, files, workspace }) {
  const stateRoot = env.FLEET_STATE_ROOT || process.cwd();
  let sid = sessionId || "";
  // Contributor-tier thinking caps at xhigh (Standard-tier max is rejected on
  // contributor plans), so the ladder top is xhigh on this tier, max elsewhere:
  // xhigh|max → plain → anon → resume.
  const topMode = preferVariantMax ? (isContributorTier(model) ? "xhigh" : "max") : "plain";
  let mode = topMode;
  let useAuth = true;
  let promptNow = prompt;
  const attempts = [];
  let ladderExhausted = false;
  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1) {
      const backoff = Math.round(20000 + Math.random() * 15000);
      await sleep(backoff);
    }
    const roundEnv = useAuth ? env : stripAuth(env);
    const r = await runOnce({ prompt: promptNow, sessionId: sid || undefined, variant: mode === "plain" ? undefined : mode, timeoutMs, env: roundEnv, files, workspace, model });
    const att = {
      round,
      model,
      mode,
      auth: useAuth ? "yes" : "anon",
      slot: r.slot ?? null,
      ...(r.exhausted ? { exhausted: true, degraded: true } : {}),
      exit: r.exitCode,
      interrupted: r.interrupted,
      gotReply: Boolean(r.reply),
      hadSession: Boolean(r.sessionId),
      errTail: (r.stderrTail || "").slice(-160),
      rawTail: (r.rawTail || "").slice(-300),
    };
    attempts.push(att);
    logModelAudit(stateRoot, { event: "round_attempt", ...att });
    // Non-stop rotation: an exhausted round already ran anon inside runOnce
    // (degraded); keep laddering through anon/resume rounds instead of
    // stopping. Callers defer/retry on complete:false.
    if (r.exhausted) ladderExhausted = true;
    if (r.sessionId) sid = r.sessionId;
    if (!r.interrupted && r.exitCode === 0 && r.reply) {
      try { markGatewayUp(stateRoot); } catch {}
      return { reply: r.reply, sessionId: sid, modelMode: `${model}${mode === "plain" ? "" : `@${mode}`}`, attempts, complete: true, ...(ladderExhausted ? { degraded: true, exhausted: true } : {}) };
    }
    // Variant best-effort: an unknown/invalid-variant round failure
    // retries that round once WITHOUT --variant before falling through
    // the ladder. No ladder redesign.
    if (mode !== "plain" && /variant/i.test(r.stderrTail || "")) {
      const vr = await runOnce({ prompt: promptNow, sessionId: sid || undefined, variant: undefined, timeoutMs, env: roundEnv, files, workspace, model });
      if (vr.exhausted) ladderExhausted = true;
      attempts.push({
        round,
        model,
        mode: "plain",
        auth: useAuth ? "yes" : "anon",
        slot: vr.slot ?? null,
        ...(vr.exhausted ? { exhausted: true, degraded: true } : {}),
        exit: vr.exitCode,
        interrupted: vr.interrupted,
        gotReply: Boolean(vr.reply),
        hadSession: Boolean(vr.sessionId),
        errTail: (vr.stderrTail || "").slice(-160),
        rawTail: (vr.rawTail || "").slice(-300),
        variantRetry: true,
      });
      if (vr.sessionId) sid = vr.sessionId;
      if (!vr.interrupted && vr.exitCode === 0 && vr.reply) {
        try { markGatewayUp(stateRoot); } catch {}
        return { reply: vr.reply, sessionId: sid, modelMode: `${model}`, attempts, complete: true, ...(ladderExhausted ? { degraded: true, exhausted: true } : {}) };
      }
    }
    if (mode === "max" || mode === "xhigh") {
      mode = "plain";
      continue;
    }
    if (useAuth) {
      useAuth = false;
      sid = "";
      promptNow = prompt;
      continue;
    }
    promptNow = "You were interrupted mid-task. Continue from where you stopped and finish the job. Output ONLY the requested final answer now.";
    sid = "";
  }
  return { reply: "", sessionId: sid, modelMode: mode, attempts, complete: false, ...(ladderExhausted ? { degraded: true, exhausted: true } : {}) };
}

export async function askModelResilient(opts) {
  const first = await askModel(opts);
  if (first.complete) return { ...first, ladders: 1 };
  const longForm = Boolean(opts.longForm) || (opts.timeoutMs || 0) >= MODEL_TIMEOUTS.long;
  const cooldownMs = opts.cooldownMs ?? (longForm ? CHAIN_RETRY_COOLDOWN_LONG_MS : CHAIN_RETRY_COOLDOWN_MS);
  await new Promise((r) => setTimeout(r, cooldownMs));
  const second = await askModel({ ...opts, maxRounds: Math.max(2, (opts.maxRounds || 4) - 1) });
  return { ...second, ladders: 2 };
}
