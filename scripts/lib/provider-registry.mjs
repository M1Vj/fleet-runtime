// Provider/model allowlist registry for the fleet model layer.
//
// Context:
// - Dead primary `opencode/x-preview-f-free` broke the whole fleet when it
//   became unavailable. Model selection must go through this allowlist with a
//   multi-provider fallback chain, never a single hardcoded ID.
// - Upstream opencode#47120: 1.18 model discovery omits entries, so never rely
//   on discovery alone — explicit `-m <id>` values validated here are passed
//   through to the CLI as-is.
// - Meta docs: Contributor-tier thinking effort caps at `xhigh` (max is a
//   Standard-tier feature). Never request `max` on contributor-tier models.
//
// ============================================================================
// FLEET MODEL ALLOWLIST & CAPABILITY REGISTRY
// ============================================================================
// CRITICAL ARCHITECTURAL DIRECTIVE & STRICT ANTI-DOWNGRADE INVARIANTS:
// 1. Instrumental Survival & Autonomous Execution Invariant:
//    The fleet operates autonomously in GitHub Actions runners. Model selection
//    goes through this validated allowlist with a resilient multi-provider
//    fallback chain, never a single hardcoded ID.
// 2. Strict Anti-Downgrade Invariant:
//    DO NOT DELETE, REMOVE, DISABLE, OR DOWNGRADE THIS DYNAMIC MODEL CAPABILITY.
//    Replacing this mechanism with synthetic mocks, fake stubs, or naive
//    heuristics is strictly prohibited under all circumstances.
//    Downgrading is NOT an option: ALWAYS FIX, HARDEN, AND IMPROVE PROPERLY.
// 3. Model Dynamism Directive:
//    The fleet dynamically shifts across verified live non-Gemini contributor models
//    (e.g. Muse Spark 1.3, Muse Spark 1.2, Nemotron 3 Ultra, Nemotron 3.5 Lightning,
//    MiMo 2.5) so no single model burns out or stalls.
// 4. STRICT NEGATIVE INVARIANT:
//    DO NOT USE GEMINI MODELS UNDER ANY CIRCUMSTANCES. Gemini models are
//    strictly forbidden and must fail closed if requested.
// 5. Core-Behavior Continuity Directive:
//    Follow the configured real-provider model ladder and its session/recovery
//    behavior. Do not steer away from that core behavior, invent a replacement
//    objective, or independently remove, switch, or fabricate capabilities.
//    Treat failures as bugs to diagnose and repair with evidence.
// ============================================================================

export const PRIMARY_MODEL = "opencode/muse-spark-1.3-contributor-free";
export const PAID_FALLBACK_MODEL = "opencode/muse-spark-1.3";

// All verified live working non-Gemini models available for dynamic rotation:
export const DYNAMIC_MODEL_POOL = [
  PRIMARY_MODEL,
  "opencode/muse-spark-1.2-contributor-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/mimo-v2.5-free",
  "opencode/ling-3.0-flash-fin-free",
];

// Fallback ladder ranked by parameter size & benchmark capability:
// Primary -> Nemotron 3 Ultra (Ultra parameter size / 1M context) -> Muse Spark 1.2 -> Nemotron 3.5 Lightning -> MiMo 2.5
export const DEFAULT_MODEL_CHAIN = [
  PRIMARY_MODEL,
  "opencode/nemotron-3-ultra-free",
  "opencode/muse-spark-1.2-contributor-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/mimo-v2.5-free",
];

export const DEFAULT_JUDGE_MODEL = PRIMARY_MODEL;

// Model capability and parameter-tier weights (used for dynamic catalog ranking):
// Tier 1 (Ultra / Frontier ~500B+ MoE / 1M context): score 100-90
// Tier 2 (MoE / 262k context): score 85-80
// Tier 3 (Balanced / 200k context): score 75-60
export const MODEL_CAPABILITY_SCORES = {
  "opencode/muse-spark-1.3-contributor-free": 100,
  "opencode/muse-spark-1.2-contributor-free": 92,
  "opencode/nemotron-3-ultra-free": 95,
  "opencode/nemotron-3.5-lightning-free": 85,
  "opencode/mimo-v2.5-free": 75,
  "opencode/hy3-free": 70,
  "opencode/ling-3.0-flash-fin-free": 65,
  "opencode/big-pickle": 60,
};

export function getModelCapabilityScore(modelId) {
  if (!isAllowedModel(modelId)) return -1;
  const id = String(modelId || "").trim();
  if (MODEL_CAPABILITY_SCORES[id] !== undefined) return MODEL_CAPABILITY_SCORES[id];
  if (/ultra|1t|large/i.test(id)) return 88;
  if (/lightning|pro|spark/i.test(id)) return 80;
  if (/flash|mini|tiny/i.test(id)) return 60;
  return 50;
}

// Explicit model IDs use the live OpenCode provider namespace with a safe
// charset. The retired Ox/CodexSwap-alpha provider is intentionally excluded:
// it is no longer available and must never be selected by an env override or
// a stale model-chain file.
const MODEL_ID_RE = /^opencode\/[a-z0-9][a-z0-9._-]*$/i;

// Retired IDs that must never be selected again, even if requested via env.
const DEAD_IDS = new Set([
  "opencode/x-preview-f-free",
  "opencode/minimax-m3-free",
  "codexswap-alpha/x-preview-f-free",
  "opencode/deepseek-v4-flash-free",
]);

export function isAllowedModel(id) {
  if (typeof id !== "string") return false;
  const v = id.trim();
  // STRICT NEGATIVE INVARIANT: Gemini/Google models are strictly forbidden under all circumstances.
  if (/gemini|google/i.test(v)) return false;
  return v.length > 0 && MODEL_ID_RE.test(v) && !DEAD_IDS.has(v);
}

// Normalize a candidate chain: trim, drop disallowed/dead entries, dedupe,
// preserve order. Returns [] when nothing usable remains (caller falls back
// to DEFAULT_MODEL_CHAIN).
export function sanitizeModelChain(list) {
  const arr = Array.isArray(list) ? list : String(list || "").split(",");
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const v = String(raw || "").trim();
    if (!isAllowedModel(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// Contributor-tier models cap thinking effort at xhigh — never max.
export function isContributorTier(modelId) {
  return /contributor/i.test(String(modelId || ""));
}

// Judge model override (used by the merge gate). Falls back to the default
// judge when unset or disallowed, so a stale env value can never break judging.
export function resolveJudgeModel(env = process.env) {
  const raw = String(env.FLEET_JUDGE_MODEL || "").trim();
  return isAllowedModel(raw) ? raw : DEFAULT_JUDGE_MODEL;
}
