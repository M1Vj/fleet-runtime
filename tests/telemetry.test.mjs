import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendTelemetryEvent,
  deterministicTelemetryEventId,
  normalizeTelemetryEvent,
  readTelemetryEvents,
  telemetryPath,
} from "../scripts/lib/telemetry.mjs";
import { makeTerminal } from "../scripts/lib/terminal.mjs";
import { attemptJudgeMirror } from "../scripts/merge.mjs";
import { appendResearchEvent, readResearchEvents } from "../scripts/lib/research-state.mjs";

const head = "a".repeat(40);

function tempRoot(prefix = "fleet-telemetry-test-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function baseEvent(overrides = {}) {
  return {
    runId: "local:test-run",
    correlationId: "corr-test-run",
    lane: "merge",
    event: "terminal",
    phase: "outcome",
    outcome: "succeeded",
    repo: "M1Vj/example",
    pr: 11,
    headSha: head,
    terminal: { state: "SUCCESS" },
    ...overrides,
  };
}

test("telemetry normalizes an allowlisted envelope with deterministic IDs", () => {
  const first = normalizeTelemetryEvent(baseEvent({ occurredAt: "2026-08-29T00:00:00.000Z" }));
  const second = normalizeTelemetryEvent(baseEvent({ occurredAt: "2026-08-29T00:01:00.000Z" }));
  assert.match(first.eventId, /^evt-[a-f0-9]{64}$/);
  assert.equal(first.eventId, second.eventId);
  assert.equal(first.occurredAt, "2026-08-29T00:00:00.000Z");
  assert.equal(first.schemaVersion, 1);
  assert.deepEqual(first.terminal, { state: "SUCCESS" });
  assert.equal(first.eventId, deterministicTelemetryEventId(first));
});

test("telemetry rejects unknown fields, forbidden payload fields, URLs, and secret sentinels", () => {
  const sentinels = [
    "AIzaSyAbcdefghijklmnopqrstuv1234567890",
    "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    "sk-abcdefghijklmnopqrstuvwxyz1234567890",
    "Bearer abcdefghijklmnop1234567890",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturesegment123",
  ];
  for (const value of sentinels) {
    assert.throws(() => normalizeTelemetryEvent(baseEvent({ reasonCode: value })), /TELEMETRY_(?:SECRET|SCHEMA)_REJECTED/);
  }
  for (const key of ["prompt", "body", "diff", "reviewNotes", "stderr", "stdout", "rawTail", "errTail", "url", "credential", "oauth", "cookies", "pii"]) {
    assert.throws(() => normalizeTelemetryEvent(baseEvent({ [key]: "redacted" })), /TELEMETRY_SCHEMA_REJECTED/);
  }
  assert.throws(() => normalizeTelemetryEvent(baseEvent({ unexpected: true })), /TELEMETRY_SCHEMA_REJECTED/);
  assert.throws(() => normalizeTelemetryEvent(baseEvent({ reasonCode: "https://example.invalid/private" })), /TELEMETRY_(?:SECRET|SCHEMA)_REJECTED/);
});

test("telemetry append is atomic, idempotent, private, and prunes by count and age", () => {
  const root = tempRoot();
  try {
    const file = telemetryPath(root);
    const old = baseEvent({
      runId: "local:old",
      correlationId: "corr-old",
      occurredAt: "2026-08-01T00:00:00.000Z",
      terminal: { state: "BLOCKED" },
      outcome: "held",
    });
    const fresh = baseEvent({
      runId: "local:fresh",
      correlationId: "corr-fresh",
      occurredAt: "2026-08-29T00:00:00.000Z",
    });
    assert.equal(appendTelemetryEvent(file, old, { now: Date.parse("2026-08-29T00:00:00.000Z"), retentionMs: 14 * 24 * 60 * 60 * 1000 }).appended, true);
    assert.equal(appendTelemetryEvent(file, fresh, { now: Date.parse("2026-08-29T00:00:00.000Z"), retentionMs: 14 * 24 * 60 * 60 * 1000 }).appended, true);
    assert.equal(appendTelemetryEvent(file, fresh, { now: Date.parse("2026-08-29T00:00:00.000Z"), retentionMs: 14 * 24 * 60 * 60 * 1000 }).appended, false);
    const events = readTelemetryEvents(file);
    assert.equal(events.length, 1);
    assert.equal(events[0].correlationId, "corr-fresh");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(existsSync(`${file}.lock`), false);
    assert.match(readFileSync(file, "utf8"), /corr-fresh/);
    assert.doesNotMatch(readFileSync(file, "utf8"), /corr-old/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal writes the shared telemetry outcome without serializing arbitrary details", () => {
  const root = tempRoot();
  try {
    const terminal = makeTerminal(root, { lane: "merge" });
    assert.equal(terminal("BLOCKED", {
      runId: "local:terminal",
      repo: "M1Vj/example",
      pr: 11,
      headSha: head,
      prompt: "must not persist",
    }), "BLOCKED");
    const [event] = readTelemetryEvents(path.join(root, "state", "telemetry.jsonl"));
    assert.equal(event.event, "terminal");
    assert.equal(event.terminal.state, "BLOCKED");
    assert.equal(event.prompt, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent comment claim telemetry records claim loss, post, and verify states", async () => {
  const root = tempRoot();
  try {
    const telemetryFile = path.join(root, "state", "telemetry.jsonl");
    const fingerprint = `comment-${"b".repeat(64)}`;
    const calls = [];
    const identity = { login: "M1Vj" };
    const base = {
      repo: "M1Vj/example",
      number: 11,
      headSha: head,
      body: "controlled judge result",
      identity,
      existingComments: [],
      telemetryFile,
      fingerprint,
      claimFingerprint: async () => {
        const won = calls.filter((call) => call === "claim").length === 0;
        calls.push("claim");
        return won;
      },
      post: async () => {
        calls.push("post");
        return { id: 77, user: { login: "M1Vj" } };
      },
      verify: async () => {
        calls.push("verify");
      },
    };
    const [first, second] = await Promise.all([
      attemptJudgeMirror(base),
      attemptJudgeMirror(base),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(calls.filter((call) => call === "post").length, 1);
    const events = readTelemetryEvents(telemetryFile).filter((event) => event.event === "comment");
    assert.ok(events.some((event) => event.comment?.action === "claim_lost"));
    assert.ok(events.some((event) => event.comment?.action === "posted"));
    assert.ok(events.some((event) => event.comment?.action === "verified"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("research state telemetry preserves one exact-head correlation through completion", () => {
  const root = tempRoot();
  try {
    const correlationId = "research-0123456789abcdef0123456789abcdef";
    appendResearchEvent(root, {
      runId: "research-run",
      state: "RESEARCH_REQUESTED",
      correlationId,
      repo: "M1Vj/example",
      pr: 11,
      headSha: head,
      summary: "no progress",
    });
    appendResearchEvent(root, {
      runId: "research-run",
      state: "RESEARCH_COMPLETED",
      correlationId,
      repo: "M1Vj/example",
      pr: 11,
      headSha: head,
      summary: "completed",
    });
    const events = readTelemetryEvents(path.join(root, "state", "telemetry.jsonl"));
    assert.ok(events.length >= 2);
    assert.ok(events.every((event) => event.event === "research"));
    assert.ok(events.every((event) => event.correlationId === correlationId));
    assert.ok(events.every((event) => event.headSha === head));
    assert.equal(readResearchEvents(root).at(-1).state, "RESEARCH_COMPLETED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("telemetry path rejects aliases and symlinked state roots", () => {
  const root = tempRoot();
  try {
    assert.equal(telemetryPath(root), path.join(root, "state", "telemetry.jsonl"));
    assert.equal(telemetryPath(path.join(root, "state", "telemetry.jsonl")), path.join(root, "state", "telemetry.jsonl"));
    assert.throws(() => telemetryPath("relative-root"), /canonical absolute/);
    assert.throws(() => telemetryPath(`${root}/state/../state/telemetry.jsonl`), /canonical absolute/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("telemetry does not trust malformed existing records", () => {
  const root = tempRoot();
  try {
    const file = telemetryPath(root);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"schemaVersion":1,"unexpected":true}\n', { mode: 0o600 });
    assert.throws(() => readTelemetryEvents(file), /TELEMETRY_SCHEMA_REJECTED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
