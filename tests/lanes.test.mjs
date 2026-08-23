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

test("planWatchdogActions: stale plans re-enables+alert; fresh plans none", async () => {
  const { planWatchdogActions } = await import("../scripts/lib/watchdog-decide.mjs");
  const now = Date.now();
  const stalePlan = planWatchdogActions({ lastRunUtc: new Date(now - 5 * 3600 * 1000).toISOString() }, now);
  assert.equal(stalePlan.stale, true);
  assert.ok(stalePlan.actions.filter((a) => a.kind === "enable-workflow").length >= 6);
  assert.equal(stalePlan.actions.filter((a) => a.kind === "file-alert-issue").length, 1);
  const freshPlan = planWatchdogActions({ lastRunUtc: new Date(now - 60000).toISOString() }, now);
  assert.equal(freshPlan.actions.length, 0);
});

test("shouldCoalesce: only schedule triggers coalesce", async () => {
  const { shouldCoalesce } = await import("../scripts/lib/watchdog-decide.mjs");
  const now = Date.now();
  assert.equal(shouldCoalesce("manual", new Date(now - 60000).toISOString(), now).coalesce, false);
  assert.equal(shouldCoalesce("schedule", new Date(now - 60000).toISOString(), now).coalesce, true);
  assert.equal(shouldCoalesce("schedule", new Date(now - 60 * 60000).toISOString(), now).coalesce, false);
});

test("summarizeEvents: window filtering and per-lane counts", async () => {
  const { summarizeEvents } = await import("../scripts/lib/status.mjs");
  const now = Date.now();
  const lines = [
    JSON.stringify({ t: new Date(now - 3600 * 1000).toISOString(), lane: "patrol", state: "SUCCESS" }),
    JSON.stringify({ t: new Date(now - 2 * 86400000).toISOString(), lane: "merge", state: "SUCCESS" }),
    JSON.stringify({ t: new Date(now - 30 * 86400000).toISOString(), lane: "old", state: "SUCCESS" }),
    JSON.stringify({ t: new Date(now - 7200 * 1000).toISOString(), lane: "deep", state: "BLOCKED" }),
  ];
  const s = summarizeEvents(lines, now);
  assert.equal(s.total, 3);
  assert.equal(s.perLane.patrol.SUCCESS, 1);
  assert.equal(s.perLane.deep.BLOCKED, 1);
  assert.equal(s.perLane.merge.SUCCESS, 1);
  assert.equal(s.perLane.old, undefined);
});

test("gateway breaker: opens on markDown within window, clears after expiry", async () => {
  const gh = await import("../scripts/lib/gateway-health.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const root = mkdtempSync(pathMod.join(tmpdir(), "gw-"));
  assert.equal(gh.gatewayCircuitOpen(root), false);
  gh.markGatewayDown(root, "test outage");
  assert.equal(gh.gatewayCircuitOpen(root), true);
  // simulate age beyond OPEN_MS by backdating mtime+content
  const p = pathMod.join(root, "state", "gateway-health.json");
  const data = JSON.parse(await import("node:fs").then ? (await import("node:fs")).readFileSync(p, "utf8") : "{}");
  data.downSince = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  (await import("node:fs")).writeFileSync(p, JSON.stringify(data));
  assert.equal(gh.gatewayCircuitOpen(root), false);
});
