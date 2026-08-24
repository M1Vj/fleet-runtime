import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendMemoryEvent,
  buildMemoryContext,
  deterministicEventId,
  memoryPath,
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

test("memory paths fail closed to canonical absolute roots or state files", () => {
  const root = path.join(tmpdir(), "pr-memory-path-contract");
  const canonical = path.join(root, "state", "pr-memory.jsonl");
  assert.equal(memoryPath(root), canonical);
  assert.equal(memoryPath(canonical), canonical);

  for (const invalid of [
    "",
    "relative-root",
    path.join(root, "state", "other.jsonl"),
    path.join(root, "pr-memory.jsonl"),
    `${root}/state/../state/pr-memory.jsonl`,
    path.join(root, "state", "pr-memory.jsonl.bak"),
  ]) {
    assert.throws(() => memoryPath(invalid), /absolute|canonical|state/i);
  }
});

test("event id is deterministic and includes the content hash", () => {
  const first = deterministicEventId(event());
  const second = deterministicEventId(event());
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, deterministicEventId(event({ runId: "a-different-run" })));
  assert.notEqual(first, deterministicEventId(event({ summary: "a different bounded issue" })));
  assert.notEqual(first, deterministicEventId(event({ attempt: 2 })));
});

test("redaction replaces token-like text before persistence", () => {
  const value = redactText("ghp_abcdefghijklmnopqrstuvwxyz1234567890 and AKIAIOSFODNN7EXAMPLE");
  assert.equal(value.includes("ghp_"), false);
  assert.equal(value.includes("AKIAIOSFODNN7EXAMPLE"), false);
  assert.match(value, /\[REDACTED\]/);
});

test("append and read redact complete PEM blocks and bounded credential forms", () => {
  const file = tempMemory();
  const pemBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturesegment123";
  const bearer = "Bearer abcdefghijklmnop1234567890";
  const query = "https://example.test/callback?access_token=abcdefghijklmnop1234567890&next=ok";
  const providerTokens = [
    "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    "github_pat_abcdefghijklmnopqrstuvwxyz1234567890",
    "AKIAIOSFODNN7EXAMPLE",
    "sk-abcdefghijklmnopqrstuvwxyz1234567890",
    "xoxb-1234567890-abcdefghijklmnop",
    "AIzaSyAbcdefghijklmnopqrstuv1234567890",
  ];
  const ordinary = "Bearer authentication is ordinary prose; Bearer version-compatibility remains prose; token=short";
  const pem = `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----`;

  appendMemoryEvent(file, event({
    summary: `${pem}\n${jwt}\n${bearer}\n${query}\n${ordinary}`,
    changedPaths: providerTokens.slice(0, 3),
    blockerIds: providerTokens.slice(3, 5),
    artifactRefs: [providerTokens[5]],
  }));

  const raw = readFileSync(file, "utf8");
  const [stored] = readMemoryEvents(file);
  assert.equal(raw.includes(pemBody), false);
  assert.equal(raw.includes("BEGIN PRIVATE KEY"), false);
  assert.equal(raw.includes("END PRIVATE KEY"), false);
  assert.equal(raw.includes(jwt), false);
  assert.equal(raw.includes("abcdefghijklmnop1234567890"), false);
  for (const token of providerTokens) assert.equal(raw.includes(token), false);
  assert.equal(stored.summary.includes(ordinary), true);
  assert.equal(stored.summary.includes(pemBody), false);
  assert.equal(stored.summary.includes(jwt), false);
});

test("append and read redact unterminated PEM bodies and plausible all-alpha bearers", () => {
  const file = tempMemory();
  const pemBody = "MIIEowIBAAKCAQEAunterminated-body-123456";
  const alphaBearer = "Bearer abcdefghijklmnopqrstuvwx";
  const ordinary = "Bearer authentication remains ordinary prose";
  const unterminatedPem = `-----BEGIN PRIVATE KEY-----\n${pemBody}`;

  appendMemoryEvent(file, event({ summary: `${ordinary}\n${alphaBearer}\n${unterminatedPem}` }));

  const raw = readFileSync(file, "utf8");
  const [stored] = readMemoryEvents(file);
  assert.equal(raw.includes(pemBody), false);
  assert.equal(raw.includes("BEGIN PRIVATE KEY"), false);
  assert.equal(raw.includes(alphaBearer), false);
  assert.equal(stored.summary.includes(ordinary), true);
});

test("append and read redact malformed lowercase PEM, URL fragments, and plain key assignments", () => {
  const file = tempMemory();
  const lowerPemBody = "lowercase-pem-body-0123456789";
  const lowerPem = `-----begin rsa private key-----\n${lowerPemBody}\n-----end rsa private key-----`;
  const plainPemBody = "plain-pem-body-9876543210";
  const plainPem = `BEGIN rsa private key\n${plainPemBody}\nEND rsa private key`;
  const fragmentToken = "https://example.test/callback#access_token=fragmentcredential1234567890";
  const assignmentToken = "api_key = 'plaincredential1234567890'";
  const ordinary = "token: short prose remains";

  appendMemoryEvent(file, event({
    summary: `${lowerPem}\n${plainPem}\n${fragmentToken}\n${assignmentToken}\n${ordinary}`,
  }));

  const raw = readFileSync(file, "utf8");
  const [stored] = readMemoryEvents(file);
  assert.equal(raw.includes(lowerPemBody), false);
  assert.equal(raw.includes("begin rsa private key"), false);
  assert.equal(raw.includes(plainPemBody), false);
  assert.equal(raw.includes(fragmentToken), false);
  assert.equal(raw.includes("fragmentcredential1234567890"), false);
  assert.equal(raw.includes(assignmentToken), false);
  assert.equal(raw.includes("plaincredential1234567890"), false);
  assert.equal(stored.summary.includes(ordinary), true);
});

test("duplicate append is an idempotent no-op", () => {
  const file = tempMemory();
  const first = appendMemoryEvent(file, event());
  const second = appendMemoryEvent(file, event({ runId: "different-run" }));
  assert.equal(first.appended, true);
  assert.equal(second.appended, false);
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
  assert.equal(readMemoryEvents(file).length, 1);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(existsSync(`${file}.lock`), false);
});

test("local writers fail closed on an existing lock and release it after rotation", () => {
  const file = tempMemory();
  const lock = `${file}.lock`;
  mkdirSync(lock, { mode: 0o700 });
  assert.throws(() => appendMemoryEvent(file, event()), /busy|lock/i);
  rmdirSync(lock);

  for (let i = 0; i < 3; i += 1) {
    appendMemoryEvent(file, event({ runId: `locked-${i}`, summary: `locked-event-${i}` }));
  }
  rotateMemory(file, { maxLines: 2 });
  assert.equal(existsSync(lock), false);
});

test("canonical and recovery symlinks never expose or modify external memory", () => {
  for (const linkKind of ["canonical", "previous"]) {
    const file = tempMemory();
    const outsideRoot = mkdtempSync(path.join(tmpdir(), "pr-memory-outside-"));
    const outside = path.join(outsideRoot, "sentinel.jsonl");
    const sentinel = `${JSON.stringify(event({ summary: `external-${linkKind}` }))}\n`;
    writeFileSync(outside, sentinel, "utf8");
    symlinkSync(outside, linkKind === "canonical" ? file : `${file}.prev`);

    assert.deepEqual(readMemoryEvents(file), []);
    assert.throws(() => appendMemoryEvent(file, event({ summary: `attempt-${linkKind}` })), /symlink|regular file|unsafe/i);
    assert.equal(readFileSync(outside, "utf8"), sentinel);
  }
});

test("a symlinked state directory fails closed without writing outside the state root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pr-memory-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "pr-memory-state-outside-"));
  const file = path.join(root, "state", "pr-memory.jsonl");
  symlinkSync(outside, path.join(root, "state"));

  assert.deepEqual(readMemoryEvents(file), []);
  assert.throws(() => appendMemoryEvent(file, event()), /symlink|directory|unsafe/i);
  assert.equal(existsSync(path.join(outside, "pr-memory.jsonl")), false);
});

test("a trusted system ancestor alias does not invalidate a real state directory", () => {
  const lexicalTmp = path.resolve(tmpdir());
  if (realpathSync(lexicalTmp) === lexicalTmp) return;
  const root = mkdtempSync(path.join(lexicalTmp, "pr-memory-alias-"));
  const file = path.join(root, "state", "pr-memory.jsonl");
  const result = appendMemoryEvent(file, event({ summary: "ancestor alias accepted" }));
  assert.equal(result.appended, true);
  assert.equal(readMemoryEvents(file).length, 1);
});

test("rotation preserves an old active dispatch claim beyond the nominal line bound", () => {
  const file = tempMemory();
  appendMemoryEvent(file, event({
    repo: "M1Vj/fleet-runtime",
    pr: 17,
    headSha: "7".repeat(40),
    lane: "merge",
    kind: "dispatch",
    state: "DISPATCH_UNKNOWN",
    artifactRefs: [`dispatch-key:${"6".repeat(64)}`],
  }), { maxLines: 100 });
  for (let index = 0; index < 8; index += 1) {
    appendMemoryEvent(file, event({ repo: "M1Vj/other", pr: index + 1, summary: `later-${index}` }), { maxLines: 100 });
  }
  rotateMemory(file, { maxLines: 3 });
  const events = readMemoryEvents(file);
  assert.ok(events.some((entry) => entry.state === "DISPATCH_UNKNOWN" && entry.pr === 17));
  assert.ok(events.some((entry) => entry.state === "ROTATED"));
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
  appendMemoryEvent(file, event({ headSha: "b".repeat(40), runId: "other-head", summary: "different-head" }));
  const context = buildMemoryContext(readMemoryEvents(file), {
    repo: "M1Vj/example-repo",
    pr: 42,
    headSha: "a".repeat(40),
    maxEvents: 2,
  });
  assert.equal(context.length, 2);
  assert.deepEqual(context.map((entry) => entry.runId), ["run-4", "run-3"]);
  assert.equal(context.some((entry) => entry.runId === "other"), false);
  assert.equal(context.some((entry) => entry.runId === "other-head"), false);
  assert.equal(JSON.stringify(context).includes("ghp_"), false);
});

test("rotation keeps the newest bounded lines and writes a summary event", () => {
  const file = tempMemory();
  for (let i = 0; i < 5; i += 1) {
    appendMemoryEvent(file, event({
      runId: `run-${i}`,
      createdAt: `2026-08-24T00:0${i}:00.000Z`,
      summary: `rotation-event-${i}`,
    }));
  }
  const result = rotateMemory(file, { maxLines: 3 });
  assert.equal(result.rotated, true);
  const lines = readMemoryEvents(file);
  assert.equal(lines.length, 3);
  assert.equal(lines.at(-1).kind, "terminal");
  assert.equal(lines.at(-1).state, "ROTATED");
  assert.equal(lines.at(-1).summary.includes("3"), true);
});

test("rotation summaries are global, private, recoverable, and do not accumulate", () => {
  const file = tempMemory();
  for (let i = 0; i < 3; i += 1) {
    appendMemoryEvent(file, event({
      runId: `rotate-${i}`,
      createdAt: `2026-08-24T00:0${i}:00.000Z`,
      summary: `rotation-history-${i}`,
    }));
  }

  rotateMemory(file, { maxLines: 2 });
  const previous = `${file}.prev`;
  assert.equal(existsSync(previous), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(previous).mode & 0o777, 0o600);
  assert.equal(readFileSync(previous, "utf8").trim().split("\n").length, 3);

  let lines = readMemoryEvents(file);
  let summary = lines.at(-1);
  assert.equal(summary.state, "ROTATED");
  assert.equal(summary.repo, "");
  assert.equal(summary.pr, 0);
  assert.equal(summary.headSha, "");
  assert.equal(buildMemoryContext(lines, {
    repo: "M1Vj/example-repo",
    pr: 42,
    headSha: "a".repeat(40),
  }).some((entry) => entry.state === "ROTATED"), false);

  appendMemoryEvent(file, event({
    runId: "rotate-next",
    createdAt: "2026-08-24T00:10:00.000Z",
    summary: "rotation-history-next",
  }));
  rotateMemory(file, { maxLines: 2 });
  lines = readMemoryEvents(file);
  const summaries = lines.filter((entry) => entry.state === "ROTATED");
  assert.equal(summaries.length, 1);
  assert.equal(new Set(summaries.map((entry) => entry.eventId)).size, summaries.length);
  assert.equal(readdirSync(path.dirname(file)).some((name) => name.startsWith(`${path.basename(file)}.tmp-`)), false);
});

test("reading and appending recover from a missing canonical file using the previous generation", () => {
  const file = tempMemory();
  for (let i = 0; i < 3; i += 1) {
    appendMemoryEvent(file, event({ runId: `recover-${i}`, summary: `recover-event-${i}` }));
  }
  rotateMemory(file, { maxLines: 2 });
  const previous = `${file}.prev`;
  const previousEvents = readFileSync(previous, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  unlinkSync(file);

  assert.deepEqual(readMemoryEvents(file).map((entry) => entry.eventId), previousEvents.map((entry) => entry.eventId));
  const result = appendMemoryEvent(file, event({ runId: "recovered-run", summary: "recovered-event" }));
  assert.equal(result.appended, true);
  assert.equal(existsSync(file), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readMemoryEvents(file).some((entry) => entry.summary === "recovered-event"), true);
});

test("rotation fault before target replacement leaves the canonical generation intact", () => {
  const file = tempMemory();
  for (let i = 0; i < 3; i += 1) {
    appendMemoryEvent(file, event({ runId: `fault-${i}`, summary: `fault-event-${i}` }));
  }
  const before = readFileSync(file, "utf8");
  const previous = `${file}.prev`;
  mkdirSync(previous, { mode: 0o700 });

  assert.throws(() => rotateMemory(file, { maxLines: 2 }));
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(readdirSync(path.dirname(file)).some((name) => name.startsWith(`${path.basename(file)}.tmp-`)), false);
  assert.equal(readdirSync(path.dirname(file)).some((name) => name.startsWith(`${path.basename(file)}.prev-tmp-`)), false);
  rmdirSync(previous);
});

test("rotation with a one-line limit keeps only the summary event", () => {
  const file = tempMemory();
  for (let i = 0; i < 3; i += 1) {
    appendMemoryEvent(file, event({ runId: `one-${i}`, summary: `one-line-event-${i}` }));
  }
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

test("memory context accounts for array framing and tiny character bounds", () => {
  const file = tempMemory();
  appendMemoryEvent(file, event({ runId: "bound-1", createdAt: "2026-08-24T00:00:00.000Z", summary: "bound-event-1" }));
  appendMemoryEvent(file, event({ runId: "bound-2", createdAt: "2026-08-24T00:01:00.000Z", summary: "bound-event-2" }));
  const entries = readMemoryEvents(file);
  const exactTwoEventLength = JSON.stringify(entries).length;
  const underTwoEventCap = buildMemoryContext(entries, { maxEvents: 2, maxChars: exactTwoEventLength - 1 });
  assert.equal(underTwoEventCap.length, 1);
  assert.equal(JSON.stringify(underTwoEventCap).length <= exactTwoEventLength - 1, true);

  const tiny = buildMemoryContext(entries, { maxEvents: 2, maxChars: 1 });
  assert.deepEqual(tiny, []);
  assert.equal(JSON.stringify(buildMemoryContext(entries, { maxEvents: 2, maxChars: 2 })).length, 2);
});

test("malformed lines are ignored while valid memory remains readable", () => {
  const file = tempMemory();
  writeFileSync(file, "not-json\n" + JSON.stringify(event()) + "\n", "utf8");
  assert.equal(readMemoryEvents(file).length, 1);
});
