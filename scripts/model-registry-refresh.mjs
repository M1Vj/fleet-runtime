#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildModelUpdateMetadata, loadProviderRegistry, validCloudflareAccountId } from "./lib/provider-registry.mjs";

const MAX_DISCOVERY_BYTES = 1024 * 1024;
const MAX_DISCOVERED_MODELS = 5000;
const MODEL_ID_RE = /^@?[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SECRET_LIKE_RE = /(?:gh[pousr]_|github_pat_|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-)/;

const DISCOVERY = Object.freeze({
  "gemini-api": {
    source: "google-models",
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    credentials: Array.from({ length: 6 }, (_, index) => `GEMINI_API_KEY_${index + 1}`),
    credentialMode: "google-header",
  },
  openrouter: {
    source: "openrouter-models",
    url: "https://openrouter.ai/api/v1/models",
    credential: "OPENROUTER_API_KEY",
    credentialMode: "bearer",
  },
  groq: {
    source: "groq-models",
    url: "https://api.groq.com/openai/v1/models",
    credential: "GROQ_API_KEY",
    credentialMode: "bearer",
  },
  "vercel-ai-gateway": {
    source: "vercel-models",
    url: "https://ai-gateway.vercel.sh/v1/models",
    credential: "AI_GATEWAY_API_KEY",
    credentialOptional: true,
    credentialMode: "bearer",
  },
  "cloudflare-workers-ai": {
    source: "cloudflare-models",
    credential: "CLOUDFLARE_API_TOKEN",
    credentialMode: "bearer",
    accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
  },
  "nvidia-nim": {
    source: "nvidia-models",
    url: "https://integrate.api.nvidia.com/v1/models",
    credentials: ["NVIDIA_API_KEY_1", "NVIDIA_API_KEY_2"],
    credentialMode: "bearer",
  },
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function rawModelIds(providerId, payload) {
  if (providerId === "gemini-api") {
    return Array.isArray(payload?.models)
      ? payload.models.map((item) => String(item?.name || "").replace(/^models\//, ""))
      : [];
  }
  if (providerId === "openrouter") {
    return Array.isArray(payload?.data) ? payload.data.map((item) => item?.id) : [];
  }
  if (providerId === "groq") {
    return Array.isArray(payload?.data) ? payload.data.map((item) => item?.id) : [];
  }
  if (providerId === "vercel-ai-gateway") {
    return Array.isArray(payload?.data) ? payload.data.map((item) => item?.id) : [];
  }
  if (providerId === "cloudflare-workers-ai") {
    const data = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.result?.data)
        ? payload.result.data
        : [];
    return data.map((item) => item?.id || item?.model || item?.model_id);
  }
  if (providerId === "nvidia-nim") {
    return Array.isArray(payload?.data) ? payload.data.map((item) => item?.id) : [];
  }
  if (providerId === "opencode-zen") {
    return Object.keys(payload?.opencode?.models || {});
  }
  return [];
}

function familyAllowed(providerId, model) {
  if (providerId === "gemini-api") return /^gemini-\d+(?:\.\d+)+-flash(?:-[a-z0-9.-]+)?$/.test(model);
  if (providerId === "openrouter") return /^[a-z0-9._-]+\/[a-z0-9._/-]+:free$/.test(model);
  if (providerId === "groq") return /^qwen\/qwen3\.[0-9]+-27b$/.test(model);
  if (providerId === "vercel-ai-gateway") return /^poolside\/laguna-s-2\.1-free$/.test(model);
  if (providerId === "cloudflare-workers-ai") return /^@cf\/(?:openai\/gpt-oss-120b|zai-org\/glm-4\.7-flash)$/.test(model);
  if (providerId === "nvidia-nim") return model === "moonshotai/kimi-k3";
  if (providerId === "opencode-zen") return /^claude-opus-\d+-\d+$/.test(model);
  return false;
}

/** Treat discovery bodies as hostile data and retain model ids only. */
export function sanitizeDiscoveredModelIds(providerId, payload) {
  const clean = [];
  for (const raw of rawModelIds(providerId, payload).slice(0, MAX_DISCOVERED_MODELS)) {
    const model = typeof raw === "string" ? raw.trim() : "";
    if (!MODEL_ID_RE.test(model) || SECRET_LIKE_RE.test(model) || !familyAllowed(providerId, model)) continue;
    clean.push(model);
  }
  return [...new Set(clean)].sort();
}

async function boundedJson(response) {
  const contentLength = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_DISCOVERY_BYTES) throw new Error("MODEL_DISCOVERY_RESPONSE_INVALID");
  let text = "";
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength || 0;
        if (bytes > MAX_DISCOVERY_BYTES) {
          await reader.cancel?.();
          throw new Error("MODEL_DISCOVERY_RESPONSE_INVALID");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      try { await reader.cancel?.(); } catch {}
      throw error;
    }
  } else {
    text = await response.text();
  }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_DISCOVERY_BYTES) throw new Error("MODEL_DISCOVERY_RESPONSE_INVALID");
  return JSON.parse(text);
}

export async function discoverProviderModels({ providerId, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const spec = DISCOVERY[providerId];
  if (!spec || typeof fetchImpl !== "function") return { status: "unsupported", source: "none", models: [] };
  let discoveryUrl = spec.url;
  if (spec.accountIdEnv) {
    const accountId = typeof env?.[spec.accountIdEnv] === "string" ? env[spec.accountIdEnv] : "";
    if (!accountId) return { status: "missing-account-id", source: spec.source, models: [] };
    if (!validCloudflareAccountId(accountId)) return { status: "invalid-account-id", source: spec.source, models: [] };
    discoveryUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?format=openrouter&hide_experimental=true&per_page=100`;
  }
  const boundedTimeout = Math.max(1, Math.min(Number(timeoutMs) || 15000, 30000));
  const credentialNames = [
    ...(Array.isArray(spec.credentials) ? spec.credentials : [spec.credential, spec.backupCredential]),
  ].filter((name, index, names) => typeof name === "string" && name.trim() && names.indexOf(name) === index);
  const presentCredentials = credentialNames.filter((name) => typeof env?.[name] === "string" && env[name].trim());
  if (presentCredentials.length === 0 && credentialNames.length > 0 && !spec.credentialOptional) {
    return { status: "missing-credential", source: spec.source, models: [] };
  }
  const attempts = presentCredentials.length > 0 ? presentCredentials : [null];
  for (const credentialName of attempts) {
    const key = credentialName ? String(env[credentialName]).trim() : "";
    const headers = { accept: "application/json" };
    if (key && spec.credentialMode === "bearer") headers.authorization = `Bearer ${key}`;
    else if (key) headers["x-goog-api-key"] = key;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), boundedTimeout);
    try {
      const response = await fetchImpl(discoveryUrl, {
        method: "GET",
        headers,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response?.ok) {
        const status = Number(response?.status || 0);
        const hasNextCredential = attempts.indexOf(credentialName) < attempts.length - 1;
        if ((status === 401 || status === 403) && hasNextCredential) continue;
        return { status: "unavailable", source: spec.source, models: [] };
      }
      const payload = await boundedJson(response);
      return { status: "healthy", source: spec.source, models: sanitizeDiscoveredModelIds(providerId, payload) };
    } catch {
      return { status: "unavailable", source: spec.source, models: [] };
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: "unavailable", source: spec.source, models: [] };
}

export function buildRefreshProposal({ registry = loadProviderRegistry(), discoveries = {}, now = Date.now() } = {}) {
  const active = buildModelUpdateMetadata({ registry, now });
  const providers = {};
  for (const provider of registry.providers) {
    const discovery = discoveries[provider.id] || { status: "not-checked", source: "none", models: [] };
    const known = Object.keys(provider.models || {}).sort();
    const discovered = Array.isArray(discovery.models)
      ? discovery.models.filter((model) => MODEL_ID_RE.test(model) && familyAllowed(provider.id, model)).slice(0, MAX_DISCOVERED_MODELS).sort()
      : [];
    providers[provider.id] = {
      status: ["healthy", "unavailable", "missing-credential", "missing-account-id", "invalid-account-id", "unsupported", "not-checked"].includes(discovery.status)
        ? discovery.status
        : "unavailable",
      source: ["google-models", "openrouter-models", "groq-models", "vercel-models", "cloudflare-models", "nvidia-models", "local-model-catalog", "none"].includes(discovery.source)
        ? discovery.source
        : "none",
      known,
      discovered: [...new Set(discovered)],
      candidates: [...new Set(discovered.filter((model) => !known.includes(model)))],
    };
  }
  const proposal = {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    activeRegistryVersion: registry.registryVersion,
    activeDigest: active.digest,
    activation: "disabled",
    providers,
  };
  return { ...proposal, proposalDigest: sha256(proposal) };
}

export async function runRefresh({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const registry = loadProviderRegistry();
  const localModels = JSON.parse(readFileSync(new URL("../config/models.json", import.meta.url), "utf8"));
  const discoveries = {
    "opencode-zen": {
      status: "healthy",
      source: "local-model-catalog",
      models: sanitizeDiscoveredModelIds("opencode-zen", localModels),
    },
  };
  for (const providerId of Object.keys(DISCOVERY)) {
    discoveries[providerId] = await discoverProviderModels({ providerId, env, fetchImpl });
  }
  return buildRefreshProposal({ registry, discoveries, now });
}

async function main() {
  const proposal = await runRefresh();
  const artifactRoot = path.resolve(process.env.FLEET_ARTIFACT_DIR || "artifacts");
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const out = path.join(artifactRoot, "model-registry-proposal.json");
  writeFileSync(out, `${JSON.stringify(proposal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`MODEL_REFRESH_PROPOSAL=${out}`);
  console.log(`MODEL_REFRESH_DIGEST=${proposal.proposalDigest}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    const code = String(error?.message || "MODEL_REFRESH_FAILED").replace(/[^A-Z0-9_-]/gi, "_").slice(0, 100);
    console.error(`MODEL_REFRESH_FAILED=${code}`);
    process.exitCode = 1;
  });
}

export const MODEL_REFRESH_SCRIPT = fileURLToPath(import.meta.url);
