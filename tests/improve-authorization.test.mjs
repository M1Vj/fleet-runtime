import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCloudAgentIssueContext,
  canonicalCloudAgentComments,
  buildCloudAgentPlanPrompt,
  buildCloudAgentResearchPrompt,
  buildCloudAgentRequestSnapshot,
  buildCloudAgentPullRequestBindingMarker,
  CLOUD_AGENT_DRAFT_MARKER,
  buildCloudAgentImplementationReceipt,
  cloudAgentArtifactMatches,
  cloudAgentIssueContextDigest,
  computeCloudAgentRequestRevision,
  fetchCloudAgentIssueComments,
  fetchCloudAgentLiveSnapshot,
  buildPlanArtifact,
  computePlanArtifactDigest,
  validatePlanArtifactContract,
  annotateCloudAgentIdeas,
  prepareCloudAgentImplementation,
  parseCloudAgentBinding,
  selectCloudAgentIssueIdea,
  validateCloudAgentExistingPullRequest,
  validateCloudAgentIssue,
  validateCloudAgentCheckout,
  validateCloudAgentPlanArtifact,
  verifyCloudAgentBinding,
} from "../scripts/improve.mjs";

const REVISION = "d".repeat(64);
const BASE_SHA = "a".repeat(40);

function bindingEnv(overrides = {}) {
  const result = {
    FLEET_CLOUD_AGENT_MODE: "issue-to-draft-pr",
    FLEET_TARGET_ISSUE: "42",
    FLEET_REQUEST_ID: "req_0123456789abcdef",
    FLEET_REQUEST_REVISION: REVISION,
    FLEET_AUTHORIZATION_ID: "auth_0123456789abcdef",
    FLEET_SOURCE_HEAD_SHA: BASE_SHA,
    FLEET_AUTH_POLICY_VERSION: "fleet-cloud-agent.v1",
    FLEET_DRAFT_ONLY: "true",
    FLEET_DISPATCH_PROOF_VERIFIED: "true",
    FLEET_DISPATCH_PROOF_ID: `proof_${"e".repeat(64)}`,
    FLEET_DISPATCH_PROOF_REPO: "M1Vj/demo",
    FLEET_DISPATCH_PROOF_ISSUE: "42",
    FLEET_ENROLLMENT_DIGEST: "f".repeat(64),
    FLEET_DISPATCH_PROOF_RUNTIME_REF: "a".repeat(40),
    FLEET_DISPATCH_PROOF_REQUEST_ID: "req_0123456789abcdef",
    FLEET_DISPATCH_PROOF_REQUEST_REVISION: REVISION,
    FLEET_DISPATCH_PROOF_AUTHORIZATION_ID: "auth_0123456789abcdef",
    FLEET_DISPATCH_PROOF_SOURCE_HEAD_SHA: BASE_SHA,
    FLEET_DISPATCH_PROOF_OPERATION: "issue-to-draft-pr",
    FLEET_DISPATCH_PROOF_POLICY_VERSION: "fleet-cloud-agent.v1",
    FLEET_DISPATCH_PROOF_TARGET_PATHS_POLICY: "safe-paths-v1",
    FLEET_DISPATCH_PROOF_DRAFT_ONLY: "true",
    FLEET_DISPATCH_PROOF_TOP_K: "1",
    FLEET_DISPATCH_PROOF_FOCUS: "all",
    ...overrides,
  };
  if (!("FLEET_DISPATCH_PROOF_REQUEST_ID" in overrides)) result.FLEET_DISPATCH_PROOF_REQUEST_ID = result.FLEET_REQUEST_ID;
  if (!("FLEET_DISPATCH_PROOF_REQUEST_REVISION" in overrides)) result.FLEET_DISPATCH_PROOF_REQUEST_REVISION = result.FLEET_REQUEST_REVISION;
  if (!("FLEET_DISPATCH_PROOF_AUTHORIZATION_ID" in overrides)) result.FLEET_DISPATCH_PROOF_AUTHORIZATION_ID = result.FLEET_AUTHORIZATION_ID;
  if (!("FLEET_DISPATCH_PROOF_SOURCE_HEAD_SHA" in overrides)) result.FLEET_DISPATCH_PROOF_SOURCE_HEAD_SHA = result.FLEET_SOURCE_HEAD_SHA;
  if (!("FLEET_DISPATCH_PROOF_ISSUE" in overrides)) result.FLEET_DISPATCH_PROOF_ISSUE = result.FLEET_TARGET_ISSUE;
  return result;
}

function issue() {
  return {
    number: 42,
    body: "hello",
    comments: 2,
    labels: [{ name: "enhancement" }, { name: "fleet" }],
    updated_at: "2026-09-20T00:00:00.000Z",
  };
}

test("canonical issue snapshot and revision match the private control-plane worker contract", () => {
  const snapshot = buildCloudAgentRequestSnapshot({
    repository: "M1Vj/demo",
    issue: issue(),
    comments: [{ id: 1 }, { id: 2 }],
    baseRef: "main",
    baseSha: BASE_SHA,
    policyVersion: "fleet-cloud-agent.v1",
    targetPathsPolicy: "safe-paths-v1",
  });

  assert.deepEqual(snapshot, {
    action: "issue-to-draft-pr",
    baseRef: "main",
    baseSha: BASE_SHA,
    commentsDigest: "9f335546a6cdc2df0f07662626ca75a077977ea3aee724e48845b59ea8a1acbf",
    issueBodyDigest: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    issueNumber: 42,
    labelsDigest: "b8d78ce6b1159e99c22ef2422c30d0d2bb3995c0e9c8cc705fec2375c405b065",
    policyVersion: "fleet-cloud-agent.v1",
    repository: "M1Vj/demo",
    sourceHeadSha: BASE_SHA,
    sourceUpdatedAt: "2026-09-20T00:00:00.000Z",
    targetPathsPolicy: "safe-paths-v1",
  });
  assert.equal(snapshot.baseSha, snapshot.sourceHeadSha);
  assert.equal(computeCloudAgentRequestRevision(snapshot), "e310621e854e65bd023ea7c23707f33c367fb1021281b24841fd4ab6ab0fde84");
});

test("cross-repo issue fixture preserves the exact 64-hex revision and 40-hex source/base pair", () => {
  const snapshot = buildCloudAgentRequestSnapshot({
    repository: "M1Vj/demo",
    issue: {
      number: 7,
      body: "private issue body",
      comments: 2,
      labels: [{ name: "enhancement" }],
      updated_at: "2026-09-20T00:00:00Z",
    },
    comments: [],
    baseRef: "main",
    baseSha: "a".repeat(40),
    sourceHeadSha: "a".repeat(40),
    policyVersion: "fleet-cloud-agent.v1",
    targetPathsPolicy: "safe-paths-v1",
  });

  assert.equal(snapshot.baseSha, "a".repeat(40));
  assert.equal(snapshot.sourceHeadSha, "a".repeat(40));
  assert.equal(computeCloudAgentRequestRevision(snapshot), "69f07f2096fba18409132518875e5e642caab762690b4484c2768364aea71f34");
});

function commentFixture(index, body = `comment-${index}`) {
  return {
    id: index + 1,
    updated_at: `2026-09-20T00:00:${String(index % 60).padStart(2, "0")}Z`,
    body,
  };
}

function pagedCommentReader(pages, calls = []) {
  return (args) => {
    const endpoint = args.find((value) => typeof value === "string" && value.includes("/comments?")) || "";
    const page = Number(endpoint.match(/[?&]page=(\d+)/)?.[1] || 0);
    calls.push({ args, page });
    const response = pages[page];
    if (response instanceof Error) throw response;
    return response ?? { items: [], hasNext: false };
  };
}

test("same-count comment body edits change request revision and reject stale bindings", () => {
  const base = {
    repository: "M1Vj/demo",
    issue: { number: 42, body: "same issue", comments: 1, labels: [], updated_at: "2026-09-20T00:00:00Z" },
    baseRef: "main",
    baseSha: BASE_SHA,
    sourceHeadSha: BASE_SHA,
  };
  const original = buildCloudAgentRequestSnapshot({ ...base, comments: [commentFixture(0, "original")] });
  const edited = buildCloudAgentRequestSnapshot({ ...base, comments: [commentFixture(0, "edited")] });
  assert.notEqual(original.commentsDigest, edited.commentsDigest);
  assert.notEqual(computeCloudAgentRequestRevision(original), computeCloudAgentRequestRevision(edited));
  const binding = parseCloudAgentBinding(bindingEnv({ FLEET_REQUEST_REVISION: computeCloudAgentRequestRevision(original) }));
  assert.equal(verifyCloudAgentBinding({ binding, repository: "M1Vj/demo", issueNumber: 42, snapshot: original }).ok, true);
  assert.equal(verifyCloudAgentBinding({ binding, repository: "M1Vj/demo", issueNumber: 42, snapshot: edited }).reason, "revision-mismatch");
});

test("comment canonicalization is deterministic and parity-compatible with the control contract", () => {
  const comments = [{ id: "7", updated_at: "2026-09-20T01:02:03Z", body: "hello" }];
  assert.deepEqual(canonicalCloudAgentComments(comments), [{
    id: "7",
    updatedAt: "2026-09-20T01:02:03.000Z",
    bodyDigest: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  }]);
  const snapshot = buildCloudAgentRequestSnapshot({
    repository: "M1Vj/demo",
    issue: { number: 42, body: "", comments: 1, labels: [], updated_at: "2026-09-20T00:00:00Z" },
    comments,
    baseRef: "main",
    baseSha: BASE_SHA,
    sourceHeadSha: BASE_SHA,
  });
  assert.equal(snapshot.commentsDigest, "975643ee44d3368d1a4164a8ebdf18f08d8ba8de63e64e3b9d73bd741e8b7d76");
});

test("bounded comment pagination accepts complete short/full pages and includes comments beyond page one", () => {
  const short = fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    ghClient: pagedCommentReader({ 1: { items: Array.from({ length: 99 }, (_, index) => commentFixture(index)), hasNext: false } }),
  });
  assert.equal(short.length, 99);

  const full = fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    ghClient: pagedCommentReader({ 1: { items: Array.from({ length: 100 }, (_, index) => commentFixture(index)), hasNext: false } }),
  });
  assert.equal(full.length, 100);

  const overPage = fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    ghClient: pagedCommentReader({
      1: { items: Array.from({ length: 100 }, (_, index) => commentFixture(index)), hasNext: true },
      2: { items: [commentFixture(100)], hasNext: false },
    }),
  });
  assert.equal(overPage.length, 101);
  assert.equal(overPage[100].id, 101);

  const atBound = fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    ghClient: pagedCommentReader({
      1: { items: Array.from({ length: 100 }, (_, index) => commentFixture(index)), hasNext: true },
      2: { items: Array.from({ length: 50 }, (_, index) => commentFixture(index + 100)), hasNext: false },
    }),
  });
  assert.equal(atBound.length, 150);
});

test("full pages without metadata require a bounded probe before completion", () => {
  const complete = fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    ghClient: pagedCommentReader({
      1: Array.from({ length: 100 }, (_, index) => commentFixture(index)),
      2: [],
    }),
  });
  assert.equal(complete.length, 100);

  assert.throws(() => fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    maxCommentPages: 1,
    ghClient: pagedCommentReader({
      1: Array.from({ length: 100 }, (_, index) => commentFixture(index)),
    }),
  }), (error) => error.code === "CLOUD_AGENT_COMMENTS_PAGINATION_EXHAUSTED");
});

test("the comment bound is accepted only after a complete final-page proof", () => {
  const underBound = fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    commentsPerPage: 50,
    maxCommentPages: 4,
    maxComments: 150,
    ghClient: pagedCommentReader({
      1: Array.from({ length: 50 }, (_, index) => commentFixture(index)),
      2: Array.from({ length: 50 }, (_, index) => commentFixture(index + 50)),
      3: Array.from({ length: 49 }, (_, index) => commentFixture(index + 100)),
    }),
  });
  assert.equal(underBound.length, 149);

  const exact = fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    commentsPerPage: 50,
    maxCommentPages: 4,
    maxComments: 150,
    ghClient: pagedCommentReader({
      1: Array.from({ length: 50 }, (_, index) => commentFixture(index)),
      2: Array.from({ length: 50 }, (_, index) => commentFixture(index + 50)),
      3: Array.from({ length: 50 }, (_, index) => commentFixture(index + 100)),
      4: [],
    }),
  });
  assert.equal(exact.length, 150);

  assert.throws(() => fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    commentsPerPage: 50,
    maxCommentPages: 4,
    maxComments: 150,
    ghClient: pagedCommentReader({
      1: Array.from({ length: 50 }, (_, index) => commentFixture(index)),
      2: Array.from({ length: 50 }, (_, index) => commentFixture(index + 50)),
      3: Array.from({ length: 50 }, (_, index) => commentFixture(index + 100)),
      4: [commentFixture(150)],
    }),
  }), (error) => error.code === "CLOUD_AGENT_COMMENTS_PAGINATION_EXHAUSTED");

  assert.throws(() => fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    commentsPerPage: 50,
    maxCommentPages: 4,
    maxComments: 150,
    ghClient: pagedCommentReader({
      1: Array.from({ length: 50 }, (_, index) => commentFixture(index)),
      2: Array.from({ length: 50 }, (_, index) => commentFixture(index + 50)),
      3: Array.from({ length: 50 }, (_, index) => commentFixture(index + 100)),
      4: { items: [], hasNext: true },
    }),
  }), (error) => error.code === "CLOUD_AGENT_COMMENTS_PAGINATION_EXHAUSTED");
});

test("a second-page comment changes the revision even when the issue count is unchanged", () => {
  const common = {
    repository: "M1Vj/demo",
    issue: { number: 42, body: "same issue", comments: 101, labels: [], updated_at: "2026-09-20T00:00:00Z" },
    baseRef: "main",
    baseSha: BASE_SHA,
    sourceHeadSha: BASE_SHA,
  };
  const originalComments = [
    ...Array.from({ length: 100 }, (_, index) => commentFixture(index)),
    commentFixture(100, "second-page-original"),
  ];
  const editedComments = originalComments.slice();
  editedComments[100] = commentFixture(100, "second-page-edited");
  const original = buildCloudAgentRequestSnapshot({ ...common, comments: originalComments });
  const edited = buildCloudAgentRequestSnapshot({ ...common, comments: editedComments });
  assert.notEqual(computeCloudAgentRequestRevision(original), computeCloudAgentRequestRevision(edited));
});

test("comment pagination fails closed on ambiguity, exhaustion, and API/page failures", () => {
  assert.throws(() => fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    maxCommentPages: 1,
    ghClient: pagedCommentReader({ 1: Array.from({ length: 100 }, (_, index) => commentFixture(index)) }),
  }), (error) => error.code === "CLOUD_AGENT_COMMENTS_PAGINATION_EXHAUSTED");

  assert.throws(() => fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    ghClient: pagedCommentReader({
      1: { items: Array.from({ length: 100 }, (_, index) => commentFixture(index)), hasNext: true },
      2: { items: Array.from({ length: 51 }, (_, index) => commentFixture(index + 100)), hasNext: false },
    }),
  }), (error) => error.code === "CLOUD_AGENT_COMMENTS_PAGINATION_EXHAUSTED");

  let calls = 0;
  assert.throws(() => fetchCloudAgentIssueComments("M1Vj/demo", 42, {}, {
    ghClient: () => {
      calls += 1;
      throw new Error("API down");
    },
  }), /API down/);
  assert.equal(calls, 1);
});

test("live snapshot stops before repository metadata when comment API fails", () => {
  const calls = [];
  const reader = (args) => {
    calls.push(args);
    const endpoint = args.find((value) => typeof value === "string" && value.startsWith("/repos/")) || "";
    if (endpoint.endsWith("/issues/42")) return { number: 42, state: "open", body: "issue", comments: 1, labels: [] };
    if (endpoint.includes("/comments?")) throw new Error("comment page unavailable");
    throw new Error("unexpected repository call");
  };
  assert.throws(() => fetchCloudAgentLiveSnapshot("M1Vj/demo", 42, { FLEET_SOURCE_HEAD_SHA: BASE_SHA }, { ghClient: reader }), /comment page unavailable/);
  assert.equal(calls.length, 2);
  assert.equal(calls.some((args) => args.some((value) => String(value).includes("/git/ref/heads/"))), false);
});

test("binding accepts the exact cloud-agent handoff contract", () => {
  const parsed = parseCloudAgentBinding(bindingEnv());
  assert.deepEqual(parsed, {
    ok: true,
    mode: "cloud-agent",
    targetIssue: 42,
    requestId: "req_0123456789abcdef",
    requestRevision: REVISION,
    authorizationId: "auth_0123456789abcdef",
    sourceHeadSha: BASE_SHA,
    policyVersion: "fleet-cloud-agent.v1",
    draftOnly: true,
    proofVerified: true,
    proofId: `proof_${"e".repeat(64)}`,
    proofRepository: "M1Vj/demo",
    proofIssue: 42,
    enrollmentDigest: "f".repeat(64),
    proofRuntimeRef: "a".repeat(40),
    proofRequestId: "req_0123456789abcdef",
    proofRequestRevision: REVISION,
    proofAuthorizationId: "auth_0123456789abcdef",
    proofSourceHeadSha: BASE_SHA,
    proofOperation: "issue-to-draft-pr",
    proofTargetPathsPolicy: "safe-paths-v1",
    proofTopK: 1,
    proofFocus: "all",
  });
});

test("binding rejects partial, malformed, or non-draft handoffs", () => {
  assert.equal(parseCloudAgentBinding(bindingEnv({ FLEET_AUTHORIZATION_ID: "" })).reason, "partial-binding");
  assert.equal(parseCloudAgentBinding(bindingEnv({ FLEET_REQUEST_REVISION: "D".repeat(64) })).reason, "invalid-request-revision");
  assert.equal(parseCloudAgentBinding(bindingEnv({ FLEET_SOURCE_HEAD_SHA: "D".repeat(40) })).reason, "invalid-source-head");
  assert.equal(parseCloudAgentBinding(bindingEnv({ FLEET_SOURCE_HEAD_SHA: "" })).reason, "partial-binding");
  assert.equal(parseCloudAgentBinding(bindingEnv({ FLEET_AUTH_POLICY_VERSION: "fleet-cloud-agent.v2" })).reason, "invalid-policy-version");
  assert.equal(parseCloudAgentBinding(bindingEnv({ FLEET_DRAFT_ONLY: "false" })).reason, "draft-only-required");
  assert.equal(parseCloudAgentBinding({
    FLEET_CLOUD_AGENT_MODE: "issue-to-draft-pr",
    FLEET_TARGET_ISSUE: "42",
  }).reason, "missing-binding");
});

test("legacy improve runs remain available only when no cloud-agent binding is supplied", () => {
  assert.deepEqual(parseCloudAgentBinding({}), { ok: true, mode: "legacy", targetIssue: null });
  assert.deepEqual(parseCloudAgentBinding({ FLEET_TARGET_ISSUE: "42" }), { ok: true, mode: "legacy", targetIssue: 42 });
  assert.equal(parseCloudAgentBinding({ FLEET_REQUEST_ID: "req_1" }).reason, "partial-binding");
});

test("verification fails closed for a stale revision or wrong issue scope", () => {
  const parsed = parseCloudAgentBinding(bindingEnv({ FLEET_REQUEST_REVISION: "f".repeat(64) }));
  const snapshot = buildCloudAgentRequestSnapshot({
    repository: "M1Vj/demo",
    issue: issue(),
    comments: [{ id: 1 }, { id: 2 }],
    baseRef: "main",
    baseSha: BASE_SHA,
    policyVersion: "fleet-cloud-agent.v1",
    targetPathsPolicy: "safe-paths-v1",
  });
  assert.equal(verifyCloudAgentBinding({ binding: parsed, repository: "M1Vj/demo", issueNumber: 42, snapshot }).reason, "revision-mismatch");

  const valid = parseCloudAgentBinding(bindingEnv({ FLEET_REQUEST_REVISION: computeCloudAgentRequestRevision(snapshot) }));
  assert.equal(verifyCloudAgentBinding({ binding: valid, repository: "M1Vj/demo", issueNumber: 41, snapshot }).reason, "issue-mismatch");
  assert.equal(verifyCloudAgentBinding({ binding: valid, repository: "Other/demo", issueNumber: 42, snapshot }).reason, "repository-mismatch");
  assert.equal(verifyCloudAgentBinding({ binding: valid, repository: "M1Vj/demo", issueNumber: 42, snapshot }).ok, true);
});

test("verification rejects a missing or mismatched 40-hex source head", () => {
  const snapshot = buildCloudAgentRequestSnapshot({
    repository: "M1Vj/demo",
    issue: issue(),
    comments: [{ id: 1 }, { id: 2 }],
    baseRef: "main",
    baseSha: BASE_SHA,
    policyVersion: "fleet-cloud-agent.v1",
    targetPathsPolicy: "safe-paths-v1",
  });
  const revision = computeCloudAgentRequestRevision(snapshot);
  const binding = parseCloudAgentBinding(bindingEnv({ FLEET_REQUEST_REVISION: revision }));

  assert.equal(verifyCloudAgentBinding({
    binding,
    repository: "M1Vj/demo",
    issueNumber: 42,
    snapshot: { ...snapshot, sourceHeadSha: "" },
  }).reason, "source-head-missing");
  assert.equal(verifyCloudAgentBinding({
    binding,
    repository: "M1Vj/demo",
    issueNumber: 42,
    snapshot: { ...snapshot, sourceHeadSha: "b".repeat(40), baseSha: "b".repeat(40) },
  }).reason, "source-head-mismatch");
});

test("cloud issue content drives research and plan prompts and remains artifact-bound", () => {
  const snapshot = buildCloudAgentRequestSnapshot({
    repository: "M1Vj/demo",
    issue: {
      number: 42,
      title: "Repair exact issue flow",
      body: "The authorized issue body is the only requested work.",
      comments: 1,
      labels: [{ name: "bug" }],
      updated_at: "2026-09-20T00:00:00Z",
    },
    comments: [{ id: 7, body: "Please keep the fix scoped to this issue." }],
    baseRef: "main",
    baseSha: BASE_SHA,
    sourceHeadSha: BASE_SHA,
    policyVersion: "fleet-cloud-agent.v1",
    targetPathsPolicy: "safe-paths-v1",
  });
  const binding = parseCloudAgentBinding(bindingEnv({ FLEET_REQUEST_REVISION: computeCloudAgentRequestRevision(snapshot) }));
  const issueContext = buildCloudAgentIssueContext({
    issue: { number: 42, title: "Repair exact issue flow", body: "The authorized issue body is the only requested work.", labels: [{ name: "bug" }] },
    comments: [{ id: 7, body: "Please keep the fix scoped to this issue." }],
    snapshot,
  });
  const idea = {
    title: "Repair exact issue flow",
    rationale: "The issue requests a scoped repair.",
    evidence: "scripts/improve.mjs:1 observed issue flow",
    impact: "high",
    category: "fix",
  };
  const researchPrompt = buildCloudAgentResearchPrompt("M1Vj/demo", "/tmp/work", { snapshot, issueContext });
  assert.match(researchPrompt, /issue #42/);
  assert.match(researchPrompt, /Repair exact issue flow/);
  assert.match(researchPrompt, /The authorized issue body is the only requested work\./);
  assert.match(researchPrompt, /Please keep the fix scoped to this issue\./);
  const artifact = {
    repo: "M1Vj/demo",
    repository: "M1Vj/demo",
    targetIssue: 42,
    issueNumber: 42,
    requestRevision: binding.requestRevision,
    proofId: binding.proofId,
    enrollmentDigest: binding.enrollmentDigest,
    snapshot,
    issueContext,
    issueContextDigest: cloudAgentIssueContextDigest(issueContext),
    ideas: annotateCloudAgentIdeas([idea], binding),
  };
  assert.equal(cloudAgentArtifactMatches({ artifact, binding, repository: "M1Vj/demo", snapshot, issueContext }), true);
  const planPrompt = buildCloudAgentPlanPrompt("M1Vj/demo", "/tmp/work", { snapshot, issueContext, idea: artifact.ideas[0] });
  assert.match(planPrompt, /exactly issue #42/);
  assert.match(planPrompt, /The authorized issue body is the only requested work\./);
  assert.equal(selectCloudAgentIssueIdea(artifact, { binding, repository: "M1Vj/demo", snapshot, issueContext }).title, idea.title);
});

test("cloud plan rejects an unrelated issue idea instead of generic ranking", () => {
  const snapshot = buildCloudAgentRequestSnapshot({
    repository: "M1Vj/demo",
    issue: { number: 42, title: "Exact issue", body: "Only this issue.", comments: 0, labels: [], updated_at: "2026-09-20T00:00:00Z" },
    comments: [],
    baseRef: "main",
    baseSha: BASE_SHA,
    sourceHeadSha: BASE_SHA,
  });
  const binding = parseCloudAgentBinding(bindingEnv({ FLEET_REQUEST_REVISION: computeCloudAgentRequestRevision(snapshot) }));
  const issueContext = buildCloudAgentIssueContext({ issue: { number: 42, title: "Exact issue", body: "Only this issue.", labels: [] }, comments: [], snapshot });
  const unrelated = {
    repo: "M1Vj/demo",
    repository: "M1Vj/demo",
    targetIssue: 42,
    issueNumber: 42,
    requestRevision: binding.requestRevision,
    proofId: binding.proofId,
    enrollmentDigest: binding.enrollmentDigest,
    snapshot,
    issueContext,
    issueContextDigest: cloudAgentIssueContextDigest(issueContext),
    ideas: [{ title: "Unrelated generic upgrade", rationale: "generic", evidence: "scripts/improve.mjs:1 generic", impact: "high", targetIssue: 99, issueNumber: 99, requestRevision: binding.requestRevision }],
  };
  assert.throws(() => selectCloudAgentIssueIdea(unrelated, { binding, repository: "M1Vj/demo", snapshot, issueContext }), /research ideas missing/);
});

function implementFixture({ sourceHeadSha = BASE_SHA } = {}) {
  const snapshot = buildCloudAgentRequestSnapshot({
    repository: "M1Vj/demo",
    issue: {
      number: 42,
      title: "Exact implement issue",
      body: "Implement only this issue.",
      comments: 0,
      labels: [{ name: "bug" }],
      updated_at: "2026-09-20T00:00:00Z",
    },
    comments: [],
    baseRef: "main",
    baseSha: sourceHeadSha,
    sourceHeadSha,
  });
  const binding = parseCloudAgentBinding(bindingEnv({
    FLEET_REQUEST_REVISION: computeCloudAgentRequestRevision(snapshot),
    FLEET_SOURCE_HEAD_SHA: sourceHeadSha,
  }));
  const issueContext = buildCloudAgentIssueContext({
    issue: { number: 42, title: "Exact implement issue", body: "Implement only this issue.", labels: [{ name: "bug" }] },
    comments: [],
    snapshot,
  });
  const plan = {
    title: "Implement exact issue",
    summary: "Make the requested bounded change.",
    prBody: "The implementation is ready for review.",
    risks: "Review the focused behavior.",
    files: [{ path: "src/fix.mjs", content: "export const fixed = true;\n" }],
  };
  return {
    snapshot,
    binding,
    issueContext,
    artifact: {
      repo: "M1Vj/demo",
      targetIssue: 42,
      issueNumber: 42,
      requestRevision: binding.requestRevision,
      proofId: binding.proofId,
      enrollmentDigest: binding.enrollmentDigest,
      snapshot,
      issueContext,
      issueContextDigest: cloudAgentIssueContextDigest(issueContext),
      plan,
      idea: { category: "fix" },
    },
  };
}

test("cloud implement rejects stale, cross-issue, and cross-revision plans before branch work", () => {
  const current = implementFixture();
  const staleSnapshot = { ...current.snapshot, sourceHeadSha: "b".repeat(40), baseSha: "b".repeat(40) };
  assert.equal(validateCloudAgentPlanArtifact({
    artifact: { ...current.artifact, snapshot: staleSnapshot },
    binding: current.binding,
    repository: "M1Vj/demo",
    snapshot: current.snapshot,
    issueContext: current.issueContext,
  }).reason, "source-head-mismatch");

  assert.equal(validateCloudAgentPlanArtifact({
    artifact: { ...current.artifact, targetIssue: 41, issueNumber: 41 },
    binding: current.binding,
    repository: "M1Vj/demo",
    snapshot: current.snapshot,
    issueContext: current.issueContext,
  }).reason, "issue-mismatch");

  assert.equal(validateCloudAgentPlanArtifact({
    artifact: { ...current.artifact, requestRevision: "f".repeat(64) },
    binding: current.binding,
    repository: "M1Vj/demo",
    snapshot: current.snapshot,
    issueContext: current.issueContext,
  }).reason, "revision-mismatch");
});

test("cloud implement prepares an issue-closing draft body without network adapters", () => {
  const fixture = implementFixture();
  const prepared = prepareCloudAgentImplementation({
    artifact: fixture.artifact,
    binding: fixture.binding,
    repository: "M1Vj/demo",
    snapshot: fixture.snapshot,
    issueContext: fixture.issueContext,
  });
  assert.equal(prepared.ok, true);
  assert.match(prepared.body, /Fixes #42/);
  assert.match(prepared.body, /draft-only/i);
  assert.match(prepared.body, /auto-merge disabled/i);
  assert.equal(prepared.pullRequest.draft, true);
  assert.equal(prepared.pullRequest.auto_merge, false);
});

function existingPullRequestFixture(fixture = implementFixture(), overrides = {}) {
  const branch = "fleet/improve-recovery";
  const branchHeadSha = "c".repeat(40);
  const marker = buildCloudAgentPullRequestBindingMarker({
    repository: "M1Vj/demo",
    targetIssue: fixture.binding.targetIssue,
    requestRevision: fixture.binding.requestRevision,
    sourceHeadSha: fixture.binding.sourceHeadSha,
    branch,
  });
  return {
    number: 17,
    state: "open",
    draft: true,
    merged: false,
    auto_merge: null,
    html_url: "https://github.com/M1Vj/demo/pull/17",
    head: { ref: branch, sha: branchHeadSha, repo: { full_name: "M1Vj/demo" } },
    base: { ref: "main", sha: fixture.binding.sourceHeadSha, repo: { full_name: "M1Vj/demo" } },
    body: [`Fixes #${fixture.binding.targetIssue}`, marker].join("\n"),
    ...overrides,
  };
}

test("exact existing cloud PR restores a control-compatible receipt", () => {
  const fixture = implementFixture();
  const pullRequest = existingPullRequestFixture(fixture);
  const validation = validateCloudAgentExistingPullRequest({
    pullRequest,
    repository: "M1Vj/demo",
    targetIssue: fixture.binding.targetIssue,
    requestRevision: fixture.binding.requestRevision,
    sourceHeadSha: fixture.binding.sourceHeadSha,
    branch: "fleet/improve-recovery",
    base: "main",
    branchHeadSha: "c".repeat(40),
  });
  assert.equal(validation.ok, true);
  const receipt = buildCloudAgentImplementationReceipt({
    repo: "M1Vj/demo",
    pullRequest,
    branch: "fleet/improve-recovery",
    base: "main",
    branchHeadSha: "c".repeat(40),
    binding: fixture.binding,
    title: fixture.artifact.plan.title,
    category: "fix",
  });
  assert.deepEqual(
    {
      schema: receipt.schema,
      version: receipt.version,
      stage: receipt.stage,
      status: receipt.status,
      complete: receipt.complete,
      repo: receipt.repo,
      prNumber: receipt.prNumber,
      prUrl: receipt.prUrl,
      sourceRevision: receipt.sourceRevision,
      headSha: receipt.headSha,
      targetIssue: receipt.targetIssue,
      requestRevision: receipt.requestRevision,
      authorizationId: receipt.authorizationId,
      sourceHeadSha: receipt.sourceHeadSha,
      binding: receipt.binding,
    },
    {
      schema: "fleet-improve-receipt-v1",
      version: 1,
      stage: "implement",
      status: "ready",
      complete: true,
      repo: "M1Vj/demo",
      prNumber: 17,
      prUrl: "https://github.com/M1Vj/demo/pull/17",
      sourceRevision: fixture.binding.sourceHeadSha,
      headSha: "c".repeat(40),
      targetIssue: 42,
      requestRevision: fixture.binding.requestRevision,
      authorizationId: fixture.binding.authorizationId,
      sourceHeadSha: fixture.binding.sourceHeadSha,
      binding: {
        kind: "source-revision-v1",
        schema: "fleet-improve-receipt-v1",
        version: 1,
        repo: "M1Vj/demo",
        sourceRevision: fixture.binding.sourceHeadSha,
        headSha: "c".repeat(40),
        prNumber: 17,
        targetIssue: 42,
        requestId: fixture.binding.requestId,
        requestRevision: fixture.binding.requestRevision,
        authorizationId: fixture.binding.authorizationId,
        sourceHeadSha: fixture.binding.sourceHeadSha,
        proofId: fixture.binding.proofId,
        enrollmentDigest: fixture.binding.enrollmentDigest,
        baseBranch: "main",
        draftOnly: true,
        draftMarker: CLOUD_AGENT_DRAFT_MARKER,
      },
    },
  );
});

test("existing cloud PR recovery rejects ambiguity and every binding or draft mismatch", () => {
  const fixture = implementFixture();
  const baseOptions = {
    repository: "M1Vj/demo",
    targetIssue: fixture.binding.targetIssue,
    requestRevision: fixture.binding.requestRevision,
    sourceHeadSha: fixture.binding.sourceHeadSha,
    branch: "fleet/improve-recovery",
    base: "main",
    branchHeadSha: "c".repeat(40),
  };
  const cases = [
    ["missing marker", { body: "Fixes #42" }, "pull-request-binding-marker-missing-or-malformed"],
    ["wrong repo", { head: { ref: "fleet/improve-recovery", sha: "c".repeat(40), repo: { full_name: "Other/demo" } } }, "pull-request-repository-mismatch"],
    ["wrong request revision", { body: `Fixes #42\n${buildCloudAgentPullRequestBindingMarker({ repository: "M1Vj/demo", targetIssue: 42, requestRevision: "e".repeat(64), sourceHeadSha: fixture.binding.sourceHeadSha, branch: "fleet/improve-recovery" })}` }, "pull-request-binding-mismatch"],
    ["wrong source head", { base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "M1Vj/demo" } } }, "pull-request-source-head-mismatch"],
    ["wrong head branch", { head: { ref: "fleet/other", sha: "c".repeat(40), repo: { full_name: "M1Vj/demo" } } }, "pull-request-branch-mismatch"],
    ["wrong base branch", { base: { ref: "develop", sha: fixture.binding.sourceHeadSha, repo: { full_name: "M1Vj/demo" } } }, "pull-request-base-mismatch"],
    ["wrong issue", { body: `Fixes #41\n${buildCloudAgentPullRequestBindingMarker({ repository: "M1Vj/demo", targetIssue: 41, requestRevision: fixture.binding.requestRevision, sourceHeadSha: fixture.binding.sourceHeadSha, branch: "fleet/improve-recovery" })}` }, "pull-request-binding-mismatch"],
    ["not draft", { draft: false }, "pull-request-not-draft"],
    ["auto merge enabled", { auto_merge: { enabled_at: "2026-09-20T00:00:00Z" } }, "pull-request-auto-merge-enabled-or-unknown"],
    ["closed", { state: "closed" }, "pull-request-not-open"],
  ];
  for (const [label, overrides, reason] of cases) {
    assert.equal(validateCloudAgentExistingPullRequest({ pullRequest: existingPullRequestFixture(fixture, overrides), ...baseOptions }).reason, reason, label);
  }
  assert.equal(validateCloudAgentExistingPullRequest({ pullRequest: existingPullRequestFixture(fixture), ...baseOptions, branchHeadSha: "d".repeat(40) }).reason, "pull-request-head-mismatch");
});

test("cloud issue and checkout guards fail closed before model or artifact work", () => {
  assert.equal(validateCloudAgentIssue({ number: 42, state: "open" }, 42).ok, true);
  assert.equal(validateCloudAgentIssue({ number: 42, state: "open", repository: { full_name: "M1Vj/demo" }, repository_url: "https://api.github.com/repos/M1Vj/demo" }, 42, "M1Vj/demo").ok, true);
  assert.equal(validateCloudAgentIssue({ number: 42, state: "open", repository: { full_name: "Other/demo" } }, 42, "M1Vj/demo").reason, "issue-repository-mismatch");
  assert.equal(validateCloudAgentIssue({ number: 42, state: "open", repository_url: "https://api.github.com/repos/M1Vj/other" }, 42, "M1Vj/demo").reason, "issue-repository-mismatch");
  assert.equal(validateCloudAgentIssue({ number: 42, state: "closed" }, 42).reason, "target-issue-not-open");
  assert.equal(validateCloudAgentIssue({ number: 42, state: "open", pull_request: { url: "https://github.com/M1Vj/demo/pull/42" } }, 42).reason, "target-is-pull-request");
  assert.equal(validateCloudAgentCheckout("/tmp/does-not-exist-fleet-runtime", BASE_SHA).reason, "checkout-missing");
  assert.equal(validateCloudAgentCheckout("/tmp/does-not-exist-fleet-runtime", "b".repeat(40)).reason, "checkout-missing");
});

test("versioned plan handoff carries an exact cloud binding and digest", () => {
  const fixture = implementFixture();
  const artifact = buildPlanArtifact({
    repo: "M1Vj/demo",
    idea: { category: "fix", targetIssue: 42, requestRevision: fixture.binding.requestRevision },
    plan: fixture.artifact.plan,
    binding: fixture.binding,
    snapshot: fixture.snapshot,
    issueContext: fixture.issueContext,
  });
  assert.equal(artifact.status, "ready");
  assert.equal(artifact.complete, true);
  assert.equal(artifact.selectedRepo, "M1Vj/demo");
  assert.equal(artifact.binding.requestRevision, fixture.binding.requestRevision);
  assert.equal(artifact.digest, computePlanArtifactDigest(artifact));
  assert.equal(validatePlanArtifactContract(artifact, {
    binding: fixture.binding,
    repository: "M1Vj/demo",
    snapshot: fixture.snapshot,
    issueContext: fixture.issueContext,
  }).ok, true);
});

test("plan contract and deterministic resolver fail closed for malformed, missing, or stale handoffs", () => {
  const fixture = implementFixture();
  const artifact = buildPlanArtifact({
    repo: "M1Vj/demo",
    idea: { category: "fix" },
    plan: fixture.artifact.plan,
    binding: fixture.binding,
    snapshot: fixture.snapshot,
    issueContext: fixture.issueContext,
  });
  assert.equal(validatePlanArtifactContract({ ...artifact, status: "blocked" }, {
    binding: fixture.binding,
    repository: "M1Vj/demo",
    snapshot: fixture.snapshot,
    issueContext: fixture.issueContext,
  }).ok, false);
  assert.equal(validatePlanArtifactContract({ ...artifact, digest: "0".repeat(64), planDigest: "0".repeat(64) }, {
    binding: fixture.binding,
    repository: "M1Vj/demo",
    snapshot: fixture.snapshot,
    issueContext: fixture.issueContext,
  }).reason, "plan-digest-mismatch");
  assert.equal(validatePlanArtifactContract(artifact, {
    binding: fixture.binding,
    repository: "M1Vj/demo",
    snapshot: { ...fixture.snapshot, sourceHeadSha: "b".repeat(40), baseSha: "b".repeat(40) },
    issueContext: fixture.issueContext,
  }).ok, false);

  assert.equal(validatePlanArtifactContract(null, {
    binding: fixture.binding,
    repository: "M1Vj/demo",
    snapshot: fixture.snapshot,
    issueContext: fixture.issueContext,
  }).reason, "invalid-artifact");
});
