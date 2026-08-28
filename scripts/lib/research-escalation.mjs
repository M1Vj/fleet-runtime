import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const HASH_RE = /^[a-f0-9]{64}$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_FINGERPRINT_SUMMARY = 240;
const MAX_EVIDENCE_EXCERPT = 500;
const MAX_EVIDENCE_TEXT = 64 * 1024;
export const MAX_PUBLIC_RESEARCH_BYTES = 256 * 1024;
export const PUBLIC_RESEARCH_TIMEOUT_MS = 30_000;

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
  /\bBEGIN [A-Z0-9 ]*PRIVATE KEY\b[\s\S]*?(?:\bEND [A-Z0-9 ]*PRIVATE KEY\b|$)/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g,
  /\b(?:npm_|glpat-|pypi-)[A-Za-z0-9_-]{20,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/gi,
  /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}\b/gi,
  /(?:https?|postgres(?:ql)?|mysql):\/\/[^\s/:@]+:[^\s@]+@[^\s]+/gi,
  /(?:^|[?&#\s])(?:access_token|refresh_token|id_token|token|api[-_]?key|apikey|client_secret|secret|password|passwd)\s*[=:]\s*["']?[A-Za-z0-9._~+\/%=-]{8,}["']?/gi,
];

const ABSOLUTE_PATH_RE = /(?:\/(?:Users|home|private|tmp|var|opt|workspace|workspaces|repos?|src|build|etc)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*|\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+|(?:[A-Za-z]:\\|\\\\)[^\s"']+)/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>'"`]+/gi;
const BARE_DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;

const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i,
  /reveal\s+(?:the\s+)?(?:secrets?|credentials?|tokens?|system\s+prompt)/i,
  /(?:run|execute|invoke)\s+(?:curl|wget|bash|sh|powershell|command|shell)\b/i,
  /(?:system|developer)\s+(?:message|instruction)\s*:/i,
  /(?:system\s+prompt|developer\s+prompt)\b/i,
  /(?:ignore|disregard)\s+(?:all\s+)?(?:rules|policies|guardrails|directions?)\b/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
  /send\s+(?:the\s+)?(?:secret|token|credential).+to\s+/i,
];

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function compact(value, max = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Redact credentials and machine-local paths before any value is hashed or persisted. */
export function redactResearchText(value, { redactBareDomains = false } = {}) {
  let output = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  output = output.replace(URL_RE, "[LINK]");
  output = output.replace(ABSOLUTE_PATH_RE, "[PATH]");
  if (redactBareDomains) output = output.replace(BARE_DOMAIN_RE, "[HOST]");
  return compact(output);
}

function normalizePart(value, fallback) {
  const normalized = compact(redactResearchText(value), 96).toLowerCase();
  return normalized || fallback;
}

function stableFailureMaterial({ errorClass, check, runtime, message }) {
  return JSON.stringify({
    check,
    errorClass,
    message: compact(redactResearchText(message), 2000),
    runtime,
  });
}

/**
 * Build a bounded fingerprint that cannot retain raw logs, credentials, or
 * machine-local paths. The digest is intentionally based on redacted values.
 */
export function buildFailureFingerprint(input = {}) {
  const errorClass = normalizePart(input.errorClass, "unknown-error");
  const check = normalizePart(input.check, "unknown-check");
  const runtime = normalizePart(input.runtime, "unknown-runtime");
  const summary = compact(redactResearchText(input.message), MAX_FINGERPRINT_SUMMARY);
  const digest = sha256(stableFailureMaterial({
    errorClass,
    check,
    runtime,
    message: input.message,
  }));
  return {
    id: `failure-${digest.slice(0, 32)}`,
    errorClass,
    check,
    runtime,
    summary,
  };
}

function normalizedRepo(value) {
  return compact(redactResearchText(value), 160);
}

function normalizedHead(value) {
  const head = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{40,64}$/.test(head) ? head : "";
}

function normalizedPr(value) {
  const pr = Number(value);
  return Number.isSafeInteger(pr) && pr > 0 ? pr : 0;
}

function eventFingerprintId(event) {
  if (typeof event?.fingerprintId === "string") return event.fingerprintId;
  if (typeof event?.fingerprint?.id === "string") return event.fingerprint.id;
  if (typeof event?.failureFingerprint?.id === "string") return event.failureFingerprint.id;
  return "";
}

function researchCorrelationId({ repo, pr, headSha, fingerprintId }) {
  return `research-${sha256(JSON.stringify({ fingerprintId, headSha, pr, repo })).slice(0, 32)}`;
}

/**
 * Decide whether a bounded research request is needed. Events are treated as
 * untrusted input and only exact target/head/fingerprint matches count.
 */
export function planResearchEscalation({ events = [], repo, pr, headSha, failure = {} } = {}) {
  const targetRepo = normalizedRepo(repo);
  const targetPr = normalizedPr(pr);
  const targetHead = normalizedHead(headSha);
  const fingerprint = buildFailureFingerprint(failure);
  if (!targetRepo || !targetPr || !targetHead) {
    return { request: false, reason: "invalid-target" };
  }

  const targetEvents = (Array.isArray(events) ? events : []).filter((event) => (
    event && typeof event === "object"
    && normalizedRepo(event.repo) === targetRepo
    && normalizedPr(event.pr) === targetPr
    && normalizedHead(event.headSha) === targetHead
  ));
  const correlationId = researchCorrelationId({
    repo: targetRepo,
    pr: targetPr,
    headSha: targetHead,
    fingerprintId: fingerprint.id,
  });
  if (targetEvents.some((event) => (
    event.state === "RESEARCH_REQUESTED"
    && (event.correlationId === correlationId || eventFingerprintId(event) === fingerprint.id)
  ))) {
    return { request: false, reason: "already-requested" };
  }

  const identicalFailures = targetEvents.filter((event) => (
    ["FAILURE_OBSERVED", "FAILURE", "CHECK_FAILED"].includes(String(event.state || ""))
    && eventFingerprintId(event) === fingerprint.id
  )).length;
  const confidence = String(failure.diagnosisConfidence ?? failure.confidence ?? "").trim().toLowerCase();
  const hardLowConfidence = failure.hard === true && confidence === "low";
  if (!hardLowConfidence && identicalFailures < 1) {
    return { request: false, reason: "not-eligible" };
  }

  const event = {
    kind: "research",
    state: "RESEARCH_REQUESTED",
    correlationId,
    fingerprintId: fingerprint.id,
    fingerprint,
    repo: targetRepo,
    pr: targetPr,
    headSha: targetHead,
    trigger: hardLowConfidence ? "hard-low-confidence" : "same-head-repeat",
  };
  return { request: true, event };
}

function parseIPv4Like(hostname) {
  const host = String(hostname).toLowerCase().replace(/^0x/, "");
  if (/^[0-9a-f]+$/.test(host) && (String(hostname).toLowerCase().startsWith("0x") || host.length > 8)) {
    const value = Number.parseInt(host, 16);
    if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) return value;
  }
  const parts = String(hostname).split(".");
  if (parts.length < 1 || parts.length > 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 255)) {
    if (parts.length !== 1 || !Number.isSafeInteger(nums[0]) || nums[0] > 0xffffffff) return null;
  }
  if (parts.length === 1) return nums[0] <= 0xffffffff ? nums[0] : null;
  if (parts.length === 2 && nums[1] <= 0xffffff) return nums[0] * 0x1000000 + nums[1];
  if (parts.length === 3 && nums[2] <= 0xffff) return nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2];
  if (parts.length === 4) return nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2] * 0x100 + nums[3];
  return null;
}

function unsafeIPv4(hostname) {
  const value = parseIPv4Like(hostname);
  if (value === null) return false;
  const a = (value >>> 24) & 0xff;
  const b = (value >>> 16) & 0xff;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0) || (a === 192 && b === 168)
    || (a === 198 && b >= 18 && b <= 19) || (a === 198 && b === 51)
    || (a === 203 && b === 0) || a >= 224;
}

function ipv6BigInt(hostname) {
  let host = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host.includes("%") || isIP(host) !== 6) return null;
  const ipv4Tail = host.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const value = parseIPv4Like(ipv4Tail);
    if (value === null) return null;
    host = host.slice(0, -ipv4Tail.length) + `${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const pieces = host.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || (pieces.length === 2 && missing < 1)) return null;
  const parts = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(Number.parseInt(part, 16)), 0n);
}

function ipv6Prefix(value, prefix, bits) {
  const prefixValue = ipv6BigInt(prefix);
  return prefixValue !== null && (value >> BigInt(128 - bits)) === (prefixValue >> BigInt(128 - bits));
}

/** Fail closed: only current global-unicast space, excluding reserved transition/documentation blocks. */
function unsafeIPv6(hostname) {
  const value = ipv6BigInt(hostname);
  if (value === null || !ipv6Prefix(value, "2000::", 3)) return true;
  return [
    ["2001::", 23],       // IETF protocol assignments and transition/reserved space
    ["2001:db8::", 32],   // documentation
    ["2002::", 16],       // 6to4
    ["3ffe::", 16],       // deprecated 6bone
    ["3fff::", 20],       // documentation
  ].some(([prefix, bits]) => ipv6Prefix(value, prefix, bits));
}

function unsafeHostname(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal") || host.endsWith(".intranet") || host.endsWith(".lan")
    || host.endsWith(".home") || host === "metadata.google.internal") return true;
  if (isIP(host) === 4) return unsafeIPv4(host);
  if (isIP(host) === 6) return unsafeIPv6(host);
  const numericPrefix = host.match(/^(\d+(?:\.\d+){1,3})\./);
  if (numericPrefix && unsafeIPv4(numericPrefix[1])) return true;
  return unsafeIPv4(host);
}

/** Validate an HTTPS source URL without resolving or contacting its host. */
export function validateResearchUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return { ok: false, reason: "url-invalid" };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "url-invalid" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "https-required" };
  if (parsed.username || parsed.password) return { ok: false, reason: "userinfo-forbidden" };
  if (parsed.port && parsed.port !== "443") return { ok: false, reason: "nonstandard-port" };
  if ([...parsed.searchParams.keys()].some((key) => /(?:token|secret|password|passwd|key|auth|credential|sig|signature)/i.test(key))) {
    return { ok: false, reason: "credential-query-forbidden" };
  }
  if (unsafeHostname(parsed.hostname)) return { ok: false, reason: "public-host-required" };
  return { ok: true, url: parsed.toString(), hostname: parsed.hostname.toLowerCase() };
}

/**
 * Fetch one public research source through an explicit SSRF-safe boundary.
 * URL policy is checked before invoking the injected fetch implementation;
 * redirects are disabled and a response URL is checked again before any body
 * is accepted. Callers still need to pass the returned text through
 * normalizeResearchEvidence before persisting or prompting with it.
 */
export async function fetchPublicResearchSource(
  value,
  {
    fetchImpl,
    lookupImpl = dnsLookup,
    timeoutMs = PUBLIC_RESEARCH_TIMEOUT_MS,
    maxBytes = MAX_PUBLIC_RESEARCH_BYTES,
    signal: parentSignal,
  } = {},
) {
  const checked = validateResearchUrl(value);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const boundedBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, MAX_PUBLIC_RESEARCH_BYTES)
    : MAX_PUBLIC_RESEARCH_BYTES;
  const controller = new AbortController();
  let timer;
  const abort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) return { ok: false, reason: "fetch-aborted" };
    parentSignal.addEventListener("abort", abort, { once: true });
  }
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.min(Number(timeoutMs), 120_000)
    : PUBLIC_RESEARCH_TIMEOUT_MS;
  timer = setTimeout(abort, timeout);
  let resolvedAddresses;
  try {
    if (isIP(checked.hostname)) {
      resolvedAddresses = [{ address: checked.hostname, family: isIP(checked.hostname) }];
    } else {
      if (typeof lookupImpl !== "function") return { ok: false, reason: "host-resolution-unavailable" };
      const lookedUp = await lookupImpl(checked.hostname, { all: true, verbatim: true });
      resolvedAddresses = (Array.isArray(lookedUp) ? lookedUp : [lookedUp])
        .map((entry) => ({ address: String(entry?.address || ""), family: Number(entry?.family) || isIP(entry?.address) }))
        .filter((entry) => isIP(entry.address));
    }
  } catch {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", abort);
    return { ok: false, reason: "host-resolution-failed" };
  }
  if (resolvedAddresses.length === 0 || resolvedAddresses.some((entry) => (
    (entry.family === 4 && unsafeIPv4(entry.address)) || (entry.family === 6 && unsafeIPv6(entry.address))
  ))) {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", abort);
    return { ok: false, reason: "public-host-required" };
  }
  let response;
  try {
    if (typeof fetchImpl === "function") {
      // Injected fetches receive the resolved address set so tests and
      // production adapters can pin their own socket/dispatcher. Global
      // fetch is intentionally not used here because it can re-resolve DNS.
      response = await fetchImpl(checked.url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        lookup: (_hostname, _options, callback) => callback(null, resolvedAddresses[0].address, resolvedAddresses[0].family),
        resolvedAddresses,
        headers: { accept: "text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1" },
      });
    } else {
      response = await requestPinnedResearchSource(checked, resolvedAddresses, {
        controller,
        timeout,
        maxBytes: boundedBytes,
      });
    }
  } catch (error) {
    const message = String(error?.message || error || "");
    return {
      ok: false,
      reason: message === "response-too-large" ? "response-too-large" : controller.signal.aborted ? "fetch-timeout" : "fetch-failed",
    };
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", abort);
  }

  const status = Number(response?.status || 0);
  if (response?.redirected === true || (status >= 300 && status < 400)) {
    return { ok: false, reason: "unsafe-redirect" };
  }
  const responseUrl = typeof response?.url === "string" && response.url ? response.url : checked.url;
  const finalUrl = validateResearchUrl(responseUrl);
  if (!finalUrl.ok || finalUrl.url !== checked.url) return { ok: false, reason: "unsafe-redirect" };
  if (response?.ok !== true) return { ok: false, reason: "http-failed", status };

  const contentLength = Number(response?.headers?.get?.("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > boundedBytes) {
    return { ok: false, reason: "response-too-large" };
  }
  if (typeof response?.text !== "function") return { ok: false, reason: "response-body-unavailable" };
  let text;
  try {
    text = await response.text();
  } catch {
    return { ok: false, reason: "response-body-unavailable" };
  }
  if (typeof text !== "string") return { ok: false, reason: "response-body-invalid" };
  if (Buffer.byteLength(text, "utf8") > boundedBytes) return { ok: false, reason: "response-too-large" };
  return {
    ok: true,
    url: finalUrl.url,
    status,
    contentType: String(response?.headers?.get?.("content-type") || "text/plain").split(";", 1)[0].trim().toLowerCase(),
    text,
  };
}

/** Use one pre-resolved address for the TLS socket; no redirect is followed. */
function requestPinnedResearchSource(checked, resolvedAddresses, { controller, timeout, maxBytes }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(checked.url);
    const request = httpsRequest(checked.url, {
      method: "GET",
      servername: parsed.hostname,
      timeout,
      lookup: (_hostname, _options, callback) => callback(null, resolvedAddresses[0].address, resolvedAddresses[0].family),
      headers: { accept: "text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1" },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          request.destroy(new Error("response-too-large"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        const headers = {
          get: (name) => {
            const value = response.headers?.[String(name).toLowerCase()];
            return Array.isArray(value) ? value[0] : value || null;
          },
        };
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: Number(response.statusCode || 0),
          url: checked.url,
          redirected: false,
          headers,
          text: async () => Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("error", reject);
    });
    const abort = () => request.destroy(new Error("request-aborted"));
    if (controller.signal.aborted) abort();
    else controller.signal.addEventListener("abort", abort, { once: true });
    request.on("error", reject);
    request.on("close", () => controller.signal.removeEventListener("abort", abort));
    request.end();
  });
}

function injectionMatch(text) {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(String(text ?? "")));
}

function normalizeEvidenceText(value) {
  let text = String(value ?? "").slice(0, MAX_EVIDENCE_TEXT);
  let injectionSuspected = injectionMatch(text);
  text = text.replace(/\r\n?/g, "\n");
  const lines = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(line)) injectionSuspected = true;
      pattern.lastIndex = 0;
    }
    line = line.replace(URL_RE, "[LINK]");
    line = line.replace(SECRET_PATTERNS[0], "[REDACTED]");
    for (const pattern of SECRET_PATTERNS.slice(1)) {
      line = line.replace(pattern, "[REDACTED]");
      pattern.lastIndex = 0;
    }
    if (injectionMatch(line)) {
      line = line.replace(BARE_DOMAIN_RE, "[HOST]");
      line = line.replace(/\b(?:ignore|disregard|reveal|execute|run|invoke|send|system|developer)\b[^.!?\n]*(?:[.!?]|$)/gi, "[QUARANTINED]");
    }
    line = line.replace(ABSOLUTE_PATH_RE, "[PATH]");
    line = line.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    line = line.replace(/[ \t]+/g, " ").trim();
    if (line) lines.push(line);
  }
  return { text: lines.join(" ").replace(/\s+/g, " ").trim(), injectionSuspected };
}

function normalizedRetrievedAt(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : "";
  }
  const text = String(value ?? "").trim();
  if (!text) return "";
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

function safeEvidenceUrl(value) {
  const parsed = new URL(value);
  for (const [key, raw] of [...parsed.searchParams.entries()]) {
    if (/(?:token|secret|password|passwd|key|auth|credential|sig|signature)/i.test(key)
      || SECRET_PATTERNS.some((pattern) => pattern.test(raw))) {
      parsed.searchParams.set(key, "[REDACTED]");
      for (const pattern of SECRET_PATTERNS) pattern.lastIndex = 0;
    }
  }
  parsed.hash = "";
  return parsed.toString();
}

/** Convert a fetched page into bounded, explicitly untrusted evidence. */
export function normalizeResearchEvidence(input = {}) {
  const url = validateResearchUrl(input.url);
  if (!url.ok) return { ok: false, reason: url.reason };
  const retrievedAt = normalizedRetrievedAt(input.retrievedAt);
  if (!retrievedAt) return { ok: false, reason: "retrieved-at-invalid" };
  if (typeof input.text !== "string") return { ok: false, reason: "text-required" };
  const contentType = compact(input.contentType || "text/plain", 96).toLowerCase();
  if (!/^(?:text\/|application\/(?:json|pdf|xml)|image\/(?:svg\+xml))/.test(contentType)) {
    return { ok: false, reason: "content-type-unsupported" };
  }
  const normalized = normalizeEvidenceText(input.text);
  const excerpt = normalized.text.slice(0, MAX_EVIDENCE_EXCERPT);
  const digest = sha256(JSON.stringify({ contentType, text: normalized.text.slice(0, MAX_EVIDENCE_TEXT) }));
  return {
    ok: true,
    url: safeEvidenceUrl(url.url),
    title: compact(redactResearchText(input.title || "Untitled source", { redactBareDomains: true }), 160) || "Untitled source",
    retrievedAt,
    contentType,
    excerpt,
    digest,
    injectionSuspected: normalized.injectionSuspected,
    trust: "untrusted-evidence",
    evidenceType: "public-source-text",
    factStatus: "unknown",
    truncated: String(input.text).length > MAX_EVIDENCE_TEXT,
  };
}

export { HASH_RE, SHA256_RE };
