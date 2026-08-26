import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("public source workspaces are refused unless the target proves public", async () => {
  const { createPublicSourceWorkspace } = await import("../scripts/lib/source-workspace.mjs");
  const base = mkdtempSync(path.join(os.tmpdir(), "fleet-source-ws-test-"));
  try {
    assert.throws(
      () => createPublicSourceWorkspace("M1Vj/private-repo", { private: true, visibility: "private" }, { repoRoot: base, stateRoot: "" }),
      /MODEL_PUBLIC_TARGET_REQUIRED/,
    );
    assert.throws(
      () => createPublicSourceWorkspace("M1Vj/maybe-repo", null, { repoRoot: base, stateRoot: "" }),
      /MODEL_PUBLIC_TARGET_REQUIRED/,
    );
    assert.equal(readdirSync(base).length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
