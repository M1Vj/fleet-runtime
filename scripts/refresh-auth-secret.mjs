#!/usr/bin/env node
import process from "node:process";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const usage = "usage: node scripts/refresh-auth-secret.mjs [--token] <file>\n  default file is auth.json -> secret FLEET_OPENCODE_AUTH\n  --token file -> secret FLEET_GH_TOKEN";

const REPOS = ["M1Vj/fleet-runtime", "M1Vj/fleet-control"];
function setSecret(name, value) {
  for (const repo of REPOS) {
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
