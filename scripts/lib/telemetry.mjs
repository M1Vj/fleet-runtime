import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const TELEMETRY_SCHEMA_VERSION = 1;
export const TELEMETRY_MAX_EVENTS = 2000;
export const TELEMETRY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const TELEMETRY_SUFFIX = `${path.sep}state${path.sep}telemetry.jsonl`;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_ID_CHARS = 120;
const MAX_MODEL_CHARS = 160;
const MAX_REPO_CHARS = 120;
const MAX_EVENT_CHARS = 32;
const MAX_HEAD_CHARS = 64;
const MAX_NESTED_KEYS = 16;

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "eventId",
  "occurredAt",
  "runId",
  "invocationId",
  "correlationId",
  "lane",
  "event",
  "phase",
  "outcome",
  "repo",
  "pr",
  "headSha",
  "attempt",
  "chainIndex",
  "durationBucket",
  "errorCode",
  "httpClass",
  "cooldownBucket",
  "state",
  "provider",
  "comment",
  "judge",
  "research",
  "workflow",
  "promotion",
  "selfHeal",
  "terminal",
]);

const NESTED_KEYS = Object.freeze({
  provider: new Set(["name", "model", "routeClass", "accountScope", "attempt", "chainIndex", "durationBucket", "errorCode", "httpClass", "cooldownBucket"]),
  comment: new Set(["fingerprint", "action"]),
  judge: new Set(["lens", "verdict", "score", "previousScore", "scoreDelta", "blockerCount", "previousBlockerCount", "progress"]),
  research: new Set(["phase", "reasonCode", "sourceCount", "citationCount", "dispatchStatus"]),
  workflow: new Set(["name", "runId", "runAttempt", "job", "conclusion"]),
  promotion: new Set(["operation", "phase", "disposition", "canaryStatus", "candidateDigest", "rollbackDigest"]),
  selfHeal: new Set(["action", "reasonCode", "outcome", "staleAgeBucket"]),
  terminal: new Set(["state"]),
});

const ENUMS = Object.freeze({
  lane: new Set(["merge", "revise", "research", "deep", "improve", "patrol", "watchdog", "promotion", "sentinel", "selftest", "kb", "retro", "thesis", "terminal", "unknown"]),
  event: new Set(["provider", "comment", "judge", "research", "workflow", "selfheal", "promotion", "terminal"]),
  phase: new Set(["selected", "attempt", "fallback", "cooldown", "claim", "post", "verify", "progress", "dispatch", "retrieval", "finalize", "activate", "rollback", "outcome", "start", "complete", "completed", "requeue", "hold", "request", "synthesis", "continuation", "planned", "verified", "committed", "pushed", "canary"]),
  outcome: new Set(["started", "succeeded", "failed", "unknown", "held", "deduped", "skipped"]),
  routeClass: new Set(["private-paid", "public-free", "local", "unknown"]),
  accountScope: new Set(["none", "account", "provider", "project"]),
  durationBucket: new Set(["lt1s", "1to5s", "5to15s", "15to30s", "gt30s", "unknown"]),
  errorCode: new Set(["auth_rejected", "rate_limited", "quota_exhausted", "timeout", "network", "unavailable", "invalid", "unknown", "none"]),
  httpClass: new Set(["2xx", "4xx", "429", "5xx", "timeout", "network", "none"]),
  cooldownBucket: new Set(["none", "lt1m", "1to5m", "gt5m"]),
  commentAction: new Set(["existing", "claimed", "claim_lost", "posted", "verify_failed", "verified"]),
  judgeLens: new Set(["correctness", "standards", "unknown"]),
  judgeVerdict: new Set(["approved", "rejected", "infrastructure"]),
  judgeProgress: new Set(["baseline", "improved", "repeat", "regressed", "unknown"]),
  researchPhase: new Set(["request", "dispatch", "retrieval", "synthesis", "finalize", "continuation"]),
  researchReason: new Set(["low_confidence", "no_progress", "unavailable", "dispatch_failed", "dispatch_unknown", "none"]),
  researchDispatch: new Set(["accepted", "failed", "unknown", "consumed", "none"]),
  workflowConclusion: new Set(["success", "failure", "cancelled", "skipped", "unknown"]),
  promotionOperation: new Set(["activate", "rollback"]),
  promotionPhase: new Set(["planned", "verified", "committed", "pushed", "canary", "rollback", "completed"]),
  promotionDisposition: new Set(["accepted", "held", "failed"]),
  canaryStatus: new Set(["not_run", "passed", "failed"]),
  selfHealAction: new Set(["heartbeat_recover", "dispatch_requeue", "issue_reuse", "kill_switch_hold", "workflow_enable"]),
  selfHealReason: new Set(["no_heartbeat", "stale", "queue", "kill_switch", "auto_enable_off"]),
  selfHealOutcome: new Set(["planned", "dispatched", "held", "failed"]),
  staleAgeBucket: new Set(["lt5m", "5to30m", "gt30m"]),
  terminalState: new Set(["SUCCESS", "NO-OP", "BLOCKED", "STALLED", "EXHAUSTED", "NO_PROGRESS", "REVISION_QUEUED", "ERROR", "MERGE_UNKNOWN", "MERGE_VERIFY_FAILED", "READY_REQUIRED", "STALE_HEAD"]),
});

const FORBIDDEN_KEYS = new Set([
  "prompt", "body", "diff", "review", "reviewtext", "reviewnotes", "stdout", "stderr", "rawtail", "errtail",
  "url", "urls", "credential", "credentials", "token", "secret", "apikey", "api_key", "oauth", "cookies", "cookie", "pii",
]);

const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{8,}/i,
  /(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/i,
  /\bsk-[A-Za-z0-9_-]{8,}/i,
  /\bBearer\s+(?=[A-Za-z0-9._~+\/-]{12,})(?:[A-Za-z0-9._~+\/-]{12,})/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/i,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\b(?:[A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL))\s*[:=]\s*[^\s,]{8,}/i,
  /\b(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*[^\s,]{12,}/i,
];
const URL_PATTERN = /\b(?:https?|ftp|ssh):\/\/|\bwww\.[^\s]+/i;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SAFE_CORRELATION_RE = /^(?:corr|research)-[A-Za-z0-9._:-]{1,100}$/;
const SAFE_PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SAFE_MODEL_RE = /^[A-Za-z0-9@/:._+-]{1,160}$/;
const SAFE_JOB_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/i;
const FINGERPRINT_RE = /^comment-[a-f0-9]{64}$/i;

export class TelemetryValidationError extends Error {
  constructor(message, code = "TELEMETRY_SCHEMA_REJECTED") {
    super(`${code}: ${message}`);
    this.name = "TelemetryValidationError";
    this.code = code;
  }
}

function fail(message, code = "TELEMETRY_SCHEMA_REJECTED") {
  throw new TelemetryValidationError(message, code);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function boundedIdentifier(value, fallback = "unknown") {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  if (!SAFE_ID_RE.test(text)) fail("telemetry identifier is invalid");
  return text.slice(0, MAX_ID_CHARS);
}

function boundedEnum(value, values, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim();
  if (!values.has(text)) fail(`telemetry ${label} is invalid`);
  return text;
}

function boundedInt(value, { min = 0, max = 2000, fallback = 0, label = "number" } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail(`telemetry ${label} is invalid`);
  return number;
}

function boundedScore(value, label) {
  return boundedInt(value, { min: 0, max: 100, fallback: 0, label });
}

function checkStringSafety(value) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) fail("telemetry secret-like input rejected", "TELEMETRY_SECRET_REJECTED");
  if (URL_PATTERN.test(value)) fail("telemetry URL input rejected", "TELEMETRY_SCHEMA_REJECTED");
}

function assertRawSafe(value, key = "") {
  if (value === undefined) return;
  if (typeof key === "string" && FORBIDDEN_KEYS.has(key.toLowerCase())) fail(`telemetry field ${key} is forbidden`);
  if (typeof value === "string") {
    checkStringSafety(value);
    if (value.length > 2000) fail("telemetry string exceeds bound");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("telemetry number is invalid");
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > MAX_NESTED_KEYS) fail("telemetry array exceeds bound");
    value.forEach((item) => assertRawSafe(item, ""));
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) assertRawSafe(childValue, childKey);
    return;
  }
  fail("telemetry value type is invalid");
}

function assertKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`telemetry ${label} block is invalid`);
  const keys = Object.keys(value);
  if (keys.length > MAX_NESTED_KEYS || keys.some((key) => !allowed.has(key))) fail(`telemetry ${label} contains undeclared fields`);
}

function normalizeProvider(source) {
  if (source === undefined) return undefined;
  assertKeys(source, NESTED_KEYS.provider, "provider");
  const result = {};
  if (source.name !== undefined) {
    const name = String(source.name).trim().toLowerCase();
    if (!SAFE_PROVIDER_RE.test(name)) fail("telemetry provider name is invalid");
    result.name = name;
  }
  if (source.model !== undefined) {
    const model = String(source.model).trim();
    if (!SAFE_MODEL_RE.test(model)) fail("telemetry provider model is invalid");
    result.model = model.slice(0, MAX_MODEL_CHARS);
  }
  for (const [key, enumName] of [["routeClass", "routeClass"], ["accountScope", "accountScope"], ["durationBucket", "durationBucket"], ["errorCode", "errorCode"], ["httpClass", "httpClass"], ["cooldownBucket", "cooldownBucket"]]) {
    if (source[key] !== undefined) result[key] = boundedEnum(source[key], ENUMS[enumName], "unknown", `provider.${key}`);
  }
  if (source.attempt !== undefined) result.attempt = boundedInt(source.attempt, { min: 0, max: 1000, label: "provider.attempt" });
  if (source.chainIndex !== undefined) result.chainIndex = boundedInt(source.chainIndex, { min: 0, max: 100, label: "provider.chainIndex" });
  return result;
}

function normalizeComment(source) {
  if (source === undefined) return undefined;
  assertKeys(source, NESTED_KEYS.comment, "comment");
  const result = {};
  if (source.fingerprint !== undefined) {
    const fingerprint = String(source.fingerprint).trim().toLowerCase();
    if (!FINGERPRINT_RE.test(fingerprint)) fail("telemetry comment fingerprint is invalid");
    result.fingerprint = fingerprint;
  }
  if (source.action !== undefined) result.action = boundedEnum(source.action, ENUMS.commentAction, "existing", "comment.action");
  return result;
}

function normalizeJudge(source) {
  if (source === undefined) return undefined;
  assertKeys(source, NESTED_KEYS.judge, "judge");
  const result = {};
  if (source.lens !== undefined) result.lens = boundedEnum(source.lens, ENUMS.judgeLens, "unknown", "judge.lens");
  if (source.verdict !== undefined) result.verdict = boundedEnum(source.verdict, ENUMS.judgeVerdict, "infrastructure", "judge.verdict");
  for (const key of ["score", "previousScore"]) if (source[key] !== undefined) result[key] = boundedScore(source[key], `judge.${key}`);
  if (source.scoreDelta !== undefined) result.scoreDelta = boundedInt(source.scoreDelta, { min: -100, max: 100, label: "judge.scoreDelta" });
  for (const key of ["blockerCount", "previousBlockerCount"]) if (source[key] !== undefined) result[key] = boundedInt(source[key], { min: 0, max: 32, label: `judge.${key}` });
  if (source.progress !== undefined) result.progress = boundedEnum(source.progress, ENUMS.judgeProgress, "unknown", "judge.progress");
  return result;
}

function normalizeResearch(source) {
  if (source === undefined) return undefined;
  assertKeys(source, NESTED_KEYS.research, "research");
  const result = {};
  if (source.phase !== undefined) result.phase = boundedEnum(source.phase, ENUMS.researchPhase, "request", "research.phase");
  if (source.reasonCode !== undefined) result.reasonCode = boundedEnum(source.reasonCode, ENUMS.researchReason, "none", "research.reasonCode");
  for (const key of ["sourceCount", "citationCount"]) if (source[key] !== undefined) result[key] = boundedInt(source[key], { min: 0, max: 16, label: `research.${key}` });
  if (source.dispatchStatus !== undefined) result.dispatchStatus = boundedEnum(source.dispatchStatus, ENUMS.researchDispatch, "none", "research.dispatchStatus");
  return result;
}

function normalizeWorkflow(source) {
  if (source === undefined) return undefined;
  assertKeys(source, NESTED_KEYS.workflow, "workflow");
  const result = {};
  if (source.name !== undefined) {
    const name = String(source.name).trim().toLowerCase();
    if (!SAFE_JOB_RE.test(name)) fail("telemetry workflow name is invalid");
    result.name = name;
  }
  if (source.runId !== undefined) result.runId = boundedIdentifier(source.runId);
  if (source.runAttempt !== undefined) result.runAttempt = boundedInt(source.runAttempt, { min: 1, max: 100, fallback: 1, label: "workflow.runAttempt" });
  if (source.job !== undefined) {
    const job = String(source.job).trim().toLowerCase();
    if (!SAFE_JOB_RE.test(job)) fail("telemetry workflow job is invalid");
    result.job = job;
  }
  if (source.conclusion !== undefined) result.conclusion = boundedEnum(source.conclusion, ENUMS.workflowConclusion, "unknown", "workflow.conclusion");
  return result;
}

function normalizePromotion(source) {
  if (source === undefined) return undefined;
  assertKeys(source, NESTED_KEYS.promotion, "promotion");
  const result = {};
  if (source.operation !== undefined) result.operation = boundedEnum(source.operation, ENUMS.promotionOperation, "activate", "promotion.operation");
  if (source.phase !== undefined) result.phase = boundedEnum(source.phase, ENUMS.promotionPhase, "planned", "promotion.phase");
  if (source.disposition !== undefined) result.disposition = boundedEnum(source.disposition, ENUMS.promotionDisposition, "held", "promotion.disposition");
  if (source.canaryStatus !== undefined) result.canaryStatus = boundedEnum(source.canaryStatus, ENUMS.canaryStatus, "not_run", "promotion.canaryStatus");
  for (const key of ["candidateDigest", "rollbackDigest"]) {
    if (source[key] === undefined) continue;
    const digest = String(source[key]).trim().toLowerCase();
    if (!DIGEST_RE.test(digest)) fail(`telemetry promotion ${key} is invalid`);
    result[key] = digest;
  }
  return result;
}

function normalizeSelfHeal(source) {
  if (source === undefined) return undefined;
  assertKeys(source, NESTED_KEYS.selfHeal, "selfHeal");
  const result = {};
  if (source.action !== undefined) result.action = boundedEnum(source.action, ENUMS.selfHealAction, "heartbeat_recover", "selfHeal.action");
  if (source.reasonCode !== undefined) result.reasonCode = boundedEnum(source.reasonCode, ENUMS.selfHealReason, "stale", "selfHeal.reasonCode");
  if (source.outcome !== undefined) result.outcome = boundedEnum(source.outcome, ENUMS.selfHealOutcome, "planned", "selfHeal.outcome");
  if (source.staleAgeBucket !== undefined) result.staleAgeBucket = boundedEnum(source.staleAgeBucket, ENUMS.staleAgeBucket, "gt30m", "selfHeal.staleAgeBucket");
  return result;
}

function normalizeTerminal(source) {
  if (source === undefined) return undefined;
  assertKeys(source, NESTED_KEYS.terminal, "terminal");
  const result = {};
  if (source.state !== undefined) result.state = boundedEnum(source.state, ENUMS.terminalState, "ERROR", "terminal.state");
  return result;
}

function normalizeOccurredAt(value, now) {
  if (value === undefined || value === null || value === "") return new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString();
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) fail("telemetry occurredAt is invalid");
  return parsed.toISOString();
}

function stripIdentityFields(value) {
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "eventId" || key === "occurredAt") continue;
    result[key] = Array.isArray(item) ? item.map(stripIdentityFields) : item && typeof item === "object" ? stripIdentityFields(item) : item;
  }
  return result;
}

/** Produce a deterministic id from the logical event, excluding time and id. */
export function deterministicTelemetryEventId(input = {}) {
  return `evt-${sha256(stableStringify(stripIdentityFields(input)))}`;
}

/** Normalize and validate the strict telemetry envelope before any write. */
export function normalizeTelemetryEvent(input = {}, { now = Date.now() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("telemetry event must be an object");
  assertRawSafe(input);
  assertKeys(input, TOP_LEVEL_KEYS, "event");
  const result = {
    schemaVersion: boundedInt(input.schemaVersion, { min: TELEMETRY_SCHEMA_VERSION, max: TELEMETRY_SCHEMA_VERSION, fallback: TELEMETRY_SCHEMA_VERSION, label: "schemaVersion" }),
    occurredAt: normalizeOccurredAt(input.occurredAt, now),
    runId: boundedIdentifier(input.runId, "local:unknown"),
    ...(input.invocationId === undefined ? {} : { invocationId: boundedIdentifier(input.invocationId, "call-unknown") }),
    correlationId: "",
    lane: boundedEnum(input.lane, ENUMS.lane, "unknown", "lane"),
    event: boundedEnum(input.event, ENUMS.event, "terminal", "event"),
    phase: boundedEnum(input.phase, ENUMS.phase, "outcome", "phase"),
    outcome: boundedEnum(input.outcome, ENUMS.outcome, "unknown", "outcome"),
  };
  const repo = String(input.repo ?? "").trim();
  if (repo) {
    if (repo.length > MAX_REPO_CHARS || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail("telemetry repo is invalid");
    result.repo = repo;
  }
  if (input.pr !== undefined) result.pr = boundedInt(input.pr, { min: 0, max: 1_000_000_000, label: "pr" });
  if (input.headSha !== undefined) {
    const head = String(input.headSha).trim().toLowerCase();
    if (head && !/^[a-f0-9]{40,64}$/.test(head)) fail("telemetry headSha is invalid");
    if (head) result.headSha = head.slice(0, MAX_HEAD_CHARS);
  }
  if (input.attempt !== undefined) result.attempt = boundedInt(input.attempt, { min: 0, max: 1000, label: "attempt" });
  if (input.chainIndex !== undefined) result.chainIndex = boundedInt(input.chainIndex, { min: 0, max: 100, label: "chainIndex" });
  for (const key of ["durationBucket", "errorCode", "httpClass", "cooldownBucket"]) {
    if (input[key] === undefined) continue;
    const enumName = key;
    result[key] = boundedEnum(input[key], ENUMS[enumName], key === "errorCode" ? "unknown" : key === "httpClass" ? "none" : key === "durationBucket" ? "unknown" : "none", key);
  }
  const terminal = normalizeTerminal(input.terminal || (input.state !== undefined ? { state: input.state } : undefined));
  if (input.state !== undefined && terminal?.state !== String(input.state)) fail("telemetry terminal state mismatch");
  if (terminal) result.terminal = terminal;
  for (const key of ["provider", "comment", "judge", "research", "workflow", "promotion", "selfHeal"]) {
    const normalized = {
      provider: normalizeProvider,
      comment: normalizeComment,
      judge: normalizeJudge,
      research: normalizeResearch,
      workflow: normalizeWorkflow,
      promotion: normalizePromotion,
      selfHeal: normalizeSelfHeal,
    }[key](input[key]);
    if (normalized !== undefined) result[key] = normalized;
  }
  const correlation = input.correlationId === undefined || input.correlationId === ""
    ? `corr-${sha256(stableStringify({ runId: result.runId, repo: result.repo || "", pr: result.pr || 0, headSha: result.headSha || "" })).slice(0, 32)}`
    : String(input.correlationId).trim().toLowerCase();
  if (!SAFE_CORRELATION_RE.test(correlation)) fail("telemetry correlationId is invalid");
  result.correlationId = correlation;
  result.eventId = deterministicTelemetryEventId(result);
  if (input.eventId !== undefined && String(input.eventId) !== result.eventId) fail("telemetry eventId is not deterministic");
  return result;
}

function assertCanonicalAbsolute(value, label) {
  const text = String(value ?? "");
  if (!text || !path.isAbsolute(text) || path.resolve(text) !== text || text.endsWith(path.sep)) fail(`${label} must be a canonical absolute path`);
}

/** Resolve a state root or direct telemetry JSONL path without aliases. */
export function telemetryPath(stateRootOrFile) {
  const value = String(stateRootOrFile ?? "");
  assertCanonicalAbsolute(value, "telemetry path");
  if (value.endsWith(TELEMETRY_SUFFIX)) return value;
  if (path.basename(value).toLowerCase().includes(".jsonl")) fail("telemetry state file must end with state/telemetry.jsonl");
  return path.join(value, "state", "telemetry.jsonl");
}

export function telemetryFileForStateRoot(stateRoot) {
  return telemetryPath(String(stateRoot || ""));
}

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("telemetry state directory must be a real non-symlink directory", "TELEMETRY_PATH_REJECTED");
  chmodSync(directory, DIRECTORY_MODE);
}

function assertRegularFileOrMissing(filePath) {
  let stat;
  try { stat = lstatSync(filePath); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("telemetry file must be a regular non-symlink file", "TELEMETRY_PATH_REJECTED");
  return stat;
}

function readContents(filePath) {
  const stat = assertRegularFileOrMissing(filePath);
  if (!stat) return "";
  let descriptor = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = lstatSync(filePath);
    if (!opened.isFile() || opened.isSymbolicLink()) fail("telemetry file changed during read", "TELEMETRY_PATH_REJECTED");
    return readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function parseContents(contents) {
  const events = [];
  for (const [index, line] of String(contents || "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { fail(`telemetry record ${index + 1} is invalid JSON`); }
    try { events.push(normalizeTelemetryEvent(parsed)); } catch (error) {
      if (error instanceof TelemetryValidationError) throw error;
      fail(`telemetry record ${index + 1} is invalid`);
    }
  }
  return events;
}

/** Read normalized telemetry events; malformed or unsafe state fails closed. */
export function readTelemetryEvents(stateRootOrFile) {
  return parseContents(readContents(telemetryPath(stateRootOrFile)));
}

function writeDurable(filePath, payload) {
  let descriptor = null;
  try {
    descriptor = openSync(filePath, "wx", FILE_MODE);
    const buffer = Buffer.from(String(payload), "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(descriptor, buffer, offset);
      if (written <= 0) throw new Error("telemetry write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(filePath, FILE_MODE);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function atomicReplace(filePath, payload) {
  const temp = `${filePath}.tmp-${process.pid}-${sha256(`${Date.now()}-${Math.random()}`).slice(0, 12)}`;
  try {
    writeDurable(temp, payload);
    renameSync(temp, filePath);
    chmodSync(filePath, FILE_MODE);
    const directory = path.dirname(filePath);
    let descriptor = null;
    try { descriptor = openSync(directory, "r"); fsyncSync(descriptor); } finally { if (descriptor !== null) closeSync(descriptor); }
  } finally {
    try { unlinkSync(temp); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function withLock(filePath, operation) {
  const lockPath = `${filePath}.lock`;
  ensurePrivateDirectory(path.dirname(filePath));
  try {
    mkdirSync(lockPath, { recursive: false, mode: DIRECTORY_MODE });
    chmodSync(lockPath, DIRECTORY_MODE);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("telemetry writer busy");
    throw error;
  }
  try { return operation(); } finally {
    try { rmdirSync(lockPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function retentionOptions(options = {}) {
  const maxEvents = Number.isSafeInteger(Number(options.maxEvents)) ? Math.max(1, Math.min(TELEMETRY_MAX_EVENTS, Number(options.maxEvents))) : TELEMETRY_MAX_EVENTS;
  const retentionMs = Number.isFinite(Number(options.retentionMs)) ? Math.max(1, Math.min(TELEMETRY_RETENTION_MS, Number(options.retentionMs))) : TELEMETRY_RETENTION_MS;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return { maxEvents, retentionMs, now };
}

/** Append one event atomically; duplicate logical events are no-ops. */
export function appendTelemetryEvent(stateRootOrFile, input, options = {}) {
  const target = telemetryPath(stateRootOrFile);
  const { maxEvents, retentionMs, now } = retentionOptions(options);
  const event = normalizeTelemetryEvent(input, { now });
  return withLock(target, () => {
    const current = parseContents(readContents(target));
    if (current.some((entry) => entry.eventId === event.eventId)) return { event, appended: false, pruned: 0, count: current.length };
    const cutoff = now - retentionMs;
    const next = [...current, event].filter((entry) => Date.parse(entry.occurredAt) >= cutoff).slice(-maxEvents);
    const payload = next.length > 0 ? `${next.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
    atomicReplace(target, payload);
    return { event, appended: true, pruned: current.length + 1 - next.length, count: next.length };
  });
}

/** Best-effort writer for operational callers; validation and secret errors still throw. */
export function recordTelemetryEvent(stateRootOrFile, input, options = {}) {
  const event = normalizeTelemetryEvent(input, options);
  try {
    return appendTelemetryEvent(stateRootOrFile, event, options);
  } catch (error) {
    if (error instanceof TelemetryValidationError || String(error?.code || "").startsWith("TELEMETRY_")) throw error;
    return { event, appended: false, writeError: true, reason: "write-failed" };
  }
}

export const emitTelemetryEvent = recordTelemetryEvent;

export function isTelemetryValidationError(error) {
  return error instanceof TelemetryValidationError || ["TELEMETRY_SCHEMA_REJECTED", "TELEMETRY_SECRET_REJECTED", "TELEMETRY_PATH_REJECTED"].includes(String(error?.code || ""));
}
