import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export function makeTerminal(root) {
  const eventsPath = path.join(root, "state", "events.jsonl");
  return function terminal(state, details = {}) {
    const named = ["SUCCESS", "NO-OP", "BLOCKED", "STALLED", "EXHAUSTED"].includes(state) ? state : "BLOCKED";
    try {
      mkdirSync(path.dirname(eventsPath), { recursive: true });
      appendFileSync(eventsPath, JSON.stringify({ t: new Date().toISOString(), state: named, ...details }) + "\n");
    } catch {}
    console.log(`TERMINAL_STATE=${named}`);
    return named;
  };
}
