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

test("planWatchdogActions respects autoEnable=false and emits zero enable actions in fleet-runtime", () => {
  const now = Date.now();
  const heartbeat = { lastRunUtc: new Date(now - 3 * 3600 * 1000).toISOString() };
  const plan = planWatchdogActions(heartbeat, now, 90 * 60 * 1000, { autoEnable: false });
  assert.equal(plan.stale, true);
  assert.equal(plan.alertIssue, true);
  const enableActions = plan.actions.filter((a) => a.kind === "enable-workflow");
  assert.equal(enableActions.length, 0);
});

test("watchdog-recipes.mjs exports all watchdog decision recipes and helpers in fleet-runtime", async () => {
  const recipes = await import("../scripts/lib/watchdog-recipes.mjs");
  const decide = await import("../scripts/lib/watchdog-decide.mjs");
  assert.deepEqual(recipes.WATCHDOG_WORKFLOWS, decide.WATCHDOG_WORKFLOWS);
  assert.equal(typeof recipes.planWatchdogActions, "function");
  assert.equal(typeof recipes.watchdogAutoEnableEnabled, "function");
  assert.equal(recipes.watchdogAutoEnableEnabled("true"), true);
  assert.equal(recipes.watchdogAutoEnableEnabled("false"), false);
  assert.equal(recipes.watchdogAutoEnableEnabled(undefined), false);
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
