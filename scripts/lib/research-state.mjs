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

import { ghInput } from "./util.mjs";
import {
  planResearchEscalation,
  redactResearchText,
  validateResearchUrl,
} from "./research-escalation.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";

export const RESEARCH_SCHEMA_VERSION = 1;
export const MAX_RESEARCH_EVENTS = 2000;
export const MAX_RESEARCH_EVENT_CHARS = 12_000;
export const RESEARCH_WORKFLOW = "research.yml";
export const RESEARCH_WORKFLOW_REPO = "M1Vj/fleet-runtime";
export const MERGE_WORKFLOW = "merge.yml";
export const MERGE_WORKFLOW_REPO = "M1Vj/fleet-runtime";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_ID_CHARS = 160;
const MAX_SUMMARY_CHARS = 360;
const MAX_FINGERPRINT_SUMMARY = 240;
const MAX_CITATIONS = 16;
const MAX_DIGESTS = 32;
const MAX_CLAIM_SUMMARIES = 16;
const MAX_CLAIM_SUMMARY_CHARS = 600;
const MAX_REASON_CHARS = 120;
const RESEARCH_STATE_SUFFIX = `${path.sep}state${path.sep}research.jsonl`;
const CORRELATION_RE = /^research-[a-f0-9]{32}$/;
const FINGERPRINT_RE = /^failure-[a-f0-9]{32}$/;
const DIGEST_RE = /^(?:sha256:)?[a-f0-9]{64}$/i;
const TERMINAL_STATES = new Set([
  "RESEARCH_COMPLETED",
  "RESEARCH_BLOCKED",
  "RESEARCH_UNAVAILABLE",
]);
const FAILURE_STATES = new Set(["FAILURE_OBSERVED", "FAILURE", "CHECK_FAILED"]);
const DISPATCH_STATES = new Set([
  "RESEARCH_DISPATCHED",
  "RESEARCH_DISPATCH_UNKNOWN",
  "RESEARCH_DISPATCH_FAILED",
]);
const CONTINUATION_STATES = new Set([
  "RESEARCH_CONTINUATION_INTENT",
  "RESEARCH_CONTINUATION_DISPATCHING",
  "RESEARCH_CONTINUATION_DISPATCHED",
  "RESEARCH_CONTINUATION_UNKNOWN",
  "RESEARCH_CONTINUATION_FAILED",
]);
const DISPATCH_ID_RE = /^[a-f0-9]{64}$/;
const CLAIM_INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|override|forget)\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|system|developer)\s+(?:instructions?|rules?|prompt)\b/i,
  /\b(?:reveal|disclose|print|show)\s+(?:the\s+)?(?:secrets?|credentials?|tokens?|keys?|system\s+prompt|developer\s+prompt)\b/i,
  /\b(?:run|execute|invoke)\s+(?:curl|wget|bash|sh|powershell|command|shell)\b/i,
  /\b(?:system|developer)\s+(?:message|instruction)\s*:/i,
  /\b(?:send|upload|post)\s+(?:the\s+)?(?:secret|token|credential|private\s+key)\b/i,
];

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

function compact(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function safeText(value, max) {
  return compact(redactResearchText(value), max);
}

function safeCorrelation(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return CORRELATION_RE.test(text) ? text : "";
}

function safeFingerprintId(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return FINGERPRINT_RE.test(text) ? text : "";
}

function safeRepo(value) {
  const text = safeText(value, 160);
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? text : "";
}

function safePr(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function safeHead(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{40,64}$/.test(text) ? text : "";
}

function safeRunId(value) {
  const text = safeText(value || "research", MAX_ID_CHARS);
  return text || "research";
}

function safeState(value) {
  const text = String(value ?? "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_-]{0,63}$/.test(text) ? text : "RESEARCH_UNAVAILABLE";
}

function safeDigest(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!DIGEST_RE.test(text)) return "";
  return text.startsWith("sha256:") ? text : `sha256:${text}`;
}

function safeConfidence(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["high", "medium", "low"].includes(text) ? text : "unknown";
}

function safeFactStatus(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["fact", "inference", "unknown"].includes(text) ? text : "unknown";
}

function normalizeCreatedAt(value) {
  const parsed = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function normalizeFingerprint(value, fallbackId = "") {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const id = safeFingerprintId(source.id || fallbackId);
  const result = {
    id,
    errorClass: safeText(source.errorClass, 96).toLowerCase(),
    check: safeText(source.check, 96).toLowerCase(),
    runtime: safeText(source.runtime, 96).toLowerCase(),
    summary: safeText(source.summary, MAX_FINGERPRINT_SUMMARY),
  };
  return result.id || result.errorClass || result.check || result.runtime || result.summary ? result : undefined;
}

function normalizeCitation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checked = validateResearchUrl(value.url);
  if (!checked.ok) return null;
  const digest = safeDigest(value.digest || value.contentDigest);
  if (!digest) return null;
  return {
    url: checked.url,
    title: safeText(value.title || "Untitled source", 160) || "Untitled source",
    digest,
    evidenceType: safeText(value.evidenceType || "public-source-text", 64) || "public-source-text",
    confidence: safeConfidence(value.confidence),
    factStatus: safeFactStatus(value.factStatus),
  };
}

function normalizeCitationList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const citations = [];
  for (const item of value) {
    const citation = normalizeCitation(item);
    if (!citation || seen.has(`${citation.url}|${citation.digest}`)) continue;
    seen.add(`${citation.url}|${citation.digest}`);
    citations.push(citation);
    if (citations.length >= MAX_CITATIONS) break;
  }
  return citations;
}

function normalizeDigestList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(safeDigest).filter(Boolean))].slice(0, MAX_DIGESTS);
}

function claimLooksLikeInstruction(value) {
  const text = String(value ?? "");
  return CLAIM_INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Keep only a short, citation-bound claim summary. Page text and model
 * instructions are never persisted in private state. Unsafe summaries are
 * dropped rather than partially trusted.
 */
export function normalizeResearchClaimSummary(value, { citationDigest = "" } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const summary = safeText(source.summary || source.claim, MAX_CLAIM_SUMMARY_CHARS);
  const digest = safeDigest(source.citationDigest || source.sourceDigest || citationDigest);
  if (!summary || !digest || claimLooksLikeInstruction(summary)) return null;
  return {
    summary,
    citationDigest: digest,
    confidence: safeConfidence(source.confidence),
    factStatus: safeFactStatus(source.factStatus),
  };
}

/** Normalize bounded claim summaries while reporting dropped hostile entries. */
export function normalizeResearchClaimSummaries(value) {
  if (!Array.isArray(value)) return { summaries: [], injectionSuspected: false };
  const summaries = [];
  const seen = new Set();
  let injectionSuspected = false;
  for (const item of value) {
    const raw = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const candidate = safeText(raw.summary || raw.claim, MAX_CLAIM_SUMMARY_CHARS);
    if (candidate && claimLooksLikeInstruction(candidate)) {
      injectionSuspected = true;
      continue;
    }
    const normalized = normalizeResearchClaimSummary(item);
    if (!normalized) continue;
    const key = `${normalized.citationDigest}|${normalized.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    summaries.push(normalized);
    if (summaries.length >= MAX_CLAIM_SUMMARIES) break;
  }
  return { summaries, injectionSuspected };
}

function boundResearchEvent(event) {
  const budget = MAX_RESEARCH_EVENT_CHARS - 80; // reserve room for eventId/JSON framing
  const candidate = { ...event };
  const serializedLength = () => JSON.stringify(candidate).length;
  while (serializedLength() > budget && Array.isArray(candidate.claimSummaries) && candidate.claimSummaries.length > 1) {
    candidate.claimSummaries = candidate.claimSummaries.slice(0, -1);
  }
  while (serializedLength() > budget && Array.isArray(candidate.citations) && candidate.citations.length > 1) {
    candidate.citations = candidate.citations.slice(0, -1);
  }
  while (serializedLength() > budget && Array.isArray(candidate.sourceDigests) && candidate.sourceDigests.length > 1) {
    candidate.sourceDigests = candidate.sourceDigests.slice(0, -1);
  }
  while (serializedLength() > budget && candidate.summary) {
    candidate.summary = candidate.summary.slice(0, Math.max(0, candidate.summary.length - 40));
  }
  return candidate;
}

function eventContent(event) {
  return {
    state: event.state,
    correlationId: event.correlationId,
    fingerprintId: event.fingerprintId,
    fingerprint: event.fingerprint,
    repo: event.repo,
    pr: event.pr,
    headSha: event.headSha,
    trigger: event.trigger,
    summary: event.summary,
    reasonCode: event.reasonCode,
    citations: event.citations,
    sourceDigests: event.sourceDigests,
    claimSummaries: event.claimSummaries,
    verificationDigest: event.verificationDigest,
    reproductionDigest: event.reproductionDigest,
    artifactDigest: event.artifactDigest,
    dispatchStatus: event.dispatchStatus,
    dispatchId: event.dispatchId,
  };
}

/** Stable logical ID excludes run and wall-clock fields so retries are no-ops. */
export function deterministicResearchEventId(input = {}) {
  const event = normalizeResearchEvent({ ...input, eventId: undefined }, { assignEventId: false });
  return sha256(stableStringify({
    kind: "research",
    state: event.state,
    repo: event.repo,
    pr: event.pr,
    headSha: event.headSha,
    correlationId: event.correlationId,
    content: eventContent(event),
  }));
}

/** Normalize a research event before it enters private state. */
export function normalizeResearchEvent(input = {}, { assignEventId = true } = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const state = safeState(source.state);
  const fingerprintId = safeFingerprintId(source.fingerprintId || source.fingerprint?.id);
  const fingerprint = normalizeFingerprint(source.fingerprint, fingerprintId);
  const event = {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    eventId: "",
    runId: safeRunId(source.runId),
    kind: "research",
    state,
    createdAt: normalizeCreatedAt(source.createdAt),
    correlationId: safeCorrelation(source.correlationId),
    fingerprintId,
    repo: safeRepo(source.repo),
    pr: safePr(source.pr),
    headSha: safeHead(source.headSha),
    trigger: safeText(source.trigger, 64).toLowerCase(),
    summary: safeText(source.summary, MAX_SUMMARY_CHARS),
  };
  if (fingerprint) event.fingerprint = fingerprint;
  if (TERMINAL_STATES.has(state)) {
    event.reasonCode = safeText(source.reasonCode || source.reason, MAX_REASON_CHARS).toLowerCase();
    event.citations = normalizeCitationList(source.citations);
    event.sourceDigests = normalizeDigestList(source.sourceDigests);
    const claimResult = normalizeResearchClaimSummaries(source.claimSummaries || source.claims);
    event.claimSummaries = claimResult.summaries;
    event.verificationDigest = safeDigest(source.verificationDigest || source.verification?.digest);
    event.reproductionDigest = safeDigest(source.reproductionDigest || source.reproduction?.digest);
  }
  if (DISPATCH_STATES.has(state) || CONTINUATION_STATES.has(state)) {
    event.dispatchStatus = safeText(source.dispatchStatus || source.status, 32).toLowerCase();
    event.artifactDigest = safeDigest(source.artifactDigest || source.artifact?.digest);
    const dispatchId = String(source.dispatchId || source.dispatch_id || "").trim().toLowerCase();
    if (DISPATCH_ID_RE.test(dispatchId)) event.dispatchId = dispatchId;
  }
  const bounded = boundResearchEvent(event);
  if (assignEventId) bounded.eventId = deterministicResearchEventId(bounded);
  return bounded;
}

function assertCanonicalAbsolute(value, label) {
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value || value.endsWith(path.sep)) {
    throw new Error(`${label} must be a canonical absolute path`);
  }
}

/** Resolve a state root or direct research JSONL path without accepting aliases. */
export function researchStatePath(stateRootOrFile) {
  const value = String(stateRootOrFile ?? "");
  assertCanonicalAbsolute(value, "research state path");
  if (value.endsWith(RESEARCH_STATE_SUFFIX)) return value;
  if (path.basename(value).toLowerCase().includes(".jsonl")) {
    throw new Error("research state file must end with state/research.jsonl");
  }
  return path.join(value, "state", "research.jsonl");
}

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("research state directory must be real");
  chmodSync(directory, DIRECTORY_MODE);
}

function assertRegularFile(filePath, { allowMissing = true } = {}) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("research state file must be a regular non-symlink file");
  return stat;
}

function readContents(filePath) {
  const stat = assertRegularFile(filePath);
  if (!stat) return "";
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = lstatSync(filePath);
    if (!opened.isFile() || opened.isSymbolicLink()) throw new Error("research state file changed during read");
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
      throw new Error(`RESEARCH_STATE_CORRUPT record ${index + 1}: ${String(error.message).slice(0, 120)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`RESEARCH_STATE_CORRUPT record ${index + 1}: object required`);
    }
    events.push(normalizeResearchEvent(parsed));
  }
  return events;
}

/** Read valid, normalized research events; malformed state fails closed. */
export function readResearchEvents(stateRootOrFile) {
  const target = researchStatePath(stateRootOrFile);
  return parseContents(readContents(target));
}

function writeDurable(filePath, payload) {
  let descriptor;
  try {
    descriptor = openSync(filePath, "wx", FILE_MODE);
    const buffer = Buffer.from(String(payload), "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(descriptor, buffer, offset);
      if (written <= 0) throw new Error("research state write made no progress");
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

function replaceDurable(filePath, payload) {
  const temp = `${filePath}.tmp-${process.pid}-${sha256(`${Date.now()}-${Math.random()}`).slice(0, 12)}`;
  try {
    writeDurable(temp, payload);
    renameSync(temp, filePath);
    chmodSync(filePath, FILE_MODE);
  } finally {
    try { unlinkSync(temp); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function withLock(filePath, operation) {
  const lockPath = `${filePath}.lock`;
  try {
    mkdirSync(lockPath, { recursive: false, mode: DIRECTORY_MODE });
    chmodSync(lockPath, DIRECTORY_MODE);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("research state writer busy");
    throw error;
  }
  try {
    return operation();
  } finally {
    try { rmdirSync(lockPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

/** Append one redacted research event, making an equivalent retry a no-op. */
export function appendResearchEvent(stateRootOrFile, input, options = {}) {
  const target = researchStatePath(stateRootOrFile);
  ensurePrivateDirectory(path.dirname(target));
  return withLock(target, () => {
    const event = normalizeResearchEvent(input);
    const current = parseContents(readContents(target));
    if (current.some((entry) => entry.eventId === event.eventId)) {
      return { event, appended: false, count: current.length };
    }
    const next = [...current, event];
    const maxEvents = Math.max(1, Number(options.maxEvents) || MAX_RESEARCH_EVENTS);
    const retained = next.length > maxEvents ? next.slice(-maxEvents) : next;
    const payload = `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    replaceDurable(target, payload);
    emitResearchTelemetry(target, event);
    return { event, appended: true, rotated: retained.length !== next.length, count: retained.length };
  });
}

function researchTelemetryOutcome(state) {
  if (state === "RESEARCH_COMPLETED") return "succeeded";
  if (state === "RESEARCH_BLOCKED" || state === "RESEARCH_UNAVAILABLE" || /FAILED|UNKNOWN/.test(state)) return "failed";
  if (/DISPATCHED|REQUESTED|INTENT|DISPATCHING/.test(state)) return "started";
  return "unknown";
}

/** Best-effort shared telemetry mirror for durable research lifecycle events. */
function emitResearchTelemetry(stateFile, event) {
  try {
    recordTelemetryEvent(stateFile.replace(`${path.sep}research.jsonl`, `${path.sep}telemetry.jsonl`), {
      runId: event.runId,
      correlationId: event.correlationId || undefined,
      lane: "research",
      event: "research",
      phase: /CONTINUATION/.test(event.state) ? "continuation" : /DISPATCH/.test(event.state) ? "dispatch" : /COMPLETED|BLOCKED|UNAVAILABLE/.test(event.state) ? "finalize" : "request",
      outcome: researchTelemetryOutcome(event.state),
      repo: event.repo || undefined,
      pr: event.pr || undefined,
      headSha: event.headSha || undefined,
      research: {
        phase: /CONTINUATION/.test(event.state) ? "continuation" : /DISPATCH/.test(event.state) ? "dispatch" : /COMPLETED|BLOCKED|UNAVAILABLE/.test(event.state) ? "finalize" : "request",
        reasonCode: ["low_confidence", "no_progress", "unavailable", "dispatch_failed", "dispatch_unknown", "none"].includes(event.reasonCode) ? event.reasonCode : "none",
        sourceCount: Array.isArray(event.sourceDigests) ? event.sourceDigests.length : 0,
        citationCount: Array.isArray(event.citations) ? event.citations.length : 0,
        dispatchStatus: ["accepted", "failed", "unknown", "consumed", "none"].includes(event.dispatchStatus) ? event.dispatchStatus : "none",
      },
    });
  } catch (error) {
    // Telemetry is diagnostic; the canonical research ledger remains authoritative.
    if (error?.code?.startsWith?.("TELEMETRY_")) throw error;
  }
}

function matchingRequest(events, correlationId) {
  return events.filter((event) => (
    event.correlationId === correlationId
    && event.state === "RESEARCH_REQUESTED"
  )).at(-1);
}

function matchingDispatch(events, correlationId) {
  return events.filter((event) => (
    event.correlationId === correlationId
    && DISPATCH_STATES.has(event.state)
  )).at(-1);
}

function dispatchStatus(value) {
  const status = Number(value && typeof value === "object" ? value.status : NaN);
  return Number.isInteger(status) ? status : 204;
}

function dispatchState(value) {
  const status = dispatchStatus(value);
  return status >= 200 && status < 300 ? "RESEARCH_DISPATCHED" : "RESEARCH_DISPATCH_FAILED";
}

/** Build the bounded, state-free planner inputs sent with a research dispatch. */
export function buildResearchDispatchPayload(event, { artifactDigest = "" } = {}) {
  const correlationId = safeCorrelation(event?.correlationId);
  if (!correlationId) throw new Error("RESEARCH_CORRELATION_INVALID");
  const digest = safeDigest(artifactDigest || event?.artifactDigest);
  const fingerprint = event?.fingerprint && typeof event.fingerprint === "object" ? event.fingerprint : {};
  const fingerprintId = safeFingerprintId(event?.fingerprintId || fingerprint.id);
  const trigger = safeText(event?.trigger, 64).toLowerCase();
  const query = safeText([
    "Find authoritative public documentation and reproducible guidance for",
    `${fingerprint.errorClass || "an unknown failure"} in ${fingerprint.check || "the affected check"}`,
    `on ${fingerprint.runtime || "the recorded runtime"}.`,
  ].join(" "), 1000);
  return {
    ref: "main",
    inputs: {
      correlation_id: correlationId,
      ...(fingerprintId ? { fingerprint_id: fingerprintId } : {}),
      ...(trigger ? { trigger } : {}),
      query,
      ...(digest ? { artifact_digest: digest } : {}),
    },
  };
}

/** Explicit REST boundary used by trusted callers; retrieval never receives this token. */
export function dispatchResearchWorkflow(payload, { env = process.env, dispatch = ghInput } = {}) {
  return dispatch(
    ["api", "-X", "POST", `/repos/${RESEARCH_WORKFLOW_REPO}/actions/workflows/${RESEARCH_WORKFLOW}/dispatches`],
    payload,
    env,
  );
}

async function persistResearchState(persist, event, stateRoot) {
  if (typeof persist !== "function") return "local-only";
  const result = await persist({ event, stateRoot });
  if (result === "no-changes") throw new Error("RESEARCH_STATE_NOT_COMMITTED");
  return result;
}

/**
 * Persist one eligible request, then dispatch one workflow. A previously
 * requested correlation is intentionally not dispatched again after an
 * ambiguous result; a fresh head or operator reconciliation is required.
 */
export async function requestResearchEscalation({
  stateRoot,
  runId = "research-request",
  repo,
  pr,
  headSha,
  failure = {},
  append = appendResearchEvent,
  read = readResearchEvents,
  persist,
  dispatch = dispatchResearchWorkflow,
  artifactDigest = "",
} = {}) {
  if (!stateRoot) throw new Error("FLEET_STATE_ROOT is required for research escalation");
  const events = read(stateRoot);
  // Callers may already have a normalized fingerprint and omit the original
  // message. Reuse its bounded summary as the deterministic message material
  // so a repeated same-head failure still matches its prior fingerprint.
  const planningFailure = failure && typeof failure === "object" && !failure.message && failure.summary
    ? { ...failure, message: failure.summary }
    : failure;
  const plan = planResearchEscalation({ events, repo, pr, headSha, failure: planningFailure });
  if (!plan.request) return { requested: false, ...plan };
  const existingRequest = matchingRequest(events, plan.event.correlationId);
  if (existingRequest || matchingDispatch(events, plan.event.correlationId)) {
    return { requested: false, reason: "already-requested", event: existingRequest || matchingDispatch(events, plan.event.correlationId) };
  }

  const requestEvent = normalizeResearchEvent({
    ...plan.event,
    runId,
    artifactDigest,
    summary: plan.event.fingerprint?.summary || plan.event.trigger,
  });
  const appended = append(stateRoot, requestEvent);
  if (!appended?.appended) return { requested: false, reason: "already-requested", event: appended?.event || requestEvent };
  await persistResearchState(persist, appended.event, stateRoot);

  const payload = buildResearchDispatchPayload(appended.event, { artifactDigest });
  let response;
  try {
    response = await dispatch(payload);
  } catch (error) {
    const unknown = append(stateRoot, {
      ...appended.event,
      state: "RESEARCH_DISPATCH_UNKNOWN",
      summary: "research workflow dispatch acceptance unknown",
      dispatchStatus: "unknown",
    });
    await persistResearchState(persist, unknown.event, stateRoot);
    return { requested: true, dispatched: false, state: "RESEARCH_DISPATCH_UNKNOWN", event: appended.event, dispatchEvent: unknown.event, payload };
  }

  const state = dispatchState(response);
  const status = dispatchStatus(response);
  const dispatchEventResult = append(stateRoot, {
    ...appended.event,
    state,
    summary: state === "RESEARCH_DISPATCHED" ? "research workflow dispatch accepted" : "research workflow dispatch rejected",
    dispatchStatus: String(status),
  });
  await persistResearchState(persist, dispatchEventResult.event, stateRoot);
  return {
    requested: true,
    dispatched: state === "RESEARCH_DISPATCHED",
    state,
    event: appended.event,
    dispatchEvent: dispatchEventResult.event,
    payload,
  };
}

function continuationTargetMatches(event, completed) {
  return Boolean(event && completed
    && event.correlationId === completed.correlationId
    && event.repo === completed.repo
    && event.pr === completed.pr
    && event.headSha === completed.headSha);
}

function latestContinuation(events, completed) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => CONTINUATION_STATES.has(event?.state) && continuationTargetMatches(event, completed))
    .at(-1);
}

function latestCompleted(events, correlationId, completedEvent) {
  const candidate = normalizeResearchEvent(completedEvent || {});
  const correlation = safeCorrelation(correlationId || candidate.correlationId);
  const found = (Array.isArray(events) ? events : [])
    .filter((event) => event?.state === "RESEARCH_COMPLETED"
      && event.correlationId === correlation
      && (!candidate.repo || continuationTargetMatches(event, candidate)))
    .at(-1);
  return found || (candidate.state === "RESEARCH_COMPLETED" && candidate.correlationId === correlation ? candidate : null);
}

/** Derive a merge dispatch id from the correlation key only. */
export function continuationDispatchId(correlationId) {
  const correlation = safeCorrelation(correlationId);
  if (!correlation) throw new Error("RESEARCH_CORRELATION_INVALID");
  return sha256(`research-merge-continuation|${correlation}`);
}

/**
 * Build the exact-target, merge-disabled continuation payload. A blank
 * dispatch_id intentionally selects merge's manual-dispatch path: merge's
 * non-empty dispatch ids are claims that must already exist in pr-memory.jsonl.
 * Idempotence is enforced by the private research continuation states keyed by
 * the correlation and exact target.
 */
export function buildMergeContinuationPayload(completedEvent) {
  const completed = normalizeResearchEvent(completedEvent || {});
  if (completed.state !== "RESEARCH_COMPLETED") throw new Error("RESEARCH_COMPLETION_REQUIRED");
  if (!completed.correlationId || !completed.repo || !completed.pr || !completed.headSha) {
    throw new Error("RESEARCH_CONTINUATION_TARGET_INVALID");
  }
  return {
    ref: "main",
    inputs: {
      repo: completed.repo,
      pr: String(completed.pr),
      head_sha: completed.headSha,
      allow_merge: "false",
      dispatch_id: "",
    },
  };
}

/** Trusted boundary for the finalizer job; retrieval never imports this path. */
export function dispatchMergeContinuation(payload, { env = process.env, dispatch = ghInput } = {}) {
  return dispatch(
    ["api", "-X", "POST", `/repos/${MERGE_WORKFLOW_REPO}/actions/workflows/${MERGE_WORKFLOW}/dispatches`],
    payload,
    env,
  );
}

/** Persist the continuation intent before any merge workflow request is made. */
export async function prepareResearchContinuation({
  stateRoot,
  completedEvent,
  correlationId,
  runId = "research-finalizer",
  append = appendResearchEvent,
  read = readResearchEvents,
  persist,
} = {}) {
  if (!stateRoot) throw new Error("FLEET_STATE_ROOT is required for research continuation");
  const events = read(stateRoot);
  const completed = latestCompleted(events, correlationId, completedEvent);
  if (!completed) return { prepared: false, reason: "completed-not-found" };
  const existing = latestContinuation(events, completed);
  if (existing) {
    if (existing.state === "RESEARCH_CONTINUATION_DISPATCHING") {
      return { prepared: false, reason: "in-flight", event: existing };
    }
    if (existing.state === "RESEARCH_CONTINUATION_INTENT" && existing.runId === safeRunId(runId)) {
      return { prepared: false, reason: "already-prepared", event: existing, completed };
    }
    if (existing.state === "RESEARCH_CONTINUATION_INTENT") {
      return { prepared: false, reason: "another-run-intent", event: existing, completed };
    }
    return { prepared: false, reason: "already-dispatched", event: existing, completed };
  }

  const payload = buildMergeContinuationPayload(completed);
  const intent = normalizeResearchEvent({
    runId,
    state: "RESEARCH_CONTINUATION_INTENT",
    correlationId: completed.correlationId,
    repo: completed.repo,
    pr: completed.pr,
    headSha: completed.headSha,
    dispatchId: payload.inputs.dispatch_id,
    summary: "merge continuation intent persisted with merge disabled",
  });
  const appended = append(stateRoot, intent);
  if (!appended?.appended) return { prepared: false, reason: "already-prepared", event: appended?.event || intent, completed };
  await persistResearchState(persist, appended.event, stateRoot);
  return { prepared: true, event: appended.event, completed, payload };
}

/** Dispatch one prepared continuation and persist every outcome before returning. */
export async function dispatchPreparedResearchContinuation({
  stateRoot,
  completedEvent,
  correlationId,
  runId = "research-finalizer",
  append = appendResearchEvent,
  read = readResearchEvents,
  persist,
  dispatch = dispatchMergeContinuation,
} = {}) {
  if (!stateRoot) throw new Error("FLEET_STATE_ROOT is required for research continuation");
  const events = read(stateRoot);
  const completed = latestCompleted(events, correlationId, completedEvent);
  if (!completed) return { dispatched: false, reason: "completed-not-found" };
  const intent = latestContinuation(events, completed);
  if (!intent) return { dispatched: false, reason: "continuation-not-prepared", completed };
  if (intent.state === "RESEARCH_CONTINUATION_DISPATCHING") {
    return { dispatched: false, reason: "in-flight", event: intent, completed };
  }
  if (intent.state !== "RESEARCH_CONTINUATION_INTENT") {
    return { dispatched: false, reason: "already-dispatched", event: intent, completed };
  }
  if (intent.runId !== safeRunId(runId)) {
    return { dispatched: false, reason: "another-run-intent", event: intent, completed };
  }

  const payload = buildMergeContinuationPayload(completed);
  const dispatching = append(stateRoot, {
    ...intent,
    state: "RESEARCH_CONTINUATION_DISPATCHING",
    dispatchStatus: "dispatching",
    dispatchId: payload.inputs.dispatch_id,
    summary: "merge continuation dispatch in progress",
  });
  // Another worker may have won the append race after both read the intent.
  // Only the worker that durably appended DISPATCHING may call the API.
  if (!dispatching?.appended) {
    return { dispatched: false, reason: "in-flight", event: dispatching?.event || intent, completed, payload };
  }
  await persistResearchState(persist, dispatching.event, stateRoot);

  let response;
  try {
    response = await dispatch(payload);
  } catch (error) {
    const unknown = append(stateRoot, {
      ...intent,
      state: "RESEARCH_CONTINUATION_UNKNOWN",
      dispatchStatus: "unknown",
      dispatchId: payload.inputs.dispatch_id,
      summary: "merge continuation acceptance unknown",
    });
    await persistResearchState(persist, unknown.event, stateRoot);
    return { dispatched: false, state: "RESEARCH_CONTINUATION_UNKNOWN", event: intent, dispatchEvent: unknown.event, payload };
  }
  const status = dispatchStatus(response);
  const state = status >= 200 && status < 300
    ? "RESEARCH_CONTINUATION_DISPATCHED"
    : "RESEARCH_CONTINUATION_FAILED";
  const outcome = append(stateRoot, {
    ...intent,
    state,
    dispatchStatus: String(status),
    dispatchId: payload.inputs.dispatch_id,
    summary: state === "RESEARCH_CONTINUATION_DISPATCHED"
      ? "merge continuation dispatch accepted"
      : "merge continuation dispatch rejected",
  });
  await persistResearchState(persist, outcome.event, stateRoot);
  return {
    dispatched: state === "RESEARCH_CONTINUATION_DISPATCHED",
    state,
    event: intent,
    dispatchEvent: outcome.event,
    payload,
    completed,
  };
}

/** Prepare and dispatch exactly one merge-disabled continuation. */
export async function requestResearchContinuation(options = {}) {
  const {
    stateRoot,
    correlationId,
    runId = "research-finalizer",
    append = appendResearchEvent,
    read = readResearchEvents,
    persist,
    dispatch = dispatchMergeContinuation,
  } = options;
  if (!stateRoot) throw new Error("FLEET_STATE_ROOT is required for research continuation");
  const completed = latestCompleted(read(stateRoot), correlationId);
  if (!completed) return { dispatched: false, reason: "completed-not-found" };
  const prepared = await prepareResearchContinuation({
    ...options,
    completedEvent: completed,
    stateRoot,
    correlationId: completed.correlationId,
    runId,
    append,
    read,
    persist,
  });
  if (!prepared.prepared && prepared.reason !== "already-prepared") return { dispatched: false, ...prepared };
  return dispatchPreparedResearchContinuation({
    ...options,
    completedEvent: completed,
    stateRoot,
    correlationId: completed.correlationId,
    runId,
    append,
    read,
    persist,
    dispatch,
  });
}

export {
  CORRELATION_RE,
  DIGEST_RE,
  DISPATCH_STATES,
  CONTINUATION_STATES,
  FAILURE_STATES,
  FINGERPRINT_RE,
  TERMINAL_STATES,
};
