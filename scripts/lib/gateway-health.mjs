import { existsSync, readFileSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import * as fs from "node:fs";
import path from "node:path";

// Circuit breaker: the gateway stays open for 30 minutes after the last
// recorded failure, then closes itself on the next check.
export const CIRCUIT_OPEN_MS = 30 * 60 * 1000;

function filePath(root) {
  return path.join(root || process.cwd(), "state", "gateway-health.json");
}

// Telemetry must never carry credentials — redact secret-like tokens from
// recorded reasons before persisting.
function scrubReason(reason) {
  return String(reason || "model unavailable")
    .replace(/(gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+|xox[bpas]-[A-Za-z0-9-]+)/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .slice(0, 300);
}

export function markGatewayDown(root = process.cwd(), reason = "model unavailable", details = {}) {
  try {
    const p = filePath(root);
    mkdirSyncSafe(p);
    // Telemetry allowlist: model IDs, attempt counts, mode labels only.
    // Never prompt text, env dumps, or auth material.
    const telemetry = {};
    if (Array.isArray(details.chain)) telemetry.chain = details.chain.map(String).slice(0, 6);
    if (Number.isFinite(details.attempts)) telemetry.attempts = details.attempts;
    if (details.modelMode) telemetry.modelMode = String(details.modelMode).slice(0, 120);
    writeFileSync(p, JSON.stringify({ downSince: new Date().toISOString(), reason: scrubReason(reason), ...telemetry }));
  } catch {}
}

export function markGatewayUp(root = process.cwd()) {
  try {
    const p = filePath(root);
    if (existsSync(p)) {
      const t = new Date().toISOString();
      utimesSync(p, new Date(t), new Date(t));
      writeFileSync(p, JSON.stringify({ recoveredAt: t }));
    }
  } catch {}
}

// Raw health document, or null when no health state exists yet.
export function readHealth(root = process.cwd()) {
  try {
    const p = filePath(root);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Telemetry snapshot for status reporters: open flag + age + stored fields.
export function healthSnapshot(root = process.cwd()) {
  const data = readHealth(root);
  if (!data) return { open: false, ageMs: -1, data: null };
  const stamp = data.downSince || data.recoveredAt;
  const ageMs = stamp ? Date.now() - Date.parse(stamp) : -1;
  const open = Boolean(data.downSince) && ageMs >= 0 && ageMs < CIRCUIT_OPEN_MS;
  return { open, ageMs, data };
}

export function gatewayCircuitOpen(root = process.cwd()) {
  return healthSnapshot(root).open;
}

function mkdirSyncSafe(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

export function gatewayDown(root = process.cwd()) {
  return gatewayCircuitOpen(root);
}
