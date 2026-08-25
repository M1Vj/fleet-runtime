import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { askModel, runOnce } from "../scripts/lib/model.mjs";
import { classifyProviderAuthFailure, providerAuthStatus, resolveProviderAuth } from "../scripts/lib/provider-auth.mjs";

const mergeWorkflow = readFileSync(new URL("../.github/workflows/merge.yml", import.meta.url), "utf8");

function tempPair(prefix) {
  return {
    repo: mkdtempSync(path.join(tmpdir(), `${prefix}-repo-`)),
    state: mkdtempSync(path.join(tmpdir(), `${prefix}-state-`)),
  };
}

function spawnChild({ stdout = "", stderr = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

test("provider auth resolution prefers the durable key and labels legacy snapshots as migration-only", () => {
  assert.deepEqual(resolveProviderAuth({ OPENCODE_API_KEY: " pk-fixture ", FLEET_OPENCODE_AUTH: "snapshot" }), { ok: true, mode: "provider-key" });
  const migrationOnly = resolveProviderAuth({ FLEET_OPENCODE_AUTH: "snapshot" });
  assert.equal(migrationOnly.ok, true);
  assert.equal(migrationOnly.mode, "legacy-oauth-migration");
  assert.deepEqual(resolveProviderAuth({}), { ok: false, mode: "none", reason: "MODEL_AUTH_MISSING", retryable: true });
});

test("the health-checked adapter refuses missing credentials before any model call", () => {
  assert.equal(providerAuthStatus({}, { circuitOpen: false }).ready, false);
  assert.equal(providerAuthStatus({}, {}).stage, "credentials");
  const circuit = providerAuthStatus({ OPENCODE_API_KEY: "pk" }, { circuitOpen: true });
  assert.equal(circuit.ready, false);
  assert.equal(circuit.stage, "health");
  assert.deepEqual(providerAuthStatus({ OPENCODE_API_KEY: "pk" }, { circuitOpen: false }), { ready: true, mode: "provider-key" });
});

test("credential rejection and exhaustion are classified for fail-closed handling", () => {
  assert.equal(classifyProviderAuthFailure("opencode: API error 401 Unauthorized: invalid api key"), "rejected");
  assert.equal(classifyProviderAuthFailure("request failed with 403 forbidden for this credential"), "rejected");
  assert.equal(classifyProviderAuthFailure("API error 402 Payment Required: insufficient credits"), "exhausted");
  assert.equal(classifyProviderAuthFailure("quota exceeded for this billing period"), "exhausted");
  assert.equal(classifyProviderAuthFailure("connect ECONNRESET"), null);
  assert.equal(classifyProviderAuthFailure(""), null);
});

test("missing model credentials fail closed without spawning a model process", async () => {
  const { repo, state } = tempPair("fleet-auth-missing");
  let spawns = 0;
  const spawnImpl = () => {
    spawns += 1;
    throw new Error("must not spawn without credentials");
  };
  try {
    const result = await askModel({
      prompt: "judge",
      timeoutMs: 1000,
      env: { FLEET_STATE_ROOT: state },
      repoRoot: repo,
      stateRoot: state,
      skipCircuitCheck: true,
      maxRounds: 2,
      spawnImpl,
    });
    assert.equal(result.complete, false);
    assert.equal(result.authMissing, true);
    assert.equal(result.modelMode, "auth-missing");
    assert.deepEqual(result.attempts.map((attempt) => attempt.skipped), ["model-auth-missing"]);
    assert.equal(spawns, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("rejected or exhausted credentials stop the ladder immediately without anonymous fallbacks", async () => {
  for (const [stderr, expected] of [
    ["API error 401 Unauthorized: invalid api key", "rejected"],
    ["API error 402 Payment Required: insufficient credits", "exhausted"],
  ]) {
    const { repo, state } = tempPair("fleet-auth-closed");
    const rounds = [];
    try {
      const result = await askModel({
        prompt: "judge",
        timeoutMs: 1000,
        env: { OPENCODE_API_KEY: "pk-fixture", FLEET_STATE_ROOT: state },
        repoRoot: repo,
        stateRoot: state,
        skipCircuitCheck: true,
        maxRounds: 4,
        spawnImpl: (_command, args) => {
          rounds.push(args[0]);
          return spawnChild({ stderr, code: 1 });
        },
      });
      assert.equal(result.complete, false);
      assert.equal(result.authState, expected);
      assert.equal(rounds.length, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  }
});

test("non-credential failures keep the existing ladder behavior", async () => {
  const { repo, state } = tempPair("fleet-auth-ladder");
  let rounds = 0;
  try {
    const result = await askModel({
      prompt: "judge",
      timeoutMs: 1000,
      env: { OPENCODE_API_KEY: "pk-fixture", FLEET_STATE_ROOT: state },
      repoRoot: repo,
      stateRoot: state,
      skipCircuitCheck: true,
      maxRounds: 1,
      spawnImpl: () => {
        rounds += 1;
        return spawnChild({ stderr: "connect ECONNRESET", code: 1 });
      },
    });
    assert.equal(result.complete, false);
    assert.equal(result.authState, undefined);
    assert.equal(rounds, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("the model process receives OPENCODE_API_KEY while other key-like variables stay stripped", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "fleet-auth-runonce-"));
  let capturedEnv;
  try {
    const result = await runOnce({
      prompt: "probe",
      timeoutMs: 1000,
      env: {
        OPENCODE_API_KEY: "pk-fixture",
        FLEET_GH_TOKEN: "gh-fixture",
        MY_API_TOKEN: "token-fixture",
        SERVICE_PASSWORD: "pw-fixture",
      },
      workspace,
      spawnImpl: (_command, _args, options) => {
        capturedEnv = options.env;
        return spawnChild({ stdout: '{"text":"ok"}\n', code: 0 });
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(capturedEnv.OPENCODE_API_KEY, "pk-fixture");
    assert.equal(capturedEnv.OPENCODE_AUTH_CONTENT, "");
    assert.equal(capturedEnv.FLEET_GH_TOKEN, undefined);
    assert.equal(capturedEnv.MY_API_TOKEN, undefined);
    assert.equal(capturedEnv.SERVICE_PASSWORD, undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("merge-gate workflows provision the provider key next to the legacy migration secret", () => {
  for (const section of ["  gate:", "      - name: autonomous revision"]) {
    const slice = mergeWorkflow.slice(mergeWorkflow.indexOf(section));
    assert.match(slice, /OPENCODE_API_KEY:\s*\$\{\{\s*secrets\.OPENCODE_API_KEY\s*\}\}/, section);
    assert.match(slice, /FLEET_OPENCODE_AUTH:\s*\$\{\{\s*secrets\.FLEET_OPENCODE_AUTH\s*\}\}/, section);
  }
});
