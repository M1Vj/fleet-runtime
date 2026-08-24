import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendMemoryEvent } from "../scripts/lib/pr-memory.mjs";
import { revisionMemoryContext } from "../scripts/revise.mjs";

const source = readFileSync(new URL("../scripts/revise.mjs", import.meta.url), "utf8");

test("revision script imports the target, path, memory, and attribution contracts", () => {
  assert.match(source, /from ["']\.\/lib\/revision-queue\.mjs["']/);
  assert.match(source, /validateTarget/);
  assert.match(source, /validateRevisionFiles/);
  assert.match(source, /parseRevisionFiles/);
  assert.doesNotMatch(source, /harvestFencedFiles/);
  assert.match(source, /isSafeRepoPath/);
  assert.match(source, /appendMemoryEvent/);
  assert.match(source, /buildMemoryContext/);
  assert.match(source, /verifyCommentAuthor/);
});

test("revision no longer hard-codes the old v2 path or undeclared summary", () => {
  assert.equal(source.includes("startsWith(\"v2/\")"), false);
  assert.equal(source.includes("!f.path.startsWith(\"v2/\")"), false);
  assert.equal(/(^|\n)\s*summary\s*=/.test(source), false);
  assert.match(source, /const\s+summary\s*=/);
});

test("target validation is ordered before the identity gate and GitHub API use", () => {
  const mainSource = source.slice(source.indexOf("export async function main"));
  const targetIndex = mainSource.indexOf("validateTarget(");
  const gateIndex = mainSource.indexOf("runGate(");
  const apiIndex = mainSource.indexOf("reviseTarget(");
  assert.ok(targetIndex >= 0 && targetIndex < gateIndex);
  assert.ok(targetIndex < apiIndex);
  assert.match(source, /FLEET_HEAD_SHA/);
  assert.match(source, /state !== ["']open["']/);
  assert.match(source, /head\.sha/);
});

test("main rejects an empty target before requiring credentials or making an API call", async () => {
  const { main } = await import("../scripts/revise.mjs");
  await assert.rejects(
    main({ FLEET_REPO: "", FLEET_PR_NUMBER: "", FLEET_HEAD_SHA: "" }),
    (error) => error && error.code === 5 && /INVALID_REVISION_TARGET/.test(error.message),
  );
});

test("revision state records named start, error, and success events without raw model payloads", () => {
  assert.match(source, /persistEvent\(context,\s*["']REVISION_STARTED["']/);
  assert.match(source, /persistEvent\(context,\s*["']ERROR["']/);
  assert.match(source, /persistEvent\(context,\s*["']SUCCESS["']/);
  assert.equal(/appendMemoryEvent\([^;]*diffText/s.test(source), false);
  assert.equal(/appendMemoryEvent\([^;]*result\.reply/s.test(source), false);
});

test("judge feedback is attribution-verified before blockers enter the prompt", () => {
  const verifyIndex = source.indexOf("verifyCommentAuthor(target.repo, lastJudge.id");
  const blockersIndex = source.indexOf("extractJudgeBlockers(lastJudge.body)");
  assert.ok(verifyIndex >= 0 && verifyIndex < blockersIndex);
});

test("revision memory context reuses prior heads for the same repo and PR", () => {
  const root = mkdtempSync(path.join(tmpdir(), "revise-memory-context-"));
  const file = path.join(root, "state", "pr-memory.jsonl");
  appendMemoryEvent(file, {
    runId: "old-head",
    lane: "revise",
    repo: "M1Vj/example-repo",
    pr: 42,
    headSha: "a".repeat(40),
    attempt: 1,
    kind: "revision",
    state: "ERROR",
    summary: "old blocker remains",
  });
  appendMemoryEvent(file, {
    runId: "new-head",
    lane: "revise",
    repo: "M1Vj/example-repo",
    pr: 42,
    headSha: "b".repeat(40),
    attempt: 2,
    kind: "revision",
    state: "REVISION_STARTED",
    summary: "new retry",
  });
  const context = revisionMemoryContext(file, "M1Vj/example-repo", 42);
  assert.deepEqual(context.map((entry) => entry.runId), ["new-head", "old-head"]);
});

test("revision requires PR-memory persistence before model or branch mutation", () => {
  const start = source.indexOf("persistEvent(context, \"REVISION_STARTED\"");
  const model = source.indexOf("askModel(");
  const put = source.indexOf("ghInput(");
  assert.ok(start >= 0 && start < model && start < put);
  assert.match(source.slice(start, model), /required:\s*true/);
  assert.match(source, /STATE_PERSISTENCE_FAILED/);
});

test("revision records truthful audit failure status and rejects fork heads before PUT", () => {
  assert.match(source, /let\s+auditStatus\s*=\s*["']ok["']/);
  assert.match(source, /auditStatus\s*=\s*["']failed["']/);
  assert.match(source, /auditStatus\s*=\s*result\s*===\s*0\s*\?\s*["']ok["']\s*:\s*["']failed["']/);
  const forkCheck = source.indexOf("headRepositoryMatches(latestPr, target.repo)");
  const putIndex = source.indexOf("ghInput(");
  assert.ok(forkCheck >= 0 && forkCheck < putIndex);
});
