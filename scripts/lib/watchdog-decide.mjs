export function decideStale(lastRunUtc, nowMs = Date.now(), thresholdMs = 90 * 60 * 1000) {
  if (!lastRunUtc) return { stale: true, ageMinutes: null, reason: "no-heartbeat" };
  const last = Date.parse(lastRunUtc);
  if (Number.isNaN(last)) return { stale: true, ageMinutes: null, reason: "bad-heartbeat" };
  const ageMinutes = Math.round(((nowMs - last) / 60000) * 10) / 10;
  return { stale: ageMinutes * 60000 > thresholdMs, ageMinutes, reason: ageMinutes * 60000 > thresholdMs ? "stale" : "fresh" };
}

const WATCHDOG_WORKFLOWS = ["patrol.yml", "selftest.yml", "deep.yml", "improve.yml", "thesis.yml", "kb.yml", "retro.yml"];

/** Enable workflow recovery only when the trusted job supplies the exact opt-in value. */
export function watchdogAutoEnableEnabled(value) {
  return value === "true";
}

export function selectWatchdogAlertIssue(issues) {
  return (Array.isArray(issues) ? issues : []).find((issue) => (
    issue && issue.state === "open"
      && typeof issue.title === "string"
      && issue.title.startsWith("[WATCHDOG] patrol stale")
      && issue.pull_request == null
  )) || null;
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
    actions: [...actions, { kind: "file-alert-issue", title: `[WATCHDOG] patrol stale since ${heartbeat && heartbeat.lastRunUtc ? heartbeat.lastRunUtc : "unknown"}` }],
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
