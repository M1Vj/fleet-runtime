import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WATCHDOG_WORKFLOWS, planWatchdogActions } from "../scripts/lib/watchdog-decide.mjs";

test("WATCHDOG_WORKFLOWS covers all 10 operational workflows in fleet-runtime", () => {
  const expected = [
    "patrol.yml",
    "selftest.yml",
    "deep.yml",
    "improve.yml",
    "thesis.yml",
    "kb.yml",
    "retro.yml",
    "merge.yml",
    "model-refresh.yml",
    "orchestrate.yml",
  ];
  assert.deepEqual([...WATCHDOG_WORKFLOWS].sort(), [...expected].sort());
  assert.equal(new Set(WATCHDOG_WORKFLOWS).size, WATCHDOG_WORKFLOWS.length);
});

test("planWatchdogActions plans recovery for all 10 operational workflows when stale", () => {
  const now = Date.now();
  const heartbeat = { lastRunUtc: new Date(now - 3 * 3600 * 1000).toISOString() };
  const plan = planWatchdogActions(heartbeat, now, 90 * 60 * 1000);
  assert.equal(plan.stale, true);
  const enableActions = plan.actions.filter((a) => a.kind === "enable-workflow");
  assert.equal(enableActions.length, 10);
  const enabledWfs = enableActions.map((a) => a.workflow).sort();
  assert.deepEqual(enabledWfs, [...WATCHDOG_WORKFLOWS].sort());
});

test("planWatchdogActions respects autoEnable=false and string 'false' and emits zero enable actions in fleet-runtime", () => {
  const now = Date.now();
  const heartbeat = { lastRunUtc: new Date(now - 3 * 3600 * 1000).toISOString() };
  for (const opt of [{ autoEnable: false }, { autoEnable: "false" }]) {
    const plan = planWatchdogActions(heartbeat, now, 90 * 60 * 1000, opt);
    assert.equal(plan.stale, true);
    assert.equal(plan.alertIssue, true);
    const enableActions = plan.actions.filter((a) => a.kind === "enable-workflow");
    assert.equal(enableActions.length, 0);
  }
});

test("watchdog-recipes.mjs exports all watchdog decision recipes, helpers, and sentinel definitions in fleet-runtime", async () => {
  const recipes = await import("../scripts/lib/watchdog-recipes.mjs");
  const decide = await import("../scripts/lib/watchdog-decide.mjs");
  assert.deepEqual(recipes.WATCHDOG_WORKFLOWS, decide.WATCHDOG_WORKFLOWS);
  assert.equal(typeof recipes.planWatchdogActions, "function");
  assert.equal(typeof recipes.watchdogAutoEnableEnabled, "function");
  assert.equal(typeof recipes.canonicalHeartbeatStamp, "function");
  assert.equal(typeof recipes.planSentinelActions, "function");
  assert.equal(typeof recipes.selectWatchdogAlertIssue, "function");
  assert.equal(typeof recipes.findWatchdogAlertIssue, "function");
  assert.deepEqual(recipes.SENTINEL_REVIVE_WORKFLOWS, ["watchdog.yml", "merge.yml"]);
  assert.equal(recipes.SENTINEL_TARGET_REPO, "M1Vj/fleet-runtime");
  assert.equal(recipes.watchdogAutoEnableEnabled("true"), true);
  assert.equal(recipes.watchdogAutoEnableEnabled(true), true);
  assert.equal(recipes.watchdogAutoEnableEnabled("false"), false);
  assert.equal(recipes.watchdogAutoEnableEnabled(undefined), false);
  assert.equal(recipes.canonicalHeartbeatStamp("not-a-date"), "unknown");
  assert.equal(recipes.canonicalHeartbeatStamp(null), "unknown");
  assert.equal(recipes.canonicalHeartbeatStamp("2026-09-17T05:00:00.000Z"), "2026-09-17T05:00:00.000Z");
});

test("scripts/watchdog.mjs exports queue and alert helpers and maintains correct scope", async () => {
  const watchdog = await import("../scripts/watchdog.mjs");
  assert.equal(typeof watchdog.refreshQueue, "function");
  assert.equal(typeof watchdog.parseQueue, "function");
  assert.equal(typeof watchdog.recentWatchdogAlert, "function");
  assert.equal(typeof watchdog.QUEUE_STALE_MS, "number");
  assert.equal(typeof watchdog.QUEUE_MAX_ATTEMPTS, "number");

  // Test parseQueue
  const parsed = watchdog.parseQueue('{"id":1}\ninvalid\n{"id":2}\n\n');
  assert.deepEqual(parsed, [{ id: 1 }, { id: 2 }]);

  // Test refreshQueue: young in_progress task is preserved
  const now = Date.now();
  const freshTask = { id: 1, status: "in_progress", updatedUtc: new Date(now - 1000).toISOString(), attempts: 1 };
  const staleTaskWithAttempts = { id: 2, status: "in_progress", updatedUtc: new Date(now - 50 * 60 * 1000).toISOString(), attempts: 1 };
  const staleTaskExhausted = { id: 3, status: "in_progress", updatedUtc: new Date(now - 50 * 60 * 1000).toISOString(), attempts: 3 };
  const result = watchdog.refreshQueue([freshTask, staleTaskWithAttempts, staleTaskExhausted], now);
  assert.equal(result.requeued, 1);
  assert.equal(result.stalled, 1);
  assert.equal(freshTask.status, "in_progress");
  assert.equal(staleTaskWithAttempts.status, "pending");
  assert.equal(staleTaskWithAttempts.attempts, 2);
  assert.equal(staleTaskExhausted.status, "stalled");

  // Test recentWatchdogAlert
  const issues = [
    { number: 10, title: "Unrelated issue", state: "open", created_at: new Date(now - 1000).toISOString() },
    { number: 11, title: "[WATCHDOG] patrol stale", state: "closed", created_at: new Date(now - 1000).toISOString() },
    { number: 12, title: "[WATCHDOG] patrol stale", state: "open", created_at: new Date(now - 10 * 3600 * 1000).toISOString() },
    { number: 13, title: "[WATCHDOG] patrol stale", state: "open", created_at: new Date(now - 30 * 60 * 1000).toISOString() },
  ];
  const found = watchdog.recentWatchdogAlert(issues, now);
  assert.equal(found?.number, 13);

  // Verify scripts/watchdog.mjs imports verifyIssueAuthor and verifyCommit
  const content = fs.readFileSync(path.resolve("scripts/watchdog.mjs"), "utf8");
  assert.match(content, /import\s*\{[^}]*verifyIssueAuthor[^}]*\}\s*from\s*["']\.\/lib\/verify\.mjs["']/);
  assert.match(content, /import\s*\{[^}]*verifyCommit[^}]*\}\s*from\s*["']\.\/lib\/verify\.mjs["']/);
  assert.match(content, /import\s*\{[^}]*planWatchdogActions[^}]*\}\s*from\s*["']\.\/lib\/watchdog-recipes\.mjs["']/);
});

test("opencode.json defines all 14 agent roles with strict permission bounds in fleet-runtime", () => {
  const opencodePath = path.resolve("opencode.json");
  const config = JSON.parse(fs.readFileSync(opencodePath, "utf8"));
  assert.ok(config.agent, "agent configuration exists");

  const expectedRoles = [
    "implementer",
    "code-simplifier",
    "refactorer",
    "test-engineer",
    "performance-engineer",
    "security-reviewer",
    "architect",
    "designer",
    "prompt-architect",
    "humanizer",
    "critic",
    "reviewer",
    "clerk",
    "researcher",
  ];

  for (const role of expectedRoles) {
    assert.ok(config.agent[role], `role ${role} must be defined in opencode.json`);
    assert.ok(Number.isInteger(config.agent[role].steps), `role ${role} must define integer step budget`);
    assert.ok(config.agent[role].steps >= 20, `role ${role} steps budget must be >= 20`);
  }

  const readOnlyRoles = ["critic", "reviewer", "clerk", "researcher"];
  for (const role of readOnlyRoles) {
    const perm = config.agent[role].permission;
    assert.equal(perm["*"], "deny", `read-only role ${role} must have * set to deny`);
    assert.equal(perm.edit, undefined, `read-only role ${role} must not allow edit`);
    assert.equal(perm.write, undefined, `read-only role ${role} must not allow write`);
    assert.equal(perm.bash, undefined, `read-only role ${role} must not allow bash`);
    assert.equal(perm.read, "allow", `read-only role ${role} must allow read`);
  }

  const mutationRoles = [
    "implementer",
    "code-simplifier",
    "refactorer",
    "test-engineer",
    "performance-engineer",
    "security-reviewer",
    "architect",
    "designer",
    "prompt-architect",
    "humanizer",
  ];
  for (const role of mutationRoles) {
    const perm = config.agent[role].permission;
    assert.equal(perm["*"], "allow", `mutation role ${role} must have * set to allow`);
    assert.equal(perm.edit, "allow", `mutation role ${role} must allow edit`);
    assert.equal(perm.write, "allow", `mutation role ${role} must allow write`);
    assert.equal(perm.bash, "allow", `mutation role ${role} must allow bash`);
  }
});
