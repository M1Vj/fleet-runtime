#!/usr/bin/env node
import process from "node:process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MAX_EVIDENCE_CHARS = 8000;
const SAFE_ENV_KEYS = ["CI", "HOME", "LANG", "LC_ALL", "NODE_ENV", "PATH", "TMPDIR"];
const SECRET_OUTPUT_PATTERNS = [
  /(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{20,}/gi,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /([?&](?:token|key|secret|password|passwd)=)[^&\s]+/gi,
];

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
  let output = String(value || "");
  for (const pattern of SECRET_OUTPUT_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  return output;
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
  mkdirSync(path.dirname(output), { recursive: true });
  if (!existsSync(target)) {
    evidence.push("target checkout unavailable");
    writeFileSync(output, trimEvidence(evidence.join("\n"), maxEvidenceChars), "utf8");
    return { ok: false, visual: false, evidence: evidence.join("\n") };
  }
  evidence.push("target checkout present");
  const pkgPath = path.join(target, "package.json");
  if (!existsSync(pkgPath)) {
    evidence.push("no package.json; skipped npm install/build/test");
    const text = trimEvidence(evidence.join("\n"), maxEvidenceChars);
    writeFileSync(output, text, "utf8");
    return { ok: true, visual: false, evidence: text };
  }
  let scripts = {};
  try {
    scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts || {};
  } catch {
    evidence.push("package.json unreadable");
    const text = trimEvidence(evidence.join("\n"), maxEvidenceChars);
    writeFileSync(output, text, "utf8");
    return { ok: false, visual: false, evidence: text };
  }
  const install = runCommand("npm", ["install", "--no-audit", "--no-fund"], target, safeEnv, 420000);
  evidence.push(`npm install: exit=${install.status === null ? "timeout" : install.status}`);
  if (install.timedOut || install.status !== 0) {
    evidence.push(trimEvidence(install.output, 1800));
    const text = trimEvidence(evidence.join("\n"), maxEvidenceChars);
    writeFileSync(output, text, "utf8");
    return { ok: false, visual: false, evidence: text };
  }
  if (scripts.build) {
    const build = runCommand("npm", ["run", "build"], target, safeEnv, 600000);
    evidence.push(`npm run build: exit=${build.status === null ? "timeout" : build.status}`);
    if (build.timedOut || build.status !== 0) {
      evidence.push(trimEvidence(build.output, 1800));
      const text = trimEvidence(evidence.join("\n"), maxEvidenceChars);
      writeFileSync(output, text, "utf8");
      return { ok: false, visual: false, evidence: text };
    }
  }
  if (scripts.test) {
    const testResult = runCommand("npm", ["test"], target, safeEnv, 420000);
    evidence.push(`npm test: exit=${testResult.status === null ? "timeout" : testResult.status}`);
    if (testResult.timedOut || testResult.status !== 0) {
      evidence.push(trimEvidence(testResult.output, 1800));
      const text = trimEvidence(evidence.join("\n"), maxEvidenceChars);
      writeFileSync(output, text, "utf8");
      return { ok: false, visual: false, evidence: text };
    }
  }
  evidence.push("visual checks: skipped by policy");
  const text = trimEvidence(evidence.join("\n"), maxEvidenceChars);
  writeFileSync(output, text, "utf8");
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
