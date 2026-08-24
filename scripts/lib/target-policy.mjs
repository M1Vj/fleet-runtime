import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const TARGET_OWNER = "M1Vj";
export const RUNTIME_REPO = `${TARGET_OWNER}/fleet-runtime`;
export const FLEET_REF_PREFIX = "fleet/";
export const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/i;
export const MAX_REPO_CHARS = 120;
export const MAX_REF_CHARS = 120;
export const MAX_POLICY_ERRORS = 8;
export const PRIVATE_REPOS = new Set([
  `${TARGET_OWNER}/vj-knowledge-base`,
  `${TARGET_OWNER}/fleet-control`,
]);

function bounded(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function fullRepo(value) {
  const raw = bounded(value, MAX_REPO_CHARS);
  if (!raw) return "";
  if (raw.includes("/")) return raw;
  return `${TARGET_OWNER}/${raw}`;
}

function ownerAndName(value) {
  const repo = fullRepo(value);
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra || owner !== TARGET_OWNER || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  return `${owner}/${name}`;
}

function targetEntries(raw) {
  const entries = [];
  const add = (value, tier) => {
    if (typeof value === "string") {
      entries.push({ repo: fullRepo(value), tier: tier || "tier1" });
      return;
    }
    if (!value || typeof value !== "object") return;
    const entryTier = String(value.tier || tier || "").toLowerCase();
    const candidate = value.repo || value.full_name || value.fullName || value.name || value.slug;
    if (candidate) entries.push({ repo: fullRepo(candidate), tier: entryTier || "tier1" });
  };
  if (Array.isArray(raw)) raw.forEach((entry) => add(entry));
  else if (raw && typeof raw === "object") {
    if (Array.isArray(raw.tier1)) raw.tier1.forEach((entry) => add(entry, "tier1"));
    if (Array.isArray(raw.targets)) raw.targets.forEach((entry) => add(entry, entry && entry.tier));
    if (Array.isArray(raw.repos)) raw.repos.forEach((entry) => add(entry, entry && entry.tier));
    if (raw.targets && typeof raw.targets === "object" && !Array.isArray(raw.targets)) {
      Object.entries(raw.targets).forEach(([name, entry]) => add(typeof entry === "object" ? { ...entry, name } : name, entry && entry.tier));
    }
    if (raw.repos && typeof raw.repos === "object" && !Array.isArray(raw.repos)) {
      Object.entries(raw.repos).forEach(([name, entry]) => add(typeof entry === "object" ? { ...entry, name } : name, entry && entry.tier));
    }
    if (raw.tier1 && typeof raw.tier1 === "object" && !Array.isArray(raw.tier1)) {
      Object.entries(raw.tier1).forEach(([name, entry]) => add(typeof entry === "object" ? { ...entry, name } : name, "tier1"));
    }
  }
  return entries
    .map((entry) => ({ ...entry, repo: ownerAndName(entry.repo) }))
    .filter((entry) => entry.repo);
}

export function readTier1Repos({ stateRoot, targets } = {}) {
  const rawTargets = targets !== undefined
    ? targets
    : (() => {
      const root = String(stateRoot || "");
      const file = root ? path.join(root, "state", "targets.json") : "";
      if (!file || !existsSync(file)) return null;
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    })();
  return new Set(targetEntries(rawTargets).filter((entry) => entry.tier === "tier1").map((entry) => entry.repo));
}

export function normalizeTargetInput(input = {}) {
  const repoRaw = String(input.repo ?? "").slice(0, MAX_REPO_CHARS);
  const repo = ownerAndName(repoRaw);
  const prText = String(input.pr ?? input.prNumber ?? "").slice(0, 20);
  const pr = /^\d+$/.test(prText) ? Number(prText) : Number.NaN;
  const headSha = String(input.headSha ?? input.head_sha ?? "").slice(0, 80).toLowerCase();
  const errors = [];
  if (!repoRaw || !repo || repoRaw !== repoRaw.trim()) errors.push("repo must be an M1Vj repository name");
  if (!Number.isSafeInteger(pr) || pr <= 0) errors.push("pr must be a positive integer");
  if (!HEAD_SHA_PATTERN.test(headSha)) errors.push("head_sha must be exactly 40 hexadecimal characters");
  return {
    ok: errors.length === 0,
    repo: repo || repoRaw,
    pr: Number.isSafeInteger(pr) ? pr : 0,
    headSha,
    errors: errors.slice(0, MAX_POLICY_ERRORS),
  };
}

export function isAllowedRepo(repo, { stateRoot, targets } = {}) {
  const normalized = ownerAndName(repo);
  if (!normalized) return false;
  if (PRIVATE_REPOS.has(normalized)) return false;
  if (normalized === RUNTIME_REPO) return true;
  return readTier1Repos({ stateRoot, targets }).has(normalized);
}

function headRepo(pr) {
  return pr && pr.head && pr.head.repo && pr.head.repo.full_name;
}

export function evaluateTargetPolicy({ target, pr, files, stateRoot, targets, repoMeta } = {}) {
  const normalized = normalizeTargetInput(target || {});
  const errors = [...normalized.errors];
  if (normalized.ok && !isAllowedRepo(normalized.repo, { stateRoot, targets })) {
    errors.push("repo is not in the tier1 fleet target allowlist");
  }
  if (!pr || typeof pr !== "object") {
    errors.push("pull request metadata unavailable");
  } else {
    if (pr.state !== "open") errors.push("pull request is not open");
    if (!pr.user || pr.user.login !== TARGET_OWNER) errors.push("pull request author must be M1Vj");
    if (!pr.head || !String(pr.head.ref || "").startsWith(FLEET_REF_PREFIX)) errors.push("head ref must start with fleet/");
    if (headRepo(pr) !== normalized.repo) errors.push("pull request head must be a same-repo nonfork head");
    if (!pr.head || String(pr.head.sha || "").toLowerCase() !== normalized.headSha) errors.push("pull request head SHA does not match the mandatory target SHA");
    if (pr.head && (pr.head.fork === true || pr.head.repo && pr.head.repo.fork === true)) errors.push("fork-origin pull request heads are not eligible");
    if (!repoMeta || repoMeta.full_name !== normalized.repo || !repoMeta.default_branch) errors.push("target repository metadata mismatch");
    if (!pr.base || !pr.base.repo || pr.base.repo.full_name !== normalized.repo) errors.push("pull request base must be the target repository");
    if (repoMeta && repoMeta.default_branch && (!pr.base || pr.base.ref !== repoMeta.default_branch)) errors.push("pull request base must be the repository default branch");
  }
  const fileResult = validateFilesResponse(files);
  if (!fileResult.ok) errors.push(...fileResult.errors);
  return {
    ok: errors.length === 0,
    target: normalized,
    errors: errors.slice(0, MAX_POLICY_ERRORS),
    files: fileResult,
  };
}

export function validateFilesResponse(files) {
  const errors = [];
  if (!Array.isArray(files)) errors.push("pull request file response unavailable");
  else {
    if (files.length === 0) errors.push("pull request file response empty");
    if (files.length >= 100) errors.push("pull request has 100 or more files; human review required");
    files.forEach((file, index) => {
      if (!file || typeof file.filename !== "string" || !file.filename) errors.push(`file ${index + 1} has no filename`);
      if (!file || typeof file.patch !== "string" || file.patch.length === 0) errors.push(`patch unavailable for file ${index + 1}`);
    });
  }
  return { ok: errors.length === 0, errors: errors.slice(0, MAX_POLICY_ERRORS) };
}

export function isFleetRef(ref) {
  return bounded(ref, MAX_REF_CHARS).startsWith(FLEET_REF_PREFIX);
}
