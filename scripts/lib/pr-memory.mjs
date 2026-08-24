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
  rmdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const MEMORY_SCHEMA_VERSION = 1;
export const DEFAULT_MEMORY_MAX_LINES = 2000;
export const DEFAULT_CONTEXT_MAX_EVENTS = 200;
export const DEFAULT_CONTEXT_MAX_CHARS = 24000;

const MAX_SUMMARY_CHARS = 500;
const MAX_ID_CHARS = 160;
const MAX_PATHS = 32;
const MAX_PATH_CHARS = 240;
const MAX_BLOCKERS = 32;
const MAX_ARTIFACTS = 32;

// These patterns deliberately cover provider tokens and common credential forms,
// while leaving ordinary prose intact. The replacement happens before hashing or
// writing so secrets cannot leak through either state or deterministic IDs.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
  /\bBEGIN [A-Z0-9 ]*PRIVATE KEY\b[\s\S]*?(?:\bEND [A-Z0-9 ]*PRIVATE KEY\b|$)/gi,
  /BEGIN [A-Z0-9 ]*PRIVATE KEY/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z]{24,}\b/gi,
  /\bBearer\s+(?=[A-Za-z0-9._~+\/-]{16,}\b)(?=[A-Za-z0-9._~+\/-]*[0-9._~+\/=])[A-Za-z0-9._~+\/-]{16,}\b/gi,
  /[?&#](?:access_token|refresh_token|id_token|token|api[-_]?key|apikey|client_secret|secret|password|passwd)=[A-Za-z0-9._~+\/%=-]{12,}/gi,
  /\b(?:access_token|refresh_token|id_token|token|api[-_]?key|apikey|client_secret|secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9._~+\/%=-]{12,}["']?/gi,
  /(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})/g,
  /AKIA[0-9A-Z]{16}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
];

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** Replace token-like values without exposing the original prefix or suffix. */
export function redactText(value) {
  let output = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  return output;
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return typeof value === "string" ? redactText(value) : value;
}

function safeArray(value, limit, maxChars) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => truncate(redactText(item), maxChars)).filter(Boolean))].slice(0, limit);
}

function validCreatedAt(value) {
  const candidate = String(value ?? "");
  return candidate && Number.isFinite(Date.parse(candidate)) ? new Date(candidate).toISOString() : new Date().toISOString();
}

/**
 * Normalize an event to the bounded, redacted schema used by fleet-control.
 * This helper is intentionally permissive; target authorization belongs to the
 * revision queue validator, while this module guarantees safe persistence.
 */
export function normalizeMemoryEvent(input = {}) {
  const redacted = redactValue(input);
  const event = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    runId: truncate(redacted.runId || "unknown", MAX_ID_CHARS),
    lane: truncate(redacted.lane || "merge", 32),
    repo: truncate(redacted.repo || "", MAX_ID_CHARS),
    pr: Number.isInteger(Number(redacted.pr)) ? Number(redacted.pr) : 0,
    headSha: truncate(redacted.headSha || "", 80),
    attempt: Number.isInteger(Number(redacted.attempt)) ? Number(redacted.attempt) : 0,
    kind: truncate(redacted.kind || "error", 32),
    state: truncate(redacted.state || "ERROR", 64),
    createdAt: validCreatedAt(redacted.createdAt),
    summary: truncate(redacted.summary || "", MAX_SUMMARY_CHARS),
    changedPaths: safeArray(redacted.changedPaths, MAX_PATHS, MAX_PATH_CHARS),
    blockerIds: safeArray(redacted.blockerIds, MAX_BLOCKERS, MAX_ID_CHARS),
    artifactRefs: safeArray(redacted.artifactRefs, MAX_ARTIFACTS, MAX_ID_CHARS),
  };
  event.eventId = deterministicEventId(event);
  return event;
}

/**
 * Produce the stable event id described by the PR-memory contract. The run id
 * is retained for diagnostics but excluded from logical duplicate identity so
 * equivalent events from separate workflow runs remain no-ops.
 */
export function deterministicEventId(input = {}) {
  const event = redactValue(input);
  const content = {
    state: event.state || "",
    summary: event.summary || "",
    changedPaths: event.changedPaths || [],
    blockerIds: event.blockerIds || [],
    artifactRefs: event.artifactRefs || [],
  };
  const material = {
    lane: event.lane || "",
    repo: event.repo || "",
    pr: Number.isInteger(Number(event.pr)) ? Number(event.pr) : Number(event.pr) || 0,
    headSha: event.headSha || "",
    kind: event.kind || "",
    attempt: Number.isInteger(Number(event.attempt)) ? Number(event.attempt) : Number(event.attempt) || 0,
    contentHash: sha256(stableStringify(content)),
  };
  return sha256(stableStringify(material));
}

export function memoryPath(stateRootOrFile) {
  const value = String(stateRootOrFile ?? "");
  const directSuffix = `${path.sep}state${path.sep}pr-memory.jsonl`;
  const basename = path.basename(value);
  const lowerBasename = basename.toLowerCase();
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value || value.endsWith(path.sep)) {
    throw new Error("memory path must be a canonical absolute path");
  }
  if (value.endsWith(directSuffix)) return value;
  if (lowerBasename.endsWith(".jsonl") || lowerBasename.includes(".jsonl.")) {
    throw new Error("memory file must end with state/pr-memory.jsonl");
  }
  return path.join(value, "state", "pr-memory.jsonl");
}

const LOCK_MODE = 0o700;
const FILE_MODE = 0o600;

function previousMemoryPath(target) {
  return `${target}.prev`;
}

function lockMemoryPath(target) {
  return `${target}.lock`;
}

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: LOCK_MODE });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("memory state directory must be a real non-symlink directory");
  }
  chmodSync(directory, LOCK_MODE);
}

function lstatOrNull(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertRegularFileOrMissing(filePath) {
  const stat = lstatOrNull(filePath);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`memory path must be a regular non-symlink file: ${filePath}`);
  }
  return stat;
}

function readSafeFile(filePath, { throwUnsafe = false, encoding = null } = {}) {
  let descriptor = null;
  try {
    const stat = assertRegularFileOrMissing(filePath);
    if (!stat) return null;
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error(`memory path changed before read: ${filePath}`);
    return readFileSync(descriptor, encoding || undefined);
  } catch (error) {
    if (throwUnsafe) throw error;
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function writeFully(descriptor, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(descriptor, buffer, offset);
    if (written <= 0) throw new Error("memory write made no progress");
    offset += written;
  }
}

function fsyncDirectory(directory) {
  let descriptor = null;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function temporaryPath(target, purpose) {
  return `${target}.${purpose}-${process.pid}-${randomUUID()}`;
}

function removeExactFile(filePath) {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function writeDurableFile(filePath, content) {
  let descriptor = null;
  try {
    descriptor = openSync(filePath, "wx", FILE_MODE);
    writeFully(descriptor, Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8"));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(filePath, FILE_MODE);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function atomicReplace(target, payload, { backup = true } = {}) {
  const directory = path.dirname(target);
  ensurePrivateDirectory(directory);
  const previous = previousMemoryPath(target);
  const currentPayload = readSafeFile(target, { throwUnsafe: true });
  assertRegularFileOrMissing(previous);
  const targetTemp = temporaryPath(target, "tmp");
  let backupTemp = null;
  try {
    if (backup && currentPayload !== null) {
      backupTemp = temporaryPath(target, "prev-tmp");
      writeDurableFile(backupTemp, currentPayload);
      renameSync(backupTemp, previous);
      backupTemp = null;
      chmodSync(previous, FILE_MODE);
      fsyncDirectory(directory);
    }
    writeDurableFile(targetTemp, payload);
    renameSync(targetTemp, target);
    chmodSync(target, FILE_MODE);
    fsyncDirectory(directory);
  } finally {
    removeExactFile(targetTemp);
    if (backupTemp !== null) removeExactFile(backupTemp);
  }
}

function readMemoryContents(target) {
  try {
    const directory = path.dirname(target);
    const directoryStat = lstatOrNull(directory);
    if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return "";
  } catch {
    return "";
  }
  const current = readSafeFile(target, { encoding: "utf8" });
  if (current !== null) return current;
  const previous = previousMemoryPath(target);
  return readSafeFile(previous, { encoding: "utf8" }) ?? "";
}

function parseMemoryContents(contents) {
  const events = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(normalizeMemoryEvent(parsed));
      }
    } catch {
      // A partially written line must not prevent future revisions from reading
      // the valid suffix of this append-only file.
    }
  }
  return events;
}

function recoverCanonical(target) {
  const current = readSafeFile(target, { throwUnsafe: true });
  if (current !== null) return;
  const previous = previousMemoryPath(target);
  const recovery = readSafeFile(previous, { throwUnsafe: true });
  if (recovery === null) return;
  atomicReplace(target, recovery, { backup: false });
}

function acquireWriteLock(target) {
  ensurePrivateDirectory(path.dirname(target));
  const lock = lockMemoryPath(target);
  try {
    mkdirSync(lock, { mode: LOCK_MODE });
    chmodSync(lock, LOCK_MODE);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("memory writer busy: local lock is held");
    throw error;
  }
  return () => {
    try {
      rmdirSync(lock);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

function withWriteLock(target, operation) {
  const release = acquireWriteLock(target);
  try {
    return operation();
  } finally {
    release();
  }
}

/** Read valid JSON events, ignoring corrupt lines left by interrupted runs. */
export function readMemoryEvents(filePath) {
  const target = memoryPath(filePath);
  return parseMemoryContents(readMemoryContents(target));
}

/**
 * Append one redacted event. Existing event ids make retries idempotent; a
 * successful duplicate append never changes the file's mtime or line count.
 */
export function appendMemoryEvent(filePath, input, options = {}) {
  const target = memoryPath(filePath);
  return withWriteLock(target, () => appendMemoryEventLocked(target, input, options));
}

function appendMemoryEventLocked(target, input, options = {}) {
  recoverCanonical(target);
  const event = normalizeMemoryEvent(input);
  const current = readMemoryEvents(target);
  if (current.some((entry) => entry.eventId === event.eventId)) {
    return { event, appended: false, rotated: false, count: current.length };
  }
  ensurePrivateDirectory(path.dirname(target));
  assertRegularFileOrMissing(target);
  let descriptor = null;
  try {
    descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0), FILE_MODE);
    writeFully(descriptor, Buffer.from(`${JSON.stringify(event)}\n`, "utf8"));
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  chmodSync(target, FILE_MODE);
  fsyncDirectory(path.dirname(target));
  const rotation = rotateMemoryLocked(target, options);
  return {
    event,
    appended: true,
    rotated: rotation.rotated,
    count: readMemoryEvents(target).length,
  };
}

/**
 * Keep the newest records and a bounded ROTATED summary when the state file is
 * too large. The summary is itself a normal event so consumers can explain why
 * older history is absent.
 */
export function rotateMemory(filePath, options = {}) {
  const target = memoryPath(filePath);
  return withWriteLock(target, () => rotateMemoryLocked(target, options));
}

function rotateMemoryLocked(target, { maxLines = DEFAULT_MEMORY_MAX_LINES } = {}) {
  recoverCanonical(target);
  const limit = Math.max(1, Number(maxLines) || DEFAULT_MEMORY_MAX_LINES);
  const events = readMemoryEvents(target);
  const isRotationSummary = (entry) => (
    entry.kind === "terminal" &&
    entry.state === "ROTATED" &&
    entry.repo === "" &&
    entry.pr === 0 &&
    entry.headSha === ""
  );
  const history = events.filter((entry) => !isRotationSummary(entry));
  if (events.length <= limit && history.length <= limit) {
    return { rotated: false, kept: events.length, dropped: 0 };
  }

  const keepCount = Math.max(0, limit - 1);
  const latestDispatchByTarget = new Map();
  for (const entry of history) {
    if (entry.kind !== "dispatch") continue;
    latestDispatchByTarget.set(`${entry.repo}\n${entry.pr}\n${entry.headSha}`, entry);
  }
  const activeStates = new Set([
    "DISPATCH_INTENT",
    "DISPATCHED",
    "DISPATCH_UNKNOWN",
    "DISPATCH_CONSUMED",
    "DISPATCH_HELD",
  ]);
  const activeIds = new Set(
    [...latestDispatchByTarget.values()]
      .filter((entry) => activeStates.has(entry.state))
      .map((entry) => entry.eventId),
  );
  const recent = keepCount === 0 ? [] : history.filter((entry) => !activeIds.has(entry.eventId)).slice(-keepCount);
  const keptIds = new Set([...activeIds, ...recent.map((entry) => entry.eventId)]);
  const kept = history.filter((entry) => keptIds.has(entry.eventId));
  const latest = history.at(-1) || events.at(-1) || {};
  const summary = normalizeMemoryEvent({
    runId: "memory-rotation",
    lane: latest.lane || "merge",
    repo: "",
    pr: 0,
    headSha: "",
    attempt: latest.attempt || 0,
    kind: "terminal",
    state: "ROTATED",
    summary: `rotated PR memory: dropped ${Math.max(0, history.length - kept.length)} older events; retained ${kept.length}`,
    changedPaths: [],
    blockerIds: [],
    artifactRefs: [],
  });
  const payload = `${[...kept, summary].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  atomicReplace(target, payload);
  return { rotated: true, kept: kept.length + 1, dropped: Math.max(0, events.length - kept.length) };
}

/**
 * Select recent context for one PR. Newest events are first, target filtering is
 * strict when a field is provided, and both count and serialized size are capped.
 */
export function buildMemoryContext(eventsOrPath, {
  repo,
  pr,
  headSha,
  maxEvents = DEFAULT_CONTEXT_MAX_EVENTS,
  maxChars = DEFAULT_CONTEXT_MAX_CHARS,
} = {}) {
  const source = Array.isArray(eventsOrPath) ? eventsOrPath : readMemoryEvents(eventsOrPath);
  const filtered = source
    .map((entry) => normalizeMemoryEvent(entry))
    .filter((entry) => (repo === undefined || entry.repo === repo))
    .filter((entry) => (pr === undefined || entry.pr === Number(pr)))
    .filter((entry) => (headSha === undefined || entry.headSha === headSha))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const selected = [];
  const parsedMaxChars = Number(maxChars);
  const charLimit = Number.isFinite(parsedMaxChars)
    ? Math.max(0, parsedMaxChars)
    : DEFAULT_CONTEXT_MAX_CHARS;
  if (charLimit < 2) return selected;
  for (const entry of filtered.slice(0, Math.max(0, Number(maxEvents) || 0))) {
    const candidate = [...selected, entry];
    if (JSON.stringify(candidate).length > charLimit) break;
    selected.push(entry);
  }
  return selected;
}
