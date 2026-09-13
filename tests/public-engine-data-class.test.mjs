import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DataClassError,
  isPublicDataClass,
  publicChildEnv,
  privateRepository,
  PRIVATE_REPOSITORY_ENV,
  publicRepository,
  publicTargetDecision,
  resolveArtifactManifest,
  resolveStateRoot,
  writePublicArtifact,
} from "../scripts/lib/private-state.mjs";
import { runGate } from "../scripts/lib/gate.mjs";
import { gh } from "../scripts/lib/util.mjs";
import { planWatchdogActions } from "../scripts/lib/watchdog-decide.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const KEEPALIVE_INSTALLER = path.join(ROOT, "scripts", "install-keepalive.sh");
const LEGACY_CHECKOUT_MARKER = ["fleet", "private", "checkout"].join("-");
const LEGACY_CONTROL_PATH_MARKER = ["Projects", "fleet", "control"].join("/");
const PRIVATE_REPOSITORY_MARKER = ["M1Vj", ["fleet", "control"].join("-")].join("/");
const SECRET_TOKEN_MARKER = ["ghp", "012345678901234567890123456789012345"].join("_");

function keepaliveFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-keepalive-test-"));
  const home = path.join(root, "home");
  const checkout = path.join(root, "private checkout & verified");
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  const bin = path.join(root, "bin");
  mkdirSync(path.join(checkout, "scripts"), { recursive: true });
  mkdirSync(launchAgents, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(checkout, "scripts", "refresh-auth-secret.mjs"), "// fixture\n");
  const launchctl = path.join(bin, "launchctl");
  writeFileSync(launchctl, "#!/bin/sh\nexit 0\n");
  chmodSync(launchctl, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH || ""}`,
    FLEET_CONTROL_CHECKOUT: checkout,
    FLEET_CONTROL_REPOSITORY: "fixture-owner/control-repository",
  };
  return {
    root,
    checkout,
    plistPath: path.join(launchAgents, "com.m1vj.fleet-auth-refresh.plist"),
    env,
    run(overrides = {}) {
      return spawnSync("bash", [KEEPALIVE_INSTALLER], {
        encoding: "utf8",
        env: { ...env, ...overrides },
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function publicEnv(root = mkdtempSync(path.join(tmpdir(), "fleet-public-test-"))) {
  return {
    FLEET_DATA_CLASS: "public",
    FLEET_PUBLIC_OWNER: "M1Vj",
    FLEET_PUBLIC_REPOSITORY: "M1Vj/public-repo",
    RUNNER_TEMP: root,
    FLEET_PUBLIC_STATE_ROOT: path.join(root, "state"),
    FLEET_PUBLIC_ARTIFACT_MANIFEST: path.join(root, "state", "manifest.json"),
    GITHUB_TOKEN: "built-in-token",
    FLEET_GH_TOKEN: "must-not-be-used",
    FLEET_OPENCODE_AUTH: "private-auth",
    FLEET_PROXY_URL: "http://private-proxy.invalid",
  };
}

test("data class defaults to private and rejects explicit typos", () => {
  assert.equal(isPublicDataClass({}), false);
  assert.throws(() => isPublicDataClass({ FLEET_DATA_CLASS: "shared" }), DataClassError);
});

test("private destinations are execution-time configuration and blocked in public mode", () => {
  assert.equal(privateRepository({ FLEET_CONTROL_REPOSITORY: "fixture-owner/control-repository" }, PRIVATE_REPOSITORY_ENV.control), "fixture-owner/control-repository");
  assert.throws(() => privateRepository({}, PRIVATE_REPOSITORY_ENV.control), /PRIVATE_REPOSITORY_REQUIRED/);
  assert.throws(() => privateRepository({ FLEET_DATA_CLASS: "public", FLEET_CONTROL_REPOSITORY: "fixture-owner/control-repository" }, PRIVATE_REPOSITORY_ENV.control), /PUBLIC_PRIVATE_REPOSITORY_BLOCKED/);
});

test("public state and artifact resolve only inside runner temp", () => {
  const env = publicEnv();
  assert.equal(resolveStateRoot(env), env.FLEET_PUBLIC_STATE_ROOT);
  assert.equal(resolveArtifactManifest(env), env.FLEET_PUBLIC_ARTIFACT_MANIFEST);
  assert.throws(() => resolveStateRoot({ ...env, FLEET_PUBLIC_STATE_ROOT: "/tmp/private-state" }), /PUBLIC_STATE_OUTSIDE_RUNNER_TEMP/);
});

test("public target decision fails closed for owner, visibility, archive, and malformed metadata", () => {
  assert.deepEqual(publicTargetDecision({ name: "public-repo", owner: { login: "M1Vj" }, private: false, visibility: "public" }), { ok: true, repository: "M1Vj/public-repo" });
  assert.equal(publicTargetDecision({ name: "x", owner: { login: "other" }, private: false, visibility: "public" }).ok, false);
  assert.equal(publicTargetDecision({ name: "x", owner: { login: "M1Vj" }, private: true, visibility: "private" }).ok, false);
  assert.equal(publicTargetDecision({ name: "x", owner: { login: "M1Vj" }, private: false, visibility: "public", archived: true }).ok, false);
  assert.equal(publicRepository(publicEnv()), "M1Vj/public-repo");
});

test("public gate uses only built-in token and live public metadata before target access", async () => {
  const env = publicEnv();
  const calls = [];
  const identity = await runGate(env, {
    dataClass: "public",
    repository: env.FLEET_PUBLIC_REPOSITORY,
    token: env.GITHUB_TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ name: "public-repo", owner: { login: "M1Vj" }, private: false, visibility: "public", archived: false }) };
    },
  });
  assert.equal(identity.dataClass, "public");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/repos\/M1Vj\/public-repo$/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer built-in-token");
  assert.equal(calls[0].options.headers["User-Agent"], "fleet-public-read");
});

test("public child environment strips private state, auth, proxy, and session material", () => {
  const env = publicEnv();
  const child = publicChildEnv(env);
  assert.equal(child.FLEET_DATA_CLASS, "public");
  assert.equal(child.FLEET_STATE_ROOT, env.FLEET_PUBLIC_STATE_ROOT);
  assert.equal(child.FLEET_GH_TOKEN, undefined);
  assert.equal(child.FLEET_OPENCODE_AUTH, undefined);
  assert.equal(child.FLEET_PROXY_URL, undefined);
  assert.equal(child.GITHUB_TOKEN, env.GITHUB_TOKEN);
  const model = publicChildEnv(env, { forModel: true });
  assert.equal(model.GITHUB_TOKEN, undefined);
});

test("public artifacts use the exact manifest and schema allowlist", () => {
  const env = publicEnv();
  const manifest = writePublicArtifact(env, { repo: env.FLEET_PUBLIC_REPOSITORY, target: env.FLEET_PUBLIC_REPOSITORY, reply: "private prompt output", token: "secret", findings: [{ title: "public" }], checks: { target: env.FLEET_PUBLIC_REPOSITORY } }, { kind: "probe", status: "ok", repository: env.FLEET_PUBLIC_REPOSITORY });
  assert.equal(manifest, env.FLEET_PUBLIC_ARTIFACT_MANIFEST);
  const data = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(data.schema, "fleet-public-artifact-v1");
  assert.equal(data.dataClass, "public");
  assert.equal(data.reply, undefined);
  assert.equal(data.token, undefined);
  assert.equal(data.repo, env.FLEET_PUBLIC_REPOSITORY);
  assert.equal(data.target, env.FLEET_PUBLIC_REPOSITORY);
  assert.equal(data.checks.target, env.FLEET_PUBLIC_REPOSITORY);
  assert.equal(data.findings[0].title, "public");
});

test("public artifacts recursively omit nested private provenance and preserve safe result fields", () => {
  const env = publicEnv();
  const manifest = writePublicArtifact(env, {
    results: {
      ok: true,
      title: "safe result",
      source: "private source text",
      log: "private log line",
      artifact: "private artifact path",
      prompt: "private prompt",
      session: "private session",
      privateState: "private state",
      path: "private/path",
      url: "https://private.invalid",
      repository: "M1Vj/private-target",
    },
    checks: {
      model: "public-model",
      digestBytes: 12,
      source: "drop this",
      repository: { owner: "M1Vj", name: "private-target" },
    },
  }, { kind: "nested", status: "ok", repository: env.FLEET_PUBLIC_REPOSITORY });
  const data = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(data.results.ok, true);
  assert.equal(data.results.title, "safe result");
  for (const key of ["source", "log", "artifact", "prompt", "session", "privateState", "path", "url", "repository"]) {
    assert.equal(data.results[key], undefined, `nested ${key} must be omitted`);
  }
  assert.equal(data.checks.model, "public-model");
  assert.equal(data.checks.digestBytes, 12);
  assert.equal(data.checks.source, undefined);
  assert.equal(data.checks.repository, undefined);
  assert.equal(JSON.stringify(data).includes("private-target"), false);
});

test("public artifacts fail closed for sensitive top-level fields and tainted text", () => {
  const env = publicEnv();
  const manifest = writePublicArtifact(env, {
    path: "/Users/vjmabansag/private/prompt.log",
    target_path: "/Users/vjmabansag/private/target.md",
    url: "https://private.example/session/abc",
    prUrl: "https://github.com/M1Vj/private-target/pull/1",
    repo: "M1Vj/private-target",
    target: "M1Vj/private-target",
    privateState: "private state payload",
    prompt: "private prompt fragment",
    log: "private log fragment",
    source: "private source fragment",
    session: "private session fragment",
    summary: "source=/Users/vjmabansag/private/prompt.log",
    error: "request failed at https://private.example/session/abc",
    checks: {
      status: "ok",
      target: "M1Vj/private-target",
      note: "prompt=/Users/vjmabansag/private/prompt.log",
      detail: "log=https://private.example/session/abc",
      token: SECRET_TOKEN_MARKER,
    },
    results: [{
      title: "safe result",
      msg: "session=/Users/vjmabansag/private/session.json",
    }],
  }, { kind: "privacy", status: "ok", repository: env.FLEET_PUBLIC_REPOSITORY });
  const data = JSON.parse(readFileSync(manifest, "utf8"));
  for (const key of ["path", "target_path", "url", "prUrl", "repo", "target", "privateState", "prompt", "log", "source", "session"]) {
    assert.equal(data[key], undefined, `top-level ${key} must be omitted`);
  }
  assert.equal(data.summary, undefined);
  assert.equal(data.error, undefined);
  assert.equal(data.checks.status, "ok");
  assert.equal(data.checks.target, undefined);
  assert.equal(data.checks.note, undefined);
  assert.equal(data.checks.detail, undefined);
  assert.equal(data.checks.token, undefined);
  assert.equal(data.results[0].title, "safe result");
  assert.equal(data.results[0].msg, undefined);
  for (const marker of ["/Users/vjmabansag", "M1Vj/private-target", ["ghp", "0123456789"].join("_")]) {
    assert.equal(JSON.stringify(data).includes(marker), false, `artifact must not contain ${marker}`);
  }
});

test("public artifacts retain only bounded summary/error codes and public PR URLs", () => {
  const env = publicEnv();
  const manifest = writePublicArtifact(env, {
    summary: "public status digest completed",
    error: "MODEL_UNAVAILABLE",
    prUrl: "https://github.com/M1Vj/public-repo/pull/7",
  }, { kind: "bounded", status: "ok", repository: env.FLEET_PUBLIC_REPOSITORY });
  const data = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(data.summary, "public status digest completed");
  assert.equal(data.error, "MODEL_UNAVAILABLE");
  assert.equal(data.prUrl, "https://github.com/M1Vj/public-repo/pull/7");
});

test("public artifact target fields cannot replace the validated repository identity", () => {
  const env = publicEnv();
  const manifest = writePublicArtifact(env, {
    target: PRIVATE_REPOSITORY_MARKER,
    checks: { target: PRIVATE_REPOSITORY_MARKER },
    selected: { repo: PRIVATE_REPOSITORY_MARKER },
    verdict: PRIVATE_REPOSITORY_MARKER,
    title: PRIVATE_REPOSITORY_MARKER,
    why: PRIVATE_REPOSITORY_MARKER,
    reason: PRIVATE_REPOSITORY_MARKER,
    findings: [{ detail: PRIVATE_REPOSITORY_MARKER }, { detail: "OtherOwner/other-repo" }],
  }, { kind: "target-identity", status: "ok", repository: env.FLEET_PUBLIC_REPOSITORY });
  const data = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(data.target, undefined);
  assert.equal(data.checks.target, undefined);
  assert.equal(data.selected.repo, undefined);
  assert.equal(data.verdict, undefined);
  assert.equal(data.title, undefined);
  assert.equal(data.why, undefined);
  assert.equal(data.reason, undefined);
  assert.equal(data.findings[0].detail, undefined);
  assert.equal(data.findings[1].detail, undefined);
  assert.equal(JSON.stringify(data).includes(PRIVATE_REPOSITORY_MARKER), false);
  assert.equal(JSON.stringify(data).includes("OtherOwner/other-repo"), false);
});

test("public artifact identity comes only from the validated target option", () => {
  const env = publicEnv();
  const manifest = writePublicArtifact(env, {
    repository: "fixture-owner/private-repository",
    results: { repository: "fixture-owner/private-repository" },
  }, { kind: "identity", status: "ok", repository: env.FLEET_PUBLIC_REPOSITORY });
  const data = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(data.repository, env.FLEET_PUBLIC_REPOSITORY);
  assert.equal(data.results.repository, undefined);
  assert.equal(JSON.stringify(data).includes("private-repository"), false);
});

test("public GitHub helper blocks all mutations and watchdog emits no actions", () => {
  const env = publicEnv();
  assert.throws(() => gh(["api", "-X", "POST", "/repos/M1Vj/public-repo/issues"], env), /PUBLIC_WRITE_BLOCKED/);
  assert.throws(() => gh(["pr", "merge", "1", "-R", "M1Vj/public-repo"], env), /PUBLIC_WRITE_BLOCKED/);
  const plan = planWatchdogActions({ lastRunUtc: new Date(Date.now() - 4 * 3600 * 1000).toISOString() }, Date.now(), 90 * 60 * 1000, { dataClass: "public" });
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.readOnly, true);
});

test("keepalive installer fails closed when the checkout is not explicitly configured", () => {
  const fixture = keepaliveFixture();
  try {
    const result = fixture.run({ FLEET_CONTROL_CHECKOUT: undefined, FLEET_CONTROL_REPOSITORY: undefined });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FLEET_CONTROL_CHECKOUT is required/);
    assert.equal(existsSync(fixture.plistPath), false);
  } finally {
    fixture.cleanup();
  }
});

test("keepalive installer fails closed when the private repository is not explicitly configured", () => {
  const fixture = keepaliveFixture();
  try {
    const result = fixture.run({ FLEET_CONTROL_REPOSITORY: undefined });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FLEET_CONTROL_REPOSITORY is required/);
    assert.equal(existsSync(fixture.plistPath), false);
  } finally {
    fixture.cleanup();
  }
});

test("keepalive installer blocks the public data class", () => {
  const fixture = keepaliveFixture();
  try {
    const result = fixture.run({ FLEET_DATA_CLASS: "public" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public data class/i);
    assert.equal(existsSync(fixture.plistPath), false);
  } finally {
    fixture.cleanup();
  }
});

test("keepalive installer writes only caller-provided checkout and repository metadata", () => {
  const fixture = keepaliveFixture();
  try {
    const result = fixture.run();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const plist = readFileSync(fixture.plistPath, "utf8");
    const escapedCheckout = fixture.checkout.replaceAll("&", "&amp;");
    assert.equal(plist.includes(`<key>WorkingDirectory</key><string>${escapedCheckout}</string>`), true);
    assert.match(plist, /<key>FLEET_CONTROL_REPOSITORY<\/key><string>fixture-owner\/control-repository<\/string>/);
    assert.match(plist, /<key>FLEET_DATA_CLASS<\/key><string>private<\/string>/);
    assert.doesNotMatch(plist, new RegExp(`${LEGACY_CHECKOUT_MARKER}|${LEGACY_CONTROL_PATH_MARKER}`, "i"));
  } finally {
    fixture.cleanup();
  }
});

test("keepalive installer source does not embed a private checkout identity", () => {
  const source = readFileSync(KEEPALIVE_INSTALLER, "utf8");
  assert.doesNotMatch(source, new RegExp(`${LEGACY_CHECKOUT_MARKER}|${LEGACY_CONTROL_PATH_MARKER}`, "i"));
});
