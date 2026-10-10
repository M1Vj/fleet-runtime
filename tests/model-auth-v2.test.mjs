import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOnce } from "../scripts/lib/model.mjs";

test("V2 receives only the selected OpenCode API credential in its native environment", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-v2-auth-"));
  try {
    const bin = path.join(root, "opencode");
    writeFileSync(bin, `#!/usr/bin/env node
const correct = process.env.OPENCODE_API_KEY === "authorized-fixture";
const leaked = Boolean(process.env.GH_TOKEN || process.env.UNRELATED_API_KEY || process.env.FLEET_OPENCODE_AUTH);
console.log(JSON.stringify({ text: correct && !leaked ? "ready" : "credential unavailable", sessionID: "fixture-session" }));
`);
    chmodSync(bin, 0o755);
    const result = await runOnce({
      prompt: "bounded credential compatibility check",
      workspace: root,
      env: {
        PATH: `${root}:${process.env.PATH}`,
        HOME: root,
        FLEET_STATE_ROOT: root,
        FLEET_INDEFINITE_DISABLE: "1",
        FLEET_OPENCODE_AUTH: JSON.stringify({ opencode: { type: "api", key: "authorized-fixture" }, unrelated: { type: "api", key: "unrelated-fixture" } }),
        OPENCODE_API_KEY: "stale-ambient-fixture",
        GH_TOKEN: "controller-fixture",
        UNRELATED_API_KEY: "unrelated-fixture",
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.reply, "ready");
    const anonymous = await runOnce({
      prompt: "bounded anonymous isolation check",
      workspace: root,
      env: {
        PATH: `${root}:${process.env.PATH}`, HOME: root,
        FLEET_STATE_ROOT: root, FLEET_INDEFINITE_DISABLE: "1",
        OPENCODE_API_KEY: "authorized-fixture",
        FLEET_OPENCODE_AUTH: JSON.stringify({ unrelated: { type: "api", key: "authorized-fixture" } }),
      },
    });
    assert.equal(anonymous.reply, "credential unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
