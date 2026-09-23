import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const CORE_VERSION = "1.0.0";

export const CORE_LOCK_DIGEST = "8058739fbd139d5b8f384c0bea71615daec2ccab95d99448fbd8633e42807cdd";
export const CORE_FILE_DIGESTS = Object.freeze({
  "manifest.json": "c657e6d7d16ae703a04459c73a5ee7d4b7628d54a9e2f52fcc9503c8559de420",
  "schema.json": "799738d89156ee5454a4092d493efd78226092c58c8adb1f7a9c3058ce93b1df",
  "golden-vectors.json": "07a24d2e4899cff320d535791036f1eb64017cca35d1d821f24cd0b7f952ad1e",
});

const FALLBACK_CAPABILITIES = Object.freeze({
  primaryModel: "opencode/muse-spark-1.3-contributor-free",
  paidFallbackModel: null,
  defaultModelChain: Object.freeze([
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/mimo-v2.6-flash-free",
    "opencode/jev-1.13-free",
    "opencode/nemotron-3-ultra-free",
    "opencode/muse-spark-1.2-contributor-free",
  ]),
  dynamicModelPool: Object.freeze([
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/mimo-v2.6-flash-free",
    "opencode/jev-1.13-free",
    "opencode/nemotron-3-ultra-free",
    "opencode/muse-spark-1.2-contributor-free",
    "opencode/nemotron-3.5-lightning-free",
    "opencode/mimo-v2.5-free",
    "opencode/ling-3.0-flash-fin-free",
  ]),
  variant: "xhigh",
  reasoningEffort: "xhigh",
  tools: true,
  parallelToolCalls: true,
  unboundedSteps: Number.MAX_SAFE_INTEGER,
  minOutputTokens: 16384,
  minMaxTokens: 16384,
  compactionPruning: Object.freeze({ compaction: true, pruning: true }),
  exactSession: true,
  singleWriter: true,
  authorizedFailover: true,
  routeFailover: true,
  quotaWaitWhenNoEligibleRoute: true,
  noIdentitySpoofing: true,
  noLimitCircumvention: true,
  retryAfterParsing: true,
  circuitBreaker: true,
});

const FALLBACK_MODEL_POLICY = Object.freeze({
  idPattern: "^opencode/[a-z0-9][a-z0-9._-]*$",
  contributorTierPattern: "contributor",
  forbiddenPatterns: Object.freeze(["gemini", "google"]),
  deadModelIds: Object.freeze([
    "opencode/union-alpha",
    "union-alpha",
    "opencode/x-preview-f-free",
    "opencode/minimax-m3-free",
    "codexswap-alpha/x-preview-f-free",
    "opencode/deepseek-v4-flash-free",
  ]),
});

const FALLBACK_MANIFEST = Object.freeze({
  name: "opencode-indefinite-core",
  coreVersion: CORE_VERSION,
  policyVersion: CORE_VERSION,
  capabilities: FALLBACK_CAPABILITIES,
  modelPolicy: FALLBACK_MODEL_POLICY,
  retryPolicy: Object.freeze({ defaultRetryAfterMs: 180000, maxErrorBodyBytes: 16384 }),
  circuitPolicy: Object.freeze({ openMs: 1800000 }),
});

const FALLBACK_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "OpenCode indefinite runtime core manifest",
});

const FALLBACK_GOLDEN_VECTORS = Object.freeze({
  version: CORE_VERSION,
  models: Object.freeze({
    primary: FALLBACK_CAPABILITIES.primaryModel,
    forbidden: "opencode/gemini-3-flash",
    chainInput: Object.freeze([
      FALLBACK_CAPABILITIES.primaryModel,
      "opencode/gemini-3-flash",
      "opencode/x-preview-f-free",
      "opencode/nemotron-3.5-lightning-free",
      "opencode/nemotron-3.5-lightning-free",
    ]),
    chainOutput: Object.freeze([
      FALLBACK_CAPABILITIES.primaryModel,
      "opencode/nemotron-3.5-lightning-free",
    ]),
  }),
  retry: Object.freeze({
    now: 0,
    deltaHeader: "3",
    deltaAt: 3000,
    status: 429,
    headers: Object.freeze({ "retry-after-ms": "1500", "retry-after": "3" }),
    body: '{"error":{"type":"FreeUsageLimitError"}}',
    classification: "quota_limited",
  }),
  capabilities: Object.freeze({
    primaryModel: Object.freeze({ name: "primaryModel", value: true, expected: true }),
    xhighVariant: Object.freeze({ name: "xhighVariant", value: "xhigh", expected: true }),
    tools: Object.freeze({ name: "tools", value: true, expected: true }),
    parallelToolCalls: Object.freeze({ name: "parallelToolCalls", value: true, expected: true }),
    unboundedSteps: Object.freeze({ name: "unboundedSteps", value: Number.MAX_SAFE_INTEGER, expected: true }),
    outputFloor: Object.freeze({ name: "outputFloor", value: 16384, expected: true }),
    compaction: Object.freeze({ name: "compaction", value: true, expected: true }),
    pruning: Object.freeze({ name: "pruning", value: true, expected: true }),
    exactSession: Object.freeze({ name: "exactSession", value: true, expected: true }),
    singleWriter: Object.freeze({ name: "singleWriter", value: true, expected: true }),
    authorizedFailover: Object.freeze({ name: "authorizedFailover", value: true, expected: true }),
    quotaWaitWhenNoEligibleRoute: Object.freeze({ name: "quotaWaitWhenNoEligibleRoute", value: true, expected: true }),
    noIdentitySpoofing: Object.freeze({ name: "noIdentitySpoofing", value: true, expected: true }),
    noLimitCircumvention: Object.freeze({ name: "noLimitCircumvention", value: true, expected: true }),
  }),
});

function readJson(root, file) {
  try {
    return JSON.parse(readFileSync(path.join(root, file), "utf8"));
  } catch {
    return null;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileDigest(root, file) {
  try {
    return sha256(readFileSync(path.join(root, file)));
  } catch {
    return null;
  }
}

function aggregateDigest(bytes) {
  return sha256(Buffer.concat([
    Buffer.from(bytes.manifest),
    Buffer.from("\n"),
    Buffer.from(bytes.schema),
    Buffer.from("\n"),
    Buffer.from(bytes.vectors),
  ]));
}

function manifestShapeValid(manifest) {
  if (!manifest || typeof manifest !== "object") return false;
  if (manifest.name !== FALLBACK_MANIFEST.name || manifest.coreVersion !== CORE_VERSION) return false;
  const c = manifest.capabilities;
  if (!c || c.primaryModel !== FALLBACK_CAPABILITIES.primaryModel) return false;
  if (!Array.isArray(c.defaultModelChain) || c.defaultModelChain.length < 1) return false;
  if (c.variant !== "xhigh" || c.reasoningEffort !== "xhigh") return false;
  if (c.tools !== true || c.parallelToolCalls !== true) return false;
  if (Number(c.unboundedSteps) < Number.MAX_SAFE_INTEGER) return false;
  if (c.paidFallbackModel !== null) return false;
  if (Number(c.minOutputTokens) < 16384 || Number(c.minMaxTokens) < 16384) return false;
  if (c.compactionPruning?.compaction !== true || c.compactionPruning?.pruning !== true) return false;
  if (c.exactSession !== true || c.singleWriter !== true || c.authorizedFailover !== true) return false;
  if (c.quotaWaitWhenNoEligibleRoute !== true || c.noIdentitySpoofing !== true || c.noLimitCircumvention !== true) return false;
  const p = manifest.modelPolicy;
  return Boolean(p && Array.isArray(p.forbiddenPatterns) && Array.isArray(p.deadModelIds));
}

function readAndVerify(root = CORE_ROOT) {
  const manifestBytes = (() => { try { return readFileSync(path.join(root, "manifest.json")); } catch { return null; } })();
  const schemaBytes = (() => { try { return readFileSync(path.join(root, "schema.json")); } catch { return null; } })();
  const vectorsBytes = (() => { try { return readFileSync(path.join(root, "golden-vectors.json")); } catch { return null; } })();
  const lock = readJson(root, "core.lock.json");
  if (!manifestBytes || !schemaBytes || !vectorsBytes || !lock) return { ok: false };
  const files = {
    "manifest.json": sha256(manifestBytes),
    "schema.json": sha256(schemaBytes),
    "golden-vectors.json": sha256(vectorsBytes),
  };
  const manifest = readJson(root, "manifest.json");
  const schema = readJson(root, "schema.json");
  const vectors = readJson(root, "golden-vectors.json");
  const aggregate = aggregateDigest({ manifest: manifestBytes, schema: schemaBytes, vectors: vectorsBytes });
  const lockFiles = lock.files && typeof lock.files === "object" ? lock.files : {};
  const ok = aggregate === CORE_LOCK_DIGEST
    && lock.name === FALLBACK_MANIFEST.name
    && lock.coreVersion === CORE_VERSION
    && lock.algorithm === "sha256"
    && lock.digest === CORE_LOCK_DIGEST
    && CORE_FILE_DIGESTS["manifest.json"] === files["manifest.json"]
    && CORE_FILE_DIGESTS["schema.json"] === files["schema.json"]
    && CORE_FILE_DIGESTS["golden-vectors.json"] === files["golden-vectors.json"]
    && lockFiles["manifest.json"] === files["manifest.json"]
    && lockFiles["schema.json"] === files["schema.json"]
    && lockFiles["golden-vectors.json"] === files["golden-vectors.json"]
    && manifestShapeValid(manifest)
    && schema && vectors && vectors.version === CORE_VERSION;
  return { ok, manifest, schema, vectors, files, aggregate };
}

const ACTIVE = readAndVerify();
export const CORE_INTEGRITY_OK = ACTIVE.ok === true;
export const CORE_MANIFEST = Object.freeze(CORE_INTEGRITY_OK ? ACTIVE.manifest : FALLBACK_MANIFEST);
export const CORE_SCHEMA = Object.freeze(CORE_INTEGRITY_OK ? ACTIVE.schema : FALLBACK_SCHEMA);
export const GOLDEN_VECTORS = Object.freeze(CORE_INTEGRITY_OK ? ACTIVE.vectors : FALLBACK_GOLDEN_VECTORS);
export const CORE_CAPABILITIES = Object.freeze(CORE_MANIFEST.capabilities || FALLBACK_CAPABILITIES);
export const OUTPUT_TOKEN_FLOOR = Number(CORE_CAPABILITIES.minOutputTokens || 16384);
export const UNBOUNDED_STEPS = Number(CORE_CAPABILITIES.unboundedSteps || Number.MAX_SAFE_INTEGER);
export const EXACT_SESSION_INVARIANT = CORE_CAPABILITIES.exactSession === true;
export const SINGLE_WRITER_INVARIANT = CORE_CAPABILITIES.singleWriter === true;

export function verifyCoreIntegrity(root = CORE_ROOT) {
  return readAndVerify(root).ok === true;
}

const capabilities = CORE_MANIFEST.capabilities || FALLBACK_CAPABILITIES;
const modelPolicy = CORE_MANIFEST.modelPolicy || FALLBACK_MODEL_POLICY;
const MODEL_ID_RE = new RegExp(modelPolicy.idPattern || FALLBACK_MODEL_POLICY.idPattern, "i");
const FORBIDDEN_RE = (modelPolicy.forbiddenPatterns || FALLBACK_MODEL_POLICY.forbiddenPatterns)
  .map((v) => new RegExp(String(v), "i"));
const DEAD_IDS = new Set(modelPolicy.deadModelIds || FALLBACK_MODEL_POLICY.deadModelIds);

export const PRIMARY_MODEL = capabilities.primaryModel;
export const PAID_FALLBACK_MODEL = capabilities.paidFallbackModel;
export const DEFAULT_MODEL_CHAIN = Object.freeze([...capabilities.defaultModelChain]);
export const DYNAMIC_MODEL_POOL = Object.freeze([...(capabilities.dynamicModelPool || capabilities.defaultModelChain)]);
export const DEFAULT_JUDGE_MODEL = PRIMARY_MODEL;
export const MODEL_CAPABILITY_SCORES = Object.freeze({
  "opencode/muse-spark-1.3-contributor-free": 100,
  "opencode/mimo-v2.6-flash-free": 98,
  "opencode/jev-1.13-free": 96,
  "opencode/nemotron-3-ultra-free": 95,
  "opencode/muse-spark-1.2-contributor-free": 90,
  "opencode/nemotron-3.5-lightning-free": 85,
  "opencode/mimo-v2.5-free": 75,
  "opencode/hy3-free": 70,
  "opencode/ling-3.0-flash-fin-free": 65,
  "opencode/big-pickle": 60,
});

export function isFreeModel(id) {
  const value = String(id || "").trim();
  return /(?:-free|contributor-free)$/i.test(value);
}

export function isAllowedModel(id, options = {}) {
  if (typeof id !== "string") return false;
  const value = id.trim();
  if (!value || FORBIDDEN_RE.some((pattern) => pattern.test(value))) return false;
  if (!MODEL_ID_RE.test(value) || DEAD_IDS.has(value)) return false;
  if (isFreeModel(value) || options.free === true) return true;
  return options && options.allowPaid === true && options.authorizedPaidOptIn === true;
}

export function sanitizeModelChain(list, options = {}) {
  const arr = Array.isArray(list) ? list : String(list || "").split(",");
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const value = String(raw || "").trim();
    if (!isAllowedModel(value, options) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function isContributorTier(modelId) {
  return new RegExp(modelPolicy.contributorTierPattern || "contributor", "i").test(String(modelId || ""));
}

export function resolveJudgeModel(env = process.env) {
  const raw = String(env.FLEET_JUDGE_MODEL || "").trim();
  return isAllowedModel(raw) ? raw : DEFAULT_JUDGE_MODEL;
}

export function getModelCapabilityScore(modelId) {
  if (!isAllowedModel(modelId)) return -1;
  const id = String(modelId).trim();
  if (MODEL_CAPABILITY_SCORES[id] !== undefined) return MODEL_CAPABILITY_SCORES[id];
  if (/ultra|1t|large/i.test(id)) return 88;
  if (/lightning|pro|spark/i.test(id)) return 80;
  if (/flash|mini|tiny/i.test(id)) return 60;
  return 50;
}

export function evaluateCapability(name, value) {
  const key = String(name || "");
  if (key === "primaryModel") return value === true || value === capabilities.primaryModel;
  if (key === "xhighVariant") return String(value || "") === String(capabilities.variant);
  if (key === "outputFloor") return Number(value) >= Number(capabilities.minOutputTokens || 8192);
  if (key === "unboundedSteps") return Number(value) >= Number(capabilities.unboundedSteps || Number.MAX_SAFE_INTEGER);
  if (key === "compaction") return value === true && capabilities.compactionPruning?.compaction === true;
  if (key === "pruning") return value === true && capabilities.compactionPruning?.pruning === true;
  if (!(key in capabilities)) return false;
  return value === capabilities[key];
}

export function applyRequestCapabilities(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  let changed = false;
  const floor = Math.max(1, Number(capabilities.minOutputTokens || 8192));
  const responseShape = Array.isArray(payload.input);
  const chatShape = !responseShape && Array.isArray(payload.messages);
  const numericFloor = (value) => Number.isFinite(Number(value))
    ? Math.max(floor, Math.trunc(Number(value)))
    : floor;
  if (responseShape) {
    const next = numericFloor(payload.max_output_tokens);
    if (payload.max_output_tokens !== next) {
      payload.max_output_tokens = next;
      changed = true;
    }
  } else if (chatShape) {
    const field = Object.hasOwn(payload, "max_completion_tokens") ? "max_completion_tokens" : "max_tokens";
    const inherited = payload[field] ?? payload.max_output_tokens;
    const next = numericFloor(inherited);
    if (payload[field] !== next) {
      payload[field] = next;
      changed = true;
    }
    // Console Go validates Chat Completions bodies strictly; the Responses-only
    // token field is an invalid extra input on this shape.
    if (Object.hasOwn(payload, "max_output_tokens")) {
      delete payload.max_output_tokens;
      changed = true;
    }
  } else {
    const next = numericFloor(payload.max_output_tokens);
    if (payload.max_output_tokens !== next) {
      payload.max_output_tokens = next;
      changed = true;
    }
    if (payload.max_tokens !== undefined) {
      const nextMax = numericFloor(payload.max_tokens);
      if (payload.max_tokens !== nextMax) {
        payload.max_tokens = nextMax;
        changed = true;
      }
    }
  }
  const expectedEffort = capabilities.reasoningEffort || "xhigh";
  // Add the Responses reasoning object, or normalize one already supplied by
  // a chat adapter. Do not inject a Responses-only field into strict chat APIs.
  if (responseShape || Object.hasOwn(payload, "reasoning")) {
    if (!payload.reasoning || typeof payload.reasoning !== "object" || Array.isArray(payload.reasoning)) {
      payload.reasoning = { effort: expectedEffort };
      changed = true;
    } else if (payload.reasoning.effort !== expectedEffort) {
      payload.reasoning.effort = expectedEffort;
      changed = true;
    }
  }
  if (Array.isArray(payload.tools) && payload.tools.length > 0 && payload.parallel_tool_calls !== true) {
    payload.parallel_tool_calls = true;
    changed = true;
  }
  return changed;
}

const DEFAULT_RETRY_AFTER_MS = Number(CORE_MANIFEST.retryPolicy?.defaultRetryAfterMs || 180000);
const MAX_ERROR_BODY_BYTES = Number(CORE_MANIFEST.retryPolicy?.maxErrorBodyBytes || 16384);

function bodyText(body) {
  if (body == null) return "";
  return Buffer.from(body).subarray(0, MAX_ERROR_BODY_BYTES).toString("utf8");
}

export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + Math.ceil(seconds * 1000);
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) && timestamp >= now ? timestamp : null;
}

function retryAtFrom(headers = {}, now = Date.now()) {
  const retryAfterMs = Number(headers["retry-after-ms"]);
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return now + Math.ceil(retryAfterMs);
  return parseRetryAfter(headers["retry-after"], now) ?? now + DEFAULT_RETRY_AFTER_MS;
}

export function classifyProviderResponse(statusCode, headers = {}, body = Buffer.alloc(0), now = Date.now()) {
  const text = bodyText(body);
  const quotaError = /FreeUsageLimitError|free\s*usage|usage\s*limit|free[-_ ]?tier/i.test(text);
  if (statusCode === 429) {
    const retryAt = retryAtFrom(headers, now);
    return {
      kind: quotaError ? "quota_limited" : "rate_limited",
      retryAt,
      retryAfterSec: Math.max(0, Math.ceil((retryAt - now) / 1000)),
      routeFailover: true,
    };
  }
  if (quotaError) {
    const retryAt = retryAtFrom(headers, now);
    return {
      kind: "quota_limited",
      retryAt,
      retryAfterSec: Math.max(0, Math.ceil((retryAt - now) / 1000)),
      routeFailover: true,
    };
  }
  if (statusCode === 401 || statusCode === 403) {
    const isFreeTierClient = /free tier can only be used from within|freetiererror/i.test(text);
    const routeFailover = statusCode === 403 && !isFreeTierClient;
    return {
      kind: "access_rejected",
      retryAt: null,
      retryAfterSec: null,
      routeFailover,
      reason: isFreeTierClient
        ? "free_tier_client_required"
        : (/country|region|geographic|location/i.test(text) ? "country_restricted" : "route_forbidden"),
    };
  }
  if (statusCode === 400 && /encrypted_content/i.test(text)) {
    return { kind: "encrypted_content_rejected", retryAt: null, retryAfterSec: null, routeFailover: false, stripEncryptedAndRetry: true };
  }
  if (statusCode === 400 && /invalid_request_error/i.test(text) && /invalid parameters|invalid request body|request contains invalid|arguments must be valid json/i.test(text)) {
    return { kind: "request_shape_invalid", retryAt: null, retryAfterSec: null, routeFailover: false, sanitizeAndRetry: true };
  }
  return { kind: "available", retryAt: null, retryAfterSec: null };
}

export function shouldTryProxyAfterResponse(classification = {}) {
  return classification.kind === "transport_error" || Boolean(classification.routeFailover);
}

export function classifyQuotaAvailability(input = [], now = Date.now()) {
  const options = Array.isArray(input) ? { routes: input, now } : (input || {});
  const routes = Array.isArray(options.routes) ? options.routes : [];
  const eligible = routes.filter((route) => {
    if (typeof route === "string") return isAllowedModel(route);
    if (!route || typeof route !== "object") return false;
    if (route.authorized === false || route.providerAuthorized === false) return false;
    if (route.eligible === false || route.quotaLimited === true || route.circuitOpen === true) return false;
    return isAllowedModel(route.model || route.id || route.route);
  });
  if (eligible.length > 0) {
    return {
      kind: "route_failover",
      wait: false,
      surface: false,
      reason: null,
      eligibleRoutes: eligible.map((route) => typeof route === "string" ? route : String(route.model || route.id || route.route)),
      retryAt: null,
      retryAfterSec: 0,
    };
  }
  const retryAt = Number.isFinite(Number(options.retryAt)) ? Number(options.retryAt) : null;
  return {
    kind: "quota_wait",
    wait: true,
    surface: true,
    reason: "no_provider_authorized_eligible_route",
    eligibleRoutes: [],
    retryAt,
    retryAfterSec: retryAt && retryAt > Number(options.now ?? now) ? Math.ceil((retryAt - Number(options.now ?? now)) / 1000) : null,
  };
}

export function extractModelId(body) {
  try {
    const model = String(JSON.parse(Buffer.from(body).toString("utf8")).model || "");
    return /^[A-Za-z0-9._:/-]{1,160}$/.test(model) ? model : "unknown";
  } catch {
    return "unknown";
  }
}

export function providerHealth(retryAt, now = Date.now()) {
  const rateLimited = Number(retryAt) > now;
  return {
    status: rateLimited ? "degraded" : "healthy",
    rateLimited,
    retryAt: rateLimited ? new Date(retryAt).toISOString() : null,
    cooldownRemainingSec: rateLimited ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0,
  };
}

export const CIRCUIT_OPEN_MS = Number(CORE_MANIFEST.circuitPolicy?.openMs || 30 * 60 * 1000);
