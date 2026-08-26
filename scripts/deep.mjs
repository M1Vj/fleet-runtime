#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, readmeExcerptWithFallback, gitAdd, gitCommit, gitPush, gitHasChanges, gitRevParse, configureIdentity } from "./lib/util.mjs";
import { askModel, disposeModelWorkspace } from "./lib/model.mjs";
import { createPublicSourceWorkspace } from "./lib/source-workspace.mjs";
import { appendMemoryEntry, repoMemoryFilePath } from "./lib/fleet-memory.mjs";
import { verifyCommit } from "./lib/verify.mjs";
import { extractJsonObject } from "./lib/directives.mjs";
import { makeTerminal } from "./lib/terminal.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = process.env.FLEET_STATE_ROOT ? path.resolve(process.env.FLEET_STATE_ROOT) : CODE_ROOT;
const QUEUE_PATH = path.join(REPO_ROOT, "state", "queue.jsonl");

function loadQueue() {
  if (!existsSync(QUEUE_PATH)) return [];
  return readFileSync(QUEUE_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function saveQueue(queue) {
  writeFileSync(QUEUE_PATH, queue.map((t) => JSON.stringify(t)).join("\n") + "\n");
}

export function claimTask(queue) {
  const now = Date.now();
  const staleMs = 40 * 60 * 1000;
  let task =
    queue.find((t) => t.status === "in_progress" && t.updatedUtc && now - new Date(t.updatedUtc).getTime() > staleMs && (t.attempts || 0) < 3) ||
    queue.find((t) => t.status === "pending");
  if (!task) return null;
  if (task.status !== "in_progress") {
    task.attempts = (task.attempts || 0) + 1;
  } else {
    task.attempts = (task.attempts || 0) + 1;
  }
  task.status = "in_progress";
  task.updatedUtc = new Date().toISOString();
  return task;
}

function buildContext(repo) {
  const meta = gh(["api", `/repos/${repo}`], process.env);
  const readmeRaw = readmeExcerptWithFallback(() => gh(["api", `-H=Accept: application/vnd.github.raw`, `/repos/${repo}/readme`], process.env));
  const commits = gh(["api", `/repos/${repo}/commits?per_page=10`], process.env) || [];
  const pulls = gh(["api", `/repos/${repo}/pulls?state=open&per_page=10`], process.env) || [];
  const lines = [];
  lines.push(`Repo: ${repo}`);
  lines.push(`Default branch: ${meta.default_branch}; pushedAt: ${meta.pushed_at}`);
  lines.push(`Recent commit subjects:`);
  for (const c of commits.slice(0, 10)) lines.push(`- ${String(c.commit && c.commit.message ? c.commit.message.split("\n")[0] : "").slice(0, 120)}`);
  lines.push(`Open PRs: ${pulls.map((p) => `#${p.number} ${p.title}`).join("; ") || "none"}`);
  lines.push(`README excerpt:\n${readmeRaw.slice(0, 4000)}`);
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
    task.hasSource
      ? "A shallow clone of the verified-public repository is mounted at './source' (inside your working directory). Use read/grep/glob freely to inspect that real code before concluding."
      : "No repository files are mounted; base every finding on the repository context below and say so when evidence is insufficient.",
    "Repository context follows:",
    buildContext(task.repo),
  ].join("\n");
}

function parseFindings(reply) {
  const obj = extractJsonObject(reply);
  if (!Array.isArray(obj.findings)) throw new Error("missing findings array");
  return {
    findings: obj.findings.slice(0, 12),
    verdict: String(obj.verdict || "").slice(0, 2000),
  };
}

export async function analyzeOne(repo, kind, prepared, audit) {
  const result = await askModel({
    prompt: buildPromptFor({ repo, kind, hasSource: Boolean(prepared) }),
    ...(prepared ? { workspace: prepared.workspace, profile: "public-read", publicTarget: prepared.meta } : {}),
    timeoutMs: 540000,
    env: process.env,
    preferVariantMax: true,
    maxRounds: 4,
  });
  audit.note("model", `repo=${repo} kind=${kind} complete=${result.complete} attempts=${JSON.stringify(result.attempts)}`);
  if (!result.complete || !result.reply) throw Object.assign(new Error("MODEL_UNAVAILABLE"), { code: 6, reason: "MODEL_UNAVAILABLE" });
  try {
    return { ...parseFindings(result.reply), sessionId: result.sessionId, modelMode: result.modelMode };
  } catch (err) {
    audit.note("parse-fallback", `unparsable model reply (${String(err.message).slice(0, 100)}); recording degraded findings`);
    return {
      findings: [{ severity: "medium", title: "review output unusable", detail: String(err.message).slice(0, 200) }],
      verdict: "Model reply could not be parsed into structured findings; re-run this lane.",
      sessionId: result.sessionId,
      modelMode: result.modelMode,
    };
  }
}

function buildPromptFor(task) {
  return buildPrompt(task);
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
  const { gatewayDown } = await import("./lib/gateway-health.mjs");
  if (gatewayDown(process.env.FLEET_STATE_ROOT || process.cwd())) {
    const stamp0 = new Date().toISOString();
    writeFileSync(
      path.join(process.env.FLEET_ARTIFACT_DIR || ".", `report-${repo.replace("/", "__")}.json`),
      JSON.stringify({ repo, kind, findings: [{ severity: "low", title: "skipped", detail: "gateway circuit open" }], verdict: "Skipped during gateway outage.", modelMode: "skipped", sessionId: "", finishedUtc: stamp0 }, null, 2),
    );
    console.log(`DEEP_SKIPPED=circuit-open ${repo}`);
    console.log(`DEEP_RESULT_FILE=${path.join(process.env.FLEET_ARTIFACT_DIR || ".", `report-${repo.replace("/", "__")}.json`)}`);
    writeFileSync(path.join(process.env.FLEET_ARTIFACT_DIR || ".", `report-${repo.replace("/", "__")}.json`), JSON.stringify({ repo, kind, findings: [{ severity: "low", title: "skipped", detail: "gateway circuit open" }], verdict: "Skipped during gateway outage." }, null, 2));
    console.log(`DEEP_RESULT_FILE=${path.join(process.env.FLEET_ARTIFACT_DIR || ".", `report-${repo.replace("/", "__")}.json`)}`);
    return 0;
  }
  const meta = gh(["api", `/repos/${repo}`], process.env);
  const publicVerified = Boolean(meta) && meta.private === false && meta.visibility === "public";
  let prepared;
  if (publicVerified) {
    try {
      prepared = { ...createPublicSourceWorkspace(repo, meta), meta };
      audit.note("workspace", `public-read source mount for ${repo}`);
    } catch (error) {
      audit.note("workspace", `public mount unavailable for ${repo} (${String(error.message || error).slice(0, 80)}); falling back to prompt-only`);
      prepared = undefined;
    }
  } else {
    audit.note("workspace", `${repo} is not verified public; prompt-only deny-all analysis`);
  }
  let analysis;
  try {
    analysis = await analyzeOne(repo, kind, prepared, audit);
  } catch (err) {
    if (err.code === 6 || /MODEL_UNAVAILABLE/.test(err.message)) {
      const { gatewayDown } = await import("./lib/gateway-health.mjs");
      if (gatewayDown(process.env.FLEET_STATE_ROOT || process.cwd())) {
        audit.note("analyze", "probe confirmed outage; skipping gracefully");
        writeFileSync(path.join(process.env.FLEET_ARTIFACT_DIR || ".", `report-${repo.replace("/", "__")}.json`), JSON.stringify({ repo, kind, findings: [{ severity: "low", title: "skipped", detail: "gateway outage" }], verdict: "Skipped during confirmed gateway outage." }, null, 2));
        console.log(`DEEP_RESULT_FILE=${path.join(process.env.FLEET_ARTIFACT_DIR || ".", `report-${repo.replace("/", "__")}.json`)}`);
        return 0;
      }
    }
    throw err;
  } finally {
    if (prepared) disposeModelWorkspace(prepared.workspace);
  }
  const outPath = path.join(process.env.FLEET_ARTIFACT_DIR || ".", `report-${repo.replace("/", "__")}.json`);
  writeFileSync(outPath, JSON.stringify({ repo, kind, ...analysis, finishedUtc: new Date().toISOString() }, null, 2));
  console.log(`DEEP_RESULT_FILE=${outPath}`);
  return 0;
}

/** Best-effort per-repo fleet-memory entry for one deep-audit report. */
function appendDeepRepoMemoryEntry(stateRoot, repo, kind, findings, audit) {
  try {
    if (!stateRoot || !repo) return false;
    const severityCounts = {};
    for (const finding of Array.isArray(findings) ? findings : []) {
      const severity = String(finding && finding.severity || "unknown").toLowerCase().replace(/[^a-z]/g, "").slice(0, 16) || "unknown";
      severityCounts[severity] = (severityCounts[severity] || 0) + 1;
    }
    const detail = Object.keys(severityCounts).sort().map((key) => `${key}=${severityCounts[key]}`).join(",") || "none";
    const file = repoMemoryFilePath(stateRoot, repo);
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    const next = appendMemoryEntry(existing, {
      stampUtc: new Date().toISOString(),
      lane: "deep",
      repo,
      summary: `${String(kind || "audit").slice(0, 40)} report: findings ${detail}`,
    });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, next, "utf8");
    audit?.note?.("memory", `deep memory entry repo=${String(repo).slice(0, 100)} ${detail}`);
    return true;
  } catch (error) {
    audit.note("memory", `deep memory entry skipped: ${String(error.message || error).slice(0, 160)}`);
    return false;
  }
}

async function mainCommit() {
  const runId = `deep-commit-${Date.now()}`;
  const audit = new AuditBuffer(scrub(process.env));
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  audit.note("gate", `committer identity=${identity.login}`);
  const dir = process.env.FLEET_ARTIFACT_DIR;
  const reportsDir = path.join(REPO_ROOT, "docs", "reports");
  mkdirSync(reportsDir, { recursive: true });
  const queue = loadQueue();
  let processed = 0;
  for (const f of readdirSync(dir).filter((n) => n.startsWith("report-") && n.endsWith(".json"))) {
    const data = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    const day = String(data.finishedUtc || new Date().toISOString()).slice(0, 10);
    const file = path.join(reportsDir, `${data.repo.replace("/", "__")}--${data.kind}--${day}.md`);
    const md = [
      `# Deep ${data.kind} — ${data.repo}`,
      "",
      `- generatedUtc: ${data.finishedUtc}`,
      `- model: opencode/x-preview-f-free (${data.modelMode})`,
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
    appendDeepRepoMemoryEntry(REPO_ROOT, data.repo, data.kind, data.findings, audit);
    for (const t of queue) {
      if (t.repo === data.repo && t.kind === data.kind && (t.status === "in_progress" || t.status === "pending")) {
        t.status = "done";
        t.updatedUtc = new Date().toISOString();
        processed += 1;
      }
    }
  }
  saveQueue(queue);
  audit.note("reports", `written=${processed}`);
  makeTerminal(REPO_ROOT)("SUCCESS", { runId, reportsCommitted: processed });
  const commitPaths = ["state/queue.jsonl", "docs/reports"];
  if (existsSync(path.join(REPO_ROOT, "state", "memory"))) commitPaths.push("state/memory");
  if (gitHasChanges(REPO_ROOT, commitPaths)) {
    gitAdd(REPO_ROOT, commitPaths);
    gitCommit(REPO_ROOT, `[fleet] deep reports ${runId}`, identity);
    gitPush(REPO_ROOT, "main", process.env);
    const sha = gitRevParse(REPO_ROOT, "HEAD");
    await verifyCommit("M1Vj/fleet-control", sha, identity, process.env.FLEET_GH_TOKEN);
    audit.note("push-verify", `attribution verified sha=${sha.slice(0, 10)}`);
  }
  audit.writeMarkdown(path.join(REPO_ROOT, "audit"), runId, "Deep commit", "ok", { lane: "deep-commit" });
  console.log(`FLEET_RUN_RESULT=${JSON.stringify({ runId, status: "ok", reportsCommitted: processed })}`);
  return 0;
}

const mode = process.env.FLEET_DEEP_MODE;
if (mode === "commit") {
  process.exit(await mainCommit());
} else {
  process.exit(await mainWorker());
}
