#!/usr/bin/env node
import process from "node:process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redactText } from "./lib/pr-memory.mjs";

export const MAX_EVIDENCE_CHARS = 8000;
export const EVIDENCE_ENVELOPE_VERSION = "FLEET_EVIDENCE_V1";
const SAFE_ENV_KEYS = ["CI", "HOME", "LANG", "LC_ALL", "NODE_ENV", "PATH", "TMPDIR"];

export function buildTargetEnv(source = process.env) {
  const safe = {};
  for (const key of SAFE_ENV_KEYS) {
    if (source[key] !== undefined) safe[key] = String(source[key]);
  }
  const root = String(source.RUNNER_TEMP || source.TMPDIR || tmpdir());
  safe.HOME = path.join(root, "fleet-pr-check-home");
  safe.NPM_CONFIG_CACHE = path.join(safe.HOME, "npm-cache");
  mkdirSync(safe.HOME, { recursive: true });
  mkdirSync(safe.NPM_CONFIG_CACHE, { recursive: true });
  return safe;
}

export function sanitizeEvidence(value) {
  return redactText(String(value || ""));
}

function unavailableEvidenceText(value) {
  const text = String(value || "").trim();
  return text.length === 0 || /^(?:target-check\s+)?evidence\s+unavailable\s*$/i.test(text);
}

/** Mark whether the sanitizer received a trusted raw artifact before upload. */
export function encodeEvidenceEnvelope(value, { available = false, maxChars = MAX_EVIDENCE_CHARS } = {}) {
  const limit = Math.max(1, Math.min(MAX_EVIDENCE_CHARS, Number(maxChars) || MAX_EVIDENCE_CHARS));
  const text = sanitizeEvidence(String(value || ""))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .slice(-limit);
  const trusted = available === true && !unavailableEvidenceText(text);
  return `${EVIDENCE_ENVELOPE_VERSION}\navailable=${trusted ? "true" : "false"}\n\n${text}`;
}

/** Fail closed when a canonical artifact lacks a trusted availability marker. */
export function decodeEvidenceEnvelope(value) {
  const match = String(value || "").match(new RegExp(`^${EVIDENCE_ENVELOPE_VERSION}\\navailable=(true|false)\\n\\n([\\s\\S]*)$`));
  if (!match) return { available: false, text: "", reason: "missing-marker" };
  const text = match[2];
  const available = match[1] === "true" && !unavailableEvidenceText(text);
  return { available, text: available ? text : "", reason: available ? "ok" : "unavailable" };
}

function evidenceParent(output) {
  const absolute = path.resolve(String(output || ""));
  if (path.basename(absolute) !== "evidence.txt" || path.basename(path.dirname(absolute)) !== "target-check") {
    throw new Error("EVIDENCE_PATH_INVALID");
  }
  const parent = path.dirname(absolute);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("EVIDENCE_PARENT_UNSAFE");
  return { absolute, parent };
}

/** Write evidence with a private temp file and atomic same-directory rename. */
export function writeEvidenceSafe(output, value) {
  const { absolute, parent } = evidenceParent(output);
  const temp = path.join(parent, `.evidence-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  let fd = null;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    writeFileSync(fd, String(value || ""), { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, absolute);
    chmodSync(absolute, 0o600);
  } finally {
    if (fd !== null) closeSync(fd);
    try { rmSync(temp, { force: true }); } catch {}
  }
  return absolute;
}

function trimEvidence(value, maxChars) {
  return sanitizeEvidence(String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")).slice(-Math.max(1, Math.min(MAX_EVIDENCE_CHARS, Number(maxChars) || MAX_EVIDENCE_CHARS)));
}

function runCommand(command, args, cwd, env, timeout) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.error && result.error.code === "ETIMEDOUT",
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

export async function runChecks({
  targetDir = process.env.FLEET_TARGET_DIR || process.cwd(),
  evidencePath = process.env.FLEET_EVIDENCE_PATH || path.join(process.cwd(), "target-check", "evidence.txt"),
  maxEvidenceChars = MAX_EVIDENCE_CHARS,
  env = process.env,
} = {}) {
  const evidence = [];
  const safeEnv = buildTargetEnv(env);
  const target = path.resolve(targetDir);
  const output = path.resolve(evidencePath);
  evidenceParent(output);
  if (!existsSync(target)) {
    evidence.push("target checkout unavailable");
    writeEvidenceSafe(output, trimEvidence(evidence.join("\n"), maxEvidenceChars));
    return { ok: false, visual: false, evidence: evidence.join("\n") };
  }
  evidence.push("target checkout present");
  const pkgPath = path.join(target, "package.json");
  if (!existsSync(pkgPath)) {
    evidence.push("unsupported target: package.json missing; no declared build/test contract");
    const text = trimEvidence(evidence.join("\n"), maxEvidenceChars);
    writeEvidenceSafe(output, text);
    return { ok: false, visual: false, evidence: text };
  }
  let scripts = {};
  try {
    scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts || {};
  } catch {
    evidence.push("package.json unreadable");
    const text = trimEvidence(evidence.join("\n"), maxEvidenceChars);
    writeEvidenceSafe(output, text);
    return { ok: false, visual: false, evidence: text };
  }
  if (!scripts.build && !scripts.test) {
    evidence.push("unsupported Node target: package.json declares no build or test script");
    const text = trimEvidence(evidence.join("\n"), maxEvidenceChars);
    writeEvidenceSafe(output, text);
    return { ok: false, visual: false, evidence: text };
  }
  const install = runCommand("npm", ["install", "--no-audit", "--no-fund"], target, safeEnv, 420000);
  evidence.push(`npm install: exit=${install.status === null ? "timeout" : install.status}`);
  if (install.timedOut || install.status !== 0) {
    evidence.push(trimEvidence(install.output, 1800));
    const text = trimEvidence(evidence.join("\n"), maxEvidenceChars);
    writeEvidenceSafe(output, text);
    return { ok: false, visual: false, evidence: text };
  }
  if (scripts.build) {
    const build = runCommand("npm", ["run", "build"], target, safeEnv, 600000);
    evidence.push(`npm run build: exit=${build.status === null ? "timeout" : build.status}`);
    if (build.timedOut || build.status !== 0) {
      evidence.push(trimEvidence(build.output, 1800));
      const text = trimEvidence(evidence.join("\n"), maxEvidenceChars);
      writeEvidenceSafe(output, text);
      return { ok: false, visual: false, evidence: text };
    }
  }
  if (scripts.test) {
    const testResult = runCommand("npm", ["test"], target, safeEnv, 420000);
    evidence.push(`npm test: exit=${testResult.status === null ? "timeout" : testResult.status}`);
    if (testResult.timedOut || testResult.status !== 0) {
      evidence.push(trimEvidence(testResult.output, 1800));
      const text = trimEvidence(evidence.join("\n"), maxEvidenceChars);
      writeEvidenceSafe(output, text);
      return { ok: false, visual: false, evidence: text };
    }
  }
  evidence.push("visual checks: skipped by policy");
  const text = trimEvidence(evidence.join("\n"), maxEvidenceChars);
  writeEvidenceSafe(output, text);
  return { ok: true, visual: false, evidence: text };
}

export async function main(env = process.env) {
  const result = await runChecks({
    targetDir: env.FLEET_TARGET_DIR,
    evidencePath: env.FLEET_EVIDENCE_PATH,
    maxEvidenceChars: Number(env.FLEET_MAX_EVIDENCE_CHARS) || MAX_EVIDENCE_CHARS,
    env,
  });
  const output = env.GITHUB_OUTPUT;
  const lines = [`pr_check_ok=${result.ok ? "true" : "false"}`, "pr_check_visual=false"];
  if (output) appendFileSync(output, `${lines.join("\n")}\n`, "utf8");
  console.log(`PR_CHECK_STATE=${result.ok ? "PASSED" : "FAILED"}`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`PR_CHECK_FAILED reason=${String(error.message).slice(0, 240)}`);
    process.exit(1);
  });
}
