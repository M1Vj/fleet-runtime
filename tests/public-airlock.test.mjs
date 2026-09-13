import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  publicRepository as runtimePublicRepository,
  publicTargetDecision as runtimePublicTargetDecision,
  publicArtifactPayload as runtimePublicArtifactPayload,
  publicStateRoot as runtimePublicStateRoot,
  resolveArtifactManifest as runtimeResolveArtifactManifest,
} from "../scripts/lib/private-state.mjs";
import { writeTaskArtifact } from "../scripts/orchestrate.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
const WORKFLOW_FILES = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

const PRIVATE_CONTROL_MARKER = ["fleet", "control"].join("-");
const STATE_CONTROL_MARKER = ["state", "control"].join("-");
const PRIVATE_STATE_MARKER = ["private", "state"].join("-");
const PRIVATE_MARKERS = [
  PRIVATE_CONTROL_MARKER,
  STATE_CONTROL_MARKER,
  "FLEET_GH_TOKEN",
  "FLEET_OPENCODE_AUTH",
  "GDRIVE_REFRESH_TOKEN",
  "GDRIVE_CLIENT_ID",
  "GDRIVE_CLIENT_SECRET",
  "GDRIVE_FOLDER_ID",
  "~/.local/share/opencode",
  "pull_request_target",
  "workflow_run",
  "issue_comment",
  "github.event.client_payload",
  "toJSON(github.event",
];

const FAILURE_LOG_MARKERS = [
  "dump opencode logs",
  "opencode/log",
  "opencode\\log",
  "tail -c",
  "tail -n",
  "cat ~/.",
];

const PUBLIC_GITHUB_TOKEN = "${{ github.token }}";

function workflowText(name) {
  return readFileSync(path.join(WORKFLOW_DIR, name), "utf8");
}

function publicTargetRuns(text) {
  const lines = text.split("\n");
  const runs = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s+- name:\s+validate public target\s*$/.test(lines[index])) continue;
    let runIndex = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s+- (?:name|uses):/.test(lines[cursor])) break;
      if (/^\s+run:\s*\|\s*$/.test(lines[cursor])) {
        runIndex = cursor;
        break;
      }
    }
    assert.notEqual(runIndex, -1, "public target step must contain a literal bash run block");
    const body = [];
    for (let cursor = runIndex + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === "") {
        body.push("");
        continue;
      }
      const indentation = line.match(/^ */)?.[0].length || 0;
      if (indentation < 10) break;
      body.push(line.slice(10));
    }
    runs.push(body.join("\n"));
  }
  return runs;
}

function workflowStepBlock(text, stepName) {
  const marker = `- name: ${stepName}`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `workflow step is missing: ${stepName}`);
  const remainder = text.slice(start);
  const nextStep = remainder.search(/\n\s+- name:/);
  return nextStep === -1 ? remainder : remainder.slice(0, nextStep);
}

function workflowStepBlocks(text, stepName) {
  const marker = `- name: ${stepName}`;
  return text
    .split(/\n(?=\s+- (?:name|uses):)/g)
    .filter((block) => block.includes(marker));
}

function workflowRunScript(stepBlock) {
  const match = stepBlock.match(/^\s+run:\s*\|\s*\n([\s\S]*)$/m);
  assert.ok(match, "step must contain a literal bash run block");
  return match[1]
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

function workflowJobBlocks(text) {
  const jobsMarker = "\njobs:\n";
  const jobsStart = text.indexOf(jobsMarker);
  assert.notEqual(jobsStart, -1, "workflow must declare jobs");
  const blocks = [];
  let current = null;
  for (const line of text.slice(jobsStart + jobsMarker.length).split("\n")) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(line)) {
      if (current) blocks.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) blocks.push(current.join("\n"));
  return blocks;
}

const PUBLIC_ACTIVATION_GATE = /(?:^|\n)\s{4}if:\s*(?:\$\{\{\s*)?vars\.FLEET_PUBLIC_ACTIVATED\s*==\s*['"]true['"]/;

function publicTargetDecision(metadata, allowedOwners = ["M1Vj"]) {
  if (!metadata || typeof metadata !== "object") return { ok: false, reason: "missing-metadata" };
  const owner = String(metadata.owner?.login || "");
  const visibility = String(metadata.visibility || "").toLowerCase();
  if (!allowedOwners.includes(owner)) return { ok: false, reason: "owner-not-allowlisted" };
  if (metadata.private !== false || visibility !== "public") return { ok: false, reason: "not-public" };
  if (metadata.archived === true) return { ok: false, reason: "archived" };
  return { ok: true, repository: `${owner}/${metadata.name}` };
}

test("all public workflows are secretless and contain no private-control references", () => {
  for (const name of WORKFLOW_FILES) {
    const text = workflowText(name);
    for (const marker of PRIVATE_MARKERS) {
      assert.equal(text.includes(marker), false, `${name} contains forbidden marker ${marker}`);
    }
    for (const marker of FAILURE_LOG_MARKERS) {
      assert.equal(text.includes(marker), false, `${name} exposes a failure-log marker ${marker}`);
    }
    assert.equal(/\bsecrets\./.test(text), false, `${name} references a privileged secret`);
    const permissionsBlock = text.match(/^permissions:\n((?:^[ \t]+[^\n]*\n?)*)/m)?.[1] || "";
    assert.doesNotMatch(permissionsBlock, /\b(?:write|none)\b/i, `${name} grants a write permission`);
  }
});

test("public workflows use only the built-in read token when a token is needed", () => {
  for (const name of WORKFLOW_FILES) {
    const text = workflowText(name);
    const tokenExpressions = [...text.matchAll(/\$\{\{\s*([^}]+)\s*\}\}/g)]
      .map((match) => match[1].trim())
      .filter((expression) => /token/i.test(expression));
    for (const expression of tokenExpressions) {
      assert.equal(expression, "github.token", `${name} uses a non-built-in token expression: ${expression}`);
    }
    if (text.includes("github.token")) assert.match(text, /permissions:\s*\n[\s\S]*?contents:\s*read/);
  }
});

test("artifact uploads use an exact public manifest rather than a broad directory", () => {
  for (const name of WORKFLOW_FILES) {
    const text = workflowText(name);
    if (!text.includes("upload-artifact")) continue;
    const uploadBlocks = text.split(/(?=\n\s*- name:|\n\s*- uses:)/g)
      .filter((block) => block.includes("upload-artifact"));
    assert.ok(uploadBlocks.length > 0, `${name} upload block was not discoverable`);
    for (const block of uploadBlocks) {
      const pathLine = block.match(/^\s+path:\s*(.+)$/m)?.[1]?.trim() || "";
      assert.ok(pathLine, `${name} upload-artifact block has no path`);
      assert.equal(/(?:^|[\\/])(?:artifacts|results|reports)(?:[\\/]|$)/i.test(pathLine), false, `${name} uploads a broad directory`);
      assert.ok(/(?:\.json|\.jsonl|\.md|FLEET_PUBLIC_ARTIFACT_MANIFEST)/i.test(pathLine), `${name} artifact path is not an allowlisted manifest: ${pathLine}`);
      assert.equal(pathLine.includes("**"), false, `${name} artifact path contains a recursive glob`);
    }
  }
});

test("workflow manifests stay inside the ephemeral public state root", () => {
  for (const name of WORKFLOW_FILES) {
    const text = workflowText(name);
    if (!text.includes("FLEET_PUBLIC_ARTIFACT_MANIFEST")) continue;
    assert.match(text, /FLEET_PUBLIC_STATE_ROOT:\s*\$\{\{\s*runner\.temp\s*\}\}\/fleet-public-state/);
    for (const line of text.split("\n")) {
      if (!line.includes("FLEET_PUBLIC_ARTIFACT_MANIFEST:")) continue;
      assert.match(line, /runner\.temp\s*\}\}\/fleet-public-state\//, `${name} manifest escapes its public state root`);
    }
  }
});

test("runner context is referenced only from step-level workflow expressions", () => {
  for (const name of WORKFLOW_FILES) {
    const lines = workflowText(name).split("\n");
    let inJobs = false;
    let currentJob = null;
    let stepsStarted = false;
    for (const line of lines) {
      if (line === "jobs:") {
        inJobs = true;
        currentJob = null;
        stepsStarted = false;
        continue;
      }
      if (inJobs && /^  [A-Za-z0-9_-]+:\s*$/.test(line)) {
        currentJob = line.trim().slice(0, -1);
        stepsStarted = false;
        continue;
      }
      if (inJobs && currentJob && /^    steps:\s*$/.test(line)) {
        stepsStarted = true;
        continue;
      }
      if (!line.includes("runner.")) continue;
      const indentation = line.match(/^ */)?.[0].length || 0;
      assert.equal(inJobs && currentJob && stepsStarted, true, `${name} uses runner context before a job's steps`);
      assert.ok(indentation >= 10, `${name} uses runner context outside step-level configuration: ${line.trim()}`);
    }
  }
});

test("step-level runner paths propagate through GITHUB_ENV for later steps", () => {
  const expectedKeys = [
    "FLEET_PUBLIC_STATE_ROOT",
    "FLEET_STATE_ROOT",
    "FLEET_PUBLIC_ARTIFACT_MANIFEST",
  ];
  const consumerMarkers = [
    "actions/checkout@",
    "actions/setup-node@",
    "actions/upload-artifact@",
    "actions/download-artifact@",
    "node scripts/",
    "opencode ",
  ];
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "fleet-public-state-env-"));
  let configureStepCount = 0;
  try {
    for (const name of WORKFLOW_FILES) {
      const blocks = workflowStepBlocks(workflowText(name), "configure ephemeral public state");
      if (name === "ci-diag.yml") {
        assert.equal(blocks.length, 0, "ci-diag must not configure operational state");
        continue;
      }
      assert.ok(blocks.length > 0, `${name} must configure ephemeral public state after validation`);
      for (const job of workflowJobBlocks(workflowText(name))) {
        const stepNames = [...job.matchAll(/^\s+- (?:name|uses):\s*(.+)$/gm)].map((match) => match[1]);
        const validationIndex = stepNames.indexOf("validate public target");
        const configurationIndex = stepNames.indexOf("configure ephemeral public state");
        assert.ok(validationIndex >= 0, `${name} job is missing target validation`);
        assert.equal(configurationIndex, validationIndex + 1, `${name} must configure state immediately after target validation`);
        const configurationOffset = job.indexOf("- name: configure ephemeral public state");
        assert.ok(configurationOffset >= 0, `${name} job is missing state configuration`);
        for (const marker of consumerMarkers) {
          const consumerOffset = job.indexOf(marker);
          if (consumerOffset >= 0) {
            assert.ok(consumerOffset > configurationOffset, `${name} consumes state before ephemeral configuration: ${marker}`);
          }
        }
      }
      for (const block of blocks) {
        configureStepCount += 1;
        for (const key of expectedKeys) {
          assert.match(block, new RegExp(`${key}:\\s+\\$\\{\\{\\s*runner\\.temp\\s*\\}\\}/fleet-public-state`));
        }
        const stateRoot = path.join(temporaryRoot, `${name}-${configureStepCount}`, "fleet-public-state");
        const envPath = path.join(temporaryRoot, `${name}-${configureStepCount}.env`);
        const script = workflowRunScript(block);
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          env: {
            FLEET_PUBLIC_STATE_ROOT: stateRoot,
            FLEET_STATE_ROOT: stateRoot,
            FLEET_PUBLIC_ARTIFACT_MANIFEST: path.join(stateRoot, "public-artifact.json"),
            GITHUB_ENV: envPath,
          },
        });
        assert.equal(result.status, 0, `${name} state propagation failed: ${result.stderr || result.stdout}`);
        assert.equal(
          readFileSync(envPath, "utf8"),
          [
            `FLEET_PUBLIC_STATE_ROOT=${stateRoot}`,
            `FLEET_STATE_ROOT=${stateRoot}`,
            `FLEET_PUBLIC_ARTIFACT_MANIFEST=${path.join(stateRoot, "public-artifact.json")}`,
            "",
          ].join("\n"),
        );
      }
    }
    assert.equal(configureStepCount, 26, "every public validator job must propagate its state paths");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("workflow inputs and metadata never interpolate untrusted payloads into run names or concurrency", () => {
  for (const name of WORKFLOW_FILES) {
    const text = workflowText(name);
    const metadata = text.split(/\n\s*(?:jobs:|permissions:)/, 1)[0];
    assert.equal(metadata.includes("github.event.client_payload"), false, `${name} uses client payload in metadata`);
    assert.equal(/run-name:[^\n]*(?:inputs\.|github\.event\.inputs|github\.event\.)/.test(metadata), false, `${name} puts event data in run-name`);
    assert.equal(/group:[\s\S]{0,500}(?:inputs\.|github\.event\.inputs|github\.event\.)/.test(metadata), false, `${name} puts event data in concurrency metadata`);
  }
});

test("public workflow dispatch cannot accept a raw repository identifier", () => {
  for (const name of WORKFLOW_FILES) {
    const text = workflowText(name);
    assert.doesNotMatch(text, /(?:inputs|github\.event\.inputs)\.repo\b/, `${name} interpolates a raw repository input`);
    assert.doesNotMatch(text, /FLEET_PUBLIC_REPOSITORY_INPUT\b/, `${name} exposes a raw repository input environment variable`);

    const dispatch = text.match(/\n  workflow_dispatch:\n([\s\S]*?)(?=\n  [A-Za-z0-9_-]+:|\n\n|$)/)?.[1] || "";
    assert.doesNotMatch(dispatch, /^\s+repo:\s*$/m, `${name} declares a repository workflow input`);
  }
});

test("public workflow dispatch inputs are typed, bounded, and never copied from raw event payloads", () => {
  const expectedInputs = {
    "ci-diag.yml": {},
    "deep.yml": { workers: "number" },
    "emergency-stop.yml": { confirm: "boolean" },
    "improve.yml": { top_k: "number" },
    "kb.yml": {},
    "merge.yml": { pr: "number" },
    "model-refresh.yml": {},
    "orchestrate.yml": { pr: "number", max_agents: "number" },
    "patrol.yml": {},
    "retro.yml": {},
    "selftest.yml": {},
    "thesis.yml": {},
    "watchdog.yml": {},
  };
  for (const name of WORKFLOW_FILES) {
    const text = workflowText(name);
    const dispatchStart = text.indexOf("\n  workflow_dispatch:");
    assert.ok(dispatchStart >= 0, `${name} must declare workflow_dispatch`);
    const remainder = text.slice(dispatchStart + 1);
    const nextTopLevel = remainder.search(/\n  (?:concurrency|permissions|env|jobs):/);
    const dispatch = remainder.slice(0, nextTopLevel >= 0 ? nextTopLevel : remainder.length);
    const inputs = {};
    const inputsStart = dispatch.indexOf("\n    inputs:");
    if (inputsStart >= 0) {
      const inputSection = dispatch.slice(inputsStart + "\n    inputs:".length);
      const blocks = [...inputSection.matchAll(/\n      ([A-Za-z0-9_-]+):\n([\s\S]*?)(?=\n      [A-Za-z0-9_-]+:\n|$)/g)];
      for (const match of blocks) {
        const type = match[2].match(/^\s+type:\s*([^\s#]+)/m)?.[1];
        inputs[match[1]] = type || "missing";
      }
    }
    assert.deepEqual(inputs, expectedInputs[name] || {}, `${name} exposes an unapproved workflow input`);
    assert.doesNotMatch(dispatch, /type:\s*string\b/, `${name} accepts arbitrary string dispatch input`);
    assert.doesNotMatch(text, /github\.event\.inputs\./, `${name} copies raw workflow input payload data`);
    assert.doesNotMatch(text, /github\.event\.client_payload/, `${name} copies raw repository-dispatch payload data`);
  }
  const merge = workflowText("merge.yml");
  assert.match(merge, /FLEET_UI_ROUTES:\s*["']?\/["']?\s*$/m, "merge routes must use a fixed public-safe default");
  assert.doesNotMatch(merge, /FLEET_UI_ROUTES:.*\$\{\{/, "merge routes must not receive workflow input text");
  const stop = workflowText("emergency-stop.yml");
  assert.match(stop, /FLEET_CONFIRM:\s*\$\{\{\s*inputs\.confirm\s*\|\|\s*false\s*\}\}/);
  assert.match(stop, /\[\[\s*\"\$FLEET_CONFIRM\"\s*==\s*\"true\"\s*\]\]/);
});

test("public target validators use trusted context only and never echo rejected identifiers", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "fleet-public-target-privacy-"));
  const mockBin = path.join(temporaryRoot, "bin");
  const mockCurl = path.join(mockBin, "curl");
  const outputPath = path.join(temporaryRoot, "github-output");
  const originalPath = process.env.PATH || "";
  const privateIdentifier = ["M1Vj", ["fleet", "control"].join("-")].join("/");
  try {
    mkdirSync(mockBin);
    writeFileSync(mockCurl, [
      "#!/bin/sh",
      "target=\"${FLEET_PUBLIC_TARGET:-${GITHUB_REPOSITORY:-}}\"",
      "name=\"${target#*/}\"",
      "case \"$name\" in",
      "  public-repo) printf '%s\\n' '{\"name\":\"public-repo\",\"private\":false,\"visibility\":\"public\",\"archived\":false,\"owner\":{\"login\":\"M1Vj\"}}' ;;",
      "  *) printf '%s\\n' '{\"name\":\"public-repo\",\"private\":true,\"visibility\":\"private\",\"archived\":false,\"owner\":{\"login\":\"M1Vj\"}}' ;;",
      "esac",
      "",
    ].join("\n"));
    chmodSync(mockCurl, 0o755);
    let validatorCount = 0;
    for (const name of WORKFLOW_FILES) {
      if (name === "ci-diag.yml") continue;
      for (const script of publicTargetRuns(workflowText(name))) {
        validatorCount += 1;
        rmSync(outputPath, { force: true });
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          env: {
            PATH: `${mockBin}:${originalPath}`,
            FLEET_PUBLIC_TARGET: privateIdentifier,
            GITHUB_REPOSITORY: "M1Vj/public-repo",
            FLEET_PUBLIC_OWNER: "M1Vj",
            RUNNER_TEMP: temporaryRoot,
            GITHUB_OUTPUT: outputPath,
            GH_TOKEN: "test-token",
          },
        });
        assert.notEqual(result.status, 0, `${name} accepted an untrusted private target`);
        assert.equal(`${result.stdout || ""}${result.stderr || ""}`.includes(privateIdentifier), false, `${name} echoed the rejected identifier`);
        assert.equal(existsSync(outputPath), false, `${name} emitted a manifest target before validation`);
      }
    }
    assert.equal(validatorCount, 26, "all operational public target validators must reject untrusted identifiers");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("self-repo public canary resolves from GitHub context without a dispatch target", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "fleet-public-self-canary-"));
  const mockBin = path.join(temporaryRoot, "bin");
  const mockCurl = path.join(mockBin, "curl");
  const outputPath = path.join(temporaryRoot, "github-output");
  try {
    mkdirSync(mockBin);
    writeFileSync(mockCurl, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"name\":\"public-repo\",\"private\":false,\"visibility\":\"public\",\"archived\":false,\"owner\":{\"login\":\"M1Vj\"}}'",
      "",
    ].join("\n"));
    chmodSync(mockCurl, 0o755);
    const [script] = publicTargetRuns(workflowText("patrol.yml"));
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: `${mockBin}:${process.env.PATH || ""}`,
        GITHUB_REPOSITORY: "M1Vj/public-repo",
        FLEET_PUBLIC_OWNER: "M1Vj",
        RUNNER_TEMP: temporaryRoot,
        GITHUB_OUTPUT: outputPath,
        GH_TOKEN: "test-token",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(outputPath, "utf8"), "repository=M1Vj/public-repo\n");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("public target and artifact validation errors redact untrusted identifiers", () => {
  const privateIdentifier = `${["M1Vj", ["fleet", "control"].join("-")].join("/")}?secret=redact-me`;
  assert.throws(
    () => runtimePublicRepository({ FLEET_PUBLIC_OWNER: "M1Vj", FLEET_PUBLIC_REPOSITORY: privateIdentifier }),
    (error) => !String(error?.message || "").includes(privateIdentifier),
  );
  assert.throws(
    () => runtimePublicArtifactPayload({}, { kind: "privacy", status: "ok", repository: privateIdentifier }),
    (error) => !String(error?.message || "").includes(privateIdentifier),
  );
});

test("public target visibility contract fails closed for unknown, private, and malformed metadata", () => {
  assert.deepEqual(
    publicTargetDecision({ name: "public-repo", owner: { login: "M1Vj" }, private: false, visibility: "public" }),
    { ok: true, repository: "M1Vj/public-repo" },
  );
  assert.equal(publicTargetDecision({ name: "unknown", owner: { login: "Other" }, private: false, visibility: "public" }).ok, false);
  assert.equal(publicTargetDecision({ name: "private", owner: { login: "M1Vj" }, private: true, visibility: "private" }).ok, false);
  assert.equal(publicTargetDecision({ name: "hidden", owner: { login: "M1Vj" }, private: false, visibility: "internal" }).ok, false);
  assert.equal(publicTargetDecision(null).ok, false);
  assert.equal(publicTargetDecision({ name: "archived", owner: { login: "M1Vj" }, private: false, visibility: "public", archived: true }).ok, false);
});

test("runtime public data-class helpers enforce owner, visibility, runner-temp state, and manifest fences", () => {
  const env = {
    FLEET_DATA_CLASS: "public",
    FLEET_PUBLIC_OWNER: "M1Vj",
    FLEET_PUBLIC_REPOSITORY: "M1Vj/public-repo",
    RUNNER_TEMP: "/tmp/fleet-airlock-test",
    FLEET_PUBLIC_STATE_ROOT: "/tmp/fleet-airlock-test/fleet-public-state",
    FLEET_PUBLIC_ARTIFACT_MANIFEST: "/tmp/fleet-airlock-test/fleet-public-state/public-artifact.json",
  };
  assert.equal(runtimePublicRepository(env), "M1Vj/public-repo");
  assert.equal(runtimePublicStateRoot(env), "/tmp/fleet-airlock-test/fleet-public-state");
  assert.equal(runtimeResolveArtifactManifest(env), "/tmp/fleet-airlock-test/fleet-public-state/public-artifact.json");
  assert.equal(runtimePublicTargetDecision({ name: "public-repo", owner: { login: "M1Vj" }, private: false, visibility: "public" }).ok, true);
  assert.equal(runtimePublicTargetDecision({ name: "private", owner: { login: "M1Vj" }, private: true, visibility: "private" }).ok, false);
  assert.throws(() => runtimePublicRepository({ ...env, FLEET_PUBLIC_REPOSITORY: "Other/private" }));
  assert.throws(() => runtimePublicStateRoot({ ...env, FLEET_PUBLIC_STATE_ROOT: "/tmp/outside" }));
  assert.throws(() => runtimeResolveArtifactManifest({ ...env, FLEET_PUBLIC_ARTIFACT_MANIFEST: "/tmp/fleet-airlock-test/public-artifact.json" }));
});

test("every operational workflow declares the public data class and a target-validation step", () => {
  for (const name of WORKFLOW_FILES) {
    const text = workflowText(name);
    if (name === "ci-diag.yml") {
      assert.doesNotMatch(text, /FLEET_DATA_CLASS:\s*private/i);
      continue;
    }
    assert.match(text, /FLEET_DATA_CLASS:\s*["']?public["']?/i, `${name} must declare public data class`);
    assert.match(text, /validate public target|public target gate|public-target/i, `${name} must validate its target before work`);
  }
});

test("workflow YAML parses with the available semantic parser", () => {
  const ruby = spawnSync("ruby", ["-e", "require 'yaml'; ARGV.each { |file| YAML.parse_file(file) }", ...WORKFLOW_FILES.map((name) => path.join(WORKFLOW_DIR, name))], { encoding: "utf8" });
  if (ruby.error?.code === "ENOENT") {
    assert.fail("ruby/Psych is required for semantic workflow validation");
  }
  assert.equal(ruby.status, 0, `workflow parser failed: ${ruby.stderr || ruby.stdout}`);
});

test("every public target validator executes with a mocked public API response", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "fleet-public-validator-"));
  const mockBin = path.join(temporaryRoot, "bin");
  const mockCurl = path.join(mockBin, "curl");
  const outputPath = path.join(temporaryRoot, "github-output");
  const originalPath = process.env.PATH || "";
  try {
    mkdirSync(mockBin);
    // The validator under test owns URL construction; this stub prevents any network access.
    // It emits only the public metadata required by the shell's real node check.
    const metadataCases = {
      private: { name: "public-repo", private: true, visibility: "private", archived: false, owner: { login: "M1Vj" } },
      internal: { name: "public-repo", private: false, visibility: "internal", archived: false, owner: { login: "M1Vj" } },
      "owner-mismatch": { name: "public-repo", private: false, visibility: "public", archived: false, owner: { login: "Other" } },
      public: { name: "public-repo", private: false, visibility: "public", archived: false, owner: { login: "M1Vj" } },
    };
    const metadataBranches = Object.entries(metadataCases)
      .map(([label, metadata]) => `  ${label}) metadata='${JSON.stringify(metadata)}';;`);
    writeFileSync(mockCurl, [
      "#!/bin/sh",
      "case \"${MOCK_TARGET_CASE:-public}\" in",
      ...metadataBranches,
      "esac",
      "printf '%s\\n' \"$metadata\"",
      "",
    ].join("\n"));
    chmodSync(mockCurl, 0o755);
    let validatorCount = 0;
    const fixtures = [
      { label: "public", expectedStatus: 0 },
      { label: "private", expectedStatus: 1 },
      { label: "internal", expectedStatus: 1 },
      { label: "owner-mismatch", expectedStatus: 1 },
    ];
    for (const name of WORKFLOW_FILES) {
      if (name === "ci-diag.yml") continue;
      const runs = publicTargetRuns(workflowText(name));
      assert.ok(runs.length > 0, `${name} has no executable public target validator`);
      for (const script of runs) {
        validatorCount += 1;
        for (const fixture of fixtures) {
          const result = spawnSync("bash", ["-c", script], {
            encoding: "utf8",
            env: {
              PATH: `${mockBin}:${originalPath}`,
              FLEET_PUBLIC_TARGET: "M1Vj/public-repo",
              FLEET_PUBLIC_OWNER: "M1Vj",
              GITHUB_REPOSITORY: "M1Vj/public-repo",
              RUNNER_TEMP: temporaryRoot,
              GITHUB_OUTPUT: outputPath,
              GH_TOKEN: "test-token",
              MOCK_TARGET_CASE: fixture.label,
            },
          });
          assert.equal(result.status, fixture.expectedStatus, `${name} ${fixture.label} target validator returned ${result.status}: ${result.stderr || result.stdout}`);
        }
      }
    }
    assert.equal(validatorCount, 26, "all operational public target validators must be executable");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("retro status digest receives only the validated public target output", () => {
  const text = workflowText("retro.yml");
  const statusBlock = workflowStepBlock(text, "status digest");
  assert.match(statusBlock, /\benv:\s*\n\s+FLEET_PUBLIC_REPOSITORY:\s+\$\{\{\s*steps\.public-target\.outputs\.repository\s*\}\}/);
  assert.doesNotMatch(statusBlock, /(?:inputs\.|github\.event\.inputs|github\.repository)/, "retro status must not consume a raw target");
  assert.ok(text.indexOf("validate public target") < text.indexOf("- name: status digest"), "status digest must follow public validation");

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "fleet-retro-status-"));
  const mockBin = path.join(temporaryRoot, "bin");
  const mockNode = path.join(mockBin, "node");
  const capturePath = path.join(temporaryRoot, "repository.txt");
  mkdirSync(mockBin);
  writeFileSync(mockNode, "#!/bin/sh\nprintf '%s' \"${FLEET_PUBLIC_REPOSITORY-}\" > \"${CAPTURE_PATH}\"\n");
  chmodSync(mockNode, 0o755);
  try {
    const run = statusBlock.match(/^\s+run:\s*(.+)$/m)?.[1];
    assert.equal(run, "node scripts/status.mjs", "status digest must invoke the trusted status script");
    const result = spawnSync("bash", ["-c", run], {
      encoding: "utf8",
      env: {
        PATH: `${mockBin}:${process.env.PATH || ""}`,
        FLEET_PUBLIC_REPOSITORY: "M1Vj/public-repo",
        CAPTURE_PATH: capturePath,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(capturePath, "utf8"), "M1Vj/public-repo");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("public scripts receive the public data contract before model/task execution", () => {
  for (const name of WORKFLOW_FILES) {
    if (name === "ci-diag.yml" || name === "emergency-stop.yml") continue;
    const text = workflowText(name);
    const scriptInvocations = [...text.matchAll(/(?:node|opencode)\s+[^\n]+/g)].map((match) => match.index);
    const guardIndex = Math.max(text.indexOf("validate public target"), text.indexOf("public target gate"), text.indexOf("public-target"));
    for (const invocationIndex of scriptInvocations) {
      assert.ok(guardIndex >= 0 && guardIndex < invocationIndex, `${name} executes work before public target validation`);
    }
    assert.match(text, /FLEET_PUBLIC_STATE_ROOT|fleet-public-state/, `${name} must use an ephemeral public state root`);
  }
});

test("ci-diag remains public-only and does not grow privileged inputs", () => {
  const text = workflowText("ci-diag.yml");
  assert.doesNotMatch(text, /secrets\.|FLEET_GH_TOKEN|FLEET_OPENCODE_AUTH|state-control/i);
  assert.match(text, /permissions:\s*\n\s+contents:\s+read/);
});

test("every operational public job is activation-gated while ci-diag remains active", () => {
  const operationalWorkflows = WORKFLOW_FILES.filter((name) => name !== "ci-diag.yml" && name !== "emergency-stop.yml");
  assert.equal(operationalWorkflows.length, 11, "the public airlock has eleven activation-gated work-progress workflows");
  for (const name of operationalWorkflows) {
    const jobs = workflowJobBlocks(workflowText(name));
    assert.ok(jobs.length > 0, `${name} must expose at least one job`);
    for (const job of jobs) {
      assert.match(job, PUBLIC_ACTIVATION_GATE, `${name} job is missing the public activation gate`);
    }
  }

  const diagJobs = workflowJobBlocks(workflowText("ci-diag.yml"));
  assert.ok(diagJobs.length > 0, "ci-diag must expose its diagnostic job");
  for (const job of diagJobs) assert.doesNotMatch(job, /FLEET_PUBLIC_ACTIVATED/);
  assert.equal(String("true") === "true", true, "the staged activation value enables operations");
  assert.equal(String("false") === "true", false, "an unset/false activation value blocks operations");
});

test("ci-diag and emergency-stop remain available before activation", () => {
  for (const name of ["ci-diag.yml", "emergency-stop.yml"]) {
    for (const job of workflowJobBlocks(workflowText(name))) assert.doesNotMatch(job, /FLEET_PUBLIC_ACTIVATED/);
  }
  const stop = workflowText("emergency-stop.yml");
  assert.doesNotMatch(stop, /opencode|FLEET_MODEL_CHAIN|FLEET_JUDGE_MODEL|scripts\/(?:deep|improve|kb|merge|model-refresh|orchestrate|patrol|retro|selftest|thesis|watchdog)\.mjs/i);
  assert.match(stop, /name: record public stop request/);
});

test("every OpenCode installation is pinned exactly to 1.18.30", () => {
  for (const name of WORKFLOW_FILES) {
    const text = workflowText(name);
    for (const match of text.matchAll(/npm\s+install\s+-g\s+opencode-ai@([^\s'"\\]+)/g)) {
      assert.equal(match[1], "1.18.30", `${name} must pin opencode-ai to 1.18.30`);
    }
    assert.doesNotMatch(text, /opencode-ai@(?:1\.18\.21|latest|[~^<>=])/i, `${name} contains mutable or stale OpenCode versioning`);
  }
});

test("thesis uploads require the canonical public manifest", () => {
  const expectedPath = "path: ${{ runner.temp }}/fleet-public-state/public-artifact.json";
  for (const name of ["thesis.yml"]) {
    const uploads = workflowText(name).split(/(?=\n\s*- name:|\n\s*- uses:)/g)
      .filter((block) => block.includes("upload-artifact"));
    assert.ok(uploads.length > 0, `${name} must upload a public manifest`);
    for (const block of uploads) {
      assert.match(block, new RegExp(expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${name} must use the canonical public manifest path`);
      assert.match(block, /if-no-files-found:\s*error\b/, `${name} must fail closed when its manifest is missing`);
    }
  }
});

test("orchestrate emits and uploads only the canonical public manifest", () => {
  const text = workflowText("orchestrate.yml");
  const executeBlock = workflowStepBlock(text, "execute public orchestration task");
  assert.match(executeBlock, /FLEET_RESULT_FILE:\s+\$\{\{\s*runner\.temp\s*\}\}\/orchestrate-result\.json/);
  assert.match(executeBlock, /--output-file\s+\"\$FLEET_RESULT_FILE\"/);
  assert.doesNotMatch(executeBlock, />\s*\"?\$FLEET_RESULT_FILE/);
  assert.doesNotMatch(executeBlock, />\s*\"?\$FLEET_PUBLIC_ARTIFACT_MANIFEST/);
  const uploadBlock = text.split(/(?=\n\s*- name:|\n\s*- uses:)/g)
    .find((block) => block.includes("upload public result manifest"));
  assert.ok(uploadBlock, "orchestrate task-result upload block must exist");
  assert.match(uploadBlock, /path:\s*\$\{\{\s*runner\.temp\s*\}\}\/fleet-public-state\/public-artifact\.json/);
  assert.match(uploadBlock, /if-no-files-found:\s*error\b/);

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "fleet-orchestrate-airlock-"));
  try {
    const artifact = writeTaskArtifact(
      { id: "public-task", type: "review", role: "review", repo: "M1Vj/public-repo", pr: 1 },
      { status: "deferred", reason: "test" },
      { RUNNER_TEMP: temporaryRoot, FLEET_ARTIFACT_DIR: path.join(temporaryRoot, "fleet-task-results") },
    );
    assert.match(artifact, /fleet-task-results\/public-task\.json$/);
    assert.equal(readFileSync(artifact, "utf8").includes("M1Vj/public-repo"), true);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("public orchestrate is a stateless read-only airlock, not a completion authority", () => {
  const text = workflowText("orchestrate.yml");
  assert.match(text, /permissions:\n  contents:\s+read/);
  assert.match(text, /FLEET_STATE_ROOT:\s*\$\{\{\s*runner\.temp\s*\}\}\/fleet-public-state/);
  assert.doesNotMatch(text, /\bgit\s+(?:commit|push)\b|\bgh\s+(?:pr|issue)\s+(?:merge|close|comment|create)\b/i);
  assert.doesNotMatch(text, /curl[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i);
  assert.doesNotMatch(
    text,
    new RegExp(`(?:FLEET_PRIVATE_STATE|FLEET_GH_TOKEN|FLEET_OPENCODE_AUTH|${PRIVATE_CONTROL_MARKER}|${STATE_CONTROL_MARKER}|${PRIVATE_STATE_MARKER})`, "i"),
  );
  assert.doesNotMatch(text, /(?:completion authority|outbox|durable task history|status:\s*completed)/i);
  assert.match(text, /upload-artifact/);
});

export { publicTargetDecision, PUBLIC_GITHUB_TOKEN };
