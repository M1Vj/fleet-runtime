import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export function makeTerminal(root, { lane = "unknown", requireWrite = false } = {}) {
  const eventsPath = path.join(root, "state", "events.jsonl");
  return function terminal(state, details = {}) {
    const named = ["SUCCESS", "NO-OP", "BLOCKED", "STALLED", "EXHAUSTED"].includes(state) ? state : "BLOCKED";
    const record = JSON.stringify({ t: new Date().toISOString(), lane, state: named, ...details });
    try {
      mkdirSync(path.dirname(eventsPath), { recursive: true });
      appendFileSync(eventsPath, record + "\n");
    } catch (err) {
      if (requireWrite) throw Object.assign(new Error(`telemetry write failed: ${err.message}`), { code: 1 });
    }
    console.log(`TERMINAL_STATE=${named}`);
    return named;
  };
}
