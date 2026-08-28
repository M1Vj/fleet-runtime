import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import {
  assessProviderHealth,
  buildModelUpdateMetadata,
  createAntigravityAdapter,
  createFreeProviderAdapter,
  createModelRollbackRecord,
  loadProviderRegistry,
  providerSecretMappings,
  resolveProviderCredentials,
  resolveProviderQuotaGroup,
  selectProviderRoute,
  validateModelUpdateMetadata,
  validateProviderRegistry,
} from "../scripts/lib/provider-registry.mjs";
import { resolveModelChain } from "../scripts/lib/model.mjs";

const registry = loadProviderRegistry();
const openCodeModels = JSON.parse(readFileSync(new URL("../config/models.json", import.meta.url), "utf8"));
const ciDiagWorkflow = readFileSync(new URL("../.github/workflows/ci-diag.yml", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const deepWorkflow = readFileSync(new URL("../.github/workflows/deep.yml", import.meta.url), "utf8");
const improveWorkflow = readFileSync(new URL("../.github/workflows/improve.yml", import.meta.url), "utf8");

function fixtureProvider(id, overrides = {}) {
  const provider = registry.providers.find((item) => item.id === id);
  assert.ok(provider, `provider fixture ${id}`);
  return structuredClone({ ...provider, ...overrides });
}

function spawnChild({ stdout = "", stderr = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

test("the provider registry carries the requested bucket preferences without enabling them", () => {
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.buckets.gemini[0].provider, "antigravity");
  assert.equal(registry.buckets.gemini[0].model, "gemini-3.7-flash-high");
  assert.equal(registry.buckets.gemini[2].credential, "account-2");
  assert.equal(registry.buckets.other[0].provider, "opencode-zen");
  assert.equal(registry.buckets.other[0].model, "claude-opus-4-6");
  assert.equal(registry.providers.find((item) => item.id === "antigravity").enabled, false);
  assert.equal(registry.providers.find((item) => item.id === "antigravity").production.enabled, false);
  assert.equal(validateProviderRegistry(registry).ok, true);
});

test("the retired 0x Alpha model cannot be selected by config or diagnostics", () => {
  assert.equal(openCodeModels.opencode.models["x-preview-f-free"], undefined);
  assert.doesNotMatch(ciDiagWorkflow, /x-preview-f-free/);
  assert.match(ciDiagWorkflow, /opencode\/claude-opus-4-6/);
  assert.doesNotMatch(readme, /x-preview-f-free|Ox\/Alpha/);
});

test("mixed public-private jobs inject free-provider secrets only after public verification", () => {
  const freeSecrets = /GEMINI_API_KEY_[12]:|OPENROUTER_API_KEY:|NVIDIA_API_KEY:/;
  const deepAnalyze = deepWorkflow.slice(deepWorkflow.indexOf("  analyze:"));
  assert.doesNotMatch(deepAnalyze.slice(0, deepAnalyze.indexOf("    steps:")), freeSecrets);
  assert.match(deepAnalyze, /id:\s*public/);
  assert.match(deepAnalyze, /GEMINI_API_KEY_1:\s*\$\{\{\s*steps\.public\.outputs\.verified\s*==\s*'true'/);
  const improveResearch = improveWorkflow.slice(improveWorkflow.indexOf("  research:"), improveWorkflow.indexOf("  plan:"));
  assert.doesNotMatch(improveResearch.slice(0, improveResearch.indexOf("    steps:")), freeSecrets);
  assert.match(improveResearch, /id:\s*public/);
  assert.match(improveResearch, /OPENROUTER_API_KEY:\s*\$\{\{\s*steps\.public\.outputs\.verified\s*==\s*'true'/);
  const quotaGroups = /GEMINI_API_KEY_[12]_QUOTA_GROUP:/;
  assert.doesNotMatch(deepAnalyze.slice(0, deepAnalyze.indexOf("    steps:")), quotaGroups);
  assert.match(deepAnalyze, quotaGroups);
  assert.match(deepAnalyze, /GEMINI_API_KEY_1_QUOTA_GROUP:\s*\$\{\{\s*steps\.public\.outputs\.verified\s*==\s*'true'\s*&&\s*vars\.GEMINI_API_KEY_1_QUOTA_GROUP\s*\|\|\s*''\s*\}\}/);
  assert.match(deepAnalyze, /GEMINI_API_KEY_2_QUOTA_GROUP:\s*\$\{\{\s*steps\.public\.outputs\.verified\s*==\s*'true'\s*&&\s*vars\.GEMINI_API_KEY_2_QUOTA_GROUP\s*\|\|\s*''\s*\}\}/);
  assert.match(improveResearch, quotaGroups);
  assert.doesNotMatch(improveResearch.slice(0, improveResearch.indexOf("    steps:")), quotaGroups);
  assert.match(improveResearch, /GEMINI_API_KEY_1_QUOTA_GROUP:\s*\$\{\{\s*steps\.public\.outputs\.verified\s*==\s*'true'\s*&&\s*vars\.GEMINI_API_KEY_1_QUOTA_GROUP\s*\|\|\s*''\s*\}\}/);
  assert.match(improveResearch, /GEMINI_API_KEY_2_QUOTA_GROUP:\s*\$\{\{\s*steps\.public\.outputs\.verified\s*==\s*'true'\s*&&\s*vars\.GEMINI_API_KEY_2_QUOTA_GROUP\s*\|\|\s*''\s*\}\}/);
});

test("OAuth is local-only and Gemini API keys are a separate durable backup provider", () => {
  const oauth = registry.providers.find((item) => item.id === "antigravity");
  const geminiApi = registry.providers.find((item) => item.id === "gemini-api");
  assert.ok(oauth);
  assert.equal(oauth.auth?.mode, "oauth");
  assert.equal(oauth.auth?.portability, "local-only");
  assert.equal(oauth.auth?.renewable, false);
  assert.equal(oauth.localOnly, true);
  assert.equal(oauth.production?.enabled, false);
  assert.equal(providerSecretMappings(registry).some((item) => item.provider === "antigravity"), false);

  assert.ok(geminiApi);
  assert.equal(geminiApi.auth?.mode, "api-key");
  assert.equal(geminiApi.auth?.sameProviderRotation, "healthy-round-robin");
  assert.equal(geminiApi.auth?.quotaScope, "credential-group");
  assert.deepEqual(geminiApi.credentials.map((item) => item.id), ["account-1", "account-2"]);
  assert.ok(geminiApi.credentials.every((item) => item.targetEnv === "GEMINI_API_KEY"));
  assert.deepEqual(geminiApi.credentials.map((item) => item.quotaGroupEnv), [
    "GEMINI_API_KEY_1_QUOTA_GROUP",
    "GEMINI_API_KEY_2_QUOTA_GROUP",
  ]);
  assert.equal(geminiApi.models["gemini-3.7-flash"].free, true);
  const zen = registry.providers.find((item) => item.id === "opencode-zen");
  assert.equal(zen.auth?.mode, "api-key");
  assert.equal(zen.auth?.sameProviderRotation, "healthy-round-robin");
  assert.equal(zen.auth?.quotaScope, "account-wide");
});

test("verified free fallbacks expose documented OpenRouter and NVIDIA routes", () => {
  const openrouter = registry.providers.find((item) => item.id === "openrouter");
  const nvidia = registry.providers.find((item) => item.id === "nvidia-nim");
  assert.ok(openrouter);
  assert.equal(openrouter.verification.status, "verified");
  assert.equal(openrouter.models["openrouter/free"].free, true);
  assert.equal(openrouter.models["meta-llama/llama-3.2-3b-instruct:free"].free, true);
  assert.ok(nvidia);
  assert.equal(nvidia.verification.status, "verified");
  assert.equal(nvidia.models["moonshotai/kimi-k3"].free, true);
  assert.equal(nvidia.models["moonshotai/kimi-k3"].availability, "free-endpoint");
  assert.equal(nvidia.models["moonshotai/kimi-k3"].contextTokens, 1_048_576);
  assert.equal(nvidia.models["moonshotai/kimi-k3"].maxOutputTokens, 65_536);
  assert.ok(nvidia.verification.docs.includes("https://build.nvidia.com/moonshotai/kimi-k3/modelcard"));
  assert.ok(nvidia.verification.docs.includes("https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3-infer"));
  assert.equal(nvidia.production?.requiresEnv, "FLEET_NVIDIA_ENABLE");
  assert.deepEqual(
    registry.buckets.other.map((item) => `${item.provider}/${item.model}`),
    [
      "opencode-zen/claude-opus-4-6",
      "opencode-zen/claude-opus-4-6",
      "openrouter/meta-llama/llama-3.2-3b-instruct:free",
      "nvidia-nim/moonshotai/kimi-k3",
    ],
  );
});

test("GitHub secret mapping exposes names only and never credential values", () => {
  const mappings = providerSecretMappings(registry);
  assert.ok(mappings.some((item) => item.githubSecret === "OPENCODE_API_KEY" && item.env === "OPENCODE_API_KEY"));
  assert.ok(mappings.some((item) => item.githubSecret === "GEMINI_API_KEY_1" && item.targetEnv === "GEMINI_API_KEY"));
  assert.ok(mappings.some((item) => item.githubSecret === "GEMINI_API_KEY_2" && item.targetEnv === "GEMINI_API_KEY"));
  assert.deepEqual(Object.keys(mappings[0]).sort(), ["credential", "env", "expiresEnv", "githubSecret", "provider", "required", "targetEnv"].sort());
  assert.equal(JSON.stringify(mappings).includes("pk-fixture"), false);
  const resolved = resolveProviderCredentials(fixtureProvider("opencode-zen"), { OPENCODE_API_KEY: "pk-fixture" });
  assert.deepEqual(resolved, {
    ok: true,
    state: "present",
    credential: "default",
    sourceEnv: "OPENCODE_API_KEY",
    targetEnv: "OPENCODE_API_KEY",
  });
});

test("credential resolution fails closed on missing, ambiguous, or expired account keys", () => {
  const antigravity = fixtureProvider("antigravity");
  assert.equal(resolveProviderCredentials(antigravity, {}).state, "local-only");
  const geminiApi = fixtureProvider("gemini-api");
  const ambiguous = resolveProviderCredentials(antigravity, {
    GEMINI_API_KEY_1: "key-one",
    GEMINI_API_KEY_2: "key-two",
  });
  assert.equal(ambiguous.state, "local-only");
  assert.equal(resolveProviderCredentials(geminiApi, {
    GEMINI_API_KEY_1: "key-one",
    GEMINI_API_KEY_2: "key-two",
  }).state, "ambiguous");
  assert.equal(resolveProviderCredentials(geminiApi, {
    GEMINI_API_KEY_1: "key-one",
    GEMINI_API_KEY_1_EXPIRES_AT: "2020-01-01T00:00:00Z",
  }, { account: "account-1", now: Date.parse("2026-08-27T00:00:00Z") }).state, "expired");
  assert.equal(resolveProviderCredentials(geminiApi, {
    GEMINI_API_KEY_1: "key-one",
  }, { account: "account-1" }).credential, "account-1");
});

test("provider health requires a fresh healthy snapshot and credentials", () => {
  const provider = fixtureProvider("opencode-zen");
  const env = { OPENCODE_API_KEY: "pk-fixture" };
  assert.equal(assessProviderHealth(provider, env).status, "unknown");
  assert.equal(assessProviderHealth(provider, {}, {
    snapshot: { status: "healthy", checkedAt: "2026-08-27T00:00:00Z" },
    now: Date.parse("2026-08-27T00:10:00Z"),
  }).status, "missing-credentials");
  assert.equal(assessProviderHealth(provider, env, {
    snapshot: { status: "healthy", checkedAt: "2026-08-27T00:00:00Z" },
    now: Date.parse("2026-08-27T00:10:00Z"),
  }).status, "healthy");
  assert.equal(assessProviderHealth(provider, env, {
    snapshot: { status: "healthy", checkedAt: "2026-08-27T00:00:00Z" },
    now: Date.parse("2026-08-27T01:00:00Z"),
  }).status, "stale");
  assert.equal(assessProviderHealth(provider, env, {
    snapshot: { status: "unavailable", checkedAt: "2026-08-27T00:00:00Z" },
    now: Date.parse("2026-08-27T00:10:00Z"),
  }).status, "unavailable");
});

test("route selection skips disabled, local-only, paid, unverified, and unhealthy candidates", () => {
  const env = {
    OPENCODE_API_KEY: "pk-fixture",
  };
  const healthy = { "opencode-zen": { status: "healthy", checkedAt: "2026-08-27T00:00:00Z" } };
  const free = selectProviderRoute({ registry, bucket: "other", env, health: healthy, now: Date.parse("2026-08-27T00:10:00Z") });
  assert.equal(free.ok, false);
  assert.equal(free.reason, "NO_HEALTHY_FREE_PROVIDER");
  const paid = selectProviderRoute({
    registry,
    bucket: "other",
    env,
    health: healthy,
    freeOnly: false,
    allowPaid: true,
    now: Date.parse("2026-08-27T00:10:00Z"),
  });
  assert.equal(paid.ok, true);
  assert.equal(paid.provider, "opencode-zen");
  assert.equal(paid.model, "claude-opus-4-6");
  const gemini = selectProviderRoute({
    registry,
    bucket: "gemini",
    env: {},
    health: { antigravity: { status: "healthy", checkedAt: "2026-08-27T00:00:00Z" } },
    allowLocal: true,
    now: Date.parse("2026-08-27T00:10:00Z"),
  });
  assert.equal(gemini.ok, false);
  assert.equal(gemini.reason, "NO_HEALTHY_FREE_PROVIDER");
});

test("route selection reaches a verified free provider only with a fresh health snapshot", () => {
  const now = Date.parse("2026-08-27T00:10:00Z");
  const route = selectProviderRoute({
    registry,
    bucket: "other",
    env: { OPENROUTER_API_KEY: "or-fixture" },
    health: { openrouter: { status: "healthy", checkedAt: "2026-08-27T00:00:00Z" } },
    dataClass: "public",
    publicTarget: { private: false, visibility: "public" },
    now,
  });
  assert.equal(route.ok, true);
  assert.equal(route.provider, "openrouter");
  assert.equal(route.model, "meta-llama/llama-3.2-3b-instruct:free");
  assert.equal(route.targetEnv, "OPENROUTER_API_KEY");

  const stale = selectProviderRoute({
    registry,
    bucket: "other",
    env: { OPENROUTER_API_KEY: "or-fixture" },
    health: { openrouter: { status: "healthy", checkedAt: "2026-08-26T00:00:00Z" } },
    dataClass: "public",
    publicTarget: { private: false, visibility: "public" },
    now,
  });
  assert.equal(stale.ok, false);
  assert.match(stale.skipped.join(","), /openrouter:stale/);
});

test("private and missing-public-target requests skip every public-only fallback", () => {
  const args = {
    registry,
    bucket: "other",
    env: { OPENROUTER_API_KEY: "or-fixture" },
    health: { openrouter: { status: "healthy", checkedAt: "2026-08-27T00:00:00Z" } },
    now: Date.parse("2026-08-27T00:10:00Z"),
  };
  const privateTarget = selectProviderRoute({ ...args, dataClass: "private", publicTarget: { private: true, visibility: "private" } });
  assert.equal(privateTarget.ok, false);
  assert.match(privateTarget.skipped.join(","), /openrouter:public-target-required/);
  const missingTarget = selectProviderRoute({ ...args, dataClass: "public" });
  assert.equal(missingTarget.ok, false);
  assert.match(missingTarget.skipped.join(","), /openrouter:public-target-required/);
});

test("same-provider Gemini keys do not rotate on a provider-wide rate limit", () => {
  const geminiOnly = structuredClone(registry);
  geminiOnly.buckets.gemini = [
    { provider: "gemini-api", model: "gemini-3.7-flash", credential: "account-1", priority: 1, free: true, publicOnly: true },
    { provider: "gemini-api", model: "gemini-3.7-flash", credential: "account-2", priority: 2, free: true, publicOnly: true },
  ];
  const route = selectProviderRoute({
    registry: geminiOnly,
    bucket: "gemini",
    env: { GEMINI_API_KEY_1: "key-one", GEMINI_API_KEY_2: "key-two" },
    health: { "gemini-api": { status: "rate-limited", checkedAt: "2026-08-27T00:00:00Z" } },
    dataClass: "public",
    publicTarget: { private: false, visibility: "public" },
    now: Date.parse("2026-08-27T00:10:00Z"),
  });
  assert.equal(route.ok, false);
  assert.match(route.skipped.join(","), /gemini-api:rate-limited/);
});

test("same-provider Gemini keys do not rotate on an account-level rate limit", () => {
  const route = selectProviderRoute({
    registry,
    bucket: "gemini",
    model: "gemini-api/gemini-3.7-flash",
    env: { GEMINI_API_KEY_1: "key-one", GEMINI_API_KEY_2: "key-two" },
    health: {
      "gemini-api": {
        status: "healthy",
        checkedAt: "2026-08-27T00:00:00Z",
        credentials: {
          "account-1": { status: "rate-limited", checkedAt: "2026-08-27T00:00:00Z" },
        },
      },
    },
    dataClass: "public",
    publicTarget: { private: false, visibility: "public" },
    now: Date.parse("2026-08-27T00:10:00Z"),
    allowLiveCanary: true,
  });
  assert.equal(route.ok, false);
  assert.match(route.skipped.join(","), /gemini-api:rate-limited/);
});

test("healthy configured accounts rotate deterministically across run seeds", () => {
  const env = {
    GEMINI_API_KEY_1: "key-one",
    GEMINI_API_KEY_2: "key-two",
    GEMINI_API_KEY_1_QUOTA_GROUP: "project-one",
    GEMINI_API_KEY_2_QUOTA_GROUP: "project-two",
  };
  const args = {
    registry,
    bucket: "gemini",
    model: "gemini-api/gemini-3.7-flash",
    env,
    health: { "gemini-api": { status: "healthy", checkedAt: "2026-08-27T00:00:00Z" } },
    dataClass: "public",
    publicTarget: { private: false, visibility: "public" },
    now: Date.parse("2026-08-27T00:10:00Z"),
  };
  const selected = new Set();
  for (let index = 0; index < 32; index += 1) {
    const route = selectProviderRoute({ ...args, rotationSeed: `run-${index}` });
    assert.equal(route.ok, true);
    selected.add(route.credential);
    const repeated = selectProviderRoute({ ...args, rotationSeed: `run-${index}` });
    assert.equal(repeated.credential, route.credential);
  }
  assert.deepEqual([...selected].sort(), ["account-1", "account-2"]);
  const fromRunId = selectProviderRoute({ ...args, env: { ...env, GITHUB_RUN_ID: "1" } });
  assert.equal(fromRunId.credential, "account-2");
});

test("a rate-limited quota group can fail over only to a separately declared project", () => {
  const env = {
    GEMINI_API_KEY_1: "key-one",
    GEMINI_API_KEY_2: "key-two",
    GEMINI_API_KEY_1_QUOTA_GROUP: "project-one",
    GEMINI_API_KEY_2_QUOTA_GROUP: "project-two",
  };
  const route = selectProviderRoute({
    registry,
    bucket: "gemini",
    model: "gemini-api/gemini-3.7-flash",
    env,
    health: {
      "gemini-api": {
        status: "healthy",
        checkedAt: "2026-08-27T00:00:00Z",
        quotaGroups: {
          "project-one": { status: "rate-limited", checkedAt: "2026-08-27T00:00:00Z" },
        },
      },
    },
    dataClass: "public",
    publicTarget: { private: false, visibility: "public" },
    now: Date.parse("2026-08-27T00:10:00Z"),
    allowLiveCanary: true,
    rotationSeed: "stable-run",
  });
  assert.equal(route.ok, true);
  assert.equal(route.credential, "account-2");
  assert.equal(route.quotaGroup, "project-two");
});

test("missing quota-group declarations keep rate limits provider-wide", () => {
  const route = selectProviderRoute({
    registry,
    bucket: "gemini",
    model: "gemini-api/gemini-3.7-flash",
    env: { GEMINI_API_KEY_1: "key-one", GEMINI_API_KEY_2: "key-two" },
    health: {
      "gemini-api": {
        status: "healthy",
        checkedAt: "2026-08-27T00:00:00Z",
        credentials: {
          "account-1": { status: "rate-limited", checkedAt: "2026-08-27T00:00:00Z" },
        },
      },
    },
    dataClass: "public",
    publicTarget: { private: false, visibility: "public" },
    now: Date.parse("2026-08-27T00:10:00Z"),
    allowLiveCanary: true,
    rotationSeed: "stable-run",
  });
  assert.equal(route.ok, false);
  assert.match(route.skipped.join(","), /gemini-api:rate-limited/);
});

test("duplicate quota-group values fail closed instead of rotating a shared project", () => {
  const route = selectProviderRoute({
    registry,
    bucket: "gemini",
    model: "gemini-api/gemini-3.7-flash",
    env: {
      GEMINI_API_KEY_1: "key-one",
      GEMINI_API_KEY_2: "key-two",
      GEMINI_API_KEY_1_QUOTA_GROUP: "same-project",
      GEMINI_API_KEY_2_QUOTA_GROUP: "same-project",
    },
    health: {
      "gemini-api": {
        status: "healthy",
        checkedAt: "2026-08-27T00:00:00Z",
        credentials: {
          "account-1": { status: "rate-limited", checkedAt: "2026-08-27T00:00:00Z" },
        },
      },
    },
    dataClass: "public",
    publicTarget: { private: false, visibility: "public" },
    now: Date.parse("2026-08-27T00:10:00Z"),
    allowLiveCanary: true,
    rotationSeed: "stable-run",
  });
  assert.equal(route.ok, false);
  assert.match(route.skipped.join(","), /gemini-api:rate-limited/);
});

test("auth rejection skips one named credential and keeps the other eligible", () => {
  const route = selectProviderRoute({
    registry,
    bucket: "gemini",
    model: "gemini-api/gemini-3.7-flash",
    env: {
      GEMINI_API_KEY_1: "key-one",
      GEMINI_API_KEY_2: "key-two",
      GEMINI_API_KEY_1_QUOTA_GROUP: "project-one",
      GEMINI_API_KEY_2_QUOTA_GROUP: "project-two",
    },
    health: {
      "gemini-api": {
        status: "healthy",
        checkedAt: "2026-08-27T00:00:00Z",
        credentials: {
          "account-1": { status: "rejected", checkedAt: "2026-08-27T00:00:00Z" },
        },
      },
    },
    dataClass: "public",
    publicTarget: { private: false, visibility: "public" },
    now: Date.parse("2026-08-27T00:10:00Z"),
    rotationSeed: "stable-run",
  });
  assert.equal(route.ok, true);
  assert.equal(route.credential, "account-2");
});

test("quota groups accept Google project ids or numbers and reject opaque labels", () => {
  const provider = registry.providers.find((item) => item.id === "gemini-api");
  const credential = provider.credentials[0];
  for (const value of ["project-one", "123456789012"]) {
    assert.equal(resolveProviderQuotaGroup(provider, credential, { GEMINI_API_KEY_1_QUOTA_GROUP: value }).ok, true, value);
  }
  for (const value of ["a", "UPPERCASE", "project.one", "project_one", "project:one", "-project", "project-"]) {
    assert.equal(resolveProviderQuotaGroup(provider, credential, { GEMINI_API_KEY_1_QUOTA_GROUP: value }).ok, false, value);
  }
});

test("untrusted health status never reaches route diagnostics", () => {
  const secretStatus = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const route = selectProviderRoute({
    registry,
    bucket: "gemini",
    model: "gemini-api/gemini-3.7-flash",
    env: { GEMINI_API_KEY_1: "key-one", GEMINI_API_KEY_1_QUOTA_GROUP: "project-one" },
    health: { "gemini-api": { status: secretStatus, checkedAt: "2026-08-27T00:00:00Z" } },
    dataClass: "public",
    publicTarget: { private: false, visibility: "public" },
    now: Date.parse("2026-08-27T00:10:00Z"),
  });
  assert.equal(JSON.stringify(route).includes(secretStatus), false);
});

test("healthy Zen credentials rotate deterministically while retaining account-wide quota scope", () => {
  const args = {
    registry,
    bucket: "other",
    model: "opencode/claude-opus-4-6",
    env: { OPENCODE_API_KEY: "key-one", OPENCODE_API_KEY_2: "key-two" },
    health: { "opencode-zen": { status: "healthy", checkedAt: "2026-08-27T00:00:00Z" } },
    now: Date.parse("2026-08-27T00:10:00Z"),
    freeOnly: false,
    allowPaid: true,
  };
  assert.equal(selectProviderRoute({ ...args, rotationSeed: "0" }).credential, "default");
  assert.equal(selectProviderRoute({ ...args, rotationSeed: "1" }).credential, "backup");
  assert.equal(selectProviderRoute({ ...args, rotationSeed: "1" }).credential, "backup");
  assert.equal(selectProviderRoute({ ...args, env: { ...args.env, GITHUB_RUN_ID: "1" } }).credential, "backup");
});

test("model selection is registry-backed and Gemini override is exact", () => {
  assert.deepEqual(resolveModelChain({}), [
    "opencode/claude-opus-4-6",
    "openrouter/meta-llama/llama-3.2-3b-instruct:free",
    "nvidia-nim/moonshotai/kimi-k3",
  ]);
  assert.deepEqual(resolveModelChain({ FLEET_GEMINI_MODEL: "gemini-3.7-flash-high" }), ["antigravity/gemini-3.7-flash-high"]);
  assert.deepEqual(resolveModelChain({ FLEET_GEMINI_MODEL: "gemini-3.7-flash" }), ["gemini-api/gemini-3.7-flash"]);
  assert.throws(() => resolveModelChain({ FLEET_GEMINI_MODEL: "gemini-unknown" }), /MODEL_GEMINI_MODEL_UNVERIFIED/);
  assert.deepEqual(resolveModelChain({}, { dataClass: "public", publicTarget: { private: false, visibility: "public" } }), [
    "antigravity/gemini-3.7-flash-high",
    "gemini-api/gemini-3.7-flash",
    "openrouter/meta-llama/llama-3.2-3b-instruct:free",
    "nvidia-nim/moonshotai/kimi-k3",
    "opencode/claude-opus-4-6",
  ]);
});

test("Antigravity adapter is explicit, isolated, and uses documented headless flags", async () => {
  const provider = fixtureProvider("antigravity", {
    enabled: true,
    localOnly: false,
    auth: { mode: "api-key" },
    credentials: [
      {
        id: "account-1",
        githubSecret: "GEMINI_API_KEY_1",
        env: "GEMINI_API_KEY_1",
        targetEnv: "GEMINI_API_KEY",
        required: false,
      },
    ],
    verification: { status: "documented-local-api-key", docs: ["https://antigravity.google/docs/cli/install/"] },
    production: { enabled: true, requiresEnv: "FLEET_ANTIGRAVITY_ENABLE" },
  });
  const captured = [];
  const result = await createAntigravityAdapter({
    provider,
    env: {
      FLEET_ANTIGRAVITY_ENABLE: "1",
      GEMINI_API_KEY_1: "key-one",
      OPENCODE_API_KEY: "must-not-forward",
      FLEET_GH_TOKEN: "must-not-forward",
    },
    allowProduction: true,
    spawnImpl: (_command, args, options) => {
      captured.push({ args, options });
      return spawnChild({ stdout: JSON.stringify({ status: "SUCCESS", response: "ok" }) + "\n" });
    },
  }).invoke({ prompt: "hello", model: "gemini-3.7-flash-high", account: "account-1", dataClass: "public", publicTarget: { private: false, visibility: "public" } });
  assert.equal(result.ok, true);
  assert.equal(result.response, "ok");
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].args, ["-p", "hello", "--model", "gemini-3.7-flash-high", "--output-format", "json"]);
  assert.equal(captured[0].options.shell, false);
  assert.equal(captured[0].options.env.GEMINI_API_KEY, "key-one");
  assert.equal(captured[0].options.env.OPENCODE_API_KEY, undefined);
  assert.equal(captured[0].options.env.FLEET_GH_TOKEN, undefined);
  assert.match(captured[0].options.env.HOME, /fleet-agy-/);
});

test("Antigravity adapter refuses local OAuth without its explicit local policy", async () => {
  const provider = fixtureProvider("antigravity", { enabled: true });
  const adapter = createAntigravityAdapter({
    provider,
    env: {},
    spawnImpl: () => { throw new Error("must not spawn"); },
  });
  await assert.rejects(() => adapter.invoke({ prompt: "hello", model: "gemini-3.7-flash-high", account: "local-oauth", dataClass: "public", publicTarget: { private: false, visibility: "public" } }), /ANTIGRAVITY_OAUTH_LOCAL_ONLY/);
});

test("Antigravity local OAuth is gated, keeps the existing HOME cache, and forwards no API key", async () => {
  const provider = fixtureProvider("antigravity");
  const captured = [];
  const adapter = createAntigravityAdapter({
    provider,
    env: { HOME: "/tmp/fleet-home-fixture", FLEET_ANTIGRAVITY_LOCAL: "1" },
    allowLocal: true,
    spawnImpl: (_command, args, options) => {
      captured.push({ args, options });
      return spawnChild({ stdout: JSON.stringify({ status: "SUCCESS", response: "ok" }) + "\n" });
    },
  });
  await assert.rejects(
    () => adapter.invoke({ prompt: "public", model: "gemini-3.7-flash-high", account: "unknown-account", dataClass: "public", publicTarget: { private: false, visibility: "public" } }),
    /ANTIGRAVITY_CREDENTIAL_UNKNOWN/,
  );
  await assert.rejects(
    () => adapter.invoke({ prompt: "private", model: "gemini-3.7-flash-high", account: "local-oauth" }),
    /ANTIGRAVITY_PUBLIC_TARGET_REQUIRED/,
  );
  const result = await adapter.invoke({ prompt: "hello", model: "gemini-3.7-flash-high", account: "local-oauth", dataClass: "public", publicTarget: { private: false, visibility: "public" } });
  assert.equal(result.ok, true);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].args, ["-p", "hello", "--model", "gemini-3.7-flash-high", "--output-format", "json", "--sandbox"]);
  assert.equal(captured[0].options.env.HOME, "/tmp/fleet-home-fixture");
  assert.equal(captured[0].options.env.GEMINI_API_KEY, undefined);
  assert.equal(captured[0].options.env.OPENCODE_API_KEY, undefined);
  assert.notEqual(captured[0].options.cwd, "/tmp/fleet-home-fixture");
  await assert.rejects(
    () => createAntigravityAdapter({ provider, env: { HOME: "/tmp/fleet-home-fixture" }, allowLocal: true, spawnImpl: () => { throw new Error("must not spawn"); } }).invoke({ prompt: "hello", model: "gemini-3.7-flash-high", account: "local-oauth", dataClass: "public", publicTarget: { private: false, visibility: "public" } }),
    /ANTIGRAVITY_OAUTH_LOCAL_ONLY/,
  );
});

test("unverified free-provider adapter refuses network access until endpoint metadata is verified", async () => {
  const provider = fixtureProvider("openrouter", { verification: { status: "unverified", docs: [] } });
  let fetches = 0;
  const adapter = createFreeProviderAdapter({ provider, env: {}, fetchImpl: async () => { fetches += 1; } });
  await assert.rejects(() => adapter.invoke({ prompt: "hello", model: "configured" }), /FREE_PROVIDER_UNVERIFIED/);
  assert.equal(fetches, 0);
});

test("free-provider adapters fail closed for private targets and require OpenRouter privacy controls", async () => {
  const provider = fixtureProvider("openrouter");
  let fetches = 0;
  const adapter = createFreeProviderAdapter({
    provider,
    env: { OPENROUTER_API_KEY: "or-fixture" },
    fetchImpl: async (_url, options) => {
      fetches += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.provider.zdr, true);
      assert.equal(body.provider.data_collection, "deny");
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
    },
  });
  await assert.rejects(
    () => adapter.invoke({ prompt: "private", model: "openrouter/free", dataClass: "private" }),
    /FREE_PROVIDER_PUBLIC_TARGET_REQUIRED/,
  );
  assert.equal(fetches, 0);
  const result = await adapter.invoke({
    prompt: "public",
    model: "openrouter/free",
    dataClass: "public",
    publicTarget: { private: false, visibility: "public" },
  });
  assert.equal(result.response, "ok");
  assert.equal(fetches, 1);
});

test("Gemini API adapter uses the documented model id and high reasoning level", async () => {
  const provider = fixtureProvider("gemini-api");
  let request;
  const result = await createFreeProviderAdapter({
    provider,
    env: { GEMINI_API_KEY_1: "key-one" },
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
    },
  }).invoke({
    prompt: "public",
    model: "gemini-3.7-flash",
    account: "account-1",
    dataClass: "public",
    publicTarget: { private: false, visibility: "public" },
  });
  assert.equal(result.response, "ok");
  assert.equal(request.model, "gemini-3.7-flash");
  assert.equal(request.reasoning_effort, "high");
});

test("NVIDIA Kimi K3 uses the documented free chat endpoint and exact model id", async () => {
  const provider = fixtureProvider("nvidia-nim");
  let request;
  let endpoint;
  const result = await createFreeProviderAdapter({
    provider,
    env: { NVIDIA_API_KEY: "nv-fixture", FLEET_NVIDIA_ENABLE: "true" },
    fetchImpl: async (url, options) => {
      endpoint = url;
      request = JSON.parse(options.body);
      assert.equal(options.headers.authorization, "Bearer nv-fixture");
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
    },
  }).invoke({
    prompt: "public",
    model: "moonshotai/kimi-k3",
    account: "default",
    dataClass: "public",
    publicTarget: { private: false, visibility: "public" },
  });
  assert.equal(result.response, "ok");
  assert.equal(endpoint, "https://integrate.api.nvidia.com/v1/chat/completions");
  assert.equal(request.model, "moonshotai/kimi-k3");
  assert.equal(request.stream, false);
  assert.equal(request.reasoning_effort, undefined, "NVIDIA defaults Kimi K3 reasoning effort to max");
});

test("model update metadata is digest-bound and rollback records are bounded and secretless", () => {
  const metadata = buildModelUpdateMetadata({ registry, now: "2026-08-27T00:00:00Z", previousDigest: null });
  assert.match(metadata.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(validateModelUpdateMetadata(metadata).ok, true);
  assert.equal(validateModelUpdateMetadata({ ...metadata, digest: "not-a-digest" }).ok, false);
  const rollback = createModelRollbackRecord({
    activeDigest: metadata.digest,
    targetDigest: "sha256:" + "a".repeat(64),
    registryVersion: registry.registryVersion,
    reason: "health check failed",
    now: "2026-08-27T00:01:00Z",
  });
  assert.deepEqual(rollback, {
    event: "MODEL_ROLLBACK_REQUESTED",
    registryVersion: registry.registryVersion,
    activeDigest: metadata.digest,
    targetDigest: "sha256:" + "a".repeat(64),
    reason: "health check failed",
    occurredAt: "2026-08-27T00:01:00.000Z",
  });
  assert.equal(JSON.stringify(rollback).includes("pk-fixture"), false);
});

test("registry config is committed JSON and does not contain credential values", () => {
  const text = readFileSync(new URL("../config/providers.json", import.meta.url), "utf8");
  assert.doesNotMatch(text, /pk-fixture|ghp_[A-Za-z0-9]+|AIza[A-Za-z0-9_-]{20,}/);
});
