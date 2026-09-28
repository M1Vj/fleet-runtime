// Per-model outcome metrics for the fleet model ladder (fleet-local,
// in-memory only — no daemon, no sockets, no persistence of prompts).
//
// One entry per sanitized model ID, capped at MODEL_METRICS_MAX_KEYS keys
// (oldest evicted first). Each entry:
//   { attempt, success, limited429, error5xx, latencyEwmaMs }
// Telemetry allowlist: model IDs + counters + latency EWMA only. Never
// prompt text, env dumps, or auth material.

export const MODEL_METRICS_MAX_KEYS = 32;
const LATENCY_EWMA_ALPHA = 0.3;

import path from "node:path";
import { atomicWriteJsonSync } from "./util.mjs";
import { existsSync, readFileSync } from "node:fs";

const metrics = new Map();

export function sanitizeModelKey(modelId) {
  const raw = String(modelId || "").trim();
  if (!raw) return "unknown-model";
  return raw.replace(/[^A-Za-z0-9/_@.:-]/g, "_").slice(0, 160) || "unknown-model";
}

function entryFor(key) {
  let entry = metrics.get(key);
  if (!entry) {
    entry = { attempt: 0, success: 0, limited429: 0, error5xx: 0, latencyEwmaMs: 0 };
    metrics.set(key, entry);
    while (metrics.size > MODEL_METRICS_MAX_KEYS) {
      const oldest = metrics.keys().next().value;
      metrics.delete(oldest);
    }
    entry = metrics.get(key);
  }
  return entry;
}

export function recordModelOutcome(modelId, { ok = false, limited429 = false, error5xx = false, latencyMs = 0 } = {}) {
  const entry = entryFor(sanitizeModelKey(modelId));
  entry.attempt += 1;
  if (ok) entry.success += 1;
  if (limited429) entry.limited429 += 1;
  if (error5xx) entry.error5xx += 1;
  const latency = Number(latencyMs);
  if (Number.isFinite(latency) && latency >= 0) {
    entry.latencyEwmaMs = entry.attempt <= 1
      ? Math.round(latency)
      : Math.round(LATENCY_EWMA_ALPHA * latency + (1 - LATENCY_EWMA_ALPHA) * entry.latencyEwmaMs);
  }
  return { ...entry };
}

export function getModelMetrics() {
  const out = {};
  for (const [key, entry] of metrics) out[key] = { ...entry };
  return out;
}

export function resetModelMetrics() {
  metrics.clear();
}

export function metricsPath(root) {
  return path.join(root || process.cwd(), "state", "model-metrics.json");
}

export function saveModelMetricsSnapshot(stateRoot) {
  try {
    atomicWriteJsonSync(metricsPath(stateRoot), {
      updatedUtc: new Date().toISOString(),
      models: getModelMetrics(),
    });
    return true;
  } catch {
    return false;
  }
}

export function loadModelMetricsSnapshot(stateRoot) {
  try {
    const p = metricsPath(stateRoot);
    if (!existsSync(p)) return {};
    const data = JSON.parse(readFileSync(p, "utf8"));
    if (!data || typeof data.models !== "object" || Array.isArray(data.models)) return {};
    return data.models;
  } catch {
    return {};
  }
}
