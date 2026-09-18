#!/usr/bin/env node
import process from "node:process";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { runGate } from "./lib/gate.mjs";
import { AuditBuffer } from "./lib/audit.mjs";
import { scrub, gh, ghInput, putFileContent, ensureBranch, gitAdd, gitCommit, gitPush, gitHasChanges, gitRevParse, configureIdentity } from "./lib/util.mjs";
import { eventKey, append } from "./lib/ledger.mjs";
import { validateDirectives } from "./lib/directives.mjs";
import { askModel } from "./lib/model.mjs";
import { verifyCommit, verifyPullAuthor, verifyCommentAuthor, verifyIssueAuthor } from "./lib/verify.mjs";
import { shouldCoalesce } from "./lib/watchdog-decide.mjs";
import {
  isPublicDataClass,
  makeExecutionTerminal,
  publicModelEnv,
  publicRepository,
  publicTargetDecision,
  privateRepository,
  PRIVATE_REPOSITORY_ENV,
  resolveStateRoot,
  writeExecutionAudit,
  writePublicArtifact,
} from "./lib/private-state.mjs";

const CODE_ROOT = process.cwd();
const REPO_ROOT = resolveStateRoot(process.env, CODE_ROOT);
const AUDIT_DIR = path.join(REPO_ROOT, "audit");
const STATE_DIR = path.join(REPO_ROOT, "state");
const DAY_MS = 24 * 60 * 60 * 1000;
export const PATROL_REVISIT_TTL_MS = DAY_MS;
export const DEEP_QUEUE_CAP = 100;
export const DEEP_QUEUE_ADDITION_CAP = 10;
export const PATROL_MAX_STATE_PUSHES = 2;
export const DEEP_WORKFLOW_REPO = "M1Vj/fleet-runtime";

export function boundedPatrolScopes(identity) {
  return Array.isArray(identity?.scopes) ? identity.scopes : [];
}

/**
 * Public patrol failures are telemetry only: never echo provider errors,
 * paths, or other untrusted detail. Private patrol retains a bounded reason
 * for operator diagnosis.
 */
export function patrolFailureReason(error, env = process.env) {
  let publicMode = false;
  try {
    publicMode = isPublicDataClass(env);
  } catch {
    // An invalid data-class must fail closed; use the public-safe message.
    publicMode = true;
  }
  if (publicMode) return "public patrol failed";
  return String(error?.reason || error?.message || "unknown").slice(0, 200);
}

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

function loadPatrolSession() {
  if (isPublicDataClass(process.env) || process.env.GITHUB_ACTIONS === "true" || process.env.CI === "true") return "";
  const data = readJson(sessionsPath(), {});
  const row = data?.["patrol-latest"];
  if (!row || typeof row !== "object") return "";
  const sessionId = typeof row.sessionId === "string" ? row.sessionId : "";
  const updated = Date.parse(String(row.updatedAt || ""));
  return /^[A-Za-z0-9._:-]{1,160}$/.test(sessionId)
    && Number.isFinite(updated)
    && Date.now() - updated <= 24 * 60 * 60 * 1000
    ? sessionId
    : "";
}

function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function parseTimestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveNow(value = Date.now()) {
  const parsed = parseTimestamp(value);
  return parsed === null ? Date.now() : parsed;
}

function boundedTtl(value = PATROL_REVISIT_TTL_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return PATROL_REVISIT_TTL_MS;
  return Math.min(parsed, 7 * DAY_MS);
}

function ledgerTime(value) {
  if (value && typeof value === "object") {
    return parseTimestamp(value.t ?? value.timestamp ?? value.seenAt ?? value.updatedAt);
  }
  return parseTimestamp(value);
}

export function loadPatrolLedger(filePath) {
  const entries = new Map();
  if (!existsSync(filePath)) return entries;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (!row || typeof row.k !== "string") continue;
      const observedAt = ledgerTime(row);
      const previous = entries.get(row.k);
      if (!entries.has(row.k) || (observedAt !== null && (previous === null || observedAt >= previous))) {
        entries.set(row.k, observedAt);
      }
    } catch {
      // Ignore malformed historical rows while preserving valid ledger entries.
    }
  }
  return entries;
}

function observedLedgerTime(seen, key) {
  if (seen instanceof Map) {
    return seen.has(key) ? ledgerTime(seen.get(key)) : undefined;
  }
  if (seen instanceof Set) return seen.has(key) ? null : undefined;
  if (Array.isArray(seen)) {
    const row = seen.find((entry) => entry && typeof entry.k === "string" && entry.k === key);
    return row ? ledgerTime(row) : undefined;
  }
  if (seen && typeof seen === "object") {
    if (typeof seen.has === "function" && !seen.has(key)) return undefined;
    if (Object.prototype.hasOwnProperty.call(seen, key)) return ledgerTime(seen[key]);
    if (typeof seen.has === "function") return null;
  }
  return undefined;
}

function shouldIncludeSignal(seen, key, now, revisitTtlMs) {
  const observedAt = observedLedgerTime(seen, key);
  if (observedAt === undefined || observedAt === null) return observedAt === undefined;
  return now - observedAt >= revisitTtlMs;
}

function activityTimestamp(item) {
  return parseTimestamp(
    item?.opened
      ?? item?.opened_at
      ?? item?.created
      ?? item?.created_at
      ?? item?.updated
      ?? item?.updated_at,
  ) ?? 0;
}

function pullPriority(item, seen, key, now, revisitTtlMs) {
  const ageMs = Math.max(0, now - activityTimestamp(item));
  const observedAt = observedLedgerTime(seen, key);
  const overdueMs = observedAt === undefined || observedAt === null
    ? 0
    : Math.max(0, now - observedAt - revisitTtlMs);
  return ageMs + (overdueMs * 2);
}

// Exit-code taxonomy (surfaced, never hidden): 2 kill-switch, 3 identity,
// 4 scope, 5 rejected directives, 6 model-unavailable. Gateway outage and
// validator exhaustion must exit 6/5, never 0 with a neutral pass.
// Kill-switch re-check: runGate enforces it at startup, but a STOP may land
// mid-run. All GitHub API mutations must consult this first; state/audit
// bookkeeping commits remain allowed so the halt itself is observable.
function killSwitchEngaged() {
  if (isPublicDataClass(process.env)) return false;
  const p = process.env.FLEET_KILL_SWITCH_PATH || path.join(REPO_ROOT, "state", "KILL_SWITCH");
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

export async function collectSignals(env, audit, options = {}) {
  const ghCall = options.gh || gh;
  const publicTarget = isPublicDataClass(env) ? publicRepository(env) : "";
  let repos;
  try {
    repos = isPublicDataClass(env)
      ? [ghCall(["api", `/repos/${publicTarget}`], env)]
      : ghCall(["api", "/user/repos?affiliation=owner&per_page=100&sort=pushed"], env);
  } catch (err) {
    if (!isPublicDataClass(env)) throw err;
    audit.note("signal-error", "public target metadata read failed");
    return [{ repo: publicTarget, error: "public target metadata read failed", openPulls: [], activeIssues: [], failingRuns24h: [] }];
  }
  audit.note("enumerate", `owned repos=${repos.length}`);
  const signals = [];
  for (const repo of repos) {
    if (isPublicDataClass(env)) {
      const decision = publicTargetDecision(repo);
      if (!decision.ok || decision.repository !== publicTarget) {
        audit.note("signal-error", "public target metadata rejected");
        signals.push({ repo: publicTarget, error: "PUBLIC_TARGET_NOT_PUBLIC", openPulls: [], activeIssues: [], failingRuns24h: [] });
        continue;
      }
    }
    const full = isPublicDataClass(env) ? publicTarget : repo.full_name || "";
    try {
      const pulls = ghCall(["api", `/repos/${full}/pulls?state=open&per_page=20`], env) || [];
      const since = readJson(heartbeatPath(), {}).lastRunUtc || new Date(Date.now() - 26 * 3600 * 1000).toISOString();
      const issues = ghCall(
        ["api", `/repos/${full}/issues?state=open&since=${encodeURIComponent(since)}&per_page=30`],
        env,
      ) || [];
      const runsRaw = ghCall(["api", `/repos/${full}/actions/runs?status=failure&per_page=15`], env) || {};
      const runs = (runsRaw.workflow_runs || []).filter((r) => new Date(r.created_at) > Date.now() - 24 * 3600 * 1000);
      signals.push({
        repo: full,
        pushedAt: repo.pushed_at,
        openPulls: pulls.map((p) => ({
          n: p.number,
          title: p.title,
          draft: p.draft,
          updated: p.updated_at,
          headSha: p.head?.sha || null,
          ...(p.created_at ? { created: p.created_at } : {}),
        })),
        activeIssues: issues.filter((i) => !i.pull_request).map((i) => ({ n: i.number, title: i.title, updated: i.updated_at })),
        failingRuns24h: runs.map((r) => ({ id: r.id, name: r.name, url: r.html_url, created: r.created_at })),
      });
    } catch (err) {
      const detail = isPublicDataClass(env)
        ? "public signal read failed"
        : String(err?.message || err).slice(0, 200);
      audit.note("signal-error", `${full}: ${detail}`);
      signals.push({ repo: full, error: detail, openPulls: [], activeIssues: [], failingRuns24h: [] });
    }
  }
  return signals;
}

export function buildDigest(signals, seen, options = {}) {
  const now = resolveNow(options.now);
  const revisitTtlMs = boundedTtl(options.revisitTtlMs ?? options.revisitTtl ?? options.ttlMs);
  const fresh = [];
  for (const s of Array.isArray(signals) ? signals : []) {
    if (!s || typeof s !== "object") continue;
    const openPulls = Array.isArray(s.openPulls) ? s.openPulls : [];
    const activeIssues = Array.isArray(s.activeIssues) ? s.activeIssues : [];
    const failingRuns = Array.isArray(s.failingRuns24h) ? s.failingRuns24h : [];
    const f = {
      repo: s.repo,
      newPulls: openPulls
        .filter((p) => shouldIncludeSignal(seen, eventKey("sig-pr", s.repo, String(p.n), String(p.updated)), now, revisitTtlMs))
        .sort((a, b) => {
          const aKey = eventKey("sig-pr", s.repo, String(a.n), String(a.updated));
          const bKey = eventKey("sig-pr", s.repo, String(b.n), String(b.updated));
          return pullPriority(b, seen, bKey, now, revisitTtlMs) - pullPriority(a, seen, aKey, now, revisitTtlMs);
        }),
      newIssueActivity: activeIssues.filter((i) =>
        shouldIncludeSignal(seen, eventKey("sig-issue", s.repo, String(i.n), String(i.updated)), now, revisitTtlMs),
      ),
      failingRuns: failingRuns.filter((r) =>
        shouldIncludeSignal(seen, eventKey("sig-run", s.repo, String(r.id), String(r.created)), now, revisitTtlMs),
      ),
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
    '{"kind":"issue","repo":"owner/name","title":"...","body":"...","labels":["..."]}',
    '{"kind":"draft_pr","repo":"owner/name","title":"...","body":"...","branch":"fleet/<kebab>","files":[{"path":"docs/... or scripts/... etc","content":"..."}]}',
    '{"kind":"noop","reason":"..."}',
    "Rules: prioritize security > broken CI > stale PR review comments > standards/docs/testing findings.",
    "Never propose direct pushes to default branches; draft_pr files only under docs/, src/, scripts/, tests/, .github/workflows/<name>.yml.",
    "Keep total under 25 directives; prefer report entries summarizing minor items.",
    "Digest:",
    digest,
  ].join("\n");
}

const PATROL_REPO_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const PATROL_REPO_MUTATION_KINDS = new Set(["comment", "label", "draft_pr", "issue"]);

/**
 * Return the only repository form patrol may send to GitHub. GitHub treats
 * owner names case-insensitively, but keeping the owner canonical prevents a
 * model-provided owner from escaping the M1Vj scope through allOwned mode.
 */
export function canonicalizePatrolRepo(value) {
  if (typeof value !== "string" || value.trim() !== value) return "";
  const match = value.match(/^([^/]+)\/([^/]+)$/);
  if (!match || !/^m1vj$/i.test(match[1])) return "";
  const name = match[2];
  if (!PATROL_REPO_NAME_RE.test(name) || name === "." || name === ".." || name.includes("..")) return "";
  return `M1Vj/${name}`;
}

/**
 * Scope-check every directive before eligibility or execution. The returned
 * array is a fresh array with owner-canonical repository references.
 */
export function fencePatrolDirectives(directives) {
  if (!Array.isArray(directives)) {
    return { ok: false, directives: [], errors: ["directives must be an array"] };
  }
  const errors = [];
  const fenced = directives.map((directive, index) => {
    if (!directive || typeof directive !== "object" || Array.isArray(directive)) return directive;
    const hasRepo = Object.prototype.hasOwnProperty.call(directive, "repo");
    if (!PATROL_REPO_MUTATION_KINDS.has(directive.kind) && !hasRepo) return directive;
    const repo = canonicalizePatrolRepo(directive.repo);
    if (!repo) {
      errors.push(`directive[${index}].repo must be a valid M1Vj repository`);
      return directive;
    }
    if (directive.kind === "issue") {
      if (typeof directive.title !== "string" || !directive.title.trim()) {
        errors.push(`directive[${index}].title must be a non-empty string for issue`);
        return directive;
      }
      if (typeof directive.body !== "string") {
        errors.push(`directive[${index}].body must be a string for issue`);
        return directive;
      }
    }
    return { ...directive, repo };
  });
  return errors.length > 0
    ? { ok: false, directives: [], errors }
    : { ok: true, directives: fenced, errors };
}

export function reviewCommentPostingAllowed(env = process.env) {
  return String(env?.FLEET_ALLOW_REVIEW_COMMENTS || "").trim().toLowerCase() === "true";
}

export function planPatrolPersistence({ changed = false, pushes = 0, maxPushes = PATROL_MAX_STATE_PUSHES } = {}) {
  if (!changed) return { persist: false, reason: "no-changes" };
  const used = Number.isSafeInteger(pushes) && pushes >= 0 ? pushes : 0;
  const configuredCap = Number.isSafeInteger(maxPushes) && maxPushes >= 1 ? maxPushes : PATROL_MAX_STATE_PUSHES;
  const cap = Math.min(PATROL_MAX_STATE_PUSHES, configuredCap);
  if (used >= cap) return { persist: false, reason: "push-cap" };
  return { persist: true, pushAttempt: used + 1 };
}

function eligible(targets, repo) {
  // Fail-closed on unknown targets (mirrors merge.isTier1Eligible).
  if (!targets || typeof targets !== "object") return false;
  const canonical = canonicalizePatrolRepo(repo);
  if (!canonical) return false;
  const matches = (value) => canonicalizePatrolRepo(value) === canonical;
  if (Array.isArray(targets.excluded) && targets.excluded.some(matches)) return false;
  if (targets.allOwned === true) return true;
  return Array.isArray(targets.tier1) && targets.tier1.some(matches);
}

export const DEEP_KINDS = ["security-audit", "redteam", "code-review", "docs-audit"];

function taskKey(task) {
  const rawRepo = typeof task?.repo === "string"
    ? task.repo
    : typeof task?.repository === "string"
      ? task.repository
      : task?.repository?.full_name || task?.repoFullName || "";
  const repo = canonicalizePatrolRepo(rawRepo) || rawRepo;
  return `${repo}|${task?.kind || ""}`;
}

function signalCounts(signal) {
  return {
    pulls: Array.isArray(signal?.openPulls) ? signal.openPulls.length : 0,
    failures: Array.isArray(signal?.failingRuns24h) ? signal.failingRuns24h.length : 0,
  };
}

function deepSignalPriority(signal) {
  const { pulls, failures } = signalCounts(signal);
  if (pulls === 0 && failures === 0) return 0;
  // Broken runs are the most urgent, while PR activity still outranks quiet repos.
  return (failures > 0 ? 2_000_000 : 0) + (pulls > 0 ? 1_000_000 : 0) + failures * 1_000 + pulls * 100;
}

export function planDeepQueueAdditions(existing, signals, options = {}) {
  const rows = Array.isArray(existing) ? existing : [];
  const requestedQueueCap = Number(options.queueCap ?? DEEP_QUEUE_CAP);
  const queueCap = Number.isFinite(requestedQueueCap)
    ? Math.min(DEEP_QUEUE_CAP, Math.max(0, Math.floor(requestedQueueCap)))
    : DEEP_QUEUE_CAP;
  const requestedAdditionCap = Number(options.maxAdditions ?? DEEP_QUEUE_ADDITION_CAP);
  const additionCap = Number.isFinite(requestedAdditionCap)
    ? Math.max(0, Math.floor(requestedAdditionCap))
    : DEEP_QUEUE_ADDITION_CAP;
  const openRows = rows.filter((task) => task?.status === "pending" || task?.status === "in_progress");
  const availableSlots = Math.max(0, queueCap - openRows.length);
  const limit = Math.min(availableSlots, additionCap);
  if (limit === 0) return [];

  const pendingKeys = new Set(openRows.map(taskKey));
  const day = new Date(resolveNow(options.now)).toISOString().slice(0, 10);
  const doneToday = new Set(
    rows
      .filter((task) => task?.status === "done" && String(task.updatedUtc || "").slice(0, 10) === day)
      .map(taskKey),
  );
  const occupied = new Set([...pendingKeys, ...doneToday]);
  const scopedSignals = (Array.isArray(signals) ? signals : [])
    .map((signal) => {
      if (!signal || typeof signal !== "object") return null;
      const repo = canonicalizePatrolRepo(signal.repo);
      return repo ? { ...signal, repo } : null;
    })
    .filter(Boolean);
  const ranked = scopedSignals
    .map((signal, index) => ({ signal, index, priority: deepSignalPriority(signal) }))
    .filter((row) => row.priority > 0 && typeof row.signal?.repo === "string" && row.signal.repo.length > 0)
    .sort((a, b) => b.priority - a.priority || a.index - b.index);

  const now = resolveNow(options.now);
  const timestamp = new Date(now).toISOString();
  const additions = [];
  const initialKindIndex = Number.isInteger(options.kindIndex)
    ? options.kindIndex
    : rows.length % DEEP_KINDS.length;
  let kindIndex = ((initialKindIndex % DEEP_KINDS.length) + DEEP_KINDS.length) % DEEP_KINDS.length;
  for (const { signal } of ranked) {
    let selectedKind = null;
    for (let offset = 0; offset < DEEP_KINDS.length; offset += 1) {
      const kind = DEEP_KINDS[(kindIndex + offset) % DEEP_KINDS.length];
      if (!occupied.has(`${signal.repo}|${kind}`)) {
        selectedKind = kind;
        break;
      }
    }
    kindIndex += 1;
    if (!selectedKind) continue;
    const key = `${signal.repo}|${selectedKind}`;
    const task = {
      id: `deep-${now}-${additions.length}`,
      kind: selectedKind,
      repo: signal.repo,
      status: "pending",
      attempts: 0,
      createdUtc: timestamp,
      updatedUtc: timestamp,
    };
    additions.push(task);
    occupied.add(key);
    if (additions.length >= limit) break;
  }
  return additions;
}

export function enqueueDeepTasks(signals, options = {}) {
  const queuePath = options.queuePath || path.join(STATE_DIR, "queue.jsonl");
  const existing = existsSync(queuePath)
    ? readFileSync(queuePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
    : [];
  const additions = planDeepQueueAdditions(existing, signals, options);
  if (additions.length > 0) {
    appendFileSync(queuePath, additions.map((task) => JSON.stringify(task)).join("\n") + "\n");
  }
  return additions.length;
}

export function planPatrolDispatches(signals, options = {}) {
  const ledger = options.ledger || new Map();
  const now = resolveNow(options.now);
  const dispatches = [];

  const priorityRepos = (Array.isArray(options.priorityRepos) && options.priorityRepos.length > 0)
    ? options.priorityRepos
    : (Array.isArray(options.tier1) && options.tier1.length > 0 ? options.tier1 : []);

  function repoRank(repoName) {
    const norm = String(repoName || "").toLowerCase();
    for (let i = 0; i < priorityRepos.length; i++) {
      if (norm.endsWith(priorityRepos[i].toLowerCase())) return i;
    }
    const tier1List = Array.isArray(options.tier1) ? options.tier1 : [];
    for (let j = 0; j < tier1List.length; j++) {
      if (norm.endsWith(tier1List[j].toLowerCase())) return priorityRepos.length + j;
    }
    return 1000;
  }

  const scopedSignals = (Array.isArray(signals) ? signals : [])
    .map((signal) => {
      if (!signal || typeof signal !== "object") return null;
      const repo = canonicalizePatrolRepo(signal.repo);
      return repo ? { ...signal, repo } : null;
    })
    .filter(Boolean)
    .sort((a, b) => repoRank(a.repo) - repoRank(b.repo));

  // 1. Pull Requests: check in priority order for eligible, non-draft open PRs
  const prDispatches = [];
  for (const signal of scopedSignals) {
    const pulls = Array.isArray(signal.openPulls) ? signal.openPulls : [];
    for (const pr of pulls) {
      if (!pr || pr.draft === true) continue;
      const prNumber = Number(pr.n ?? pr.number);
      if (!Number.isSafeInteger(prNumber) || prNumber <= 0) continue;
      const headSha = pr.headSha || pr.head_sha || pr.head?.sha || "";
      const updated = String(pr.updated ?? pr.updated_at ?? "");
      const dispatchToken = headSha || updated;
      const key = eventKey("dispatch-merge", signal.repo, String(prNumber), dispatchToken);
      const lastObserved = observedLedgerTime(ledger, key);
      if (lastObserved === undefined) {
        prDispatches.push({
          workflow: "merge.yml",
          repo: signal.repo,
          pr: String(prNumber),
          key,
        });
      }
    }
  }

  // Cap PR dispatches to at most 1 per patrol cycle to avoid runner queue storms
  if (prDispatches.length > 0) {
    dispatches.push(prDispatches[0]);
  }

  // 2. Idle Tier-1 Repo Improvement: if no PR dispatch is planned, check for idle tier-1 repos
  if (dispatches.length === 0) {
    for (const signal of scopedSignals) {
      const hasOpenPulls = Array.isArray(signal.openPulls) && signal.openPulls.length > 0;
      if (hasOpenPulls) continue; // Skip if repo already has open PRs

      const key = eventKey("dispatch-improve", signal.repo, "idle", "");
      const lastObserved = observedLedgerTime(ledger, key);
      const idleTtl = 24 * 60 * 60 * 1000; // 24h
      if (lastObserved === undefined || now - lastObserved >= idleTtl) {
        dispatches.push({
          workflow: "improve.yml",
          repo: signal.repo,
          key,
        });
        break; // At most 1 improve dispatch per cycle
      }
    }
  }

  return dispatches;
}

export async function applyPatrolLabels(repo, number, labels, env = process.env, audit = {}, options = {}) {
  const ghCall = options.gh || gh;
  const killSwitch = options.killSwitch || killSwitchEngaged;
  let applied = 0;
  let skipped = false;
  const markSkipped = () => {
    skipped = true;
    if (typeof audit.incident === "function") {
      audit.incident("kill-switch", `label processing stopped on ${repo}#${number}: KILL_SWITCH engaged mid-run`);
    }
  };
  for (const label of Array.isArray(labels) ? labels : []) {
    if (killSwitch()) {
      markSkipped();
      break;
    }
    try {
      ghCall(["api", "-X", "POST", `/repos/${repo}/issues/${number}/labels`, "-f", `labels[]=${label}`], env);
      applied += 1;
    } catch (addErr) {
      // Label may not exist yet: create it (tolerate 422 = already exists),
      // then retry the attach (tolerate 422 = already attached). Every write,
      // including these retries, is guarded independently by the kill switch.
      if (killSwitch()) {
        markSkipped();
        break;
      }
      try {
        ghCall(["api", "-X", "POST", `/repos/${repo}/labels`, "-f", `name=${label}`, "-f", "color=ededed"], env);
      } catch (createErr) {
        if (!/422|already.?exists/i.test(String(createErr.message))) throw createErr;
        if (typeof audit.note === "function") audit.note("label-422", `${repo}: label ${label} already exists (tolerated)`);
      }
      if (killSwitch()) {
        markSkipped();
        break;
      }
      try {
        ghCall(["api", "-X", "POST", `/repos/${repo}/issues/${number}/labels`, "-f", `labels[]=${label}`], env);
        applied += 1;
      } catch (retryErr) {
        if (!/422|already/i.test(String(retryErr.message))) throw retryErr;
        if (typeof audit.note === "function") audit.note("label-422", `${repo}#${number}: label ${label} already attached (tolerated)`);
      }
      void addErr;
    }
  }
  return { applied, skipped };
}

export async function executeDirectives(env, identity, directives, targets, audit) {
  const scoped = fencePatrolDirectives(directives);
  if (!scoped.ok) {
    for (const error of scoped.errors) {
      if (typeof audit?.incident === "function") audit.incident("scope", error);
    }
    return {
      mutations: 0,
      results: scoped.errors.map((error) => ({ kind: "scope", ok: false, error })),
    };
  }
  if (isPublicDataClass(env)) {
    const results = scoped.directives.map((directive) => ({
      kind: directive?.kind || "unknown",
      ok: true,
      skipped: "public-read-only",
    }));
    if (typeof audit?.note === "function") audit.note("public-read-only", `suppressed ${results.length} directive mutations`);
    return { mutations: 0, results };
  }
  let mutations = 0;
  const results = [];
  for (const d of scoped.directives) {
    try {
      if (d.kind === "report") {
        results.push({ kind: d.kind, ok: true, note: d.section });
      } else if (d.kind === "fleet_issue") {
        if (killSwitchEngaged()) {
          audit.incident("kill-switch", "fleet_issue skipped: KILL_SWITCH engaged mid-run");
          results.push({ kind: d.kind, ok: true, skipped: "kill-switch" });
          continue;
        }
        const controlRepository = privateRepository(env, PRIVATE_REPOSITORY_ENV.control);
        const created = gh(["api", "-X", "POST", `/repos/${controlRepository}/issues`, "-f", `title=${d.title}`, "-f", `body=${d.body}`], env);
        await verifyIssueAuthor(controlRepository, created.number, identity, env.FLEET_GH_TOKEN);
        mutations += 1;
        results.push({ kind: d.kind, ok: true, issue: created.number });
      } else if (d.kind === "comment" || d.kind === "label") {
        if (!eligible(targets, d.repo)) {
          results.push({ kind: d.kind, ok: true, downgraded: `${d.repo} not tier1` });
          continue;
        }
        if (d.kind === "comment") {
          if (!reviewCommentPostingAllowed(env)) {
            audit.note("comment-draft", `comment suppressed on ${d.repo}#${d.number} (postedComment=false)`, {
              postedComment: false,
              repo: d.repo,
              target: d.target,
              number: d.number,
            });
            results.push({ kind: d.kind, ok: true, postedComment: false });
            continue;
          }
          if (killSwitchEngaged()) {
            audit.incident("kill-switch", `comment skipped on ${d.repo}#${d.number}: KILL_SWITCH engaged mid-run`);
            results.push({ kind: d.kind, ok: true, skipped: "kill-switch" });
            continue;
          }
          const created = gh(["api", "-X", "POST", `/repos/${d.repo}/issues/${d.number}/comments`, "-f", `body=${d.body}`], env);
          await verifyCommentAuthor(d.repo, created.id, identity, env.FLEET_GH_TOKEN);
          mutations += 1;
          results.push({ kind: d.kind, ok: true, commentId: created.id });
        } else {
          const labelResult = await applyPatrolLabels(d.repo, d.number, d.labels, env, audit);
          if (labelResult.applied > 0) mutations += 1;
          results.push({ kind: d.kind, ok: true, applied: labelResult.applied, ...(labelResult.skipped ? { skipped: "kill-switch" } : {}) });
        }
      } else if (d.kind === "draft_pr") {
        if (!eligible(targets, d.repo)) {
          results.push({ kind: d.kind, ok: true, downgraded: `${d.repo} not tier1` });
          continue;
        }
        if (killSwitchEngaged()) {
          audit.incident("kill-switch", `draft_pr skipped on ${d.repo}: KILL_SWITCH engaged mid-run`);
          results.push({ kind: d.kind, ok: true, skipped: "kill-switch" });
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
      } else if (d.kind === "issue") {
        if (!eligible(targets, d.repo)) {
          results.push({ kind: d.kind, ok: true, downgraded: `${d.repo} not tier1` });
          continue;
        }
        if (killSwitchEngaged()) {
          audit.incident("kill-switch", `issue skipped on ${d.repo}: KILL_SWITCH engaged mid-run`);
          results.push({ kind: d.kind, ok: true, skipped: "kill-switch" });
          continue;
        }
        const issueArgs = ["api", "-X", "POST", `/repos/${d.repo}/issues`, "-f", `title=${d.title}`, "-f", `body=${d.body}`];
        if (Array.isArray(d.labels) && d.labels.length > 0) {
          for (const label of d.labels) {
            if (label && typeof label === "string") {
              issueArgs.push("-f", `labels[]=${label}`);
            }
          }
        }
        const created = gh(issueArgs, env);
        await verifyIssueAuthor(d.repo, created.number, identity, env.FLEET_GH_TOKEN);
        mutations += 1;
        results.push({ kind: d.kind, ok: true, issue: created.number, repo: d.repo });
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
  const terminal = makeExecutionTerminal(process.env, REPO_ROOT, { lane: "patrol" });
  let trigger = "manual";
  let gwRoot = REPO_ROOT;
  let auditFileRel = "";
  let statePushAttempted = false;
  let statePushVerified = false;
  const writePatrolAudit = (outcome) => {
    const file = writeExecutionAudit(audit, process.env, REPO_ROOT, runId, "Patrol run", outcome);
    auditFileRel = file ? path.relative(REPO_ROOT, file) : (process.env.FLEET_PUBLIC_ARTIFACT_MANIFEST || "");
    return file;
  };
  try {
    identity = await runGate(process.env);
    configureIdentity(REPO_ROOT, identity);
    const scopes = boundedPatrolScopes(identity);
    audit.note("gate", `identity=${identity.login} id=${identity.id} scopes=${scopes.join(",")}`);

    gwRoot = REPO_ROOT;

    if (isPublicDataClass(process.env)) {
      const repo = publicRepository(process.env);
      const signals = await collectSignals(process.env, audit);
      const digest = buildDigest(signals, new Map());
      let modelStatus = "skipped-empty-digest";
      let directives = [];
      if (digest !== "[]") {
        const modelResult = await askModel({
          prompt: buildPrompt(digest),
          timeoutMs: 480000,
          env: publicModelEnv(process.env),
          preferVariantMax: true,
          maxRounds: 3,
        });
        modelStatus = modelResult.modelMode || (modelResult.complete ? "model" : "model-unavailable");
        if (modelResult.complete && modelResult.reply) {
          const validation = validateDirectives(modelResult.reply);
          if (validation.ok) directives = validation.directives;
          else audit.note("validator", "public directive output rejected; no mutations attempted");
        }
      }
      const result = await executeDirectives(process.env, identity, directives, { tier1: [repo], excluded: [] }, audit);
      writePublicArtifact(process.env, { mode: "patrol", status: "ok", repository: repo, count: signals.length, results: result.results, checks: { model: modelStatus, digestBytes: digest.length } }, { kind: "patrol", status: "ok", repository: repo, runId });
      writePatrolAudit("ok-public-read-only");
      console.log(`FLEET_RUN_RESULT=${JSON.stringify({ runId, status: "public-read-only", directives: directives.length, mutations: 0 })}`);
      return 0;
    }
    const { gatewayDown } = await import("./lib/gateway-health.mjs");
    if (gatewayDown(gwRoot)) {
      // Finish-loop: gateway outage is MODEL_UNAVAILABLE (exit 6), surfaced
      // not hidden. No silent neutral-pass when the app is unservable.
      audit.incident("gateway", "circuit open at patrol start; failing closed code=6");
      terminal("EXHAUSTED", { runId, why: "gateway-circuit-open", code: 6 });
      console.log(`FLEET_RUN_RESULT=${JSON.stringify({ runId, status: "model-unavailable", code: 6 })}`);
      return 6;
    }

    trigger = process.env.FLEET_TRIGGER || "manual";
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
    const seen = loadPatrolLedger(ledgerPath());
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
        sessionId: loadPatrolSession() || undefined,
        // Contributor tier: high thinking effort (maps to xhigh), never the max variant.
        preferVariantMax: true,
      });
      modelMode = modelResult.modelMode;
      audit.note("model", `mode=${modelMode} complete=${modelResult.complete} attempts=${JSON.stringify(modelResult.attempts)} session=${modelResult.sessionId ? "captured" : "none"}`);
      if (modelResult.sessionId) {
        const sessions = readJson(sessionsPath(), {});
        const row = { sessionId: modelResult.sessionId, updatedAt: new Date().toISOString() };
        sessions[runId] = row;
        sessions["patrol-latest"] = row;
        writeFileSync(sessionsPath(), JSON.stringify(sessions, null, 2));
      }
      if (!modelResult.complete || !modelResult.reply) {
        audit.incident("model", "triage model unavailable or incomplete, continuing patrol without directives");
      } else {
        let validation = validateDirectives(modelResult.reply);
        // Finish-loop: session-id capture + auto-resume up to 3 repair rounds.
        // Each round reuses the captured sessionId so caps/revision stay
        // consistent; every round is audited and the session is persisted.
        let resumeSid = modelResult.sessionId || "";
        for (let round = 1; round <= 3 && !validation.ok && resumeSid; round++) {
          audit.note("validator", `repair round ${round}/3 requested`);
          const repair = await askModel({
            prompt: "Your previous reply was rejected because it was not a bare JSON array matching the directive schema. Re-output ONLY the strict JSON array now — no prose, no fences, no code.",
            sessionId: resumeSid,
            timeoutMs: 300000,
            env: process.env,
            preferVariantMax: true,
          });
          audit.note("repair", `round=${round} complete=${repair.complete} gotReply=${Boolean(repair.reply)}`);
          if (repair.sessionId) {
            resumeSid = repair.sessionId;
            const sessions = readJson(sessionsPath(), {});
            const row = { sessionId: resumeSid, updatedAt: new Date().toISOString(), repairRound: round };
            sessions[runId] = row;
            sessions["patrol-latest"] = row;
            writeFileSync(sessionsPath(), JSON.stringify(sessions, null, 2));
          }
          if (repair.complete && repair.reply) validation = validateDirectives(repair.reply);
        }
        if (!validation.ok) {
          audit.incident("validator", "model output rejected, skipping directives", { errors: validation.errors.slice(0, 10) });
        } else {
          directives = validation.directives;
          audit.note("validator", `directives accepted=${directives.length}`);
        }
      }
    }

    const { mutations, results } = await executeDirectives(process.env, identity, directives, targets, audit);
    audit.note("executor", `mutations=${mutations}`);

    // Mark signals seen only after executor success or permanent rejection
    // (invalid kind/duplicate/downgraded all record ok:true). Transient
    // executor errors (ok:false) leave signals unmarked so they retry next
    // scan. Idempotency keys unchanged.
    const transientFailed = (results || []).some((r) => r && r.ok === false);
    if (transientFailed) {
      audit.note("ledger-defer", "transient executor errors; signals NOT marked seen, will retry next scan");
    } else {
      for (const group of signals) {
        for (const p of group.openPulls || []) append(ledgerPath(), eventKey("sig-pr", group.repo, String(p.n), String(p.updated)), {});
        for (const i of group.activeIssues || []) append(ledgerPath(), eventKey("sig-issue", group.repo, String(i.n), String(i.updated)), {});
        for (const r of group.failingRuns24h || []) append(ledgerPath(), eventKey("sig-run", group.repo, String(r.id), String(r.created)), {});
      }
    }

    // Heartbeat + revision persistence: model chain revision and caps travel
    // with the heartbeat so resume/retry rounds stay consistent.
    const chainRev = readJson(path.join(REPO_ROOT, "state", "model-chain.json"), {});
    writeFileSync(
      heartbeatPath(),
      JSON.stringify({ lastRunUtc: new Date().toISOString(), runId, modelMode, reposSeen: signals.length, mutations, chainUpdatedAt: chainRev.updatedAt || null, caps: "xhigh-contributor-cap" }, null, 2),
    );

    status = "ok";
    const state = status === "ok" ? "SUCCESS" : "NO-OP";
    terminal(state, { runId, modelMode, mutations, trigger });

    // Dynamic autonomous worker dispatch (Scout / Radar)
    const targetsData = readJson(targetsPath(), {});
    const scoutDispatches = planPatrolDispatches(signals, {
      ledger: loadPatrolLedger(ledgerPath()),
      priorityRepos: targetsData.priorityRepos || targetsData.tier1 || [],
      tier1: targetsData.tier1 || [],
    });
    for (const d of scoutDispatches) {
      try {
        const args = ["workflow", "run", d.workflow, "-R", privateRepository(process.env, PRIVATE_REPOSITORY_ENV.control)];
        if (d.repo) args.push("-f", `repo=${d.repo}`);
        if (d.pr) args.push("-f", `pr=${d.pr}`);
        gh(args, process.env);
        append(ledgerPath(), d.key, { workflow: d.workflow, repo: d.repo, pr: d.pr });
        audit.note("scout-dispatch", `dispatched ${d.workflow} for ${d.repo}${d.pr ? `#${d.pr}` : ""}`);
      } catch (err) {
        audit.note("scout-dispatch", `dispatch ${d.workflow} failed: ${err.message.slice(0, 120)}`);
      }
    }

    const queued = enqueueDeepTasks(signals);
    audit.note("deep-queue", `tasks enqueued=${queued} (bounded cap=${DEEP_QUEUE_CAP})`);
    // Write once before persistence so the audit itself is included in the
    // single state commit/push. A final write below captures post-push notes
    // without attempting a second unsafe push.
    writePatrolAudit(status);

    if (gitHasChanges(REPO_ROOT, ["state", "audit"])) {
      gitAdd(REPO_ROOT, ["state", "audit"]);
      gitCommit(REPO_ROOT, `[fleet] patrol ${runId}`, identity);
      audit.note("push", "state push attempted once");
      statePushAttempted = true;
      gitPush(REPO_ROOT, "main", process.env);
      const sha = gitRevParse(REPO_ROOT, "HEAD");
      await verifyCommit(privateRepository(process.env, PRIVATE_REPOSITORY_ENV.control), sha, identity, process.env.FLEET_GH_TOKEN);
      statePushVerified = true;
      audit.note("push-verify", `attribution verified sha=${sha.slice(0, 10)}`);
      try {
        gh(["workflow", "run", "deep.yml", "-R", privateRepository(process.env, PRIVATE_REPOSITORY_ENV.control), "-f", "workers=3"], process.env);
        audit.note("deep-dispatch", "deep.yml dispatched");
      } catch (err) {
        audit.note("deep-dispatch", `dispatch skipped: ${err.message.slice(0, 120)}`);
      }
    } else {
      status = "ok-no-changes";
      audit.note("persistence", "no state or audit changes detected");
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
    writePatrolAudit(status);
    console.log(`FLEET_RUN_RESULT=${JSON.stringify({ runId, status, modelMode, directives: directives.length, mutations, auditFile: auditFileRel })}`);
    return 0;
  } catch (err) {
    const code = err.code && Number.isInteger(err.code) ? err.code : 1;
    const publicMode = (() => {
      try {
        return isPublicDataClass(process.env);
      } catch {
        return true;
      }
    })();
    const failureReason = patrolFailureReason(err, process.env);
    audit.incident("fatal", publicMode ? "public patrol failed" : err.message);
    const failureStatus = `failed(${publicMode ? code : (err.reason || code)})`;
    writePatrolAudit(failureStatus);
    console.error(`PATROL_FAILED code=${code} reason=${failureReason}`);
    if (err.reason === "MODEL_UNAVAILABLE") {
      try {
        const { gatewayDown } = await import("./lib/gateway-health.mjs");
        if (gatewayDown(gwRoot)) {
          // Surfaced, not hidden: outage still exits 6 so watchdog/alerts fire.
          audit.note("outage-skip", "circuit open; recording EXHAUSTED code=6");
          terminal("EXHAUSTED", { runId, why: "gateway-circuit-open", code: 6, trigger });
          writePatrolAudit(failureStatus);
          console.log(`FLEET_RUN_RESULT=${JSON.stringify({ runId, status: "model-unavailable", code: 6 })}`);
          return 6;
        }
      } catch {}
    }
    terminal(err.reason === "MODEL_UNAVAILABLE" ? "EXHAUSTED" : "BLOCKED", { runId, code, trigger });
    if (identity && !statePushAttempted && gitHasChanges(REPO_ROOT, ["audit"])) {
      try {
        gitAdd(REPO_ROOT, ["audit"]);
        gitCommit(REPO_ROOT, `[fleet] patrol-failure-audit ${runId}`, identity);
        audit.note("push", "failure audit push attempted once");
        statePushAttempted = true;
        gitPush(REPO_ROOT, "main", process.env);
        const failSha = gitRevParse(REPO_ROOT, "HEAD");
        await verifyCommit(privateRepository(process.env, PRIVATE_REPOSITORY_ENV.control), failSha, identity, process.env.FLEET_GH_TOKEN);
        statePushVerified = true;
        audit.note("push-verify", `failure audit attribution verified sha=${failSha.slice(0, 10)}`);
      } catch (pushErr) {
        audit.note(
          "push-verify",
          publicMode
            ? "failure audit push skipped"
            : `failure audit push skipped: ${String(pushErr.message || pushErr).slice(0, 160)}`,
        );
      }
    }
    if (statePushAttempted && !statePushVerified) {
      audit.note("push-verify", "state push outcome unresolved; retry suppressed");
    }
    // Preserve fatal incidents and any push outcome in the final local audit;
    // never replay the push merely to persist this note.
    writePatrolAudit(failureStatus);
    return code;
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const exitCode = await main();
  process.exit(exitCode);
}
