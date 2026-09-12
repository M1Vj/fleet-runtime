import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
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

// Behavioral test for the fixed hardcode: runOnce must pass the requested
// model to `opencode -m` (via allowlist) instead of a hardcoded ID. Uses a
// fake `opencode` executable first on PATH — no network, no credentials.
function makeFakeOpencode() {
  const dir = mkdtempSync(path.join(tmpdir(), "fleetmodel-"));
  const capture = path.join(dir, "args.jsonl");
  const bin = path.join(dir, "opencode");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs=require("fs");\nfs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))+"\\n");\nconsole.log(JSON.stringify({text:"hello-test",sessionID:"sess-test-1"}));\n`,
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
    `#!/usr/bin/env node\nconst fs=require("fs");\nconst e={FLEET_GH_TOKEN:process.env.FLEET_GH_TOKEN,GH_TOKEN:process.env.GH_TOKEN,OPENCODE_AUTH_CONTENT:(process.env.OPENCODE_AUTH_CONTENT||"").slice(0,4),MY_API_KEY:process.env.MY_API_KEY};\nfs.writeFileSync(${JSON.stringify(seen)},JSON.stringify(e));\nconsole.log(JSON.stringify({text:"ok",sessionID:"s1"}));\n`,
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

test("runOnce degrades on exhaustion: anon attempt, no throw, alert-intent flag", async () => {
  const { runOnce } = await import("../scripts/lib/model.mjs");
  const pool = await import("../scripts/lib/credential-pool.mjs");
  const { dir } = makeFakeOpencode();
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
  assert.equal(r.reply, "hello-test");
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
