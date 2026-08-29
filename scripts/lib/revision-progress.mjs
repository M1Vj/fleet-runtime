import { buildFailureFingerprint, planResearchEscalation } from "./research-escalation.mjs";
import { createHash } from "node:crypto";

function scoresOf(value) {
  const scores = value && typeof value === "object" && value.judgeScores && typeof value.judgeScores === "object"
    ? value.judgeScores
    : value;
  const correctness = Number(scores?.correctness);
  const standards = Number(scores?.standards);
  return Number.isFinite(correctness) && Number.isFinite(standards)
    ? { correctness, standards }
    : null;
}

export function judgeMinimumScore(value) {
  const scores = scoresOf(value);
  return scores ? Math.min(scores.correctness, scores.standards) : null;
}

export function normalizeJudgeBlockerIds(value) {
  const source = value && typeof value === "object"
    ? (Array.isArray(value.blockerIds) ? value.blockerIds : value.blockers)
    : value;
  return [...new Set((Array.isArray(source) ? source : [])
    .map((item) => String(item ?? "").trim().toLowerCase())
    .filter(Boolean))];
}

/** Compare a new judge result with the latest result from a prior head. */
export function compareJudgeProgress(previous, current) {
  const previousMinimum = judgeMinimumScore(previous);
  const currentMinimum = judgeMinimumScore(current);
  const previousBlockers = normalizeJudgeBlockerIds(previous);
  const currentBlockers = normalizeJudgeBlockerIds(current);
  const hasBaseline = previousMinimum !== null || previousBlockers.length > 0;
  const scoreImproved = previousMinimum !== null && currentMinimum !== null && currentMinimum > previousMinimum;
  const eliminatedBlockers = previousBlockers.filter((id) => !currentBlockers.includes(id));
  const addedBlockers = currentBlockers.filter((id) => !previousBlockers.includes(id));
  // A same-sized swap merely moves the goalposts. Count a blocker as progress
  // only when at least one prior blocker disappears without adding a replacement
  // that keeps the total unchanged; score gains still count independently.
  // A blocker swap at the same cardinality is not progress: it can merely
  // trade one unresolved failure for another. Require a strictly smaller
  // blocker set; a minimum-score increase remains an independent progress
  // signal even when stochastic judges disagree on individual lenses.
  const blockersImproved = eliminatedBlockers.length > 0
    && currentBlockers.length < previousBlockers.length;
  const exactRepeat = hasBaseline
    && previousMinimum !== null
    && currentMinimum !== null
    && currentMinimum === previousMinimum
    && eliminatedBlockers.length === 0
    && addedBlockers.length === 0;
  const regressed = hasBaseline
    && previousMinimum !== null
    && currentMinimum !== null
    && currentMinimum < previousMinimum
    && !blockersImproved;
  return {
    progress: !hasBaseline || scoreImproved || blockersImproved,
    hasBaseline,
    scoreImproved,
    blockersImproved,
    exactRepeat,
    regressed,
    previousMinimum,
    currentMinimum,
    previousBlockers,
    currentBlockers,
    eliminatedBlockers,
    addedBlockers,
  };
}

function telemetryRunId(value) {
  return String(value || "merge-judge").replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 120) || "merge-judge";
}

function telemetryTarget(target = {}) {
  const repo = String(target.repo || "").trim();
  const pr = Number(target.pr);
  const headSha = String(target.headSha || "").trim().toLowerCase();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return {};
  if (!Number.isSafeInteger(pr) || pr < 0) return { repo };
  if (!/^[a-f0-9]{40,64}$/.test(headSha)) return { repo, pr };
  return { repo, pr, headSha };
}

function judgeVerdict(value) {
  if (value?.infrastructureFailure === true || value?.state === "JUDGE_UNAVAILABLE" || value?.verdict === "infrastructure") return "infrastructure";
  if (value?.verdict === "approve" || value?.verdict === "approved" || value?.state === "JUDGE_APPROVED") return "approved";
  return "rejected";
}

function progressKind(comparison) {
  if (!comparison?.hasBaseline) return "baseline";
  if (comparison.progress) return "improved";
  if (comparison.exactRepeat) return "repeat";
  if (comparison.regressed) return "regressed";
  return "unknown";
}

/** Build a strict, redacted judge-progress telemetry envelope. */
export function buildJudgeProgressTelemetry({
  runId,
  target,
  previous,
  current,
  lens = "unknown",
  hold = false,
} = {}) {
  const comparison = compareJudgeProgress(previous, current);
  const targetFields = telemetryTarget(target);
  const currentScore = comparison.currentMinimum;
  const previousScore = comparison.previousMinimum;
  const progress = progressKind(comparison);
  const key = `${telemetryRunId(runId)}|${targetFields.repo || ""}|${targetFields.pr || 0}|${targetFields.headSha || ""}`;
  const event = {
    runId: telemetryRunId(runId),
    correlationId: `corr-${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32)}`,
    lane: "merge",
    event: "judge",
    phase: hold ? "hold" : "progress",
    outcome: hold ? "held" : comparison.progress ? "succeeded" : "held",
    ...targetFields,
    judge: {
      lens: ["correctness", "standards", "unknown"].includes(lens) ? lens : "unknown",
      verdict: judgeVerdict(current),
      score: currentScore === null ? 0 : currentScore,
      blockerCount: comparison.currentBlockers.length,
      progress,
      ...(previousScore === null ? {} : { previousScore }),
      ...(previousScore === null || currentScore === null ? {} : { scoreDelta: currentScore - previousScore }),
      ...(comparison.hasBaseline ? { previousBlockerCount: comparison.previousBlockers.length } : {}),
    },
  };
  if (hold) event.terminal = { state: "NO_PROGRESS" };
  return event;
}

/** Build one bounded private research request for a repeated/regressed cycle. */
export function planNoProgressResearch({ events = [], target = {}, previous, current } = {}) {
  const comparison = compareJudgeProgress(previous, current);
  if (!comparison.hasBaseline) return { request: false, reason: "no-baseline", comparison };
  if (comparison.progress) return { request: false, reason: "progress-observed", comparison };
  const failure = {
    errorClass: "revision-no-progress",
    check: "judge-progress",
    runtime: "fleet-revision",
    message: JSON.stringify({
      previousMinimum: comparison.previousMinimum,
      currentMinimum: comparison.currentMinimum,
      eliminatedBlockers: comparison.eliminatedBlockers,
      addedBlockers: comparison.addedBlockers,
    }),
    hard: true,
    diagnosisConfidence: "low",
  };
  const fingerprint = buildFailureFingerprint(failure);
  const planned = planResearchEscalation({
    events,
    repo: target.repo,
    pr: target.pr,
    headSha: target.headSha,
    failure,
  });
  return { ...planned, comparison, fingerprint, failure };
}
