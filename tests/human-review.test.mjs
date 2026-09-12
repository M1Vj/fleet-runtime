import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  queuePaths,
  loadQueue,
  saveQueue,
  recordHumanReview,
  resolveHumanReviewItem,
  renderHumanReviewMarkdown,
  reconcileHumanReviewQueue,
} from "../scripts/lib/human-review.mjs";

test("queuePaths points to human-review-queue.json and HUMAN_REVIEW_QUEUE.md", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hr-paths-"));
  const { jsonPath, mdPath } = queuePaths(root);
  assert.equal(jsonPath, path.join(root, "state", "human-review-queue.json"));
  assert.equal(mdPath, path.join(root, "state", "HUMAN_REVIEW_QUEUE.md"));
});

test("loadQueue defaults to empty active and resolved lists", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hr-load-"));
  const queue = loadQueue(root);
  assert.deepEqual(queue.active, []);
  assert.deepEqual(queue.resolved, []);
});

test("recordHumanReview upserts an active item and updates Markdown dashboard", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hr-record-"));
  const item = {
    repo: "M1Vj/VSU-SmartMap",
    prNumber: 42,
    title: "feat(ui): redesign map navigation control",
    headSha: "abc1234567890",
    author: "M1Vj",
    branch: "fleet/smartmap-nav",
    category: "ui-ux",
    why: "Pixel diff (14.2%) exceeds 10% threshold",
    scores: [
      { lens: "correctness-and-security", score: 92, verdict: "approve" },
      { lens: "ux-and-visual-integrity", score: 86, verdict: "approve" },
    ],
    deterministic: true,
    visual: {
      diffPct: 14.2,
      consoleErrors: 0,
      a11yBlocker: false,
      vlm: { verdict: "approve", score: 88 },
    },
  };

  const recorded = recordHumanReview(root, item);
  assert.equal(recorded.repo, "M1Vj/VSU-SmartMap");
  assert.equal(recorded.prNumber, 42);
  assert.equal(recorded.category, "ui-ux");

  const queue = loadQueue(root);
  assert.equal(queue.active.length, 1);
  assert.equal(queue.active[0].prNumber, 42);

  const { mdPath } = queuePaths(root);
  assert.ok(existsSync(mdPath));
  const md = readFileSync(mdPath, "utf8");
  assert.ok(md.includes("M1Vj/VSU-SmartMap#42"));
  assert.ok(md.includes("Pixel diff"));
  assert.ok(md.includes("14.20%"));
  assert.ok(md.includes("gh pr merge 42 --repo M1Vj/VSU-SmartMap --merge"));

  // Upsert test with changed score
  const updatedItem = { ...item, why: "Updated why reasoning" };
  recordHumanReview(root, updatedItem);
  const queue2 = loadQueue(root);
  assert.equal(queue2.active.length, 1);
  assert.equal(queue2.active[0].why, "Updated why reasoning");
});

test("resolveHumanReviewItem moves active item to resolved", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hr-resolve-"));
  recordHumanReview(root, {
    repo: "M1Vj/Dormy",
    prNumber: 15,
    title: "chore: update config",
    category: "risk-sensitive",
    why: "Workflow deletion detected",
  });

  assert.equal(loadQueue(root).active.length, 1);
  assert.equal(loadQueue(root).resolved.length, 0);

  const resolved = resolveHumanReviewItem(root, "M1Vj/Dormy", 15, "merged");
  assert.equal(resolved, true);

  const after = loadQueue(root);
  assert.equal(after.active.length, 0);
  assert.equal(after.resolved.length, 1);
  assert.equal(after.resolved[0].repo, "M1Vj/Dormy");
  assert.equal(after.resolved[0].prNumber, 15);
  assert.equal(after.resolved[0].resolution, "merged");
  assert.ok(after.resolved[0].resolvedAt);

  // Resolving non-existent item returns false
  assert.equal(resolveHumanReviewItem(root, "M1Vj/Dormy", 999), false);
});

test("renderHumanReviewMarkdown handles empty and populated queues", () => {
  const emptyMd = renderHumanReviewMarkdown([], []);
  assert.ok(emptyMd.includes("No pull requests currently require human review"));
  assert.ok(emptyMd.includes("No resolved reviews recorded yet"));

  const populatedMd = renderHumanReviewMarkdown(
    [
      {
        repo: "M1Vj/test-repo",
        prNumber: 99,
        title: "Deadlock test",
        category: "judge-deadlock",
        why: "Max revisions reached",
        headSha: "1234567890abcdef",
        scores: [{ lens: "correctness", score: 75 }],
        prUrl: "https://github.com/M1Vj/test-repo/pull/99",
      },
    ],
    [
      {
        repo: "M1Vj/test-repo",
        prNumber: 98,
        title: "Resolved item",
        category: "ui-ux",
        resolution: "merged",
        resolvedAt: "2026-09-12T00:00:00.000Z",
        prUrl: "https://github.com/M1Vj/test-repo/pull/98",
      },
    ]
  );

  assert.ok(populatedMd.includes("M1Vj/test-repo#99"));
  assert.ok(populatedMd.includes("judge-deadlock"));
  assert.ok(populatedMd.includes("gh pr merge 99 --repo M1Vj/test-repo --merge"));
  assert.ok(populatedMd.includes("Resolved item"));
});

test("reconcileHumanReviewQueue handles empty active queue cleanly", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "hr-reconcile-"));
  const reconciled = await reconcileHumanReviewQueue(root, {});
  assert.equal(reconciled, 0);
});
