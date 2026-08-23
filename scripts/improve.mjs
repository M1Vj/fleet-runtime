#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, ghInput, putFileContent, ensureBranch, gitAdd, gitCommit, gitPush, gitHasChanges, gitRevParse, sha256, configureIdentity } from "./lib/util.mjs";
import { askModel } from "./lib/model.mjs";
import { verifyCommit, verifyPullAuthor, verifyCommentAuthor } from "./lib/verify.mjs";
import { makeTerminal } from "./lib/terminal.mjs";
import { isSafeRepoPath, sanitizeControlChars, extractJsonObject } from "./lib/directives.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = process.env.FLEET_STATE_ROOT ? path.resolve(process.env.FLEET_STATE_ROOT) : CODE_ROOT;
const STATE_PATH = path.join(REPO_ROOT, "state", "improve-state.json");

function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

export function rankRepos(repos) {
  const now = Date.now();
  return repos
    .map((r) => {
      const ageDays = (now - new Date(r.pushed_at).getTime()) / 86400000;
      const recency = Math.max(0, 30 - Math.min(30, ageDays));
      const activity = r.open_issues_count || 0;
      return { full_name: r.full_name, pushed_at: r.pushed_at, score: recency * 2 + activity };
    })
    .sort((a, b) => b.score - a.score);
}

async function modePick(audit) {
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  const repos = gh(["api", "/user/repos?affiliation=owner&per_page=100&sort=pushed"], process.env) || [];
  const topK = Number(process.env.FLEET_TOP_K || 2);
  const ranked = rankRepos(repos.filter((r) => !r.archived && r.full_name !== "M1Vj/fleet-control")).slice(0, topK);
  audit.note("pick", ranked.map((r) => `${r.full_name}(${r.score})`).join(", "));
  console.log(`IMPROVE_MATRIX=${JSON.stringify({ repo: ranked.map((r) => r.full_name) })}`);
  return 0;
}

function buildResearchPrompt(repo, workdir) {
  const meta = gh(["api", `/repos/${repo}`], process.env);
  const commits = gh(["api", `/repos/${repo}/commits?per_page=15`], process.env) || [];
  const pulls = gh(["api", `/repos/${repo}/pulls?state=open&per_page=10`], process.env) || [];
  const issuesRaw = gh(["api", `/repos/${repo}/issues?state=open&per_page=15`], process.env) || [];
  const langs = gh(["api", `/repos/${repo}/languages`], process.env) || {};
  const lines = [
    `Repo ${repo} (${meta.description || "no description"}). Languages: ${Object.keys(langs).join(",")}. Default branch: ${meta.default_branch}.`,
    `Recent commits:\n${commits.slice(0, 15).map((c) => `- ${String((c.commit && c.commit.message) || "").split("\n")[0].slice(0, 110)}`).join("\n")}`,
    `Open PRs: ${pulls.map((p) => `#${p.number} ${p.title}`).join("; ") || "none"}`,
    `Open issues: ${issuesRaw.filter((i) => !i.pull_request).map((i) => `#${i.number} ${i.title}`).join("; ") || "none"}`,
  ];
  return [
    `You are the research sub-agent for repo ${repo}. A full shallow clone is mounted at your working directory ('.')${workdir ? "" : " (digest-only mode)"} — use read/grep/glob on real code before concluding. Decide what would MOST improve this project right now (correctness, security, DX, performance, docs, CI). You may use webfetch to consult authoritative sources.`,
    "Return ONLY strict JSON: {\"ideas\":[{\"title\":\"...\",\"rationale\":\"...\",\"evidence\":\"what you saw\",\"impact\":\"high|medium|low\"}]} max 5 ideas.",
    "Context:",
    lines.join("\n").slice(0, 14000),
  ].join("\n");
}

async function modeResearch(audit) {
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  const repo = process.env.FLEET_REPO;
  const result = await askModel({ prompt: buildResearchPrompt(repo), timeoutMs: 480000, env: process.env, preferVariantMax: true });
  audit.note("research", `repo=${repo} complete=${result.complete} attempts=${JSON.stringify(result.attempts)}`);
  if (!result.complete || !result.reply) throw Object.assign(new Error("MODEL_UNAVAILABLE"), { code: 6, reason: "MODEL_UNAVAILABLE" });
  const outDir = process.env.FLEET_ARTIFACT_DIR || ".";
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `ideas-${repo.replace("/", "__")}.json`);
  writeFileSync(file, JSON.stringify({ repo, reply: result.reply }, null, 2));
  console.log(`IMPROVE_DONE=research:${repo}`);
  return 0;
}

export { extractJsonObject as extractJsonRobust };

export function extractJson(replyText) {
  return extractJsonObject(replyText);
}

export function pickBestIdea(replyText) {
  const obj = extractJson(replyText);
  if (!Array.isArray(obj.ideas) || obj.ideas.length === 0) throw new Error("no ideas");
  const rank = { high: 3, medium: 2, low: 1 };
  return obj.ideas.slice().sort((a, b) => (rank[b.impact] || 0) - (rank[a.impact] || 0))[0];
}

export function extractFileBlocks(text) {
  const files = [];
  const fileRe = /^FILE path=(.+)$/gm;
  const matches = [...String(text).matchAll(fileRe)];
  for (let i = 0; i < matches.length; i++) {
    const path = matches[i][1].trim();
    const after = String(text).slice(matches[i].index + matches[i][0].length);
    const fence = after.match(/```[a-zA-Z0-9]*\n([\s\S]*?)\n```/);
    if (!fence) continue;
    files.push({ path, content: fence[1] });
  }
  return files;
}

export function parsePlanV3(replyText, fallbackTitle) {
  const text = String(replyText);
  const grab = (label) => {
    const m = text.match(new RegExp(`^${label}:\\s*(.+)$`, "mi"));
    return m ? m[1].trim() : "";
  };
  const files = extractFileBlocks(text);
  if (files.length === 0 || files.length > 6) throw new Error("v3 files invalid");
  for (const f of files) {
    if (!isSafeRepoPath(f.path)) throw new Error(`forbidden path ${f.path}`);
    if (f.content.length > 15000) throw new Error("file too large");
  }
  return {
    title: grab("TITLE") || fallbackTitle || "fleet improvement",
    summary: grab("SUMMARY"),
    prBody: grab("SUMMARY"),
    risks: grab("RISKS"),
    files,
  };
}

export function parsePlanV2(replyText) {
  const text = String(replyText).replace(/^\uFEFF/, "").trim();
  const lines = text.split("\n");
  let planIdx = lines.findIndex((l) => l.trim().toUpperCase().startsWith("PLAN"));
  if (planIdx === -1) planIdx = lines.findIndex((l) => l.includes("\"title\"") || l.trim() === "{");
  if (planIdx === -1) throw new Error("no PLAN marker");
  const rest = lines.slice(planIdx + 1);
  const stopIdx = rest.findIndex((l) => /^(FILE path=|```)/.test(l.trim()));
  const metaChunkLines = (stopIdx === -1 ? rest : rest.slice(0, stopIdx)).filter((l) => !/^```/.test(l.trim()));
  if (metaChunkLines.length === 0) throw new Error("no meta section");
  const meta = extractJson(metaChunkLines.join("\n"));
  const files = extractFileBlocks(text);
  if (files.length === 0 || files.length > 6) throw new Error("v2 files invalid");
  for (const f of files) {
    if (!isSafeRepoPath(f.path)) throw new Error(`forbidden path ${f.path}`);
    if (f.content.length > 15000) throw new Error("file too large");
  }
  return {
    title: String(meta.title || "").slice(0, 120),
    summary: String(meta.summary || "").slice(0, 1000),
    prBody: String(meta.prBody || "").slice(0, 6000),
    files,
    risks: String(meta.risks || "").slice(0, 800),
  };
}

export function parsePlan(replyText) {
  const obj = extractJson(replyText);
  if (!Array.isArray(obj.files) || obj.files.length === 0 || obj.files.length > 6) throw new Error("files invalid");
  for (const f of obj.files) {
    if (!f.path || typeof f.content !== "string") throw new Error("file entry invalid");
    if (!isSafeRepoPath(f.path)) throw new Error(`forbidden path ${f.path}`);
    if (f.content.length > 15000) throw new Error("file too large");
  }
  return {
    title: String(obj.title || "").slice(0, 120),
    summary: String(obj.summary || "").slice(0, 1000),
    prBody: String(obj.prBody || "").slice(0, 6000),
    files: obj.files,
    risks: String(obj.risks || "").slice(0, 800),
  };
}

async function modePlan(audit) {
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  const dir = process.env.FLEET_ARTIFACT_DIR || ".";
  const ideaFiles = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("ideas-") && f.endsWith(".json")) : [];
  let plans = 0;
  for (const f of ideaFiles) {
    const data = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    let idea;
    try {
      idea = pickBestIdea(data.reply);
    } catch (err) {
      audit.note("plan", `${data.repo}: ideas unparsable (${err.message})`);
      continue;
    }
    let workdir;
    try {
      workdir = `/tmp/improve-plan-${String(data.repo).replace("/", "__")}`;
      gh(["repo", "clone", repo0(data.repo), workdir, "--", "--depth", "1"], process.env);
    } catch {
      workdir = undefined;
    }
    const planPrompt = [
      `You are the planning sub-agent for repo ${data.repo}. Turn this improvement idea into a concrete minimal implementation plan.`,
      `Idea: ${idea.title}. Rationale: ${idea.rationale}. Evidence: ${idea.evidence}.`,
      workdir ? `A shallow clone of the repository is mounted at your working directory ('.') — inspect real code with read/grep/glob before planning.` : "",
      "You may fetch authoritative docs via webfetch if needed.",
      "Respond in EXACTLY this plain-text format (no markdown headers, no extra prose):",
      "PLAN",
      "TITLE: <short title>",
      "SUMMARY: <one line what and why>",
      "RISKS: <one line risks>",
      "Then for EACH file:",
      "FILE path=relative/path",
      "```",
      "<complete raw file content>",
      "```",
      "Constraints: at most 6 files; each file under 15000 chars; no .env*, *.pem, *.key, state/, audit/ paths; no '..' in paths.",
    ].join("\n");
    const plan = await askModel({ prompt: planPrompt, timeoutMs: 480000, env: process.env, preferVariantMax: true, maxRounds: 4, workspace: workdir });
    audit.note("plan", `repo=${data.repo} complete=${plan.complete} attempts=${JSON.stringify(plan.attempts)}`);
    if (workdir) {
      try {
        (await import("node:fs")).rmSync(workdir, { recursive: true, force: true });
      } catch {}
    }
    if (!plan.complete || !plan.reply) continue;
    let parsed;
    try {
      try {
        parsed = parsePlanV3(plan.reply, idea.title);
      } catch (errV3) {
        audit.note("plan-v3", `v3 rejected (${errV3.message.slice(0, 100)})`);
        try {
          parsed = parsePlanV2(plan.reply);
        } catch (errV2) {
          audit.note("plan-v2", `fallbacks rejected (${errV2.message.slice(0, 100)}); repair round`);
          let repair = { complete: false, reply: "", sessionId: plan.sessionId };
          if (plan.sessionId) {
            repair = await askModel({
              prompt: "Your previous answer did not match the required format. Re-output it now following EXACTLY: first line PLAN; then TITLE:, SUMMARY:, RISKS: single-line values; then per file a line FILE path=<path> and one fenced code block with the raw file content. No other prose.",
              sessionId: plan.sessionId,
              timeoutMs: 300000,
              env: process.env,
              preferVariantMax: false,
            });
          }
          if (repair.complete && repair.reply) {
            parsed = parsePlanV3(repair.reply, idea.title);
          } else {
            parsed = parsePlan(plan.reply);
          }
        }
      }
      writeFileSync(path.join(dir, `plan-${data.repo.replace("/", "__")}.json`), JSON.stringify({ repo: data.repo, idea, plan: parsed }, null, 2));
      plans += 1;
      console.log(`IMPROVE_PLAN_OK=${data.repo}`);
    } catch (err) {
      audit.incident("plan-parse", `${data.repo}: ${err.message}`);
    }
  }
  console.log(`IMPROVE_DONE=plan:${plans}`);
  return plans > 0 || ideaFiles.length === 0 ? 0 : 1;
}

async function modeImplement(audit) {
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  const dir = process.env.FLEET_ARTIFACT_DIR || ".";
  const repo = process.env.FLEET_REPO;
  const planFile = path.join(dir, `plan-${repo.replace("/", "__")}.json`);
  if (!existsSync(planFile)) {
    console.log(`IMPROVE_SKIP=${repo}:no-plan`);
    return 0;
  }
  const { plan } = JSON.parse(readFileSync(planFile, "utf8"));
  const meta = gh(["api", `/repos/${repo}`], process.env);
  const base = meta.default_branch;
  const hash = sha256(JSON.stringify([plan.title, plan.files.map((f) => f.path)])).slice(0, 8);
  const branch = `fleet/improve-${hash}`;
  const existing = gh(["api", `-X=GET`, `/repos/${repo}/pulls?head=${encodeURIComponent("M1Vj:" + branch)}&state=open`], process.env);
  if (Array.isArray(existing) && existing.length > 0) {
    console.log(`IMPROVE_DUPLICATE_PR=${existing[0].html_url}`);
    return 0;
  }
  const refData = gh(["api", `/repos/${repo}/git/ref/heads/${base}`], process.env);
  gh(["api", "-X", "POST", `/repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${refData.object.sha}`], process.env);
  for (const f of plan.files) {
    putFileContent(repo, f.path, f.content, branch, `[fleet-improve] ${plan.title}`, process.env);
  }
  const body = [plan.prBody, "", "---", `**Summary:** ${plan.summary}`, "", `**Risks:** ${plan.risks}`, "", "_Generated autonomously by M1Vj fleet-control improve pipeline; review before merge._"].join("\n");
  const pr = ghInput(
    ["api", "-X", "POST", `/repos/${repo}/pulls`],
    { title: `[fleet-improve] ${plan.title}`, body, head: branch, base, draft: true },
    process.env,
  );
  await verifyPullAuthor(repo, pr.number, identity, process.env.FLEET_GH_TOKEN);
  const branchHead = gh(["api", `/repos/${repo}/commits/${branch}`], process.env);
  await verifyCommit(repo, branchHead.sha, identity, process.env.FLEET_GH_TOKEN);
  audit.note("implement", `repo=${repo} pr=#${pr.number} branch=${branch} verified`);
  const outDir = process.env.FLEET_ARTIFACT_DIR || ".";
  writeFileSync(path.join(outDir, `prmeta-${repo.replace("/", "__")}.json`), JSON.stringify({ repo, prNumber: pr.number, prUrl: pr.html_url, branch, title: plan.title }, null, 2));
  console.log(`IMPROVE_DONE=implement:${repo}:#${pr.number}`);
  return 0;
}

const LENSES = {
  correctness: "Act as a meticulous correctness reviewer: bugs, edge cases, race conditions, error handling, test gaps.",
  redteam: "Act as a red teamer: security holes introduced by this change, abuse paths, supply-chain risks, credential exposure.",
  standards: "Act as an industry-standards reviewer: idiomatic style for the language/framework, accessibility, performance norms, docs expectations.",
};

async function modeReview(audit) {
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  const dir = process.env.FLEET_ARTIFACT_DIR || ".";
  const lens = process.env.FLEET_LENS;
  const prmetas = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("prmeta-") && f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"))) : [];
  mkdirSync(path.join(dir, "..", "reviews"), { recursive: true });
  for (const meta of prmetas) {
    const filesRaw = gh(["api", `/repos/${meta.repo}/pulls/${meta.prNumber}/files?per_page=20`], process.env) || [];
    const diff = filesRaw.map((f) => `--- ${f.filename}\n${String(f.patch || "(binary or large)").slice(0, 6000)}`).join("\n\n").slice(0, 30000);
    const prompt = [
      `You are the ${lens} review sub-agent. Review this proposed change to ${meta.repo} (PR #${meta.prNumber}: ${meta.title}).`,
      LENSES[lens] || LENSES.correctness,
      "Return ONLY strict JSON: {\"verdict\":\"approve|fix\",\"findings\":[{\"severity\":\"critical|high|medium|low\",\"title\":\"...\",\"detail\":\"...\"}]} max 8 findings.",
      "Diff:",
      diff,
    ].join("\n");
    const result = await askModel({ prompt, timeoutMs: 480000, env: process.env, preferVariantMax: true });
    audit.note("review", `${lens}:${meta.repo} complete=${result.complete} attempts=${JSON.stringify(result.attempts)}`);
    let payload = { verdict: "fix", findings: [{ severity: "high", title: "review unavailable", detail: result.complete ? "unparsable" : "model unavailable" }] };
    if (result.complete && result.reply) {
      try {
        const parsed = extractJson(result.reply);
        payload = { verdict: parsed.verdict === "approve" ? "approve" : "fix", findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 8) : [] };
      } catch {}
    }
    writeFileSync(path.join(dir, "..", "reviews", `review-${meta.repo.replace("/", "__")}__${lens}.json`), JSON.stringify({ repo: meta.repo, prNumber: meta.prNumber, lens, ...payload }, null, 2));
  }
  console.log(`IMPROVE_DONE=review:${lens}:${prmetas.length}`);
  return 0;
}

async function modeFinalize(audit) {
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  const revDir = process.env.FLEET_REVIEW_DIR;
  const metas = [];
  const artDir = process.env.FLEET_ARTIFACT_DIR || ".";
  for (const f of existsSync(artDir) ? readdirSync(artDir).filter((x) => x.startsWith("prmeta-")) : []) {
    metas.push(JSON.parse(readFileSync(path.join(artDir, f), "utf8")));
  }
  const reviews = existsSync(revDir) ? readdirSync(revDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(revDir, f), "utf8"))) : [];
  const state = readJson(STATE_PATH, { runs: [] });
  const byRepo = {};
  for (const m of metas) byRepo[m.repo] = { ...m, verdicts: {}, commentsPosted: [] };
  for (const r of reviews) {
    const entry = byRepo[r.repo];
    if (!entry) continue;
    entry.verdicts[r.lens] = r.verdict;
    const lines = [`### ${r.lens} review: **${r.verdict}**`];
    for (const f of r.findings || []) lines.push(`- [${f.severity}] ${f.title} — ${f.detail}`);
    const created = gh(["api", "-X", "POST", `/repos/${r.repo}/issues/${r.prNumber}/comments`, "-f", `body=${lines.join("\n")}`], process.env);
    await verifyCommentAuthor(r.repo, created.id, identity, process.env.FLEET_GH_TOKEN);
    entry.commentsPosted.push(created.id);
  }
  const runRecord = { utc: new Date().toISOString(), repos: Object.fromEntries(Object.entries(byRepo).map(([k, v]) => [k, { pr: v.prUrl, verdicts: v.verdicts }])) };
  state.runs.unshift(runRecord);
  state.runs = state.runs.slice(0, 30);
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  audit.note("finalize", `repos=${Object.keys(byRepo).length} reviews=${reviews.length}`);
  if (gitHasChanges(REPO_ROOT, ["state", "audit"])) {
    gitAdd(REPO_ROOT, ["state", "audit"]);
    gitCommit(REPO_ROOT, `[fleet] improve finalize ${new Date().toISOString().slice(0, 16)}`, identity);
    gitPush(REPO_ROOT, "main", process.env);
    const sha = gitRevParse(REPO_ROOT, "HEAD");
    await verifyCommit("M1Vj/fleet-control", sha, identity, process.env.FLEET_GH_TOKEN);
    audit.note("push-verify", `attribution verified sha=${sha.slice(0, 10)}`);
  }
  console.log(`IMPROVE_DONE=finalize`);
  return 0;
}

const MODES = { pick: modePick, research: modeResearch, plan: modePlan, implement: modeImplement, review: modeReview, finalize: modeFinalize };

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const mode = process.env.FLEET_IMPROVE_MODE;
  const audit = new AuditBuffer(scrub(process.env));
  if (!mode || !MODES[mode]) {
    console.error("FLEET_IMPROVE_MODE must be one of pick|research|plan|implement|review|finalize");
    process.exit(1);
  }
  const dumpAudit = () => {
    for (const e of [...audit.entries, ...audit.incidents]) {
      console.log(`AUDIT ${JSON.stringify(e)}`);
    }
  };
  try {
    const code = await MODES[mode](audit);
    makeTerminal(REPO_ROOT)(code === 0 ? "SUCCESS" : "BLOCKED", { mode });
    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), `improve-${mode}-${Date.now()}`, `Improve ${mode}`, code === 0 ? "ok" : "failed");
    if (code !== 0) dumpAudit();
    process.exit(code);
  } catch (err) {
    audit.incident("fatal", err.message);
    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), `improve-${mode}-${Date.now()}`, `Improve ${mode}`, `failed(${err.code || 1})`);
    console.error(`IMPROVE_FAILED mode=${mode} code=${err.code || 1} reason=${err.reason || err.message}`);
    dumpAudit();
    process.exit(err.code && Number.isInteger(err.code) ? err.code : 1);
  }
}
