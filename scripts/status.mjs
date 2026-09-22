#!/usr/bin/env node
import process from "node:process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { configureIdentity, safeCommitState, gitRevParse } from "./lib/util.mjs";
import { verifyCommit } from "./lib/verify.mjs";
import { renderStatusMd } from "./lib/status.mjs";
import {
  isPublicDataClass,
  makeExecutionTerminal,
  privateRepository,
  PRIVATE_REPOSITORY_ENV,
  publicRepository,
  resolveStateRoot,
  writeExecutionAudit,
  writePublicArtifact,
} from "./lib/private-state.mjs";

const REPO_ROOT = resolveStateRoot(process.env, process.cwd());

function readLines(p) {
  return existsSync(p) ? readFileSync(p, "utf8").split("\n") : [];
}

const identity = await runGate(process.env);
if (isPublicDataClass(process.env)) {
  const repository = publicRepository(process.env);
  writePublicArtifact(process.env, {
    mode: "status",
    status: "ok",
    repository,
    summary: "public status digest completed",
    checks: { privateState: "not-read", externalWrites: "blocked" },
  }, { kind: "status", status: "ok", repository });
  makeExecutionTerminal(process.env, REPO_ROOT, { lane: "status" })("SUCCESS", { repository });
  writeExecutionAudit({ entries: [], incidents: [] }, process.env, REPO_ROOT, `status-${Date.now()}`, "Status", "ok");
  console.log("STATUS_WRITTEN");
  process.exit(0);
}
configureIdentity(REPO_ROOT, identity);
const eventsLines = readLines(path.join(REPO_ROOT, "state", "events.jsonl"));
const md = renderStatusMd({
  eventsLines,
  mergesLines: readLines(path.join(REPO_ROOT, "state", "merges.jsonl")),
  heartbeat: existsSync(path.join(REPO_ROOT, "state", "heartbeat.json"))
    ? JSON.parse(readFileSync(path.join(REPO_ROOT, "state", "heartbeat.json"), "utf8"))
    : null,
  queueLines: readLines(path.join(REPO_ROOT, "state", "queue.jsonl")),
});
// The shared renderer only tabulates the five classic states; count the newer
// terminal states (REVISION_QUEUED / SCAN-DONE / SCAN-FAILED) here so the digest stays whole.
const extraStates = ["REVISION_QUEUED", "SCAN-DONE", "SCAN-FAILED", "SUCCESS", "BLOCKED", "EXHAUSTED", "STALLED", "NO-OP"];
const windowMs = 7 * 24 * 3600 * 1000;
const nowMs = Date.now();
const counts = Object.fromEntries(extraStates.map((s) => [s, 0]));
for (const l of eventsLines) {
  try {
    const e = JSON.parse(l);
    if (!e.t || !e.state || nowMs - Date.parse(e.t) > windowMs) continue;
    if (counts[e.state] !== undefined) counts[e.state] += 1;
  } catch {}
}
const extra = [
  "",
  `## All terminal states (last 7 days, incl. merge-gate states)`,
  "",
  `| state | count |`,
  `| --- | --- |`,
  ...extraStates.map((s) => `| ${s} | ${counts[s]} |`),
  "",
];
mkdirSync(path.join(REPO_ROOT, "docs"), { recursive: true });
writeFileSync(path.join(REPO_ROOT, "docs", "status.md"), md + extra.join("\n"));
const outcome = safeCommitState(REPO_ROOT, ["docs/status.md"], `[fleet] status digest ${new Date().toISOString().slice(0, 16)}`, identity, process.env);
if (outcome === "committed" && process.env.FLEET_STATE_ROOT) {
  // Attributable push: verify the digest commit landed under M1Vj in
  // private control repository. Enforced in CI (FLEET_STATE_ROOT set); skipped for local runs.
  const sha = gitRevParse(REPO_ROOT, "HEAD");
  await verifyCommit(privateRepository(process.env, PRIVATE_REPOSITORY_ENV.control), sha, identity, process.env.FLEET_GH_TOKEN);
  console.log(`STATUS_VERIFIED sha=${sha.slice(0, 10)}`);
}
console.log("STATUS_WRITTEN");
