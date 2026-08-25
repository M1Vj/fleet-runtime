import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseArchiveListing, safeExtractArchive, validateArchiveMembers } from "../scripts/lib/archive-safe.mjs";

test("GNU-format tar listings expose escape members to validation and pass normal ones", () => {
  const gnuListing = [
    "drwxr-xr-x root/root         0 2026-05-01 10:00 src/",
    "-rw-r--r-- root/root      1234 2026-05-01 10:00 src/app.js",
    "-rw-r--r-- root/root        12 2026-05-01 10:00 ../escaped.sh",
    "-rw-r--r-- root/root        12 2026-05-01 10:00 /abs/escape.sh",
    "lrwxrwxrwx root/root         0 2026-05-01 10:00 src/link -> /etc/passwd",
    "garbage line without a listing shape",
  ].join("\n");
  const members = parseArchiveListing(gnuListing);
  assert.deepEqual(members.slice(0, 2), [
    { name: "src/", type: "file" },
    { name: "src/app.js", type: "file" },
  ]);
  assert.ok(members.some((member) => member.name === "../escaped.sh"), "traversal member must be surfaced");
  assert.ok(members.some((member) => member.name === "/abs/escape.sh"), "absolute member must be surfaced");
  assert.equal(members.at(-1).name, "", "unparseable lines must fail closed");
  const linkMember = members.find((member) => member.type === "symlink");
  assert.equal(linkMember.name, "", "link lines fail closed on their -> target shape");
  assert.equal(validateArchiveMembers([linkMember]).ok, false);
  assert.equal(validateArchiveMembers(members).ok, false);
  assert.equal(validateArchiveMembers(members.slice(0, 2)).ok, true);
});

test("bsdtar-style listings parse while ambiguous or metadata-shaped names fail closed", () => {
  const listing = [
    "-rw-r--r--  0 owner staff       3 25 Aug 15:46 src/app.js",
    "-rw-r--r-- root/root        5 2026-05-01 10:00 my file.txt",
    "-rw-r--r-- root/root        5 2026-05-01 10:00 2026-05-01",
    "-rw-r--r-- root/root        5 2026-05-01 10:00 10:00",
  ].join("\n");
  const members = parseArchiveListing(listing);
  assert.equal(members[0].name, "src/app.js");
  assert.equal(validateArchiveMembers([members[0]]).ok, true);
  for (const member of members.slice(1)) {
    assert.equal(member.name, "", JSON.stringify(member));
    assert.equal(validateArchiveMembers([member]).ok, false);
  }
});

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
