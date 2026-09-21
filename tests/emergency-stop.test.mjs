import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_KILL_SWITCH_PATH,
  STOP_WORKFLOWS,
  resolveKillSwitchPath,
} from "../scripts/emergency-stop.mjs";

test("emergency stop covers every fleet workflow that must be halted", () => {
  const expected = [
    "patrol.yml",
    "watchdog.yml",
    "selftest.yml",
    "cloud-agent.yml",
    "deep.yml",
    "improve.yml",
    "thesis.yml",
    "kb.yml",
    "retro.yml",
    "orchestrate.yml",
    "merge.yml",
    "model-refresh.yml",
    "ci-diag.yml",
  ];

  assert.deepEqual(STOP_WORKFLOWS, expected);
  assert.equal(new Set(STOP_WORKFLOWS).size, STOP_WORKFLOWS.length);
});

test("emergency stop requires an explicit non-workspace kill-switch path", () => {
  assert.equal(
    resolveKillSwitchPath({ FLEET_KILL_SWITCH_PATH: CANONICAL_KILL_SWITCH_PATH }),
    CANONICAL_KILL_SWITCH_PATH,
  );
  assert.throws(
    () => resolveKillSwitchPath({}),
    /FLEET_KILL_SWITCH_PATH must be an absolute path/,
  );
  assert.throws(
    () => resolveKillSwitchPath({ FLEET_KILL_SWITCH_PATH: `${process.cwd()}/state/KILL_SWITCH` }),
    /must not point at the workflow workspace/,
  );
  assert.throws(
    () => resolveKillSwitchPath({ FLEET_KILL_SWITCH_PATH: "/tmp/fleet-kill-switch" }),
    /canonical VM marker/,
  );
});
