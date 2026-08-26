#!/usr/bin/env node
import process from "node:process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { safeCommitState, scrub, gh } from "./lib/util.mjs";
import { askModel } from "./lib/model.mjs";
import { verifyIssueAuthor } from "./lib/verify.mjs";
import { extractJsonObject } from "./lib/directives.mjs";
import {
  consolidatePatterns,
  renderRepoMemoryPage,
} from "./lib/fleet-memory.mjs";

const REPO_ROOT = process.env.FLEET_STATE_ROOT || process.cwd();

function readEvents() {
  const p = path.join(REPO_ROOT, "state", "events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(-200);
}

function readJsonlTolerant(fileName) {
  const p = path.join(REPO_ROOT, "state", fileName);
  if (!existsSync(p)) return [];
  return String(readFileSync(p, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        const parsed = JSON.parse(l);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null; // skip malformed lines
      }
    })
    .filter(Boolean);
}

function toPatternEvents(laneEvents, prMemoryEvents) {
  const mapped = [];
  for (const e of laneEvents) {
    mapped.push({
      lane: String(e.mode || e.lane || "lane").slice(0, 32),
      state: String(e.state || "").slice(0, 64),
      reason: String(e.why || e.reason || e.summary || ""),
      repo: String(e.repo || "").slice(0, 120),
    });
  }
  for (const e of prMemoryEvents) {
    mapped.push({
      lane: String(e.lane || "lane").slice(0, 32),
      state: String(e.state || "").slice(0, 64),
      reason: String(e.summary || ""),
      repo: String(e.repo || "").slice(0, 120),
    });
  }
  return mapped;
}

/**
 * Deterministic consolidation pass: rebuild the "## Patterns" section of
 * UNIVERSAL.md from events.jsonl + pr-memory.jsonl. Best-effort — a memory
 * failure is an audit note and never fails the retro lane.
 */
function consolidateUniversalMemory(audit, identity) {
  try {
    const memoryDir = path.join(REPO_ROOT, "state", "memory");
    const universalPath = path.join(memoryDir, "UNIVERSAL.md");
    const existing = existsSync(universalPath)
      ? String(readFileSync(universalPath, "utf8"))
      : renderRepoMemoryPage("fleet", {
        title: "Universal Fleet Memory",
        description: "Fleet-wide operational learnings shared across lanes and repositories.",
      });
    const headingIdx = existing.indexOf("## Patterns");
    const head = headingIdx === -1 ? existing : existing.slice(0, headingIdx);
    const patternEvents = toPatternEvents(readJsonlTolerant("events.jsonl"), readJsonlTolerant("pr-memory.jsonl"));
    const rebuilt = `${head.replace(/\s*$/, "")}\n\n${consolidatePatterns(patternEvents)}`;
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(universalPath, rebuilt, "utf8");
    const outcome = safeCommitState(REPO_ROOT, ["state"], "[fleet] retro consolidate universal memory patterns", identity, process.env);
    audit.note("memory", `patterns rebuilt events=${patternEvents.length} commit=${outcome}`);
    return true;
  } catch (error) {
    audit.note("memory", `universal patterns rebuild skipped: ${String(error.message || error).slice(0, 160)}`);
    return false;
  }
}

async function modePropose(audit) {
  const identity = await runGate(process.env);
  consolidateUniversalMemory(audit, identity);
  const today = new Date().toISOString().slice(0, 10);
  const dedupeKey = `[RETRO] ${today}`;
  const recentIssues = gh(["api", `/repos/M1Vj/fleet-control/issues?since=${today}T00:00:00Z&state=all&per_page=50`], process.env) || [];
  if (recentIssues.some((i) => i.title && i.title.startsWith("[RETRO]"))) {
    audit.note("dedupe", "retro already filed today");
    console.log("RETRO_STATE=NO-OP");
    return 0;
  }

  const events = readEvents();
  const counts = {};
  for (const e of events) counts[e.state] = (counts[e.state] || 0) + 1;
  const failureSamples = events.filter((e) => e.state === "BLOCKED" || e.state === "EXHAUSTED").slice(-15);

  const auditDir = path.join(REPO_ROOT, "audit");
  const recentAudits = [];
  if (existsSync(auditDir)) {
    const days = readdirSafe(auditDir).sort().slice(-2);
    for (const d of days) {
      for (const f of readdirSafe(path.join(auditDir, d)).slice(0, 40)) recentAudits.push(`${d}/${f}`);
    }
  }

  const digest = [
    `Terminal-state counts (last ${events.length}): ${JSON.stringify(counts)}`,
    "Recent non-success samples:",
    ...failureSamples.map((e) => `- ${e.t} ${e.state} ${e.mode || e.repo || ""} ${e.why || e.reason || ""}`.trim()),
    "",
    `Recent audit files (${recentAudits.length}):`,
    recentAudits.slice(0, 60).join("\n"),
  ].join("\n");

  const prompt = [
    "You are the fleet RETROSPECTIVE agent. Analyze the automation loop's own telemetry below.",
    "Identify the highest-leverage improvements to the LOOP ITSELF: recurring failure causes, flaky lanes, wasted minutes, missing verifications, cadence tuning, better guardrails.",
    'Return ONLY strict JSON: {"health_summary":"...","proposals":[{"title":"...","impact":"high|medium|low","effort":"small|medium|large","detail":"concrete change"}]} with 3 to 6 proposals.',
    "Telemetry:",
    digest.slice(0, 30000),
  ].join("\n");

  let result = await askModel({ prompt, timeoutMs: 480000, env: process.env, preferVariantMax: true, maxRounds: 3 });
  if (!result.complete) {
    await new Promise((r) => setTimeout(r, 60000));
    result = await askModel({ prompt, timeoutMs: 480000, env: process.env, preferVariantMax: false, maxRounds: 3 });
  }
  audit.note("propose", `complete=${result.complete}`);
  if (!result.complete || !result.reply) throw Object.assign(new Error("MODEL_UNAVAILABLE"), { code: 6, reason: "MODEL_UNAVAILABLE" });

  let parsed;
  try {
    parsed = extractJsonObject(result.reply);
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.proposals) || parsed.proposals.length === 0) {
    audit.note("parse", "no usable proposals; filing raw notes");
    parsed = { health_summary: String(result.reply).slice(0, 1500), proposals: [] };
  }

  const bodyLines = [
    "## Fleet retrospective",
    "",
    `**Health:** ${String(parsed.health_summary || "").slice(0, 1200)}`,
    "",
    "**Proposals:**",
    ...parsed.proposals.map(
      (p2, i) => `${i + 1}. **${p2.title}** (impact ${p2.impact}, effort ${p2.effort})\n   ${String(p2.detail || "").slice(0, 500)}`,
    ),
    "",
    `_telemetry basis: ${events.length} terminal events; auto-filed by fleet-retro_`,
  ];
  const issue = gh(["api", "-X", "POST", "/repos/M1Vj/fleet-control/issues", "-f", `title=${dedupeKey}`, "-F", `body=${bodyLines.join("\n")}`], process.env);
  void identity;
  await verifyIssueAuthor("M1Vj/fleet-control", issue.number, identity, process.env.FLEET_GH_TOKEN);
  audit.note("issue", `#${issue.number}`);
  console.log(`RETRO_STATE=SUCCESS issue=${issue.number}`);
  return 0;

  function readdirSafe(d) {
    try {
      return fsMod.readdirSync(d);
    } catch {
      return [];
    }
  }
}

import * as fsMod from "node:fs";

const MODES = { propose: modePropose };

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const mode = process.env.FLEET_RETRO_MODE || "propose";
  const audit = new AuditBuffer(scrub(process.env));
  try {
    const code = await MODES[mode](audit);
    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), `retro-${Date.now()}`, "Fleet retrospective", code === 0 ? "ok" : "failed");
    process.exit(code);
  } catch (err) {
    audit.incident("fatal", err.message);
    audit.writeMarkdown(path.join(REPO_ROOT, "audit"), `retro-${Date.now()}`, "Fleet retrospective", `failed(${err.code || 1})`);
    console.error(`RETRO_FAILED reason=${err.reason || err.message}`);
    process.exit(err.code && Number.isInteger(err.code) ? err.code : 1);
  }
}
