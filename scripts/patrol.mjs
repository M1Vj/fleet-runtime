#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, ghInput, putFileContent, ensureBranch, gitAdd, gitCommit, gitPush, gitHasChanges, gitRevParse, configureIdentity } from "./lib/util.mjs";
import { loadLedger, eventKey, has, append } from "./lib/ledger.mjs";
import { validateDirectives } from "./lib/directives.mjs";
import { askModel } from "./lib/model.mjs";
import { verifyCommit, verifyPullAuthor, verifyCommentAuthor, verifyIssueAuthor } from "./lib/verify.mjs";
import { makeTerminal } from "./lib/terminal.mjs";
import { shouldCoalesce } from "./lib/watchdog-decide.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = process.env.FLEET_STATE_ROOT ? path.resolve(process.env.FLEET_STATE_ROOT) : CODE_ROOT;
const AUDIT_DIR = path.join(REPO_ROOT, "audit");
const STATE_DIR = path.join(REPO_ROOT, "state");

function targetsPath() {
  return path.join(STATE_DIR, "targets.json");
}

function ledgerPath() {
  return path.join(STATE_DIR, "ledger.jsonl");
}

function heartbeatPath() {
  return path.join(STATE_DIR, "heartbeat.json");
}

function sessionsPath() {
  return path.join(STATE_DIR, "sessions.json");
}

function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

async function collectSignals(env, audit) {
  const repos = gh(["api", "/user/repos?affiliation=owner&per_page=100&sort=pushed"], env);
  audit.note("enumerate", `owned repos=${repos.length}`);
  const signals = [];
  for (const repo of repos) {
    const full = repo.full_name;
    try {
      const pulls = gh(["api", `/repos/${full}/pulls?state=open&per_page=20`], env) || [];
      const since = readJson(heartbeatPath(), {}).lastRunUtc || new Date(Date.now() - 26 * 3600 * 1000).toISOString();
      const issues = gh(
        ["api", `/repos/${full}/issues?state=open&since=${encodeURIComponent(since)}&per_page=30`],
        env,
      ) || [];
      const runsRaw = gh(["api", `/repos/${full}/actions/runs?status=failure&per_page=15`], env) || {};
      const runs = (runsRaw.workflow_runs || []).filter((r) => new Date(r.created_at) > Date.now() - 24 * 3600 * 1000);
      signals.push({
        repo: full,
        pushedAt: repo.pushed_at,
        openPulls: pulls.map((p) => ({ n: p.number, title: p.title, draft: p.draft, updated: p.updated_at })),
        activeIssues: issues.filter((i) => !i.pull_request).map((i) => ({ n: i.number, title: i.title, updated: i.updated_at })),
        failingRuns24h: runs.map((r) => ({ id: r.id, name: r.name, url: r.html_url, created: r.created_at })),
      });
    } catch (err) {
      audit.note("signal-error", `${full}: ${err.message}`);
      signals.push({ repo: full, error: err.message.slice(0, 200), openPulls: [], activeIssues: [], failingRuns24h: [] });
    }
  }
  return signals;
}

function buildDigest(signals, seen) {
  const fresh = [];
  for (const s of signals) {
    const f = {
      repo: s.repo,
      newPulls: s.openPulls.filter((p) => !has(seen, eventKey("sig-pr", s.repo, String(p.n), String(p.updated)))),
      newIssueActivity: s.activeIssues.filter((i) => !has(seen, eventKey("sig-issue", s.repo, String(i.n), String(i.updated)))),
      failingRuns: s.failingRuns24h.filter((r) => !has(seen, eventKey("sig-run", s.repo, String(r.id), String(r.created)))),
    };
    if (f.newPulls.length + f.newIssueActivity.length + f.failingRuns.length > 0) fresh.push(f);
  }
  return JSON.stringify(fresh, null, 1).slice(0, 38000);
}

function buildPrompt(digest) {
  return [
    "You are the fleet triage brain for GitHub user M1Vj. Analyze the digest of repository signals below.",
    "Your ENTIRE reply must be exactly one strict JSON array of directive objects and nothing else — no prose, no markdown fences, no code, no examples. Allowed kinds:",
    '{"kind":"report","section":"triage|security|standards|docs|testing|redteam","text":"..."}',
    '{"kind":"comment","repo":"owner/name","target":"issue|pr","number":N,"body":"..."}',
    '{"kind":"label","repo":"owner/name","target":"issue|pr","number":N,"labels":["..."]}',
    '{"kind":"draft_pr","repo":"owner/name","title":"...","body":"...","branch":"fleet/<kebab>","files":[{"path":"docs/... or scripts/... etc","content":"..."}]}',
    '{"kind":"noop","reason":"..."}',
    "Rules: prioritize security > broken CI > stale PR review comments > standards/docs/testing findings.",
    "Never propose direct pushes to default branches; draft_pr files only under docs/, src/, scripts/, tests/, .github/workflows/<name>.yml.",
    "Keep total under 25 directives; prefer report entries summarizing minor items.",
    "Digest:",
    digest,
  ].join("\n");
}

function eligible(targets, repo) {
  if ((targets.excluded || []).includes(repo)) return false;
  if (targets.allOwned === true) return true;
  return (targets.tier1 || []).includes(repo);
}

const DEEP_KINDS = ["security-audit", "redteam", "code-review", "docs-audit"];

function enqueueDeepTasks(signals) {
  const queuePath = path.join(STATE_DIR, "queue.jsonl");
  const existing = existsSync(queuePath)
    ? readFileSync(queuePath, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const openCount = existing.filter((t) => t.status === "pending" || t.status === "in_progress").length;
  if (openCount >= 12) return 0;
  const pendingKeys = new Set(existing.filter((t) => t.status === "pending" || t.status === "in_progress").map((t) => `${t.repo}|${t.kind}`));
  const doneToday = new Set(
    existing
      .filter((t) => t.status === "done" && (t.updatedUtc || "").slice(0, 10) === new Date().toISOString().slice(0, 10))
      .map((t) => `${t.repo}|${t.kind}`),
  );
  const additions = [];
  let kindIdx = existing.length % DEEP_KINDS.length;
  for (const s of signals) {
    const hasSignal = (s.openPulls && s.openPulls.length > 0) || (s.failingRuns24h && s.failingRuns24h.length > 0);
    if (!hasSignal) continue;
    const kind = DEEP_KINDS[kindIdx % DEEP_KINDS.length];
    kindIdx += 1;
    const key = `${s.repo}|${kind}`;
    if (pendingKeys.has(key) || doneToday.has(key)) continue;
    additions.push({ id: `deep-${Date.now()}-${additions.length}`, kind, repo: s.repo, status: "pending", attempts: 0, createdUtc: new Date().toISOString(), updatedUtc: new Date().toISOString() });
    if (additions.length >= 10) break;
  }
  if (additions.length > 0) {
    appendFileSync(queuePath, additions.map((t) => JSON.stringify(t)).join("\n") + "\n");
  }
  return additions.length;
}

async function executeDirectives(env, identity, directives, targets, audit) {
  let mutations = 0;
  const results = [];
  for (const d of directives) {
    try {
      if (d.kind === "report") {
        results.push({ kind: d.kind, ok: true, note: d.section });
      } else if (d.kind === "fleet_issue") {
        const created = gh(["api", "-X", "POST", "/repos/M1Vj/fleet-control/issues", "-f", `title=${d.title}`, "-f", `body=${d.body}`], env);
        await verifyIssueAuthor("M1Vj/fleet-control", created.number, identity, env.FLEET_GH_TOKEN);
        mutations += 1;
        results.push({ kind: d.kind, ok: true, issue: created.number });
      } else if (d.kind === "comment" || d.kind === "label") {
        if (!eligible(targets, d.repo)) {
          results.push({ kind: d.kind, ok: true, downgraded: `${d.repo} not tier1` });
          continue;
        }
        if (d.kind === "comment") {
          const created = gh(["api", "-X", "POST", `/repos/${d.repo}/issues/${d.number}/comments`, "-f", `body=${d.body}`], env);
          await verifyCommentAuthor(d.repo, created.id, identity, env.FLEET_GH_TOKEN);
          mutations += 1;
          results.push({ kind: d.kind, ok: true, commentId: created.id });
        } else {
          for (const label of d.labels) {
            try {
              gh(["api", "-X", "POST", `/repos/${d.repo}/issues/${d.number}/labels`, "-f", `labels[]=${label}`], env);
            } catch {
              gh(["api", "-X", "POST", `/repos/${d.repo}/labels`, "-f", `name=${label}`, "-f", "color=ededed"], env);
              gh(["api", "-X", "POST", `/repos/${d.repo}/issues/${d.number}/labels`, "-f", `labels[]=${label}`], env);
            }
          }
          mutations += 1;
          results.push({ kind: d.kind, ok: true });
        }
      } else if (d.kind === "draft_pr") {
        if (!eligible(targets, d.repo)) {
          results.push({ kind: d.kind, ok: true, downgraded: `${d.repo} not tier1` });
          continue;
        }
        const meta = gh(["api", `/repos/${d.repo}`], env);
        const base = meta.default_branch;
        const refData = gh(["api", `/repos/${d.repo}/git/ref/heads/${base}`], env);
        const baseSha = refData.object.sha;
        const branch = d.branch;
        ensureBranch(d.repo, branch, baseSha, env);
        for (const file of d.files) {
          putFileContent(d.repo, file.path, file.content, branch, `[fleet] add ${file.path}`, env);
        }
        const pr = ghInput(
          ["api", "-X", "POST", `/repos/${d.repo}/pulls`],
          { title: d.title, body: d.body, head: branch, base, draft: true },
          env,
        );
        await verifyPullAuthor(d.repo, pr.number, identity, env.FLEET_GH_TOKEN);
        mutations += 1;
        results.push({ kind: d.kind, ok: true, pr: pr.number });
      } else {
        results.push({ kind: d.kind, ok: true });
      }
    } catch (err) {
      audit.incident("executor", `directive failed ${d.kind} on ${d.repo || "fleet"}`, { error: String(err.message).slice(0, 300) });
      results.push({ kind: d.kind, ok: false, error: String(err.message).slice(0, 160) });
    }
  }
  const failedCount = results.filter((r) => r.ok === false).length;
  if (failedCount > 0) audit.note("executor-summary", `${failedCount} directive(s) failed but run continued`);
  return { mutations, results };
}

export async function main() {
  const runId = `patrol-${Date.now()}`;
  const redact = scrub(process.env);
  const audit = new AuditBuffer(redact);
  let identity = null;
  let status = "failed";
  try {
    identity = await runGate(process.env);
    configureIdentity(REPO_ROOT, identity);
    const terminal = makeTerminal(REPO_ROOT, { lane: "patrol", requireWrite: true });
    audit.note("gate", `identity=${identity.login} id=${identity.id} scopes=${identity.scopes.join(",")}`);

    const gwRoot = process.env.FLEET_STATE_ROOT || REPO_ROOT;
    const { gatewayDown } = await import("./lib/gateway-health.mjs");
    if (gatewayDown(gwRoot)) {
      terminal("STALLED", { runId, why: "gateway-circuit-open" });
      console.log(`FLEET_RUN_RESULT=${JSON.stringify({ runId, status: "skipped-gateway-down" })}`);
      return 0;
    }

    const trigger = process.env.FLEET_TRIGGER || "manual";
    const heartbeatPre = readJson(heartbeatPath(), {});
    const coalesce = shouldCoalesce(trigger, heartbeatPre.lastRunUtc);
    audit.note("cadence", `trigger=${trigger} gapMinutes=${coalesce.gapMinutes}`);
    if (coalesce.gapMinutes !== null && coalesce.gapMinutes > 30) audit.note("cadence-drift", `gap ${coalesce.gapMinutes}min exceeds 30min bound`);
    if (coalesce.coalesce) {
      terminal("NO-OP", { runId, coalesced: true, gapMinutes: coalesce.gapMinutes });
      console.log(`FLEET_RUN_RESULT=${JSON.stringify({ runId, status: "coalesced", gapMinutes: coalesce.gapMinutes })}`);
      return 0;
    }

    const targets = readJson(targetsPath(), { tier1: [], excluded: [], observeAll: true });
    const seen = loadLedger(ledgerPath());
    audit.note("state", `ledger keys=${seen.size} tier1=${targets.tier1.length}`);

    const signals = await collectSignals(process.env, audit);
    const digest = buildDigest(signals, seen);
    audit.note("digest", `fresh signal groups bytes=${digest.length}`);

    let directives = [];
    let modelMode = "skipped-empty-digest";
    if (digest !== "[]") {
      const modelResult = await askModel({
        prompt: buildPrompt(digest),
        timeoutMs: 480000,
        env: process.env,
        sessionId: undefined,
      });
      modelMode = modelResult.modelMode;
      audit.note("model", `mode=${modelMode} complete=${modelResult.complete} attempts=${JSON.stringify(modelResult.attempts)} session=${modelResult.sessionId ? "captured" : "none"}`);
      if (modelResult.sessionId) {
        const sessions = readJson(sessionsPath(), {});
        sessions[runId] = { sessionId: modelResult.sessionId, updatedAt: new Date().toISOString() };
        writeFileSync(sessionsPath(), JSON.stringify(sessions, null, 2));
      }
      if (!modelResult.complete || !modelResult.reply) {
        throw Object.assign(new Error("MODEL_UNAVAILABLE after resume attempts"), { code: 6, reason: "MODEL_UNAVAILABLE" });
      }
      let validation = validateDirectives(modelResult.reply);
      if (!validation.ok && modelResult.sessionId) {
        audit.note("validator", "repair round requested");
        const repair = await askModel({
          prompt: "Your previous reply was rejected because it was not a bare JSON array matching the directive schema. Re-output ONLY the strict JSON array now — no prose, no fences, no code.",
          sessionId: modelResult.sessionId,
          timeoutMs: 300000,
          env: process.env,
          preferVariantMax: false,
        });
        audit.note("repair", `complete=${repair.complete} gotReply=${Boolean(repair.reply)}`);
        if (repair.complete && repair.reply) validation = validateDirectives(repair.reply);
      }
      if (!validation.ok) {
        audit.incident("validator", "model output rejected", { errors: validation.errors.slice(0, 10) });
        throw Object.assign(new Error("DIRECTIVES_REJECTED"), { code: 5 });
      }
      directives = validation.directives;
      audit.note("validator", `directives accepted=${directives.length}`);
    }

    const { mutations, results } = await executeDirectives(process.env, identity, directives, targets, audit);
    audit.note("executor", `mutations=${mutations}`);

    for (const group of signals) {
      for (const p of group.openPulls || []) append(ledgerPath(), eventKey("sig-pr", group.repo, String(p.n), String(p.updated)), {});
      for (const i of group.activeIssues || []) append(ledgerPath(), eventKey("sig-issue", group.repo, String(i.n), String(i.updated)), {});
      for (const r of group.failingRuns24h || []) append(ledgerPath(), eventKey("sig-run", group.repo, String(r.id), String(r.created)), {});
    }

    writeFileSync(
      heartbeatPath(),
      JSON.stringify({ lastRunUtc: new Date().toISOString(), runId, modelMode, reposSeen: signals.length, mutations }, null, 2),
    );

    const auditFileRel = path.relative(REPO_ROOT, audit.writeMarkdown(AUDIT_DIR, runId, "Patrol run", "ok"));
    status = "ok";
    const state = status === "ok" ? "SUCCESS" : "NO-OP";
    terminal(state, { runId, modelMode, mutations, trigger });

    enqueueDeepTasks(signals);
    audit.note("deep-queue", `tasks enqueued (rotation)`);

    if (gitHasChanges(REPO_ROOT, ["state", "audit"])) {
      gitAdd(REPO_ROOT, ["state", "audit"]);
      gitCommit(REPO_ROOT, `[fleet] patrol ${runId}`, identity);
      gitPush(REPO_ROOT, "main", process.env);
      const sha = gitRevParse(REPO_ROOT, "HEAD");
      await verifyCommit("M1Vj/fleet-control", sha, identity, process.env.FLEET_GH_TOKEN);
      audit.note("push-verify", `attribution verified sha=${sha.slice(0, 10)}`);
      try {
        gh(["workflow", "run", "deep.yml", "-R", "M1Vj/fleet-control", "-f", "workers=3"], process.env);
        audit.note("deep-dispatch", "deep.yml dispatched");
      } catch (err) {
        audit.note("deep-dispatch", `dispatch skipped: ${err.message.slice(0, 120)}`);
      }
    } else {
      audit.writeMarkdown(AUDIT_DIR, runId, "Patrol run", "ok-no-changes");
      status = "ok-no-changes";
    }

    let patrolsSince = Number(heartbeatPre.patrolsSinceSelftest || 0);
    if (status === "ok") {
      patrolsSince += 1;
      if (patrolsSince >= 5) {
        try {
          gh(["workflow", "run", "selftest.yml", "-R", "M1Vj/fleet-runtime"], process.env);
          patrolsSince = 0;
          audit.note("selftest-dispatch", "every-5-patrols cadence");
        } catch (err) {
          audit.note("selftest-dispatch", `failed: ${err.message.slice(0, 100)}`);
        }
      }
      writeFileSync(
        heartbeatPath(),
        JSON.stringify({ ...(readJson(heartbeatPath(), {})), patrolsSinceSelftest: patrolsSince }, null, 2),
      );
    }
    console.log(`FLEET_RUN_RESULT=${JSON.stringify({ runId, status, modelMode, directives: directives.length, mutations, auditFile: auditFileRel })}`);
    return 0;
  } catch (err) {
    const code = err.code && Number.isInteger(err.code) ? err.code : 1;
    if (code === 5) audit.incident("fatal", err.message);
    else audit.incident("fatal", err.message);
    audit.writeMarkdown(AUDIT_DIR, runId, "Patrol run", `failed(${err.reason || code})`);
    console.error(`PATROL_FAILED code=${code} reason=${err.reason || err.message}`);
    terminal(err.reason === "MODEL_UNAVAILABLE" ? "EXHAUSTED" : "BLOCKED", { runId, code, trigger });
    if (identity && gitHasChanges(REPO_ROOT, ["audit"])) {
      try {
        gitAdd(REPO_ROOT, ["audit"]);
        gitCommit(REPO_ROOT, `[fleet] patrol-failure-audit ${runId}`, identity);
        gitPush(REPO_ROOT, "main", process.env);
      } catch {
        /* best-effort failure audit */
      }
    }
    return code;
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const exitCode = await main();
  process.exit(exitCode);
}
