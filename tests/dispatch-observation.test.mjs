import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { observeRunnerRuns, admissionRepositories, DEEP_WORKFLOW_REPO } from "../scripts/patrol.mjs";
import { observeWatchdogRuns } from "../scripts/watchdog.mjs";
import { createAdmissionGate, ADMISSION_REFUSALS } from "../scripts/lib/dispatch-admission.mjs";
import { planDispatch, DISPATCH_DECISIONS, DISPATCH_REASONS } from "../scripts/lib/watchdog-admission.mjs";

// The single runner this plane observes. It is the only repository
// `admissionRepositories()` can resolve without private runtime configuration,
// so it is the one the observation path actually reads.
const REPO = DEEP_WORKFLOW_REPO;

// Bodies that `gh` can hand back at exit 0 while reporting nothing usable about
// occupancy. Each must read as "could not observe", never as "zero live".
const MALFORMED = [
  {
    name: "empty stdout",
    body: "",
    detail: "gh returned no stdout at all",
  },
  {
    name: "HTML rate-limit page",
    body: "<!DOCTYPE html>\n<html><body><h1>API rate limit exceeded</h1></body></html>\n",
    detail: "gh emitted an HTML error page where JSON was expected",
  },
  {
    name: "JSON object with no workflow_runs",
    body: JSON.stringify({ message: "Bad credentials", documentation_url: "https://docs.github.com/rest" }),
    detail: "gh emitted a valid JSON error envelope, not a run list",
  },
  {
    name: "bare array",
    body: JSON.stringify([{ id: 1, status: "in_progress" }]),
    detail: "gh emitted an array where the run-list envelope was expected",
  },
];

const VALID_EMPTY = JSON.stringify({ total_count: 0, workflow_runs: [] });
const VALID_BUSY = JSON.stringify({
  total_count: 1,
  workflow_runs: [{ id: 99, path: ".github/workflows/patrol.yml", status: "in_progress", created_at: "2026-09-13T00:00:00Z" }],
});

/**
 * Run `body` through the real `gh()` spawn path by putting a fake `gh` first on
 * PATH. The fake appends to `calls.log` so a passing assertion proves the
 * executable really was invoked, rather than the assertion holding because the
 * observer silently skipped its read.
 */
function withFakeGh(body, fn) {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-observe-"));
  try {
    const bin = path.join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const calls = path.join(root, "calls.log");
    const gh = path.join(bin, "gh");
    writeFileSync(
      gh,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> ' + JSON.stringify(calls),
        "cat " + JSON.stringify(path.join(root, "body.txt")),
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(gh, 0o755);
    writeFileSync(path.join(root, "body.txt"), body);
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const result = fn(env, { callCount: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length : 0) });
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a malformed gh body is reported as an unknown repository, not as an idle runner", () => {
  for (const { name, body, detail } of MALFORMED) {
    withFakeGh(body, (env, counter) => {
      const notes = [];
      const observed = observeRunnerRuns(env, (kind, text) => notes.push(`${kind}: ${text}`));

      assert.deepEqual(counter.callCount() >= 1, true, `${name}: fake gh was never invoked`);
      assert.deepEqual(
        observed.unknownRepos,
        [REPO],
        `${name}: ${detail} must make the repository unknown, got ${JSON.stringify(observed.unknownRepos)}`,
      );
      assert.deepEqual(observed.runs, [], `${name}: a malformed body must not fabricate runs`);
      assert.equal(
        notes.some((text) => text.startsWith("dispatch-observe:")),
        true,
        `${name}: the unreadable repository must be noted for the operator`,
      );
    });
  }
});

test("a malformed gh body never reaches the planner as a known idle runner", () => {
  for (const { name, body } of MALFORMED) {
    withFakeGh(body, (env) => {
      const observed = observeRunnerRuns(env);
      const plan = planDispatch({
        duty: "patrol for acme/repo",
        repo: REPO,
        workflow: "patrol.yml",
        runs: observed.runs,
        unknownRepos: observed.unknownRepos,
        now: Date.parse("2026-09-13T00:00:00.000Z"),
      });

      assert.equal(plan.observationKnown, false, `${name}: occupancy must not be reported as observed`);
      assert.equal(plan.occupancy.observed, false, `${name}: occupancy must not be reported as observed`);
      assert.deepEqual(plan.decision, DISPATCH_DECISIONS.DEFER, `${name}: the planner must defer`);
      assert.equal(
        plan.reasonCode,
        DISPATCH_REASONS.OBSERVATION_UNAVAILABLE,
        `${name}: deferral must be attributed to an unobservable runner`,
      );
      assert.notEqual(plan.reasonCode, DISPATCH_REASONS.RUNNER_IDLE, `${name}: must never claim an idle runner`);
    });
  }
});

test("the admission choke point withholds the dispatch for a malformed gh body", () => {
  for (const { name, body } of MALFORMED) {
    withFakeGh(body, (env) => {
      let dispatched = false;
      const gate = createAdmissionGate({
        observe: () => observeRunnerRuns(env),
        loadHistory: () => [],
        loadLedger: () => new Set(),
        appendLedger: () => {},
        hasLedger: () => false,
        contendedRepository: REPO,
        clock: () => Date.parse("2026-09-13T00:00:00.000Z"),
      });

      const outcome = gate.dispatchGuarded(
        { duty: "patrol for acme/repo", repo: REPO, workflow: "patrol.yml" },
        () => {
          dispatched = true;
          return "gh workflow run executed";
        },
      );

      assert.equal(dispatched, false, `${name}: the dispatch thunk must never run`);
      assert.equal(outcome.dispatch, false, `${name}: the gate must not admit the dispatch`);
      assert.equal(outcome.reason, DISPATCH_REASONS.OBSERVATION_UNAVAILABLE, `${name}: refusal reason`);
      assert.equal(outcome.plan.observationKnown, false, `${name}: observation must be unknown`);
    });
  }
});

test("a well-formed empty run list is still observed as idle", () => {
  withFakeGh(VALID_EMPTY, (env, counter) => {
    const observed = observeRunnerRuns(env);
    assert.equal(counter.callCount() >= 1, true, "fake gh was never invoked");
    assert.deepEqual(observed.unknownRepos, [], "a genuine empty run list is readable");
    assert.deepEqual(observed.runs, [], "a genuine empty run list holds no runs");

    const plan = planDispatch({
      duty: "patrol for acme/repo",
      repo: REPO,
      workflow: "patrol.yml",
      runs: observed.runs,
      unknownRepos: observed.unknownRepos,
      now: Date.parse("2026-09-13T00:00:00.000Z"),
    });
    assert.equal(plan.observationKnown, true, "a genuine empty run list is an observation");
    assert.equal(plan.reasonCode, DISPATCH_REASONS.RUNNER_IDLE, "a genuinely idle runner dispatches");
  });
});

test("a well-formed run list with a live run is observed as busy", () => {
  withFakeGh(VALID_BUSY, (env) => {
    const observed = observeRunnerRuns(env);
    assert.deepEqual(observed.unknownRepos, [], "a genuine run list is readable");
    assert.equal(observed.runs.length, 1);
    assert.equal(observed.runs[0].workflowFile, "patrol.yml");
    assert.equal(observed.runs[0].status, "in_progress");

    const plan = planDispatch({
      duty: "patrol for acme/repo",
      repo: REPO,
      workflow: "patrol.yml",
      runs: observed.runs,
      unknownRepos: observed.unknownRepos,
      now: Date.parse("2026-09-13T00:00:00.000Z"),
    });
    assert.equal(plan.observationKnown, true);
    assert.equal(plan.decision, DISPATCH_DECISIONS.DEFER);
    // The live run carries this duty's own workflow file, so the planner reports
    // the stricter same-purpose contention rather than generic occupancy. The
    // property under test is that a genuine run list stays a *known busy*
    // observation, which is what the malformed-body cases above lose.
    assert.equal(plan.reasonCode, DISPATCH_REASONS.SAME_PURPOSE_LIVE);
    assert.equal(plan.occupancy.live, 1);
  });
});

test("the watchdog observer shares the fail-closed reading of the same bodies", () => {
  for (const { name, body } of MALFORMED) {
    withFakeGh(body, (env) => {
      const observed = observeWatchdogRuns(env, [REPO]);
      assert.deepEqual(observed.unknownRepos, [REPO], `${name}: watchdog must also report the repository unknown`);
      assert.deepEqual(observed.runs, [], `${name}: watchdog must not fabricate runs`);
    });
  }
});

test("a repository that is not the contended one is refused before any read", () => {
  const gate = createAdmissionGate({
    observe: () => ({ runs: [], unknownRepos: [] }),
    loadHistory: () => [],
    loadLedger: () => new Set(),
    appendLedger: () => {},
    hasLedger: () => false,
    contendedRepository: "",
    clock: () => Date.parse("2026-09-13T00:00:00.000Z"),
  });
  const outcome = gate.admit({ duty: "patrol for acme/repo", repo: REPO, workflow: "patrol.yml" });
  assert.equal(outcome.dispatch, false);
  assert.equal(outcome.reason, ADMISSION_REFUSALS.unresolvedContendedRepository);
});

test("admissionRepositories resolves the observed repository deterministically", () => {
  const repos = admissionRepositories({});
  assert.deepEqual(repos, [REPO], "without private configuration only the runtime repository is observable");
});