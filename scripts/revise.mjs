#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import {
  appendMemoryEvent,
  buildMemoryContext,
  memoryPath,
  readMemoryEvents,
  redactText,
} from "./lib/pr-memory.mjs";
import {
  assertTarget,
  headRepositoryMatches,
  parseRevisionFiles,
  validateTarget,
  validateRevisionFiles,
} from "./lib/revision-queue.mjs";
import { isSafeRepoPath } from "./lib/directives.mjs";
import {
  configureIdentity,
  gh,
  ghInput,
  gitHasChanges,
  safeCommitState,
  scrub,
  sha256,
} from "./lib/util.mjs";
import { askModel } from "./lib/model.mjs";
import {
  verifyCommentAuthor,
  verifyCommit,
  verifyPullAuthor,
} from "./lib/verify.mjs";

const REPO_ROOT = process.cwd();
const STATE_ROOT = process.env.FLEET_STATE_ROOT || REPO_ROOT;
const MEMORY_FILE = memoryPath(STATE_ROOT);

function revisionCount(repo, pr) {
  return readMemoryEvents(MEMORY_FILE).filter(
    (entry) => entry.lane === "revise" && entry.repo === repo && entry.pr === pr && entry.state === "REVISION_STARTED",
  ).length;
}

function boundedSummary(value, fallback) {
  const text = redactText(String(value || fallback || "").replace(/[\r\n]+/g, " ").trim());
  return text.slice(0, 240);
}

function blockerIds(blockers) {
  return (Array.isArray(blockers) ? blockers : []).slice(0, 8).map((blocker) => sha256(String(blocker)));
}

function extractJudgeBlockers(body) {
  const section = String(body || "").split("**Blockers:**")[1] || "";
  return section
    .split("\n")
    .filter((line) => line.trim().startsWith("- "))
    .slice(0, 8)
    .map((line) => line.trim().slice(2, 500));
}

function extractSummary(reply) {
  const line = String(reply || "").split("\n").find((candidate) => candidate.startsWith("SUMMARY:"));
  return boundedSummary(line ? line.replace(/^SUMMARY:\s*/, "") : "", "revision applied");
}

function currentHead(pr) {
  return String(pr && pr.head && pr.head.sha || "");
}

function targetMatchesHead(pr, expectedHead) {
  return pr && pr.state === "open" && currentHead(pr) === expectedHead;
}

function recordMemory(context, state, details = {}) {
  const summary = boundedSummary(details.summary, state.toLowerCase());
  return appendMemoryEvent(MEMORY_FILE, {
    runId: context.runId,
    lane: "revise",
    repo: context.repo,
    pr: context.pr,
    headSha: context.headSha,
    attempt: context.attempt,
    kind: state === "ERROR" ? "error" : state === "SUCCESS" ? "revision" : state === "REVISION_STARTED" ? "revision" : "terminal",
    state,
    summary,
    changedPaths: details.changedPaths || [],
    blockerIds: blockerIds(details.blockers || details.blockerIds),
    artifactRefs: [],
  });
}

function persistState(identity, audit, message, { required = false } = {}) {
  let changed = false;
  try {
    changed = gitHasChanges(STATE_ROOT, ["state"]);
    if (!changed) {
      if (required) throw new Error("state checkout has no staged PR-memory change");
      return "no-changes";
    }
    const outcome = safeCommitState(STATE_ROOT, ["state"], message, identity, process.env);
    audit.note("state", outcome);
    if (required && outcome === "no-changes") throw new Error("state commit produced no change");
    return outcome;
  } catch (error) {
    audit.incident("state", `state persistence failed: ${String(error.message).slice(0, 160)}`);
    if (required) {
      const failure = new Error(`STATE_PERSISTENCE_FAILED ${String(error.message).slice(0, 200)}`);
      failure.code = 7;
      throw failure;
    }
    return "error";
  }
}

function persistEvent(context, state, details, identity, audit, { required = false } = {}) {
  let eventResult;
  try {
    eventResult = recordMemory(context, state, details);
    audit.note("memory", `${state} appended=${eventResult.appended}`);
  } catch (error) {
    audit.incident("memory", `memory append failed: ${String(error.message).slice(0, 160)}`);
    if (required) {
      const failure = new Error(`STATE_PERSISTENCE_FAILED ${String(error.message).slice(0, 200)}`);
      failure.code = 7;
      throw failure;
    }
  }
  const stateOutcome = persistState(identity, audit, `[fleet] revise ${context.repo}#${context.pr} ${state}`, { required });
  return { eventResult, stateOutcome };
}

export function revisionMemoryContext(memoryFile, repo, pr) {
  return buildMemoryContext(memoryFile, {
    repo,
    pr,
    maxEvents: 200,
    maxChars: 24000,
  });
}

async function fetchRevisionTarget(target, identity) {
  const pr = gh(["api", `/repos/${target.repo}/pulls/${target.pr}`], process.env);
  if (!pr || pr.state !== "open") return { pr, terminal: "closed" };
  await verifyPullAuthor(target.repo, target.pr, identity, process.env.FLEET_GH_TOKEN);
  if (!headRepositoryMatches(pr, target.repo)) return { pr, terminal: "fork-head" };
  if (!pr.head || !pr.head.sha || (target.headSha && pr.head.sha !== target.headSha)) return { pr, terminal: "stale-head" };
  return { pr, terminal: null };
}

async function reviseTarget(target, identity, audit, context) {
  const max = Number(process.env.FLEET_MAX_REVISIONS || 2);
  const used = revisionCount(target.repo, target.pr);
  audit.note("quota", `revisions used=${used}/${max}`);
  if (used >= max) {
    persistEvent(context, "EXHAUSTED", { summary: `revision cap reached (${max})` }, identity, audit);
    console.log("REVISE_STATE=EXHAUSTED");
    return 0;
  }

  const fetched = await fetchRevisionTarget(target, identity);
  if (fetched.terminal) {
    const terminalSummary = fetched.terminal === "stale-head"
      ? "PR head SHA changed before revision"
      : fetched.terminal === "fork-head"
        ? "fork-origin PR head is not the target repository"
        : "PR is not open";
    persistEvent(context, "STALLED", { summary: terminalSummary }, identity, audit);
    console.log(`REVISE_STATE=${fetched.terminal === "stale-head" ? "STALE_HEAD" : fetched.terminal === "fork-head" ? "FORK_HEAD" : "NO_OP"}`);
    return 0;
  }
  const pr = fetched.pr;
  const expectedHead = target.headSha || currentHead(pr);
  context.headSha = expectedHead;

  const comments = gh(["api", `/repos/${target.repo}/issues/${target.pr}/comments?per_page=20`], process.env) || [];
  const lastJudge = [...comments].reverse().find((comment) => comment.body && comment.body.includes("fleet judge panel"));
  if (!lastJudge) throw new Error("no judge feedback found");
  if (!lastJudge.id) throw new Error("judge comment response missing id");
  await verifyCommentAuthor(target.repo, lastJudge.id, identity, process.env.FLEET_GH_TOKEN);
  const blockers = extractJudgeBlockers(lastJudge.body);

  const filesApi = gh(["api", `/repos/${target.repo}/pulls/${target.pr}/files?per_page=100`], process.env) || [];
  const changedPaths = filesApi.map((file) => file.filename).filter(Boolean);
  const diffText = filesApi
    .map((file) => `--- ${file.filename}\n${String(file.patch || "").slice(0, 4000)}`)
    .join("\n\n")
    .slice(0, 30000);
  const priorMemory = revisionMemoryContext(MEMORY_FILE, target.repo, target.pr);
  persistEvent(context, "REVISION_STARTED", { summary: "revision model run started", changedPaths, blockers }, identity, audit, { required: true });

  const prompt = [
    `You are the REVISION agent for your own change to ${target.repo} (PR #${target.pr}). Independent judges rejected it.`,
    "Fix every blocker below by returning corrected/new FULL files.",
    "Respond in EXACTLY this plain-text format:",
    "REVISED",
    "SUMMARY: <one line>",
    "Then per file:",
    "FILE path=<repo-relative/path>",
    "```",
    "<complete corrected file content>",
    "```",
    "Rules: only files already present in the diff, plus at most 2 new safe supporting files; never write .env, state, audit, credentials, or an unmodified workflow path.",
    "",
    "RECENT PR MEMORY (bounded and redacted):",
    JSON.stringify(priorMemory),
    "",
    "JUDGE BLOCKERS:",
    blockers.join("\n"),
    "",
    "CURRENT DIFF:",
    diffText,
    "",
    "FULL JUDGE COMMENT:",
    String(lastJudge.body).slice(0, 5000),
  ].join("\n");

  let result = await askModel({ prompt, timeoutMs: 600000, env: process.env, preferVariantMax: true, maxRounds: 4 });
  audit.note("revise", `complete=${result.complete}`);
  if (!result.complete || !result.reply) {
    persistEvent(context, "ERROR", { summary: "model unavailable", changedPaths, blockers }, identity, audit);
    console.log("REVISE_STATE=MODEL_UNAVAILABLE");
    return 6;
  }

  let parsedFiles = parseRevisionFiles(result.reply);
  let files = parsedFiles.files;
  if (files.length === 0 && result.sessionId) {
    const firm = await askModel({
      prompt: "You returned no parseable FILE blocks. Re-output using EXACTLY: 'REVISED', 'SUMMARY: <line>', then per file 'FILE path=<path>' + fenced complete content.",
      sessionId: result.sessionId,
      timeoutMs: 480000,
      env: process.env,
      preferVariantMax: false,
      maxRounds: 2,
    });
    if (firm.reply) {
      parsedFiles = parseRevisionFiles(firm.reply);
      files = parsedFiles.files;
    }
  }
  if (files.length === 0) {
    persistEvent(context, "ERROR", { summary: parsedFiles.errors[0] || "model returned no parseable files", changedPaths, blockers }, identity, audit);
    console.log("REVISE_STATE=NO_CHANGES");
    return 0;
  }
  if (parsedFiles.errors.length > 0) {
    persistEvent(context, "ERROR", { summary: parsedFiles.errors[0], changedPaths, blockers }, identity, audit);
    console.log(`REVISE_STATE=REJECTED ${parsedFiles.errors[0]}`);
    return 5;
  }

  // Keep the shared path validator in this script's import graph as an explicit
  // defense-in-depth check; revision-queue applies the full changed-path policy.
  const pathSafetyErrors = files.filter((file) => !isSafeRepoPath(file.path)).map((file) => `unsafe path: ${file.path}`);
  const validation = validateRevisionFiles(files, changedPaths);
  if (pathSafetyErrors.length > 0 || !validation.ok) {
    const errors = [...pathSafetyErrors, ...(validation.errors || [])];
    persistEvent(context, "ERROR", { summary: errors[0] || "revision output rejected", changedPaths, blockers }, identity, audit);
    console.log(`REVISE_STATE=REJECTED ${errors[0] || "invalid output"}`);
    return 5;
  }

  // Re-read the PR immediately before the first PUT to close the stale-head
  // race between model generation and branch mutation.
  const latestPr = gh(["api", `/repos/${target.repo}/pulls/${target.pr}`], process.env);
  if (!targetMatchesHead(latestPr, expectedHead)) {
    persistEvent(context, "STALLED", { summary: "PR closed or head SHA changed before mutation", changedPaths, blockers }, identity, audit);
    console.log("REVISE_STATE=STALE_HEAD");
    return 0;
  }
  if (!headRepositoryMatches(latestPr, target.repo)) {
    persistEvent(context, "STALLED", { summary: "fork-origin PR head is not the target repository", changedPaths, blockers }, identity, audit);
    console.log("REVISE_STATE=FORK_HEAD");
    return 0;
  }
  const branch = latestPr.head.ref;
  if (!branch) throw new Error("PR head branch is missing");

  const commitShas = [];
  for (const file of validation.files) {
    let sha;
    try {
      const existing = gh(["api", `/repos/${target.repo}/contents/${file.path}?ref=${branch}`], process.env);
      sha = existing && existing.sha;
    } catch {
      sha = undefined;
    }
    const response = ghInput(
      ["api", "-X", "PUT", `/repos/${target.repo}/contents/${file.path}`],
      {
        message: `[fleet-revise] update ${file.path} (round ${used + 1})`,
        content: Buffer.from(file.content, "utf8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      },
      process.env,
    );
    const commitSha = response && response.commit && response.commit.sha;
    if (commitSha) {
      await verifyCommit(target.repo, commitSha, identity, process.env.FLEET_GH_TOKEN);
      commitShas.push(commitSha);
    }
  }

  const summary = extractSummary(result.reply);
  const comment = gh(
    ["api", "-X", "POST", `/repos/${target.repo}/issues/${target.pr}/comments`, "-F", `body=<!-- fleet-pr-memory: revision -->\n🔧 **fleet revision agent** (round ${used + 1}/${max}): pushed corrected files (${validation.files.map((file) => file.path).join(", ")}). ${summary}\n\nMerge gate re-evaluates automatically.`],
    process.env,
  );
  if (!comment || !comment.id) throw new Error("revision comment response missing id");
  await verifyCommentAuthor(target.repo, comment.id, identity, process.env.FLEET_GH_TOKEN);
  const successPersistence = persistEvent(context, "SUCCESS", { summary, changedPaths: validation.files.map((file) => file.path), blockers }, identity, audit);
  if (successPersistence.stateOutcome === "error") console.log("REVISE_MEMORY_WARNING=STATE_PERSIST_FAILED");
  audit.note("attribution", `verified ${commitShas.length} commit(s) and comment #${comment.id}`);
  console.log("REVISE_STATE=SUCCESS");
  return 0;
}

export async function main(env = process.env) {
  const audit = new AuditBuffer(scrub(env));
  const rawTarget = { repo: env.FLEET_REPO, pr: env.FLEET_PR_NUMBER, headSha: env.FLEET_HEAD_SHA };
  const targetValidation = validateTarget(rawTarget);
  if (!targetValidation.ok) {
    const error = new Error(`INVALID_REVISION_TARGET ${targetValidation.errors.join("; ")}`);
    error.code = 5;
    throw error;
  }
  const target = assertTarget(targetValidation);
  const runId = env.FLEET_RUN_ID || `revise-${Date.now()}`;
  const context = {
    runId,
    repo: target.repo,
    pr: target.pr,
    headSha: target.headSha || "",
    attempt: 0,
  };
  let identity;
  let auditStatus = "ok";
  try {
    identity = await runGate(env);
    configureIdentity(REPO_ROOT, identity);
    context.attempt = revisionCount(target.repo, target.pr) + 1;
    const result = await reviseTarget(target, identity, audit, context);
    auditStatus = result === 0 ? "ok" : "failed";
    return result;
  } catch (error) {
    auditStatus = "failed";
    if (identity) {
      persistEvent(context, "ERROR", { summary: error.message || "revision failed" }, identity, audit);
    }
    throw error;
  } finally {
    try {
      audit.writeMarkdown(path.join(REPO_ROOT, "audit"), runId, `Revise ${target.repo}#${target.pr}`, auditStatus, { lane: "revise" });
    } catch {}
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
    .then((code) => process.exit(code || 0))
    .catch((error) => {
      console.error(`REVISE_FAILED reason=${error.message}`);
      process.exit(error.code && Number.isInteger(error.code) ? error.code : 1);
    });
}
