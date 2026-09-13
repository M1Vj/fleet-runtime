import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTerminal as privateMakeTerminal } from "./terminal.mjs";

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
    throw new DataClassError(3, "PUBLIC_TARGET_INVALID", raw || "missing FLEET_PUBLIC_REPOSITORY");
  }
  const [targetOwner, name] = raw.split("/");
  if (targetOwner !== owner || !PATH_SEGMENT_RE.test(name) || name === "." || name === "..") {
    throw new DataClassError(3, "PUBLIC_TARGET_OWNER_MISMATCH", raw);
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

/** Public jobs receive a minimal, non-secret child environment. */
export function publicChildEnv(env = process.env, { forModel = false } = {}) {
  const stateRoot = publicStateRoot(env);
  const manifest = String(env?.FLEET_PUBLIC_ARTIFACT_MANIFEST || "");
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|COOKIE|SESSION|PROXY/i.test(key)) continue;
    if (/^(?:FLEET_|OPENCODE_|GH_|GITHUB_)/i.test(key)) continue;
    out[key] = value;
  }
  out.FLEET_DATA_CLASS = PUBLIC_DATA_CLASS;
  out.FLEET_PUBLIC_OWNER = DEFAULT_PUBLIC_OWNER;
  out.FLEET_PUBLIC_REPOSITORY = publicRepository(env);
  out.FLEET_PUBLIC_STATE_ROOT = stateRoot;
  out.FLEET_STATE_ROOT = stateRoot;
  if (manifest) out.FLEET_PUBLIC_ARTIFACT_MANIFEST = manifest;
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
const PUBLIC_PRIVATE_TEXT_RE = /(?:https?:|ftp:|file:|data:|\bwww\.|(?:^|[\s"'=])(?:~[\\/]|[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var|etc|opt|workspace|runner|Volumes)[\\/]|(?:private|secret|credential|session|log|artifact|prompt|source)[\\/][^\s"'<>]+)|\b(?:prompt|source|session|private(?:State)?|log|artifact)\s*[:=]|\b(?:private|secret|credential|session|prompt|source|log|artifact)\b|\b(?:gh[pousr]_|github_pat_|sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+[A-Za-z0-9._-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}))/i;
const PUBLIC_REPOSITORY_SHAPE_RE = /(?:^|[\s"'`([{=:])([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})(?=$|[\s"'`)}\],.;!?])/g;

function hasForeignRepositoryReference(text, repository) {
  const matches = String(text).matchAll(PUBLIC_REPOSITORY_SHAPE_RE);
  for (const match of matches) {
    if (!repository || match[1] !== repository) return true;
  }
  return false;
}

function publicScalar(value, max = 4000, key = "", repository) {
  const cleanKey = String(key || "");
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
  if (cleanKey === "repository" || cleanKey === "repo") {
    const text = scalar(value, max);
    return typeof text === "string" && repository && text.trim() === repository ? text.trim() : undefined;
  }
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  const text = String(value).slice(0, max);
  return PUBLIC_PRIVATE_TEXT_RE.test(text) || hasForeignRepositoryReference(text, repository) ? undefined : text;
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
  "impact", "effort", "error", "severity", "detail", "recommendation", "approach", "ok", "skipped", "note",
  "issue", "number", "commentId", "applied", "postedComment", "downgraded", "digestBytes", "stale", "actions", "model",
  "identity", "entries", "incidents", "t", "step", "msg",
]);
const PUBLIC_NESTED_DENY = /(?:token|secret|password|credential|cookie|session|prompt|reply|proxy|auth|private|source|log|artifact|path|url|repository)/i;

function allowPublicValue(value, depth = 0, repository) {
  if (depth > 4) return undefined;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => allowPublicValue(item, depth + 1, repository)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return publicScalar(value, 4000, "", repository);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const topLevel = depth === 0;
    if ((!topLevel && PUBLIC_NESTED_DENY.test(key)) || (topLevel && PUBLIC_NESTED_DENY.test(key) && !PUBLIC_FIELDS.has(key))) continue;
    if (!(topLevel ? PUBLIC_FIELDS : PUBLIC_NESTED_FIELDS).has(key)) continue;
    const clean = (key === "summary" || key === "error" || key === "prUrl" || key === "target" || key === "repository" || key === "repo")
      ? publicScalar(item, 4000, key, repository)
      : allowPublicValue(item, depth + 1, repository);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

export function publicArtifactPayload(payload = {}, { kind = "run", status = "ok", repository, runId } = {}) {
  if (repository) {
    const rawRepository = String(repository).trim();
    const [owner, name] = rawRepository.split("/");
    if (owner !== DEFAULT_PUBLIC_OWNER || !PATH_SEGMENT_RE.test(name || "") || !REPOSITORY_RE.test(rawRepository)) {
      throw new DataClassError(3, "PUBLIC_ARTIFACT_REPOSITORY_INVALID", rawRepository);
    }
    repository = `${owner}/${name}`;
  }
  const now = new Date().toISOString();
  const base = {
    schema: PUBLIC_ARTIFACT_SCHEMA,
    dataClass: PUBLIC_DATA_CLASS,
    kind: publicScalar(kind, 80, "", repository) || "run",
    status: publicScalar(status, 80, "", repository) || "ok",
    generatedUtc: now,
  };
  if (repository) base.repository = publicScalar(repository, 220, "repository", repository);
  if (runId) base.runId = publicScalar(runId, 160, "", repository);
  const clean = allowPublicValue(payload, 0, repository);
  const merged = { ...base, ...(clean && typeof clean === "object" && !Array.isArray(clean) ? clean : {}) };
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
  if (requested !== target) throw new DataClassError(3, "PUBLIC_ARTIFACT_TARGET_MISMATCH", requested || "missing");
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

export function writeExecutionAudit(audit, env = process.env, root = process.cwd(), runId = "run", title = "Fleet run", status = "ok", meta = {}) {
  if (isPublicDataClass(env)) {
    const entries = safeAudit([...(audit?.entries || [])]);
    const incidents = safeAudit([...(audit?.incidents || [])]);
    const previous = readPublicManifest(env) || {};
    return writePublicArtifact(env, { ...previous, mode: title, status, audit: { entries, incidents }, checks: meta }, {
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
        writePublicArtifact(env, { mode: options.lane || "terminal", status: state, results: details }, {
          kind: "terminal",
          status: state,
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
