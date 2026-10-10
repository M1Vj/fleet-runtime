import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOnce, askModelResilient } from "../scripts/lib/model.mjs";

for (const authenticated of [false, true]) {
  test(`provider access denial stops every retry and failover (${authenticated ? 'authenticated' : 'anonymous'})`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fleet-provider-denial-'));
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn,
      Number(ms) >= 20_000 && Number(ms) < 40_000 ? 0 : ms, ...args);
    try {
      const calls = path.join(root, 'calls.jsonl');
      const bin = path.join(root, 'opencode');
      writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({type:'error',sessionID:'denied-session',error:{message:"OpenCode's free tier can only be used from within OpenCode"}}));
process.exitCode = 1;
`);
      chmodSync(bin, 0o755);
      const result = await askModelResilient({
        prompt:'provider denial fixture', workspace:root, maxRounds:4, cooldownMs:0,
        env:{PATH:`${root}:${process.env.PATH}`,HOME:root,FLEET_STATE_ROOT:root,
          FLEET_INDEFINITE_DISABLE:'1',
          FLEET_MODEL_CHAIN:'opencode/muse-spark-1.3-contributor-free,opencode/mimo-v2.6-flash-free',
          ...(authenticated ? {FLEET_OPENCODE_AUTH:JSON.stringify({opencode:{type:'api',key:'authorized-fixture'}})} : {}),
        },
      });
      assert.equal(result.complete, false);
      assert.equal(result.blocked, true);
      assert.equal(result.providerAccessDenied, true);
      assert.equal(result.reason, 'provider_access_denied');
      assert.equal(result.waitingForQuota, undefined);
      assert.equal(result.ladders, 1);
      assert.equal(result.attempts.length, 1);
      assert.equal(readFileSync(calls,'utf8').trim().split('\n').length, 1);
      assert.match(result.attempts[0].errHead, /free tier/);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      rmSync(root, {recursive:true,force:true});
    }
  });
}

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

test('native crash diagnostics retain the redacted cause before a long stack', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fleet-v2-error-'));
  try {
    const bin = path.join(root, 'opencode');
    writeFileSync(bin, `#!/usr/bin/env node
process.stderr.write('ConfigError: rejected schema; credential=' + process.env.OPENCODE_API_KEY + '\\n' + '    at nativeFrame()\\n'.repeat(100));
process.exitCode = 1;
`);
    chmodSync(bin, 0o755);
    const result = await runOnce({ prompt: 'diagnostic fixture', workspace: root, env: {
      PATH: `${root}:${process.env.PATH}`, HOME: root, FLEET_STATE_ROOT: root,
      FLEET_INDEFINITE_DISABLE: '1',
      FLEET_OPENCODE_AUTH: JSON.stringify({opencode:{type:'api',key:'opaque-fixture-value'}}),
    }});
    assert.match(result.stderrHead, /ConfigError: rejected schema/);
    assert.doesNotMatch(result.stderrHead, /opaque-fixture-value/);
    assert.ok(result.stderrHead.length <= 400);
    assert.match(result.stderrTail, /nativeFrame/);
  } finally { rmSync(root, { recursive:true, force:true }); }
});
