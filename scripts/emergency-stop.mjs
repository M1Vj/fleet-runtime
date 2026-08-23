#!/usr/bin/env node
import process from "node:process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, gitAdd, gitCommit, gitPush, gitRevParse, configureIdentity } from "./lib/util.mjs";
import { verifyCommit, verifyIssueAuthor } from "./lib/verify.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = process.env.FLEET_STATE_ROOT ? path.resolve(process.env.FLEET_STATE_ROOT) : CODE_ROOT;

export async function main() {
  const runId = `stop-${Date.now()}`;
  const redact = scrub(process.env);
  const audit = new AuditBuffer(redact);
  try {
    if (process.env.FLEET_CONFIRM !== "STOP") {
      throw new Error("CONFIRM_REQUIRED set FLEET_CONFIRM=STOP");
    }
    const identity = await runGate(process.env);
    configureIdentity(REPO_ROOT, identity);
    audit.note("gate", `identity=${identity.login}`);

    writeFileSync(path.join(REPO_ROOT, "state", "KILL_SWITCH"), `halt ${new Date().toISOString()} dispatch ${process.env.GITHUB_RUN_ID || "local"}\n`);
    gitAdd(REPO_ROOT, ["state/KILL_SWITCH"]);
    gitCommit(REPO_ROOT, `[fleet] EMERGENCY STOP ${runId}`, identity);
    gitPush(REPO_ROOT, "main", process.env);
    const sha = gitRevParse(REPO_ROOT, "HEAD");
    await verifyCommit("M1Vj/fleet-control", sha, identity, process.env.FLEET_GH_TOKEN);
    audit.note("kill-switch", `committed sha=${sha.slice(0, 10)}`);

    for (const repoFullName of ["M1Vj/fleet-runtime", "M1Vj/fleet-control"]) {
      for (const wf of ["patrol.yml", "watchdog.yml", "selftest.yml", "deep.yml", "improve.yml", "thesis.yml", "kb.yml", "retro.yml"]) {
        gh(["api", "-X", "PUT", `/repos/${repoFullName}/actions/workflows/${wf}/disable`], process.env);
      }
      audit.note("disable", wf);
    }

    const issue = gh(
      [
        "api", "-X", "POST", "/repos/M1Vj/fleet-control/issues",
        "-f", `title=[EMERGENCY STOP] engaged run ${runId}`,
        "-f", `body=Kill switch committed (${sha.slice(0, 10)}) and patrol/watchdog/selftest workflows disabled.\nRe-arm procedure is in docs/RUNBOOK.md.`,
      ],
      process.env,
    );
    await verifyIssueAuthor("M1Vj/fleet-control", issue.number, identity, process.env.FLEET_GH_TOKEN);
    audit.note("confirmation-issue", `#${issue.number}`);

    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), runId, "Emergency stop", "ok");
    console.log("FLEET_RUN_RESULT=" + JSON.stringify({ runId, status: "stopped", killSwitchSha: sha.slice(0, 10), issue: issue.number }));
    return 0;
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
