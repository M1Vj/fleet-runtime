#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runGate } from "./lib/gate.mjs";
import { gh, ghInput, safeCommitState } from "./lib/util.mjs";

import {
  capabilityDigest,
  evaluateCapabilityCandidate,
  loadSkillRegistry,
  loadToolRegistry,
  validateSkillRegistry,
  validateToolRegistry,
} from "./lib/capability-registry.mjs";
import {
  appendPromotionEvent,
  normalizePromotionEvent,
  promotionStatePath,
} from "./lib/promotion-state.mjs";

export const PROMOTION_PLAN_SCHEMA_VERSION = 1;
export const PROMOTION_ATTRIBUTION = Object.freeze({
  name: "M1Vj",
  email: "143296579+M1Vj@users.noreply.github.com",
});

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_SHA_RE = /^[a-f0-9]{40}$/i;
const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const PLACEHOLDER_IDS = new Set([
  "a", "b", "foo", "bar", "baz", "test", "fixture", "placeholder", "unknown", "default", "none", "null",
  "judge", "judge1", "judge2", "judge-1", "judge-2", "judge-a", "judge-b", "reviewer", "reviewer-1", "reviewer-2",
]);
const PROTECTED_PATH_PATTERNS = [
  /^\.github\/workflows(?:\/|$)/i,
  /^\.github\/actions(?:\/|$)/i,
  /^(?:config\/providers\.json|config\/models\.json|config\/auth(?:\/|$))/i,
  /^(?:scripts\/lib\/(?:provider|model|capability-registry|target-policy|atomic-revision|verify|gate)|scripts\/(?:provider|refresh-auth|emergency-stop|sentinel|watchdog))(?:\.mjs|\/|$)/i,
  /^(?:state|state-control|audit)(?:\/|$)/i,
  /(?:^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|.*(?:\.pem|\.key|\.p12|\.pfx))$/i,
  /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i,
  /^(?:deploy|infra|terraform|migrations?)(?:\/|$)/i,
];

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g,
  /\b(?:npm_|glpat-|pypi-)[A-Za-z0-9_-]{20,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/gi,
  /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}\b/gi,
  /(?:https?|postgres(?:ql)?|mysql):\/\/[^\s/:@]+:[^\s@]+@[^\s]+/gi,
  /\b(?:access_token|refresh_token|id_token|token|api[-_]?key|apikey|client_secret|secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9._~+\/%=-]{8,}["']?/gi,
  /(?:^|[?&#\s])(?:access_token|refresh_token|id_token|token|api[-_]?key|apikey|client_secret|secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9._~+\/%=-]{8,}["']?/gi,
];

function containsSecretLike(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return true;
  }
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function safePath(value) {
  const text = String(value ?? "").trim();
  if (!SAFE_PATH_RE.test(text) || text.startsWith("/") || text.includes("\\") || text.includes("//")) return "";
  const parts = text.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === "__proto__" || part === "constructor" || part === "prototype")) return "";
  return text;
}

function safeId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  return ID_RE.test(id) && !PLACEHOLDER_IDS.has(id) ? id : "";
}

function safeDigest(value) {
  const digest = String(value ?? "").trim().toLowerCase();
  return DIGEST_RE.test(digest) ? digest : "";
}

function normalizeCandidateInput(candidate) {
  if (!isRecord(candidate)) return { candidate: {}, manifest: {}, kind: "" };
  const manifest = isRecord(candidate.manifest) ? { ...candidate.manifest } : { ...candidate };
  const kind = candidate.kind === "skill" || candidate.kind === "declarative-v1"
    ? candidate.kind
    : manifest.kind === "declarative-v1" ? "declarative-v1" : manifest.path ? "skill" : String(candidate.kind || "").trim();
  if (manifest === candidate || !isRecord(candidate.manifest)) {
    // These envelope fields carry evidence for the planner and are not part of
    // the committed registry manifest. Keep declarative-v1 `kind`, which the
    // tool schema requires, but remove the skill envelope discriminator.
    for (const key of ["candidateDigest", "content", "text", "fixtureResults", "judgeResults", "canaryResult", "priorActiveDigest", "previousActiveDigest", "priorActive", "previousActive", "rollback", "trustedJudgeIds", "changedPaths", "paths", "registryPath"]) delete manifest[key];
    if (kind === "skill" && manifest.kind === "skill") delete manifest.kind;
  }
  return { candidate, manifest, kind };
}

function candidateId(candidate, manifest) {
  return safeId(candidate.id || manifest.id);
}

function candidateDigest(candidate, manifest, kind) {
  return safeDigest(candidate.candidateDigest || candidate.digest || manifest.digest);
}

function manifestForValidation(manifest, kind) {
  const value = { ...manifest };
  // A candidate may omit status while the plan defaults to activation. The
  // schema gate still validates the complete manifest shape, including the
  // active status used by the resulting pointer.
  if (value.status === undefined) value.status = "active";
  if (kind === "skill") return { version: 1, skills: [value] };
  return { version: 1, tools: [value] };
}

function schemaGate(manifest, kind) {
  if (!isRecord(manifest) || !["skill", "declarative-v1"].includes(kind)) return { ok: false, reason: "schema-gate-failed" };
  if (manifest.status !== undefined && manifest.status !== "active") return { ok: false, reason: "schema-gate-failed" };
  const value = manifestForValidation(manifest, kind);
  const result = kind === "skill" ? validateSkillRegistry(value) : validateToolRegistry(value);
  return result.ok ? { ok: true } : { ok: false, reason: "schema-gate-failed", errors: result.errors.slice(0, 8) };
}

function protectedPathCheck(candidate, manifest, kind) {
  const declared = Array.isArray(candidate.changedPaths)
    ? candidate.changedPaths
    : Array.isArray(candidate.paths) ? candidate.paths : [];
  const paths = [...new Set([
    ...declared,
    manifest.path,
    candidate.registryPath || (kind === "skill" ? "config/skills.json" : "config/tools.json"),
  ].filter((entry) => typeof entry === "string" && entry))];
  const normalized = paths.map(safePath);
  if (normalized.some((entry) => !entry || PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(entry)))) {
    return { ok: false, paths: normalized.filter(Boolean), reason: "protected-path-gate-failed" };
  }
  if (kind === "skill" && normalized.some((entry) => entry !== "config/skills.json"
    && entry !== `skills/${manifest.id}/SKILL.md`)) {
    return { ok: false, paths: normalized.filter(Boolean), reason: "protected-path-gate-failed" };
  }
  if (kind === "declarative-v1" && normalized.some((entry) => entry !== "config/tools.json" && entry !== "config/tools.generated.json")) {
    return { ok: false, paths: normalized.filter(Boolean), reason: "protected-path-gate-failed" };
  }
  return { ok: true, paths: normalized };
}

function fixtureId(value) {
  return safeId(value?.id || value?.name);
}

function fixturePassed(fixture, digest) {
  if (!isRecord(fixture) || !fixtureId(fixture)) return false;
  const status = String(fixture.status || fixture.verdict || "").trim().toLowerCase();
  if (!(fixture.passed === true || fixture.ok === true || status === "passed" || status === "pass")) return false;
  const hasResult = ["result", "observed", "actual", "output", "evidence"].some((key) => {
    if (!Object.prototype.hasOwnProperty.call(fixture, key)) return false;
    const value = fixture[key];
    return value !== undefined && value !== null && (typeof value !== "string" || value.trim().length > 0);
  });
  if (!hasResult) return false;
  const referenced = fixture.candidateDigest || fixture.digest || fixture.inputDigest;
  return referenced === undefined || referenced === digest;
}

function judgeId(value) {
  const id = safeId(value);
  return id && !id.startsWith("placeholder") ? id : "";
}

function judgeGate(candidate, digest, options = {}) {
  const judges = Array.isArray(candidate.judgeResults)
    ? candidate.judgeResults
    : Array.isArray(candidate.judges) ? candidate.judges : [];
  const trusted = new Set([
    ...(Array.isArray(candidate.trustedJudgeIds) ? candidate.trustedJudgeIds : []),
    ...(Array.isArray(options.trustedJudgeIds) ? options.trustedJudgeIds : []),
  ].map(judgeId).filter(Boolean));
  const ids = judges.map((entry) => judgeId(entry?.id));
  if (judges.length < 2 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    return { ok: false, reason: "two-independent-judges-required", ids: ids.filter(Boolean) };
  }
  const allPass = judges.every((entry, index) => isRecord(entry)
    && entry.verdict === "pass"
    && (entry.trusted === true || trusted.has(ids[index]))
    && (entry.candidateDigest === undefined || entry.candidateDigest === digest));
  if (!allPass) return { ok: false, reason: "judge-gate-failed", ids };
  if (trusted.size === 0 && judges.some((entry) => entry?.trusted !== true)) {
    return { ok: false, reason: "trusted-judges-required", ids };
  }
  return { ok: true, ids };
}

function canaryGate(candidate, digest) {
  const canary = candidate.canaryResult || candidate.canary;
  if (!isRecord(canary)) return { ok: false, reason: "canary-gate-failed" };
  const status = String(canary.status || canary.verdict || "").trim().toLowerCase();
  if (!(canary.passed === true || canary.ok === true || status === "passed" || status === "pass")) {
    return { ok: false, reason: "canary-gate-failed" };
  }
  const digestRef = canary.candidateDigest || canary.digest || canary.inputDigest;
  if (digestRef !== digest || canary.synthetic === false) return { ok: false, reason: "canary-gate-failed" };
  const id = safeId(canary.id || canary.name);
  if (!id) return { ok: false, reason: "canary-gate-failed" };
  return { ok: true, id };
}

function findPriorActive(candidate, manifest, kind, digest, options = {}) {
  const declared = candidate.priorActiveDigest || candidate.previousActiveDigest || candidate.rollback?.digest || options.priorActiveDigest;
  if (!declared || declared !== digest) return null;
  const direct = candidate.priorActive || candidate.previousActive || candidate.rollback?.entry;
  if (isRecord(direct) && ["active", "inactive"].includes(direct.status)
    && direct.id === manifest.id && direct.digest === digest) return direct;
  const registry = options.registry;
  if (!isRecord(registry)) return null;
  const entries = kind === "skill" ? registry.skills : registry.tools;
  if (!Array.isArray(entries)) return null;
  return entries.find((entry) => isRecord(entry)
    && entry.id === manifest.id
    && ["active", "inactive"].includes(entry.status)
    && entry.digest === digest) || null;
}

function sanitizeManifest(manifest) {
  const output = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (["content", "text", "fixtureResults", "judgeResults", "canaryResult", "canary", "rollback", "priorActive", "previousActive"].includes(key)) continue;
    // Registry schema bounds strings below 2,000 chars (template text) and
    // arrays below 64 entries. Keep those exact values so a rollback can
    // recompute the prior manifest digest instead of restoring truncated data.
    if (typeof value === "string" && value.length > 4096) output[key] = value.slice(0, 4096);
    else if (Array.isArray(value)) output[key] = value.slice(0, 64).map((entry) => isRecord(entry) ? sanitizeManifest(entry) : entry);
    else if (isRecord(value)) output[key] = sanitizeManifest(value);
    else output[key] = value;
  }
  return output;
}

function registryCollection(kind) {
  return kind === "skill" ? "skills" : "tools";
}

/**
 * Evaluate a candidate without reading, writing, executing, or contacting a
 * remote service. Every gate is derived from evidence, never from a boolean
 * claim supplied by a model.
 */
export function validateCapabilityCandidate(candidate = {}, options = {}) {
  const { candidate: source, manifest, kind } = normalizeCandidateInput(candidate);
  const reasons = [];
  const id = candidateId(source, manifest);
  const digest = candidateDigest(source, manifest, kind);
  const rollbackDigest = safeDigest(source.rollbackDigest || manifest.rollbackDigest);

  if (!id) reasons.push("candidate-id-invalid");
  const candidateContent = typeof source.content === "string" ? source.content : typeof source.text === "string" ? source.text : undefined;
  if (kind === "skill" && typeof candidateContent !== "string") reasons.push("candidate-content-required");
  if (!digest || (kind === "skill" && typeof candidateContent === "string" && digest !== `sha256:${sha256(candidateContent)}`)) {
    reasons.push("candidate-digest-invalid");
  }
  if (kind === "declarative-v1" && digest && digest !== capabilityDigest(manifest)) reasons.push("candidate-digest-invalid");
  if (!rollbackDigest) reasons.push("rollback-digest-invalid");
  if (digest && rollbackDigest && digest === rollbackDigest) reasons.push("rollback-digest-must-differ");
  if (containsSecretLike(source)) reasons.push("secret-scan-gate-failed");

  const schema = schemaGate(manifest, kind);
  if (!schema.ok) reasons.push(schema.reason);
  const protectedPaths = protectedPathCheck(source, manifest, kind);
  if (!protectedPaths.ok) reasons.push(protectedPaths.reason);

  const fixtureEvidence = source.fixtureResults || source.fixtures || manifest.fixtureResults || manifest.fixtures;
  const fixtures = Array.isArray(fixtureEvidence) ? fixtureEvidence : [];
  const fixtureIds = fixtures.map(fixtureId).filter(Boolean);
  if (fixtures.length === 0 || !fixtures.every((fixture) => fixturePassed(fixture, digest))) reasons.push("fixture-gate-failed");

  const evidenceSource = {
    ...manifest,
    ...source,
    fixtureResults: source.fixtureResults || manifest.fixtureResults,
    fixtures: source.fixtures || manifest.fixtures,
    judgeResults: source.judgeResults || manifest.judgeResults,
    judges: source.judges || manifest.judges,
    canaryResult: source.canaryResult || manifest.canaryResult,
    canary: source.canary || manifest.canary,
    trustedJudgeIds: source.trustedJudgeIds || manifest.trustedJudgeIds,
  };
  const judges = judgeGate(evidenceSource, digest, options);
  if (!judges.ok) reasons.push(judges.reason);
  const canary = canaryGate(evidenceSource, digest);
  if (!canary.ok) reasons.push(canary.reason);

  const prior = findPriorActive(source, manifest, kind, rollbackDigest, options);
  if (!prior) reasons.push("prior-active-rollback-required");

  const normalizedReasons = [...new Set(reasons)];
  const capabilityEvaluation = evaluateCapabilityCandidate({
    kind,
    protectedPathSafe: protectedPaths.ok,
    secretScanPassed: !containsSecretLike(source),
    schemaPassed: schema.ok,
    fixtures: fixtures.map((fixture) => ({ ...fixture, passed: fixturePassed(fixture, digest) })),
    fixtureResults: fixtures,
    judges: evidenceSource.judges,
    judgeResults: evidenceSource.judgeResults,
    trustedJudgeIds: evidenceSource.trustedJudgeIds,
    canary: evidenceSource.canary,
    canaryResult: evidenceSource.canaryResult,
    digest,
    rollbackDigest,
    priorActiveDigest: prior?.digest || source.priorActiveDigest,
    rollbackVerified: Boolean(prior),
  }, options);
  if (capabilityEvaluation.activate && normalizedReasons.length === 0) {
    return {
      ok: true,
      activate: true,
      disposition: "auto-activate",
      reasons: [],
      id,
      kind,
      digest,
      rollbackDigest,
      changedPaths: protectedPaths.paths,
      judgeIds: judges.ids,
      fixtureIds,
      canaryId: canary.id,
      priorActive: prior,
    };
  }
  const ownerReview = kind !== "skill" && kind !== "declarative-v1" || normalizedReasons.includes("protected-path-gate-failed");
  return {
    ok: false,
    activate: false,
    disposition: ownerReview ? "owner-review" : "blocked",
    reasons: normalizedReasons.length > 0 ? normalizedReasons : capabilityEvaluation.reasons,
    id,
    kind,
    digest,
    rollbackDigest,
    changedPaths: protectedPaths.paths,
    judgeIds: judges.ids,
    fixtureIds,
    canaryId: canary.id,
    priorActive: prior,
  };
}

export const assessCapabilityCandidate = validateCapabilityCandidate;

function registryPathFor(kind, options = {}) {
  return options.registryPath || (kind === "skill" ? "config/skills.json" : "config/tools.json");
}

function activationTransaction(evaluation, manifest, options = {}) {
  const registryPath = registryPathFor(evaluation.kind, options);
  const collection = registryCollection(evaluation.kind);
  const message = `promote ${evaluation.kind === "skill" ? "skill" : "tool"} ${evaluation.id} ${manifest.version}`;
  const branch = options.branch || `fleet/capability-${evaluation.id}-${evaluation.digest.slice(7, 19)}`;
  const baseRef = options.baseRef || "main";
  return {
    operation: "prepare-registry-pointer-pr",
    registryPath,
    collection,
    id: evaluation.id,
    expectedDigest: evaluation.rollbackDigest,
    candidateDigest: evaluation.digest,
    rollbackDigest: evaluation.rollbackDigest,
    baseRef,
    ...(COMMIT_SHA_RE.test(String(options.baseSha || options.expectedHeadSha || ""))
      ? { baseSha: String(options.baseSha || options.expectedHeadSha).toLowerCase() }
      : {}),
    ref: branch,
    branch,
    pullRequest: { base: baseRef, head: branch, draft: true },
    force: false,
    commitMessage: message,
    author: PROMOTION_ATTRIBUTION.name,
    email: PROMOTION_ATTRIBUTION.email,
    committer: { ...PROMOTION_ATTRIBUTION },
  };
}

/** Build a redacted, exact activation plan. The plan never performs a commit. */
export function preparePromotion(candidate = {}, options = {}) {
  const { manifest } = normalizeCandidateInput(candidate);
  const evaluation = validateCapabilityCandidate(candidate, options);
  const plan = {
    schemaVersion: PROMOTION_PLAN_SCHEMA_VERSION,
    planId: sha256(stableStringify({
      id: evaluation.id,
      kind: evaluation.kind,
      digest: evaluation.digest,
      rollbackDigest: evaluation.rollbackDigest,
    })),
    createdAt: new Date(options.now || Date.now()).toISOString(),
    disposition: evaluation.disposition,
    activate: evaluation.activate,
    reasons: [...evaluation.reasons],
    capability: {
      id: evaluation.id,
      kind: evaluation.kind,
      version: manifest.version,
      digest: evaluation.digest,
      rollbackDigest: evaluation.rollbackDigest,
      manifest: sanitizeManifest(manifest),
    },
    evidence: {
      changedPaths: [...evaluation.changedPaths],
      judgeIds: [...evaluation.judgeIds],
      fixtureIds: [...evaluation.fixtureIds],
      canaryId: evaluation.canaryId || "",
      priorActiveDigest: evaluation.priorActive?.digest || "",
    },
  };
  if (evaluation.activate) {
    plan.transaction = activationTransaction(evaluation, manifest, options);
    plan.rollback = {
      operation: "prepare-registry-pointer-rollback-pr",
      registryPath: plan.transaction.registryPath,
      collection: plan.transaction.collection,
      id: evaluation.id,
      expectedDigest: evaluation.digest,
      candidateDigest: evaluation.digest,
      rollbackDigest: evaluation.rollbackDigest,
      baseRef: plan.transaction.baseRef,
      ...(plan.transaction.baseSha ? { baseSha: plan.transaction.baseSha } : {}),
      branch: `${plan.transaction.branch}-rollback`,
      pullRequest: {
        base: plan.transaction.baseRef,
        head: `${plan.transaction.branch}-rollback`,
        draft: true,
      },
      ref: `${plan.transaction.branch}-rollback`,
      priorManifest: evaluation.priorActive ? sanitizeManifest(evaluation.priorActive) : undefined,
      force: false,
      author: PROMOTION_ATTRIBUTION.name,
      email: PROMOTION_ATTRIBUTION.email,
    };
  } else if (evaluation.disposition === "owner-review") {
    plan.draft = {
      disposition: "owner-review",
      reason: "protected or executable capability requires owner review",
      mutation: "none",
    };
  }
  return plan;
}

export const buildPromotionPlan = preparePromotion;
export const prepareActivationPlan = preparePromotion;

/**
 * Invoke an injected committer for tests or a separately governed activation
 * service. The default path is fail-closed and cannot mutate Git or a registry.
 */
export function activatePromotion(plan, { commit, commitActivation } = {}) {
  const checked = validatePromotionPlan(plan);
  if (!checked.ok) throw new Error(`PROMOTION_PLAN_NOT_ACTIVATABLE: ${checked.reasons.join(",")}`);
  const committer = typeof commit === "function" ? commit : commitActivation;
  if (typeof committer !== "function") throw new Error("PROMOTION_ACTIVATION_DISABLED");
  const transaction = structuredClone(plan.transaction);
  return committer(transaction);
}

export const applyActivation = activatePromotion;
export const commitActivation = activatePromotion;

/** Validate the immutable transaction envelope before a trusted caller hands it
 * to an injected committer. This check never reads or writes a registry. */
export function validatePromotionPlan(plan) {
  if (!isRecord(plan) || plan.schemaVersion !== PROMOTION_PLAN_SCHEMA_VERSION) {
    return { ok: false, reasons: ["promotion-plan-schema-invalid"] };
  }
  if (plan.activate !== true || plan.disposition !== "auto-activate" || !isRecord(plan.transaction)) {
    return { ok: false, reasons: ["promotion-plan-not-activatable"] };
  }
  const transaction = plan.transaction;
  const reasons = [];
  if (transaction.force !== false) reasons.push("promotion-transaction-must-be-non-force");
  if (transaction.author !== PROMOTION_ATTRIBUTION.name || transaction.email !== PROMOTION_ATTRIBUTION.email) {
    reasons.push("promotion-attribution-invalid");
  }
  if (!safeDigest(transaction.expectedDigest) || !safeDigest(transaction.candidateDigest)
    || !safeDigest(transaction.rollbackDigest) || transaction.expectedDigest !== transaction.rollbackDigest
    || transaction.candidateDigest === transaction.rollbackDigest) {
    reasons.push("promotion-transaction-digest-invalid");
  }
  if (!safePath(transaction.registryPath) || !["skills", "tools"].includes(transaction.collection) || !safeId(transaction.id)
    || !["prepare-registry-pointer-pr", "prepare-registry-pointer-rollback-pr"].includes(transaction.operation)
    || transaction.baseRef !== "main"
    || transaction.registryPath !== (transaction.collection === "skills" ? "config/skills.json" : "config/tools.json")
    || typeof transaction.branch !== "string" || !/^fleet\/capability-[a-z0-9][a-z0-9-]{1,100}$/.test(transaction.branch)
    || transaction.ref !== transaction.branch
    || !isRecord(transaction.pullRequest) || transaction.pullRequest.base !== transaction.baseRef
    || transaction.pullRequest.head !== transaction.branch || transaction.pullRequest.draft !== true) {
    reasons.push("promotion-transaction-target-invalid");
  }
  return { ok: reasons.length === 0, reasons };
}

function clone(value) {
  return structuredClone(value);
}

function registryEntryFor(registry, collection, id) {
  if (!isRecord(registry) || !Array.isArray(registry[collection])) return null;
  return registry[collection].find((entry) => isRecord(entry) && entry.id === id) || null;
}

function registryValid(registry, collection) {
  return collection === "skills" ? validateSkillRegistry(registry) : validateToolRegistry(registry);
}

/**
 * Create the only registry mutation permitted by an activation plan. The
 * caller must provide the exact current registry and the candidate manifest;
 * this helper never reads a checkout or writes a file.
 */
export function buildRegistryPointerMutation({ plan, registry, candidate, candidateManifest, candidateContent } = {}) {
  const checked = validatePromotionPlan(plan);
  if (!checked.ok) throw new Error(`PROMOTION_PLAN_NOT_ACTIVATABLE: ${checked.reasons.join(",")}`);
  const collection = plan.transaction.collection;
  const currentValidation = registryValid(registry, collection);
  if (!currentValidation.ok) throw new Error("PROMOTION_CURRENT_REGISTRY_INVALID");
  const current = registryEntryFor(registry, collection, plan.transaction.id);
  if (!current || !["active", "inactive"].includes(current.status)
    || current.digest !== plan.transaction.expectedDigest) {
    throw new Error("PROMOTION_CURRENT_DIGEST_MISMATCH");
  }
  const normalized = normalizeCandidateInput(candidate || {});
  const manifest = isRecord(candidateManifest)
    ? clone(candidateManifest)
    : isRecord(normalized.manifest) && Object.keys(normalized.manifest).length > 0
      ? clone(normalized.manifest)
      : clone(plan.capability.manifest);
  if (!isRecord(manifest) || manifest.id !== plan.transaction.id) throw new Error("PROMOTION_CANDIDATE_ID_MISMATCH");
  if (manifest.status !== undefined && manifest.status !== "active") throw new Error("PROMOTION_CANDIDATE_STATUS_INVALID");
  manifest.status = "active";
  manifest.digest = plan.transaction.candidateDigest;
  manifest.rollbackDigest = plan.transaction.rollbackDigest;
  if (containsSecretLike(manifest)) throw new Error("PROMOTION_SECRET_SCAN_FAILED");

  const files = {};
  if (collection === "skills") {
    if (!safePath(manifest.path) || !manifest.path.startsWith("skills/") || !manifest.path.endsWith("SKILL.md")) {
      throw new Error("PROMOTION_SKILL_PATH_INVALID");
    }
    const text = candidateContent ?? candidate?.content ?? candidate?.text;
    if (typeof text !== "string" || `sha256:${sha256(text)}` !== plan.transaction.candidateDigest) {
      throw new Error("PROMOTION_SKILL_BYTES_MISMATCH");
    }
    files[manifest.path] = text;
    delete manifest.kind;
  } else {
    if (manifest.kind !== "declarative-v1" || capabilityDigest(manifest) !== plan.transaction.candidateDigest) {
      throw new Error("PROMOTION_TOOL_MANIFEST_MISMATCH");
    }
  }
  const candidateRegistry = { ...clone(registry), [collection]: registry[collection].map((entry) => entry.id === plan.transaction.id ? manifest : entry) };
  const updatedValidation = registryValid(candidateRegistry, collection);
  if (!updatedValidation.ok) throw new Error("PROMOTION_UPDATED_REGISTRY_INVALID");
  files[plan.transaction.registryPath] = `${JSON.stringify(candidateRegistry, null, 2)}\n`;
  return {
    registry: candidateRegistry,
    files,
    changedPaths: Object.keys(files),
    expectedDigest: plan.transaction.expectedDigest,
    candidateDigest: plan.transaction.candidateDigest,
  };
}

function requireIdentity(identity) {
  const value = identity && typeof identity === "object" ? identity : {};
  const name = String(value.name || value.login || "").trim();
  const email = String(value.email || "").trim();
  if (name !== PROMOTION_ATTRIBUTION.name || email !== PROMOTION_ATTRIBUTION.email) {
    throw new Error("PROMOTION_IDENTITY_MISMATCH");
  }
  return { name, email };
}

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BASE_REF_RE = /^[A-Za-z0-9._/-]{1,160}$/;

function safeRepository(value) {
  const repository = String(value || "").trim();
  if (!REPOSITORY_RE.test(repository) || repository.includes("..")) throw new Error("PROMOTION_REPOSITORY_INVALID");
  return repository;
}

function safeRef(value, label = "promotion ref") {
  const ref = String(value || "").trim();
  if (!BASE_REF_RE.test(ref) || ref.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label.toUpperCase().replaceAll(" ", "_")}_INVALID`);
  }
  return ref;
}

function refApiPath(repository, ref) {
  return `/repos/${repository}/git/ref/heads/${safeRef(ref).split("/").map(encodeURIComponent).join("/")}`;
}

function contentsApiPath(repository, filePath, ref) {
  const safeFile = safePath(filePath);
  if (!mutationPathAllowed(safeFile)) throw new Error("PROMOTION_REGISTRY_PATH_INVALID");
  return `/repos/${repository}/contents/${safeFile.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(safeRef(ref))}`;
}

function responseSha(response, label) {
  const value = String(response?.object?.sha || response?.sha || "").trim().toLowerCase();
  if (!COMMIT_SHA_RE.test(value)) throw new Error(`${label}_UNVERIFIED`);
  return value;
}

function mutationPathAllowed(value) {
  const filePath = safePath(value);
  return filePath === "config/skills.json"
    || filePath === "config/tools.json"
    || (filePath.startsWith("skills/") && filePath.endsWith("SKILL.md"));
}

/**
 * Build the production GitHub adapter without performing any work. The
 * workflow must opt in explicitly with --execute and the owner gate. All
 * writes use Git data APIs, an exact base SHA, force=false, and a draft PR.
 * `ghCall`, `ghInputCall`, and `gate` are injectable so tests never contact
 * GitHub or exercise a real identity.
 */
export function createGitHubPromotionAdapters({
  env = process.env,
  repository = env.FLEET_PROMOTION_REPO || "M1Vj/fleet-runtime",
  ghCall = gh,
  ghInputCall = ghInput,
  gate = runGate,
} = {}) {
  const repo = safeRepository(repository);
  const callGh = (args) => ghCall(args, env);
  const callGhInput = (args, body) => ghInputCall(args, body, env);
  return {
    verifyIdentity: async () => {
      const identity = await gate(env);
      if (!identity || identity.login !== PROMOTION_ATTRIBUTION.name || identity.type === "Bot") {
        throw new Error("PROMOTION_IDENTITY_MISMATCH");
      }
      return { name: identity.login, email: identity.noreply };
    },
    /** Read the current main commit and registry pointer before any branch write. */
    readCurrentMainState: ({ baseRef = "main", registryPath, collection } = {}) => {
      const safeBaseRef = safeRef(baseRef, "promotion base ref");
      const expectedPath = collection === "skills" ? "config/skills.json" : "config/tools.json";
      if (registryPath !== expectedPath) throw new Error("PROMOTION_REGISTRY_PATH_INVALID");
      const baseSha = responseSha(callGh(["api", refApiPath(repo, safeBaseRef)]), "PROMOTION_BASE_REF");
      const file = callGh(["api", contentsApiPath(repo, registryPath, baseSha)]);
      if (file?.encoding !== "base64" || typeof file.content !== "string") throw new Error("PROMOTION_REGISTRY_CONTENT_UNVERIFIED");
      let registry;
      try {
        registry = JSON.parse(Buffer.from(file.content.replace(/\s+/g, ""), "base64").toString("utf8"));
      } catch {
        throw new Error("PROMOTION_CURRENT_REGISTRY_INVALID");
      }
      if (!registryValid(registry, collection).ok) throw new Error("PROMOTION_CURRENT_REGISTRY_INVALID");
      return { baseRef: safeBaseRef, baseSha, registry };
    },
    createBranch: ({ branch, baseRef = "main", baseSha, force } = {}) => {
      if (force !== false) throw new Error("PROMOTION_FORCE_FORBIDDEN");
      const safeBranch = safeRef(branch, "promotion branch");
      const safeBaseRef = safeRef(baseRef, "promotion base ref");
      const expectedSha = String(baseSha || "").trim().toLowerCase();
      if (!COMMIT_SHA_RE.test(expectedSha)) throw new Error("PROMOTION_BASE_SHA_REQUIRED");
      const base = responseSha(callGh(["api", refApiPath(repo, safeBaseRef)]), "PROMOTION_BASE_REF");
      if (base !== expectedSha) throw new Error("PROMOTION_BASE_SHA_MISMATCH");
      try {
        const created = callGhInput(
          ["api", "-X", "POST", `/repos/${repo}/git/refs`],
          { ref: `refs/heads/${safeBranch}`, sha: expectedSha },
        );
        const createdSha = responseSha(created, "PROMOTION_BRANCH");
        if (createdSha !== expectedSha) throw new Error("PROMOTION_BRANCH_BASE_MISMATCH");
        return { branch: safeBranch, sha: createdSha, created: true, forced: false };
      } catch (error) {
        if (!/422|already exists|Reference already exists/i.test(String(error?.message || error))) throw error;
        const existing = responseSha(callGh(["api", refApiPath(repo, safeBranch)]), "PROMOTION_BRANCH");
        if (existing !== expectedSha) throw new Error("PROMOTION_BRANCH_BASE_MISMATCH");
        return { branch: safeBranch, sha: existing, created: false, idempotent: true, forced: false };
      }
    },
    commit: ({ branch, baseSha, files, message, author, email, force, allowedPaths = [] } = {}) => {
      if (force !== false) throw new Error("PROMOTION_FORCE_FORBIDDEN");
      const safeBranch = safeRef(branch, "promotion branch");
      const expectedSha = String(baseSha || "").trim().toLowerCase();
      if (!COMMIT_SHA_RE.test(expectedSha)) throw new Error("PROMOTION_BASE_SHA_REQUIRED");
      const head = responseSha(callGh(["api", refApiPath(repo, safeBranch)]), "PROMOTION_BRANCH");
      if (head !== expectedSha) throw new Error("PROMOTION_BRANCH_HEAD_MISMATCH");
      if (!files || typeof files !== "object" || Array.isArray(files) || Object.keys(files).length === 0) {
        throw new Error("PROMOTION_MUTATION_EMPTY");
      }
      const allowed = new Set(allowedPaths.filter((entry) => typeof entry === "string"));
      const changed = Object.keys(files);
      for (const filePath of changed) {
        if (!mutationPathAllowed(filePath) || (allowed.size > 0 && !allowed.has(filePath))) {
          throw new Error("PROMOTION_MUTATION_PATH_FORBIDDEN");
        }
        if (typeof files[filePath] !== "string" || containsSecretLike(files[filePath])) {
          throw new Error("PROMOTION_MUTATION_CONTENT_INVALID");
        }
      }
      const baseCommit = callGh(["api", `/repos/${repo}/git/commits/${expectedSha}`]);
      const baseTree = responseSha(baseCommit?.tree, "PROMOTION_BASE_TREE");
      const tree = [];
      for (const filePath of changed) {
        const blob = callGhInput(
          ["api", "-X", "POST", `/repos/${repo}/git/blobs`],
          { content: files[filePath], encoding: "utf-8" },
        );
        const blobSha = responseSha(blob, "PROMOTION_BLOB");
        tree.push({ path: filePath, mode: "100644", type: "blob", sha: blobSha });
      }
      const treeResult = callGhInput(
        ["api", "-X", "POST", `/repos/${repo}/git/trees`],
        { base_tree: baseTree, tree },
      );
      const treeSha = responseSha(treeResult, "PROMOTION_TREE");
      const commitResult = callGhInput(
        ["api", "-X", "POST", `/repos/${repo}/git/commits`],
        {
          message: String(message || "governed capability promotion").slice(0, 240),
          tree: treeSha,
          parents: [expectedSha],
          author: { name: author, email },
          committer: { name: author, email },
        },
      );
      const commitSha = responseSha(commitResult, "PROMOTION_COMMIT");
      const parentSha = responseSha(commitResult?.parents?.[0], "PROMOTION_COMMIT_PARENT");
      if (parentSha !== expectedSha) throw new Error("PROMOTION_COMMIT_PARENT_MISMATCH");
      const commitAuthor = String(commitResult?.commit?.author?.name || "").trim();
      const commitEmail = String(commitResult?.commit?.author?.email || "").trim();
      if (commitAuthor !== author || commitEmail !== email) throw new Error("PROMOTION_COMMIT_ATTRIBUTION_MISMATCH");
      return { sha: commitSha, author: commitAuthor, email: commitEmail, forced: false };
    },
    push: ({ branch, commitSha, expectedHeadSha, force } = {}) => {
      if (force !== false) throw new Error("PROMOTION_FORCE_FORBIDDEN");
      const safeBranch = safeRef(branch, "promotion branch");
      const expectedSha = String(expectedHeadSha || "").trim().toLowerCase();
      const nextSha = String(commitSha || "").trim().toLowerCase();
      if (!COMMIT_SHA_RE.test(expectedSha) || !COMMIT_SHA_RE.test(nextSha) || expectedSha === nextSha) {
        throw new Error("PROMOTION_PUSH_SHA_INVALID");
      }
      const current = responseSha(callGh(["api", refApiPath(repo, safeBranch)]), "PROMOTION_BRANCH");
      if (current !== expectedSha) throw new Error("PROMOTION_BRANCH_HEAD_MISMATCH");
      const updated = callGhInput(
        ["api", "-X", "PATCH", refApiPath(repo, safeBranch)],
        { sha: nextSha, force: false },
      );
      const updatedSha = responseSha(updated, "PROMOTION_PUSH");
      if (updatedSha !== nextSha) throw new Error("PROMOTION_PUSH_SHA_MISMATCH");
      return { branch: safeBranch, sha: updatedSha, forced: false, force: false };
    },
    openDraftPullRequest: ({ base, head, draft, title, body } = {}) => {
      if (draft !== true) throw new Error("PROMOTION_DRAFT_PR_REQUIRED");
      const safeBase = safeRef(base, "promotion base ref");
      const safeHead = safeRef(head, "promotion branch");
      const result = callGhInput(
        ["api", "-X", "POST", `/repos/${repo}/pulls`],
        {
          title: String(title || "Governed capability promotion").slice(0, 240),
          head: safeHead,
          base: safeBase,
          body: String(body || "").slice(0, 8_000),
          draft: true,
          maintainer_can_modify: false,
        },
      );
      if (result?.draft !== true || result?.base?.ref !== safeBase || result?.head?.ref !== safeHead) {
        throw new Error("PROMOTION_DRAFT_PR_UNVERIFIED");
      }
      return {
        number: Number.isSafeInteger(result.number) ? result.number : undefined,
        draft: true,
        merged: result.merged === true,
        autoMerge: result.auto_merge === true || result.autoMerge === true,
        url: typeof result.html_url === "string" ? result.html_url : undefined,
      };
    },
  };
}

/** Commit one redacted event to the private state repository only. */
export function commitPromotionState({ stateRoot, event, env = process.env } = {}) {
  if (!stateRoot || !event || typeof event !== "object") throw new Error("PROMOTION_STATE_COMMIT_INPUT_INVALID");
  const capability = String(event.capabilityId || "capability").slice(0, 96);
  const state = String(event.state || "event").slice(0, 64);
  return safeCommitState(
    path.resolve(String(stateRoot)),
    ["state/promotions.jsonl"],
    `[fleet] promotion ${state} ${capability}`,
    { name: PROMOTION_ATTRIBUTION.name, noreply: PROMOTION_ATTRIBUTION.email },
    env,
  );
}

function persistPromotionState(stateRoot, plan, state, extra = {}) {
  if (!stateRoot) throw new Error("PROMOTION_STATE_REQUIRED");
  const result = appendPromotionEvent(stateRoot, {
    runId: extra.runId || "promotion-execution",
    state,
    capabilityId: plan.capability.id,
    capabilityKind: plan.capability.kind,
    candidateDigest: plan.capability.digest,
    rollbackDigest: plan.capability.rollbackDigest,
    registryPath: plan.transaction?.registryPath || plan.rollback?.registryPath,
    disposition: plan.disposition,
    changedPaths: plan.evidence?.changedPaths || [],
    judgeIds: plan.evidence?.judgeIds || [],
    fixtureIds: plan.evidence?.fixtureIds || [],
    canaryId: plan.evidence?.canaryId || "",
    summary: extra.summary || state.toLowerCase().replace(/_/g, " "),
    artifactRefs: extra.artifactRefs || [],
    transaction: extra.transaction || plan.transaction || plan.rollback,
  });
  if (typeof extra.stateCommit === "function") extra.stateCommit({ stateRoot, event: result.event });
  return result;
}

function requireAdapter(adapters, name) {
  if (!adapters || typeof adapters[name] !== "function") throw new Error(`PROMOTION_ADAPTER_REQUIRED:${name}`);
  return adapters[name];
}

/**
 * Execute the branch/commit/push/draft-PR path only through injected adapters.
 * Production callers must provide a separately audited adapter; this module
 * never invokes git, GitHub, a model, or a network client by itself.
 */
export async function executePromotionTransaction({
  plan,
  registry,
  candidate,
  candidateManifest,
  candidateContent,
  stateRoot,
  adapters = {},
  runId = "promotion-execution",
  stateCommit,
} = {}) {
  const checked = validatePromotionPlan(plan);
  if (!checked.ok) throw new Error(`PROMOTION_PLAN_NOT_ACTIVATABLE: ${checked.reasons.join(",")}`);
  if (!stateRoot) throw new Error("PROMOTION_STATE_REQUIRED");
  if (!plan.transaction.baseSha || !COMMIT_SHA_RE.test(plan.transaction.baseSha)) throw new Error("PROMOTION_BASE_SHA_REQUIRED");
  const mutation = buildRegistryPointerMutation({ plan, registry, candidate, candidateManifest, candidateContent });
  const persist = (state, extra = {}) => persistPromotionState(stateRoot, plan, state, {
    ...extra,
    runId,
    stateCommit,
  });
  persist("ACTIVATION_PLANNED", { summary: "activation transaction planned", transaction: plan.transaction });
  try {
    const identity = requireIdentity(await requireAdapter(adapters, "verifyIdentity")({ transaction: plan.transaction }));
    const branchResult = await requireAdapter(adapters, "createBranch")({
      branch: plan.transaction.branch,
      baseRef: plan.transaction.baseRef,
      baseSha: plan.transaction.baseSha,
      force: false,
    });
    if (branchResult?.branch && branchResult.branch !== plan.transaction.branch) throw new Error("PROMOTION_BRANCH_MISMATCH");
    if (branchResult?.forced === true) throw new Error("PROMOTION_FORCE_FORBIDDEN");
    persist("ACTIVATION_BRANCH_CREATED", { summary: "promotion branch created" });

    const commitResult = await requireAdapter(adapters, "commit")({
      branch: plan.transaction.branch,
      baseSha: plan.transaction.baseSha,
      files: mutation.files,
      message: plan.transaction.commitMessage,
      author: identity.name,
      email: identity.email,
      force: false,
      allowedPaths: mutation.changedPaths,
    });
    const commitSha = String(commitResult?.sha || commitResult?.commitSha || "").trim().toLowerCase();
    if (!COMMIT_SHA_RE.test(commitSha) || commitResult?.forced === true || commitResult?.author !== undefined && commitResult.author !== identity.name) {
      throw new Error("PROMOTION_COMMIT_UNVERIFIED");
    }
    persist("ACTIVATION_COMMITTED", { summary: "attributed activation commit created", artifactRefs: [`commit:${commitSha}`] });

    const pushResult = await requireAdapter(adapters, "push")({
      branch: plan.transaction.branch,
      commitSha,
      expectedHeadSha: plan.transaction.baseSha,
      force: false,
    });
    if (pushResult?.forced === true || pushResult?.force === true) throw new Error("PROMOTION_FORCE_FORBIDDEN");
    persist("ACTIVATION_PUSHED", { summary: "non-force promotion branch pushed", artifactRefs: [`commit:${commitSha}`] });

    const pullRequest = await requireAdapter(adapters, "openDraftPullRequest")({
      base: plan.transaction.pullRequest.base,
      head: plan.transaction.pullRequest.head,
      draft: true,
      title: plan.transaction.commitMessage,
      body: "Governed capability promotion plan. Owner review remains required before activation.",
    });
    if (!pullRequest || pullRequest.draft !== true || pullRequest.merged === true || pullRequest.autoMerge === true) {
      throw new Error("PROMOTION_DRAFT_PR_UNVERIFIED");
    }
    const artifactRefs = pullRequest.number ? [`pr:${pullRequest.number}`, `commit:${commitSha}`] : [`commit:${commitSha}`];
    persist("ACTIVATION_PR_OPENED", { summary: "draft promotion pull request opened", artifactRefs });
    return { state: "ACTIVATION_PR_OPENED", branch: plan.transaction.branch, commitSha, pullRequest, mutation };
  } catch (error) {
    persist("ACTIVATION_FAILED", { summary: String(error.message || "promotion failed").slice(0, 200) });
    throw error;
  }
}

export const applyPromotionTransaction = executePromotionTransaction;
export const runPromotion = executePromotionTransaction;

function validateRollbackTransaction(transaction, plan) {
  const reasons = [];
  if (!isRecord(transaction) || transaction.operation !== "prepare-registry-pointer-rollback-pr") reasons.push("rollback-operation-invalid");
  if (transaction?.force !== false) reasons.push("rollback-force-forbidden");
  if (transaction?.author !== PROMOTION_ATTRIBUTION.name || transaction?.email !== PROMOTION_ATTRIBUTION.email) reasons.push("rollback-attribution-invalid");
  if (transaction?.candidateDigest !== plan.capability.digest || transaction?.rollbackDigest !== plan.capability.rollbackDigest) reasons.push("rollback-digest-invalid");
  if (!COMMIT_SHA_RE.test(String(transaction?.baseSha || ""))) reasons.push("rollback-base-sha-invalid");
  if (!safePath(transaction?.registryPath) || !["skills", "tools"].includes(transaction?.collection)
    || transaction?.registryPath !== (transaction?.collection === "skills" ? "config/skills.json" : "config/tools.json")
    || transaction?.baseRef !== "main" || transaction?.id !== plan.capability.id) reasons.push("rollback-target-invalid");
  if (typeof transaction?.branch !== "string" || !/^fleet\/capability-[a-z0-9][a-z0-9-]{1,100}-rollback$/.test(transaction.branch)
    || transaction.ref !== transaction.branch || transaction.pullRequest?.base !== transaction.baseRef
    || transaction.pullRequest?.head !== transaction.branch || transaction.pullRequest?.draft !== true) reasons.push("rollback-branch-invalid");
  return { ok: reasons.length === 0, reasons };
}

/** Build the exact registry bytes used by a pointer-only rollback. */
export function buildRollbackPointerMutation({ plan, registry, priorManifest, priorContent } = {}) {
  if (!isRecord(plan) || plan.activate !== true || !isRecord(plan.rollback)) throw new Error("PROMOTION_ROLLBACK_PLAN_UNAVAILABLE");
  const checked = validateRollbackTransaction(plan.rollback, plan);
  if (!checked.ok) throw new Error(`PROMOTION_ROLLBACK_PLAN_INVALID: ${checked.reasons.join(",")}`);
  const currentValidation = registryValid(registry, plan.rollback.collection);
  if (!currentValidation.ok) throw new Error("PROMOTION_CURRENT_REGISTRY_INVALID");
  const current = registryEntryFor(registry, plan.rollback.collection, plan.capability.id);
  if (!current || current.status !== "active" || current.digest !== plan.capability.digest) throw new Error("PROMOTION_CURRENT_DIGEST_MISMATCH");
  const manifest = isRecord(priorManifest)
    ? clone(priorManifest)
    : isRecord(plan.rollback.priorManifest) ? clone(plan.rollback.priorManifest) : null;
  if (!manifest || manifest.id !== plan.capability.id || !["active", "inactive"].includes(manifest.status)
    || manifest.digest !== plan.capability.rollbackDigest) {
    throw new Error("PROMOTION_PRIOR_MANIFEST_UNVERIFIED");
  }
  if (containsSecretLike(manifest)) throw new Error("PROMOTION_SECRET_SCAN_FAILED");
  const files = {};
  if (plan.rollback.collection === "skills") {
    if (!safePath(manifest.path) || !manifest.path.startsWith("skills/") || !manifest.path.endsWith("SKILL.md")) throw new Error("PROMOTION_SKILL_PATH_INVALID");
    if (typeof priorContent !== "string" || `sha256:${sha256(priorContent)}` !== plan.capability.rollbackDigest) throw new Error("PROMOTION_PRIOR_BYTES_MISMATCH");
    files[manifest.path] = priorContent;
    delete manifest.kind;
  } else if (manifest.kind !== "declarative-v1" || capabilityDigest(manifest) !== plan.capability.rollbackDigest) {
    throw new Error("PROMOTION_PRIOR_MANIFEST_MISMATCH");
  }
  const updatedRegistry = { ...clone(registry), [plan.rollback.collection]: registry[plan.rollback.collection].map((entry) => entry.id === plan.capability.id ? manifest : entry) };
  if (!registryValid(updatedRegistry, plan.rollback.collection).ok) throw new Error("PROMOTION_UPDATED_REGISTRY_INVALID");
  files[plan.rollback.registryPath] = `${JSON.stringify(updatedRegistry, null, 2)}\n`;
  return {
    registry: updatedRegistry,
    files,
    changedPaths: Object.keys(files),
    expectedDigest: plan.capability.digest,
    rollbackDigest: plan.capability.rollbackDigest,
  };
}

/** Execute the rollback draft-PR path through injected adapters only. */
export async function executeRollbackTransaction({
  plan,
  health,
  currentEntry,
  registry,
  priorManifest,
  priorContent,
  stateRoot,
  adapters = {},
  runId = "promotion-rollback",
  stateCommit,
} = {}) {
  const rollback = planPostActivationRollback({ plan, health, currentEntry });
  if (!rollback.rollback) return rollback;
  if (!stateRoot) throw new Error("PROMOTION_STATE_REQUIRED");
  const persist = (state, extra = {}) => persistPromotionState(stateRoot, plan, state, {
    ...extra,
    runId,
    stateCommit,
  });
  let transaction = rollback.transaction;
  let mutation;
  try {
    const identity = requireIdentity(await requireAdapter(adapters, "verifyIdentity")({ transaction }));
    const main = await requireAdapter(adapters, "readCurrentMainState")({
      baseRef: transaction.baseRef,
      registryPath: transaction.registryPath,
      collection: transaction.collection,
      id: transaction.id,
    });
    const freshBaseSha = String(main?.baseSha || "").trim().toLowerCase();
    if (!COMMIT_SHA_RE.test(freshBaseSha)) throw new Error("PROMOTION_BASE_SHA_UNVERIFIED");
    if (main?.baseRef !== undefined && main.baseRef !== transaction.baseRef) throw new Error("PROMOTION_BASE_REF_MISMATCH");
    const currentRegistry = main?.registry;
    const currentValidation = registryValid(currentRegistry, transaction.collection);
    if (!currentValidation.ok) throw new Error("PROMOTION_CURRENT_REGISTRY_INVALID");
    const currentPointer = registryEntryFor(currentRegistry, transaction.collection, transaction.id);
    if (!currentPointer || currentPointer.status !== "active" || currentPointer.digest !== plan.capability.digest) {
      throw new Error("PROMOTION_CURRENT_DIGEST_MISMATCH");
    }
    transaction = { ...transaction, baseSha: freshBaseSha };
    mutation = buildRollbackPointerMutation({ plan, registry: currentRegistry, priorManifest, priorContent });
    persist("ROLLBACK_PLANNED", { summary: "post-activation rollback transaction planned", transaction });
    const branchResult = await requireAdapter(adapters, "createBranch")({
      branch: transaction.branch,
      baseRef: transaction.baseRef,
      baseSha: transaction.baseSha,
      force: false,
    });
    if (branchResult?.branch && branchResult.branch !== transaction.branch) throw new Error("PROMOTION_BRANCH_MISMATCH");
    if (branchResult?.forced === true) throw new Error("PROMOTION_FORCE_FORBIDDEN");
    const commitResult = await requireAdapter(adapters, "commit")({
      branch: transaction.branch,
      baseSha: transaction.baseSha,
      files: mutation.files,
      message: `rollback ${plan.capability.kind} ${plan.capability.id}`,
      author: identity.name,
      email: identity.email,
      force: false,
      allowedPaths: mutation.changedPaths,
    });
    const commitSha = String(commitResult?.sha || commitResult?.commitSha || "").trim().toLowerCase();
    if (!COMMIT_SHA_RE.test(commitSha) || commitResult?.forced === true) throw new Error("PROMOTION_COMMIT_UNVERIFIED");
    const pushResult = await requireAdapter(adapters, "push")({ branch: transaction.branch, commitSha, expectedHeadSha: transaction.baseSha, force: false });
    if (pushResult?.forced === true || pushResult?.force === true) throw new Error("PROMOTION_FORCE_FORBIDDEN");
    const pullRequest = await requireAdapter(adapters, "openDraftPullRequest")({
      base: rollback.transaction.pullRequest.base,
      head: transaction.pullRequest.head,
      draft: true,
      title: `Rollback ${plan.capability.id}`,
      body: "Governed pointer rollback plan after candidate health failure.",
    });
    if (!pullRequest || pullRequest.draft !== true || pullRequest.merged === true || pullRequest.autoMerge === true) throw new Error("PROMOTION_DRAFT_PR_UNVERIFIED");
    const artifactRefs = pullRequest.number ? [`pr:${pullRequest.number}`, `commit:${commitSha}`] : [`commit:${commitSha}`];
    persist("ROLLBACK_PR_OPENED", { summary: "draft rollback pull request opened", artifactRefs, transaction });
    return { state: "ROLLBACK_PR_OPENED", branch: transaction.branch, commitSha, pullRequest, mutation };
  } catch (error) {
    persist("ROLLBACK_FAILED", { summary: String(error.message || "rollback failed").slice(0, 200), transaction });
    throw error;
  }
}

export const applyRollbackTransaction = executeRollbackTransaction;

/** Prepare an exact pointer rollback after a candidate-specific health failure. */
export function planPostActivationRollback({ plan, health, currentEntry } = {}) {
  if (!isRecord(plan) || plan.activate !== true || !isRecord(plan.rollback)) throw new Error("PROMOTION_ROLLBACK_PLAN_UNAVAILABLE");
  const healthy = health?.ok === true || ["healthy", "passed", "pass"].includes(String(health?.status || "").toLowerCase());
  if (healthy) return { rollback: false, disposition: "healthy", reasons: [] };
  const currentDigest = currentEntry?.digest || currentEntry?.candidateDigest;
  if (currentDigest !== plan.capability.digest) {
    return { rollback: false, disposition: "blocked", reasons: ["candidate-pointer-mismatch"] };
  }
  return {
    rollback: true,
    disposition: "auto-rollback",
    reasons: ["post-activation-health-failed"],
    transaction: {
      ...plan.rollback,
      expectedDigest: plan.capability.digest,
      candidateDigest: plan.capability.digest,
      rollbackDigest: plan.capability.rollbackDigest,
      force: false,
      author: PROMOTION_ATTRIBUTION.name,
      email: PROMOTION_ATTRIBUTION.email,
      committer: { ...PROMOTION_ATTRIBUTION },
    },
  };
}

export const planRollback = planPostActivationRollback;
export const prepareRollbackPlan = planPostActivationRollback;

function readJson(filePath) {
  const text = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("candidate JSON must be an object");
  return parsed;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    args[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return args;
}

function defaultRegistry(root, kind) {
  const pathName = path.join(root, kind === "skill" ? "config/skills.json" : "config/tools.json");
  return kind === "skill" ? loadSkillRegistry(pathName) : loadToolRegistry(pathName);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.plan && !args.execute) {
    const plan = readJson(path.resolve(String(args.plan)));
    const checked = validatePromotionPlan(plan);
    process.stdout.write(`${JSON.stringify({ ...checked, plan: checked.ok ? plan : undefined })}\n`);
    return checked.ok ? 0 : 1;
  }
  if (args.help || !args.candidate) {
    process.stdout.write("Usage: node scripts/promote-capability.mjs --candidate <json> [--registry <json>] [--state-root <dir>] [--base-sha <sha>] [--plan-only|--execute]\n");
    return args.help ? 0 : 2;
  }
  const candidatePath = path.resolve(String(args.candidate));
  if (!existsSync(candidatePath)) throw new Error("candidate file not found");
  const candidate = readJson(candidatePath);
  const normalized = normalizeCandidateInput(candidate);
  const repoRoot = path.resolve(String(args.root || process.cwd()));
  const registry = ["skill", "declarative-v1"].includes(normalized.kind)
    ? (args.registry
      ? (normalized.kind === "skill" ? loadSkillRegistry(path.resolve(String(args.registry))) : loadToolRegistry(path.resolve(String(args.registry))))
      : defaultRegistry(repoRoot, normalized.kind))
    : {};
  const registryPath = args.registry
    ? path.relative(repoRoot, path.resolve(String(args.registry))) || path.basename(String(args.registry))
    : registryPathFor(normalized.kind);
  const plan = preparePromotion(candidate, {
    registry,
    registryPath,
    root: repoRoot,
    baseSha: args.baseSha || env.GITHUB_SHA,
    trustedJudgeIds: env.FLEET_TRUSTED_JUDGE_IDS ? env.FLEET_TRUSTED_JUDGE_IDS.split(",") : [],
  });
  if (args.execute) {
    if (env.FLEET_PROMOTION_ENABLE !== "true") throw new Error("PROMOTION_GATE_DISABLED");
    const suppliedPlan = args.plan ? readJson(path.resolve(String(args.plan))) : plan;
    const suppliedValidation = validatePromotionPlan(suppliedPlan);
    if (!suppliedValidation.ok) throw new Error(`PROMOTION_PLAN_NOT_ACTIVATABLE: ${suppliedValidation.reasons.join(",")}`);
    if (suppliedPlan.planId !== plan.planId || suppliedPlan.capability?.digest !== plan.capability.digest
      || suppliedPlan.capability?.id !== plan.capability.id || suppliedPlan.transaction?.baseSha !== plan.transaction?.baseSha) {
      throw new Error("PROMOTION_PLAN_CANDIDATE_MISMATCH");
    }
    const stateRoot = args.stateRoot ? path.resolve(String(args.stateRoot)) : "";
    if (!stateRoot) throw new Error("PROMOTION_STATE_REQUIRED");
    const adapters = createGitHubPromotionAdapters({
      env,
      repository: env.FLEET_PROMOTION_REPO || "M1Vj/fleet-runtime",
    });
    const stateCommit = ({ stateRoot: root, event }) => commitPromotionState({ stateRoot: root, event, env });
    const result = await executePromotionTransaction({
      plan: suppliedPlan,
      registry,
      candidate,
      candidateManifest: normalized.manifest,
      candidateContent: typeof candidate.content === "string" ? candidate.content : candidate.text,
      stateRoot,
      adapters,
      stateCommit,
      runId: env.GITHUB_RUN_ID || "promotion-cli",
    });
    process.stdout.write(`${JSON.stringify({
      state: result.state,
      branch: result.branch,
      commitSha: result.commitSha,
      pullRequest: result.pullRequest,
    })}\n`);
    return 0;
  }
  if (args.stateRoot) {
    const stateRoot = path.resolve(String(args.stateRoot));
    appendPromotionEvent(promotionStatePath(stateRoot), normalizePromotionEvent({
      runId: env.GITHUB_RUN_ID || "promotion-cli",
      state: plan.activate ? "ACTIVATION_PLANNED" : plan.disposition === "owner-review" ? "OWNER_REVIEW_REQUIRED" : "CANDIDATE_BLOCKED",
      capabilityId: plan.capability.id,
      capabilityKind: plan.capability.kind,
      candidateDigest: plan.capability.digest,
      rollbackDigest: plan.capability.rollbackDigest,
      registryPath: plan.transaction?.registryPath || registryPath,
      disposition: plan.disposition,
      reasons: plan.reasons,
      changedPaths: plan.evidence.changedPaths,
      judgeIds: plan.evidence.judgeIds,
      fixtureIds: plan.evidence.fixtureIds,
      canaryId: plan.evidence.canaryId,
      summary: plan.activate ? "activation plan prepared" : "promotion candidate requires review or remains blocked",
      transaction: plan.transaction,
    }));
  }
  process.stdout.write(`${JSON.stringify(plan)}\n`);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${String(error.message || error)}\n`);
    process.exitCode = 1;
  });
}

export { containsSecretLike, PROTECTED_PATH_PATTERNS, DIGEST_RE };
