const PROVIDER_REJECTED_RE = /\b(?:401|403)\b|unauthorized|forbidden|invalid[_ -]?api[_ -]?key|api key (?:invalid|missing|rejected)|credential(?:s)? (?:invalid|rejected|expired)|authentication (?:failed|error)|expired token/i;
const PROVIDER_EXHAUSTED_RE = /\b402\b|payment required|insufficient credits?|quota exceeded|credits? exhausted|credit balance|billing|usage limit/i;

/**
 * Resolve model credentials. Production uses the durable OPENCODE_API_KEY
 * provider secret provisioned as a GitHub Environment secret; the owner-Mac
 * OAuth snapshot is an explicit migration-only fallback, never the default.
 * No credential values are returned, only the resolution mode.
 */
export function resolveProviderAuth(env = process.env) {
  const providerKey = typeof env.OPENCODE_API_KEY === "string" ? env.OPENCODE_API_KEY.trim() : "";
  if (providerKey) return { ok: true, mode: "provider-key" };
  const legacyAuth = typeof env.FLEET_OPENCODE_AUTH === "string" ? env.FLEET_OPENCODE_AUTH.trim() : "";
  const githubHost = /^(?:1|true)$/i.test(String(env.GITHUB_ACTIONS || "")) || Boolean(env.GITHUB_RUN_ID) || Boolean(env.GITHUB_WORKFLOW);
  if (legacyAuth && !githubHost) return { ok: true, mode: "legacy-oauth-migration" };
  return { ok: false, mode: "none", reason: "MODEL_AUTH_MISSING", retryable: true };
}

/** Combine credential presence with gateway-circuit health into one adapter status. */
export function providerAuthStatus(env = process.env, { circuitOpen = false } = {}) {
  const auth = resolveProviderAuth(env);
  if (!auth.ok) return { ready: false, stage: "credentials", reason: "MODEL_AUTH_MISSING", retryable: true };
  if (circuitOpen) return { ready: false, stage: "health", reason: "MODEL_CIRCUIT_OPEN", retryable: true, mode: auth.mode };
  return { ready: true, mode: auth.mode };
}

/** Classify a failed model round's error tails: rejected, exhausted, or null. */
export function classifyProviderAuthFailure(text) {
  const value = String(text || "");
  if (!value) return null;
  if (PROVIDER_EXHAUSTED_RE.test(value)) return "exhausted";
  if (PROVIDER_REJECTED_RE.test(value)) return "rejected";
  return null;
}
