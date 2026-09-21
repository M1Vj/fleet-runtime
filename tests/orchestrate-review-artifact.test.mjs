import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";

import * as orchestrate from "../scripts/orchestrate.mjs";

const REPO = "M1Vj/fleet-fixture";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NEXT_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const REVISION = "a".repeat(64);

function makeRoot(prefix = "fleet-review-artifact-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function advisoryEnv(root, overrides = {}) {
  return {
    FLEET_REVIEW_ADVISORY: "true",
    FLEET_REQUEST_ID: "req-review-1",
    FLEET_REQUEST_REVISION: REVISION,
    FLEET_TASK_ID: "review-task-1",
    FLEET_BOUND_HEAD_SHA: HEAD,
    FLEET_RESULT_FILE: path.join(root, "worker-result.json"),
    RUNNER_TEMP: root,
    FLEET_STATE_ROOT: path.join(root, "controller-state"),
    FLEET_ADVISORY_STATE_ROOT: path.join(root, "advisory-state"),
    FLEET_MODEL_WORKSPACE: path.join(root, "model-workspace"),
    FLEET_RUNTIME_CHECKOUT_ROOT: path.join(root, "runtime-checkout"),
    FLEET_ARTIFACT_DIR: path.join(root, "task-results"),
    ...overrides,
  };
}

function reviewTask() {
  return { id: "review-task-1", type: "review", role: "review", repo: REPO, pr: 7 };
}

function ghFixture(headSha = HEAD) {
  return (args) => {
    const endpoint = String(args.at(-1) || "");
    if (endpoint.endsWith(`/repos/${REPO}`)) return { default_branch: "main" };
    if (endpoint.includes(`/repos/${REPO}/pulls/7`)) {
      return { number: 7, state: "open", head: { sha: headSha }, base: { ref: "main" } };
    }
    if (args.includes("application/vnd.github.v3.diff")) return "diff --git a/src/example.mjs b/src/example.mjs";
    throw new Error(`unexpected GitHub call: ${args.join(" ")}`);
  };
}

test("legacy review accepts its task identity without advisory binding fields", () => {
  assert.deepEqual(
    orchestrate.parseReviewBinding(reviewTask(), {
      FLEET_REVIEW_ADVISORY: "false",
      FLEET_TASK_ID: "review-task-1",
    }),
    { advisory: false, binding: null },
  );
});

test("legacy review still rejects advisory binding fields without the advisory marker", () => {
  assert.deepEqual(
    orchestrate.parseReviewBinding(reviewTask(), {
      FLEET_REVIEW_ADVISORY: "false",
      FLEET_TASK_ID: "review-task-1",
      FLEET_REQUEST_ID: "req-review-1",
    }),
    { advisory: true, error: "advisory marker is required" },
  );
});

test("private advisory model boundary strips controller credentials/state and uses the runtime workspace", async () => {
  const root = makeRoot("fleet-review-model-boundary-");
  let captured;
  try {
    const controllerState = path.join(root, "controller-state");
    const runtimeWorkspace = path.join(root, "runtime");
    const result = await orchestrate.executeTask(reviewTask(), {
      env: advisoryEnv(root, {
        FLEET_STATE_ROOT: controllerState,
        FLEET_GH_TOKEN: "publisher-secret",
        FLEET_READ_TOKEN: "read-secret",
        GITHUB_TOKEN: "actions-secret",
        GH_TOKEN: "gh-secret",
        GITHUB_WORKSPACE: path.join(root, "controller-checkout"),
        FLEET_MODEL_WORKSPACE: runtimeWorkspace,
      }),
      ghClient: (args, env) => {
        if (args.includes("application/vnd.github.v3.diff")) return "diff with read-secret and ghp_fake_secret_value";
        const value = ghFixture()(args);
        if (String(args.at(-1) || "").includes(`/repos/${REPO}/pulls/7`)) {
          return { ...value, title: "bounded title", body: "contains read-secret and ghp_fake_secret_value" };
        }
        return value;
      },
      modelRunner: async (options) => {
        captured = options;
        return { complete: true, reply: JSON.stringify({ findings: [] }) };
      },
    });
    assert.equal(result.status, "completed");
    assert.ok(captured);
    assert.equal(captured.readOnly, true);
    assert.equal(captured.workspace, runtimeWorkspace);
    assert.equal(captured.env.FLEET_GH_TOKEN, undefined);
    assert.equal(captured.env.FLEET_READ_TOKEN, undefined);
    assert.equal(captured.env.GITHUB_TOKEN, undefined);
    assert.equal(captured.env.GH_TOKEN, undefined);
    assert.equal(captured.env.GITHUB_WORKSPACE, undefined);
    assert.notEqual(captured.env.FLEET_STATE_ROOT, controllerState);
    assert.equal(captured.env.FLEET_WORKSPACE_ROOT, runtimeWorkspace);
    assert.match(captured.prompt, /sanitized and bounded/);
    assert.doesNotMatch(captured.prompt, /read-secret|ghp_fake_secret_value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy review records bounded non-secret model failure diagnostics", async () => {
  const root = makeRoot("fleet-review-model-diagnostics-");
  try {
    const env = advisoryEnv(root, {
      FLEET_REVIEW_ADVISORY: "false",
      FLEET_REQUEST_ID: undefined,
      FLEET_REQUEST_REVISION: undefined,
      FLEET_BOUND_HEAD_SHA: undefined,
      FLEET_TASK_ID: "review-task-1",
    });
    const result = await orchestrate.executeTask(reviewTask(), {
      env,
      ghClient: ghFixture(),
      modelRunner: async () => ({
        complete: false,
        modelMode: "opencode/test-model",
        attempts: [{ round: 1, model: "opencode/test-model", exit: 143, interrupted: true, gotReply: false }],
      }),
    });
    assert.equal(result.status, "deferred");
    assert.equal(result.reason, "model-unavailable");
    assert.deepEqual(result.diagnostics, {
      modelMode: "opencode/test-model",
      attemptCount: 1,
      attempts: [{
        round: 1,
        model: "opencode/test-model",
        exit: 143,
        interrupted: true,
        gotReply: false,
        sessionNotFound: false,
        exhausted: false,
      }],
      blocked: false,
      circuitOpen: false,
      waitingForCapacity: false,
      waitingForQuota: false,
    });
    const artifact = JSON.parse(readFileSync(result.artifact, "utf8"));
    assert.deepEqual(artifact.diagnostics, result.diagnostics);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual orchestrate workflow review environment derives the enforced advisory permission map", async () => {
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const controlRoot = process.env.FLEET_CONTROL_WORKTREE
    || runtimeRoot.replace(/runtime$/u, "control");
  const controlWorkflow = path.join(controlRoot, ".github/workflows/orchestrate.yml");
  const workflow = readFileSync(controlWorkflow, "utf8");
  const reviewStart = workflow.indexOf("      - name: execute orchestration task");
  const cleanupStart = workflow.indexOf("      - name: cleanup advisory model workspace", reviewStart);
  assert.ok(reviewStart >= 0 && cleanupStart > reviewStart);
  const reviewStep = workflow.slice(reviewStart, cleanupStart);
  assert.match(reviewStep, /FLEET_READ_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.match(reviewStep, /working-directory:\s*runtime/);
  assert.doesNotMatch(reviewStep, /FLEET_GH_TOKEN:/);

  const { advisoryModelEnv, buildOpenCodeConfigContent } = await import("../scripts/lib/model.mjs");
  const root = makeRoot("fleet-derived-workflow-env-");
  try {
    const workspace = path.join(root, "model-workspace");
    const controllerCheckout = path.join(root, "controller-checkout");
    const modelEnv = advisoryModelEnv({
      RUNNER_TEMP: root,
      FLEET_STATE_ROOT: path.join(root, "controller-state"),
      FLEET_ADVISORY_STATE_ROOT: path.join(root, "advisory-state"),
      GITHUB_WORKSPACE: controllerCheckout,
      FLEET_RUNTIME_CHECKOUT_ROOT: path.join(root, "runtime-checkout"),
      FLEET_MODEL_WORKSPACE: workspace,
      FLEET_GH_TOKEN: "publisher-secret",
      FLEET_READ_TOKEN: "read-secret",
      GITHUB_TOKEN: "actions-secret",
      GH_TOKEN: "gh-secret",
      FLEET_OPENCODE_AUTH: "model-secret",
    }, { workspace });
    const config = JSON.parse(buildOpenCodeConfigContent("opencode/muse-spark-1.3-contributor-free", "{\"permission\":{\"bash\":\"allow\",\"edit\":\"allow\",\"write\":\"allow\"}}", workspace, { readOnly: true }));
    for (const key of ["FLEET_GH_TOKEN", "FLEET_READ_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_WORKSPACE"]) {
      assert.equal(modelEnv[key], undefined, `${key} must be absent from the derived model environment`);
    }
    assert.equal(modelEnv.FLEET_WORKSPACE_ROOT.endsWith("/model-workspace"), true);
    assert.equal(config.permission.bash, "deny");
    assert.equal(config.permission.edit, "deny");
    assert.equal(config.permission.write, "deny");
    assert.equal(config.permission.external_directory, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory review rejects partial bindings before GitHub or model execution", async () => {
  const root = makeRoot();
  let modelCalls = 0;
  let ghCalls = 0;
  try {
    const env = advisoryEnv(root, { FLEET_REQUEST_REVISION: undefined });
    const result = await orchestrate.executeTask(reviewTask(), {
      env,
      ghClient: () => { ghCalls += 1; throw new Error("GitHub must not run"); },
      modelRunner: async () => { modelCalls += 1; return { complete: true, reply: "{}" }; },
    });
    assert.equal(result.status, "deferred");
    assert.equal(result.reason, "review-binding-invalid");
    assert.equal(ghCalls, 0);
    assert.equal(modelCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory review defers a malformed-only findings response", async () => {
  const root = makeRoot();
  let modelCalls = 0;
  try {
    const result = await orchestrate.executeTask(reviewTask(), {
      env: advisoryEnv(root),
      ghClient: ghFixture(),
      modelRunner: async () => {
        modelCalls += 1;
        return { complete: true, reply: JSON.stringify({ findings: [{}] }) };
      },
    });
    assert.equal(result.status, "deferred");
    assert.equal(result.reason, "model-output-invalid");
    assert.equal(modelCalls, 1);
    assert.equal(existsSync(path.join(root, "worker-result.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory review defers mixed valid and malformed findings instead of filtering", async () => {
  const root = makeRoot();
  const valid = {
    file: "src/example.mjs",
    line: 3,
    rationale: "Use the checked audience.",
    evidence: "src/example.mjs:3",
    validationStatus: "validated",
    severity: "high",
    confidence: "high",
  };
  try {
    const result = await orchestrate.executeTask(reviewTask(), {
      env: advisoryEnv(root),
      ghClient: ghFixture(),
      modelRunner: async () => ({ complete: true, reply: JSON.stringify({ findings: [valid, {}] }) }),
    });
    assert.equal(result.status, "deferred");
    assert.equal(result.reason, "model-output-invalid");
    assert.equal(existsSync(path.join(root, "worker-result.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private advisory result paths must stay inside the verified runner temp root", async () => {
  const root = makeRoot();
  let ghCalls = 0;
  let modelCalls = 0;
  try {
    const result = await orchestrate.executeTask(reviewTask(), {
      env: advisoryEnv(root, { FLEET_RESULT_FILE: path.join(root, "..", "escaped-worker-result.json") }),
      ghClient: () => { ghCalls += 1; throw new Error("GitHub must not run"); },
      modelRunner: async () => { modelCalls += 1; return { complete: true, reply: JSON.stringify({ findings: [] }) }; },
    });
    assert.equal(result.status, "deferred");
    assert.equal(result.reason, "review-binding-invalid");
    assert.equal(ghCalls, 0);
    assert.equal(modelCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private advisory accepts a valid result path under runner temp", async () => {
  const root = makeRoot();
  try {
    const result = await orchestrate.executeTask(reviewTask(), {
      env: advisoryEnv(root),
      ghClient: ghFixture(),
      modelRunner: async () => ({ complete: true, reply: JSON.stringify({ findings: [] }) }),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.artifact, path.join(root, "worker-result.json"));
    assert.equal(JSON.parse(readFileSync(result.artifact, "utf8")).findings.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private advisory rejects symlinked result targets and ancestors", async () => {
  const root = makeRoot();
  const ancestorRoot = makeRoot();
  const outside = makeRoot("fleet-review-outside-");
  try {
    const linkedTarget = path.join(root, "linked-result.json");
    symlinkSync(path.join(outside, "target.json"), linkedTarget);
    const targetResult = await orchestrate.executeTask(reviewTask(), {
      env: advisoryEnv(root, { FLEET_RESULT_FILE: linkedTarget }),
      ghClient: () => { throw new Error("GitHub must not run"); },
      modelRunner: async () => ({ complete: true, reply: JSON.stringify({ findings: [] }) }),
    });
    assert.equal(targetResult.status, "deferred");
    assert.equal(targetResult.reason, "review-binding-invalid");

    const linkedDirectory = path.join(ancestorRoot, "linked-directory");
    symlinkSync(outside, linkedDirectory, "dir");
    const ancestorResult = await orchestrate.executeTask(
      reviewTask(),
      {
        env: advisoryEnv(ancestorRoot, { FLEET_RESULT_FILE: path.join(linkedDirectory, "worker-result.json") }),
        ghClient: () => { throw new Error("GitHub must not run"); },
        modelRunner: async () => ({ complete: true, reply: JSON.stringify({ findings: [] }) }),
      },
    );
    assert.equal(ancestorResult.status, "deferred");
    assert.equal(ancestorResult.reason, "review-binding-invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ancestorRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("advisory review rejects a stale bound head before model execution", async () => {
  const root = makeRoot();
  let modelCalls = 0;
  let diffCalls = 0;
  try {
    const result = await orchestrate.executeTask(reviewTask(), {
      env: advisoryEnv(root),
      ghClient: (args) => {
        if (args.includes("application/vnd.github.v3.diff")) diffCalls += 1;
        return ghFixture(NEXT_HEAD)(args);
      },
      modelRunner: async () => { modelCalls += 1; return { complete: true, reply: "{}" }; },
    });
    assert.equal(result.status, "deferred");
    assert.equal(result.reason, "stale-head");
    assert.equal(modelCalls, 0);
    assert.equal(diffCalls, 0);
    assert.equal(existsSync(path.join(root, "worker-result.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory review rechecks the head and suppresses a stale artifact", async () => {
  const root = makeRoot();
  let pullReads = 0;
  let modelCalls = 0;
  try {
    const result = await orchestrate.executeTask(reviewTask(), {
      env: advisoryEnv(root),
      ghClient: (args) => {
        const endpoint = String(args.at(-1) || "");
        if (endpoint.endsWith(`/repos/${REPO}`)) return { default_branch: "main" };
        if (endpoint.includes(`/repos/${REPO}/pulls/7`) && !args.some((arg) => String(arg).includes("application/vnd.github.v3.diff"))) {
          pullReads += 1;
          return { number: 7, state: "open", head: { sha: pullReads === 1 ? HEAD : NEXT_HEAD }, base: { ref: "main" } };
        }
        if (args.some((arg) => String(arg).includes("application/vnd.github.v3.diff"))) return "diff";
        throw new Error(`unexpected GitHub call: ${args.join(" ")}`);
      },
      modelRunner: async () => {
        modelCalls += 1;
        return { complete: true, reply: JSON.stringify({ findings: [] }) };
      },
    });
    assert.equal(result.status, "deferred");
    assert.equal(result.reason, "stale-head");
    assert.equal(pullReads, 2);
    assert.equal(modelCalls, 1);
    assert.equal(existsSync(path.join(root, "worker-result.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory worker artifact bounds and redacts structured findings", async () => {
  const root = makeRoot();
  const secret = ["AKIA", "1234567890ABCDEF"].join("");
  const findings = Array.from({ length: 30 }, (_, index) => ({
    file: `src/example-${index}.mjs`,
    line: index + 1,
    rationale: index === 0 ? `Bearer ${secret}` : `bounded rationale ${index}`,
    evidence: index === 0 ? `evidence ${secret} ${"x".repeat(3_000)}` : `evidence ${index}`,
    validationStatus: "validated",
    severity: index % 2 ? "medium" : "high",
    confidence: 0.9,
    fixSuggestion: "bounded fix",
    anchor: { line: index + 1, snippet: `line ${index}` },
    ignored: "must not be copied",
  }));
  try {
    const result = await orchestrate.executeTask(reviewTask(), {
      env: advisoryEnv(root),
      ghClient: ghFixture(),
      modelRunner: async () => ({ complete: true, reply: JSON.stringify({ findings }) }),
    });
    assert.equal(result.status, "completed");
    const artifact = JSON.parse(readFileSync(path.join(root, "worker-result.json"), "utf8"));
    assert.equal(artifact.schema, "fleet.worker-result.v1");
    assert.equal(artifact.repository, REPO);
    assert.equal(artifact.prNumber, 7);
    assert.equal(artifact.sourceHeadSha, HEAD);
    assert.equal(Object.hasOwn(artifact, "headSha"), false);
    assert.equal(artifact.requestId, "req-review-1");
    assert.equal(artifact.requestRevision, REVISION);
    assert.equal(artifact.taskId, "review-task-1");
    assert.ok(/^[a-f0-9]{64}$/.test(artifact.artifactDigest));
    assert.ok(artifact.findings.length <= 25);
    assert.equal(JSON.stringify(artifact).includes(secret), false);
    assert.equal(JSON.stringify(artifact).includes("ignored"), false);
    assert.equal(JSON.stringify(artifact).includes("must not be copied"), false);
    assert.ok(Array.isArray(artifact.checks));
    assert.ok(Array.isArray(artifact.tests));
    assert.ok(artifact.checks.every((entry) => /^[a-f0-9]{64}$/.test(entry.digest)));
    assert.ok(artifact.tests.every((entry) => /^[a-f0-9]{64}$/.test(entry.digest)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory main preserves the canonical worker artifact when --result-file is supplied", async () => {
  const root = makeRoot();
  try {
    const env = advisoryEnv(root);
    const resultFile = env.FLEET_RESULT_FILE;
    const code = await orchestrate.main([
      "execute",
      "--repo", REPO,
      "--pr", "7",
      "--type", "review",
      "--role", "review",
      "--id", "review-task-1",
      "--result-file", resultFile,
    ], env, {
      ghClient: ghFixture(),
      modelRunner: async () => ({ complete: true, reply: JSON.stringify({ findings: [] }) }),
    });
    assert.equal(code, 0);
    const artifact = JSON.parse(readFileSync(resultFile, "utf8"));
    assert.equal(artifact.schema, "fleet.worker-result.v1");
    assert.equal(artifact.kind, "pr-review");
    assert.equal(artifact.repository, REPO);
    assert.equal(artifact.prNumber, 7);
    assert.equal(artifact.sourceHeadSha, HEAD);
    assert.equal(Object.hasOwn(artifact, "headSha"), false);
    assert.match(artifact.artifactDigest, /^[a-f0-9]{64}$/);
    const rebuilt = orchestrate.buildWorkerResult(artifact);
    assert.equal(artifact.artifactDigest, rebuilt.artifactDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory main fails closed on a stale bound head without a canonical artifact", async () => {
  const root = makeRoot();
  try {
    const resultFile = path.join(root, "worker-result.json");
    const code = await orchestrate.main([
      "execute",
      "--repo", REPO,
      "--pr", "7",
      "--type", "review",
      "--role", "review",
      "--id", "review-task-1",
      "--result-file", resultFile,
    ], advisoryEnv(root), {
      ghClient: ghFixture(NEXT_HEAD),
      modelRunner: async () => ({ complete: true, reply: JSON.stringify({ findings: [] }) }),
    });
    assert.equal(code, 1);
    assert.equal(existsSync(resultFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory main fails closed on an invalid binding without a canonical artifact", async () => {
  const root = makeRoot();
  try {
    const resultFile = path.join(root, "worker-result.json");
    const code = await orchestrate.main([
      "execute",
      "--repo", REPO,
      "--pr", "7",
      "--type", "review",
      "--role", "review",
      "--id", "review-task-1",
      "--result-file", resultFile,
    ], advisoryEnv(root, { FLEET_REQUEST_REVISION: undefined }), {
      ghClient: () => { throw new Error("invalid binding must stop before GitHub access"); },
      modelRunner: async () => ({ complete: true, reply: JSON.stringify({ findings: [] }) }),
    });
    assert.equal(code, 1);
    assert.equal(existsSync(resultFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory main fails closed when the canonical artifact cannot be written", async () => {
  const root = makeRoot();
  try {
    const code = await orchestrate.main([
      "execute",
      "--repo", REPO,
      "--pr", "7",
      "--type", "review",
      "--role", "review",
      "--id", "review-task-1",
      "--result-file", root,
    ], advisoryEnv(root, { FLEET_RESULT_FILE: root }), {
      ghClient: ghFixture(),
      modelRunner: async () => ({ complete: true, reply: JSON.stringify({ findings: [] }) }),
    });
    assert.equal(code, 1);
    assert.equal(existsSync(path.join(root, "worker-result.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker artifact digest is deterministic over the canonical payload", () => {
  const input = {
    requestId: "req-review-1",
    requestRevision: REVISION,
    taskId: "review-task-1",
    repository: REPO,
    prNumber: 7,
    sourceHeadSha: HEAD,
    workerRunId: "worker-1",
    findings: [{
      file: "src/example.mjs",
      line: 3,
      rationale: "Use the checked audience.",
      evidence: "src/example.mjs:3",
      validationStatus: "validated",
      severity: "high",
      confidence: "high",
    }],
    summary: { total: 1, bySeverity: { high: 1 } },
    checks: [{ name: "head-binding", status: "passed", digest: "a".repeat(64) }],
    tests: [{ name: "structured-findings", status: "passed", digest: "b".repeat(64) }],
  };
  const first = orchestrate.buildWorkerResult(input);
  const second = orchestrate.buildWorkerResult({ ...input });
  assert.deepEqual(first, second);
  assert.match(first.artifactDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.schema, "fleet.worker-result.v1");
});

test("canonical worker artifacts reject the legacy headSha field", () => {
  assert.throws(() => orchestrate.buildWorkerResult({
    requestId: "req-review-1",
    requestRevision: REVISION,
    taskId: "review-task-1",
    repository: REPO,
    prNumber: 7,
    headSha: HEAD,
    workerRunId: "worker-1",
    findings: [],
  }), /sourceHeadSha|legacy headSha/);
});
