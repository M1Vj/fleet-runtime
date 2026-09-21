import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const CANONICAL_KILL_SWITCH_PATH = "/opt/actions-runner/_state/fleet-cloud-agent/state/KILL_SWITCH";
export const CENTRAL_KILL_SWITCH_VARIABLE = "FLEET_KILL_SWITCH";

const REPOSITORY_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

export class KillSwitchError extends Error {
  constructor(code, reason, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "KillSwitchError";
    this.code = code;
    this.reason = reason;
  }
}

function workspaceMarker(codeRoot = process.cwd()) {
  return path.resolve(String(codeRoot || process.cwd()), "state", "KILL_SWITCH");
}

function isWorkspaceMarker(value, codeRoot) {
  return path.resolve(String(value || "")) === workspaceMarker(codeRoot);
}

function signalReadEnv(env) {
  const token = String(env?.FLEET_GH_TOKEN || "").trim();
  return {
    PATH: env?.PATH || "/usr/bin:/bin:/usr/local/bin",
    HOME: env?.HOME || "/tmp",
    GH_HOST: "github.com",
    ...(token ? { GH_TOKEN: token } : {}),
  };
}

function parseSignal(result, variable) {
  if (Number(result?.status) !== 0) {
    throw new KillSwitchError(2, "KILL_SWITCH_SIGNAL_UNAVAILABLE");
  }
  let payload;
  try {
    payload = JSON.parse(String(result?.stdout || ""));
  } catch {
    throw new KillSwitchError(2, "KILL_SWITCH_SIGNAL_UNAVAILABLE");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.name !== variable) {
    throw new KillSwitchError(2, "KILL_SWITCH_SIGNAL_UNAVAILABLE");
  }
  const value = typeof payload.value === "string" ? payload.value.trim() : "";
  if (value === "clear") return { present: false };
  if (value === "engaged" || value.startsWith("engaged ")) return { present: true };
  throw new KillSwitchError(2, "KILL_SWITCH_SIGNAL_INVALID");
}

/**
 * Return true only for GitHub CLI commands that can mutate remote state.
 * Reads still run through the normal identity and target gates; this helper
 * exists so every direct gh mutation receives the same last-moment stop check.
 */
export function isGitHubMutation(args = []) {
  const values = (Array.isArray(args) ? args : []).map((value) => String(value));
  const command = values[0] || "";
  if (command === "api") {
    let method;
    let hasBody = false;
    for (let index = 1; index < values.length; index += 1) {
      const value = values[index];
      if (/^(?:-X|--method)=/i.test(value)) method = value.slice(value.indexOf("=") + 1);
      else if (value === "-X" || value === "--method") method = values[++index];
      else if (/^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/i.test(value)) hasBody = true;
    }
    if (method) return String(method).trim().toUpperCase() !== "GET";
    return hasBody;
  }
  if (command === "workflow") return new Set(["run", "enable", "disable", "cancel"]).has(values[1]);
  if (command === "run") return new Set(["cancel", "rerun", "delete"]).has(values[1]);
  if (command === "variable") return new Set(["set", "delete"]).has(values[1]);
  if (command === "pr") return new Set(["create", "merge", "ready", "close", "reopen", "edit", "comment", "review"]).has(values[1]);
  if (command === "issue") return new Set(["create", "close", "reopen", "edit", "comment", "delete", "lock", "unlock"]).has(values[1]);
  if (command === "repo") return new Set(["create", "delete", "edit", "rename", "archive"]).has(values[1]);
  return false;
}

/**
 * Check both the task-local marker (when explicitly configured) and the
 * centrally observable private-repository variable. Any unreadable signal
 * fails closed so a hosted job never treats its workspace as global state.
 */
export function assertKillSwitchClear(env = process.env, {
  exists = existsSync,
  run = spawnSync,
  codeRoot = process.cwd(),
} = {}) {
  const controlRepository = String(env?.FLEET_CONTROL_REPOSITORY || "").trim();
  const configuredRepository = String(env?.FLEET_KILL_SWITCH_REPOSITORY || "").trim();
  const configuredVariable = String(env?.FLEET_KILL_SWITCH_VARIABLE || "").trim();
  const actionsRepository = String(env?.GITHUB_REPOSITORY || "").trim();
  if (!REPOSITORY_RE.test(controlRepository)
    || configuredRepository !== controlRepository
    || (String(env?.GITHUB_ACTIONS || "") === "true" && actionsRepository !== controlRepository)
    || configuredVariable !== CENTRAL_KILL_SWITCH_VARIABLE) {
    throw new KillSwitchError(4, "KILL_SWITCH_CONFIG_INVALID");
  }
  const actuator = String(env?.FLEET_KILL_SWITCH_ACTUATOR || "") === "true"
    && String(env?.FLEET_CONFIRM || "") === "STOP"
    && String(env?.FLEET_KILL_SWITCH_PATH || "") === CANONICAL_KILL_SWITCH_PATH
    && String(env?.FLEET_CONTROL_REPOSITORY || "") === controlRepository
    && String(env?.FLEET_KILL_SWITCH_REPOSITORY || "") === controlRepository
    && String(env?.FLEET_KILL_SWITCH_VARIABLE || "") === CENTRAL_KILL_SWITCH_VARIABLE
    && String(env?.GITHUB_ACTIONS || "") === "true"
    && String(env?.GITHUB_REPOSITORY || "") === controlRepository
    && String(env?.GITHUB_REF || "") === "refs/heads/main"
    && String(env?.GITHUB_EVENT_NAME || "") === "workflow_dispatch"
    && String(env?.GITHUB_ACTOR || "") === "M1Vj"
    && String(env?.GITHUB_TRIGGERING_ACTOR || "") === "M1Vj"
    && String(env?.GITHUB_WORKFLOW || "") === "fleet-emergency-stop";
  const localPath = String(env?.FLEET_KILL_SWITCH_PATH || "").trim();
  if (localPath) {
    if (!path.isAbsolute(localPath)) {
      throw new KillSwitchError(4, "KILL_SWITCH_PATH_INVALID");
    }
    if (isWorkspaceMarker(localPath, codeRoot)) {
      throw new KillSwitchError(4, "KILL_SWITCH_WORKSPACE_PATH_INVALID");
    }
    if (!actuator && exists(localPath)) {
      throw new KillSwitchError(2, "KILL_SWITCH_ENGAGED", localPath);
    }
  }

  const repository = controlRepository;
  const variable = CENTRAL_KILL_SWITCH_VARIABLE;
  if (actuator) return true;
  let result;
  try {
    result = run("gh", ["api", `/repos/${repository}/actions/variables/${variable}`], {
      env: signalReadEnv(env),
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 5000,
      killSignal: "SIGTERM",
    });
  } catch {
    throw new KillSwitchError(2, "KILL_SWITCH_SIGNAL_UNAVAILABLE");
  }
  const signal = parseSignal(result, variable);
  if (signal.present) throw new KillSwitchError(2, "KILL_SWITCH_ENGAGED", `${repository}/${variable}`);
  return true;
}
