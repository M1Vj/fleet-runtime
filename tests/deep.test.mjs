import test from "node:test";
import assert from "node:assert/strict";

import {
  CLAIM_MAX_ATTEMPTS,
  applyArtifactToQueue,
  claimTask,
  parseFindingsWithRepair,
  reportArtifactName,
  isValidArtifactIdentity,
  isValidArtifactDocument,
} from "../scripts/deep.mjs";

test("invalid deep output resumes the same session until strict JSON succeeds", async () => {
  const calls = [];
  const result = await parseFindingsWithRepair(
    { complete: true, reply: "not json", sessionId: "ses_original", modelMode: "muse" },
    async (sessionId, round) => {
      calls.push({ sessionId, round });
      return {
        complete: true,
        reply: '{"findings":[],"verdict":"verified"}',
        sessionId: "ses_original",
        modelMode: "muse",
      };
    },
  );
  assert.deepEqual(calls, [{ sessionId: "ses_original", round: 1 }]);
  assert.equal(result.verdict, "verified");
  assert.equal(result.sessionId, "ses_original");
});

test("unrepairable output is rejected after three bounded resume rounds", async () => {
  let rounds = 0;
  await assert.rejects(
    () => parseFindingsWithRepair(
      { complete: true, reply: "bad", sessionId: "ses_original", modelMode: "muse" },
      async (sessionId, round) => {
        assert.equal(sessionId, "ses_original");
        rounds = round;
        return { complete: true, reply: "still bad", sessionId, modelMode: "muse" };
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
  const queue = [{ repo: "M1Vj/a", kind: "code-review", status: "pending", attempts: 0 }];
  assert.equal(
    applyArtifactToQueue(queue, { repo: "M1Vj/a", kind: "code-review", findings: [], verdict: "ok", exitCode: 0 }, "2026-09-12T09:00:00Z"),
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
      { complete: true, reply: '{"findings":[{"severity":"high","title":"x"}],"verdict":"bad"}', sessionId: "ses_original", modelMode: "muse" },
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
  assert.equal(isValidArtifactIdentity("M1Vj/fleet-control", "security-audit"), true);
  assert.equal(isValidArtifactIdentity("../../outside", "code-review"), false);
  assert.equal(isValidArtifactIdentity("M1Vj/fleet-control/extra", "code-review"), false);
  assert.equal(isValidArtifactIdentity("M1Vj/fleet-control", "../reports"), false);
  assert.equal(isValidArtifactIdentity("../evil", "code-review"), false);
  assert.equal(isValidArtifactIdentity("M1Vj/..", "code-review"), false);
});

test("artifact documents reject malformed findings before publication", () => {
  const base = {
    repo: "M1Vj/fleet-control",
    kind: "code-review",
    findings: [],
    verdict: "verified",
    modelMode: "opencode/muse-spark-1.3-contributor-free@xhigh",
    exitCode: 0,
    finishedUtc: new Date().toISOString(),
  };
  assert.equal(isValidArtifactDocument(base), true);
  assert.equal(isValidArtifactDocument({ ...base, findings: [{ severity: "high" }] }), false);
  assert.equal(isValidArtifactDocument({ ...base, findings: [{ severity: "urgent", title: "x", detail: "y", recommendation: "z" }] }), false);
  assert.equal(isValidArtifactDocument({ ...base, exitCode: "6" }), false);
  assert.equal(isValidArtifactDocument({ ...base, verdict: "" }), false);
  assert.equal(isValidArtifactDocument({ ...base, finishedUtc: "2020-01-01T00:00:00Z" }), false);
});
