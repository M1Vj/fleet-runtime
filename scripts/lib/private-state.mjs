import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTerminal as privateMakeTerminal } from "./terminal.mjs";
import {
  assertKillSwitchClear,
  CANONICAL_KILL_SWITCH_PATH,
} from "./kill-switch.mjs";

/**
 * Execution data-class helpers.
 *
 * The runtime historically assumed that every invocation ran from the
 * private controller checkout.  Public Actions jobs are deliberately a
 * different class: they may inspect one allow-listed public repository, but
 * they must never inherit private state, credentials, sessions, or write
 * authority.  Keep this module dependency-free so every lane can use the
 * same fail-closed boundary without changing the model/provider APIs.
 */

export const PUBLIC_DATA_CLASS = "public";
export const PRIVATE_DATA_CLASS = "private";
export const DEFAULT_PUBLIC_OWNER = "M1Vj";
export const PUBLIC_ARTIFACT_SCHEMA = "fleet-public-artifact-v1";
export const PRIVATE_REPOSITORY_ENV = Object.freeze({
  control: "FLEET_CONTROL_REPOSITORY",
  kb: "FLEET_KB_REPOSITORY",
  thesis: "FLEET_THESIS_REPOSITORY",
});

const REPOSITORY_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const CLOUD_PUBLISHER_KILL_SWITCH_PATH = CANONICAL_KILL_SWITCH_PATH;

export class DataClassError extends Error {
  constructor(code, reason, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
    this.code = code;
    this.reason = reason;
  }
}

export function resolveDataClass(env = process.env) {
  const raw = String(env?.FLEET_DATA_CLASS ?? "").trim().toLowerCase();
  // Existing controller workflows predate the explicit variable.  Keep
  // their behavior private while still rejecting an explicit typo.
  if (!raw) return PRIVATE_DATA_CLASS;
  if (raw === PUBLIC_DATA_CLASS || raw === PRIVATE_DATA_CLASS) return raw;
  throw new DataClassError(4, "DATA_CLASS_INVALID", raw);
}

export function isPublicDataClass(env = process.env) {
  return resolveDataClass(env) === PUBLIC_DATA_CLASS;
}

export function isPrivateDataClass(env = process.env) {
  return resolveDataClass(env) === PRIVATE_DATA_CLASS;
}

export function publicOwner(env = process.env) {
  const owner = String(env?.FLEET_PUBLIC_OWNER || DEFAULT_PUBLIC_OWNER).trim();
  if (owner !== DEFAULT_PUBLIC_OWNER) {
    throw new DataClassError(3, "PUBLIC_OWNER_NOT_ALLOWLISTED", owner || "missing");
  }
  return DEFAULT_PUBLIC_OWNER;
}

export function publicRepository(env = process.env) {
  const raw = String(env?.FLEET_PUBLIC_REPOSITORY || "").trim();
  const owner = publicOwner(env);
  if (!REPOSITORY_RE.test(raw)) {
    throw new DataClassError(3, "PUBLIC_TARGET_INVALID", "expected an allowlisted public owner/name");
  }
  const [targetOwner, name] = raw.split("/");
  if (targetOwner !== owner || !PATH_SEGMENT_RE.test(name) || name === "." || name === "..") {
    throw new DataClassError(3, "PUBLIC_TARGET_OWNER_MISMATCH", "target is outside the public owner allowlist");
  }
  return `${owner}/${name}`;
}

/**
 * Resolve a private destination only from private-mode runtime configuration.
 * Private repository identities are intentionally not compiled into the public
 * runtime; private workflows inject these values at execution time instead.
 */
export function privateRepository(env = process.env, variable = PRIVATE_REPOSITORY_ENV.control) {
  if (isPublicDataClass(env)) {
    throw new DataClassError(4, "PUBLIC_PRIVATE_REPOSITORY_BLOCKED", String(variable));
  }
  const key = String(variable || "").trim();
  const repository = String(env?.[key] || "").trim();
  if (!key || !REPOSITORY_RE.test(repository)) {
    throw new DataClassError(4, "PRIVATE_REPOSITORY_REQUIRED", key || "missing variable");
  }
  return repository;
}

function runnerTempRoot(env = process.env) {
  return path.resolve(String(env?.RUNNER_TEMP || env?.TMPDIR || tmpdir()));
}

export function publicStateRoot(env = process.env) {
  const runnerRoot = runnerTempRoot(env);
  const configured = String(env?.FLEET_PUBLIC_STATE_ROOT || "").trim();
  const root = path.resolve(configured || path.join(runnerRoot, "fleet-public-state"));
  const relative = path.relative(runnerRoot, root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new DataClassError(4, "PUBLIC_STATE_OUTSIDE_RUNNER_TEMP", root);
  }
  return root;
}

export function resolveStateRoot(env = process.env, codeRoot = process.cwd()) {
  if (isPublicDataClass(env)) return publicStateRoot(env);
  return path.resolve(String(env?.FLEET_STATE_ROOT || codeRoot));
}

function publicArtifactRoot(env = process.env) {
  const stateRoot = publicStateRoot(env);
  const configured = String(env?.FLEET_PUBLIC_ARTIFACT_MANIFEST || "").trim();
  if (!configured) throw new DataClassError(4, "PUBLIC_ARTIFACT_MANIFEST_MISSING");
  const manifest = path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(stateRoot, configured);
  const relative = path.relative(stateRoot, manifest);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new DataClassError(4, "PUBLIC_ARTIFACT_OUTSIDE_STATE", manifest);
  }
  if (!manifest.toLowerCase().endsWith(".json") || relative.includes("..")) {
    throw new DataClassError(4, "PUBLIC_ARTIFACT_MANIFEST_INVALID", manifest);
  }
  return manifest;
}

export function resolveArtifactManifest(env = process.env) {
  if (!isPublicDataClass(env)) return null;
  return publicArtifactRoot(env);
}

export function resolveArtifactDir(env = process.env, fallback = ".") {
  if (isPublicDataClass(env)) return path.dirname(publicArtifactRoot(env));
  return path.resolve(String(env?.FLEET_ARTIFACT_DIR || fallback));
}

export function publicRepositoryFromIdentity(identity, env = process.env) {
  if (identity?.dataClass === PUBLIC_DATA_CLASS && identity.repository) return String(identity.repository);
  return publicRepository(env);
}

const PUBLIC_CHILD_ENV_KEYS = new Set([
  "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TERM", "CI", "TZ", "NO_COLOR", "FORCE_COLOR",
  "GITHUB_ACTIONS", "GITHUB_SERVER_URL", "GITHUB_API_URL", "GITHUB_GRAPHQL_URL", "GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_REF_NAME", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_NUMBER", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKFLOW", "GITHUB_WORKFLOW_REF", "GITHUB_WORKFLOW_SHA",
  "RUNNER_OS", "RUNNER_ARCH", "RUNNER_NAME", "RUNNER_ENVIRONMENT", "RUNNER_TOOL_CACHE",
  "FLEET_MODEL_CHAIN", "FLEET_JUDGE_MODEL", "FLEET_CHAIN_TTL_MS", "FLEET_GATEWAY_RETRY_MS", "FLEET_OPENCODE_DEBUG",
]);

function boundedPublicEnvValue(value) {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  if (!text || text.length > 4096 || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
  return text;
}

function publicEphemeralDirectories(env, stateRoot) {
  const runnerRoot = runnerTempRoot(env);
  try {
    mkdirSync(runnerRoot, { recursive: true, mode: 0o700 });
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    try { chmodSync(runnerRoot, 0o700); } catch {}
    try { chmodSync(stateRoot, 0o700); } catch {}
    const realRunner = realpathSync(runnerRoot);
    const realState = realpathSync(stateRoot);
    const runnerPrefix = realRunner.endsWith(path.sep) ? realRunner : `${realRunner}${path.sep}`;
    if (realState !== realRunner && !realState.startsWith(runnerPrefix)) {
      throw new DataClassError(4, "PUBLIC_STATE_OUTSIDE_RUNNER_TEMP", stateRoot);
    }
    // Keep the caller's absolute runner/state spelling in the child env.  On
    // macOS `/var` is a symlink to `/private/var`; exporting realpath values
    // would make ordinary containment checks appear to escape the configured
    // public root even though the validated filesystem target is the same.
    // Every path is still realpath-checked below before it is returned.
    const paths = {
      home: path.join(stateRoot, "home"),
      config: path.join(stateRoot, "xdg-config"),
      data: path.join(stateRoot, "xdg-data"),
      cache: path.join(stateRoot, "xdg-cache"),
      tmp: path.join(stateRoot, "tmp"),
    };
    for (const directory of Object.values(paths)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { chmodSync(directory, 0o700); } catch {}
      const real = realpathSync(directory);
      const statePrefix = realState.endsWith(path.sep) ? realState : `${realState}${path.sep}`;
      if (real !== realState && !real.startsWith(statePrefix)) throw new DataClassError(4, "PUBLIC_ENV_ROOT_INVALID", directory);
    }
    return { ...paths, runner: runnerRoot, state: stateRoot };
  } catch (error) {
    if (error instanceof DataClassError) throw error;
    throw new DataClassError(4, "PUBLIC_ENV_ROOT_INVALID", stateRoot);
  }
}

/** Public jobs receive a minimal, non-secret child environment. */
export function publicChildEnv(env = process.env, { forModel = false } = {}) {
  const stateRoot = publicStateRoot(env);
  const ephemeral = publicEphemeralDirectories(env, stateRoot);
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!PUBLIC_CHILD_ENV_KEYS.has(key)) continue;
    const safe = boundedPublicEnvValue(value);
    if (safe !== undefined) out[key] = safe;
  }
  out.FLEET_DATA_CLASS = PUBLIC_DATA_CLASS;
  out.FLEET_PUBLIC_OWNER = DEFAULT_PUBLIC_OWNER;
  out.FLEET_PUBLIC_REPOSITORY = publicRepository(env);
  out.FLEET_PUBLIC_STATE_ROOT = ephemeral.state;
  out.FLEET_STATE_ROOT = ephemeral.state;
  out.FLEET_WORKSPACE_ROOT = ephemeral.state;
  out.RUNNER_TEMP = ephemeral.runner;
  out.HOME = ephemeral.home;
  out.XDG_CONFIG_HOME = ephemeral.config;
  out.XDG_DATA_HOME = ephemeral.data;
  out.XDG_CACHE_HOME = ephemeral.cache;
  out.TMPDIR = ephemeral.tmp;
  if (env?.FLEET_PUBLIC_ARTIFACT_MANIFEST) out.FLEET_PUBLIC_ARTIFACT_MANIFEST = resolveArtifactManifest(env);
  if (!forModel && env?.GITHUB_TOKEN) out.GITHUB_TOKEN = String(env.GITHUB_TOKEN);
  return out;
}

export function publicModelEnv(env = process.env) {
  return publicChildEnv(env, { forModel: true });
}

/**
 * Public mode is read-only with respect to GitHub and the private checkout.
 * Local state under runner temp is intentionally limited to the manifest.
 */
export function assertMutationAllowed(env = process.env, action = "mutation") {
  if (isPublicDataClass(env)) {
    throw new DataClassError(4, "PUBLIC_WRITE_BLOCKED", String(action));
  }
  if (String(env?.FLEET_CLOUD_UNTRUSTED || "") === "true") {
    throw new DataClassError(4, "CLOUD_UNTRUSTED_WRITE_BLOCKED", String(action));
  }
  if (String(env?.FLEET_CLOUD_TRUSTED_PUBLISHER || "") === "true") {
    // The private publisher must consult the durable VM marker immediately
    // before each external write.  A workflow workspace marker is not shared
    // with the controller and therefore fails closed instead of being trusted.
    if (String(env?.FLEET_CLOUD_PUBLISHER || "") !== "fleet-runner"
      || String(env?.FLEET_KILL_SWITCH_PATH || "") !== CLOUD_PUBLISHER_KILL_SWITCH_PATH) {
      throw new DataClassError(4, "CLOUD_PUBLISHER_STATE_INVALID", String(action));
    }
    if (existsSync(CLOUD_PUBLISHER_KILL_SWITCH_PATH)) {
      throw new DataClassError(2, "KILL_SWITCH_ENGAGED", CLOUD_PUBLISHER_KILL_SWITCH_PATH);
    }
  }
  try {
    assertKillSwitchClear(env);
  } catch (error) {
    throw new DataClassError(error?.code || 2, error?.reason || "KILL_SWITCH_SIGNAL_UNAVAILABLE", String(action));
  }
  return true;
}

export function publicTargetDecision(metadata, allowedOwners = [DEFAULT_PUBLIC_OWNER]) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { ok: false, reason: "missing-metadata" };
  }
  const owner = String(metadata.owner?.login || metadata.owner?.name || "");
  const visibility = String(metadata.visibility || "").toLowerCase();
  const name = String(metadata.name || "");
  if (!allowedOwners.includes(owner)) return { ok: false, reason: "owner-not-allowlisted" };
  if (metadata.private !== false || visibility !== "public") return { ok: false, reason: "not-public" };
  if (metadata.archived === true) return { ok: false, reason: "archived" };
  if (!PATH_SEGMENT_RE.test(name) || name === "." || name === "..") return { ok: false, reason: "name-invalid" };
  return { ok: true, repository: `${owner}/${name}` };
}

function scalar(value, max = 4000) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  return String(value).slice(0, max);
}

// Public artifacts are telemetry, not a transport for model output or runtime
// diagnostics.  Keep the few human-readable summaries that the public jobs
// intentionally emit, but fail closed for arbitrary summary/error strings and
// for text that looks like private provenance, paths, URLs, or credentials.
const PUBLIC_SAFE_SUMMARIES = new Set([
  "ok",
  "deferred",
  "blocked",
  "public inventory reviewed",
  "model unavailable",
  "public retrospective completed",
  "public status digest completed",
  "public thesis survey completed",
]);
const PUBLIC_SAFE_STATUSES = new Set([
  "ok",
  "rejected",
  "selected",
  "analyzed",
  "blocked",
  "deferred",
  "waiting_for_capacity",
  "awaiting-control",
  "awaiting-private-control",
]);
const PUBLIC_SAFE_EFFECT_STATES = new Set([
  "registered", "leased", "executing", "awaiting_receipt", "verifying", "completed", "blocked",
  "recovering", "escalated", "expired", "waiting_for_capacity", "unknown_effect",
]);
const PUBLIC_SAFE_SEMANTIC_STATUSES = new Set([
  "SUCCESS", "ACCEPTED", "DUPLICATE", "DEFERRED", "NO_OP", "AWAITING_RECEIPT", "WAITING_FOR_CAPACITY",
  "UNKNOWN_EFFECT", "BLOCKED", "RECOVERING", "EXPIRED", "UNKNOWN",
]);
const PUBLIC_SAFE_ERRORS = new Set([
  "DATA_CLASS_INVALID",
  "MODEL_UNAVAILABLE",
  "PRIVATE_REPOSITORY_REQUIRED",
  "PUBLIC_ARTIFACT_MANIFEST_INVALID",
  "PUBLIC_ARTIFACT_MANIFEST_MISSING",
  "PUBLIC_ARTIFACT_OUTSIDE_STATE",
  "PUBLIC_ARTIFACT_REPOSITORY_INVALID",
  "PUBLIC_ARTIFACT_TARGET_MISMATCH",
  "PUBLIC_OWNER_NOT_ALLOWLISTED",
  "PUBLIC_PRIVATE_REPOSITORY_BLOCKED",
  "PUBLIC_STATE_OUTSIDE_RUNNER_TEMP",
  "PUBLIC_TARGET_INVALID",
  "PUBLIC_TARGET_OWNER_MISMATCH",
  "PUBLIC_WRITE_BLOCKED",
]);
const PUBLIC_PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([A-Za-z0-9_.-]{1,100})\/(?:pull|issues)\/\d+$/;
// Reject concrete transport/path/credential markers while retaining bounded
// public prose. Bare words such as "source" or "private" are not secrets on
// their own and commonly occur in legitimate review findings.
const PUBLIC_PRIVATE_TEXT_RE = /(?:https?:|ftp:|file:|data:|\bwww\.|(?:^|[^A-Za-z0-9_])(?:~[\\/]|[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var|etc|opt|workspace|runner|Volumes)[\\/]|(?:private|secret|credential|session|log|artifact|prompt|source)[\\/][^\s"'<>]+)|\b(?:prompt|source|session|private(?:State)?|log|artifact)\s*[:=]|\b(?:private[-_])?(?:ses(?:sion)?|task|thread|job)[-_][A-Za-z0-9]{2,}\b|\b(?:gh[pousr]_|github_pat_|sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+[A-Za-z0-9._-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}))/i;
// Consume a source line/range or symbol anchor with the repository-shaped
// token. Otherwise the lookahead may backtrack at the file extension in
// `scripts/improve.mjs:123`, classify `scripts/improve` as an identity, and
// drop legitimate public evidence before the anchored path check runs.
const PUBLIC_REPOSITORY_SHAPE_RE = /(?:^|[\s"'`([{=:])([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})(?::[0-9]+(?:-[0-9]+)?|#[A-Za-z_$][A-Za-z0-9_$.-]*)?(?=$|[\s"'`)}\],.;!?])/g;

const PUBLIC_SOURCE_PATH_PREFIXES = new Set([
  ".github", "app", "apps", "client", "components", "config", "docs", "lib", "pages", "packages", "public", "scripts", "server", "src", "test", "tests",
]);

function isLikelySourcePath(reference) {
  const [prefix, ...rest] = String(reference || "").split("/");
  if (!PUBLIC_SOURCE_PATH_PREFIXES.has(prefix.toLowerCase()) || rest.length === 0) return false;
  const suffix = rest.join("/");
  return rest.length > 1 || /\.[A-Za-z0-9]{1,12}$/.test(suffix);
}

function hasForeignRepositoryReference(text, repository, { allowSourcePaths = false, rejectTarget = false } = {}) {
  const source = String(text);
  const matches = source.matchAll(PUBLIC_REPOSITORY_SHAPE_RE);
  for (const match of matches) {
    if (allowSourcePaths && isLikelySourcePath(match[1])) continue;
    if (!repository || match[1] !== repository || rejectTarget) return true;
  }
  // A repository-shaped pair can be embedded after a source prefix, e.g.
  // `src/Owner/foreign-repo`; the boundary regex above intentionally avoids
  // matching the first pair because it is followed by another slash. Inspect
  // adjacent path segments so a foreign owner/repo cannot survive as evidence.
  if (allowSourcePaths || source.includes("/")) {
    // Keep optional line/range or symbol anchors attached to the source path.
    // Otherwise `scripts/improve.mjs:123` backtracks to `scripts/improve` and
    // is falsely treated as a foreign owner/repository identity.
    const pathToken = /(?:^|[\s"'`([{=:])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)(?::[0-9]+(?:-[0-9]+)?|#[A-Za-z_$][A-Za-z0-9_$.-]*)?(?=$|[\s"'`)}\],.;!?])/g;
    const targetOwner = String(repository || "").split("/")[0];
    for (const token of source.matchAll(pathToken)) {
      const segments = token[1].split("/");
      if (segments.length < 2) continue;
      const prefix = segments[0].toLowerCase();
      // A known source prefix followed by one file segment is an ordinary
      // source path (for example src/foo-bar.js), not an owner/repository
      // identity. Deeper paths remain subject to the identity detector.
      if (allowSourcePaths && segments.length === 2
        && PUBLIC_SOURCE_PATH_PREFIXES.has(prefix)
        && /\.[A-Za-z0-9]{1,12}$/.test(segments[1])) continue;
      const start = segments.length >= 3 && PUBLIC_SOURCE_PATH_PREFIXES.has(segments[0].toLowerCase()) ? 1 : 0;
      for (let index = start; index < segments.length - 1; index += 1) {
        const candidate = `${segments[index]}/${segments[index + 1]}`;
        if (candidate === repository && !rejectTarget) continue;
        const owner = segments[index];
        const name = segments[index + 1];
        // File-like second segments are source paths; owner/repository-shaped
        // pairs remain forbidden even when nested under a source prefix.
        const secondBase = name.replace(/\.[A-Za-z0-9]{1,12}$/, "");
        const ownerLikeIdentity = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(owner)
          && /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/.test(secondBase);
        if (owner === targetOwner || !/\.[A-Za-z0-9]{1,12}$/.test(name) || ownerLikeIdentity) return true;
      }
    }
  }
  return false;
}

function publicScalar(value, max = 4000, key = "", repository) {
  const cleanKey = String(key || "");
  if (cleanKey === "status") {
    const text = scalar(value, max);
    return typeof text === "string" && PUBLIC_SAFE_STATUSES.has(text.trim()) ? text.trim() : undefined;
  }
  if (cleanKey === "effectState") {
    const text = scalar(value, max);
    return typeof text === "string" && PUBLIC_SAFE_EFFECT_STATES.has(text.trim()) ? text.trim() : undefined;
  }
  if (cleanKey === "semanticStatus") {
    const text = scalar(value, max);
    return typeof text === "string" && PUBLIC_SAFE_SEMANTIC_STATUSES.has(text.trim().toUpperCase()) ? text.trim().toUpperCase() : undefined;
  }
  if (cleanKey === "processSuccess" || cleanKey === "desiredTaskCompleted") {
    return typeof value === "boolean" ? value : undefined;
  }
  if (cleanKey === "summary") {
    const text = scalar(value, max);
    return typeof text === "string" && PUBLIC_SAFE_SUMMARIES.has(text.trim()) ? text.trim() : undefined;
  }
  if (cleanKey === "error") {
    const text = scalar(value, max);
    return typeof text === "string" && PUBLIC_SAFE_ERRORS.has(text.trim()) ? text.trim() : undefined;
  }
  if (cleanKey === "prUrl") {
    const text = scalar(value, max);
    if (typeof text !== "string" || !repository) return undefined;
    const match = text.trim().match(PUBLIC_PR_URL_RE);
    return match && `${match[1]}/${match[2]}` === repository ? text.trim() : undefined;
  }
  if (cleanKey === "target") {
    const text = scalar(value, max);
    return typeof text === "string" && repository && text.trim() === repository ? text.trim() : undefined;
  }
  if (cleanKey === "runId") {
    const text = scalar(value, max);
    return typeof text === "string" && /^(?:[0-9]{1,20}|[A-Fa-f0-9]{8,64})$/.test(text.trim()) ? text.trim() : undefined;
  }
  if (cleanKey === "repository" || cleanKey === "repo") {
    const text = scalar(value, max);
    return typeof text === "string" && repository && text.trim() === repository ? text.trim() : undefined;
  }
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  const text = String(value).slice(0, max);
  const allowSourcePaths = cleanKey === "evidence" || cleanKey === "evidencePaths" || cleanKey === "inspectedScope";
  if (cleanKey === "evidencePaths") {
    if (!/^(?:(?:[A-Za-z0-9_.-]+)[\\/])+[A-Za-z0-9_.-]+$/.test(text)
      || text.split(/[\\/]/).some((part) => part === "." || part === "..")
      || hasForeignRepositoryReference(text, repository, { allowSourcePaths: true, rejectTarget: true })) return undefined;
    return text;
  }
  const rejectTarget = !["repository", "repo", "target", "prUrl"].includes(cleanKey);
  return PUBLIC_PRIVATE_TEXT_RE.test(text) || hasForeignRepositoryReference(text, repository, { allowSourcePaths, rejectTarget }) ? undefined : text;
}

function safeAudit(audit) {
  const rows = Array.isArray(audit) ? audit : [];
  return rows.slice(-100).map((row) => ({
    t: scalar(row?.t, 64),
    step: scalar(row?.step, 80),
    msg: scalar(row?.msg, 800),
  })).filter((row) => row.t || row.step || row.msg);
}

const PUBLIC_FIELDS = new Set([
  "schema", "dataClass", "kind", "status", "mode", "repository", "repo", "target", "runId",
  "generatedUtc", "finishedUtc", "exitCode", "modelMode", "verdict", "findings", "ideas", "plan",
  "files", "lens", "prNumber", "prUrl", "count", "summary", "reason", "checks", "audit", "results",
  "selected", "validatedAt", "title", "why", "impact", "effort", "error", "externalWrites", "visibility", "archived",
  "analyzed", "blocked", "awaitingPrivateControl", "effectState", "processSuccess", "semanticStatus",
  "awaitingControl", "evidenceVerified", "sourceRevision", "treeSnapshot", "evidencePaths",
  "stageResults", "desiredTaskCompleted", "evidence",
]);

// Nested values are intentionally narrower than the top-level manifest.  A
// model or GitHub response may carry source text, URLs, artifact paths, or
// repository metadata under an otherwise-safe result/checks key.  Keep only
// fields that are useful public telemetry and taint-drop sensitive identity or
// provenance keys at every nested depth.
const PUBLIC_NESTED_FIELDS = new Set([
  "schema", "dataClass", "kind", "status", "mode", "target", "runId", "generatedUtc", "finishedUtc",
  "exitCode", "modelMode", "verdict", "findings", "ideas", "plan", "files", "lens", "prNumber", "prUrl",
  "count", "summary", "reason", "checks", "audit", "results", "selected", "validatedAt", "title", "why",
  "impact", "effort", "error", "externalWrites", "severity", "detail", "recommendation", "approach", "ok", "skipped", "note", "rationale", "evidence",
  "issue", "number", "commentId", "applied", "postedComment", "downgraded", "digestBytes", "stale", "actions", "model",
  "identity", "entries", "incidents", "t", "step", "msg",
  "analyzed", "blocked", "awaitingPrivateControl", "effectState", "processSuccess", "semanticStatus",
  "stageResults", "desiredTaskCompleted", "evidence", "receipt", "pick", "research", "plan", "implement", "review", "terminalState",
  "inspectedScope", "noFindingsRationale", "noFindingsVerified",
  "evidenceVerified", "sourceRevision", "treeSnapshot", "evidencePaths",
  "awaitingControl", "durableControl",
]);
const PUBLIC_NESTED_DENY = /(?:token|secret|password|credential|cookie|session|prompt|reply|proxy|auth|private|source|log|artifact|path|url|repository)/i;
const PUBLIC_SELECTION_MAX = 15;
const PUBLIC_SELECTION_FIELDS = new Set(["repo", "repository", "score", "weight", "rank"]);

function boundedSelectionNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1_000_000_000 ? number : undefined;
}

/**
 * Selection artifacts are the one nested shape that intentionally carries a
 * public repository identity.  Preserve only the validated target and small
 * ranking fields; foreign identities and arbitrary nested metadata are
 * dropped before the public manifest is written.
 */
function allowPublicSelection(value, repository) {
  if (typeof value === "boolean") return value;
  const raw = Array.isArray(value) ? value : [value];
  const entries = [];
  for (const item of raw.slice(0, PUBLIC_SELECTION_MAX)) {
    const candidate = typeof item === "string" ? { repo: item } : item;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const selectedRepository = String(candidate.repo ?? candidate.repository ?? "").trim();
    if (!repository || selectedRepository !== repository) continue;
    const clean = { repo: repository };
    for (const key of PUBLIC_SELECTION_FIELDS) {
      if (key === "repo" || key === "repository" || candidate[key] === undefined) continue;
      const bounded = key === "rank" ? Number(candidate[key]) : boundedSelectionNumber(candidate[key]);
      if (key === "rank" ? Number.isInteger(bounded) && bounded > 0 && bounded <= PUBLIC_SELECTION_MAX : bounded !== undefined) {
        clean[key] = bounded;
      }
    }
    entries.push(clean);
  }
  return entries;
}

function allowPublicValue(value, depth = 0, repository, key = "") {
  if (depth > 4) return undefined;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => allowPublicValue(item, depth + 1, repository, key)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return publicScalar(value, 4000, key, repository);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "selected") {
      const selection = allowPublicSelection(item, repository);
      if (selection !== undefined) out[key] = selection;
      continue;
    }
    const topLevel = depth === 0;
    if ((!topLevel && PUBLIC_NESTED_DENY.test(key)) || (topLevel && PUBLIC_NESTED_DENY.test(key) && !PUBLIC_FIELDS.has(key))) continue;
    if (!(topLevel ? PUBLIC_FIELDS : PUBLIC_NESTED_FIELDS).has(key)) continue;
    const clean = (key === "status" || key === "summary" || key === "error" || key === "prUrl" || key === "target" || key === "repository" || key === "repo")
      ? publicScalar(item, 4000, key, repository)
      : allowPublicValue(item, depth + 1, repository, key);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

export function publicArtifactPayload(payload = {}, { kind = "run", status = "ok", repository, runId } = {}) {
  if (repository) {
    const rawRepository = String(repository).trim();
    const [owner, name] = rawRepository.split("/");
    if (owner !== DEFAULT_PUBLIC_OWNER || !PATH_SEGMENT_RE.test(name || "") || !REPOSITORY_RE.test(rawRepository)) {
      throw new DataClassError(3, "PUBLIC_ARTIFACT_REPOSITORY_INVALID", "artifact target is not an allowlisted public repository");
    }
    repository = `${owner}/${name}`;
  }
  const now = new Date().toISOString();
  const safeKind = publicScalar(kind, 80, "", repository) || "run";
  const safeStatus = publicScalar(status, 80, "status", repository) || "blocked";
  const safeRunId = runId === undefined || runId === null ? undefined : publicScalar(runId, 160, "runId", repository);
  const base = {
    schema: PUBLIC_ARTIFACT_SCHEMA,
    dataClass: PUBLIC_DATA_CLASS,
    kind: safeKind,
    status: safeStatus,
    generatedUtc: now,
  };
  if (repository) base.repository = publicScalar(repository, 220, "repository", repository);
  if (safeRunId !== undefined) base.runId = safeRunId;
  const clean = allowPublicValue(payload, 0, repository);
  const merged = { ...base, ...(clean && typeof clean === "object" && !Array.isArray(clean) ? clean : {}) };
  // Caller options own schema-controlled telemetry.  Model/result payloads
  // cannot replace the explicit kind, status, or run identity.
  merged.kind = safeKind;
  merged.status = safeStatus;
  if (safeRunId !== undefined) merged.runId = safeRunId;
  else delete merged.runId;
  // The caller-supplied repository option is the only identity source. A
  // model/result payload cannot replace it with a private target.
  if (repository) {
    merged.repository = publicScalar(repository, 220, "repository", repository);
    if (merged.repo !== undefined && merged.repo !== merged.repository) delete merged.repo;
  } else {
    delete merged.repository;
    delete merged.repo;
  }
  return { ...merged, schema: PUBLIC_ARTIFACT_SCHEMA, dataClass: PUBLIC_DATA_CLASS };
}

export function writePublicArtifact(env = process.env, payload = {}, options = {}) {
  const manifest = publicArtifactRoot(env);
  const target = publicRepository(env);
  const requested = options.repository === undefined ? target : String(options.repository).trim();
  if (requested !== target) throw new DataClassError(3, "PUBLIC_ARTIFACT_TARGET_MISMATCH", "artifact target does not match the validated public repository");
  mkdirSync(path.dirname(manifest), { recursive: true });
  const value = publicArtifactPayload(payload, { ...options, repository: target });
  writeFileSync(manifest, JSON.stringify(value, null, 2), "utf8");
  return manifest;
}

export function writeExecutionArtifact(env = process.env, payload = {}, options = {}) {
  if (isPublicDataClass(env)) return writePublicArtifact(env, payload, options);
  const dir = resolveArtifactDir(env, options.fallbackDir || ".");
  mkdirSync(dir, { recursive: true });
  const name = String(options.name || "result.json");
  const output = path.join(dir, name);
  writeFileSync(output, JSON.stringify(payload, null, 2), "utf8");
  return output;
}

function stripPublicEnvelope(value = {}) {
  const out = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  for (const key of ["schema", "dataClass", "kind", "status", "repository", "repo", "runId"]) delete out[key];
  return out;
}

export function writeExecutionAudit(audit, env = process.env, root = process.cwd(), runId = "run", title = "Fleet run", status = "ok", meta = {}) {
  if (isPublicDataClass(env)) {
    const entries = safeAudit([...(audit?.entries || [])]);
    const incidents = safeAudit([...(audit?.incidents || [])]);
    const previous = readPublicManifest(env) || {};
    const checks = {
      ...(previous.checks && typeof previous.checks === "object" && !Array.isArray(previous.checks) ? previous.checks : {}),
      ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {}),
    };
    return writePublicArtifact(env, { ...stripPublicEnvelope(previous), mode: previous.mode || title, audit: { entries, incidents }, checks }, {
      kind: "audit",
      status,
      repository: env.FLEET_PUBLIC_REPOSITORY,
      runId,
    });
  }
  return audit.writeMarkdown(path.join(root, "audit"), runId, title, status, meta);
}

/** Public terminal telemetry is folded into the exact manifest, never events.jsonl. */
export function makeExecutionTerminal(env = process.env, root = process.cwd(), options = {}) {
  if (isPublicDataClass(env)) {
    return (state, details = {}) => {
      try {
        const previous = readPublicManifest(env) || {};
        const status = String(state || "").toUpperCase() === "BLOCKED" ? "blocked" : (previous.status || state);
        writePublicArtifact(env, { ...stripPublicEnvelope(previous), mode: previous.mode || options.lane || "terminal", results: { ...previous.results, ...details, terminalState: state } }, {
          kind: "terminal",
          status,
          repository: env.FLEET_PUBLIC_REPOSITORY,
          runId: details.runId,
        });
      } catch {}
      const named = String(state || "BLOCKED");
      console.log(`TERMINAL_STATE=${named}`);
      return named;
    };
  }
  return privateMakeTerminal(root, options);
}

export function publicStateExists(env = process.env) {
  try {
    return existsSync(publicStateRoot(env));
  } catch {
    return false;
  }
}

export function readPublicManifest(env = process.env) {
  try {
    const manifest = publicArtifactRoot(env);
    return JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return null;
  }
}
