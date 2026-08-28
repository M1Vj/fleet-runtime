import { buildFailureFingerprint, planResearchEscalation } from "./research-escalation.mjs";

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
