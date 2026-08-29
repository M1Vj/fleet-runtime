import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readTelemetryEvents } from "../scripts/lib/telemetry.mjs";
import {
  buildJudgeProgressTelemetry,
  compareJudgeProgress,
} from "../scripts/lib/revision-progress.mjs";
import {
  buildWorkflowTelemetry,
  completeDispatch,
  consumeDispatch,
  dispatchTarget,
  recordJudgeProgressTelemetry,
} from "../scripts/merge.mjs";
import {
  appendPromotionEvent,
} from "../scripts/lib/promotion-state.mjs";
import {
  buildSelfHealTelemetry,
  planSentinelActions,
  planWatchdogActions,
} from "../scripts/lib/watchdog-decide.mjs";
import { emitWatchdogTelemetry } from "../scripts/watchdog.mjs";
import { main as sentinelMain } from "../scripts/sentinel.mjs";

const head = "a".repeat(40);
const candidateDigest = `sha256:${"b".repeat(64)}`;
const rollbackDigest = `sha256:${"c".repeat(64)}`;

function tempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function target(overrides = {}) {
  return { repo: "M1Vj/example-repo", pr: 42, headSha: head, ...overrides };
}

test("promotion lifecycle telemetry mirrors canary pass and rollback failure without payload text", () => {
  const root = tempRoot("fleet-promotion-telemetry-");
  try {
    appendPromotionEvent(root, {
      runId: "promotion-run",
      state: "ACTIVATION_CANARY_PASSED",
      capabilityId: "safe-transform",
      capabilityKind: "declarative-v1",
      candidateDigest,
      rollbackDigest,
      registryPath: "config/tools.json",
      disposition: "auto-activate",
      canaryId: "synthetic-canary",
      health: { status: "passed", digest: candidateDigest },
      summary: "bounded canary",
    });
    appendPromotionEvent(root, {
      runId: "promotion-run",
      state: "ROLLBACK_FAILED",
      capabilityId: "safe-transform",
      capabilityKind: "declarative-v1",
      candidateDigest,
      rollbackDigest,
      registryPath: "config/tools.json",
      disposition: "auto-rollback",
      health: { status: "failed", digest: candidateDigest },
      summary: "rollback failure",
    });
    const events = readTelemetryEvents(root).filter((event) => event.event === "promotion");
    assert.equal(events.length, 2);
    assert.equal(events[0].promotion.operation, "activate");
    assert.equal(events[0].promotion.phase, "canary");
    assert.equal(events[0].promotion.canaryStatus, "passed");
    assert.equal(events[0].promotion.disposition, "accepted");
    assert.equal(events[1].promotion.operation, "rollback");
    assert.equal(events[1].promotion.phase, "rollback");
    assert.equal(events[1].outcome, "failed");
    assert.equal(events[1].promotion.canaryStatus, "failed");
    assert.equal(events[0].correlationId, events[1].correlationId);
    assert.equal(events[0].summary, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("judge telemetry records score and blocker progress, then a correlated no-progress hold", () => {
  const previous = {
    headSha: head,
    judgeScores: { correctness: 70, standards: 82 },
    blockerIds: ["blocker-1111111111111111", "blocker-2222222222222222"],
  };
  const current = {
    headSha: "d".repeat(40),
    judgeScores: { correctness: 75, standards: 78 },
    blockerIds: ["blocker-2222222222222222"],
  };
  const progress = buildJudgeProgressTelemetry({
    runId: "merge-run",
    target: target({ headSha: current.headSha }),
    previous,
    current,
  });
  assert.equal(progress.event, "judge");
  assert.equal(progress.phase, "progress");
  assert.equal(progress.outcome, "succeeded");
  assert.equal(progress.judge.progress, "improved");
  assert.equal(progress.judge.score, 75);
  assert.equal(progress.judge.previousScore, 70);
  assert.equal(progress.judge.scoreDelta, 5);
  assert.equal(progress.judge.blockerCount, 1);
  assert.equal(progress.judge.previousBlockerCount, 2);

  const hold = buildJudgeProgressTelemetry({
    runId: "merge-run",
    target: target({ headSha: current.headSha }),
    previous: current,
    current,
    hold: true,
  });
  assert.equal(hold.phase, "hold");
  assert.equal(hold.outcome, "held");
  assert.equal(hold.judge.progress, "repeat");
  assert.deepEqual(hold.terminal, { state: "NO_PROGRESS" });
  assert.equal(progress.correlationId, hold.correlationId);
});

test("merge judge decision branch writes progress and no-progress hold events", () => {
  const root = tempRoot("fleet-judge-runtime-telemetry-");
  try {
    const previous = {
      headSha: head,
      judgeScores: { correctness: 70, standards: 82 },
      blockerIds: ["blocker-1111111111111111"],
    };
    const current = {
      state: "JUDGE_REJECTED",
      headSha: "d".repeat(40),
      judgeScores: { correctness: 70, standards: 82 },
      blockerIds: ["blocker-1111111111111111"],
      verdict: "reject",
    };
    const decision = compareJudgeProgress(previous, current);
    assert.equal(decision.exactRepeat, true);
    recordJudgeProgressTelemetry({ stateRoot: root, runId: "merge-runtime", target: target({ headSha: current.headSha }), previous, current });
    if (!decision.progress) {
      recordJudgeProgressTelemetry({ stateRoot: root, runId: "merge-runtime", target: target({ headSha: current.headSha }), previous, current, hold: true });
    }
    const events = readTelemetryEvents(root).filter((event) => event.event === "judge");
    assert.deepEqual(events.map((event) => event.phase), ["progress", "hold"]);
    assert.equal(events.at(-1).outcome, "held");
    assert.deepEqual(events.at(-1).terminal, { state: "NO_PROGRESS" });
    assert.equal(events[0].correlationId, events[1].correlationId);
    assert.equal(events[1].judge.blockerCount, 1);
    assert.equal(events[1].judge.previousBlockerCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow dispatch, consumption, and completion share one exact-target correlation", async () => {
  const root = tempRoot("fleet-workflow-telemetry-");
  try {
    const memory = [];
    const append = (_file, event) => {
      memory.push(event);
      return { event, appended: true };
    };
    const read = () => memory;
    const persist = () => "committed";
    const dispatched = await dispatchTarget(target(), {
      stateRoot: root,
      runId: "scan-run",
      append,
      read,
      persist,
      dispatch: async () => ({ workflow_run_id: 123 }),
    });
    const keyRef = dispatched.event.artifactRefs.find((value) => value.startsWith("dispatch-key:"));
    const dispatchKey = keyRef.slice("dispatch-key:".length);
    await consumeDispatch(target(), dispatchKey, { stateRoot: root, runId: "gate-run", append, read, persist });
    completeDispatch(target(), dispatchKey, "NO_PROGRESS", { stateRoot: root, runId: "gate-run", append, read, persist });

    const events = readTelemetryEvents(root).filter((event) => event.event === "workflow");
    assert.equal(events.length, 4);
    assert.ok(events.every((event) => event.repo === "M1Vj/example-repo" && event.pr === 42 && event.headSha === head));
    assert.equal(new Set(events.map((event) => event.correlationId)).size, 1);
    assert.deepEqual(events.map((event) => event.phase), ["dispatch", "dispatch", "start", "outcome"]);
    assert.equal(events.at(-1).outcome, "held");
    assert.equal(events.at(-1).workflow.conclusion, "skipped");

    const explicit = buildWorkflowTelemetry({ target: target(), dispatchKey, runId: "gate-run", state: "DISPATCH_RELEASED" });
    assert.equal(explicit.correlationId, events[0].correlationId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watchdog and sentinel self-heal plans emit bounded decision and outcome fields", () => {
  const stale = planWatchdogActions(
    { lastRunUtc: "2026-08-29T00:00:00.000Z" },
    Date.parse("2026-08-29T02:00:00.000Z"),
    60 * 60 * 1000,
    { autoEnable: true },
  );
  const planned = buildSelfHealTelemetry({ runId: "watchdog-run", lane: "watchdog", plan: stale, repo: "M1Vj/fleet-runtime" });
  const dispatched = buildSelfHealTelemetry({ runId: "watchdog-run", lane: "watchdog", plan: stale, repo: "M1Vj/fleet-runtime", action: "workflow_enable", outcome: "dispatched" });
  assert.equal(planned.event, "selfheal");
  assert.equal(planned.selfHeal.action, "workflow_enable");
  assert.equal(planned.selfHeal.reasonCode, "stale");
  assert.equal(planned.selfHeal.outcome, "planned");
  assert.equal(dispatched.outcome, "succeeded");
  assert.equal(dispatched.selfHeal.outcome, "dispatched");
  assert.equal(planned.correlationId, dispatched.correlationId);

  const held = planSentinelActions({
    lastRunUtc: "2026-08-29T00:00:00.000Z",
    nowMs: Date.parse("2026-08-29T02:00:00.000Z"),
    thresholdMs: 60 * 60 * 1000,
    autoEnable: "false",
    killSwitchPresent: false,
  });
  const heldTelemetry = buildSelfHealTelemetry({ runId: "sentinel-run", lane: "sentinel", plan: held, repo: "M1Vj/fleet-runtime" });
  assert.equal(heldTelemetry.phase, "hold");
  assert.equal(heldTelemetry.outcome, "held");
  assert.equal(heldTelemetry.selfHeal.reasonCode, "auto_enable_off");
  assert.equal(heldTelemetry.selfHeal.outcome, "held");
});

test("watchdog runtime decision writes planned and dispatched self-heal events", () => {
  const root = tempRoot("fleet-watchdog-runtime-telemetry-");
  try {
    const plan = planWatchdogActions(
      { lastRunUtc: "2026-08-29T00:00:00.000Z" },
      Date.parse("2026-08-29T02:00:00.000Z"),
      60 * 60 * 1000,
      { autoEnable: true },
    );
    emitWatchdogTelemetry({ stateRoot: root, runId: "watchdog-runtime", plan, outcome: "planned" });
    emitWatchdogTelemetry({ stateRoot: root, runId: "watchdog-runtime", plan, action: "workflow_enable", outcome: "dispatched" });
    const events = readTelemetryEvents(root).filter((event) => event.event === "selfheal");
    assert.deepEqual(events.map((event) => event.selfHeal.outcome), ["planned", "dispatched"]);
    assert.deepEqual(events.map((event) => event.phase), ["start", "dispatch"]);
    assert.equal(events[0].lane, "watchdog");
    assert.equal(events[0].correlationId, events[1].correlationId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sentinel main stale-enable branch writes planned and dispatched events", async () => {
  const root = tempRoot("fleet-sentinel-runtime-telemetry-");
  try {
    const env = {
      FLEET_STATE_ROOT: root,
      FLEET_RUN_ID: "sentinel-runtime",
      FLEET_SENTINEL_TARGET: "M1Vj/fleet-runtime",
      FLEET_WATCHDOG_AUTO_ENABLE: "true",
    };
    const calls = [];
    const code = await sentinelMain(env, {
      gateFn: async () => ({ login: "M1Vj" }),
      nowMs: Date.parse("2026-08-29T02:00:00.000Z"),
      ghFn: (args) => {
        calls.push(args);
        const command = String(args.join(" "));
        if (command.includes("actions/workflows/watchdog.yml/runs")) {
          return { workflow_runs: [{ created_at: "2026-08-29T00:00:00.000Z" }] };
        }
        if (command.includes("contents/state/KILL_SWITCH")) {
          const error = new Error("404");
          throw error;
        }
        return {};
      },
    });
    assert.equal(code, 0);
    assert.equal(calls.filter((args) => String(args.join(" ")).includes("/enable")).length, 2);
    const events = readTelemetryEvents(root).filter((event) => event.event === "selfheal");
    assert.deepEqual(events.map((event) => event.selfHeal.outcome), ["planned", "dispatched"]);
    assert.deepEqual(events.map((event) => event.phase), ["start", "dispatch"]);
    assert.ok(events.every((event) => event.lane === "sentinel"));
    assert.equal(events[0].correlationId, events[1].correlationId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
