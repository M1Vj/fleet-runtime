import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDirectives } from "../scripts/lib/directives.mjs";

test("valid report directive passes", () => {
  const r = validateDirectives('[{"kind":"report","section":"triage","text":"all quiet"}]');
  assert.equal(r.ok, true);
});

test("fenced json tolerated", () => {
  const r = validateDirectives('```json\n[{"kind":"noop","reason":"ok"}]\n```');
  assert.equal(r.ok, true);
});

test("unknown kind rejected", () => {
  assert.equal(validateDirectives('[{"kind":"explode"}]').ok, false);
});

test("path traversal rejected", () => {
  const r = validateDirectives('[{"kind":"draft_pr","repo":"a/b","title":"t","body":"b","branch":"fleet/abcde","files":[{"path":"../x","content":"y"}]}]');
  assert.equal(r.ok, false);
});

test("secret-like content rejected", () => {
  assert.equal(validateDirectives('[{"kind":"comment","repo":"a/b","target":"issue","number":1,"body":"gho_ABCDEF1234567890abcdef"}]').ok, false);
});

test("non-array rejected", () => {
  assert.equal(validateDirectives('{"kind":"noop"}').ok, false);
});

test("bad branch rejected", () => {
  const r = validateDirectives('[{"kind":"draft_pr","repo":"a/b","title":"t","body":"b","branch":"main","files":[{"path":"docs/x.md","content":"c"}]}]');
  assert.equal(r.ok, false);
});

test("sanitize rescues raw newlines in strings", async () => {
  const { sanitizeControlChars } = await import("../scripts/lib/directives.mjs");
  assert.equal(JSON.parse(sanitizeControlChars('{"a":"x\ny"}')).a, "x\ny");
});

test("extractJsonArray handles prose-wrapped output", async () => {
  const { extractJsonArray } = await import("../scripts/lib/directives.mjs");
  const arr = extractJsonArray('Sure!\n[{"kind":"noop","reason":"ok"}]\nDone.');
  assert.equal(arr.length, 1);
});

test("classify depth: docs-only = depth 1", async () => {
  const { classify } = await import("../scripts/merge.mjs");
  const r = classify([{ filename: "docs/guide.md", additions: 20, deletions: 2 }]);
  assert.equal(r.depth, 1);
  assert.equal(r.uiTouched, false);
});

test("classify depth: UI change = depth 2", async () => {
  const { classify } = await import("../scripts/merge.mjs");
  const r = classify([{ filename: "src/intro.mdx", additions: 10 }]);
  assert.equal(r.depth, 2);
  assert.equal(r.uiTouched, true);
});

test("classify depth: workflow deletion = depth 3", async () => {
  const { classify } = await import("../scripts/merge.mjs");
  const r = classify([{ filename: ".github/workflows/ci.yml", additions: 5, deletions: 30 }]);
  assert.equal(r.depth, 3);
});

test("classify depth: sensitive path escalates", async () => {
  const { classify } = await import("../scripts/merge.mjs");
  const r = classify([{ filename: ".env.production", additions: 3 }]);
  assert.ok(r.depth >= 2);
});

test("classify depth: no additions = max depth", async () => {
  const { classify } = await import("../scripts/merge.mjs");
  const r = classify([{ filename: "docs/x.md", additions: 0, deletions: 10 }]);
  assert.equal(r.depth, 3);
});

test("secretsInDiff flags tokens", async () => {
  const { secretsInDiff } = await import("../scripts/merge.mjs");
  const hits = secretsInDiff([{ filename: "cfg.ts", patch: "+const t = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';" }]);
  assert.equal(hits.length, 1);
});

test("decideStale matrix", async () => {
  const { decideStale } = await import("../scripts/lib/watchdog-decide.mjs");
  const now = Date.now();
  assert.equal(decideStale(new Date(now - 5 * 60000).toISOString(), now).stale, false);
  assert.equal(decideStale(new Date(now - 2 * 3600000).toISOString(), now).stale, true);
  assert.equal(decideStale(null, now).stale, true);
});

test("planWatchdogActions: stale plans re-enables + alert", async () => {
  const { planWatchdogActions } = await import("../scripts/lib/watchdog-decide.mjs");
  const now = Date.now();
  const p = planWatchdogActions({ lastRunUtc: new Date(now - 5 * 3600000).toISOString() }, now);
  assert.equal(p.stale, true);
  assert.ok(p.actions.filter((a) => a.kind === "enable-workflow").length >= 6);
  assert.equal(p.actions.filter((a) => a.kind === "file-alert-issue").length, 1);
});

test("shouldCoalesce only for schedule trigger", async () => {
  const { shouldCoalesce } = await import("../scripts/lib/watchdog-decide.mjs");
  const now = Date.now();
  assert.equal(shouldCoalesce("manual", new Date(now - 60000).toISOString(), now).coalesce, false);
  assert.equal(shouldCoalesce("schedule", new Date(now - 60000).toISOString(), now).coalesce, true);
});

test("resolveModelChain parsing", async () => {
  const { resolveModelChain } = await import("../scripts/lib/model.mjs");
  assert.deepEqual(resolveModelChain({}), ["opencode/x-preview-f-free"]);
  assert.equal(resolveModelChain({ FLEET_MODEL_CHAIN: "a/b,c/d" }).length, 2);
});

test("summarizeEvents window filtering", async () => {
  const { summarizeEvents } = await import("../scripts/lib/status.mjs");
  const now = Date.now();
  const s = summarizeEvents([
    JSON.stringify({ t: new Date(now - 3600000).toISOString(), lane: "patrol", state: "SUCCESS" }),
    JSON.stringify({ t: new Date(now - 30 * 86400000).toISOString(), lane: "old", state: "SUCCESS" }),
  ], now);
  assert.equal(s.total, 1);
  assert.equal(s.perLane.patrol.SUCCESS, 1);
});

test("harvestFencedFiles extracts path+content", async () => {
  const { harvestFencedFiles } = await import("../scripts/lib/directives.mjs");
  const files = harvestFencedFiles("V2FILE path=v2/ch.md\n```md\n# Hello\n```");
  assert.equal(files[0].path, "v2/ch.md");
});


