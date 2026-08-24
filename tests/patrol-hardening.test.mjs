import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDigest, executeDirectives, sanitizePatrolDirectives } from "../scripts/patrol.mjs";
import { eventKey } from "../scripts/lib/ledger.mjs";

test("patrol keys PR freshness by stable head SHA, not comment-sensitive updated_at", () => {
  const headSha = "a".repeat(40);
  const signals = [{
    repo: "M1Vj/demo",
    openPulls: [{ n: 2, title: "draft", draft: true, headSha, updated: "changed-by-patrol-comment" }],
    activeIssues: [],
    failingRuns24h: [],
  }];
  const seen = new Set([eventKey("sig-pr", "M1Vj/demo", "2", headSha)]);
  assert.equal(buildDigest(signals, seen), "[]");
});

test("patrol downgrades every issue/PR comment directive to a private report", async () => {
  const directives = [
    { kind: "comment", repo: "M1Vj/demo", target: "pr", number: 2, body: "apply this fix" },
    { kind: "comment", repo: "M1Vj/demo", target: "issue", number: 3, body: "and this one" },
  ];
  const safe = sanitizePatrolDirectives(directives);
  assert.equal(safe.length, directives.length);
  assert.ok(safe.every((directive) => directive.kind === "report" && directive.downgraded === "public-comment-disabled"));
  assert.ok(safe.every((directive) => !Object.hasOwn(directive, "body")));

  const audit = { incident() {}, note() {} };
  const executed = await executeDirectives({}, { login: "M1Vj" }, directives, { tier1: ["M1Vj/demo"] }, audit);
  assert.equal(executed.mutations, 0);
  assert.equal(executed.results.length, 2);
  assert.ok(executed.results.every((result) => result.kind === "report" && result.ok));
});
