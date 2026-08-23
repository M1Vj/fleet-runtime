#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { ghInput, putFileContent } from "./lib/util.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, gitAdd, gitCommit, gitPush, configureIdentity } from "./lib/util.mjs";
import { askModel } from "./lib/model.mjs";

const REPO_ROOT = process.cwd();
const REVISIONS_PATH = path.join(process.env.FLEET_STATE_ROOT || REPO_ROOT, "state", "revisions.jsonl");

function readRevisions() {
  return existsSync(REVISIONS_PATH) ? readFileSync(REVISIONS_PATH, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
}

function countFor(repo, pr) {
  return readRevisions().filter((r) => r.repo === repo && r.pr === pr).length;
}

async function main() {
  const audit = new AuditBuffer(scrub(process.env));
  const identity = await runGate(process.env);
  if (process.env.FLEET_GH_TOKEN && !process.env.GH_TOKEN) process.env.GH_TOKEN = process.env.FLEET_GH_TOKEN;
  configureIdentity(REPO_ROOT, identity);
  const repo = process.env.FLEET_REPO;
  const prNumber = Number(process.env.FLEET_PR_NUMBER || 0);
  const max = Number(process.env.FLEET_MAX_REVISIONS || 2);
  const used = countFor(repo, prNumber);
  audit.note("quota", `revisions used=${used}/${max}`);
  if (used >= max) {
    console.log("REVISE_STATE=EXHAUSTED");
    appendLine({ t: new Date().toISOString(), repo, pr: prNumber, state: "exhausted" });
    return 0;
  }

  const pr = gh(["api", `/repos/${repo}/pulls/${prNumber}`], process.env);
  const comments = gh(["api", `/repos/${repo}/issues/${prNumber}/comments?per_page=20`], process.env) || [];
  const lastJudge = [...comments].reverse().find((c) => c.body && c.body.includes("fleet judge panel"));
  if (!lastJudge) throw new Error("no judge feedback found");
  const blockersMatch = lastJudge.body.match(/\*\*Blockers:\*\*[\s\S]*?(- .*)?(\n|$)/);
  const blockersSection = lastJudge.body.split("**Blockers:**")[1] || "";
  const blockerLines = blockersSection.split("\n").filter((l) => l.trim().startsWith("- ")).slice(0, 8);

  const filesApi = gh(["api", `/repos/${repo}/pulls/${prNumber}/files?per_page=100`], process.env) || [];
  const changedPaths = filesApi.map((f) => f.filename);
  const diffText = filesApi
    .map((f) => `--- ${f.filename}\n${String(f.patch || "").slice(0, 4000)}`)
    .join("\n\n")
    .slice(0, 30000);

  const promptV3 = [
    `You are the REVISION agent for your own change to ${repo} (PR #${prNumber}). Independent judges REJECTED it.`,
    "Fix every blocker below by returning corrected/new FULL files.",
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
    "JUDGE BLOCKERS:",
    blockerLines.join("\n"),
    "",
    "CURRENT DIFF:",
    diffText,
    "",
    "FULL JUDGE COMMENT:",
    lastJudge.body.slice(0, 5000),
  ].join("\n");

  let result = await askModel({
    prompt: promptV3,
    timeoutMs: 600000,
    env: process.env,
    preferVariantMax: true,
    maxRounds: 4,
  });
  audit.note("revise", `complete=${result.complete}`);
  if (!result.complete || !result.reply) {
    appendLine({ t: new Date().toISOString(), repo, pr: prNumber, state: "model-unavailable" });
    console.log("REVISE_STATE=MODEL_UNAVAILABLE");
    return 6;
  }
  const { harvestFencedFiles } = await import("./lib/directives.mjs");
  let files = harvestFencedFiles(result.reply);
  if (files.length === 0 && result.sessionId) {
    const firm = await askModel({
      prompt: "You returned no parseable FILE blocks. Re-output using EXACTLY: 'REVISED', 'SUMMARY: <line>', then per file 'FILE path=<path>' + fenced complete content.",
      sessionId: result.sessionId,
      timeoutMs: 480000,
      env: process.env,
      preferVariantMax: false,
      maxRounds: 2,
    });
    if (firm.reply) files = harvestFencedFiles(firm.reply);
  }
  if (files.length === 0) {
    process.stdout.write(`REVISE_REPLY=${String(result.reply).slice(0, 240)}\n`);
    appendLine({ t: new Date().toISOString(), repo, pr: prNumber, state: "no-parseable-files" });
    console.log("REVISE_STATE=NO_CHANGES");
    return 0;
  }

  const branch = pr.head.ref;
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
        ...(sha ? { sha } : {}),
      },
      process.env,
    );
  }
  summary = String(result.reply).split("\n").find((l) => l.startsWith("SUMMARY:"))?.replace(/^SUMMARY:\s*/, "") || String(summary).slice(0, 200);
  gh(["api", "-X", "POST", `/repos/${repo}/issues/${prNumber}/comments`, "-F", `body=🔧 **fleet revision agent** (round ${used + 1}/${max}): pushed corrected files (${files.map((f) => f.path).join(", ")}). ${summary}\n\nMerge gate re-evaluates automatically.`], process.env);

  function appendLine(obj) {
    try {
      mkdirSync(path.dirname(REVISIONS_PATH), { recursive: true });
      appendFileSync(REVISIONS_PATH, JSON.stringify(obj) + "\n");
    } catch {}
  }
  function writeAudit(a, rid) {
    try {
      a.writeMarkdown(path.join(REPO_ROOT, "audit"), rid, `Revise ${repo}#${prNumber}`, "ok");
    } catch {}
  }
}


main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`REVISE_FAILED reason=${err.message}`);
    process.exit(err.code && Number.isInteger(err.code) ? err.code : 1);
  });
