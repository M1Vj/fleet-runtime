import { test } from "node:test";
import assert from "node:assert/strict";

test("sentinel planner revives exactly watchdog+merge on a stale enabled target", async () => {
  const { planSentinelActions } = await import("../scripts/lib/watchdog-decide.mjs");
  const now = Date.parse("2026-08-26T02:00:00.000Z");
  const staleStamp = "2026-08-26T00:30:00.000Z";
  const freshStamp = "2026-08-26T01:45:00.000Z";
  const plan = planSentinelActions({ lastRunUtc: staleStamp, nowMs: now, thresholdMs: 60 * 60 * 1000, autoEnable: "true", killSwitchPresent: false });
  assert.equal(plan.stale, true);
  assert.deepEqual(plan.actions, [
    { kind: "enable-workflow", repo: "M1Vj/fleet-runtime", workflow: "watchdog.yml" },
    { kind: "enable-workflow", repo: "M1Vj/fleet-runtime", workflow: "merge.yml" },
  ]);
  assert.deepEqual(
    planSentinelActions({ lastRunUtc: freshStamp, nowMs: now, thresholdMs: 60 * 60 * 1000, autoEnable: "true", killSwitchPresent: false }).actions,
    [],
  );
});

test("sentinel planner fails closed on kill switch, opt-in off, and malformed input", async () => {
  const { planSentinelActions } = await import("../scripts/lib/watchdog-decide.mjs");
  const stale = { lastRunUtc: "2026-08-26T00:30:00.000Z", nowMs: Date.parse("2026-08-26T02:00:00.000Z"), thresholdMs: 3600000 };
  assert.equal(planSentinelActions({ ...stale, autoEnable: "true", killSwitchPresent: true }).reason, "kill-switch-present");
  assert.equal(planSentinelActions({ ...stale, autoEnable: "true", killSwitchPresent: true }).actions.length, 0);
  assert.equal(planSentinelActions({ ...stale, autoEnable: "false", killSwitchPresent: false }).actions.length, 0);
  assert.equal(planSentinelActions({ ...stale, autoEnable: undefined, killSwitchPresent: false }).actions.length, 0);
  const noRuns = planSentinelActions({ lastRunUtc: null, nowMs: Date.now(), thresholdMs: 3600000, autoEnable: "true", killSwitchPresent: false });
  assert.equal(noRuns.stale, true);
  assert.equal(noRuns.reason, "no-runs");
  assert.equal(noRuns.actions.length, 2);
});

test("watchdog requeues stale work instead of refreshing an in-progress lease forever", async () => {
  const { recoverStaleQueue } = await import("../scripts/lib/watchdog-decide.mjs");
  const nowMs = Date.parse("2026-08-28T02:00:00.000Z");
  const queue = [
    { id: "fresh", status: "in_progress", attempts: 1, updatedUtc: "2026-08-28T01:45:00.000Z" },
    { id: "retry", status: "in_progress", attempts: 2, updatedUtc: "2026-08-28T00:00:00.000Z" },
    { id: "exhausted", status: "in_progress", attempts: 3, updatedUtc: "2026-08-28T00:00:00.000Z" },
    { id: "done", status: "done", attempts: 1, updatedUtc: "2026-08-27T00:00:00.000Z" },
  ];
  const result = recoverStaleQueue(queue, { nowMs, staleMs: 40 * 60 * 1000, maxAttempts: 3 });
  assert.equal(result.changed, true);
  assert.deepEqual(result.requeued, ["retry"]);
  assert.deepEqual(result.exhausted, ["exhausted"]);
  assert.equal(result.queue[0].status, "in_progress");
  assert.equal(result.queue[1].status, "pending");
  assert.equal(result.queue[1].attempts, 2, "the next claimant, not the watchdog, owns attempt increments");
  assert.equal(result.queue[2].status, "failed");
  assert.equal(result.queue[2].failureReason, "stale-attempt-limit");
  assert.equal(result.queue[3].status, "done");
});

test("watchdog queue recovery is immutable and ignores malformed timestamps", async () => {
  const { recoverStaleQueue } = await import("../scripts/lib/watchdog-decide.mjs");
  const queue = [{ id: "bad", status: "in_progress", attempts: 1, updatedUtc: "not-a-date" }];
  const result = recoverStaleQueue(queue, { nowMs: Date.parse("2026-08-28T02:00:00.000Z") });
  assert.equal(result.changed, false);
  assert.notEqual(result.queue, queue);
  assert.deepEqual(result.queue, queue);
});

test("sentinel verifies the exact owner identity before any GitHub API access", async () => {
  const { main } = await import("../scripts/sentinel.mjs");
  const calls = [];
  const code = await main(
    { FLEET_SENTINEL_TARGET: "M1Vj/fleet-runtime", FLEET_WATCHDOG_AUTO_ENABLE: "true" },
    {
      gateFn: async () => ({ login: "M1Vj", scopes: ["repo", "workflow"] }),
      ghFn: (args) => {
        calls.push(args);
        if (String(args.join(" ")).includes("KILL_SWITCH")) throw new Error("404 Not Found");
        return { workflow_runs: [{ created_at: new Date().toISOString() }] };
      },
      nowMs: Date.now(),
    },
  );
  assert.equal(code, 0);
  assert.ok(calls.length >= 1);

  let apiCalled = false;
  await assert.rejects(
    () => main({}, {
      gateFn: async () => { throw new Error("IDENTITY_MISMATCH"); },
      ghFn: () => { apiCalled = true; },
    }),
    /IDENTITY_MISMATCH/,
  );
  assert.equal(apiCalled, false);
});
