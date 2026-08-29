import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const PROVIDER_HEALTH_RETENTION_MS = 15 * 60 * 1000;
const MAX_BYTES = 256 * 1024;
const STATUS = new Set(["healthy", "unknown", "missing", "expired", "rejected", "rate-limited", "quota-exhausted", "timeout", "unavailable", "disabled", "stale"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function stateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function canonicalAbsolute(value, code) {
  const text = String(value ?? "");
  if (!text || !path.isAbsolute(text) || path.resolve(text) !== text || text.endsWith(path.sep)) throw stateError(code);
  return text;
}

/** Reject a leaf and its task-owned parent without rejecting OS-level aliases such as /var. */
function validatePathComponents(value, code, { allowMissing = true, leafType = "any" } = {}) {
  const absolute = canonicalAbsolute(value, code);
  const parent = path.dirname(absolute);
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw stateError(code);
  let stat;
  try { stat = lstatSync(absolute); } catch (error) {
    if (error?.code === "ENOENT" && allowMissing) return absolute;
    throw error;
  }
  if (stat.isSymbolicLink()) throw stateError(code);
  if (leafType === "file" && !stat.isFile()) throw stateError(code);
  if (leafType === "directory" && !stat.isDirectory()) throw stateError(code);
  return absolute;
}

/** Create/verify one task-owned private directory below an existing trusted parent. */
function ensurePrivateDirectory(directory, code) {
  const absolute = canonicalAbsolute(directory, code);
  let stat;
  try { stat = lstatSync(absolute); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    const parentStat = lstatSync(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw stateError(code);
    try { mkdirSync(absolute, { mode: DIRECTORY_MODE }); } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") throw mkdirError;
    }
    stat = lstatSync(absolute);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw stateError(code);
  const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
  try { fchmodSync(descriptor, DIRECTORY_MODE); } finally { closeSync(descriptor); }
  return absolute;
}

function openRegularFile(file, code, { maxBytes = MAX_BYTES, required = false } = {}) {
  const absolute = validatePathComponents(file, code, { allowMissing: true, leafType: "file" });
  let descriptor;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return null;
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) throw stateError(code);
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) throw stateError(code);
    return { descriptor, size: stat.size };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function readRegularFile(file, code, options = {}) {
  const opened = openRegularFile(file, code, options);
  if (!opened) return null;
  try { return readFileSync(opened.descriptor, "utf8"); } finally { closeSync(opened.descriptor); }
}

function stateFile(stateRoot) {
  const root = canonicalAbsolute(stateRoot, "PROVIDER_HEALTH_STATE_ROOT_INVALID");
  ensurePrivateDirectory(root, "PROVIDER_HEALTH_STATE_ROOT_INVALID");
  const directory = path.join(root, "state");
  ensurePrivateDirectory(directory, "PROVIDER_HEALTH_STATE_PATH_INVALID");
  const file = path.join(directory, "provider-health.json");
  validatePathComponents(file, "PROVIDER_HEALTH_STATE_PATH_INVALID", { allowMissing: true, leafType: "file" });
  return file;
}

function safeId(value) {
  const text = String(value || "").trim();
  if (!ID_RE.test(text)) throw new Error("PROVIDER_HEALTH_STATE_INVALID");
  return text;
}

function safeTime(value, now) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed) || parsed > now + 60_000) throw new Error("PROVIDER_HEALTH_STATE_INVALID");
  return new Date(parsed).toISOString();
}

function normalizeNode(value, now, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) throw new Error("PROVIDER_HEALTH_STATE_INVALID");
  const allowed = new Set(["status", "checkedAt", "credentials", "quotaGroups"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("PROVIDER_HEALTH_STATE_INVALID");
  const status = String(value.status || "unknown");
  if (!STATUS.has(status)) throw new Error("PROVIDER_HEALTH_STATE_INVALID");
  const checkedAt = safeTime(value.checkedAt, now);
  const result = { status, checkedAt };
  for (const field of ["credentials", "quotaGroups"]) {
    if (value[field] === undefined) continue;
    if (!value[field] || typeof value[field] !== "object" || Array.isArray(value[field])) throw new Error("PROVIDER_HEALTH_STATE_INVALID");
    const entries = Object.entries(value[field]);
    if (entries.length > 32) throw new Error("PROVIDER_HEALTH_STATE_INVALID");
    result[field] = Object.fromEntries(entries.map(([key, item]) => [safeId(key), normalizeNode(item, now, depth + 1)]));
  }
  return result;
}

function normalizeSnapshot(value, now = Date.now(), { prune = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error("PROVIDER_HEALTH_STATE_INVALID");
  const result = {};
  for (const [provider, raw] of entries) {
    const node = normalizeNode(raw, now);
    if (!prune || now - Date.parse(node.checkedAt) <= PROVIDER_HEALTH_RETENTION_MS) result[safeId(provider)] = node;
  }
  return result;
}

function readFile(file, now) {
  const text = readRegularFile(file, "PROVIDER_HEALTH_STATE_PATH_INVALID");
  if (text === null) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw stateError("PROVIDER_HEALTH_STATE_INVALID"); }
  if (parsed?.schemaVersion !== 1 || !parsed.health || Object.keys(parsed).some((key) => !["schemaVersion", "health"].includes(key))) {
    throw stateError("PROVIDER_HEALTH_STATE_INVALID");
  }
  return normalizeSnapshot(parsed.health, now);
}

function mergeNode(left, right) {
  if (!left) return structuredClone(right);
  if (!right) return structuredClone(left);
  const newer = Date.parse(right.checkedAt) >= Date.parse(left.checkedAt) ? right : left;
  const result = { status: newer.status, checkedAt: newer.checkedAt };
  for (const field of ["credentials", "quotaGroups"]) {
    const keys = new Set([...Object.keys(left[field] || {}), ...Object.keys(right[field] || {})]);
    if (keys.size > 0) result[field] = Object.fromEntries([...keys].map((key) => [key, mergeNode(left[field]?.[key], right[field]?.[key])]));
  }
  return result;
}

export function mergeProviderHealthSnapshots(left = {}, right = {}, now = Date.now()) {
  const a = normalizeSnapshot(left, now, { prune: false });
  const b = normalizeSnapshot(right, now, { prune: false });
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return Object.fromEntries([...keys].map((key) => [key, mergeNode(a[key], b[key])]));
}

export function readProviderHealthState(stateRoot, { now = Date.now() } = {}) {
  return readFile(stateFile(stateRoot), Number(now));
}

function writeDurable(file, payload, code = "PROVIDER_HEALTH_STATE_PATH_INVALID") {
  const destination = canonicalAbsolute(file, code);
  const directory = ensurePrivateDirectory(path.dirname(destination), code);
  validatePathComponents(destination, code, { allowMissing: true, leafType: "file" });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor = null;
  try {
    descriptor = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), FILE_MODE);
    const buffer = Buffer.from(payload, "utf8");
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(descriptor, buffer, offset);
    fchmodSync(descriptor, FILE_MODE);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    ensurePrivateDirectory(path.dirname(destination), code);
    validatePathComponents(destination, code, { allowMissing: true, leafType: "file" });
    renameSync(temp, destination);
    const finalDescriptor = openSync(destination, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const finalStat = fstatSync(finalDescriptor);
      if (!finalStat.isFile()) throw stateError(code);
      fchmodSync(finalDescriptor, FILE_MODE);
      fsyncSync(finalDescriptor);
    } finally { closeSync(finalDescriptor); }
    const directoryDescriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try { unlinkSync(temp); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

export function persistProviderHealthState(stateRoot, health, { now = Date.now() } = {}) {
  const currentNow = Number(now);
  const file = stateFile(stateRoot);
  const lock = `${file}.lock`;
  try {
    mkdirSync(lock, { mode: DIRECTORY_MODE });
    validatePathComponents(lock, "PROVIDER_HEALTH_STATE_PATH_INVALID", { allowMissing: false, leafType: "directory" });
    const descriptor = openSync(lock, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    try { fchmodSync(descriptor, DIRECTORY_MODE); } finally { closeSync(descriptor); }
  } catch (error) {
    if (error?.code === "EEXIST") {
      let stat;
      try { stat = lstatSync(lock); } catch (lstatError) { throw lstatError; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw stateError("PROVIDER_HEALTH_STATE_PATH_INVALID");
      const busy = stateError("PROVIDER_HEALTH_STATE_BUSY");
      throw busy;
    }
    throw error;
  }
  try {
    const merged = mergeProviderHealthSnapshots(readFile(file, currentNow), normalizeSnapshot(health, currentNow), currentNow);
    const payload = `${JSON.stringify({ schemaVersion: 1, health: normalizeSnapshot(merged, currentNow) })}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_BYTES) throw new Error("PROVIDER_HEALTH_STATE_INVALID");
    writeDurable(file, payload);
    return merged;
  } finally {
    try {
      const stat = lstatSync(lock);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw stateError("PROVIDER_HEALTH_STATE_PATH_INVALID");
      rmdirSync(lock);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

export function providerHealthStatePath(stateRoot) {
  return stateFile(stateRoot);
}

function readArtifact(file, now) {
  const text = readRegularFile(file, "PROVIDER_HEALTH_ARTIFACT_PATH_INVALID", { required: true });
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw stateError("PROVIDER_HEALTH_ARTIFACT_INVALID"); }
  if (parsed?.schemaVersion !== 1 || !parsed.health || Object.keys(parsed).some((key) => !["schemaVersion", "health"].includes(key))) {
    throw stateError("PROVIDER_HEALTH_ARTIFACT_INVALID");
  }
  return normalizeSnapshot(parsed.health, now);
}

export function exportProviderHealthArtifact(stateRoot, outputFile, { now = Date.now() } = {}) {
  const output = canonicalAbsolute(outputFile, "PROVIDER_HEALTH_ARTIFACT_PATH_INVALID");
  const health = readProviderHealthState(stateRoot, { now });
  if (Object.keys(health).length === 0) return false;
  ensurePrivateDirectory(path.dirname(output), "PROVIDER_HEALTH_ARTIFACT_PATH_INVALID");
  validatePathComponents(output, "PROVIDER_HEALTH_ARTIFACT_PATH_INVALID", { allowMissing: true, leafType: "file" });
  writeDurable(output, `${JSON.stringify({ schemaVersion: 1, health })}\n`, "PROVIDER_HEALTH_ARTIFACT_PATH_INVALID");
  return true;
}

export function importProviderHealthArtifacts(stateRoot, files, { now = Date.now() } = {}) {
  const candidates = Array.isArray(files) ? files : [];
  let merged = readProviderHealthState(stateRoot, { now });
  for (const file of candidates) {
    try {
      merged = mergeProviderHealthSnapshots(merged, readArtifact(file, Number(now)), Number(now));
    } catch (error) {
      if (error?.code === "PROVIDER_HEALTH_ARTIFACT_PATH_INVALID") throw error;
      if (error?.code === "ELOOP" || error?.code === "ENOTDIR") throw stateError("PROVIDER_HEALTH_ARTIFACT_PATH_INVALID");
      throw error;
    }
  }
  if (candidates.length > 0) persistProviderHealthState(stateRoot, merged, { now });
  return merged;
}
