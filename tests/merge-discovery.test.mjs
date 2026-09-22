import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseMergeTarget,
  revisionOutputValues,
  selectScanPullRequests,
  normalizeScanCap,
  buildScanPageEndpoint,
  collectScanPages,
  classifyTestResult,
  mutationAllowed,
  readMergesHistory,
  mergeAlreadyRecorded,
  isNewFeature,
  mergeExitCode,
  mergeChildExitCode,
  mergePersistenceExitCode,
  recordMergePersistenceFailure,
} from "../scripts/merge.mjs";
import { TERMINAL_STATES, makeTerminal } from "../scripts/lib/terminal.mjs";
import { renderStatusMd, summarizeEvents } from "../scripts/lib/status.mjs";

const targets = {
  allOwned: false,
  tier1: ["M1Vj/enrolled"],
  excluded: ["M1Vj/excluded"],
};

test("merge gate exposes non-success terminal states as failed process outcomes", () => {
  for (const state of ["SUCCESS", "MERGED", "NO-OP"]) assert.equal(mergeExitCode(state), 0);
  for (const state of ["BLOCKED", "REVISION_QUEUED", "EXHAUSTED", "UNKNOWN"]) {
    assert.notEqual(mergeExitCode(state), 0, state);
  }
});

test("merge persistence failures are non-green without rewriting the terminal result", () => {
  assert.equal(mergePersistenceExitCode("committed"), 0);
  assert.equal(mergePersistenceExitCode("no-changes"), 0);
  assert.equal(mergePersistenceExitCode("push-failed"), 1);
});

test("merge persistence failures leave a durable terminal event for the next retry", () => {
  const root = mkdtempSync(path.join(tmpdir(), "merge-persistence-failure-"));
  try {
    const named = recordMergePersistenceFailure(root, {
      runId: "merge-scan-1",
      terminalState: "SCAN-FAILED",
      reason: "push-failed",
    });
    assert.equal(named, "SCAN-FAILED");
    const events = readFileSync(path.join(root, "state", "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.at(-1), {
      t: events.at(-1).t,
      lane: "merge",
      state: "SCAN-FAILED",
      runId: "merge-scan-1",
      persistence: "failed",
      reason: "push-failed",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SCAN-FAILED is a recognized terminal state and status consumer count", () => {
  assert.ok(TERMINAL_STATES.includes("SCAN-FAILED"));
  const root = mkdtempSync(path.join(tmpdir(), "merge-terminal-state-"));
  try {
    const terminal = makeTerminal(root, { lane: "merge" });
    assert.equal(terminal("SCAN-FAILED", { runId: "scan-1" }), "SCAN-FAILED");
    const lines = readFileSync(path.join(root, "state", "events.jsonl"), "utf8").trim().split("\n");
    const summary = summarizeEvents(lines, Date.now(), 24 * 60 * 60 * 1000);
    assert.equal(summary.perLane.merge.SCANFAILED, 1);
    assert.match(renderStatusMd({ eventsLines: lines, mergesLines: [], heartbeat: null, queueLines: [] }), /SCAN-FAILED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("merge scan propagates every failed or interrupted child", () => {
  assert.equal(mergeChildExitCode({ status: 0, error: undefined, signal: null }), 0);
  assert.equal(mergeChildExitCode({ status: 1, error: undefined, signal: null }), 1);
  assert.equal(mergeChildExitCode({ status: null, error: new Error("spawn failed"), signal: null }), 1);
  assert.equal(mergeChildExitCode({ status: null, error: undefined, signal: "SIGTERM" }), 1);
});

test("merge CLI propagates the semantic exit code returned by main", () => {
  const source = readFileSync(new URL("../scripts/merge.mjs", import.meta.url), "utf8");
  assert.match(source, /\.then\(\(code\)\s*=>\s*process\.exit\(code\)\)/);
  assert.doesNotMatch(source, /\.then\(\(\)\s*=>\s*process\.exit\(0\)\)/);
});

test("merge completion does not hide persistence or attribution failures", () => {
  const source = readFileSync(new URL("../scripts/merge.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /try \{\s*await commitPushVerify\([\s\S]{0,400}?\}\s*catch \{\}/);
  assert.match(source, /const persistence = await commitPushVerify\([\s\S]{0,300}?mergePersistenceExitCode\(persistence\)/);
  assert.match(source, /scanExitCode = Math\.max\(scanExitCode, mergeChildExitCode\(res\)\)/);
  assert.match(source, /"Merge gate scan", scanExitCode === 0 \? "ok" : "failed-child"/);
  assert.match(source, /"Merge gate scan", "failed-persistence"/);
  assert.match(source, /MERGE_TERMINAL_STATE=\$\{resultCode === 0 \? "SCAN-DONE" : "SCAN-FAILED"\}/);
  assert.match(source, /return resultCode/);
  assert.match(source, /recordMergePersistenceFailure\(STATE_ROOT/);
});

test("parseMergeTarget accepts only a repo and positive integer PR", () => {
  assert.deepEqual(parseMergeTarget("M1Vj/fleet-runtime", "42"), {
    repo: "M1Vj/fleet-runtime",
    prNumber: 42,
    valid: true,
    provided: true,
  });
  for (const [repo, pr] of [
    ["", "42"],
    [undefined, "42"],
    ["M1Vj/fleet-runtime", "0"],
    ["M1Vj/fleet-runtime", undefined],
    ["not-a-repo", "42"],
    ["M1Vj/fleet-runtime", "1.5"],
  ]) {
    const parsed = parseMergeTarget(repo, pr);
    assert.equal(parsed.valid, false, `${String(repo)}#${String(pr)} must be invalid`);
  }
});

test("parseMergeTarget rejects foreign owners even when the repo and PR shape are valid", () => {
  assert.equal(parseMergeTarget("evil/repo", "42").valid, false);
  assert.equal(parseMergeTarget("m1vj/fleet-runtime", "42").valid, true);
});

test("revisionOutputValues fail closed and emit explicit target fields", () => {
  assert.deepEqual(revisionOutputValues("", 0, true), {
    revision_needed: "false",
    target_valid: "false",
    target_repo: "",
    pr_number: "0",
  });
  assert.deepEqual(revisionOutputValues("M1Vj/fleet-runtime", 42, true), {
    revision_needed: "true",
    target_valid: "true",
    target_repo: "M1Vj/fleet-runtime",
    pr_number: "42",
  });
  assert.equal(revisionOutputValues("M1Vj/fleet-runtime", 42, "false").revision_needed, "false");
});

test("selectScanPullRequests includes enrolled open user PRs, orders fairly, and caps the queue", () => {
  const pulls = [
    {
      repo: "M1Vj/enrolled",
      number: 9,
      state: "open",
      draft: false,
      user: { login: "outside-contributor" },
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-20T00:00:00Z",
    },
    {
      repo: "M1Vj/enrolled",
      number: 7,
      state: "open",
      draft: true,
      user: { login: "M1Vj" },
      head: { ref: "feature/user-branch" },
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-09-10T00:00:00Z",
    },
    {
      repo: "M1Vj/enrolled",
      number: 8,
      state: "open",
      draft: false,
      user: { login: "outside-contributor" },
      created_at: "2026-07-15T00:00:00Z",
      updated_at: "2026-07-16T00:00:00Z",
    },
    {
      repo: "M1Vj/excluded",
      number: 10,
      state: "open",
      user: { login: "outside-contributor" },
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    },
    {
      repo: "M1Vj/enrolled",
      number: 11,
      state: "closed",
      user: { login: "outside-contributor" },
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
    },
  ];

  const selected = selectScanPullRequests(pulls, { targets, limit: 2 });
  assert.deepEqual(selected.map((pull) => pull.number), [7, 8]);
  assert.equal(selected.some((pull) => pull.number === 9), false, "cap should be enforced after fair ordering");
  assert.equal(selected.some((pull) => pull.number === 10), false, "excluded repos stay out of the scan");
});

test("scan eligibility rejects foreign owners even with allOwned or observeAll enabled", () => {
  const foreignPull = {
    repo: "evil/repo",
    number: 42,
    state: "open",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  };
  for (const enrollment of [{ allOwned: true }, { observeAll: true }]) {
    assert.deepEqual(
      selectScanPullRequests([foreignPull], { targets: { ...enrollment, excluded: [] }, limit: 15 }),
      [],
      `foreign repo must stay out with ${JSON.stringify(enrollment)}`,
    );
  }
});

test("normalizeScanCap is bounded to a safe maximum of fifteen", () => {
  assert.equal(normalizeScanCap(undefined), 3);
  assert.equal(normalizeScanCap("15"), 15);
  assert.equal(normalizeScanCap("999"), 15);
  assert.equal(normalizeScanCap("0"), 1);
});

test("collectScanPages stops at the first short page and never exceeds the page cap", () => {
  const calls = [];
  const rows = collectScanPages((page, perPage) => {
    calls.push([page, perPage]);
    if (page === 1) return [{ id: 1 }, { id: 2 }];
    return [{ id: 3 }];
  }, { maxPages: 5, perPage: 2 });

  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3]);
  assert.deepEqual(calls, [[1, 2], [2, 2]]);
  assert.equal(buildScanPageEndpoint("/repos?state=open&per_page=20", 2, 100), "/repos?state=open&page=2&per_page=100");
});

test("least-recently visited PRs win ties while older creation remains the deterministic fallback", () => {
  const pulls = [
    {
      repo: "M1Vj/enrolled",
      number: 20,
      state: "open",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-03T00:00:00Z",
    },
    {
      repo: "M1Vj/enrolled",
      number: 21,
      state: "open",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
    },
  ];
  const selected = selectScanPullRequests(pulls, {
    targets,
    limit: 2,
    history: [{ repo: "M1Vj/enrolled", pr: 20, selectedAt: "2026-09-12T00:00:00Z" }],
  });
  assert.deepEqual(selected.map((pull) => pull.number), [21, 20]);
});

test("deterministic test result classification fails closed on nonzero or missing exit status", () => {
  assert.deepEqual(classifyTestResult({ status: 0 }), { ok: true, exitCode: 0, why: "passed" });
  assert.equal(classifyTestResult({ status: 1 }).ok, false);
  assert.equal(classifyTestResult({ status: null, signal: "SIGTERM" }).ok, false);
});

test("mutationAllowed fails closed while the kill switch is engaged", () => {
  const oldPath = process.env.FLEET_KILL_SWITCH_PATH;
  const dir = mkdtempSync(path.join(tmpdir(), "merge-kill-switch-"));
  const switchPath = path.join(dir, "KILL_SWITCH");
  const incidents = [];
  try {
    writeFileSync(switchPath, "stop\n", "utf8");
    process.env.FLEET_KILL_SWITCH_PATH = switchPath;
    assert.equal(mutationAllowed("test mutation", { incident: (...args) => incidents.push(args) }), false);
    assert.equal(incidents.length, 1);
  } finally {
    if (oldPath === undefined) delete process.env.FLEET_KILL_SWITCH_PATH;
    else process.env.FLEET_KILL_SWITCH_PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge gate keeps deterministic test failures blocking and persists scan-empty evidence", () => {
  const source = readFileSync(new URL("../scripts/merge.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\$\{scripts\.test\} \|\| true/);
  assert.match(source, /const testVerdict = classifyTestResult\(t\)/);
  assert.match(source, /writeMergeState\("NO-OP", \{ why: "scan-empty" \}\);\s*return finish\(audit, runId, "NO-OP"\);/s);
});

test("readMergesHistory parses valid jsonl lines and ignores empty/malformed lines", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "merges-test-"));
  const filePath = path.join(dir, "merges.jsonl");
  try {
    writeFileSync(filePath, '{"t":"2026-09-17T00:00:00Z","repo":"a/b","pr":1}\n\nnot-json\n{"t":"2026-09-17T01:00:00Z","repo":"c/d","pr":2}\n', "utf8");
    const history = readMergesHistory(filePath);
    assert.equal(history.length, 2);
    assert.equal(history[0].repo, "a/b");
    assert.equal(history[1].repo, "c/d");
    assert.deepEqual(readMergesHistory("/nonexistent-path"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unvisited newer PRs are prioritized over older visited PRs to prevent queue starvation", () => {
  const pulls = [
    {
      repo: "M1Vj/enrolled",
      number: 1,
      state: "open",
      created_at: "2022-01-01T00:00:00Z",
      updated_at: "2022-01-01T00:00:00Z",
    },
    {
      repo: "M1Vj/enrolled",
      number: 102,
      state: "open",
      created_at: "2026-09-15T00:00:00Z",
      updated_at: "2026-09-15T00:00:00Z",
    },
  ];
  const selected = selectScanPullRequests(pulls, {
    targets,
    limit: 1,
    history: [{ repo: "M1Vj/enrolled", pr: 1, selectedAt: "2026-09-17T07:00:00Z" }],
  });
  assert.deepEqual(selected.map((pull) => pull.number), [102]);
});

test("mergeAlreadyRecorded honors terminal states (SUCCESS, BLOCKED, NEEDS_HUMAN_REVIEW) for exact sha and invalidates on new sha", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "merges-recorded-"));
  const filePath = path.join(dir, "merges.jsonl");
  try {
    writeFileSync(
      filePath,
      JSON.stringify({ t: "2026-09-18T00:00:00Z", state: "BLOCKED", repo: "M1Vj/VSU-SmartMap", pr: 103, sha: "sha-blocked-1" }) + "\n" +
      JSON.stringify({ t: "2026-09-18T01:00:00Z", state: "SUCCESS", repo: "M1Vj/ConceptHub", pr: 5, sha: "sha-merged-1" }) + "\n" +
      JSON.stringify({ t: "2026-09-18T02:00:00Z", state: "NEEDS_HUMAN_REVIEW", repo: "M1Vj/vsunavigator", pr: 3, sha: "sha-review-1" }) + "\n" +
      JSON.stringify({ t: "2026-09-18T03:00:00Z", state: "REVISION_QUEUED", repo: "M1Vj/HydraLab", pr: 2, sha: "sha-rev-1" }) + "\n",
      "utf8",
    );

    assert.equal(mergeAlreadyRecorded(filePath, "M1Vj/VSU-SmartMap", 103, "sha-blocked-1"), true);
    assert.equal(mergeAlreadyRecorded(filePath, "M1Vj/VSU-SmartMap", 103, "sha-new-commit"), false);
    assert.equal(mergeAlreadyRecorded(filePath, "M1Vj/ConceptHub", 5, "sha-merged-1"), true);
    assert.equal(mergeAlreadyRecorded(filePath, "M1Vj/vsunavigator", 3, "sha-review-1"), true);
    assert.equal(mergeAlreadyRecorded(filePath, "M1Vj/HydraLab", 2, "sha-rev-1"), false);
    assert.equal(mergeAlreadyRecorded(filePath, "M1Vj/OtherRepo", 99, "sha-other"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isNewFeature identifies new feature PRs across titles, branches, labels, categories, and route additions", () => {
  // Title tests
  assert.equal(isNewFeature({ title: "feat: add user dark mode toggle" }), true);
  assert.equal(isNewFeature({ title: "feat(auth): support passkey login" }), true);
  assert.equal(isNewFeature({ title: "feature: export reports to csv" }), true);
  assert.equal(isNewFeature({ title: "[fleet-improve] feat: add search filtering" }), true);
  assert.equal(isNewFeature({ title: "fix: resolve memory leak on unmount" }), false);
  assert.equal(isNewFeature({ title: "chore: bump dependencies" }), false);
  assert.equal(isNewFeature({ title: "refactor: simplify query hooks" }), false);

  // Branch tests
  assert.equal(isNewFeature({ title: "add dark mode", head: { ref: "fleet/feat-darkmode" } }), true);
  assert.equal(isNewFeature({ title: "add export", head: { ref: "fleet/feature-export" } }), true);
  assert.equal(isNewFeature({ title: "fix crash", head: { ref: "fleet/improve-a1b2c3d4" } }), false);

  // Label tests
  assert.equal(isNewFeature({ title: "Campus building viewer", labels: [{ name: "enhancement" }] }), true);
  assert.equal(isNewFeature({ title: "Event notifier", labels: ["feature"] }), true);
  assert.equal(isNewFeature({ title: "Bug fix", labels: [{ name: "bug" }] }), false);

  // Body category tests
  assert.equal(isNewFeature({ title: "Custom calendar export", body: "Category: new-feature\nSummary: exports ics" }), true);
  assert.equal(isNewFeature({ title: "Typo fix", body: "Category: docs\nSummary: fix typo" }), false);

  // File addition tests (new routes / endpoints)
  const filesWithNewRoute = [
    { filename: "app/api/calendar/route.ts", status: "added", additions: 50, deletions: 0 },
    { filename: "components/calendar/calendar-view.tsx", status: "added", additions: 80, deletions: 0 },
  ];
  assert.equal(isNewFeature({ title: "Calendar service" }, filesWithNewRoute), true);

  const filesFixOnly = [
    { filename: "components/ui/button.tsx", status: "modified", additions: 5, deletions: 2 },
  ];
  assert.equal(isNewFeature({ title: "Button styling adjustment" }, filesFixOnly), false);
});
