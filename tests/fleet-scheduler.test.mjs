import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreRepository,
  weightedSampleWithoutReplacement,
  scorePullRequest,
  buildFleetPlan,
} from "../scripts/lib/fleet-scheduler.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-13T00:00:00.000Z");

function iso(at) {
  return new Date(at).toISOString();
}

function repository(fullName, overrides = {}) {
  return {
    full_name: fullName,
    name: fullName.split("/").at(-1),
    archived: false,
    fork: false,
    created_at: iso(NOW - 365 * DAY_MS),
    pushed_at: iso(NOW - 180 * DAY_MS),
    updated_at: iso(NOW - 180 * DAY_MS),
    ...overrides,
  };
}

function pullRequest(repo, number, { ageDays = 1, ...overrides } = {}) {
  const openedAt = NOW - ageDays * DAY_MS;
  return {
    repo,
    number,
    title: `Review ${repo} #${number}`,
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

function historyEntry(repo, at, pr = undefined) {
  return {
    repo,
    pr,
    selectedAt: iso(at),
    lastSelectedAt: iso(at),
    visitedAt: iso(at),
    lastVisitedAt: iso(at),
    selectionCount: 1,
  };
}

function taskRepo(task) {
  return task.repo ?? task.repository ?? task.repoFullName;
}

function taskPr(task) {
  return task.pr ?? task.pullRequest ?? task.number;
}

function taskRoles(task) {
  const roles = task.roles ?? task.reviewRoles;
  if (Array.isArray(roles)) return roles;
  return [task.role ?? task.reviewRole].filter(Boolean);
}

test("scoreRepository rewards manual tier1/priority and active, new, and recent repositories", () => {
  const baseline = repository("M1Vj/baseline");
  const dormant = repository("M1Vj/dormant", { archived: true });
  const active = repository("M1Vj/active");
  const newRepo = repository("M1Vj/new", {
    created_at: iso(NOW - 2 * DAY_MS),
  });
  const recent = repository("M1Vj/recent", {
    pushed_at: iso(NOW - 1 * DAY_MS),
    updated_at: iso(NOW - 1 * DAY_MS),
  });
  const tier1 = repository("M1Vj/tier1");
  const priority = repository("M1Vj/priority");
  const options = {
    history: [],
    targets: {
      tier1: [tier1.full_name],
      priority: [priority.full_name],
      excluded: [],
    },
    now: NOW,
  };

  assert.ok(scoreRepository(active, options) > scoreRepository(dormant, options));
  assert.ok(scoreRepository(newRepo, options) > scoreRepository(baseline, options));
  assert.ok(scoreRepository(recent, options) > scoreRepository(baseline, options));
  assert.ok(scoreRepository(tier1, options) > scoreRepository(baseline, options));
  assert.ok(scoreRepository(priority, options) > scoreRepository(baseline, options));
});

test("scoreRepository gives long-unselected repositories fairness weight while cooling recent selections without zeroing them", () => {
  const longUnselected = repository("M1Vj/long-unselected");
  const recentlySelected = repository("M1Vj/recently-selected");
  const history = [
    historyEntry(longUnselected.full_name, NOW - 120 * DAY_MS),
    historyEntry(recentlySelected.full_name, NOW - 30 * 60 * 1000),
  ];
  const options = { history, targets: { tier1: [], priority: [], excluded: [] }, now: NOW };
  const longScore = scoreRepository(longUnselected, options);
  const cooledScore = scoreRepository(recentlySelected, options);

  assert.ok(longScore > cooledScore);
  assert.ok(cooledScore > 0, "cooldown must leave a nonzero chance");
});

test("weightedSampleWithoutReplacement is deterministic with a deterministic rng and never repeats a row", () => {
  const rows = [
    { id: "alpha", weight: 1 },
    { id: "bravo", weight: 3 },
    { id: "charlie", weight: 6 },
    { id: "delta", weight: 2 },
  ];
  const values = [0.05, 0.55, 0.15, 0.9];
  const makeRng = () => {
    const sequence = [...values];
    return () => sequence.shift() ?? 0;
  };

  const first = weightedSampleWithoutReplacement(rows, rows.length, makeRng());
  const second = weightedSampleWithoutReplacement(rows, rows.length, makeRng());

  assert.equal(first.length, rows.length);
  assert.equal(new Set(first.map((row) => row.id)).size, rows.length);
  assert.deepEqual(
    second.map((row) => row.id),
    first.map((row) => row.id),
  );
});

test("scorePullRequest keeps old open PRs eligible and increases with age and time since visit", () => {
  const oldPr = pullRequest("M1Vj/aging", 7, { ageDays: 180 });
  const youngPr = pullRequest("M1Vj/aging", 8, { ageDays: 2 });
  const oldVisit = [historyEntry(oldPr.repo, NOW - 90 * DAY_MS, oldPr.number)];
  const recentVisit = [historyEntry(oldPr.repo, NOW - 30 * 60 * 1000, oldPr.number)];

  const oldScore = scorePullRequest(oldPr, { history: oldVisit, now: NOW, trigger: "schedule" });
  const recentlyVisitedScore = scorePullRequest(oldPr, {
    history: recentVisit,
    now: NOW,
    trigger: "schedule",
  });
  const youngScore = scorePullRequest(youngPr, {
    history: [],
    now: NOW,
    trigger: "schedule",
  });

  assert.ok(oldScore > 0, "old open PRs remain eligible");
  assert.ok(oldScore > recentlyVisitedScore);
  assert.ok(oldScore > youngScore);
});

test("buildFleetPlan puts an explicitly opened PR first and assigns multiple distinct review roles", () => {
  const opened = pullRequest("M1Vj/active", 42, { ageDays: 0.01 });
  const older = pullRequest("M1Vj/active", 9, { ageDays: 90 });
  const plan = buildFleetPlan({
    repos: [repository("M1Vj/active")],
    pulls: [older, opened],
    history: [],
    targets: { tier1: [], priority: [], excluded: [] },
    now: NOW,
    trigger: {
      event: "pull_request",
      type: "pull_request",
      action: "opened",
      repo: opened.repo,
      number: opened.number,
      pull_request: opened,
    },
    maxAgents: 5,
    agentsPerPr: 3,
    upgradeSlots: 0,
    rng: () => 0.5,
  });

  assert.ok(Array.isArray(plan.tasks));
  assert.ok(plan.tasks.length <= 5);
  assert.equal(taskRepo(plan.tasks[0]), opened.repo);
  assert.equal(taskPr(plan.tasks[0]), opened.number);

  const openedTasks = plan.tasks.filter(
    (task) => taskRepo(task) === opened.repo && taskPr(task) === opened.number,
  );
  const roles = new Set(openedTasks.flatMap(taskRoles));
  assert.ok(roles.size >= 2, "an opened PR needs multiple distinct review roles");
});

test("buildFleetPlan caps total tasks and selects upgrades only from eligible weighted repositories", () => {
  const preferred = repository("M1Vj/preferred");
  const ordinary = repository("M1Vj/ordinary");
  const fallback = repository("M1Vj/fallback", {
    pushed_at: iso(NOW - 200 * DAY_MS),
    updated_at: iso(NOW - 200 * DAY_MS),
  });
  const archived = repository("M1Vj/archived", { archived: true });
  const fork = repository("M1Vj/fork", { fork: true });
  const excluded = repository("M1Vj/excluded");
  const plan = buildFleetPlan({
    repos: [preferred, ordinary, fallback, archived, fork, excluded],
    pulls: [],
    history: [],
    targets: {
      tier1: [preferred.full_name],
      priority: [preferred.full_name],
      excluded: [excluded.full_name],
    },
    now: NOW,
    trigger: "schedule",
    maxAgents: 3,
    agentsPerPr: 2,
    upgradeSlots: 3,
    rng: () => 0,
  });

  assert.ok(Array.isArray(plan.tasks));
  assert.ok(Array.isArray(plan.upgrades));
  assert.ok(plan.tasks.length <= 3);
  assert.ok(plan.upgrades.length > 0);
  assert.equal(taskRepo(plan.upgrades[0]), preferred.full_name);

  const forbidden = new Set([archived.full_name, fork.full_name, excluded.full_name]);
  for (const upgrade of plan.upgrades) {
    assert.ok(!forbidden.has(taskRepo(upgrade)));
  }
});

test("buildFleetPlan reserves upgrade capacity when an old PR backlog exceeds maxAgents", () => {
  const repositories = Array.from({ length: 5 }, (_, index) => repository(`M1Vj/backlog-${index + 1}`));
  const pulls = Array.from({ length: 20 }, (_, index) => pullRequest(
    `M1Vj/backlog-${(index % repositories.length) + 1}`,
    index + 1,
    { ageDays: index + 1 },
  ));
  const plan = buildFleetPlan({
    repos: repositories,
    pulls,
    history: [],
    targets: { tier1: [], priority: [], excluded: [] },
    now: NOW,
    trigger: "schedule",
    maxAgents: 15,
    agentsPerPr: 1,
    upgradeSlots: 15,
    minimumUpgradeSlots: 3,
    rng: () => 0,
  });

  const allTasks = plan.allTasks ?? [...plan.tasks, ...plan.upgrades];
  assert.ok(allTasks.length <= 15);
  assert.ok(plan.upgrades.length >= 3, "old PR backlog must not starve upgrades");
  assert.equal(new Set(plan.upgrades.map((task) => taskRepo(task))).size, plan.upgrades.length);
  assert.ok(plan.upgrades.every((task) => taskRepo(task).startsWith("M1Vj/")));
});
