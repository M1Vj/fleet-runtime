import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_VALUE_RE = /(?:gh[pousr]_|github_pat_|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{20,}|xox[baprs]-|AIza[0-9A-Za-z_-]{20,})/;
const DEFAULT_HEALTH_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_AGY_TIMEOUT_MS = 120 * 1000;
const MAX_PROCESS_OUTPUT = 128 * 1024;
const MAX_PROVIDER_TIMEOUT_MS = 120 * 1000;

const DEFAULT_REGISTRY_PATH = new URL("../../config/providers.json", import.meta.url);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function isoTime(value = Date.now()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("MODEL_UPDATE_TIME_INVALID");
  return parsed.toISOString();
}

function dateMs(value) {
  if (typeof value !== "string" && !(value instanceof Date) && typeof value !== "number") return NaN;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

function hasCredentialValue(env, name) {
  return typeof env?.[name] === "string" && env[name].trim().length > 0;
}

function credentialValue(env, name) {
  return typeof env?.[name] === "string" ? env[name].trim() : "";
}

function modelIsKnown(provider, model) {
  return Boolean(provider && typeof provider.models === "object" && provider.models && provider.models[model]);
}

function modelMetadata(provider, model) {
  return modelIsKnown(provider, model) && provider.models[model] && typeof provider.models[model] === "object"
    ? provider.models[model]
    : null;
}

function validHttpsEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.trim()) return false;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return false;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return false;
    if (/^(10|127)\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[0-1])\.|^169\.254\.|^(?:fc|fd)[0-9a-f]{2}:|^fe80:/i.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Validate the committed provider policy before it can affect routing. */
export function validateProviderRegistry(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["registry must be an object"] };
  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof value.registryVersion !== "string" || !value.registryVersion.trim()) errors.push("registryVersion is required");
  if (!Array.isArray(value.providers) || value.providers.length === 0) errors.push("providers must be a non-empty array");
  const ids = new Set();
  for (const provider of Array.isArray(value.providers) ? value.providers : []) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      errors.push("provider must be an object");
      continue;
    }
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(String(provider.id || ""))) errors.push("provider id invalid");
    if (ids.has(provider.id)) errors.push(`duplicate provider id ${provider.id}`);
    ids.add(provider.id);
    for (const field of ["enabled", "free", "localOnly"]) {
      if (typeof provider[field] !== "boolean") errors.push(`${provider.id}.${field} must be boolean`);
    }
    if (!provider.production || typeof provider.production.enabled !== "boolean") errors.push(`${provider.id}.production.enabled must be boolean`);
    if (provider.production?.requiresEnv !== undefined && !ENV_RE.test(String(provider.production.requiresEnv))) errors.push(`${provider.id}.production.requiresEnv invalid`);
    if (provider.auth !== undefined && (!provider.auth || typeof provider.auth !== "object" || Array.isArray(provider.auth))) errors.push(`${provider.id}.auth must be an object`);
    if (provider.auth?.mode !== undefined && !["api-key", "oauth"].includes(provider.auth.mode)) errors.push(`${provider.id}.auth.mode invalid`);
    if (provider.auth?.sameProviderRotation !== undefined && !["auth-only", "healthy-round-robin"].includes(provider.auth.sameProviderRotation)) errors.push(`${provider.id}.auth.sameProviderRotation invalid`);
    if (provider.auth?.quotaScope !== undefined && !["account-wide", "credential-group"].includes(provider.auth.quotaScope)) errors.push(`${provider.id}.auth.quotaScope invalid`);
    if (provider.localOnly && provider.auth?.mode !== "oauth") errors.push(`${provider.id}.localOnly providers must use oauth auth metadata`);
    if (!Array.isArray(provider.credentials) || provider.credentials.length === 0) errors.push(`${provider.id}.credentials must be non-empty`);
    for (const credential of Array.isArray(provider.credentials) ? provider.credentials : []) {
      if (!credential || typeof credential !== "object") {
        errors.push(`${provider.id}.credential must be an object`);
        continue;
      }
      if (typeof credential.id !== "string" || !credential.id.trim()) errors.push(`${provider.id}.credential.id is required`);
      if (credential.localOnly === true) {
        for (const field of ["githubSecret", "env", "targetEnv", "expiresEnv"]) {
          if (credential[field] !== undefined) errors.push(`${provider.id}.local credential must not declare ${field}`);
        }
        if (credential.profile !== undefined && (typeof credential.profile !== "string" || !credential.profile.trim())) errors.push(`${provider.id}.credential.profile invalid`);
      } else {
        for (const field of ["githubSecret", "env", "targetEnv"]) {
          if (typeof credential[field] !== "string" || !credential[field].trim()) errors.push(`${provider.id}.credential.${field} is required`);
        }
        for (const field of ["githubSecret", "env", "targetEnv", "expiresEnv"]) {
          if (credential[field] !== undefined && !ENV_RE.test(String(credential[field]))) errors.push(`${provider.id}.credential.${field} invalid`);
        }
        if (credential.quotaGroupEnv !== undefined && !ENV_RE.test(String(credential.quotaGroupEnv))) errors.push(`${provider.id}.credential.quotaGroupEnv invalid`);
        if (provider.auth?.quotaScope === "credential-group" && (!credential.quotaGroupEnv || !ENV_RE.test(String(credential.quotaGroupEnv)))) {
          errors.push(`${provider.id}.credential.quotaGroupEnv is required for credential-group quota scope`);
        }
      }
      if (credential.localOnly !== undefined && typeof credential.localOnly !== "boolean") errors.push(`${provider.id}.credential.localOnly must be boolean`);
      if (credential.required !== undefined && typeof credential.required !== "boolean") errors.push(`${provider.id}.credential.required must be boolean`);
    }
    if (provider.endpoint !== null && provider.endpoint !== undefined && !validHttpsEndpoint(provider.endpoint)) errors.push(`${provider.id}.endpoint must be a public HTTPS URL`);
    if (!provider.verification || typeof provider.verification.status !== "string") errors.push(`${provider.id}.verification.status is required`);
    else if (!Array.isArray(provider.verification.docs)) errors.push(`${provider.id}.verification.docs must be an array`);
    if (!provider.models || typeof provider.models !== "object" || Array.isArray(provider.models)) errors.push(`${provider.id}.models must be an object`);
    for (const [model, metadata] of Object.entries(provider.models || {})) {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) errors.push(`${provider.id}/${model} metadata must be an object`);
      else if (typeof metadata.free !== "boolean") errors.push(`${provider.id}/${model}.free must be boolean`);
      if (!model.trim() || model.length > 200) errors.push(`${provider.id} model id invalid`);
    }
    if (provider.kind === "free-api" && provider.verification?.status === "verified" && !validHttpsEndpoint(provider.endpoint)) errors.push(`${provider.id}.verified free provider needs HTTPS endpoint`);
    if (provider.fallbackPolicy !== undefined) {
      for (const field of ["credentialFallbackOn", "noCredentialRotationOn"]) {
        if (!Array.isArray(provider.fallbackPolicy[field]) || provider.fallbackPolicy[field].some((item) => typeof item !== "string" || !item.trim())) errors.push(`${provider.id}.fallbackPolicy.${field} invalid`);
      }
    }
    if (provider.privacy !== undefined) {
      if (provider.privacy.requireZdr !== true) errors.push(`${provider.id}.privacy.requireZdr must be true`);
      if (provider.privacy.dataCollection !== "deny") errors.push(`${provider.id}.privacy.dataCollection must be deny`);
    }
    if (SECRET_VALUE_RE.test(JSON.stringify(provider))) errors.push(`${provider.id} contains secret-like content`);
  }
  if (!value.buckets || typeof value.buckets !== "object" || Array.isArray(value.buckets)) errors.push("buckets must be an object");
  for (const [bucket, refs] of Object.entries(value.buckets || {})) {
    if (!Array.isArray(refs)) {
      errors.push(`bucket ${bucket} must be an array`);
      continue;
    }
    for (const ref of refs) {
      if (!ref || typeof ref !== "object") {
        errors.push(`bucket ${bucket} entry must be an object`);
        continue;
      }
      const provider = value.providers?.find((item) => item.id === ref.provider);
      if (!provider) errors.push(`bucket ${bucket} references unknown provider ${ref.provider}`);
      if (typeof ref.model !== "string" || !ref.model.trim()) errors.push(`bucket ${bucket} model is required`);
      else if (provider && !modelIsKnown(provider, ref.model)) errors.push(`bucket ${bucket} model ${ref.model} is not registered for ${ref.provider}`);
      else if (provider && typeof provider.models[ref.model].free === "boolean" && provider.models[ref.model].free !== ref.free) errors.push(`bucket ${bucket} free flag disagrees with ${ref.provider}/${ref.model}`);
      if (typeof ref.credential !== "string" || !ref.credential.trim()) errors.push(`bucket ${bucket} credential is required`);
      else if (provider && !provider.credentials.some((item) => item.id === ref.credential)) errors.push(`bucket ${bucket} credential ${ref.credential} is not registered for ${ref.provider}`);
      if (!Number.isInteger(ref.priority) || ref.priority < 1) errors.push(`bucket ${bucket} priority invalid`);
      if (typeof ref.free !== "boolean") errors.push(`bucket ${bucket} free must be boolean`);
      for (const field of ["publicOnly", "localOnly"]) if (ref[field] !== undefined && typeof ref[field] !== "boolean") errors.push(`bucket ${bucket}.${field} must be boolean`);
      if (ref.fallbackOn !== undefined && (!Array.isArray(ref.fallbackOn) || ref.fallbackOn.some((item) => typeof item !== "string" || !item.trim()))) errors.push(`bucket ${bucket}.fallbackOn invalid`);
      if (provider && provider.free === true && provider.kind === "free-api" && ref.publicOnly !== true) errors.push(`bucket ${bucket} free API route must be publicOnly`);
      if (provider && provider.localOnly && ref.localOnly !== true) errors.push(`bucket ${bucket} local route must be localOnly`);
    }
  }
  return { ok: errors.length === 0, errors: errors.slice(0, 50) };
}

/** Load and validate only the committed, secretless registry document. */
export function loadProviderRegistry(filePath = DEFAULT_REGISTRY_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("PROVIDER_REGISTRY_INVALID");
  }
  const result = validateProviderRegistry(parsed);
  if (!result.ok) throw new Error(`PROVIDER_REGISTRY_INVALID: ${result.errors.join("; ")}`);
  return parsed;
}

/** Return durable secret mappings without ever returning secret values. */
export function providerSecretMappings(registry = loadProviderRegistry()) {
  const validation = validateProviderRegistry(registry);
  if (!validation.ok) throw new Error(`PROVIDER_REGISTRY_INVALID: ${validation.errors.join("; ")}`);
  return registry.providers.flatMap((provider) => provider.credentials.filter((credential) => credential.localOnly !== true).map((credential) => ({
    provider: provider.id,
    credential: credential.id,
    githubSecret: credential.githubSecret,
    env: credential.env,
    targetEnv: credential.targetEnv,
    required: credential.required === true,
    ...(credential.expiresEnv ? { expiresEnv: credential.expiresEnv } : {}),
  })));
}

/**
 * Resolve one named credential by presence and expiry metadata. The returned
 * object contains names and state only; the secret value stays process-local.
 */
export function resolveProviderCredentials(provider, env = process.env, { account, now = Date.now() } = {}) {
  const credentials = Array.isArray(provider?.credentials) ? provider.credentials : [];
  const candidates = account ? credentials.filter((item) => item.id === account) : credentials;
  if (candidates.length === 0) return { ok: false, state: "missing", reason: "CREDENTIAL_MAPPING_MISSING" };
  if (candidates.every((item) => item.localOnly === true)) {
    return { ok: false, state: "local-only", reason: "CREDENTIAL_LOCAL_ONLY", credential: candidates[0].id };
  }
  const present = candidates.filter((item) => hasCredentialValue(env, item.env));
  if (!account && present.length > 1) return { ok: false, state: "ambiguous", reason: "CREDENTIAL_MAPPING_AMBIGUOUS" };
  if (present.length === 0) return { ok: false, state: "missing", reason: "CREDENTIAL_MISSING" };
  const selected = present[0];
  if (selected.expiresEnv && hasCredentialValue(env, selected.expiresEnv)) {
    const expiresAt = dateMs(credentialValue(env, selected.expiresEnv));
    if (!Number.isFinite(expiresAt)) return { ok: false, state: "invalid-expiry", reason: "CREDENTIAL_EXPIRY_INVALID", credential: selected.id };
    if (expiresAt <= Number(now)) return { ok: false, state: "expired", reason: "CREDENTIAL_EXPIRED", credential: selected.id };
  }
  return {
    ok: true,
    state: "present",
    credential: selected.id,
    sourceEnv: selected.env,
    targetEnv: selected.targetEnv,
  };
}

/** Evaluate a provider snapshot without trusting stale or malformed health. */
const PROVIDER_HEALTH_STATES = new Set([
  "healthy", "rejected", "missing", "expired", "rate-limited", "quota-exhausted",
  "timeout", "unavailable", "disabled", "unknown", "stale",
]);

/** Map untrusted health snapshots to a fixed, log-safe vocabulary. */
export function normalizeProviderHealthStatus(value, fallback = "") {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  return PROVIDER_HEALTH_STATES.has(status) ? status : fallback;
}

export function assessProviderHealth(provider, env = process.env, { snapshot, now = Date.now(), maxAgeMs = DEFAULT_HEALTH_MAX_AGE_MS, account } = {}) {
  const credentials = resolveProviderCredentials(provider, env, { account, now });
  if (!credentials.ok) {
    const states = new Set(["ambiguous", "expired", "invalid-expiry", "local-only"]);
    return {
      provider: provider?.id || "unknown",
      status: states.has(credentials.state) ? `${credentials.state}-credentials` : "missing-credentials",
      credentialState: credentials.state,
    };
  }
  if (provider?.enabled !== true) return { provider: provider.id, status: "disabled", credential: credentials.credential };
  let selectedSnapshot = snapshot;
  if (snapshot?.credentials && typeof snapshot.credentials === "object" && account && snapshot.credentials[account]) selectedSnapshot = snapshot.credentials[account];
  if (!selectedSnapshot || typeof selectedSnapshot !== "object") return { provider: provider.id, status: "unknown", credential: credentials.credential };
  const checkedAt = dateMs(selectedSnapshot.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > Number(now)) return { provider: provider.id, status: "unknown", credential: credentials.credential };
  if (Number(now) - checkedAt > Number(maxAgeMs)) return { provider: provider.id, status: "stale", checkedAt: new Date(checkedAt).toISOString(), credential: credentials.credential };
  const status = normalizeProviderHealthStatus(selectedSnapshot.status, "unknown");
  if (status !== "healthy") return { provider: provider.id, status, checkedAt: new Date(checkedAt).toISOString(), credential: credentials.credential };
  return { provider: provider.id, status: "healthy", checkedAt: new Date(checkedAt).toISOString(), credential: credentials.credential };
}

const QUOTA_GROUP_VALUE_RE = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/;

function validQuotaGroupValue(value) {
  return typeof value === "string"
    && QUOTA_GROUP_VALUE_RE.test(value)
    && !SECRET_VALUE_RE.test(value);
}

/**
 * Resolve a non-secret quota-group label for one credential. Group labels are
 * configuration identifiers (for example, a Google Cloud project id), never
 * credential values. The result deliberately omits the label on failure.
 */
export function resolveProviderQuotaGroup(provider, credential, env = process.env) {
  if (provider?.auth?.quotaScope !== "credential-group") return { ok: false, state: "account-wide" };
  const envName = credential?.quotaGroupEnv;
  if (typeof envName !== "string" || !ENV_RE.test(envName)) return { ok: false, state: "missing-declaration" };
  const value = credentialValue(env, envName);
  if (!value) return { ok: false, state: "missing" };
  if (!validQuotaGroupValue(value)) return { ok: false, state: "invalid" };
  return { ok: true, env: envName, quotaGroup: value };
}

function freshSnapshotStatus(snapshot, now, maxAgeMs = DEFAULT_HEALTH_MAX_AGE_MS) {
  if (!snapshot || typeof snapshot !== "object") return "";
  const checkedAt = dateMs(snapshot.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > Number(now) || Number(now) - checkedAt > Number(maxAgeMs)) return "";
  return normalizeProviderHealthStatus(snapshot.status, "");
}

function quotaGroupValidation(provider, candidates, env) {
  if (provider?.auth?.quotaScope !== "credential-group") return { ok: false, state: "account-wide", groups: new Map() };
  const groups = new Map();
  const seen = new Set();
  for (const candidate of candidates) {
    const credentialId = candidate.ref?.credential || candidate.credentials?.credential;
    if (!credentialId || seen.has(credentialId)) continue;
    seen.add(credentialId);
    const resolved = resolveProviderQuotaGroup(provider, candidate.credentialObject, env);
    if (!resolved.ok) return { ok: false, state: resolved.state, groups };
    groups.set(credentialId, resolved.quotaGroup);
  }
  const values = [...groups.values()];
  if (values.length !== new Set(values).size) return { ok: false, state: "duplicate", groups };
  return { ok: true, state: "valid", groups };
}

function rotationStart(seed, provider, model, count) {
  if (!seed || count <= 1) return 0;
  const text = String(seed).trim();
  const numericSuffix = text.match(/(?:^|\D)(\d+)$/)?.[1];
  if (numericSuffix) return Number(BigInt(numericSuffix) % BigInt(count));
  const material = `${text}\u0000${provider}\u0000${model}`;
  const hash = createHash("sha256").update(material).digest();
  let value = 0n;
  for (const byte of hash.subarray(0, 8)) value = (value << 8n) | BigInt(byte);
  return Number(value % BigInt(count));
}

/** Return the model reference accepted by the OpenCode child or direct adapter. */
export function providerModelReference(provider, model) {
  const id = typeof provider === "string" ? provider : provider?.id;
  if (!id || typeof model !== "string" || !model.trim()) return "";
  return `${id === "opencode-zen" ? "opencode" : id}/${model}`;
}

/** Resolve a provider/model reference without guessing unknown provider ids. */
export function parseProviderModelReference(reference, registry = loadProviderRegistry()) {
  if (typeof reference !== "string" || !reference.trim()) return null;
  const value = reference.trim();
  const providers = [...registry.providers].sort((a, b) => {
    const left = a.id === "opencode-zen" ? "opencode" : a.id;
    const right = b.id === "opencode-zen" ? "opencode" : b.id;
    return right.length - left.length;
  });
  for (const provider of providers) {
    const prefix = `${provider.id === "opencode-zen" ? "opencode" : provider.id}/`;
    if (value.startsWith(prefix)) return { provider, model: value.slice(prefix.length), reference: value };
  }
  return null;
}

/** Select a route by policy; no route is returned for unverified providers. */
export function selectProviderRoute({ registry = loadProviderRegistry(), bucket, model, env = process.env, health = {}, now = Date.now(), freeOnly = true, allowPaid = false, allowLocal = false, allowPreview = false, allowLiveCanary = false, dataClass = "private", publicTarget, rotationSeed } = {}) {
  const validation = validateProviderRegistry(registry);
  if (!validation.ok) return { ok: false, reason: "PROVIDER_REGISTRY_INVALID" };
  const refs = Array.isArray(registry.buckets?.[bucket]) ? registry.buckets[bucket].slice().sort((a, b) => a.priority - b.priority) : [];
  const skipped = [];
  const localAccess = allowLocal === true
    && /^(?:1|true)$/i.test(String(env?.FLEET_ANTIGRAVITY_LOCAL || ""))
    && !/^(?:1|true)$/i.test(String(env?.GITHUB_ACTIONS || ""));
  const effectiveRotationSeed = rotationSeed ?? env?.FLEET_ACCOUNT_ROTATION_SEED ?? env?.GITHUB_RUN_ID ?? "";
  const groups = [];
  const seenGroups = new Set();
  for (const ref of refs) {
    if (model && ref.model !== model && providerModelReference(ref.provider === "opencode" ? "opencode-zen" : ref.provider, ref.model) !== model) continue;
    const groupKey = `${ref.provider}\u0000${ref.model}`;
    if (seenGroups.has(groupKey)) continue;
    seenGroups.add(groupKey);
    groups.push({
      key: groupKey,
      refs: refs.filter((item) => item.provider === ref.provider && item.model === ref.model),
    });
  }

  for (const group of groups) {
    const firstRef = group.refs[0];
    const provider = registry.providers.find((item) => item.id === firstRef.provider);
    if (!provider) { skipped.push("provider-missing"); continue; }
    const providerSnapshot = health[provider.id];
    const noRotationStates = new Set(["rate-limited", "quota-exhausted", ...(provider.fallbackPolicy?.noCredentialRotationOn || [])]);
    const providerStatus = freshSnapshotStatus(providerSnapshot, now);
    if (noRotationStates.has(providerStatus)) {
      skipped.push(`${provider.id}:${providerStatus}`);
      continue;
    }

    const candidates = [];
    for (const ref of group.refs) {
      if (provider.enabled !== true && !(localAccess && provider.localOnly === true)) { skipped.push(`${provider.id}:disabled`); continue; }
      if (provider.localOnly && !localAccess) { skipped.push(`${provider.id}:local-only`); continue; }
      if (provider.production?.enabled !== true && !localAccess && !allowPreview) { skipped.push(`${provider.id}:production-disabled`); continue; }
      if (provider.production?.requiresEnv && !/^(?:1|true)$/i.test(String(env[provider.production.requiresEnv] || "")) && !localAccess) { skipped.push(`${provider.id}:gate-disabled`); continue; }
      if (freeOnly && ref.free !== true) { skipped.push(`${provider.id}:paid`); continue; }
      if (!freeOnly && ref.free !== true && !allowPaid) { skipped.push(`${provider.id}:paid`); continue; }
      if (provider.kind === "free-api" && provider.verification?.status !== "verified") { skipped.push(`${provider.id}:unverified`); continue; }
      if (provider.kind === "cli" && provider.id === "antigravity"
        && provider.verification?.status !== "documented-local-api-key"
        && !(localAccess && provider.auth?.mode === "oauth" && provider.verification?.status === "documented-local-oauth")) {
        skipped.push(`${provider.id}:unverified`);
        continue;
      }
      if ((ref.publicOnly === true || provider.free === true && provider.kind === "free-api") && (dataClass !== "public" || publicTarget?.private !== false || publicTarget?.visibility !== "public")) {
        skipped.push(`${provider.id}:public-target-required`);
        continue;
      }
      if (!modelIsKnown(provider, ref.model)) { skipped.push(`${provider.id}:model-unverified`); continue; }
      const credentials = resolveProviderCredentials(provider, env, { account: ref.credential, now });
      const localCredential = localAccess && provider.localOnly === true && credentials.state === "local-only";
      if (!credentials.ok && !localCredential) { skipped.push(`${provider.id}:${credentials.state}`); continue; }
      const credentialObject = provider.credentials?.find((item) => item.id === ref.credential) || null;
      candidates.push({ ref, provider, credentials, credentialObject, localCredential });
    }
    if (candidates.length === 0) continue;

    const quotaInfo = quotaGroupValidation(provider, candidates.filter((candidate) => !candidate.localCredential), env);
    const accountStates = new Map();
    for (const candidate of candidates) {
      const accountSnapshot = providerSnapshot?.credentials?.[candidate.ref.credential];
      accountStates.set(candidate.ref.credential, freshSnapshotStatus(accountSnapshot, now));
    }
    const failedCredentials = new Set();
    const failedGroups = new Set();
    let unsafeQuotaSignal = false;
    for (const [credential, status] of accountStates) {
      if (!noRotationStates.has(status)) continue;
      if (!quotaInfo.ok) unsafeQuotaSignal = true;
      else {
        const groupName = quotaInfo.groups.get(credential);
        if (groupName) failedGroups.add(groupName);
        else failedCredentials.add(credential);
      }
    }
    const quotaGroups = providerSnapshot?.quotaGroups;
    if (quotaGroups && typeof quotaGroups === "object" && !Array.isArray(quotaGroups)) {
      if (!quotaInfo.ok) {
        for (const snapshot of Object.values(quotaGroups)) {
          if (noRotationStates.has(freshSnapshotStatus(snapshot, now))) unsafeQuotaSignal = true;
        }
      } else {
        for (const [groupName, snapshot] of Object.entries(quotaGroups)) {
          const status = freshSnapshotStatus(snapshot, now);
          if (!noRotationStates.has(status)) continue;
          if (![...quotaInfo.groups.values()].includes(groupName)) unsafeQuotaSignal = true;
          else failedGroups.add(groupName);
        }
      }
    }
    if (unsafeQuotaSignal) {
      const status = [...accountStates.values()].find((item) => noRotationStates.has(item)) || providerStatus || "rate-limited";
      skipped.push(`${provider.id}:${status}`);
      continue;
    }

    const eligible = [];
    for (const candidate of candidates) {
      if (failedCredentials.has(candidate.ref.credential)) {
        skipped.push(`${provider.id}:${accountStates.get(candidate.ref.credential)}`);
        continue;
      }
      const groupName = quotaInfo.groups.get(candidate.ref.credential);
      if (groupName && failedGroups.has(groupName)) {
        skipped.push(`${provider.id}:${accountStates.get(candidate.ref.credential) || "rate-limited"}`);
        continue;
      }
      if (candidate.localCredential) {
        eligible.push(candidate);
        continue;
      }
      const healthStatus = assessProviderHealth(provider, env, { snapshot: providerSnapshot, now, account: candidate.ref.credential });
      const liveCanary = allowLiveCanary === true
        && provider.kind === "free-api"
        && ["unknown", "stale"].includes(healthStatus.status);
      if (healthStatus.status !== "healthy" && !liveCanary) {
        skipped.push(`${provider.id}:${healthStatus.status}`);
        continue;
      }
      eligible.push({ ...candidate, liveCanary });
    }
    if (eligible.length === 0) continue;
    const ordered = eligible.slice().sort((left, right) => left.ref.priority - right.ref.priority);
    const canRotateHealthy = provider.auth?.sameProviderRotation === "healthy-round-robin";
    const selected = ordered[canRotateHealthy ? rotationStart(effectiveRotationSeed, provider.id, firstRef.model, ordered.length) : 0];
    const route = {
      ok: true,
      bucket,
      provider: provider.id,
      model: selected.ref.model,
      credential: selected.credentials.credential || selected.ref.credential,
      sourceEnv: selected.localCredential ? "" : selected.credentials.sourceEnv,
      targetEnv: selected.localCredential ? "" : selected.credentials.targetEnv,
      free: selected.ref.free,
      publicOnly: selected.ref.publicOnly === true || provider.free === true && provider.kind === "free-api",
      modelReference: providerModelReference(provider, selected.ref.model),
      ...(selected.liveCanary ? { health: "live-canary" } : selected.localCredential ? {} : { health: "fresh" }),
      ...(quotaInfo.groups.has(selected.credentials.credential) ? { quotaGroup: quotaInfo.groups.get(selected.credentials.credential) } : {}),
      ...(quotaInfo.ok && candidates.length > 1 ? { quotaGroupRotation: true } : {}),
    };
    return route;
  }
  return { ok: false, reason: freeOnly ? "NO_HEALTHY_FREE_PROVIDER" : "NO_HEALTHY_PROVIDER", skipped: skipped.slice(0, 20) };
}

function runBoundedProcess(command, args, options, timeoutMs, spawnImpl) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, options);
    } catch {
      reject(new Error("ANTIGRAVITY_SPAWN_FAILED"));
      return;
    }
    let stdout = "";
    let settled = false;
    let timedOut = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_PROCESS_OUTPUT) stdout += String(chunk).slice(0, MAX_PROCESS_OUTPUT - stdout.length);
    });
    child.stderr?.on("data", () => {});
    child.on("error", () => finish(reject, new Error("ANTIGRAVITY_PROCESS_FAILED")));
    child.on("close", (code) => {
      if (timedOut) return finish(reject, new Error("ANTIGRAVITY_TIMEOUT"));
      if (code !== 0) return finish(reject, new Error("ANTIGRAVITY_PROCESS_FAILED"));
      finish(resolve, stdout);
    });
  });
}

function providerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function classifyProviderHttpStatus(status) {
  if (status === 401 || status === 403) return "FREE_PROVIDER_AUTH_REJECTED";
  if (status === 402) return "FREE_PROVIDER_QUOTA_EXHAUSTED";
  if (status === 408 || status === 504) return "FREE_PROVIDER_TIMEOUT";
  if (status === 429) return "FREE_PROVIDER_RATE_LIMITED";
  if (status >= 500 && status <= 599) return "FREE_PROVIDER_UNAVAILABLE";
  return "FREE_PROVIDER_REQUEST_FAILED";
}

async function readBoundedResponseText(response, maxLength = MAX_PROCESS_OUTPUT) {
  const contentLength = response?.headers?.get?.("content-length");
  if (contentLength && Number.isFinite(Number(contentLength)) && Number(contentLength) > maxLength) {
    throw providerError("FREE_PROVIDER_OUTPUT_TOO_LARGE");
  }
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let output = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
        if (output.length > maxLength) {
          try { await reader.cancel(); } catch {}
          throw providerError("FREE_PROVIDER_OUTPUT_TOO_LARGE");
        }
      }
      output += decoder.decode();
      return output;
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }
  if (typeof response?.text === "function") {
    const output = await response.text();
    if (typeof output !== "string" || output.length > maxLength) throw providerError("FREE_PROVIDER_OUTPUT_TOO_LARGE");
    return output;
  }
  if (typeof response?.json === "function") {
    const output = JSON.stringify(await response.json());
    if (output.length > maxLength) throw providerError("FREE_PROVIDER_OUTPUT_TOO_LARGE");
    return output;
  }
  throw providerError("FREE_PROVIDER_OUTPUT_INVALID");
}

/**
 * Build an Antigravity CLI boundary. OAuth is local-only: when the explicit
 * local gate is set, agy runs from a disposable cwd while HOME points at the
 * caller's existing credential cache. Nothing is copied or exported. The
 * production/API-key branch remains an explicit, separately configured probe.
 */
export function createAntigravityAdapter({ provider, env = process.env, allowProduction = false, allowLocal = false, baseDir = os.tmpdir(), spawnImpl = spawn } = {}) {
  return {
    async invoke({ prompt, model, account, effort, timeoutMs = DEFAULT_AGY_TIMEOUT_MS, dataClass = "private", publicTarget } = {}) {
      const production = provider?.production?.enabled === true;
      const gateName = provider?.production?.requiresEnv || "FLEET_ANTIGRAVITY_ENABLE";
      const localMode = provider?.auth?.mode === "oauth" || provider?.localOnly === true;
      const localGate = allowLocal === true
        && /^(?:1|true)$/i.test(String(env.FLEET_ANTIGRAVITY_LOCAL || ""))
        && !/^(?:1|true)$/i.test(String(env.GITHUB_ACTIONS || ""));
      if (provider?.id !== "antigravity") throw new Error("ANTIGRAVITY_DISABLED");
      if (localMode) {
        if (!localGate) throw new Error("ANTIGRAVITY_OAUTH_LOCAL_ONLY");
      } else if (provider.enabled !== true || !(
        production
        ? allowProduction === true && /^(?:1|true)$/i.test(String(env[gateName] || ""))
        : /^(?:1|true)$/i.test(String(env.FLEET_ANTIGRAVITY_PROBE || "")))) {
        throw new Error("ANTIGRAVITY_DISABLED");
      }
      if (provider.verification?.status !== "documented-local-api-key"
        && !(localMode && provider.verification?.status === "documented-local-oauth")) throw new Error("ANTIGRAVITY_UNVERIFIED");
      if (dataClass !== "public" || publicTarget?.private !== false || publicTarget?.visibility !== "public") throw new Error("ANTIGRAVITY_PUBLIC_TARGET_REQUIRED");
      if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 120000) throw new Error("ANTIGRAVITY_PROMPT_INVALID");
      if (!modelIsKnown(provider, model)) throw new Error("ANTIGRAVITY_MODEL_UNVERIFIED");
      const configuredLocalCredential = localMode
        ? provider.credentials?.find((credential) => credential.id === (account || provider.credentials?.[0]?.id))
        : null;
      if (localMode && !configuredLocalCredential) throw new Error("ANTIGRAVITY_CREDENTIAL_UNKNOWN");
      const credentials = localMode
        ? { ok: true, state: "local-only", credential: configuredLocalCredential.id }
        : resolveProviderCredentials(provider, env, { account });
      if (!credentials.ok) throw new Error(`ANTIGRAVITY_CREDENTIAL_${credentials.state.toUpperCase()}`);
      const secret = localMode ? "" : credentialValue(env, credentials.sourceEnv);
      const cwd = mkdtempSync(path.join(path.resolve(baseDir), localMode ? "fleet-agy-local-" : "fleet-agy-"));
      const originalHome = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME : os.homedir();
      const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Math.min(Number(timeoutMs), MAX_PROVIDER_TIMEOUT_MS)
        : DEFAULT_AGY_TIMEOUT_MS;
      try {
        if (!localMode) {
          const settingsDir = path.join(cwd, ".gemini", "antigravity-cli");
          mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
          writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ modelProvider: "gemini", permissions: { allow: [] } }) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
        }
        const args = ["-p", prompt, "--model", model, "--output-format", "json"];
        if (effort) args.push("--effort", effort);
        if (localMode) args.push("--sandbox");
        const output = await runBoundedProcess("agy", args, {
          cwd,
          env: {
            PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin",
            HOME: localMode ? originalHome : cwd,
            TMPDIR: cwd,
            ...(localMode ? {} : { GEMINI_API_KEY: secret }),
            OPENCODE_DISABLE_AUTOUPDATE: "1",
          },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        }, boundedTimeoutMs, spawnImpl);
        let parsed;
        try { parsed = JSON.parse(output.trim()); } catch { throw new Error("ANTIGRAVITY_OUTPUT_INVALID"); }
        if (parsed?.status !== "SUCCESS" || typeof parsed.response !== "string") throw new Error("ANTIGRAVITY_OUTPUT_INVALID");
        return { ok: true, provider: provider.id, model, credential: credentials.credential, response: parsed.response };
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}

/** Build a generic free API boundary that refuses every unverified slot. */
export function createFreeProviderAdapter({ provider, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return {
    async invoke({ prompt, model, account, effort = "high", timeoutMs = 60 * 1000, dataClass = "private", publicTarget } = {}) {
      if (provider?.kind !== "free-api" || provider.free !== true || provider.verification?.status !== "verified") throw new Error("FREE_PROVIDER_UNVERIFIED");
      if (provider.enabled !== true || provider.production?.enabled !== true) throw new Error("FREE_PROVIDER_DISABLED");
      if (provider.production?.requiresEnv && !/^(?:1|true)$/i.test(String(env[provider.production.requiresEnv] || ""))) throw new Error("FREE_PROVIDER_GATE_DISABLED");
      if (dataClass !== "public" || publicTarget?.private !== false || publicTarget?.visibility !== "public") throw new Error("FREE_PROVIDER_PUBLIC_TARGET_REQUIRED");
      if (!validHttpsEndpoint(provider.endpoint)) throw new Error("FREE_PROVIDER_ENDPOINT_UNVERIFIED");
      if (!modelIsKnown(provider, model)) throw new Error("FREE_PROVIDER_MODEL_UNVERIFIED");
      if (typeof fetchImpl !== "function") throw providerError("FREE_PROVIDER_FETCH_UNAVAILABLE");
      if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 120000) throw providerError("FREE_PROVIDER_PROMPT_INVALID");
      const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Math.min(Number(timeoutMs), MAX_PROVIDER_TIMEOUT_MS)
        : 60 * 1000;
      const credentials = resolveProviderCredentials(provider, env, { account });
      if (!credentials.ok) throw providerError(`FREE_PROVIDER_CREDENTIAL_${credentials.state.toUpperCase()}`);
      const secret = credentialValue(env, credentials.sourceEnv);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), boundedTimeoutMs);
      try {
        const requestBody = {
          model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          ...(provider.id === "gemini-api" ? { reasoning_effort: effort || "high" } : {}),
          ...(provider.privacy?.requireZdr === true ? {
            provider: {
              zdr: true,
              data_collection: provider.privacy.dataCollection || "deny",
            },
          } : {}),
        };
        const response = await fetchImpl(provider.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
          body: JSON.stringify(requestBody),
          redirect: "error",
          signal: controller.signal,
        });
        if (!response?.ok) throw providerError(classifyProviderHttpStatus(Number(response?.status || 0)));
        let parsed;
        try {
          const raw = await readBoundedResponseText(response);
          parsed = JSON.parse(raw);
        } catch (error) {
          if (/^FREE_PROVIDER_/.test(String(error?.message || ""))) throw error;
          throw providerError("FREE_PROVIDER_OUTPUT_INVALID");
        }
        const text = typeof parsed?.output_text === "string"
          ? parsed.output_text
          : typeof parsed?.choices?.[0]?.message?.content === "string"
            ? parsed.choices[0].message.content
            : Array.isArray(parsed?.choices?.[0]?.message?.content)
              ? parsed.choices[0].message.content.map((part) => typeof part === "string" ? part : part?.text || "").join("")
              : "";
        if (typeof text !== "string" || !text || text.length > MAX_PROCESS_OUTPUT) throw providerError("FREE_PROVIDER_OUTPUT_INVALID");
        return { ok: true, provider: provider.id, model, credential: credentials.credential, response: text };
      } catch (error) {
        if (error?.name === "AbortError") throw providerError("FREE_PROVIDER_TIMEOUT");
        if (/^FREE_PROVIDER_/.test(String(error?.message || ""))) throw error;
        throw providerError("FREE_PROVIDER_NETWORK_FAILED");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function buildModelUpdateMetadata({ registry = loadProviderRegistry(), now = Date.now(), previousDigest = null } = {}) {
  const validation = validateProviderRegistry(registry);
  if (!validation.ok) throw new Error(`PROVIDER_REGISTRY_INVALID: ${validation.errors.join("; ")}`);
  if (previousDigest !== null && !HASH_RE.test(previousDigest)) throw new Error("MODEL_UPDATE_PREVIOUS_DIGEST_INVALID");
  const generatedAt = isoTime(now);
  return {
    schemaVersion: 1,
    registryVersion: registry.registryVersion,
    generatedAt,
    digest: digest(registry),
    previousDigest,
    rollback: { enabled: true, priorDigest: previousDigest },
  };
}

export function validateModelUpdateMetadata(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["metadata must be an object"] };
  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof value.registryVersion !== "string" || !value.registryVersion.trim()) errors.push("registryVersion is required");
  if (typeof value.generatedAt !== "string" || !Number.isFinite(dateMs(value.generatedAt))) errors.push("generatedAt invalid");
  if (!HASH_RE.test(String(value.digest || ""))) errors.push("digest invalid");
  if (value.previousDigest !== null && !HASH_RE.test(String(value.previousDigest || ""))) errors.push("previousDigest invalid");
  if (!value.rollback || value.rollback.enabled !== true || value.rollback.priorDigest !== value.previousDigest) errors.push("rollback metadata invalid");
  return { ok: errors.length === 0, errors };
}

export function createModelRollbackRecord({ activeDigest, targetDigest, registryVersion, reason, now = Date.now() } = {}) {
  if (!HASH_RE.test(String(activeDigest || "")) || !HASH_RE.test(String(targetDigest || "")) || activeDigest === targetDigest) throw new Error("MODEL_ROLLBACK_DIGEST_INVALID");
  if (typeof registryVersion !== "string" || !registryVersion.trim()) throw new Error("MODEL_ROLLBACK_REGISTRY_INVALID");
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 500 || SECRET_VALUE_RE.test(reason)) throw new Error("MODEL_ROLLBACK_REASON_INVALID");
  return {
    event: "MODEL_ROLLBACK_REQUESTED",
    registryVersion,
    activeDigest,
    targetDigest,
    reason: reason.trim(),
    occurredAt: isoTime(now),
  };
}

export const PROVIDER_HEALTH_MAX_AGE_MS = DEFAULT_HEALTH_MAX_AGE_MS;
