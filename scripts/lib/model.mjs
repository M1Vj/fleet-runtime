import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { recordTelemetryEvent, isTelemetryValidationError } from "./telemetry.mjs";
import { mergeProviderHealthSnapshots, persistProviderHealthState, readProviderHealthState } from "./provider-health-state.mjs";
import { gatewayCircuitOpen, markGatewayDown, markGatewayUp } from "./gateway-health.mjs";
import { classifyProviderAuthFailure, providerAuthStatus, resolveProviderAuth } from "./provider-auth.mjs";
import {
  createAntigravityAdapter,
  createFreeProviderAdapter,
  loadProviderRegistry,
  normalizeProviderHealthStatus,
  normalizeProviderAttachments,
  parseProviderModelReference,
  providerModelReference,
  selectProviderRoute,
} from "./provider-registry.mjs";

function telemetryStateFile(env = process.env) {
  const root = String(env?.FLEET_STATE_ROOT || "");
  if (!root || !path.isAbsolute(root) || path.resolve(root) !== root || root.endsWith(path.sep)) return "";
  return path.join(root, "state", "telemetry.jsonl");
}

function telemetryCorrelation(env, route = {}, invocationId = "") {
  const runId = telemetryRunId(env);
  const target = `${route.provider || "provider"}|${route.model || "model"}|${route.repo || ""}|${route.pr || 0}|${route.headSha || ""}`;
  return `corr-${createHash("sha256").update(`${runId}|${invocationId}|${target}`).digest("hex").slice(0, 32)}`;
}

function telemetryRunId(env) {
  return String(env?.FLEET_RUN_ID || env?.GITHUB_RUN_ID || "local-model").replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 100) || "local-model";
}

function telemetryDurationBucket(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 1000) return "lt1s";
  if (ms < 5000) return "1to5s";
  if (ms < 15000) return "5to15s";
  if (ms < 30000) return "15to30s";
  return "gt30s";
}

function telemetryLane(env) {
  const value = String(env?.FLEET_LANE || "unknown").trim().toLowerCase();
  return new Set(["merge", "revise", "research", "deep", "improve", "patrol", "watchdog", "promotion", "sentinel", "selftest", "kb", "retro", "thesis", "terminal", "unknown"]).has(value) ? value : "unknown";
}

function telemetryAccountScope(selected, isZen) {
  if (selected?.quotaGroup) return "project";
  const scope = String(selected?.providerObject?.auth?.quotaScope || "").toLowerCase();
  if (scope === "account" || scope === "account-wide" || isZen) return "account";
  return "provider";
}

function telemetryErrorCode(value) {
  const state = String(value || "").toLowerCase();
  if (state.includes("rate")) return "rate_limited";
  if (state.includes("quota") || state.includes("exhaust")) return "quota_exhausted";
  if (state.includes("auth") || state.includes("reject") || state.includes("credential")) return "auth_rejected";
  if (state.includes("timeout")) return "timeout";
  if (state.includes("network") || state.includes("spawn") || state.includes("unavailable")) return "network";
  return state ? "unknown" : "none";
}

function emitModelTelemetry(env, input) {
  const file = telemetryStateFile(env);
  if (!file) return null;
  try {
    return recordTelemetryEvent(file, input);
  } catch (error) {
    if (isTelemetryValidationError(error)) throw error;
    return null;
  }
}

export const DISPOSABLE_MODEL_POLICY = Object.freeze({
  permission: {
    "*": "deny",
    read: "deny",
    list: "deny",
    glob: "deny",
    grep: "deny",
    bash: "deny",
    edit: "deny",
    external_directory: "deny",
    webfetch: "deny",
    websearch: "deny",
    task: "deny",
    skill: "deny",
    lsp: "deny",
    question: "deny",
    todowrite: "deny",
  },
});

// The improve loop may inspect a freshly cloned, explicitly public target. It
// still cannot mutate, execute, or reach outside that disposable workspace.
export const PUBLIC_READ_MODEL_POLICY = Object.freeze({
  profile: "public-read",
  permission: {
    "*": "deny",
    read: "allow",
    list: "allow",
    glob: "allow",
    grep: "allow",
    // Public source retrieval is performed by the SSRF-safe fetch boundary;
    // the model must not open arbitrary URLs from hostile prompt content.
    webfetch: "deny",
    bash: "deny",
    edit: "deny",
    external_directory: "deny",
    websearch: "deny",
    task: "deny",
    skill: "deny",
    lsp: "deny",
    question: "deny",
    todowrite: "deny",
  },
});

function policyFor(profile = "deny-all", publicTarget) {
  if (profile === "deny-all") return DISPOSABLE_MODEL_POLICY;
  if (profile !== "public-read") throw new Error("MODEL_POLICY_PROFILE_INVALID");
  if (!publicTarget || publicTarget.private !== false || publicTarget.visibility !== "public") {
    throw new Error("MODEL_PUBLIC_TARGET_REQUIRED");
  }
  return PUBLIC_READ_MODEL_POLICY;
}

function canonicalPath(value) {
  try { return realpathSync(path.resolve(String(value))); } catch { return path.resolve(String(value)); }
}

function isWithin(child, parent) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(child));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

const MODEL_ATTACHMENT_MAX_COUNT = 4;
const MODEL_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
const MODEL_ATTACHMENT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MODEL_IMAGE_MIME_BY_EXTENSION = Object.freeze({
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});

function modelAttachmentMimeType(filePath) {
  return MODEL_IMAGE_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/**
 * Copy external attachments into the disposable model workspace and prepare
 * bounded base64 payloads for direct public providers. Repository/state files
 * are rejected rather than silently sent to a public endpoint.
 */
function prepareDirectAttachments({ files = [], workspace, repoRoot, stateRoot } = {}) {
  if (!Array.isArray(files)) throw new Error("MODEL_ATTACHMENTS_INVALID");
  if (files.length > MODEL_ATTACHMENT_MAX_COUNT) throw new Error("MODEL_ATTACHMENT_COUNT_EXCEEDED");
  if (files.length === 0) return [];
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) throw new Error("MODEL_WORKSPACE_NOT_ISOLATED");
  const attachmentDir = path.join(workspace, "attachments");
  const prepared = [];
  let totalBytes = 0;
  let index = 0;
  for (const value of files) {
    if (typeof value !== "string" || !value.trim()) throw new Error("MODEL_ATTACHMENT_INVALID");
    const source = path.resolve(value);
    let sourceStat;
    try { sourceStat = lstatSync(source); } catch { throw new Error("MODEL_ATTACHMENT_UNAVAILABLE"); }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("MODEL_ATTACHMENT_INVALID");
    if (isWithin(source, repoRoot || process.cwd()) || (stateRoot && isWithin(source, stateRoot))) {
      throw new Error("MODEL_ATTACHMENT_PRIVATE_BOUNDARY");
    }
    if (sourceStat.size > MODEL_ATTACHMENT_MAX_BYTES) throw new Error("MODEL_ATTACHMENT_TOO_LARGE");
    let staged = source;
    const relative = path.relative(workspace, source);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });
      staged = path.join(attachmentDir, `${index += 1}-${path.basename(source).replace(/[^A-Za-z0-9._-]/g, "-")}`);
      copyFileSync(source, staged);
      chmodSync(staged, 0o600);
    }
    let data;
    try { data = readFileSync(staged); } catch { throw new Error("MODEL_ATTACHMENT_UNAVAILABLE"); }
    if (data.length === 0) throw new Error("MODEL_ATTACHMENT_INVALID");
    if (data.length > MODEL_ATTACHMENT_MAX_BYTES) throw new Error("MODEL_ATTACHMENT_TOO_LARGE");
    totalBytes += data.length;
    if (totalBytes > MODEL_ATTACHMENT_MAX_TOTAL_BYTES) throw new Error("MODEL_ATTACHMENT_TOTAL_TOO_LARGE");
    prepared.push({ mimeType: modelAttachmentMimeType(staged), data: data.toString("base64") });
  }
  // Re-run the provider-independent canonical validation here so direct route
  // callers cannot accidentally bypass count, MIME, or base64 checks.
  return normalizeProviderAttachments(prepared).map(({ mimeType, data }) => ({ mimeType, data }));
}

/** Create an explicit, disposable OpenCode cwd that cannot contain private state. */
export function createDisposableModelWorkspace({
  repoRoot = process.cwd(),
  stateRoot = process.env.FLEET_STATE_ROOT || "",
  baseDir = process.env.FLEET_MODEL_TMPDIR || os.tmpdir(),
  prefix = "fleet-model-",
  profile = "deny-all",
  publicTarget,
} = {}) {
  const resolvedRepo = path.resolve(String(repoRoot || process.cwd()));
  const resolvedState = stateRoot ? path.resolve(String(stateRoot)) : "";
  const resolvedBase = path.resolve(String(baseDir || os.tmpdir()));
  const policy = policyFor(profile, publicTarget);
  const workspace = mkdtempSync(path.join(resolvedBase, prefix));
  try {
    if (isWithin(workspace, resolvedRepo) || (resolvedState && isWithin(workspace, resolvedState))) {
      throw new Error("MODEL_WORKSPACE_NOT_ISOLATED");
    }
    chmodSync(workspace, 0o700);
    const policyPath = path.join(workspace, "opencode.json");
    const policyDocument = {
      profile,
      permission: policy.permission,
      ...(profile === "public-read" ? { publicTarget: { private: false, visibility: "public" } } : {}),
    };
    writeFileSync(policyPath, `${JSON.stringify(policyDocument)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(policyPath, 0o600);
    return workspace;
  } catch (error) {
    rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

export function assertDisposableModelWorkspace(workspace, { repoRoot = process.cwd(), stateRoot = process.env.FLEET_STATE_ROOT || "", profile = "deny-all", publicTarget } = {}) {
  const candidate = typeof workspace === "string" && path.isAbsolute(workspace) ? path.resolve(workspace) : "";
  if (!candidate || !existsSync(candidate) || isWithin(candidate, repoRoot || process.cwd())
    || (stateRoot && isWithin(candidate, stateRoot))) {
    throw new Error("MODEL_WORKSPACE_NOT_ISOLATED");
  }
  const candidateStat = lstatSync(candidate);
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) throw new Error("MODEL_WORKSPACE_NOT_ISOLATED");
  const policyPath = path.join(candidate, "opencode.json");
  if (!existsSync(policyPath)) throw new Error("MODEL_POLICY_REQUIRED");
  try {
    const policyStat = lstatSync(policyPath);
    if (!policyStat.isFile() || policyStat.isSymbolicLink()) throw new Error("MODEL_POLICY_INVALID");
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    const expected = policyFor(profile, publicTarget);
    if (policy.profile !== profile || !policy.permission) throw new Error("MODEL_POLICY_PROFILE_MISMATCH");
    for (const [key, value] of Object.entries(expected.permission)) {
      if (policy.permission[key] !== value) throw new Error("MODEL_POLICY_NOT_DENY_ALL");
    }
    if (profile === "public-read" && (policy.publicTarget?.private !== false || policy.publicTarget?.visibility !== "public")) {
      throw new Error("MODEL_PUBLIC_TARGET_REQUIRED");
    }
  } catch (error) {
    if (/MODEL_POLICY_|MODEL_PUBLIC_TARGET_/.test(String(error.message))) throw error;
    throw new Error("MODEL_POLICY_INVALID");
  }
  return candidate;
}

export function disposeModelWorkspace(workspace) {
  if (typeof workspace === "string" && path.isAbsolute(workspace)) rmSync(workspace, { recursive: true, force: true });
}

function deepFind(obj, key, out = []) {
  if (obj === null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const item of obj) deepFind(item, key, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === key && typeof v === "string" && v.length > 0) out.push(v);
    deepFind(v, key, out);
  }
  return out;
}

function collectText(obj, out = []) {
  if (obj === null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const item of obj) collectText(item, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if ((k === "text" || k === "delta") && typeof v === "string") out.push(v);
    else collectText(v, out);
  }
  return out;
}

const DEFAULT_MODEL_BUCKET = "other";

function canonicalModelReference(reference, registry) {
  const parsed = parseProviderModelReference(reference, registry);
  if (!parsed || !parsed.model || !parsed.provider?.models?.[parsed.model]) {
    throw new Error("MODEL_REFERENCE_UNVERIFIED");
  }
  const canonical = providerModelReference(parsed.provider, parsed.model);
  const registered = Object.values(registry.buckets || {}).some((refs) => Array.isArray(refs)
    && refs.some((ref) => providerModelReference(ref.provider, ref.model) === canonical));
  if (!registered) throw new Error("MODEL_REFERENCE_UNVERIFIED");
  return canonical;
}

function bucketEntryForReference(reference, registry) {
  const canonical = canonicalModelReference(reference, registry);
  for (const [bucket, refs] of Object.entries(registry.buckets || {})) {
    const ref = Array.isArray(refs)
      ? refs.find((item) => providerModelReference(item.provider, item.model) === canonical)
      : null;
    if (ref) {
      const provider = registry.providers.find((item) => item.id === ref.provider);
      return { bucket, ref, provider, reference: canonical };
    }
  }
  return null;
}

function uniqueReferences(references) {
  return [...new Set(references)];
}

/** Resolve only registry-backed provider/model references in priority order. */
export function resolveModelChain(env = process.env, { dataClass = "private", publicTarget } = {}) {
  const registry = loadProviderRegistry();
  if (dataClass === "public" && (publicTarget?.private !== false || publicTarget?.visibility !== "public")) {
    throw new Error("MODEL_PUBLIC_TARGET_REQUIRED");
  }
  const publicRequest = dataClass === "public"
    && publicTarget?.private === false
    && publicTarget?.visibility === "public";
  const publicFallbacks = () => uniqueReferences(
    (registry.buckets?.public || [])
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((ref) => providerModelReference(ref.provider, ref.model)),
  );
  const raw = String(env.FLEET_MODEL_CHAIN || "").trim();
  if (raw) {
    const chain = raw.split(",").map((m) => m.trim()).filter(Boolean);
    if (chain.length === 0) throw new Error("MODEL_CHAIN_EMPTY");
    const preferred = chain.map((reference) => canonicalModelReference(reference, registry));
    // Repository variables may narrow private lanes, but they cannot reorder a
    // verified-public lane around its governed free-first policy. Call sites
    // that intentionally require one exact model use modelOverride instead.
    return publicRequest ? publicFallbacks() : uniqueReferences(preferred);
  }
  const requestedGemini = String(env.FLEET_GEMINI_MODEL || "").trim();
  if (requestedGemini) {
    const refs = Array.isArray(registry.buckets?.gemini)
      ? registry.buckets.gemini.filter((item) => item.model === requestedGemini)
      : [];
    const references = uniqueReferences(refs.map((ref) => providerModelReference(ref.provider, ref.model)));
    if (references.length !== 1) throw new Error("MODEL_GEMINI_MODEL_UNVERIFIED");
    return uniqueReferences(publicRequest ? [...references, ...publicFallbacks()] : references);
  }
  const bucket = publicRequest
    ? "public"
    : (String(env.FLEET_MODEL_BUCKET || DEFAULT_MODEL_BUCKET).trim() || DEFAULT_MODEL_BUCKET);
  const refs = registry.buckets?.[bucket];
  if (!Array.isArray(refs) || refs.length === 0) throw new Error("MODEL_BUCKET_UNVERIFIED");
  return uniqueReferences(refs.slice().sort((a, b) => a.priority - b.priority).map((ref) => providerModelReference(ref.provider, ref.model)));
}

export function runOnce({ prompt, sessionId, variant, timeoutMs, env, files = [], model = "opencode/claude-opus-4-6", workspace, repoRoot = process.cwd(), stateRoot = env.FLEET_STATE_ROOT || "", spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const auth = resolveProviderAuth(env);
    const missing = !auth.ok;
    const args = ["run", "--format", "json", "-m", model];
    if (env.FLEET_OPENCODE_DEBUG === "1") args.push("--print-logs", "--log-level", "DEBUG");
    if (!missing && variant) args.push("--variant", variant);
    if (!missing && sessionId) args.push("-s", sessionId);
    args.push(prompt);
    const workspaceRoot = workspace || env.FLEET_WORKSPACE_ROOT || process.cwd();
    const attachmentDir = path.join(workspaceRoot, "attachments");
    let attachmentIndex = 0;
    for (const f of files || []) {
      let attachPath = f;
      try {
        const resolved = path.resolve(f);
        if (!existsSync(resolved)) continue;
        const stat = lstatSync(resolved);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) continue;
        const rel = path.relative(workspaceRoot, resolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          // Never copy attachments from the repository or private state checkout.
          if (isWithin(resolved, repoRoot) || (stateRoot && isWithin(resolved, stateRoot))) continue;
          mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });
          attachPath = path.join(attachmentDir, `${attachmentIndex += 1}-${path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, "-")}`);
          copyFileSync(resolved, attachPath);
          chmodSync(attachPath, 0o600);
        }
      } catch {}
      if (existsSync(attachPath)) args.push("--file", attachPath);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const childEnv = { ...env };
    for (const key of Object.keys(childEnv)) {
      if (/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(key) && key !== "OPENCODE_AUTH_CONTENT" && key !== "OPENCODE_API_KEY") delete childEnv[key];
    }
    delete childEnv.FLEET_GH_TOKEN;
    delete childEnv.GH_TOKEN;
    delete childEnv.GDRIVE_REFRESH_TOKEN;
    delete childEnv.GDRIVE_CLIENT_SECRET;
    // Legacy migration path only: owner-Mac OAuth snapshots are never the
    // production dependency; GitHub provisions OPENCODE_API_KEY instead.
    childEnv.OPENCODE_AUTH_CONTENT = auth.mode === "legacy-oauth-migration" ? env.FLEET_OPENCODE_AUTH || "" : "";
    childEnv.OPENCODE_DISABLE_AUTOUPDATE = "1";
    const child = spawnImpl("opencode", args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"], cwd: workspaceRoot });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ reply: "", sessionId: "", exitCode: -1, interrupted: false, stderrTail: String(err.message).slice(-400), spawnFailed: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let reply = "";
      let sid = "";
      try {
        const events = [];
        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try { events.push(JSON.parse(trimmed)); } catch { continue; }
        }
        reply = events.map((e) => collectText(e).join("")).filter(Boolean).join("\n").trim();
        const ids = events.map((e) => deepFind(e, "sessionID")).flat();
        sid = ids[ids.length - 1] || "";
      } catch {
        reply = "";
      }
      if (!reply) {
        const tail = stdout.split("\n").filter((l) => !l.trim().startsWith("{") && l.trim()).join("\n").trim();
        reply = tail.slice(-4000);
      }
      const rawTail = stdout.split("\n").filter(Boolean).slice(-8).join("\n").slice(-1200);
      resolve({
        reply,
        sessionId: sid,
        exitCode: code ?? -1,
        interrupted: timedOut,
        stderrTail: stderr.slice(-400),
        rawTail,
        spawnFailed: false,
        authMissing: missing,
      });
    });
  });
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function parseHealthSnapshot(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return structuredClone(value);
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function routeEntryForReference(reference, registry) {
  try {
    return bucketEntryForReference(reference, registry);
  } catch {
    return null;
  }
}

function isPublicTarget(dataClass, publicTarget) {
  return dataClass === "public" && publicTarget?.private === false && publicTarget?.visibility === "public";
}

function directRouteEligible(entry, dataClass, publicTarget) {
  return entry?.provider?.kind === "free-api" && isPublicTarget(dataClass, publicTarget);
}

function localRouteEligible(entry, env) {
  return entry?.provider?.localOnly === true
    && /^(?:1|true)$/i.test(String(env?.FLEET_ANTIGRAVITY_LOCAL || ""))
    && !/^(?:1|true)$/i.test(String(env?.GITHUB_ACTIONS || ""));
}

function routeHealthForSelection({ entry, health, now, circuitOpen }) {
  const snapshot = structuredClone(health || {});
  if (entry?.provider?.id === "opencode-zen" && !snapshot[entry.provider.id] && !circuitOpen) {
    // Existing OpenCode auth plus a closed gateway circuit is the Zen health
    // signal. Direct APIs require an explicit fresh snapshot instead.
    snapshot[entry.provider.id] = { status: "healthy", checkedAt: new Date(now).toISOString() };
  }
  return snapshot;
}

function materializeRouteEnv(route, env) {
  const childEnv = { ...env };
  if (route?.sourceEnv && route?.targetEnv && typeof env?.[route.sourceEnv] === "string") {
    childEnv[route.targetEnv] = env[route.sourceEnv];
  }
  if (route?.provider !== "opencode-zen") return childEnv;
  // OpenCode receives only its selected target key. Backup keys and unrelated
  // provider credentials are removed before the child process is spawned.
  for (const key of Object.keys(childEnv)) {
    if (/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(key)
      && key !== "OPENCODE_API_KEY"
      && key !== "OPENCODE_AUTH_CONTENT") delete childEnv[key];
  }
  delete childEnv.FLEET_OPENCODE_AUTH;
  if (route.sourceEnv && route.sourceEnv !== "OPENCODE_API_KEY") delete childEnv[route.sourceEnv];
  return childEnv;
}

function routeFailureState(error) {
  const code = String(error?.code || error?.message || "");
  if (/CREDENTIAL_(?:MISSING|EXPIRED|LOCAL_ONLY)/.test(code)) return code.includes("EXPIRED") ? "expired" : "missing";
  if (/_AUTH_REJECTED|_REJECTED/.test(code)) return "rejected";
  if (/_RATE_LIMITED/.test(code)) return "rate-limited";
  if (/_QUOTA_EXHAUSTED|_EXHAUSTED/.test(code)) return "quota-exhausted";
  if (/_TIMEOUT/.test(code)) return "timeout";
  return "";
}

export function recordRouteFailure(health, route, state, now) {
  if (!route?.provider || !state) return;
  const normalizedState = state === "exhausted" ? "quota-exhausted" : state;
  const current = health[route.provider] && typeof health[route.provider] === "object" ? health[route.provider] : {};
  const credentials = current.credentials && typeof current.credentials === "object" ? { ...current.credentials } : {};
  credentials[route.credential] = {
    ...(credentials[route.credential] || {}),
    status: normalizedState,
    checkedAt: new Date(now).toISOString(),
  };
  const quotaGroups = current.quotaGroups && typeof current.quotaGroups === "object" ? { ...current.quotaGroups } : {};
  if (["rate-limited", "quota-exhausted"].includes(normalizedState)
    && route.quotaGroupRotation === true
    && typeof route.quotaGroup === "string"
    && route.quotaGroup.length > 0) {
    quotaGroups[route.quotaGroup] = {
      ...(quotaGroups[route.quotaGroup] || {}),
      status: normalizedState,
      checkedAt: new Date(now).toISOString(),
    };
  }
  health[route.provider] = {
    ...current,
    checkedAt: new Date(now).toISOString(),
    // Keep a credential-group provider healthy when the selected project is
    // limited. Without an explicit, validated group map, the failure remains
    // provider-wide and prevents quota-evasion retries.
    ...(normalizedState === "rejected" || normalizedState === "missing" || normalizedState === "expired"
      ? { status: normalizeProviderHealthStatus(current.status, "healthy") }
      : ["rate-limited", "quota-exhausted"].includes(normalizedState)
        && route.quotaGroupRotation === true && typeof route.quotaGroup === "string"
        ? { status: normalizeProviderHealthStatus(current.status, "healthy") }
        : { status: normalizedState }),
    credentials,
    ...(Object.keys(quotaGroups).length > 0 ? { quotaGroups } : {}),
  };
}

function classifyModelRouteFailure(text) {
  const value = String(text || "");
  if (/\b429\b|rate[ -]?limit|too many requests/i.test(value)) return "rate-limited";
  if (/\b402\b|quota exceeded|credits? exhausted|payment required|usage limit/i.test(value)) return "quota-exhausted";
  if (/\b(?:401|403)\b|unauthorized|forbidden|invalid[_ -]?api[_ -]?key/i.test(value)) return "rejected";
  return "";
}

function directAttempt({ route, error, elapsedMs }) {
  const code = String(error?.code || error?.message || "FREE_PROVIDER_REQUEST_FAILED");
  return {
    round: 1,
    model: route.modelReference,
    provider: route.provider,
    adapter: route.providerObject?.id === "antigravity" ? "antigravity-cli" : "direct-api",
    auth: "yes",
    exit: -1,
    interrupted: code === "FREE_PROVIDER_TIMEOUT",
    gotReply: false,
    hadSession: false,
    elapsedMs,
    error: code.replace(/[^A-Z0-9_-]/g, "_").slice(0, 80),
  };
}

async function askDirectRoute({ route, prompt, timeoutMs, env, dataClass, publicTarget, effort, files, workspace, repoRoot, stateRoot, fetchImpl, allowLocal, spawnImpl }) {
  const started = Date.now();
  try {
    const adapter = route.providerObject?.id === "antigravity"
      ? createAntigravityAdapter({ provider: route.providerObject, env, allowLocal, spawnImpl })
      : createFreeProviderAdapter({ provider: route.providerObject, env, fetchImpl });
    const directFiles = prepareDirectAttachments({ files, workspace, repoRoot, stateRoot });
    const adapterOptions = {
      prompt,
      model: route.model,
      account: route.credential,
      timeoutMs,
      dataClass,
      publicTarget,
      effort,
      files: directFiles,
    };
    const result = await adapter.invoke(adapterOptions);
    return {
      reply: result.response,
      sessionId: "",
      modelMode: route.modelReference,
      attempts: [{ round: 1, model: route.modelReference, provider: route.provider, adapter: route.providerObject?.id === "antigravity" ? "antigravity-cli" : "direct-api", auth: "yes", exit: 0, interrupted: false, gotReply: true, hadSession: false, elapsedMs: Date.now() - started }],
      complete: true,
    };
  } catch (error) {
    return {
      reply: "",
      sessionId: "",
      modelMode: route.modelReference,
      attempts: [directAttempt({ route, error, elapsedMs: Date.now() - started })],
      complete: false,
      authState: routeFailureState(error),
    };
  }
}

async function askModelInternal({ prompt, sessionId, timeoutMs = 480000, env = process.env, preferVariantMax = true, maxRounds = 4, files = [], modelOverride, workspace, repoRoot = process.cwd(), stateRoot: privateStateRoot = env.FLEET_STATE_ROOT || "", spawnImpl, skipCircuitCheck = false, dataClass = "private", publicTarget, providerHealth, effort = "high", fetchImpl = globalThis.fetch, now = Date.now(), rotationSeed, invocationId = `call-${randomUUID()}` }) {
  const registry = loadProviderRegistry();
  if (dataClass === "public" && (publicTarget?.private !== false || publicTarget?.visibility !== "public")) {
    throw new Error("MODEL_PUBLIC_TARGET_REQUIRED");
  }
  const chain = modelOverride
    ? [canonicalModelReference(modelOverride, registry)]
    : resolveModelChain(env, { dataClass, publicTarget });
  const healthRoot = env.FLEET_STATE_ROOT || process.cwd();
  const circuitOpen = !skipCircuitCheck && !sessionId && gatewayCircuitOpen(healthRoot);
  const authStatus = providerAuthStatus(env, { circuitOpen });
  const explicitHealth = parseHealthSnapshot(providerHealth ?? env.FLEET_PROVIDER_HEALTH_JSON);
  const persistedHealth = privateStateRoot ? readProviderHealthState(privateStateRoot, { now }) : {};
  const runtimeHealth = mergeProviderHealthSnapshots(explicitHealth, persistedHealth, now);
  const effectiveRotationSeed = rotationSeed ?? env.FLEET_ACCOUNT_ROTATION_SEED ?? env.GITHUB_RUN_ID ?? "";
  const entries = chain.map((reference) => routeEntryForReference(reference, registry));
  const hasDirectEligible = entries.some((entry) => directRouteEligible(entry, dataClass, publicTarget));
  const allowLocal = entries.some((entry) => localRouteEligible(entry, env));
  const hasLocalEligible = entries.some((entry) => localRouteEligible(entry, env));
  if (!authStatus.ready && !hasDirectEligible && !hasLocalEligible) {
    return authStatus.stage === "credentials"
      ? { reply: "", sessionId: "", modelMode: "auth-missing", attempts: [{ round: 0, skipped: "model-auth-missing" }], complete: false, authMissing: true }
      : { reply: "", sessionId: "", modelMode: "circuit-open", attempts: [{ round: 0, skipped: "circuit-open" }], complete: false, circuitOpen: true };
  }
  const allAttempts = [];
  let lastSid = sessionId || "";
  let lastMode = "";
  let lastAuthState = "";
  let attemptedZen = false;
  let lastProvider = "";
  let lastCredential = "";
  const replayedReferences = new Set();
  for (let ci = 0; ci < chain.length; ci++) {
    const reference = chain[ci];
    const entry = routeEntryForReference(reference, registry);
    if (!entry?.provider) {
      allAttempts.push({ round: 0, model: reference, skipped: "model-reference-unverified" });
      lastMode = reference;
      continue;
    }
    const isZen = entry.provider.id === "opencode-zen";
    const routeHealth = routeHealthForSelection({ entry, health: runtimeHealth, now, circuitOpen });
    const route = selectProviderRoute({
      registry,
      bucket: entry.bucket,
      model: reference,
      env,
      health: routeHealth,
      now,
      freeOnly: !isZen,
      allowPaid: isZen,
      allowLocal,
      allowLiveCanary: !isZen,
      dataClass,
      publicTarget,
      rotationSeed: effectiveRotationSeed,
    });
    if (!route.ok) {
      allAttempts.push({ round: 0, model: reference, provider: entry.provider.id, skipped: route.reason || "route-unavailable", skippedRoutes: route.skipped || [] });
      lastMode = reference;
      continue;
    }
    const selected = { ...route, providerObject: entry.provider };
    const correlationId = telemetryCorrelation(env, selected, invocationId);
    emitModelTelemetry(env, {
      runId: telemetryRunId(env),
      correlationId,
      invocationId,
      lane: telemetryLane(env),
      event: "provider",
      phase: "selected",
      outcome: "started",
      provider: {
        name: selected.provider,
        model: selected.model,
        routeClass: selected.routeClass || (isZen ? "private-paid" : "public-free"),
        accountScope: telemetryAccountScope(selected, isZen),
        chainIndex: ci,
        cooldownBucket: "none",
      },
    });
    if (isZen) attemptedZen = true;
    const routeEnv = materializeRouteEnv(selected, env);
    const routeSession = isZen
      && lastProvider === selected.provider
      && lastCredential === selected.credential
      ? lastSid
      : "";
    const result = isZen
      ? await askOnModel({ model: selected.modelReference, isPrimary: ci === 0, prompt, sessionId: routeSession || undefined, timeoutMs, env: routeEnv, preferVariantMax, maxRounds, files, workspace, repoRoot, stateRoot: privateStateRoot, spawnImpl })
      : await askDirectRoute({ route: selected, prompt, timeoutMs, env, dataClass, publicTarget, effort, files, workspace, repoRoot, stateRoot: privateStateRoot, fetchImpl, allowLocal, spawnImpl });
    allAttempts.push(...(result.attempts || []));
    const lastAttempt = Array.isArray(result.attempts) && result.attempts.length > 0 ? result.attempts.at(-1) : {};
    emitModelTelemetry(env, {
      runId: telemetryRunId(env),
      correlationId,
      invocationId,
      lane: telemetryLane(env),
      event: "provider",
      phase: "attempt",
      outcome: result.complete ? "succeeded" : "failed",
      provider: {
        name: selected.provider,
        model: selected.model,
        routeClass: selected.routeClass || (isZen ? "private-paid" : "public-free"),
        accountScope: telemetryAccountScope(selected, isZen),
        attempt: Number(lastAttempt.round) || 1,
        chainIndex: ci,
        durationBucket: telemetryDurationBucket(lastAttempt.elapsedMs),
        errorCode: telemetryErrorCode(result.authState || lastAttempt.error),
        httpClass: "none",
        cooldownBucket: "none",
      },
    });
    if (isZen && result.sessionId) lastSid = result.sessionId;
    if (!isZen) lastSid = "";
    lastProvider = selected.provider;
    lastCredential = selected.credential;
    lastMode = result.modelMode || selected.modelReference;
    lastAuthState = result.authState || "";
    if (result.complete) {
      if (isZen) {
        try { markGatewayUp(healthRoot); } catch {}
      }
      return { reply: result.reply, sessionId: isZen ? lastSid : "", modelMode: lastMode, attempts: allAttempts, complete: true };
    }
    recordRouteFailure(runtimeHealth, selected, lastAuthState, now);
    if (privateStateRoot && ["rejected", "rate-limited", "quota-exhausted", "timeout", "unavailable"].includes(lastAuthState)) {
      try {
        persistProviderHealthState(privateStateRoot, runtimeHealth, { now });
      } catch (error) {
        // Another process owns the short atomic-write lock. Its write will be
        // reloaded by the next call; do not sacrifice this call's fallback.
        // Malformed/symlinked state and every other persistence error remain
        // fail-closed.
        if (error?.code !== "PROVIDER_HEALTH_STATE_BUSY") throw error;
      }
    }
    emitModelTelemetry(env, {
      runId: telemetryRunId(env),
      correlationId,
      invocationId,
      lane: telemetryLane(env),
      event: "provider",
      phase: "fallback",
      outcome: "started",
      provider: {
        name: selected.provider,
        model: selected.model,
        routeClass: selected.routeClass || (isZen ? "private-paid" : "public-free"),
        accountScope: telemetryAccountScope(selected, isZen),
        chainIndex: ci + 1,
        errorCode: telemetryErrorCode(lastAuthState),
        cooldownBucket: "none",
      },
    });
    const canRotateCredential = lastAuthState === "rejected"
      || ((lastAuthState === "rate-limited" || lastAuthState === "quota-exhausted") && selected.quotaGroupRotation === true);
    if (canRotateCredential && !replayedReferences.has(reference)) {
      // Re-run the same model reference once so selectProviderRoute can pick a
      // cold credential from the same provider. Rate/quota failures are replayed
      // only when the selected route proved a distinct credential-group map.
      replayedReferences.add(reference);
      chain.splice(ci + 1, 0, reference);
    }
    // Auth failures are eligible for a cold credential or another provider.
    // Account-group rate/quota failures may use the next declared project;
    // provider-wide limits continue to the next provider only.
  }
  if (attemptedZen) {
    try { markGatewayDown(healthRoot, allAttempts.map((x) => x.errTail || x.error || "").join(" ").slice(-200)); } catch {}
  }
  return {
    reply: "",
    sessionId: lastSid,
    modelMode: lastMode,
    attempts: allAttempts,
    complete: false,
    ...(lastAuthState ? { authState: lastAuthState } : {}),
  };
}

/** Every judge/revision call gets a fresh workspace and policy by default. */
export async function askModel(opts = {}) {
  const env = opts.env || process.env;
  const profile = opts.profile || "deny-all";
  const publicTarget = opts.publicTarget;
  const workspace = opts.workspace || createDisposableModelWorkspace({
    repoRoot: opts.repoRoot || process.cwd(),
    stateRoot: opts.stateRoot || env.FLEET_STATE_ROOT || "",
    profile,
    publicTarget,
  });
  const owned = !opts.workspace;
  assertDisposableModelWorkspace(workspace, {
    repoRoot: opts.repoRoot || process.cwd(),
    stateRoot: opts.stateRoot || env.FLEET_STATE_ROOT || "",
    profile,
    publicTarget,
  });
  try {
    return await askModelInternal({ ...opts, env, workspace, repoRoot: opts.repoRoot || process.cwd(), stateRoot: opts.stateRoot || env.FLEET_STATE_ROOT || "" });
  } finally {
    if (owned) disposeModelWorkspace(workspace);
  }
}

async function askOnModel({ model, isPrimary, prompt, sessionId, timeoutMs, env, preferVariantMax, maxRounds, files, workspace, repoRoot, stateRoot: privateStateRoot, spawnImpl }) {
  const healthRoot = env.FLEET_STATE_ROOT || process.cwd();
  let sid = sessionId || "";
  let mode = preferVariantMax && isPrimary ? "max" : "plain";
  let restarted = false;
  let promptNow = prompt;
  const attempts = [];
  let routeState = "";
  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1) {
      const backoff = Math.round(20000 + Math.random() * 15000);
      await sleep(backoff);
    }
    const r = await runOnce({ prompt: promptNow, sessionId: sid || undefined, variant: mode === "max" ? "max" : undefined, timeoutMs, env, files, model, workspace, repoRoot, stateRoot: privateStateRoot, spawnImpl });
    attempts.push({
      round,
      model,
      mode,
      auth: "yes",
      exit: r.exitCode,
      interrupted: r.interrupted,
      gotReply: Boolean(r.reply),
      hadSession: Boolean(r.sessionId),
      errTail: (r.stderrTail || "").slice(-160),
      rawTail: (r.rawTail || "").slice(-300),
    });
    if (r.sessionId) sid = r.sessionId;
    if (!r.interrupted && r.exitCode === 0 && r.reply) {
      try { markGatewayUp(healthRoot); } catch {}
      return { reply: r.reply, sessionId: sid, modelMode: `${model}${mode === "max" ? "@max" : ""}`, attempts, complete: true };
    }
    // Classify CLI stderr only: rawTail includes model reply text, so a PR diff
    // discussing "402"/"401" must never open the fleet-wide gateway circuit.
    const authState = classifyProviderAuthFailure(r.stderrTail || "");
    if (authState) {
      return { reply: "", sessionId: sid, modelMode: mode, attempts, complete: false, authState };
    }
    routeState = classifyModelRouteFailure(r.stderrTail || "") || routeState;
    if (mode === "max") {
      mode = "plain";
      continue;
    }
    if (!restarted) {
      restarted = true;
      sid = "";
      promptNow = prompt;
      continue;
    }
    promptNow = sid
      ? "You were interrupted mid-task. Continue from where you stopped and finish the job. Output ONLY the requested final answer now."
      : prompt;
  }
  return { reply: "", sessionId: sid, modelMode: mode, attempts, complete: false, ...(routeState ? { authState: routeState } : {}) };
}

export async function askModelResilient(opts) {
  const first = await askModel(opts);
  if (first.complete || first.authState || first.authMissing) return { ...first, ladders: 1 };
  const cooldownMs = opts.cooldownMs ?? 90000;
  emitModelTelemetry(opts.env || process.env, {
    runId: telemetryRunId(opts.env || process.env),
    correlationId: telemetryCorrelation(opts.env || process.env, { provider: "model-ladder", model: "fallback" }),
    lane: telemetryLane(opts.env || process.env),
    event: "provider",
    phase: "cooldown",
    outcome: "started",
    provider: {
      name: "model-ladder",
      model: "fallback",
      routeClass: "unknown",
      accountScope: "provider",
      cooldownBucket: cooldownMs < 60000 ? "lt1m" : cooldownMs <= 300000 ? "1to5m" : "gt5m",
      errorCode: telemetryErrorCode(first.authState || "unavailable"),
    },
  });
  await new Promise((r) => setTimeout(r, cooldownMs));
  const second = await askModel({ ...opts, maxRounds: Math.max(2, (opts.maxRounds || 4) - 1) });
  return { ...second, ladders: 2 };
}
