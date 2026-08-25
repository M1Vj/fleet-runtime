import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { sanitizeReviewPayload } from "../scripts/improve.mjs";

const source = readFileSync(new URL("../scripts/improve.mjs", import.meta.url), "utf8");
const finalize = source.slice(source.indexOf("async function modeFinalize"), source.indexOf("const MODES"));

test("improve finalize persists private review findings without public comments", () => {
  assert.doesNotMatch(finalize, /issues\/\$\{.*comments|verifyCommentAuthor|commentsPosted/);
  assert.match(finalize, /findings/);
  assert.match(finalize, /runRecord/);
});

test("improve review artifacts redact and bound untrusted findings before upload", () => {
  const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  const rawUrl = "https://example.test/private?token=raw";
  const rawMention = "@maintainer";
  const payload = sanitizeReviewPayload({
    verdict: "fix\u0007",
    findings: [{ severity: "high\n", title: `${token} ${rawUrl} ${rawMention}`, detail: `${"x".repeat(900)}\u0001` }],
  });
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, new RegExp(token));
  assert.doesNotMatch(serialized, /https:\/\/example\.test/);
  assert.doesNotMatch(serialized, /@maintainer/);
  assert.doesNotMatch(serialized, /[\u0000-\u001F]/);
  assert.ok(payload.findings[0].detail.length <= 400);
  assert.ok(payload.findings.length <= 8);
});
