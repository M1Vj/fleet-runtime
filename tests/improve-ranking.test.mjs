import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeSelectionHistory,
  salvageIdeas,
  selectImprovementRepos,
  validateIdeasObject,
  resolveRequestedRepo,
  researchCapacityOutcome,
} from "../scripts/improve.mjs";

const NOW = Date.parse("2026-09-13T00:00:00.000Z");

function repo(fullName, overrides = {}) {
  return {
    full_name: fullName,
    archived: false,
    fork: false,
    created_at: new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString(),
    pushed_at: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

test("weighted improvement selection uses scheduler scores and excludes archived repositories", () => {
  const active = repo("M1Vj/active");
  const dormant = repo("M1Vj/dormant", { pushed_at: new Date(NOW - 300 * 24 * 60 * 60 * 1000).toISOString() });
  const archived = repo("M1Vj/archived", { archived: true });
  const selected = selectImprovementRepos([active, dormant, archived], {
    topK: 2,
    now: NOW,
    history: [],
    rng: () => 0,
  });

  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((item) => item.full_name), ["M1Vj/active", "M1Vj/dormant"]);
  assert.ok(selected.every((item) => Number.isFinite(item.score) && item.score > 0));
});

test("exact owner-scoped repo selection overrides weighted sampling", () => {
  const target = repo("M1Vj/target");
  const other = repo("M1Vj/other");
  const selected = selectImprovementRepos([target, other], {
    requestedRepo: "M1Vj/target",
    topK: 1,
    now: NOW,
    rng: () => 0.99,
  });

  assert.deepEqual(selected.map((item) => item.full_name), ["M1Vj/target"]);
  assert.equal(resolveRequestedRepo([target, other], "M1Vj/target").full_name, "M1Vj/target");
});

test("foreign or missing exact repo targets fail closed", () => {
  const target = repo("M1Vj/target");
  assert.throws(() => resolveRequestedRepo([target], "Other/target"));
  assert.throws(() => resolveRequestedRepo([target], "M1Vj/missing"));
  assert.throws(() => selectImprovementRepos([target], { requestedRepo: "not-a-repo", topK: 1 }));
});

test("private research circuit outage remains waiting for capacity", () => {
  const outcome = researchCapacityOutcome("private", Date.parse("2026-09-13T00:00:00.000Z"), 30 * 60 * 1000);
  assert.equal(outcome.status, "waiting_for_capacity");
  assert.equal(outcome.exitCode, 6);
  assert.equal(outcome.retryAt, "2026-09-13T00:30:00.000Z");
  assert.notEqual(outcome.exitCode, 0);
});

test("selection history merge is idempotent per run and preserves fairness records", () => {
  const first = { repo: "M1Vj/active", score: 4, runId: "run-1", selectedAt: "2026-09-13T00:00:00.000Z" };
  const state = mergeSelectionHistory({ runs: [] }, [first, first]);
  const repeated = mergeSelectionHistory(state, [first]);

  assert.equal(state.selectionHistory.length, 1);
  assert.deepEqual(repeated.selectionHistory, state.selectionHistory);
  assert.equal(repeated.selectionHistory[0].repo, "M1Vj/active");
});

test("research ideas are validated and salvage keeps a valid subset from a noisy response", () => {
  const response = [
    "Here is the research output:",
    "```json",
    '{ideas:[{title:"Improve tests",rationale:"The suite misses a case",evidence:"Observed flaky retry",impact:"high"},{title:"",rationale:"bad",evidence:"bad",impact:"low"}],}',
    "```",
  ].join("\n");

  const parsed = salvageIdeas(response);
  assert.equal(parsed.degraded, true);
  assert.equal(parsed.ideas.length, 1);
  assert.equal(parsed.ideas[0].title, "Improve tests");
  assert.deepEqual(validateIdeasObject({ ideas: parsed.ideas }), { ideas: parsed.ideas });
});

test("invalid research ideas cannot be emitted as a valid object", () => {
  assert.throws(() => validateIdeasObject({ ideas: [{ title: "missing fields" }] }));
  assert.throws(() => salvageIdeas("{\"ideas\":[]}"));
});
