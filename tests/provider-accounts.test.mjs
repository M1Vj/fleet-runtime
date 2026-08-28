import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { collectProviderAccountStatus, renderProviderAccountStatus, runProviderLogin } from "../scripts/provider-accounts.mjs";
import { loadProviderRegistry } from "../scripts/lib/provider-registry.mjs";

const registry = loadProviderRegistry();
const now = Date.parse("2026-08-27T00:10:00Z");

test("provider account status reports named slots without credential values", () => {
  const env = {
    GEMINI_API_KEY_1: "secret-key-one",
    GEMINI_API_KEY_2: "secret-key-two",
    GEMINI_API_KEY_1_QUOTA_GROUP: "project-one",
    GEMINI_API_KEY_2_QUOTA_GROUP: "project-two",
    OPENCODE_API_KEY: "secret-zen-key",
  };
  const status = collectProviderAccountStatus({
    registry,
    env,
    health: {
      "gemini-api": {
        status: "healthy",
        checkedAt: "2026-08-27T00:00:00Z",
        credentials: { "account-1": { status: "rejected", checkedAt: "2026-08-27T00:00:00Z" } },
      },
    },
    now,
  });
  const text = JSON.stringify(status);
  assert.doesNotMatch(text, /secret-key-one|secret-key-two|secret-zen-key|project-one|project-two/);
  const gemini = status.providers.find((provider) => provider.provider === "gemini-api");
  assert.deepEqual(gemini.credentials.map((credential) => credential.credential), ["account-1", "account-2"]);
  assert.equal(gemini.credentials[0].state, "present");
  assert.equal(gemini.credentials[0].health, "rejected");
  assert.equal(gemini.credentials[0].quotaGroupState, "configured");
});

test("owner login helper status remains secretless for the local Antigravity OAuth slot", () => {
  const text = renderProviderAccountStatus({
    registry,
    env: { FLEET_PROVIDER_HEALTH_JSON: "not-json", HOME: "/owner/home" },
    now,
    providerId: "antigravity",
  });
  assert.match(text, /"provider": "antigravity"/);
  assert.match(text, /"state": "local-only"/);
  assert.doesNotMatch(text, /owner\/home|keychain/i);
});

test("owner login launches the official Antigravity sandbox with an allowlisted environment", async () => {
  const calls = [];
  const child = new EventEmitter();
  const resultPromise = runProviderLogin({
    env: {
      HOME: "/owner/home",
      PATH: "/owner/bin",
      TERM: "xterm-256color",
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LC_API_KEY: "must-not-forward",
      OPENCODE_API_KEY: "must-not-forward",
      GEMINI_API_KEY_1: "must-not-forward",
      FLEET_GH_TOKEN: "must-not-forward",
    },
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "agy");
  assert.deepEqual(calls[0].args, ["--sandbox"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio, "inherit");
  assert.deepEqual(calls[0].options.env, {
    PATH: "/owner/bin",
    HOME: "/owner/home",
    TERM: "xterm-256color",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  });
});

test("provider account status maps arbitrary health text to a fixed safe value", () => {
  const status = collectProviderAccountStatus({
    registry,
    env: { GEMINI_API_KEY_1: "key", GEMINI_API_KEY_1_QUOTA_GROUP: "project-one" },
    health: {
      "gemini-api": {
        status: "ghp_abcdefghijklmnopqrstuvwxyz123456",
        checkedAt: "2026-08-27T00:00:00Z",
        credentials: { "account-1": { status: "LC_API_KEY-secret", checkedAt: "2026-08-27T00:00:00Z" } },
      },
    },
    now,
  });
  const text = JSON.stringify(status);
  assert.doesNotMatch(text, /ghp_|LC_API_KEY/);
  const gemini = status.providers.find((provider) => provider.provider === "gemini-api");
  assert.equal(gemini.providerHealth, "unknown");
  assert.equal(gemini.credentials[0].health, "unknown");
});

test("owner login rejects unknown providers, GitHub, and non-TTY execution before spawning", async () => {
  const spawnImpl = () => { throw new Error("must not spawn"); };
  await assert.rejects(() => runProviderLogin({ providerId: "unknown", stdin: { isTTY: true }, stdout: { isTTY: true }, spawnImpl }), /LOGIN_PROVIDER_UNSUPPORTED/);
  await assert.rejects(() => runProviderLogin({ env: { GITHUB_ACTIONS: "true" }, stdin: { isTTY: true }, stdout: { isTTY: true }, spawnImpl }), /LOGIN_GITHUB_UNSUPPORTED/);
  await assert.rejects(() => runProviderLogin({ env: {}, stdin: { isTTY: false }, stdout: { isTTY: true }, spawnImpl }), /LOGIN_TTY_REQUIRED/);
});

test("owner login reports launch failures and nonzero CLI exits", async () => {
  await assert.rejects(
    () => runProviderLogin({ stdin: { isTTY: true }, stdout: { isTTY: true }, spawnImpl: () => { throw new Error("launch failed"); } }),
    /LOGIN_SPAWN_FAILED/,
  );
  const child = new EventEmitter();
  const resultPromise = runProviderLogin({
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    spawnImpl: () => {
      queueMicrotask(() => child.emit("close", 7, "SIGTERM"));
      return child;
    },
  });
  assert.deepEqual(await resultPromise, { ok: false, provider: "antigravity", code: 7, signal: "SIGTERM" });
});
