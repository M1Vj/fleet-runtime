import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isRevisionEligible,
  countRevisionsFor,
  writeQueueOutputs,
  writeRevisionOutputs,
} from "../scripts/merge.mjs";

test("isRevisionEligible identifies eligible same-repo PRs for automated revision", () => {
  assert.equal(isRevisionEligible(null), false);
  assert.equal(isRevisionEligible({}), false);

  // Fleet authored branch
  assert.equal(isRevisionEligible({
    head: { ref: "fleet/improve-12345", repo: { full_name: "M1Vj/VSU-SmartMap" } },
    base: { repo: { full_name: "M1Vj/VSU-SmartMap" } },
    user: { login: "M1Vj" },
  }), true);

  // Dependabot branch
  assert.equal(isRevisionEligible({
    head: { ref: "dependabot/npm_and_yarn/next-16.3.5", repo: { full_name: "M1Vj/VSU-SmartMap" } },
    base: { repo: { full_name: "M1Vj/VSU-SmartMap" } },
    user: { login: "dependabot[bot]" },
  }), true);

  // Owner branch
  assert.equal(isRevisionEligible({
    head: { ref: "feature/map-layer", repo: { full_name: "M1Vj/VSU-SmartMap" } },
    base: { repo: { full_name: "M1Vj/VSU-SmartMap" } },
    user: { login: "M1Vj" },
  }), true);

  // External fork PR (untrusted, cannot push to head directly)
  assert.equal(isRevisionEligible({
    head: { ref: "patch-1", repo: { full_name: "untrusted-user/VSU-SmartMap" } },
    base: { repo: { full_name: "M1Vj/VSU-SmartMap" } },
    user: { login: "untrusted-user" },
  }), false);
});

test("countRevisionsFor accurately counts revision attempts", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "rev-test-"));
  const stateDir = path.join(tempDir, "state");
  mkdirSync(stateDir, { recursive: true });
  const revFile = path.join(stateDir, "revisions.jsonl");

  assert.equal(countRevisionsFor(tempDir, "M1Vj/VSU-SmartMap", 102), 0);

  writeFileSync(revFile, [
    JSON.stringify({ repo: "M1Vj/VSU-SmartMap", pr: 102, state: "pushed", round: 1 }),
    JSON.stringify({ repo: "M1Vj/VSU-SmartMap", pr: 99, state: "pushed", round: 1 }),
    JSON.stringify({ repo: "M1Vj/VSU-SmartMap", pr: 102, state: "pushed", round: 2 }),
  ].join("\n") + "\n");

  assert.equal(countRevisionsFor(tempDir, "M1Vj/VSU-SmartMap", 102), 2);
  assert.equal(countRevisionsFor(tempDir, "M1Vj/VSU-SmartMap", 99), 1);
  assert.equal(countRevisionsFor(tempDir, "M1Vj/other-repo", 102), 0);
});

test("writeQueueOutputs sets has_pending_prs for Actions daisy-chaining", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "output-test-"));
  const outputFile = path.join(tempDir, "github-output.txt");

  writeQueueOutputs(outputFile, true);
  let content = readFileSync(outputFile, "utf8");
  assert.match(content, /^has_pending_prs=true$/m);

  writeQueueOutputs(outputFile, false);
  content = readFileSync(outputFile, "utf8");
  assert.match(content, /has_pending_prs=false/);
});

test("writeRevisionOutputs sets revision_needed and target fields cleanly", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "rev-out-test-"));
  const outputFile = path.join(tempDir, "github-output.txt");

  const outputs = writeRevisionOutputs(outputFile, "M1Vj/VSU-SmartMap", "102", true);
  assert.equal(outputs.revision_needed, "true");
  assert.equal(outputs.target_valid, "true");
  assert.equal(outputs.target_repo, "M1Vj/VSU-SmartMap");
  assert.equal(outputs.pr_number, "102");

  const content = readFileSync(outputFile, "utf8");
  assert.match(content, /revision_needed=true/);
  assert.match(content, /target_repo=M1Vj\/VSU-SmartMap/);
  assert.match(content, /pr_number=102/);
});

test("deterministic checks failure comment is properly parsed for revision blockers", () => {
  const comments = [
    {
      id: 1,
      body: "🧪 **fleet merge-gate**: deterministic checks FAILED.\n\n```\nnpm error Missing script: \"build\"\nnpm error In module @vsu/smartmap\n```",
    },
  ];

  const lastFeedback = [...comments].reverse().find((c) =>
    c.body && (
      c.body.includes("fleet multi-agent audit panel") ||
      c.body.includes("fleet judge panel") ||
      c.body.includes("deterministic checks FAILED")
    )
  );

  assert.ok(lastFeedback);
  const isDetFailure = lastFeedback.body.includes("deterministic checks FAILED");
  assert.equal(isDetFailure, true);

  const codeBlockMatch = lastFeedback.body.match(/```(?:[\w-]+)?\n([\s\S]*?)\n```/);
  assert.ok(codeBlockMatch);
  assert.match(codeBlockMatch[1], /npm error Missing script: "build"/);
});
