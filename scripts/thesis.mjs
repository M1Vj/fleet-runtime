#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, ghInput, putFileContent, ensureBranch, findExistingOpenPr, gitAdd, gitCommit, gitPush, gitHasChanges, gitRevParse, sha256, configureIdentity } from "./lib/util.mjs";
import { askModel } from "./lib/model.mjs";
import { verifyCommit, verifyPullAuthor } from "./lib/verify.mjs";
import { sanitizeControlChars } from "./lib/directives.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = process.env.FLEET_STATE_ROOT ? path.resolve(process.env.FLEET_STATE_ROOT) : CODE_ROOT;
export const THESIS_REPO = "M1Vj/THESIS";
const V2_PREFIX = "v2/";
const ALLOWED_EXT = /\.(md|markdown|tex|txt|bib|yml|yaml)$/i;

function listThesisTree() {
  const meta = gh(["api", `/repos/${THESIS_REPO}`], process.env);
  const branch = meta.default_branch;
  const ref = gh(["api", `/repos/${THESIS_REPO}/git/ref/heads/${branch}`], process.env);
  const tree = gh(["api", `/repos/${THESIS_REPO}/git/trees/${ref.object.sha}?recursive=1`], process.env) || {};
  return {
    defaultBranch: branch,
    baseSha: ref.object.sha,
    files: (tree.tree || []).filter((t) => t.type === "blob").map((t) => t.path).slice(0, 400),
  };
}

function fetchTextFiles(paths, maxBytesPerFile = 12000, maxFiles = 25) {
  const out = [];
  for (const p of paths.filter((x) => /\.(md|markdown|tex|txt)$/i.test(x)).slice(0, maxFiles)) {
    try {
      const raw = gh(["api", "-H=Accept: application/vnd.github.raw", `/repos/${THESIS_REPO}/contents/${p}`], process.env);
      out.push(`===== ${p} =====\n${String(raw).slice(0, maxBytesPerFile)}`);
    } catch {}
  }
  return out.join("\n\n").slice(0, 60000);
}

async function modeSurvey(audit) {
  await runGate(process.env);
  const treeInfo = listThesisTree();
  const digest = [
    `THESIS repo file inventory (${treeInfo.files.length} files):`,
    treeInfo.files.join("\n"),
    "",
    "Key text excerpts:",
    fetchTextFiles(treeInfo.files),
  ].join("\n");
  const prompt = [
    "You are the dedicated THESIS improvement agent for Vj. Survey the thesis repository snapshot below.",
    "Identify: structural weaknesses, missing chapters/sections, argumentation gaps, citation hygiene issues, methodology risks, formatting inconsistencies, and the highest-leverage improvements.",
    "Return ONLY strict JSON: {\"assessment\":\"...\",\"priorities\":[{\"title\":\"...\",\"why\":\"...\",\"approach\":\"...\"}]} with at most 8 priorities, deepest analysis you can produce.",
    "Snapshot:",
    digest,
  ].join("\n");
  let result = await askModel({ prompt, timeoutMs: 600000, env: process.env, preferVariantMax: true, maxRounds: 4 });
  if (!result.complete) {
    await new Promise((r) => setTimeout(r, 90000));
    result = await askModel({ prompt, timeoutMs: 600000, env: process.env, preferVariantMax: true, maxRounds: 3 });
  }
  audit.note("survey", `complete=${result.complete}`);
  if (!result.complete || !result.reply) throw Object.assign(new Error("MODEL_UNAVAILABLE"), { code: 6, reason: "MODEL_UNAVAILABLE" });
  const dir = process.env.FLEET_ARTIFACT_DIR || ".";
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "thesis-survey.json"), JSON.stringify({ reply: result.reply }, null, 2));
  console.log("THESIS_DONE=survey");
  return 0;
}

function extractFileBlocks(text) {
  const files = [];
  const fileRe = /^(?:FILE|V2FILE) path=(.+)$/gm;
  const matches = [...String(text).matchAll(fileRe)];
  for (let i = 0; i < matches.length; i++) {
    const rawPath = matches[i][1].trim().replace(/^["']|["']$/g, "");
    let p = rawPath.startsWith(V2_PREFIX) ? rawPath : V2_PREFIX + rawPath.replace(/^\//, "");
    const after = String(text).slice(matches[i].index + matches[i][0].length);
    const fence = after.match(/```[a-zA-Z0-9]*\n([\s\S]*?)\n```/);
    if (!fence) continue;
    files.push({ path: p, content: fence[1] });
  }
  return files;
}

function validateV2(files) {
  const errors = [];
  if (files.length === 0 || files.length > 12) errors.push(`file count invalid (${files.length})`);
  for (const f of files) {
    if (!f.path.startsWith(V2_PREFIX)) errors.push(`outside v2/: ${f.path}`);
    if (!ALLOWED_EXT.test(f.path)) errors.push(`extension not allowed: ${f.path}`);
    if (f.content.length > 60000) errors.push(`too large: ${f.path}`);
  }
  return errors;
}

async function modeDraft(audit) {
  await runGate(process.env);
  const dir = process.env.FLEET_ARTIFACT_DIR || ".";
  const surveyPath = path.join(dir, "thesis-survey.json");
  if (!existsSync(surveyPath)) throw new Error("thesis-survey.json missing");
  const survey = JSON.parse(readFileSync(surveyPath, "utf8")).reply;
  const treeInfo = listThesisTree();
  const prompt = [
    "You are the dedicated THESIS genius agent. Using the survey below, produce SUBSTANTIAL new thesis material in a NEW folder only ('" + V2_PREFIX + "*').",
    "Never propose modifying or deleting any existing file — everything lands under '" + V2_PREFIX + "'.",
    "Aim high: restructured chapter drafts, new argumentation, methodology hardening, literature-synthesis sections, defense-prep documents. Multi-file, deep, publication-quality prose.",
    "Respond in EXACTLY this plain-text format:",
    "THESIS",
    "TITLE: <one-line package title>",
    "SUMMARY: <what this package improves and why>",
    "RISKS: <one line>",
    "Then per file: a line 'V2FILE path=v2/<name>.<ext>' followed by one fenced block containing the complete file content.",
    "At most 10 files; each up to 50000 chars; allowed extensions: .md .markdown .tex .txt .bib .yml .yaml",
    "",
    "SURVEY:",
    survey.slice(0, 30000),
    "",
    "EXISTING FILE LIST (do not modify; context only):",
    treeInfo.files.join("\n").slice(0, 8000),
  ].join("\n");
  let result = await askModel({ prompt, timeoutMs: 600000, env: process.env, preferVariantMax: true, maxRounds: 5 });
  if (!result.complete) {
    audit.note("draft-retry", "model unavailable; second ladder after cooldown");
    await new Promise((r) => setTimeout(r, 120000));
    result = await askModel({ prompt, timeoutMs: 600000, env: process.env, preferVariantMax: true, maxRounds: 4 });
  }
  audit.note("draft", `complete=${result.complete} attempts=${JSON.stringify(result.attempts)}`);
  if (!result.complete || !result.reply) throw Object.assign(new Error("MODEL_UNAVAILABLE"), { code: 6, reason: "MODEL_UNAVAILABLE" });

  let files = extractFileBlocks(result.reply);
  if (files.length === 0 && result.sessionId) {
    audit.note("draft-repair", "no v2 blocks parsed; repair round");
    const repair = await askModel({
      prompt: "Your previous answer contained no parseable 'V2FILE path=...' blocks. Re-output it now following EXACTLY the required format: header lines TITLE:/SUMMARY:/RISKS: then per file 'V2FILE path=v2/<name>' + one fenced block with full content.",
      sessionId: result.sessionId,
      timeoutMs: 480000,
      env: process.env,
      preferVariantMax: false,
      maxRounds: 3,
    });
    if (repair.reply) files = extractFileBlocks(repair.reply);
  }
  const errors = validateV2(files);
  if (errors.length > 0) {
    audit.incident("validate", errors.slice(0, 6).join("; "));
    throw Object.assign(new Error("THESIS_DRAFT_REJECTED"), { code: 5 });
  }
  writeFileSync(path.join(dir, "thesis-draft.json"), JSON.stringify({ files }, null, 2));
  console.log(`THESIS_FILES=${files.length}`);
  return 0;
}

async function modeRefine(audit) {
  await runGate(process.env);
  const dir = process.env.FLEET_ARTIFACT_DIR || ".";
  const draftPath = path.join(dir, "thesis-draft.json");
  if (!existsSync(draftPath)) throw new Error("thesis-draft.json missing");
  const draft = JSON.parse(readFileSync(draftPath, "utf8"));
  const corpus = draft.files.map((f) => `V2FILE path=${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n").slice(0, 90000);
  const prompt = [
    "You are the THESIS red-team reviewer AND polisher. Critically review the draft package below for: factual/causal overreach, weak argumentation, citation claims without sources (flag as [CITATION NEEDED] inline), structure, tone fit for an undergraduate thesis, and internal contradictions.",
    "Then output the IMPROVED final version of every file you changed (and every file that is fine may be omitted).",
    "Same output format: TITLE:/SUMMARY:/RISKS: then 'V2FILE path=...' fenced blocks. Only include files you actually improved.",
    "",
    corpus,
  ].join("\n");
  const result = await askModel({ prompt, timeoutMs: 600000, env: process.env, preferVariantMax: true, maxRounds: 4 });
  audit.note("refine", `complete=${result.complete}`);
  if (result.complete && result.reply) {
    const refined = extractFileBlocks(result.reply);
    const byPath = Object.fromEntries(draft.files.map((f) => [f.path, f]));
    let applied = 0;
    for (const f of refined) {
      const errs = validateV2([f]);
      if (errs.length === 0) {
        byPath[f.path] = f;
        applied += 1;
      }
    }
    draft.files = Object.values(byPath);
    audit.note("refine-apply", `${applied} file(s) refined`);
  } else {
    audit.note("refine", "refinement unavailable; shipping unrefined draft");
  }
  writeFileSync(path.join(dir, "thesis-final.json"), JSON.stringify(draft, null, 2));
  console.log("THESIS_DONE=refine");
  return 0;
}

async function modeShip(audit) {
  const identity = await runGate(process.env);
  configureIdentity(REPO_ROOT, identity);
  const dir = process.env.FLEET_ARTIFACT_DIR || ".";
  const finalPath = path.join(dir, "thesis-final.json");
  if (!existsSync(finalPath)) {
    console.log("THESIS_SKIP=no-final");
    return 0;
  }
  const { files } = JSON.parse(readFileSync(finalPath, "utf8"));
  if (!files || files.length === 0) {
    console.log("THESIS_SKIP=empty");
    return 0;
  }
  const treeInfo = listThesisTree();
  const branch = `fleet/thesis-v2-${sha256(files.map((f) => f.path).join(",")).slice(0, 8)}`;
  ensureBranch(THESIS_REPO, branch, treeInfo.baseSha, process.env);
  for (const f of files) {
    putFileContent(THESIS_REPO, f.path, f.content, branch, `[fleet-thesis] add ${f.path}`, process.env);
  }
  const body = [
    "## fleet-thesis v2 package",
    "",
    "**Everything here lives under `v2/` — no existing file was touched.**",
    "",
    `**Files:** ${files.map((f) => "`" + f.path + "`").join(", ")}`,
    "",
    "_Generated autonomously by the M1Vj fleet THESIS agent. Review before merging._",
  ].join("\n");
  let pr = findExistingOpenPr(THESIS_REPO, branch, process.env);
  if (!pr) {
    try {
      pr = ghInput(
        ["api", "-X", "POST", `/repos/${THESIS_REPO}/pulls`],
        { title: `[fleet-thesis] v2 package: ${files[0].path}`, body, head: branch, base: treeInfo.defaultBranch, draft: true },
        process.env,
      );
    } catch (err) {
      pr = findExistingOpenPr(THESIS_REPO, branch, process.env);
      if (!pr) throw err;
    }
  }
  await verifyPullAuthor(THESIS_REPO, pr.number, identity, process.env.FLEET_GH_TOKEN);
  const headSha = pr.head && pr.head.sha ? pr.head.sha : null;
  if (!headSha) throw new Error("PR head sha unavailable");
  await verifyCommit(THESIS_REPO, headSha, identity, process.env.FLEET_GH_TOKEN);
  audit.note("ship", `pr=#${pr.number} branch=${branch} files=${files.length}`);

  const labDir = path.join(REPO_ROOT, "docs", "thesis-lab");
  mkdirSync(labDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  for (const f of files) {
    const dest = path.join(labDir, stamp + "--" + f.path.replace(/\//g, "__"));
    writeFileSync(dest, f.content);
  }
  if (gitHasChanges(REPO_ROOT, ["docs/thesis-lab"])) {
    gitAdd(REPO_ROOT, ["docs/thesis-lab"]);
    gitCommit(REPO_ROOT, `[fleet] thesis-lab mirror ${stamp} PR#${pr.number}`, identity);
    gitPush(REPO_ROOT, "main", process.env);
    const sha = gitRevParse(REPO_ROOT, "HEAD");
    await verifyCommit("M1Vj/fleet-control", sha, identity, process.env.FLEET_GH_TOKEN);
  }
  console.log(`FLEET_RUN_RESULT=${JSON.stringify({ mode: "ship", pr: pr.number, files: files.length })}`);
  return 0;
}

const MODES = { survey: modeSurvey, draft: modeDraft, refine: modeRefine, ship: modeShip };

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const mode = process.env.FLEET_THESIS_MODE;
  const audit = new AuditBuffer(scrub(process.env));
  if (!mode || !MODES[mode]) {
    console.error("FLEET_THESIS_MODE must be one of survey|draft|refine|ship");
    process.exit(1);
  }
  try {
    const code = await MODES[mode](audit);
    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), `thesis-${mode}-${Date.now()}`, `Thesis ${mode}`, code === 0 ? "ok" : "failed");
    if (code !== 0) for (const e of [...audit.entries, ...audit.incidents]) console.log(`AUDIT ${JSON.stringify(e)}`);
    process.exit(code);
  } catch (err) {
    audit.incident("fatal", err.message);
    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), `thesis-${mode}-${Date.now()}`, `Thesis ${mode}`, `failed(${err.code || 1})`);
    console.error(`THESIS_FAILED mode=${mode} reason=${err.reason || err.message}`);
    for (const e of [...audit.entries, ...audit.incidents]) console.log(`AUDIT ${JSON.stringify(e)}`);
    process.exit(err.code && Number.isInteger(err.code) ? err.code : 1);
  }
}
