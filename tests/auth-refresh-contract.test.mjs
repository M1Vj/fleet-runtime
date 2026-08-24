import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const helper = readFileSync(new URL("../scripts/refresh-auth-secret.mjs", import.meta.url), "utf8");
const installer = readFileSync(new URL("../scripts/install-keepalive.sh", import.meta.url), "utf8");
const runbook = readFileSync(new URL("../docs/RUNBOOK.md", import.meta.url), "utf8");

test("auth refresh helper loops over both exact fleet repositories", () => {
  assert.match(helper, /const REPOS = \[\s*"M1Vj\/fleet-runtime",\s*"M1Vj\/fleet-control"\s*,?\s*\];/);
  assert.equal((helper.match(/spawnSync\("gh"/g) || []).length, 1);
  assert.doesNotMatch(helper, /function setSecretLegacy/);
});

test("auth refresh helper sends content through gh stdin without logging it", () => {
  assert.match(helper, /input: value/);
  assert.match(helper, /stdio: \["pipe", "inherit", "inherit"\]/);
  assert.doesNotMatch(helper, /process\.(stdout|stderr)\.write\([^;]*(?:value|content)/s);
});

test("keepalive uses runtime helper with absolute node and login shell", () => {
  assert.match(installer, /FLEET_DIR="\$HOME\/Projects\/fleet-runtime"/);
  assert.match(installer, /NODE_BIN="\$\(command -v node\)"/);
  assert.match(installer, /NODE_BIN" != \/\* /);
  assert.match(installer, /<string>\/bin\/zsh<\/string>\s*<string>-lc<\/string>/);
  assert.match(installer, /cd ["']?\$\{?FLEET_DIR_XML\}?["']?\s*&amp;&amp;\s*exec ["']?\$\{?NODE_BIN_XML\}?["']? scripts\/refresh-auth-secret\.mjs/);
  assert.doesNotMatch(installer, /fleet-control/);
  assert.doesNotMatch(installer, /<string>node scripts\/refresh-auth-secret\.mjs/);
});

test("runbook documents one helper refresh for both repositories", () => {
  assert.match(runbook, /helper targets both `M1Vj\/fleet-runtime` and\s+`M1Vj\/fleet-control`/);
  assert.doesNotMatch(runbook, /helper targets fleet-control only/);
  assert.doesNotMatch(runbook, /mirror manually/);
});
