#!/usr/bin/env node
import process from "node:process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encodeEvidenceEnvelope, writeEvidenceSafe } from "./pr-check.mjs";

export function sanitizeEvidenceArtifact(inputPath, outputPath, maxChars = 8000) {
  const input = path.resolve(String(inputPath || ""));
  const limit = Math.max(1, Math.min(8000, Number(maxChars) || 8000));
  let text = "target-check evidence unavailable\n";
  let available = false;
  try {
    const stat = lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit * 4) throw new Error("unsafe evidence artifact");
    text = readFileSync(input, "utf8");
    available = text.trim().length > 0 && !/^(?:target-check\s+)?evidence\s+unavailable\s*$/i.test(text.trim());
  } catch {}
  const safe = encodeEvidenceEnvelope(text, { available, maxChars: limit });
  writeEvidenceSafe(outputPath, safe);
  return safe;
}

export function main(env = process.env) {
  sanitizeEvidenceArtifact(env.EVIDENCE_INPUT, env.EVIDENCE_OUTPUT, env.MAX_EVIDENCE_CHARS);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`SANITIZE_EVIDENCE_FAILED ${String(error.message).slice(0, 240)}`);
    process.exit(1);
  }
}
