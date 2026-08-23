import { existsSync } from "node:fs";

export class GateError extends Error {
  constructor(code, reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.code = code;
    this.reason = reason;
  }
}

export function gateDeps(env) {
  return {
    killSwitchPath: env.FLEET_KILL_SWITCH_PATH ?? null,
    expectedLogin: env.FLEET_EXPECT_LOGIN ?? "M1Vj",
    token: env.FLEET_GH_TOKEN ?? "",
    fetchImpl: globalThis.fetch,
  };
}

export async function runGate(env, deps = gateDeps(env)) {
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
      "User-Agent": "fleet-control",
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
