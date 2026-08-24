import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isSafeSupportingPath,
  headRepositoryMatches,
  parseRevisionFiles,
  validatePrDiffFiles,
  validateRevisionFiles,
  validateTarget,
} from "../scripts/lib/revision-queue.mjs";

const headSha = "a".repeat(40);

test("valid target requires the M1Vj repo owner and a 40-hex head SHA", () => {
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
    { repo: "other/name", pr: 42, headSha: "a".repeat(40) },
    { repo: "M1Vj/name", pr: 42 },
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

test("revision paths reject comment/control punctuation while keeping normal source paths", () => {
  for (const filePath of ["x).md", "src/`inject`.js", "docs/[notes].md", "config/percent%20.json", "src/line\nfeed.js"]) {
    const result = validateRevisionFiles([{ path: filePath, content: "x" }], [filePath]);
    assert.equal(result.ok, false, filePath);
  }
  assert.equal(validateRevisionFiles([{ path: "src/fixed-file.mjs", content: "x" }], ["src/fixed-file.mjs"]).ok, true);
});

test("workflow paths are rejected even when already changed", () => {
  assert.equal(isSafeSupportingPath(".github/workflows/merge.yml", [".github/workflows/merge.yml"]), false);
  assert.equal(isSafeSupportingPath(".github/workflows/merge.yml", ["src/app.js"]), false);
});

test("revision policy rejects operational, auth, dependency, and deployment paths", () => {
  for (const filePath of [
    ".github/actions/check/action.yml",
    "auth/session.ts",
    "security/policy.ts",
    "db/migrations/001.sql",
    "infra/main.tf",
    "deploy/release.sh",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    "pyproject.toml",
    "requirements-dev.txt",
    "requirements-prod.txt",
    "requirements/base.txt",
    "Pipfile.lock",
    "poetry.lock",
    "setup.py",
    "setup.cfg",
    "Cargo.toml",
    "Cargo.lock",
    "go.mod",
    "go.sum",
    "go.work",
    "go.work.sum",
    "Gemfile",
    "Gemfile.lock",
    "app.gemspec",
    "composer.json",
    "composer.lock",
    "pom.xml",
    ".mvn/wrapper/maven-wrapper.properties",
    "build.gradle.kts",
    "settings.gradle",
    "gradle.properties",
    "gradle.lockfile",
    "gradle/libs.versions.toml",
    "Dockerfile",
    "docker-compose.yml",
    "compose.yaml",
    "Makefile",
    ".nvmrc",
    "actions/action.yml",
    ".github/dependabot.yml",
    ".github/dependabot/config.yml",
    ".github/dependabot",
    ".env.production",
    "credentials/config.json",
  ]) {
    const result = validateRevisionFiles([{ path: filePath, content: "x" }], [filePath]);
    assert.equal(result.ok, false, filePath);
  }
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

test("PR diff metadata requires fewer than 100 files and a usable patch for every file", () => {
  assert.equal(validatePrDiffFiles([{ filename: "src/a.js", patch: "@@ -1 +1 @@" }]).ok, true);
  assert.equal(validatePrDiffFiles([{ filename: "src/a.js", patch: "" }]).ok, false);
  assert.equal(validatePrDiffFiles([{ filename: "src/a.js" }]).ok, false);
  assert.equal(validatePrDiffFiles(Array.from({ length: 100 }, (_, i) => ({ filename: `src/${i}.js`, patch: "@@" }))).ok, false);
});
