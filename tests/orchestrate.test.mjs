import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as orchestrate from "../scripts/orchestrate.mjs";
import { buildFleetPlan } from "../scripts/lib/fleet-scheduler.mjs";

const {
  validateTrigger,
  normalizeRepo,
  validateTask,
  shouldScheduleImmediate,
  stableWorkKey,
  stableEffectKey,
  loadOrchestrationState,
  applyEffectReceipt,
  canTransition,
  transitionWorkState,
} = orchestrate;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const NOW = Date.parse("2026-09-13T00:00:00.000Z");
const OWNER_REPO = "M1Vj/fleet-fixture";

function iso(at) {
  return new Date(at).toISOString();
}

function triggerPayload({
  event = "pull_request",
  action = "opened",
  delivery = "delivery-1",
  repo = OWNER_REPO,
  pr = 42,
  clientPayload,
} = {}) {
  const payload = {
    event,
    event_name: event,
    type: event,
    action,
    delivery,
    repo,
    repository: { full_name: repo },
  };
  if (pr !== null && pr !== undefined) {
    payload.pr = pr;
    payload.number = pr;
    payload.pull_request = {
      number: pr,
      repository: { full_name: repo },
      base: { repo: { full_name: repo } },
    };
  }
  if (clientPayload !== undefined) {
    payload.client_payload = clientPayload;
    payload.clientPayload = clientPayload;
    payload.payload = clientPayload;
  }
  return payload;
}

function historyEntry({
  delivery = "different-delivery",
  repo = OWNER_REPO,
  pr = 42,
  action = "opened",
  at = NOW - MINUTE_MS,
} = {}) {
  const timestamp = iso(at);
  return {
    delivery,
    deliveryId: delivery,
    eventId: delivery,
    repo,
    repository: repo,
    pr,
    number: pr,
    action,
    timestamp,
    at: timestamp,
    receivedAt: timestamp,
    scheduledAt: timestamp,
    lastScheduledAt: timestamp,
  };
}

function repository(fullName, overrides = {}) {
  return {
    full_name: fullName,
    name: fullName.split("/").at(-1),
    archived: false,
    fork: false,
    created_at: iso(NOW - 365 * DAY_MS),
    pushed_at: iso(NOW - 2 * DAY_MS),
    updated_at: iso(NOW - 2 * DAY_MS),
    ...overrides,
  };
}

function pullRequest(repo, number, ageDays = 2, overrides = {}) {
  const openedAt = NOW - ageDays * DAY_MS;
  return {
    repo,
    number,
    title: `${repo} #${number}`,
    state: "open",
    draft: false,
    created_at: iso(openedAt),
    opened_at: iso(openedAt),
    updated_at: iso(openedAt),
    repository: { full_name: repo },
    base: { repo: { full_name: repo } },
    ...overrides,
  };
}

test("normalizeRepo prefixes bare repository names and rejects non-owner paths", () => {
  assert.equal(normalizeRepo("fleet-runtime"), "M1Vj/fleet-runtime");
  assert.equal(normalizeRepo("M1Vj/fleet-fixture"), "M1Vj/fleet-fixture");
  assert.throws(() => normalizeRepo("octocat/fleet-fixture"));
  assert.throws(() => normalizeRepo("M1Vj/../outside"));
});

test("validateTrigger accepts schedule, manual, and valid repository_dispatch payloads", () => {
  const schedule = validateTrigger(
    triggerPayload({
      event: "schedule",
      action: "schedule",
      delivery: "schedule-1",
      repo: "M1Vj/fleet-runtime",
      pr: null,
    }),
  );
  assert.equal(schedule.event, "schedule");
  assert.equal(schedule.repo, "M1Vj/fleet-runtime");
  assert.ok(schedule.pr === null || schedule.pr === undefined);

  const manual = validateTrigger(
    triggerPayload({
      event: "workflow_dispatch",
      action: "manual",
      delivery: "manual-1",
      repo: "fleet-runtime",
      pr: "7",
    }),
  );
  assert.equal(manual.event, "workflow_dispatch");
  assert.equal(manual.repo, "M1Vj/fleet-runtime");
  assert.equal(manual.pr, 7);

  const dispatchPayload = {
    event: "repository_dispatch",
    event_name: "repository_dispatch",
    type: "repository_dispatch",
    action: "fleet-pr",
    delivery: "dispatch-1",
    repository: { full_name: "M1Vj/fleet-runtime" },
    client_payload: {
      event: "pull_request",
      action: "opened",
      repo: "fleet-fixture",
      pr: 18,
      delivery: "dispatch-1",
    },
  };
  const dispatch = validateTrigger(dispatchPayload);
  assert.equal(dispatch.event, "repository_dispatch");
  assert.equal(dispatch.repo, OWNER_REPO);
  assert.equal(dispatch.pr, 18);
  assert.equal(dispatch.action, "opened");
});

test("validateTrigger rejects foreign repositories, invalid PR numbers, unknown actions, and oversized strings", () => {
  assert.throws(() => validateTrigger(triggerPayload({ repo: "octocat/fleet-fixture" })));

  for (const pr of [0, -1, 1.5, "not-a-number"]) {
    assert.throws(() => validateTrigger(triggerPayload({ pr })));
  }

  assert.throws(() => validateTrigger(triggerPayload({ action: "unknown-action" })));

  const oversized = "x".repeat(10_000);
  assert.throws(() => validateTrigger(triggerPayload({ repo: `M1Vj/${oversized}` })));
  assert.throws(() => validateTrigger(triggerPayload({ action: oversized })));
  assert.throws(() => validateTrigger(triggerPayload({ delivery: oversized })));
});

test("validateTask normalizes valid review and upgrade tasks and enforces the task schema", () => {
  const review = validateTask({
    id: "review-1",
    type: "review",
    role: "security",
    repo: "fleet-fixture",
    pr: 42,
  });
  assert.equal(review.id, "review-1");
  assert.equal(review.type, "review");
  assert.equal(review.role, "security");
  assert.equal(review.repo, OWNER_REPO);
  assert.equal(review.pr, 42);

  const upgrade = validateTask({
    type: "upgrade",
    role: "upgrade",
    repo: "M1Vj/fleet-runtime",
  });
  assert.equal(upgrade.type, "upgrade");
  assert.equal(upgrade.role, "upgrade");
  assert.equal(upgrade.repo, "M1Vj/fleet-runtime");
  assert.ok(upgrade.pr === null || upgrade.pr === undefined);

  const base = { repo: OWNER_REPO, pr: 42 };
  assert.throws(() => validateTask({ ...base, type: "audit", role: "review" }));
  assert.throws(() => validateTask({ ...base, type: "review", role: "untrusted" }));
  assert.throws(() => validateTask({ ...base, type: "review", role: "security", repo: "octocat/repo" }));
  assert.throws(() => validateTask({ ...base, type: "review", role: "security", pr: 0 }));
  assert.throws(() => validateTask({ repo: OWNER_REPO, type: "upgrade", role: "upgrade", pr: 3 }));
});

test("shouldScheduleImmediate dedupes delivery and recent repo/PR/action while allowing TTL expiry", () => {
  const trigger = validateTrigger(
    triggerPayload({
      event: "pull_request",
      action: "opened",
      delivery: "delivery-42",
      repo: OWNER_REPO,
      pr: 42,
    }),
  );

  assert.equal(shouldScheduleImmediate(trigger, [], NOW), true);
  assert.equal(
    shouldScheduleImmediate(
      trigger,
      [historyEntry({ delivery: "delivery-42", repo: "M1Vj/other", pr: 1, action: "other" })],
      NOW,
    ),
    false,
  );
  assert.equal(
    shouldScheduleImmediate(
      trigger,
      [historyEntry({ delivery: "different-delivery", at: NOW - 5 * MINUTE_MS })],
      NOW,
    ),
    false,
  );
  assert.equal(
    shouldScheduleImmediate(
      trigger,
      [historyEntry({ delivery: "different-delivery", at: NOW - 11 * MINUTE_MS })],
      NOW,
    ),
    true,
  );
});

test("buildFleetPlan preserves the explicitly triggered PR, stays within 15 tasks, revisits aged PRs, and emits unique owner tasks", () => {
  const opened = pullRequest(OWNER_REPO, 42, 0.01);
  const older = pullRequest(OWNER_REPO, 7, 90);
  const runtimePr = pullRequest("M1Vj/fleet-runtime", 8, 120);
  const foreignPr = pullRequest("octocat/foreign", 9, 180);
  const trigger = validateTrigger(
    triggerPayload({
      event: "pull_request",
      action: "opened",
      delivery: "delivery-opened-42",
      repo: OWNER_REPO,
      pr: opened.number,
    }),
  );

  const plan = buildFleetPlan({
    repos: [
      repository(OWNER_REPO),
      repository("M1Vj/fleet-runtime"),
      repository("M1Vj/ordinary"),
      repository("octocat/foreign"),
    ],
    pulls: [opened, older, runtimePr, foreignPr],
    history: [
      {
        repo: OWNER_REPO,
        pr: older.number,
        visitedAt: iso(NOW - 30 * DAY_MS),
      },
    ],
    targets: { tier1: [], priority: [], excluded: [] },
    now: NOW,
    trigger,
    maxAgents: 15,
    agentsPerPr: 3,
    upgradeSlots: 5,
    reviewRoles: ["review", "tests", "security"],
    rng: () => 0.5,
  });

  const tasks = plan.allTasks ?? plan.include ?? plan.tasks;
  assert.ok(Array.isArray(tasks));
  assert.ok(tasks.length <= 15);
  assert.equal(tasks[0].repo, OWNER_REPO);
  assert.equal(tasks[0].pr, opened.number);
  assert.equal(tasks[0].triggered, true);
  assert.ok(tasks.some((task) => task.repo === OWNER_REPO && task.pr === older.number));
  assert.ok(tasks.some((task) => task.repo === "M1Vj/fleet-runtime" && task.pr === runtimePr.number));
  assert.ok(tasks.every((task) => String(task.repo).startsWith("M1Vj/")));

  const identities = tasks.map((task) =>
    task.id ?? [task.type, task.repo, task.pr ?? task.number ?? "", task.role ?? ""].join("|"),
  );
  assert.equal(new Set(identities).size, identities.length);
  for (const task of tasks) validateTask(task);

  const scheduleTrigger = validateTrigger(
    triggerPayload({
      event: "schedule",
      action: "schedule",
      delivery: "schedule-1",
      repo: "M1Vj/fleet-runtime",
      pr: null,
    }),
  );
  const schedulePlan = buildFleetPlan({
    repos: [repository("M1Vj/fleet-runtime")],
    pulls: [runtimePr],
    history: [
      {
        repo: runtimePr.repo,
        pr: runtimePr.number,
        visitedAt: iso(NOW - 30 * DAY_MS),
      },
    ],
    now: NOW,
    trigger: scheduleTrigger,
    maxAgents: 1,
    agentsPerPr: 1,
    upgradeSlots: 0,
  });
  assert.ok(schedulePlan.tasks.some((task) => task.repo === runtimePr.repo && task.pr === runtimePr.number));
});

test("upgrade dispatch targets the fleet-runtime workflow while scoping the target repo input", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-dispatch-"));
  const workflowPath = path.join(root, "improve.yml");
  writeFileSync(
    workflowPath,
    [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      repo:",
      "        description: target repository",
      "        type: string",
    ].join("\n"),
  );
  const calls = [];
  try {
    const result = await orchestrate.executeTask(
      { id: "upgrade-target", type: "upgrade", role: "upgrade", repo: OWNER_REPO },
      {
        workflowPath,
        env: { RUNNER_TEMP: root, FLEET_ARTIFACT_DIR: path.join(root, "fleet-task-results") },
        ghClient(args) {
          calls.push(args);
          return null;
        },
      },
    );
    assert.equal(result.status, "dispatched");
    assert.deepEqual(calls, [[
      "workflow",
      "run",
      "improve.yml",
      "-R",
      "M1Vj/fleet-runtime",
      "-f",
      `repo=${OWNER_REPO}`,
    ]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task artifacts honor an explicit runner-temp directory and reject traversal", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-artifact-"));
  const task = { id: "artifact-target", type: "upgrade", role: "upgrade", repo: OWNER_REPO };
  try {
    const explicit = path.join(root, "custom-results");
    const artifact = orchestrate.writeTaskArtifact(
      task,
      { status: "deferred", reason: "test" },
      { RUNNER_TEMP: root, FLEET_ARTIFACT_DIR: explicit },
    );
    assert.equal(path.dirname(artifact), explicit);
    assert.equal(JSON.parse(readFileSync(artifact, "utf8")).status, "deferred");
    assert.throws(() => orchestrate.writeTaskArtifact(
      task,
      { status: "deferred" },
      { RUNNER_TEMP: root, FLEET_ARTIFACT_DIR: "../outside" },
    ));
    assert.throws(() => orchestrate.writeTaskArtifact(
      task,
      { status: "deferred" },
      { RUNNER_TEMP: root, FLEET_ARTIFACT_DIR: path.join(os.tmpdir(), "outside-fleet-results") },
    ));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planFleet reserves three upgrades for scans and one for repository-dispatch PR events", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-upgrade-reservation-"));
  const repository = {
    full_name: "M1Vj/upgrade-target",
    name: "upgrade-target",
    archived: false,
    fork: false,
  };
  const ghClient = (args) => {
    const endpoint = String(args.at(-1) ?? "");
    if (endpoint.includes("/user/repos")) return [repository];
    if (endpoint.includes("/repos/M1Vj/upgrade-target/pulls")) return [];
    return null;
  };
  const runPlan = async (env) => {
    const captured = [];
    await orchestrate.planFleet({
      env: { ...env, FLEET_STATE_ROOT: root },
      ghClient,
      logger: () => {},
      planBuilder(input) {
        captured.push(input);
        return { allTasks: [] };
      },
    });
    return captured[0]?.minimumUpgradeSlots;
  };
  try {
    assert.equal(
      await runPlan({
        FLEET_EVENT_NAME: "schedule",
        FLEET_EVENT_ACTION: "schedule",
        FLEET_EVENT_PAYLOAD: "{}",
      }),
      3,
    );
    assert.equal(
      await runPlan({
        FLEET_EVENT_NAME: "workflow_dispatch",
        FLEET_EVENT_ACTION: "manual",
        FLEET_EVENT_PAYLOAD: "{}",
      }),
      3,
    );
    assert.equal(
      await runPlan({
        FLEET_EVENT_NAME: "repository_dispatch",
        FLEET_EVENT_ACTION: "fleet-pr",
        FLEET_EVENT_PAYLOAD: JSON.stringify({
          event: "pull_request",
          action: "opened",
          repo: "upgrade-target",
          pr: 18,
          delivery: "upgrade-reservation-18",
        }),
      }),
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable planning suppresses duplicate delivery across separate processes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-dedupe-"));
  const repository = {
    full_name: "M1Vj/dedupe-target",
    name: "dedupe-target",
    archived: false,
    fork: false,
  };
  const ghClient = (args) => {
    const endpoint = String(args.at(-1) ?? "");
    if (endpoint.includes("/user/repos")) return [repository];
    if (endpoint.includes("/repos/M1Vj/dedupe-target/pulls")) return [];
    return null;
  };
  const env = {
    FLEET_STATE_ROOT: root,
    FLEET_EVENT_NAME: "repository_dispatch",
    FLEET_EVENT_ACTION: "fleet-pr",
    FLEET_EVENT_PAYLOAD: JSON.stringify({
      event: "pull_request",
      action: "opened",
      repo: "dedupe-target",
      pr: 7,
      delivery: "duplicate-delivery-7",
    }),
  };
  try {
    const first = await orchestrate.planFleet({ env, ghClient, logger: () => {} });
    const modulePath = path.join(process.cwd(), "scripts", "orchestrate.mjs");
    const childSource = `
      import * as orchestrate from ${JSON.stringify(modulePath)};
      const env = ${JSON.stringify(env)};
      const repository = ${JSON.stringify(repository)};
      const ghClient = (args) => {
        const endpoint = String(args.at(-1) ?? "");
        if (endpoint.includes("/user/repos")) return [repository];
        if (endpoint.includes("/repos/M1Vj/dedupe-target/pulls")) return [];
        return null;
      };
      const result = await orchestrate.planFleet({ env, ghClient, logger: () => {} });
      process.stdout.write(JSON.stringify(result));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
      cwd: process.cwd(),
      env: { ...process.env, FLEET_STATE_ROOT: root },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    const second = JSON.parse(child.stdout);
    assert.ok(first.include.length > 0, "the first delivery must be planned");
    assert.deepEqual(second.include, [], "the same delivery must be suppressed after a separate process run");
    const state = loadOrchestrationState(root);
    assert.equal(new Set(state.outbox.map((row) => row.effectKey).filter(Boolean)).size, first.include.length);
    assert.equal(state.history.filter((row) => row.event === "planned").length, first.include.length);
    assert.equal(first.include[0].workKey, stableWorkKey(first.include[0]));
    assert.equal(first.include[0].effectKey, stableEffectKey(first.include[0]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work lifecycle rejects downgrades and exposes explicit unknown-effect recovery", () => {
  const base = {
    workKey: "work-v1-test",
    effectKey: "effect-v1-test",
    generation: 0,
    state: "awaiting_receipt",
  };
  assert.equal(canTransition("awaiting_receipt", "unknown_effect"), true);
  assert.equal(canTransition("completed", "executing"), false);
  const unknown = transitionWorkState(base, "unknown_effect", { reason: "runner-crash" });
  assert.equal(unknown.status, "unknown_effect");
  assert.throws(() => transitionWorkState(unknown, "executing"), /illegal state transition/);
  const recovered = transitionWorkState(unknown, "recovering");
  assert.equal(recovered.generation, 1);
});

test("effect acknowledgement is durable-before-dispatch and stale receipts are rejected", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-crash-"));
  const workflowPath = path.join(root, "improve.yml");
  writeFileSync(workflowPath, [
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      repo:",
    "        type: string",
  ].join("\n"));
  const calls = [];
  const task = { id: "crash-target", type: "upgrade", role: "upgrade", repo: OWNER_REPO };
  try {
    const result = await orchestrate.executeTask(task, {
      workflowPath,
      env: {
        FLEET_STATE_ROOT: root,
        RUNNER_TEMP: root,
        FLEET_ARTIFACT_DIR: path.join(root, "fleet-task-results"),
      },
      ghClient(args) {
        const state = loadOrchestrationState(root);
        calls.push({ args, state });
        throw new Error("receipt lost after dispatch attempt");
      },
    });
    assert.equal(result.status, "deferred");
    assert.equal(result.effectState, "unknown_effect");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].state.outbox.length, 1, "outbox must be committed before dispatch");
    assert.equal(calls[0].state.history.some((row) => row.event === "effect_prepared"), true);
    const current = loadOrchestrationState(root).records.find((row) => row.workKey === stableWorkKey(task));
    assert.equal(current.state, "unknown_effect");
    const receipt = applyEffectReceipt(root, {
      workKey: current.workKey,
      effectKey: current.effectKey,
      generation: current.generation - 1,
      status: "acknowledged",
    });
    assert.equal(receipt.accepted, false);
    assert.equal(receipt.reason, "late-receipt");
    assert.equal(loadOrchestrationState(root).records.find((row) => row.workKey === current.workKey).state, "unknown_effect");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepted workflow dispatch remains awaiting receipt until goal-bound evidence arrives", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-dispatch-receipt-"));
  const workflowPath = path.join(root, "improve.yml");
  writeFileSync(workflowPath, [
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      repo:",
    "        type: string",
  ].join("\n"));
  const task = { id: "receipt-target", type: "upgrade", role: "upgrade", repo: OWNER_REPO };
  try {
    const result = await orchestrate.executeTask(task, {
      workflowPath,
      env: {
        FLEET_STATE_ROOT: root,
        RUNNER_TEMP: root,
        FLEET_ARTIFACT_DIR: path.join(root, "fleet-task-results"),
      },
      ghClient() {
        return { runId: "run-123" };
      },
    });
    assert.equal(result.status, "dispatched");
    assert.equal(result.effectState, "awaiting_receipt");
    const replay = await orchestrate.executeTask(task, {
      workflowPath,
      env: {
        FLEET_STATE_ROOT: root,
        RUNNER_TEMP: root,
        FLEET_ARTIFACT_DIR: path.join(root, "fleet-task-results"),
      },
      ghClient() {
        throw new Error("duplicate dispatch must be suppressed");
      },
    });
    assert.equal(replay.status, "duplicate");
    assert.equal(replay.reason, "effect-in-flight");
    const current = loadOrchestrationState(root).records.find((row) => row.workKey === stableWorkKey(task));
    assert.equal(current.state, "awaiting_receipt");
    assert.equal(result.processSuccess, true);
    assert.equal(result.desiredTaskCompleted, false);
    assert.equal(result.semanticStatus, "AWAITING_RECEIPT");
    const incomplete = applyEffectReceipt(root, {
      workKey: current.workKey,
      effectKey: current.effectKey,
      generation: current.generation,
      status: "completed",
    });
    assert.equal(incomplete.accepted, false);
    assert.equal(incomplete.reason, "receipt-evidence-missing");
    const complete = applyEffectReceipt(root, {
      workKey: current.workKey,
      effectKey: current.effectKey,
      generation: current.generation,
      status: "completed",
      receiptId: "receipt-123",
      goal: current.receiptBinding.goal,
      session: current.receiptBinding.session,
      artifact: current.receiptBinding.artifact,
      checks: current.receiptBinding.checks,
      verifier: current.receiptBinding.verifier,
    });
    assert.equal(complete.accepted, true);
    assert.equal(loadOrchestrationState(root).records.find((row) => row.workKey === current.workKey).state, "completed");

    const noRunTask = { id: "no-run-id-target", type: "upgrade", role: "upgrade", repo: "M1Vj/no-run-id" };
    const noRun = await orchestrate.executeTask(noRunTask, {
      workflowPath,
      env: {
        FLEET_STATE_ROOT: root,
        RUNNER_TEMP: root,
        FLEET_ARTIFACT_DIR: path.join(root, "fleet-task-results"),
      },
      ghClient() {
        return null;
      },
    });
    assert.equal(noRun.status, "dispatched");
    assert.equal(noRun.effectState, "unknown_effect");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given a duplicate delivery, when execution is replayed, then process success never becomes semantic SUCCESS", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-duplicate-semantics-"));
  const workflowPath = path.join(root, "improve.yml");
  writeFileSync(workflowPath, [
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      repo:",
    "        type: string",
  ].join("\n"));
  const task = { id: "duplicate-semantics", type: "upgrade", role: "upgrade", repo: OWNER_REPO };
  const env = {
    FLEET_STATE_ROOT: root,
    RUNNER_TEMP: root,
    FLEET_ARTIFACT_DIR: path.join(root, "fleet-task-results"),
  };
  try {
    const first = await orchestrate.executeTask(task, {
      workflowPath,
      env,
      ghClient: () => ({ runId: "run-duplicate" }),
    });
    assert.equal(first.processSuccess, true);
    assert.equal(first.desiredTaskCompleted, false);
    const replay = await orchestrate.executeTask(task, {
      workflowPath,
      env,
      ghClient: () => { throw new Error("duplicate dispatch must not run"); },
    });
    assert.equal(replay.status, "duplicate");
    assert.equal(replay.processSuccess, true);
    assert.equal(replay.desiredTaskCompleted, false);
    assert.equal(replay.semanticStatus, "DUPLICATE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given deferred, no-op, and awaiting-receipt stages, when the envelope is built, then only a completed receipt is SUCCESS", () => {
  const cases = [
    ["accepted", "ACCEPTED"],
    ["deferred", "DEFERRED"],
    ["no_op", "NO_OP"],
    ["awaiting_receipt", "AWAITING_RECEIPT"],
  ];
  for (const [status, semanticStatus] of cases) {
    const envelope = orchestrate.describeOutcome({ status, effectState: status });
    assert.equal(envelope.processSuccess, true);
    assert.equal(envelope.desiredTaskCompleted, false);
    assert.equal(envelope.semanticStatus, semanticStatus);
  }
  const success = orchestrate.describeOutcome({ status: "completed", effectState: "completed" });
  assert.equal(success.processSuccess, true);
  assert.equal(success.desiredTaskCompleted, true);
  assert.equal(success.semanticStatus, "SUCCESS");
});

test("Given a valid receipt, when goal, session, generation, artifact, check, or verifier drifts, then completion is rejected", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-receipt-binding-"));
  const task = { id: "receipt-binding", type: "review", role: "review", repo: OWNER_REPO, pr: 51 };
  const env = {
    FLEET_STATE_ROOT: root,
    RUNNER_TEMP: root,
    FLEET_ARTIFACT_DIR: path.join(root, "fleet-task-results"),
  };
  try {
    const result = await orchestrate.executeTask(task, {
      env,
      ghClient(args) {
        const endpoint = String(args.at(-1) ?? "");
        if (endpoint.includes("/pulls/51")) return { number: 51, state: "open", base: { ref: "main" } };
        return { default_branch: "main" };
      },
      modelRunner: async () => ({ complete: true, reply: "bounded review evidence", modelMode: "test" }),
    });
    const record = loadOrchestrationState(root).records.find((row) => row.workKey === stableWorkKey(task));
    assert.equal(record.state, "awaiting_receipt");
    const binding = record.receiptBinding;
    assert.ok(binding);
    const base = {
      workKey: record.workKey,
      effectKey: record.effectKey,
      generation: record.generation,
      receiptId: "receipt-binding-51",
      status: "completed",
      ...binding,
    };
    assert.equal(applyEffectReceipt(root, base).accepted, true);
    for (const [field, value] of [
      ["goal", "review M1Vj/other#51"],
      ["session", "session-drift"],
      ["generation", record.generation + 1],
      ["artifact", "artifact-drift"],
      ["checks", ["check-drift"]],
      ["verifier", "verifier-drift"],
    ]) {
      const isolatedRoot = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-receipt-binding-case-"));
      try {
        const isolated = await orchestrate.executeTask(task, {
          env: { ...env, RUNNER_TEMP: isolatedRoot, FLEET_STATE_ROOT: isolatedRoot, FLEET_ARTIFACT_DIR: path.join(isolatedRoot, "fleet-task-results") },
          ghClient(args) {
            const endpoint = String(args.at(-1) ?? "");
            if (endpoint.includes("/pulls/51")) return { number: 51, state: "open", base: { ref: "main" } };
            return { default_branch: "main" };
          },
          modelRunner: async () => ({ complete: true, reply: "bounded review evidence", modelMode: "test" }),
        });
        const current = loadOrchestrationState(isolatedRoot).records.find((row) => row.workKey === stableWorkKey(task));
        const receipt = { ...base, workKey: current.workKey, effectKey: current.effectKey, generation: current.generation, ...current.receiptBinding };
        receipt[field] = value;
        const rejected = applyEffectReceipt(isolatedRoot, receipt);
        assert.equal(rejected.accepted, false, `${field} drift must reject`);
        assert.ok(["receipt-binding-mismatch", "late-receipt"].includes(rejected.reason), `${field} drift reason`);
        assert.equal(loadOrchestrationState(isolatedRoot).records.find((row) => row.workKey === current.workKey).state, "awaiting_receipt");
        assert.equal(isolated.processSuccess, true);
      } finally {
        rmSync(isolatedRoot, { recursive: true, force: true });
      }
    }
    assert.equal(result.desiredTaskCompleted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given the public orchestrate workflow, when it consumes a result, then effectState is required and the exact manifest is uploaded", () => {
  const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", "orchestrate.yml"), "utf8");
  assert.match(workflow, /consume structured orchestration state/i);
  assert.match(workflow, /effectState/);
  assert.match(workflow, /desiredTaskCompleted/);
  assert.match(workflow, /FLEET_PUBLIC_ARTIFACT_MANIFEST/);
  assert.match(workflow, /fleet-public-artifact-v1/);
  assert.match(workflow, /manifest\.dataClass\s*!==\s*"public"/);
  assert.doesNotMatch(workflow, />\s*\"?\$FLEET_PUBLIC_ARTIFACT_MANIFEST/);
  assert.match(workflow, /--output-file\s+\"\$FLEET_RESULT_FILE\"/);
  assert.doesNotMatch(workflow, />\s*\"?\$FLEET_RESULT_FILE/);
  assert.match(workflow, /path:\s*\$\{\{\s*runner\.temp\s*\}\}\/fleet-public-state\/public-artifact\.json/);
});

test("Given a public execution, when a task artifact is emitted, then only the canonical sanitized manifest is written", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-public-manifest-"));
  const stateRoot = path.join(root, "state");
  const manifest = path.join(stateRoot, "public-artifact.json");
  const env = {
    FLEET_DATA_CLASS: "public",
    FLEET_PUBLIC_OWNER: "M1Vj",
    FLEET_PUBLIC_REPOSITORY: OWNER_REPO,
    FLEET_PUBLIC_STATE_ROOT: stateRoot,
    FLEET_STATE_ROOT: stateRoot,
    FLEET_PUBLIC_ARTIFACT_MANIFEST: manifest,
    RUNNER_TEMP: root,
    GITHUB_RUN_ID: "12345",
    FLEET_ARTIFACT_DIR: path.join(root, "raw-results"),
  };
  const task = { id: "public-manifest-task", type: "review", role: "review", repo: OWNER_REPO, pr: 73 };
  try {
    const result = await orchestrate.executeTask(task, {
      env,
      ghClient(args) {
        const endpoint = String(args.at(-1) ?? "");
        if (endpoint.includes("/pulls/73")) return { number: 73, state: "open", base: { ref: "main" } };
        return { default_branch: "main" };
      },
      modelRunner: async () => ({ complete: true, reply: "public bounded review", modelMode: "test" }),
    });
    const value = JSON.parse(readFileSync(manifest, "utf8"));
    assert.equal(value.schema, "fleet-public-artifact-v1");
    assert.equal(value.dataClass, "public");
    assert.equal(value.repository, OWNER_REPO);
    assert.equal(value.runId, "12345");
    assert.equal(value.effectState, result.effectState);
    assert.equal(value.processSuccess, result.processSuccess);
    assert.equal(value.semanticStatus, result.semanticStatus);
    assert.equal(value.desiredTaskCompleted, false);
    assert.equal(value.awaitingControl, true);
    assert.equal(value.status, "awaiting-control");
    assert.equal(value.checks.effectState, result.effectState);
    assert.equal(value.checks.processSuccess, result.processSuccess);
    assert.equal(value.checks.semanticStatus, result.semanticStatus);
    assert.equal(existsSync(path.join(root, "raw-results")), false);
    assert.equal(JSON.stringify(value).includes("/raw-results/"), false);
    assert.equal(JSON.stringify(value).includes(result.workKey), false);
    assert.equal(JSON.stringify(value).includes(result.effectKey), false);
    assert.equal(JSON.stringify(value).includes(result.receiptBinding?.session || "session-v1-"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given a public review, when the model runner starts, then private auth and slots are absent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-public-model-env-"));
  const stateRoot = path.join(root, "state");
  const manifest = path.join(stateRoot, "public-artifact.json");
  const env = {
    FLEET_DATA_CLASS: "public",
    FLEET_PUBLIC_OWNER: "M1Vj",
    FLEET_PUBLIC_REPOSITORY: OWNER_REPO,
    FLEET_PUBLIC_STATE_ROOT: stateRoot,
    FLEET_STATE_ROOT: stateRoot,
    FLEET_PUBLIC_ARTIFACT_MANIFEST: manifest,
    RUNNER_TEMP: root,
    GITHUB_RUN_ID: "67890",
    GITHUB_TOKEN: "built-in-token",
    GH_TOKEN: "built-in-token",
    FLEET_GH_TOKEN: "private-gh-token",
    FLEET_OPENCODE_AUTH: "private-auth-1",
    FLEET_PROXY_URL: "http://private-proxy.invalid",
    OPENCODE_AUTH_CONTENT: "private-auth-content",
    FLEET_AUTH_COOLDOWN_MS: "60000",
    FLEET_PRIVATE_STATE_ROOT: "/private/state",
    GITHUB_WORKSPACE: "/private/workspace",
  };
  for (let slot = 2; slot <= 9; slot += 1) env[`FLEET_OPENCODE_AUTH_${slot}`] = `private-auth-${slot}`;
  const task = { id: "public-model-env-task", type: "review", role: "review", repo: OWNER_REPO, pr: 74 };
  let captured;
  try {
    await orchestrate.executeTask(task, {
      env,
      ghClient(args) {
        const endpoint = String(args.at(-1) ?? "");
        if (endpoint.includes("/pulls/74")) return { number: 74, state: "open", base: { ref: "main" } };
        return { default_branch: "main" };
      },
      modelRunner: async (options) => {
        captured = options.env;
        return { complete: true, reply: "public bounded review", modelMode: "test" };
      },
    });
    assert.ok(captured, "model runner must receive an environment");
    for (const key of [
      "FLEET_GH_TOKEN",
      "FLEET_OPENCODE_AUTH",
      "FLEET_PROXY_URL",
      "OPENCODE_AUTH_CONTENT",
      "FLEET_AUTH_COOLDOWN_MS",
      "FLEET_PRIVATE_STATE_ROOT",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_WORKSPACE",
    ]) assert.equal(captured[key], undefined, `${key} must not reach a public model runner`);
    for (let slot = 2; slot <= 9; slot += 1) {
      assert.equal(captured[`FLEET_OPENCODE_AUTH_${slot}`], undefined, `private auth slot ${slot} must be removed`);
    }
    assert.equal(captured.FLEET_DATA_CLASS, "public");
    assert.equal(captured.FLEET_PUBLIC_OWNER, "M1Vj");
    assert.equal(captured.FLEET_PUBLIC_REPOSITORY, OWNER_REPO);
    assert.equal(captured.FLEET_PUBLIC_STATE_ROOT, stateRoot);
    assert.equal(captured.FLEET_STATE_ROOT, stateRoot);
    assert.equal(captured.FLEET_PUBLIC_ARTIFACT_MANIFEST, manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given an unsafe public state-root override, when execution starts, then it fails before any durable write", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-public-state-fence-"));
  const unsafe = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-unsafe-state-"));
  const stateRoot = path.join(root, "fleet-public-state");
  const manifest = path.join(stateRoot, "public-artifact.json");
  const baseEnv = {
    FLEET_DATA_CLASS: "public",
    FLEET_PUBLIC_OWNER: "M1Vj",
    FLEET_PUBLIC_REPOSITORY: OWNER_REPO,
    FLEET_PUBLIC_STATE_ROOT: stateRoot,
    FLEET_STATE_ROOT: stateRoot,
    FLEET_PUBLIC_ARTIFACT_MANIFEST: manifest,
    RUNNER_TEMP: root,
    GITHUB_RUN_ID: "89012",
  };
  const task = { id: "public-state-fence-task", type: "review", role: "review", repo: OWNER_REPO, pr: 76 };
  try {
    await assert.rejects(
      orchestrate.executeTask(task, { env: { ...baseEnv, FLEET_STATE_ROOT: unsafe }, stateRoot: undefined }),
      /public state root mismatch: FLEET_STATE_ROOT/,
    );
    assert.equal(existsSync(path.join(unsafe, "state")), false);
    assert.equal(existsSync(stateRoot), false);

    await assert.rejects(
      orchestrate.executeTask(task, { env: baseEnv, stateRoot: unsafe }),
      /public state root mismatch: stateRoot/,
    );
    assert.equal(existsSync(path.join(unsafe, "state")), false);
    assert.equal(existsSync(stateRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(unsafe, { recursive: true, force: true });
  }
});

test("Given an unsafe public planning root, when planning starts, then no builder or scheduler write runs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-public-plan-fence-"));
  const unsafe = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-unsafe-plan-"));
  const stateRoot = path.join(root, "fleet-public-state");
  const env = {
    FLEET_DATA_CLASS: "public",
    FLEET_PUBLIC_OWNER: "M1Vj",
    FLEET_PUBLIC_REPOSITORY: OWNER_REPO,
    FLEET_PUBLIC_STATE_ROOT: stateRoot,
    FLEET_STATE_ROOT: unsafe,
    FLEET_PUBLIC_ARTIFACT_MANIFEST: path.join(stateRoot, "public-artifact.json"),
    RUNNER_TEMP: root,
    FLEET_EVENT_NAME: "schedule",
    FLEET_EVENT_ACTION: "schedule",
    FLEET_EVENT_PAYLOAD: "{}",
  };
  let builderCalled = false;
  try {
    await assert.rejects(
      orchestrate.planFleet({
        env,
        stateRoot: unsafe,
        ghClient: () => { throw new Error("planning must stop before GitHub access"); },
        planBuilder: () => {
          builderCalled = true;
          return { allTasks: [] };
        },
      }),
      /public state root mismatch: FLEET_STATE_ROOT/,
    );
    assert.equal(builderCalled, false);
    assert.equal(existsSync(path.join(unsafe, "state")), false);
    assert.equal(existsSync(stateRoot), false);

    const symlinkRoot = path.join(root, "fleet-public-state-link");
    symlinkSync(unsafe, symlinkRoot, "dir");
    const symlinkEnv = { ...env, FLEET_PUBLIC_STATE_ROOT: symlinkRoot, FLEET_STATE_ROOT: symlinkRoot };
    await assert.rejects(
      orchestrate.planFleet({
        env: symlinkEnv,
        ghClient: () => { throw new Error("planning must stop before GitHub access"); },
        planBuilder: () => ({ allTasks: [] }),
      }),
      /public state root resolves outside RUNNER_TEMP/,
    );
    assert.equal(existsSync(path.join(unsafe, "state")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(unsafe, { recursive: true, force: true });
  }
});

test("Given pre-JSON terminal telemetry, when execute writes a result file, then capacity output stays parseable", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-result-file-"));
  const stateRoot = path.join(root, "state");
  const resultFile = path.join(root, "orchestrate-result.json");
  const manifest = path.join(stateRoot, "public-artifact.json");
  const retryAt = "2026-09-14T01:00:00.000Z";
  const env = {
    FLEET_DATA_CLASS: "public",
    FLEET_PUBLIC_OWNER: "M1Vj",
    FLEET_PUBLIC_REPOSITORY: OWNER_REPO,
    FLEET_PUBLIC_STATE_ROOT: stateRoot,
    FLEET_STATE_ROOT: stateRoot,
    FLEET_PUBLIC_ARTIFACT_MANIFEST: manifest,
    RUNNER_TEMP: root,
    GITHUB_RUN_ID: "78901",
  };
  const taskArgs = [
    "execute",
    "--repo", OWNER_REPO,
    "--pr", "75",
    "--type", "review",
    "--role", "review",
    "--output-file", resultFile,
  ];
  try {
    const code = await orchestrate.main(taskArgs, env, {
      ghClient(args) {
        const endpoint = String(args.at(-1) ?? "");
        if (endpoint.includes("/pulls/75")) return { number: 75, state: "open", base: { ref: "main" } };
        return { default_branch: "main" };
      },
      modelRunner: async () => {
        process.stdout.write("TERMINAL_STATE=STALLED\n");
        return { complete: false, error: "quota exhausted", retryAt };
      },
    });
    assert.equal(code, 0, "deferred capacity should not fail the process");
    const result = JSON.parse(readFileSync(resultFile, "utf8"));
    assert.equal(result.status, "deferred");
    assert.equal(result.effectState, "waiting_for_capacity");
    assert.equal(result.semanticStatus, "DEFERRED");
    assert.equal(result.processSuccess, true);
    assert.equal(result.desiredTaskCompleted, false);
    assert.equal(result.retryAt, retryAt);
    assert.equal(JSON.stringify(result).includes("TERMINAL_STATE=STALLED"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown effect is not replayed until an explicit desired recovery is provided", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-reconcile-"));
  const workflowPath = path.join(root, "improve.yml");
  writeFileSync(workflowPath, [
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      repo:",
    "        type: string",
  ].join("\n"));
  const task = { id: "unknown-recovery-target", type: "upgrade", role: "upgrade", repo: OWNER_REPO };
  const env = {
    FLEET_STATE_ROOT: root,
    RUNNER_TEMP: root,
    FLEET_ARTIFACT_DIR: path.join(root, "fleet-task-results"),
  };
  const ghClient = (args) => {
    const endpoint = String(args.at(-1) ?? "");
    if (endpoint.includes("/user/repos")) return [{ full_name: OWNER_REPO, name: OWNER_REPO.split("/").at(-1), archived: false, fork: false }];
    if (endpoint.includes(`/repos/${OWNER_REPO}/pulls`)) return [];
    throw new Error("dispatch-effect-uncertain");
  };
  try {
    const first = await orchestrate.executeTask(task, { workflowPath, env, ghClient });
    assert.equal(first.effectState, "unknown_effect");
    const before = loadOrchestrationState(root).records.find((row) => row.workKey === stableWorkKey(task));
    assert.equal(before.state, "unknown_effect");
    const planned = await orchestrate.planFleet({
      env: {
        ...env,
        FLEET_EVENT_NAME: "schedule",
        FLEET_EVENT_ACTION: "schedule",
        FLEET_EVENT_PAYLOAD: "{}",
      },
      ghClient,
      logger: () => {},
    });
    assert.deepEqual(planned.include, [], "schedule must not replay an unknown external effect");
    const stillUnknown = loadOrchestrationState(root).records.find((row) => row.workKey === stableWorkKey(task));
    assert.equal(stillUnknown.state, "unknown_effect");

    const stateDirectory = path.join(root, "state");
    writeFileSync(path.join(stateDirectory, "orchestrate-desired.json"), JSON.stringify({ tasks: [{ ...task, desiredState: "active" }] }));
    const recoveredPlan = await orchestrate.planFleet({
      env: {
        ...env,
        FLEET_EVENT_NAME: "schedule",
        FLEET_EVENT_ACTION: "schedule",
        FLEET_EVENT_PAYLOAD: "{}",
      },
      ghClient,
      logger: () => {},
    });
    assert.ok(recoveredPlan.include.length > 0);
    const recovered = loadOrchestrationState(root).records.find((row) => row.workKey === stableWorkKey(task));
    assert.equal(recovered.state, "registered");
    assert.equal(recovered.generation, before.generation + 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model capacity exhaustion waits durably and resumes the same generation after retryAt", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-capacity-"));
  const task = { id: "capacity-target", type: "review", role: "tests", repo: OWNER_REPO, pr: 9 };
  const retryAt = "2026-09-13T00:01:00.000Z";
  const env = {
    FLEET_STATE_ROOT: root,
    RUNNER_TEMP: root,
    FLEET_ARTIFACT_DIR: path.join(root, "fleet-task-results"),
  };
  try {
    const exhausted = await orchestrate.executeTask(task, {
      env,
      ghClient(args) {
        const endpoint = String(args.at(-1) ?? "");
        if (endpoint.includes("/pulls/9")) return { number: 9, state: "open", base: { ref: "main" } };
        return { default_branch: "main" };
      },
      modelRunner: async () => ({ complete: false, error: "quota exhausted", retryAt }),
    });
    assert.equal(exhausted.effectState, "waiting_for_capacity");
    const waiting = loadOrchestrationState(root).records.find((row) => row.workKey === stableWorkKey(task));
    assert.equal(waiting.state, "waiting_for_capacity");
    assert.equal(waiting.retryAt, retryAt);

    writeFileSync(path.join(root, "state", "orchestrate-desired.json"), JSON.stringify({ tasks: [{ ...task, desiredState: "active" }] }));
    const beforeDue = await orchestrate.planFleet({
      env: {
        ...env,
        FLEET_EVENT_NAME: "schedule",
        FLEET_EVENT_ACTION: "schedule",
        FLEET_EVENT_PAYLOAD: "{}",
        FLEET_NOW: "2026-09-13T00:00:30.000Z",
      },
      now: Date.parse("2026-09-13T00:00:30.000Z"),
      ghClient(args) {
        const endpoint = String(args.at(-1) ?? "");
        if (endpoint.includes("/user/repos")) return [{ full_name: OWNER_REPO, name: OWNER_REPO.split("/").at(-1), archived: false, fork: false }];
        return [];
      },
      logger: () => {},
    });
    assert.equal(beforeDue.include.some((entry) => entry.workKey === waiting.workKey), false);

    const afterDue = await orchestrate.planFleet({
      env: {
        ...env,
        FLEET_EVENT_NAME: "schedule",
        FLEET_EVENT_ACTION: "schedule",
        FLEET_EVENT_PAYLOAD: "{}",
      },
      now: Date.parse("2026-09-13T00:02:00.000Z"),
      ghClient(args) {
        const endpoint = String(args.at(-1) ?? "");
        if (endpoint.includes("/user/repos")) return [{ full_name: OWNER_REPO, name: OWNER_REPO.split("/").at(-1), archived: false, fork: false }];
        return [];
      },
      logger: () => {},
    });
    assert.ok(afterDue.include.length > 0);
    const resumed = loadOrchestrationState(root).records.find((row) => row.workKey === stableWorkKey(task));
    assert.equal(resumed.generation, waiting.generation);
    assert.equal(resumed.state, "registered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed local analysis does not complete durable work without an observed receipt", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-orch-analysis-receipt-"));
  const task = { id: "analysis-target", type: "review", role: "review", repo: OWNER_REPO, pr: 12 };
  const env = {
    FLEET_STATE_ROOT: root,
    RUNNER_TEMP: root,
    FLEET_ARTIFACT_DIR: path.join(root, "fleet-task-results"),
  };
  try {
    const result = await orchestrate.executeTask(task, {
      env,
      ghClient(args) {
        const endpoint = String(args.at(-1) ?? "");
        if (endpoint.includes("/pulls/12")) return { number: 12, state: "open", base: { ref: "main" } };
        return { default_branch: "main" };
      },
      modelRunner: async () => ({ complete: true, reply: "evidence-backed analysis", modelMode: "test" }),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.effectState, "awaiting_receipt");
    const record = loadOrchestrationState(root).records.find((row) => row.workKey === stableWorkKey(task));
    assert.equal(record.state, "awaiting_receipt");
    const receipt = applyEffectReceipt(root, {
      workKey: record.workKey,
      effectKey: record.effectKey,
      generation: record.generation,
      receiptId: "review-receipt-12",
      goal: record.receiptBinding.goal,
      session: record.receiptBinding.session,
      artifact: record.receiptBinding.artifact,
      checks: record.receiptBinding.checks,
      verifier: record.receiptBinding.verifier,
      status: "completed",
    });
    assert.equal(receipt.accepted, true);
    assert.equal(loadOrchestrationState(root).records.find((row) => row.workKey === record.workKey).state, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
