import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RUNBOOK = path.join(ROOT, "docs", "fleet-selftest-triage-runbook.md");
const GENERIC = path.join(ROOT, "docs", "runbooks", "ci-failure-triage.md");
const SCRIPT = path.join(ROOT, "scripts", "fleet-triage-snapshot.sh");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "selftest.yml");

const read = (p) => fs.readFileSync(p, "utf8");

test("runbook exists and ends with POSIX EOF newline", () => {
  assert.ok(fs.existsSync(RUNBOOK), "docs/fleet-selftest-triage-runbook.md must exist");
  const buf = fs.readFileSync(RUNBOOK);
  assert.ok(buf.length > 0, "runbook must be non-empty");
  assert.equal(buf[buf.length - 1], 0x0a, "runbook must end with newline");
});

test("runbook reconciles generic triage runbook instead of duplicating it", () => {
  const md = read(RUNBOOK);
  assert.match(md, /docs\/runbooks\/ci-failure-triage\.md/, "must link generic runbook");
  assert.match(md, /authoritative|supplement/i, "must state generic runbook authority");
  assert.match(md, /canary/i, "must reconcile canary policy");
  assert.match(md, /escalat/i, "must reconcile escalation");
});

test("runbook uses parameterized failed-only rerun with triage-issue link", () => {
  const md = read(RUNBOOK);
  assert.ok(
    md.includes("gh run rerun <run-id> --failed"),
    "must contain parameterized 'gh run rerun <run-id> --failed'",
  );
  const steps = md.split("## Guardrails")[0].split("## Steps")[1] || "";
  assert.doesNotMatch(steps, /gh run rerun [0-9]{5,}/, "Steps must not hardcode numeric run id");
  assert.match(md, /triage-issue/i, "must require triage-issue link");
});

test("runbook documents redaction rule and gated live capture", () => {
  const md = read(RUNBOOK);
  assert.match(md, /redact/i, "must document redaction");
  assert.match(md, /FLEET_LIVE_TRIAGE/, "must gate live capture behind FLEET_LIVE_TRIAGE");
  assert.match(md, /SKIP: live gh capture requires/, "must state skip reason");
  assert.match(md, /FLEET_PUBLIC_ARTIFACT_MANIFEST|failure-log.*artifact|workflow artifact/i, "must forbid raw log artifacts");
});

test("runbook guardrails are actionable (concurrency key + draft PR)", () => {
  const md = read(RUNBOOK);
  assert.ok(md.includes("fleet-selftest-public"), "must name exact concurrency group");
  assert.ok(md.includes("--draft"), "must document draft-PR workflow");
  assert.match(md, /never.*main|no.*push.*main|direct.*push.*forbidden/i, "must forbid default-branch push");
  const wf = read(WORKFLOW);
  assert.ok(wf.includes("fleet-selftest-public"), "workflow must define fleet-selftest-public");
  assert.ok(md.includes("cancel-in-progress: false"), "must mirror cancel-in-progress policy");
});

test("runbook isolates ephemeral incident state to appendix", () => {
  const md = read(RUNBOOK);
  assert.match(md, /Appendix B.*[Ee]phemeral|ephemeral.*appendix/i, "must isolate ephemeral instance");
  assert.match(md, /34589043909/, "must preserve triage instance id in appendix");
  assert.match(md, /remove.*appendix|delete.*appendix/i, "must require appendix removal after landing");
});

test("runbook verification is hermetic with node --test evidence", () => {
  const md = read(RUNBOOK);
  assert.match(md, /--check/, "must document hermetic --check");
  assert.match(md, /node --test/, "must document node --test suite");
  assert.match(md, /markdown/i, "must document markdown link check");
});

test("no synthetic downgrade markers in triage files", () => {
  for (const p of [RUNBOOK, SCRIPT]) {
    const content = read(p).toLowerCase();
    assert.doesNotMatch(content, /gemini/, "must never reference Gemini models");
  }
});

test("snapshot script is executable with fail-fast guards and validation", () => {
  assert.ok(fs.existsSync(SCRIPT), "script must exist");
  assert.ok((fs.statSync(SCRIPT).mode & 0o111) !== 0, "script must be executable");
  const sh = read(SCRIPT);
  assert.ok(sh.includes("set -euo pipefail"), "script must keep fail-fast guard");
  assert.match(sh, /5-20 digits|invalid run id/, "script must validate run id");
  assert.match(sh, /owner\/name|invalid repo/, "script must validate repo");
  assert.ok(sh.includes("--check"), "script must support --check");
  assert.ok(sh.includes("--help"), "script must support --help");
  assert.match(sh, /gho_|ghp_|github_pat_/, "script must implement redaction patterns");
});

test("script --help and invalid input fail closed", () => {
  const help = spawnSync("bash", [SCRIPT, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, "--help must exit 0");
  assert.match(help.stdout, /Usage/, "--help must print usage");
  const bad = spawnSync("bash", [SCRIPT, "not-a-run"], { encoding: "utf8" });
  assert.notEqual(bad.status, 0, "invalid run id must fail closed");
  assert.match(bad.stderr, /invalid run id/, "must explain invalid run id");
});

test("script --check passes hermetically without network", () => {
  const r = spawnSync("bash", [SCRIPT, "--check"], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `--check must pass hermetically:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
  assert.match(r.stdout, /--check: OK/, "--check must report OK");
});

test("script --stdin redacts token-shaped values and enforces redaction", () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, "triage-snapshots-test-"));
  try {
    const evil = "error boom token ghp_ABCDEFGHIJ1234567890 and github_pat_abc123XYZ bearer Bearer abc.def.ghi";
    const r = spawnSync("bash", [SCRIPT, "--stdin", "34589043909", "--out", tmp], {
      encoding: "utf8",
      cwd: ROOT,
      input: evil,
    });
    assert.equal(r.status, 0, `--stdin must succeed:\n${r.stdout}\n${r.stderr}`);
    const outMd = path.join(tmp, "snapshot-34589043909.md");
    assert.ok(fs.existsSync(outMd), "must write redacted snapshot");
    const content = read(outMd);
    assert.doesNotMatch(content, /ghp_ABCDEFGHIJ/, "token must be redacted");
    assert.doesNotMatch(content, /github_pat_abc/, "PAT must be redacted");
    assert.match(content, /\*\*\*/, "redaction marker must appear");
    assert.match(content, /34589043909/, "run id must appear in snapshot");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("generic ci-failure-triage runbook still intact (no doc deletion)", () => {
  assert.ok(fs.existsSync(GENERIC), "generic runbook must still exist");
  const generic = read(GENERIC);
  assert.match(generic, /gh run rerun <id> --failed/, "generic rerun guidance intact");
  assert.match(generic, /canary/i, "generic canary intact");
  assert.match(generic, /Escalation/, "generic escalation intact");
});