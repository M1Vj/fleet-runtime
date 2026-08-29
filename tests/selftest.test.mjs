import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SELFTEST_PUBLIC_CANARY_PROMPT,
  SELFTEST_PUBLIC_REPO,
  findVisionRoute,
  isPublicCanarySuccess,
  parseVisionCanaryReply,
  resolveVerifiedPublicTarget,
  runModelLiveness,
  runVisionCanary,
  visionCapabilityRequired,
} from "../scripts/selftest.mjs";

const publicMeta = {
  full_name: SELFTEST_PUBLIC_REPO,
  private: false,
  visibility: "public",
};

test("selftest verifies the fixed public repository before building a target", async () => {
  const calls = [];
  const target = await resolveVerifiedPublicTarget({
    env: { GITHUB_REPOSITORY: SELFTEST_PUBLIC_REPO, FLEET_GH_TOKEN: "token-fixture" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ ...publicMeta, default_branch: "main", owner: { login: "M1Vj" } }) };
    },
  });
  assert.deepEqual(target, publicMeta);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.github.com/repos/${SELFTEST_PUBLIC_REPO}`);
  assert.equal(calls[0].options.headers.Authorization, "Bearer token-fixture");
});

test("T5 sends only a harmless public canary with an explicitly verified target", async () => {
  let captured;
  const result = await runModelLiveness({
    env: { FLEET_STATE_ROOT: "/tmp/private-state-fixture" },
    publicTarget: publicMeta,
    ask: async (options) => {
      captured = options;
      return { complete: true, reply: "PUBLIC_CANARY_OK", sessionId: "direct-route" };
    },
  });
  assert.equal(result.complete, true);
  assert.equal(captured.prompt, SELFTEST_PUBLIC_CANARY_PROMPT);
  assert.equal(captured.dataClass, "public");
  assert.deepEqual(captured.publicTarget, publicMeta);
  assert.equal(captured.profile, "public-read");
  assert.equal(captured.prompt.includes("secret"), false);
});

test("T5 rejects surrounding text instead of treating a partial canary match as success", () => {
  assert.equal(isPublicCanarySuccess({ complete: true, reply: "PUBLIC_CANARY_OK" }), true);
  assert.equal(isPublicCanarySuccess({ complete: true, reply: "prefix PUBLIC_CANARY_OK suffix" }), false);
  assert.equal(isPublicCanarySuccess({ complete: true, reply: " PUBLIC_CANARY_OK \n" }), true);
});

test("T5 refuses a target that is not verified public instead of opening a private model call", async () => {
  let calls = 0;
  await assert.rejects(
    () => runModelLiveness({
      publicTarget: { full_name: SELFTEST_PUBLIC_REPO, private: true, visibility: "private" },
      ask: async () => { calls += 1; return { complete: true }; },
    }),
    /MODEL_PUBLIC_TARGET_REQUIRED/,
  );
  assert.equal(calls, 0);
});

test("T10 reports capability-unavailable when no configured public route declares image input", async () => {
  let calls = 0;
  const registry = {
    schemaVersion: 1,
    registryVersion: "test-1",
    providers: [{
      id: "text-only",
      kind: "free-api",
      enabled: true,
      free: true,
      localOnly: false,
      production: { enabled: true },
      verification: { status: "verified", docs: [] },
      credentials: [{ id: "default", githubSecret: "TEXT_KEY", env: "TEXT_KEY", targetEnv: "TEXT_KEY" }],
      models: { "text-model": { free: true, modalities: ["text"] } },
      endpoint: "https://example.com/v1/chat/completions",
    }],
    buckets: { public: [{ provider: "text-only", model: "text-model", credential: "default", priority: 1, free: true, publicOnly: true }] },
  };
  const result = await runVisionCanary({
    registry,
    env: { TEXT_KEY: "fixture" },
    publicTarget: publicMeta,
    files: ["/tmp/fixture.png"],
    ask: async () => { calls += 1; return { complete: true, reply: "false positive" }; },
  });
  assert.equal(result.complete, false);
  assert.equal(result.capabilityAvailable, false);
  assert.equal(result.required, false);
  assert.equal(result.status, "degraded");
  assert.equal(result.reason, "VISION_CAPABILITY_UNAVAILABLE");
  assert.equal(calls, 0);
});

test("T10 capability absence fails only when the owner explicitly requires vision", async () => {
  assert.equal(visionCapabilityRequired({}), false);
  assert.equal(visionCapabilityRequired({ FLEET_REQUIRE_VISION: "true" }), true);
  const registry = {
    schemaVersion: 1,
    registryVersion: "test-1",
    providers: [{
      id: "text-only",
      kind: "free-api",
      enabled: true,
      free: true,
      localOnly: false,
      production: { enabled: true },
      verification: { status: "verified", docs: [] },
      credentials: [{ id: "default", githubSecret: "TEXT_KEY", env: "TEXT_KEY", targetEnv: "TEXT_KEY" }],
      models: { "text-model": { free: true, modalities: ["text"] } },
      endpoint: "https://example.com/v1/chat/completions",
    }],
    buckets: { public: [{ provider: "text-only", model: "text-model", credential: "default", priority: 1, free: true, publicOnly: true }] },
  };
  const result = await runVisionCanary({
    registry,
    env: { TEXT_KEY: "fixture", FLEET_REQUIRE_VISION: "true" },
    publicTarget: publicMeta,
    ask: async () => { throw new Error("must not invoke unavailable route"); },
  });
  assert.equal(result.complete, false);
  assert.equal(result.capabilityAvailable, false);
  assert.equal(result.required, true);
  assert.equal(result.status, "failed");
});

test("T10 pins a configured vision route and forwards public gates and attachments", async () => {
  let captured;
  const registry = {
    schemaVersion: 1,
    registryVersion: "test-1",
    providers: [{
      id: "vision-free",
      kind: "free-api",
      enabled: true,
      free: true,
      localOnly: false,
      production: { enabled: true },
      verification: { status: "verified", docs: [] },
      credentials: [{ id: "default", githubSecret: "VISION_KEY", env: "VISION_KEY", targetEnv: "VISION_KEY" }],
      models: { "vision-model": { free: true, modalities: ["text", "image"] } },
      endpoint: "https://example.com/v1/chat/completions",
    }],
    buckets: { public: [{ provider: "vision-free", model: "vision-model", credential: "default", priority: 1, free: true, publicOnly: true }] },
  };
  const result = await runVisionCanary({
    registry,
    env: { VISION_KEY: "fixture" },
    publicTarget: publicMeta,
    files: ["/tmp/fixture.png"],
    ask: async (options) => {
      captured = options;
      return { complete: true, reply: '{"same":false,"colors":["red","blue"]}' };
    },
  });
  assert.equal(result.complete, true);
  assert.equal(result.capabilityAvailable, true);
  assert.equal(result.status, "passed");
  assert.equal(result.route.modelReference, "vision-free/vision-model");
  assert.equal(captured.modelOverride, "vision-free/vision-model");
  assert.equal(captured.dataClass, "public");
  assert.deepEqual(captured.publicTarget, publicMeta);
  assert.deepEqual(captured.files, ["/tmp/fixture.png"]);
});

test("T10 rejects malformed vision output even when the model reports completion", async () => {
  const registry = {
    schemaVersion: 1,
    registryVersion: "test-1",
    providers: [{
      id: "vision-free",
      kind: "free-api",
      enabled: true,
      free: true,
      localOnly: false,
      production: { enabled: true },
      verification: { status: "verified", docs: [] },
      credentials: [{ id: "default", githubSecret: "VISION_KEY", env: "VISION_KEY", targetEnv: "VISION_KEY" }],
      models: { "vision-model": { free: true, modalities: ["text", "image"] } },
      endpoint: "https://example.com/v1/chat/completions",
    }],
    buckets: { public: [{ provider: "vision-free", model: "vision-model", credential: "default", priority: 1, free: true, publicOnly: true }] },
  };
  for (const reply of [
    '{"same":true,"colors":["red","blue"]}',
    '{"same":false,"colors":["red"]}',
    '{"same":false,"colors":["red",""]}',
    '{"same":false,"colors":["red",2]}',
    '{"same":false,"colors":["red","blue"],"extra":true}',
    'prefix {"same":false,"colors":["red","blue"]}',
  ]) {
    const result = await runVisionCanary({
      registry,
      env: { VISION_KEY: "fixture" },
      publicTarget: publicMeta,
      files: ["/tmp/fixture.png"],
      ask: async () => ({ complete: true, reply }),
    });
    assert.equal(parseVisionCanaryReply(reply), null, `malformed reply accepted: ${reply}`);
    assert.equal(result.complete, false, `malformed reply passed: ${reply}`);
    assert.equal(result.status, "failed", `malformed reply status: ${reply}`);
  }
});

test("T10 records configured vision-route transport failure and never passes", async () => {
  const registry = {
    schemaVersion: 1,
    registryVersion: "test-1",
    providers: [{
      id: "vision-free",
      kind: "free-api",
      enabled: true,
      free: true,
      localOnly: false,
      production: { enabled: true },
      verification: { status: "verified", docs: [] },
      credentials: [{ id: "default", githubSecret: "VISION_KEY", env: "VISION_KEY", targetEnv: "VISION_KEY" }],
      models: { "vision-model": { free: true, modalities: ["text", "image"] } },
      endpoint: "https://example.com/v1/chat/completions",
    }],
    buckets: { public: [{ provider: "vision-free", model: "vision-model", credential: "default", priority: 1, free: true, publicOnly: true }] },
  };
  const result = await runVisionCanary({
    registry,
    env: { VISION_KEY: "fixture" },
    publicTarget: publicMeta,
    files: ["/tmp/fixture.png"],
    ask: async () => ({ complete: false, reply: "provider unavailable" }),
  });
  assert.equal(result.capabilityAvailable, true);
  assert.equal(result.complete, false);
  assert.equal(result.status, "failed");
  assert.equal(result.route.modelReference, "vision-free/vision-model");
});
