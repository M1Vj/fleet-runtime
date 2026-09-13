import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as orchestrate from "../scripts/orchestrate.mjs";
import { buildFleetPlan } from "../scripts/lib/fleet-scheduler.mjs";

const { validateTrigger, normalizeRepo, validateTask, shouldScheduleImmediate } = orchestrate;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const NOW = Date.parse("2026-09-13T00:00:00.000Z");
const OWNER_REPO = "M1Vj/fleet-control";

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
  assert.equal(normalizeRepo("M1Vj/fleet-control"), "M1Vj/fleet-control");
  assert.throws(() => normalizeRepo("octocat/fleet-control"));
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
      repo: "fleet-control",
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
  assert.throws(() => validateTrigger(triggerPayload({ repo: "octocat/fleet-control" })));

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
    repo: "fleet-control",
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
