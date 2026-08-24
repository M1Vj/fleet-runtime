import { isSafeRepoPath } from "./directives.mjs";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[a-f0-9]{40}$/i;
const MAX_FILE_CHARS = 60000;
const MAX_SUPPORTING_FILES = 2;

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
  if (normalizedPr === null) errors.push("pr must be a positive integer");
  if (normalizedHead !== undefined && !SHA_RE.test(normalizedHead)) errors.push("headSha must be a 40-hex SHA");
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

/**
 * A path is a safe supporting path only when it is safe in the shared directive
 * validator and not a workflow path. Workflow files may be revised only when
 * they were already part of the PR's original changed-path set.
 */
export function isSafeSupportingPath(filePath, changedPaths = []) {
  if (!isSafeRepoPath(filePath)) return false;
  if (workflowPath(filePath)) return changedPaths.includes(filePath);
  return true;
}

/**
 * Enforce the maker-checker output allowlist: existing changed files are valid,
 * with at most two additional safe supporting files. No model output is written
 * until this pure validation returns ok.
 */
export function validateRevisionFiles(files, changedPaths = []) {
  const errors = [];
  const changed = new Set(
    (Array.isArray(changedPaths) ? changedPaths : [])
      .filter((value) => typeof value === "string")
      .map((value) => value.trim()),
  );
  const outputs = Array.isArray(files) ? files : [];
  const seen = new Set();
  const supportingPaths = [];

  if (!Array.isArray(files) || files.length === 0) errors.push("revision must contain at least one file");
  for (const file of outputs) {
    const filePath = file && typeof file.path === "string" ? file.path.replace(/^\.\//, "") : "";
    if (!filePath) {
      errors.push("file path is required");
      continue;
    }
    if (seen.has(filePath)) errors.push(`duplicate path: ${filePath}`);
    seen.add(filePath);
    if (!isSafeRepoPath(filePath)) errors.push(`unsafe path: ${filePath}`);
    if (typeof file.content !== "string") errors.push(`content must be text: ${filePath}`);
    else if (file.content.length > MAX_FILE_CHARS) errors.push(`too large: ${filePath} (${file.content.length})`);

    const alreadyChanged = changed.has(filePath);
    if (workflowPath(filePath) && !alreadyChanged) errors.push(`workflow path must already be changed: ${filePath}`);
    if (!alreadyChanged) {
      if (!isSafeSupportingPath(filePath, changedPaths)) errors.push(`unsafe supporting path: ${filePath}`);
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
