import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/merge.yml", import.meta.url), "utf8");
const mergeSource = readFileSync(new URL("../scripts/merge.mjs", import.meta.url), "utf8");
const archiveSource = readFileSync(new URL("../scripts/lib/archive-safe.mjs", import.meta.url), "utf8");
const prCheckSource = readFileSync(new URL("../scripts/pr-check.mjs", import.meta.url), "utf8");

test("manual dispatch has an explicit, fail-closed target contract", () => {
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:/);
  assert.match(workflow, /repo:[\s\S]*?required:\s*true/);
  assert.match(workflow, /pr:[\s\S]*?required:\s*true/);
  assert.match(workflow, /head_sha:[\s\S]*?required:\s*true/);
  assert.match(workflow, /allow_merge:[\s\S]*?default:\s*false/);
  assert.match(workflow, /dispatch_id:[\s\S]*?required:\s*false[\s\S]*?default:\s*["']{2}/);
  assert.doesNotMatch(workflow, /routes:/);
});

test("scan and target runs are separate and scan dispatches one explicit SHA", () => {
  assert.match(workflow, /scan:[\s\S]*?if:\s*\$\{\{\s*github\.event_name\s*==\s*['"]schedule['"]\s*\}\}/);
  assert.match(workflow, /target-check:[\s\S]*?if:[^\n]*github\.event_name\s*==\s*['"]workflow_dispatch['"]/);
  assert.match(mergeSource, /actions\/workflows\/merge\.yml\/dispatches/);
  assert.match(mergeSource, /ref:\s*["']main["']/);
  assert.match(mergeSource, /allowMerge\s*===\s*true\s*\?\s*["']true["']\s*:\s*["']false["']/);
  assert.doesNotMatch(workflow, /gh workflow run/);
  const scanJob = workflow.slice(workflow.indexOf("  scan:"), workflow.indexOf("  target-check:"));
  assert.doesNotMatch(scanJob, /revise\.mjs/);
  assert.doesNotMatch(workflow, /visual-check\.mjs/);
  assert.doesNotMatch(workflow, /install visual/i);
});

test("authorization precedes target checkout and target jobs consume only authorized outputs", () => {
  const authorize = workflow.indexOf("  authorize:");
  const materialize = workflow.indexOf("  materialize-target:");
  const target = workflow.indexOf("  target-check:");
  const gate = workflow.indexOf("  gate:");
  assert.ok(authorize >= 0 && authorize < materialize && materialize < target && target < gate);
  const materializeJob = workflow.slice(materialize, target);
  assert.match(materializeJob, /needs:\s*authorize/);
  assert.match(materializeJob, /upload-artifact/);
  assert.match(materializeJob, /sha256sum/);
  assert.doesNotMatch(materializeJob, /secrets\.|FLEET_GH_TOKEN/);
  assert.doesNotMatch(materializeJob, /actions\/checkout/);
  assert.match(materializeJob, /credential\.helper=/);
  assert.match(materializeJob, /fetch --depth=1 --no-tags origin/);
  assert.match(materializeJob, /rev-parse FETCH_HEAD/);
  const targetJob = workflow.slice(target, gate);
  assert.match(targetJob, /needs:\s*materialize-target/);
  assert.match(targetJob, /download-artifact/);
  assert.match(targetJob, /sha256sum\s+-c/);
  assert.doesNotMatch(targetJob, /repository:\s*\$\{\{\s*inputs\.repo/);
  assert.doesNotMatch(targetJob, /ref:\s*\$\{\{\s*inputs\.head_sha/);
  assert.doesNotMatch(targetJob, /FLEET_GH_TOKEN|FLEET_OPENCODE_AUTH|secrets\./);
  const authorizeJob = workflow.slice(authorize, target);
  assert.match(authorizeJob, /FLEET_AUTHORIZE_ONLY:\s*["']?true["']?/);
  assert.match(authorizeJob, /FLEET_TARGET_REPO:\s*\$\{\{\s*inputs\.repo\s*\}\}/);
  assert.match(authorizeJob, /FLEET_HEAD_SHA:\s*\$\{\{\s*inputs\.head_sha\s*\}\}/);
  assert.match(authorizeJob, /FLEET_DISPATCH_ID:\s*\$\{\{\s*inputs\.dispatch_id\s*\}\}/);
  assert.match(authorizeJob, /FLEET_KILL_SWITCH_PATH:/);
});

test("the workflow uses one global non-canceling concurrency group", () => {
  const groups = [...workflow.matchAll(/^\s+group:\s*(.+)$/gm)].map((match) => match[1].trim());
  assert.deepEqual(groups, ["fleet-merge-gate"]);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /queue:\s*max/);
});

test("target code has no state checkout or secret-bearing job environment", () => {
  const targetJob = workflow.slice(workflow.indexOf("  target-check:"), workflow.indexOf("  gate:"));
  assert.doesNotMatch(targetJob, /state-control/);
  assert.doesNotMatch(targetJob, /FLEET_GH_TOKEN\s*:/);
  assert.doesNotMatch(targetJob, /FLEET_OPENCODE_AUTH\s*:/);
  assert.doesNotMatch(targetJob, /secrets\./);
  const targetRun = targetJob.slice(targetJob.indexOf("run target"));
  assert.doesNotMatch(targetRun, /FLEET_GH_TOKEN|FLEET_OPENCODE_AUTH|GH_TOKEN|OPENCODE_MODELS_URL/);
  assert.match(targetJob, /persist-credentials:\s*false/);
});

test("trusted credentials are step-local and state root is explicit", () => {
  const gateJob = workflow.slice(workflow.indexOf("  gate:"));
  assert.doesNotMatch(gateJob.slice(0, gateJob.indexOf("steps:")), /FLEET_GH_TOKEN|FLEET_OPENCODE_AUTH/);
  assert.match(gateJob, /FLEET_GH_TOKEN:\s*\$\{\{\s*secrets\.FLEET_GH_TOKEN\s*\}\}/);
  assert.match(gateJob, /FLEET_OPENCODE_AUTH:\s*\$\{\{\s*secrets\.FLEET_OPENCODE_AUTH\s*\}\}/);
  assert.match(gateJob, /FLEET_ALLOW_MERGE:\s*\$\{\{\s*inputs\.allow_merge\s*\}\}/);
  assert.match(gateJob, /FLEET_DISPATCH_ID:\s*\$\{\{\s*inputs\.dispatch_id\s*\}\}/);
  assert.match(gateJob, /FLEET_STATE_ROOT:/);
  assert.doesNotMatch(gateJob, /FLEET_TARGET_REPO:\s*\$\{\{\s*inputs\.repo/);
  assert.match(gateJob, /FLEET_TARGET_REPO:\s*\$\{\{\s*needs\.authorize\.outputs\.repo/);
  assert.match(gateJob.slice(gateJob.indexOf("autonomous revision")), /FLEET_EVIDENCE_PATH:/);
});

test("target evidence is explicitly bounded and redacted before upload", () => {
  const targetJob = workflow.slice(workflow.indexOf("  target-check:"), workflow.indexOf("  gate:"));
  assert.match(targetJob, /MAX_EVIDENCE_CHARS/);
  assert.match(targetJob, /load canonical redactor before target execution/);
  assert.match(prCheckSource, /redactText/);
  assert.match(prCheckSource, /constants\.O_NOFOLLOW/);
  assert.match(prCheckSource, /renameSync\(temp, absolute\)/);
  assert.doesNotMatch(targetJob, /github_pat_|xox|AIza|Bearer|BEGIN PRIVATE KEY|eyJ/);
  assert.match(targetJob, /8000/);
  assert.match(targetJob, /upload-artifact/);
  assert.match(targetJob, /evidence\.txt/);
});

test("archive extraction validates members and uses safe tar flags", () => {
  const targetJob = workflow.slice(workflow.indexOf("  target-check:"), workflow.indexOf("  sanitize-evidence:"));
  assert.match(targetJob, /scripts\/lib\/archive-safe\.mjs/);
  assert.match(archiveSource, /--no-same-owner/);
  assert.match(archiveSource, /--no-same-permissions/);
  assert.match(archiveSource, /--no-overwrite-dir/);
  assert.match(targetJob, /target-check-evidence-raw/);
});

test("fresh sanitizer owns the canonical redaction sink while exact target outcome stays authoritative", () => {
  const sanitizer = workflow.slice(workflow.indexOf("  sanitize-evidence:"), workflow.indexOf("  gate:"));
  assert.match(sanitizer, /actions\/checkout/);
  assert.match(sanitizer, /target-check-evidence-raw/);
  assert.match(sanitizer, /scripts\/sanitize-evidence\.mjs/);
  assert.match(sanitizer, /target-check-evidence/);
  assert.doesNotMatch(sanitizer, /FLEET_GH_TOKEN|FLEET_OPENCODE_AUTH|state-control|secrets\./);
  const gateJob = workflow.slice(workflow.indexOf("  gate:"));
  assert.match(gateJob, /needs:\s*\[authorize, target-check, sanitize-evidence\]/);
  assert.match(gateJob, /FLEET_TARGET_CHECK_RESULT:\s*\$\{\{\s*needs\.target-check\.outputs\.check_result\s*\}\}/);
  assert.match(prCheckSource, /FLEET_EVIDENCE_V1|available=/i);
  assert.match(gateJob, /FLEET_EVIDENCE_PATH:/);
});

test("trusted judge tooling installs before private state is present", () => {
  const gateJob = workflow.slice(workflow.indexOf("  gate:"));
  assert.ok(gateJob.indexOf("install pinned judge cli") < gateJob.indexOf("checkout private state repo"));
});

test("scan dispatch uses the REST helper and kill switch", () => {
  const scan = workflow.slice(workflow.indexOf("  scan:"), workflow.indexOf("  authorize:"));
  assert.match(scan, /FLEET_GH_TOKEN:\s*\$\{\{\s*secrets\.FLEET_GH_TOKEN\s*\}\}/);
  assert.match(scan, /FLEET_KILL_SWITCH_PATH:/);
});

test("revision is gated by manual dispatch, authorization, normalized outputs, and judge signal", () => {
  const revision = workflow.slice(workflow.indexOf("      - name: autonomous revision"));
  assert.match(revision, /github\.event_name\s*==\s*['"]workflow_dispatch['"]/);
  assert.match(revision, /needs\.authorize\.result\s*==\s*['"]success['"]/);
  assert.match(revision, /needs\.authorize\.outputs\.repo\s*!=\s*['"]['"]/);
  assert.match(revision, /needs\.authorize\.outputs\.pr\s*!=\s*['"]['"]/);
  assert.match(revision, /needs\.authorize\.outputs\.head_sha\s*!=\s*['"]['"]/);
  assert.match(revision, /FLEET_DISPATCH_ID:\s*\$\{\{\s*inputs\.dispatch_id\s*\}\}/);
  assert.match(revision, /steps\.gate\.outputs\.revision_needed\s*==\s*['"]true['"]/);
});

test("an always-equivalent finalizer releases only a consumed claim when the gate never ran", () => {
  const finalizeIndex = workflow.indexOf("  finalize-setup-failure:");
  assert.ok(finalizeIndex > workflow.indexOf("  gate:"), "finalizer job must follow the gate job");
  const finalizeJob = workflow.slice(finalizeIndex);
  assert.match(finalizeJob, /needs:\s*\[authorize,\s*gate\]/);
  assert.match(finalizeJob, /github\.event_name == 'workflow_dispatch'/);
  assert.match(finalizeJob, /needs\.gate\.result != 'success'/);
  assert.match(finalizeJob, /node scripts\/merge-finalize\.mjs/);
  assert.match(finalizeJob, /FLEET_DISPATCH_ID:\s*\$\{\{\s*inputs\.dispatch_id\s*\}\}/);
  assert.match(finalizeJob, /FLEET_ALLOW_MERGE:\s*\$\{\{\s*inputs\.allow_merge\s*\}\}/);
  assert.match(finalizeJob, /FLEET_TARGET_REPO:\s*\$\{\{\s*needs\.authorize\.outputs\.repo\s*\}\}/);
  assert.doesNotMatch(finalizeJob, /FLEET_OPENCODE_AUTH|OPENCODE_API_KEY/);
});

test("the setup-failure finalizer runs even when the gate job failed", () => {
  const finalizeJob = workflow.slice(workflow.indexOf("  finalize-setup-failure:"));
  const condition = finalizeJob.match(/^\s+if:\s*(.+)$/m)?.[1] || "";
  assert.match(condition, /^\$\{\{\s*always\(\)/);
  assert.match(condition, /github\.event_name == 'workflow_dispatch'/);
  assert.match(condition, /needs\.gate\.result != 'success'/);
});

test("every model-credential wiring also exposes the durable provider key", () => {
  const dir = new URL("../.github/workflows/", import.meta.url);
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".yml")) continue;
    const text = readFileSync(new URL(name, dir), "utf8");
    const legacy = text.match(/secrets\.FLEET_OPENCODE_AUTH/g) || [];
    const provider = text.match(/OPENCODE_API_KEY: \$\{\{ secrets\.OPENCODE_API_KEY \}\}/g) || [];
    assert.equal(provider.length, legacy.length, `${name}: each FLEET_OPENCODE_AUTH wiring needs a sibling OPENCODE_API_KEY wiring`);
  }
});
