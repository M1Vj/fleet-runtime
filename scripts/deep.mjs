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
import { makeTerminal } from "./lib/terminal.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = process.env.FLEET_STATE_ROOT ? path.resolve(process.env.FLEET_STATE_ROOT) : CODE_ROOT;
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

export function claimTask(queue) {
  const now = Date.now();
  const staleMs = CLAIM_RECLAIM_MS;
  // Sweep: stale in_progress tasks that exhausted attempts become blocked so
  // the loop never spins forever; watchdog/commit persists this transition.
  for (const t of queue) {
    const exhaustedPending = t.status === "pending" && (t.attempts || 0) >= CLAIM_MAX_ATTEMPTS;
    const exhaustedStale = t.status === "in_progress" && (t.attempts || 0) >= CLAIM_MAX_ATTEMPTS && t.updatedUtc && now - new Date(t.updatedUtc).getTime() > staleMs;
    if (exhaustedPending || exhaustedStale) {
      t.status = "blocked";
      t.updatedUtc = new Date().toISOString();
    }
  }
  let task =
    queue.find((t) => t.status === "in_progress" && t.updatedUtc && now - new Date(t.updatedUtc).getTime() > staleMs && (t.attempts || 0) < CLAIM_MAX_ATTEMPTS) ||
    queue.find((t) => t.status === "pending" && (t.attempts || 0) < CLAIM_MAX_ATTEMPTS);
  if (!task) return null;
  task.attempts = (task.attempts || 0) + 1;
  if (task.attempts >= CLAIM_MAX_ATTEMPTS && task.status === "in_progress") {
    // Claimed for its final attempt; commit lane will mark blocked on failure.
  }
  task.status = "in_progress";
  task.updatedUtc = new Date().toISOString();
  return task;
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

export function applyArtifactToQueue(queue, data, updatedUtc = new Date().toISOString()) {
  const task = queue.find((t) =>
    t.repo === data.repo && t.kind === data.kind &&
    (t.status === "in_progress" || t.status === "pending"));
  if (!task) return "unmatched";
  if (!Number.isInteger(data?.exitCode) || ![0, 5, 6].includes(data.exitCode)) return "invalid";
  task.updatedUtc = updatedUtc;
  if (data.exitCode === 6 || data.modelMode === "model-unavailable") {
    task.status = "pending";
    return "retry";
  }
  if (data.exitCode === 5) {
    task.attempts = (task.attempts || 0) + 1;
    task.status = task.attempts >= CLAIM_MAX_ATTEMPTS ? "blocked" : "pending";
    return task.status === "blocked" ? "blocked" : "retry";
  }
  task.status = "done";
  return "done";
}

function persistSession(repo, kind, result, repairRound = 0) {
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
    env: process.env,
    preferVariantMax: true,
    maxRounds: 4,
  });
  audit.note("model", `repo=${repo} kind=${kind} complete=${result.complete} resumed=${Boolean(prior?.sessionId)} attempts=${JSON.stringify(result.attempts)}`);
  persistSession(repo, kind, result);
  return parseFindingsWithRepair(result, async (sessionId, repairRound) => {
    audit.note("validator", `deep findings repair round ${repairRound}/3`);
    const repaired = await askModel({
      prompt: "Your previous deep-audit reply was rejected. Re-output ONLY the required strict JSON object with findings and verdict; no prose or fences.",
      workspace: workdir,
      sessionId,
      timeoutMs: 300000,
      env: process.env,
      preferVariantMax: true,
      maxRounds: 2,
    });
    persistSession(repo, kind, repaired, repairRound);
    return repaired;
  });
}

function buildPromptFor(task, workdir) {
  return buildPrompt(task, workdir);
}

async function mainWorker() {
  const runId = `deep-${process.env.FLEET_WORKER_IDX || 0}-${Date.now()}`;
  const audit = new AuditBuffer(scrub(process.env));
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  audit.note("gate", `worker identity=${identity.login}`);
  const repo = process.env.FLEET_REPO;
  const kind = process.env.FLEET_KIND;
  audit.note("task", `${repo} ${kind}`);
  const artifactDir = process.env.FLEET_ARTIFACT_DIR || ".";
  mkdirSync(artifactDir, { recursive: true });
  const outPath = path.join(artifactDir, reportArtifactName(repo, kind));
  const writeFailureArtifact = (err, detail) => {
    const code = err?.code === 5 ? 5 : 6;
    const modelMode = code === 6 ? "model-unavailable" : "output-rejected";
    writeFileSync(outPath, JSON.stringify({
      repo,
      kind,
      findings: [],
      verdict: detail,
      modelMode,
      sessionId: err?.sessionId || "",
      finishedUtc: new Date().toISOString(),
      exitCode: code,
    }, null, 2));
  };
  const { gatewayDown } = await import("./lib/gateway-health.mjs");
  if (gatewayDown(process.env.FLEET_STATE_ROOT || process.cwd())) {
    // Surfaced, not hidden: outage exits 6 with an explicit artifact so the
    // commit lane and watchdog can see MODEL_UNAVAILABLE. No exit-0 skip.
    const stamp0 = new Date().toISOString();
    writeFileSync(outPath, JSON.stringify({ repo, kind, findings: [], verdict: "Deferred: model unavailable while the gateway circuit is open.", modelMode: "model-unavailable", sessionId: "", finishedUtc: stamp0, exitCode: 6 }, null, 2));
    console.log(`DEEP_BLOCKED=circuit-open ${repo} code=6`);
    console.log(`DEEP_RESULT_FILE=${outPath}`);
    makeTerminal(REPO_ROOT, { lane: "deep-worker" })("EXHAUSTED", { runId, repo, kind, code: 6 });
    return 6;
  }
  const cloneRoot = mkdtempSync(path.join(tmpdir(), "fleet-deep-"));
  const cloneDir = path.join(cloneRoot, "repo");
  try {
    gh(["repo", "clone", repo, cloneDir, "--", "--depth", "1"], process.env);
    const analysis = await analyzeOne(repo, kind, cloneDir, audit);
    writeFileSync(outPath, JSON.stringify({ repo, kind, ...analysis, exitCode: 0, finishedUtc: new Date().toISOString() }, null, 2));
    console.log(`DEEP_RESULT_FILE=${outPath}`);
    return 0;
  } catch (err) {
    if (err.code === 5 || err.code === 6 || /MODEL_UNAVAILABLE/.test(err.message)) {
      const code = err.code === 5 ? 5 : 6;
      writeFailureArtifact(err, code === 5
        ? "Deferred: model output stayed invalid after three same-session repair rounds."
        : "Deferred: model unavailable; retry when provider health recovers.");
      console.log(`DEEP_RESULT_FILE=${outPath}`);
      makeTerminal(REPO_ROOT, { lane: "deep-worker" })(code === 6 ? "EXHAUSTED" : "REVISION_QUEUED", { runId, repo, kind, code });
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
  audit.note("gate", `committer identity=${identity.login}`);
  const analyzeResult = String(process.env.FLEET_ANALYZE_RESULT || "").trim();
  if (analyzeResult && !["success", "skipped"].includes(analyzeResult)) {
    audit.incident("analyze", `analyze job finished with ${analyzeResult}; reports not publishable`);
    makeTerminal(REPO_ROOT, { lane: "deep-commit" })("EXHAUSTED", { runId, analyzeResult });
    return 6;
  }
  const dir = process.env.FLEET_ARTIFACT_DIR || "artifacts";
  const reportsDir = path.join(REPO_ROOT, "docs", "reports");
  mkdirSync(reportsDir, { recursive: true });
  const queue = loadQueue();
  // Finish-loop sweep: stale in_progress tasks at max attempts become blocked.
  const nowMs = Date.now();
  for (const t of queue) {
    if (t.status === "in_progress" && (t.attempts || 0) >= CLAIM_MAX_ATTEMPTS && t.updatedUtc && nowMs - new Date(t.updatedUtc).getTime() > CLAIM_RECLAIM_MS) {
      t.status = "blocked";
      t.updatedUtc = new Date().toISOString();
      audit.note("queue-blocked", `${t.repo} ${t.kind} attempts=${t.attempts}`);
    }
  }
  let processed = 0;
  let acceptedArtifacts = 0;
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
  const claimableCount = queue.filter((t) => t.status === "pending" || t.status === "in_progress").length;
  if (claimableCount > 0 && acceptedArtifacts === 0) {
    audit.incident("reports", `no valid artifacts accepted for ${claimableCount} queued task(s)`);
    makeTerminal(REPO_ROOT, { lane: "deep-commit" })("EXHAUSTED", { runId, claimableCount });
    return 6;
  }
  saveQueue(queue);
  audit.note("reports", `written=${processed}`);
  if (gitHasChanges(REPO_ROOT, ["state/queue.jsonl", "state/sessions.json", "docs/reports"])) {
    gitAdd(REPO_ROOT, ["state/queue.jsonl", "state/sessions.json", "docs/reports"]);
    gitCommit(REPO_ROOT, `[fleet] deep reports ${runId}`, identity);
    gitPush(REPO_ROOT, "main", process.env);
    const sha = gitRevParse(REPO_ROOT, "HEAD");
    await verifyCommit("M1Vj/fleet-control", sha, identity, process.env.FLEET_GH_TOKEN);
    audit.note("push-verify", `attribution verified sha=${sha.slice(0, 10)}`);
  }
  makeTerminal(REPO_ROOT)("SUCCESS", { runId, reportsCommitted: processed });
  audit.writeMarkdown(path.join(REPO_ROOT, "audit"), runId, "Deep commit", "ok", { lane: "deep-commit" });
  console.log(`FLEET_RUN_RESULT=${JSON.stringify({ runId, status: "ok", reportsCommitted: processed })}`);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const mode = process.env.FLEET_DEEP_MODE;
  process.exit(mode === "commit" ? await mainCommit() : await mainWorker());
}
