#!/usr/bin/env node
// Paired fleet-control sentinel: revives the target repo's watchdog.yml and
// merge.yml when the primary watchdog is stale. Fails closed on uncertainty.
import process from "node:process";
import { existsSync } from "node:fs";
import { planSentinelActions } from "./lib/watchdog-decide.mjs";
import { gh } from "./lib/util.mjs";
import { runGate } from "./lib/gate.mjs";

const THRESHOLD_MS = 60 * 60 * 1000;

export function sentinelEnvDefaults(env = process.env) {
  return {
    target: env.FLEET_SENTINEL_TARGET || "M1Vj/fleet-runtime",
    autoEnable: env.FLEET_WATCHDOG_AUTO_ENABLE,
    killSwitchPath: env.FLEET_KILL_SWITCH_PATH || "",
    thresholdMs: THRESHOLD_MS,
  };
}

export async function main(env = process.env, { ghFn = gh, gateFn = runGate, nowMs = Date.now() } = {}) {
  const { target, autoEnable, killSwitchPath, thresholdMs } = sentinelEnvDefaults(env);
  const identity = await gateFn(env);
  if (!identity || identity.login !== "M1Vj") throw new Error("IDENTITY_MISMATCH");
  let lastRunUtc = null;
  try {
    const data = ghFn(["api", `/repos/${target}/actions/workflows/watchdog.yml/runs?per_page=1`], env);
    const latest = Array.isArray(data?.workflow_runs) ? data.workflow_runs[0] : undefined;
    lastRunUtc = latest?.created_at ?? null;
  } catch (error) {
    console.log(`SENTINEL_SKIPPED=target-runs-unavailable ${String(error.message || error).slice(0, 120)}`);
    return 0;
  }
  let killSwitchPresent = Boolean(killSwitchPath && existsSync(killSwitchPath));
  if (!killSwitchPresent) {
    try {
      ghFn(["api", "-i", "/repos/M1Vj/fleet-control/contents/state/KILL_SWITCH"], env);
      killSwitchPresent = true;
    } catch (error) {
      if (!/\b404\b|Not Found/i.test(String(error.message || error))) {
        console.log(`SENTINEL_SKIPPED=kill-switch-check-failed ${String(error.message || error).slice(0, 120)}`);
        return 0;
      }
    }
  }
  const plan = planSentinelActions({ lastRunUtc, nowMs, thresholdMs, autoEnable, killSwitchPresent });
  if (plan.actions.length === 0) {
    console.log(`SENTINEL_NOOP=${plan.reason} stale=${plan.stale}`);
    return 0;
  }
  for (const action of plan.actions) {
    try {
      ghFn(["api", "-X", "PUT", `/repos/${action.repo}/actions/workflows/${action.workflow}/enable`], env);
      console.log(`SENTINEL_ENABLED=${action.repo}/${action.workflow}`);
    } catch (error) {
      console.log(`SENTINEL_ENABLE_FAILED=${action.repo}/${action.workflow} ${String(error.message || error).slice(0, 120)}`);
      return 1;
    }
  }
  console.log("SENTINEL_DONE");
  return 0;
}

const isDirectExec = process.argv[1] && process.argv[1].endsWith("sentinel.mjs");
if (isDirectExec) {
  main().then((code) => process.exit(code || 0)).catch((error) => {
    console.error(`SENTINEL_FAILED ${String(error.message || error).slice(0, 160)}`);
    process.exit(1);
  });
}
