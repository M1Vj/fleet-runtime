import test from "node:test";
import assert from "node:assert/strict";
import {
  CORE_VERSION,
  CORE_LOCK_DIGEST,
  CORE_MANIFEST,
  GOLDEN_VECTORS,
  DEFAULT_MODEL_CHAIN,
  DYNAMIC_MODEL_POOL,
  MODEL_CAPABILITY_SCORES,
  PRIMARY_MODEL,
  evaluateCapability,
  verifyCoreIntegrity,
  isAllowedModel,
  sanitizeModelChain,
  getModelCapabilityScore,
  classifyProviderResponse,
} from "../packages/indefinite-core/index.mjs";
import {
  CORE_POLICY_DIGEST,
} from "../scripts/lib/provider-registry.mjs";
import { sanitizeRequestBody } from "../scripts/lib/request-sanitizer.mjs";

test("indefinite core parity is semver-valid and digest-pinned", () => {
  assert.match(CORE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(CORE_MANIFEST.coreVersion, CORE_VERSION);
  assert.match(CORE_LOCK_DIGEST, /^[a-f0-9]{64}$/);
  assert.equal(verifyCoreIntegrity(), true);
  assert.equal(CORE_POLICY_DIGEST, CORE_LOCK_DIGEST);
  assert.equal(CORE_MANIFEST.capabilities.primaryModel, "opencode/muse-spark-1.3-contributor-free");
  assert.equal(CORE_MANIFEST.capabilities.reasoningEffort, "xhigh");
  assert.equal(CORE_MANIFEST.capabilities.minOutputTokens, 16384);
  assert.equal(CORE_MANIFEST.capabilities.minMaxTokens, 16384);
});

test("indefinite fallback ladder parity enforces benchmark/sentiment chain without Gemini", () => {
  assert.equal(PRIMARY_MODEL, "opencode/muse-spark-1.3-contributor-free");
  assert.equal(DEFAULT_MODEL_CHAIN[0], "opencode/muse-spark-1.3-contributor-free");
  assert.equal(DEFAULT_MODEL_CHAIN[1], "opencode/mimo-v2.6-flash-free");
  assert.equal(DEFAULT_MODEL_CHAIN[2], "opencode/jev-1.13-free");
  assert.equal(DEFAULT_MODEL_CHAIN[3], "opencode/nemotron-3-ultra-free");

  // Verify benchmark capability scores descending
  assert.ok(getModelCapabilityScore("opencode/muse-spark-1.3-contributor-free") > getModelCapabilityScore("opencode/mimo-v2.6-flash-free"));
  assert.ok(getModelCapabilityScore("opencode/mimo-v2.6-flash-free") > getModelCapabilityScore("opencode/jev-1.13-free"));
  assert.ok(getModelCapabilityScore("opencode/jev-1.13-free") > getModelCapabilityScore("opencode/nemotron-3-ultra-free"));

  // Strictly NO Gemini models
  for (const model of [...DEFAULT_MODEL_CHAIN, ...DYNAMIC_MODEL_POOL]) {
    assert.equal(/gemini|google/i.test(model), false, `Model ${model} must not match gemini or google`);
    assert.equal(isAllowedModel(model), true, `Model ${model} must be allowed`);
  }
  for (const forbidden of ["opencode/gemini-3-flash", "google/gemini-2.0-flash", "google/antigravity"]) {
    assert.equal(isAllowedModel(forbidden), false);
  }
});

test("indefinite parity rewrites union-alpha to muse-spark-1.3-contributor-free", () => {
  assert.equal(isAllowedModel("opencode/union-alpha"), false);
  assert.equal(isAllowedModel("union-alpha"), false);

  for (const m of ["union-alpha", "opencode/union-alpha", "union", "alpha"]) {
    const payload = Buffer.from(JSON.stringify({ model: m, input: [] }));
    const sanitized = sanitizeRequestBody(payload, "parity-test");
    const parsed = JSON.parse(sanitized.toString("utf8"));
    assert.equal(parsed.model, "opencode/muse-spark-1.3-contributor-free");
  }
});
