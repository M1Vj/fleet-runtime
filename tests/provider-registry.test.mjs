import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRIMARY_MODEL,
  PAID_FALLBACK_MODEL,
  DEFAULT_MODEL_CHAIN,
  DEFAULT_JUDGE_MODEL,
  isAllowedModel,
  sanitizeModelChain,
  isContributorTier,
  resolveJudgeModel,
} from "../scripts/lib/provider-registry.mjs";

test("defaults pin muse-spark contributor-free primary with no paid fallback", () => {
  assert.equal(PRIMARY_MODEL, "opencode/muse-spark-1.3-contributor-free");
  assert.equal(PAID_FALLBACK_MODEL, null);
  assert.ok(DEFAULT_MODEL_CHAIN.includes(PRIMARY_MODEL));
  assert.equal(isAllowedModel("opencode/muse-spark-1.3"), false);
  assert.equal(isAllowedModel("opencode/muse-spark-1.3", { allowPaid: true, authorizedPaidOptIn: true }), true);
  assert.equal(DEFAULT_JUDGE_MODEL, PRIMARY_MODEL);
});

test("explicit IDs allowed without discovery, Gemini models strictly rejected", () => {
  // Upstream #47120: discovery omits models — any well-formed explicit ID passes.
  assert.equal(isAllowedModel("opencode/muse-spark-1.3-contributor-free"), true);
  assert.equal(isAllowedModel("opencode/nemotron-3.5-lightning-free"), true);
  assert.equal(isAllowedModel("opencode/some-future-model-9"), false);
  // STRICT NEGATIVE INVARIANT: Gemini/Google models strictly forbidden
  assert.equal(isAllowedModel("opencode/gemini-3-flash"), false);
  assert.equal(isAllowedModel("google/antigravity-gemini-3"), false);
});

test("unsafe, dead, and forbidden values rejected", () => {
  assert.equal(isAllowedModel(""), false);
  assert.equal(isAllowedModel("   "), false);
  assert.equal(isAllowedModel(null), false);
  assert.equal(isAllowedModel("opencode/x-preview-f-free"), false);
  assert.equal(isAllowedModel("codexswap-alpha/x-preview-f-free"), false);
  assert.equal(isAllowedModel("opencode/minimax-m3-free"), false);
  assert.equal(isAllowedModel("opencode/gemini-3-flash"), false);
  assert.equal(isAllowedModel("../evil"), false);
  assert.equal(isAllowedModel("opencode/../evil"), false);
  assert.equal(isAllowedModel("--variant"), false);
  assert.equal(isAllowedModel("gpt-4o"), false);
  assert.equal(isAllowedModel("opencode/"), false);
});

test("sanitize preserves order, dedupes, drops dead and forbidden models", () => {
  assert.deepEqual(
    sanitizeModelChain("opencode/nemotron-3.5-lightning-free, opencode/x-preview-f-free, opencode/gemini-3-flash, opencode/nemotron-3.5-lightning-free, opencode/mimo-v2.5-free "),
    ["opencode/nemotron-3.5-lightning-free", "opencode/mimo-v2.5-free"],
  );
  assert.deepEqual(sanitizeModelChain([]), []);
});

test("contributor tier gating for xhigh (never max)", () => {
  assert.equal(isContributorTier("opencode/muse-spark-1.3-contributor-free"), true);
  assert.equal(isContributorTier("opencode/muse-spark-1.3"), false);
  assert.equal(isContributorTier(""), false);
});

test("judge resolution falls back on stale or forbidden values", () => {
  assert.equal(resolveJudgeModel({ FLEET_JUDGE_MODEL: "opencode/nemotron-3.5-lightning-free" }), "opencode/nemotron-3.5-lightning-free");
  assert.equal(resolveJudgeModel({ FLEET_JUDGE_MODEL: "opencode/gemini-3-flash" }), DEFAULT_JUDGE_MODEL);
  assert.equal(resolveJudgeModel({ FLEET_JUDGE_MODEL: "bogus" }), DEFAULT_JUDGE_MODEL);
  assert.equal(resolveJudgeModel({}), DEFAULT_JUDGE_MODEL);
});
