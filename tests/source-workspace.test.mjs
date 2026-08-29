import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

test("public source retrieval is anonymous and cannot inherit GitHub credentials", () => {
  const source = readFileSync(new URL("../scripts/lib/source-workspace.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bgh\s*\(/);
  assert.match(source, /credential\.helper=/);
  assert.match(source, /GIT_CONFIG_GLOBAL/);
  assert.match(source, /GIT_TERMINAL_PROMPT/);
});

test("public source retrieval requires exact repository identity and a credential-isolated clone", async () => {
  const { createPublicSourceWorkspace } = await import("../scripts/lib/source-workspace.mjs");
  const { disposeModelWorkspace } = await import("../scripts/lib/model.mjs");
  const base = mkdtempSync(path.join(os.tmpdir(), "fleet-source-clone-test-"));
  const calls = [];
  try {
    assert.throws(
      () => createPublicSourceWorkspace("M1Vj/public-repo", { private: false, visibility: "public" }, { repoRoot: base, stateRoot: "", spawnImpl: () => ({ status: 0 }) }),
      /PUBLIC_SOURCE_REPO_INVALID/,
    );
    assert.throws(
      () => createPublicSourceWorkspace("M1Vj/public-repo", { full_name: "M1Vj/other", private: false, visibility: "public" }, { repoRoot: base, stateRoot: "", spawnImpl: () => ({ status: 0 }) }),
      /PUBLIC_SOURCE_REPO_INVALID/,
    );

    const prepared = createPublicSourceWorkspace(
      "M1Vj/public-repo",
      { full_name: "M1Vj/public-repo", private: false, visibility: "public" },
      {
        repoRoot: base,
        stateRoot: "",
        spawnImpl(command, args, options) {
          calls.push({ command, args, options });
          return { status: 0 };
        },
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "git");
    assert.deepEqual(calls[0].args.slice(0, 3), ["-c", "credential.helper=", "clone"]);
    assert.ok(calls[0].args.includes("https://github.com/M1Vj/public-repo.git"));
    assert.equal(calls[0].options.env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(calls[0].options.env.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(calls[0].options.env.GIT_ASKPASS, "");
    assert.equal("GH_TOKEN" in calls[0].options.env, false);
    assert.equal("GITHUB_TOKEN" in calls[0].options.env, false);
    disposeModelWorkspace(prepared.workspace);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
