#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { runGate } from "./lib/gate.mjs";
import { ghInput, putFileContent } from "./lib/util.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, gitAdd, gitCommit, gitPush, gitRevParse, gitHasChanges, configureIdentity } from "./lib/util.mjs";
import { askModel } from "./lib/model.mjs";
import { isSafeRepoPath, harvestFencedFiles } from "./lib/directives.mjs";
import { verifyCommentAuthor, verifyCommit } from "./lib/verify.mjs";
import { makeTerminal } from "./lib/terminal.mjs";
import {
  isPublicDataClass,
  makeExecutionTerminal,
  privateRepository,
  PRIVATE_REPOSITORY_ENV,
  publicRepository,
  resolveStateRoot,
  writePublicArtifact,
} from "./lib/private-state.mjs";

const REPO_ROOT = process.cwd();
const STATE_ROOT = resolveStateRoot(process.env, REPO_ROOT);
const REVISIONS_PATH = path.join(STATE_ROOT, "state", "revisions.jsonl");

export function killSwitchEngaged() {
  const p = process.env.FLEET_KILL_SWITCH_PATH || path.join(STATE_ROOT, "state", "KILL_SWITCH");
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

// Parse the REVISION agent's plain-text format:
//
//   REVISED
//   SUMMARY: <one line>
//   FILE path=<repo-relative/path>
//   ```<optional lang>
//   <complete corrected file content>
//   ```
//
// Accepts any repo-relative path (code, docs, workflows — not just markdown),
// unlike the shared harvester which only recognizes doc-like extensions.
// Falls back to harvestFencedFiles for harvester-style replies.
export function parseRevisedFiles(reply) {
  const lines = String(reply || "").split("\n");
  const files = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^FILE\s+path=(.+?)\s*$/);
    if (!m) continue;
    const filePath = m[1].trim().replace(/^["']|["']$/g, "");
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length || !/^```/.test(lines[j].trim())) continue;
    const content = [];
    j++;
    while (j < lines.length && !/^```/.test(lines[j].trim())) {
      content.push(lines[j]);
      j++;
    }
    const text = content.join("\n");
    if (filePath && text.trim().length > 0) files.push({ path: filePath, content: text });
    i = j;
  }
  if (files.length > 0) return files;
  try {
    return harvestFencedFiles(reply);
  } catch {
    return [];
  }
}

// Revision scope rule (mirrors the prompt): only files already in the PR diff,
// plus at most 2 brand-new supporting files. Returns { ok, errors }.
export function validateRevisionFiles(files, changedPaths) {
  const errors = [];
  const allowed = new Set(changedPaths || []);
  let newCount = 0;
  for (const f of files || []) {
    if (!isSafeRepoPath(f.path)) {
      errors.push(`unsafe path: ${f.path}`);
      continue;
    }
    if (!allowed.has(f.path)) {
      newCount++;
      if (newCount > 2) errors.push(`too many new files (max 2 supporting): ${f.path}`);
    }
    if (String(f.content || "").length > 60000) errors.push(`too large: ${f.path} (${String(f.content).length})`);
  }
  if ((files || []).length === 0) errors.push("no files");
  return { ok: errors.length === 0, errors };
}

function appendLine(obj) {
  try {
    mkdirSync(path.dirname(REVISIONS_PATH), { recursive: true });
    appendFileSync(REVISIONS_PATH, JSON.stringify(obj) + "\n");
  } catch {}
}

function readRevisions() {
  return existsSync(REVISIONS_PATH) ? readFileSync(REVISIONS_PATH, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
}

function countFor(repo, pr) {
  return readRevisions().filter((r) => r.repo === repo && r.pr === pr).length;
}

async function main() {
  const audit = new AuditBuffer(scrub(process.env));
  const identity = await runGate(process.env);
  if (isPublicDataClass(process.env)) {
    try {
      const repository = publicRepository(process.env);
      writePublicArtifact(process.env, { mode: "revise", status: "blocked", repository, reason: "public-read-only" }, { kind: "revise", status: "blocked", repository });
      makeExecutionTerminal(process.env, STATE_ROOT, { lane: "revise" })("BLOCKED", { repository, reason: "public-read-only" });
    } catch {}
    audit.note("public-read-only", "revision mutations are disabled in public mode");
    console.log("REVISE_STATE=BLOCKED reason=public-read-only");
    return 4;
  }
  if (process.env.FLEET_GH_TOKEN && !process.env.GH_TOKEN) process.env.GH_TOKEN = process.env.FLEET_GH_TOKEN;
  configureIdentity(REPO_ROOT, identity);
  const repo = process.env.FLEET_REPO;
  const prNumber = Number(process.env.FLEET_PR_NUMBER || 0);
  if (!repo || !prNumber) {
    audit.note("skip", "missing FLEET_REPO or FLEET_PR_NUMBER");
    console.log("REVISE_STATE=SKIPPED reason=missing_repo_or_pr");
    return 0;
  }
  const max = Number(process.env.FLEET_MAX_REVISIONS || 2);
  const used = countFor(repo, prNumber);
  audit.note("quota", `revisions used=${used}/${max}`);
  const earlyTerminal = makeTerminal(STATE_ROOT, { lane: "revise" });
  if (used >= max) {
    console.log("REVISE_STATE=EXHAUSTED");
    appendLine({ t: new Date().toISOString(), repo, pr: prNumber, state: "exhausted" });
    earlyTerminal("EXHAUSTED", { repo, pr: prNumber, why: "max-revisions" });
    return 0;
  }

  const pr = gh(["api", `/repos/${repo}/pulls/${prNumber}`], process.env);
  const comments = gh(["api", `/repos/${repo}/issues/${prNumber}/comments?per_page=20`], process.env) || [];
  const lastFeedback = [...comments].reverse().find((c) =>
    c.body && (
      c.body.includes("fleet multi-agent audit panel") ||
      c.body.includes("fleet judge panel") ||
      c.body.includes("deterministic checks FAILED")
    )
  );
  if (!lastFeedback) throw new Error("no judge or deterministic feedback found");

  const isDetFailure = lastFeedback.body.includes("deterministic checks FAILED");
  let blockerLines = [];
  if (isDetFailure) {
    const codeBlockMatch = lastFeedback.body.match(/```(?:[\w-]+)?\n([\s\S]*?)\n```/);
    const rawError = codeBlockMatch ? codeBlockMatch[1] : lastFeedback.body;
    blockerLines = [
      "DETERMINISTIC CHECKS FAILED (TEST/BUILD/LOCKFILE ERROR):",
      ...rawError.split("\n").filter(Boolean).slice(-20).map((l) => `- ${l}`),
    ];
  } else {
    const blockersSection = lastFeedback.body.split("**Blockers:**")[1] || "";
    blockerLines = blockersSection.split("\n").filter((l) => l.trim().startsWith("- ")).slice(0, 8);
  }

  const filesApi = gh(["api", `/repos/${repo}/pulls/${prNumber}/files?per_page=100`], process.env) || [];
  const changedPaths = filesApi.map((f) => f.filename);
  const diffText = filesApi
    .map((f) => `--- ${f.filename}\n${String(f.patch || "").slice(0, 4000)}`)
    .join("\n\n")
    .slice(0, 30000);

  const promptV3 = [
    `You are the REVISION agent for ${repo} (PR #${prNumber}). ${isDetFailure ? "Deterministic verification checks (install / build / test) FAILED." : "Independent judges REJECTED it."}`,
    "Fix every blocker and error below by returning corrected/new FULL files so that tests and builds pass.",
    "Respond in EXACTLY this plain-text format:",
    "REVISED",
    "SUMMARY: <one line>",
    "Then per file:",
    "FILE path=<repo-relative/path>",
    "```",
    "<complete corrected file content>",
    "```",
    "Rules: only files already present in the diff, plus at most 2 new supporting files; never delete documentation/security sections; make the required CI check hermetic or explicitly gated behind a repository variable with a clear skip reason; keep fail-fast guards.",
    "",
    "BLOCKERS / FAILURE OUTPUT:",
    blockerLines.join("\n"),
    "",
    "CURRENT DIFF:",
    diffText,
    "",
    "FULL FEEDBACK COMMENT:",
    lastFeedback.body.slice(0, 5000),
  ].join("\n");

  if (pr.state !== "open") {
    appendLine({ t: new Date().toISOString(), repo, pr: prNumber, state: "pr-closed" });
    earlyTerminal("NO-OP", { repo, pr: prNumber, why: `state=${pr.state}` });
    console.log("REVISE_STATE=NO_CHANGES");
    return 0;
  }

  let result = await askModel({
    prompt: promptV3,
    timeoutMs: 600000,
    env: process.env,
    // Contributor tier: high thinking effort (maps to xhigh), never the max variant.
    preferVariantMax: true,
    maxRounds: 4,
  });
  audit.note("revise", `complete=${result.complete}`);
  if (!result.complete || !result.reply) {
    appendLine({ t: new Date().toISOString(), repo, pr: prNumber, state: "model-unavailable" });
    earlyTerminal("STALLED", { repo, pr: prNumber, why: "model-unavailable" });
    console.log("REVISE_STATE=MODEL_UNAVAILABLE");
    return 6;
  }
  let files = parseRevisedFiles(result.reply);
  if (files.length === 0 && result.sessionId) {
    const firm = await askModel({
      prompt: "You returned no parseable FILE blocks. Re-output using EXACTLY: 'REVISED', 'SUMMARY: <line>', then per file 'FILE path=<path>' + fenced complete content.",
      sessionId: result.sessionId,
      timeoutMs: 480000,
      env: process.env,
      preferVariantMax: true,
      maxRounds: 2,
    });
    if (firm.reply) files = parseRevisedFiles(firm.reply);
  }
  if (files.length === 0) {
    process.stdout.write(`REVISE_REPLY=${String(result.reply).slice(0, 240)}\n`);
    appendLine({ t: new Date().toISOString(), repo, pr: prNumber, state: "no-parseable-files" });
    earlyTerminal("NO-OP", { repo, pr: prNumber, why: "no-parseable-files" });
    console.log("REVISE_STATE=NO_CHANGES");
    return 0;
  }

  const branch = pr.head.ref;
  const validation = validateRevisionFiles(files, changedPaths);
  if (!validation.ok) {
    audit.incident("validate", validation.errors.slice(0, 5).join("; "));
    appendLine({ t: new Date().toISOString(), repo, pr: prNumber, state: "rejected", errors: validation.errors.slice(0, 5) });
    console.log(`REVISE_STATE=REJECTED ${validation.errors[0]}`);
    return 5;
  }
  if (killSwitchEngaged()) {
    audit.incident("kill-switch", "revision push refused: KILL_SWITCH engaged (files validated but not pushed)");
    appendLine({ t: new Date().toISOString(), repo, pr: prNumber, state: "kill-switch-skipped" });
    console.log("REVISE_STATE=BLOCKED kill-switch");
    return 2;
  }
  for (const f of files) {
    let sha;
    try {
      const ex = gh(["api", `/repos/${repo}/contents/${f.path}?ref=${branch}`], process.env);
      sha = ex && ex.sha;
    } catch {
      sha = undefined;
    }
    ghInput(
      ["api", "-X", "PUT", `/repos/${repo}/contents/${f.path}`],
      {
        message: `[fleet-revise] update ${f.path} (round ${used + 1})`,
        content: Buffer.from(f.content, "utf8").toString("base64"),
        branch,
        committer: {
          name: identity.name,
          email: identity.email,
        },
        author: {
          name: identity.name,
          email: identity.email,
        },
        ...(sha ? { sha } : {}),
      },
      process.env,
    );
  }
  // Record the push fact BEFORE the comment-verify step so a verify
  // throw never leaves an unrecorded push behind for retries to duplicate.
  appendLine({ t: new Date().toISOString(), repo, pr: prNumber, state: "pushed", round: used + 1, files: files.map((f) => f.path) });
  const summaryLine = String(result.reply).split("\n").find((l) => l.startsWith("SUMMARY:"));
  const summary = (summaryLine ? summaryLine.replace(/^SUMMARY:\s*/, "") : `round ${used + 1} revision`).slice(0, 200);
  const comment = gh(["api", "-X", "POST", `/repos/${repo}/issues/${prNumber}/comments`, "-F", `body=🔧 **fleet revision agent** (round ${used + 1}/${max}): pushed corrected files (${files.map((f) => f.path).join(", ")}). ${summary}\n\nMerge gate re-evaluates automatically.`], process.env);
  try {
    await verifyCommentAuthor(repo, comment.id, identity, process.env.FLEET_GH_TOKEN);
    audit.note("comment-verify", `revision comment attribution verified id=${comment.id}`);
  } catch (err) {
    audit.incident("comment-verify", `ATTRIBUTION FAILURE on revision comment: ${String(err.message).slice(0, 160)}`);
    throw err;
  }

  const terminal = makeTerminal(STATE_ROOT, { lane: "revise" });
  terminal("SUCCESS", { repo, pr: prNumber, round: used + 1, files: files.length });
  try {
    audit.writeMarkdown(path.join(STATE_ROOT, "audit"), `revise-${Date.now()}`, `Revise ${repo}#${prNumber}`, "ok");
  } catch {}
  try {
    if (gitHasChanges(STATE_ROOT, ["state", "audit"])) {
      gitAdd(STATE_ROOT, ["state", "audit"]);
      if (gitCommit(STATE_ROOT, `[fleet] revise ${repo}#${prNumber} round ${used + 1}`, identity) === "committed") {
        gitPush(STATE_ROOT, "main", process.env);
        const shaAfter = gitRevParse(STATE_ROOT, "HEAD");
        await verifyCommit(privateRepository(process.env, PRIVATE_REPOSITORY_ENV.control), shaAfter, identity, process.env.FLEET_GH_TOKEN);
        audit.note("push-verify", `sha=${shaAfter.slice(0, 10)}`);
      }
    }
  } catch (err) {
    audit.incident("push-verify", `bookkeeping push failed (revision already pushed): ${String(err.message).slice(0, 160)}`);
  }
  console.log(`REVISE_STATE=PUSHED round=${used + 1}/${max}`);
  return 0;
}


main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`REVISE_FAILED reason=${err.message}`);
    process.exit(err.code && Number.isInteger(err.code) ? err.code : 1);
  });
