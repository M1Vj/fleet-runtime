#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, gitAdd, gitCommit, gitPush, gitHasChanges, gitRevParse, configureIdentity } from "./lib/util.mjs";
import { planWatchdogActions, WATCHDOG_WORKFLOWS } from "./lib/watchdog-decide.mjs";
import {
  isPublicDataClass,
  makeExecutionTerminal,
  publicRepository,
  privateRepository,
  PRIVATE_REPOSITORY_ENV,
  resolveStateRoot,
  writeExecutionAudit,
  writePublicArtifact,
} from "./lib/private-state.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = resolveStateRoot(process.env, CODE_ROOT);

// Stale thresholds: a task stuck in_progress longer than this with attempts
// remaining is resumed (requeued to pending); one that already exhausted its
// attempts trips the breaker and is parked as stalled.
export const QUEUE_STALE_MS = 40 * 60 * 1000;
export const QUEUE_MAX_ATTEMPTS = 3;
export const ALERT_DEDUPE_MS = 6 * 3600 * 1000;

export function refreshQueue(tasks, nowMs = Date.now(), staleMs = QUEUE_STALE_MS, maxAttempts = QUEUE_MAX_ATTEMPTS) {
  let requeued = 0;
  let stalled = 0;
  for (const t of tasks || []) {
    if (!t || t.status !== "in_progress" || !t.updatedUtc) continue;
    const age = nowMs - Date.parse(t.updatedUtc);
    if (Number.isNaN(age) || age <= staleMs) continue;
    if ((t.attempts || 0) < maxAttempts) {
      t.status = "pending";
      t.attempts = (t.attempts || 0) + 1;
      t.updatedUtc = new Date(nowMs).toISOString();
      t.note = "watchdog-resume-stale";
      requeued++;
    } else {
      t.status = "stalled";
      t.updatedUtc = new Date(nowMs).toISOString();
      t.note = "watchdog-breaker-max-attempts";
      stalled++;
    }
  }
  return { requeued, stalled };
}

export function parseQueue(text) {
  return String(text || "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Avoid filing a [WATCHDOG] alert every 15 minutes while stale: skip when a
// recent open watchdog alert already exists.
export function recentWatchdogAlert(issues, nowMs = Date.now(), windowMs = ALERT_DEDUPE_MS) {
  for (const i of issues || []) {
    if (!i || i.state === "closed") continue;
    if (!String(i.title || "").startsWith("[WATCHDOG]")) continue;
    const created = Date.parse(i.created_at || "");
    if (!Number.isNaN(created) && nowMs - created < windowMs) return i;
  }
  return null;
}

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

    if (isPublicDataClass(process.env)) {
      const repo = publicRepository(process.env);
      const synthetic = { lastRunUtc: new Date().toISOString() };
      const plan = planWatchdogActions(synthetic, Date.now(), 90 * 60 * 1000, { dataClass: "public" });
      writePublicArtifact(process.env, { mode: "watchdog", status: "ok", repository: repo, reason: "public-read-only", checks: { stale: plan.stale, actions: plan.actions.length } }, { kind: "watchdog", status: "ok", repository: repo, runId });
      audit.note("public", `actions=${plan.actions.length}`);
      writeExecutionAudit(audit, process.env, REPO_ROOT, runId, "Watchdog", "ok");
      console.log(`FLEET_RUN_RESULT=${JSON.stringify({ runId, status: "public-read-only", actions: 0 })}`);
      return 0;
    }

    if (process.env.FLEET_WATCHDOG_DRY_RUN === "1") {
      const synthetic = { lastRunUtc: new Date(Date.now() - 4 * 3600 * 1000).toISOString() };
      const plan = planWatchdogActions(synthetic, Date.now(), 90 * 60 * 1000, {
        autoEnable: process.env.FLEET_WATCHDOG_AUTO_ENABLE !== "false",
      });
      const enables = plan.actions.filter((a) => a.kind === "enable-workflow").length;
      audit.note("dry-run", `stale=${plan.stale} enables=${enables} alert=${plan.alertIssue}`);
      for (const a of plan.actions) console.log(`WOULD ${a.kind} ${a.workflow || ""}`.trim());
      writeExecutionAudit(audit, process.env, REPO_ROOT, runId, "Watchdog dry-run", "ok");
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
    const autoEnable = process.env.FLEET_WATCHDOG_AUTO_ENABLE !== "false";
    const plan = planWatchdogActions(heartbeat, Date.now(), 90 * 60 * 1000, { autoEnable });
    audit.note("heartbeat", `decision=${plan.reason} ageMinutes=${plan.ageMinutes}`);
    const terminal = makeExecutionTerminal(process.env, REPO_ROOT, { lane: "watchdog" });

    if (!plan.stale) {
      writeExecutionAudit(audit, process.env, REPO_ROOT, runId, "Watchdog", "ok-fresh");
      console.log("FLEET_RUN_RESULT=" + JSON.stringify({ runId, status: "fresh", action: "none" }));
      return 0;
    }

    // Breaker tripped: patrol heartbeat is stale. Record STALLED first so the
    // outage is visible in the status digest even if recovery below fails.
    terminal("STALLED", { runId, why: plan.reason, ageMinutes: plan.ageMinutes });

    if (autoEnable) {
      const enablePlan = {
        "M1Vj/fleet-runtime": WATCHDOG_WORKFLOWS,
        [privateRepository(process.env, PRIVATE_REPOSITORY_ENV.control)]: WATCHDOG_WORKFLOWS,
      };
      const controlRepository = privateRepository(process.env, PRIVATE_REPOSITORY_ENV.control);
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
    } else {
      audit.note("re-enable-skipped", "FLEET_WATCHDOG_AUTO_ENABLE is false");
    }
    const queuePath = path.join(REPO_ROOT, "state", "queue.jsonl");
    let queueStats = { requeued: 0, stalled: 0 };
    if (existsSync(queuePath)) {
      try {
        const queue = parseQueue(readFileSync(queuePath, "utf8"));
        queueStats = refreshQueue(queue, Date.now());
        if (queueStats.requeued + queueStats.stalled > 0) {
          writeFileSync(queuePath, queue.map((t) => JSON.stringify(t)).join("\n") + "\n");
          audit.note("queue-resume", `requeued=${queueStats.requeued} breaker-stalled=${queueStats.stalled} (stale>40min, attempts<${QUEUE_MAX_ATTEMPTS} resume)`);
        } else {
          audit.note("queue-recheck", "no stale in_progress tasks");
        }
      } catch (err) {
        audit.note("queue-recheck", `skipped: ${err.message.slice(0, 120)}`);
      }
    }

    const recentRuns = gh(["api", `/repos/${controlRepository}/actions/runs?per_page=5`], process.env);
    const runsList = (recentRuns.workflow_runs || [])
      .map((r) => `- ${r.name} ${r.status}/${r.conclusion} ${r.html_url}`)
      .join("\n");
    let issueNumber = null;
    try {
      const openIssues = gh(["api", `/repos/${controlRepository}/issues?state=open&per_page=50`], process.env) || [];
      const dupe = recentWatchdogAlert(openIssues, Date.now());
      if (dupe) {
        audit.note("alert-dedupe", `open watchdog alert #${dupe.number} already exists, skipping new issue`);
      } else {
        const issue = gh(
          [
            "api", "-X", "POST", `/repos/${controlRepository}/issues`,
            "-f", `title=${plan.actions.find((a) => a.kind === "file-alert-issue").title}`,
            "-f", `body=Patrol heartbeat is stale (${plan.ageMinutes} minutes).\nRe-enable was attempted. Recent runs:\n${runsList}\n\nCheck model auth secret freshness and Actions quota.`,
          ],
          process.env,
        );
        await verifyIssueAuthor(controlRepository, issue.number, identity, process.env.FLEET_GH_TOKEN);
        audit.note("alert-issue", `#${issue.number}`);
        issueNumber = issue.number;
      }
    } catch (err) {
      audit.incident("alert-issue", `alert filing skipped: ${String(err.message).slice(0, 140)}`);
    }

    writeExecutionAudit(audit, process.env, REPO_ROOT, runId, "Watchdog", "ok-stale-recovered");
    if (gitHasChanges(REPO_ROOT, ["state", "audit"])) {
      gitAdd(REPO_ROOT, ["state", "audit"]);
      gitCommit(REPO_ROOT, `[fleet] watchdog ${runId}`, identity);
      gitPush(REPO_ROOT, "main", process.env);
      const sha = gitRevParse(REPO_ROOT, "HEAD");
      await verifyCommit(controlRepository, sha, identity, process.env.FLEET_GH_TOKEN);
      audit.note("push-verify", `attribution verified sha=${sha.slice(0, 10)}`);
    }
    console.log("FLEET_RUN_RESULT=" + JSON.stringify({ runId, status: "stale-recovered", issue: issueNumber, queue: queueStats }));
    terminal("SUCCESS", { runId, recovered: true, issue: issueNumber, ...queueStats });
    return 0;
  } catch (err) {
    const code = err.code && Number.isInteger(err.code) ? err.code : 1;
    audit.incident("fatal", err.message);
    writeExecutionAudit(audit, process.env, REPO_ROOT, runId, "Watchdog", `failed(${err.reason || code})`);
    console.error(`WATCHDOG_FAILED code=${code} reason=${err.reason || err.message}`);
    return code;
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const exitCode = await main();
  process.exit(exitCode);
}
