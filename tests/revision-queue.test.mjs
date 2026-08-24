import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isSafeSupportingPath,
  headRepositoryMatches,
  parseRevisionFiles,
  validateRevisionFiles,
  validateTarget,
} from "../scripts/lib/revision-queue.mjs";

const headSha = "a".repeat(40);

test("valid target normalizes repo, PR number, and optional head SHA", () => {
  assert.deepEqual(validateTarget({ repo: "M1Vj/example-repo", pr: "42", headSha }), {
    ok: true,
    repo: "M1Vj/example-repo",
    pr: 42,
    headSha,
    errors: [],
  });
});

test("target validation rejects missing or malformed values", () => {
  for (const input of [
    {},
    { repo: "", pr: 42 },
    { repo: "owner", pr: 42 },
    { repo: "owner/name", pr: 0 },
    { repo: "owner/name", pr: -1 },
    { repo: "owner/name", pr: "not-a-number" },
    { repo: "owner/name", pr: 42, headSha: "short" },
    { repo: "owner/name", pr: 42, headSha: "g".repeat(40) },
  ]) {
    assert.equal(validateTarget(input).ok, false, JSON.stringify(input));
  }
});

test("revision output allows changed files and at most two safe supporting files", () => {
  const changedPaths = ["src/app.js", "README.md"];
  const result = validateRevisionFiles([
    { path: "src/app.js", content: "fixed" },
    { path: "support/one.md", content: "one" },
    { path: "support/two.md", content: "two" },
  ], changedPaths);
  assert.equal(result.ok, true);
  assert.deepEqual(result.supportingPaths, ["support/one.md", "support/two.md"]);
});

test("revision output rejects a third supporting file and unknown unsafe paths", () => {
  const changedPaths = ["src/app.js"];
  const tooMany = validateRevisionFiles([
    { path: "src/app.js", content: "fixed" },
    { path: "support/one.md", content: "one" },
    { path: "support/two.md", content: "two" },
    { path: "support/three.md", content: "three" },
  ], changedPaths);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.errors.join(" "), /supporting/i);

  for (const path of ["../escape", ".env", "state/new.json", "audit/new.md", "credentials.txt", ".github/workflows/new.yml"]) {
    const result = validateRevisionFiles([{ path, content: "x" }], changedPaths);
    assert.equal(result.ok, false, path);
  }
});

test("an already changed workflow path is allowed only as an existing changed file", () => {
  assert.equal(isSafeSupportingPath(".github/workflows/merge.yml", [".github/workflows/merge.yml"]), true);
  assert.equal(isSafeSupportingPath(".github/workflows/merge.yml", ["src/app.js"]), false);
});

test("revision output rejects oversized content and duplicate paths", () => {
  const result = validateRevisionFiles([
    { path: "src/app.js", content: "one" },
    { path: "src/app.js", content: "two" },
    { path: "README.md", content: "x".repeat(60001) },
  ], ["src/app.js", "README.md"]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /duplicate|too large/i);
});

test("revision parser accepts normal code and config extensions", () => {
  const parsed = parseRevisionFiles([
    "FILE path=scripts/fix.mjs",
    "```js",
    "export const fixed = true;",
    "```",
    "FILE path=src/component.tsx",
    "```tsx",
    "export function Component() { return null; }",
    "```",
    "FILE path=config/settings.json",
    "```json",
    '{"enabled":true}',
    "```",
  ].join("\n"));
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.files.map((file) => file.path), ["scripts/fix.mjs", "src/component.tsx", "config/settings.json"]);
  assert.equal(parsed.files[2].content, '{"enabled":true}');
});

test("revision parser reports malformed or unterminated FILE blocks", () => {
  const parsed = parseRevisionFiles("FILE path=src/fix.ts\n```ts\nconst broken = true;");
  assert.equal(parsed.files.length, 0);
  assert.match(parsed.errors.join(" "), /unterminated/i);
  const missingPath = parseRevisionFiles("FILE nope=src/fix.ts\n```ts\nconst x = 1;\n```");
  assert.equal(missingPath.files.length, 0);
  assert.match(missingPath.errors.join(" "), /FILE path/i);
});

test("fork-origin heads fail closed unless the head repository is the target", () => {
  assert.equal(headRepositoryMatches({ head: { repo: { full_name: "owner/name" } } }, "owner/name"), true);
  assert.equal(headRepositoryMatches({ head: { repo: { full_name: "other/name" } } }, "owner/name"), false);
  assert.equal(headRepositoryMatches({ head: { repo: null } }, "owner/name"), false);
});
