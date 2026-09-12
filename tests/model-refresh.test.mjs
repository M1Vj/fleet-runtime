import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractCandidates,
  isFreeTier,
  rankChain,
  validateChain,
  main,
} from "../scripts/model-refresh.mjs";
import { PRIMARY_MODEL } from "../scripts/lib/provider-registry.mjs";

test("extractCandidates parses various catalog formats", () => {
  const arr = [{ id: "model-1" }, { name: "model-2" }];
  assert.deepEqual(
    extractCandidates(arr).map((x) => x.id),
    ["opencode/model-1", "opencode/model-2"],
  );

  const dataObj = { data: [{ id: "opencode/model-a" }] };
  assert.deepEqual(
    extractCandidates(dataObj).map((x) => x.id),
    ["opencode/model-a"],
  );

  const modelsObj = { models: { "m-1": { cost: { input: 0 } } } };
  assert.deepEqual(
    extractCandidates(modelsObj).map((x) => x.id),
    ["opencode/m-1"],
  );
});

test("isFreeTier identifies free models and filters out paid models", () => {
  assert.equal(isFreeTier("opencode/muse-spark-1.3-contributor-free"), true);
  assert.equal(isFreeTier("opencode/nemotron-3-ultra-free"), true);
  assert.equal(isFreeTier("opencode/custom", { cost: { input: 0 } }), true);
  assert.equal(isFreeTier("opencode/custom", { tier: "free" }), true);
  assert.equal(isFreeTier("opencode/custom", { free: true }), true);

  assert.equal(isFreeTier("opencode/claude-sonnet-4-5", { cost: { input: 0.003 } }), false);
  assert.equal(isFreeTier("opencode/gpt-5-codex"), false);
});

test("rankChain pins PRIMARY_MODEL first when present", () => {
  const candidates = [
    { id: "opencode/mimo-v2.5-free", entry: { free: true, limit: { context: 200000 } } },
    { id: PRIMARY_MODEL, entry: { free: true, limit: { context: 1048576 } } },
    { id: "opencode/nemotron-3-ultra-free", entry: { free: true, limit: { context: 1000000 } } },
  ];
  const chain = rankChain(candidates);
  assert.equal(chain[0], PRIMARY_MODEL);
  assert.equal(chain[1], "opencode/nemotron-3-ultra-free");
  assert.equal(chain[2], "opencode/mimo-v2.5-free");
});

test("rankChain falls back to next biggest model when PRIMARY_MODEL is removed", () => {
  // Scenario: Muse Spark 1.3 Free is removed from the catalog
  const candidates = [
    { id: "opencode/mimo-v2.5-free", entry: { free: true, limit: { context: 200000 } } },
    { id: "opencode/nemotron-3.5-lightning-free", entry: { free: true, limit: { context: 262144 } } },
    { id: "opencode/nemotron-3-ultra-free", entry: { free: true, limit: { context: 1000000 } } },
  ];
  const chain = rankChain(candidates);
  // Next biggest model (Nemotron 3 Ultra ~500B MoE, 1M context, score 95) must become primary:
  assert.equal(chain[0], "opencode/nemotron-3-ultra-free");
  assert.equal(chain[1], "opencode/nemotron-3.5-lightning-free");
  assert.equal(chain[2], "opencode/mimo-v2.5-free");
  // PRIMARY_MODEL must NOT be in the chain:
  assert.equal(chain.includes(PRIMARY_MODEL), false);
});

test("rankChain excludes deprecated models even if free", () => {
  const candidates = [
    { id: PRIMARY_MODEL, entry: { free: true, status: "deprecated" } },
    { id: "opencode/nemotron-3-ultra-free", entry: { free: true, limit: { context: 1000000 } } },
  ];
  const chain = rankChain(candidates);
  assert.equal(chain[0], "opencode/nemotron-3-ultra-free");
  assert.equal(chain.includes(PRIMARY_MODEL), false);
});

test("rankChain strictly filters out forbidden Gemini models", () => {
  const candidates = [
    { id: "opencode/gemini-3-flash", entry: { free: true } },
    { id: "google/gemini-3.5-flash-free", entry: { free: true } },
    { id: "google/antigravity-gemini-free", entry: { free: true } },
    { id: "opencode/nemotron-3-ultra-free", entry: { free: true } },
  ];
  const chain = rankChain(candidates);
  assert.deepEqual(chain, ["opencode/nemotron-3-ultra-free"]);
  for (const id of chain) {
    assert.equal(/gemini|google/i.test(id), false);
  }
});

test("validateChain validates proper chain lengths and contents", () => {
  assert.equal(validateChain(["opencode/nemotron-3-ultra-free"]), true);
  assert.equal(validateChain([]), false);
  assert.equal(
    validateChain([
      "opencode/m-1",
      "opencode/m-2",
      "opencode/m-3",
      "opencode/m-4",
      "opencode/m-5",
      "opencode/m-6",
    ]),
    false,
  );
  assert.equal(validateChain(["opencode/gemini-3-flash"]), false);
});

test("main writes valid state/model-chain.json using mock catalog", async () => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "refresh-state-"));
  const env = {
    FLEET_STATE_ROOT: stateRoot,
    ZEN_MODELS_URL: "file://" + path.resolve("config/models.json"),
  };
  const exitCode = await main(env);
  assert.equal(exitCode, 0);

  const chainFile = path.join(stateRoot, "state", "model-chain.json");
  const data = JSON.parse(readFileSync(chainFile, "utf8"));
  assert.ok(Array.isArray(data.chain));
  assert.ok(data.chain.length > 0);
  assert.ok(data.updatedAt);
  assert.equal(data.source, env.ZEN_MODELS_URL);
});
