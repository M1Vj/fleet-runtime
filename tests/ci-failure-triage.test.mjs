import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const RUNBOOK = path.resolve("docs/runbooks/ci-failure-triage.md");

function readRunbook() {
  return fs.readFileSync(RUNBOOK, "utf8");
}

test("triage runbook exists and ends with exactly one trailing newline (hermetic)", () => {
  const raw = readRunbook();
  assert.ok(raw.length > 500, "runbook must preserve substantive triage documentation");
  assert.ok(raw.endsWith("\n"), "runbook must end with a trailing newline");
  assert.ok(!raw.endsWith("\n\n"), "runbook must end with exactly one trailing newline, not two");
});

test("triage runbook keeps a single Escalation section and all incident history (no deletions)", () => {
  const raw = readRunbook();
  const escalationCount = (raw.match(/^## Escalation\s*$/gm) || []).length;
  assert.equal(escalationCount, 1, "must keep exactly one Escalation section (no duplicates, no deletions)");
  assert.match(raw, /2026-08-23 13:30-15:00 UTC/, "must preserve the 2026-08-23 incident window");
  assert.match(raw, /32643967935/, "must preserve original merge-gate run evidence");
  assert.match(raw, /2026-09-12/, "must preserve the 2026-09-12 incident window");
  assert.match(raw, /34725129509/, "must preserve 2026-09-12 merge-gate run evidence");
  assert.match(raw, /34725422303/, "must preserve fleet-deep run evidence");
  assert.match(raw, /34725502502/, "must preserve fleet-kb run evidence");
  assert.match(raw, /34727000584/, "must preserve fleet-improve run evidence");
  assert.match(raw, /do-not-merge/, "must preserve the escalation do-not-merge directive");
});

test("triage runbook keeps fail-fast guards (hermetic)", () => {
  const raw = readRunbook().toLowerCase();
  assert.match(raw, /fail-fast/, "must keep fail-fast guards section");
  assert.match(raw, /fail closed/, "must keep fail-closed guard");
  assert.match(raw, /one canary per/, "must keep one-canary-before-mass-rerun guard");
  assert.match(raw, /never direct-push/, "must keep revert-via-PR guard");
});

test("triage verification is hermetic by default and live steps are gated with a clear skip reason (hermetic)", () => {
  const raw = readRunbook();
  assert.match(raw, /FLEET_LIVE_TRIAGE/, "live triage must be gated behind the FLEET_LIVE_TRIAGE repository variable");
  assert.match(raw, /live-triage-disabled/, "gated live steps must state the clear skip reason live-triage-disabled");
  assert.match(raw, /hermetic/i, "runbook must document the hermetic verification path");
  assert.match(raw, /node --test tests\/public-airlock\.test\.mjs/, "hermetic path must include the public airlock suite");
  assert.match(raw, /gated/i, "live probes must be described as gated, never unconditional");
});

test("triage runbook frames 2026-09-12 cause as hypothesis and keeps public-shell boundary (hermetic)", () => {
  const raw = readRunbook();
  assert.match(raw, /hypothesis/i, "correlated-failure cause must be framed as hypothesis until log evidence confirms it");
  assert.match(raw, /do not assert/i, "must warn against asserting expiry/quota as fact without evidence");
  assert.ok(!/gh secret set/i.test(raw), "public runbook must not instruct pushing secrets from the public shell");
  assert.ok(!/FLEET_OPENCODE_AUTH/i.test(raw), "public runbook must not name private-plane credential env values");
  assert.match(raw, /private controller/i, "credential rotation must be escalated to the private controller");
});

test("triage runbook contains no secret-shaped values (hermetic)", () => {
  const raw = readRunbook();
  const secretPatterns = [
    /(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{10,}/,
    /github_pat_[A-Za-z0-9_]{10,}/,
    /AKIA[0-9A-Z]{16}/,
    /BEGIN [A-Z ]*PRIVATE KEY/,
    /sk-[A-Za-z0-9]{20,}/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
  ];
  for (const re of secretPatterns) {
    assert.ok(!re.test(raw), "runbook must not contain secret-shaped value matching " + String(re));
  }
});