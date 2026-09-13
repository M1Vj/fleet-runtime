/* Thin adapter over the pinned, dependency-free indefinite runtime core. */
import {
  CORE_INTEGRITY_OK,
  CORE_LOCK_DIGEST,
  CORE_MANIFEST,
  CORE_CAPABILITIES,
  OUTPUT_TOKEN_FLOOR,
  UNBOUNDED_STEPS,
  EXACT_SESSION_INVARIANT,
  SINGLE_WRITER_INVARIANT,
  PRIMARY_MODEL,
  PAID_FALLBACK_MODEL,
  DEFAULT_MODEL_CHAIN,
  DYNAMIC_MODEL_POOL,
  DEFAULT_JUDGE_MODEL,
  MODEL_CAPABILITY_SCORES,
  getModelCapabilityScore,
  isAllowedModel,
  sanitizeModelChain,
  isContributorTier,
  resolveJudgeModel,
  classifyQuotaAvailability,
} from "../../packages/indefinite-core/index.mjs";

export {
  CORE_INTEGRITY_OK,
  CORE_MANIFEST,
  CORE_CAPABILITIES,
  OUTPUT_TOKEN_FLOOR,
  UNBOUNDED_STEPS,
  EXACT_SESSION_INVARIANT,
  SINGLE_WRITER_INVARIANT,
  PRIMARY_MODEL,
  PAID_FALLBACK_MODEL,
  DEFAULT_MODEL_CHAIN,
  DYNAMIC_MODEL_POOL,
  DEFAULT_JUDGE_MODEL,
  MODEL_CAPABILITY_SCORES,
  getModelCapabilityScore,
  isAllowedModel,
  sanitizeModelChain,
  isContributorTier,
  resolveJudgeModel,
  classifyQuotaAvailability,
};

// Consumers compare this immutable pin before using the adapter's policy.
export const CORE_POLICY_DIGEST = CORE_LOCK_DIGEST;
