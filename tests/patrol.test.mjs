import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildDigest,
  applyPatrolLabels,
  canonicalizePatrolRepo,
  fencePatrolDirectives,
  loadPatrolLedger,
  planPatrolPersistence,
  planDeepQueueAdditions,
  planPatrolDispatches,
  DEEP_QUEUE_CAP,
} from "../scripts/patrol.mjs";
import { eventKey } from "../scripts/lib/ledger.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.parse("2026-09-13T00:00:00.000Z");

function iso(at) {
  return new Date(at).toISOString();
}

function pull(repo, number, updatedAt) {
  return { n: number, title: `PR ${number}`, draft: false, updated: iso(updatedAt) };
}

function signal(repo, { pulls = [], failures = [] } = {}) {
  return {
    repo,
    openPulls: pulls,
    activeIssues: [],
    failingRuns24h: failures,
  };
}

function task(repo, kind, status = "pending") {
  return { id: `${repo}-${kind}`, repo, kind, status, attempts: 0 };
}

test("buildDigest rediscover unchanged open PRs after the bounded revisit TTL", () => {
  const pr = pull("M1Vj/aging", 7, NOW - 25 * HOUR_MS);
  const key = eventKey("sig-pr", "M1Vj/aging", "7", pr.updated);
  const digest = JSON.parse(
    buildDigest(
      [signal("M1Vj/aging", { pulls: [pr] })],
      new Map([[key, NOW - 25 * HOUR_MS]]),
      { now: NOW },
    ),
  );

  assert.deepEqual(digest[0].newPulls.map((item) => item.n), [7]);
});

test("buildDigest deduplicates fresh ledger entries within the revisit TTL", () => {
  const pr = pull("M1Vj/fresh", 8, NOW - 2 * HOUR_MS);
  const key = eventKey("sig-pr", "M1Vj/fresh", "8", pr.updated);
  const digest = buildDigest(
    [signal("M1Vj/fresh", { pulls: [pr] })],
    new Map([[key, NOW - HOUR_MS]]),
    { now: NOW },
  );

  assert.equal(digest, "[]");
});

test("loadPatrolLedger keeps the latest timestamp for stale rediscovery", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "patrol-ledger-test-"));
  const ledgerPath = path.join(dir, "ledger.jsonl");
  const key = eventKey("sig-pr", "M1Vj/ledger", "9", iso(NOW));
  writeFileSync(
    ledgerPath,
    `${JSON.stringify({ k: key, t: iso(NOW - 3 * DAY_MS) })}\n${JSON.stringify({ k: key, t: iso(NOW - HOUR_MS) })}\n`,
  );

  try {
    assert.equal(loadPatrolLedger(ledgerPath).get(key), NOW - HOUR_MS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildDigest progressively prioritizes older open PRs", () => {
  const oldPr = pull("M1Vj/aging", 1, NOW - 180 * DAY_MS);
  const youngPr = pull("M1Vj/aging", 2, NOW - 2 * DAY_MS);
  const digest = JSON.parse(
    buildDigest(
      [signal("M1Vj/aging", { pulls: [youngPr, oldPr] })],
      new Map(),
      { now: NOW },
    ),
  );

  assert.deepEqual(digest[0].newPulls.map((item) => item.n), [1, 2]);
});

test("planDeepQueueAdditions keeps adding prioritized work above the old 12-task cutoff", () => {
  const existing = Array.from({ length: 13 }, (_, index) => task(`M1Vj/backlog-${index}`, "code-review"));
  const additions = planDeepQueueAdditions(
    existing,
    [
      signal("M1Vj/pr-only", { pulls: [pull("M1Vj/pr-only", 1, NOW)] }),
      signal("M1Vj/failure", { failures: [{ id: 99, created: iso(NOW) }] }),
    ],
    { now: NOW },
  );

  assert.equal(additions.length, 2);
  assert.equal(additions[0].repo, "M1Vj/failure");
  assert.equal(new Set(additions.map((item) => `${item.repo}|${item.kind}`)).size, additions.length);
});

test("planDeepQueueAdditions respects the bounded queue cap and available slots", () => {
  const existing = Array.from({ length: DEEP_QUEUE_CAP - 1 }, (_, index) => task(`M1Vj/backlog-${index}`, "code-review"));
  const signals = Array.from({ length: 3 }, (_, index) =>
    signal(`M1Vj/new-${index}`, { pulls: [pull(`M1Vj/new-${index}`, index + 1, NOW)] }),
  );

  const additions = planDeepQueueAdditions(existing, signals, { now: NOW });

  assert.equal(additions.length, 1);
  assert.ok(existing.filter((item) => ["pending", "in_progress"].includes(item.status)).length + additions.length <= DEEP_QUEUE_CAP);
});

test("planDeepQueueAdditions deduplicates repo/kind against pending and same-day completed work", () => {
  const existing = [
    task("M1Vj/duplicate", "security-audit", "pending"),
    { ...task("M1Vj/completed", "redteam", "done"), updatedUtc: iso(NOW + HOUR_MS) },
  ];
  const additions = planDeepQueueAdditions(
    [
      ...existing,
    ],
    [
      signal("M1Vj/duplicate", { pulls: [pull("M1Vj/duplicate", 1, NOW)] }),
      signal("M1Vj/completed", { pulls: [pull("M1Vj/completed", 2, NOW)] }),
    ],
    { now: NOW, kindIndex: 0 },
  );

  const existingKeys = new Set(existing.map((item) => `${item.repo}|${item.kind}`));
  assert.ok(additions.every((item) => !existingKeys.has(`${item.repo}|${item.kind}`)));
  assert.equal(new Set(additions.map((item) => `${item.repo}|${item.kind}`)).size, additions.length);
});

test("canonicalizePatrolRepo accepts only case-insensitive M1Vj owner and canonicalizes it", () => {
  assert.equal(canonicalizePatrolRepo("m1vj/runtime"), "M1Vj/runtime");
  assert.equal(canonicalizePatrolRepo("M1VJ/runtime-tools"), "M1Vj/runtime-tools");
  assert.equal(canonicalizePatrolRepo("other/runtime"), "");
  assert.equal(canonicalizePatrolRepo("M1Vj"), "");
  assert.equal(canonicalizePatrolRepo("M1Vj/../runtime"), "");
  assert.equal(canonicalizePatrolRepo(" M1Vj/runtime"), "");
});

test("fencePatrolDirectives rejects foreign and malformed repos for every mutation directive", () => {
  const mutationDirectives = [
    { kind: "comment", repo: "other/repo", target: "pr", number: 1, body: "x" },
    { kind: "label", repo: "not-owner/repo", number: 2, labels: ["x"] },
    {
      kind: "draft_pr",
      repo: "M1Vj/../escape",
      branch: "fleet/safe-branch",
      title: "x",
      body: "x",
      files: [{ path: "docs/note.md", content: "x" }],
    },
  ];

  for (const directive of mutationDirectives) {
    const fenced = fencePatrolDirectives([directive]);
    assert.equal(fenced.ok, false);
    assert.deepEqual(fenced.directives, []);
  }
});

test("fencePatrolDirectives canonicalizes valid mutation repos before execution eligibility", () => {
  const fenced = fencePatrolDirectives([
    { kind: "comment", repo: "m1vj/runtime", target: "pr", number: 1, body: "x" },
    { kind: "label", repo: "M1VJ/runtime", number: 2, labels: ["x"] },
    {
      kind: "draft_pr",
      repo: "m1Vj/runtime",
      branch: "fleet/safe-branch",
      title: "x",
      body: "x",
      files: [{ path: "docs/note.md", content: "x" }],
    },
  ]);

  assert.equal(fenced.ok, true);
  assert.deepEqual(fenced.directives.map((item) => item.repo), ["M1Vj/runtime", "M1Vj/runtime", "M1Vj/runtime"]);
});

test("planDeepQueueAdditions rejects foreign and malformed signal repos while retaining valid work", () => {
  const additions = planDeepQueueAdditions(
    [],
    [
      signal("other/foreign", { pulls: [pull("other/foreign", 1, NOW)] }),
      signal("M1Vj/../escape", { pulls: [pull("M1Vj/../escape", 2, NOW)] }),
      signal("m1vj/valid", { pulls: [pull("m1vj/valid", 3, NOW)] }),
    ],
    { now: NOW, kindIndex: 0 },
  );

  assert.deepEqual(additions.map((item) => item.repo), ["M1Vj/valid"]);
});

test("applyPatrolLabels rechecks the kill switch before each label mutation", async () => {
  const calls = [];
  const audit = { note() {}, incident() {} };
  const result = await applyPatrolLabels("M1Vj/runtime", 3, ["first", "second"], {}, audit, {
    killSwitch: () => calls.length >= 1,
    gh: (args) => {
      calls.push(args);
      return { ok: true };
    },
  });

  assert.equal(result.applied, 1);
  assert.equal(result.skipped, true);
  assert.equal(calls.length, 1);
});

test("planPatrolPersistence bounds the lifecycle to one initial push plus one final audit push", () => {
  assert.deepEqual(planPatrolPersistence({ changed: false, pushes: 0 }), { persist: false, reason: "no-changes" });
  assert.deepEqual(planPatrolPersistence({ changed: true, pushes: 0 }), { persist: true, pushAttempt: 1 });
  assert.deepEqual(planPatrolPersistence({ changed: true, pushes: 1 }), { persist: true, pushAttempt: 2 });
  assert.deepEqual(planPatrolPersistence({ changed: true, pushes: 2 }), { persist: false, reason: "push-cap" });
});

test("planPatrolDispatches detects open non-draft PR and plans targeted merge.yml", () => {
  const pr = pull("M1Vj/VSU-SmartMap", 102, NOW);
  const dispatches = planPatrolDispatches([signal("M1Vj/VSU-SmartMap", { pulls: [pr] })], {
    now: NOW,
    ledger: new Map(),
    tier1: ["VSU-SmartMap"],
  });

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].workflow, "merge.yml");
  assert.equal(dispatches[0].repo, "M1Vj/VSU-SmartMap");
  assert.equal(dispatches[0].pr, "102");
});

test("planPatrolDispatches skips draft PRs and deduplicates against the ledger", () => {
  const draftPr = { n: 103, title: "Draft PR", draft: true, updated: iso(NOW) };
  const openPr = pull("M1Vj/VSU-SmartMap", 104, NOW);
  const key = eventKey("dispatch-merge", "M1Vj/VSU-SmartMap", "104", openPr.updated);
  const ledger = new Map([[key, NOW]]);

  const dispatches = planPatrolDispatches([signal("M1Vj/VSU-SmartMap", { pulls: [draftPr, openPr] })], {
    now: NOW,
    ledger,
    tier1: ["VSU-SmartMap"],
  });

  assert.equal(dispatches.length, 0);
});

test("planPatrolDispatches plans improve.yml for idle tier-1 repo when no PRs are pending", () => {
  const dispatches = planPatrolDispatches([signal("M1Vj/CodexSwap", { pulls: [] })], {
    now: NOW,
    ledger: new Map(),
    tier1: ["CodexSwap"],
  });

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].workflow, "improve.yml");
  assert.equal(dispatches[0].repo, "M1Vj/CodexSwap");
});

test("planPatrolDispatches enforces strict Top-2 priority ordering (VSU-SmartMap > SangkAI-city > Others)", () => {
  const prCodex = pull("M1Vj/CodexSwap", 1, NOW);
  const prSmartMap = pull("M1Vj/VSU-SmartMap", 102, NOW);
  const prSangkai = pull("M1Vj/SangkAI-city", 5, NOW);

  // Even when signals are passed in reverse order (CodexSwap, SangkAI-city, VSU-SmartMap)
  const dispatches = planPatrolDispatches(
    [
      signal("M1Vj/CodexSwap", { pulls: [prCodex] }),
      signal("M1Vj/SangkAI-city", { pulls: [prSangkai] }),
      signal("M1Vj/VSU-SmartMap", { pulls: [prSmartMap] }),
    ],
    {
      now: NOW,
      ledger: new Map(),
      priorityRepos: ["VSU-SmartMap", "SangkAI-city"],
      tier1: ["VSU-SmartMap", "SangkAI-city", "CodexSwap"],
    },
  );

  // VSU-SmartMap must be chosen first!
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].repo, "M1Vj/VSU-SmartMap");
  assert.equal(dispatches[0].pr, "102");

  // When VSU-SmartMap has no PRs, SangkAI-city must be chosen before CodexSwap
  const dispatches2 = planPatrolDispatches(
    [
      signal("M1Vj/CodexSwap", { pulls: [prCodex] }),
      signal("M1Vj/SangkAI-city", { pulls: [prSangkai] }),
      signal("M1Vj/VSU-SmartMap", { pulls: [] }),
    ],
    {
      now: NOW,
      ledger: new Map(),
      priorityRepos: ["VSU-SmartMap", "SangkAI-city"],
      tier1: ["VSU-SmartMap", "SangkAI-city", "CodexSwap"],
    },
  );

  assert.equal(dispatches2.length, 1);
  assert.equal(dispatches2[0].repo, "M1Vj/SangkAI-city");
  assert.equal(dispatches2[0].pr, "5");
});
