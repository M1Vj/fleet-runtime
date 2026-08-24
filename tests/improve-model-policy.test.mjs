import { test } from "node:test";
import assert from "node:assert/strict";

import { validateImproveTarget } from "../scripts/improve.mjs";

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

