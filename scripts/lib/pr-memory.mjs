import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

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
  /(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})/g,
  /AKIA[0-9A-Z]{16}/g,
  /BEGIN [A-Z ]*PRIVATE KEY/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
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
 * distinguishes legitimate events from separate workflow runs; retries of the
 * same run and event payload remain no-ops.
 */
export function deterministicEventId(input = {}) {
  const event = redactValue(input);
  const content = {
    // A run id differentiates two legitimate attempts with identical bounded
    // status text while keeping retries from the same workflow idempotent.
    runId: event.runId || "",
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
  const value = String(stateRootOrFile || "");
  return value.endsWith(".jsonl") ? value : path.join(value, "state", "pr-memory.jsonl");
}

/** Read valid JSON events, ignoring corrupt lines left by interrupted runs. */
export function readMemoryEvents(filePath) {
  const target = memoryPath(filePath);
  if (!existsSync(target)) return [];
  let contents;
  try {
    contents = readFileSync(target, "utf8");
  } catch {
    return [];
  }
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

/**
 * Append one redacted event. Existing event ids make retries idempotent; a
 * successful duplicate append never changes the file's mtime or line count.
 */
export function appendMemoryEvent(filePath, input, options = {}) {
  const target = memoryPath(filePath);
  const event = normalizeMemoryEvent(input);
  const current = readMemoryEvents(target);
  if (current.some((entry) => entry.eventId === event.eventId)) {
    return { event, appended: false, rotated: false, count: current.length };
  }
  mkdirSync(path.dirname(target), { recursive: true });
  appendFileSync(target, `${JSON.stringify(event)}\n`, "utf8");
  const rotation = rotateMemory(target, options);
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
export function rotateMemory(filePath, { maxLines = DEFAULT_MEMORY_MAX_LINES } = {}) {
  const target = memoryPath(filePath);
  const limit = Math.max(1, Number(maxLines) || DEFAULT_MEMORY_MAX_LINES);
  const events = readMemoryEvents(target);
  if (events.length <= limit) return { rotated: false, kept: events.length, dropped: 0 };

  const keepCount = Math.max(0, limit - 1);
  const kept = keepCount === 0 ? [] : events.slice(-keepCount);
  const latest = events.at(-1) || {};
  const summary = normalizeMemoryEvent({
    runId: "memory-rotation",
    lane: latest.lane || "merge",
    repo: latest.repo || "",
    pr: latest.pr || 0,
    headSha: latest.headSha || "",
    attempt: latest.attempt || 0,
    kind: "terminal",
    state: "ROTATED",
    summary: `rotated PR memory: dropped ${events.length - keepCount} older events; retained ${keepCount}`,
    changedPaths: [],
    blockerIds: [],
    artifactRefs: [],
  });
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${[...kept, summary].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return { rotated: true, kept: keepCount + 1, dropped: events.length - keepCount };
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
  let chars = 0;
  for (const entry of filtered.slice(0, Math.max(0, Number(maxEvents) || 0))) {
    const nextChars = JSON.stringify(entry).length;
    if (chars + nextChars > maxChars) break;
    selected.push(entry);
    chars += nextChars;
  }
  return selected;
}
