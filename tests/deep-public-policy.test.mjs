import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as deep from "../scripts/deep.mjs";

const source = readFileSync(new URL("../scripts/deep.mjs", import.meta.url), "utf8");
const publicMeta = {
  full_name: "M1Vj/public-repo",
  private: false,
  visibility: "public",
};

test("Deep keeps verified-public routing when the anonymous clone is unavailable", () => {
  assert.deepEqual(deep.publicDeepModelOptions(publicMeta), {
    dataClass: "public",
    publicTarget: publicMeta,
  });
  assert.throws(
    () => deep.publicDeepModelOptions({ ...publicMeta, private: true, visibility: "private" }),
    /DEEP_PUBLIC_TARGET_REQUIRED/,
  );
  const worker = source.slice(source.indexOf("async function mainWorker"), source.indexOf("/** Best-effort"));
  assert.match(worker, /prepared\s*=\s*\{\s*meta\s*\}/);
  const analyze = source.slice(source.indexOf("export async function analyzeOne"), source.indexOf("async function mainWorker"));
  assert.match(analyze, /publicDeepModelOptions\(/);
  assert.match(analyze, /Boolean\(prepared\?\.workspace\)/);
});

test("Deep revalidates public visibility immediately before the model call", () => {
  assert.equal(typeof deep.requireFreshPublicDeepTarget, "function");
  assert.throws(
    () => deep.requireFreshPublicDeepTarget(publicMeta.full_name, {
      ghImpl: () => ({ ...publicMeta, private: true, visibility: "private" }),
    }),
    /DEEP_PUBLIC_TARGET_REJECTED/,
  );
  assert.equal(deep.requireFreshPublicDeepTarget(publicMeta.full_name, { ghImpl: () => publicMeta }), publicMeta);
  const analyze = source.slice(source.indexOf("export async function analyzeOne"), source.indexOf("async function mainWorker"));
  assert.match(analyze, /requireFreshPublicDeepTarget\(/);
});
