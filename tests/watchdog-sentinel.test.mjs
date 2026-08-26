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
