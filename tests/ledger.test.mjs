import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eventKey, loadLedger, has, append } from "../scripts/lib/ledger.mjs";
import { sha256 } from "../scripts/lib/util.mjs";

test("eventKey is deterministic sha256 of material", () => {
  const a = eventKey("sig-pr", "o/r", "7", "2026-01-01T00:00:00Z");
  const b = eventKey("sig-pr", "o/r", "7", "2026-01-01T00:00:00Z");
  assert.equal(a, b);
  assert.equal(a, sha256("sig-pr|o/r|7|2026-01-01T00:00:00Z"));
});

test("eventKey differs on activity change", () => {
  const a = eventKey("sig-issue", "o/r", "9", "t1");
  const b = eventKey("sig-issue", "o/r", "9", "t2");
  assert.notEqual(a, b);
});

test("ledger dedupe: duplicate append detected by has()", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleetledger-"));
  const file = path.join(dir, "ledger.jsonl");
  const key = eventKey("sig-test", "owner/repo", "42", "2026-01-01T00:00:00Z");
  const seenEmpty = loadLedger(file);
  assert.equal(has(seenEmpty, key), false);
  append(file, key, { note: "first" });
  append(file, key, { note: "duplicate" });
  const seen = loadLedger(file);
  assert.equal(has(seen, key), true);
  assert.equal(seen.size, 1);
});

test("loadLedger tolerates missing and corrupt lines", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleetledger2-"));
  const file = path.join(dir, "missing.jsonl");
  assert.equal(loadLedger(file).size, 0);
});
