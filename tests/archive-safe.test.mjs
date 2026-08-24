import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { safeExtractArchive, validateArchiveMembers } from "../scripts/lib/archive-safe.mjs";

test("archive member validation rejects absolute, traversal, and link entries", () => {
  assert.equal(validateArchiveMembers(["src/app.js", "src/"]).ok, true);
  for (const members of [
    ["/etc/passwd"],
    ["../escape"],
    ["src/../../escape"],
    ["src\\..\\escape"],
    [{ name: "src/link", type: "symlink" }],
    [{ name: "src/hardlink", type: "hardlink" }],
  ]) {
    assert.equal(validateArchiveMembers(members).ok, false, JSON.stringify(members));
  }
});

test("archive validation bounds member count and path length", () => {
  assert.equal(validateArchiveMembers(Array.from({ length: 10001 }, (_, index) => `f/${index}`)).ok, false);
  assert.equal(validateArchiveMembers([`f/${"x".repeat(500)}`]).ok, false);
  const root = mkdtempSync(path.join(tmpdir(), "archive-safe-test-"));
  rmSync(root, { recursive: true, force: true });
});

test("safe extraction rejects symlink members and preserves a fresh target boundary", () => {
  const root = mkdtempSync(path.join(tmpdir(), "archive-safe-extract-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "source.tgz");
  const target = path.join(root, "target");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "ok.txt"), "ok\n", "utf8");
  symlinkSync("/tmp/private-state", path.join(source, "link"));
  const packed = spawnSync("tar", ["-czf", archive, "-C", source, "."], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  assert.throws(() => safeExtractArchive(archive, target), /ARCHIVE_REJECTED/);
  assert.equal(existsSync(target), false);
  rmSync(root, { recursive: true, force: true });
});

test("safe extraction accepts regular members only into a new exact target", () => {
  const root = mkdtempSync(path.join(tmpdir(), "archive-safe-regular-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "source.tgz");
  const target = path.join(root, "target");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "ok.txt"), "ok\n", "utf8");
  const packed = spawnSync("tar", ["-czf", archive, "-C", source, "."], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  assert.equal(safeExtractArchive(archive, target), target);
  assert.equal(readFileSync(path.join(target, "ok.txt"), "utf8"), "ok\n");
  rmSync(root, { recursive: true, force: true });
});
