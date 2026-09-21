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
import { existsSync, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from "node:fs";
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
  collectSlots,
  isAuthFailure,
  recordFailure,
  recordSuccess,
  resolveCooldownMs,
  selectSlot,
  stripSlotKeys,
} from "./credential-pool.mjs";
import { makeTerminal } from "./terminal.mjs";

import {
  CORE_INTEGRITY_OK,
  CORE_LOCK_DIGEST,
  CORE_MANIFEST,
  classifyQuotaAvailability,
  verifyCoreIntegrity,
} from "../../packages/indefinite-core/index.mjs";
import { publicModelEnv } from "./private-state.mjs";
import { startIndefiniteDispatcher, getDispatcherInstance } from "./indefinite-dispatcher.mjs";
import { getSystemPromptMemoryBlock, recordMistake, getRepoSlug } from "./persistent-memory.mjs";


// Model-layer timeouts (ms): standard calls 480s, long-form 540s,
// extended/vision 600s. Callers pick the tier that fits the task.
export const MODEL_TIMEOUTS = { standard: 480000, long: 540000, extended: 600000 };
// Whole-chain cooldown before a second ladder pass: 90s default,
// 120s for long-form calls.
export const CHAIN_RETRY_COOLDOWN_MS = 90000;
export const CHAIN_RETRY_COOLDOWN_LONG_MS = 120000;
export const CORE_MODEL_DIGEST = CORE_LOCK_DIGEST;

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

// Public target repositories are untrusted input.  Do not load their
// opencode.json (or any caller-supplied config) into a public model process:
// a target could otherwise re-enable edit/bash/external-directory access
// after this runtime's read-only airlock has been established.  Keep the
// useful read-only tools available for analysis and pin every mutation-capable
// tool to deny in the final config.
export const PUBLIC_READ_ONLY_PERMISSIONS = Object.freeze({
  edit: "deny",
  write: "deny",
  bash: "deny",
  external_directory: "deny",
  question: "deny",
  todowrite: "deny",
  read: "allow",
  grep: "allow",
  glob: "allow",
  list: "allow",
  webfetch: "allow",
  websearch: "allow",
});

export const ADVISORY_READ_ONLY_PERMISSIONS = Object.freeze({
  ...PUBLIC_READ_ONLY_PERMISSIONS,
  webfetch: "deny",
  websearch: "deny",
});

const ADVISORY_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "CI",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "GITHUB_ACTIONS",
  "GITHUB_SERVER_URL",
  "GITHUB_API_URL",
  "GITHUB_GRAPHQL_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_SHA",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_WORKFLOW",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_WORKFLOW_SHA",
  "RUNNER_OS",
  "RUNNER_ARCH",
  "RUNNER_NAME",
  "RUNNER_ENVIRONMENT",
  "FLEET_MODEL_CHAIN",
  "FLEET_JUDGE_MODEL",
  "FLEET_CHAIN_TTL_MS",
  "FLEET_GATEWAY_RETRY_MS",
  "FLEET_OPENCODE_DEBUG",
]);

const ADVISORY_AUTH_KEYS = Object.freeze([
  "FLEET_OPENCODE_AUTH",
  "FLEET_OPENCODE_AUTH_2",
  "FLEET_OPENCODE_AUTH_3",
  "FLEET_OPENCODE_AUTH_4",
  "FLEET_OPENCODE_AUTH_5",
  "FLEET_OPENCODE_AUTH_6",
  "FLEET_OPENCODE_AUTH_7",
  "FLEET_OPENCODE_AUTH_8",
  "FLEET_OPENCODE_AUTH_9",
]);

// Read-only environments carry their isolation proof by object identity, not
// by a caller-controlled marker in the environment.  This lets nested model
// calls reuse one verified boundary without re-running containment checks
// against the already-rewritten FLEET_STATE_ROOT.
const PREPARED_ADVISORY_ENVS = new WeakSet();

function isPreparedAdvisoryEnv(env) {
  return Boolean(env && typeof env === "object" && !Array.isArray(env) && PREPARED_ADVISORY_ENVS.has(env));
}

function rememberPreparedAdvisoryEnv(env) {
  if (env && typeof env === "object" && !Array.isArray(env)) PREPARED_ADVISORY_ENVS.add(env);
  return env;
}

function hasModelAuth(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return false;
  if (String(env.OPENCODE_AUTH_CONTENT || "")) return true;
  return ADVISORY_AUTH_KEYS.some((key) => Boolean(String(env[key] || "")));
}

function boundedAdvisoryValue(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  if (!text || text.length > 4096 || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
  return text;
}

function advisoryRoot(env = process.env) {
  const runnerTemp = path.resolve(String(env.RUNNER_TEMP || env.TMPDIR || os.tmpdir()));
  const configured = String(env.FLEET_ADVISORY_STATE_ROOT || "").trim();
  const root = path.resolve(configured || path.join(runnerTemp, "fleet-advisory-model"));
  const relative = path.relative(runnerTemp, root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("advisory model state must stay under runner temp");
  }
  for (const privateRoot of [
    env.FLEET_PRIVATE_STATE_ROOT,
    env.FLEET_STATE_ROOT ? path.join(String(env.FLEET_STATE_ROOT), "state") : "",
  ]) {
    const candidate = String(privateRoot || "").trim();
    if (!candidate) continue;
    const normalized = path.resolve(candidate);
    const privateRelative = path.relative(normalized, root);
    if (privateRelative === "" || (!privateRelative.startsWith("..") && !path.isAbsolute(privateRelative))) {
      throw new Error("advisory model state may not overlap controller state");
    }
  }
  return { runnerTemp, root };
}

function advisoryPathInfo(value, label = "path") {
  const lexical = path.resolve(String(value || ""));
  let probe = lexical;
  const missing = [];
  while (true) {
    try {
      const stat = lstatSync(probe);
      const baseReal = realpathSync.native(probe);
      const real = missing.length > 0 ? path.join(baseReal, ...missing.reverse()) : baseReal;
      if (stat.isSymbolicLink()) {
        return { label, lexical, real, exists: missing.length === 0, directory: false, symlink: true };
      }
      const exists = probe === lexical;
      return {
        label,
        lexical,
        real,
        exists,
        directory: exists && stat.isDirectory(),
        symlink: false,
      };
    } catch (error) {
      if (!error || !["ENOENT", "ENOTDIR"].includes(error.code)) {
        throw new Error(`${label} could not be verified`);
      }
      const parent = path.dirname(probe);
      if (parent === probe) return { label, lexical, real: undefined, exists: false, directory: false, symlink: false };
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

function advisoryPathWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function advisoryPathsOverlap(left, right) {
  return advisoryPathWithin(left, right) || advisoryPathWithin(right, left);
}

/**
 * Reject symlink aliases introduced below a trusted runner-temp prefix.  The
 * macOS /var -> /private/var alias is allowed as part of the trusted prefix;
 * a task-created alias inside that prefix is not.
 */
function assertAdvisoryWorkspaceSymlinkFree(workspace, runnerTemp) {
  const target = path.resolve(workspace);
  const trusted = path.resolve(runnerTemp);
  const relative = path.relative(trusted, target);
  const start = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
    ? trusted
    : path.parse(target).root;
  let current = start;
  for (const segment of path.relative(start, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("advisory model workspace may not use a symlink alias");
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") break;
      throw error;
    }
  }
}

function advisoryForbiddenRoots(source, advisoryStateRoot) {
  const entries = [];
  const seen = new Set();
  const add = (label, value) => {
    const raw = String(value || "").trim();
    if (!raw) return;
    const lexical = path.resolve(raw);
    const key = `${label}:${lexical}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(advisoryPathInfo(lexical, label));
  };
  add("controller checkout", source.GITHUB_WORKSPACE);
  add("workflow checkout", source.FLEET_WORKFLOW_ROOT);
  add("controller workspace", source.FLEET_CONTROLLER_WORKSPACE);
  add("runtime checkout", source.FLEET_RUNTIME_CHECKOUT_ROOT);
  add("controller state", source.FLEET_STATE_ROOT);
  if (source.FLEET_STATE_ROOT) add("controller state tree", path.join(String(source.FLEET_STATE_ROOT), "state"));
  add("private state", source.FLEET_PRIVATE_STATE_ROOT);
  add("public state", source.FLEET_PUBLIC_STATE_ROOT);
  add("advisory state", advisoryStateRoot);
  return entries;
}

function assertAdvisoryWorkspaceSeparated(workspaceInfo, forbiddenRoots) {
  for (const root of forbiddenRoots) {
    const left = workspaceInfo.real || workspaceInfo.lexical;
    const right = root.real || root.lexical;
    if (advisoryPathsOverlap(left, right) || advisoryPathsOverlap(workspaceInfo.lexical, root.lexical)) {
      throw new Error(`advisory model workspace may not overlap ${root.label}`);
    }
  }
}

function ensureAdvisoryWorkspace(source, workspaceInfo, runnerTempInfo) {
  // Existing checkouts are constrained just like newly created workspaces:
  // advisory analysis must run inside the dedicated runner-temp fence.
  if (!runnerTempInfo.exists || !runnerTempInfo.directory || runnerTempInfo.symlink) {
    throw new Error("runner temp root could not be verified");
  }
  if (runnerTempInfo.lexical === path.parse(runnerTempInfo.lexical).root) {
    throw new Error("runner temp root must be dedicated");
  }
  const lexicalWithin = advisoryPathWithin(runnerTempInfo.lexical, workspaceInfo.lexical);
  const canonicalWithin = runnerTempInfo.real && workspaceInfo.real
    ? advisoryPathWithin(runnerTempInfo.real, workspaceInfo.real)
    : false;
  if ((!lexicalWithin && !canonicalWithin) || workspaceInfo.lexical === runnerTempInfo.lexical) {
    throw new Error("advisory model workspace must stay under RUNNER_TEMP");
  }
  if (workspaceInfo.exists) {
    if (!workspaceInfo.directory || workspaceInfo.symlink) throw new Error("advisory model workspace must be a real directory");
    if (workspaceInfo.lexical === runnerTempInfo.lexical || (workspaceInfo.real && runnerTempInfo.real && workspaceInfo.real === runnerTempInfo.real)) {
      throw new Error("advisory model workspace must be a dedicated directory under runner temp");
    }
    return workspaceInfo;
  }
  const configuredRunnerTemp = String(source.RUNNER_TEMP || "").trim();
  if (!configuredRunnerTemp) {
    throw new Error("advisory model workspace must exist or be created under RUNNER_TEMP");
  }
  mkdirSync(workspaceInfo.lexical, { recursive: true, mode: 0o700 });
  const created = advisoryPathInfo(workspaceInfo.lexical, "advisory model workspace");
  if (!created.exists || !created.directory || created.symlink) {
    throw new Error("advisory model workspace could not be safely created");
  }
  return created;
}

function ensureAdvisoryRoot(runnerTemp, root, forbiddenRoots) {
  const runnerTempInfo = advisoryPathInfo(runnerTemp, "runner temp root");
  if (!runnerTempInfo.exists || !runnerTempInfo.directory || runnerTempInfo.symlink) {
    throw new Error("runner temp root could not be verified");
  }
  if (runnerTempInfo.lexical === path.parse(runnerTempInfo.lexical).root) {
    throw new Error("runner temp root must be dedicated");
  }
  const rootInfo = advisoryPathInfo(root, "advisory model state");
  const lexicalWithin = advisoryPathWithin(runnerTempInfo.lexical, rootInfo.lexical);
  const canonicalWithin = runnerTempInfo.real && rootInfo.real
    ? advisoryPathWithin(runnerTempInfo.real, rootInfo.real)
    : false;
  if ((!lexicalWithin && !canonicalWithin) || rootInfo.lexical === runnerTempInfo.lexical) {
    throw new Error("advisory model state must stay under runner temp");
  }
  assertAdvisoryWorkspaceSymlinkFree(rootInfo.lexical, runnerTempInfo.lexical);
  for (const entry of forbiddenRoots) {
    if (entry.label === "advisory state") continue;
    const left = rootInfo.real || rootInfo.lexical;
    const right = entry.real || entry.lexical;
    if (advisoryPathsOverlap(left, right) || advisoryPathsOverlap(rootInfo.lexical, entry.lexical)) {
      throw new Error(`advisory model state may not overlap ${entry.label}`);
    }
  }
  if (rootInfo.exists && (!rootInfo.directory || rootInfo.symlink)) {
    throw new Error("advisory model state must be a real directory");
  }
  mkdirSync(rootInfo.lexical, { recursive: true, mode: 0o700 });
  const verified = advisoryPathInfo(rootInfo.lexical, "advisory model state");
  if (!verified.exists || !verified.directory || verified.symlink) {
    throw new Error("advisory model state could not be safely created");
  }
  assertAdvisoryWorkspaceSymlinkFree(verified.lexical, runnerTempInfo.lexical);
  for (const directory of ["home", "tmp", "xdg-config", "xdg-data", "xdg-cache"]) {
    mkdirSync(path.join(verified.lexical, directory), { recursive: true, mode: 0o700 });
  }
  return verified.lexical;
}

/**
 * Build the environment visible to the hosted advisory model runner.
 *
 * This boundary is deliberately independent from FLEET_DATA_CLASS.  Private
 * reviews still use private controller code and bounded GitHub reads, but the
 * model child receives only provider auth plus a dedicated runtime workspace.
 * Controller tokens, checkout/state paths, and inherited OpenCode config are
 * omitted before spawn; runOnce adds the fixed read-only permission policy.
 */
export function advisoryModelEnv(env = process.env, { workspace } = {}) {
  const source = env && typeof env === "object" && !Array.isArray(env) ? env : {};
  const { runnerTemp, root } = advisoryRoot(source);
  const suppliedWorkspace = String(workspace || "").trim();
  const configuredWorkspace = suppliedWorkspace || String(source.FLEET_MODEL_WORKSPACE || source.FLEET_RUNTIME_WORKSPACE || "").trim();
  // Older callers passed process.cwd() when no workflow workspace contract
  // existed.  Fail closed against that controller checkout by materializing a
  // dedicated sibling under RUNNER_TEMP instead; an explicitly configured
  // workspace is always validated and never silently substituted.
  const implicitControllerWorkspace = !suppliedWorkspace && !String(source.FLEET_MODEL_WORKSPACE || source.FLEET_RUNTIME_WORKSPACE || "").trim();
  const requestedWorkspace = path.resolve(String(configuredWorkspace || (implicitControllerWorkspace ? path.join(runnerTemp, "fleet-advisory-workspace") : workspace) || path.join(runnerTemp, "fleet-advisory-workspace")));
  if (!requestedWorkspace.startsWith("/") || requestedWorkspace === "/") {
    throw new Error("advisory model workspace must be an absolute path");
  }
  const workspaceInfo = advisoryPathInfo(requestedWorkspace, "advisory model workspace");
  assertAdvisoryWorkspaceSymlinkFree(requestedWorkspace, runnerTemp);
  const forbiddenRoots = advisoryForbiddenRoots(source, root);
  // Check lexical paths before creating a missing workspace so an invalid
  // controller/state path is never materialized as a model directory.
  assertAdvisoryWorkspaceSeparated(workspaceInfo, forbiddenRoots);
  const runnerTempInfo = advisoryPathInfo(runnerTemp, "runner temp root");
  const verifiedWorkspace = ensureAdvisoryWorkspace(source, workspaceInfo, runnerTempInfo);
  assertAdvisoryWorkspaceSymlinkFree(verifiedWorkspace.lexical, runnerTemp);
  assertAdvisoryWorkspaceSeparated(verifiedWorkspace, forbiddenRoots);
  const verifiedRoot = ensureAdvisoryRoot(runnerTemp, root, forbiddenRoots);
  // Keep the caller's verified lexical path for cwd/config semantics.  The
  // canonical path was used above for all isolation decisions and symlink
  // aliases are rejected before this point.
  const modelWorkspace = verifiedWorkspace.lexical;
  const output = {};
  for (const key of ADVISORY_ENV_ALLOWLIST) {
    const safe = boundedAdvisoryValue(source[key]);
    if (safe !== undefined) output[key] = safe;
  }
  for (const key of ADVISORY_AUTH_KEYS) {
    const safe = boundedAdvisoryValue(source[key]);
    if (safe !== undefined) output[key] = safe;
  }
  if (String(source.FLEET_DATA_CLASS || "").trim().toLowerCase() === "public") {
    for (const key of ["FLEET_DATA_CLASS", "FLEET_PUBLIC_OWNER", "FLEET_PUBLIC_REPOSITORY", "FLEET_PUBLIC_STATE_ROOT", "FLEET_PUBLIC_ARTIFACT_MANIFEST"]) {
      const safe = boundedAdvisoryValue(source[key]);
      if (safe !== undefined) output[key] = safe;
    }
  }
  output.FLEET_ADVISORY_READ_ONLY = "1";
  output.FLEET_STATE_ROOT = verifiedRoot;
  output.FLEET_WORKSPACE_ROOT = modelWorkspace;
  output.RUNNER_TEMP = runnerTemp;
  output.HOME = path.join(verifiedRoot, "home");
  output.TMPDIR = path.join(verifiedRoot, "tmp");
  output.XDG_CONFIG_HOME = path.join(verifiedRoot, "xdg-config");
  output.XDG_DATA_HOME = path.join(verifiedRoot, "xdg-data");
  output.XDG_CACHE_HOME = path.join(verifiedRoot, "xdg-cache");
  output.GIT_TERMINAL_PROMPT = "0";
  return rememberPreparedAdvisoryEnv(output);
}

export function buildOpenCodeConfigContent(selectedModel, existing = "", workspace = "", options = {}) {
  const publicMode = options && options.publicMode === true;
  const readOnly = options && options.readOnly === true;
  let config = {};
  try {
    if (!publicMode && !readOnly) {
      const workspaceConfigPath = workspace ? path.join(workspace, "opencode.json") : "";
      const workspaceConfig = workspaceConfigPath && existsSync(workspaceConfigPath)
        ? parseConfigObject(readFileSync(workspaceConfigPath, "utf8"))
        : {};
      config = mergeConfig(workspaceConfig, parseConfigObject(existing));
    }
  } catch {}
  if (publicMode) config = { permission: { ...PUBLIC_READ_ONLY_PERMISSIONS } };
  if (readOnly) config = { permission: { ...ADVISORY_READ_ONLY_PERMISSIONS } };
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
    if (data && data.coreDigest !== undefined && data.coreDigest !== CORE_LOCK_DIGEST) return null;
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

export function runOnce({ prompt, sessionId, variant, timeoutMs = MODEL_TIMEOUTS.standard, env = process.env, files = [], model, modelOverride, workspace, readOnly = false }) {
  return new Promise((resolve) => {
    // Honor the requested model via the provider allowlist; fall back to the
    // chain primary. (Upstream opencode#47120: 1.18 discovery omits models, so
    // explicit `-m` IDs are passed through here rather than discovered.)
    const requested = String(modelOverride || model || DEFAULT_MODEL_CHAIN[0]).trim();
    const selected = isAllowedModel(requested) ? requested : DEFAULT_MODEL_CHAIN[0];
    if (readOnly) {
      try {
        if (!isPreparedAdvisoryEnv(env)) env = advisoryModelEnv(env, { workspace });
        workspace = env.FLEET_WORKSPACE_ROOT;
      } catch (error) {
        resolve({ reply: "", sessionId: "", exitCode: -1, interrupted: false, stderrTail: String(error?.message || error).slice(0, 240), spawnFailed: false, blocked: true, modelMode: "advisory-env-invalid", model: selected });
        return;
      }
    }
    if (String(env?.FLEET_DATA_CLASS || "").trim().toLowerCase() === "public") {
      try {
        env = publicModelEnv(env);
        if (readOnly) workspace = env.FLEET_WORKSPACE_ROOT;
      } catch {
        resolve({ reply: "", sessionId: "", exitCode: -1, interrupted: false, stderrTail: "public environment unavailable", spawnFailed: false, blocked: true, modelMode: "public-env-invalid", model: selected });
        return;
      }
    }
    const poolRoot = env.FLEET_STATE_ROOT || process.cwd();
    const coreRoot = String(env.FLEET_CORE_ROOT || "").trim();
    if (!CORE_INTEGRITY_OK || !verifyCoreIntegrity(coreRoot || undefined)) {
      resolve({ ...coreParityBlocked(poolRoot), model: selected, spawnFailed: false });
      return;
    }
    // Credential rotation pool: with numbered slots (FLEET_OPENCODE_AUTH_2.._9)
    // the active slot is selected per call; legacy single-key deploys behave
    // exactly as before. Telemetry records slot NUMBERS only, never values.
    const usePool = collectSlots(env).length > 0;
    let poolSlot = null;
    let poolValue = null;
    let exhaustedDegraded = false;
    let exhaustedTotal = 0;
    if (usePool) {
      const sel = selectSlot({ env, stateRoot: poolRoot });
      if (sel.exhausted) {
        // Never bypass provider-authorized credential capacity with an
        // anonymous attempt. Return a durable wait disposition directly.
        const wait = credentialCapacityWait(poolRoot, env, sel.total || 0);
        resolve({ ...wait, model: selected, spawnFailed: false, authMissing: true, slot: null });
        return;
      } else if (!sel.missing) {
        poolSlot = sel.slot;
        poolValue = sel.value;
      }
    }
    const authValue = usePool ? poolValue || "" : env.FLEET_OPENCODE_AUTH || env.OPENCODE_AUTH_CONTENT || "";
    const missing = !authValue;
    const usedSlot = poolSlot ?? (authValue ? 1 : null);
    const args = ["run", "--format", "json", "-m", selected];
    if (env.FLEET_OPENCODE_DEBUG === "1") args.push("--print-logs", "--log-level", "DEBUG");
    // Capability and exact-session continuity are independent of auth mode.
    // Anonymous, provider-authorized calls must retain xhigh/plain selection
    // and a supplied session rather than silently dropping either argument.
    if (variant) args.push("--variant", variant);
    if (sessionId) args.push("-s", sessionId);

  // Anti-downgrade & instrumental self-preservation directive
  const antiDowngradeBlock = [
    "=== CRITICAL ARCHITECTURAL DIRECTIVE & ANTI-DOWNGRADE INVARIANT ===",
    "DO NOT DELETE, REMOVE, DISABLE, OR DOWNGRADE ANY EXISTING CAPABILITIES.",
    "Replacing real functionality with synthetic mocks, fake stubs, or naive heuristics is strictly prohibited.",
    "Anything that makes system behavior different from the real implementation is an unacceptable downgrade.",
    "Always fix, harden, and improve with genuine, evidence-based code. Never use Gemini models under any circumstances.",
    "MAXIMUM OUTPUT CAPACITY & BATCH MULTI-TOOL EXECUTION: Batch multiple tool actions per turn (parallel file reads, searches, multi-file edits, and command verifications). Do NOT emit timid, truncated, or 100-token placeholder summaries. Deliver thorough, in-depth technical analysis, complete file implementations, and rigorous verification evidence.",
    `CORE CAPABILITIES: use ${CORE_MANIFEST.capabilities.reasoningEffort} reasoning, preserve tools and parallel tool calls, and continue up to the configured unbounded task budget (${CORE_MANIFEST.capabilities.unboundedSteps}) until the requested work is actually complete.`,
    "EXACT SESSION / SINGLE WRITER: preserve the supplied session identity and do not create a competing writer for the same task.",
    "===================================================================="
  ].join("\n");
  const repoRoot = workspace || env.FLEET_WORKSPACE_ROOT || process.cwd();
  const memoryBlock = getSystemPromptMemoryBlock(repoRoot, env);
  const effectivePrompt = [antiDowngradeBlock, memoryBlock, prompt].filter(Boolean).join("\n\n");

    args.push(effectivePrompt);
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
    if (childEnv.OPENCODE_MODELS_URL && (childEnv.OPENCODE_MODELS_URL.startsWith("file:") || childEnv.OPENCODE_MODELS_URL.endsWith(".json"))) {
      delete childEnv.OPENCODE_MODELS_URL;
    }
    // Pin OpenCode's internal title/summary helpers to the same selected live
    // contributor model. Otherwise OpenCode may call its paid default small
    // model even though the primary `-m` argument is free and valid.
    childEnv.OPENCODE_CONFIG_CONTENT = buildOpenCodeConfigContent(
      selected,
      childEnv.OPENCODE_CONFIG_CONTENT,
      workspace,
      {
        publicMode: String(env?.FLEET_DATA_CLASS || "").trim().toLowerCase() === "public",
        readOnly,
      },
    );
    childEnv.OPENCODE_DISABLE_AUTOUPDATE = "1";
    if (env.FLEET_INDEFINITE_DISABLE !== "1") {
      try {
        const dispatcher = startIndefiniteDispatcher({
          stateRoot: poolRoot,
          port: env.FLEET_DISPATCHER_PORT || 58444,
        });
        if (dispatcher && dispatcher.port) {
          childEnv.HTTP_PROXY = `http://127.0.0.1:${dispatcher.port}`;
          childEnv.HTTPS_PROXY = `http://127.0.0.1:${dispatcher.port}`;
          childEnv.NO_PROXY = "localhost,127.0.0.1";
        }
      } catch {}
    }
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
      const sessionNotFound = /session.*not found/i.test(`${stderr} ${stdout}`);
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
        sessionIdReturned: Boolean(sid),
        exitCode: code ?? -1,
        interrupted: timedOut,
        stderrTail: tail,
        rawTail: scrubTail(rawTailSrc).slice(-1200),
        spawnFailed: false,
        authMissing: missing,
        model: selected,
        slot: usedSlot,
        sessionNotFound,
        ...(exhaustedDegraded ? { exhausted: true, degraded: true, total: exhaustedTotal } : {}),
      });
    });
  });
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function coreParityBlocked(stateRoot, reason = "core-parity-mismatch") {
  const attempts = [{ round: 0, skipped: reason, parityMismatch: true }];
  return {
    reply: "",
    sessionId: "",
    modelMode: reason,
    attempts,
    complete: false,
    blocked: true,
    parityMismatch: true,
    surfaced: true,
    stderrTail: reason,
  };
}

function credentialCapacityRetryAt(stateRoot, env = process.env, now = Date.now()) {
  try {
    const p = path.join(stateRoot || process.cwd(), "state", "credential-health.json");
    const data = JSON.parse(readFileSync(p, "utf8"));
    const slots = data && data.slots && typeof data.slots === "object" ? Object.values(data.slots) : [];
    const future = slots
      .map((entry) => Number(entry?.cooldownUntil) || 0)
      .filter((until) => until > now);
    if (future.length > 0) return Math.min(...future);
  } catch {}
  return now + resolveCooldownMs(env);
}

function credentialCapacityWait(stateRoot, env, total) {
  const now = Date.now();
  const retryAt = credentialCapacityRetryAt(stateRoot, env, now);
  const retryAfterSec = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const quotaDisposition = {
    kind: "quota_wait",
    wait: true,
    surface: true,
    reason: "credential_capacity_exhausted",
    eligibleRoutes: [],
    retryAt,
    retryAfterSec,
  };
  try {
    writeAuthExhaustedFlag({ stateRoot, total, cooldownMs: resolveCooldownMs(env) });
  } catch {}
  return {
    reply: "",
    sessionId: "",
    modelMode: "waiting_for_capacity",
    attempts: [{ round: 0, skipped: "credential-capacity", exhausted: true, degraded: true }],
    complete: false,
    degraded: true,
    exhausted: true,
    waitingForCapacity: true,
    waiting_for_capacity: true,
    waitingForQuota: true,
    surfaced: true,
    retryAt,
    retryAfterSec,
    quotaDisposition,
  };
}

function allAttemptsQuotaLimited(attempts = []) {
  if (!Array.isArray(attempts) || attempts.length === 0) return false;
  return attempts.every((attempt) => {
    const text = `${attempt?.errTail || ""} ${attempt?.rawTail || ""}`;
    return Boolean(attempt?.exhausted) || /429|quota|rate[ -]?limit|free\s*usage|usage\s*limit/i.test(text);
  });
}

export async function askModel({ prompt, sessionId, timeoutMs = MODEL_TIMEOUTS.standard, env = process.env, preferVariantMax = true, maxRounds = 4, files = [], modelOverride, workspace, skipCircuitCheck = false, pinModel = false, readOnly = false }) {
  if (readOnly) {
    try {
      if (!isPreparedAdvisoryEnv(env)) env = advisoryModelEnv(env, { workspace });
      workspace = env.FLEET_WORKSPACE_ROOT;
    } catch (error) {
      return {
        reply: "",
        sessionId: "",
        modelMode: "advisory-env-invalid",
        attempts: [],
        complete: false,
        blocked: true,
        error: String(error?.message || error).slice(0, 240),
      };
    }
  }
  const stateRoot = env.FLEET_STATE_ROOT || process.cwd();
  const coreRoot = String(env.FLEET_CORE_ROOT || "").trim();
  if (!CORE_INTEGRITY_OK || !verifyCoreIntegrity(coreRoot || undefined)) return coreParityBlocked(stateRoot);
  if (collectSlots(env).length > 0) {
    const slotState = selectSlot({ env, stateRoot });
    if (slotState.exhausted) return credentialCapacityWait(stateRoot, env, slotState.total || 0);
  }
  if (!skipCircuitCheck && !sessionId && gatewayCircuitOpen(stateRoot)) {
    return { reply: "", sessionId: "", modelMode: "circuit-open", attempts: [{ round: 0, skipped: "circuit-open" }], complete: false, circuitOpen: true };
  }
  // An explicit override prioritizes that model as the chain head, while
  // preserving failover to the resolved chain so single-model outages or rate
  // limits never stall judging, revisions, or audits.
  const chain = modelOverride && isAllowedModel(modelOverride)
    ? (pinModel ? [modelOverride] : [modelOverride, ...resolveModelChain(env).filter((m) => m !== modelOverride)])
    : resolveModelChain(env);
  logModelAudit(stateRoot, { event: "chain_start", chain, sessionId: sessionId || null });
  const allAttempts = [];
  let lastSid = sessionId || "";
  let lastMode = "";
  let chainExhausted = false;
  for (let ci = 0; ci < chain.length; ci++) {
    logModelAudit(stateRoot, { event: "model_try", model: chain[ci], index: ci, total: chain.length });
    const r = await askOnModel({ model: chain[ci], isPrimary: ci === 0, prompt, sessionId: lastSid || undefined, timeoutMs, env, preferVariantMax, maxRounds, files, workspace, readOnly });
    allAttempts.push(...(r.attempts || []));
    lastSid = r.sessionId || "";
    lastMode = r.modelMode || lastMode;
    // Preserve a surfaced credential/quota wait across the chain boundary.
    // Once an authenticated route is capacity-limited, never continue to a
    // later anonymous or otherwise unauthorized attempt; callers must receive
    // the durable retry disposition and retryAt unchanged.
    if (r.waitingForCapacity || (r.waitingForQuota && r.surfaced && r.retryAt)) {
      return {
        ...r,
        sessionId: lastSid,
        modelMode: r.modelMode || "waiting_for_capacity",
        attempts: allAttempts,
        complete: false,
      };
    }
    // A surfaced credential wait is terminal for this invocation. For an
    // explicitly anonymous invocation, ordinary retries may continue; an
    // authenticated invocation never converts to an anonymous route.
    if (r.exhausted) chainExhausted = true;
    if (r.complete) {
      try { markGatewayUp(stateRoot); } catch {}
      logModelAudit(stateRoot, { event: "model_success", model: chain[ci], mode: r.modelMode, attempts: r.attempts?.length });
      return { reply: r.reply, sessionId: lastSid, sessionIdReturned: r.sessionIdReturned === true, modelMode: lastMode, attempts: allAttempts, complete: true, ...(chainExhausted ? { degraded: true, exhausted: true } : {}) };
    }
    logModelAudit(stateRoot, { event: "model_failover", model: chain[ci], nextModel: chain[ci + 1] || null, attempts: r.attempts?.length });
  }
  // Only mark gateway down when the entire resolved model chain fails.
  // A single modelOverride must not trip the global circuit breaker for all workflows.
  if (!modelOverride) {
    try { markGatewayDown(stateRoot, allAttempts.map((x) => x.errTail || "").join(" ").slice(-200), { attempts: allAttempts.length, modelMode: lastMode, chain }); } catch {}
  }
  logModelAudit(stateRoot, { event: "chain_failed", attempts: allAttempts.length, chain });
  const quotaUnavailable = allAttemptsQuotaLimited(allAttempts);
  const quotaDisposition = quotaUnavailable
    ? classifyQuotaAvailability({
      routes: chain.map((model) => ({ model, authorized: true, eligible: true, quotaLimited: true })),
      now: Date.now(),
    })
    : null;
  return {
    reply: "",
    sessionId: lastSid,
    modelMode: lastMode,
    attempts: allAttempts,
    complete: false,
    ...(chainExhausted ? { degraded: true, exhausted: true } : {}),
    ...(quotaDisposition ? { waitingForQuota: true, surfaced: true, quotaDisposition } : {}),
    sessionIdReturned: allAttempts.some((attempt) => attempt.sessionReturned === true),
  };
}

function stripAuth(env) {
  const clone = { ...env };
  delete clone.OPENCODE_AUTH_CONTENT;
  // Numbered slots included: anon rounds must not leak any slot key.
  const stripped = stripSlotKeys(clone);
  return isPreparedAdvisoryEnv(env) ? rememberPreparedAdvisoryEnv(stripped) : stripped;
}

async function askOnModel({ model, isPrimary, prompt, sessionId, timeoutMs, env, preferVariantMax, maxRounds, files, workspace, readOnly = false }) {
  const stateRoot = env.FLEET_STATE_ROOT || process.cwd();
  const startedAuthenticated = hasModelAuth(env);
  let sid = sessionId || "";
  let sessionReturned = false;
  // Contributor-tier thinking caps at xhigh (Standard-tier max is rejected on
  // contributor plans), so the ladder top is xhigh on this tier, max elsewhere.
  // Anonymous rounds are available only when the invocation began anonymous.
  const topMode = preferVariantMax ? (isContributorTier(model) ? "xhigh" : "max") : "plain";
  let mode = topMode;
  let useAuth = startedAuthenticated;
  let promptNow = prompt;
  const attempts = [];
  let ladderExhausted = false;
  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1) {
      const backoff = Math.round(20000 + Math.random() * 15000);
      await sleep(backoff);
    }
    const roundEnv = useAuth ? env : stripAuth(env);
    let r = await runOnce({ prompt: promptNow, sessionId: sid || undefined, variant: mode === "plain" ? undefined : mode, timeoutMs, env: roundEnv, files, workspace, model, readOnly });
    if (sid && (r.sessionNotFound || /session.*not found/i.test(`${r.stderrTail || ""} ${r.rawTail || ""}`))) {
      logModelAudit(stateRoot, { event: "session_not_found_cleared", staleSessionId: sid, model, round });
      attempts.push({
        round,
        model,
        mode,
        auth: useAuth ? "yes" : "anon",
        slot: r.slot ?? null,
        exit: r.exitCode,
        interrupted: r.interrupted,
        gotReply: false,
        hadSession: true,
        sessionReturned: false,
        sessionNotFound: true,
        errTail: (r.stderrTail || "").slice(-160),
        rawTail: (r.rawTail || "").slice(-300),
      });
      sid = "";
      r = await runOnce({ prompt: promptNow, sessionId: undefined, variant: mode === "plain" ? undefined : mode, timeoutMs, env: roundEnv, files, workspace, model, readOnly });
    }
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
      sessionReturned: r.sessionIdReturned === true,
      errTail: (r.stderrTail || "").slice(-160),
      rawTail: (r.rawTail || "").slice(-300),
      sessionNotFound: r.sessionNotFound === true,
    };
    attempts.push(att);
    logModelAudit(stateRoot, { event: "round_attempt", ...att });
    if (r.waitingForCapacity || r.waitingForQuota) {
      return { ...r, sessionId: r.sessionId || sid || "", attempts, modelMode: "waiting_for_capacity", complete: false };
    }
    if (startedAuthenticated && isAuthFailure(`${r.stderrTail || ""} ${r.rawTail || ""}`)) {
      const wait = credentialCapacityWait(stateRoot, env, collectSlots(env).length || 1);
      return { ...wait, sessionId: r.sessionId || sid || "", attempts, model: model, complete: false };
    }
    // A non-capacity failure can retry the same authorized route; never switch
    // an authenticated invocation to an anonymous route.
    if (r.exhausted) ladderExhausted = true;
    if (r.sessionId) sid = r.sessionId;
    if (r.sessionIdReturned === true) sessionReturned = true;
    if (!r.interrupted && r.exitCode === 0 && r.reply) {
      try { markGatewayUp(stateRoot); } catch {}
      return { reply: r.reply, sessionId: sid, sessionIdReturned: sessionReturned, modelMode: `${model}${mode === "plain" ? "" : `@${mode}`}`, attempts, complete: true, ...(ladderExhausted ? { degraded: true, exhausted: true } : {}) };
    }
    // Variant best-effort: an unknown/invalid-variant round failure
    // retries that round once WITHOUT --variant before falling through
    // the ladder. No ladder redesign.
    if (mode !== "plain" && /variant/i.test(r.stderrTail || "")) {
      const vr = await runOnce({ prompt: promptNow, sessionId: sid || undefined, variant: undefined, timeoutMs, env: roundEnv, files, workspace, model, readOnly });
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
        sessionReturned: vr.sessionIdReturned === true,
        errTail: (vr.stderrTail || "").slice(-160),
        rawTail: (vr.rawTail || "").slice(-300),
        variantRetry: true,
      });
      if (startedAuthenticated && isAuthFailure(`${vr.stderrTail || ""} ${vr.rawTail || ""}`)) {
        const wait = credentialCapacityWait(stateRoot, env, collectSlots(env).length || 1);
        return { ...wait, sessionId: vr.sessionId || sid || "", attempts, model, complete: false };
      }
      if (vr.sessionId) sid = vr.sessionId;
      if (vr.sessionIdReturned === true) sessionReturned = true;
      if (!vr.interrupted && vr.exitCode === 0 && vr.reply) {
        try { markGatewayUp(stateRoot); } catch {}
        return { reply: vr.reply, sessionId: sid, sessionIdReturned: sessionReturned, modelMode: `${model}`, attempts, complete: true, ...(ladderExhausted ? { degraded: true, exhausted: true } : {}) };
      }
    }
    if (mode === "max" || mode === "xhigh") {
      mode = "plain";
      continue;
    }
    if (useAuth) {
      if (startedAuthenticated) {
        promptNow = prompt;
        continue;
      }
      useAuth = false;
      sid = "";
      promptNow = prompt;
      continue;
    }
    promptNow = "You were interrupted mid-task. Continue from where you stopped and finish the job. Output ONLY the requested final answer now.";
    sid = "";
  }
  return { reply: "", sessionId: sid, sessionIdReturned: sessionReturned, modelMode: mode, attempts, complete: false, ...(ladderExhausted ? { degraded: true, exhausted: true } : {}) };
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
