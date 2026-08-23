import { existsSync } from "node:fs";

export function summarizeEvents(lines, nowMs = Date.now(), windowMs = 7 * 24 * 3600 * 1000) {
  const perLane = {};
  let inWindow = 0;
  for (const l of lines || []) {
    try {
      const e = typeof l === "string" ? JSON.parse(l) : l;
      if (!e.t || !e.state) continue;
      if (nowMs - Date.parse(e.t) > windowMs) continue;
      inWindow += 1;
      const lane = e.lane || e.mode || "unknown";
      perLane[lane] = perLane[lane] || { SUCCESS: 0, NOOP: 0, BLOCKED: 0, STALLED: 0, EXHAUSTED: 0 };
      const key = e.state === "NO-OP" ? "NOOP" : e.state;
      if (perLane[lane][key] !== undefined) perLane[lane][key] += 1;
    } catch {}
  }
  return { windowDays: windowMs / 86400000, total: inWindow, perLane };
}

export function renderStatusMd({ eventsLines, mergesLines, heartbeat, queueLines }) {
  const summary = summarizeEvents(eventsLines);
  const merges = mergesLines.filter(Boolean).length;
  const queuePending = queueLines.filter((l) => {
    try {
      return JSON.parse(l).status === "pending";
    } catch {
      return false;
    }
  }).length;
  const lines = [
    "# Fleet status",
    "",
    `- generatedUtc: ${new Date().toISOString()}`,
    `- kill switch: ${existsSyncMarker()}`,
    `- heartbeat: ${heartbeat && heartbeat.lastRunUtc ? heartbeat.lastRunUtc : "none"} (model ${heartbeat && heartbeat.modelMode ? heartbeat.modelMode : "?"}, mutations ${heartbeat && heartbeat.mutations})`,
    `- deep queue pending: ${queuePending}`,
    `- merge decisions recorded: ${merges}`,
    "",
    `## Terminal states (last ${summary.windowDays} days)`,
    "",
    "| lane | SUCCESS | NO-OP | BLOCKED | STALLED | EXHAUSTED |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const [lane, c] of Object.entries(summary.perLane)) {
    lines.push(`| ${lane} | ${c.SUCCESS} | ${c.NOOP} | ${c.BLOCKED} | ${c.STALLED} | ${c.EXHAUSTED} |`);
  }
  if (Object.keys(summary.perLane).length === 0) lines.push("| (none) | 0 | 0 | 0 | 0 | 0 |");
  lines.push("");
  return lines.join("\n");
}

function existsSyncMarker() {
  return existsSync("state/KILL_SWITCH") ? "ENGAGED" : "armed";
}
