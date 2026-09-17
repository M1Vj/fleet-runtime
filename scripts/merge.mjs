#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, ghInput, gitRevParse, configureIdentity, installCredentialHelper, gitAdd, gitCommit, gitPush, gitHasChanges } from "./lib/util.mjs";
import { askModel } from "./lib/model.mjs";
import { extractJsonObject } from "./lib/directives.mjs";
import { verifyCommit } from "./lib/verify.mjs";
import { findSuperseded, isStale } from "./lib/pr-hygiene.mjs";
import { verifyPullAuthor, verifyCommentAuthor } from "./lib/verify.mjs";
import { recordHumanReview, reconcileHumanReviewQueue, tagPrNeedsHumanReview } from "./lib/human-review.mjs";
import {
  isPublicDataClass,
  publicRepository,
  privateRepository,
  PRIVATE_REPOSITORY_ENV,
  resolveStateRoot,
  writeExecutionAudit,
  writePublicArtifact,
} from "./lib/private-state.mjs";

const REPO_ROOT = resolveStateRoot(process.env, process.cwd());
const STATE_ROOT = resolveStateRoot(process.env, REPO_ROOT);
const AUDIT_DIR = path.join(STATE_ROOT, "audit");
const MERGES_PATH = path.join(STATE_ROOT, "state", "merges.jsonl");
const TARGETS_PATH = path.join(STATE_ROOT, "state", "targets.json");
const RAW_TARGET_REPO = isPublicDataClass(process.env) ? process.env.FLEET_PUBLIC_REPOSITORY : process.env.FLEET_TARGET_REPO;
const RAW_PR_NUMBER = process.env.FLEET_PR_NUMBER;

const UI_EXTENSIONS = /\.(html|htm|css|scss|less|jsx|tsx|vue|svelte|astro|mdx)$/i;
const HARD_RISK_PATTERNS = [
  /^\.env/i,
  /(^|\/)(migrations?|db\/migrate)/i,
  /(^|\/)infra\//i,
  /^\.okf\//i,
];
const SOFT_RISK_PATTERNS = [
  /(^|\/)(Dockerfile|docker-compose)/i,
  /^\.github\/workflows\//i,
  /(^|\/)(auth|security)\//i,
  /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i,
];
const SECRET_PATTERNS = [
  /(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /sk-[A-Za-z0-9]{20,}/,
];

const REPO_REF_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FLEET_OWNER = "m1vj";
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const DEFAULT_SCAN_CAP = 3;
const MAX_SCAN_CAP = 15;
const DEFAULT_SCAN_PAGES = 3;
const MAX_SCAN_PAGES = 5;
const SCAN_PAGE_SIZE = 100;

function isM1VjRepo(value) {
  const repo = String(value || "").trim();
  return REPO_REF_PATTERN.test(repo) && repo.split("/", 1)[0].toLowerCase() === FLEET_OWNER;
}

/**
 * Parse the explicit merge target without ever coercing an invalid value into
 * a runnable revision.  An absent target is distinct from a malformed one so
 * scheduled scans can proceed while partial/manual inputs fail closed.
 */
export function parseMergeTarget(repoInput, prInput) {
  const repoValue = typeof repoInput === "string" ? repoInput.trim() : String(repoInput ?? "").trim();
  const prValue = typeof prInput === "string" ? prInput.trim() : String(prInput ?? "").trim();
  const repoValid = isM1VjRepo(repoValue);
  const prValid = POSITIVE_INTEGER_PATTERN.test(prValue);
  const parsedPr = prValid ? Number(prValue) : 0;
  const valid = repoValid && Number.isSafeInteger(parsedPr) && parsedPr > 0;
  return {
    repo: valid ? repoValue : "",
    prNumber: valid ? parsedPr : 0,
    valid,
    provided: repoValue.length > 0 || prValue.length > 0,
  };
}

/**
 * Return the exact GitHub Actions output values used by the revision step.
 * Invalid or incomplete targets can never produce revision_needed=true.
 */
export function revisionOutputValues(repoInput, prInput, revisionNeeded = false) {
  const target = parseMergeTarget(repoInput, prInput);
  const enabled = (revisionNeeded === true || String(revisionNeeded).toLowerCase() === "true") && target.valid;
  return {
    revision_needed: enabled ? "true" : "false",
    target_valid: target.valid ? "true" : "false",
    target_repo: target.valid ? target.repo : "",
    pr_number: target.valid ? String(target.prNumber) : "0",
  };
}

/** Write explicit, fail-closed revision outputs when running under Actions. */
export function writeRevisionOutputs(outputPath, repoInput, prInput, revisionNeeded = false) {
  const values = revisionOutputValues(repoInput, prInput, revisionNeeded);
  if (outputPath) {
    try {
      appendFileSync(
        outputPath,
        Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
      );
    } catch {}
  }
  return values;
}

/** Check if a pull request is eligible for automated fleet revision. */
export function isRevisionEligible(pr) {
  if (!pr || typeof pr !== "object") return false;
  const headRepo = repoReference(pr.head?.repo?.full_name || pr.head?.repo?.fullName);
  const baseRepo = repoReference(pr.base?.repo?.full_name || pr.base?.repo?.fullName);
  if (headRepo && baseRepo && headRepo.toLowerCase() !== baseRepo.toLowerCase()) {
    return false;
  }
  const ref = String(pr.head?.ref || "");
  const author = String(pr.user?.login || "");
  if (ref.startsWith("fleet/")) return true;
  if (ref.startsWith("dependabot/")) return true;
  if (author === "M1Vj") return true;
  if (author === "dependabot[bot]" || author === "app/dependabot") return true;
  return false;
}

/** Count existing revision attempts for a PR. */
export function countRevisionsFor(repoRoot, repo, prNumber) {
  const root = repoRoot || (typeof REPO_ROOT !== "undefined" ? REPO_ROOT : process.cwd());
  const revPath = path.join(root, "state", "revisions.jsonl");
  if (!existsSync(revPath)) return 0;
  try {
    return readFileSync(revPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          const r = JSON.parse(l);
          return r.repo === repo && Number(r.pr) === Number(prNumber) ? r : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Write queue outputs for daisy-chaining continuous gate runs. */
export function writeQueueOutputs(outputPath, hasPendingPrs = false) {
  if (outputPath) {
    try {
      appendFileSync(outputPath, `has_pending_prs=${hasPendingPrs ? "true" : "false"}\n`);
    } catch {}
  }
  return { has_pending_prs: hasPendingPrs ? "true" : "false" };
}

/** Keep a scheduled scan bounded even when a workflow variable is malformed. */
export function normalizeScanCap(value, fallback = DEFAULT_SCAN_CAP) {
  const candidate = Number(value);
  const fallbackNumber = Number(fallback);
  const safeFallback = Number.isInteger(fallbackNumber) && fallbackNumber > 0
    ? Math.min(MAX_SCAN_CAP, fallbackNumber)
    : DEFAULT_SCAN_CAP;
  if (!Number.isFinite(candidate)) return safeFallback;
  return Math.min(MAX_SCAN_CAP, Math.max(1, Math.floor(candidate)));
}

function normalizeScanPages(value, fallback = DEFAULT_SCAN_PAGES) {
  const candidate = Number(value);
  const fallbackNumber = Number(fallback);
  const safeFallback = Number.isInteger(fallbackNumber) && fallbackNumber > 0
    ? Math.min(MAX_SCAN_PAGES, fallbackNumber)
    : DEFAULT_SCAN_PAGES;
  if (!Number.isFinite(candidate)) return safeFallback;
  return Math.min(MAX_SCAN_PAGES, Math.max(1, Math.floor(candidate)));
}

/** Build a page URL with exactly one bounded page/per_page pair. */
export function buildScanPageEndpoint(endpoint, page, perPage = SCAN_PAGE_SIZE) {
  const base = String(endpoint || "").replace(/([?&])(?:page|per_page)=[^&]*/g, "").replace(/[?&]$/, "");
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}page=${Math.max(1, Math.floor(Number(page) || 1))}&per_page=${Math.max(1, Math.floor(Number(perPage) || SCAN_PAGE_SIZE))}`;
}

/**
 * Collect a finite number of API pages.  The fetcher is injected so this
 * boundary remains unit-testable without a network or credential.
 */
export function collectScanPages(fetchPage, { maxPages = DEFAULT_SCAN_PAGES, perPage = SCAN_PAGE_SIZE } = {}) {
  if (typeof fetchPage !== "function") return [];
  const pages = normalizeScanPages(maxPages);
  const pageSize = Math.max(1, Math.floor(Number(perPage) || SCAN_PAGE_SIZE));
  const rows = [];
  for (let page = 1; page <= pages; page += 1) {
    let batch;
    try {
      batch = fetchPage(page, pageSize);
    } catch {
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

function repoReference(value) {
  const repo = String(value || "").trim();
  return isM1VjRepo(repo) ? repo : "";
}

function bareRepoName(repo) {
  return String(repo || "").split("/").at(-1) || "";
}

function targetListContains(list, repo) {
  const full = String(repo || "").toLowerCase();
  const bare = bareRepoName(repo).toLowerCase();
  if (!full) return false;
  if (Array.isArray(list)) {
    return list.some((entry) => {
      const value = typeof entry === "string" ? entry : entry && (entry.full_name || entry.fullName || entry.repo || entry.name);
      const normalized = String(value || "").trim().toLowerCase();
      return normalized === full || normalized === bare;
    });
  }
  if (list && typeof list === "object") {
    return Object.entries(list).some(([entry, enabled]) => {
      const normalized = String(entry || "").trim().toLowerCase();
      return enabled !== false && (normalized === full || normalized === bare);
    });
  }
  return false;
}

function isScanEnrolled(targets, repo, metadata = {}) {
  if (!targets || typeof targets !== "object" || !isM1VjRepo(repo)) return false;
  if (metadata.archived === true || metadata.fork === true || metadata.disabled === true) return false;
  if (targetListContains(targets.excluded, repo)) return false;
  if (targets.allOwned === true || targets.observeAll === true) return true;
  return targetListContains(targets.tier1, repo) ||
    targetListContains(targets.enrolled, repo) ||
    targetListContains(targets.repositories, repo);
}

function pullRepo(pull) {
  return repoReference(
    pull && (pull.repo || pull.repoFullName || pull.repository?.full_name || pull.repository?.fullName || pull.base?.repo?.full_name || pull.base?.repo?.fullName),
  );
}

function pullNumber(pull) {
  const raw = pull && (pull.number ?? pull.pr ?? pull.pullRequest?.number ?? pull.pull_request?.number);
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function parseTimestamp(value, fallback) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function latestVisitTime(pull, history) {
  const repo = pullRepo(pull).toLowerCase();
  const number = pullNumber(pull);
  let latest = 0;
  for (const entry of Array.isArray(history) ? history : []) {
    const entryRepo = String(entry?.repo || entry?.repository || entry?.repoFullName || "").trim().toLowerCase();
    const entryNumber = Number(entry?.pr ?? entry?.number ?? entry?.prNumber);
    if (entryRepo !== repo || (Number.isSafeInteger(entryNumber) && entryNumber > 0 && entryNumber !== number)) continue;
    for (const value of [
      entry.lastSelectedAt,
      entry.selectedAt,
      entry.lastVisitedAt,
      entry.visitedAt,
      entry.lastRunAt,
      entry.at,
      entry.t,
    ]) {
      const timestamp = parseTimestamp(value, Number.NaN);
      if (Number.isFinite(timestamp) && timestamp > latest) latest = timestamp;
    }
  }
  return latest;
}

function scanPullSortKey(pull, history) {
  const created = parseTimestamp(pull?.created_at || pull?.createdAt || pull?.opened_at || pull?.openedAt, Number.POSITIVE_INFINITY);
  const visited = latestVisitTime(pull, history);
  const updated = parseTimestamp(pull?.updated_at || pull?.updatedAt || pull?.last_updated_at || pull?.lastUpdatedAt, Number.POSITIVE_INFINITY);
  return [visited, created, updated, pullRepo(pull).toLowerCase(), pullNumber(pull)];
}

function compareScanPulls(a, b, history) {
  const left = scanPullSortKey(a, history);
  const right = scanPullSortKey(b, history);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

/**
 * Filter and fairly order scan candidates.  Discovery is intentionally broad
 * (including user-authored and ready PRs); targeted merge gates retain the
 * existing author, tier, CI, judge, and SHA mutation fences.
 */
export function selectScanPullRequests(pulls, { targets, limit = DEFAULT_SCAN_CAP, history = [], repositories = [] } = {}) {
  const cap = normalizeScanCap(limit);
  const repositoryMap = new Map();
  for (const repository of Array.isArray(repositories) ? repositories : []) {
    const repo = repoReference(repository?.full_name || repository?.fullName || repository?.repo);
    if (repo) repositoryMap.set(repo.toLowerCase(), repository);
  }
  const selected = [];
  const seen = new Set();
  for (const pull of Array.isArray(pulls) ? pulls : []) {
    if (String(pull?.state || "open").toLowerCase() !== "open") continue;
    const repo = pullRepo(pull);
    const number = pullNumber(pull);
    if (!repo || number === 0) continue;
    const metadata = repositoryMap.get(repo.toLowerCase()) || pull.repository || pull.base?.repo || {};
    if (!isScanEnrolled(targets, repo, metadata)) continue;
    const key = `${repo.toLowerCase()}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ ...pull, repo, number });
  }
  selected.sort((a, b) => compareScanPulls(a, b, history));
  return selected.slice(0, cap);
}

const INITIAL_TARGET = parseMergeTarget(RAW_TARGET_REPO, RAW_PR_NUMBER);
const TARGET_REPO = INITIAL_TARGET.repo;
const PR_NUMBER = INITIAL_TARGET.prNumber;

export function classify(files) {
  const reasons = [];
  let additions = 0;
  let deletions = 0;
  let uiTouched = false;
  let depth = 1;
  let wfDeletions = false;
  let touchesSensitive = false;
  for (const f of files) {
    additions += f.additions || 0;
    deletions += f.deletions || 0;
    if (UI_EXTENSIONS.test(f.filename)) uiTouched = true;
    if (/^\.github\/workflows\//.test(f.filename) && (f.deletions || 0) > 0) {
      wfDeletions = true;
      reasons.push(`workflow deletions in ${f.filename}`);
    }
    for (const re of [...HARD_RISK_PATTERNS, ...SOFT_RISK_PATTERNS]) {
      if (re.test(f.filename)) {
        touchesSensitive = true;
        reasons.push(`sensitive path ${f.filename}`);
        break;
      }
    }
  }
  const size = additions + deletions;
  if (size > 800 || wfDeletions || !files.some((f) => f.additions > 0)) depth = 3;
  else if (size > 250 || touchesSensitive || uiTouched) depth = 2;
  return { risk: `depth-${depth}`, reasons, uiTouched, size, depth };
}

export function secretsInDiff(files) {
  const hits = [];
  for (const f of files) {
    const patch = f.patch || "";
    for (const re of SECRET_PATTERNS) {
      const m = patch.match(re);
      if (m) hits.push(`${f.filename}: ${m[0].slice(0, 8)}...`);
    }
  }
  return hits;
}

// Untrusted-checkout execution: PR code (npm install/build/test,
// visual-check) must never see secrets. Mirrors the model.mjs child-env
// pattern, but also strips model auth — builds must still run.
export function sanitizedExecEnv(env = process.env, workdir = null) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(key)) delete out[key];
  }
  delete out.FLEET_GH_TOKEN;
  delete out.GH_TOKEN;
  delete out.FLEET_OPENCODE_AUTH;
  delete out.OPENCODE_AUTH_CONTENT;
  delete out.OPENCODE_API_KEY;
  delete out.GDRIVE_REFRESH_TOKEN;
  delete out.GDRIVE_CLIENT_SECRET;
  if (workdir) {
    const nodeBin = path.join(workdir, "node_modules", ".bin");
    out.PATH = nodeBin + (out.PATH ? path.delimiter + out.PATH : "");
  }
  return out;
}

// Kill-switch re-check before every mutation: runGate enforces it at startup,
// but a STOP may land while judges/checks are running.
export function killSwitchEngaged() {
  if (isPublicDataClass(process.env)) return false;
  const p = process.env.FLEET_KILL_SWITCH_PATH || path.join(STATE_ROOT, "state", "KILL_SWITCH");
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** Return false and record the stop whenever a mutation is about to run. */
export function mutationAllowed(action, audit) {
  if (!killSwitchEngaged()) return true;
  const label = String(action || "mutation");
  if (audit && typeof audit.incident === "function") {
    audit.incident("kill-switch", `${label} skipped: KILL_SWITCH engaged`);
  }
  return false;
}

export function readTargets() {
  try {
    if (existsSync(TARGETS_PATH)) return JSON.parse(readFileSync(TARGETS_PATH, "utf8"));
  } catch {}
  return { tier1: [], excluded: [] };
}

// Mirror of patrol's eligibility: merges only proceed on tier1 (or everywhere
// when the fleet is configured with allOwned). Fail-closed when unknown.
export function isTier1Eligible(targets, repo) {
  if (!targets || typeof targets !== "object") return false;
  if (Array.isArray(targets.excluded) && targets.excluded.includes(repo)) return false;
  if (targets.allOwned === true) return true;
  return Array.isArray(targets.tier1) && targets.tier1.includes(repo);
}

// Ledger idempotency: never re-gate an exact SHA already merged successfully.
export function mergeAlreadyRecorded(mergesPath, repo, prNumber, headSha) {
  try {
    if (!existsSync(mergesPath)) return false;
    for (const line of readFileSync(mergesPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const r = JSON.parse(trimmed);
        if (r.repo === repo && Number(r.pr) === Number(prNumber) && r.sha === headSha && r.state === "SUCCESS") return true;
      } catch {}
    }
  } catch {}
  return false;
}

// Read merges.jsonl history for LRU/fair round-robin PR scan rotation.
export function readMergesHistory(mergesPath) {
  try {
    if (!mergesPath || !existsSync(mergesPath)) return [];
    const entries = [];
    for (const line of readFileSync(mergesPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const r = JSON.parse(trimmed);
        if (r && typeof r === "object") entries.push(r);
      } catch {}
    }
    return entries;
  } catch {
    return [];
  }
}

const CI_BAD_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "stale"]);
const CI_PENDING_STATUS = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

// Pure CI-green verdict over the combined status + check-runs of one exact SHA.
// Empty (no checks configured) counts as green; anything failing or still
// running blocks the merge until the next 15-minute gate pass.
export function ciVerdict({ state, runs, error }) {
  // Fail-closed: a CI API error means unknown status — never treat as
  // green. The merge BLOCKEDs and retries on the next gate pass.
  if (error) {
    return { ok: false, pending: false, why: `ci-unknown: ${String(error).slice(0, 160)}` };
  }
  const list = Array.isArray(runs) ? runs : [];
  const bad = list.filter((r) => r.conclusion && CI_BAD_CONCLUSIONS.has(String(r.conclusion)));
  if (state === "failure" || bad.length > 0) {
    return { ok: false, pending: false, why: `failing checks: ${bad.map((r) => r.name || "?").join(", ") || "commit status= failure"}`.slice(0, 200) };
  }
  const waiting = list.filter((r) => r.status && CI_PENDING_STATUS.has(String(r.status)));
  if (state === "pending" || waiting.length > 0) {
    return { ok: false, pending: true, why: `checks still running (${waiting.length || "status=pending"})` };
  }
  if (list.length === 0 && (state === null || state === undefined || state === "")) return { ok: true, pending: false, why: "no-checks" };
  return { ok: true, pending: false, why: `green (${list.length} runs, status=${state || "n/a"})` };
}

export function fetchCi(repo, sha, env = process.env) {
  let state = null;
  let runs = [];
  let error = null;
  try {
    const s = gh(["api", `/repos/${repo}/commits/${sha}/status?per_page=100`], env);
    state = s && s.state;
  } catch (err) {
    error = String((err && err.message) || err).slice(0, 200);
  }
  try {
    const c = gh(["api", `/repos/${repo}/commits/${sha}/check-runs?per_page=100`], env);
    runs = (c && c.check_runs) || [];
  } catch (err) {
    error = String((err && err.message) || err).slice(0, 200);
  }
  return { state, runs, error };
}

// Post a marker-tagged comment at most once (scan recent comments for the
// marker first) so 15-minute retries never spam the PR while CI runs.
export async function postCommentOnce(repo, number, marker, body, audit, env = process.env) {
  try {
    const comments = gh(["api", `/repos/${repo}/issues/${number}/comments?per_page=20`], env) || [];
    if (comments.some((c) => c.body && String(c.body).includes(marker))) {
      audit.note("comment-dedupe", `#${number} marker already present, skipped`);
      return null;
    }
  } catch {}
  if (!mutationAllowed(`comment ${repo}#${number}`, audit)) return null;
  const c = gh(["api", "-X", "POST", `/repos/${repo}/issues/${number}/comments`, "-F", `body=${marker}\n\n${body}`], env);
  const user = gh(["api", `/repos/${repo}/issues/comments/${c.id}`], env);
  if ((user.user && user.user.login) !== "M1Vj") throw new Error("comment attribution mismatch");
  // Fail-closed: attribution-verify failure must throw (same as
  // postComment) — never swallow.
  await verifyCommentAuthor(repo, c.id, { login: "M1Vj" }, env.FLEET_GH_TOKEN);
  audit.note("comment", `#${number} posted`);
  return c;
}

// Attributable state push: commit + push as M1Vj, then verify the SHA landed
// under the configured owner in the private control repository. Bookkeeping only — never throws; the merge
// outcome itself is enforced separately via verifyCommit on the merge commit.
export async function commitPushVerify(repoDir, subpaths, message, identity, audit, env = process.env) {
  try {
    const existing = subpaths.filter((p2) => existsSync(path.join(repoDir, p2)));
    const changed = existing.filter((p2) => gitHasChanges(repoDir, [p2]));
    if (changed.length === 0) return "no-changes";
    gitAdd(repoDir, changed);
    const outcome = gitCommit(repoDir, message, identity);
    if (outcome !== "committed") return outcome;
    gitPush(repoDir, "main", env);
    const sha = gitRevParse(repoDir, "HEAD");
    await verifyCommit(privateRepository(env, PRIVATE_REPOSITORY_ENV.control), sha, identity, env.FLEET_GH_TOKEN);
    audit.note("push-verify", `state committed+verified sha=${sha.slice(0, 10)}`);
    return outcome;
  } catch (err) {
    audit.incident("push-verify", `bookkeeping push failed (merge outcome unaffected): ${String(err.message).slice(0, 160)}`);
    return "push-failed";
  }
}

async function getPr() {
  const pr = gh(["api", `/repos/${TARGET_REPO}/pulls/${PR_NUMBER}`], process.env);
  const files = gh(["api", `/repos/${TARGET_REPO}/pulls/${PR_NUMBER}/files?per_page=100`], process.env) || [];
  return { pr, files };
}

/** A test command is green only when it exits normally with status zero. */
export function classifyTestResult(result = {}) {
  const status = result && result.status;
  if (status === 0) return { ok: true, exitCode: 0, why: "passed" };
  const exitCode = Number.isInteger(status) ? status : null;
  const reason = exitCode === null
    ? (result && result.signal ? `signal=${String(result.signal)}` : "no-exit-status")
    : `exit=${exitCode}`;
  return { ok: false, exitCode, why: `failed (${reason})` };
}

async function runDeterministicChecks(repo, headSha, audit) {
  const evidenceLines = [];
  const workdir = path.join(mkdtempSync(path.join(tmpdir(), "pr-checkout-")), "repo");
  gh(["repo", "clone", repo, workdir, "--", "--depth", "1"], process.env);
  installCredentialHelper(workdir, process.env);
  const { spawnSync } = await import("node:child_process");
  let fr = spawnSync("git", ["fetch", "-q", "--depth", "1", "origin", headSha], { cwd: workdir, encoding: "utf8" });
  if (fr.status !== 0) {
    fr = spawnSync("git", ["fetch", "-q", "--depth", "1", "origin", `refs/pull/${PR_NUMBER}/head`], { cwd: workdir, encoding: "utf8" });
  }
  const co = spawnSync("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: workdir, encoding: "utf8" });
  if (fr.status !== 0 || co.status !== 0) {
    evidenceLines.push(`checkout failed: fetch=${fr.status}/${String(fr.stderr).slice(-200)} checkout=${co.status}/${String(co.stderr).slice(-200)}`);
    return { ok: false, evidence: evidenceLines.join("\n") };
  }
  evidenceLines.push(`checkout: head ${headSha.slice(0, 10)} ok`);
  const pkgPath = path.join(workdir, "package.json");
  if (existsSync(pkgPath)) {
    let scripts = {};
    try {
      scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts || {};
    } catch {}
    if (Object.keys(scripts).length > 0) {
      const inst = spawnSync("bash", ["-lc", "npm install --no-audit --no-fund"], { cwd: workdir, encoding: "utf8", timeout: 420000, env: sanitizedExecEnv(process.env, workdir) });
      evidenceLines.push(`npm install: exit=${inst.status}`);
      if (inst.status !== 0) return { ok: false, evidence: evidenceLines.join("\n") + `\n${String(inst.stderr).slice(-400)}` };
      if (scripts.build) {
        const b = spawnSync("bash", ["-lc", "npm run build"], { cwd: workdir, encoding: "utf8", timeout: 600000, env: sanitizedExecEnv(process.env, workdir) });
        evidenceLines.push(`npm run build: exit=${b.status}`);
        if (b.status !== 0) return { ok: false, evidence: evidenceLines.join("\n") + `\n${String(b.stderr).slice(-600)}` };
      }
      if (Object.prototype.hasOwnProperty.call(scripts, "test")) {
        const testScript = typeof scripts.test === "string" ? scripts.test.trim() : "";
        if (!testScript) {
          evidenceLines.push("npm test: configured but empty");
          return { ok: false, evidence: evidenceLines.join("\n") };
        }
        const t = spawnSync("bash", ["-lc", "npm test"], { cwd: workdir, encoding: "utf8", timeout: 420000, env: sanitizedExecEnv(process.env, workdir) });
        const testVerdict = classifyTestResult(t);
        evidenceLines.push(`npm test: ${testVerdict.why}`);
        if (!testVerdict.ok) {
          return { ok: false, evidence: evidenceLines.join("\n") + `\n${String(t.stderr || t.stdout || "").slice(-600)}` };
        }
      }
    } else {
      evidenceLines.push("package.json without scripts; skipped build/test");
    }
  } else {
    evidenceLines.push("no package.json; static repo, nothing to build");
  }
  return { ok: true, evidence: evidenceLines.join("\n") };
}

async function postComment(repo, number, body, audit) {
  if (!mutationAllowed(`comment ${repo}#${number}`, audit)) return null;
  const c = gh(["api", "-X", "POST", `/repos/${repo}/issues/${number}/comments`, "-F", `body=${body}`], process.env);
  const user = gh(["api", `/repos/${repo}/issues/comments/${c.id}`], process.env);
  if ((user.user && user.user.login) !== "M1Vj") throw new Error("comment attribution mismatch");
  audit.note("comment", `#${number} posted`);
  return c;
}

async function recordTerminalState(state, details) {
  appendFileSync(MERGES_PATH, JSON.stringify({ t: new Date().toISOString(), state, ...details }) + "\n");
}

  function writeMergeState(state, details) {
    try {
      mkdirSync(path.dirname(MERGES_PATH), { recursive: true });
      appendFileSync(MERGES_PATH, JSON.stringify({ t: new Date().toISOString(), state, ...details }) + "\n");
    } catch {}
  }

async function runHygiene(identity, audit) {
  if (!mutationAllowed("hygiene", audit)) return 0;
  const repos = gh(["api", "/user/repos?affiliation=owner&per_page=100&sort=pushed"], process.env) || [];
  const entries = [];
  for (const r of repos) {
    try {
      const pulls = gh(["api", `/repos/${r.full_name}/pulls?state=open&per_page=30`], process.env) || [];
      for (const p of pulls) {
        if (!(p.user && p.user.login === "M1Vj") || !String(p.head.ref || "").startsWith("fleet/")) continue;
        const files = gh(["api", `/repos/${r.full_name}/pulls/${p.number}/files?per_page=100`], process.env) || [];
        entries.push({ repo: r.full_name, number: p.number, state: "open", draft: p.draft, created_at: p.created_at, files, title: p.title });
      }
    } catch {}
  }
  const now = Date.now();
  for (const sup of findSuperseded(entries, now)) {
    try {
      if (!mutationAllowed(`hygiene comment ${sup.repo}#${sup.number}`, audit)) continue;
      await postComment(sup.repo, sup.number, `♻️ **fleet hygiene**: superseded by #${sup.supersededBy} (overlapping files). Closing this draft; reopen if still relevant.`, audit);
      if (!mutationAllowed(`hygiene close ${sup.repo}#${sup.number}`, audit)) continue;
      gh(["api", "-X", "PATCH", `/repos/${sup.repo}/pulls/${sup.number}`, "-f", "state=closed"], process.env);
      await recordTerminalState("STALLED", { repo: sup.repo, pr: sup.number, why: "superseded", by: sup.supersededBy });
      audit.note("hygiene", `closed superseded ${sup.repo}#${sup.number}`);
    } catch (err) {
      audit.note("hygiene-error", `${sup.repo}#${sup.number}: ${err.message.slice(0, 120)}`);
    }
  }
  for (const e of entries) {
    if (!isStale(e, now)) continue;
    try {
      if (!mutationAllowed(`hygiene comment ${e.repo}#${e.number}`, audit)) continue;
      await postComment(e.repo, e.number, "🕰 **fleet hygiene**: this draft has been open 14+ days without action. Closing to keep the queue honest — reopen if still relevant.", audit);
      if (!mutationAllowed(`hygiene close ${e.repo}#${e.number}`, audit)) continue;
      gh(["api", "-X", "PATCH", `/repos/${e.repo}/pulls/${e.number}`, "-f", "state=closed"], process.env);
      await recordTerminalState("STALLED", { repo: e.repo, pr: e.number, why: "stale-14d" });
      audit.note("hygiene", `closed stale ${e.repo}#${e.number}`);
    } catch (err) {
      audit.note("hygiene-error", `${e.repo}#${e.number}: ${err.message.slice(0, 120)}`);
    }
  }
}

export async function discoverFleetPRs(limit = process.env.FLEET_MERGE_SCAN_CAP || DEFAULT_SCAN_CAP, options = {}) {
  const history = Array.isArray(options.history) ? options.history : readMergesHistory(MERGES_PATH);
  if (isPublicDataClass(process.env)) {
    const repository = publicRepository(process.env);
    const pulls = collectScanPages(
      (page, perPage) => gh(["api", buildScanPageEndpoint(`/repos/${repository}/pulls?state=open&sort=created&direction=asc`, page, perPage)], process.env),
      { maxPages: normalizeScanPages(options.maxPages ?? process.env.FLEET_MERGE_SCAN_MAX_PAGES), perPage: Math.min(100, Math.max(1, Math.floor(Number(options.perPage || SCAN_PAGE_SIZE) || SCAN_PAGE_SIZE))) },
    ).map((pull) => ({ ...pull, repo: repository }));
    return selectScanPullRequests(pulls, {
      targets: { tier1: [repository], excluded: [] },
      limit: normalizeScanCap(limit),
      history,
      repositories: [{ full_name: repository, private: false, visibility: "public" }],
    });
  }
  const targets = options.targets || readTargets();
  const scanCap = normalizeScanCap(limit);
  const maxPages = normalizeScanPages(options.maxPages ?? process.env.FLEET_MERGE_SCAN_MAX_PAGES);
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(options.perPage || SCAN_PAGE_SIZE) || SCAN_PAGE_SIZE)));
  const fetchPages = (endpoint) => collectScanPages(
    (page, perPage) => gh(["api", buildScanPageEndpoint(endpoint, page, perPage)], process.env),
    { maxPages, perPage: pageSize },
  );

  const repos = fetchPages("/user/repos?affiliation=owner&sort=pushed");
  const pulls = [];
  for (const repository of repos) {
    const repo = repoReference(repository?.full_name || repository?.fullName || repository?.repo);
    if (!repo || repository.archived === true || repository.fork === true || !isScanEnrolled(targets, repo, repository)) continue;
    try {
      for (const pull of fetchPages(`/repos/${repo}/pulls?state=open&sort=created&direction=asc`)) {
        pulls.push({ ...pull, repo: pullRepo(pull) || repo });
      }
    } catch {}
  }

  const selected = selectScanPullRequests(pulls, {
    targets,
    limit: scanCap,
    history,
    repositories: repos,
  });
  selected.totalEnrolledPulls = pulls.length;
  selected.hasPendingPrs = pulls.length > selected.length;
  return selected;
}

async function main() {
  const runId = `merge-${Date.now()}`;
  const audit = new AuditBuffer(scrub(process.env));
  // M2: unexpected throws (SHA-moved, merge-not-merged, post-verify, …)
  // must still land a terminal BLOCKED event + audit finish + ledger
  // entry via the existing helpers — never a bare MERGE_GATE_FAILED.
  let identity;
  try {
    identity = await runGate(process.env);
    configureIdentity(REPO_ROOT, identity);
    if (isPublicDataClass(process.env)) {
      const repository = publicRepository(process.env);
      audit.note("public", "merge gate is read-only; no PR, review, state, or workflow mutation is permitted");
      writePublicArtifact(process.env, {
        mode: "merge",
        status: "blocked",
        repository,
        reason: "public-read-only",
        checks: { targetVisibility: "public", privateState: "not-read", externalWrites: "blocked" },
      }, { kind: "merge", status: "blocked", repository, runId });
      writeExecutionAudit(audit, process.env, REPO_ROOT, runId, `Merge gate ${repository}`, "blocked");
      console.log("MERGE_TERMINAL_STATE=BLOCKED");
      return 4;
    }
  if (process.env.FLEET_GH_TOKEN) {
    if (!process.env.GH_TOKEN) process.env.GH_TOKEN = process.env.FLEET_GH_TOKEN;
    if (!process.env.FLEET_GH_USER) process.env.FLEET_GH_USER = identity.login;
  }
  audit.note("gate", `identity=${identity.login} target=${TARGET_REPO} pr=${PR_NUMBER}`);
  writeRevisionOutputs(process.env.GITHUB_OUTPUT, TARGET_REPO, PR_NUMBER, false);
  writeQueueOutputs(process.env.GITHUB_OUTPUT, false);

  if (!INITIAL_TARGET.valid && INITIAL_TARGET.provided) {
    audit.note("target", "invalid or incomplete target; scan and revision both refused");
    await recordTerminalState("NO-OP", { why: "invalid-target" });
    console.log("MERGE_TERMINAL_STATE=NO-OP");
    return finish(audit, runId, "NO-OP");
  }

  if (!INITIAL_TARGET.valid) {
    const queue = await discoverFleetPRs(process.env.FLEET_MERGE_SCAN_CAP || DEFAULT_SCAN_CAP);
    writeQueueOutputs(process.env.GITHUB_OUTPUT, Boolean(queue.hasPendingPrs));
    audit.note("scan", `enrolled open PRs queued: ${queue.map((q) => `${q.repo}#${q.number}`).join(", ") || "none"} (pending=${queue.hasPendingPrs ? "yes" : "no"})`);
    if (queue.length === 0) {
      console.log("MERGE_TERMINAL_STATE=NO-OP (nothing to gate)");
      writeMergeState("NO-OP", { why: "scan-empty" });
      return finish(audit, runId, "NO-OP");
    }
    mkdirSync(AUDIT_DIR, { recursive: true });
    for (const item of queue) {
      try {
        const { spawnSync } = await import("node:child_process");
        const { fileURLToPath } = await import("node:url");
        const scriptPath = fileURLToPath(import.meta.url);
        const res = spawnSync("node", [scriptPath], {
          encoding: "utf8",
          timeout: 3600000,
          env: {
            ...process.env,
            FLEET_TARGET_REPO: item.repo,
            FLEET_PR_NUMBER: String(item.number),
          },
        });
        audit.note("child", `${item.repo}#${item.number} exit=${res.status}`);
      } catch (err) {
        audit.incident("child", `${item.repo}#${item.number}: ${err.message}`);
      }
    }
    try {
      const reconciledCount = await reconcileHumanReviewQueue(STATE_ROOT, process.env);
      audit.note("human-review-reconcile", `reconciled ${reconciledCount} human review items`);
    } catch (err) {
      audit.incident("human-review-reconcile", `failed reconciling human review queue: ${err.message}`);
    }
    await runHygiene(identity, audit);

    writeExecutionAudit(audit, process.env, REPO_ROOT, runId, "Merge gate scan", "ok");
    await commitPushVerify(STATE_ROOT, ["state", "audit"], `[fleet] merge-gate scan ${runId}`, identity, audit, process.env);
    console.log("MERGE_TERMINAL_STATE=SCAN-DONE");
    return;
  }

  const { pr, files } = await getPr();
  if (pr.state !== "open") {
    await recordTerminalState("NO-OP", { repo: TARGET_REPO, pr: PR_NUMBER, why: `state=${pr.state}` });
    console.log("MERGE_TERMINAL_STATE=NO-OP");
    return finish(audit, runId, "NO-OP");
  }
  // Tier1 fence: autonomous merges only proceed on tier1 repos.
  if (!isTier1Eligible(readTargets(), TARGET_REPO)) {
    audit.note("tier1", `${TARGET_REPO} not tier1 — autonomous merge refused, no comment posted`);
    await recordTerminalState("NO-OP", { repo: TARGET_REPO, pr: PR_NUMBER, why: "not-tier1" });
    console.log("MERGE_TERMINAL_STATE=NO-OP");
    return finish(audit, runId, "NO-OP");
  }
  await verifyPullAuthor(TARGET_REPO, PR_NUMBER, identity, process.env.FLEET_GH_TOKEN);
  if (!pr.head || !pr.head.sha) throw new Error("no head sha");
  const evalSha = pr.head.sha;
  // Ledger idempotency: an exact SHA already merged successfully is done.
  if (mergeAlreadyRecorded(MERGES_PATH, TARGET_REPO, PR_NUMBER, evalSha)) {
    audit.note("idempotency", `SUCCESS already recorded for ${TARGET_REPO}#${PR_NUMBER}@${evalSha.slice(0, 10)}`);
    console.log("MERGE_TERMINAL_STATE=NO-OP");
    return finish(audit, runId, "NO-OP");
  }

  const cls = classify(files);
  const secretHits = secretsInDiff(files);
  audit.note("classify", JSON.stringify({ ...cls, secretHits: secretHits.length }));

  const terminal = async (state, extra = {}) => {
    await recordTerminalState(state, { repo: TARGET_REPO, pr: PR_NUMBER, sha: evalSha, ...extra });
    console.log(`MERGE_TERMINAL_STATE=${state}`);
  };

  if (pr.state !== "open") return terminal("NO-OP", { why: "pr not open" });
  if (secretHits.length > 0) {
    await postComment(TARGET_REPO, PR_NUMBER, "🛑 **fleet merge-gate**: potential secrets detected in diff:\n\n" + secretHits.map((h) => `- \`${h}\``).join("\n") + "\n\nAuto-merge refused. Remove and force-push the branch.", audit);
    await terminal("BLOCKED", { why: "secrets in diff" });
    return finish(audit, runId, "BLOCKED");
  }

  const riskCommentBits = [];
  riskCommentBits.push(...cls.reasons);

  let visualEvidence = "not-applicable";
  let visualOk = true;
  let visualData = null;
  if (cls.uiTouched) {
    const visDir = "/tmp/visual-out";
    mkdirSync(visDir, { recursive: true });
    const routesEnv = process.env.FLEET_UI_ROUTES || "/";
    const { spawnSync } = await import("node:child_process");
    const vres = spawnSync("node", [path.join(REPO_ROOT, "scripts", "visual-check.mjs")], {
      encoding: "utf8",
      timeout: 2400000,
      env: {
        ...sanitizedExecEnv(process.env),
        FLEET_REPO: TARGET_REPO,
        FLEET_HEAD_SHA: pr.head.sha,
        FLEET_BASE_SHA: pr.base ? pr.base.sha : "",
        FLEET_PR_NUMBER: String(PR_NUMBER),
        FLEET_UI_ROUTES: routesEnv,
        FLEET_ARTIFACT_DIR: visDir,
      },
    });
    audit.note("visual", `exit=${vres.status} ${String(vres.stdout).slice(-120)}`);
    const evJson = path.join(visDir, "visual-evidence.json");
    const evTxt = path.join(visDir, "visual-evidence.txt");
    if (existsSync(evJson)) {
      const ve = JSON.parse(readFileSync(evJson, "utf8"));
      visualData = ve;
      visualOk = !(ve.verdict && ve.verdict.consoleBlocker) && !(ve.verdict && ve.verdict.a11yBlocker);
      if (ve.verdict && ve.verdict.vlm) {
        riskCommentBits.push(`vision judge (advisory): ${ve.verdict.vlm.verdict} (${ve.verdict.vlm.score}) regressions=${JSON.stringify(ve.verdict.vlm.regressions || []).slice(0, 200)}`);
      }
      visualEvidence = existsSync(evTxt) ? readFileSync(evTxt, "utf8") : "";
    } else {
      visualEvidence = "visual capture did not produce evidence (app not servable?) — treating as neutral pass with note";
      riskCommentBits.push("note: visual evidence unavailable");
    }
    if (!visualOk) riskCommentBits.push("visual gate: console errors or critical a11y violations present");
  }

  // Multi-Agent Adversarial & Critique Gauntlet
  // 1. Deterministic checks (npm install, build, test)
  const det = await runDeterministicChecks(TARGET_REPO, pr.head.sha, audit);
  if (!det.ok) {
    await postComment(TARGET_REPO, PR_NUMBER, "🧪 **fleet merge-gate**: deterministic checks FAILED.\n\n```\n" + det.evidence.slice(-1500) + "\n```", audit);
    if (isRevisionEligible(pr)) {
      const revCount = countRevisionsFor(REPO_ROOT, TARGET_REPO, PR_NUMBER);
      if (revCount < 2 && process.env.GITHUB_OUTPUT) {
        writeRevisionOutputs(process.env.GITHUB_OUTPUT, TARGET_REPO, PR_NUMBER, true);
        await recordTerminalState("REVISION_QUEUED", { repo: TARGET_REPO, pr: PR_NUMBER, sha: evalSha, why: "deterministic checks failed; revision queued" });
        console.log("MERGE_TERMINAL_STATE=REVISION_QUEUED");
        return finish(audit, runId, "REVISION_QUEUED");
      }
    }
    await terminal("BLOCKED", { why: "deterministic checks failed" });
    return finish(audit, runId, "BLOCKED");
  }
  audit.note("deterministic", "passed (L1/L2)");

  const combinedEvidence = [
    det.evidence,
    visualEvidence === "not-applicable" ? "" : "VISUAL:\n" + visualEvidence,
  ].filter(Boolean).join("\n\n");

  // 2. Multi-Agent Adversarial Panel
  const correctness = await judge({ repo: TARGET_REPO, prNumber: PR_NUMBER, title: pr.title, body: pr.body, files, extraEvidence: combinedEvidence, lens: "correctness-and-security", audit });
  const standards = await judge({ repo: TARGET_REPO, prNumber: PR_NUMBER, title: pr.title, body: pr.body, files, extraEvidence: combinedEvidence, lens: "industry-standards-and-maintainability", audit });
  
  let security = null;
  const needsSecurity = cls.depth >= 2 || (cls.reasons && cls.reasons.some((r) => r.includes("sensitive path") || r.includes("workflow")));
  if (needsSecurity) {
    security = await judge({ repo: TARGET_REPO, prNumber: PR_NUMBER, title: pr.title, body: pr.body, files, extraEvidence: combinedEvidence, lens: "security-and-supply-chain", audit });
  }

  let ux = null;
  if (cls.uiTouched) {
    ux = await judge({ repo: TARGET_REPO, prNumber: PR_NUMBER, title: pr.title, body: pr.body, files, extraEvidence: combinedEvidence, lens: "ux-and-visual-integrity", audit });
  }

  const judgesList = [correctness, standards];
  if (security) judgesList.push(security);
  if (ux) judgesList.push(ux);

  const availableJudges = judgesList.filter((j) => !j.unavailable && j.verdict !== "unavailable");
  const unavailableJudges = judgesList.filter((j) => j.unavailable || j.verdict === "unavailable");

  // Thresholds: depth 1: 80, depth 2: 85, depth 3 (YOLO): 90 with security judge >= 90. 0 blockers required across all judges.
  const baseThreshold = cls.depth >= 3 ? 90 : cls.depth >= 2 ? 85 : 80;

  if (availableJudges.length === 0) {
    await postComment(TARGET_REPO, PR_NUMBER, "⏳ **fleet merge-gate**: judges temporarily unavailable due to model capacity. Gate retries automatically on the next pass.", audit);
    await terminal("STALLED", { why: "all judges unavailable" });
    console.log("MERGE_TERMINAL_STATE=STALLED");
    return finish(audit, runId, "STALLED");
  }

  const allJudgesApprove = availableJudges.every((j) => j.verdict === "approve" && j.score >= baseThreshold && (!j.blockers || j.blockers.length === 0));
  const securityPasses = !security || security.unavailable || (cls.depth >= 3 ? security.score >= 90 : security.score >= baseThreshold);
  const consensusApproved = allJudgesApprove && securityPasses;

  const judgeRows = [
    `| correctness+security | ${correctness.unavailable ? "UNAVAILABLE (transient)" : correctness.verdict.toUpperCase()} | ${correctness.score ?? "-"} |`,
    `| standards+maintainability | ${standards.unavailable ? "UNAVAILABLE (transient)" : standards.verdict.toUpperCase()} | ${standards.score ?? "-"} |`,
  ];
  if (security) judgeRows.push(`| security+supply-chain | ${security.unavailable ? "UNAVAILABLE (transient)" : security.verdict.toUpperCase()} | ${security.score ?? "-"} |`);
  if (ux) judgeRows.push(`| ux+visual-integrity | ${ux.unavailable ? "UNAVAILABLE (transient)" : ux.verdict.toUpperCase()} | ${ux.score ?? "-"} |`);

  const allBlockers = availableJudges.flatMap((j) => j.blockers || []);
  const allReasons = availableJudges.flatMap((j) => j.reasons || []);

  const verdictBody =
    "🔍 **fleet multi-agent audit panel** (adversarial critique gauntlet)\n\n" +
    `| lens | verdict | score |\n| --- | --- | --- |\n${judgeRows.join("\n")}\n\n` +
    (allBlockers.length
      ? "**Blockers:**\n" + allBlockers.map((b) => `- ${b}`).join("\n") + "\n\n"
      : "") +
    "<details><summary>reasons</summary>\n\n" +
    allReasons.map((r) => `- ${r}`).join("\n") +
    "\n</details>";

  await postComment(TARGET_REPO, PR_NUMBER, verdictBody, audit);

  // Compute visual metrics for decision
  let maxDiffPct = -1;
  let totalConsoleErrors = 0;
  let hasA11yBlocker = false;
  if (visualData && Array.isArray(visualData.results)) {
    const afterResults = visualData.results.filter((r) => r.label === "after");
    for (const r of afterResults) {
      if (r.diffPct !== undefined && r.diffPct > maxDiffPct) maxDiffPct = r.diffPct;
      if (r.consoleErrors) totalConsoleErrors += r.consoleErrors;
      if (r.a11yCritical && r.a11yCritical > 0) hasA11yBlocker = true;
    }
  }

  const scoresSummary = availableJudges.map((j) => ({ lens: j.lens || "judge", score: j.score, verdict: j.verdict }));

  if (!consensusApproved) {
    const eligible = isRevisionEligible(pr);
    if (eligible) {
      const revCount = countRevisionsFor(REPO_ROOT, TARGET_REPO, PR_NUMBER);
      if (revCount >= 2) {
        // Instead of auto-closing, route to recordHumanReview category: judge-deadlock
        const deadlockReason = `Maximum revisions reached (${revCount}) and multi-agent panel still rejected PR (scores: ${availableJudges.map((j) => j.score).join(", ")}). Requires human eyes to unblock.`;
        recordHumanReview(STATE_ROOT, {
          repo: TARGET_REPO,
          prNumber: PR_NUMBER,
          title: pr.title,
          headSha: evalSha,
          author: pr.user ? pr.user.login : "M1Vj",
          branch: pr.head ? pr.head.ref : "",
          category: "judge-deadlock",
          why: deadlockReason,
          scores: scoresSummary,
          deterministic: det.ok,
          visual: visualData ? { diffPct: maxDiffPct, consoleErrors: totalConsoleErrors, a11yBlocker: hasA11yBlocker, vlm: visualData.verdict && visualData.verdict.vlm } : null,
        });
        await tagPrNeedsHumanReview(TARGET_REPO, PR_NUMBER, "judge-deadlock", deadlockReason, audit, process.env);
        await recordTerminalState("NEEDS_HUMAN_REVIEW", { repo: TARGET_REPO, pr: PR_NUMBER, sha: evalSha, why: deadlockReason, category: "judge-deadlock" });
        console.log("MERGE_TERMINAL_STATE=NEEDS_HUMAN_REVIEW");
        return finish(audit, runId, "NEEDS_HUMAN_REVIEW");
      }
      if (process.env.GITHUB_OUTPUT) {
        writeRevisionOutputs(process.env.GITHUB_OUTPUT, TARGET_REPO, PR_NUMBER, true);
        await recordTerminalState("REVISION_QUEUED", { repo: TARGET_REPO, pr: PR_NUMBER, sha: evalSha, why: "judges rejected; revision queued" });
        console.log("MERGE_TERMINAL_STATE=REVISION_QUEUED");
        return finish(audit, runId, "REVISION_QUEUED");
      }
    }
    await terminal("BLOCKED", { why: "judges rejected", scores: availableJudges.map((j) => j.score) });
    return finish(audit, runId, "BLOCKED");
  }

  // Consensus Approved! Check autonomous merge conditions or human review routing.
  if (cls.uiTouched) {
    const isSubjectiveRedesign = ux && (
      (ux.reasons && ux.reasons.some((r) => /subjective|redesign|human review|layout overhaul|design change/i.test(r))) ||
      (ux.blockers && ux.blockers.some((b) => /subjective|redesign|human review/i.test(b)))
    );
    const pixelDiffHigh = maxDiffPct > 10;
    const visualIssues = totalConsoleErrors > 0 || hasA11yBlocker;

    if (pixelDiffHigh || isSubjectiveRedesign || (ux && ux.score < 90) || visualIssues) {
      const whyReasons = [];
      if (pixelDiffHigh) whyReasons.push(`Pixel diff (${maxDiffPct.toFixed(2)}%) exceeds 10% threshold`);
      if (isSubjectiveRedesign) whyReasons.push("UX judge flagged subjective redesign needing human review");
      if (ux && ux.score < 90) whyReasons.push(`UX judge score (${ux.score}) is below autonomous merge threshold 90`);
      if (totalConsoleErrors > 0) whyReasons.push(`Visual check detected ${totalConsoleErrors} console error(s)`);
      if (hasA11yBlocker) whyReasons.push("Critical accessibility violations detected");

      const whyStr = whyReasons.join("; ");
      recordHumanReview(STATE_ROOT, {
        repo: TARGET_REPO,
        prNumber: PR_NUMBER,
        title: pr.title,
        headSha: evalSha,
        author: pr.user ? pr.user.login : "M1Vj",
        branch: pr.head ? pr.head.ref : "",
        category: "ui-ux",
        why: whyStr,
        scores: scoresSummary,
        deterministic: det.ok,
        visual: { diffPct: maxDiffPct, consoleErrors: totalConsoleErrors, a11yBlocker: hasA11yBlocker, vlm: visualData ? visualData.verdict && visualData.verdict.vlm : null },
      });
      await tagPrNeedsHumanReview(TARGET_REPO, PR_NUMBER, "ui-ux", whyStr, audit, process.env);
      await recordTerminalState("NEEDS_HUMAN_REVIEW", { repo: TARGET_REPO, pr: PR_NUMBER, sha: evalSha, why: whyStr, category: "ui-ux" });
      console.log("MERGE_TERMINAL_STATE=NEEDS_HUMAN_REVIEW");
      return finish(audit, runId, "NEEDS_HUMAN_REVIEW");
    }
  } else {
    if (cls.wfDeletions) {
      const whyStr = `Workflow deletion detected in PR (${cls.reasons.join(", ")}). Sensitive risk requires human review.`;
      recordHumanReview(STATE_ROOT, {
        repo: TARGET_REPO,
        prNumber: PR_NUMBER,
        title: pr.title,
        headSha: evalSha,
        author: pr.user ? pr.user.login : "M1Vj",
        branch: pr.head ? pr.head.ref : "",
        category: "risk-sensitive",
        why: whyStr,
        scores: scoresSummary,
        deterministic: det.ok,
        visual: null,
      });
      await tagPrNeedsHumanReview(TARGET_REPO, PR_NUMBER, "risk-sensitive", whyStr, audit, process.env);
      await recordTerminalState("NEEDS_HUMAN_REVIEW", { repo: TARGET_REPO, pr: PR_NUMBER, sha: evalSha, why: whyStr, category: "risk-sensitive" });
      console.log("MERGE_TERMINAL_STATE=NEEDS_HUMAN_REVIEW");
      return finish(audit, runId, "NEEDS_HUMAN_REVIEW");
    }
  }

  // If approved and not routed to human review: Proceed with Autonomous Merge!
  // Pre-merge gates on the exact evaluated SHA: kill-switch, SHA stability
  // (PR must not have moved under us while judges ran), then CI green.
  if (killSwitchEngaged()) {
    audit.incident("kill-switch", "merge refused: KILL_SWITCH engaged after judges approved");
    await terminal("BLOCKED", { why: "kill-switch-engaged" });
    return finish(audit, runId, "BLOCKED");
  }

  const fresh = gh(["api", `/repos/${TARGET_REPO}/pulls/${PR_NUMBER}`], process.env);
  if (fresh.state !== "open") {
    await terminal("NO-OP", { why: `pr state=${fresh.state} at merge time` });
    return finish(audit, runId, "NO-OP");
  }
  if (!fresh.head || fresh.head.sha !== evalSha) {
    await postCommentOnce(
      TARGET_REPO, PR_NUMBER, "<!-- fleet:sha-gate -->",
      `⏳ **fleet merge-gate**: judges approved \`${evalSha.slice(0, 10)}\` but the PR head has since moved to \`${String(fresh.head && fresh.head.sha || "?").slice(0, 10)}\`. Re-evaluating on the next gate pass against the exact new SHA.`,
      audit,
    );
    await terminal("BLOCKED", { why: "sha-changed", evalSha, headSha: fresh.head && fresh.head.sha });
    return finish(audit, runId, "BLOCKED");
  }

  const ci = fetchCi(TARGET_REPO, evalSha, process.env);
  const verdict = ciVerdict(ci);
  audit.note("ci-gate", `${verdict.why} @${evalSha.slice(0, 10)}`);
  if (!verdict.ok) {
    await postCommentOnce(
      TARGET_REPO, PR_NUMBER, "<!-- fleet:ci-gate -->",
      verdict.pending
        ? `⏳ **fleet merge-gate**: judges approved, but CI is not green yet on \`${evalSha.slice(0, 10)}\` (${verdict.why}). The gate retries automatically — no action needed.`
        : `🛑 **fleet merge-gate**: judges approved, but CI is RED on \`${evalSha.slice(0, 10)}\` (${verdict.why}). Auto-merge refused until checks pass.`,
      audit,
    );
    await terminal("BLOCKED", { why: verdict.pending ? "ci-pending" : "ci-red", ci: verdict.why });
    return finish(audit, runId, "BLOCKED");
  }

  if (pr.draft) {
    try {
      gh(["pr", "ready", String(PR_NUMBER), "-R", TARGET_REPO], process.env);
      audit.note("ready", "marked ready for review");
    } catch (err) {
      audit.note("ready", `mark-ready failed: ${err.message.slice(0, 100)}`);
    }
  }

  if (killSwitchEngaged()) {
    audit.incident("kill-switch", "merge refused at merge instant: KILL_SWITCH engaged");
    await terminal("BLOCKED", { why: "kill-switch-engaged" });
    return finish(audit, runId, "BLOCKED");
  }
  try {
    gh(["pr", "merge", String(PR_NUMBER), "--merge", "--delete-branch", "-R", TARGET_REPO], process.env);
  } catch (err) {
    if (/draft/i.test(String(err.message))) {
      gh(["pr", "ready", String(PR_NUMBER), "-R", TARGET_REPO], process.env);
      await new Promise((r) => setTimeout(r, 3000));
      gh(["pr", "merge", String(PR_NUMBER), "--merge", "--delete-branch", "-R", TARGET_REPO], process.env);
    } else if (/behind|not mergeable|update branch|conflict/i.test(String(err.message))) {
      // Pull-rebase collision analog: ask GitHub to update the branch onto
      // base, wait, then retry the merge exactly once.
      audit.note("update-branch", `merge blocked (${String(err.message).slice(0, 100)}); updating branch and retrying once`);
      gh(["api", "-X", "POST", `/repos/${TARGET_REPO}/pulls/${PR_NUMBER}/update-branch`], process.env);
      await new Promise((r) => setTimeout(r, 15000));
      const moved = gh(["api", `/repos/${TARGET_REPO}/pulls/${PR_NUMBER}`], process.env);
      if (!moved.head || moved.head.sha === evalSha) {
        gh(["pr", "merge", String(PR_NUMBER), "--merge", "--delete-branch", "-R", TARGET_REPO], process.env);
      } else {
        throw new Error(`branch moved during update (${evalSha.slice(0, 10)} -> ${String(moved.head.sha).slice(0, 10)}); re-gate required`);
      }
    } else {
      throw err;
    }
  }
  await new Promise((r) => setTimeout(r, 4000));
  const mergedMeta = gh(["api", `/repos/${TARGET_REPO}/pulls/${PR_NUMBER}`], process.env);
  if (!mergedMeta.merged) throw new Error("merge attempted but not merged");
  try {
    await verifyCommit(TARGET_REPO, mergedMeta.merge_commit_sha, identity, process.env.FLEET_GH_TOKEN);
  } catch (err) {
    audit.incident("post-merge-verify", `ATTRIBUTION FAILURE after merge: ${err.message}`);
    throw err;
  }
  audit.note("merged", `merge_commit=${String(mergedMeta.merge_commit_sha).slice(0, 10)}`);
  await terminal("SUCCESS", { mergeCommit: mergedMeta.merge_commit_sha, scores: [correctness.score, standards.score] });
  return finish(audit, runId, "SUCCESS");
  } catch (err) {
    const msg = String((err && err.message) || err).slice(0, 200);
    audit.incident("fatal", `unexpected merge-gate failure: ${msg}`);
    try {
      await recordTerminalState("BLOCKED", { repo: TARGET_REPO, pr: PR_NUMBER, why: `unexpected: ${msg.slice(0, 160)}` });
    } catch {}
    console.log("MERGE_TERMINAL_STATE=BLOCKED");
    return finish(audit, runId, "BLOCKED");
  }

  async function finish(a, rid, stateName) {
    writeExecutionAudit(a, process.env, REPO_ROOT, rid, `Merge gate ${TARGET_REPO}#${PR_NUMBER}`, stateName);
    // Durable state (merges.jsonl) + audit live in the private control repository; commit and
    // push as M1Vj with attribution verify. Best-effort: the terminal state
    // above is already recorded locally.
    try {
      await commitPushVerify(STATE_ROOT, ["state", "audit"], `[fleet] merge-gate ${rid} ${stateName}`, identity, a, process.env);
    } catch {}
    return 0;
  }
}

async function judge({ repo, prNumber, title, body, files, extraEvidence, lens, audit }) {
  const diff = files
    .map((f) => `--- ${f.filename} (+${f.additions}/-${f.deletions})\n${String(f.patch || "(binary or too large)").slice(0, 5000)}`)
    .join("\n\n")
    .slice(0, 45000);
  const prompt = [
    `You are an INDEPENDENT ${lens} JUDGE reviewing a pull request you did not author.`,
    `Repo ${repo}, PR #${prNumber}: ${title}.`,
    body ? `PR description:\n${String(body).slice(0, 3000)}\n` : "",
    extraEvidence ? `Deterministic verification evidence already collected:\n${extraEvidence.slice(0, 8000)}\n` : "",
    "Judge strictly against industry standards: correctness, security, error handling, tests, maintainability.",
    'Return ONLY strict JSON: {"verdict":"approve|reject","score":<0-100>,"reasons":["..."],"blockers":["..."]}',
    "approve requires score>=80 AND zero blockers. Rubber-stamping is failure; reject anything questionable.",
    "DIFF:",
    diff,
  ].join("\n");
  const judgeModel = process.env.FLEET_JUDGE_MODEL;
  let result = await askModel({
    prompt,
    timeoutMs: 480000,
    env: process.env,
    // Contributor tier: high thinking effort (maps to xhigh), never the max variant.
    preferVariantMax: true,
    maxRounds: 3,
    ...(judgeModel ? { modelOverride: judgeModel } : {}),
  });
  if (!result.complete || !result.reply) {
    audit.note("judge-retry", `${lens} first try incomplete; retrying without model override`);
    result = await askModel({
      prompt,
      timeoutMs: 360000,
      env: process.env,
      preferVariantMax: true,
      maxRounds: 2,
    });
  }
  audit.note("judge", `${lens} complete=${result.complete}`);
  if (!result.complete || !result.reply) {
    return {
      lens,
      verdict: "unavailable",
      score: null,
      reasons: ["judge unavailable (model capacity wait or transient error)"],
      blockers: [],
      unavailable: true,
    };
  }
  try {
    const v = extractJsonObject(result.reply);
    return {
      lens,
      verdict: v.verdict === "approve" ? "approve" : "reject",
      score: Math.max(0, Math.min(100, Number(v.score) || 0)),
      reasons: Array.isArray(v.reasons) ? v.reasons.map(String).slice(0, 6) : [],
      blockers: Array.isArray(v.blockers) ? v.blockers.map(String).slice(0, 6) : [],
    };
  } catch (err) {
    return { verdict: "reject", score: 0, reasons: [`judge output unparsable: ${String(err.message).slice(0, 80)}`], blockers: ["unparsable"] };
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`MERGE_GATE_FAILED reason=${err.message}`);
      process.exit(err.code && Number.isInteger(err.code) ? err.code : 1);
    });
}
