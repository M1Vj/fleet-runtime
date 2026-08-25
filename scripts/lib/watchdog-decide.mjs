export function decideStale(lastRunUtc, nowMs = Date.now(), thresholdMs = 90 * 60 * 1000) {
  if (!lastRunUtc) return { stale: true, ageMinutes: null, reason: "no-heartbeat" };
  const last = Date.parse(lastRunUtc);
  if (Number.isNaN(last)) return { stale: true, ageMinutes: null, reason: "bad-heartbeat" };
  const ageMinutes = Math.round(((nowMs - last) / 60000) * 10) / 10;
  return { stale: ageMinutes * 60000 > thresholdMs, ageMinutes, reason: ageMinutes * 60000 > thresholdMs ? "stale" : "fresh" };
}

const WATCHDOG_WORKFLOWS = ["patrol.yml", "selftest.yml", "deep.yml", "improve.yml", "thesis.yml", "kb.yml", "retro.yml"];
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
