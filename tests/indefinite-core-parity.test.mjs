import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CORE_VERSION,
  CORE_LOCK_DIGEST,
  CORE_MANIFEST,
  GOLDEN_VECTORS,
  evaluateCapability,
  classifyProviderResponse,
  classifyQuotaAvailability,
  parseRetryAfter,
  verifyCoreIntegrity,
  isAllowedModel,
  sanitizeModelChain,
  applyRequestCapabilities,
} from "../packages/indefinite-core/index.mjs";
import {
  CORE_POLICY_DIGEST,
} from "../scripts/lib/provider-registry.mjs";

test("indefinite core declares a semver manifest and pinned digest", () => {
  assert.match(CORE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(CORE_MANIFEST.coreVersion, CORE_VERSION);
  assert.match(CORE_LOCK_DIGEST, /^[a-f0-9]{64}$/);
  assert.equal(verifyCoreIntegrity(), true);
  assert.equal(CORE_MANIFEST.capabilities.minOutputTokens, 16384);
  assert.equal(CORE_MANIFEST.capabilities.minMaxTokens, 16384);
  assert.equal(CORE_MANIFEST.capabilities.paidFallbackModel, null);
});

test("fleet model adapter is parity-pinned to the core policy", () => {
  assert.equal(CORE_POLICY_DIGEST, CORE_LOCK_DIGEST);
  assert.equal(isAllowedModel(GOLDEN_VECTORS.models.primary), true);
  assert.equal(isAllowedModel(GOLDEN_VECTORS.models.forbidden), false);
  assert.deepEqual(
    sanitizeModelChain(GOLDEN_VECTORS.models.chainInput),
    GOLDEN_VECTORS.models.chainOutput,
  );
  assert.equal(isAllowedModel("opencode/muse-spark-1.3"), false);
  assert.equal(isAllowedModel("opencode/muse-spark-1.3", { allowPaid: true, authorizedPaidOptIn: true }), true);
  assert.deepEqual(sanitizeModelChain(["opencode/muse-spark-1.3", "opencode/muse-spark-1.3-contributor-free"]), ["opencode/muse-spark-1.3-contributor-free"]);
});

test("golden retry and capability vectors preserve provider behavior", () => {
  const retry = GOLDEN_VECTORS.retry;
  assert.equal(parseRetryAfter(retry.deltaHeader, retry.now), retry.deltaAt);
  assert.equal(
    classifyProviderResponse(
      retry.status,
      retry.headers,
      Buffer.from(retry.body),
      retry.now,
    ).kind,
    retry.classification,
  );
  for (const [name, vector] of Object.entries(GOLDEN_VECTORS.capabilities)) {
    assert.deepEqual(evaluateCapability(vector.name, vector.value), vector.expected, name);
  }
});

test("integrity mismatch fails closed and quota exhaustion is surfaced as a wait", () => {
  const root = mkdtempSync(path.join(tmpdir(), "indefinite-core-tamper-"));
  for (const file of ["manifest.json", "schema.json", "golden-vectors.json", "core.lock.json"]) {
    cpSync(path.join("packages", "indefinite-core", file), path.join(root, file));
  }
  writeFileSync(path.join(root, "manifest.json"), "{}\n");
  assert.equal(verifyCoreIntegrity(root), false);
  const disposition = classifyQuotaAvailability({
    routes: [{ model: "opencode/muse-spark-1.3-contributor-free", authorized: true, quotaLimited: true }],
    now: 0,
  });
  assert.equal(disposition.kind, "quota_wait");
  assert.equal(disposition.wait, true);
  assert.equal(disposition.surface, true);
  assert.equal(disposition.reason, "no_provider_authorized_eligible_route");
});

test("capability repair raises malformed and low output limits without lowering higher values", () => {
  const low = { max_output_tokens: 8192, max_tokens: 1000, reasoning: { effort: "low" }, tools: [{ type: "function" }] };
  assert.equal(applyRequestCapabilities(low), true);
  assert.equal(low.max_output_tokens, 16384);
  assert.equal(low.max_tokens, 16384);
  assert.equal(low.reasoning.effort, "xhigh");
  assert.equal(low.parallel_tool_calls, true);
  const malformed = { max_output_tokens: "bad", reasoning: null };
  assert.equal(applyRequestCapabilities(malformed), true);
  assert.equal(malformed.max_output_tokens, 16384);
  assert.equal(malformed.reasoning.effort, "xhigh");
  const higher = { max_output_tokens: 32768, max_tokens: 65536, reasoning: { effort: "xhigh" } };
  assert.equal(applyRequestCapabilities(higher), false);
  assert.equal(higher.max_output_tokens, 32768);
  assert.equal(higher.max_tokens, 65536);
});
