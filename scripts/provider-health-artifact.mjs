#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { exportProviderHealthArtifact, importProviderHealthArtifacts } from "./lib/provider-health-state.mjs";

function safeId(value) {
  return String(value || "provider-health").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100) || "provider-health";
}

export function runProviderHealthArtifact({ mode, stateRoot, artifactDir, artifactId = "provider-health", now = Date.now() } = {}) {
  const root = path.resolve(String(stateRoot || ""));
  const directory = path.resolve(String(artifactDir || ""));
  if (!path.isAbsolute(String(stateRoot || "")) || root !== String(stateRoot) || !path.isAbsolute(String(artifactDir || "")) || directory !== String(artifactDir)) {
    throw new Error("PROVIDER_HEALTH_ARTIFACT_PATH_INVALID");
  }
  if (mode === "export") {
    const output = path.join(directory, `provider-health-${safeId(artifactId)}.json`);
    return { mode, count: exportProviderHealthArtifact(root, output, { now }) ? 1 : 0 };
  }
  if (mode === "import") {
    const files = existsSync(directory)
      ? readdirSync(directory).filter((name) => /^provider-health-[A-Za-z0-9._-]+\.json$/.test(name)).sort().map((name) => path.join(directory, name))
      : [];
    importProviderHealthArtifacts(root, files, { now });
    return { mode, count: files.length };
  }
  throw new Error("PROVIDER_HEALTH_ARTIFACT_MODE_INVALID");
}

async function main() {
  const result = runProviderHealthArtifact({
    mode: process.argv[2],
    stateRoot: process.env.FLEET_STATE_ROOT,
    artifactDir: process.env.FLEET_PROVIDER_HEALTH_ARTIFACT_DIR,
    artifactId: process.env.FLEET_PROVIDER_HEALTH_ARTIFACT_ID,
  });
  console.log(`PROVIDER_HEALTH_ARTIFACT=${result.mode}:${result.count}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`PROVIDER_HEALTH_ARTIFACT_FAILED=${String(error?.message || "FAILED").replace(/[^A-Z0-9_-]/gi, "_").slice(0, 100)}`);
    process.exitCode = 1;
  });
}
