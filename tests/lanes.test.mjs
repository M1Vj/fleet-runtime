import { test } from "node:test";
import assert from "node:assert/strict";
import { harvestFencedFiles, sanitizeControlChars } from "../scripts/lib/directives.mjs";

test("harvester: path line above fence", () => {
  const t = 'Here:\nV2FILE path=v2/chapter1.md\n```md\n# Chapter 1\ncontent\n```';
  const files = harvestFencedFiles(t);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "v2/chapter1.md");
  assert.match(files[0].content, /Chapter 1/);
});

test("harvester: forces prefix when missing", () => {
  const t = '**outline.tex**\n```\n\\section{Intro}\n```';
  const files = harvestFencedFiles(t, { forcePrefix: "v2/" });
  assert.equal(files[0].path, "v2/outline.tex");
});

test("harvester: skips blocks without any path nearby", () => {
  const t = 'random\n```\njust code no path\n```\n';
  assert.equal(harvestFencedFiles(t).length, 0);
});

test("harvester: multiple files dedup by path+head", () => {
  const t = 'a\nFILE path=v2/a.md\n```\nA\n```\nb\nFILE path=v2/b.md\n```\nB\n```';
  const files = harvestFencedFiles(t);
  assert.equal(files.length, 2);
});

test("sanitize: control chars inside strings only", () => {
  const fixed = sanitizeControlChars('{"a":"x\ny"}');
  assert.equal(JSON.parse(fixed).a, "x\ny");
});

test("kb harvester fallback parses prose-wrapped packages", () => {
  const t = "Sure!\n\nv2/identity/core-beliefs.md\n```md\n---\ntype: Identity\n---\n# Core beliefs\n```\nDone.";
  const files = harvestFencedFiles(t);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "v2/identity/core-beliefs.md");
});

test("merge classify: empty file list is HIGH (nothing additive)", async () => {
  const { classify } = await import("../scripts/merge.mjs");
  const r = classify([]);
  assert.equal(r.risk, "HIGH");
});

test("merge classify: docs-only small diff is LOW", async () => {
  const { classify } = await import("../scripts/merge.mjs");
  const r = classify([{ filename: "docs/guide.md", additions: 20, deletions: 2 }]);
  assert.equal(r.risk, "LOW");
  assert.equal(r.uiTouched, false);
});

test("merge classify: mdx counts as UI", async () => {
  const { classify } = await import("../scripts/merge.mjs");
  const r = classify([{ filename: "src/intro.mdx", additions: 10, deletions: 0 }]);
  assert.equal(r.uiTouched, true);
});

test("merge classify: workflow edits are HIGH", async () => {
  const { classify } = await import("../scripts/merge.mjs");
  const r = classify([{ filename: ".github/workflows/ci.yml", additions: 5, deletions: 1 }]);
  assert.equal(r.risk, "HIGH");
});

test("merge classify: >400 line diff is HIGH", async () => {
  const { classify } = await import("../scripts/merge.mjs");
  const r = classify([{ filename: "src/big.ts", additions: 300, deletions: 150 }]);
  assert.equal(r.risk, "HIGH");
  assert.equal(r.size, 450);
});

test("secretsInDiff flags leaked token patterns", async () => {
  const { secretsInDiff } = await import("../scripts/merge.mjs");
  const hits = secretsInDiff([{ filename: "cfg.ts", patch: "+const t = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';" }]);
  assert.equal(hits.length, 1);
});

test("decideStale: fresh/stale/missing/bad-heartbeat matrix", async () => {
  const { decideStale } = await import("../scripts/lib/watchdog-decide.mjs");
  const now = Date.now();
  assert.equal(decideStale(new Date(now - 5 * 60000).toISOString(), now).stale, false);
  assert.equal(decideStale(new Date(now - 2 * 3600 * 1000).toISOString(), now).stale, true);
  const missing = decideStale(null, now);
  assert.equal(missing.stale, true);
  assert.equal(missing.reason, "no-heartbeat");
  const bad = decideStale("not-a-date", now);
  assert.equal(bad.reason, "bad-heartbeat");
});
