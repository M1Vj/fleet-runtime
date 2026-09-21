import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  CENTRAL_KILL_SWITCH_VARIABLE,
  isGitHubMutation,
  assertKillSwitchClear,
} from "../scripts/lib/kill-switch.mjs";

function fakeGh({ status = 0, stdout = "", stderr = "" } = {}) {
  return () => ({ status, stdout, stderr });
}

const centralEnv = (extra = {}) => ({
  FLEET_CONTROL_REPOSITORY: "private-owner/control-plane",
  FLEET_KILL_SWITCH_REPOSITORY: "private-owner/control-plane",
  FLEET_KILL_SWITCH_VARIABLE: CENTRAL_KILL_SWITCH_VARIABLE,
  FLEET_GH_TOKEN: "token-redacted",
  ...extra,
});

test("central kill-switch signal blocks a mutation when the repository variable is present", () => {
  assert.throws(
    () => assertKillSwitchClear(centralEnv(), {
      exists: () => false,
      run: fakeGh({ stdout: JSON.stringify({ name: CENTRAL_KILL_SWITCH_VARIABLE, value: "engaged" }) }),
    }),
    (error) => error.code === 2 && error.reason === "KILL_SWITCH_ENGAGED",
  );
});

test("an explicitly initialized clear central variable permits a mutation", () => {
  assert.equal(
    assertKillSwitchClear(centralEnv(), {
      exists: () => false,
      run: fakeGh({ stdout: JSON.stringify({ name: CENTRAL_KILL_SWITCH_VARIABLE, value: "clear" }) }),
    }),
    true,
  );
});

test("an absent central kill-switch variable is unreadable and blocks fail-closed", () => {
  assert.throws(
    () => assertKillSwitchClear(centralEnv(), {
      exists: () => false,
      run: fakeGh({ status: 1, stderr: "HTTP 404: Not Found" }),
    }),
    (error) => error.code === 2 && error.reason === "KILL_SWITCH_SIGNAL_UNAVAILABLE",
  );
});

test("central kill-switch read failures fail closed before mutation", () => {
  assert.throws(
    () => assertKillSwitchClear(centralEnv(), {
      exists: () => false,
      run: fakeGh({ status: 1, stderr: "network timeout" }),
    }),
    (error) => error.code === 2 && error.reason === "KILL_SWITCH_SIGNAL_UNAVAILABLE",
  );
});

test("missing or caller-selected central identity fails closed", () => {
  assert.throws(
    () => assertKillSwitchClear({ FLEET_GH_TOKEN: "token-redacted" }, { exists: () => false, run: fakeGh() }),
    (error) => error.code === 4 && error.reason === "KILL_SWITCH_CONFIG_INVALID",
  );
  assert.throws(
    () => assertKillSwitchClear(centralEnv({ FLEET_KILL_SWITCH_REPOSITORY: "Other/control" }), { exists: () => false, run: fakeGh() }),
    (error) => error.code === 4 && error.reason === "KILL_SWITCH_CONFIG_INVALID",
  );
});

test("workspace markers cannot be configured as a global stop signal", () => {
  const workspaceMarker = path.resolve(process.cwd(), "state", "KILL_SWITCH");
  assert.throws(
    () => assertKillSwitchClear(centralEnv({ FLEET_KILL_SWITCH_PATH: workspaceMarker }), {
      exists: () => false,
      run: fakeGh(),
    }),
    (error) => error.code === 4 && error.reason === "KILL_SWITCH_WORKSPACE_PATH_INVALID",
  );
});

test("the actuator flag alone cannot bypass an engaged signal", () => {
  assert.throws(
    () => assertKillSwitchClear(centralEnv({
      FLEET_KILL_SWITCH_ACTUATOR: "true",
      FLEET_KILL_SWITCH_PATH: "/opt/actions-runner/_state/fleet-cloud-agent/state/KILL_SWITCH",
    }), {
      exists: () => true,
      run: fakeGh({ stdout: JSON.stringify({ name: CENTRAL_KILL_SWITCH_VARIABLE, value: "engaged" }) }),
    }),
    (error) => error.code === 2 && error.reason === "KILL_SWITCH_ENGAGED",
  );
});

test("only the exact emergency workflow context can bypass the signal while engaging", () => {
  let centralRead = false;
  assert.equal(
    assertKillSwitchClear(centralEnv({
      FLEET_KILL_SWITCH_ACTUATOR: "true",
      FLEET_CONFIRM: "STOP",
      FLEET_KILL_SWITCH_PATH: "/opt/actions-runner/_state/fleet-cloud-agent/state/KILL_SWITCH",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "private-owner/control-plane",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_ACTOR: "M1Vj",
      GITHUB_TRIGGERING_ACTOR: "M1Vj",
      GITHUB_WORKFLOW: "fleet-emergency-stop",
    }), {
      exists: () => true,
      run: () => { centralRead = true; throw new Error("central signal must be bypassed only by actuator"); },
    }),
    true,
  );
  assert.equal(centralRead, false);
});

test("GitHub mutation detection covers API writes and workflow/PR commands", () => {
  assert.equal(isGitHubMutation(["api", "-X", "POST", "/repos/private-owner/control-plane/issues"]), true);
  assert.equal(isGitHubMutation(["api", "/repos/private-owner/control-plane/issues"]), false);
  assert.equal(isGitHubMutation(["workflow", "run", "patrol.yml"]), true);
  assert.equal(isGitHubMutation(["pr", "merge", "12", "-R", "M1Vj/demo"]), true);
  assert.equal(isGitHubMutation(["repo", "clone", "M1Vj/demo", "/tmp/demo"]), false);
});
