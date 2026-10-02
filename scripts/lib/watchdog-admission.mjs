/**
 * Pure dispatch-admission decisions for the single-runner control plane.
 *
 * The fleet executes on exactly one physical self-hosted runner, so every
 * dispatched workflow run competes for the same 1 vCPU / 1 GiB slice. Measured
 * on 2026-10-02 (council loop 1): 51 of 100 sampled runs never started a job,
 * p90 queue wait 11.3 min, arrivals every ~10.7 min against a 15-19 min
 * observed service time. Offered load is therefore 1.40-1.78 against a
 * capacity of 1.0, and because a run holds its GitHub concurrency group from
 * *creation* (not from start) every new arrival cancels the pending sibling it
 * was queued behind. Admission therefore has to drop work before dispatch
 * rather than let the queue absorb it.
 *
 * This module has no process, network, clock, filesystem, or durable-state
 * access. Callers supply a bounded observation of live/queued runs and an
 * explicit `now`, and own every side effect. It never proposes cancelling a
 * run: an already-dispatched run is left alone, per D4.
 */

export const DISPATCH_DECISIONS = Object.freeze({
  DISPATCH: "dispatch",
  DEFER: "defer",
});

export const DISPATCH_REASONS = Object.freeze({
  RUNNER_IDLE: "runner_idle",
  SAME_PURPOSE_LIVE: "same_purpose_live",
  SAME_PURPOSE_QUEUED: "same_purpose_queued",
  RUNNER_OCCUPIED: "runner_occupied",
  RUNNER_SATURATED: "runner_saturated",
  OBSERVATION_UNAVAILABLE: "observation_unavailable",
  STARVATION_COUNT_BOUND: "starvation_count_bound",
  STARVATION_AGE_BOUND: "starvation_age_bound",
  DUPLICATE_ADMISSION: "duplicate_admission",
});

/**
 * Limits are measured data, not host probes. Patrol runs on a 20-minute cron
 * (`3,23,43 * * * *`), so `cycleMs` is the deferral-chain granularity used to
 * make ledger keys idempotent within a cycle.
 */
export const DEFAULT_ADMISSION_LIMITS = Object.freeze({
  runnerSlots: 1,
  cycleMs: 20 * 60 * 1000,
  arrivalIntervalMinutes: 10.7,
  serviceTimeMinutesMin: 15,
  serviceTimeMinutesMax: 19,
  observedQueueWaitP90Minutes: 11.3,
  // 3 deferred cycles x 20 min = 60 min of waiting, and 45 min is 2.4x the
  // worst observed service time, so a deferral chain can never outlast one
  // full service window plus margin.
  maxConsecutiveDefers: 3,
  starvationMs: 45 * 60 * 1000,
});

const ACTIVE_STATUSES = new Set([
  "in_progress",
  "queued",
  "waiting",
  "pending",
  "requested",
  "in progress",
]);

function finiteNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value.trim());
  return Number.isNaN(parsed) ? null : parsed;
}

export function canonicalDispatchStatus(value) {
  const text = String(value ?? "").trim().toLowerCase().replaceAll("-", "_");
  if (text === "in_progress" || text === "in progress") return "in_progress";
  if (text === "queued" || text === "waiting" || text === "pending" || text === "requested") return "queued";
  return text || "unknown";
}

export function isActiveRun(run) {
  if (!run || typeof run !== "object") return false;
  return ACTIVE_STATUSES.has(canonicalDispatchStatus(run.status ?? run.conclusion ?? run.state));
}

/**
 * Normalize the identity of the run that is performing the observation.
 *
 * A dispatcher cannot observe its own in-flight run as occupancy: the watchdog
 * or patrol run doing the reading is itself occupying the one runner, so
 * counting it makes every duty look busy and publishes a false `runner_occupied`
 * or `same_purpose_live` reason instead of the truth (the runner is idle once
 * this cycle's own run is discounted).
 *
 * Only an exact id match excludes a run, and only when the repository agrees
 * when both sides know it. An observation that cannot name itself excludes
 * nothing, because over-excluding occupancy is exactly the blind dispatch the
 * unobserved-state guard exists to prevent.
 */
export function normalizeSelfRun(selfRun) {
  if (!selfRun || typeof selfRun !== "object") return null;
  const id = String(selfRun.id ?? selfRun.runId ?? selfRun.run_id ?? "").trim();
  const repo = String(selfRun.repo ?? selfRun.repository ?? "").trim().toLowerCase();
  if (!id) return null;
  return Object.freeze({ id, repo: repo || null });
}

/**
 * The run that is asking, taken from the two values GitHub injects into every
 * workflow step: `GITHUB_RUN_ID` and `GITHUB_REPOSITORY`. Pure string handling -
 * an absent or unparseable run id yields `null`, which excludes nothing, so a
 * dispatcher that cannot identify itself keeps the safe (deferring) behaviour.
 */
export function selfRunFromEnv(env = {}) {
  const id = String(env?.GITHUB_RUN_ID ?? "").trim();
  if (!id) return null;
  return normalizeSelfRun({ id, repo: env?.GITHUB_REPOSITORY });
}

export function isSelfRun(run, selfRun) {
  const self = normalizeSelfRun(selfRun);
  if (!self) return false;
  if (!run || typeof run !== "object") return false;
  if (String(run.id ?? run.runId ?? run.run_id ?? "").trim() !== self.id) return false;
  const repo = String(run.repo ?? run.repository ?? "").trim().toLowerCase();
  return !(self.repo && repo && repo !== self.repo);
}

/** Drop the observing run itself from an occupancy observation. */
export function excludeSelfRun(runs, selfRun) {
  const list = Array.isArray(runs) ? runs : [];
  if (!normalizeSelfRun(selfRun)) return list;
  return list.filter((run) => !isSelfRun(run, selfRun));
}

/** Stable duty identity: one repo + one workflow file is one purpose. */
export function dutyPurpose(repo, workflow) {
  const r = String(repo ?? "").trim();
  const w = String(workflow ?? "").trim();
  if (!r && !w) return "";
  return `${r}#${w}`;
}

function runPurpose(run) {
  return dutyPurpose(
    run?.repo ?? run?.repository,
    run?.workflowFile ?? run?.workflow ?? run?.workflow_name ?? run?.workflowName ?? run?.name,
  );
}

export function resolveLimits(overrides) {
  if (!overrides || typeof overrides !== "object") return DEFAULT_ADMISSION_LIMITS;
  const merged = { ...DEFAULT_ADMISSION_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    if (key === "maxConsecutiveDefers") {
      const n = finiteNumber(value);
      if (n !== null && n >= 0) merged.maxConsecutiveDefers = Math.floor(n);
      continue;
    }
    if (key === "runnerSlots") {
      const n = finiteNumber(value);
      if (n !== null && n >= 0) merged.runnerSlots = Math.floor(n);
      continue;
    }
    const n = finiteNumber(value);
    if (n !== null && n >= 0) merged[key] = n;
  }
  return Object.freeze(merged);
}

/**
 * Offered load, utilization and net backlog growth for the measured runner.
 * Pure arithmetic over caller-supplied (or default) measurements so the
 * starvation bounds stay auditable.
 */
export function capacityArithmetic(overrides) {
  const limits = resolveLimits(overrides);
  const arrivalMinutes = limits.arrivalIntervalMinutes;
  const serviceMin = limits.serviceTimeMinutesMin;
  const serviceMax = limits.serviceTimeMinutesMax;
  const arrivalPerMinute = arrivalMinutes > 0 ? 1 / arrivalMinutes : null;
  const serviceLowPerMinute = serviceMax > 0 ? 1 / serviceMax : null;
  const serviceHighPerMinute = serviceMin > 0 ? 1 / serviceMin : null;
  const utilization = arrivalPerMinute === null ? null : {
    atBestService: round2(arrivalPerMinute * serviceMax),
    atWorstService: round2(arrivalPerMinute * serviceMin),
  };
  const backlogPerHour = arrivalPerMinute === null ? null : {
    atBestService: round2((arrivalPerMinute - serviceLowPerMinute) * 60),
    atWorstService: round2((arrivalPerMinute - serviceHighPerMinute) * 60),
  };
  return Object.freeze({
    runnerSlots: limits.runnerSlots,
    arrivalIntervalMinutes: arrivalMinutes,
    serviceTimeMinutes: Object.freeze({ min: serviceMin, max: serviceMax }),
    observedQueueWaitP90Minutes: limits.observedQueueWaitP90Minutes,
    arrivalPerMinute: round4(arrivalPerMinute),
    servicePerMinute: Object.freeze({
      atBestService: round4(serviceLowPerMinute),
      atWorstService: round4(serviceHighPerMinute),
    }),
    utilization,
    backlogGrowthPerHour: backlogPerHour,
    maxConsecutiveDefers: limits.maxConsecutiveDefers,
    starvationMs: limits.starvationMs,
    cycleMs: limits.cycleMs,
  });
}

function round2(n) {
  return n === null || n === undefined ? null : Math.round(n * 100) / 100;
}

function round4(n) {
  return n === null || n === undefined ? null : Math.round(n * 10000) / 10000;
}

/** Bucket a timestamp into the patrol cadence so re-evaluation is idempotent. */
export function admissionCycleKey(nowMs, cycleMs = DEFAULT_ADMISSION_LIMITS.cycleMs) {
  const now = finiteNumber(nowMs);
  const width = finiteNumber(cycleMs);
  if (now === null || width === null || width <= 0) return "unknown-cycle";
  return `cycle-${Math.floor(now / width)}`;
}

/**
 * Canonical per-duty admission history: newest record per cycle wins, records
 * without a usable timestamp are ignored, and the order of the input array is
 * irrelevant. Returns records oldest-first.
 */
export function canonicalAdmissionHistory(history, duty) {
  if (!Array.isArray(history)) return [];
  const byCycle = new Map();
  const sequence = [];
  history.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    if (duty && String(entry.duty ?? "") !== String(duty)) return;
    const at = timestampMs(entry.t ?? entry.at ?? entry.deferredAt);
    if (at === null) return;
    const cycle = String(entry.cycle ?? `seq-${index}`);
    const record = {
      duty: String(entry.duty ?? ""),
      cycle,
      at,
      decision: entry.decision === DISPATCH_DECISIONS.DISPATCH ? DISPATCH_DECISIONS.DISPATCH : DISPATCH_DECISIONS.DEFER,
      reason: String(entry.reason ?? entry.reasonCode ?? ""),
    };
    const prior = byCycle.get(cycle);
    if (prior) {
      prior.at = Math.max(prior.at, record.at);
      prior.decision = record.decision;
      prior.reason = record.reason;
      return;
    }
    byCycle.set(cycle, record);
    sequence.push(record);
  });
  sequence.sort((left, right) => (left.at - right.at) || left.cycle.localeCompare(right.cycle));
  return sequence;
}

/**
 * Length of the current unbroken deferral chain for a duty: consecutive defers
 * back to the last dispatch. A dispatch terminates the chain, so a deferral can
 * never be refreshed indefinitely by its own successors.
 */
export function deferralChain(history, duty) {
  const records = canonicalAdmissionHistory(history, duty);
  let consecutiveDefers = 0;
  let chainStartMs = null;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record.decision !== DISPATCH_DECISIONS.DEFER) break;
    consecutiveDefers += 1;
    chainStartMs = record.at;
  }
  return Object.freeze({ consecutiveDefers, chainStartMs, records: Object.freeze(records) });
}

/**
 * The one way a run list is ever read out of a `gh` body.
 *
 * `gh()` resolves to `null` on empty stdout and to the RAW STRING when stdout
 * is not JSON, both at exit 0 -- so an HTML rate-limit page, a proxy error or a
 * truncated response all arrive here looking like "observed, zero runs". A
 * caller that treats that as an empty run list publishes `runner_idle` with
 * `observationKnown: true` and dispatches onto a runner it never saw, which is
 * the fail-open this guards.
 *
 * Occupancy is claimed only when the body genuinely is a run list: a
 * non-array JSON object carrying an array `workflow_runs`. An empty array is a
 * real observation of zero live runs and is accepted; everything else --
 * `null`, a string, a bare array, an object without the key -- is unreadable
 * and must become an entry in `unknownRepos` so `summarizeOccupancy` reports a
 * partial observation and `planDispatch` defers.
 */
export function readRunList(res) {
  if (res === null || typeof res !== "object" || Array.isArray(res)) return null;
  if (!Array.isArray(res.workflow_runs)) return null;
  return res.workflow_runs;
}

/** Bounded view of runner occupancy: live and queued runs across every repo
 *  that shares the one physical runner. `unknownRepos` are repos whose run list
 *  could not be read; any of them makes the observation partial, and a partial
 *  observation is never treated as idle. */
export function summarizeOccupancy(runs, purpose, limits = DEFAULT_ADMISSION_LIMITS, unknownRepos = []) {
  const slots = resolveLimits(limits).runnerSlots;
  const unreadable = Array.isArray(unknownRepos) ? unknownRepos.filter((r) => String(r ?? "").trim()) : [];
  if (!Array.isArray(runs) || unreadable.length > 0) {
    return Object.freeze({
      observed: false,
      partial: Array.isArray(runs),
      unreadableRepos: Object.freeze([...unreadable]),
      live: 0,
      queued: 0,
      samePurposeLive: 0,
      samePurposeQueued: 0,
      runnerSlots: slots,
    });
  }
  let live = 0;
  let queued = 0;
  let samePurposeLive = 0;
  let samePurposeQueued = 0;
  for (const run of runs) {
    if (!isActiveRun(run)) continue;
    const status = canonicalDispatchStatus(run.status ?? run.conclusion ?? run.state);
    const same = purpose ? runPurpose(run) === purpose : false;
    if (status === "in_progress") {
      live += 1;
      if (same) samePurposeLive += 1;
    } else {
      queued += 1;
      if (same) samePurposeQueued += 1;
    }
  }
  return Object.freeze({
    observed: true,
    partial: false,
    unreadableRepos: Object.freeze([]),
    live,
    queued,
    samePurposeLive,
    samePurposeQueued,
    runnerSlots: slots,
  });
}

function decision(defer, { duty, repo, workflow, purpose, reason, reasonCode, occupancy, chain, waitMinutes, boundedBy, limits, nowMs, observationKnown, selfRunsExcluded, cycle }) {
  return Object.freeze({
    duty,
    repo,
    workflow,
    purpose,
    // The per-cycle idempotency key this decision is recorded under, carried on
    // the decision so no caller has to re-derive it from a clock.
    cycle,
    decision: defer ? DISPATCH_DECISIONS.DEFER : DISPATCH_DECISIONS.DISPATCH,
    reasonCode,
    reason,
    observationKnown,
    occupancy,
    // How many of the observed runs were discounted as the observing run's own.
    // Published so an auditor can tell a genuinely idle runner from one that
    // only looked busy, which is the difference between a truthful occupancy
    // reading and a false deferral.
    selfRunsExcluded: selfRunsExcluded ?? 0,
    consecutiveDefers: chain.consecutiveDefers,
    deferredSince: chain.chainStartMs === null ? null : new Date(chain.chainStartMs).toISOString(),
    waitMinutes,
    starvation: Object.freeze({
      maxConsecutiveDefers: limits.maxConsecutiveDefers,
      starvationMs: limits.starvationMs,
      boundedBy: boundedBy ?? null,
    }),
    cancel: false,
    nowMs: nowMs,
    now: new Date(nowMs).toISOString(),
  });
}

/**
 * Decide whether a duty may be dispatched now.
 *
 * Returns DISPATCH or DEFER plus a reason code. Never returns a cancel: an
 * already-dispatched run is never touched, only new dispatch is suppressed.
 *
 * The two evidence classes are treated in opposite directions, and never
 * interchangeably:
 *
 *   - Occupancy that could NOT be read is deferred indefinitely. The bounds are
 *     not consulted at all, because an unknown runner state is the one case a
 *     bound must never talk past: forcing here would put a run on a runner that
 *     may well be busy, on the strength of evidence that does not exist.
 *   - Occupancy that DID read as busy is subject to the bounds. The bound is the
 *     anti-starvation backstop, and the duty is re-decided every cycle regardless,
 *     so a chain that is being deferred against evidence it can see terminates
 *     instead of starving forever.
 *
 * Either way a bound is only ever applied to a state that was positively
 * observed, so "we know it is busy" and "we could not find out" never share a
 * path. A duty deferred while the runner is busy or unreadable is not lost: it is
 * re-decided every cycle and dispatches the moment the runner is idle.
 *
 * `selfRun` is `{ id, repo }` - exactly the values GitHub exposes to a workflow
 * as `GITHUB_RUN_ID` and `GITHUB_REPOSITORY`. The observing run is not occupancy:
 * a dispatcher that counted its own in-flight run reported the runner busy for
 * every duty and published a false `runner_occupied` reason while the runner was
 * idle.
 */
export function planDispatch(input = {}) {
  const now = finiteNumber(input.now) ?? finiteNumber(input.nowMs) ?? 0;
  const duty = String(input.duty ?? "").trim();
  const repo = String(input.repo ?? "").trim();
  const workflow = String(input.workflow ?? "").trim();
  const purpose = String(input.purpose ?? dutyPurpose(repo, workflow) ?? "").trim();
  const limits = resolveLimits(input.limits);
  const selfRun = normalizeSelfRun(input.selfRun);
  const rawRuns = input.runs;
  const countedRuns = excludeSelfRun(rawRuns, selfRun);
  const occupancy = summarizeOccupancy(countedRuns, purpose, limits, input.unknownRepos);
  const chain = deferralChain(input.history, duty);
  const waitMinutes = chain.chainStartMs === null ? null : round2((now - chain.chainStartMs) / 60000);
  const base = {
    duty,
    repo,
    workflow,
    purpose,
    occupancy,
    chain,
    waitMinutes,
    limits,
    selfRun,
    selfRunsExcluded: Array.isArray(rawRuns) ? rawRuns.length - countedRuns.length : 0,
    cycle: admissionCycleKey(now, limits.cycleMs),
    nowMs: now,
    observationKnown: occupancy.observed,
  };

  const blocked = deferReason(occupancy, limits);
  if (!blocked) {
    // An idle runner needs no starvation override at all: the honest reason for
    // this dispatch is that the slot is free, and labelling it a bound would put
    // a claim in the audit record that is not true of this decision.
    return decision(false, {
      ...base,
      reasonCode: DISPATCH_REASONS.RUNNER_IDLE,
      reason: `runner idle: ${occupancy.live} live, ${occupancy.queued} queued`,
      boundedBy: null,
    });
  }

  // Fail closed on an unreadable observation. This check deliberately precedes
  // the starvation bound: a long deferral chain says nothing about the runner,
  // so forcing on it is the one overcommit this module exists to prevent. An
  // unreadable repository therefore defers past the bound indefinitely and
  // publishes that it did, rather than force-dispatching an unknown state.
  if (blocked.reasonCode === DISPATCH_REASONS.OBSERVATION_UNAVAILABLE) {
    return decision(true, { ...base, reasonCode: blocked.reasonCode, reason: blocked.reason, boundedBy: null });
  }

  // Occupancy here was read successfully and reports the runner busy. That is a
  // known, observed state, so the starvation bound applies to it: the bounds are
  // the backstop against a chain that would otherwise never resolve, and the
  // forced dispatch publishes the bound as its reason instead of claiming the
  // runner is free.
  const forced = starvationOverride(chain, waitMinutes, limits);
  if (forced) {
    return decision(false, {
      ...base,
      reasonCode: forced.reasonCode,
      reason: forced.reason,
      boundedBy: forced.boundedBy,
    });
  }

  return decision(true, { ...base, reasonCode: blocked.reasonCode, reason: blocked.reason, boundedBy: null });
}

function deferReason(occupancy, limits) {
  if (!occupancy.observed) {
    const unreadable = occupancy.unreadableRepos.length > 0 ? occupancy.unreadableRepos.join(", ") : "the runner";
    return {
      reasonCode: DISPATCH_REASONS.OBSERVATION_UNAVAILABLE,
      reason: `runner occupancy only partially observed (unreadable: ${unreadable}); not dispatching blind`,
    };
  }
  if (occupancy.samePurposeLive > 0) {
    return {
      reasonCode: DISPATCH_REASONS.SAME_PURPOSE_LIVE,
      reason: `${occupancy.samePurposeLive} run of this workflow already in progress`,
    };
  }
  if (occupancy.samePurposeQueued > 0) {
    return {
      reasonCode: DISPATCH_REASONS.SAME_PURPOSE_QUEUED,
      reason: `${occupancy.samePurposeQueued} run of this workflow already queued; a new arrival would cancel the pending sibling`,
    };
  }
  if (occupancy.live >= limits.runnerSlots) {
    return {
      reasonCode: occupancy.queued > 0 ? DISPATCH_REASONS.RUNNER_SATURATED : DISPATCH_REASONS.RUNNER_OCCUPIED,
      reason: `all ${limits.runnerSlots} runner slot(s) busy (${occupancy.live} live, ${occupancy.queued} queued)`,
    };
  }
  return null;
}

/**
 * A deferred duty is forced through once its chain is long enough that waiting
 * costs more than queueing does. Count and age bounds are independent so one
 * can fire without the other.
 */
function starvationOverride(chain, waitMinutes, limits) {
  if (chain.chainStartMs === null) return null;
  if (limits.maxConsecutiveDefers > 0 && chain.consecutiveDefers >= limits.maxConsecutiveDefers) {
    return {
      boundedBy: "count",
      reasonCode: DISPATCH_REASONS.STARVATION_COUNT_BOUND,
      reason: `starvation bound: ${chain.consecutiveDefers} consecutive defers (max ${limits.maxConsecutiveDefers}); dispatching anyway`,
    };
  }
  if (limits.starvationMs > 0 && waitMinutes !== null && waitMinutes * 60000 >= limits.starvationMs) {
    return {
      boundedBy: "age",
      reasonCode: DISPATCH_REASONS.STARVATION_AGE_BOUND,
      reason: `starvation bound: deferred ${waitMinutes} min (max ${round2(limits.starvationMs / 60000)} min); dispatching anyway`,
    };
  }
  return null;
}

/**
 * Apply a decision to the admission history, producing the next history plus
 * the record to persist. Returns null for the record when the decision is
 * DISPATCH so a dispatch never rewrites its own chain.
 */
export function nextAdmissionHistory(history, { duty, decision: verdict, reason, reasonCode, now, limits }) {
  const resolved = resolveLimits(limits);
  const nowMs = finiteNumber(now) ?? 0;
  const prior = canonicalAdmissionHistory(history, duty);
  if (verdict !== DISPATCH_DECISIONS.DEFER) {
    return { history: prior, record: null };
  }
  const cycle = admissionCycleKey(nowMs, resolved.cycleMs);
  const existing = prior.find((entry) => entry.cycle === cycle);
  if (existing) {
    return {
      history: prior,
      record: { duty, cycle, t: new Date(existing.at).toISOString(), decision: DISPATCH_DECISIONS.DEFER, reason: existing.reason || (reason ?? reasonCode ?? "") },
      duplicate: true,
    };
  }
  const reasonText = reason ?? reasonCode ?? "";
  const record = { duty, cycle, t: new Date(nowMs).toISOString(), decision: DISPATCH_DECISIONS.DEFER, reason: reasonText };
  return { history: [...prior, { duty, cycle, at: nowMs, decision: DISPATCH_DECISIONS.DEFER, reason: reasonText }], record };
}

/** Ledger key material for a persisted admission record; stable per duty+cycle. */
export function admissionEventMaterial(duty, cycle, repo) {
  return `dispatch-admission|${repo ?? ""}|${duty}|${cycle}`;
}

/** Idempotence key: the same duty decided in the same cycle is one ledger line. */
export function admissionLedgerKey(plan, nowMs) {
  const at = planNowMs(plan, nowMs);
  return admissionEventMaterial(plan?.duty, plan?.cycle ?? admissionCycleKey(at), plan?.repo);
}

function planNowMs(plan, fallback) {
  return finiteNumber(plan?.nowMs)
    ?? timestampMs(plan?.now)
    ?? finiteNumber(fallback)
    ?? 0;
}

/**
 * Flat, persistable shape of a plan decision. `decidedAt` is derived from the
 * plan's own `now`, so the record is reproducible in a test.
 */
export function admissionRecord(plan, nowMs) {
  const at = planNowMs(plan, nowMs);
  return {
    duty: plan?.duty ?? "",
    cycle: plan?.cycle ?? admissionCycleKey(at),
    decidedAt: new Date(at).toISOString(),
    decision: plan?.decision ?? DISPATCH_DECISIONS.DEFER,
    reason: plan?.reason ?? "",
    reasonCode: plan?.reasonCode ?? DISPATCH_REASONS.OBSERVATION_UNAVAILABLE,
    // `t` is the epoch-ms field every ledger record in this repo carries and the
    // field canonicalAdmissionHistory() reads back, so a persisted deferral is
    // what actually reconstructs the chain on the next cycle. Omitting it makes
    // the starvation bound unreachable.
    t: at,
    // Persisted so the recorded occupancy reading can be re-derived later.
    selfRunsExcluded: Number.isFinite(plan?.selfRunsExcluded) ? plan.selfRunsExcluded : 0,
  };
}
