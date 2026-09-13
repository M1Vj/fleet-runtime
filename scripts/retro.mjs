#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh } from "./lib/util.mjs";
import { askModel } from "./lib/model.mjs";
import { verifyIssueAuthor } from "./lib/verify.mjs";
import { extractJsonObject } from "./lib/directives.mjs";
import {
  isPublicDataClass,
  makeExecutionTerminal,
  publicModelEnv,
  publicRepository,
  privateRepository,
  PRIVATE_REPOSITORY_ENV,
  resolveStateRoot,
  writeExecutionAudit,
  writePublicArtifact,
} from "./lib/private-state.mjs";

const REPO_ROOT = resolveStateRoot(process.env, process.cwd());

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

async function modePropose(audit) {
  const identity = await runGate(process.env);
  if (isPublicDataClass(process.env)) {
    const repo = publicRepository(process.env);
    const recentIssues = gh(["api", `/repos/${repo}/issues?state=all&per_page=20`], process.env) || [];
    const events = readEvents();
    const counts = {};
    for (const e of events) counts[e.state] = (counts[e.state] || 0) + 1;
    const result = await askModel({
      prompt: `Review public telemetry for ${repo}. Return ONLY strict JSON {"health_summary":"...","proposals":[{"title":"...","impact":"high|medium|low","effort":"small|medium|large","detail":"..."}]} with 3 to 6 proposals.\nCounts: ${JSON.stringify(counts)}\nRecent public issue titles: ${recentIssues.map((i) => i.title).filter(Boolean).slice(0, 20).join("; ")}`,
      timeoutMs: 480000,
      env: publicModelEnv(process.env),
      preferVariantMax: true,
      maxRounds: 3,
    });
    writePublicArtifact(process.env, {
      mode: "retro",
      status: result.complete && result.reply ? "ok" : "deferred",
      repository: repo,
      summary: result.complete && result.reply ? "public retrospective completed" : "model unavailable",
      count: events.length,
    }, { kind: "retro", status: result.complete && result.reply ? "ok" : "deferred", repository: repo });
    audit.note("public", `repo=${repo} events=${events.length} complete=${result.complete}`);
    return result.complete && result.reply ? 0 : 6;
  }
  const today = new Date().toISOString().slice(0, 10);
  const dedupeKey = `[RETRO] ${today}`;
  const controlRepository = privateRepository(process.env, PRIVATE_REPOSITORY_ENV.control);
  const recentIssues = gh(["api", `/repos/${controlRepository}/issues?since=${today}T00:00:00Z&state=all&per_page=50`], process.env) || [];
  if (recentIssues.some((i) => i.title && i.title.startsWith("[RETRO]"))) {
    audit.note("dedupe", "retro already filed today");
    try {
      makeExecutionTerminal(process.env, REPO_ROOT, { lane: "retro" })("NO-OP", { why: "retro-already-filed" });
    } catch {}
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

  let result = await askModel({
    prompt,
    timeoutMs: 480000,
    env: process.env,
    // Contributor tier: high thinking effort (maps to xhigh), never the max variant.
    preferVariantMax: true,
    maxRounds: 3,
  });
  if (!result.complete) {
    await new Promise((r) => setTimeout(r, 60000));
    result = await askModel({ prompt, timeoutMs: 480000, env: process.env, preferVariantMax: true, maxRounds: 3 });
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
  const issue = gh(["api", "-X", "POST", `/repos/${controlRepository}/issues`, "-f", `title=${dedupeKey}`, "-F", `body=${bodyLines.join("\n")}`], process.env);
  void identity;
  await verifyIssueAuthor(controlRepository, issue.number, identity, process.env.FLEET_GH_TOKEN);
  audit.note("issue", `#${issue.number}`);
  try {
    makeExecutionTerminal(process.env, REPO_ROOT, { lane: "retro" })("SUCCESS", { issue: issue.number, proposals: parsed.proposals.length });
  } catch {}
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
    writeExecutionAudit(audit, process.env, REPO_ROOT, `retro-${Date.now()}`, "Fleet retrospective", code === 0 ? "ok" : "failed");
    process.exit(code);
  } catch (err) {
    audit.incident("fatal", err.message);
    writeExecutionAudit(audit, process.env, REPO_ROOT, `retro-${Date.now()}`, "Fleet retrospective", `failed(${err.code || 1})`);
    console.error(`RETRO_FAILED reason=${err.reason || err.message}`);
    process.exit(err.code && Number.isInteger(err.code) ? err.code : 1);
  }
}
