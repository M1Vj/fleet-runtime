export function decideStale(lastRunUtc, nowMs = Date.now(), thresholdMs = 90 * 60 * 1000) {
  if (!lastRunUtc) return { stale: true, ageMinutes: null, reason: "no-heartbeat" };
  const last = Date.parse(lastRunUtc);
  if (Number.isNaN(last)) return { stale: true, ageMinutes: null, reason: "bad-heartbeat" };
  const ageMinutes = Math.round(((nowMs - last) / 60000) * 10) / 10;
  return { stale: ageMinutes * 60000 > thresholdMs, ageMinutes, reason: ageMinutes * 60000 > thresholdMs ? "stale" : "fresh" };
}

export const WATCHDOG_WORKFLOWS = [
  "patrol.yml",
  "selftest.yml",
  "deep.yml",
  "improve.yml",
  "thesis.yml",
  "kb.yml",
  "retro.yml",
  "merge.yml",
  "model-refresh.yml",
  "orchestrate.yml",
];

export function planWatchdogActions(heartbeat, nowMs = Date.now(), thresholdMs = 90 * 60 * 1000, options = {}) {
  const decision = decideStale(heartbeat && heartbeat.lastRunUtc, nowMs, thresholdMs);
  if (String(options?.dataClass || "").toLowerCase() === "public") {
    return { ...decision, actions: [], alertIssue: false, dataClass: "public", readOnly: true };
  }
  if (!decision.stale) {
    return { ...decision, actions: [], alertIssue: false };
  }
  return {
    ...decision,
    actions: [
      ...WATCHDOG_WORKFLOWS.map((wf) => ({ kind: "enable-workflow", workflow: wf })),
      { kind: "file-alert-issue", title: `[WATCHDOG] patrol stale since ${heartbeat && heartbeat.lastRunUtc ? heartbeat.lastRunUtc : "unknown"}` },
    ],
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
