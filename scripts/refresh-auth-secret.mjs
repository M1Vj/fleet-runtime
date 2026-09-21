#!/usr/bin/env node
import process from "node:process";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  assertKillSwitchClear,
  CENTRAL_KILL_SWITCH_VARIABLE,
} from "./lib/kill-switch.mjs";

const RUNTIME_REPOSITORY = "M1Vj/fleet-runtime";
const OWNER_LOGIN = "M1Vj";
const usage = "usage: node scripts/refresh-auth-secret.mjs [--token] <file>\n  default file is auth.json -> secret FLEET_OPENCODE_AUTH\n  --token file -> secret FLEET_GH_TOKEN";

function canonicalGuardEnv(env = process.env) {
  if (String(env.FLEET_DATA_CLASS || "private").trim().toLowerCase() === "public") {
    throw Object.assign(new Error("public data class cannot refresh private secrets"), { code: 4, reason: "PUBLIC_WRITE_BLOCKED" });
  }
  const controlRepository = String(env.FLEET_CONTROL_REPOSITORY || "").trim();
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(controlRepository)
    || String(env.FLEET_KILL_SWITCH_REPOSITORY || "").trim() !== controlRepository
    || String(env.FLEET_KILL_SWITCH_VARIABLE || "").trim() !== CENTRAL_KILL_SWITCH_VARIABLE) {
    throw Object.assign(new Error("owner control repository is not canonical"), { code: 4, reason: "IDENTITY_TARGET_INVALID" });
  }
  return {
    ...env,
    FLEET_CONTROL_REPOSITORY: controlRepository,
    FLEET_KILL_SWITCH_REPOSITORY: controlRepository,
    FLEET_KILL_SWITCH_VARIABLE: CENTRAL_KILL_SWITCH_VARIABLE,
  };
}

function ghApiJson(pathname, env) {
  const result = spawnSync("gh", ["api", pathname], {
    env: { ...env, GH_HOST: "github.com" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024,
    timeout: 10_000,
    killSignal: "SIGTERM",
  });
  if (result.status !== 0) throw Object.assign(new Error("owner identity unavailable"), { code: 2, reason: "IDENTITY_UNAVAILABLE" });
  try {
    return JSON.parse(String(result.stdout || ""));
  } catch {
    throw Object.assign(new Error("owner identity response invalid"), { code: 2, reason: "IDENTITY_UNAVAILABLE" });
  }
}

function assertOwnerMutationReady(env = process.env) {
  const guardEnv = canonicalGuardEnv(env);
  const identity = ghApiJson("/user", guardEnv);
  if (!identity || identity.login !== OWNER_LOGIN || identity.type !== "User") {
    throw Object.assign(new Error("owner identity mismatch"), { code: 3, reason: "IDENTITY_MISMATCH" });
  }
  // This read is deliberately immediately before each secret mutation. Any
  // missing, engaged, or malformed central signal blocks the effect.
  assertKillSwitchClear(guardEnv);
  return guardEnv;
}

function repositoryTargets(env) {
  return [RUNTIME_REPOSITORY, env.FLEET_CONTROL_REPOSITORY];
}

function setSecret(name, value, env = process.env) {
  for (const repository of repositoryTargets(canonicalGuardEnv(env))) {
    const guardedEnv = assertOwnerMutationReady(env);
    const result = spawnSync("gh", ["secret", "set", name, "-R", repository], {
      input: value,
      env: { ...guardedEnv, GH_HOST: "github.com" },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024,
      timeout: 30_000,
      killSignal: "SIGTERM",
    });
    if (result.status !== 0) {
      process.stderr.write(`secret ${name} update failed for canonical target\n`);
      process.exitCode = result.status || 1;
      return false;
    }
    process.stdout.write(`secret ${name} updated on ${repository}\n`);
  }
  return true;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 0) {
    process.stdout.write(`${usage}\n`);
    return 1;
  }
  const tokenMode = argv[0] === "--token";
  const filePath = tokenMode ? argv[1] : argv[0];
  if (!filePath) {
    process.stdout.write(`${usage}\n`);
    return 1;
  }
  // The value is read only as stdin for `gh secret set`; it is never logged,
  // interpolated into an argument, or included in diagnostics.
  const content = readFileSync(filePath, "utf8");
  return setSecret(tokenMode ? "FLEET_GH_TOKEN" : "FLEET_OPENCODE_AUTH", content, env) ? 0 : (process.exitCode || 1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) process.exitCode = main();
