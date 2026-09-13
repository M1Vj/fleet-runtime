#!/usr/bin/env node
import process from "node:process";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { privateRepository, PRIVATE_REPOSITORY_ENV } from "./lib/private-state.mjs";

if (process.env.FLEET_DATA_CLASS === "public") {
  process.stderr.write("REFRESH_AUTH_SECRET_BLOCKED=public-data-class\n");
  process.exit(4);
}

const usage = "usage: node scripts/refresh-auth-secret.mjs [--token] <file>\n  default file is auth.json -> secret FLEET_OPENCODE_AUTH\n  --token file -> secret FLEET_GH_TOKEN";

function repositoryTargets() {
  return ["M1Vj/fleet-runtime", privateRepository(process.env, PRIVATE_REPOSITORY_ENV.control)];
}
function setSecret(name, value) {
  for (const repo of repositoryTargets()) {
    const res = spawnSync("gh", ["secret", "set", name, "-R", repo], {
      input: value,
      encoding: "utf8",
      stdio: ["pipe", "inherit", "inherit"],
    });
    if (res.status !== 0) process.exit(res.status || 1);
    process.stdout.write(`secret ${name} updated on ${repo}\n`);
  }
}
function setSecretLegacy(name, value) {
  const res = spawnSync("gh", ["secret", "set", name, "-R", repo], {
    input: value,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (res.status !== 0) process.exit(res.status || 1);
  process.stdout.write(`secret ${name} updated (value never displayed)\n`);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stdout.write(usage + "\n");
  process.exit(1);
}
const tokenMode = args[0] === "--token";
const filePath = tokenMode ? args[1] : args[0];
if (!filePath) {
  process.stdout.write(usage + "\n");
  process.exit(1);
}
const content = readFileSync(filePath, "utf8");
setSecret(tokenMode ? "FLEET_GH_TOKEN" : "FLEET_OPENCODE_AUTH", content);
