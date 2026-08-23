import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDirectives } from "../scripts/lib/directives.mjs";

test("valid report directive passes", () => {
  const r = validateDirectives('[{"kind":"report","section":"triage","text":"all quiet"}]');
  assert.equal(r.ok, true);
  assert.equal(r.directives.length, 1);
});

test("fenced json is tolerated", () => {
  const r = validateDirectives('```json\n[{"kind":"noop","reason":"nothing"}]\n```');
  assert.equal(r.ok, true);
  assert.equal(r.directives[0].kind, "noop");
});

test("unknown kind rejected", () => {
  const r = validateDirectives('[{"kind":"explode","repo":"a/b"}]');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /unknown kind/);
});

test("path traversal in draft_pr rejected", () => {
  const r = validateDirectives(
    '[{"kind":"draft_pr","repo":"a/b","title":"t","body":"b","branch":"fleet/abcde","files":[{"path":"../evil","content":"x"}]}]',
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /rejected|invalid/);
});

test("secret-like body rejected", () => {
  const r = validateDirectives(
    '[{"kind":"comment","repo":"a/b","target":"issue","number":1,"body":"leak gho_ABCDEF1234567890abcdef here"}]',
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /secret-like/);
});

test("non-array payload rejected", () => {
  const r = validateDirectives('{"kind":"noop"}');
  assert.equal(r.ok, false);
});

test("oversized text rejected", () => {
  const big = "x".repeat(5000);
  const r = validateDirectives(JSON.stringify([{ kind: "report", section: "docs", text: big }]));
  assert.equal(r.ok, false);
});

test("bad branch name rejected", () => {
  const r = validateDirectives(
    '[{"kind":"draft_pr","repo":"a/b","title":"t","body":"b","branch":"main","files":[{"path":"docs/x.md","content":"c"}]}]',
  );
  assert.equal(r.ok, false);
});

test("sanitizeControlChars rescues raw newlines inside strings", async () => {
  const { sanitizeControlChars } = await import("../scripts/lib/directives.mjs");
  const broken = '{"title":"x","files":[{"path":"docs/a.md","content":"line1\nline2\ttab"}]}';
  const fixed = JSON.parse(sanitizeControlChars(broken));
  assert.equal(fixed.files[0].content, "line1\nline2\ttab");
});

test("validateDirectives accepts model output with control chars via fallback", async () => {
  const { validateDirectives } = await import("../scripts/lib/directives.mjs");
  const r = validateDirectives('Sure! Here you go:\n[{"kind":"report","section":"docs","text":"para1\npara2"}]\nDone.');
  assert.equal(r.ok, true);
  assert.equal(r.directives[0].text, "para1\npara2");
});
