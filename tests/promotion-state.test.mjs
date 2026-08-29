import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendPromotionEvent,
  buildPromotionContext,
  deterministicPromotionEventId,
  normalizePromotionEvent,
  promotionStatePath,
  readPromotionEvents,
  rotatePromotions,
} from "../scripts/lib/promotion-state.mjs";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "fleet-promotion-state-"));
}

function event(overrides = {}) {
  return {
    runId: "promotion-run",
    state: "ACTIVATION_PLANNED",
    capabilityId: "safe-skill",
    capabilityKind: "skill",
    candidateDigest: `sha256:${"a".repeat(64)}`,
    rollbackDigest: `sha256:${"b".repeat(64)}`,
    registryPath: "config/skills.json",
    disposition: "auto-activate",
    summary: "bounded activation plan",
    changedPaths: ["skills/safe-skill/SKILL.md", "config/skills.json"],
    judgeIds: ["correctness", "adversarial"],
    fixtureIds: ["frontmatter"],
    canaryId: "synthetic",
    transaction: {
      operation: "replace-registry-pointer",
      expectedDigest: `sha256:${"b".repeat(64)}`,
      candidateDigest: `sha256:${"a".repeat(64)}`,
      rollbackDigest: `sha256:${"b".repeat(64)}`,
      force: false,
      author: "M1Vj",
      email: "143296579+M1Vj@users.noreply.github.com",
    },
    ...overrides,
  };
}

test("promotion state paths are canonical and point at state/promotions.jsonl", () => {
  const root = tempRoot();
  const expected = path.join(root, "state", "promotions.jsonl");
  assert.equal(promotionStatePath(root), expected);
  assert.equal(promotionStatePath(expected), expected);
  assert.throws(() => promotionStatePath(path.join(root, "state", "other.jsonl")), /promotions\.jsonl/i);
  assert.throws(() => promotionStatePath(`${root}/state/../state/promotions.jsonl`), /canonical/i);
});

test("promotion events are bounded, redacted, deterministic, and idempotent", () => {
  const root = tempRoot();
  const file = promotionStatePath(root);
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  const first = appendPromotionEvent(file, event({ summary: `candidate ${secret}` }));
  const second = appendPromotionEvent(file, event({ runId: "a-different-run", summary: `candidate ${secret}` }));
  assert.equal(first.appended, true);
  assert.equal(second.appended, false);
  const raw = readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /ghp_|abcdefghijklmnopqrstuvwxyz1234567890/);
  assert.equal(readPromotionEvents(file).length, 1);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(deterministicPromotionEventId(event()), deterministicPromotionEventId(event({ runId: "another" })));
  assert.equal(normalizePromotionEvent(event()).schemaVersion, 1);
});

test("promotion state rotation stays bounded and keeps the latest active claim", () => {
  const root = tempRoot();
  const file = promotionStatePath(root);
  appendPromotionEvent(file, event({ capabilityId: "active-capability", summary: "active" }));
  for (let index = 0; index < 8; index += 1) {
    appendPromotionEvent(file, event({
      capabilityId: `other-${index}`,
      candidateDigest: `sha256:${String(index + 1).repeat(64)}`,
      rollbackDigest: `sha256:${"f".repeat(64)}`,
      summary: `older-${index}`,
    }));
  }
  const result = rotatePromotions(file, { maxLines: 4 });
  const records = readPromotionEvents(file);
  assert.equal(result.rotated, true);
  assert.ok(records.length <= 4);
  assert.ok(records.some((record) => record.capabilityId === "active-capability"));
  assert.ok(records.some((record) => record.state === "ROTATED"));
});

test("promotion context filters by candidate and caps serialized size", () => {
  const root = tempRoot();
  const file = promotionStatePath(root);
  appendPromotionEvent(file, event({ summary: "target-old", createdAt: "2026-08-28T00:00:00Z" }));
  appendPromotionEvent(file, event({ capabilityId: "other", summary: "other" }));
  const context = buildPromotionContext(file, {
    capabilityId: "safe-skill",
    candidateDigest: `sha256:${"a".repeat(64)}`,
    maxEvents: 4,
    maxChars: 20_000,
  });
  assert.equal(context.length, 1);
  assert.equal(context[0].capabilityId, "safe-skill");
});

test("promotion state rejects a symlinked canonical file", () => {
  const root = tempRoot();
  const file = promotionStatePath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const outside = path.join(tempRoot(), "outside.jsonl");
  writeFileSync(outside, `${JSON.stringify(event())}\n`);
  symlinkSync(outside, file);
  assert.throws(() => appendPromotionEvent(file, event()), /regular|symlink|unsafe/i);
  assert.equal(readFileSync(outside, "utf8").split("\n").filter(Boolean).length, 1);
  assert.equal(existsSync(`${file}.lock`), false);
});
