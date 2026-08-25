import { test } from "node:test";
import assert from "node:assert/strict";

import { disableFleetWorkflows } from "../scripts/emergency-stop.mjs";

test("emergency-stop disables every workflow in both repositories before confirmation issue", () => {
  const calls = [];
  const result = disableFleetWorkflows({
    repos: ["M1Vj/fleet-runtime", "M1Vj/fleet-control"],
    workflows: ["patrol.yml", "watchdog.yml"],
    disable: (repo, workflow) => calls.push(`${repo}:${workflow}`),
  });
  assert.deepEqual(result, calls);
  assert.deepEqual(calls, [
    "M1Vj/fleet-runtime:patrol.yml",
    "M1Vj/fleet-runtime:watchdog.yml",
    "M1Vj/fleet-control:patrol.yml",
    "M1Vj/fleet-control:watchdog.yml",
  ]);
});
