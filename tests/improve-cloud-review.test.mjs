import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  buildCloudAgentPullRequestBindingMarker,
  CLOUD_AGENT_DRAFT_MARKER,
  computeCloudAgentBranchName,
  computeCloudAgentRequestRevision,
  buildCloudAgentRequestSnapshot,
} from "../scripts/improve.mjs";

const REPO = "M1Vj/demo";
const ISSUE = 42;
const SOURCE = "a".repeat(40);
const AUTH = "auth_0123456789abcdef";
const PROOF = `proof_${"e".repeat(64)}`;
const ENROLLMENT = "f".repeat(64);
const REVISION = computeCloudAgentRequestRevision(buildCloudAgentRequestSnapshot({
  repository: REPO,
  issue: { number: ISSUE, body: "review", labels: [], updated_at: "2026-09-20T00:00:00Z" },
  comments: [],
  baseRef: "main",
  baseSha: SOURCE,
  sourceHeadSha: SOURCE,
}));
const BINDING = {
  ok: true,
  mode: "cloud-agent",
  targetIssue: ISSUE,
  requestId: "req_0123456789abcdef",
  requestRevision: REVISION,
  authorizationId: AUTH,
  sourceHeadSha: SOURCE,
  proofVerified: true,
  proofId: PROOF,
  proofRepository: REPO,
  proofIssue: ISSUE,
  enrollmentDigest: ENROLLMENT,
};
const BRANCH = computeCloudAgentBranchName({ repository: REPO, targetIssue: ISSUE, requestRevision: REVISION, sourceHeadSha: SOURCE, authorizationId: AUTH });
const HEAD = "c".repeat(40);
const MARKER = buildCloudAgentPullRequestBindingMarker({ repository: REPO, targetIssue: ISSUE, requestRevision: REVISION, sourceHeadSha: SOURCE, branch: BRANCH });

function metaFixture(overrides = {}) {
  return {
    schema: "fleet-improve-receipt-v1",
    version: 1,
    stage: "implement",
    status: "ready",
    complete: true,
    repo: REPO,
    selectedRepo: REPO,
    targetIssue: ISSUE,
    requestId: BINDING.requestId,
    requestRevision: REVISION,
    authorizationId: AUTH,
    proofId: PROOF,
    enrollmentDigest: ENROLLMENT,
    sourceRevision: SOURCE,
    sourceHeadSha: SOURCE,
    prNumber: 17,
    prUrl: `https://github.com/${REPO}/pull/17`,
    branch: BRANCH,
    baseBranch: "main",
    headSha: HEAD,
    draftOnly: true,
    draftMarker: CLOUD_AGENT_DRAFT_MARKER,
    category: "fix",
    bindingMarker: MARKER,
    binding: {
      kind: "source-revision-v1",
      schema: "fleet-improve-receipt-v1",
      version: 1,
      repo: REPO,
      sourceRevision: SOURCE,
      headSha: HEAD,
      prNumber: 17,
      targetIssue: ISSUE,
      requestId: BINDING.requestId,
      requestRevision: REVISION,
      authorizationId: AUTH,
      sourceHeadSha: SOURCE,
      proofId: PROOF,
      enrollmentDigest: ENROLLMENT,
      baseBranch: "main",
      draftOnly: true,
      draftMarker: CLOUD_AGENT_DRAFT_MARKER,
    },
    ...overrides,
  };
}

function runReview(meta, { livePatch = {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-cloud-review-runtime-"));
  const artifacts = path.join(root, "artifacts");
  const bin = path.join(root, "bin");
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(artifacts, "prmeta-M1Vj__demo.json"), JSON.stringify(meta));
  const ghLog = path.join(root, "gh-log");
  const modelSeen = path.join(root, "model-seen");
  const gh = path.join(bin, "gh");
  const ghSource = `#!/usr/bin/env node\nconst fs=require("node:fs");const a=process.argv.slice(2);const j=a.join(" ");fs.appendFileSync(${JSON.stringify(ghLog)},JSON.stringify(a)+"\\n");const out=v=>process.stdout.write(JSON.stringify(v));const marker=${JSON.stringify(MARKER)};const draftMarker=${JSON.stringify(CLOUD_AGENT_DRAFT_MARKER)};const pr={number:17,state:"open",draft:true,merged:false,auto_merge:null,html_url:"https://github.com/${REPO}/pull/17",head:{ref:${JSON.stringify(BRANCH)},sha:${JSON.stringify(HEAD)},repo:{full_name:"${REPO}"}},base:{ref:"main",sha:${JSON.stringify(SOURCE)},repo:{full_name:"${REPO}"}},body:"Fixes #42\\n"+marker+"\\n"+draftMarker};Object.assign(pr,${JSON.stringify(livePatch)});if(j.includes("actions/variables/FLEET_KILL_SWITCH"))out({name:"FLEET_KILL_SWITCH",value:"clear"});else if(j.includes("/pulls/17/files"))out([{filename:"src/fix.mjs",patch:"+export const fixed=true;"}]);else if(j.includes("/pulls/17"))out(pr);else if(j.includes("/commits/"))out({sha:${JSON.stringify(HEAD)}});else if(j.includes("/compare/"))out({status:"ahead",ahead_by:1,behind_by:0,base_commit:{sha:${JSON.stringify(SOURCE)}},head_commit:{sha:${JSON.stringify(HEAD)}}});else if(j.includes("/repos/${REPO}"))out({default_branch:"main"});else process.exit(1);`;
  writeFileSync(gh, ghSource, { mode: 0o700 });
  chmodSync(gh, 0o700);
  const opencode = path.join(bin, "opencode");
  writeFileSync(opencode, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(modelSeen)},"called");console.log(JSON.stringify({text:JSON.stringify({verdict:"approve",findings:[]}),sessionID:"review-test"}));`, { mode: 0o700 });
  chmodSync(opencode, 0o700);
  const preload = path.join(root, "fetch.mjs");
  writeFileSync(preload, `const r=(v,h={})=>({ok:true,status:200,headers:{get:n=>h[String(n).toLowerCase()]||""},json:async()=>v});globalThis.fetch=async u=>String(u).endsWith("/user")?r({login:"M1Vj",type:"User",id:1,name:"Vj"},{"x-oauth-scopes":"repo,workflow"}):r({});`);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH || ""}`,
    HOME: root,
    RUNNER_TEMP: root,
    TMPDIR: root,
    FLEET_STATE_ROOT: path.join(root, "state"),
    FLEET_ARTIFACT_DIR: artifacts,
    FLEET_REPO: REPO,
    FLEET_IMPROVE_MODE: "review",
    FLEET_LENS: "correctness",
    FLEET_CLOUD_AGENT_MODE: "issue-to-draft-pr",
    FLEET_TARGET_ISSUE: String(ISSUE),
    FLEET_REQUEST_ID: BINDING.requestId,
    FLEET_REQUEST_REVISION: REVISION,
    FLEET_AUTHORIZATION_ID: AUTH,
    FLEET_SOURCE_HEAD_SHA: SOURCE,
    FLEET_AUTH_POLICY_VERSION: "fleet-cloud-agent.v1",
    FLEET_DRAFT_ONLY: "true",
    FLEET_GH_TOKEN: "fixture-token",
    FLEET_OPENCODE_AUTH: "fixture-model-auth",
    FLEET_EXPECT_LOGIN: "M1Vj",
    FLEET_CONTROL_REPOSITORY: "private-owner/control-plane",
    FLEET_KILL_SWITCH_REPOSITORY: "private-owner/control-plane",
    FLEET_KILL_SWITCH_VARIABLE: "FLEET_KILL_SWITCH",
    FLEET_KILL_SWITCH_PATH: path.join(root, "KILL_SWITCH"),
    FLEET_DISPATCH_PROOF_VERIFIED: "true",
    FLEET_DISPATCH_PROOF_ID: PROOF,
    FLEET_DISPATCH_PROOF_REPO: REPO,
    FLEET_DISPATCH_PROOF_ISSUE: String(ISSUE),
    FLEET_ENROLLMENT_DIGEST: ENROLLMENT,
    FLEET_INDEFINITE_DISABLE: "1",
  };
  const result = spawnSync(process.execPath, ["--import", preload, path.resolve(process.cwd(), "scripts/improve.mjs")], { cwd: process.cwd(), env, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  const logs = existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const reviewDir = path.join(root, "reviews");
  const reviewFiles = existsSync(reviewDir) ? readdirSync(reviewDir) : [];
  const reviewReceipts = reviewFiles.map((name) => JSON.parse(readFileSync(path.join(reviewDir, name), "utf8")));
  const output = { status: result.status, stdout: result.stdout, stderr: result.stderr, timedOut: result.signal === "SIGTERM", logs, modelCalled: existsSync(modelSeen), reviewFiles, reviewReceipts };
  rmSync(root, { recursive: true, force: true });
  return output;
}

test("cloud review rejects malformed or unbound prmeta before diff/model/receipt work", () => {
  for (const meta of [metaFixture({ status: "blocked" }), metaFixture({ proofId: `proof_${"a".repeat(64)}` }), metaFixture({ branch: "fleet/improve-foreign" })]) {
    const result = runReview(meta);
    assert.notEqual(result.status, 0);
    assert.equal(result.logs.some((args) => args.join(" ").includes("/pulls/")), false);
    assert.equal(result.logs.some((args) => args.join(" ").includes("/files")), false);
    assert.equal(result.modelCalled, false);
    assert.deepEqual(result.reviewFiles, []);
  }
});

test("cloud review validates live draft PR and branch before reading files", () => {
  const result = runReview(metaFixture());
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.logs.some((args) => args.join(" ").includes("/pulls/17/files")), true);
  assert.equal(result.modelCalled, true);
  assert.equal(result.reviewFiles.length, 1);
  assert.equal(result.reviewReceipts[0].verdict, "approve");
  assert.deepEqual(result.reviewReceipts[0].findings, [], "an advisory approval may be clean when no findings are present");
  assert.equal(result.reviewReceipts[0].proofId, PROOF);
  assert.equal(result.reviewReceipts[0].enrollmentDigest, ENROLLMENT);
});

test("cloud review rejects live URL or draft drift before reading files or calling the model", () => {
  for (const livePatch of [
    { html_url: `https://github.com/${REPO}/pull/18` },
    { draft: false },
  ]) {
    const result = runReview(metaFixture(), { livePatch });
    assert.notEqual(result.status, 0);
    assert.equal(result.logs.some((args) => args.join(" ").includes("/pulls/17/files")), false);
    assert.equal(result.modelCalled, false);
    assert.deepEqual(result.reviewFiles, []);
  }
});
