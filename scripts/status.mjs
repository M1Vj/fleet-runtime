#!/usr/bin/env node
import process from "node:process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { configureIdentity, safeCommitState } from "./lib/util.mjs";
import { renderStatusMd } from "./lib/status.mjs";

const REPO_ROOT = process.env.FLEET_STATE_ROOT || process.cwd();

function readLines(p) {
  return existsSync(p) ? readFileSync(p, "utf8").split("\n") : [];
}

const identity = await runGate(process.env);
configureIdentity(REPO_ROOT, identity);
const md = renderStatusMd({
  eventsLines: readLines(path.join(REPO_ROOT, "state", "events.jsonl")),
  mergesLines: readLines(path.join(REPO_ROOT, "state", "merges.jsonl")),
  heartbeat: existsSync(path.join(REPO_ROOT, "state", "heartbeat.json"))
    ? JSON.parse(readFileSync(path.join(REPO_ROOT, "state", "heartbeat.json"), "utf8"))
    : null,
  queueLines: readLines(path.join(REPO_ROOT, "state", "queue.jsonl")),
});
mkdirSync(path.join(REPO_ROOT, "docs"), { recursive: true });
writeFileSync(path.join(REPO_ROOT, "docs", "status.md"), md);
safeCommitState(REPO_ROOT, ["docs/status.md"], `[fleet] status digest ${new Date().toISOString().slice(0, 16)}`, identity, process.env);
console.log("STATUS_WRITTEN");
