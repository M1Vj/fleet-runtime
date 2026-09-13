#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, gitAdd, gitCommit, gitPush, gitHasChanges, gitRevParse, configureIdentity } from "./lib/util.mjs";
import { askModel } from "./lib/model.mjs";
import { verifyCommit } from "./lib/verify.mjs";
import { extractJsonObject } from "./lib/directives.mjs";
import {
  isPublicDataClass,
  publicModelEnv,
  publicRepository,
  privateRepository,
  PRIVATE_REPOSITORY_ENV,
  resolveArtifactDir,
  resolveStateRoot,
  makeExecutionTerminal,
  writeExecutionAudit,
  writePublicArtifact,
} from "./lib/private-state.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = resolveStateRoot(process.env, CODE_ROOT);
const QUEUE_PATH = path.join(REPO_ROOT, "state", "queue.jsonl");

function loadQueue() {
  if (!existsSync(QUEUE_PATH)) return [];
  const rows = readFileSync(QUEUE_PATH, "utf8").split("\n").filter(Boolean);
  const queue = [];
  for (const line of rows) {
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("row is not an object");
      queue.push(value);
    } catch (error) {
      throw new Error(`QUEUE_INVALID: ${error.message}`);
    }
  }
  return queue;
}

function saveQueue(queue) {
  writeFileSync(QUEUE_PATH, queue.map((t) => JSON.stringify(t)).join("\n") + "\n");
}

// Finish-loop durable queue claim: 40min reclaim, max 3 attempts then blocked.
// Exit taxonomy: 2 kill, 3 identity, 4 scope, 5 rejected, 6 model-unavailable.
export const CLAIM_RECLAIM_MS = 40 * 60 * 1000;
export const CLAIM_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_WORKERS = 6;
export const MAX_WORKERS = 15;
export const MAX_PARALLEL = MAX_WORKERS;

export function sanitizeMaxWorkers(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_MAX_WORKERS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return MAX_WORKERS;
  if (parsed < 1) return DEFAULT_MAX_WORKERS;
  if (parsed > MAX_WORKERS) return MAX_WORKERS;
  if (!Number.isSafeInteger(parsed)) return DEFAULT_MAX_WORKERS;
  return Math.min(parsed, MAX_WORKERS);
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isStaleClaim(task, now) {
  const updated = timestampMs(task.updatedUtc);
  return task.status === "in_progress" && updated !== null && now - updated > CLAIM_RECLAIM_MS;
}

function attemptCount(task) {
  return Number.isSafeInteger(task.attempts) && task.attempts >= 0 ? task.attempts : 0;
}

function taskKey(task) {
  if (task?.repo && task?.kind) return `${task.repo}|${task.kind}`;
  if (task?.id !== undefined && task?.id !== null) return `id:${task.id}`;
  return "";
}

export function sweepExhaustedTasks(queue, now = Date.now(), updatedUtc = new Date(now).toISOString()) {
  let blocked = 0;
  for (const task of queue) {
    const attempts = attemptCount(task);
    const exhaustedPending = task.status === "pending" && attempts >= CLAIM_MAX_ATTEMPTS;
    const exhaustedStale = isStaleClaim(task, now) && attempts >= CLAIM_MAX_ATTEMPTS;
    if (exhaustedPending || exhaustedStale) {
      task.status = "blocked";
      task.updatedUtc = updatedUtc;
      delete task.claimRunId;
      delete task.claimAttempt;
      blocked += 1;
    }
  }
  return blocked;
}

function claimRow(task, runId, updatedUtc) {
  const previousAttempts = attemptCount(task);
  task.attempts = previousAttempts + 1;
  task.status = "in_progress";
  task.updatedUtc = updatedUtc;
  task.claimRunId = runId;
  task.claimAttempt = task.attempts;
  return {
    id: task.id,
    taskId: task.id,
    repo: task.repo,
    kind: task.kind,
    status: task.status,
    attempts: task.attempts,
    previousAttempts,
    claimRunId: runId,
    claimAttempt: task.claimAttempt,
    updatedUtc,
  };
}

/**
 * Plan a bounded matrix while claiming each selected row in the plan's
 * in-memory queue snapshot. The commit lane replays these claims against the
 * fresh state checkout; worker jobs never write shared state.
 */
export function planTasks(queue, requestedWorkers, options = {}) {
  if (!Array.isArray(queue)) throw new TypeError("queue must be an array");
  const settings = options && typeof options === "object" ? options : Number.isFinite(options) ? { now: options } : {};
  const now = Number.isFinite(settings.now) ? settings.now : Date.now();
  const updatedUtc = settings.updatedUtc || new Date(now).toISOString();
  const runId = String(settings.runId || `deep-plan-${now}`);
  const maxWorkers = sanitizeMaxWorkers(requestedWorkers);
  const blocked = sweepExhaustedTasks(queue, now, updatedUtc);
  const selected = [];
  const selectedKeys = new Set();
  const candidates = [
    ...queue.filter((task) => isStaleClaim(task, now) && attemptCount(task) < CLAIM_MAX_ATTEMPTS),
    ...queue.filter((task) => task.status === "pending" && attemptCount(task) < CLAIM_MAX_ATTEMPTS),
  ];
  for (const task of candidates) {
    if (selected.length >= maxWorkers) break;
    const key = taskKey(task);
    if (!key || selectedKeys.has(key)) continue;
    selectedKeys.add(key);
    selected.push(claimRow(task, runId, updatedUtc));
  }
  const worker = selected.length > 0 ? selected : [{ repo: "", kind: "none" }];
  return {
    worker,
    selected,
    blocked,
    runId,
    maxWorkers,
    maxParallel: maxWorkers,
  };
}

export function claimTask(queue, options = {}) {
  const plan = planTasks(queue, 1, options);
  const claimed = plan.selected[0];
  if (!claimed) return null;
  return queue.find((task) => task.repo === claimed.repo
    && task.kind === claimed.kind
    && task.claimRunId === claimed.claimRunId
    && task.claimAttempt === claimed.claimAttempt) || claimed;
}

function buildContext(repo) {
  const meta = gh(["api", `/repos/${repo}`], process.env);
  const readmeRaw = gh(["api", `-H=Accept: application/vnd.github.raw`, `/repos/${repo}/readme`], process.env);
  const commits = gh(["api", `/repos/${repo}/commits?per_page=10`], process.env) || [];
  const pulls = gh(["api", `/repos/${repo}/pulls?state=open&per_page=10`], process.env) || [];
  const lines = [];
  lines.push(`Repo: ${repo}`);
  lines.push(`Default branch: ${meta.default_branch}; pushedAt: ${meta.pushed_at}`);
  lines.push(`Recent commit subjects:`);
  for (const c of commits.slice(0, 10)) lines.push(`- ${String(c.commit && c.commit.message ? c.commit.message.split("\n")[0] : "").slice(0, 120)}`);
  lines.push(`Open PRs: ${pulls.map((p) => `#${p.number} ${p.title}`).join("; ") || "none"}`);
  lines.push(`README excerpt:\n${String(readmeRaw).slice(0, 4000)}`);
  return lines.join("\n").slice(0, 14000);
}

function buildPrompt(task) {
  const focus = {
    "security-audit": "Find security vulnerabilities, leaked credentials patterns, unsafe dependencies, injection points, auth flaws.",
    redteam: "Act as a red teamer: enumerate abuse paths, privilege escalation, CI/CD takeover risks, supply-chain risks.",
    "code-review": "Deep code review: correctness bugs, race conditions, error handling gaps, API misuse, test coverage holes.",
    "docs-audit": "Audit documentation: outdated instructions, broken setup steps, missing runbooks, drift between docs and behavior.",
  }[task.kind] || "General audit.";
  return [
    `You are a specialized deep-audit sub-agent for repo ${task.repo} (kind=${task.kind}).`,
    focus,
    "Return ONLY strict JSON: {\"findings\":[{\"severity\":\"critical|high|medium|low\",\"title\":\"...\",\"detail\":\"...\",\"recommendation\":\"...\"}],\"verdict\":\"one-paragraph summary\"}",
    "Max 12 findings; be specific and evidence-based; do not invent files you have not seen.",
    "A full clone of the repository is mounted at '.' (your working directory). Use read/grep/glob freely to inspect real code before concluding.",
    "Repository context follows:",
    buildContext(task.repo),
  ].join("\n");
}

function parseFindings(reply) {
  const obj = extractJsonObject(reply);
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || !Array.isArray(obj.findings)) {
    throw new Error("missing findings array");
  }
  const allowedSeverities = new Set(["critical", "high", "medium", "low"]);
  const findings = obj.findings.slice(0, 12).map((finding, index) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error(`finding ${index + 1} is not an object`);
    }
    const severity = String(finding.severity || "").toLowerCase();
    const title = String(finding.title || "").trim();
    const detail = String(finding.detail || "").trim();
    const recommendation = String(finding.recommendation || "").trim();
    if (!allowedSeverities.has(severity) || !title || !detail || !recommendation) {
      throw new Error(`finding ${index + 1} has an invalid shape`);
    }
    return { severity, title, detail, recommendation };
  });
  const verdict = String(obj.verdict || "").slice(0, 2000).trim();
  if (!verdict) throw new Error("missing verdict");
  return { findings, verdict };
}

export function reportArtifactName(repo, kind) {
  const safe = (value) => String(value || "unknown").replace(/[^A-Za-z0-9_.-]+/g, "__");
  return `report-${safe(repo)}--${safe(kind)}.json`;
}

// Artifact identities are supplied by a worker and later become report
// filenames. Keep the GitHub owner/name shape and audit kind explicit so a
// malformed or tampered artifact can never escape docs/reports.
export function isValidArtifactIdentity(repo, kind) {
  if (typeof repo !== "string" || typeof kind !== "string") return false;
  const parts = repo.split("/");
  const validPart = (value) => value.length > 0 && value.length <= 100
    && value !== "." && value !== ".."
    && /^[A-Za-z0-9_.-]+$/.test(value);
  return parts.length === 2 && validPart(parts[0]) && validPart(parts[1])
    && validPart(kind);
}

export function isValidArtifactDocument(data, now = Date.now()) {
  if (!isValidArtifactIdentity(data?.repo, data?.kind) || !Array.isArray(data?.findings) || data.findings.length > 12) {
    return false;
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) return false;
  if (!Number.isInteger(data.exitCode) || ![0, 5, 6].includes(data.exitCode)) return false;
  if (typeof data.modelMode !== "string" || !data.modelMode.trim()) return false;
  const finished = Date.parse(String(data.finishedUtc || ""));
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(finished) || finished > now + 5 * 60 * 1000 || now - finished > maxAgeMs) return false;
  return data.findings.every((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return false;
    const severity = String(finding.severity || "").toLowerCase();
    return ["critical", "high", "medium", "low"].includes(severity)
      && Boolean(String(finding.title || "").trim())
      && Boolean(String(finding.detail || "").trim())
      && Boolean(String(finding.recommendation || "").trim());
  });
}

export async function parseFindingsWithRepair(initialResult, repair, maxRepairRounds = 3) {
  let result = initialResult;
  for (let round = 0; round <= maxRepairRounds; round++) {
    if (!result?.complete || !result?.reply) {
      throw Object.assign(new Error("MODEL_UNAVAILABLE"), {
        code: 6,
        reason: "MODEL_UNAVAILABLE",
        sessionId: result?.sessionId || "",
      });
    }
    try {
      return {
        ...parseFindings(result.reply),
        sessionId: result.sessionId || "",
        modelMode: result.modelMode,
      };
    } catch (parseError) {
      if (round >= maxRepairRounds || !result.sessionId) {
        throw Object.assign(new Error("DEEP_FINDINGS_REJECTED"), {
          code: 5,
          reason: "DIRECTIVES_REJECTED",
          sessionId: result.sessionId || "",
          cause: parseError,
        });
      }
      result = await repair(result.sessionId, round + 1);
    }
  }
  throw new Error("unreachable repair loop");
}

function findClaimedTask(queue, data) {
  const hasTaskId = data?.taskId !== undefined && data?.taskId !== null && String(data.taskId) !== "";
  const hasClaimRunId = data?.claimRunId !== undefined && data?.claimRunId !== null && String(data.claimRunId) !== "";
  return queue.find((task) => {
    if (task.repo !== data.repo || task.kind !== data.kind) return false;
    if (task.status !== "in_progress" && task.status !== "pending") return false;
    if (hasTaskId) {
      const taskId = task.id !== undefined && task.id !== null ? String(task.id) : taskKey(task);
      if (taskId !== String(data.taskId)) return false;
    }
    if (hasClaimRunId && String(task.claimRunId || "") !== String(data.claimRunId)) return false;
    return true;
  });
}

function clearClaim(task) {
  delete task.claimRunId;
  delete task.claimAttempt;
}

export function applyArtifactToQueue(queue, data, updatedUtc = new Date().toISOString()) {
  const task = findClaimedTask(queue, data);
  if (!task) return "unmatched";
  if (!Number.isInteger(data?.exitCode) || ![0, 5, 6].includes(data.exitCode)) return "invalid";
  const claimAttempt = Number(data.claimAttempt);
  const hasMatchingClaim = Boolean(data.claimRunId)
    && String(task.claimRunId || "") === String(data.claimRunId);
  task.updatedUtc = updatedUtc;
  if (data.exitCode === 6 || data.modelMode === "model-unavailable") {
    // Provider outages do not consume a validation attempt. A plan claim is
    // rolled back once, while legacy unclaimed artifacts preserve attempts.
    if (hasMatchingClaim && Number.isSafeInteger(claimAttempt) && task.attempts === claimAttempt) {
      task.attempts = Math.max(0, attemptCount(task) - 1);
    }
    task.status = "pending";
    clearClaim(task);
    return "retry";
  }
  if (data.exitCode === 5) {
    // A matching planned claim already consumed this attempt. Legacy callers
    // without claim metadata retain the historical increment behavior.
    if (!(hasMatchingClaim && Number.isSafeInteger(claimAttempt) && task.attempts >= claimAttempt)) {
      task.attempts = attemptCount(task) + 1;
    }
    task.status = task.attempts >= CLAIM_MAX_ATTEMPTS ? "blocked" : "pending";
    clearClaim(task);
    return task.status === "blocked" ? "blocked" : "retry";
  }
  task.status = "done";
  clearClaim(task);
  return "done";
}

function plannedClaims(plan) {
  const rows = Array.isArray(plan) ? plan : plan?.selected || plan?.worker || [];
  return rows.filter((task) => task && task.repo && task.kind && task.kind !== "none");
}

function findPlannedTask(queue, claim) {
  const taskId = claim.taskId ?? claim.id;
  return queue.find((task) => {
    if (task.repo !== claim.repo || task.kind !== claim.kind) return false;
    if (taskId === undefined || taskId === null || String(taskId) === "") return true;
    const currentId = task.id !== undefined && task.id !== null ? String(task.id) : taskKey(task);
    return currentId === String(taskId);
  });
}

/**
 * Replay the planner's claims against the fresh state checkout. This is the
 * only place a commit job turns matrix selections into durable in_progress
 * rows; worker jobs only upload artifacts.
 */
export function applyPlanClaims(queue, plan, options = {}) {
  if (!Array.isArray(queue)) throw new TypeError("queue must be an array");
  const settings = options && typeof options === "object" ? options : Number.isFinite(options) ? { now: options } : {};
  const now = Number.isFinite(settings.now) ? settings.now : Date.now();
  const updatedUtc = settings.updatedUtc || new Date(now).toISOString();
  const claims = plannedClaims(plan);
  const claimed = [];
  let blocked = sweepExhaustedTasks(queue, now, updatedUtc);
  let skipped = 0;
  for (const claim of claims) {
    const task = findPlannedTask(queue, claim);
    if (!task || task.status === "done" || task.status === "blocked") {
      skipped += 1;
      continue;
    }
    const stale = isStaleClaim(task, now);
    const runId = String(claim.claimRunId || plan?.runId || "");
    if (task.status === "in_progress" && !stale && String(task.claimRunId || "") !== runId) {
      // Another active owner has the task; do not steal it or apply a stale
      // artifact to that worker's claim.
      skipped += 1;
      continue;
    }
    const currentAttempts = attemptCount(task);
    if (currentAttempts >= CLAIM_MAX_ATTEMPTS) {
      if (task.status === "pending" || stale) {
        task.status = "blocked";
        task.updatedUtc = updatedUtc;
        delete task.claimRunId;
        delete task.claimAttempt;
        blocked += 1;
      }
      skipped += 1;
      continue;
    }
    if (task.status === "in_progress" && String(task.claimRunId || "") === runId) {
      claimed.push({ ...claim, taskId: task.id ?? claim.taskId, claimRunId: runId, claimAttempt: currentAttempts });
      continue;
    }
    const requestedAttempt = Number(claim.claimAttempt);
    task.attempts = Math.min(
      CLAIM_MAX_ATTEMPTS,
      Math.max(currentAttempts + 1, Number.isSafeInteger(requestedAttempt) ? requestedAttempt : 0),
    );
    task.status = "in_progress";
    task.updatedUtc = updatedUtc;
    task.claimRunId = runId || claim.claimRunId;
    task.claimAttempt = task.attempts;
    claimed.push({
      ...claim,
      taskId: task.id ?? claim.taskId,
      claimRunId: task.claimRunId,
      claimAttempt: task.claimAttempt,
    });
  }
  return { claims: claimed, claimed: claimed.length, blocked, skipped };
}

function markMissingClaims(queue, claims, updatedUtc) {
  let missing = 0;
  let retryable = 0;
  let blocked = 0;
  for (const claim of claims) {
    const task = findPlannedTask(queue, claim);
    if (!task || task.status !== "in_progress" || String(task.claimRunId || "") !== String(claim.claimRunId || "")) continue;
    missing += 1;
    task.updatedUtc = updatedUtc;
    task.status = attemptCount(task) >= CLAIM_MAX_ATTEMPTS ? "blocked" : "pending";
    if (task.status === "blocked") blocked += 1;
    else retryable += 1;
    clearClaim(task);
  }
  return { missing, retryable, blocked };
}

/**
 * Apply every sibling artifact independently, then return unreported claims
 * to pending/blocked. A failed matrix sibling therefore cannot discard a
 * successful sibling's durable report.
 */
export function applyPlannedArtifacts(queue, plan, artifacts = [], options = {}) {
  const settings = options && typeof options === "object" ? options : Number.isFinite(options) ? { now: options } : {};
  const now = Number.isFinite(settings.now) ? settings.now : Date.now();
  const updatedUtc = settings.updatedUtc || new Date(now).toISOString();
  const claimResult = applyPlanClaims(queue, plan, { now, updatedUtc });
  const summary = {
    succeeded: 0,
    retryable: 0,
    blocked: claimResult.blocked,
    missing: 0,
    invalid: 0,
    unmatched: 0,
    claimed: claimResult.claimed,
    skipped: claimResult.skipped,
  };
  for (const artifact of artifacts) {
    let result = applyArtifactToQueue(queue, artifact, updatedUtc);
    if (result === "invalid") {
      summary.invalid += 1;
      result = applyArtifactToQueue(queue, { ...artifact, exitCode: 5 }, updatedUtc);
    }
    if (result === "done") summary.succeeded += 1;
    else if (result === "retry") summary.retryable += 1;
    else if (result === "blocked") summary.blocked += 1;
    else if (result === "unmatched") summary.unmatched += 1;
  }
  const missing = markMissingClaims(queue, claimResult.claims, updatedUtc);
  summary.missing = missing.missing;
  summary.retryable += missing.retryable;
  summary.blocked += missing.blocked;
  return summary;
}

function persistSession(repo, kind, result, repairRound = 0) {
  if (isPublicDataClass(process.env)) return;
  if (!result?.sessionId) return;
  try {
    const sp = path.join(REPO_ROOT, "state", "sessions.json");
    const prev = existsSync(sp) ? JSON.parse(readFileSync(sp, "utf8")) : {};
    prev[`deep-${repo}-${kind}`] = {
      sessionId: result.sessionId,
      modelMode: result.modelMode,
      repairRound,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(sp, JSON.stringify(prev, null, 2));
  } catch {}
}

function loadPersistedSession(repo, kind) {
  if (isPublicDataClass(process.env)) return null;
  try {
    const sp = path.join(REPO_ROOT, "state", "sessions.json");
    const data = existsSync(sp) ? JSON.parse(readFileSync(sp, "utf8")) : {};
    const sessionId = data?.[`deep-${repo}-${kind}`]?.sessionId;
    return typeof sessionId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(sessionId)
      ? { sessionId }
      : null;
  } catch {
    return null;
  }
}

export async function analyzeOne(repo, kind, workdir, audit) {
  const prior = loadPersistedSession(repo, kind);
  const result = await askModel({
    prompt: buildPromptFor({ repo, kind }, workdir),
    workspace: workdir,
    sessionId: prior?.sessionId,
    timeoutMs: 540000,
    env: isPublicDataClass(process.env) ? publicModelEnv(process.env) : process.env,
    preferVariantMax: true,
    maxRounds: 4,
  });
  audit.note("model", `repo=${repo} kind=${kind} complete=${result.complete} resumed=${Boolean(prior?.sessionId)} attempts=${JSON.stringify(result.attempts)}`);
  return parseFindingsWithRepair(result, async (sessionId, repairRound) => {
    audit.note("validator", `deep findings repair round ${repairRound}/3`);
    const repaired = await askModel({
      prompt: "Your previous deep-audit reply was rejected. Re-output ONLY the required strict JSON object with findings and verdict; no prose or fences.",
      workspace: workdir,
      sessionId,
      timeoutMs: 300000,
      env: isPublicDataClass(process.env) ? publicModelEnv(process.env) : process.env,
      preferVariantMax: true,
      maxRounds: 2,
    });
    return repaired;
  });
}

function buildPromptFor(task, workdir) {
  return buildPrompt(task, workdir);
}

function workerClaimMetadata(env = process.env) {
  const metadata = {};
  if (env.FLEET_TASK_ID) metadata.taskId = String(env.FLEET_TASK_ID);
  if (env.FLEET_CLAIM_RUN_ID) metadata.claimRunId = String(env.FLEET_CLAIM_RUN_ID);
  if (env.FLEET_CLAIM_ATTEMPT && /^\d+$/.test(String(env.FLEET_CLAIM_ATTEMPT))) {
    metadata.claimAttempt = Number(env.FLEET_CLAIM_ATTEMPT);
  }
  return metadata;
}

async function mainPlan() {
  if (isPublicDataClass(process.env)) {
    await runGate(process.env);
    const repo = publicRepository(process.env);
    process.stdout.write(`matrix=${JSON.stringify({ worker: [{ repo, kind: process.env.FLEET_KIND || "public-audit" }] })}\n`);
    process.stdout.write("max_parallel=1\n");
    return 0;
  }
  const queue = loadQueue();
  const runId = String(process.env.FLEET_DEEP_RUN_ID || process.env.GITHUB_RUN_ID || `local-${Date.now()}`);
  const plan = planTasks(queue, process.env.FLEET_MAX_WORKERS, { runId });
  // Claims are deliberately emitted as matrix metadata only. The commit job
  // is the sole writer that replays them into the durable state checkout.
  process.stdout.write(`matrix=${JSON.stringify({ worker: plan.worker })}\n`);
  process.stdout.write(`max_parallel=${plan.maxParallel}\n`);
}

async function mainWorker() {
  const runId = `deep-${process.env.FLEET_WORKER_IDX || 0}-${Date.now()}`;
  const audit = new AuditBuffer(scrub(process.env));
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  audit.note("gate", `worker identity=${identity.login}`);
  const publicMode = isPublicDataClass(process.env);
  const repo = publicMode ? publicRepository(process.env) : process.env.FLEET_REPO;
  const kind = process.env.FLEET_KIND || (publicMode ? "public-audit" : "general-audit");
  audit.note("task", `${repo} ${kind}`);
  const artifactDir = publicMode ? resolveArtifactDir(process.env, ".") : (process.env.FLEET_ARTIFACT_DIR || ".");
  if (!publicMode) mkdirSync(artifactDir, { recursive: true });
  const outPath = publicMode ? null : path.join(artifactDir, reportArtifactName(repo, kind));
  const claimMetadata = workerClaimMetadata();
  const writeFailureArtifact = (err, detail) => {
    const code = err?.code === 5 ? 5 : 6;
    const modelMode = code === 6 ? "model-unavailable" : "output-rejected";
    const payload = {
      repo,
      kind,
      ...claimMetadata,
      findings: [],
      verdict: detail,
      modelMode,
      sessionId: err?.sessionId || "",
      finishedUtc: new Date().toISOString(),
      exitCode: code,
    };
    if (publicMode) writePublicArtifact(process.env, payload, { kind: "deep", status: code === 6 ? "deferred" : "rejected", repository: repo, runId });
    else writeFileSync(outPath, JSON.stringify(payload, null, 2));
  };
  const { gatewayDown } = await import("./lib/gateway-health.mjs");
  if (gatewayDown(REPO_ROOT)) {
    // Surfaced, not hidden: outage exits 6 with an explicit artifact so the
    // commit lane and watchdog can see MODEL_UNAVAILABLE. No exit-0 skip.
    const stamp0 = new Date().toISOString();
    const payload = { repo, kind, ...claimMetadata, findings: [], verdict: "Deferred: model unavailable while the gateway circuit is open.", modelMode: "model-unavailable", sessionId: "", finishedUtc: stamp0, exitCode: 6 };
    if (publicMode) writePublicArtifact(process.env, payload, { kind: "deep", status: "deferred", repository: repo, runId });
    else writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log(`DEEP_BLOCKED=circuit-open ${repo} code=6`);
    console.log(`DEEP_RESULT_FILE=${outPath || process.env.FLEET_PUBLIC_ARTIFACT_MANIFEST}`);
    makeExecutionTerminal(process.env, REPO_ROOT, { lane: "deep-worker" })("EXHAUSTED", { runId, repo, kind, code: 6 });
    return 6;
  }
  const cloneRoot = mkdtempSync(path.join(tmpdir(), "fleet-deep-"));
  const cloneDir = path.join(cloneRoot, "repo");
  try {
    gh(["repo", "clone", repo, cloneDir, "--", "--depth", "1"], process.env);
    const analysis = await analyzeOne(repo, kind, cloneDir, audit);
    const payload = { repo, kind, ...claimMetadata, ...analysis, exitCode: 0, finishedUtc: new Date().toISOString() };
    if (publicMode) writePublicArtifact(process.env, payload, { kind: "deep", status: "ok", repository: repo, runId });
    else writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log(`DEEP_RESULT_FILE=${outPath || process.env.FLEET_PUBLIC_ARTIFACT_MANIFEST}`);
    return 0;
  } catch (err) {
    if (err.code === 5 || err.code === 6 || /MODEL_UNAVAILABLE/.test(err.message)) {
      const code = err.code === 5 ? 5 : 6;
      writeFailureArtifact(err, code === 5
        ? "Deferred: model output stayed invalid after three same-session repair rounds."
        : "Deferred: model unavailable; retry when provider health recovers.");
      console.log(`DEEP_RESULT_FILE=${outPath || process.env.FLEET_PUBLIC_ARTIFACT_MANIFEST}`);
      makeExecutionTerminal(process.env, REPO_ROOT, { lane: "deep-worker" })(code === 6 ? "EXHAUSTED" : "REVISION_QUEUED", { runId, repo, kind, code });
      return code;
    }
    throw err;
  } finally {
    rmSync(cloneRoot, { recursive: true, force: true });
  }
}

async function mainCommit() {
  const runId = `deep-commit-${Date.now()}`;
  const audit = new AuditBuffer(scrub(process.env));
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  if (isPublicDataClass(process.env)) {
    writePublicArtifact(process.env, { mode: "commit", status: "blocked", reason: "public-read-only" }, { kind: "deep-commit", status: "blocked", repository: publicRepository(process.env), runId });
    console.log("DEEP_COMMIT_BLOCKED=public-read-only");
    return 4;
  }
  audit.note("gate", `committer identity=${identity.login}`);
  const analyzeResult = String(process.env.FLEET_ANALYZE_RESULT || "").trim();
  const analyzeFailed = Boolean(analyzeResult && !["success", "skipped"].includes(analyzeResult));
  if (analyzeFailed) audit.incident("analyze", `analyze job finished with ${analyzeResult}; applying available sibling artifacts and retrying missing work`);
  const dir = process.env.FLEET_ARTIFACT_DIR || "artifacts";
  const reportsDir = path.join(REPO_ROOT, "docs", "reports");
  mkdirSync(reportsDir, { recursive: true });
  const queue = loadQueue();
  const nowMs = Date.now();
  let plan = [];
  try {
    plan = process.env.FLEET_PLAN_MATRIX ? JSON.parse(process.env.FLEET_PLAN_MATRIX) : [];
  } catch {
    audit.note("plan-invalid", "FLEET_PLAN_MATRIX was not valid JSON; queued work remains retryable");
  }
  const updatedUtc = new Date(nowMs).toISOString();
  const claimResult = applyPlanClaims(queue, plan, { now: nowMs, updatedUtc });
  if (claimResult.blocked > 0) audit.note("queue-blocked", `blocked=${claimResult.blocked}`);
  let processed = 0;
  let acceptedArtifacts = 0;
  let deferredArtifacts = 0;
  let blockedArtifacts = 0;
  let invalidArtifacts = 0;
  const artifactFiles = existsSync(dir)
    ? readdirSync(dir).filter((n) => n.startsWith("report-") && n.endsWith(".json"))
    : [];
  for (const f of artifactFiles) {
    let data;
    try {
      data = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    } catch {
      audit.note("report-invalid", `unreadable artifact ${f}`);
      continue;
    }
    if (!isValidArtifactIdentity(data?.repo, data?.kind)) {
      audit.note("report-invalid", `invalid artifact identity in ${f}`);
      continue;
    }
    if (f !== reportArtifactName(data.repo, data.kind)) {
      audit.note("report-invalid", `artifact filename does not match identity in ${f}`);
      continue;
    }
    if (!isValidArtifactDocument(data)) {
      const queueResult = applyArtifactToQueue(queue, { ...data, exitCode: 5 });
      invalidArtifacts += 1;
      if (queueResult === "retry") deferredArtifacts += 1;
      if (queueResult === "blocked") blockedArtifacts += 1;
      audit.note("report-invalid", `invalid report shape in ${f} state=${queueResult}`);
      continue;
    }
    const queueResult = applyArtifactToQueue(queue, data);
    if (queueResult === "unmatched") {
      audit.note("report-unmatched", `${data.repo || "unknown"} ${data.kind || "unknown"}`);
      continue;
    }
    acceptedArtifacts += 1;
    persistSession(data.repo, data.kind, data, data.repairRound || 0);
    // Deferred/rejected artifacts update durable queue state but are never
    // published as audit findings or counted as successful reports.
    if (data.exitCode === 5 || data.exitCode === 6 || data.modelMode === "model-unavailable") {
      if (queueResult === "retry") deferredArtifacts += 1;
      if (queueResult === "blocked") blockedArtifacts += 1;
      audit.note("report-deferred", `${data.repo} ${data.kind} state=${queueResult}`);
      continue;
    }
    const day = String(data.finishedUtc || new Date().toISOString()).slice(0, 10);
    const file = path.join(reportsDir, `${data.repo.replace("/", "__")}--${data.kind}--${day}.md`);
    const md = [
      `# Deep ${data.kind} — ${data.repo}`,
      "",
      `- generatedUtc: ${data.finishedUtc}`,
      `- model: ${data.modelMode}`,
      "",
      `## Verdict`,
      "",
      data.verdict,
      "",
      `## Findings`,
      "",
      ...(data.findings || []).map((x) => `### [${x.severity}] ${x.title}\n\n${x.detail}\n\n**Recommendation:** ${x.recommendation}\n`),
    ].join("\n");
    writeFileSync(file, md);
    if (queueResult === "done") processed += 1;
  }
  const missingClaims = markMissingClaims(queue, claimResult.claims, updatedUtc);
  if (missingClaims.missing > 0) {
    audit.note("reports-missing", `missing=${missingClaims.missing} retryable=${missingClaims.retryable} blocked=${missingClaims.blocked}`);
  }
  const plannedCount = plannedClaims(plan).length;
  const claimableCount = queue.filter((t) => t.status === "pending" || t.status === "in_progress").length;
  const retryableSelected = missingClaims.retryable + deferredArtifacts;
  const blockedSelected = missingClaims.blocked + blockedArtifacts;
  const unresolvedSelected = retryableSelected + blockedSelected + invalidArtifacts;
  const noPlanArtifacts = plannedCount === 0 && claimableCount > 0 && acceptedArtifacts === 0;
  const skippedClaims = Math.max(0, plannedCount - claimResult.claimed);
  const runFailed = analyzeFailed || unresolvedSelected > 0 || skippedClaims > 0 || noPlanArtifacts;
  if (runFailed) {
    audit.incident("reports", `partial deep run: planned=${plannedCount} claimed=${claimResult.claimed} skipped=${skippedClaims} accepted=${acceptedArtifacts} missing=${missingClaims.missing} retryable=${retryableSelected} blocked=${blockedSelected} invalid=${invalidArtifacts}`);
  }
  saveQueue(queue);
  audit.note("reports", `written=${processed}`);
  if (gitHasChanges(REPO_ROOT, ["state/queue.jsonl", "state/sessions.json", "docs/reports"])) {
    gitAdd(REPO_ROOT, ["state/queue.jsonl", "state/sessions.json", "docs/reports"]);
    gitCommit(REPO_ROOT, `[fleet] deep reports ${runId}`, identity);
    gitPush(REPO_ROOT, "main", process.env);
    const sha = gitRevParse(REPO_ROOT, "HEAD");
    await verifyCommit(privateRepository(process.env, PRIVATE_REPOSITORY_ENV.control), sha, identity, process.env.FLEET_GH_TOKEN);
    audit.note("push-verify", `attribution verified sha=${sha.slice(0, 10)}`);
  }
  const terminalStatus = runFailed ? "EXHAUSTED" : "SUCCESS";
  makeExecutionTerminal(process.env, REPO_ROOT, { lane: "deep-commit" })(terminalStatus, {
    runId,
    reportsCommitted: processed,
    missing: missingClaims.missing,
    retryable: retryableSelected,
    blocked: blockedSelected,
    skippedClaims,
  });
  writeExecutionAudit(audit, process.env, REPO_ROOT, runId, "Deep commit", runFailed ? "partial" : "ok", { lane: "deep-commit" });
  console.log(`FLEET_RUN_RESULT=${JSON.stringify({ runId, status: runFailed ? "partial" : "ok", reportsCommitted: processed, retryable: retryableSelected, blocked: blockedSelected, skippedClaims })}`);
  return runFailed ? 6 : 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const mode = process.env.FLEET_DEEP_MODE;
  if (mode === "plan") process.exit(await mainPlan());
  else process.exit(mode === "commit" ? await mainCommit() : await mainWorker());
}
