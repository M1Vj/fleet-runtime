#!/usr/bin/env node
import process from "node:process";
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh } from "./lib/util.mjs";
import { verifyIssueAuthor } from "./lib/verify.mjs";
import { isPublicDataClass, privateRepository, PRIVATE_REPOSITORY_ENV, publicRepository, writePublicArtifact } from "./lib/private-state.mjs";
import {
  CANONICAL_KILL_SWITCH_PATH,
  CENTRAL_KILL_SWITCH_VARIABLE,
} from "./lib/kill-switch.mjs";

export { CANONICAL_KILL_SWITCH_PATH };

const CODE_ROOT = process.cwd();
const REPO_ROOT = CODE_ROOT;
/**
 * Resolve the one kill-switch marker consumed by the private cloud worker.
 * The path is always supplied by the protected workflow; a workspace fallback
 * would create a marker the worker cannot see and is therefore rejected.
 */
export function resolveKillSwitchPath(env = process.env, codeRoot = CODE_ROOT) {
  const configured = typeof env.FLEET_KILL_SWITCH_PATH === "string"
    ? env.FLEET_KILL_SWITCH_PATH.trim()
    : "";
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error("FLEET_KILL_SWITCH_PATH must be an absolute path");
  }
  const resolved = path.resolve(configured);
  const workspaceMarker = path.resolve(codeRoot, "state", "KILL_SWITCH");
  if (resolved === workspaceMarker) {
    throw new Error("FLEET_KILL_SWITCH_PATH must not point at the workflow workspace");
  }
  if (resolved !== CANONICAL_KILL_SWITCH_PATH) {
    throw new Error("FLEET_KILL_SWITCH_PATH must point at the canonical VM marker");
  }
  return resolved;
}

export const STOP_WORKFLOWS = Object.freeze([
  "patrol.yml",
  "watchdog.yml",
  "selftest.yml",
  "cloud-agent.yml",
  "deep.yml",
  "improve.yml",
  "thesis.yml",
  "kb.yml",
  "retro.yml",
  "orchestrate.yml",
  "merge.yml",
  "model-refresh.yml",
  "ci-diag.yml",
]);

export async function main() {
  const runId = `stop-${Date.now()}`;
  const redact = scrub(process.env);
  const audit = new AuditBuffer(redact);
  try {
    if (process.env.FLEET_CONFIRM !== "STOP") {
      throw new Error("CONFIRM_REQUIRED set FLEET_CONFIRM=STOP");
    }
    const identity = await runGate(process.env);
    if (isPublicDataClass(process.env)) {
      try {
        const repository = publicRepository(process.env);
        writePublicArtifact(process.env, { mode: "emergency-stop", status: "blocked", repository, reason: "public-read-only" }, { kind: "emergency-stop", status: "blocked", repository });
      } catch {}
      audit.note("public-read-only", "emergency stop cannot mutate public repositories");
      console.log("FLEET_RUN_RESULT=" + JSON.stringify({ runId, status: "blocked", reason: "public-read-only" }));
      return 4;
    }
    audit.note("gate", `identity=${identity.login}`);

    const killSwitchPath = resolveKillSwitchPath(process.env);
    if (existsSync(killSwitchPath) && lstatSync(killSwitchPath).isSymbolicLink()) {
      throw new Error("FLEET_KILL_SWITCH_PATH is a symbolic link");
    }
    mkdirSync(path.dirname(killSwitchPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      killSwitchPath,
      `halt ${new Date().toISOString()} dispatch ${process.env.GITHUB_RUN_ID || "local"}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    chmodSync(killSwitchPath, 0o600);
    const controlRepository = privateRepository(process.env, PRIVATE_REPOSITORY_ENV.control);
    const actuatorEnv = {
      ...process.env,
      FLEET_KILL_SWITCH_ACTUATOR: "true",
    };
    let centralSignalSet = false;
    try {
      gh(
        [
          "variable", "set", CENTRAL_KILL_SWITCH_VARIABLE,
          "--body", `engaged ${new Date().toISOString()} dispatch ${process.env.GITHUB_RUN_ID || "local"}`,
          "-R", controlRepository,
        ],
        actuatorEnv,
      );
      centralSignalSet = true;
      audit.note("central-kill-switch", `${controlRepository}/${CENTRAL_KILL_SWITCH_VARIABLE} engaged`);
    } catch (error) {
      audit.incident("central-kill-switch", `signal write failed; continuing workflow disable: ${String(error?.message || error).slice(0, 120)}`);
    }
    audit.note("kill-switch", `path=${killSwitchPath}`);

    for (const repoFullName of ["M1Vj/fleet-runtime", controlRepository]) {
      for (const wf of STOP_WORKFLOWS) {
        try {
          gh(["api", "-X", "PUT", `/repos/${repoFullName}/actions/workflows/${wf}/disable`], actuatorEnv);
          audit.note("disable", `${repoFullName}/${wf} disabled`);
        } catch (err) {
          // Absent workflows 404 (e.g. thesis/kb/retro only exist on
          // fleet-runtime) — tolerate, the kill-switch file is the real halt.
          if (!/404|not found/i.test(String(err.message))) throw err;
          audit.note("disable-skip", `${repoFullName}/${wf} absent`);
        }
      }
    }

    const issue = gh(
      [
        "api", "-X", "POST", `/repos/${controlRepository}/issues`,
        "-f", `title=[EMERGENCY STOP] engaged run ${runId}`,
        "-f", `body=Kill switch engaged at ${killSwitchPath}. Central signal ${centralSignalSet ? "engaged" : "FAILED TO WRITE"}. Disabled workflows: ${STOP_WORKFLOWS.join(", ")} (on both repositories).\nRe-arm procedure is in docs/RUNBOOK.md.`,
      ],
      actuatorEnv,
    );
    await verifyIssueAuthor(controlRepository, issue.number, identity, process.env.FLEET_GH_TOKEN);
    audit.note("confirmation-issue", `#${issue.number}`);

    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), runId, "Emergency stop", "ok");
    const status = centralSignalSet ? "stopped" : "partial-stopped";
    console.log("FLEET_RUN_RESULT=" + JSON.stringify({ runId, status, killSwitchPath, centralSignalSet, issue: issue.number }));
    return centralSignalSet ? 0 : 1;
  } catch (err) {
    const code = err.code && Number.isInteger(err.code) ? err.code : 1;
    audit.incident("fatal", err.message);
    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), runId, "Emergency stop", `failed(${err.reason || code})`);
    console.error(`EMERGENCY_STOP_FAILED code=${code} reason=${err.reason || err.message}`);
    return code;
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const exitCode = await main();
  process.exit(exitCode);
}
