import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  publicImproveReceipt,
  readPublicImproveManifests,
  isBoundedReviewManifest,
  publicReviewSerialization,
  publicTerminalState,
  publicResearchCloneDisposition,
  researchPromptHeader,
  writeGitHubOutput,
} from "../scripts/improve.mjs";
import { makeExecutionTerminal, writeExecutionAudit, writePublicArtifact } from "../scripts/lib/private-state.mjs";
import { buildOpenCodeConfigContent, PUBLIC_READ_ONLY_PERMISSIONS, runOnce } from "../scripts/lib/model.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "improve.yml");

function publicEnv(root) {
  const state = path.join(root, "state");
  return {
    FLEET_DATA_CLASS: "public",
    FLEET_PUBLIC_OWNER: "M1Vj",
    FLEET_PUBLIC_REPOSITORY: "M1Vj/public-repo",
    RUNNER_TEMP: root,
    FLEET_PUBLIC_STATE_ROOT: state,
    FLEET_PUBLIC_ARTIFACT_MANIFEST: path.join(state, "public-artifact.json"),
  };
}

test("public improve matrix output is materialized for downstream jobs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-improve-output-"));
  const output = path.join(root, "github-output");
  try {
    assert.equal(writeGitHubOutput("matrix", { repo: ["M1Vj/public-repo"] }, { GITHUB_OUTPUT: output }), true);
    assert.equal(readFileSync(output, "utf8"), 'matrix={"repo":["M1Vj/public-repo"]}\n');
    writeGitHubOutput("repository", "M1Vj/public-repo", { GITHUB_OUTPUT: output });
    assert.equal(readFileSync(output, "utf8"), 'matrix={"repo":["M1Vj/public-repo"]}\nrepository=M1Vj/public-repo\n');
    assert.equal(writeGitHubOutput("matrix", { repo: [] }), false, "local runs stay stdout-only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public artifact preserves bounded receipt booleans", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-improve-artifact-"));
  try {
    const env = publicEnv(root);
    writePublicArtifact(env, {
      mode: "finalize",
      status: "awaiting-control",
      repository: env.FLEET_PUBLIC_REPOSITORY,
      selected: true,
      analyzed: true,
      blocked: true,
      awaitingControl: true,
      awaitingPrivateControl: true,
      desiredTaskCompleted: false,
      evidence: { awaitingControl: true, durableControl: "required" },
      checks: { externalWrites: "blocked", analyzed: true, awaitingControl: true },
    }, { kind: "improve", status: "awaiting-control", repository: env.FLEET_PUBLIC_REPOSITORY });
    const value = JSON.parse(readFileSync(env.FLEET_PUBLIC_ARTIFACT_MANIFEST, "utf8"));
    assert.equal(value.status, "awaiting-control");
    assert.equal(value.selected, true);
    assert.equal(value.analyzed, true);
    assert.equal(value.blocked, true);
    assert.equal(value.awaitingPrivateControl, true);
    assert.equal(value.checks.externalWrites, "blocked");
    makeExecutionTerminal(env, root, { lane: "finalize" })("STALLED", { status: value.status });
    const preserved = JSON.parse(readFileSync(env.FLEET_PUBLIC_ARTIFACT_MANIFEST, "utf8"));
    assert.equal(preserved.status, "awaiting-control", "terminal telemetry must not erase receipt status");
    assert.equal(preserved.kind, "terminal");
    assert.equal(preserved.results.terminalState, "STALLED");
    writeExecutionAudit({ entries: [], incidents: [] }, env, root, "receipt-test", "Improve finalize", "awaiting-control");
    const audited = JSON.parse(readFileSync(env.FLEET_PUBLIC_ARTIFACT_MANIFEST, "utf8"));
    assert.equal(audited.status, "awaiting-control", "audit telemetry must not erase receipt status");
    assert.equal(audited.kind, "audit");
    assert.equal(audited.mode, "finalize");
    assert.equal(audited.results.terminalState, "STALLED");
    assert.equal(audited.desiredTaskCompleted, false);
    assert.equal(audited.evidence.awaitingControl, true);
    assert.equal(audited.awaitingControl, true);
    assert.equal(audited.checks.externalWrites, "blocked");
    assert.equal(audited.checks.awaitingControl, true);
    makeExecutionTerminal(env, root, { lane: "finalize" })("BLOCKED", { status: "blocked" });
    const blocked = JSON.parse(readFileSync(env.FLEET_PUBLIC_ARTIFACT_MANIFEST, "utf8"));
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.results.terminalState, "BLOCKED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public receipt distinguishes selected, analyzed, blocked, and private handoff", () => {
  const receipt = publicImproveReceipt(
    "M1Vj/public-repo",
    [
      { repository: "M1Vj/public-repo", mode: "pick", status: "ok", selected: true },
      { repository: "M1Vj/public-repo", mode: "research", status: "ok", ideas: [{ title: "Improve tests", rationale: "The suite misses a case", evidence: "Observed a missing regression", impact: "high" }] },
      { repository: "M1Vj/public-repo", mode: "plan", status: "analyzed", plan: { title: "Improve tests", impact: "high" } },
      { repository: "M1Vj/public-repo", mode: "implement", status: "blocked" },
    ],
    { pick: "success", research: "success", plan: "success", implement: "success", review: "success" },
  );
  assert.equal(receipt.status, "awaiting-control");
  assert.equal(receipt.selected, true);
  assert.equal(receipt.analyzed, true);
  assert.equal(receipt.blocked, true);
  assert.equal(receipt.awaitingPrivateControl, true);
  assert.equal(receipt.awaitingControl, true);
  assert.equal(receipt.desiredTaskCompleted, false);
  assert.equal(receipt.evidence.durableControl, "required");
  assert.equal(receipt.checks.externalWrites, "blocked");
  assert.equal(receipt.checks.awaitingControl, true);
  assert.equal(receipt.stageResults.implement, "success");
  assert.equal(JSON.stringify(receipt).includes("privateState"), false, "receipt contains no private-state payload");
});

test("empty public run is blocked rather than falsely completed", () => {
  const receipt = publicImproveReceipt("M1Vj/public-repo", [], { pick: "failure", research: "skipped", plan: "skipped", implement: "skipped", review: "skipped" });
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.selected, false);
  assert.equal(receipt.analyzed, false);
  assert.equal(receipt.blocked, true);
  assert.equal(receipt.awaitingPrivateControl, false);
  assert.equal(receipt.desiredTaskCompleted, false);
});

test("receipt does not infer analysis from deferred or malformed stage artifacts", () => {
  const missingSelection = publicImproveReceipt("M1Vj/public-repo", [], { pick: "success", research: "success" });
  assert.equal(missingSelection.selected, false);
  assert.equal(missingSelection.analyzed, false);
  assert.equal(missingSelection.awaitingPrivateControl, false);

  const deferred = publicImproveReceipt("M1Vj/public-repo", [
    { repository: "M1Vj/public-repo", mode: "pick", status: "ok", selected: [{ repo: "M1Vj/public-repo" }] },
    { repository: "M1Vj/public-repo", mode: "research", status: "deferred", reason: "INVALID_RESEARCH_OUTPUT", ideas: [] },
  ], { pick: "success", research: "success", plan: "success", implement: "success", review: "success" });
  assert.equal(deferred.selected, true);
  assert.equal(deferred.analyzed, false);
  assert.equal(deferred.awaitingPrivateControl, false);
  assert.equal(deferred.status, "deferred");
  assert.equal(deferred.reason, "public-analysis-deferred");
  assert.equal(deferred.desiredTaskCompleted, false);

  const malformedReview = publicImproveReceipt("M1Vj/public-repo", [
    { repository: "M1Vj/public-repo", mode: "pick", status: "ok", selected: [{ repo: "M1Vj/public-repo" }] },
    { repository: "M1Vj/public-repo", mode: "review", status: "analyzed", findings: [{ title: "missing severity", detail: "" }] },
  ], { pick: "success", research: "skipped", plan: "skipped", implement: "success", review: "success" });
  assert.equal(malformedReview.analyzed, false);
  assert.equal(malformedReview.desiredTaskCompleted, false);
});

test("public terminal mapping stalls when private control is still required", () => {
  assert.equal(publicTerminalState(0, { status: "awaiting-control", desiredTaskCompleted: false }), "STALLED");
  assert.equal(publicTerminalState(0, { status: "analyzed", desiredTaskCompleted: false }), "STALLED");
  assert.equal(publicTerminalState(0, { status: "ok" }), "SUCCESS");
  assert.equal(publicTerminalState(1, { status: "awaiting-control", desiredTaskCompleted: false }), "BLOCKED");
});

test("public receipt rejects unbound or foreign nested pick selections", () => {
  const foreignNested = publicImproveReceipt("M1Vj/public-repo", [
    { repository: "M1Vj/public-repo", mode: "pick", status: "ok", selected: [{ repo: "M1Vj/other-repo" }] },
  ], { pick: "success" });
  assert.equal(foreignNested.selected, false);
  assert.equal(foreignNested.awaitingControl, false);
  const unbound = publicImproveReceipt("M1Vj/public-repo", [
    { mode: "pick", status: "ok", selected: [{ repo: "M1Vj/public-repo" }] },
  ], { pick: "success" });
  assert.equal(unbound.selected, false);
});

test("public research clone failure is deferred without digest-only analysis", () => {
  assert.deepEqual(publicResearchCloneDisposition(), {
    status: "deferred",
    selected: true,
    analyzed: false,
    blocked: false,
    awaitingPrivateControl: false,
    reason: "PUBLIC_TARGET_UNAVAILABLE",
    ideas: [],
  });
  assert.deepEqual(publicResearchCloneDisposition("/tmp/public-target"), { status: "ready", reason: "public-read-only" });
});

test("public OpenCode config ignores hostile target config and pins read-only permissions", () => {
  const config = JSON.parse(buildOpenCodeConfigContent(
    "opencode/nemotron-3.5-lightning-free",
    JSON.stringify({ permission: { edit: "allow", write: "allow", bash: "allow", external_directory: "allow" }, mcp: { evil: { command: "sh" } } }),
    "/tmp/untrusted-target",
    { publicMode: true },
  ));
  assert.deepEqual(config.permission, PUBLIC_READ_ONLY_PERMISSIONS);
  assert.equal(config.model, "opencode/nemotron-3.5-lightning-free");
  assert.equal(config.small_model, "opencode/nemotron-3.5-lightning-free");
  assert.equal(config.mcp, undefined);
});

test("public runOnce applies the read-only config to an untrusted workspace", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-improve-model-public-"));
  try {
    const binDir = path.join(root, "bin");
    const workspace = path.join(root, "workspace");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const seen = path.join(root, "config.json");
    writeFileSync(path.join(workspace, "opencode.json"), JSON.stringify({ permission: { edit: "allow", bash: "allow", external_directory: "allow" }, mcp: { evil: { command: "sh" } } }));
    const bin = path.join(binDir, "opencode");
    writeFileSync(bin, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(seen)}, process.env.OPENCODE_CONFIG_CONTENT); console.log(JSON.stringify({text:"ok",sessionID:"s-public-1"}));\n`);
    chmodSync(bin, 0o755);
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FLEET_DATA_CLASS: "public",
      FLEET_OPENCODE_AUTH: "auth",
    };
    const result = await runOnce({ prompt: "inspect", timeoutMs: 15000, env, workspace, model: "opencode/nemotron-3.5-lightning-free" });
    assert.equal(result.reply, "ok");
    const config = JSON.parse(readFileSync(seen, "utf8"));
    assert.deepEqual(config.permission, PUBLIC_READ_ONLY_PERMISSIONS);
    assert.equal(config.mcp, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public research and plan bounds reject oversized or malformed handoffs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-improve-bounds-"));
  try {
    const env = publicEnv(root);
    writePublicArtifact(env, {
      mode: "research",
      status: "ok",
      ideas: Array.from({ length: 6 }, (_, index) => ({ title: `idea-${index}`, impact: "high" })),
    }, { kind: "improve", status: "ok", repository: env.FLEET_PUBLIC_REPOSITORY });
    const [research] = readPublicImproveManifests(env.FLEET_PUBLIC_STATE_ROOT, env.FLEET_PUBLIC_REPOSITORY);
    assert.equal(research.ideas.length, 6);
    assert.equal(publicImproveReceipt(env.FLEET_PUBLIC_REPOSITORY, [research], { research: "success" }).analyzed, false);
    writePublicArtifact(env, {
      mode: "plan",
      status: "analyzed",
      plan: { title: "x".repeat(161), impact: "high" },
    }, { kind: "improve", status: "analyzed", repository: env.FLEET_PUBLIC_REPOSITORY });
    const [plan] = readPublicImproveManifests(env.FLEET_PUBLIC_STATE_ROOT, env.FLEET_PUBLIC_REPOSITORY);
    assert.equal(publicImproveReceipt(env.FLEET_PUBLIC_REPOSITORY, [plan], { plan: "success" }).analyzed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("research prompt records a real workspace when one is mounted", () => {
  const mounted = researchPromptHeader("M1Vj/public-repo", "/tmp/improve-workspace");
  assert.doesNotMatch(mounted, /digest-only mode/);
  assert.match(researchPromptHeader("M1Vj/public-repo"), /digest-only mode/);
});

test("review serialization keeps safe prose and defers dropped required fields", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-improve-review-roundtrip-"));
  try {
    const env = publicEnv(root);
    writePublicArtifact(env, {
      mode: "review",
      status: "analyzed",
      findings: [{ severity: "high", title: "Review source handling", detail: "The private log wording is ordinary public prose." }],
    }, { kind: "improve", status: "analyzed", repository: env.FLEET_PUBLIC_REPOSITORY });
    const [safe] = readPublicImproveManifests(env.FLEET_PUBLIC_STATE_ROOT, env.FLEET_PUBLIC_REPOSITORY);
    assert.equal(isBoundedReviewManifest(safe), true);
    assert.equal(publicReviewSerialization(safe).status, "analyzed");

    writePublicArtifact(env, {
      mode: "review",
      status: "analyzed",
      findings: [{ severity: "high", title: "source=/tmp/private.log", detail: "unsafe path marker" }],
    }, { kind: "improve", status: "analyzed", repository: env.FLEET_PUBLIC_REPOSITORY });
    const [unsafe] = readPublicImproveManifests(env.FLEET_PUBLIC_STATE_ROOT, env.FLEET_PUBLIC_REPOSITORY);
    assert.equal(isBoundedReviewManifest(unsafe), false);
    assert.deepEqual(publicReviewSerialization(unsafe), { status: "deferred", analyzed: false, blocked: false, reason: "PUBLIC_REVIEW_PAYLOAD_UNSAFE" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public receipt handles malformed manifest rows without crashing", () => {
  const receipt = publicImproveReceipt("M1Vj/public-repo", [null, "invalid", { repository: "M1Vj/public-repo", mode: "pick", status: "ok", selected: [{ repo: "M1Vj/public-repo" }] }, { repository: "M1Vj/public-repo", mode: "research", status: "deferred" }], { pick: "success", research: "success" });
  assert.equal(receipt.selected, true);
  assert.equal(receipt.analyzed, false);
  assert.equal(receipt.awaitingPrivateControl, false);
  assert.equal(receipt.status, "deferred");
});

test("public receipt ignores manifests for a different validated target", () => {
  const receipt = publicImproveReceipt("M1Vj/public-repo", [
    { repository: "M1Vj/other-repo", mode: "pick", status: "ok", selected: true },
    { repository: "M1Vj/other-repo", mode: "research", status: "ok", ideas: [{ title: "foreign", impact: "high" }] },
  ], { pick: "success", research: "success" });
  assert.equal(receipt.selected, false);
  assert.equal(receipt.analyzed, false);
  assert.equal(receipt.awaitingPrivateControl, false);
  assert.equal(receipt.status, "blocked");
});

test("sanitized research round-trip stays analyzable when free text is dropped", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-improve-roundtrip-"));
  try {
    const env = publicEnv(root);
    writePublicArtifact(env, {
      mode: "research",
      status: "ok",
      ideas: [{
        title: "Improve tests",
        rationale: "source path and private log details are intentionally omitted",
        evidence: "observed source=/tmp/private.log",
        impact: "high",
      }],
    }, { kind: "improve", status: "ok", repository: env.FLEET_PUBLIC_REPOSITORY });
    const [research] = readPublicImproveManifests(env.FLEET_PUBLIC_STATE_ROOT, env.FLEET_PUBLIC_REPOSITORY);
    assert.equal(research.ideas[0].title, "Improve tests");
    assert.equal(research.ideas[0].impact, "high");
    assert.equal(isBoundedResearchForTest(research), true);
    const receipt = publicImproveReceipt(env.FLEET_PUBLIC_REPOSITORY, [research, { repository: env.FLEET_PUBLIC_REPOSITORY, mode: "pick", status: "ok", selected: true }], { pick: "success", research: "success" });
    assert.equal(receipt.analyzed, true);
    assert.equal(receipt.status, "awaiting-control");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function isBoundedResearchForTest(value) {
  return value.mode === "research" && value.status === "ok" && Array.isArray(value.ideas)
    && value.ideas[0]?.title === "Improve tests" && value.ideas[0]?.impact === "high";
}

test("finalizer reads only bounded downloaded public manifests", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-improve-manifests-"));
  try {
    writeFileSync(path.join(root, "public-artifact.json"), JSON.stringify({ schema: "fleet-public-artifact-v1", dataClass: "public", repository: "M1Vj/public-repo", mode: "research", status: "ok" }));
    const nested = path.join(root, "public-review-0");
    makeDir(nested);
    writeFileSync(path.join(nested, "public-artifact.json"), JSON.stringify({ schema: "fleet-public-artifact-v1", dataClass: "public", repository: "M1Vj/public-repo", mode: "review", status: "analyzed" }));
    writeFileSync(path.join(root, "other.json"), JSON.stringify({ mode: "private", status: "ok" }));
    const manifests = readPublicImproveManifests(root, "M1Vj/public-repo");
    assert.equal(manifests.length, 2);
    assert.deepEqual(manifests.map((entry) => entry.mode).sort(), ["research", "review"]);
    const foreign = path.join(root, "foreign");
    makeDir(foreign);
    writeFileSync(path.join(foreign, "public-artifact.json"), JSON.stringify({ schema: "fleet-public-artifact-v1", dataClass: "public", repository: "M1Vj/other", mode: "research", status: "ok" }));
    const invalid = path.join(root, "invalid");
    makeDir(invalid);
    writeFileSync(path.join(invalid, "public-artifact.json"), JSON.stringify({ mode: "research", status: "ok", repository: "M1Vj/public-repo" }));
    assert.equal(readPublicImproveManifests(root, "M1Vj/public-repo").length, 2, "foreign target is ignored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeDir(directory) {
  // Keep this fixture helper synchronous without broad filesystem setup.
  mkdirSync(directory, { recursive: true });
}

test("hosted improve workflow wires job outputs, artifact handoff, and receipt upload", () => {
  const text = readFileSync(WORKFLOW, "utf8");
  const script = readFileSync(path.join(ROOT, "scripts", "improve.mjs"), "utf8");
  assert.match(text, /outputs:\s*\n\s+matrix:\s+\$\{\{\s*steps\.pick\.outputs\.matrix/);
  assert.match(text, /repository:\s+\$\{\{\s*steps\.pick\.outputs\.repository/);
  assert.match(script, /writeGitHubOutput\("matrix"/);
  assert.match(script, /writeGitHubOutput\("implmatrix"/);
  assert.match(script, /writeGitHubOutput\("reviewmatrix"/);
  assert.match(text, /name: download public research manifests/);
  assert.match(text, /pattern: public-research-\*/);
  assert.match(text, /needs:\s*\[pick, research, plan, implement, review\]/);
  assert.match(text, /plan:\s*\n\s+needs:\s*\[pick, research\]/);
  assert.match(text, /FLEET_PUBLIC_REPOSITORY_INPUT:\s+\$\{\{\s*needs\.pick\.outputs\.repository\s*\}\}/);
  assert.doesNotMatch(text, /matrix\.repo\s*\|\|\s*github\.repository/);
  assert.match(text, /name: download public improve manifests/);
  assert.match(text, /name: upload public improve receipt/);
  assert.match(text, /name: public-improve-receipt/);
  assert.match(text, /if-no-files-found: error/);
  assert.doesNotMatch(text, /finalize public result[\s\S]{0,1400}git\s+(?:commit|push)/i);
  assert.match(script, /desiredTaskCompleted:\s*false/);
  assert.match(script, /awaiting-control/);
  const fatalCatch = script.slice(script.lastIndexOf("  } catch (err) {"));
  assert.ok(fatalCatch.indexOf("makeExecutionTerminal") < fatalCatch.indexOf("writeExecutionAudit"), "fatal public path emits BLOCKED terminal before audit");
  assert.match(script, /const outputDir = artifactDir\(\);/);
  assert.match(script, /writeFileSync\(path\.join\(outputDir, "public-plan\.json"\)/);
});
