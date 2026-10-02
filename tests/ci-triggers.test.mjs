import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");

/** Workflows whose push trigger must never exist: a push may not start a self-modifying loop. */
const MUTATING_WORKFLOWS = [
  "improve.yml",
  "deep.yml",
  "patrol.yml",
  "watchdog.yml",
  "merge.yml",
  "retro.yml",
  "thesis.yml",
  "kb.yml",
  "model-refresh.yml",
  "orchestrate.yml",
];

/** Verification workflows that must exercise every push to main. */
const PUSH_VERIFICATION_WORKFLOWS = ["selftest.yml", "ci-diag.yml"];

const ALL_WORKFLOWS = fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml"));

function readWorkflow(name) {
  return fs.readFileSync(path.join(WORKFLOW_DIR, name), "utf8");
}

/**
 * Returns the raw text of the top-level `on:` block, or null when absent.
 * A top-level key starts at column 0; the block runs until the next column-0 key.
 */
function onBlock(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^on:\s*(#.*)?$/.test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/** Nested mapping keys present inside a block, dedented, e.g. ["push", "schedule"]. */
function blockKeys(block) {
  if (block === null) return [];
  return [...new Set(block.split("\n").map((l) => l.match(/^\s*([A-Za-z0-9_-]+):/)?.[1]).filter(Boolean))];
}

/** Scalar list items under `parent:` inside a block, e.g. branches for push. */
function listUnder(block, parent) {
  const out = [];
  const lines = (block ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp(`^\\s*${parent}:`).test(lines[i])) continue;
    const parentIndent = lines[i].match(/^\s*/)[0].length;
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^\s*-\s+(.+?)\s*$/);
      if (!item) {
        if (/^\s*\S/.test(lines[j]) || lines[j].trim() === "") break;
        continue;
      }
      if (lines[j].match(/^\s*/)[0].length <= parentIndent) break;
      out.push(item[1].replace(/^["']|["']$/g, ""));
    }
  }
  return out;
}

function concurrencyBlock(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^concurrency:\s*(#.*)?$/.test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

test("every workflow in .github/workflows is on disk and non-empty", () => {
  assert.ok(ALL_WORKFLOWS.length >= 13, `expected at least 13 workflows, found ${ALL_WORKFLOWS.length}`);
  for (const name of ALL_WORKFLOWS) {
    const text = readWorkflow(name);
    assert.ok(text.trim().length > 0, `${name} is empty`);
    assert.match(text, /^name:\s*\S/m, `${name} has no top-level name`);
    assert.ok(onBlock(text) !== null, `${name} has no top-level on: block`);
  }
});

test("the verification workflows declare a push trigger scoped to main", () => {
  for (const name of PUSH_VERIFICATION_WORKFLOWS) {
    const block = onBlock(readWorkflow(name));
    assert.notEqual(block, null, `${name} has no on: block`);
    assert.ok(blockKeys(block).includes("push"), `${name} does not declare a push trigger`);
    assert.deepEqual(listUnder(block, "branches"), ["main"], `${name} push trigger must be scoped to main only`);
  }
});

test("SAFETY INVARIANT: no mutating workflow declares a push trigger", () => {
  for (const name of MUTATING_WORKFLOWS) {
    assert.ok(fs.existsSync(path.join(WORKFLOW_DIR, name)), `${name} listed as mutating but is missing`);
    const block = onBlock(readWorkflow(name));
    assert.notEqual(block, null, `${name} has no on: block`);
    assert.ok(
      !blockKeys(block).includes("push"),
      `mutating workflow ${name} must not trigger on push: it would start a self-modifying loop`,
    );
    assert.deepEqual(listUnder(block, "branches"), [], `${name} must not branch-filter on push`);
  }
});

test("only the verification workflows gained a push trigger", () => {
  const withPush = ALL_WORKFLOWS
    .filter((name) => blockKeys(onBlock(readWorkflow(name))).includes("push"))
    .sort();
  assert.deepEqual(withPush, [...PUSH_VERIFICATION_WORKFLOWS].sort());
});

test("every push-triggered workflow declares concurrency so pushes cannot queue", () => {
  for (const name of PUSH_VERIFICATION_WORKFLOWS) {
    const block = concurrencyBlock(readWorkflow(name));
    assert.notEqual(block, null, `${name} has no concurrency block`);
    assert.match(block, /group:\s*\S/, `${name} concurrency has no group`);
    assert.match(
      block,
      /cancel-in-progress:\s*\S/,
      `${name} concurrency does not decide cancellation, so a push burst can queue`,
    );
  }
});

test("push-triggered workflows run on public GitHub-hosted runners and stay read-only", () => {
  for (const name of PUSH_VERIFICATION_WORKFLOWS) {
    const text = readWorkflow(name);
    const runsOn = [...text.matchAll(/^\s*runs-on:\s*(.+?)\s*$/gm)].map((m) => m[1]);
    assert.ok(runsOn.length > 0, `${name} has no runs-on`);
    for (const value of runsOn) {
      assert.equal(
        value,
        "ubuntu-latest",
        `${name} runs-on ${value}: a self-hosted or non-Linux runner is not available for a public repo push`,
      );
    }
    assert.match(text, /^permissions:\s*$/m, `${name} declares no explicit permissions`);
    const permissions = text.match(/^permissions:\s*\n((?:\s+.*\n?)*)/m)?.[1] ?? "";
    assert.match(
      permissions,
      /contents:\s*read/,
      `${name} must hold contents: read: verification must not be able to write the repo`,
    );
    assert.ok(
      !/contents:\s*write/.test(permissions),
      `${name} must not hold contents: write: push-triggered verification must stay read-only`,
    );
  }
});

test("selftest keeps its schedule and dispatch triggers alongside push", () => {
  const keys = blockKeys(onBlock(readWorkflow("selftest.yml")));
  for (const trigger of ["push", "schedule", "workflow_dispatch"]) {
    assert.ok(keys.includes(trigger), `selftest.yml lost its ${trigger} trigger`);
  }
  const block = onBlock(readWorkflow("selftest.yml"));
  assert.match(block, /schedule:\s*\n\s*-\s*cron:/, "selftest.yml lost its daily cron");
});

test("selftest supersedes stale push runs but never cancels a scheduled run", () => {
  const block = concurrencyBlock(readWorkflow("selftest.yml"));
  assert.match(block, /cancel-in-progress:\s*\$\{\{\s*github\.event_name\s*==\s*'push'\s*\}\}/);
  assert.match(block, /group:\s*fleet-selftest-public-\$\{\{\s*github\.event_name\s*\}\}/);
});

test("ci-diag cancels in progress so a push burst keeps only the newest run", () => {
  const block = concurrencyBlock(readWorkflow("ci-diag.yml"));
  assert.match(block, /cancel-in-progress:\s*true/);
  assert.match(block, /group:\s*ci-diag-\$\{\{\s*github\.ref\s*\}\}/);
});

test("the push-triggered workflows keep their original dispatch trigger", () => {
  for (const name of PUSH_VERIFICATION_WORKFLOWS) {
    assert.ok(
      blockKeys(onBlock(readWorkflow(name))).includes("workflow_dispatch"),
      `${name} lost workflow_dispatch, which is how a human runs the diagnostic`,
    );
  }
});