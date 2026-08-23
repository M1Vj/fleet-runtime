import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { sha256 } from "./util.mjs";

export function eventKey(kind, repo, subjectId, activityRef) {
  const material = `${kind}|${repo}|${subjectId}|${activityRef}`;
  return sha256(material);
}

export function loadLedger(filePath) {
  const seen = new Set();
  if (!existsSync(filePath)) return seen;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.k === "string") seen.add(obj.k);
    } catch {
      continue;
    }
  }
  return seen;
}

export function has(seen, key) {
  return seen.has(key);
}

export function append(filePath, key, meta = {}) {
  appendFileSync(filePath, JSON.stringify({ k: key, t: new Date().toISOString(), ...meta }) + "\n");
}
