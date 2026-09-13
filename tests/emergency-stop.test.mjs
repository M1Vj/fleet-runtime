import test from "node:test";
import assert from "node:assert/strict";
import { STOP_WORKFLOWS } from "../scripts/emergency-stop.mjs";

test("emergency stop covers every fleet workflow that must be halted", () => {
  const expected = [
    "patrol.yml",
    "watchdog.yml",
    "selftest.yml",
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
