#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { safeCommitState, scrub } from "./lib/util.mjs";
import { normalizeAuditRunId } from "./lib/pr-memory.mjs";
import { releaseSetupFailedDispatch } from "./merge.mjs";

/**
 * always()-equivalent merge-gate finalizer. When the workflow failed before
 * scripts/merge.mjs recorded any gate state, release only the exact latest
 * DISPATCH_CONSUMED claim for the correlated repo+PR+head SHA. Live merges
 * (FLEET_ALLOW_MERGE=true) and any recorded gate/revision state are refused.
 */
export async function main(env = process.env) {
  const audit = new AuditBuffer(scrub(env));
  const runId = normalizeAuditRunId(String(env.FLEET_RUN_ID || "finalize"));
  const dispatchKey = String(env.FLEET_DISPATCH_ID || "");
  const target = {
    repo: String(env.FLEET_TARGET_REPO || ""),
    pr: env.FLEET_PR_NUMBER,
    headSha: String(env.FLEET_HEAD_SHA || ""),
  };
  if (!dispatchKey || !env.FLEET_STATE_ROOT || !target.repo || !target.pr || !target.headSha) {
    console.log("MERGE_FINALIZE_SKIPPED=no-correlation");
    return 0;
  }
  try {
    const identity = await runGate(env);
    const result = releaseSetupFailedDispatch(target, dispatchKey, {
      stateRoot: env.FLEET_STATE_ROOT,
      runId,
      identity,
      allowMerge: String(env.FLEET_ALLOW_MERGE || "") === "true",
    });
    audit.note("finalize", `released=${Boolean(result.released)} ${String(result.reason || (result.event && result.event.state) || "").slice(0, 120)}`);
    audit.writeMarkdown(path.join(env.FLEET_STATE_ROOT, "audit"), runId, "Merge gate finalize", result.released ? "ok-released" : "ok-noop");
    safeCommitState(env.FLEET_STATE_ROOT, ["audit"], `[fleet] merge-gate finalize ${runId} ${result.released ? "released" : "noop"}`, identity, env);
    console.log(`MERGE_FINALIZE_RESULT=${result.released ? "DISPATCH_RELEASED" : `skipped:${String(result.reason || "not-eligible").slice(0, 80)}`}`);
    return 0;
  } catch (error) {
    audit.incident("fatal", String(error.message || error).slice(0, 200));
    console.error(`MERGE_FINALIZE_FAILED reason=${String(error.message || error).slice(0, 200)}`);
    return Number.isInteger(error.code) ? error.code : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code || 0));
}
