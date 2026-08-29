import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityDigest } from "../scripts/lib/capability-registry.mjs";
import {
  activatePromotion,
  buildRegistryPointerMutation,
  buildRollbackPointerMutation,
  createGitHubPromotionAdapters,
  executePromotionTransaction,
  executeRollbackTransaction,
  planPostActivationRollback,
  preparePromotion,
  validateCapabilityCandidate,
} from "../scripts/promote-capability.mjs";
import { readPromotionEvents } from "../scripts/lib/promotion-state.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const digest = (letter) => `sha256:${letter.repeat(64)}`;

function toolCandidate(overrides = {}) {
  const rollbackDigest = digest("b");
  const manifest = {
    id: "safe-transform",
    version: "1.0.0",
    status: "active",
    kind: "declarative-v1",
    operations: [{ op: "take", count: 1 }],
    purpose: "A bounded declarative transform.",
    description: "No executable authority.",
    capabilities: ["json-selection", "no-shell", "no-network", "no-env", "no-write"],
  };
  manifest.digest = capabilityDigest(manifest);
  const candidateDigest = manifest.digest;
  const candidate = {
    manifest,
    kind: "declarative-v1",
    digest: candidateDigest,
    changedPaths: ["config/tools.json"],
    fixtureResults: [{ id: "transform-fixture", status: "passed", result: [{ value: 1 }], candidateDigest }],
    judgeResults: [
      { id: "correctness", trusted: true, verdict: "pass", candidateDigest },
      { id: "adversarial", trusted: true, verdict: "pass", candidateDigest },
    ],
    canary: { id: "synthetic-transform", status: "passed", digest: candidateDigest, synthetic: true },
    rollbackDigest,
    priorActiveDigest: rollbackDigest,
  };
  const prior = {
    ...manifest,
    version: "0.9.0",
    operations: [{ op: "take", count: 2 }],
    digest: rollbackDigest,
  };
  prior.digest = rollbackDigest;
  return {
    candidate: { ...candidate, ...overrides },
    registry: { version: 1, tools: [{ ...prior, status: "active" }] },
  };
}

test("a complete declarative candidate prepares an exact non-force attributed activation plan", () => {
  const { candidate, registry } = toolCandidate();
  const plan = preparePromotion(candidate, { registry, registryPath: "config/tools.json" });
  assert.equal(plan.activate, true);
  assert.equal(plan.disposition, "auto-activate");
  assert.equal(plan.capability.digest, candidate.digest);
  assert.equal(plan.capability.rollbackDigest, candidate.rollbackDigest);
  assert.equal(plan.transaction.force, false);
  assert.equal(plan.transaction.expectedDigest, candidate.rollbackDigest);
  assert.equal(plan.transaction.candidateDigest, candidate.digest);
  assert.equal(plan.transaction.author, "M1Vj");
  assert.equal(plan.transaction.email, "143296579+M1Vj@users.noreply.github.com");
});

test("promotion blocks missing, duplicate, untrusted, or failing judges", () => {
  const { candidate, registry } = toolCandidate();
  const missing = { ...candidate, judgeResults: [{ verdict: "pass" }, { verdict: "pass" }] };
  assert.equal(validateCapabilityCandidate(missing, { registry }).activate, false);
  const duplicate = { ...candidate, judgeResults: [{ ...candidate.judgeResults[0] }, { ...candidate.judgeResults[0] }] };
  assert.equal(validateCapabilityCandidate(duplicate, { registry }).activate, false);
  const untrusted = { ...candidate, judgeResults: candidate.judgeResults.map((entry) => ({ ...entry, trusted: false })) };
  assert.equal(validateCapabilityCandidate(untrusted, { registry }).activate, false);
  const failed = { ...candidate, judgeResults: candidate.judgeResults.map((entry) => ({ ...entry, verdict: "fail" })) };
  assert.equal(validateCapabilityCandidate(failed, { registry }).activate, false);
});

test("promotion requires real fixture results, candidate-specific canary, and an existing prior active digest", () => {
  const { candidate, registry } = toolCandidate();
  assert.equal(validateCapabilityCandidate({ ...candidate, fixtureResults: [{ id: "fixture", passed: true }] }, { registry }).activate, false);
  assert.equal(validateCapabilityCandidate({ ...candidate, canary: { status: "passed", digest: digest("b"), synthetic: true } }, { registry }).activate, false);
  assert.equal(validateCapabilityCandidate({ ...candidate, priorActiveDigest: digest("c") }, { registry }).activate, false);
  assert.equal(validateCapabilityCandidate({ ...candidate, rollbackDigest: candidate.digest, priorActiveDigest: candidate.digest }, { registry }).activate, false);
  assert.equal(validateCapabilityCandidate({ ...candidate, content: "api_key=plaintextcredential123456" }, { registry }).activate, false);
});

test("protected paths and executable tools produce owner-review drafts only", () => {
  const { candidate, registry } = toolCandidate({ changedPaths: [".github/workflows/promote.yml"] });
  const protectedPlan = preparePromotion(candidate, { registry });
  assert.equal(protectedPlan.activate, false);
  assert.equal(protectedPlan.disposition, "owner-review");
  assert.equal(protectedPlan.draft.mutation, "none");

  const executable = preparePromotion({ ...candidate, kind: "javascript", manifest: { ...candidate, kind: "javascript" } }, { registry });
  assert.equal(executable.activate, false);
  assert.equal(executable.disposition, "owner-review");
  assert.equal(executable.draft.mutation, "none");
});

test("activation is injectable for tests and disabled by default", () => {
  const { candidate, registry } = toolCandidate();
  const plan = preparePromotion(candidate, { registry });
  assert.throws(() => activatePromotion(plan), /ACTIVATION_DISABLED/i);
  let received;
  const result = activatePromotion(plan, { commit: (transaction) => { received = transaction; return { committed: true }; } });
  assert.deepEqual(result, { committed: true });
  assert.equal(received.force, false);
  assert.equal(received.expectedDigest, candidate.rollbackDigest);
  assert.equal(received.email, "143296579+M1Vj@users.noreply.github.com");
});

test("injected activation mutates only the registry pointer, creates a capability branch, and records PR state", async () => {
  const { candidate, registry } = toolCandidate();
  const baseSha = "c".repeat(40);
  const plan = preparePromotion(candidate, { registry, baseSha });
  const mutation = buildRegistryPointerMutation({ plan, registry, candidateManifest: candidate.manifest });
  assert.deepEqual(mutation.changedPaths, ["config/tools.json"]);
  assert.equal(mutation.registry.tools.find((entry) => entry.id === candidate.manifest.id).digest, candidate.digest);

  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleet-promotion-exec-"));
  const calls = [];
  const committedStates = [];
  const result = await executePromotionTransaction({
    plan,
    registry,
    candidateManifest: candidate.manifest,
    stateRoot,
    adapters: {
      verifyIdentity: () => ({ name: "M1Vj", email: "143296579+M1Vj@users.noreply.github.com" }),
      createBranch: (request) => { calls.push(["branch", request]); return { branch: request.branch, forced: false }; },
      commit: (request) => { calls.push(["commit", request]); return { sha: "d".repeat(40), author: "M1Vj" }; },
      push: (request) => { calls.push(["push", request]); return { forced: false }; },
      openDraftPullRequest: (request) => { calls.push(["pr", request]); return { number: 17, draft: true, merged: false }; },
    },
    stateCommit: ({ event }) => { committedStates.push(event.state); return "committed"; },
  });
  assert.equal(result.state, "ACTIVATION_PR_OPENED");
  assert.equal(calls[0][0], "branch");
  assert.equal(calls[1][1].force, false);
  assert.equal(calls[2][1].force, false);
  assert.equal(calls[3][1].draft, true);
  const states = readPromotionEvents(stateRoot).map((entry) => entry.state);
  assert.ok(states.includes("ACTIVATION_PLANNED"));
  assert.ok(states.includes("ACTIVATION_PR_OPENED"));
  assert.deepEqual(committedStates, ["ACTIVATION_PLANNED", "ACTIVATION_BRANCH_CREATED", "ACTIVATION_COMMITTED", "ACTIVATION_PUSHED", "ACTIVATION_PR_OPENED"]);
});

test("production adapter is locally injectable and uses exact non-force branch, commit, push, and draft PR API calls", async () => {
  const baseSha = "c".repeat(40);
  const commitSha = "d".repeat(40);
  const mainRegistry = toolCandidate().registry;
  const branch = "fleet/capability-safe-transform-abcdef123456";
  let branchSha = baseSha;
  const ghCalls = [];
  const inputCalls = [];
  const adapters = createGitHubPromotionAdapters({
    env: { FLEET_PROMOTION_REPO: "M1Vj/fleet-runtime" },
    gate: async () => ({ login: "M1Vj", type: "User", noreply: "143296579+M1Vj@users.noreply.github.com" }),
    ghCall: (args) => {
      ghCalls.push(args);
      const joined = args.join(" ");
      if (joined.includes("git/ref/heads/main")) return { object: { sha: baseSha } };
      if (joined.includes("/contents/config/tools.json")) return {
        encoding: "base64",
        content: Buffer.from(JSON.stringify(mainRegistry), "utf8").toString("base64"),
      };
      if (joined.includes("git/ref/heads/fleet/")) return { object: { sha: branchSha } };
      if (joined.includes("git/commits/")) return { tree: { sha: "e".repeat(40) } };
      throw new Error(`unexpected gh call: ${joined}`);
    },
    ghInputCall: (args, body) => {
      inputCalls.push([args, body]);
      const joined = args.join(" ");
      if (joined.includes("git/refs") && joined.includes("POST")) {
        branchSha = baseSha;
        return { object: { sha: baseSha } };
      }
      if (joined.includes("git/blobs")) return { sha: "f".repeat(40) };
      if (joined.includes("git/trees")) return { sha: "a".repeat(40) };
      if (joined.includes("git/commits")) return {
        sha: commitSha,
        parents: [{ sha: baseSha }],
        commit: { author: { name: "M1Vj", email: "143296579+M1Vj@users.noreply.github.com" } },
      };
      if (joined.includes("git/ref/heads/fleet/") && joined.includes("PATCH")) {
        branchSha = commitSha;
        return { object: { sha: commitSha } };
      }
      if (joined.includes("/pulls") && joined.includes("POST")) return {
        number: 23,
        draft: true,
        merged: false,
        auto_merge: null,
        base: { ref: "main" },
        head: { ref: branch },
        html_url: "https://github.com/M1Vj/fleet-runtime/pull/23",
      };
      throw new Error(`unexpected gh input: ${joined}`);
    },
  });
  assert.deepEqual(await adapters.verifyIdentity(), {
    name: "M1Vj",
    email: "143296579+M1Vj@users.noreply.github.com",
  });
  const currentMain = adapters.readCurrentMainState({ baseRef: "main", registryPath: "config/tools.json", collection: "tools" });
  assert.equal(currentMain.baseSha, baseSha);
  assert.deepEqual(currentMain.registry, mainRegistry);
  assert.equal(adapters.createBranch({ branch, baseRef: "main", baseSha, force: false }).forced, false);
  const commit = adapters.commit({
    branch,
    baseSha,
    files: { "config/tools.json": "{\"version\":1}\n" },
    allowedPaths: ["config/tools.json"],
    message: "promote tool",
    author: "M1Vj",
    email: "143296579+M1Vj@users.noreply.github.com",
    force: false,
  });
  assert.equal(commit.sha, commitSha);
  assert.equal(adapters.push({ branch, commitSha, expectedHeadSha: baseSha, force: false }).forced, false);
  const pr = adapters.openDraftPullRequest({ base: "main", head: branch, draft: true, title: "promote", body: "review" });
  assert.equal(pr.draft, true);
  assert.equal(inputCalls.find(([args]) => args.join(" ").includes("PATCH"))[1].force, false);
  assert.equal(inputCalls.find(([args]) => args.join(" ").includes("/pulls"))[1].draft, true);
  assert.ok(ghCalls.some((args) => args.join(" ").includes("git/ref/heads/main")));
});

test("injected activation fails closed on stale registry digest or identity mismatch", async () => {
  const { candidate, registry } = toolCandidate();
  const plan = preparePromotion(candidate, { registry, baseSha: "c".repeat(40) });
  const stale = structuredClone(registry);
  stale.tools[0].digest = digest("e");
  assert.throws(() => buildRegistryPointerMutation({ plan, registry: stale, candidateManifest: candidate.manifest }), /CURRENT_DIGEST_MISMATCH/i);
  await assert.rejects(() => executePromotionTransaction({
    plan,
    registry,
    candidateManifest: candidate.manifest,
    stateRoot: mkdtempSync(path.join(tmpdir(), "fleet-promotion-identity-")),
    adapters: {
      verifyIdentity: () => ({ name: "not-owner", email: "not-owner@example.invalid" }),
      createBranch: () => ({ branch: plan.transaction.branch }),
      commit: () => ({ sha: "d".repeat(40) }),
      push: () => ({ forced: false }),
      openDraftPullRequest: () => ({ number: 1, draft: true }),
    },
  }), /IDENTITY_MISMATCH/i);
});

test("post-activation health failure plans exact pointer rollback and never arbitrary code", () => {
  const { candidate, registry } = toolCandidate();
  const plan = preparePromotion(candidate, { registry });
  const healthy = planPostActivationRollback({ plan, health: { status: "passed" }, currentEntry: candidate });
  assert.equal(healthy.rollback, false);
  const rollback = planPostActivationRollback({ plan, health: { status: "failed" }, currentEntry: candidate });
  assert.equal(rollback.rollback, true);
  assert.equal(rollback.transaction.operation, "prepare-registry-pointer-rollback-pr");
  assert.equal(rollback.transaction.expectedDigest, candidate.digest);
  assert.equal(rollback.transaction.rollbackDigest, candidate.rollbackDigest);
  assert.equal(rollback.transaction.force, false);
  assert.equal(Object.hasOwn(rollback.transaction, "code"), false);
  assert.equal(planPostActivationRollback({ plan, health: { status: "failed" }, currentEntry: { digest: digest("c") } }).rollback, false);
});

test("a committed inactive digest seed can activate and rollback to its exact inactive manifest", async () => {
  const prior = {
    id: "seeded-transform",
    version: "0.9.0",
    status: "inactive",
    kind: "declarative-v1",
    operations: [{ op: "take", count: 2 }],
    purpose: "A seeded inactive transform.",
    description: "Digest-pinned rollback seed.",
    capabilities: ["json-selection", "no-shell", "no-network", "no-env", "no-write"],
  };
  prior.digest = capabilityDigest(prior);
  const manifest = {
    ...prior,
    version: "1.0.0",
    status: "active",
    operations: [{ op: "take", count: 1 }],
  };
  manifest.digest = capabilityDigest(manifest);
  manifest.rollbackDigest = prior.digest;
  const candidate = {
    manifest,
    kind: "declarative-v1",
    digest: manifest.digest,
    rollbackDigest: prior.digest,
    priorActiveDigest: prior.digest,
    changedPaths: ["config/tools.json"],
    fixtureResults: [{ id: "seed-fixture", status: "passed", result: [{ value: 1 }], candidateDigest: manifest.digest }],
    judgeResults: [
      { id: "correctness", trusted: true, verdict: "pass", candidateDigest: manifest.digest },
      { id: "adversarial", trusted: true, verdict: "pass", candidateDigest: manifest.digest },
    ],
    canary: { id: "seed-canary", status: "passed", digest: manifest.digest, synthetic: true },
  };
  const registry = { version: 1, tools: [prior] };
  const plan = preparePromotion(candidate, { registry, baseSha: "c".repeat(40) });
  assert.equal(plan.activate, true);
  assert.equal(plan.evidence.priorActiveDigest, prior.digest);
  assert.equal(plan.rollback.priorManifest.status, "inactive");
  const activationRegistry = buildRegistryPointerMutation({ plan, registry, candidateManifest: manifest }).registry;
  assert.equal(activationRegistry.tools[0].status, "active");
  const rollback = buildRollbackPointerMutation({ plan, registry: activationRegistry, priorManifest: prior });
  assert.equal(rollback.registry.tools[0].status, "inactive");
  assert.equal(rollback.registry.tools[0].digest, prior.digest);

  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleet-promotion-rollback-"));
  const states = [];
  const result = await executeRollbackTransaction({
    plan,
    health: { status: "failed", digest: manifest.digest },
    currentEntry: activationRegistry.tools[0],
    registry: activationRegistry,
    priorManifest: prior,
    stateRoot,
    adapters: {
      verifyIdentity: () => ({ name: "M1Vj", email: "143296579+M1Vj@users.noreply.github.com" }),
      readCurrentMainState: () => ({ baseRef: "main", baseSha: plan.rollback.baseSha, registry: activationRegistry }),
      createBranch: ({ branch }) => ({ branch, forced: false }),
      commit: () => ({ sha: "e".repeat(40), author: "M1Vj" }),
      push: () => ({ forced: false }),
      openDraftPullRequest: () => ({ number: 29, draft: true, merged: false }),
    },
    stateCommit: ({ event }) => { states.push(event.state); return "committed"; },
  });
  assert.equal(result.state, "ROLLBACK_PR_OPENED");
  assert.deepEqual(states, ["ROLLBACK_PLANNED", "ROLLBACK_PR_OPENED"]);
});

test("rollback re-reads an advanced main base and candidate registry pointer before branch creation", async () => {
  const { candidate, registry: fixtureRegistry } = toolCandidate();
  const prior = { ...fixtureRegistry.tools[0] };
  prior.digest = capabilityDigest(prior);
  const registry = { ...fixtureRegistry, tools: [prior] };
  const candidateForPlan = { ...candidate, rollbackDigest: prior.digest, priorActiveDigest: prior.digest };
  const plan = preparePromotion(candidateForPlan, { registry, baseSha: "c".repeat(40) });
  const activationRegistry = buildRegistryPointerMutation({ plan, registry, candidateManifest: candidateForPlan.manifest }).registry;
  const advancedMain = "f".repeat(40);
  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleet-promotion-rollback-advanced-"));
  const calls = [];
  const result = await executeRollbackTransaction({
    plan,
    health: { status: "failed", digest: candidate.digest },
    currentEntry: activationRegistry.tools[0],
    registry: activationRegistry,
    priorManifest: prior,
    stateRoot,
    adapters: {
      verifyIdentity: () => ({ name: "M1Vj", email: "143296579+M1Vj@users.noreply.github.com" }),
      readCurrentMainState: () => {
        calls.push(["read-main"]);
        return { baseSha: advancedMain, registry: activationRegistry };
      },
      createBranch: (request) => {
        calls.push(["branch", request]);
        return { branch: request.branch, forced: false };
      },
      commit: (request) => {
        calls.push(["commit", request]);
        return { sha: "e".repeat(40), author: "M1Vj" };
      },
      push: (request) => {
        calls.push(["push", request]);
        return { forced: false };
      },
      openDraftPullRequest: () => ({ number: 31, draft: true, merged: false }),
    },
  });
  assert.equal(result.state, "ROLLBACK_PR_OPENED");
  assert.equal(calls[0][0], "read-main");
  assert.equal(calls[1][0], "branch");
  assert.equal(calls[1][1].baseSha, advancedMain);
  assert.equal(calls[2][1].baseSha, advancedMain);

  const blockedCalls = [];
  await assert.rejects(() => executeRollbackTransaction({
    plan,
    health: { status: "failed", digest: candidate.digest },
    currentEntry: activationRegistry.tools[0],
    registry: activationRegistry,
    priorManifest: prior,
    stateRoot: mkdtempSync(path.join(tmpdir(), "fleet-promotion-rollback-pointer-mismatch-")),
    adapters: {
      verifyIdentity: () => ({ name: "M1Vj", email: "143296579+M1Vj@users.noreply.github.com" }),
      readCurrentMainState: () => {
        blockedCalls.push("read-main");
        return { baseSha: advancedMain, registry };
      },
      createBranch: () => { blockedCalls.push("branch"); return { branch: plan.rollback.branch, forced: false }; },
    },
  }), /CURRENT_DIGEST_MISMATCH/i);
  assert.deepEqual(blockedCalls, ["read-main"]);
});
