import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendMemoryEvent,
  buildMemoryContext,
  deterministicEventId,
  readMemoryEvents,
  redactText,
  rotateMemory,
} from "../scripts/lib/pr-memory.mjs";

function tempMemory() {
  const root = mkdtempSync(path.join(tmpdir(), "pr-memory-test-"));
  mkdirSync(path.join(root, "state"), { recursive: true });
  return path.join(root, "state", "pr-memory.jsonl");
}

function event(overrides = {}) {
  return {
    runId: "merge-1",
    lane: "revise",
    repo: "M1Vj/example-repo",
    pr: 42,
    headSha: "a".repeat(40),
    attempt: 1,
    kind: "revision",
    state: "REVISION_QUEUED",
    createdAt: "2026-08-24T00:00:00.000Z",
    summary: "judge rejected one bounded issue",
    changedPaths: ["src/example.js"],
    blockerIds: ["b1"],
    artifactRefs: ["audit/2026-08-24/run.md"],
    ...overrides,
  };
}

test("event id is deterministic and includes the content hash", () => {
  const first = deterministicEventId(event());
  const second = deterministicEventId(event());
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, deterministicEventId(event({ summary: "a different bounded issue" })));
  assert.notEqual(first, deterministicEventId(event({ attempt: 2 })));
});

test("redaction replaces token-like text before persistence", () => {
  const value = redactText("ghp_abcdefghijklmnopqrstuvwxyz1234567890 and AKIAIOSFODNN7EXAMPLE");
  assert.equal(value.includes("ghp_"), false);
  assert.equal(value.includes("AKIAIOSFODNN7EXAMPLE"), false);
  assert.match(value, /\[REDACTED\]/);
});

test("duplicate append is an idempotent no-op", () => {
  const file = tempMemory();
  const first = appendMemoryEvent(file, event());
  const second = appendMemoryEvent(file, event());
  assert.equal(first.appended, true);
  assert.equal(second.appended, false);
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
  assert.equal(readMemoryEvents(file).length, 1);
});

test("memory context is target-scoped and bounded to recent events", () => {
  const file = tempMemory();
  for (let i = 0; i < 5; i += 1) {
    appendMemoryEvent(file, event({
      runId: `run-${i}`,
      createdAt: `2026-08-24T00:0${i}:00.000Z`,
      summary: `event-${i}`,
    }));
  }
  appendMemoryEvent(file, event({ repo: "other/repo", runId: "other" }));
  const context = buildMemoryContext(readMemoryEvents(file), {
    repo: "M1Vj/example-repo",
    pr: 42,
    headSha: "a".repeat(40),
    maxEvents: 2,
  });
  assert.equal(context.length, 2);
  assert.deepEqual(context.map((entry) => entry.runId), ["run-4", "run-3"]);
  assert.equal(context.some((entry) => entry.runId === "other"), false);
  assert.equal(JSON.stringify(context).includes("ghp_"), false);
});

test("rotation keeps the newest bounded lines and writes a summary event", () => {
  const file = tempMemory();
  for (let i = 0; i < 5; i += 1) {
    appendMemoryEvent(file, event({ runId: `run-${i}`, createdAt: `2026-08-24T00:0${i}:00.000Z` }));
  }
  const result = rotateMemory(file, { maxLines: 3 });
  assert.equal(result.rotated, true);
  const lines = readMemoryEvents(file);
  assert.equal(lines.length, 3);
  assert.equal(lines.at(-1).kind, "terminal");
  assert.equal(lines.at(-1).state, "ROTATED");
  assert.equal(lines.at(-1).summary.includes("3"), true);
});

test("rotation with a one-line limit keeps only the summary event", () => {
  const file = tempMemory();
  for (let i = 0; i < 3; i += 1) appendMemoryEvent(file, event({ runId: `one-${i}` }));
  const result = rotateMemory(file, { maxLines: 1 });
  assert.equal(result.rotated, true);
  const lines = readMemoryEvents(file);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].state, "ROTATED");
});

test("memory context never exceeds the serialized character bound", () => {
  const file = tempMemory();
  appendMemoryEvent(file, event({ summary: "x".repeat(500) }));
  const context = buildMemoryContext(readMemoryEvents(file), {
    repo: "M1Vj/example-repo",
    pr: 42,
    headSha: "a".repeat(40),
    maxEvents: 2,
    maxChars: 10,
  });
  assert.equal(context.length, 0);
});

test("malformed lines are ignored while valid memory remains readable", () => {
  const file = tempMemory();
  writeFileSync(file, "not-json\n" + JSON.stringify(event()) + "\n", "utf8");
  assert.equal(readMemoryEvents(file).length, 1);
});
