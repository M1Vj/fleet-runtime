/**
 * Drop-before-dispatch admission for the single-runner fleet (root decision D4).
 *
 * `watchdog-admission.mjs` owns the *decision* and is pure. This module owns the
 * *choke point*: `dispatchGuarded()` is the only sanctioned way for a dispatcher
 * to enqueue work onto the fleet's one physical runner. It gathers a bounded
 * occupancy observation, asks the pure planner, and on a deferral records a
 * truthful NO-OP in the surfaces the controller already maintains before the
 * dispatch would have happened.
 *
 * Two invariants are structural, not conventional:
 *
 *   1. DROP BEFORE DISPATCH. A deferral returns without ever calling the
 *      caller's dispatch function, so the run is never created and therefore can
 *      never hold a concurrency group or be cancelled. Admission is the opposite
 *      of cancellation: it prevents the pending run from existing at all.
 *   2. NEVER CANCEL. This module exposes no cancellation capability of any kind.
 *      An already-dispatched run is none of its business; per D4 the fleet stops
 *      *creating* work it cannot execute and leaves in-flight work alone.
 *
 * This module compiles in no private identity and imports nothing
 * repo-specific. The repositories that share the one runner are supplied by the
 * caller, which resolves them from the environment exactly as the rest of the
 * controller does; every side effect (occupancy read, ledger append, terminal
 * event, audit note, dispatch) is injected, so the gate is testable without a
 * token, a runner, or a clock. tests/dispatch-admission.test.mjs exercises it
 * directly.
 */

import {
  DISPATCH_DECISIONS,
  DISPATCH_REASONS,
  admissionLedgerKey,
  admissionRecord,
  planDispatch,
} from "./watchdog-admission.mjs";

export const RUNTIME_REPOSITORY = "M1Vj/fleet-runtime";

/** Canonical audit/ledger discriminator, shared with the tests. */
export const ADMISSION_GUARD = "dispatch-admission";

/**
 * Refusals issued by the choke point itself, before any occupancy read.
 *
 * These are not deferrals and carry no occupancy claim: the gate refused because
 * it could not establish which runner the dispatch would land on, not because it
 * observed that runner to be busy. They are kept out of `DISPATCH_REASONS`
 * because that vocabulary is the planner's -- every code in it is a decision made
 * against an observation -- so an operator reading a ledger can tell "we looked
 * and it was busy" apart from "we refused to look".
 */
export const ADMISSION_REFUSALS = Object.freeze({
  unresolvedContendedRepository: "contended_repository_unresolved",
});

/**
 * Whether a dispatch into `targetRepository` would occupy the one physical
 * self-hosted runner.
 *
 * Only the control repository schedules its operational workflows onto
 * `runs-on: [self-hosted, linux, x64, fleet-runner]`; this repository's own
 * workflows run on GitHub-hosted `ubuntu-latest` and do not contend for that
 * slice. Contention is therefore decided by comparing the dispatch target with
 * the control repository the caller resolved from `FLEET_CONTROL_REPOSITORY` --
 * the private identity is never compiled in, and a caller cannot opt itself out
 * by passing a flag, because the only input is the repository it is about to
 * dispatch into.
 *
 * An unresolved control repository cannot be compared, so `dispatchGuarded()`
 * refuses before it ever consults this function. This predicate only ever
 * answers "does this dispatch target contend with the runner", and it may only
 * be asked that question about a repository the caller actually resolved.
 */
export function repositoryOccupiesRunner(targetRepository, contendedRepository) {
  const target = String(targetRepository ?? "").trim().toLowerCase();
  const contended = String(contendedRepository ?? "").trim().toLowerCase();
  if (!target || !contended) return false;
  return target === contended;
}

/** Canonical refusal code for an admission decision taken without a resolved
 *  contended repository. It is not one of the planner's reason codes because the
 *  planner is never reached: the run's occupancy was never observed, so there is
 *  no observation to reason about. */
export const UNRESOLVED_CONTENTION_REASON = "contended_repository_unresolved";


function noAdmissionOutcome(duty, repo, workflow) {
  return {
    dispatch: true,
    contended: false,
    ungated: true,
    plan: null,
    record: null,
    duplicate: false,
    reason: null,
    duty: duty ?? "",
    repo: repo ?? "",
    workflow: workflow ?? "",
    result: undefined,
  };
}

/**
 * The refusal issued when the contended repository is unresolved.
 *
 * Contention is decided by comparing the dispatch target against one resolved
 * repository. With that repository blank there is no answer to the only question
 * this module asks, so the gate refuses instead of assuming the target does not
 * contend: an unset, empty or misspelled `FLEET_CONTROL_REPOSITORY` would
 * otherwise return every duty ungated and put a real run on a runner whose state
 * nobody established. Refusing costs a cycle; admitting blind costs a queued run
 * that competes with and can cancel the run already waiting.
 *
 * It is a refusal rather than a deferral because there is no occupancy
 * observation to report: nothing was read, so no occupancy claim is made and no
 * deferral chain is advanced on a fiction. The refused duty is re-decided on the
 * next cycle, once the caller can resolve the contended repository again.
 */
function unresolvedContentionOutcome(duty, repo, workflow, audit) {
  const reason = "contended repository unresolved; refusing rather than dispatching onto an unverified runner";
  if (audit && typeof audit.note === "function") {
    audit.note(ADMISSION_GUARD, `refused before dispatch: ${reason}`);
  }
  return {
    dispatch: false,
    contended: false,
    ungated: false,
    unresolved: true,
    plan: null,
    record: null,
    duplicate: false,
    reason: ADMISSION_REFUSALS.unresolvedContendedRepository,
    duty: duty ?? "",
    repo: repo ?? "",
    workflow: workflow ?? "",
    result: undefined,
  };
}

/**
 * Build an admission gate.
 *
 * @param {object} deps
 * @param {() => {runs?: any[], unknownRepos?: string[]}} [deps.observe]
 *   Bounded occupancy read across the repositories the caller contends for.
 *   Called at most once per
 *   gate so several duties decided in one cycle share one observation and one
 *   `now`, which is what makes the deferral chain and the per-cycle ledger key
 *   agree across duties.
 * @param {() => any[]} [deps.loadHistory] Prior admission records (deferral chain).
 * @param {() => any} [deps.loadLedger] Ledger `seen` map, for per-cycle dedupe.
 * @param {(key: string, meta: object) => void} [deps.appendLedger]
 * @param {(seen: any, key: string) => boolean} [deps.hasLedger]
 * @param {{note(kind: string, text: string): void}} [deps.audit]
 * @param {(event: string, payload: object) => void} [deps.terminal]
 * @param {object} [deps.limits] Overrides for DEFAULT_ADMISSION_LIMITS.
 * @param {() => number} [deps.clock]
 * @param {string} [deps.contendedRepository] The control repository resolved
 *   from the environment; a dispatch into any other repository is ungated.
 * @param {{id: string, repo?: string}} [deps.selfRun] The run performing the
 *   observation, so a duty is never deferred by the run that is deferring it.
 */
export function createAdmissionGate(deps = {}) {
  const {
    observe,
    loadHistory,
    loadLedger,
    appendLedger,
    hasLedger,
    audit = null,
    terminal = null,
    limits,
    clock = () => Date.now(),
    contendedRepository = null,
    selfRun: observedSelfRun = null,
  } = deps;

  // Resolved once, at construction. A blank or whitespace-only value means the
  // caller could not name the repository that contends for the one runner, and
  // that is a refusal for every duty rather than a licence for all of them.
  const contended = String(contendedRepository ?? "").trim();

  let observationCache = null;
  let ledgerCache = null;

  function observation() {
    if (observationCache === null) {
      const raw = typeof observe === "function" ? observe() : observe;
      observationCache = {
        runs: Array.isArray(raw?.runs) ? raw.runs : [],
        unknownRepos: Array.isArray(raw?.unknownRepos) ? raw.unknownRepos : Array.isArray(raw?.unknown) ? raw.unknown : [],
      };
    }
    return observationCache;
  }

  function seen() {
    if (ledgerCache === null) ledgerCache = typeof loadLedger === "function" ? loadLedger() : {};
    return ledgerCache;
  }

  /**
   * Fold a just-appended key back into the cached ledger.
   *
   * `appendLedger` is durable -- it writes the row -- but the snapshot `seen()`
   * dedupes against is taken once and never refreshed. Without this, a second
   * admission for the same key inside one cycle consults a pre-append map, misses
   * the row the gate itself just wrote, and charges one real dispatch twice: the
   * duplicate row then terminates a deferral chain that is still live, and
   * `duplicate: true` is never reported to the caller. `loadLedger` is re-read
   * where it is available so the cache tracks the durable ledger, and the key is
   * asserted into the result so an injected loader that returns a fixed snapshot
   * still dedupes.
   */
  function seenAfterAppend(key) {
    const reloaded = typeof loadLedger === "function" ? loadLedger() : ledgerCache;
    const current = reloaded == null ? ledgerCache : reloaded;
    if (current && typeof current.add === "function") {
      current.add(key);
      return current;
    }
    if (current && typeof current === "object") {
      current[key] = true;
      return current;
    }
    return new Set([key]);
  }

  /**
   * Decide, and record a deferral. Returns `{ dispatch, plan, record }`.
   * Never dispatches and never cancels.
   */
  function admit(input = {}) {
    const { duty = "", repo = "", workflow = "" } = input;
    if (!contended) return unresolvedContentionOutcome(duty, repo, workflow, audit);
    if (!repositoryOccupiesRunner(repo, contended)) return noAdmissionOutcome(duty, repo, workflow);

    const now = input.now === undefined ? clock() : input.now;
    const observed = input.runs ? { runs: input.runs, unknownRepos: input.unknownRepos || [] } : observation();
    const history = input.history || (typeof loadHistory === "function" ? loadHistory() : []);
    const selfRun = input.selfRun === undefined ? observedSelfRun : input.selfRun;

    const plan = planDispatch({ duty, repo, workflow, runs: observed.runs, unknownRepos: observed.unknownRepos, history, limits, now, selfRun });
    const record = admissionRecord(plan, now);
    const key = admissionLedgerKey(plan, now);

    let duplicate = false;
    if (typeof hasLedger !== "function" || !hasLedger(seen(), key)) {
      // Both decisions are recorded, not just deferrals. The deferral chain is
      // reconstructed from this ledger, so a dispatch has to appear in it too:
      // otherwise a chain that reached the starvation bound is never terminated
      // and the gate force-dispatches on every subsequent cycle forever, which
      // is precisely the un-executable work D4 exists to prevent.
      if (typeof appendLedger === "function") {
        appendLedger(key, { admission: true, ...record });
        ledgerCache = seenAfterAppend(key);
      }
      if (plan.decision === DISPATCH_DECISIONS.DEFER) {
        if (typeof terminal === "function") {
          terminal("NO-OP", {
            reason: plan.reasonCode,
            admission: ADMISSION_GUARD,
            duty: plan.duty,
            repo: plan.repo,
            workflow: plan.workflow,
            occupancy: plan.occupancy,
          });
        }
        if (audit && typeof audit.note === "function") {
          audit.note(ADMISSION_GUARD, `${plan.duty} deferred before dispatch: ${plan.reason}`);
        }
      }
    } else {
      duplicate = true;
    }

    return {
      // A duplicate is already admitted for this duty/repo/workflow/cycle, so the
      // run it named is either in flight or was never created. Dispatching the
      // thunk again would create a second real run for one admission decision --
      // two pending runs contend for the single runner slot, and the pending
      // sibling of a live same-purpose run is exactly what `planDispatch` refuses
      // to create. The ledger row is the admission; a duplicate re-admission is
      // not a second one.
      dispatch: plan.decision === DISPATCH_DECISIONS.DISPATCH && !duplicate,
      contended: true,
      ungated: false,
      plan,
      record,
      duplicate,
      reason: duplicate ? DISPATCH_REASONS.DUPLICATE_ADMISSION : plan.reasonCode,
      duty: plan.duty,
      repo: plan.repo,
      workflow: plan.workflow,
      result: undefined,
    };
  }

  /**
   * The choke point. `dispatchFn` is invoked exactly when admission says the
   * fleet can execute the run, and never otherwise. Returns the admission
   * outcome with the dispatch result attached.
   */
  function dispatchGuarded(input, dispatchFn) {
    const outcome = admit(input);
    if (!outcome.dispatch) return outcome;
    outcome.result = typeof dispatchFn === "function" ? dispatchFn(outcome) : undefined;
    return outcome;
  }

  /** Drop the cached observation so a new cycle re-reads the runner. */
  function reset() {
    observationCache = null;
    ledgerCache = null;
  }

  return { admit, dispatchGuarded, reset, observation };
}