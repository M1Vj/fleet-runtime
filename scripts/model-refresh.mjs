#!/usr/bin/env node
// Fleet self-tuning chain refresh writer (workflow-only, never in lanes).
//
// Reads the live OpenCode Zen catalog (Zen /v1/models + pricing), filters to
// free-tier + allowlisted IDs (provider-registry helpers, read-only), ranks,
// and writes the runtime override file:
//
//   <FLEET_STATE_ROOT>/state/model-chain.json
//   {chain:[ids], updatedAt, source:<safe public category>, ttlMs}
//
// Precedence (scripts/lib/model.mjs resolveModelChain):
//   explicit FLEET_MODEL_CHAIN env > fresh+valid override file > code DEFAULT.
// Stale/invalid file is ignored (rollback by expiry, default 7d via
// FLEET_CHAIN_TTL_MS). This writer never writes an invalid file: on any
// fetch/parse/validation failure it exits non-zero without touching state
// (read-only on failure).
//
// Telemetry ranking: no per-model success-rate/latency store exists yet
// (state/events.jsonl records lane/state/mode only, no per-model outcomes;
// gateway-health records chain snapshots on failure only). Phase 1 therefore
// ranks = catalog order with the current primary pinned first. Phase 2 (TODO):
// rank by measured success-rate then latency once per-model telemetry lands.
//
// Catalog source: live Zen URL defaults to https://opencode.ai/zen/v1/models
// (see .github/workflows/ci-diag.yml v4 curl probe). Override with
// ZEN_MODELS_URL, or with OPENCODE_MODELS_URL when it is an https:// URL
// (workflows otherwise set OPENCODE_MODELS_URL=file://.../config/models.json
// for the opencode CLI registry override — a file:// value is used as a
// local fallback catalog, never fetched).
//
// Dependency-free: node builtins + global fetch + local provider-registry
// helpers only. No npm deps. Fake data only in tests; never logs secrets.

import process from "node:process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_MODEL_CHAIN,
  PRIMARY_MODEL,
  isAllowedModel,
  sanitizeModelChain,
  getModelCapabilityScore,
} from "./lib/provider-registry.mjs";
import { CORE_INTEGRITY_OK, CORE_LOCK_DIGEST, CORE_MANIFEST } from "../packages/indefinite-core/index.mjs";
import { makeTerminal } from "./lib/terminal.mjs";

export const ZEN_DEFAULT_URL = "https://opencode.ai/zen/v1/models";
export const CHAIN_TTL_MS_DEFAULT = 7 * 24 * 3600 * 1000;
export const MAX_CHAIN = 5;
export const CORE_REFRESH_DIGEST = CORE_LOCK_DIGEST;

// Public artifacts must never carry the catalog URL or a local fallback path.
// Keep the source field categorical and accept only exact, public HTTPS
// catalog endpoints that this workflow is allowed to query.
const PUBLIC_CATALOG_ORIGINS = new Map([
  [ZEN_DEFAULT_URL, "zen-public"],
  ["https://models.dev/api.json", "models-dev-public"],
]);

function isPublicExecution(env = process.env) {
  return String(env?.FLEET_DATA_CLASS || "").trim().toLowerCase() === "public";
}

function refreshFailureLine(reason, error, env = process.env, maxDetail = 160) {
  if (isPublicExecution(env)) return `MODEL_REFRESH_FAILED reason=${reason}`;
  const detail = String((error && error.message) || error).slice(0, maxDetail);
  return `MODEL_REFRESH_FAILED reason=${reason} detail=${detail}`;
}

export function publicCatalogOrigin(env = process.env) {
  const raw = resolveCatalogUrl(env);
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return "unknown";
    return PUBLIC_CATALOG_ORIGINS.get(url.toString()) || "unknown";
  } catch {
    return "unknown";
  }
}

export function resolveWriterTtlMs(env = process.env) {
  const raw = Number.parseInt(String(env.FLEET_CHAIN_TTL_MS || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : CHAIN_TTL_MS_DEFAULT;
}

export function chainOutputPath(stateRoot) {
  return path.join(stateRoot || process.cwd(), "state", "model-chain.json");
}

export function resolveCatalogUrl(env = process.env) {
  const zen = String(env.ZEN_MODELS_URL || "").trim();
  if (zen) return zen;
  const oc = String(env.OPENCODE_MODELS_URL || "").trim();
  if (oc.startsWith("https://")) return oc;
  return ZEN_DEFAULT_URL;
}

function localFallbackPaths(env = process.env) {
  const out = [];
  const oc = String(env.OPENCODE_MODELS_URL || "").trim();
  if (oc.startsWith("file://")) out.push(oc.slice("file://".length));
  out.push(path.join(process.cwd(), "config", "models.json"));
  return out;
}

async function fetchJson(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function readLocalJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

// Normalize the many shapes a model catalog can take into [{id, entry}]:
// array, {models: array|object}, {data: array}, {opencode:{models:{}}}.
export function extractCandidates(json) {
  const out = [];
  const pushEntry = (id, entry) => {
    let v = String(id || (entry && entry.id) || "").trim();
    if (!v) return;
    if (!v.includes("/")) v = `opencode/${v}`;
    out.push({ id: v, entry: entry || {} });
  };
  if (!json || typeof json !== "object") return out;
  if (Array.isArray(json)) {
    for (const e of json) pushEntry(e && (e.id || e.name), e);
    return out;
  }
  const pools = [];
  if (json.models) pools.push(json.models);
  if (json.data) pools.push(json.data);
  if (json.opencode && json.opencode.models) pools.push(json.opencode.models);
  for (const pool of pools) {
    if (Array.isArray(pool)) {
      for (const e of pool) pushEntry(e && (e.id || e.name), e);
    } else if (pool && typeof pool === "object") {
      for (const [k, e] of Object.entries(pool)) pushEntry((e && e.id) || k, e);
    }
  }
  return out;
}

// Free-tier filter: explicit -free IDs or zero-price entries. Allowlist is
// enforced separately via isAllowedModel (rejects dead IDs).
export function isFreeTier(id, entry = {}) {
  if (/free/i.test(String(id || ""))) return true;
  const costs = [entry?.cost?.input, entry?.pricing?.input, entry?.price?.input];
  for (const c of costs) {
    if (typeof c === "number" && c === 0) return true;
    if (typeof c === "string" && c.trim() === "0") return true;
  }
  if (entry && (entry.free === true || entry.tier === "free")) return true;
  return false;
}

// Dynamic ranking: primary pinned first, fallback models dynamically sorted
// by parameter size / benchmark capability score and context window limit.
export function rankChain(candidates) {
  const free = [];
  for (const { id, entry } of candidates) {
    const fullId = id.includes("/") ? id : `opencode/${id}`;
    if (!isAllowedModel(fullId, { free: isFreeTier(fullId, entry) })) continue;
    if (entry && (entry.authorized === false || entry.providerAuthorized === false || entry.routeEligible === false)) continue;
    if (entry && entry.status === "deprecated") continue;
    if (!isFreeTier(fullId, entry)) continue;
    free.push({ id: fullId, entry });
  }

  free.sort((a, b) => {
    if (a.id === PRIMARY_MODEL) return -1;
    if (b.id === PRIMARY_MODEL) return 1;

    const scoreA = getModelCapabilityScore(a.id);
    const scoreB = getModelCapabilityScore(b.id);
    if (scoreA !== scoreB) return scoreB - scoreA;

    const ctxA = a.entry?.limit?.context || 0;
    const ctxB = b.entry?.limit?.context || 0;
    return ctxB - ctxA;
  });

  const hasPrimary = free.some((x) => x.id === PRIMARY_MODEL);
  const ordered = hasPrimary
    ? [PRIMARY_MODEL, ...free.map((x) => x.id).filter((id) => id !== PRIMARY_MODEL)]
    : free.map((x) => x.id);
  const clean = sanitizeModelChain(ordered);
  return clean.slice(0, MAX_CHAIN);
}

export function validateChain(chain) {
  if (!Array.isArray(chain) || chain.length === 0 || chain.length > MAX_CHAIN) return false;
  const clean = sanitizeModelChain(chain);
  return clean.length === chain.length;
}

async function loadCatalog(env) {
  const url = resolveCatalogUrl(env);
  if (url.startsWith("file://")) return readLocalJson(url.slice("file://".length));
  try {
    return await fetchJson(url);
  } catch (err) {
    for (const p of localFallbackPaths(env)) {
      try {
        if (existsSync(p)) return readLocalJson(p);
      } catch {}
    }
    throw err;
  }
}

export async function main(env = process.env) {
  const stateRoot = env.FLEET_STATE_ROOT || process.cwd();
  if (!CORE_INTEGRITY_OK) {
    console.error(`MODEL_REFRESH_FAILED reason=core-parity-mismatch digest=${CORE_LOCK_DIGEST}`);
    return 1;
  }
  const ttlMs = resolveWriterTtlMs(env);
  let json;
  try {
    json = await loadCatalog(env);
  } catch (err) {
    console.error(refreshFailureLine("catalog-unavailable", err, env));
    return 1;
  }
  const cands = extractCandidates(json);
  if (cands.length === 0) {
    console.error("MODEL_REFRESH_FAILED reason=empty-catalog");
    return 1;
  }
  const ranked = rankChain(cands);
  if (!validateChain(ranked)) {
    console.error(`MODEL_REFRESH_FAILED reason=no-valid-free-chain candidates=${ranked.length}`);
    return 1;
  }
  // Never strand the fleet on a chain without the known-good primary when
  // the catalog omits it: primary is pinned first by rankChain, and an empty
  // result above already fails read-only. Fall back to code default only as
  // a last resort before writing (still validated).
  const chain = ranked.length > 0 ? ranked : sanitizeModelChain(DEFAULT_MODEL_CHAIN).slice(0, MAX_CHAIN);
  if (!validateChain(chain)) {
    console.error("MODEL_REFRESH_FAILED reason=invalid-chain");
    return 1;
  }
  const payload = {
    chain,
    updatedAt: new Date().toISOString(),
    source: publicCatalogOrigin(env),
    ttlMs,
    coreVersion: CORE_MANIFEST.coreVersion,
    coreDigest: CORE_LOCK_DIGEST,
  };
  try {
    const p = chainOutputPath(stateRoot);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(payload, null, 2) + "\n");
  } catch (err) {
    console.error(refreshFailureLine("write-failed", err, env, 120));
    return 1;
  }
  try {
    makeTerminal(stateRoot, { lane: "model-refresh" })("SUCCESS", { chain, source: payload.source });
  } catch {}
  console.log(`MODEL_REFRESH_OK chain=${chain.join(",")}`);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const code = await main(process.env);
  process.exit(code);
}
