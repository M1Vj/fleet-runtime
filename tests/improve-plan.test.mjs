import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePlan,
  salvagePlan,
  salvagePartialPlan,
  harvestPlanCandidates,
  collectValidPlanFiles,
} from "../scripts/improve.mjs";

const STRICT = JSON.stringify({
  title: "fix docs link",
  summary: "correct a stale link",
  prBody: "updates one doc link",
  risks: "none",
  files: [{ path: "docs/guide.md", content: "# Guide\nok\n" }],
});

test("valid strict plan passes", () => {
  const p = parsePlan(STRICT);
  assert.equal(p.title, "fix docs link");
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].path, "docs/guide.md");
  const s = salvagePlan(STRICT, "fallback");
  assert.equal(s.files.length, 1);
  assert.equal(s.degraded, false);
});

test("fenced+prose salvage", () => {
  const reply = [
    "Sure! Here is your plan:",
    "```json",
    JSON.stringify({
      title: "tune retry",
      summary: "short backoff",
      prBody: "retry tweak",
      risks: "low",
      files: [{ path: "docs/notes.md", content: "hello\n" }],
    }),
    "```",
    "Hope this helps!",
  ].join("\n");
  const s = salvagePlan(reply, "fallback");
  assert.equal(s.title, "tune retry");
  assert.equal(s.files.length, 1);
  assert.equal(s.files[0].content, "hello\n");
  assert.ok(harvestPlanCandidates(reply).length >= 2);
});

test("trailing-comma/unquoted-key salvage", () => {
  const reply = '{title:"loose plan",summary:"s",prBody:"b",risks:"r",files:[{path:"docs/a.md",content:"hi",},],}';
  assert.throws(() => parsePlan(reply));
  const s = salvagePlan(reply, "fallback");
  assert.equal(s.title, "loose plan");
  assert.equal(s.files.length, 1);
  assert.equal(s.files[0].path, "docs/a.md");
  assert.equal(s.files[0].content, "hi");
});

test("single-file object salvages to one-file plan", () => {
  const reply = JSON.stringify({
    title: "solo",
    summary: "s",
    files: { path: "docs/solo.md", content: "body\n" },
  });
  const s = salvagePlan(reply, "fallback");
  assert.equal(s.files.length, 1);
  assert.equal(s.files[0].path, "docs/solo.md");
});

test("partial-plan degradation keeps valid subset", () => {
  const reply = JSON.stringify({
    title: "mixed",
    summary: "s",
    files: [
      { path: "docs/keep.md", content: "keep\n" },
      { path: "../evil.md", content: "drop\n" },
    ],
  });
  assert.throws(() => salvagePlan(reply, "fallback"));
  const p = salvagePartialPlan(reply, "fallback");
  assert.equal(p.degraded, true);
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].path, "docs/keep.md");
  assert.equal(p.files[0].content, "keep\n");
});

test("unfixable plan throws (caller stays honest exit-1)", () => {
  assert.throws(() => salvagePlan("hello, no plan here", "fallback"));
  assert.throws(() => salvagePartialPlan("hello, no plan here", "fallback"));
  assert.throws(() => salvagePlan(JSON.stringify({ title: "empty", files: [] }), "fallback"));
  assert.throws(() => salvagePartialPlan(JSON.stringify({ title: "empty", files: [] }), "fallback"));
});

test("budget caps enforced", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ path: `docs/f${i}.md`, content: "x" }));
  assert.throws(() => salvagePlan(JSON.stringify({ title: "t", files: many }), "fallback"));
  const big = "x".repeat(15001);
  assert.throws(() => salvagePlan(JSON.stringify({ title: "t", files: [{ path: "docs/big.md", content: big }] }), "fallback"));
  const capped = collectValidPlanFiles(JSON.stringify({ title: "t", files: many }));
  assert.ok(capped.length <= 6);
});

test("path caps enforced", () => {
  for (const bad of ["../evil.md", ".env", "state/x.md", "audit/y.md", "id_rsa"]) {
    assert.throws(
      () => salvagePlan(JSON.stringify({ title: "t", files: [{ path: bad, content: "x" }] }), "fallback"),
      undefined,
      bad,
    );
  }
  const p = salvagePartialPlan(
    JSON.stringify({ title: "t", files: [{ path: "docs/ok.md", content: "ok" }, { path: "state/no.md", content: "no" }] }),
    "fallback",
  );
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].path, "docs/ok.md");
});
