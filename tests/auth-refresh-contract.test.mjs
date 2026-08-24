import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const helperPath = fileURLToPath(new URL("../scripts/refresh-auth-secret.mjs", import.meta.url));
const installerPath = fileURLToPath(new URL("../scripts/install-keepalive.sh", import.meta.url));
const runbookPath = fileURLToPath(new URL("../docs/RUNBOOK.md", import.meta.url));
const helper = readFileSync(helperPath, "utf8");
const installer = readFileSync(installerPath, "utf8");
const runbook = readFileSync(runbookPath, "utf8");

function makeGhFixture() {
  const root = path.join(tmpdir(), `auth-refresh-gh-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const logPath = path.join(root, "gh-calls.jsonl");
  const ghPath = path.join(bin, "gh");
  writeFileSync(
    ghPath,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      "const value = readFileSync(0, \"utf8\");",
      "appendFileSync(process.env.GH_LOG, JSON.stringify({ args, value }) + \"\\n\");",
      'const repoIndex = args.indexOf("-R");',
      'if (process.env.GH_FAIL_REPO && repoIndex >= 0 && args[repoIndex + 1] === process.env.GH_FAIL_REPO) process.exit(23);',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { root, bin, ghPath, logPath };
}

function callsFrom(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runRefresh(fixture, args, extraEnv = {}) {
  return spawnSync(process.execPath, [helperPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      FLEET_GH_BIN: fixture.ghPath,
      GH_LOG: fixture.logPath,
      ...extraEnv,
    },
  });
}

test("auth refresh helper loops over both exact fleet repositories", () => {
  assert.match(helper, /const REPOS = \[\s*"M1Vj\/fleet-runtime",\s*"M1Vj\/fleet-control"\s*,?\s*\];/);
  assert.match(helper, /const GH_BIN = process\.env\.FLEET_GH_BIN \|\| "gh"/);
  assert.match(helper, /spawnSync\(GH_BIN/);
  assert.doesNotMatch(helper, /function setSecretLegacy/);
});

test("auth refresh helper uses only stdin and propagates gh failures", () => {
  assert.match(helper, /input: value/);
  assert.match(helper, /stdio: \["pipe", "inherit", "inherit"\]/);
  assert.doesNotMatch(helper, /process\.(stdout|stderr)\.write\([^;]*(?:value|content)/s);

  const fixture = makeGhFixture();
  try {
    const authFile = path.join(fixture.root, "auth.json");
    const authValue = "auth-fixture\n";
    writeFileSync(authFile, authValue);
    const authRun = runRefresh(fixture, [authFile]);
    assert.equal(authRun.status, 0, authRun.stderr);
    const authCalls = callsFrom(fixture.logPath);
    assert.deepEqual(authCalls.map((call) => call.args), [
      ["secret", "set", "FLEET_OPENCODE_AUTH", "-R", "M1Vj/fleet-runtime"],
      ["secret", "set", "FLEET_OPENCODE_AUTH", "-R", "M1Vj/fleet-control"],
    ]);
    assert.deepEqual(authCalls.map((call) => call.value), [authValue, authValue]);
    assert.doesNotMatch(authRun.stdout, new RegExp(authValue.trim()));

    const tokenFile = path.join(fixture.root, "token.txt");
    const tokenValue = "token-fixture\n";
    writeFileSync(tokenFile, tokenValue);
    writeFileSync(fixture.logPath, "");
    const tokenRun = runRefresh(fixture, ["--token", tokenFile]);
    assert.equal(tokenRun.status, 0, tokenRun.stderr);
    const tokenCalls = callsFrom(fixture.logPath);
    assert.deepEqual(tokenCalls.map((call) => call.args), [
      ["secret", "set", "FLEET_GH_TOKEN", "-R", "M1Vj/fleet-runtime"],
      ["secret", "set", "FLEET_GH_TOKEN", "-R", "M1Vj/fleet-control"],
    ]);
    assert.deepEqual(tokenCalls.map((call) => call.value), [tokenValue, tokenValue]);
    assert.doesNotMatch(tokenRun.stdout, new RegExp(tokenValue.trim()));

    writeFileSync(fixture.logPath, "");
    const failedRun = runRefresh(fixture, [authFile], { GH_FAIL_REPO: "M1Vj/fleet-control" });
    assert.equal(failedRun.status, 23);
    assert.equal(callsFrom(fixture.logPath).length, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("keepalive emits direct runtime ProgramArguments with absolute node and gh", () => {
  assert.match(installer, /FLEET_DIR="\$HOME\/Projects\/fleet-runtime"/);
  assert.match(installer, /NODE_BIN="\$\(command -v node\)"/);
  assert.match(installer, /GH_BIN="\$\(command -v gh\)"/);
  assert.match(installer, /EnvironmentVariables/);
  assert.doesNotMatch(installer, /<string>\/bin\/zsh<\/string>|<string>-lc<\/string>/);
  assert.match(installer, /WorkingDirectory/);
  assert.match(installer, /refresh-auth-secret\.mjs/);
  assert.doesNotMatch(installer, /fleet-control/);
});

test("installer preserves hostile paths as data in a valid direct-launch plist", () => {
  const root = path.join(tmpdir(), `auth-refresh-install-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const bin = path.join(root, "bin");
  const marker = path.join(root, "payload-ran");
  const hostileHome = path.join(root, `home spaces & \"quoted\" $(${`touch ${marker}`}) ${"`touch " + marker + "`"} slash\\name`);
  mkdirSync(bin, { recursive: true });
  mkdirSync(hostileHome, { recursive: true });
  const nodePath = path.join(bin, "node");
  const ghPath = path.join(bin, "gh");
  const launchctlPath = path.join(bin, "launchctl");
  const launchctlLog = path.join(root, "launchctl.log");
  symlinkSync(process.execPath, nodePath);
  symlinkSync(process.execPath, ghPath);
  writeFileSync(launchctlPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"\n`, { mode: 0o755 });
  chmodSync(launchctlPath, 0o755);

  try {
    const installRun = spawnSync("/bin/bash", [installerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: hostileHome,
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LAUNCHCTL_LOG: launchctlLog,
      },
    });
    assert.equal(installRun.status, 0, installRun.stderr);

    const plistPath = path.join(hostileHome, "Library", "LaunchAgents", "com.m1vj.fleet-auth-refresh.plist");
    const lintRun = spawnSync("plutil", ["-lint", plistPath], { encoding: "utf8" });
    assert.equal(lintRun.status, 0, lintRun.stderr);
    const jsonRun = spawnSync("plutil", ["-convert", "json", "-o", "-", plistPath], { encoding: "utf8" });
    assert.equal(jsonRun.status, 0, jsonRun.stderr);
    const plist = JSON.parse(jsonRun.stdout);
    const runtimeDir = path.join(hostileHome, "Projects", "fleet-runtime");
    const authPath = path.join(hostileHome, ".local", "share", "opencode", "auth.json");
    assert.deepEqual(plist.ProgramArguments, [nodePath, path.join(runtimeDir, "scripts", "refresh-auth-secret.mjs"), authPath]);
    assert.equal(plist.WorkingDirectory, runtimeDir);
    assert.equal(plist.EnvironmentVariables.FLEET_GH_BIN, ghPath);
    assert.ok(plist.EnvironmentVariables.PATH.split(":").includes(path.dirname(nodePath)));
    assert.ok(plist.EnvironmentVariables.PATH.split(":").includes(path.dirname(ghPath)));
    assert.equal(existsSync(marker), false);
    assert.notEqual(plist.ProgramArguments[0], "/bin/zsh");
    assert.notEqual(plist.ProgramArguments[1], "-lc");
    assert.equal(readFileSync(launchctlLog, "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runbook documents one helper refresh for both repositories and active sessions", () => {
  assert.match(runbook, /helper targets both `M1Vj\/fleet-runtime` and\s+`M1Vj\/fleet-control`/);
  assert.match(runbook, /active user session/);
  assert.doesNotMatch(runbook, /helper targets fleet-control only|mirror manually|while this Mac is on/);
});
