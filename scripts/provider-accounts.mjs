#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import process from "node:process";

import {
  loadProviderRegistry,
  normalizeProviderHealthStatus,
  resolveProviderCredentials,
  resolveProviderQuotaGroup,
} from "./lib/provider-registry.mjs";

function parseHealth(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeStatus(value) {
  return normalizeProviderHealthStatus(value, "unknown");
}

function safeTimestamp(value) {
  const timestamp = typeof value === "string" ? new Date(value) : new Date(Number(value));
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function credentialStatus(provider, credential, env, health, now) {
  const resolved = resolveProviderCredentials(provider, env, { account: credential.id, now });
  const snapshot = health?.[provider.id];
  const accountSnapshot = snapshot?.credentials?.[credential.id];
  const group = resolveProviderQuotaGroup(provider, credential, env);
  return {
    credential: credential.id,
    localOnly: credential.localOnly === true,
    state: resolved.ok ? "present" : resolved.state,
    sourceEnv: credential.localOnly === true ? null : credential.env,
    quotaGroupState: provider.auth?.quotaScope === "credential-group"
      ? group.ok ? "configured" : group.state
      : "account-wide",
    health: safeStatus(accountSnapshot?.status || snapshot?.status || "unknown"),
    checkedAt: safeTimestamp(accountSnapshot?.checkedAt || snapshot?.checkedAt),
  };
}

/**
 * Build a secretless account status document. It contains credential slot
 * names and states only; secret values, OAuth caches, and keychain data are
 * never read or returned.
 */
export function collectProviderAccountStatus({ registry = loadProviderRegistry(), env = process.env, health = parseHealth(env.FLEET_PROVIDER_HEALTH_JSON), now = Date.now(), providerId } = {}) {
  const providers = registry.providers
    .filter((provider) => !providerId || provider.id === providerId)
    .map((provider) => ({
      provider: provider.id,
      authMode: provider.auth?.mode || "unknown",
      localOnly: provider.localOnly === true,
      quotaScope: provider.auth?.quotaScope || "provider-wide",
      credentials: provider.credentials.map((credential) => credentialStatus(provider, credential, env, health, now)),
      providerHealth: safeStatus(health?.[provider.id]?.status || "unknown"),
      providerCheckedAt: safeTimestamp(health?.[provider.id]?.checkedAt),
    }));
  return {
    schemaVersion: 1,
    generatedAt: new Date(Number(now)).toISOString(),
    providers,
  };
}

export function renderProviderAccountStatus(options = {}) {
  return `${JSON.stringify(collectProviderAccountStatus(options), null, 2)}\n`;
}

function isGitHubActionsHost(env) {
  return /^(?:1|true)$/i.test(String(env?.GITHUB_ACTIONS || ""))
    || Boolean(env?.GITHUB_RUN_ID)
    || Boolean(env?.GITHUB_WORKFLOW);
}

function buildLoginEnvironment(source = process.env) {
  const env = {};
  const copyIfSet = (key, fallback) => {
    const value = source?.[key];
    if (typeof value === "string" && value) {
      env[key] = value;
    } else if (fallback) {
      env[key] = fallback;
    }
  };

  copyIfSet("PATH", "/usr/local/bin:/usr/bin:/bin");
  copyIfSet("HOME", homedir());
  for (const key of ["TERM", "SHELL", "LANG"]) copyIfSet(key);
  for (const key of ["LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_NUMERIC", "LC_TIME", "LC_COLLATE", "LC_MONETARY"]) copyIfSet(key);
  return env;
}

/**
 * Launch the official local Antigravity CLI login flow.
 *
 * This intentionally accepts an injected environment, streams, and spawn
 * implementation so tests can prove the guardrails without touching a
 * keychain or starting a real login. It never reads or copies OAuth state.
 */
export async function runProviderLogin({
  providerId = "antigravity",
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  spawnImpl = spawn,
} = {}) {
  if (providerId !== "antigravity") throw new Error("LOGIN_PROVIDER_UNSUPPORTED");
  if (isGitHubActionsHost(env)) throw new Error("LOGIN_GITHUB_UNSUPPORTED");
  if (stdin?.isTTY !== true || stdout?.isTTY !== true) throw new Error("LOGIN_TTY_REQUIRED");

  let child;
  try {
    child = spawnImpl("agy", ["--sandbox"], {
      env: buildLoginEnvironment(env),
      stdio: "inherit",
      shell: false,
    });
  } catch {
    throw new Error("LOGIN_SPAWN_FAILED");
  }
  if (!child || typeof child.on !== "function") throw new Error("LOGIN_SPAWN_FAILED");

  return new Promise((resolve, reject) => {
    let settled = false;
    child.on("error", () => {
      if (settled) return;
      settled = true;
      reject(new Error("LOGIN_SPAWN_FAILED"));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({
        ok: code === 0,
        provider: providerId,
        code: code ?? -1,
        signal: signal || null,
      });
    });
  });
}

function printLoginInstructions(providerId) {
  if (providerId !== "antigravity") {
    console.error("LOGIN_PROVIDER_UNSUPPORTED");
    return 2;
  }
  console.log("ANTIGRAVITY_LOGIN_OWNER_RUN");
  console.log("Run the official `agy` CLI interactively on the owner Mac to sign in.");
  console.log("The CLI owns one OS-keyring OAuth session; use its documented `/logout` command before switching accounts.");
  console.log("This helper passes the normal HOME path to the official CLI but never reads or copies OAuth caches, profiles, or keychain data, and it cannot create concurrent OAuth profiles.");
  return 0;
}

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMain()) {
  const command = process.argv[2] || "status";
  if (command === "login") {
    const providerId = process.argv[3] || "antigravity";
    const status = printLoginInstructions(providerId);
    if (status !== 0) {
      process.exitCode = status;
    } else {
      try {
        const result = await runProviderLogin({ providerId });
        process.exitCode = result.ok ? 0 : 1;
      } catch (error) {
        console.error(error instanceof Error ? error.message : "LOGIN_FAILED");
        process.exitCode = 2;
      }
    }
  } else if (command === "status") {
    const providerId = process.argv[3] && !process.argv[3].startsWith("-") ? process.argv[3] : undefined;
    try {
      process.stdout.write(renderProviderAccountStatus({ providerId }));
    } catch {
      console.error("PROVIDER_ACCOUNT_STATUS_FAILED");
      process.exitCode = 1;
    }
  } else {
    console.error("USAGE: node scripts/provider-accounts.mjs <status [provider]|login antigravity>");
    process.exitCode = 2;
  }
}
