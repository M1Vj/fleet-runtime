#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, gitAdd, gitCommit, gitPush, gitHasChanges, gitRevParse, configureIdentity } from "./lib/util.mjs";
import { verifyCommit, verifyIssueAuthor } from "./lib/verify.mjs";
import { planWatchdogActions } from "./lib/watchdog-decide.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = process.env.FLEET_STATE_ROOT ? path.resolve(process.env.FLEET_STATE_ROOT) : CODE_ROOT;

function heartbeatPath() {
  return path.join(REPO_ROOT, "state", "heartbeat.json");
}

export async function main() {
  const runId = `watchdog-${Date.now()}`;
  const redact = scrub(process.env);
  const audit = new AuditBuffer(redact);
  let identity = null;
  try {
    identity = await runGate(process.env);
    configureIdentity(REPO_ROOT, identity);
    audit.note("gate", `identity=${identity.login}`);

    if (process.env.FLEET_WATCHDOG_DRY_RUN === "1") {
      const synthetic = { lastRunUtc: new Date(Date.now() - 4 * 3600 * 1000).toISOString() };
      const plan = planWatchdogActions(synthetic, Date.now());
      const enables = plan.actions.filter((a) => a.kind === "enable-workflow").length;
      audit.note("dry-run", `stale=${plan.stale} enables=${enables} alert=${plan.alertIssue}`);
      for (const a of plan.actions) console.log(`WOULD ${a.kind} ${a.workflow || ""}`.trim());
      audit.writeMarkdown(path.join(REPO_ROOT, "audit"), runId, "Watchdog dry-run", "ok");
      console.log(`WATCHDOG_DRY_RUN_OK stale=${plan.stale} enables=${enables}`);
      return 0;
    }

    let heartbeat = null;
    if (existsSync(heartbeatPath())) {
      try {
        heartbeat = JSON.parse(readFileSync(heartbeatPath(), "utf8"));
      } catch {
        heartbeat = null;
      }
    }
    const plan = planWatchdogActions(heartbeat, Date.now());
    audit.note("heartbeat", `decision=${plan.reason} ageMinutes=${plan.ageMinutes}`);

    if (!plan.stale) {
      audit.writeMarkdown(path.join(REPO_ROOT, "audit"), runId, "Watchdog", "ok-fresh");
      console.log("FLEET_RUN_RESULT=" + JSON.stringify({ runId, status: "fresh", action: "none" }));
      return 0;
    }

    const enablePlan = {
      "M1Vj/fleet-runtime": ["patrol.yml", "selftest.yml", "deep.yml", "improve.yml", "thesis.yml", "kb.yml", "retro.yml"],
      "M1Vj/fleet-control": ["patrol.yml", "selftest.yml", "deep.yml", "improve.yml"],
    };
    for (const [repoFullName, workflows] of Object.entries(enablePlan)) {
      for (const wf of workflows) {
        try {
          gh(["api", "-X", "PUT", `/repos/${repoFullName}/actions/workflows/${wf}/enable`], process.env);
          audit.note("re-enable", `${repoFullName}/${wf}`);
        } catch (err) {
          if (!/404|not found/i.test(String(err.message))) throw err;
          audit.note("re-enable-skip", `${repoFullName}/${wf} absent`);
        }
      }
    }
    const queuePath = path.join(REPO_ROOT, "state", "queue.jsonl");
    if (existsSync(queuePath)) {
      try {
        const queue = readFileSync(queuePath, "utf8").split("\n").filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const now = Date.now();
        let changed = false;
        for (const t of queue) {
          if (t.status === "in_progress" && t.updatedUtc && now - new Date(t.updatedUtc).getTime() > 40 * 60 * 1000) {
            t.updatedUtc = new Date().toISOString();
            changed = true;
          }
        }
        if (changed) {
          writeFileSync(queuePath, queue.map((t) => JSON.stringify(t)).join("\n") + "\n");
          audit.note("queue-recheck", "stale in_progress timestamps refreshed");
        }
      } catch (err) {
        audit.note("queue-recheck", `skipped: ${err.message.slice(0, 120)}`);
      }
    }

    const recentRuns = gh(["api", "/repos/M1Vj/fleet-control/actions/runs?per_page=5"], process.env);
    const runsList = (recentRuns.workflow_runs || [])
      .map((r) => `- ${r.name} ${r.status}/${r.conclusion} ${r.html_url}`)
      .join("\n");
    const issue = gh(
      [
        "api", "-X", "POST", "/repos/M1Vj/fleet-control/issues",
        "-f", `title=${plan.actions.find((a) => a.kind === "file-alert-issue").title}`,
        "-f", `body=Patrol heartbeat is stale (${plan.ageMinutes} minutes).\nRe-enable was attempted. Recent runs:\n${runsList}\n\nCheck model auth secret freshness and Actions quota.`,
      ],
      process.env,
    );
    await verifyIssueAuthor("M1Vj/fleet-control", issue.number, identity, process.env.FLEET_GH_TOKEN);
    audit.note("alert-issue", `#${issue.number}`);

    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), runId, "Watchdog", "ok-stale-recovered");
    if (gitHasChanges(REPO_ROOT, ["state", "audit"])) {
      gitAdd(REPO_ROOT, ["state", "audit"]);
      gitCommit(REPO_ROOT, `[fleet] watchdog ${runId}`, identity);
      gitPush(REPO_ROOT, "main", process.env);
      const sha = gitRevParse(REPO_ROOT, "HEAD");
      await verifyCommit("M1Vj/fleet-control", sha, identity, process.env.FLEET_GH_TOKEN);
      audit.note("push-verify", `attribution verified sha=${sha.slice(0, 10)}`);
    }
    console.log("FLEET_RUN_RESULT=" + JSON.stringify({ runId, status: "stale-recovered", issue: issue.number }));
    return 0;
  } catch (err) {
    const code = err.code && Number.isInteger(err.code) ? err.code : 1;
    audit.incident("fatal", err.message);
    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), runId, "Watchdog", `failed(${err.reason || code})`);
    console.error(`WATCHDOG_FAILED code=${code} reason=${err.reason || err.message}`);
    return code;
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const exitCode = await main();
  process.exit(exitCode);
}
