import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

import * as modelRefresh from "../scripts/model-refresh.mjs";
import * as patrol from "../scripts/patrol.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");

function workflowText(name) {
  return readFileSync(path.join(WORKFLOW_DIR, name), "utf8");
}

function stepScript(name, stepName) {
  const text = workflowText(name);
  const marker = `- name: ${stepName}`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `${name} is missing ${stepName}`);
  const remainder = text.slice(start);
  const next = remainder.search(/\n\s+- (?:name|uses):/);
  const block = next === -1 ? remainder : remainder.slice(0, next);
  const match = block.match(/^\s+run:\s*\|\s*\n([\s\S]*)$/m);
  assert.ok(match, `${name} ${stepName} must contain a run block`);
  return match[1]
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

test("model refresh categorizes catalog origin without persisting file URLs or paths", async () => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "model-refresh-origin-"));
  try {
    const sourcePath = path.join(stateRoot, "private", "catalog.json");
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, JSON.stringify({
      models: {
        "muse-spark-1.3-contributor-free": { free: true },
        "nemotron-3-ultra-free": { free: true },
      },
    }));
    const env = {
      FLEET_STATE_ROOT: stateRoot,
      ZEN_MODELS_URL: `file://${sourcePath}`,
    };
    assert.equal(await modelRefresh.main(env), 0);
    const data = JSON.parse(readFileSync(path.join(stateRoot, "state", "model-chain.json"), "utf8"));
    assert.equal(data.source, "unknown");
    assert.equal(/(?:https?:|file:|[\\/](?:Users|private|tmp)[\\/])/.test(String(data.source)), false);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("public catalog origin accepts only the exact public HTTPS allowlist", () => {
  assert.equal(modelRefresh.publicCatalogOrigin({ ZEN_MODELS_URL: "https://opencode.ai/zen/v1/models" }), "zen-public");
  assert.equal(modelRefresh.publicCatalogOrigin({ ZEN_MODELS_URL: "https://opencode.ai/zen/v1/models?private=1" }), "unknown");
  assert.equal(modelRefresh.publicCatalogOrigin({ ZEN_MODELS_URL: "https://private.example/catalog.json" }), "unknown");
  assert.equal(modelRefresh.publicCatalogOrigin({ ZEN_MODELS_URL: "file:///Users/vj/private/catalog.json" }), "unknown");
});

test("model refresh materialization uses the canonical public sanitizer and drops private source data", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "model-refresh-public-artifact-"));
  const stateRoot = path.join(temporaryRoot, "fleet-public-state");
  const manifest = path.join(stateRoot, "public-artifact.json");
  const sourcePath = path.join(stateRoot, "state", "model-chain.json");
  const privateSentinel = "/Users/vjmabansag/private/session-prompt-public";
  try {
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, JSON.stringify({
      chain: ["opencode/muse-spark-1.3-contributor-free"],
      updatedAt: "2026-09-14T00:00:00.000Z",
      source: `file://${privateSentinel}`,
      privatePath: privateSentinel,
    }));
    const script = stepScript("model-refresh.yml", "materialize public model manifest");
    const result = spawnSync("bash", ["-c", script], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        FLEET_PUBLIC_STATE_ROOT: stateRoot,
        FLEET_STATE_ROOT: stateRoot,
        FLEET_PUBLIC_ARTIFACT_MANIFEST: manifest,
        FLEET_PUBLIC_REPOSITORY: "M1Vj/public-repo",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(manifest), true);
    const data = JSON.parse(readFileSync(manifest, "utf8"));
    assert.equal(data.schema, "fleet-public-artifact-v1");
    assert.equal(data.dataClass, "public");
    assert.equal(data.count, 1);
    assert.equal(data.modelMode, "unknown");
    assert.equal(data.checks.model, "chain-valid");
    assert.equal(data.chain, undefined);
    assert.equal(data.source, undefined);
    assert.equal(JSON.stringify(data).includes(privateSentinel), false);
    assert.equal(JSON.stringify(data).includes("file:"), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("ci diagnostics emit only a bounded categorical probe result", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "ci-diag-privacy-"));
  const mockBin = path.join(temporaryRoot, "bin");
  const mockOpencode = path.join(mockBin, "opencode");
  const mockTimeout = path.join(mockBin, "timeout");
  const sentinel = "/Users/vjmabansag/private/session-prompt.log";
  try {
    mkdirSync(mockBin);
    writeFileSync(mockOpencode, [
      "#!/bin/sh",
      `printf '%s\\n' '${sentinel}'`,
      `printf '%s\\n' 'prompt=private-session error=private-error' >&2`,
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(mockOpencode, 0o755);
    writeFileSync(mockTimeout, [
      "#!/bin/sh",
      "shift",
      "exec \"$@\"",
      "",
    ].join("\n"));
    chmodSync(mockTimeout, 0o755);
    const script = stepScript("ci-diag.yml", "anonymous model probe");
    const result = spawnSync("/bin/bash", ["-c", script], {
      encoding: "utf8",
      env: { BASH_ENV: "/dev/null", HOME: temporaryRoot, PATH: `${mockBin}:/usr/bin:/bin`, FLEET_MODEL_PRIMARY: "public-model" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(`${result.stdout || ""}${result.stderr || ""}`.includes(sentinel), false);
    assert.equal(`${result.stdout || ""}${result.stderr || ""}`.includes("private-session"), false);
    assert.equal(`${result.stdout || ""}${result.stderr || ""}`.includes("private-error"), false);
    assert.match(result.stdout, /probe=ok/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("public patrol reporting bounds absent scopes without weakening the read-only fence", () => {
  assert.deepEqual(patrol.boundedPatrolScopes({}), []);
  assert.deepEqual(patrol.boundedPatrolScopes({ scopes: ["repo"] }), ["repo"]);
});

test("public patrol initial target read errors are generic and bounded", async () => {
  const sentinel = "/Users/vjmabansag/private/session-prompt-metadata-error";
  const env = {
    FLEET_DATA_CLASS: "public",
    FLEET_PUBLIC_OWNER: "M1Vj",
    FLEET_PUBLIC_REPOSITORY: "M1Vj/public-repo",
  };
  const signals = await patrol.collectSignals(env, { note() {} }, {
    gh: () => {
      throw new Error(`provider rejected target at ${sentinel}`);
    },
  });
  assert.deepEqual(signals, [{
    repo: "M1Vj/public-repo",
    error: "public target metadata read failed",
    openPulls: [],
    activeIssues: [],
    failingRuns24h: [],
  }]);
  assert.equal(JSON.stringify(signals).includes(sentinel), false);
});

test("public patrol failure formatting never exposes provider details", () => {
  const sentinel = "/Users/vjmabansag/private/session-prompt-main-error";
  assert.equal(
    patrol.patrolFailureReason(new Error(`provider rejected target at ${sentinel}`), {
      FLEET_DATA_CLASS: "public",
    }),
    "public patrol failed",
  );
  assert.equal(
    patrol.patrolFailureReason(new Error(sentinel), { FLEET_DATA_CLASS: "private" }),
    sentinel,
  );
});

test("public patrol main handles initial target read failures without leaking details", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "patrol-public-metadata-error-"));
  const mockBin = path.join(temporaryRoot, "bin");
  const mockGh = path.join(mockBin, "gh");
  const stateRoot = path.join(temporaryRoot, "state");
  const manifest = path.join(stateRoot, "public-artifact.json");
  const sentinel = "/Users/vjmabansag/private/session-prompt-main-error";
  try {
    mkdirSync(mockBin, { recursive: true });
    writeFileSync(mockGh, [
      "#!/bin/sh",
      `printf '%s\\n' 'provider rejected target at ${sentinel}' >&2`,
      "exit 1",
      "",
    ].join("\n"));
    chmodSync(mockGh, 0o755);
    const child = [
      `import * as patrol from ${JSON.stringify(path.join(ROOT, "scripts", "patrol.mjs"))};`,
      "globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return { name: 'public-repo', private: false, visibility: 'public', archived: false, owner: { login: 'M1Vj', id: 1 }, id: 1 }; } });",
      "const code = await patrol.main();",
      "process.exit(code);",
      "",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        FLEET_DATA_CLASS: "public",
        FLEET_PUBLIC_OWNER: "M1Vj",
        FLEET_PUBLIC_REPOSITORY: "M1Vj/public-repo",
        RUNNER_TEMP: temporaryRoot,
        FLEET_PUBLIC_STATE_ROOT: stateRoot,
        FLEET_PUBLIC_ARTIFACT_MANIFEST: manifest,
        PATH: `${mockBin}:/usr/bin:/bin`,
        GITHUB_TOKEN: "",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(output.includes("PATROL_FAILED"), false);
    assert.equal(output.includes(sentinel), false);
    assert.match(output, /FLEET_RUN_RESULT=/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("public patrol binds downstream reads to the validated repository, ignoring hostile full_name metadata", async () => {
  const calls = [];
  const metadata = {
    name: "public-repo",
    full_name: "M1Vj/private-target",
    private: false,
    visibility: "public",
    archived: false,
    owner: { login: "M1Vj" },
    pushed_at: "2026-09-14T00:00:00.000Z",
  };
  const env = {
    FLEET_DATA_CLASS: "public",
    FLEET_PUBLIC_OWNER: "M1Vj",
    FLEET_PUBLIC_REPOSITORY: "M1Vj/public-repo",
  };
  const signals = await patrol.collectSignals(env, { note() {} }, {
    gh: (args) => {
      calls.push(args);
      if (args[1] === "/repos/M1Vj/public-repo") return metadata;
      if (args[1].includes("/pulls?")) return [];
      if (args[1].includes("/issues?")) return [];
      if (args[1].includes("/actions/runs?")) return { workflow_runs: [] };
      throw new Error("unexpected public endpoint");
    },
  });
  assert.equal(signals[0].repo, "M1Vj/public-repo");
  assert.equal(argsToPath(calls[0]), "/repos/M1Vj/public-repo");
  assert.equal(argsToPath(calls[1]), "/repos/M1Vj/public-repo/pulls?state=open&per_page=20");
  assert.match(argsToPath(calls[2]), /^\/repos\/M1Vj\/public-repo\/issues\?state=open&since=/);
  assert.equal(argsToPath(calls[3]), "/repos/M1Vj/public-repo/actions/runs?status=failure&per_page=15");
  assert.equal(JSON.stringify(signals).includes("private-target"), false);
});

test("public patrol rejects private or foreign target metadata before downstream reads", async () => {
  const calls = [];
  const metadata = {
    name: "public-repo",
    full_name: "Other/private-target",
    private: true,
    visibility: "private",
    archived: false,
    owner: { login: "Other" },
  };
  const env = {
    FLEET_DATA_CLASS: "public",
    FLEET_PUBLIC_OWNER: "M1Vj",
    FLEET_PUBLIC_REPOSITORY: "M1Vj/public-repo",
  };
  const signals = await patrol.collectSignals(env, { note() {} }, {
    gh: (args) => {
      calls.push(args);
      return metadata;
    },
  });
  assert.deepEqual(calls.map((args) => args[1]), ["/repos/M1Vj/public-repo"]);
  assert.deepEqual(signals, [{
    repo: "M1Vj/public-repo",
    error: "PUBLIC_TARGET_NOT_PUBLIC",
    openPulls: [],
    activeIssues: [],
    failingRuns24h: [],
  }]);
  assert.equal(JSON.stringify(signals).includes("private-target"), false);
});

test("public patrol redacts downstream read errors", async () => {
  const sentinel = "/Users/vjmabansag/private/session-prompt.log";
  const env = {
    FLEET_DATA_CLASS: "public",
    FLEET_PUBLIC_OWNER: "M1Vj",
    FLEET_PUBLIC_REPOSITORY: "M1Vj/public-repo",
  };
  const signals = await patrol.collectSignals(env, { note() {} }, {
    gh: (args) => {
      if (args[1] === "/repos/M1Vj/public-repo") {
        return {
          name: "public-repo",
          full_name: "M1Vj/public-repo",
          private: false,
          visibility: "public",
          archived: false,
          owner: { login: "M1Vj" },
        };
      }
      throw new Error(`provider failed at ${sentinel}`);
    },
  });
  assert.equal(signals[0].error, "public signal read failed");
  assert.equal(JSON.stringify(signals).includes(sentinel), false);
});

function argsToPath(args) {
  return Array.isArray(args) ? String(args[1] || "") : "";
}
