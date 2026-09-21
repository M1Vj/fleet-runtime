import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_MODEL_CHAIN,
  PRIMARY_MODEL,
  isAllowedModel,
  isContributorTier,
  sanitizeModelChain,
  resolveJudgeModel,
  DEFAULT_JUDGE_MODEL,
} from "../scripts/lib/provider-registry.mjs";
import { resolveModelChain, MODEL_TIMEOUTS } from "../scripts/lib/model.mjs";
import { publicModelEnv } from "../scripts/lib/private-state.mjs";

const EXPECTED_CHAIN = [
  "opencode/muse-spark-1.3-contributor-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/muse-spark-1.2-contributor-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/mimo-v2.5-free",
];

test("default chain is the verified-live free chain (muse-spark primary)", () => {
  assert.deepEqual(resolveModelChain({}), EXPECTED_CHAIN);
  assert.deepEqual([...DEFAULT_MODEL_CHAIN], EXPECTED_CHAIN);
  assert.equal(PRIMARY_MODEL, EXPECTED_CHAIN[0]);
});

test("FLEET_MODEL_CHAIN override honored", () => {
  const chain = resolveModelChain({ FLEET_MODEL_CHAIN: "opencode/nemotron-3.5-lightning-free,opencode/mimo-v2.5-free" });
  assert.deepEqual(chain, ["opencode/nemotron-3.5-lightning-free", "opencode/mimo-v2.5-free"]);
});

test("paid explicit chain values are rejected without an authorized paid opt-in", () => {
  assert.deepEqual(resolveModelChain({ FLEET_MODEL_CHAIN: "opencode/muse-spark-1.3" }), EXPECTED_CHAIN);
});

test("dead model id can never be selected", () => {
  assert.equal(isAllowedModel("opencode/x-preview-f-free"), false);
  assert.deepEqual(resolveModelChain({ FLEET_MODEL_CHAIN: "opencode/x-preview-f-free" }), EXPECTED_CHAIN);
  const mixed = resolveModelChain({ FLEET_MODEL_CHAIN: "opencode/x-preview-f-free,opencode/nemotron-3.5-lightning-free" });
  assert.deepEqual(mixed, ["opencode/nemotron-3.5-lightning-free"]);
});

test("chain sanitization dedupes and rejects unsafe and forbidden values", () => {
  assert.deepEqual(
    sanitizeModelChain(["opencode/nemotron-3.5-lightning-free", "opencode/nemotron-3.5-lightning-free", "", "../evil", "-m", "opencode/x-preview-f-free"]),
    ["opencode/nemotron-3.5-lightning-free"],
  );
  // STRICT NEGATIVE INVARIANT: Gemini models strictly rejected
  assert.deepEqual(sanitizeModelChain(["opencode/gemini-3-flash"]), []);
});

test("contributor tier detected for xhigh ladder", () => {
  assert.equal(isContributorTier(PRIMARY_MODEL), true);
  assert.equal(isContributorTier("opencode/nemotron-3-ultra-free"), false);
});

test("judge model defaults with stale-value fallback", () => {
  assert.equal(resolveJudgeModel({}), DEFAULT_JUDGE_MODEL);
  assert.equal(resolveJudgeModel({ FLEET_JUDGE_MODEL: "opencode/nemotron-3.5-lightning-free" }), "opencode/nemotron-3.5-lightning-free");
  assert.equal(resolveJudgeModel({ FLEET_JUDGE_MODEL: "opencode/gemini-3-flash" }), DEFAULT_JUDGE_MODEL);
  assert.equal(resolveJudgeModel({ FLEET_JUDGE_MODEL: "opencode/x-preview-f-free" }), DEFAULT_JUDGE_MODEL);
});

test("model timeout tiers are 480/540/600s", () => {
  assert.deepEqual(MODEL_TIMEOUTS, { standard: 480000, long: 540000, extended: 600000 });
});

test("askModel waits for cooling credential capacity without spawning anonymous OpenCode", async () => {
  const { askModel } = await import("../scripts/lib/model.mjs");
  const pool = await import("../scripts/lib/credential-pool.mjs");
  const { dir, capture } = makeFakeOpencode();
  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleet-capacity-"));
  const now = Date.now();
  pool.recordFailure(stateRoot, 1, "429 rate limit", { nowMs: now, cooldownMs: 60_000 });
  pool.recordFailure(stateRoot, 2, "429 rate limit", { nowMs: now, cooldownMs: 120_000 });
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FLEET_STATE_ROOT: stateRoot,
    FLEET_OPENCODE_AUTH: "test-slot-1",
    FLEET_OPENCODE_AUTH_2: "test-slot-2",
    FLEET_MODEL_CHAIN: PRIMARY_MODEL,
  };
  const result = await askModel({ prompt: "must wait", timeoutMs: 15_000, env, maxRounds: 1, skipCircuitCheck: true });
  assert.equal(result.complete, false);
  assert.equal(result.waitingForCapacity, true);
  assert.equal(result.waiting_for_capacity, true);
  assert.equal(result.waitingForQuota, true);
  assert.equal(result.surfaced, true);
  assert.equal(result.quotaDisposition.kind, "quota_wait");
  assert.equal(result.quotaDisposition.reason, "credential_capacity_exhausted");
  assert.ok(result.retryAt >= now + 60_000);
  assert.equal(existsSync(capture), false);
});

test("askModel fails closed on a tampered core before spawning OpenCode", async () => {
  const { askModel, runOnce } = await import("../scripts/lib/model.mjs");
  const { dir, capture } = makeFakeOpencode();
  const coreRoot = mkdtempSync(path.join(tmpdir(), "fleet-parity-core-"));
  for (const file of ["manifest.json", "schema.json", "golden-vectors.json", "core.lock.json"]) {
    cpSync(path.join("packages", "indefinite-core", file), path.join(coreRoot, file));
  }
  writeFileSync(path.join(coreRoot, "manifest.json"), Buffer.from("{}\n"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleet-parity-"));
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FLEET_STATE_ROOT: stateRoot, FLEET_CORE_ROOT: coreRoot, FLEET_OPENCODE_AUTH: "test-auth" };
  const result = await askModel({ prompt: "must block", timeoutMs: 15_000, env, maxRounds: 1, skipCircuitCheck: true });
  assert.equal(result.complete, false);
  assert.equal(result.blocked, true);
  assert.equal(result.parityMismatch, true);
  assert.equal(result.surfaced, true);
  assert.equal(existsSync(capture), false);
  const direct = await runOnce({ prompt: "must also block direct invocation", timeoutMs: 15_000, env, model: PRIMARY_MODEL });
  assert.equal(direct.complete, false);
  assert.equal(direct.blocked, true);
  assert.equal(direct.parityMismatch, true);
  assert.equal(existsSync(capture), false);
});

// Behavioral test for the fixed hardcode: runOnce must pass the requested
// model to `opencode -m` (via allowlist) instead of a hardcoded ID. Uses a
// fake `opencode` executable first on PATH — no network, no credentials.
function makeFakeOpencode({ includeSession = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "fleetmodel-"));
  const capture = path.join(dir, "args.jsonl");
  const bin = path.join(dir, "opencode");
  const output = includeSession ? '{text:"hello-test",sessionID:"sess-test-1"}' : '{text:"hello-without-session"}';
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs=require("fs");\nfs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))+"\\n");\nconsole.log(JSON.stringify(${output}));\n`,
  );
  chmodSync(bin, 0o755);
  return { dir, capture };
}

async function lastArgs(capture) {
  const lines = readFileSync(capture, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

test("runOnce honors the requested model param", async () => {
  const { runOnce } = await import("../scripts/lib/model.mjs");
  const { dir, capture } = makeFakeOpencode();
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FLEET_OPENCODE_AUTH: "test-auth" };
  const r = await runOnce({ prompt: "hi", timeoutMs: 15000, env, model: "opencode/nemotron-3.5-lightning-free" });
  assert.equal(r.reply, "hello-test");
  assert.equal(r.sessionId, "sess-test-1");
  const args = await lastArgs(capture);
  const i = args.indexOf("-m");
  assert.notEqual(i, -1);
  assert.equal(args[i + 1], "opencode/nemotron-3.5-lightning-free");
});

test("anonymous provider-authorized calls preserve variant and exact session args", async () => {
  const { runOnce } = await import("../scripts/lib/model.mjs");
  const { dir, capture } = makeFakeOpencode();
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  delete env.OPENCODE_AUTH_CONTENT;
  for (let n = 1; n <= 9; n++) delete env[n === 1 ? "FLEET_OPENCODE_AUTH" : `FLEET_OPENCODE_AUTH_${n}`];
  const r = await runOnce({
    prompt: "continue",
    sessionId: "sess-anonymous-1",
    variant: "xhigh",
    timeoutMs: 15000,
    env,
    model: PRIMARY_MODEL,
  });
  assert.equal(r.reply, "hello-test");
  const args = await lastArgs(capture);
  assert.equal(args[args.indexOf("--variant") + 1], "xhigh");
  assert.equal(args[args.indexOf("-s") + 1], "sess-anonymous-1");
});

test("caller session is not treated as provider-returned when response omits sessionID", async () => {
  const { runOnce } = await import("../scripts/lib/model.mjs");
  const { dir } = makeFakeOpencode({ includeSession: false });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FLEET_OPENCODE_AUTH: "test-auth" };
  const result = await runOnce({
    prompt: "continue without provider session evidence",
    sessionId: "caller-supplied-session",
    variant: "xhigh",
    timeoutMs: 15000,
    env,
    model: PRIMARY_MODEL,
  });
  assert.equal(result.reply, "hello-without-session");
  assert.equal(result.sessionId, "");
  assert.equal(result.sessionIdReturned, false);
});

test("authenticated retries preserve a returned exact session", async () => {
  const { askModel } = await import("../scripts/lib/model.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-session-"));
  const capture = path.join(dir, "args.jsonl");
  const bin = path.join(dir, "opencode");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({ type: "error", error: { message: "provider unavailable" }, sessionID: "exact-session-1" }));
process.exitCode = 1;
`,
  );
  chmodSync(bin, 0o755);
  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleet-session-state-"));
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FLEET_STATE_ROOT: stateRoot,
    FLEET_OPENCODE_AUTH: "authorized-slot",
    FLEET_MODEL_CHAIN: PRIMARY_MODEL,
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, Number(ms) >= 20_000 ? 0 : ms, ...args);
  let result;
  try {
    result = await askModel({
      prompt: "preserve session",
      timeoutMs: 15000,
      env,
      maxRounds: 2,
      preferVariantMax: false,
      skipCircuitCheck: true,
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(result.complete, false);
  assert.equal(result.sessionId, "exact-session-1");
  const args = readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(args.length, 2);
  assert.equal(args[1][args[1].indexOf("-s") + 1], "exact-session-1");
});

test("runOnce maps dead/override requests to the chain primary", async () => {
  const { runOnce } = await import("../scripts/lib/model.mjs");
  const { dir, capture } = makeFakeOpencode();
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FLEET_OPENCODE_AUTH: "test-auth" };
  await runOnce({ prompt: "hi", timeoutMs: 15000, env, model: "opencode/x-preview-f-free" });
  const args = await lastArgs(capture);
  assert.equal(args[args.indexOf("-m") + 1], PRIMARY_MODEL);
});

test("runOnce keeps secret-stripped env plus OPENCODE_AUTH_CONTENT", async () => {
  const { runOnce } = await import("../scripts/lib/model.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "fleetmodel-"));
  const seen = path.join(dir, "env.json");
  const bin = path.join(dir, "opencode");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs=require("fs");\nconst e={FLEET_GH_TOKEN:process.env.FLEET_GH_TOKEN,GH_TOKEN:process.env.GH_TOKEN,OPENCODE_AUTH_CONTENT:(process.env.OPENCODE_AUTH_CONTENT||"").slice(0,4),OPENCODE_CONFIG_CONTENT:process.env.OPENCODE_CONFIG_CONTENT,MY_API_KEY:process.env.MY_API_KEY};\nfs.writeFileSync(${JSON.stringify(seen)},JSON.stringify(e));\nconsole.log(JSON.stringify({text:"ok",sessionID:"s1"}));\n`,
  );
  chmodSync(bin, 0o755);
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FLEET_OPENCODE_AUTH: "auth",
    FLEET_GH_TOKEN: "leak-me",
    GH_TOKEN: "leak-me",
    MY_API_KEY: "leak-me",
  };
  await runOnce({ prompt: "hi", timeoutMs: 15000, env });
  const got = JSON.parse(readFileSync(seen, "utf8"));
  assert.equal(got.FLEET_GH_TOKEN, undefined);
  assert.equal(got.GH_TOKEN, undefined);
  assert.equal(got.MY_API_KEY, undefined);
  assert.equal(got.OPENCODE_AUTH_CONTENT, "auth");
  assert.deepEqual(JSON.parse(got.OPENCODE_CONFIG_CONTENT), {
    model: PRIMARY_MODEL,
    small_model: PRIMARY_MODEL,
  });
});

test("runOnce preserves safe config while pinning selected model helpers", async () => {
  const { runOnce } = await import("../scripts/lib/model.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "fleetmodel-"));
  const seen = path.join(dir, "env.json");
  const bin = path.join(dir, "opencode");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs=require("fs");fs.writeFileSync(${JSON.stringify(seen)},process.env.OPENCODE_CONFIG_CONTENT);console.log(JSON.stringify({text:"ok",sessionID:"s-config-1"}));\n`,
  );
  chmodSync(bin, 0o755);
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FLEET_OPENCODE_AUTH: "auth",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { read: "allow" } }),
  };
  await runOnce({ prompt: "hi", timeoutMs: 15000, env, model: "opencode/nemotron-3.5-lightning-free" });
  assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")), {
    permission: { read: "allow" },
    model: "opencode/nemotron-3.5-lightning-free",
    small_model: "opencode/nemotron-3.5-lightning-free",
  });
});

test("runOnce preserves the workspace permission boundary when pinning models", async () => {
  const { runOnce } = await import("../scripts/lib/model.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "fleetmodel-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "fleetworkspace-"));
  const seen = path.join(dir, "env.json");
  const bin = path.join(dir, "opencode");
  writeFileSync(path.join(workspace, "opencode.json"), JSON.stringify({
    permission: { edit: "deny", bash: "deny", read: "allow" },
  }));
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs=require("fs");fs.writeFileSync(${JSON.stringify(seen)},process.env.OPENCODE_CONFIG_CONTENT);console.log(JSON.stringify({text:"ok",sessionID:"s-workspace-1"}));\n`,
  );
  chmodSync(bin, 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FLEET_OPENCODE_AUTH: "auth" };
  await runOnce({ prompt: "hi", timeoutMs: 15000, env, workspace, model: "opencode/nemotron-3.5-lightning-free" });
  assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")), {
    permission: { edit: "deny", bash: "deny", read: "allow" },
    model: "opencode/nemotron-3.5-lightning-free",
    small_model: "opencode/nemotron-3.5-lightning-free",
  });
});

test("read-only advisory runOnce strips controller state/tokens and forces deny permissions", async () => {
  const { runOnce } = await import("../scripts/lib/model.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "fleet-advisory-model-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "fleet-advisory-bin-"));
  const workspace = path.join(root, "runtime");
  mkdirSync(workspace, { recursive: true });
  const seen = path.join(binDir, "seen.json");
  const bin = path.join(binDir, "opencode");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs=require("fs");fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({env:{FLEET_GH_TOKEN:process.env.FLEET_GH_TOKEN,FLEET_READ_TOKEN:process.env.FLEET_READ_TOKEN,GH_TOKEN:process.env.GH_TOKEN,GITHUB_TOKEN:process.env.GITHUB_TOKEN,GITHUB_WORKSPACE:process.env.GITHUB_WORKSPACE,FLEET_STATE_ROOT:process.env.FLEET_STATE_ROOT,FLEET_WORKSPACE_ROOT:process.env.FLEET_WORKSPACE_ROOT,MY_PRIVATE:process.env.MY_PRIVATE,OPENCODE_AUTH_CONTENT:(process.env.OPENCODE_AUTH_CONTENT||"").slice(0,4)},cwd:process.cwd(),config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT||"{}")}));console.log(JSON.stringify({text:"ok",sessionID:"s-advisory-1"}));\n`,
  );
  chmodSync(bin, 0o755);
  const env = {
    PATH: `${binDir}:${process.env.PATH || ""}`,
    RUNNER_TEMP: root,
    TMPDIR: root,
    FLEET_STATE_ROOT: path.join(root, "controller-state"),
    FLEET_MODEL_WORKSPACE: workspace,
    GITHUB_WORKSPACE: path.join(root, "controller-checkout"),
    FLEET_GH_TOKEN: "publisher-secret",
    FLEET_READ_TOKEN: "read-secret",
    GITHUB_TOKEN: "actions-secret",
    FLEET_OPENCODE_AUTH: "auth-secret",
    MY_PRIVATE: "must-not-forward",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { read: "allow", edit: "allow", write: "allow", bash: "allow" } }),
    FLEET_INDEFINITE_DISABLE: "1",
  };
  try {
    const result = await runOnce({ prompt: "bounded advisory", timeoutMs: 15000, env, workspace, model: PRIMARY_MODEL, readOnly: true });
    assert.equal(result.reply, "ok");
    const captured = JSON.parse(readFileSync(seen, "utf8"));
    for (const key of ["FLEET_GH_TOKEN", "FLEET_READ_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_WORKSPACE", "MY_PRIVATE"]) {
      assert.equal(captured.env[key], undefined, `${key} must not reach advisory model`);
    }
    assert.notEqual(captured.env.FLEET_STATE_ROOT, env.FLEET_STATE_ROOT);
    assert.equal(captured.env.FLEET_WORKSPACE_ROOT.endsWith("/runtime"), true);
    assert.equal(path.basename(captured.cwd), "runtime");
    assert.doesNotMatch(captured.cwd, /controller/);
    assert.equal(captured.env.OPENCODE_AUTH_CONTENT, "auth");
    assert.deepEqual(captured.config.permission, {
      edit: "deny",
      write: "deny",
      bash: "deny",
      external_directory: "deny",
      question: "deny",
      todowrite: "deny",
      read: "allow",
      grep: "allow",
      glob: "allow",
      list: "allow",
      webfetch: "deny",
      websearch: "deny",
    });
    assert.doesNotMatch(JSON.stringify(captured.config), /controller-state|controller-checkout/);
    const blocked = await runOnce({ prompt: "controller workspace must block", timeoutMs: 15000, env, workspace: env.GITHUB_WORKSPACE, model: PRIMARY_MODEL, readOnly: true });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.modelMode, "advisory-env-invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("read-only advisory askModel reuses one prepared authenticated environment", async () => {
  const { askModel } = await import("../scripts/lib/model.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "fleet-advisory-ask-auth-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "fleet-advisory-ask-auth-bin-"));
  const workspace = path.join(root, "runtime");
  const seen = path.join(binDir, "seen.json");
  mkdirSync(workspace, { recursive: true });
  const bin = path.join(binDir, "opencode");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs=require("fs");fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({authenticated:Boolean(process.env.OPENCODE_AUTH_CONTENT),slot:process.env.FLEET_OPENCODE_AUTH,slot2:process.env.FLEET_OPENCODE_AUTH_2,stateRoot:process.env.FLEET_STATE_ROOT,workspaceRoot:process.env.FLEET_WORKSPACE_ROOT}));console.log(JSON.stringify({text:"ok",sessionID:"s-readonly-auth"}));\n`,
  );
  chmodSync(bin, 0o755);
  const env = {
    PATH: `${binDir}:${process.env.PATH || ""}`,
    RUNNER_TEMP: root,
    TMPDIR: root,
    FLEET_STATE_ROOT: path.join(root, "controller-state"),
    FLEET_MODEL_WORKSPACE: workspace,
    FLEET_OPENCODE_AUTH: "auth-secret",
    FLEET_OPENCODE_AUTH_2: "auth-secret-2",
    FLEET_MODEL_CHAIN: PRIMARY_MODEL,
    FLEET_INDEFINITE_DISABLE: "1",
  };
  try {
    const result = await askModel({
      prompt: "bounded advisory",
      timeoutMs: 15000,
      env,
      maxRounds: 1,
      preferVariantMax: false,
      skipCircuitCheck: true,
      workspace,
      readOnly: true,
    });
    assert.equal(result.complete, true);
    assert.equal(result.reply, "ok");
    assert.equal(result.attempts[0].auth, "yes");
    assert.equal(JSON.stringify(result.attempts).includes("auth-secret"), false);
    const captured = JSON.parse(readFileSync(seen, "utf8"));
    assert.equal(captured.authenticated, true);
    assert.equal(captured.slot, undefined);
    assert.equal(captured.slot2, undefined);
    assert.notEqual(captured.stateRoot, env.FLEET_STATE_ROOT);
    assert.equal(captured.workspaceRoot, workspace);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("read-only advisory askModel reuses one prepared anonymous environment", async () => {
  const { askModel } = await import("../scripts/lib/model.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "fleet-advisory-ask-anon-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "fleet-advisory-ask-anon-bin-"));
  const workspace = path.join(root, "runtime");
  const seen = path.join(binDir, "seen.json");
  mkdirSync(workspace, { recursive: true });
  const bin = path.join(binDir, "opencode");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs=require("fs");fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({authenticated:Boolean(process.env.OPENCODE_AUTH_CONTENT),slot:process.env.FLEET_OPENCODE_AUTH,slot2:process.env.FLEET_OPENCODE_AUTH_2,stateRoot:process.env.FLEET_STATE_ROOT,workspaceRoot:process.env.FLEET_WORKSPACE_ROOT}));console.log(JSON.stringify({text:"ok",sessionID:"s-readonly-anon"}));\n`,
  );
  chmodSync(bin, 0o755);
  const env = {
    PATH: `${binDir}:${process.env.PATH || ""}`,
    RUNNER_TEMP: root,
    TMPDIR: root,
    FLEET_STATE_ROOT: path.join(root, "controller-state"),
    FLEET_MODEL_WORKSPACE: workspace,
    FLEET_MODEL_CHAIN: PRIMARY_MODEL,
    FLEET_INDEFINITE_DISABLE: "1",
  };
  try {
    const result = await askModel({
      prompt: "bounded anonymous advisory",
      timeoutMs: 15000,
      env,
      maxRounds: 1,
      preferVariantMax: false,
      skipCircuitCheck: true,
      workspace,
      readOnly: true,
    });
    assert.equal(result.complete, true);
    assert.equal(result.reply, "ok");
    assert.equal(result.attempts[0].auth, "anon");
    const captured = JSON.parse(readFileSync(seen, "utf8"));
    assert.equal(captured.authenticated, false);
    assert.equal(captured.slot, undefined);
    assert.equal(captured.slot2, undefined);
    assert.equal(captured.workspaceRoot, workspace);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("advisory model workspace is canonically isolated from controller, state, and workflow roots", async () => {
  const { advisoryModelEnv } = await import("../scripts/lib/model.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "fleet-advisory-isolation-"));
  const outside = mkdtempSync(path.join(tmpdir(), "fleet-advisory-outside-"));
  const controller = path.join(root, "controller");
  const state = path.join(root, "state");
  const workflow = path.join(root, "workflow");
  const sibling = path.join(root, "model-sibling");
  const nestedController = path.join(controller, "runtime");
  const nestedState = path.join(state, "runtime");
  const nestedWorkflow = path.join(workflow, "runtime");
  const advisoryState = path.join(root, "fleet-advisory-model");
  mkdirSync(controller, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(workflow, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  const env = {
    RUNNER_TEMP: root,
    GITHUB_WORKSPACE: controller,
    FLEET_STATE_ROOT: state,
    FLEET_WORKFLOW_ROOT: workflow,
  };
  const blocked = (workspace) => assert.throws(
    () => advisoryModelEnv(env, { workspace }),
    /advisory model workspace may not overlap|symlink alias|RUNNER_TEMP/,
  );
  try {
    // Nested, exact, and parent paths are all forbidden in either direction.
    blocked(nestedController);
    assert.equal(existsSync(advisoryState), false, "invalid workspace must not create advisory state");
    blocked(controller);
    blocked(root);
    blocked(nestedState);
    blocked(state);
    blocked(nestedWorkflow);
    blocked(workflow);

    // A real sibling checkout is accepted and returned canonically.
    const safe = advisoryModelEnv(env, { workspace: sibling });
    assert.equal(safe.FLEET_WORKSPACE_ROOT.endsWith("/model-sibling"), true);
    assert.equal(existsSync(advisoryState), true);
    assert.throws(() => advisoryModelEnv(env, { workspace: outside }), /RUNNER_TEMP|symlink alias/);

    // A symlink alias is rejected even when its target is an otherwise-safe sibling.
    const alias = path.join(root, "model-alias");
    symlinkSync(sibling, alias, "dir");
    assert.throws(() => advisoryModelEnv(env, { workspace: alias }), /symlink alias/);

    // Missing workspaces are created only beneath the explicit runner temp root.
    const missing = path.join(root, "model-created");
    assert.equal(existsSync(missing), false);
    const created = advisoryModelEnv(env, { workspace: missing });
    assert.equal(existsSync(missing), true);
    assert.equal(created.FLEET_WORKSPACE_ROOT.endsWith("/model-created"), true);

    const outsideMissing = path.join(outside, "model-created");
    assert.throws(() => advisoryModelEnv(env, { workspace: outsideMissing }), /RUNNER_TEMP|symlink alias/);
    assert.equal(existsSync(outsideMissing), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("public runOnce uses an allowlisted environment and ephemeral config roots", async () => {
  const { runOnce } = await import("../scripts/lib/model.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "fleet-public-model-env-"));
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-public-model-bin-"));
  const stateRoot = path.join(root, "state");
  const seen = path.join(dir, "env.json");
  const bin = path.join(dir, "opencode");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs=require("fs");fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({HOME:process.env.HOME,XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME,XDG_DATA_HOME:process.env.XDG_DATA_HOME,XDG_CACHE_HOME:process.env.XDG_CACHE_HOME,TMPDIR:process.env.TMPDIR,RUNNER_TEMP:process.env.RUNNER_TEMP,ARBITRARY_PRIVATE:process.env.ARBITRARY_PRIVATE,FLEET_OPENCODE_AUTH:process.env.FLEET_OPENCODE_AUTH,OPENCODE_AUTH_CONTENT:process.env.OPENCODE_AUTH_CONTENT,NODE_OPTIONS:process.env.NODE_OPTIONS}));console.log(JSON.stringify({text:"ok",sessionID:"s-public-env-1"}));\n`,
  );
  chmodSync(bin, 0o755);
  const env = {
    FLEET_DATA_CLASS: "public",
    FLEET_PUBLIC_OWNER: "M1Vj",
    FLEET_PUBLIC_REPOSITORY: "M1Vj/public-repo",
    RUNNER_TEMP: root,
    FLEET_PUBLIC_STATE_ROOT: stateRoot,
    FLEET_PUBLIC_ARTIFACT_MANIFEST: path.join(stateRoot, "public-artifact.json"),
    PATH: `${dir}:${process.env.PATH || ""}`,
    HOME: "/private-home",
    XDG_CONFIG_HOME: "/private-config",
    ARBITRARY_PRIVATE: "must-not-be-forwarded",
    FLEET_OPENCODE_AUTH: "private-auth",
    OPENCODE_AUTH_CONTENT: "private-auth",
    NODE_OPTIONS: "--require /private-module.js",
  };
  try {
    const result = await runOnce({ prompt: "public env probe", timeoutMs: 15000, env, model: PRIMARY_MODEL });
    assert.equal(result.reply, "ok");
    const captured = JSON.parse(readFileSync(seen, "utf8"));
    const publicRoot = path.resolve(stateRoot);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR"]) {
      assert.equal(captured[key].startsWith(`${publicRoot}${path.sep}`), true, `${key} must be ephemeral public state`);
    }
    assert.equal(captured.RUNNER_TEMP, path.resolve(root));
    assert.equal(captured.ARBITRARY_PRIVATE, undefined);
    assert.equal(captured.FLEET_OPENCODE_AUTH, undefined);
    assert.equal(captured.OPENCODE_AUTH_CONTENT, "");
    assert.equal(captured.NODE_OPTIONS, undefined);
    assert.equal(publicModelEnv(env).HOME.startsWith(`${publicRoot}${path.sep}`), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnce rejects an error event even when the CLI exits zero", async () => {
  const { runOnce } = await import("../scripts/lib/model.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "fleetmodel-"));
  const bin = path.join(dir, "opencode");
  writeFileSync(bin, "#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'error',error:{message:'provider failed'}}));\n");
  chmodSync(bin, 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FLEET_OPENCODE_AUTH: "auth" };
  const result = await runOnce({ prompt: "hi", timeoutMs: 15000, env });
  assert.equal(result.reply, "");
  assert.match(result.stderrTail, /provider failed/);
});

test("runOnce selects pooled slot, strips slot keys, records slot number", async () => {
  const { runOnce } = await import("../scripts/lib/model.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "fleetmodel-"));
  const seen = path.join(dir, "env.json");
  const bin = path.join(dir, "opencode");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs=require("fs");\nconst e={OPENCODE_AUTH_CONTENT:process.env.OPENCODE_AUTH_CONTENT,FLEET_OPENCODE_AUTH:process.env.FLEET_OPENCODE_AUTH,FLEET_OPENCODE_AUTH_2:process.env.FLEET_OPENCODE_AUTH_2};\nfs.writeFileSync(${JSON.stringify(seen)},JSON.stringify(e));\nconsole.log(JSON.stringify({text:"ok",sessionID:"s-pool-1"}));\n`,
  );
  chmodSync(bin, 0o755);
  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleetpool-"));
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FLEET_STATE_ROOT: stateRoot,
    FLEET_OPENCODE_AUTH: "test-slot-1",
    FLEET_OPENCODE_AUTH_2: "test-slot-2",
  };
  const r = await runOnce({ prompt: "hi", timeoutMs: 15000, env });
  assert.equal(r.reply, "ok");
  assert.equal(r.slot, 1);
  const got = JSON.parse(readFileSync(seen, "utf8"));
  assert.equal(got.OPENCODE_AUTH_CONTENT, "test-slot-1");
  assert.equal(got.FLEET_OPENCODE_AUTH, undefined);
  assert.equal(got.FLEET_OPENCODE_AUTH_2, undefined);
  const health = JSON.parse(readFileSync(path.join(stateRoot, "state", "credential-health.json"), "utf8"));
  assert.ok(health.slots["1"].lastOk);
});

test("runOnce waits on exhaustion without anonymous bypass, preserving alert intent", async () => {
  const { runOnce } = await import("../scripts/lib/model.mjs");
  const pool = await import("../scripts/lib/credential-pool.mjs");
  const { dir, capture } = makeFakeOpencode();
  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleetpool-"));
  const now = Date.now();
  pool.recordFailure(stateRoot, 1, "429 rate limit", { nowMs: now });
  pool.recordFailure(stateRoot, 2, "CreditsError: out of credits", { nowMs: now });
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FLEET_STATE_ROOT: stateRoot,
    FLEET_OPENCODE_AUTH: "test-slot-1",
    FLEET_OPENCODE_AUTH_2: "test-slot-2",
  };
  delete env.FLEET_GH_TOKEN;
  let r = null;
  try {
    r = await runOnce({ prompt: "hi", timeoutMs: 15000, env });
  } catch (err) {
    assert.fail(`runOnce must not throw on exhaustion: ${err.message}`);
  }
  assert.equal(r.exhausted, true);
  assert.equal(r.degraded, true);
  assert.equal(r.slot, null);
  assert.equal(r.reply, "");
  assert.equal(r.waitingForCapacity, true);
  assert.equal(r.waiting_for_capacity, true);
  assert.equal(r.waitingForQuota, true);
  assert.equal(r.quotaDisposition.reason, "credential_capacity_exhausted");
  assert.equal(existsSync(capture), false);
  const flagPath = path.join(stateRoot, "state", "auth-exhausted.json");
  assert.equal(existsSync(flagPath), true);
  const flag = JSON.parse(readFileSync(flagPath, "utf8"));
  assert.equal(flag.slots, 2);
  assert.ok(flag.exhaustedAt);
  const events = readFileSync(path.join(stateRoot, "state", "events.jsonl"), "utf8");
  assert.ok(events.includes("credential-pool-exhausted"));
  assert.ok(events.includes("STALLED"));
  assert.ok(!events.includes("test-slot-"));
  assert.ok(!JSON.stringify(flag).includes("test-slot-"));
});

test("authenticated 429 never falls back to an anonymous OpenCode attempt", async () => {
  const { askModel } = await import("../scripts/lib/model.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-auth-429-"));
  const capture = path.join(dir, "attempts.jsonl");
  const bin = path.join(dir, "opencode");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
const authenticated = Boolean(process.env.OPENCODE_AUTH_CONTENT);
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ authenticated }) + "\\n");
if (authenticated) {
  console.log(JSON.stringify({ type: "error", error: { message: "429 rate limit" } }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ text: "anonymous-success", sessionID: "anon-session" }));
}
`,
  );
  chmodSync(bin, 0o755);
  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleet-auth-429-state-"));
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FLEET_STATE_ROOT: stateRoot,
    FLEET_OPENCODE_AUTH: "authorized-slot",
    FLEET_AUTH_COOLDOWN_MS: "60000",
    FLEET_MODEL_CHAIN: PRIMARY_MODEL,
  };
  const result = await askModel({
    prompt: "must preserve authenticated route",
    timeoutMs: 15000,
    env,
    maxRounds: 2,
    preferVariantMax: false,
    skipCircuitCheck: true,
  });
  assert.equal(result.complete, false);
  assert.equal(result.waitingForCapacity, true);
  assert.equal(result.waitingForQuota, true);
  assert.equal(result.surfaced, true);
  assert.ok(result.retryAt > Date.now());
  const attempts = readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(attempts, [{ authenticated: true }]);
  const health = JSON.parse(readFileSync(path.join(stateRoot, "state", "credential-health.json"), "utf8"));
  assert.ok(Number(health.slots["1"].cooldownUntil) > Date.now());
});

test("askModel attempts record slot numbers, never key material", async () => {
  const { askModel } = await import("../scripts/lib/model.mjs");
  const { dir, capture } = makeFakeOpencode();
  void capture;
  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleetpool-"));
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FLEET_STATE_ROOT: stateRoot,
    FLEET_OPENCODE_AUTH: "test-slot-1",
    FLEET_OPENCODE_AUTH_2: "test-slot-2",
  };
  const res = await askModel({ prompt: "hi", timeoutMs: 15000, env, maxRounds: 1, preferVariantMax: false });
  assert.equal(res.complete, true);
  assert.equal(res.attempts[0].slot, 1);
  assert.ok(!JSON.stringify(res.attempts).includes("test-slot-"));
});

function writeChainFile(stateRoot, payload) {
  const p = path.join(stateRoot, "state", "model-chain.json");
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(payload));
  return p;
}

test("chain override file: fresh-valid wins over code default", async () => {
  const { resolveModelChain } = await import("../scripts/lib/model.mjs");
  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleetchain-"));
  writeChainFile(stateRoot, {
    chain: ["opencode/mimo-v2.5-free", "opencode/nemotron-3.5-lightning-free"],
    updatedAt: new Date().toISOString(),
    source: "test",
    ttlMs: 604800000,
  });
  const chain = resolveModelChain({ FLEET_STATE_ROOT: stateRoot });
  assert.deepEqual(chain, ["opencode/mimo-v2.5-free", "opencode/nemotron-3.5-lightning-free"]);
});

test("chain override file: explicit env beats a valid file", async () => {
  const { resolveModelChain } = await import("../scripts/lib/model.mjs");
  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleetchain-"));
  writeChainFile(stateRoot, {
    chain: ["opencode/mimo-v2.5-free"],
    updatedAt: new Date().toISOString(),
    source: "test",
    ttlMs: 604800000,
  });
  const chain = resolveModelChain({ FLEET_STATE_ROOT: stateRoot, FLEET_MODEL_CHAIN: "opencode/nemotron-3.5-lightning-free" });
  assert.deepEqual(chain, ["opencode/nemotron-3.5-lightning-free"]);
});

test("chain override file: stale/invalid fall through to code default", async () => {
  const { resolveModelChain } = await import("../scripts/lib/model.mjs");
  const { DEFAULT_MODEL_CHAIN } = await import("../scripts/lib/provider-registry.mjs");
  const staleRoot = mkdtempSync(path.join(tmpdir(), "fleetchain-"));
  writeChainFile(staleRoot, {
    chain: ["opencode/mimo-v2.5-free"],
    updatedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    source: "test",
    ttlMs: 604800000,
  });
  assert.deepEqual(resolveModelChain({ FLEET_STATE_ROOT: staleRoot }), [...DEFAULT_MODEL_CHAIN].slice(0, 5));
  const badRoot = mkdtempSync(path.join(tmpdir(), "fleetchain-"));
  writeChainFile(badRoot, { chain: ["opencode/x-preview-f-free"], updatedAt: new Date().toISOString(), source: "test" });
  assert.deepEqual(resolveModelChain({ FLEET_STATE_ROOT: badRoot }), [...DEFAULT_MODEL_CHAIN].slice(0, 5));
  const emptyRoot = mkdtempSync(path.join(tmpdir(), "fleetchain-"));
  assert.deepEqual(resolveModelChain({ FLEET_STATE_ROOT: emptyRoot }), [...DEFAULT_MODEL_CHAIN].slice(0, 5));
});

test("askModel with failing modelOverride does not trip the global gateway circuit breaker", async () => {
  const { askModel } = await import("../scripts/lib/model.mjs");
  const { gatewayCircuitOpen } = await import("../scripts/lib/gateway-health.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "fleetfail-"));
  const bin = path.join(dir, "opencode");
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.exit(1);\n`);
  chmodSync(bin, 0o755);
  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleetgw-"));
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FLEET_STATE_ROOT: stateRoot,
  };
  const res = await askModel({
    prompt: "hi",
    timeoutMs: 5000,
    env,
    maxRounds: 1,
    modelOverride: "opencode/muse-spark-1.3-contributor-free",
  });
  assert.equal(res.complete, false);
  assert.equal(gatewayCircuitOpen(stateRoot), false);
});

test("askModel failing whole chain does trip the global gateway circuit breaker", async () => {
  const { askModel } = await import("../scripts/lib/model.mjs");
  const { gatewayCircuitOpen } = await import("../scripts/lib/gateway-health.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "fleetfail2-"));
  const bin = path.join(dir, "opencode");
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.exit(1);\n`);
  chmodSync(bin, 0o755);
  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleetgw2-"));
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FLEET_STATE_ROOT: stateRoot,
    FLEET_MODEL_CHAIN: "opencode/mimo-v2.5-free",
  };
  const res = await askModel({
    prompt: "hi",
    timeoutMs: 5000,
    env,
    maxRounds: 1,
  });
  assert.equal(res.complete, false);
  assert.equal(gatewayCircuitOpen(stateRoot), true);
});

test("askModel automatically recovers and retries when session not found occurs", async () => {
  const { askModel } = await import("../scripts/lib/model.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "fleetsession-"));
  const bin = path.join(dir, "opencode");
  // If called with -s, fail with "Session not found". Otherwise return success.
  writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv;
if (args.includes("-s")) {
  process.stderr.write("Error: Session not found: ses_stale\\n");
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({ type: "message", text: "recovered success", sessionID: "ses_fresh" }) + "\\n");
  process.exit(0);
}
`);
  chmodSync(bin, 0o755);
  const stateRoot = mkdtempSync(path.join(tmpdir(), "fleetgw3-"));
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FLEET_STATE_ROOT: stateRoot,
    FLEET_MODEL_CHAIN: "opencode/muse-spark-1.3-contributor-free",
  };
  const res = await askModel({
    prompt: "hi",
    sessionId: "ses_stale",
    timeoutMs: 5000,
    env,
    maxRounds: 1,
  });
  assert.equal(res.complete, true);
  assert.equal(res.reply, "recovered success");
  assert.equal(res.sessionId, "ses_fresh");
  const clearedAudit = res.attempts.some((a) => a.sessionNotFound === true);
  assert.equal(clearedAudit, true);
});
