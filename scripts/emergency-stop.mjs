#!/usr/bin/env node
import process from "node:process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, gitAdd, gitCommit, gitPush, gitRevParse, configureIdentity } from "./lib/util.mjs";
import { verifyCommit, verifyIssueAuthor } from "./lib/verify.mjs";
import { isPublicDataClass, privateRepository, PRIVATE_REPOSITORY_ENV, publicRepository, writePublicArtifact } from "./lib/private-state.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = process.env.FLEET_STATE_ROOT ? path.resolve(process.env.FLEET_STATE_ROOT) : CODE_ROOT;

export const STOP_WORKFLOWS = Object.freeze([
  "patrol.yml",
  "watchdog.yml",
  "selftest.yml",
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
    configureIdentity(REPO_ROOT, identity);
    audit.note("gate", `identity=${identity.login}`);

    writeFileSync(path.join(REPO_ROOT, "state", "KILL_SWITCH"), `halt ${new Date().toISOString()} dispatch ${process.env.GITHUB_RUN_ID || "local"}\n`);
    gitAdd(REPO_ROOT, ["state/KILL_SWITCH"]);
    gitCommit(REPO_ROOT, `[fleet] EMERGENCY STOP ${runId}`, identity);
    gitPush(REPO_ROOT, "main", process.env);
    const sha = gitRevParse(REPO_ROOT, "HEAD");
    const controlRepository = privateRepository(process.env, PRIVATE_REPOSITORY_ENV.control);
    await verifyCommit(controlRepository, sha, identity, process.env.FLEET_GH_TOKEN);
    audit.note("kill-switch", `committed sha=${sha.slice(0, 10)}`);

    for (const repoFullName of ["M1Vj/fleet-runtime", controlRepository]) {
      for (const wf of STOP_WORKFLOWS) {
        try {
          gh(["api", "-X", "PUT", `/repos/${repoFullName}/actions/workflows/${wf}/disable`], process.env);
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
        "-f", `body=Kill switch committed (${sha.slice(0, 10)}). Disabled workflows: ${STOP_WORKFLOWS.join(", ")} (on both repositories).\nRe-arm procedure is in docs/RUNBOOK.md.`,
      ],
      process.env,
    );
    await verifyIssueAuthor(controlRepository, issue.number, identity, process.env.FLEET_GH_TOKEN);
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
