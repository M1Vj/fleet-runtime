import { isSafeRepoPath } from "./directives.mjs";
import { containsSecretLike } from "./pr-memory.mjs";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[a-f0-9]{40}$/i;
const MAX_FILE_CHARS = 60000;
const MAX_SUPPORTING_FILES = 2;
const REVISION_PATH_RE = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const MAX_REVISION_ATTEMPTS = 32;

export function normalizeMaxRevisions(value, fallback = 2) {
  const candidate = Number(value);
  const safeFallback = Number.isSafeInteger(Number(fallback)) && Number(fallback) > 0 ? Number(fallback) : 2;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) return Math.min(MAX_REVISION_ATTEMPTS, safeFallback);
  return Math.min(MAX_REVISION_ATTEMPTS, candidate);
}

function positivePr(value) {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Validate and normalize a workflow revision target before any API call. */
export function validateTarget({ repo, pr, headSha } = {}) {
  const errors = [];
  const normalizedRepo = typeof repo === "string" ? repo.trim() : "";
  const normalizedPr = positivePr(pr);
  const normalizedHead = headSha === undefined || headSha === null || headSha === "" ? undefined : String(headSha).trim();

  if (!REPO_RE.test(normalizedRepo)) errors.push("repo must match owner/name");
  else if (normalizedRepo.split("/")[0] !== "M1Vj") errors.push("repo owner must be M1Vj");
  if (normalizedPr === null) errors.push("pr must be a positive integer");
  if (normalizedHead === undefined) errors.push("headSha is required");
  else if (!SHA_RE.test(normalizedHead)) errors.push("headSha must be a 40-hex SHA");
  return {
    ok: errors.length === 0,
    repo: normalizedRepo,
    pr: normalizedPr,
    headSha: normalizedHead,
    errors,
  };
}

export function targetFromEnv(env = process.env) {
  return validateTarget({
    repo: env.FLEET_REPO,
    pr: env.FLEET_PR_NUMBER,
    headSha: env.FLEET_HEAD_SHA,
  });
}

/**
 * Parse the revision agent's strict FILE + fenced-content protocol. Unlike the
 * shared directive harvester, this accepts normal source/config extensions and
 * leaves path safety to validateRevisionFiles().
 */
export function parseRevisionFiles(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const files = [];
  const errors = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("FILE ")) continue;
    const match = line.match(/^FILE\s+path=([^\s]+)\s*$/);
    if (!match) {
      errors.push(`invalid FILE path declaration at line ${index + 1}`);
      continue;
    }
    const filePath = match[1];
    const openerIndex = index + 1;
    const opener = lines[openerIndex] && lines[openerIndex].trim();
    if (!/^```[^`\r\n]*$/.test(opener || "")) {
      errors.push(`missing fenced content for ${filePath}`);
      continue;
    }
    let closeIndex = openerIndex + 1;
    while (closeIndex < lines.length && lines[closeIndex].trim() !== "```") closeIndex += 1;
    if (closeIndex >= lines.length) {
      errors.push(`unterminated fenced content for ${filePath}`);
      continue;
    }
    files.push({ path: filePath, content: lines.slice(openerIndex + 1, closeIndex).join("\n") });
    index = closeIndex;
  }
  if (files.length === 0 && errors.length === 0 && String(text ?? "").trim()) {
    errors.push("no FILE path blocks found");
  }
  return { files, errors };
}

function workflowPath(filePath) {
  return filePath === ".github/workflows" || filePath.startsWith(".github/workflows/");
}

const FORBIDDEN_REVISION_PATHS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:state|audit|credential|credentials|secret|secrets)(\/|$)/i,
  /^\.github\/(?:workflows|actions)(\/|$)/i,
  /^\.github\/dependabot(?:$|\/|\.ya?ml$)/i,
  /(^|\/)(?:auth|security|migration|migrations|infra|deploy|deployment|login|oauth2?|permissions?|sessions?|access[-_]?control)(\/|[._-]|$)/i,
  /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|pnpm-workspace\.ya?ml|yarn\.lock|bun\.lock(?:b)?|\.npmrc|\.yarnrc(?:\.yml)?|pyproject\.toml|requirements(?:\/.*|[^/]*\.txt)|Pipfile(?:\.lock)?|poetry\.lock|setup\.(?:py|cfg)|Cargo\.toml|Cargo\.lock|go\.(?:mod|sum|work|work\.sum)|Gemfile(?:\.lock)?|[^/]+\.gemspec|composer\.json|composer\.lock|pom\.xml|mvnw|\.mvn(?:\/.*|$)|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle(?:\.lockfile|\/.*|$)|gradle\.properties|gradlew|Dockerfile(?:\..*)?|docker-compose(?:\..*)?|compose\.(?:ya?ml)|Makefile|\.nvmrc|action\.ya?ml)$/i,
];

export function isRevisionPathPolicySafe(filePath) {
  if (!isSafeRepoPath(filePath) || !REVISION_PATH_RE.test(String(filePath))) return false;
  return !FORBIDDEN_REVISION_PATHS.some((pattern) => pattern.test(filePath));
}

/**
 * A path is a safe supporting path only when it is safe in the shared directive
 * validator and not a workflow path. Workflow files may be revised only when
 * they were already part of the PR's original changed-path set.
 */
export function isSafeSupportingPath(filePath, changedPaths = []) {
  if (!isRevisionPathPolicySafe(filePath)) return false;
  return !workflowPath(filePath) && changedPaths.includes(filePath) === false;
}

/**
 * Enforce the maker-checker output allowlist: existing changed files are valid,
 * with at most two additional safe supporting files. No model output is written
 * until this pure validation returns ok.
 */
export function validateRevisionFiles(files, changedPaths = [], { existingPaths = [] } = {}) {
  const errors = [];
  const changed = new Set(
    (Array.isArray(changedPaths) ? changedPaths : [])
      .filter((value) => typeof value === "string")
      .map((value) => value.trim()),
  );
  const outputs = Array.isArray(files) ? files : [];
  const seen = new Set();
  const supportingPaths = [];
  const existing = new Set((Array.isArray(existingPaths) ? existingPaths : []).filter((value) => typeof value === "string"));

  if (!Array.isArray(files) || files.length === 0) errors.push("revision must contain at least one file");
  for (const file of outputs) {
    const filePath = file && typeof file.path === "string" ? file.path.replace(/^\.\//, "") : "";
    if (!filePath) {
      errors.push("file path is required");
      continue;
    }
    if (seen.has(filePath)) errors.push(`duplicate path: ${filePath}`);
    seen.add(filePath);
    if (!isRevisionPathPolicySafe(filePath)) errors.push(`unsafe revision path: ${filePath}`);
    if (typeof file.content !== "string") errors.push(`content must be text: ${filePath}`);
    else if (file.content.length > MAX_FILE_CHARS) errors.push(`too large: ${filePath} (${file.content.length})`);

    const alreadyChanged = changed.has(filePath);
    if (workflowPath(filePath)) errors.push(`workflow path rejected: ${filePath}`);
    if (!alreadyChanged) {
      if (!isSafeSupportingPath(filePath, changedPaths)) errors.push(`unsafe supporting path: ${filePath}`);
      else if (existing.has(filePath)) errors.push(`supporting path already exists at exact head: ${filePath}`);
      else supportingPaths.push(filePath);
    }
  }
  if (supportingPaths.length > MAX_SUPPORTING_FILES) {
    errors.push(`at most ${MAX_SUPPORTING_FILES} supporting files are allowed`);
  }
  return {
    ok: errors.length === 0,
    errors,
    changedPaths: [...changed],
    supportingPaths,
    files: outputs.map((file) => ({ path: file && typeof file.path === "string" ? file.path.replace(/^\.\//, "") : "", content: file && typeof file.content === "string" ? file.content : "" })),
  };
}

const PRIVATE_OUTPUT_PATTERNS = [
  /(?:^|[\\/])(?:state-control|pr-memory\.jsonl|gateway-health\.json|KILL_SWITCH)(?:$|[\\/])/i,
  /(?:^|[\\/])(?:credentials?|secrets?|private|audit)(?:$|[\\/])/i,
  /(?:\/Users\/|\/home\/|\/runner\/work\/)/i,
  /\b(?:FLEET_GH_TOKEN|FLEET_OPENCODE_AUTH|OPENCODE_AUTH_CONTENT|GH_TOKEN)\b/i,
  /(?:read|cat|print|dump|copy|exfiltrat)[^\n]{0,80}(?:state-control|pr-memory|credentials?|secrets?)/i,
];

/** Reject secret/private-state material before creating any Git object. */
export function screenRevisionOutput(files) {
  const errors = [];
  for (const file of Array.isArray(files) ? files : []) {
    const content = String(file && file.content || "");
    if (containsSecretLike(content)) errors.push(`secret-like revision content: ${file.path || "<unknown>"}`);
    if (PRIVATE_OUTPUT_PATTERNS.some((pattern) => pattern.test(content))) errors.push(`private-state revision content: ${file.path || "<unknown>"}`);
  }
  return { ok: errors.length === 0, errors: errors.slice(0, 8) };
}

export function assertTarget(target) {
  const result = validateTarget(target);
  if (!result.ok) {
    const error = new Error(`INVALID_REVISION_TARGET ${result.errors.join("; ")}`);
    error.code = 5;
    error.validation = result;
    throw error;
  }
  return result;
}

export function headRepositoryMatches(pr, targetRepo) {
  return Boolean(pr && pr.head && pr.head.repo && pr.head.repo.full_name === targetRepo);
}

export function validatePrDiffFiles(files, { maxFiles = 100 } = {}) {
  const errors = [];
  if (!Array.isArray(files)) return { ok: false, errors: ["PR files response must be an array"] };
  if (files.length >= maxFiles) errors.push(`PR has ${files.length} files; human review required at ${maxFiles}+`);
  files.forEach((file, index) => {
    if (!file || typeof file.filename !== "string" || !file.filename) errors.push(`PR file ${index + 1} has no filename`);
    if (!file || typeof file.patch !== "string" || file.patch.trim().length === 0) errors.push(`PR file ${index + 1} has no usable patch`);
  });
  return { ok: errors.length === 0, errors };
}
