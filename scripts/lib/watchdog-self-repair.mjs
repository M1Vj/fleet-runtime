/**
 * The watchdog's self-repair path: receipt ledger plus dispatch gate.
 *
 * `self-repair-policy.mjs` is pure and holds every invariant. This module owns the
 * two things the policy deliberately does not: the durable receipt ledger and the
 * side effects. Its contract is the one the old unconditional dispatch broke:
 *
 *   1. A repair dispatch is only ever made through `evaluateSelfRepair`, and a
 *      refusal is never worked around.
  *   2. The receipt is written immediately AFTER the admission gate admits and
  *      the dispatch function returns, and only then, so a deferred or refused
  *      dispatch creates no run and therefore spends no budget. An admitted
  *      dispatch still spends its signature's budget even when the run is later
  *      cancelled or the process crashes after the receipt lands: the cap
  *      survives cancellation because a run that happened must not hand the
  *      same signature a fresh allowance every window.
 *   3. A ledger or occupancy observation that cannot be read refuses the dispatch.
 *      "Cannot prove there is budget" is a refusal, never an empty budget.
 *
 * The receipt ledger is a separate append-only JSONL file rather than a `state`
 * record: the watchdog ledger is keyed for dedupe (`loadLedger` returns keys only)
 * and holds no records, and rewriting it to carry receipts would put repair
 * history on the same file the heartbeat's occupancy gate reads.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  REPAIR_DECISIONS,
  REPAIR_MAX_DISPATCHES_PER_SIGNATURE,
  REPAIR_WINDOW_MINUTES,
  classifyRepairFailures,
  createSelfRepairReceipt,
  evaluateSelfRepair,
  failingSignature,
  normalizeSelfRepairReceipts,
  pruneSelfRepairReceipts,
} from "./self-repair-policy.mjs";

/** Canonical audit discriminator, shared with the tests. */
export const SELF_REPAIR_GUARD = "watchdog-self-repair";

/** Repair workflows the watchdog may answer a failure with, in preference order. */
export const SELF_REPAIR_WORKFLOWS = Object.freeze(["improve.yml", "retro.yml"]);

/**
 * Compaction bound. The receipt ledger is append-only and read on every cron
 * tick, so it is rewritten once it outgrows this many entries; retention
 * (72h in the policy) drops the rest.
 */
export const SELF_REPAIR_RECEIPT_MAX_ENTRIES = 500;

export function selfRepairLedgerPath(stateRoot) {
  return path.join(String(stateRoot ?? ""), "state", "self-repair-receipts.jsonl");
}

/**
 * Read the receipt ledger.
 *
 * A missing file is an empty ledger, not a failure: the first tick on a fresh
 * state root has receipts and nothing else. Any other read error, and an
 * unreadable ledger is what `readable: false` reports — the caller must refuse
 * on it rather than assume the budget is intact.
 */
export function readSelfRepairReceipts(filePath) {
  if (!existsSync(filePath)) return { receipts: [], readable: true };
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    return { receipts: [], readable: false, error: String(err?.message ?? err).slice(0, 160) };
  }
  const records = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === "object") records.push(row);
    } catch {
      continue;
    }
  }
  return { receipts: normalizeSelfRepairReceipts(records), readable: true };
}

export function appendSelfRepairReceipt(filePath, receipt) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(receipt) + "\n");
  return receipt;
}

/**
 * Rewrite the ledger with the pruned set once it outgrows the bound. The rewrite
 * goes through a sibling temp file and a rename so a crash mid-compaction cannot
 * leave a half-written ledger, and a failure here is not fatal: the append-only
 * file stays authoritative and the next tick compacts again.
 */
export function compactSelfRepairLedger(filePath, now = Date.now()) {
  const { receipts, readable } = readSelfRepairReceipts(filePath);
  if (!readable) return false;
  const kept = pruneSelfRepairReceipts(receipts, now);
  if (receipts.length <= SELF_REPAIR_RECEIPT_MAX_ENTRIES && kept.length === receipts.length) return false;
  const temp = `${filePath}.tmp`;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(temp, kept.map((receipt) => JSON.stringify(receipt)).join("\n") + (kept.length ? "\n" : ""));
    renameSync(temp, filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which repository a failure names as its repair target.
 *
 * `improve.yml` and `retro.yml` live in THIS repository, not in the control
 * plane, so the only repository where a repair dispatch can be received and can
 * record a receipt is the runtime repository. The control repository's improve
 * path is `repository_dispatch`-only and the policy refuses it as CONTROL_TARGET,
 * so routing any other failure there guaranteed a refusal: both repair families
 * refused, no receipt was ever written, and every tick re-observed the same
 * failure. The target is therefore the repository that owns the repair workflow.
 *
 * `evaluateSelfRepair` still owns the last word. A failure of the repair workflow
 * itself resolves to the runtime repository too, and the policy refuses that as
 * repair-target-owns-the-failing-repair-workflow, so this mapping cannot become a
 * repair loop pointed at ourselves.
 */
export function selfRepairTargetFor(run, { runtimeRepository = "", controlRepository = "" } = {}) {
  if (String(runtimeRepository ?? "").trim()) return runtimeRepository;
  // No runtime repository configured: fall back to where the failure was seen,
  // then to the control plane, which the policy refuses rather than bypasses.
  if (String(run?.repo ?? "").trim()) return run.repo;
  return controlRepository;
}

/**
 * Build the self-repair dispatcher.
 *
 * Every side effect is injected so the whole gate is testable without a token, a
 * runner, a clock or a network: `admission` supplies the drop-before-dispatch
 * choke point and its occupancy observation, `dispatchWorkflow` performs the
 * `gh workflow run` call, and `audit` receives the truthful NO-OP notes.
 */
export function createSelfRepairDispatcher({
  stateRoot = "",
  admission = null,
  dispatchWorkflow = () => {},
  audit = null,
  controlRepository = "",
  runtimeRepository = "",
  controlRepositories = [],
  owner = "",
  workflows = SELF_REPAIR_WORKFLOWS,
  clock = () => Date.now(),
  receiptPath = null,
} = {}) {
  const ledgerPath = receiptPath ?? selfRepairLedgerPath(stateRoot);
  // Admission already observes the runner, so reuse its observation rather than
  // adding a second API call per tick; the policy refuses when it cannot be read.
  const occupancy = () => {
    const observed = admission?.observation?.();
    if (!observed) return { runs: [], readable: false, reason: "no occupancy observation" };
    const unknown = Array.isArray(observed.unknownRepos) ? observed.unknownRepos : [];
    return { runs: Array.isArray(observed.runs) ? observed.runs : [], readable: unknown.length === 0, unknownRepos: unknown };
  };

  return {
    receiptPath: ledgerPath,

    /**
     * Answer a set of observed failures. Returns one outcome per candidate so the
     * caller can audit refusals and dispatches from the result alone; the return
     * value is also what the tests assert on.
     */
    respondToFailures(failedRuns = []) {
      const now = clock();
      const runs = Array.isArray(failedRuns) ? failedRuns : [];
      const observed = occupancy();
      const { receipts, readable, error } = readSelfRepairReceipts(ledgerPath);
      if (!readable) {
        audit?.note("self-repair", `receipt ledger unreadable (${error}); refusing`);
      }
      // Every workflow candidate for one failure shares that failure's signature,
      // so a receipt written earlier in this same tick has to charge the next
      // candidate too, or one failure buys two dispatches.
      const ledger = [...receipts];

      const { selfDispatched, other } = classifyRepairFailures({ failedRuns: runs, receipts });
      for (const { run, receipt } of selfDispatched) {
        audit?.note("self-repair-echo", `${receipt.workflow} at ${receipt.target} is our own dispatch; not a new defect`);
      }

      const outcomes = [];
      for (const run of other) {
        const target = selfRepairTargetFor(run, { runtimeRepository, controlRepository });
        for (const workflow of workflows) {
          const decision = evaluateSelfRepair({
            failedRun: run,
            workflow,
            target,
            signature: failingSignature(run, target),
            receipts: ledger,
            recentRuns: observed.runs,
            controlRepository,
            controlRepositories,
            owner,
            now,
            ledgerReadable: readable,
            occupancyReadable: observed.readable,
          });

          if (decision.decision !== REPAIR_DECISIONS.REPAIR) {
            audit?.note("self-repair-refusal", `${workflow} at ${target || "unknown"} refused: ${decision.reason}`);
            outcomes.push({ ...decision, failedRun: run, dispatched: false });
            continue;
          }

          // The admission gate decides FIRST: a deferral creates no run, so it
          // must create no receipt either. Charging a deferred repair is the
          // phantom-receipt defect: under saturation every repair defers, every
          // deferral burned the signature's single allowance, and self-repair
          // muted itself while the fleet was busiest. The receipt (durable file
          // and in-memory ledger) is written only after the gate admits and the
          // dispatch function returns, so an admitted dispatch still spends its
          // budget even when the run is later cancelled.
          const guarded = admission?.dispatchGuarded
            ? admission.dispatchGuarded(
                { duty: `self-repair ${workflow} for ${target}`, repo: target, workflow },
                () => dispatchWorkflow(workflow, target),
              )
            : { dispatch: false, reason: "no admission gate" };

          if (!guarded.dispatch) {
            audit?.note("self-repair-deferred", `${workflow} at ${target} ${guarded.reason} (not dispatched)`);
            outcomes.push({
              ...decision,
              failedRun: run,
              dispatched: false,
              admissionReason: guarded.reason ?? null,
            });
            continue;
          }

          const receipt = createSelfRepairReceipt({
            signature: decision.signature,
            target,
            workflow,
            at: now,
            runId: null,
            conclusion: null,
          });
          appendSelfRepairReceipt(ledgerPath, receipt);
          // The in-memory ledger takes the charge too, or the next repair
          // workflow for the same failure would be authorized by a budget
          // already spent.
          ledger.push(receipt);

          outcomes.push({
            ...decision,
            failedRun: run,
            dispatched: true,
            admissionReason: guarded.reason ?? null,
          });
        }
      }

      compactSelfRepairLedger(ledgerPath, now);
      return outcomes;
    },
  };
}

export const SELF_REPAIR_LIMITS = Object.freeze({
  maxDispatchesPerSignature: REPAIR_MAX_DISPATCHES_PER_SIGNATURE,
  windowMinutes: REPAIR_WINDOW_MINUTES,
});
