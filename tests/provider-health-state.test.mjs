import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  mergeProviderHealthSnapshots,
  exportProviderHealthArtifact,
  importProviderHealthArtifacts,
  persistProviderHealthState,
  providerHealthStatePath,
  readProviderHealthState,
} from "../scripts/lib/provider-health-state.mjs";

test("provider cooldown state is atomic, private, bounded, and reloadable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-provider-health-"));
  const now = Date.parse("2026-08-29T02:00:00.000Z");
  try {
    persistProviderHealthState(root, {
      openrouter: {
        status: "rate-limited",
        checkedAt: new Date(now).toISOString(),
        credentials: { primary: { status: "rate-limited", checkedAt: new Date(now).toISOString() } },
      },
    }, { now });
    const file = providerHealthStatePath(root);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(readProviderHealthState(root, { now }).openrouter.status, "rate-limited");
    assert.doesNotMatch(readFileSync(file, "utf8"), /api.?key|prompt|response|body/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider cooldown artifacts merge sanitized matrix-job state into the private ledger", () => {
  const source = mkdtempSync(path.join(tmpdir(), "fleet-provider-health-source-"));
  const target = mkdtempSync(path.join(tmpdir(), "fleet-provider-health-target-"));
  const artifacts = mkdtempSync(path.join(tmpdir(), "fleet-provider-health-artifacts-"));
  const now = Date.parse("2026-08-29T02:00:00.000Z");
  try {
    persistProviderHealthState(source, { nvidia: { status: "rate-limited", checkedAt: new Date(now).toISOString() } }, { now });
    const artifact = path.join(artifacts, "provider-health-worker-1.json");
    assert.equal(exportProviderHealthArtifact(source, artifact, { now }), true);
    importProviderHealthArtifacts(target, [artifact], { now });
    assert.equal(readProviderHealthState(target, { now }).nvidia.status, "rate-limited");
    writeFileSync(path.join(artifacts, "hostile.json"), '{"schemaVersion":1,"health":{"nvidia":{"status":"healthy","checkedAt":"2026-08-29T02:00:00.000Z","prompt":"attack"}}}\n');
    assert.throws(() => importProviderHealthArtifacts(target, [path.join(artifacts, "hostile.json")], { now }), /PROVIDER_HEALTH_ARTIFACT_INVALID|PROVIDER_HEALTH_STATE_INVALID/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
});

test("provider health artifacts reject symlinked directories and files", () => {
  const source = mkdtempSync(path.join(tmpdir(), "fleet-provider-health-artifact-source-"));
  const target = mkdtempSync(path.join(tmpdir(), "fleet-provider-health-artifact-target-"));
  const artifacts = mkdtempSync(path.join(tmpdir(), "fleet-provider-health-artifact-dir-"));
  const external = mkdtempSync(path.join(tmpdir(), "fleet-provider-health-artifact-external-"));
  const linkedDirectory = path.join(artifacts, "linked");
  const linkedFile = path.join(artifacts, "linked-file.json");
  const now = Date.parse("2026-08-29T02:00:00.000Z");
  try {
    persistProviderHealthState(source, { groq: { status: "healthy", checkedAt: new Date(now).toISOString() } }, { now });
    symlinkSync(external, linkedDirectory, "dir");
    assert.throws(
      () => exportProviderHealthArtifact(source, path.join(linkedDirectory, "provider-health-worker.json"), { now }),
      /PROVIDER_HEALTH_ARTIFACT_PATH_INVALID/,
    );

    const artifact = path.join(artifacts, "provider-health-worker.json");
    assert.equal(exportProviderHealthArtifact(source, artifact, { now }), true);
    symlinkSync(artifact, linkedFile, "file");
    assert.throws(
      () => importProviderHealthArtifacts(target, [linkedFile], { now }),
      /PROVIDER_HEALTH_ARTIFACT_INVALID|PROVIDER_HEALTH_ARTIFACT_PATH_INVALID/,
    );
    symlinkSync(external, path.join(artifacts, "linked-import"), "dir");
    assert.throws(
      () => importProviderHealthArtifacts(target, [path.join(artifacts, "linked-import", "provider-health-worker.json")], { now }),
      /PROVIDER_HEALTH_ARTIFACT_INVALID|PROVIDER_HEALTH_ARTIFACT_PATH_INVALID/,
    );
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("newer durable cooldowns override stale healthy snapshots and expire", () => {
  const now = Date.parse("2026-08-29T02:00:00.000Z");
  const merged = mergeProviderHealthSnapshots(
    { groq: { status: "healthy", checkedAt: "2026-08-29T01:50:00.000Z" } },
    { groq: { status: "quota-exhausted", checkedAt: "2026-08-29T01:59:00.000Z" } },
    now,
  );
  assert.equal(merged.groq.status, "quota-exhausted");

  const root = mkdtempSync(path.join(tmpdir(), "fleet-provider-health-expiry-"));
  try {
    persistProviderHealthState(root, merged, { now });
    assert.deepEqual(readProviderHealthState(root, { now: now + 16 * 60 * 1000 }), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider cooldown state fails closed on malformed or symlinked files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-provider-health-invalid-"));
  const external = path.join(root, "external.json");
  try {
    const file = providerHealthStatePath(root);
    writeFileSync(file, '{"schemaVersion":1,"health":{"openrouter":{"status":"healthy","prompt":"unsafe"}}}\n', { mode: 0o600 });
    assert.throws(() => readProviderHealthState(root), /PROVIDER_HEALTH_STATE_INVALID/);
    rmSync(file);
    writeFileSync(external, '{"schemaVersion":1,"health":{}}\n', { mode: 0o600 });
    symlinkSync(external, file);
    assert.throws(() => readProviderHealthState(root), /PROVIDER_HEALTH_STATE_PATH_INVALID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
