import { test } from "node:test";
import assert from "node:assert/strict";

import * as improve from "../scripts/improve.mjs";

import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../scripts/improve.mjs", import.meta.url), "utf8");
const { publicImproveModelOptions, validateImproveTarget } = improve;

const baseMeta = {
  full_name: "M1Vj/public-repo",
  private: false,
  visibility: "public",
  default_branch: "main",
};

test("improve target requires explicit public metadata", () => {
  assert.equal(validateImproveTarget({ repo: baseMeta.full_name, meta: baseMeta, targets: undefined }).ok, true);
  assert.equal(validateImproveTarget({ repo: baseMeta.full_name, meta: { ...baseMeta, private: true, visibility: "private" }, targets: undefined }).ok, false);
  assert.equal(validateImproveTarget({ repo: baseMeta.full_name, meta: { ...baseMeta, private: false, visibility: "internal" }, targets: undefined }).ok, false);
});

test("improve target honors an available tier-1 allowlist", () => {
  const targets = { tier1: ["M1Vj/public-repo"] };
  assert.equal(validateImproveTarget({ repo: baseMeta.full_name, meta: baseMeta, targets }).ok, true);
  const otherMeta = { ...baseMeta, full_name: "M1Vj/other-public" };
  const result = validateImproveTarget({ repo: otherMeta.full_name, meta: otherMeta, targets });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /tier1/);
});

test("every public improve model phase carries verified public routing context", () => {
  assert.deepEqual(publicImproveModelOptions(baseMeta), {
    dataClass: "public",
    publicTarget: baseMeta,
  });
  assert.throws(
    () => publicImproveModelOptions({ ...baseMeta, private: true, visibility: "private" }),
    /IMPROVE_PUBLIC_TARGET_REQUIRED/,
  );

  const plan = source.slice(source.indexOf("async function modePlan"), source.indexOf("async function modeImplement"));
  const research = source.slice(source.indexOf("async function modeResearch"), source.indexOf("function repo0"));
  const review = source.slice(source.indexOf("async function modeReview"), source.indexOf("async function modeFinalize"));
  assert.ok((research.match(/publicImproveModelOptions\(/g) || []).length >= 1, "clone-failure research must retain public context");
  assert.ok((plan.match(/publicImproveModelOptions\(/g) || []).length >= 2, "plan and repair calls must carry public context");
  assert.ok((review.match(/publicImproveModelOptions\(/g) || []).length >= 1, "review calls must carry public context");
});

test("public Improve plan prompts exclude private fleet memory", () => {
  assert.equal(typeof improve.buildPublicImprovePlanPrompt, "function");
  const sentinel = "PRIVATE_FLEET_MEMORY_SENTINEL";
  const prompt = improve.buildPublicImprovePlanPrompt({
    repo: baseMeta.full_name,
    idea: { title: "Fix it", rationale: "Reason", evidence: "Evidence" },
    sourceAvailable: true,
    fleetMemoryBlock: sentinel,
  });
  assert.equal(prompt.includes(sentinel), false);
  assert.match(prompt, /UNTRUSTED PUBLIC IDEA/);
  assert.doesNotMatch(prompt, /webfetch/i);
  assert.doesNotMatch(source.slice(source.indexOf("async function modePlan"), source.indexOf("async function modeImplement")), /loadImproveMemoryBlock|formatMemoryPromptBlock/);
  assert.doesNotMatch(source, /You may (?:use|fetch).*webfetch/i);
});

test("Improve revalidates visibility after anonymous source or diff retrieval", async () => {
  assert.equal(typeof improve.requireFreshPublicImproveTarget, "function");
  assert.throws(
    () => improve.requireFreshPublicImproveTarget(baseMeta.full_name, {
      ghImpl: () => ({ ...baseMeta, private: true, visibility: "private" }),
      targets: undefined,
    }),
    /IMPROVE_TARGET_REJECTED/,
  );
  const fresh = improve.requireFreshPublicImproveTarget(baseMeta.full_name, {
    ghImpl: () => baseMeta,
    targets: undefined,
  });
  assert.equal(fresh, baseMeta);
  assert.ok((source.match(/requireFreshPublicImproveTarget\(/g) || []).length >= 4, "helper plus research, plan, and review calls are required");

  assert.equal(typeof improve.fetchPublicPullFiles, "function");
  const calls = [];
  const files = await improve.fetchPublicPullFiles(baseMeta.full_name, 7, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, text: async () => JSON.stringify([{ filename: "README.md", patch: "+safe" }]) };
    },
  });
  assert.equal(files.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/M1Vj/public-repo/pulls/7/files?per_page=20");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.authorization, undefined);
});
