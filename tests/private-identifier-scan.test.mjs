import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("tracked public source/docs/tests/workflows contain no private repository identities", () => {
  const forbidden = [
    new RegExp(["M1Vj", ["fleet", "control"].join("-")].join("/"), "i"),
    new RegExp(["M1Vj", ["vj-knowledge", "base"].join("-")].join("/"), "i"),
    new RegExp(["M1Vj", "THESIS"].join("/"), "i"),
    new RegExp(["fleet", "control"].join("-"), "i"),
  ];
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((file) => !/^(?:audit|state)\//.test(file));
  const violations = [];
  for (const file of tracked) {
    const body = readFileSync(path.join(ROOT, file), "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(body)) violations.push(`${file}: ${pattern.source}`);
    }
  }
  assert.deepEqual(violations, [], `private repository identity leaked into tracked public files: ${violations.join(", ")}`);
});
