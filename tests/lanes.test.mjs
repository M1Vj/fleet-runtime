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
