import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compareJudgeProgress,
  planNoProgressResearch,
} from "../scripts/lib/revision-progress.mjs";
import {
  applyValidatedRevision,
  attemptRevisionMirror,
  dispatchFreshJudgeAfterRevision,
} from "../scripts/revise.mjs";
import {
  commentFingerprintMarker,
  hasPublicCommentFingerprint,
  listPublicComments,
  publicCommentFingerprint,
  withPublicCommentFingerprint,
} from "../scripts/lib/public-comment.mjs";

const target = { repo: "M1Vj/example-repo", pr: 42, headSha: "a".repeat(40) };

function judge(overrides = {}) {
  return {
    headSha: target.headSha,
    judgeScores: { correctness: 70, standards: 82, threshold: 80, targetChecksPassed: true },
    blockerIds: ["blocker-1111111111111111", "blocker-2222222222222222"],
    ...overrides,
  };
}

test("judge progress accepts a higher minimum even when one stochastic score falls", () => {
  const result = compareJudgeProgress(
    judge(),
    judge({ judgeScores: { correctness: 75, standards: 78, threshold: 80, targetChecksPassed: true } }),
  );
  assert.equal(result.progress, true);
  assert.equal(result.scoreImproved, true);
  assert.equal(result.previousMinimum, 70);
  assert.equal(result.currentMinimum, 75);
});

test("judge progress accepts blocker elimination when the blocker set shrinks", () => {
  const result = compareJudgeProgress(
    judge(),
    judge({ blockerIds: ["blocker-2222222222222222"] }),
  );
  assert.equal(result.progress, true);
  assert.equal(result.blockersImproved, true);
  assert.deepEqual(result.eliminatedBlockers, ["blocker-1111111111111111"]);
});

test("equal-count blocker replacement is not progress", () => {
  const result = compareJudgeProgress(
    judge(),
    judge({ blockerIds: ["blocker-2222222222222222", "blocker-3333333333333333"] }),
  );
  assert.equal(result.progress, false);
  assert.equal(result.blockersImproved, false);
  assert.deepEqual(result.eliminatedBlockers, ["blocker-1111111111111111"]);
  assert.deepEqual(result.addedBlockers, ["blocker-3333333333333333"]);
});

test("exact repeated or regressed score and blockers stops with no progress", () => {
  const same = compareJudgeProgress(judge(), judge());
  assert.equal(same.progress, false);
  assert.equal(same.exactRepeat, true);

  const regressed = compareJudgeProgress(
    judge(),
    judge({ judgeScores: { correctness: 65, standards: 78, threshold: 80, targetChecksPassed: true } }),
  );
  assert.equal(regressed.progress, false);
  assert.equal(regressed.regressed, true);
});

test("no-progress research planning is bounded and correlated to the exact head", () => {
  const result = planNoProgressResearch({
    events: [],
    target,
    previous: judge(),
    current: judge({ headSha: "b".repeat(40) }),
  });
  assert.equal(result.request, true);
  assert.match(result.event.correlationId, /^research-[a-f0-9]{32}$/);
  assert.equal(result.event.headSha, target.headSha);
  assert.ok(JSON.stringify(result).length < 4000);
});

test("public comment fingerprints are deterministic and suppress equivalent same-head mirrors", () => {
  const body = "controlled summary\n\nBlocker IDs: none";
  const fingerprint = publicCommentFingerprint({ kind: "judge", ...target, body });
  assert.match(fingerprint, /^comment-[a-f0-9]{64}$/);
  assert.equal(fingerprint, publicCommentFingerprint({ kind: "judge", ...target, body: " controlled summary\r\n\nBlocker IDs: none " }));
  const marked = withPublicCommentFingerprint(body, { kind: "judge", ...target, fingerprint });
  assert.match(marked, new RegExp(commentFingerprintMarker("judge", fingerprint).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")));
  assert.equal(hasPublicCommentFingerprint([{ body: marked, user: { login: "M1Vj" } }], { kind: "judge", ...target, body, fingerprint, authorLogin: "M1Vj" }), true);
  assert.equal(hasPublicCommentFingerprint([{ body: marked, user: { login: "other" } }], { kind: "judge", ...target, body, fingerprint, authorLogin: "M1Vj" }), false);
});

test("bounded comment pagination reaches page two and stops at a short page", async () => {
  const calls = [];
  const comments = await listPublicComments({
    repo: target.repo,
    pr: target.pr,
    listPage: (_repo, _pr, page, pageSize) => {
      calls.push({ page, pageSize });
      if (page === 1) return Array.from({ length: pageSize }, (_, index) => ({ id: index + 1 }));
      if (page === 2) return [{ id: 101 }];
      return [{ id: 999 }];
    },
  });
  assert.equal(comments.length, 101);
  assert.deepEqual(calls, [{ page: 1, pageSize: 100 }, { page: 2, pageSize: 100 }]);
});

test("matching fingerprint still requires the equivalent body", () => {
  const body = "controlled summary";
  const fingerprint = publicCommentFingerprint({ kind: "judge", ...target, body });
  const marked = withPublicCommentFingerprint("different summary", { kind: "judge", ...target, fingerprint });
  assert.equal(hasPublicCommentFingerprint([{ body: marked, user: { login: "M1Vj" } }], {
    kind: "judge",
    ...target,
    body,
    fingerprint,
    authorLogin: "M1Vj",
  }), false);
});

test("local adapter canary runs one changed-head revision and one fresh judge without looping", async () => {
  const oldHead = "a".repeat(40);
  const newHead = "b".repeat(40);
  const target = { repo: "M1Vj/example-repo", pr: 42, headSha: oldHead };
  const prior = judge({
    headSha: oldHead,
    judgeScores: { correctness: 70, standards: 82, threshold: 80, targetChecksPassed: true },
    blockerIds: ["blocker-1111111111111111", "blocker-2222222222222222"],
  });
  const current = judge({
    headSha: newHead,
    judgeScores: { correctness: 95, standards: 92, threshold: 80, targetChecksPassed: true },
    blockerIds: [],
  });
  let commits = 0;
  let dispatches = [];
  let mirrorPosts = 0;
  const applied = await applyValidatedRevision({
    files: [{ path: "src/app.js", content: "new" }],
    changedPaths: ["src/app.js"],
    existingPaths: ["src/app.js"],
    baseFiles: [{ path: "src/app.js", content: "old" }],
    apply: async () => {
      commits += 1;
      return { commitSha: newHead };
    },
  });
  assert.equal(applied.atomic.commitSha, newHead);

  const dispatched = await dispatchFreshJudgeAfterRevision({
    target,
    commitSha: applied.atomic.commitSha,
    runtime: { stateRoot: "/tmp/fleet-local-canary", env: { FLEET_RUN_ID: "canary" } },
    identity: { name: "M1Vj", noreply: "1+M1Vj@users.noreply.github.com" },
    audit: { note() {}, incident() {} },
    dispatch: async (nextTarget, options) => {
      dispatches.push({ nextTarget, options });
      return { event: { state: "DISPATCHED" } };
    },
  });
  const progress = compareJudgeProgress(prior, current);
  const currentApproved = current.judgeScores.correctness >= current.judgeScores.threshold
    && current.judgeScores.standards >= current.judgeScores.threshold
    && current.blockerIds.length === 0;
  assert.equal(commits, 1);
  assert.equal(dispatched.dispatched, true);
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0].nextTarget, { repo: target.repo, pr: target.pr, headSha: newHead });
  assert.equal(dispatches[0].options.allowMerge, false);
  assert.equal(progress.progress, true);
  assert.equal(currentApproved, true);

  const mirror = await attemptRevisionMirror({
    repo: target.repo,
    number: target.pr,
    headSha: newHead,
    body: "revision applied",
    post: async () => { mirrorPosts += 1; return { id: 1 }; },
    audit: { note() {}, incident() {} },
  });
  assert.equal(mirror.ok, true);
  assert.equal(mirrorPosts, 1);
  // The approved exact-head result terminates the local cycle; no second
  // revision dispatch or public mirror is attempted.
  assert.equal(dispatches.length, 1);
  assert.equal(mirrorPosts, 1);
});
