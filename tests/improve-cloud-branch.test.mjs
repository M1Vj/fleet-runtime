import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildCloudAgentRequestSnapshot,
  buildCloudAgentPullRequestBindingMarker,
  CLOUD_AGENT_DRAFT_MARKER,
  canonicalCloudAgentComments,
  cloudAgentModelOptions,
  createIsolatedModelWorkspace,
  computeCloudAgentBranchName,
  computeCloudAgentRequestRevision,
  fetchCloudAgentIssueComments,
  validatePlanArtifactContract,
  validateCloudAgentExistingBranch,
  validateCloudAgentExistingPullRequest,
  validateCloudAgentReviewPrmeta,
  validateCloudAgentCheckout,
  validateCloudAgentPlanFiles,
  materializeCloudAgentSourceSnapshot,
  isSafeCloudAgentBranchRef,
} from "../scripts/improve.mjs";
import { sha256 } from "../scripts/lib/util.mjs";
import { runOnce } from "../scripts/lib/model.mjs";

const REVISION = "d".repeat(64);
const SOURCE = "a".repeat(40);
const AUTH = "auth_0123456789abcdef";

test("nested infrastructure paths remain protected in cloud plans", () => {
  for (const filePath of ["packages/service/terraform/main.tf", "packages/service/Dockerfile", "packages/service/deploy/config.yaml"]) {
    assert.equal(validateCloudAgentPlanFiles([{ path: filePath, content: "safe text" }]).reason, "protected-plan-path", filePath);
  }
  assert.equal(validateCloudAgentPlanFiles([{ path: "packages/service/src/index.mjs", content: "export const ready = true;" }]).ok, true);
});

function branchOptions(overrides = {}) {
  return {
    repository: "M1Vj/demo",
    targetIssue: 42,
    requestRevision: REVISION,
    requestId: "req_0123456789abcdef",
    sourceHeadSha: SOURCE,
    authorizationId: AUTH,
    ...overrides,
  };
}

test("cloud branch identity separates requests that the old title/path hash collided", () => {
  const oldHashForIssue42 = sha256(JSON.stringify(["Repair the bounded issue flow", ["src/fix.mjs"]])).slice(0, 8);
  const oldHashForIssue43 = sha256(JSON.stringify(["Repair the bounded issue flow", ["src/fix.mjs"]])).slice(0, 8);
  assert.equal(oldHashForIssue42, oldHashForIssue43, "pre-fix title/path identity reproduces the collision");
  const first = computeCloudAgentBranchName(branchOptions());
  const samePlanDifferentIssue = computeCloudAgentBranchName(branchOptions({ targetIssue: 43 }));
  const differentRevision = computeCloudAgentBranchName(branchOptions({ requestRevision: "e".repeat(64) }));
  const differentSource = computeCloudAgentBranchName(branchOptions({ sourceHeadSha: "b".repeat(40) }));
  const differentAuthorization = computeCloudAgentBranchName(branchOptions({ authorizationId: "auth_other" }));
  const differentRepository = computeCloudAgentBranchName(branchOptions({ repository: "M1Vj/other" }));

  for (const candidate of [samePlanDifferentIssue, differentRevision, differentSource, differentAuthorization, differentRepository]) {
    assert.notEqual(candidate, first);
    assert.match(candidate, /^fleet\/(?:feat|improve)-[a-f0-9]{32}$/);
    assert.ok(candidate.length <= 200);
  }
});

test("existing cloud branch evidence is adopted only when base, files, and identity are exact", () => {
  const planFiles = [{ path: "src/fix.mjs", content: "export const fixed = true;\n" }];
  const branch = computeCloudAgentBranchName(branchOptions());
  const compare = {
    status: "ahead",
    ahead_by: 1,
    behind_by: 0,
    base_commit: { sha: SOURCE },
    files: [{ filename: "src/fix.mjs", status: "modified" }],
  };
  const valid = validateCloudAgentExistingBranch({
    ...branchOptions(),
    branch,
    branchHeadSha: "c".repeat(40),
    compare,
    planFiles,
    fileContents: { "src/fix.mjs": planFiles[0].content },
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.complete, true);
  assert.deepEqual(valid.missingFiles, []);

  assert.equal(validateCloudAgentExistingBranch({
    ...branchOptions(),
    branch,
    branchHeadSha: "c".repeat(40),
    compare: { ...compare, behind_by: 1 },
    planFiles,
    fileContents: { "src/fix.mjs": planFiles[0].content },
  }).reason, "branch-stale");
  assert.equal(validateCloudAgentExistingBranch({
    ...branchOptions(),
    branch,
    branchHeadSha: "c".repeat(40),
    compare,
    planFiles,
    fileContents: { "src/fix.mjs": "foreign content\n" },
  }).reason, "branch-file-mismatch");
  assert.equal(validateCloudAgentExistingBranch({
    ...branchOptions(),
    branch,
    branchHeadSha: "c".repeat(40),
    compare: { ...compare, files: [{ filename: "README.md", status: "modified" }] },
    planFiles,
    fileContents: { "src/fix.mjs": planFiles[0].content },
  }).reason, "branch-foreign-files");
});

function existingPrEvidenceFixture() {
  const planFiles = [{ path: "src/fix.mjs", content: "export const fixed = true;\n" }];
  const branch = computeCloudAgentBranchName(branchOptions());
  const head = "c".repeat(40);
  const marker = buildCloudAgentPullRequestBindingMarker({
    repository: "M1Vj/demo",
    targetIssue: 42,
    requestRevision: REVISION,
    sourceHeadSha: SOURCE,
    branch,
  });
  const pullRequest = {
    number: 17,
    state: "open",
    draft: true,
    merged: false,
    auto_merge: null,
    html_url: "https://github.com/M1Vj/demo/pull/17",
    head: { ref: branch, sha: head, repo: { full_name: "M1Vj/demo" } },
    base: { ref: "main", sha: SOURCE, repo: { full_name: "M1Vj/demo" } },
    body: `Fixes #42\n${marker}`,
  };
  const branchEvidence = {
    authorizationId: AUTH,
    headSha: head,
    compare: {
      status: "ahead",
      ahead_by: 1,
      behind_by: 0,
      base_commit: { sha: SOURCE },
      files: [{ filename: planFiles[0].path, status: "modified" }],
    },
    fileContents: { [planFiles[0].path]: planFiles[0].content },
  };
  return { planFiles, branch, head, pullRequest, branchEvidence };
}

test("existing cloud draft PR recovery requires exact branch compare and plan content", () => {
  const fixture = existingPrEvidenceFixture();
  const base = {
    pullRequest: fixture.pullRequest,
    ...branchOptions(),
    branch: fixture.branch,
    base: "main",
    branchHeadSha: fixture.head,
    authorizationId: AUTH,
    branchEvidence: fixture.branchEvidence,
    planFiles: fixture.planFiles,
  };
  assert.equal(validateCloudAgentExistingPullRequest(base).ok, true);

  const tamperedFile = {
    ...fixture.branchEvidence,
    fileContents: { "src/fix.mjs": "foreign\n" },
  };
  assert.equal(validateCloudAgentExistingPullRequest({ ...base, branchEvidence: tamperedFile }).reason, "pull-request-branch-file-mismatch");

  const extraFile = {
    ...fixture.branchEvidence,
    compare: {
      ...fixture.branchEvidence.compare,
      files: [
        ...fixture.branchEvidence.compare.files,
        { filename: "README.md", status: "modified" },
      ],
      ahead_by: 2,
    },
    fileContents: {
      ...fixture.branchEvidence.fileContents,
      "README.md": "foreign\n",
    },
  };
  assert.equal(validateCloudAgentExistingPullRequest({ ...base, branchEvidence: extraFile }).reason, "pull-request-branch-foreign-files");

  const divergent = {
    ...fixture.branchEvidence,
    compare: { ...fixture.branchEvidence.compare, behind_by: 1 },
  };
  assert.equal(validateCloudAgentExistingPullRequest({ ...base, branchEvidence: divergent }).reason, "pull-request-branch-stale");
});

test("live cloud review PR validation binds the endpoint number, canonical URL, and draft marker", () => {
  const fixture = reviewPrmetaFixture();
  const base = {
    pullRequest: {
      number: 17,
      state: "open",
      draft: true,
      merged: false,
      auto_merge: null,
      html_url: "https://github.com/M1Vj/demo/pull/17",
      head: { ref: fixture.meta.branch, sha: fixture.meta.headSha, repo: { full_name: "M1Vj/demo" } },
      base: { ref: fixture.meta.baseBranch, sha: fixture.meta.sourceHeadSha, repo: { full_name: "M1Vj/demo" } },
      body: [`Fixes #42`, fixture.meta.bindingMarker, CLOUD_AGENT_DRAFT_MARKER].join("\n"),
    },
    repository: "M1Vj/demo",
    targetIssue: 42,
    requestRevision: REVISION,
    sourceHeadSha: SOURCE,
    authorizationId: AUTH,
    branch: fixture.meta.branch,
    base: fixture.meta.baseBranch,
    branchHeadSha: fixture.meta.headSha,
    expectedPrNumber: fixture.meta.prNumber,
    requireDraftMarker: true,
  };
  assert.equal(validateCloudAgentExistingPullRequest(base).ok, true);
  assert.equal(validateCloudAgentExistingPullRequest({ ...base, expectedPrNumber: 18 }).reason, "pull-request-number-mismatch");
  assert.equal(validateCloudAgentExistingPullRequest({ ...base, pullRequest: { ...base.pullRequest, html_url: "https://github.com/M1Vj/demo/pull/18" } }).reason, "pull-request-url-mismatch");
  assert.equal(validateCloudAgentExistingPullRequest({ ...base, pullRequest: { ...base.pullRequest, body: `Fixes #42\n${fixture.meta.bindingMarker}` } }).reason, "pull-request-draft-marker-missing");
});

test("fresh branch final evidence rejects a collaborator file injected after PUT", () => {
  const fixture = existingPrEvidenceFixture();
  const exact = validateCloudAgentExistingBranch({
    ...branchOptions(),
    branch: fixture.branch,
    branchHeadSha: fixture.head,
    compare: fixture.branchEvidence.compare,
    planFiles: fixture.planFiles,
    fileContents: fixture.branchEvidence.fileContents,
  });
  assert.equal(exact.ok, true);

  const raced = validateCloudAgentExistingBranch({
    ...branchOptions(),
    branch: fixture.branch,
    branchHeadSha: fixture.head,
    compare: {
      ...fixture.branchEvidence.compare,
      ahead_by: 2,
      files: [...fixture.branchEvidence.compare.files, { filename: "src/foreign.mjs", status: "added" }],
    },
    planFiles: fixture.planFiles,
    fileContents: {
      ...fixture.branchEvidence.fileContents,
      "src/foreign.mjs": "export const foreign = true;\n",
    },
  });
  assert.equal(raced.ok, false);
  assert.equal(raced.reason, "branch-foreign-files");
});

function reviewPrmetaFixture() {
  const proofId = `proof_${"e".repeat(64)}`;
  const enrollmentDigest = "f".repeat(64);
  const binding = {
    ok: true,
    mode: "cloud-agent",
    targetIssue: 42,
    requestId: "req_0123456789abcdef",
    requestRevision: REVISION,
    authorizationId: AUTH,
    sourceHeadSha: SOURCE,
    policyVersion: "fleet-cloud-agent.v1",
    draftOnly: true,
    proofVerified: true,
    proofId,
    proofRepository: "M1Vj/demo",
    proofIssue: 42,
    enrollmentDigest,
  };
  const branch = computeCloudAgentBranchName({ ...branchOptions(), feature: false });
  const headSha = "c".repeat(40);
  const bindingMarker = buildCloudAgentPullRequestBindingMarker({
    repository: "M1Vj/demo",
    targetIssue: 42,
    requestRevision: REVISION,
    sourceHeadSha: SOURCE,
    branch,
  });
  const meta = {
    schema: "fleet-improve-receipt-v1",
    version: 1,
    stage: "implement",
    status: "ready",
    complete: true,
    repo: "M1Vj/demo",
    selectedRepo: "M1Vj/demo",
    targetIssue: 42,
    requestId: "req_0123456789abcdef",
    requestRevision: REVISION,
    authorizationId: AUTH,
    proofId,
    enrollmentDigest,
    sourceRevision: SOURCE,
    sourceHeadSha: SOURCE,
    prNumber: 17,
    prUrl: "https://github.com/M1Vj/demo/pull/17",
    branch,
    baseBranch: "main",
    headSha,
    draftOnly: true,
    draftMarker: CLOUD_AGENT_DRAFT_MARKER,
    category: "fix",
    bindingMarker,
    binding: {
      kind: "source-revision-v1",
      schema: "fleet-improve-receipt-v1",
      version: 1,
      repo: "M1Vj/demo",
      sourceRevision: SOURCE,
      headSha,
      prNumber: 17,
      targetIssue: 42,
      requestId: "req_0123456789abcdef",
      requestRevision: REVISION,
      authorizationId: AUTH,
      sourceHeadSha: SOURCE,
      proofId,
      enrollmentDigest,
      baseBranch: "main",
      draftOnly: true,
      draftMarker: CLOUD_AGENT_DRAFT_MARKER,
    },
  };
  return { binding, meta };
}

test("cloud review prmeta is exact-bound before GitHub diff or model reads", () => {
  const fixture = reviewPrmetaFixture();
  assert.equal(validateCloudAgentReviewPrmeta(fixture.meta, { binding: fixture.binding, repository: "M1Vj/demo" }).ok, true);
  const cases = [
    ["malformed contract", { stage: "plan" }, "prmeta-contract-mismatch"],
    ["foreign PR owner", { prUrl: "https://github.com/Other/demo/pull/17" }, "prmeta-pull-request-mismatch"],
    ["wrong request id", { requestId: "req_other" }, "prmeta-request-id-mismatch"],
    ["wrong proof", { proofId: `proof_${"a".repeat(64)}` }, "prmeta-proof-mismatch"],
    ["wrong deterministic branch", { branch: "fleet/improve-foreign" }, "prmeta-branch-mismatch"],
    ["missing draft binding marker", { bindingMarker: "" }, "prmeta-binding-marker-mismatch"],
    ["missing draft marker", { draftMarker: "" }, "prmeta-draft-marker-mismatch"],
    ["nested binding drift", { binding: { ...fixture.meta.binding, authorizationId: "auth_other" } }, "prmeta-nested-binding-mismatch"],
  ];
  for (const [label, overrides, reason] of cases) {
    assert.equal(validateCloudAgentReviewPrmeta({ ...fixture.meta, ...overrides }, { binding: fixture.binding, repository: "M1Vj/demo" }).reason, reason, label);
  }
});

test("an existing ref at the exact source head is a resumable empty branch", () => {
  const planFiles = [{ path: "src/fix.mjs", content: "new\n" }];
  const branch = computeCloudAgentBranchName(branchOptions());
  const result = validateCloudAgentExistingBranch({
    ...branchOptions(),
    branch,
    branchHeadSha: SOURCE,
    compare: { status: "identical", ahead_by: 0, behind_by: 0, base_commit: { sha: SOURCE }, files: [] },
    planFiles,
    fileContents: { "src/fix.mjs": null },
  });
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missingFiles, ["src/fix.mjs"]);
});

test("cloud plan policy blocks protected paths, permission changes, and secret-shaped content", () => {
  assert.equal(validateCloudAgentPlanFiles([{ path: ".github/workflows/ci.yml", content: "name: ci\n" }]).reason, "protected-plan-path");
  assert.equal(validateCloudAgentPlanFiles([{ path: "deploy/app.yaml", content: "kind: Deployment\n" }]).reason, "protected-plan-path");
  assert.equal(validateCloudAgentPlanFiles([{ path: "deployment.yaml", content: "kind: Deployment\n" }]).reason, "protected-plan-path");
  assert.equal(validateCloudAgentPlanFiles([{ path: "config/runtime.yml", content: "permissions:\n  contents: write\n" }]).reason, "workflow-permission-change");
  assert.equal(validateCloudAgentPlanFiles([{ path: "src/config.mjs", content: "const token = 'ghp_0123456789abcdef';\n" }]).reason, "secret-like-plan-content");
  assert.equal(validateCloudAgentPlanFiles([{ path: "src/fix.mjs", content: "export const fixed = true;\n" }]).ok, true);
});

test("cloud plan contract rejects protected and secret artifacts before mutation", () => {
  const binding = {
    ok: true,
    mode: "cloud-agent",
    targetIssue: 42,
    requestId: "req_0123456789abcdef",
    requestRevision: REVISION,
    authorizationId: AUTH,
    sourceHeadSha: SOURCE,
    policyVersion: "fleet-cloud-agent.v1",
    draftOnly: true,
  };
  const base = {
    schema: "fleet-improve-plan-v1",
    version: 1,
    stage: "plan",
    status: "ready",
    complete: true,
    repo: "M1Vj/demo",
    selectedRepo: "M1Vj/demo",
    binding: {},
  };
  assert.equal(validatePlanArtifactContract({
    ...base,
    plan: { title: "bad", files: [{ path: ".github/workflows/ci.yml", content: "name: ci\n" }] },
  }, { binding, repository: "M1Vj/demo" }).reason, "protected-plan-path");
  assert.equal(validatePlanArtifactContract({
    ...base,
    plan: { title: "bad", files: [{ path: "src/token.mjs", content: "const token = 'ghp_0123456789abcdef';\n" }] },
  }, { binding, repository: "M1Vj/demo" }).reason, "secret-like-plan-content");
});

test("cloud advisory model options explicitly deny mutation and isolate workspace", () => {
  assert.deepEqual(cloudAgentModelOptions({ cloudAgent: true, workspace: "/tmp/fleet-advisory" }), {
    readOnly: true,
    workspace: "/tmp/fleet-advisory",
  });
  assert.deepEqual(cloudAgentModelOptions({ cloudAgent: false, workspace: "/tmp/legacy" }), {
    workspace: "/tmp/legacy",
  });
});

test("default branch validation permits safe slash refs and rejects malformed refs", () => {
  assert.equal(isSafeCloudAgentBranchRef("release/2026"), true);
  assert.equal(isSafeCloudAgentBranchRef("feature/team/main"), true);
  for (const value of ["", "/main", "main/", "main//next", "main/../next", "main/.", "main/..", "main/./next", "main\u0000next", "main @", "main@{bad}", ".main", "main.lock"]) {
    assert.equal(isSafeCloudAgentBranchRef(value), false, value);
  }
});

test("cloud advisory receives a verified read-only snapshot, separate from checkout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-cloud-source-checkout-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", root], { encoding: "utf8" }).status, 0);
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "ready.mjs"), "export const ready = true;\n");
    writeFileSync(path.join(root, "README.md"), "validated source\n");
    assert.equal(spawnSync("git", ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "add", "."], { encoding: "utf8" }).status, 0);
    assert.equal(spawnSync("git", ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { encoding: "utf8" }).status, 0);
    const sourceHeadSha = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const workspace = createIsolatedModelWorkspace("cloud-source-test");
    const snapshot = materializeCloudAgentSourceSnapshot({ checkout: root, expectedSourceHeadSha: sourceHeadSha, workspace });
    assert.equal(snapshot.ok, true);
    assert.notEqual(path.resolve(snapshot.workspace), path.resolve(root));
    assert.equal(readFileSync(path.join(snapshot.workspace, "README.md"), "utf8"), "validated source\n");
    assert.equal((statSync(snapshot.workspace).mode & 0o222), 0);
    assert.equal((statSync(path.join(snapshot.workspace, "README.md")).mode & 0o222), 0);
    assert.equal(readFileSync(path.join(root, "README.md"), "utf8"), "validated source\n");
    chmodSync(path.join(snapshot.workspace, "README.md"), 0o644);
    chmodSync(path.join(snapshot.workspace, "src", "ready.mjs"), 0o644);
    chmodSync(path.join(snapshot.workspace, "src"), 0o755);
    chmodSync(snapshot.workspace, 0o755);
    rmSync(snapshot.workspace, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted advisory model succeeds in a dedicated RUNNER_TEMP workspace", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-cloud-advisory-hosted-"));
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const seen = path.join(root, "seen.json");
  const opencode = path.join(binDir, "opencode");
  writeFileSync(opencode, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ cwd: process.cwd(), workspace: process.env.FLEET_WORKSPACE_ROOT, config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}") }));
process.stdout.write(JSON.stringify({ text: "{\\"ideas\\":[]}", sessionID: "cloud-advisory-test" }));
`);
  chmodSync(opencode, 0o700);
  const workspace = createIsolatedModelWorkspace("improve-research-test", root);
  const env = {
    PATH: `${binDir}:${process.env.PATH || ""}`,
    RUNNER_TEMP: root,
    TMPDIR: root,
    FLEET_STATE_ROOT: path.join(root, "controller-state"),
    GITHUB_WORKSPACE: path.join(root, "controller-checkout"),
    FLEET_GH_TOKEN: "must-not-forward",
    FLEET_INDEFINITE_DISABLE: "1",
  };
  try {
    const result = await runOnce({
      prompt: "bounded cloud research",
      timeoutMs: 15000,
      env,
      workspace,
      model: "opencode/muse-spark-1.3-contributor-free",
      readOnly: true,
    });
    assert.equal(result.reply, "{\"ideas\":[]}");
    const captured = JSON.parse(readFileSync(seen, "utf8"));
    assert.equal(captured.cwd, realpathSync.native(workspace));
    assert.equal(path.resolve(captured.workspace), path.resolve(workspace));
    assert.equal(captured.config.permission.write, "deny");
    assert.equal(captured.config.permission.bash, "deny");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloud research checkout gate rejects clone gaps and source-head mismatches before model handoff", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-cloud-research-checkout-"));
  try {
    assert.deepEqual(validateCloudAgentCheckout(undefined, SOURCE), { ok: false, reason: "checkout-missing" });
    const init = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    writeFileSync(path.join(root, "README.md"), "checkout\n");
    const commit = spawnSync("git", ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "add", "README.md"], { encoding: "utf8" });
    assert.equal(commit.status, 0, commit.stderr);
    const committed = spawnSync("git", ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { encoding: "utf8" });
    assert.equal(committed.status, 0, committed.stderr);
    const observed = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    assert.match(observed, /^[a-f0-9]{40}$/);
    assert.deepEqual(validateCloudAgentCheckout(root, "b".repeat(40)), { ok: false, reason: "checkout-source-head-mismatch" });
    assert.deepEqual(validateCloudAgentCheckout(root, observed), { ok: true, workdir: root, sourceHeadSha: observed });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical comments exclude only verified owner publication markers and preserve parity", () => {
  const marker = "<!-- fleet-publication:v1:review-summary:" + "a".repeat(24) + " -->";
  const intent = "<!-- fleet-publication-intent:v1:review-summary:" + "b".repeat(24) + " -->";
  const trusted = {
    id: 1,
    body: `${marker}\n${intent}\n### Fleet review summary`,
    user: { login: "M1Vj" },
    provenance: { source: "github", type: "issue_comment", author: "M1Vj", verified: true },
    updated_at: "2026-09-20T00:00:00Z",
  };
  const attacker = { id: 2, body: `${marker}\nattacker text`, user: { login: "attacker" }, updated_at: "2026-09-20T00:01:00Z" };
  const unverifiedOwner = { id: 3, body: `${marker}\nowner text`, user: { login: "M1Vj" }, provenance: { source: "github", type: "issue_comment", author: "M1Vj" }, updated_at: "2026-09-20T00:02:00Z" };
  const canonical = canonicalCloudAgentComments([trusted, attacker, unverifiedOwner]);
  assert.deepEqual(canonical.map((comment) => comment.id), ["2", "3"]);
  assert.match(canonical[0].bodyDigest, /^[a-f0-9]{64}$/);
});

function pagedReader(pages) {
  return (args) => {
    const endpoint = args.find((value) => typeof value === "string" && value.includes("/comments?")) || "";
    const page = Number(endpoint.match(/[?&]page=(\d+)/)?.[1] || 0);
    return pages[page] ?? { items: [], hasNext: false };
  };
}

test("comment pagination probes exact-cap and full-page boundaries before accepting", () => {
  const comment = (id) => ({ id, body: `comment-${id}`, updated_at: "2026-09-20T00:00:00Z" });
  const exact = fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    commentsPerPage: 2,
    maxComments: 3,
    ghClient: pagedReader({
      1: { items: [comment(1), comment(2)], hasNext: true },
      2: { items: [comment(3)], hasNext: true },
      3: { items: [], hasNext: false },
    }),
  });
  assert.equal(exact.length, 3);

  assert.throws(() => fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    commentsPerPage: 2,
    maxComments: 3,
    ghClient: pagedReader({
      1: { items: [comment(1), comment(2)], hasNext: true },
      2: { items: [comment(3), comment(4)], hasNext: false },
    }),
  }), /pagination limit-exceeded/);

  const fullWithoutMetadata = fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    commentsPerPage: 2,
    maxComments: 3,
    ghClient: pagedReader({
      1: { items: [comment(1), comment(2)] },
      2: { items: [], hasNext: false },
    }),
  });
  assert.equal(fullWithoutMetadata.length, 2);
});

test("request revision remains deterministic after publication filtering", () => {
  const snapshot = buildCloudAgentRequestSnapshot({
    repository: "M1Vj/demo",
    issue: { number: 42, body: "hello", labels: [], updated_at: "2026-09-20T00:00:00Z" },
    comments: [{ id: 2, body: "source", updated_at: "2026-09-20T00:01:00Z" }],
    baseRef: "main",
    baseSha: SOURCE,
    sourceHeadSha: SOURCE,
  });
  assert.match(computeCloudAgentRequestRevision(snapshot), /^[a-f0-9]{64}$/);
  assert.equal(snapshot.commentsDigest, "0bf3803998818eadbbc08c27786e3bf5b8feeaafa74d15b7a7716b8255b4a653");
});

function controlBodyText(value, maxBodyBytes = 256 * 1024) {
  if (typeof value !== "string" || value.includes("\u0000")) return "";
  return value.slice(0, maxBodyBytes);
}

test("request snapshot body digest matches control normalization for NUL, limits, Unicode, and empty input", () => {
  const cases = [
    { label: "NUL", body: "before\u0000after" },
    { label: "oversize", body: "x".repeat(256 * 1024 + 7) },
    { label: "Unicode and line endings", body: "á🙂\r\nline" },
    { label: "empty", body: "" },
    { label: "non-string", body: null },
  ];
  for (const { label, body } of cases) {
    const snapshot = buildCloudAgentRequestSnapshot({
      repository: "M1Vj/demo",
      issue: { number: 42, body, labels: [], updated_at: "2026-09-20T00:00:00Z" },
      comments: [],
      baseRef: "main",
      baseSha: SOURCE,
      sourceHeadSha: SOURCE,
    });
    assert.equal(snapshot.issueBodyDigest, sha256(controlBodyText(body)), label);
  }
});
