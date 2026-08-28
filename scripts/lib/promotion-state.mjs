import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
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
import { createHash } from "node:crypto";
import path from "node:path";

export const PROMOTION_SCHEMA_VERSION = 1;
export const DEFAULT_PROMOTION_MAX_LINES = 2000;
export const DEFAULT_PROMOTION_CONTEXT_MAX_EVENTS = 200;
export const DEFAULT_PROMOTION_CONTEXT_MAX_CHARS = 24_000;
export const MAX_PROMOTION_EVENT_CHARS = 12_000;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const PROMOTION_STATE_SUFFIX = `${path.sep}state${path.sep}promotions.jsonl`;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_SHA_RE = /^[a-f0-9]{40}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const MAX_SUMMARY_CHARS = 500;
const MAX_REASON_CHARS = 160;
const MAX_ID_CHARS = 160;
const MAX_PATHS = 64;
const MAX_JUDGE_IDS = 16;
const MAX_FIXTURE_IDS = 64;
const MAX_ARTIFACT_REFS = 32;

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
  /\bBEGIN [A-Z0-9 ]*PRIVATE KEY\b[\s\S]*?(?:\bEND [A-Z0-9 ]*PRIVATE KEY\b|$)/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\b(?:glpat|pypi)-[A-Za-z0-9_-]{20,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/gi,
  /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}\b/gi,
  /(?:https?|postgres(?:ql)?|mysql):\/\/[^\s/:@]+:[^\s@]+@[^\s]+/gi,
  /(?:^|[?&#\s])(?:access_token|refresh_token|id_token|token|api[-_]?key|apikey|client_secret|secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9._~+\/%=-]{8,}["']?/gi,
];
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|tmp|var|opt|workspace|workspaces|repo|repos|src|build|etc)\/[^\s"']+|(?:[A-Za-z]:\\|\\\\)[^\s"']+)/gi;

const ACTIVE_STATES = new Set([
  "CANDIDATE_ACCEPTED",
  "ACTIVATION_PLANNED",
  "ACTIVATION_READY",
  "ACTIVATION_APPLIED",
  "ROLLBACK_PLANNED",
  "OWNER_REVIEW_REQUIRED",
]);

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

/** Replace credentials and local paths before an event is hashed or persisted. */
export function redactPromotionText(value) {
  let output = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  output = output.replace(ABSOLUTE_PATH_PATTERN, "[PATH]");
  return output
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeText(value, max) {
  return redactPromotionText(value).slice(0, max);
}

function safeId(value, max = MAX_ID_CHARS) {
  const text = safeText(value, max);
  return text && ID_RE.test(text) ? text : "";
}

function safeDigest(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return DIGEST_RE.test(text) ? text : "";
}

function safeCommitSha(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return COMMIT_SHA_RE.test(text) ? text : "";
}

function safePath(value) {
  const text = String(value ?? "").trim();
  if (!SAFE_PATH_RE.test(text) || text.startsWith("/") || text.includes("\\") || text.includes("//")) return "";
  const parts = text.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === "__proto__" || part === "constructor" || part === "prototype")) return "";
  return text;
}

function safeList(value, maxItems, maxChars, mapper = (entry) => safeText(entry, maxChars)) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const item = mapper(entry);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
}

function safeDate(value) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function safeState(value) {
  const state = String(value ?? "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_-]{0,63}$/.test(state) ? state : "ERROR";
}

function safeKind(value) {
  const kind = String(value ?? "promotion").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(kind) ? kind : "promotion";
}

function eventContent(event) {
  return {
    state: event.state,
    capabilityId: event.capabilityId,
    capabilityKind: event.capabilityKind,
    candidateDigest: event.candidateDigest,
    rollbackDigest: event.rollbackDigest,
    registryPath: event.registryPath,
    disposition: event.disposition,
    summary: event.summary,
    reasons: event.reasons,
    changedPaths: event.changedPaths,
    judgeIds: event.judgeIds,
    fixtureIds: event.fixtureIds,
    canaryId: event.canaryId,
    artifactRefs: event.artifactRefs,
    transaction: event.transaction,
  };
}

/** Stable logical identity excludes run IDs and wall-clock timestamps. */
export function deterministicPromotionEventId(input = {}) {
  const event = normalizePromotionEvent({ ...input, eventId: undefined }, { assignEventId: false });
  return sha256(stableStringify({ kind: "promotion", content: eventContent(event) }));
}

/** Normalize a promotion event to a bounded, secret-redacted JSONL record. */
export function normalizePromotionEvent(input = {}, { assignEventId = true } = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const event = {
    schemaVersion: PROMOTION_SCHEMA_VERSION,
    eventId: "",
    runId: safeText(source.runId || "promotion", MAX_ID_CHARS) || "promotion",
    kind: safeKind(source.kind),
    state: safeState(source.state),
    createdAt: safeDate(source.createdAt),
    capabilityId: safeId(source.capabilityId || source.id),
    capabilityKind: safeKind(source.capabilityKind || source.capability?.kind || source.candidateKind),
    candidateDigest: safeDigest(source.candidateDigest || source.digest),
    rollbackDigest: safeDigest(source.rollbackDigest || source.priorActiveDigest),
    registryPath: safePath(source.registryPath || source.registry?.path),
    disposition: safeText(source.disposition, 48).toLowerCase(),
    summary: safeText(source.summary, MAX_SUMMARY_CHARS),
    reasons: safeList(source.reasons || source.reasonCodes, 16, MAX_REASON_CHARS),
    changedPaths: safeList(source.changedPaths, MAX_PATHS, 240, safePath),
    judgeIds: safeList(source.judgeIds || source.trustedJudgeIds, MAX_JUDGE_IDS, 96, (entry) => safeId(entry, 96)),
    fixtureIds: safeList(source.fixtureIds, MAX_FIXTURE_IDS, 96, (entry) => safeId(entry, 96)),
    canaryId: safeId(source.canaryId || source.canary?.id, 96),
    artifactRefs: safeList(source.artifactRefs, MAX_ARTIFACT_REFS, 200),
  };
  if (source.transaction && typeof source.transaction === "object" && !Array.isArray(source.transaction)) {
    const transaction = {
      operation: safeText(source.transaction.operation, 64).toLowerCase(),
      registryPath: safePath(source.transaction.registryPath),
      collection: safeText(source.transaction.collection, 32).toLowerCase(),
      id: safeId(source.transaction.id),
      expectedDigest: safeDigest(source.transaction.expectedDigest),
      candidateDigest: safeDigest(source.transaction.candidateDigest),
      rollbackDigest: safeDigest(source.transaction.rollbackDigest),
      force: source.transaction.force === false ? false : undefined,
      ref: safeText(source.transaction.ref, 120),
      baseRef: safeText(source.transaction.baseRef, 120),
      baseSha: safeCommitSha(source.transaction.baseSha),
      branch: safeText(source.transaction.branch, 160),
      author: safeText(source.transaction.author, 160),
      email: safeText(source.transaction.email, 240),
    };
    for (const key of Object.keys(transaction)) if (transaction[key] === undefined || transaction[key] === "") delete transaction[key];
    if (Object.keys(transaction).length > 0) event.transaction = transaction;
    if (source.transaction.pullRequest && typeof source.transaction.pullRequest === "object") {
      const pullRequest = {
        base: safeText(source.transaction.pullRequest.base, 120),
        head: safeText(source.transaction.pullRequest.head, 160),
        draft: source.transaction.pullRequest.draft === true,
      };
      if (pullRequest.base && pullRequest.head) event.transaction.pullRequest = pullRequest;
    }
  }
  if (source.health && typeof source.health === "object" && !Array.isArray(source.health)) {
    event.health = {
      status: safeText(source.health.status, 32).toLowerCase(),
      digest: safeDigest(source.health.digest),
      summary: safeText(source.health.summary, 240),
    };
    for (const key of Object.keys(event.health)) if (!event.health[key]) delete event.health[key];
    if (Object.keys(event.health).length === 0) delete event.health;
  }
  if (assignEventId) event.eventId = deterministicPromotionEventId(event);
  const serialized = JSON.stringify(event);
  if (serialized.length > MAX_PROMOTION_EVENT_CHARS) {
    event.summary = event.summary.slice(0, 120);
    event.reasons = event.reasons.slice(0, 8);
    event.changedPaths = event.changedPaths.slice(0, 24);
    event.artifactRefs = event.artifactRefs.slice(0, 12);
    if (event.transaction) delete event.transaction.email;
    if (event.health) delete event.health.summary;
  }
  return event;
}

function assertCanonicalAbsolute(value, label) {
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value || value.endsWith(path.sep)) {
    throw new Error(`${label} must be a canonical absolute path`);
  }
}

/** Resolve a state root or direct state file without accepting path aliases. */
export function promotionStatePath(stateRootOrFile) {
  const value = String(stateRootOrFile ?? "");
  assertCanonicalAbsolute(value, "promotion state path");
  if (value.endsWith(PROMOTION_STATE_SUFFIX)) return value;
  if (path.basename(value).toLowerCase().includes(".jsonl")) {
    throw new Error("promotion state file must end with state/promotions.jsonl");
  }
  return path.join(value, "state", "promotions.jsonl");
}

export const promotionsPath = promotionStatePath;
export const statePath = promotionStatePath;

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("promotion state directory must be a real non-symlink directory");
  chmodSync(directory, DIRECTORY_MODE);
}

function optionalStat(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertRegularFileOrMissing(filePath) {
  const stat = optionalStat(filePath);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("promotion state file must be a regular non-symlink file");
  return stat;
}

function readSafe(filePath) {
  const stat = assertRegularFileOrMissing(filePath);
  if (!stat) return null;
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error("promotion state file changed during read");
    return readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseContents(contents) {
  const events = [];
  for (const [index, line] of String(contents || "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`PROMOTION_STATE_CORRUPT record ${index + 1}: ${String(error.message || "invalid JSON").slice(0, 120)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`PROMOTION_STATE_CORRUPT record ${index + 1}: object required`);
    }
    events.push(normalizePromotionEvent(parsed));
  }
  return events;
}

function previousPath(target) {
  return `${target}.prev`;
}

function lockPath(target) {
  return `${target}.lock`;
}

function readContents(target) {
  try {
    const current = readSafe(target);
    if (current !== null) return current;
    const previous = previousPath(target);
    assertRegularFileOrMissing(previous);
    return readSafe(previous) ?? "";
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function writeDurable(filePath, payload) {
  let descriptor;
  try {
    descriptor = openSync(filePath, "wx", FILE_MODE);
    const buffer = Buffer.from(String(payload), "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(descriptor, buffer, offset);
      if (written <= 0) throw new Error("promotion state write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(filePath, FILE_MODE);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function temporaryPath(target, suffix) {
  return `${target}.${suffix}-${process.pid}-${sha256(`${Date.now()}-${Math.random()}`).slice(0, 12)}`;
}

function removeExact(filePath) {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function atomicReplace(target, payload, { backup = true } = {}) {
  const directory = path.dirname(target);
  ensurePrivateDirectory(directory);
  const previous = previousPath(target);
  const current = readSafe(target);
  assertRegularFileOrMissing(previous);
  const targetTemp = temporaryPath(target, "tmp");
  let previousTemp;
  try {
    if (backup && current) {
      previousTemp = temporaryPath(target, "prev-tmp");
      writeDurable(previousTemp, current);
      renameSync(previousTemp, previous);
      previousTemp = undefined;
      chmodSync(previous, FILE_MODE);
      fsyncDirectory(directory);
    }
    writeDurable(targetTemp, payload);
    renameSync(targetTemp, target);
    chmodSync(target, FILE_MODE);
    fsyncDirectory(directory);
  } finally {
    removeExact(targetTemp);
    if (previousTemp) removeExact(previousTemp);
  }
}

function withLock(target, operation) {
  ensurePrivateDirectory(path.dirname(target));
  const lock = lockPath(target);
  try {
    mkdirSync(lock, { recursive: false, mode: DIRECTORY_MODE });
    chmodSync(lock, DIRECTORY_MODE);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("promotion state writer busy");
    throw error;
  }
  try {
    return operation();
  } finally {
    try {
      rmdirSync(lock);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

/** Read normalized promotion events; malformed JSON fails closed. */
export function readPromotionEvents(stateRootOrFile) {
  const target = promotionStatePath(stateRootOrFile);
  ensurePrivateDirectory(path.dirname(target));
  return parseContents(readContents(target));
}

function isRotationSummary(event) {
  return event.state === "ROTATED" && !event.capabilityId && !event.candidateDigest;
}

function rotationEvent(events, dropped) {
  const latest = events.at(-1) || {};
  return normalizePromotionEvent({
    runId: "promotion-rotation",
    kind: "terminal",
    state: "ROTATED",
    summary: `rotated promotion state: dropped ${Math.max(0, dropped)} older events`,
    capabilityId: "",
    candidateDigest: "",
    rollbackDigest: "",
    registryPath: "",
    changedPaths: [],
    reasons: [],
    judgeIds: [],
    fixtureIds: [],
    artifactRefs: [],
    createdAt: latest.createdAt,
  });
}

function rotateLocked(target, options = {}) {
  const maxLines = Math.max(1, Number(options.maxLines || options.maxEvents) || DEFAULT_PROMOTION_MAX_LINES);
  const events = parseContents(readContents(target));
  if (events.length <= maxLines) return { rotated: false, kept: events.length, dropped: 0 };
  const history = events.filter((event) => !isRotationSummary(event));
  const latestByCapability = new Map();
  for (const event of history) {
    if (event.capabilityId && ACTIVE_STATES.has(event.state)) latestByCapability.set(`${event.capabilityId}|${event.candidateDigest}`, event);
  }
  const keepCount = Math.max(0, maxLines - 1);
  const active = [...latestByCapability.values()].slice(0, keepCount);
  const keepIds = new Set(active.map((event) => event.eventId));
  const recentBudget = Math.max(0, keepCount - active.length);
  const candidates = history.filter((event) => !keepIds.has(event.eventId));
  const recent = recentBudget > 0 ? candidates.slice(-recentBudget) : [];
  const kept = [...active, ...recent];
  const summary = rotationEvent(kept, Math.max(0, events.length - kept.length));
  const bounded = [...kept, summary].slice(-maxLines);
  atomicReplace(target, `${bounded.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return { rotated: true, kept: bounded.length, dropped: Math.max(0, events.length - bounded.length) };
}

/** Append one redacted event. Equivalent retries are durable no-ops. */
export function appendPromotionEvent(stateRootOrFile, input, options = {}) {
  const target = promotionStatePath(stateRootOrFile);
  return withLock(target, () => {
    const event = normalizePromotionEvent(input);
    const current = parseContents(readContents(target));
    if (current.some((entry) => entry.eventId === event.eventId)) {
      return { event, appended: false, rotated: false, count: current.length };
    }
    const next = [...current, event];
    atomicReplace(target, `${next.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { backup: true });
    const rotation = rotateLocked(target, options);
    return { event, appended: true, rotated: rotation.rotated, count: parseContents(readContents(target)).length };
  });
}

/** Rotate the bounded promotion log while retaining active candidate claims. */
export function rotatePromotions(stateRootOrFile, options = {}) {
  const target = promotionStatePath(stateRootOrFile);
  return withLock(target, () => rotateLocked(target, options));
}

/** Select bounded, newest-first context for one candidate digest. */
export function buildPromotionContext(eventsOrPath, {
  capabilityId,
  candidateDigest,
  maxEvents = DEFAULT_PROMOTION_CONTEXT_MAX_EVENTS,
  maxChars = DEFAULT_PROMOTION_CONTEXT_MAX_CHARS,
} = {}) {
  const source = Array.isArray(eventsOrPath) ? eventsOrPath : readPromotionEvents(eventsOrPath);
  const id = capabilityId === undefined ? undefined : safeId(capabilityId);
  const digest = candidateDigest === undefined ? undefined : safeDigest(candidateDigest);
  const filtered = source
    .map((event) => normalizePromotionEvent(event))
    .filter((event) => id === undefined || event.capabilityId === id)
    .filter((event) => digest === undefined || event.candidateDigest === digest)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const count = Math.max(0, Number(maxEvents) || 0);
  const limit = Math.max(0, Number(maxChars) || 0);
  const selected = [];
  for (const event of filtered.slice(0, count)) {
    const candidate = [...selected, event];
    if (JSON.stringify(candidate).length > limit) break;
    selected.push(event);
  }
  return selected;
}

export { DIGEST_RE };
