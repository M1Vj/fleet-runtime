import { createHash } from "node:crypto";
import { recordTelemetryEvent } from "./telemetry.mjs";

const FINGERPRINT_RE = /^comment-[a-f0-9]{64}$/i;
const MARKER_RE = /<!--\s*fleet-pr-memory:\s*([a-z0-9_-]{1,32})(?:\s+(comment-[a-f0-9]{64}))?\s*-->/gi;
const MAX_BODY_CHARS = 6000;

/** Emit one redacted comment state without accepting public body text. */
export function emitCommentTelemetry({
  telemetry,
  telemetryFile,
  runId,
  correlationId,
  lane = "merge",
  repo,
  pr,
  headSha,
  fingerprint,
  phase,
  outcome,
  action,
} = {}) {
  const event = {
    runId,
    correlationId,
    lane,
    event: "comment",
    phase,
    outcome,
    repo,
    pr,
    headSha,
    comment: { fingerprint, action },
  };
  if (typeof telemetry === "function") return telemetry(event);
  if (telemetryFile) return recordTelemetryEvent(telemetryFile, event);
  return null;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function boundedKind(value) {
  const kind = String(value ?? "gate").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(kind) ? kind : "gate";
}

function positivePr(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/** Normalize only controlled public text before hashing or marker comparison. */
export function normalizePublicCommentBody(value) {
  return String(value ?? "")
    .replace(MARKER_RE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim()
    .slice(0, MAX_BODY_CHARS);
}

/** Stable identity for one bounded comment on one exact PR head. */
export function publicCommentFingerprint({ kind = "gate", repo = "", pr = 0, headSha = "", body = "" } = {}) {
  const material = {
    kind: boundedKind(kind),
    repo: String(repo ?? "").trim().toLowerCase(),
    pr: positivePr(pr),
    headSha: String(headSha ?? "").trim().toLowerCase(),
    body: normalizePublicCommentBody(body),
  };
  return `comment-${sha256(JSON.stringify(material))}`;
}

export function commentFingerprintMarker(kind, fingerprint) {
  const normalized = String(fingerprint ?? "");
  if (!FINGERPRINT_RE.test(normalized)) throw new Error("comment fingerprint is invalid");
  return `<!-- fleet-pr-memory: ${boundedKind(kind)} ${normalized} -->`;
}

/** Prefix controlled text with one idempotency marker. */
export function withPublicCommentFingerprint(body, { kind = "gate", fingerprint } = {}) {
  const marker = commentFingerprintMarker(kind, fingerprint);
  return `${marker}\n${normalizePublicCommentBody(body)}`.slice(0, MAX_BODY_CHARS + marker.length + 1);
}

/** Return a marker fingerprint, or an empty string for legacy/unmarked text. */
export function extractPublicCommentFingerprint(body, { kind } = {}) {
  const expectedKind = kind === undefined ? undefined : boundedKind(kind);
  MARKER_RE.lastIndex = 0;
  let match;
  while ((match = MARKER_RE.exec(String(body ?? "")))) {
    if (expectedKind !== undefined && match[1].toLowerCase() !== expectedKind) continue;
    return match[2] && FINGERPRINT_RE.test(match[2]) ? match[2].toLowerCase() : "";
  }
  return "";
}

function markerKind(body) {
  MARKER_RE.lastIndex = 0;
  const match = MARKER_RE.exec(String(body ?? ""));
  return match ? match[1].toLowerCase() : "";
}

function commentAuthorMatches(comment, authorLogin) {
  if (!authorLogin) return true;
  const login = comment?.user?.login ?? comment?.author?.login ?? comment?.login;
  return Boolean(login) && String(login) === String(authorLogin);
}

/** Detect one prior equivalent controlled comment without contacting GitHub. */
export function hasPublicCommentFingerprint(comments, {
  kind = "gate",
  repo = "",
  pr = 0,
  headSha = "",
  body = "",
  fingerprint = publicCommentFingerprint({ kind, repo, pr, headSha, body }),
  authorLogin = "",
  allowLegacy = false,
} = {}) {
  return Boolean(findPublicCommentFingerprint(comments, {
    kind,
    repo,
    pr,
    headSha,
    body,
    fingerprint,
    authorLogin,
    allowLegacy,
  }));
}

/** Return the exact matching comment object, preserving attribution checks. */
export function findPublicCommentFingerprint(comments, {
  kind = "gate",
  repo = "",
  pr = 0,
  headSha = "",
  body = "",
  fingerprint = publicCommentFingerprint({ kind, repo, pr, headSha, body }),
  authorLogin = "",
  allowLegacy = false,
} = {}) {
  if (!FINGERPRINT_RE.test(String(fingerprint ?? ""))) return null;
  const expectedBody = normalizePublicCommentBody(body);
  const expectedKind = boundedKind(kind);
  for (const comment of Array.isArray(comments) ? comments : []) {
    if (!commentAuthorMatches(comment, authorLogin)) continue;
    const commentBody = typeof comment === "string" ? comment : comment?.body;
    if (extractPublicCommentFingerprint(commentBody, { kind: expectedKind }) === String(fingerprint).toLowerCase()
      && normalizePublicCommentBody(commentBody) === expectedBody) return comment;
    if (allowLegacy && markerKind(commentBody) === expectedKind
      && !extractPublicCommentFingerprint(commentBody, { kind: expectedKind })
      && normalizePublicCommentBody(commentBody) === expectedBody) return comment;
  }
  return null;
}

/**
 * Fetch a bounded sequence of issue comments without allowing an unbounded
 * pagination loop. The caller owns the transport so tests can stay offline.
 */
export async function listPublicComments({ repo, pr, listPage, maxPages = 5, pageSize = 100 } = {}) {
  if (typeof listPage !== "function") return [];
  const pages = Number.isSafeInteger(maxPages) ? Math.max(1, Math.min(maxPages, 5)) : 5;
  const size = Number.isSafeInteger(pageSize) ? Math.max(1, Math.min(pageSize, 100)) : 100;
  const comments = [];
  for (let page = 1; page <= pages; page += 1) {
    const batch = await listPage(repo, pr, page, size);
    if (!Array.isArray(batch)) break;
    comments.push(...batch);
    if (batch.length < size) break;
  }
  return comments;
}

export { FINGERPRINT_RE, MAX_BODY_CHARS };
