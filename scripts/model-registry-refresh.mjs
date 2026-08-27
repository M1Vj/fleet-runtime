#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildModelUpdateMetadata, loadProviderRegistry } from "./lib/provider-registry.mjs";

const MAX_DISCOVERY_BYTES = 1024 * 1024;
const MAX_DISCOVERED_MODELS = 5000;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SECRET_LIKE_RE = /(?:gh[pousr]_|github_pat_|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-)/;

const DISCOVERY = Object.freeze({
  "gemini-api": {
    source: "google-models",
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    credential: "GEMINI_API_KEY_1",
    backupCredential: "GEMINI_API_KEY_2",
  },
  openrouter: {
    source: "openrouter-models",
    url: "https://openrouter.ai/api/v1/models",
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
  if (providerId === "opencode-zen") {
    return Object.keys(payload?.opencode?.models || {});
  }
  return [];
}

function familyAllowed(providerId, model) {
  if (providerId === "gemini-api") return /^gemini-\d+(?:\.\d+)+-flash(?:-[a-z0-9.-]+)?$/.test(model);
  if (providerId === "openrouter") return /^[a-z0-9._-]+\/[a-z0-9._/-]+:free$/.test(model);
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
  const text = await response.text();
  if (typeof text !== "string" || text.length > MAX_DISCOVERY_BYTES) throw new Error("MODEL_DISCOVERY_RESPONSE_INVALID");
  return JSON.parse(text);
}

export async function discoverProviderModels({ providerId, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const spec = DISCOVERY[providerId];
  if (!spec || typeof fetchImpl !== "function") return { status: "unsupported", source: "none", models: [] };
  const headers = { accept: "application/json" };
  if (spec.credential) {
    const key = String(env[spec.credential] || env[spec.backupCredential] || "").trim();
    if (!key) return { status: "missing-credential", source: spec.source, models: [] };
    headers["x-goog-api-key"] = key;
  }
  const controller = new AbortController();
  const boundedTimeout = Math.max(1, Math.min(Number(timeoutMs) || 15000, 30000));
  const timer = setTimeout(() => controller.abort(), boundedTimeout);
  try {
    const response = await fetchImpl(spec.url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) return { status: "unavailable", source: spec.source, models: [] };
    const payload = await boundedJson(response);
    return { status: "healthy", source: spec.source, models: sanitizeDiscoveredModelIds(providerId, payload) };
  } catch {
    return { status: "unavailable", source: spec.source, models: [] };
  } finally {
    clearTimeout(timer);
  }
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
      status: ["healthy", "unavailable", "missing-credential", "unsupported", "not-checked"].includes(discovery.status)
        ? discovery.status
        : "unavailable",
      source: ["google-models", "openrouter-models", "local-model-catalog", "none"].includes(discovery.source)
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
