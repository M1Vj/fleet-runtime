import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { isTelemetryValidationError, recordTelemetryEvent, telemetryPath } from "./telemetry.mjs";

export function makeTerminal(root, { lane = "unknown", requireWrite = false } = {}) {
  const eventsPath = path.join(root, "state", "events.jsonl");
  const telemetryFile = telemetryPath(path.resolve(root));
  return function terminal(state, details = {}) {
    const named = ["SUCCESS", "NO-OP", "BLOCKED", "STALLED", "EXHAUSTED"].includes(state) ? state : "BLOCKED";
    const record = JSON.stringify({ t: new Date().toISOString(), lane, state: named, ...details });
    try {
      mkdirSync(path.dirname(eventsPath), { recursive: true });
      appendFileSync(eventsPath, record + "\n");
      if (existsSync(eventsPath)) {
        const lines = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
        if (lines.length > 1000) writeFileSync(eventsPath, lines.slice(-500).join("\n") + "\n");
      }
    } catch (err) {
      if (requireWrite) throw Object.assign(new Error(`telemetry write failed: ${err.message}`), { code: 1 });
    }
    const telemetryOutcome = named === "SUCCESS" ? "succeeded" : named === "NO-OP" ? "skipped" : named === "BLOCKED" || named === "STALLED" || named === "EXHAUSTED" ? "held" : "unknown";
    const telemetry = {
      runId: details.runId,
      lane,
      event: "terminal",
      phase: "outcome",
      outcome: telemetryOutcome,
      ...(typeof details.repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(details.repo) ? { repo: details.repo } : {}),
      ...(Number.isSafeInteger(Number(details.pr)) && Number(details.pr) >= 0 ? { pr: Number(details.pr) } : {}),
      ...(typeof details.headSha === "string" && /^[a-f0-9]{40,64}$/i.test(details.headSha) ? { headSha: details.headSha } : {}),
      terminal: { state: named },
    };
    try {
      recordTelemetryEvent(telemetryFile, telemetry);
    } catch (error) {
      if (isTelemetryValidationError(error) || requireWrite) throw error;
    }
    console.log(`TERMINAL_STATE=${named}`);
    return named;
  };
}
