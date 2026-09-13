import { existsSync } from "node:fs";
import {
  DEFAULT_PUBLIC_OWNER,
  isPublicDataClass,
  publicRepository,
  publicTargetDecision,
  resolveDataClass,
} from "./private-state.mjs";

export class GateError extends Error {
  constructor(code, reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.code = code;
    this.reason = reason;
  }
}

export function gateDeps(env) {
  const dataClass = resolveDataClass(env);
  if (dataClass === "public") {
    return {
      dataClass,
      killSwitchPath: null,
      expectedOwner: DEFAULT_PUBLIC_OWNER,
      repository: env.FLEET_PUBLIC_REPOSITORY || "",
      token: env.GITHUB_TOKEN || "",
      fetchImpl: globalThis.fetch,
    };
  }
  return {
    dataClass,
    killSwitchPath: env.FLEET_KILL_SWITCH_PATH ?? null,
    expectedLogin: env.FLEET_EXPECT_LOGIN ?? "M1Vj",
    token: env.FLEET_GH_TOKEN ?? "",
    fetchImpl: globalThis.fetch,
  };
}

/**
 * Public preflight: use only Actions' built-in GITHUB_TOKEN or anonymous
 * GitHub API access, and prove the exact owner/repository is live and public
 * before any later target endpoint or clone is attempted.
 */
export async function runPublicGate(env, deps = gateDeps(env)) {
  let repository;
  try {
    repository = deps.repository || publicRepository(env);
  } catch (err) {
    throw new GateError(err?.code || 3, err?.reason || "PUBLIC_TARGET_INVALID", String(err?.message || err).slice(0, 160));
  }
  const token = deps.token || "";
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "fleet-public-read",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await deps.fetchImpl(`https://api.github.com/repos/${repository}`, { headers });
  } catch (err) {
    throw new GateError(3, "PUBLIC_TARGET_UNAVAILABLE", String(err?.message || err).slice(0, 160));
  }
  if (!response || response.ok === false || (Number.isInteger(response.status) && response.status >= 400)) {
    throw new GateError(3, "PUBLIC_TARGET_UNAVAILABLE", `status=${response?.status || "unknown"}`);
  }
  let metadata;
  try {
    metadata = await response.json();
  } catch (err) {
    throw new GateError(3, "PUBLIC_TARGET_METADATA_INVALID", String(err?.message || err).slice(0, 160));
  }
  const decision = publicTargetDecision(metadata, [DEFAULT_PUBLIC_OWNER]);
  if (!decision.ok || decision.repository !== repository) {
    throw new GateError(3, "PUBLIC_TARGET_NOT_PUBLIC", decision.reason || "metadata-mismatch");
  }
  return {
    dataClass: "public",
    mode: "public",
    login: metadata.owner?.login || DEFAULT_PUBLIC_OWNER,
    id: metadata.owner?.id || metadata.id || 0,
    name: metadata.owner?.login || DEFAULT_PUBLIC_OWNER,
    repository,
    visibility: "public",
    private: false,
    tokenSource: token ? "github.token" : "anonymous",
    metadata: {
      name: metadata.name,
      default_branch: metadata.default_branch,
      pushed_at: metadata.pushed_at,
      archived: metadata.archived === true,
    },
  };
}

export async function runGate(env, deps = gateDeps(env)) {
  if (isPublicDataClass(env) || deps.dataClass === "public") return runPublicGate(env, deps);
  if (deps.killSwitchPath && existsSync(deps.killSwitchPath)) {
    throw new GateError(2, "KILL_SWITCH_ENGAGED", deps.killSwitchPath);
  }
  if (!deps.token) {
    throw new GateError(3, "IDENTITY_MISMATCH", "missing FLEET_GH_TOKEN");
  }
  const res = await deps.fetchImpl("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${deps.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "fleet-runtime",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const scopes = (res.headers.get("x-oauth-scopes") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const user = await res.json();
  if (!user || user.login !== deps.expectedLogin || user.type !== "User") {
    throw new GateError(3, "IDENTITY_MISMATCH", `login=${user && user.login} type=${user && user.type}`);
  }
  if (!(scopes.includes("repo") && scopes.includes("workflow"))) {
    throw new GateError(4, "SCOPE_MISMATCH", scopes.join(","));
  }
  return {
    login: user.login,
    id: user.id,
    name: user.name || user.login,
    noreply: `${user.id}+${user.login}@users.noreply.github.com`,
    scopes,
  };
}
