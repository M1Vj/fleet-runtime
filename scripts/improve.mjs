#!/usr/bin/env node
import process from "node:process";
import fsMod from "node:fs";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, ghInput, putFileContent, ensureBranch, gitAdd, gitCommit, gitPush, gitHasChanges, gitRevParse, sha256, configureIdentity } from "./lib/util.mjs";
import { askModel, askModelResilient } from "./lib/model.mjs";
import { verifyCommit, verifyPullAuthor, verifyCommentAuthor } from "./lib/verify.mjs";
import { makeTerminal } from "./lib/terminal.mjs";
import { isSafeRepoPath, sanitizeControlChars, extractJsonObject, firstBalancedObject, harvestFencedFiles } from "./lib/directives.mjs";
import { scoreRepository, weightedSampleWithoutReplacement } from "./lib/fleet-scheduler.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = process.env.FLEET_STATE_ROOT ? path.resolve(process.env.FLEET_STATE_ROOT) : CODE_ROOT;
const STATE_PATH = path.join(REPO_ROOT, "state", "improve-state.json");
const MAX_SELECTION_HISTORY = 300;
const MAX_TOP_K = 15;
const DEFAULT_REPO_OWNER = "M1Vj";
const REPO_REF_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const IDEA_MAX_COUNT = 5;
const IDEA_IMPACTS = new Set(["high", "medium", "low"]);

function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function repoName(repo) {
  return String(repo?.full_name || repo?.fullName || repo?.name || "").trim();
}

export function selectionHistoryFromState(state) {
  if (!state || typeof state !== "object") return [];
  const direct = Array.isArray(state.selectionHistory) ? state.selectionHistory : [];
  const runs = Array.isArray(state.runs) ? state.runs : [];
  const legacy = [];
  for (const run of runs) {
    const repos = run && run.repos && typeof run.repos === "object" ? run.repos : {};
    for (const repo of Object.keys(repos)) legacy.push({ repo, selectedAt: run.utc || run.at || run.timestamp });
    for (const repo of Array.isArray(run?.selectedRepos) ? run.selectedRepos : []) {
      if (typeof repo === "string" && repo.trim()) legacy.push({ repo: repo.trim(), selectedAt: run.utc || run.at || run.timestamp });
    }
  }
  const seen = new Set();
  return [...direct, ...legacy].filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const key = `${String(entry.repo || entry.repository || "").trim()}|${String(entry.selectedAt || entry.selected_at || entry.at || "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(key.split("|")[0]);
  });
}

export function rankRepos(repos, options = {}) {
  const now = options.now ?? Date.now();
  const history = Array.isArray(options.history) ? options.history : [];
  return (Array.isArray(repos) ? repos : [])
    .filter((repo) => repo && repo.archived !== true && repo.fork !== true)
    .map((repo) => {
      const score = scoreRepository(repo, { ...options, history, now });
      return {
        ...repo,
        full_name: repoName(repo),
        score,
      };
    })
    .filter((repo) => repo.full_name && repo.score > 0)
    .sort((a, b) => (b.score - a.score) || a.full_name.localeCompare(b.full_name));
}

export function resolveRequestedRepo(repos, requestedRepo, owner = DEFAULT_REPO_OWNER) {
  const target = String(requestedRepo ?? "").trim();
  if (!target) return null;
  if (!REPO_REF_RE.test(target)) throw new Error("invalid repo target");
  const expectedOwner = String(owner || DEFAULT_REPO_OWNER).trim();
  if (target.split("/")[0] !== expectedOwner) throw new Error("foreign repo target");
  const match = (Array.isArray(repos) ? repos : []).find((repo) => repoName(repo) === target);
  if (!match || match.archived === true || match.fork === true || target === expectedOwner + "/fleet-control") {
    throw new Error("repo target unavailable");
  }
  return match;
}

export function selectImprovementRepos(repos, options = {}) {
  const topK = Math.min(MAX_TOP_K, Math.max(0, Math.floor(Number(options.topK ?? options.top_k ?? 2) || 0)));
  const requestedRepo = options.requestedRepo ?? options.requested_repo;
  const exact = resolveRequestedRepo(repos, requestedRepo, options.owner || DEFAULT_REPO_OWNER);
  if (exact) {
    const rankedExact = rankRepos([exact], options)[0];
    if (!rankedExact) throw new Error("repo target ineligible");
    return [{ ...rankedExact, weight: rankedExact.score }];
  }
  if (topK === 0) return [];
  const ranked = rankRepos(repos, options);
  const rows = ranked.map((repo) => ({
    ...repo,
    weight: repo.score,
  }));
  const sampled = weightedSampleWithoutReplacement(rows, topK, options.rng || Math.random);
  return sampled.map((repo) => ({ ...repo }));
}

async function modePick(audit) {
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  const repos = gh(["api", "/user/repos?affiliation=owner&per_page=100&sort=pushed"], process.env) || [];
  const state = readJson(STATE_PATH, { runs: [], selectionHistory: [] });
  const history = selectionHistoryFromState(state);
  const topK = Math.min(MAX_TOP_K, Math.max(0, Number(process.env.FLEET_TOP_K || 2) || 0));
  const candidates = repos.filter((r) => r.full_name !== "M1Vj/fleet-control");
  const selected = selectImprovementRepos(candidates, {
    history,
    topK,
    rng: Math.random,
    requestedRepo: process.env.FLEET_REPO,
  });
  const selectedAt = new Date().toISOString();
  const selection = {
    runId: process.env.GITHUB_RUN_ID || process.env.GITHUB_RUN_NUMBER || undefined,
    selectedAt,
    selected: selected.map((repo) => ({ repo: repo.full_name, score: repo.score })),
  };
  const outDir = process.env.FLEET_ARTIFACT_DIR;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const suffix = String(selection.runId || Date.now()).replace(/[^A-Za-z0-9_-]/g, "-");
    writeFileSync(path.join(outDir, `selection-${suffix}.json`), JSON.stringify(selection, null, 2));
  }
  audit.note("pick", selected.map((r) => `${r.full_name}(${r.score})`).join(", "));
  console.log(`IMPROVE_MATRIX=${JSON.stringify({ repo: selected.map((r) => r.full_name) })}`);
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
  {
    const { gatewayDown } = await import("./lib/gateway-health.mjs");
    if (gatewayDown(process.env.FLEET_STATE_ROOT || process.cwd())) {
      audit.note("research", "gateway circuit open; skipping wave");
      console.log("IMPROVE_SKIPPED=circuit-open");
      return 0;
    }
  }
  let workdir;
  try {
    workdir = `/tmp/improve-${String(repo).replace("/", "__")}`;
    gh(["repo", "clone", repo0(repo), workdir, "--", "--depth", "1"], process.env);
  } catch {
    workdir = undefined;
  }
  const result = await askModelResilient({
    prompt: buildResearchPrompt(repo),
    timeoutMs: 480000,
    env: process.env,
    preferVariantMax: true,
    maxRounds: 4,
    workspace: workdir,
  });
  audit.note("research", `repo=${repo} complete=${result.complete} ladders=${result.ladders}`);
  if (workdir) {
    try {
      fsRemove(workdir);
    } catch {}
  }
  if (!result.complete || !result.reply) {
    const { gatewayDown } = await import("./lib/gateway-health.mjs");
    if (gatewayDown(process.env.FLEET_STATE_ROOT || process.cwd())) {
      audit.note("research", "probe confirmed outage; skipping gracefully");
      console.log("IMPROVE_SKIPPED=circuit-still-open");
      return 0;
    }
    throw Object.assign(new Error("MODEL_UNAVAILABLE"), { code: 6, reason: "MODEL_UNAVAILABLE" });
  }
  let ideas;
  try {
    ideas = salvageIdeas(result.reply);
  } catch (err) {
    audit.note("research", `repo=${repo} invalid ideas; skipped (${String(err.message || err).slice(0, 120)})`);
    console.log(`IMPROVE_SKIPPED=invalid-ideas:${repo}`);
    return 0;
  }
  const outDir = process.env.FLEET_ARTIFACT_DIR || ".";
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, `ideas-${repo.replace("/", "__")}.json`),
    JSON.stringify({ repo, ideas, reply: result.reply, validatedAt: new Date().toISOString() }, null, 2),
  );
  console.log(`IMPROVE_DONE=research:${repo}`);
  return 0;
}

function repo0(name) {
  return name;
}
function fsRemove(target) {
  fsMod.rmSync(target, { recursive: true, force: true });
}

export function extractJson(replyText) {
  return extractJsonObject(replyText);
}

function normalizeIdea(idea, index = 0) {
  if (!idea || typeof idea !== "object" || Array.isArray(idea)) throw new Error(`idea ${index} invalid`);
  if (typeof idea.title !== "string" || typeof idea.rationale !== "string" || typeof idea.evidence !== "string" || typeof idea.impact !== "string") {
    throw new Error(`idea ${index} fields invalid`);
  }
  const title = idea.title.trim();
  const rationale = idea.rationale.trim();
  const evidence = idea.evidence.trim();
  const impact = idea.impact.trim().toLowerCase();
  if (!title || !rationale || !evidence) throw new Error(`idea ${index} missing fields`);
  if (!IDEA_IMPACTS.has(impact)) throw new Error(`idea ${index} impact invalid`);
  if (title.length > 240 || rationale.length > 2400 || evidence.length > 2400) {
    throw new Error(`idea ${index} exceeds size limit`);
  }
  return { title, rationale, evidence, impact };
}

export function validateIdeasObject(value, { allowPartial = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ideas object invalid");
  if (!Array.isArray(value.ideas) || value.ideas.length === 0 || value.ideas.length > IDEA_MAX_COUNT) {
    throw new Error("ideas invalid");
  }
  const ideas = [];
  const errors = [];
  value.ideas.forEach((idea, index) => {
    try {
      ideas.push(normalizeIdea(idea, index));
    } catch (err) {
      errors.push(err);
      if (!allowPartial) throw err;
    }
  });
  if (ideas.length === 0) throw new Error("no valid ideas");
  if (errors.length > 0 || ideas.length !== value.ideas.length) return { ideas, degraded: true };
  return { ideas };
}

export function harvestIdeaCandidates(replyText) {
  const text = String(replyText ?? "");
  const candidates = [];
  const seen = new Set();
  const push = (candidate) => {
    const value = String(candidate ?? "").trim();
    if (!value.includes("{") || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) push(match[1]);
  let rest = text;
  for (let i = 0; i < 20 && rest.includes("{"); i += 1) {
    let object;
    try {
      object = firstBalancedObject(rest);
    } catch {
      break;
    }
    push(object);
    const offset = rest.indexOf(object);
    if (offset < 0) break;
    rest = rest.slice(offset + object.length);
  }
  push(text);
  return candidates;
}

function parseIdeaCandidate(candidate) {
  const variants = [String(candidate ?? "").trim()];
  try {
    const normalized = normalizePlanJsonText(variants[0]);
    if (normalized && !variants.includes(normalized)) variants.push(normalized);
  } catch {}
  let lastError = new Error("ideas candidate invalid");
  for (const variant of variants) {
    try {
      const parsed = extractJsonObject(variant);
      try {
        return validateIdeasObject(parsed);
      } catch (strictError) {
        lastError = strictError;
        return validateIdeasObject(parsed, { allowPartial: true });
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export function salvageIdeas(replyText) {
  if (replyText && typeof replyText === "object" && !Array.isArray(replyText)) {
    return validateIdeasObject(replyText);
  }
  let lastError = new Error("no ideas candidates");
  for (const candidate of harvestIdeaCandidates(replyText)) {
    try {
      return parseIdeaCandidate(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export function pickBestIdea(replyText) {
  const obj = typeof replyText === "string"
    ? salvageIdeas(replyText)
    : validateIdeasObject(Array.isArray(replyText) ? { ideas: replyText } : replyText);
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

export const PLAN_MAX_FILES = 6;
export const PLAN_MAX_FILE_CHARS = 15000;

// Tolerant PLAN salvage (fleet issue #10): free-model replies are often tiny
// non-conforming JSON (prose prefix/suffix, fences, unquoted keys, trailing
// commas, single-file object). Harvest candidates with the shared helpers,
// normalize outside strings only (never rewrite file contents), and validate
// against the same schema parsePlan demands. No fabrication, same budgets.
function quoteUnquotedKeysOutsideStrings(s) {
  let out = "";
  let inStr = false;
  let esc = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "{" || ch === ",") {
      out += ch;
      i++;
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j++;
      let k = j;
      while (k < s.length && /[A-Za-z_0-9]/.test(s[k])) k++;
      let m = k;
      while (m < s.length && /\s/.test(s[m])) m++;
      const word = s.slice(j, k);
      if (word.length > 0 && /^[A-Za-z_]/.test(word) && s[m] === ":") {
        out += s.slice(i, j) + `"${word}"`;
        i = k;
        continue;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function stripTrailingCommasOutsideStrings(s) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === "}" || s[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

export function normalizePlanJsonText(raw) {
  let s = String(raw ?? "").replace(/^\uFEFF/, "").trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1].includes("{")) s = fenced[1].trim();
  s = quoteUnquotedKeysOutsideStrings(s);
  s = stripTrailingCommasOutsideStrings(s);
  return s;
}

export function coercePlanObject(obj, fallbackTitle) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("plan object invalid");
  let files = obj.files;
  if (files && typeof files === "object" && !Array.isArray(files)) {
    files = [files];
  } else if (!files && typeof obj.path === "string" && typeof obj.content === "string") {
    files = [{ path: obj.path, content: obj.content }];
  } else if (!files && obj.file && typeof obj.file === "object" && !Array.isArray(obj.file)) {
    files = [obj.file];
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > PLAN_MAX_FILES) throw new Error("files invalid");
  const clean = [];
  for (const f of files) {
    if (!f || typeof f !== "object" || Array.isArray(f)) throw new Error("file entry invalid");
    if (!f.path || typeof f.content !== "string") throw new Error("file entry invalid");
    const p = String(f.path).trim();
    if (!isSafeRepoPath(p)) throw new Error(`forbidden path ${f.path}`);
    if (f.content.length > PLAN_MAX_FILE_CHARS) throw new Error("file too large");
    clean.push({ path: p, content: f.content });
  }
  return {
    title: String(obj.title || fallbackTitle || "fleet improvement").slice(0, 120),
    summary: String(obj.summary || "").slice(0, 1000),
    prBody: String(obj.prBody || "").slice(0, 6000),
    files: clean,
    risks: String(obj.risks || "").slice(0, 800),
  };
}

export function tryParsePlanText(candidateText, fallbackTitle) {
  const raw = String(candidateText ?? "");
  const variants = [raw];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const sliced = raw.slice(start, end + 1);
    if (sliced !== raw) variants.push(sliced);
  }
  const norm = normalizePlanJsonText(raw);
  if (!variants.includes(norm)) variants.push(norm);
  const nStart = norm.indexOf("{");
  const nEnd = norm.lastIndexOf("}");
  if (nStart !== -1 && nEnd > nStart) {
    const nSliced = norm.slice(nStart, nEnd + 1);
    if (!variants.includes(nSliced)) variants.push(nSliced);
  }
  for (const v of [...variants]) {
    try {
      const sanitized = sanitizeControlChars(v);
      if (!variants.includes(sanitized)) variants.push(sanitized);
    } catch {}
  }
  let lastErr = new Error("unparseable plan");
  for (const v of variants) {
    try {
      return coercePlanObject(JSON.parse(v), fallbackTitle);
    } catch (err) {
      lastErr = err;
    }
  }
  try {
    return coercePlanObject(extractJsonObject(raw), fallbackTitle);
  } catch {}
  try {
    return coercePlanObject(extractJsonObject(norm), fallbackTitle);
  } catch {}
  throw lastErr;
}

export function harvestPlanCandidates(replyText) {
  const text = String(replyText ?? "");
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const t = String(s ?? "").trim();
    if (t.length < 2 || !t.includes("{")) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) push(m[1]);
  let rest = text;
  for (let i = 0; i < 20; i++) {
    let found;
    try {
      found = firstBalancedObject(rest);
    } catch {
      break;
    }
    push(found);
    const idx = rest.indexOf(found);
    if (idx === -1) break;
    rest = rest.slice(idx + found.length);
    if (!rest.includes("{")) break;
  }
  push(text);
  return out;
}

export function salvagePlan(replyText, fallbackTitle) {
  const candidates = harvestPlanCandidates(replyText);
  let lastErr = new Error("no plan candidates");
  for (const cand of candidates) {
    try {
      const plan = tryParsePlanText(cand, fallbackTitle);
      return { ...plan, degraded: false };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export function collectValidPlanFiles(replyText) {
  const valid = [];
  const seenPath = new Set();
  const consider = (p, c) => {
    const pp = String(p ?? "").trim();
    if (typeof c !== "string") return;
    if (!isSafeRepoPath(pp)) return;
    if (c.length > PLAN_MAX_FILE_CHARS) return;
    if (seenPath.has(pp)) return;
    seenPath.add(pp);
    valid.push({ path: pp, content: c });
  };
  for (const cand of harvestPlanCandidates(replyText)) {
    if (valid.length >= PLAN_MAX_FILES) break;
    let obj;
    try {
      const norm = normalizePlanJsonText(cand);
      try {
        obj = JSON.parse(norm);
      } catch {
        obj = JSON.parse(sanitizeControlChars(norm));
      }
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    let files = obj.files;
    if (files && typeof files === "object" && !Array.isArray(files)) files = [files];
    else if (!files && typeof obj.path === "string" && typeof obj.content === "string") files = [{ path: obj.path, content: obj.content }];
    else if (!files && obj.file && typeof obj.file === "object" && !Array.isArray(obj.file)) files = [obj.file];
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      if (valid.length >= PLAN_MAX_FILES) break;
      if (!f || typeof f !== "object" || Array.isArray(f)) continue;
      consider(f.path, f.content);
    }
  }
  try {
    for (const f of extractFileBlocks(String(replyText))) {
      if (valid.length >= PLAN_MAX_FILES) break;
      consider(f.path, f.content);
    }
  } catch {}
  try {
    for (const f of harvestFencedFiles(String(replyText))) {
      if (valid.length >= PLAN_MAX_FILES) break;
      consider(f.path, f.content);
    }
  } catch {}
  return valid.slice(0, PLAN_MAX_FILES);
}

export function salvagePartialPlan(replyText, fallbackTitle) {
  const files = collectValidPlanFiles(replyText);
  if (files.length === 0) throw new Error("no valid files for partial plan");
  let meta = {};
  for (const cand of harvestPlanCandidates(replyText)) {
    try {
      const obj = JSON.parse(normalizePlanJsonText(cand));
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        meta = obj;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) meta = {};
  return {
    title: String(meta.title || fallbackTitle || "fleet improvement (partial)").slice(0, 120),
    summary: String(meta.summary || "").slice(0, 1000),
    prBody: String(meta.prBody || meta.summary || "").slice(0, 6000),
    files,
    risks: String(meta.risks || "partial plan: subset of valid files salvaged").slice(0, 800),
    degraded: true,
  };
}

async function modePlan(audit) {
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  const dir = process.env.FLEET_ARTIFACT_DIR || ".";
  const ideaFiles = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("ideas-") && f.endsWith(".json")) : [];
  let plans = 0;
  for (const f of ideaFiles) {
    let data;
    try {
      data = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    } catch (err) {
      audit.note("plan", `${f}: invalid ideas artifact (${String(err.message || err).slice(0, 120)}); skipped`);
      continue;
    }
    if (!data || typeof data !== "object" || !data.repo) {
      audit.note("plan", `${f}: missing repo; skipped`);
      continue;
    }
    let idea;
    try {
      idea = pickBestIdea(data.ideas || data.reply);
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
    let plan;
    try {
      plan = await askModel({ prompt: planPrompt, timeoutMs: 480000, env: process.env, preferVariantMax: true, maxRounds: 4, workspace: workdir });
    } catch (err) {
      audit.note("plan", `repo=${data.repo} model error (${String(err.message || err).slice(0, 120)}); skipped`);
      if (workdir) {
        try {
          (await import("node:fs")).rmSync(workdir, { recursive: true, force: true });
        } catch {}
      }
      continue;
    }
    audit.note("plan", `repo=${data.repo} complete=${plan.complete} attempts=${JSON.stringify(plan.attempts)}`);
    if (workdir) {
      try {
        (await import("node:fs")).rmSync(workdir, { recursive: true, force: true });
      } catch {}
    }
    if (plan.circuitOpen) {
      audit.note("plan", "gateway circuit open; skipping plan wave");
      continue;
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
          audit.note("plan-v2", `fallbacks rejected (${errV2.message.slice(0, 100)}); salvage`);
          let salvaged = null;
          try {
            salvaged = salvagePlan(plan.reply, idea.title);
            audit.note("plan-salvage", `salvaged full plan files=${salvaged.files.length}`);
            parsed = salvaged;
          } catch (errSalv) {
            audit.note("plan-salvage", `no candidate validated (${String(errSalv.message || errSalv).slice(0, 100)}); repair round`);
            // Bounded ONE repair round via askModel (same resilient model
            // chain + variant ladder askModelResilient wraps; the second
            // Resilient ladder is deliberately skipped to bound cost).
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
              try {
                parsed = parsePlanV3(repair.reply, idea.title);
              } catch {
                try {
                  parsed = parsePlanV2(repair.reply);
                } catch {
                  try {
                    salvaged = salvagePlan(repair.reply, idea.title);
                    audit.note("plan-salvage", `repair salvaged files=${salvaged.files.length}`);
                    parsed = salvaged;
                  } catch {
                    const combined = `${plan.reply}\n${repair.reply}`;
                    try {
                      salvaged = salvagePartialPlan(combined, idea.title);
                    } catch {
                      salvaged = salvagePartialPlan(plan.reply, idea.title);
                    }
                    audit.note("plan-salvage", `degraded partial plan files=${salvaged.files.length} (subset of valid files)`);
                    parsed = salvaged;
                  }
                }
              }
            } else {
              try {
                parsed = parsePlan(plan.reply);
              } catch {
                parsed = salvagePartialPlan(plan.reply, idea.title);
                audit.note("plan-salvage", `degraded partial plan files=${parsed.files.length} (no repair reply)`);
              }
            }
          }
        }
      }
      writeFileSync(path.join(dir, `plan-${data.repo.replace("/", "__")}.json`), JSON.stringify({ repo: data.repo, idea, plan: parsed }, null, 2));
      plans += 1;
      console.log(`IMPROVE_PLAN_OK=${data.repo}`);
    } catch (err) {
      audit.note("plan-salvage", `salvage attempted; unfixable (${String(err.message || err).slice(0, 120)})`);
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
  const requestedRepo = process.env.FLEET_REPO;
  const prmetas = existsSync(dir)
    ? readdirSync(dir)
      .filter((f) => f.startsWith("prmeta-") && f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(path.join(dir, f), "utf8"));
        } catch {
          audit.note("review", `${f}: malformed PR metadata; skipped`);
          return null;
        }
      })
      .filter((meta) => meta && (!requestedRepo || meta.repo === requestedRepo))
    : [];
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

export function selectionEntriesFromArtifact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = value.selected || value.selections || value.repos || [];
  const entries = Array.isArray(raw) ? raw : [];
  return entries.map((entry) => {
    if (typeof entry === "string") return { repo: entry, score: undefined };
    if (!entry || typeof entry !== "object") return null;
    const repo = repoName(entry) || String(entry.repo || entry.repository || "").trim();
    if (!repo) return null;
    return {
      repo,
      score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : undefined,
      selectedAt: entry.selectedAt || entry.selected_at || value.selectedAt || value.at,
      runId: entry.runId || entry.run_id || value.runId || value.run_id,
    };
  }).filter(Boolean);
}

export function mergeSelectionHistory(state, selections, now = Date.now()) {
  const current = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  const existing = selectionHistoryFromState(current).filter((entry) => entry && typeof entry === "object");
  const incoming = Array.isArray(selections)
    ? selections
    : (selections && (selections.selected || selections.selections || selections.repos)
      ? selectionEntriesFromArtifact(selections)
      : [selections]);
  const history = [...existing];
  const seen = new Set(history.map((entry) => {
    const repo = String(entry.repo || entry.repository || "").trim();
    const runId = String(entry.runId || entry.run_id || "").trim();
    const selectedAt = String(entry.selectedAt || entry.selected_at || entry.at || "");
    return runId ? `run:${runId}|${repo}` : `at:${selectedAt}|${repo}`;
  }));
  for (const raw of incoming) {
    const candidate = typeof raw === "string" ? { repo: raw } : raw;
    if (!candidate || typeof candidate !== "object") continue;
    const repo = String(candidate.repo || candidate.repository || candidate.full_name || "").trim();
    if (!repo) continue;
    const selectedAt = String(candidate.selectedAt || candidate.selected_at || candidate.at || new Date(now).toISOString());
    const runId = candidate.runId || candidate.run_id;
    const identity = runId ? `run:${String(runId)}|${repo}` : `at:${selectedAt}|${repo}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const entry = { repo, selectedAt };
    if (runId) entry.runId = String(runId);
    if (Number.isFinite(Number(candidate.score))) entry.score = Number(candidate.score);
    history.push(entry);
  }
  return { ...current, selectionHistory: history.slice(-MAX_SELECTION_HISTORY) };
}

async function modeFinalize(audit) {
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  const revDir = process.env.FLEET_REVIEW_DIR;
  const metas = [];
  const artDir = process.env.FLEET_ARTIFACT_DIR || ".";
  for (const f of existsSync(artDir) ? readdirSync(artDir).filter((x) => x.startsWith("prmeta-")) : []) {
    try {
      metas.push(JSON.parse(readFileSync(path.join(artDir, f), "utf8")));
    } catch {
      audit.note("finalize", `${f}: malformed PR metadata; skipped`);
    }
  }
  const reviews = existsSync(revDir) ? readdirSync(revDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(revDir, f), "utf8"))) : [];
  const selections = [];
  for (const f of existsSync(artDir) ? readdirSync(artDir).filter((x) => x.startsWith("selection-") && x.endsWith(".json")) : []) {
    try {
      selections.push(...selectionEntriesFromArtifact(JSON.parse(readFileSync(path.join(artDir, f), "utf8"))));
    } catch {
      audit.note("finalize", `${f}: malformed selection artifact; skipped`);
    }
  }
  let state = readJson(STATE_PATH, { runs: [], selectionHistory: [] });
  state = mergeSelectionHistory(state, selections);
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
  const runRecord = {
    utc: new Date().toISOString(),
    selectedRepos: selections.map((entry) => entry.repo),
    repos: Object.fromEntries(Object.entries(byRepo).map(([k, v]) => [k, { pr: v.prUrl, verdicts: v.verdicts }])),
  };
  state.runs.unshift(runRecord);
  state.runs = state.runs.slice(0, 30);
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
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
