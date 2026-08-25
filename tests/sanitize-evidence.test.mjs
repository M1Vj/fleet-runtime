import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sanitizeEvidenceArtifact } from "../scripts/sanitize-evidence.mjs";
import { readEvidence } from "../scripts/merge.mjs";
import { readRevisionEvidence } from "../scripts/revise.mjs";

function workspaceFixture(name) {
  const root = mkdtempSync(path.join(tmpdir(), `${name}-`));
  const targetCheck = path.join(root, "target-check");
  return { root, targetCheck, input: path.join(root, "raw.txt"), output: path.join(targetCheck, "evidence.txt") };
}

test("sanitized evidence marks a trusted raw artifact available and strips its envelope", () => {
  const fixture = workspaceFixture("fleet-evidence-valid");
  try {
    writeFileSync(fixture.input, "npm test: exit=0\n", "utf8");
    sanitizeEvidenceArtifact(fixture.input, fixture.output);
    const raw = readFileSync(fixture.output, "utf8");
    assert.match(raw, /^FLEET_EVIDENCE_V1\navailable=true\n\n/);
    const evidence = readEvidence(fixture.output, { workspaceRoot: fixture.root });
    assert.equal(evidence.available, true);
    assert.equal(evidence.text, "npm test: exit=0");
    assert.match(evidence.digest, /^[a-f0-9]{16}$/);
    assert.equal(readRevisionEvidence(fixture.output, { workspaceRoot: fixture.root }), "npm test: exit=0\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("missing or generated-unavailable evidence never becomes available", () => {
  const fixture = workspaceFixture("fleet-evidence-missing");
  try {
    sanitizeEvidenceArtifact(path.join(fixture.root, "missing.txt"), fixture.output);
    assert.match(readFileSync(fixture.output, "utf8"), /^FLEET_EVIDENCE_V1\navailable=false\n\n/);
    assert.equal(readEvidence(fixture.output, { workspaceRoot: fixture.root }).available, false);
    assert.equal(readRevisionEvidence(fixture.output, { workspaceRoot: fixture.root }), "");

    writeFileSync(fixture.input, "target-check evidence unavailable\n", "utf8");
    sanitizeEvidenceArtifact(fixture.input, fixture.output);
    assert.match(readFileSync(fixture.output, "utf8"), /^FLEET_EVIDENCE_V1\navailable=false\n\n/);
    assert.equal(readEvidence(fixture.output, { workspaceRoot: fixture.root }).available, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
