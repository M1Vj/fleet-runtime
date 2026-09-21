import test from "node:test";
import assert from "node:assert/strict";

import {
  CLAIM_MAX_ATTEMPTS,
  DEFAULT_MAX_WORKERS,
  MAX_WORKERS,
  applyArtifactToQueue,
  applyPlannedArtifacts,
  buildContext,
  claimTask,
  planTasks,
  parseFindingsWithRepair,
  reportArtifactName,
  sanitizeMaxWorkers,
  isValidArtifactIdentity,
  isValidArtifactDocument,
} from "../scripts/deep.mjs";

const SOURCE_PROOF = {
  sourceRevision: "0123456789abcdef0123456789abcdef01234567",
  treeSnapshot: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  evidence: {
    inspectedScope: "checked-out repository source and tests for the claimed audit kind",
    noFindingsRationale: "No actionable findings were identified after inspecting the recorded scope.",
  },
  checks: { sourceRevision: true, treeSnapshot: true, evidence: true, noFindingsVerified: true },
};

function successfulArtifact(overrides = {}) {
  return {
    taskId: "task-1",
    claimRunId: "run-1",
    claimAttempt: 1,
    repo: "M1Vj/a",
    kind: "code-review",
    findings: [],
    verdict: "No actionable findings were identified after inspecting the recorded scope.",
    modelMode: "muse",
    finishedUtc: new Date().toISOString(),
    exitCode: 0,
    ...SOURCE_PROOF,
    ...overrides,
  };
}

test("missing README falls back to bounded repository metadata, tree, and manifests", () => {
  const calls = [];
  const context = buildContext("M1Vj/no-readme", {
    fetch: (args) => {
      calls.push(args);
      const endpoint = args.at(-1);
      if (endpoint === "/repos/M1Vj/no-readme") return { default_branch: "main", description: "fixture repository", language: "JavaScript" };
      if (endpoint.endsWith("/readme")) throw new Error("404 README not found");
      if (endpoint.includes("/git/trees/")) return { tree: [{ type: "blob", path: "src/index.js" }, { type: "blob", path: "package.json" }] };
      if (endpoint.includes("/contents/package.json")) return { content: Buffer.from('{"scripts":{"test":"node --test"}}').toString("base64") };
      if (endpoint.includes("/commits?")) return [];
      if (endpoint.includes("/pulls?")) return [];
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  });
  assert.match(context, /README unavailable/);
  assert.match(context, /src\/index\.js/);
  assert.match(context, /package\.json/);
  assert.match(context, /node --test/);
  assert.equal(calls.some((args) => String(args.at(-1)).endsWith("/readme")), true);
});

test("invalid deep output resumes the same session until strict JSON succeeds", async () => {
  const calls = [];
  const result = await parseFindingsWithRepair(
    { complete: true, reply: "not json", sessionId: "ses_original", sessionIdReturned: true, modelMode: "muse" },
    async (sessionId, round) => {
      calls.push({ sessionId, round });
      return {
        complete: true,
        reply: '{"findings":[],"verdict":"verified","evidence":{"inspectedScope":"checked-out repository source and tests","noFindingsRationale":"No actionable findings were identified after inspecting the recorded scope."}}',
        sessionId: "ses_original",
        sessionIdReturned: true,
        modelMode: "muse",
      };
    },
  );
  assert.deepEqual(calls, [{ sessionId: "ses_original", round: 1 }]);
  assert.equal(result.verdict, "verified");
  assert.equal(result.sessionId, "ses_original");
});

test("deep repair refuses a caller-only session without provider attestation", async () => {
  let calls = 0;
  await assert.rejects(
    () => parseFindingsWithRepair(
      { complete: true, reply: "not json", sessionId: "ses_caller_only", sessionIdReturned: false, modelMode: "muse" },
      async () => { calls += 1; return {}; },
    ),
    (error) => error.code === 5 && error.sessionId === "ses_caller_only",
  );
  assert.equal(calls, 0);
});

test("deep repair rejects a provider response that omits session evidence", async () => {
  let calls = 0;
  await assert.rejects(
    () => parseFindingsWithRepair(
      { complete: true, reply: "not json", sessionId: "ses_original", sessionIdReturned: true, modelMode: "muse" },
      async () => {
        calls += 1;
        return {
          complete: true,
          reply: '{"findings":[],"verdict":"verified","evidence":{"inspectedScope":"checked-out repository source and tests","noFindingsRationale":"No actionable findings were identified after inspecting the recorded scope."}}',
          sessionId: "ses_original",
          modelMode: "muse",
        };
      },
    ),
    (error) => error.code === 5 && error.sessionId === "ses_original",
  );
  assert.equal(calls, 1);
});

test("deep repair rejects a provider response that changes session identity", async () => {
  let calls = 0;
  await assert.rejects(
    () => parseFindingsWithRepair(
      { complete: true, reply: "not json", sessionId: "ses_original", sessionIdReturned: true, modelMode: "muse" },
      async () => {
        calls += 1;
        return {
          complete: true,
          reply: '{"findings":[],"verdict":"verified","evidence":{"inspectedScope":"checked-out repository source and tests","noFindingsRationale":"No actionable findings were identified after inspecting the recorded scope."}}',
          sessionId: "ses_changed",
          sessionIdReturned: true,
          modelMode: "muse",
        };
      },
    ),
    (error) => error.code === 5 && error.sessionId === "ses_original",
  );
  assert.equal(calls, 1);
});

test("unrepairable output is rejected after three bounded resume rounds", async () => {
  let rounds = 0;
  await assert.rejects(
    () => parseFindingsWithRepair(
      { complete: true, reply: "bad", sessionId: "ses_original", sessionIdReturned: true, modelMode: "muse" },
      async (sessionId, round) => {
        assert.equal(sessionId, "ses_original");
        rounds = round;
        return { complete: true, reply: "still bad", sessionId, sessionIdReturned: true, modelMode: "muse" };
      },
    ),
    (error) => error.code === 5 && error.sessionId === "ses_original",
  );
  assert.equal(rounds, 3);
});

test("failed artifacts remain retryable then become blocked at the attempt cap", () => {
  const queue = [{ repo: "M1Vj/a", kind: "code-review", status: "pending", attempts: 1 }];
  const artifact = { repo: "M1Vj/a", kind: "code-review", exitCode: 5 };
  assert.equal(applyArtifactToQueue(queue, artifact, "2026-09-12T09:00:00Z"), "retry");
  assert.equal(queue[0].attempts, 2);
  assert.equal(queue[0].status, "pending");
  assert.equal(applyArtifactToQueue(queue, artifact, "2026-09-12T09:01:00Z"), "blocked");
  assert.equal(queue[0].attempts, CLAIM_MAX_ATTEMPTS);
  assert.equal(queue[0].status, "blocked");
});

test("provider outage stays pending without consuming a validation attempt", () => {
  const queue = [{ repo: "M1Vj/a", kind: "docs-audit", status: "pending", attempts: 2 }];
  assert.equal(
    applyArtifactToQueue(queue, { repo: "M1Vj/a", kind: "docs-audit", exitCode: 6 }),
    "retry",
  );
  assert.equal(queue[0].attempts, 2);
  assert.equal(queue[0].status, "pending");
});

test("successful artifacts complete one task and artifact names cannot collide by kind", () => {
  const queue = [{ id: "task-1", repo: "M1Vj/a", kind: "code-review", status: "in_progress", attempts: 1, claimRunId: "run-1", claimAttempt: 1 }];
  assert.equal(
    applyArtifactToQueue(queue, successfulArtifact(), "2026-09-12T09:00:00Z"),
    "done",
  );
  assert.equal(queue[0].status, "done");
  assert.notEqual(
    reportArtifactName("M1Vj/a", "code-review"),
    reportArtifactName("M1Vj/a", "docs-audit"),
  );
});

test("claimTask never reclaims a pending task already at the attempt cap", () => {
  const queue = [{ repo: "M1Vj/a", kind: "code-review", status: "pending", attempts: CLAIM_MAX_ATTEMPTS }];
  assert.equal(claimTask(queue), null);
  assert.equal(queue[0].status, "blocked");
});

test("strict findings validation rejects malformed finding entries", async () => {
  await assert.rejects(
    () => parseFindingsWithRepair(
      { complete: true, reply: '{"findings":[{"severity":"high","title":"x"}],"verdict":"bad"}', sessionId: "ses_original", sessionIdReturned: true, modelMode: "muse" },
      async () => ({ complete: true, reply: "still invalid", sessionId: "ses_original", modelMode: "muse" }),
      0,
    ),
    (error) => error.code === 5 && error.sessionId === "ses_original",
  );
});

test("artifacts for no-longer-queued work are ignored", () => {
  const queue = [{ repo: "M1Vj/a", kind: "code-review", status: "done", attempts: 1 }];
  assert.equal(applyArtifactToQueue(queue, { repo: "M1Vj/a", kind: "code-review" }), "unmatched");
});

test("artifact identities stay within the GitHub repo and audit-kind shape", () => {
  assert.equal(isValidArtifactIdentity("M1Vj/fleet-fixture", "security-audit"), true);
  assert.equal(isValidArtifactIdentity("../../outside", "code-review"), false);
  assert.equal(isValidArtifactIdentity("M1Vj/fleet-fixture/extra", "code-review"), false);
  assert.equal(isValidArtifactIdentity("M1Vj/fleet-fixture", "../reports"), false);
  assert.equal(isValidArtifactIdentity("../evil", "code-review"), false);
  assert.equal(isValidArtifactIdentity("M1Vj/..", "code-review"), false);
});

test("artifact documents reject malformed findings before publication", () => {
  const base = {
    taskId: "task-1",
    claimRunId: "run-1",
    claimAttempt: 1,
    repo: "M1Vj/fleet-fixture",
    kind: "code-review",
    findings: [],
    verdict: "No actionable findings were identified after inspecting the recorded scope.",
    modelMode: "opencode/muse-spark-1.3-contributor-free@xhigh",
    exitCode: 0,
    finishedUtc: new Date().toISOString(),
    sourceRevision: SOURCE_PROOF.sourceRevision,
    treeSnapshot: SOURCE_PROOF.treeSnapshot,
    evidence: SOURCE_PROOF.evidence,
    checks: SOURCE_PROOF.checks,
  };
  assert.equal(isValidArtifactDocument(base), true);
  assert.equal(isValidArtifactDocument({ ...base, findings: [{ severity: "high" }] }), false);
  assert.equal(isValidArtifactDocument({ ...base, findings: [{ severity: "urgent", title: "x", detail: "y", recommendation: "z" }] }), false);
  assert.equal(isValidArtifactDocument({ ...base, exitCode: "6" }), false);
  assert.equal(isValidArtifactDocument({ ...base, verdict: "" }), false);
  assert.equal(isValidArtifactDocument({ ...base, finishedUtc: "2020-01-01T00:00:00Z" }), false);
});

test("successful artifacts require exact claim and source/evidence receipts", () => {
  const queue = [{ id: "task-1", repo: "M1Vj/a", kind: "code-review", status: "in_progress", attempts: 1, claimRunId: "run-1", claimAttempt: 1 }];
  const missingProof = { ...successfulArtifact(), sourceRevision: undefined, treeSnapshot: undefined, evidence: undefined, checks: undefined };
  assert.equal(isValidArtifactDocument(missingProof), false);
  assert.equal(applyArtifactToQueue(queue, missingProof), "invalid");
  assert.equal(queue[0].status, "in_progress");
  assert.equal(applyArtifactToQueue(queue, successfulArtifact({ taskId: "other-task" })), "invalid");
  assert.equal(queue[0].status, "in_progress");
  assert.equal(applyArtifactToQueue(queue, successfulArtifact({ claimRunId: "other-run" })), "invalid");
  assert.equal(queue[0].status, "in_progress");
});

test("empty findings require explicit inspected scope and verified no-findings rationale", () => {
  const base = successfulArtifact();
  assert.equal(isValidArtifactDocument({ ...base, evidence: { inspectedScope: "source" }, checks: { sourceRevision: true, treeSnapshot: true, evidence: true } }), false);
  assert.equal(isValidArtifactDocument({ ...base, checks: { sourceRevision: true, treeSnapshot: true, evidence: true, noFindingsVerified: false } }), false);
  assert.equal(isValidArtifactDocument(base), true);
});

test("worker limits default safely and clamp strict numeric input to the hard cap", () => {
  assert.equal(DEFAULT_MAX_WORKERS, 6);
  assert.equal(MAX_WORKERS, 15);
  assert.equal(sanitizeMaxWorkers(undefined), DEFAULT_MAX_WORKERS);
  assert.equal(sanitizeMaxWorkers(""), DEFAULT_MAX_WORKERS);
  assert.equal(sanitizeMaxWorkers("0"), DEFAULT_MAX_WORKERS);
  assert.equal(sanitizeMaxWorkers(" 9 "), 9);
  assert.equal(sanitizeMaxWorkers("99"), MAX_WORKERS);
  assert.equal(sanitizeMaxWorkers("999999999999999999999999"), MAX_WORKERS);
  assert.equal(sanitizeMaxWorkers("3x"), DEFAULT_MAX_WORKERS);
});

test("planning claims stale work, blocks exhausted work, and never picks duplicate repo-kind tasks", () => {
  const now = Date.parse("2026-09-13T00:00:00.000Z");
  const stale = new Date(now - 41 * 60 * 1000).toISOString();
  const queue = [
    { id: "pending-1", repo: "M1Vj/a", kind: "code-review", status: "pending", attempts: 0 },
    { id: "pending-duplicate", repo: "M1Vj/a", kind: "code-review", status: "pending", attempts: 0 },
    { id: "stale-1", repo: "M1Vj/b", kind: "docs-audit", status: "in_progress", attempts: 1, updatedUtc: stale },
    { id: "exhausted", repo: "M1Vj/c", kind: "redteam", status: "pending", attempts: CLAIM_MAX_ATTEMPTS },
  ];

  const plan = planTasks(queue, 15, { now, runId: "deep-run-1" });

  assert.deepEqual(plan.worker.map((task) => task.id), ["stale-1", "pending-1"]);
  assert.equal(new Set(plan.worker.map((task) => `${task.repo}|${task.kind}`)).size, plan.worker.length);
  assert.equal(plan.worker.every((task) => task.status === "in_progress" && task.claimRunId === "deep-run-1"), true);
  assert.equal(queue.find((task) => task.id === "stale-1").attempts, 2);
  assert.equal(queue.find((task) => task.id === "exhausted").status, "blocked");
});

test("a second plan does not pick tasks already claimed by the first run", () => {
  const now = Date.parse("2026-09-13T00:00:00.000Z");
  const queue = [
    { id: "one", repo: "M1Vj/a", kind: "code-review", status: "pending", attempts: 0 },
    { id: "two", repo: "M1Vj/b", kind: "docs-audit", status: "pending", attempts: 0 },
  ];

  const first = planTasks(queue, 1, { now, runId: "deep-run-1" });
  const second = planTasks(queue, 1, { now: now + 1, runId: "deep-run-2" });

  assert.deepEqual(first.worker.map((task) => task.id), ["one"]);
  assert.deepEqual(second.worker.map((task) => task.id), ["two"]);
  assert.equal(queue.find((task) => task.id === "one").claimRunId, "deep-run-1");
  assert.equal(queue.find((task) => task.id === "two").claimRunId, "deep-run-2");
});

test("successful sibling artifacts apply even when another selected task fails or is missing", () => {
  const now = Date.parse("2026-09-13T00:00:00.000Z");
  const initialQueue = [
    { id: "one", repo: "M1Vj/a", kind: "code-review", status: "pending", attempts: 0 },
    { id: "two", repo: "M1Vj/b", kind: "docs-audit", status: "pending", attempts: 0 },
  ];
  const planningQueue = structuredClone(initialQueue);
  const plan = planTasks(planningQueue, 2, { now, runId: "deep-run-1" });
  const queue = structuredClone(initialQueue);
  const summary = applyPlannedArtifacts(queue, plan, [
    successfulArtifact({
      taskId: "one",
      claimRunId: "deep-run-1",
      repo: "M1Vj/a",
      kind: "code-review",
      finishedUtc: new Date().toISOString(),
    }),
    {
      taskId: "two",
      repo: "M1Vj/b",
      kind: "docs-audit",
      claimRunId: "deep-run-1",
      claimAttempt: 1,
      findings: [],
      verdict: "deferred",
      modelMode: "output-rejected",
      finishedUtc: new Date(now).toISOString(),
      exitCode: 5,
    },
  ], { now, updatedUtc: new Date(now).toISOString() });

  assert.equal(queue.find((task) => task.id === "one").status, "done");
  assert.equal(queue.find((task) => task.id === "two").status, "pending");
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.retryable, 1);
  assert.equal(summary.missing, 0);
});

test("missing selected artifacts stay retryable while completed siblings remain done", () => {
  const now = Date.parse("2026-09-13T00:00:00.000Z");
  const initialQueue = [
    { id: "one", repo: "M1Vj/a", kind: "code-review", status: "pending", attempts: 0 },
    { id: "two", repo: "M1Vj/b", kind: "docs-audit", status: "pending", attempts: 0 },
  ];
  const plan = planTasks(structuredClone(initialQueue), 2, { now, runId: "deep-run-1" });
  const queue = structuredClone(initialQueue);
  const summary = applyPlannedArtifacts(queue, plan, [
    successfulArtifact({
      taskId: "one",
      claimRunId: "deep-run-1",
      repo: "M1Vj/a",
      kind: "code-review",
      finishedUtc: new Date().toISOString(),
    }),
  ], { now, updatedUtc: new Date(now).toISOString() });

  assert.equal(queue.find((task) => task.id === "one").status, "done");
  assert.equal(queue.find((task) => task.id === "two").status, "pending");
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.retryable, 1);
  assert.equal(summary.missing, 1);
});
