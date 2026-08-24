import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildTargetEnv, runChecks, sanitizeEvidence } from "../scripts/pr-check.mjs";

test("target command environment excludes fleet credentials and private-state variables", () => {
  const env = buildTargetEnv({
    PATH: "/bin",
    HOME: "/tmp",
    FLEET_GH_TOKEN: "token",
    FLEET_OPENCODE_AUTH: "model-secret",
    GH_TOKEN: "token",
    FLEET_STATE_ROOT: "/private/state",
    OPENCODE_MODELS_URL: "file:///private/models.json",
    CI: "true",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.CI, "true");
  assert.notEqual(env.HOME, "/tmp");
  assert.match(env.NPM_CONFIG_CACHE, /npm-cache$/);
  for (const key of ["FLEET_GH_TOKEN", "FLEET_OPENCODE_AUTH", "GH_TOKEN", "FLEET_STATE_ROOT", "OPENCODE_MODELS_URL"]) {
    assert.equal(Object.hasOwn(env, key), false, key);
  }
});

test("target evidence redacts token, JWT, PEM, and query-credential output", () => {
  const raw = "ghp_abcdefghijklmnopqrstuvwxyz1234567890 eyJaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc -----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY----- https://x.test/?token=secret";
  const safe = sanitizeEvidence(raw);
  assert.equal(safe.includes("ghp_abcdefghijklmnopqrstuvwxyz1234567890"), false);
  assert.equal(safe.includes("eyJaaaaaaaaaaaaaaaaaaaa"), false);
  assert.equal(safe.includes("BEGIN PRIVATE KEY"), false);
  assert.equal(safe.includes("token=secret"), false);
});

test("target checks write bounded fixed evidence and do not execute visual tooling", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-pr-check-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e 'process.stdout.write(\"ok\")'" } }));
  const evidence = path.join(root, "evidence.txt");
  const result = await runChecks({ targetDir: root, evidencePath: evidence, maxEvidenceChars: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.visual, false);
  assert.ok(readFileSync(evidence, "utf8").length <= 200);
  assert.match(readFileSync(evidence, "utf8"), /npm test/);
});
