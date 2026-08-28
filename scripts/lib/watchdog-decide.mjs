export function decideStale(lastRunUtc, nowMs = Date.now(), thresholdMs = 90 * 60 * 1000) {
  const stamp = typeof lastRunUtc === "string" ? lastRunUtc.trim() : "";
  if (!stamp) return { stale: true, ageMinutes: null, reason: "no-heartbeat" };
  const last = Date.parse(stamp);
  if (Number.isNaN(last)) return { stale: true, ageMinutes: null, reason: "bad-heartbeat" };
  const ageMinutes = Math.round(((nowMs - last) / 60000) * 10) / 10;
  return { stale: ageMinutes * 60000 > thresholdMs, ageMinutes, reason: ageMinutes * 60000 > thresholdMs ? "stale" : "fresh" };
}

export const WATCHDOG_WORKFLOWS = ["patrol.yml", "selftest.yml", "deep.yml", "improve.yml", "thesis.yml", "kb.yml", "retro.yml", "merge.yml"];
const WATCHDOG_ALERT_TITLE = /^\[WATCHDOG\] patrol stale since (?:unknown|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/;
const CANONICAL_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export const MAX_WATCHDOG_ALERT_PAGES = 10;

/** Malformed heartbeat timestamps collapse to one canonical alert identity. */
export function canonicalHeartbeatStamp(value) {
  if (typeof value !== "string") return "unknown";
  const text = value.trim();
  if (!CANONICAL_STAMP_RE.test(text) || Number.isNaN(Date.parse(text))) return "unknown";
  return text;
}

/** Enable workflow recovery only when the trusted job supplies the exact opt-in value. */
export function watchdogAutoEnableEnabled(value) {
  return value === "true";
}

export function selectWatchdogAlertIssue(issues) {
  const matches = (Array.isArray(issues) ? issues : []).filter((issue) => (
    issue && issue.state === "open"
      && typeof issue.title === "string"
      && WATCHDOG_ALERT_TITLE.test(issue.title)
      && issue.pull_request == null
  ));
  return matches.sort((left, right) => {
    const leftNumber = Number(left.number);
    const rightNumber = Number(right.number);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber;
    return String(left.id || left.number || "").localeCompare(String(right.id || right.number || ""));
  })[0] || null;
}

export function findWatchdogAlertIssue(fetchPage, { maxPages = MAX_WATCHDOG_ALERT_PAGES } = {}) {
  if (typeof fetchPage !== "function") return null;
  const pages = [];
  for (let page = 1; page <= Math.max(1, Math.min(MAX_WATCHDOG_ALERT_PAGES, Number(maxPages) || MAX_WATCHDOG_ALERT_PAGES)); page += 1) {
    const issues = fetchPage(page);
    if (!Array.isArray(issues)) break;
    pages.push(...issues);
    if (issues.length < 100) break;
  }
  return selectWatchdogAlertIssue(pages);
}

export function planWatchdogActions(heartbeat, nowMs = Date.now(), thresholdMs = 90 * 60 * 1000, { autoEnable = false } = {}) {
  const decision = decideStale(heartbeat && heartbeat.lastRunUtc, nowMs, thresholdMs);
  if (!decision.stale) {
    return { ...decision, autoEnable: autoEnable === true, actions: [], alertIssue: false };
  }
  const actions = autoEnable === true
    ? WATCHDOG_WORKFLOWS.map((wf) => ({ kind: "enable-workflow", workflow: wf }))
    : [];
  return {
    ...decision,
    autoEnable: autoEnable === true,
    actions: [...actions, { kind: "file-alert-issue", title: `[WATCHDOG] patrol stale since ${canonicalHeartbeatStamp(heartbeat && heartbeat.lastRunUtc)}` }],
    alertIssue: true,
  };
}

export function shouldCoalesce(trigger, lastRunUtc, nowMs = Date.now(), minGapMinutes = 10) {
  if (trigger !== "schedule") return { coalesce: false, gapMinutes: null };
  if (!lastRunUtc) return { coalesce: false, gapMinutes: null };
  const last = Date.parse(lastRunUtc);
  if (Number.isNaN(last)) return { coalesce: false, gapMinutes: null };
  const gapMinutes = Math.round(((nowMs - last) / 60000) * 10) / 10;
  return { coalesce: gapMinutes < minGapMinutes, gapMinutes };
}

/**
 * Recover expired queue leases without hiding them behind a refreshed
 * in-progress timestamp. The next worker owns the attempt increment. Work that
 * already reached the cap becomes an explicit terminal failure.
 */
export function recoverStaleQueue(queue, {
  nowMs = Date.now(),
  staleMs = 40 * 60 * 1000,
  maxAttempts = 3,
} = {}) {
  const now = Number(nowMs);
  const staleAfter = Math.max(1, Number(staleMs) || 40 * 60 * 1000);
  const cap = Math.max(1, Number(maxAttempts) || 3);
  const nowUtc = new Date(now).toISOString();
  const requeued = [];
  const exhausted = [];
  const next = (Array.isArray(queue) ? queue : []).map((raw) => {
    const task = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : raw;
    if (!task || task.status !== "in_progress") return task;
    const updated = Date.parse(String(task.updatedUtc || ""));
    if (!Number.isFinite(updated) || updated > now || now - updated <= staleAfter) return task;
    const attempts = Math.max(0, Number(task.attempts) || 0);
    if (attempts >= cap) {
      exhausted.push(String(task.id || "unknown").slice(0, 120));
      return { ...task, status: "failed", updatedUtc: nowUtc, failureReason: "stale-attempt-limit" };
    }
    requeued.push(String(task.id || "unknown").slice(0, 120));
    return { ...task, status: "pending", updatedUtc: nowUtc, recoveryReason: "stale-lease" };
  });
  return { queue: next, changed: requeued.length + exhausted.length > 0, requeued, exhausted };
}

/** The paired fleet-control sentinel may revive exactly this minimum set so the primary watchdog can self-heal everything else. */
export const SENTINEL_REVIVE_WORKFLOWS = ["watchdog.yml", "merge.yml"];
export const SENTINEL_TARGET_REPO = "M1Vj/fleet-runtime";

/**
 * Pure planner for the paired fleet-control sentinel: when the target repo's
 * primary watchdog is stale, auto-enable is explicitly on, and no kill switch
 * exists, revive exactly SENTINEL_REVIVE_WORKFLOWS on the target repo. Any
 * uncertain input fails closed to zero actions.
 */
export function planSentinelActions({ lastRunUtc, nowMs = Date.now(), thresholdMs = 60 * 60 * 1000, autoEnable, killSwitchPresent } = {}) {
  if (killSwitchPresent === true || autoEnable !== "true") {
    return { stale: false, reason: killSwitchPresent === true ? "kill-switch-present" : "auto-enable-off", actions: [] };
  }
  const stamp = typeof lastRunUtc === "string" ? lastRunUtc.trim() : "";
  let stale;
  let reason;
  if (!stamp) {
    stale = true;
    reason = "no-runs";
  } else {
    const decision = decideStale(stamp, nowMs, thresholdMs);
    stale = decision.stale === true;
    reason = decision.reason;
  }
  if (!stale) return { stale: false, reason, actions: [] };
  return {
    stale: true,
    reason,
    actions: SENTINEL_REVIVE_WORKFLOWS.map((workflow) => ({ kind: "enable-workflow", repo: SENTINEL_TARGET_REPO, workflow })),
  };
}
