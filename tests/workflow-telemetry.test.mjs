import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkflowTelemetry, workflowFailureCause } from "../scripts/lib/workflow-telemetry.mjs";

test("phase start, end, failure and terminal notices use fixed fields and elapsed times", () => {
  const lines = [];
  let now = 100;
  const telemetry = createWorkflowTelemetry("patrol", { now: () => now, write: (line) => lines.push(line) });
  telemetry.phase("preflight");
  now = 125;
  telemetry.phase("model");
  now = 140;
  telemetry.fail({ reason: "MODEL_UNAVAILABLE", message: "must never be emitted" });
  telemetry.terminal("EXHAUSTED");
  assert.equal(lines.length, 5);
  assert.match(lines[0], /phase=preflight status=start .*elapsed_ms=0$/);
  assert.match(lines[1], /phase=preflight status=end .*elapsed_ms=25$/);
  assert.match(lines[2], /phase=model status=start/);
  assert.match(lines[3], /phase=model status=failed .*cause=model-unavailable elapsed_ms=40$/);
  assert.match(lines[4], /phase=model status=terminal outcome=EXHAUSTED cause=model-unavailable/);
});

test("hostile errors and every free-text field cannot inject annotations or private text", () => {
  const hostile = "private-text\n::error::injected%0Asecret";
  const lines = [];
  const telemetry = createWorkflowTelemetry(hostile, { write: (line) => lines.push(line) });
  telemetry.phase(hostile);
  telemetry.fail({ reason: hostile, message: hostile, stdout: hostile, stderr: hostile });
  telemetry.terminal(hostile, hostile, hostile);
  for (const line of lines) {
    assert.match(line, /^::notice title=Fleet runtime::lane=unknown phase=preflight status=(start|failed|terminal) outcome=(none|FAILED) cause=(none|unexpected-error) elapsed_ms=\d+$/);
    assert.ok(!line.includes("private-text"));
    assert.ok(!line.includes("::error"));
  }
  assert.equal(workflowFailureCause({ get reason() { throw new Error(hostile); } }), "unexpected-error");
});

test("notices are capped at ten while reserving the final terminal outcome", () => {
  const lines = [];
  const telemetry = createWorkflowTelemetry("merge", { write: (line) => lines.push(line) });
  for (let i = 0; i < 100; i++) telemetry.phase("checks");
  telemetry.terminal("NEEDS_HUMAN_REVIEW");
  telemetry.terminal("SUCCESS");
  telemetry.phase("merge");
  assert.equal(lines.length, 10);
  assert.match(lines.at(-1), /status=terminal outcome=NEEDS_HUMAN_REVIEW/);
  assert.ok(lines.every((line) => line.startsWith("::notice ")));
});

test("summary-only child reports one terminal outcome with the failed phase", () => {
  const lines = [];
  const telemetry = createWorkflowTelemetry("merge", { summaryOnly: true, write: (line) => lines.push(line) });
  telemetry.phase("checks");
  telemetry.fail(new Error("private exception"));
  telemetry.phase("persistence");
  telemetry.terminal("BLOCKED");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /phase=checks status=terminal outcome=BLOCKED cause=unexpected-error/);
});

test("push failure overrides an earlier error phase when persistence is explicitly responsible", () => {
  const lines = [];
  const telemetry = createWorkflowTelemetry("merge", { write: (line) => lines.push(line) });
  telemetry.phase("checks");
  telemetry.fail(new Error("synthetic original error"));
  telemetry.phase("persistence");
  telemetry.terminal("BLOCKED", "push-failed", "persistence");
  assert.match(lines.at(-1), /phase=persistence status=terminal outcome=BLOCKED cause=push-failed/);
});

test("ordinary original failure retains its phase and cause after successful persistence", () => {
  const lines = [];
  const telemetry = createWorkflowTelemetry("merge", { write: (line) => lines.push(line) });
  telemetry.phase("judges");
  telemetry.fail({ reason: "MODEL_UNAVAILABLE" });
  telemetry.phase("persistence");
  telemetry.terminal("BLOCKED");
  assert.match(lines.at(-1), /phase=judges status=terminal outcome=BLOCKED cause=model-unavailable/);
});

for (const { outcome, cause, phase } of [
  { outcome: "SCAN-FAILED", cause: "child-failed", phase: "children" },
  { outcome: "SCAN-FAILED", cause: "push-failed", phase: "persistence" },
  { outcome: "SCAN-DONE", cause: "none", phase: "persistence" },
]) {
  test(`scan terminal attributes ${cause} to ${phase}`, () => {
    const lines = [];
    const telemetry = createWorkflowTelemetry("merge", { write: (line) => lines.push(line) });
    telemetry.phase("children");
    telemetry.end("child-failed");
    telemetry.phase("persistence");
    telemetry.terminal(outcome, cause, phase);
    assert.ok(lines.at(-1).includes(`phase=${phase} status=terminal outcome=${outcome} cause=${cause} `));
    assert.ok(lines.length <= 7);
  });
}

test("sink failure and malformed clocks do not throw or change the caller result", () => {
  const telemetry = createWorkflowTelemetry("patrol", { now: () => Infinity, write: () => { throw new Error("sink unavailable"); } });
  assert.doesNotThrow(() => {
    telemetry.phase("execution");
    telemetry.fail(null);
    telemetry.terminal("FAILED");
  });
});

test("scan FD relay exposes only the new terminal notice while preserving captured output and exit", () => {
  const moduleUrl = new URL("../scripts/lib/workflow-telemetry.mjs", import.meta.url).href;
  const childSource = `
    import { createMergeWorkflowTelemetry } from ${JSON.stringify(moduleUrl)};
    const telemetry = createMergeWorkflowTelemetry("3");
    telemetry.phase("checks");
    console.log("synthetic-private-stdout");
    console.error("synthetic-private-stderr");
    telemetry.fail(new Error("synthetic-private-error"));
    telemetry.terminal("BLOCKED");
    process.exitCode = 7;
  `;
  const parentSource = `
    import assert from "node:assert/strict";
    import { spawnSync } from "node:child_process";
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(childSource)}], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe", 1],
    });
    assert.equal(child.status, 7);
    assert.equal(child.stdout.trim(), "synthetic-private-stdout");
    assert.equal(child.stderr.trim(), "synthetic-private-stderr");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", parentSource], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^::notice title=Fleet runtime::lane=merge phase=checks status=terminal outcome=BLOCKED cause=unexpected-error elapsed_ms=\d+$/);
  assert.ok(!result.stdout.includes("synthetic-private"));
});

test("arbitrary FD mode text never selects a descriptor, file, or workflow command", () => {
  const moduleUrl = new URL("../scripts/lib/workflow-telemetry.mjs", import.meta.url).href;
  for (const mode of ["off", "99", "/tmp/no-file-created", "\n::error::private-mode"]) {
    const source = `
      import { createMergeWorkflowTelemetry } from ${JSON.stringify(moduleUrl)};
      const telemetry = createMergeWorkflowTelemetry(${JSON.stringify(mode)});
      telemetry.phase("preflight"); telemetry.terminal("NO-OP");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
    assert.equal(result.status, 0);
    if (mode === "off") assert.equal(result.stdout, "");
    else {
      assert.equal(result.stdout.trim().split("\n").length, 3);
      assert.ok(result.stdout.trim().split("\n").every((line) => line.startsWith("::notice title=Fleet runtime::lane=merge ")));
      assert.ok(!result.stdout.includes("private-mode"));
    }
  }
});

test("scan phase notices and the first three child summaries fit the step notice budget", () => {
  const lines = [];
  const write = (line) => lines.push(line);
  const parent = createWorkflowTelemetry("merge", { write });
  parent.phase("preflight");
  parent.phase("children");
  for (let i = 0; i < 3; i++) {
    const child = createWorkflowTelemetry("merge", { write, summaryOnly: true });
    child.phase("judges"); child.terminal("NEEDS_HUMAN_REVIEW");
  }
  parent.end("child-failed");
  parent.phase("persistence");
  // Even a persistence exception/recovery loop must retain the reservation.
  for (let i = 0; i < 20; i++) parent.phase("persistence");
  parent.terminal("SCAN-FAILED", "child-failed", "children");
  assert.equal(lines.length, 10);
  assert.match(lines.at(-1), /phase=children status=terminal outcome=SCAN-FAILED cause=child-failed/);
});

test("patrol entrypoint annotates an actual preflight failure without changing its exit code", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "fleet-telemetry-patrol-"));
  const moduleUrl = new URL("../scripts/patrol.mjs", import.meta.url).href;
  try {
    const source = `
      import { main } from ${JSON.stringify(moduleUrl)};
      globalThis.fetch = async () => { throw new Error("synthetic-private-provider-error\\n::error::injected"); };
      process.exitCode = await main();
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        FLEET_DATA_CLASS: "public",
        FLEET_PUBLIC_REPOSITORY: "M1Vj/public-repo",
        RUNNER_TEMP: temporaryRoot,
        FLEET_PUBLIC_STATE_ROOT: path.join(temporaryRoot, "state"),
        FLEET_PUBLIC_ARTIFACT_MANIFEST: path.join(temporaryRoot, "state", "artifact.json"),
      },
    });
    assert.equal(result.status, 3, result.stderr);
    const annotations = result.stdout.split("\n").filter((line) => line.startsWith("::notice "));
    assert.equal(annotations.length, 3);
    assert.match(annotations[0], /phase=preflight status=start/);
    assert.match(annotations[1], /phase=preflight status=failed/);
    assert.match(annotations[2], /phase=preflight status=terminal outcome=FAILED/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("synthetic-private-provider-error"));
    assert.ok(!`${result.stdout}${result.stderr}`.includes("::error::injected"));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("merge entrypoint preserves the public read-only BLOCKED exit and annotates its safe cause", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "fleet-telemetry-merge-"));
  const moduleUrl = new URL("../scripts/merge.mjs", import.meta.url);
  try {
    const source = `
      globalThis.fetch = async () => ({ ok: true, status: 200, async json() {
        return { name: "public-repo", private: false, visibility: "public", archived: false, owner: { login: "M1Vj", id: 1 }, id: 1 };
      } });
      process.argv[1] = ${JSON.stringify(moduleUrl.pathname)};
      await import(${JSON.stringify(moduleUrl.href)});
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        FLEET_DATA_CLASS: "public",
        FLEET_PUBLIC_REPOSITORY: "M1Vj/public-repo",
        RUNNER_TEMP: temporaryRoot,
        FLEET_PUBLIC_STATE_ROOT: path.join(temporaryRoot, "state"),
        FLEET_PUBLIC_ARTIFACT_MANIFEST: path.join(temporaryRoot, "state", "artifact.json"),
      },
    });
    assert.equal(result.status, 4, result.stderr);
    const annotations = result.stdout.split("\n").filter((line) => line.startsWith("::notice "));
    assert.equal(annotations.length, 3);
    assert.match(annotations.at(-1), /phase=preflight status=terminal outcome=BLOCKED cause=public-read-only/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
