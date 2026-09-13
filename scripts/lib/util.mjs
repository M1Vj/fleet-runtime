import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertMutationAllowed,
  isPublicDataClass,
  publicStateRoot,
} from "./private-state.mjs";

export function sha256(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

export function utcNowISO() {
  return new Date().toISOString();
}

export function dayPath(iso = utcNowISO()) {
  return iso.slice(0, 10);
}

export function scrub(env) {
  const token = env.FLEET_GH_TOKEN || "";
  const auth = env.FLEET_OPENCODE_AUTH || "";
  // Pattern-based redaction alongside the exact-value replacement above:
  // catches token-shaped substrings even when the exact env value is
  // unknown (other actors' tokens, pasted creds in diffs/logs).
  const PATTERNS = [
    /(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{10,}/g,
    /github_pat_[A-Za-z0-9_]+/g,
    /AKIA[0-9A-Z]{16}/g,
    /sk-[A-Za-z0-9_-]{10,}/g,
    /xox[bpas]-[A-Za-z0-9-]+/g,
    /AIza[A-Za-z0-9_-]+/g,
    /Bearer\s+[A-Za-z0-9._~+/-]+/gi,
  ];
  return (str) => {
    let out = String(str ?? "");
    if (token) out = out.split(token).join("***");
    if (auth && auth.length > 16) out = out.split(auth).join("***");
    for (const re of PATTERNS) out = out.replace(re, "***");
    return out;
  };
}

export function retry(fn, { tries = 3, baseMs = 500 } = {}, onAttempt = () => {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      onAttempt(i);
      return fn();
    } catch (err) {
      lastErr = err;
      if (i < tries) {
        const ms = baseMs * Math.pow(2, i - 1);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      }
    }
  }
  throw lastErr;
}

function childEnv(env) {
  if (isPublicDataClass(env)) {
    const stateRoot = publicStateRoot(env);
    const out = {
      PATH: env.PATH || "/usr/bin:/bin:/usr/local/bin",
      // Keep gh from consulting a user's private config/token store.
      HOME: path.join(stateRoot, "home"),
      TMPDIR: env.TMPDIR || tmpdir(),
      GH_TOKEN: env.GITHUB_TOKEN || "",
      GH_HOST: "github.com",
      GH_CONFIG_DIR: path.join(stateRoot, "gh-config"),
    };
    return out;
  }
  return {
    PATH: env.PATH || "/usr/bin:/bin:/usr/local/bin",
    HOME: env.HOME || process.env.HOME || "/tmp",
    TMPDIR: env.TMPDIR || tmpdir(),
    GH_TOKEN: env.FLEET_GH_TOKEN || "",
    GH_HOST: "github.com",
  };
}

export function gh(args, env = process.env, { input } = {}) {
  if (isPublicDataClass(env)) assertPublicGhReadOnly(args);
  const redact = scrub(env);
  const res = spawnSync("gh", args, {
    env: childEnv(env),
    input: input === undefined ? undefined : String(input),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${redact(res.stderr || res.stdout || "unknown")}`);
  }
  const out = (res.stdout || "").trim();
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

function assertPublicGhReadOnly(args = []) {
  const values = args.map((value) => String(value));
  const methodIndex = values.findIndex((value) => /^-X$|^--method$|^-X=/.test(value));
  if (methodIndex >= 0) {
    const method = values[methodIndex].includes("=")
      ? values[methodIndex].split("=").at(-1)
      : values[methodIndex + 1];
    if (String(method || "GET").toUpperCase() !== "GET") {
      throw new Error(`PUBLIC_WRITE_BLOCKED: gh ${method}`);
    }
  }
  const explicitGet = methodIndex >= 0 && String(values[methodIndex].includes("=") ? values[methodIndex].split("=").at(-1) : values[methodIndex + 1] || "GET").toUpperCase() === "GET";
  if (!explicitGet && values.some((value) => /^--?(?:raw-)?field$|^-F$|^-f$|^--input$/.test(value))) {
    throw new Error("PUBLIC_WRITE_BLOCKED: gh request body");
  }
  if (methodIndex < 0 && values.some((value) => /^--?(?:raw-)?field$|^-F$|^-f$|^--input$/.test(value))) {
    throw new Error("PUBLIC_WRITE_BLOCKED: gh request body");
  }
  if (values[0] === "pr" && values.some((value) => /^(merge|ready|close|reopen|edit|comment|review|create)$/.test(value))) {
    throw new Error("PUBLIC_WRITE_BLOCKED: gh pr mutation");
  }
  if (values[0] === "workflow" && values.some((value) => /^(run|enable|disable|cancel)$/.test(value))) {
    throw new Error("PUBLIC_WRITE_BLOCKED: gh workflow mutation");
  }
}

export function putFileContent(repo, filePath, contentUtf8, branch, message, env = process.env) {
  assertMutationAllowed(env, `put file ${repo}/${filePath}`);
  let sha;
  try {
    const existing = gh(["api", `/repos/${repo}/contents/${filePath}?ref=${branch}`], env);
    if (existing && existing.sha) sha = existing.sha;
  } catch {
    sha = undefined;
  }
  return ghInput(
    ["api", "-X", "PUT", `/repos/${repo}/contents/${filePath}`],
    {
      message,
      content: Buffer.from(contentUtf8, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    },
    env,
  );
}

export function ensureBranch(repo, branch, baseSha, env = process.env) {
  assertMutationAllowed(env, `create branch ${repo}:${branch}`);
  try {
    gh(["api", "-X", "POST", `/repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${baseSha}`], env);
    return "created";
  } catch (err) {
    if (/422|already|exists/i.test(String(err.message))) return "exists";
    throw err;
  }
}

export function ghInput(prefixArgs, bodyObj, env = process.env) {
  assertMutationAllowed(env, `gh input ${prefixArgs.join(" ")}`);
  const tmp = path.join(mkdtempSync(path.join(tmpdir(), "ghin-")), "body.json");
  writeFileSync(tmp, JSON.stringify(bodyObj), "utf8");
  try {
    return gh([...prefixArgs, "--input", tmp], env);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function gitPush(repoDir, branch, env = process.env, { retries = 3 } = {}) {
  assertMutationAllowed(env, `git push ${branch}`);
  const redact = scrub(env);
  const dir = mkdtempSync(path.join(tmpdir(), "fleetcred-"));
  const helper = path.join(dir, "helper.sh");
  writeFileSync(
    helper,
    "#!/bin/sh\nprintf 'username=%s\\n' \"$FLEET_GH_USER\"\nprintf 'password=%s\\n' \"$FLEET_GH_TOKEN\"\n",
    { mode: 0o700 },
  );
  try {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const credArgs = ["-c", `credential.helper=${helper}`];
      const res = spawnSync("git", [...credArgs, "push", "origin", `HEAD:${branch}`], {
        cwd: repoDir,
        encoding: "utf8",
        env: { ...childEnv(env), FLEET_GH_USER: env.FLEET_EXPECT_LOGIN || "M1Vj", FLEET_GH_TOKEN: env.FLEET_GH_TOKEN },
      });
      if (res.status === 0) return true;
      const output = `${res.stderr || ""}${res.stdout || ""}`;
      if (/non-fast-forward|fetch first|rejected/i.test(output) && attempt < retries) {
        const pull = spawnSync("git", [...credArgs, "pull", "--rebase", "-X", "theirs", "origin", branch], {
          cwd: repoDir,
          encoding: "utf8",
          env: { ...childEnv(env), FLEET_GH_USER: env.FLEET_EXPECT_LOGIN || "M1Vj", FLEET_GH_TOKEN: env.FLEET_GH_TOKEN },
        });
        if (pull.status !== 0) {
          spawnSync("git", ["rebase", "--abort"], { cwd: repoDir });
          const mergePull = spawnSync("git", [...credArgs, "pull", "--no-rebase", "-X", "theirs", "origin", branch, "-m", "[fleet] merge concurrent state update"], {
            cwd: repoDir,
            encoding: "utf8",
            env: { ...childEnv(env), FLEET_GH_USER: env.FLEET_EXPECT_LOGIN || "M1Vj", FLEET_GH_TOKEN: env.FLEET_GH_TOKEN },
          });
          if (mergePull.status !== 0) {
            throw new Error(`git pull retry failed: ${redact(mergePull.stderr || mergePull.stdout || pull.stderr || pull.stdout)}`);
          }
        }
        continue;
      }
      throw new Error(`git push failed: ${redact(output || "unknown")}`);
    }
    throw new Error("git push exhausted retries");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function gitCommit(repoDir, message, identity) {
  assertMutationAllowed(process.env, "git commit");
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" });
  if (!(status.stdout || "").trim()) {
    return "no-changes";
  }
  const args = [
    "-c", `user.name=${identity.name}`,
    "-c", `user.email=${identity.noreply}`,
    "commit",
    "-m", message,
  ];
  const res = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git commit failed: ${res.stderr || res.stdout}`);
  return "committed";
}

export function gitAdd(repoDir, paths) {
  assertMutationAllowed(process.env, "git add");
  const res = spawnSync("git", ["add", ...paths], { cwd: repoDir, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git add failed: ${res.stderr || res.stdout}`);
  return true;
}

export function configureIdentity(repoDir, identity) {
  if (isPublicDataClass(process.env)) return false;
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoDir, encoding: "utf8" });
  if (probe.status !== 0) return false;
  for (const [k, v] of [["user.name", identity.name], ["user.email", identity.noreply]]) {
    const res = spawnSync("git", ["config", k, String(v)], { cwd: repoDir, encoding: "utf8" });
    if (res.status !== 0) return false;
  }
  return true;
}

export function gitHasChanges(repoDir, paths) {
  const res = spawnSync("git", ["status", "--porcelain", "--", ...paths], { cwd: repoDir, encoding: "utf8" });
  return Boolean((res.stdout || "").trim());
}

export function gitRevParse(repoDir, ref = "HEAD") {
  const res = spawnSync("git", ["rev-parse", ref], { cwd: repoDir, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`rev-parse failed: ${res.stderr}`);
  return (res.stdout || "").trim();
}

export function findExistingOpenPr(repoFullName, branch, env = process.env) {
  try {
    const res = gh(["api", `/repos/${repoFullName}/pulls?head=${encodeURIComponent("M1Vj:" + branch)}&state=open`], env);
    if (Array.isArray(res) && res.length > 0) return res[0];
  } catch {}
  return null;
}

export function safeCommitState(repoDir, subpaths, message, identity, pushEnv = process.env) {
  assertMutationAllowed(pushEnv, "commit state");
  const existing = subpaths.filter((p2) => existsSync(path.join(repoDir, p2)));
  const changed = existing.filter((p2) => {
    const res = spawnSync("git", ["status", "--porcelain", "--", p2], { cwd: repoDir, encoding: "utf8" });
    return Boolean((res.stdout || "").trim());
  });
  if (changed.length === 0) return "no-changes";
  gitAdd(repoDir, changed);
  const outcome = gitCommit(repoDir, message, identity);
  if (outcome === "committed") gitPush(repoDir, "main", pushEnv);
  return outcome;
}

export function installCredentialHelper(repoDir, env = process.env) {
  assertMutationAllowed(env, "install git credential helper");
  const helperPath = path.join(mkdtempSync(path.join(tmpdir(), "fleetcred2-")), "helper.sh");
  writeFileSync(
    helperPath,
    "#!/bin/sh\nprintf 'username=%s\\n' \"$FLEET_GH_USER\"\nprintf 'password=%s\\n' \"$FLEET_GH_TOKEN\"\n",
    { mode: 0o700 },
  );
  const res = spawnSync("git", ["config", "credential.helper", helperPath], { cwd: repoDir, encoding: "utf8", env: childEnv(env) });
  void res;
  return helperPath;
}
