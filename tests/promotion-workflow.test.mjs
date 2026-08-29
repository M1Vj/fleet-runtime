import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/promote-capability.yml", import.meta.url), "utf8");
const cli = readFileSync(new URL("../scripts/promote-capability.mjs", import.meta.url), "utf8");
const feature = readFileSync(new URL("../docs/specs/capability-promotion.feature", import.meta.url), "utf8");
const runbook = readFileSync(new URL("../docs/runbooks/capability-promotion.md", import.meta.url), "utf8");

test("promotion workflow is dispatch-only and disabled behind the owner gate", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.doesNotMatch(workflow, /repository_dispatch:/);
  assert.match(workflow, /vars\.FLEET_PROMOTION_ENABLE\s*==\s*['"]true['"]/);
  assert.match(workflow, /group:\s*fleet-state-writer/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
});

test("candidate checks stay secretless and separate from trusted state verification", () => {
  const candidate = workflow.slice(workflow.indexOf("  candidate-tests:"), workflow.indexOf("  trusted-state-activation:"));
  const trusted = workflow.slice(workflow.indexOf("  trusted-state-activation:"));
  assert.match(candidate, /promote-capability\.mjs/);
  assert.match(candidate, /upload-artifact/);
  assert.doesNotMatch(candidate, /secrets\.|FLEET_GH_TOKEN|state-control|OPENCODE_API_KEY/);
  assert.match(trusted, /download-artifact/);
  assert.match(trusted, /repository:\s*M1Vj\/fleet-control/);
  assert.match(trusted, /FLEET_GH_TOKEN/);
  assert.doesNotMatch(trusted, /OPENCODE_API_KEY|FLEET_OPENCODE_AUTH/);
  assert.doesNotMatch(workflow, /git\s+(?:commit|push)|gh\s+workflow\s+run/);
});

test("trusted execution is an attributed non-force capability branch and draft PR with durable state commits", () => {
  const trusted = workflow.slice(workflow.indexOf("  trusted-state-activation:"));
  assert.match(trusted, /permissions:\s*\n\s+contents:\s*write\s*\n\s+pull-requests:\s*write/);
  assert.match(trusted, /--execute/);
  assert.match(trusted, /FLEET_PROMOTION_ENABLE/);
  assert.match(trusted, /FLEET_GH_TOKEN/);
  assert.match(trusted, /FLEET_KILL_SWITCH_PATH/);
  assert.match(trusted, /--base-sha/);
  assert.doesNotMatch(workflow, /git\s+push[^\n]*\bmain\b/i);
  assert.doesNotMatch(workflow, /gh\s+workflow\s+run/i);

  assert.match(cli, /import\s+\{\s*runGate\s*\}\s+from\s+["']\.\/lib\/gate\.mjs/);
  assert.match(cli, /createGitHubPromotionAdapters/);
  assert.match(cli, /fleet\/capability-/);
  assert.match(cli, /force:\s*false/);
  assert.match(cli, /draft:\s*true/);
  assert.match(cli, /result\?\.draft\s*!==\s*true/);
  assert.match(cli, /commitPromotionState/);
  assert.match(cli, /safeCommitState/);
  assert.match(cli, /ACTIVATION_PLANNED/);
  assert.match(cli, /ACTIVATION_PR_OPENED/);
  assert.match(cli, /ROLLBACK_PLANNED/);
  assert.doesNotMatch(cli, /force:\s*true/);
});

test("Gherkin and runbook record strict evidence and inactive built-in boundaries", () => {
  assert.match(feature, /Feature: Governed capability promotion/);
  assert.match(feature, /two or more distinct named trusted judges/);
  assert.match(feature, /post-activation health fails/);
  assert.match(runbook, /Existing built-ins are intentionally inactive/);
  assert.match(runbook, /no arbitrary code/);
});
