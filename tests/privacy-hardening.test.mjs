import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { markGatewayDown } from "../scripts/lib/gateway-health.mjs";
import { redactText } from "../scripts/lib/pr-memory.mjs";
import { normalizeAuditRunId } from "../scripts/lib/pr-memory.mjs";
import { scrub } from "../scripts/lib/util.mjs";

test("scrub redacts the durable provider key alongside token and legacy auth", () => {
  const env = {
    FLEET_GH_TOKEN: "gh-token-supersecret-value",
    FLEET_OPENCODE_AUTH: "legacy-oauth-snapshot-supersecret",
    OPENCODE_API_KEY: "provider-key-supersecret-1234",
  };
  const out = scrub(env)([env.FLEET_GH_TOKEN, env.FLEET_OPENCODE_AUTH, env.OPENCODE_API_KEY].join(" | "));
  assert.equal(out.includes(env.FLEET_GH_TOKEN), false);
  assert.equal(out.includes(env.FLEET_OPENCODE_AUTH), false);
  assert.equal(out.includes(env.OPENCODE_API_KEY), false);
  assert.match(out, /\*\*\*/);
});

test("shared redactor covers provider, basic-auth, and database credential forms", () => {
  for (const value of [
    "npm_abcdefghijklmnopqrstuvwxyz1234567890",
    "glpat-abcdefghijklmnopqrstuvwxyz1234567890",
    "Basic YWJjZGVmZ2hpamtsbW5vcA==",
    "https://user:password@example.test/repo.git",
    "postgres://user:password@example.test/db",
  ]) {
    assert.notEqual(redactText(value), value, value);
  }
});

test("gateway health redacts model errors before persistence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-gateway-health-"));
  try {
    const token = "github_pat_abcdefghijklmnopqrstuvwxyz1234567890";
    markGatewayDown(root, `provider failed ${token} https://u:p@example.test/path`);
    const file = path.join(root, "state", "gateway-health.json");
    assert.equal(existsSync(file), true);
    const body = readFileSync(file, "utf8");
    assert.equal(body.includes(token), false);
    assert.equal(body.includes("u:p@example.test"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit run IDs are bounded to safe filename characters", () => {
  assert.equal(normalizeAuditRunId("../run id/with?secrets"), "run-id-with-secrets");
  assert.ok(normalizeAuditRunId(""));
});
