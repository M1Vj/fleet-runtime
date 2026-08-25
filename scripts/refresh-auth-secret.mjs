#!/usr/bin/env node
// Migration-only utility: refreshes the legacy OAuth snapshot secret
// (FLEET_OPENCODE_AUTH) or FLEET_GH_TOKEN. Production model auth uses the
// durable OPENCODE_API_KEY GitHub Environment secret instead.
import process from "node:process";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const usage = "usage: node scripts/refresh-auth-secret.mjs [--token] <file>\n  default file is auth.json -> secret FLEET_OPENCODE_AUTH\n  --token file -> secret FLEET_GH_TOKEN";

const REPOS = ["M1Vj/fleet-runtime", "M1Vj/fleet-control"];
const GH_BIN = process.env.FLEET_GH_BIN || "gh";
function setSecret(name, value) {
  for (const repo of REPOS) {
    const res = spawnSync(GH_BIN, ["secret", "set", name, "-R", repo], {
      input: value,
      encoding: "utf8",
      stdio: ["pipe", "inherit", "inherit"],
    });
    if (res.status !== 0) process.exit(res.status || 1);
    process.stdout.write(`secret ${name} updated on ${repo}\n`);
  }
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
