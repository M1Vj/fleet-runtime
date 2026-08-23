import { test } from "node:test";
import assert from "node:assert/strict";
import { findSuperseded, isStale } from "../scripts/lib/pr-hygiene.mjs";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-08-23T12:00:00Z");
const mk = (repo, number, createdDaysAgo, files, draft = true) => ({
  repo,
  number,
  state: "open",
  draft,
  created_at: new Date(now - createdDaysAgo * DAY).toISOString(),
  files: files.map((f) => ({ filename: f })),
});

test("supersession: older overlapping draft closed, young one kept", () => {
  const entries = [
    mk("o/r", 2, 5, ["docs/a.md"]),
    mk("o/r", 1, 6, ["docs/a.md", "docs/b.md"]),
  ];
  const closed = findSuperseded(entries, now);
  assert.deepEqual(closed.map((c) => c.number), [1]);
});

test("supersession: young drafts (<3d) never closed", () => {
  const entries = [
    mk("o/r", 2, 1, ["docs/a.md"]),
    mk("o/r", 1, 2, ["docs/a.md"]),
  ];
  assert.equal(findSuperseded(entries, now).length, 0);
});

test("no overlap -> nothing closed", () => {
  const entries = [
    mk("o/r", 2, 5, ["docs/a.md"]),
    mk("o/r", 1, 9, ["docs/other.md"]),
  ];
  assert.equal(findSuperseded(entries, now).length, 0);
});

test("different repos independent", () => {
  const entries = [
    mk("o/r1", 2, 5, ["docs/a.md"]),
    mk("o/r2", 1, 9, ["docs/a.md"]),
  ];
  assert.equal(findSuperseded(entries, now).length, 0);
});

test("isStale boundary at 14 days; non-drafts exempt", () => {
  assert.equal(isStale(mk("o/r", 3, 15, ["docs/a.md"]), now), true);
  assert.equal(isStale(mk("o/r", 3, 13, ["docs/a.md"]), now), false);
  assert.equal(isStale(mk("o/r", 3, 20, ["docs/a.md"], false), now), false);
});
