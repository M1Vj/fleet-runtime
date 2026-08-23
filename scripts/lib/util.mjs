import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

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
  return (str) => {
    let out = String(str ?? "");
    if (token) out = out.split(token).join("***");
    if (auth && auth.length > 16) out = out.split(auth).join("***");
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
        const until = Date.now() + ms;
        while (Date.now() < until) {}
      }
    }
  }
  throw lastErr;
}

function childEnv(env) {
  return {
    PATH: env.PATH || "/usr/bin:/bin:/usr/local/bin",
    HOME: env.HOME || process.env.HOME || "/tmp",
    TMPDIR: env.TMPDIR || tmpdir(),
    GH_TOKEN: env.FLEET_GH_TOKEN || "",
    GH_HOST: "github.com",
  };
}

export function gh(args, env = process.env, { input } = {}) {
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

export function putFileContent(repo, filePath, contentUtf8, branch, message, env = process.env) {
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
  try {
    gh(["api", "-X", "POST", `/repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${baseSha}`], env);
    return "created";
  } catch (err) {
    if (/422|already|exists/i.test(String(err.message))) return "exists";
    throw err;
  }
}

export function ghInput(prefixArgs, bodyObj, env = process.env) {
  const tmp = path.join(mkdtempSync(path.join(tmpdir(), "ghin-")), "body.json");
  writeFileSync(tmp, JSON.stringify(bodyObj), "utf8");
  try {
    return gh([...prefixArgs, "--input", tmp], env);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function gitPush(repoDir, branch, env = process.env, { retries = 3 } = {}) {
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
        const pull = spawnSync("git", [...credArgs, "pull", "--rebase", "origin", branch], {
          cwd: repoDir,
          encoding: "utf8",
          env: { ...childEnv(env), FLEET_GH_USER: env.FLEET_EXPECT_LOGIN || "M1Vj", FLEET_GH_TOKEN: env.FLEET_GH_TOKEN },
        });
        if (pull.status !== 0) throw new Error(`git pull --rebase failed: ${redact(pull.stderr || pull.stdout)}`);
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
  const res = spawnSync("git", ["add", ...paths], { cwd: repoDir, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git add failed: ${res.stderr || res.stdout}`);
  return true;
}

export function configureIdentity(repoDir, identity) {
  for (const [k, v] of [["user.name", identity.name], ["user.email", identity.noreply]]) {
    const res = spawnSync("git", ["config", k, String(v)], { cwd: repoDir, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git config ${k} failed`);
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
