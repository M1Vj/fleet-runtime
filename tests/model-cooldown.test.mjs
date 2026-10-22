import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOnce } from "../scripts/lib/model.mjs";
import { clearAllModelRetries, modelRetryWaitMs } from "../scripts/lib/credential-pool.mjs";
import { closeDb } from "../scripts/lib/persistent-memory.mjs";
import { DEFAULT_MODEL_CHAIN } from "../scripts/lib/provider-registry.mjs";

const model = DEFAULT_MODEL_CHAIN[0];
const cooldownMs = 60_000;
const rateLimitCooldownMs = 120_000;
const cases = [
  { name: "nested statusCode 429", event: { type: "error", error: { message: "provider failed", data: { statusCode: 429 } } }, cools: true },
  { name: "nested status 429 even on zero exit", event: { type: "error", error: { message: "provider failed", data: [{ status: 429 }] } }, exitCode: 0, cools: true },
  { name: "numeric-string statusCode 429", event: { type: "error", error: { message: "provider failed", statusCode: "429" } }, cools: true },
  { name: "structured rate limit uses its class cooldown", event: { type: "error", error: { message: "HTTP 429 Too Many Requests", data: { statusCode: 429 } } }, cooldownMs: rateLimitCooldownMs, cools: true },
  { name: "stderr-only 429", stderr: "HTTP 429 Too Many Requests\n", cools: false },
  { name: "malformed JSON containing 429", stdout: '{"error":{"statusCode":429}\n', stderr: "HTTP 429 Too Many Requests\n", cools: false },
  { name: "non-429 status with 429 text", event: { type: "error", error: { message: "HTTP 429 Too Many Requests", data: { statusCode: 503, status: 500 } } }, cools: false },
  { name: "ordinary failure without status", event: { type: "error", error: { message: "provider failed" } }, cools: false },
  { name: "429 in an unrelated numeric field", event: { type: "error", error: { message: "provider failed", code: 429 } }, cools: false },
  { name: "numeric session ID is not accepted", event: { text: "ok", sessionID: 429, status: 200 }, exitCode: 0, reply: "ok", cools: false },
  { name: "successful reply and session", event: { text: "ok", sessionID: "session-test", status: 200 }, exitCode: 0, reply: "ok", sessionId: "session-test", cools: false },
];

for (const fixture of cases) {
  test(`runOnce model cooldown: ${fixture.name}`, async () => {
    clearAllModelRetries();
    closeDb();
    const dir = mkdtempSync(path.join(tmpdir(), "fleetmodel-cooldown-"));
    try {
      const bin = path.join(dir, "opencode");
      const stdout = fixture.stdout ?? (fixture.event ? `${JSON.stringify(fixture.event)}\n` : "");
      writeFileSync(bin, [
        `#!${process.execPath}`,
        `process.stdout.write(${JSON.stringify(stdout)});`,
        `process.stderr.write(${JSON.stringify(fixture.stderr || "")});`,
        `process.exitCode = ${fixture.exitCode ?? 1};`,
        "",
      ].join("\n"));
      chmodSync(bin, 0o755);
      // Deliberately do not inherit ambient credentials, proxy configuration,
      // or PATH. This fixture only emits literal output and cannot call a model.
      const env = {
        PATH: dir,
        HOME: dir,
        FLEET_STATE_ROOT: dir,
        FLEET_MEMORY_DB: ":memory:",
        FLEET_INDEFINITE_DISABLE: "1",
        FLEET_UNKNOWN_COOLDOWN_MS: String(cooldownMs),
        FLEET_RATE_LIMIT_COOLDOWN_MS: String(rateLimitCooldownMs),
      };
      const startedAt = Date.now();
      const result = await runOnce({ prompt: "offline fixture", model, workspace: dir, env });
      const finishedAt = Date.now();
      assert.equal(result.spawnFailed, false);
      assert.equal(result.exitCode, fixture.exitCode ?? 1);
      assert.equal(result.model, model);
      assert.equal(result.reply, fixture.reply || "");
      assert.equal(result.sessionId, fixture.sessionId || "");
      assert.equal(result.sessionIdReturned, Boolean(fixture.sessionId));
      const waitMs = modelRetryWaitMs(model, { nowMs: startedAt });
      if (fixture.cools) {
        const expectedCooldownMs = fixture.cooldownMs ?? cooldownMs;
        assert.ok(waitMs >= expectedCooldownMs, `expected a model cooldown, got ${waitMs}ms`);
        assert.ok(waitMs <= expectedCooldownMs + finishedAt - startedAt, "cooldown must use the configured duration");
      } else {
        assert.equal(waitMs, 0, "unstructured and non-429 responses must not cool the model");
      }
      assert.equal(modelRetryWaitMs(DEFAULT_MODEL_CHAIN[1], { nowMs: startedAt }), 0, "other models must remain available");
    } finally {
      clearAllModelRetries();
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
