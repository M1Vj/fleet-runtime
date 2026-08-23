#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
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

  const workdir = `/tmp/revise-${repo.replace("/", "__")}-${prNumber}`;
  gh(["repo", "clone", repo, workdir, "--", "--branch", pr.head.ref], process.env);

  const modelEnv = {
    ...process.env,
    FLEET_WORKSPACE_ROOT: workdir,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      permission: { edit: "allow", bash: { "*": "deny", "git add *": "allow", "git commit *": "allow" }, question: "deny", external_directory: "deny", read: "allow", grep: "allow", glob: "allow" },
    }),
  };

  const result = await askModel({
    prompt: [
      `You are the REVISION agent. Your earlier change to ${repo} (PR #${prNumber}, branch ${pr.head.ref}) was reviewed and REJECTED.`,
      "The working directory contains the PR branch checked out — edit the files IN PLACE to address every blocker below.",
      "You may run read-only inspection plus targeted edits. Do NOT touch files unrelated to the blockers. Do NOT delete documentation or security content.",
      "BLOCKERS:",
      ...blockerLines,
      "",
      "When done editing, reply ONLY strict JSON: {\"summary\":\"what you changed\"}",
      "Full judge comment for context:",
      lastJudge.body.slice(0, 6000),
    ].join("\n"),
    timeoutMs: 600000,
    env: modelEnv,
    preferVariantMax: true,
    maxRounds: 4,
    workspace: workdir,
  });
  audit.note("revise", `complete=${result.complete}`);
  if (!result.complete || !result.reply) {
    appendLine({ t: new Date().toISOString(), repo, pr: prNumber, state: "model-unavailable" });
    console.log("REVISE_STATE=MODEL_UNAVAILABLE");
    return 6;
  }
  let summary = String(result.reply).slice(0, 500);
  try {
    summary = JSON.parse(result.reply.match(/{[\s\S]*}/)[0]).summary || summary;
  } catch {}

  const status = gh(["api", `/repos/${repo}/pulls/${prNumber}`], process.env);
  void status;
  const changed = spawnGit(workdir, ["status", "--porcelain"]);
  if (!changed.stdout.trim()) {
    appendLine({ t: new Date().toISOString(), repo, pr: prNumber, state: "no-changes" });
    console.log("REVISE_STATE=NO_CHANGES");
    return 0;
  }
  spawnGit(workdir, ["add", "-A"]);
  const commit = spawnGit(workdir, ["commit", "-m", `[fleet-revise] address review blockers (${summary.slice(0, 80)})`]);
  if (commit.status !== 0) throw new Error(`revision commit failed: ${String(commit.stderr).slice(-200)}`);
  const push = spawnGit(workdir, ["push", "origin", pr.head.ref]);
  if (push.status !== 0) throw new Error(`push failed: ${String(push.stderr).slice(-200)}`);

  appendLine({ t: new Date().toISOString(), repo, pr: prNumber, state: "revised", round: used + 1 });
  gh(["api", "-X", "POST", `/repos/${repo}/issues/${prNumber}/comments`, "-F", `body=🔧 **fleet revision agent**: pushed fixes for the review blockers (round ${used + 1}/${max}). Summary: ${summary}\n\nMerge gate will re-evaluate automatically.`], process.env);
  audit.note("done", `round=${used + 1}`);
  writeAudit(audit, `revise-${Date.now()}`);
  console.log("REVISE_STATE=REVISED");
  return 0;

  function appendLine(obj) {
    try {
      const { appendFileSync, mkdirSync: mkd } = requireFsMod();
      mkd(path.dirname(REVISIONS_PATH), { recursive: true });
      appendFileSync(REVISIONS_PATH, JSON.stringify(obj) + "\n");
    } catch {}
  }
  function writeAudit(a, rid) {
    try {
      a.writeMarkdown(path.join(REPO_ROOT, "audit"), rid, `Revise ${repo}#${prNumber}`, "ok");
    } catch {}
  }
  function spawnGit(dir, args) {
    const cp = req("node:child_process").spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env } });
    return { status: cp.status, stdout: cp.stdout || "", stderr: cp.stderr || "" };
  }
  function req(mod) {
    // eslint-disable-next-line
    return globalRequire(mod);
  }
}
let globalRequire = null;
import { createRequire as _cr } from "node:module";
globalRequire = _cr(import.meta.url);

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`REVISE_FAILED reason=${err.message}`);
    process.exit(err.code && Number.isInteger(err.code) ? err.code : 1);
  });
