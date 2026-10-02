import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPAIR_DECISIONS,
  REPAIR_MAX_DISPATCHES_PER_SIGNATURE,
  REPAIR_REFUSALS,
  REPAIR_WINDOW_MINUTES,
  SELF_REPAIR_RECEIPT_VERSION,
  classifyRepairFailures,
  createSelfRepairReceipt,
  evaluateSelfRepair,
  failingSignature,
  matchSelfRepairReceipt,
  normalizeSelfRepairReceipts,
} from "../scripts/lib/self-repair-policy.mjs";
import {
  SELF_REPAIR_GUARD,
  SELF_REPAIR_WORKFLOWS,
  appendSelfRepairReceipt,
  createSelfRepairDispatcher,
  readSelfRepairReceipts,
  selfRepairLedgerPath,
} from "../scripts/lib/watchdog-self-repair.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Fixture identities: the private control repository is resolved from the
// environment at run time and is never compiled into source, so the tests name
// a fixture and never the real one.
const CONTROL = "fixture-owner/control-plane";
const RUNTIME = "fixture-owner/controller";
const OTHER = "other-owner/controller";

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const WINDOW_MS = REPAIR_WINDOW_MINUTES * 60_000;

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-self-repair-"));
  mkdirSync(path.join(dir, "state"), { recursive: true });
  return {
    dir,
    receiptPath: selfRepairLedgerPath(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * A failed workflow run. The fixtures use a runtime control repository so the
 * control-refusal test names the same repository the fleet actually refuses.
 */
function failedRun(overrides = {}) {
  return {
    repo: RUNTIME,
    id: "900",
    workflowFile: "kb.yml",
    name: "kb",
    status: "completed",
    conclusion: "failure",
    createdAt: new Date(NOW - 10 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

function receiptFor(run, overrides = {}) {
  const target = overrides.target ?? run.repo;
  return createSelfRepairReceipt({
    signature: failingSignature(run, target),
    target,
    workflow: "improve.yml",
    at: NOW - 20 * 60_000,
    ...overrides,
  });
}

function repair(overrides = {}) {
  return evaluateSelfRepair({
    failedRun: failedRun(),
    workflow: "improve.yml",
    target: RUNTIME,
    controlRepository: CONTROL,
    owner: "fixture-owner",
    now: NOW,
    recentRuns: [],
    receipts: [],
    ...overrides,
  });
}

test("the repair cap is one dispatch per signature over a 360 minute window", () => {
  assert.equal(REPAIR_MAX_DISPATCHES_PER_SIGNATURE, 1);
  assert.equal(REPAIR_WINDOW_MINUTES, 360);
});

test("a second dispatch for the same signature inside the window is refused", () => {
  const run = failedRun();
  const first = repair({ failedRun: run });
  assert.equal(first.decision, REPAIR_DECISIONS.REPAIR);
  assert.equal(first.charged, 0);

  const second = repair({ failedRun: run, receipts: [receiptFor(run)] });
  assert.equal(second.decision, REPAIR_DECISIONS.REFUSE);
  assert.equal(second.reason, REPAIR_REFUSALS.BUDGET);
});

test("the same signature is allowed again once the window has elapsed", () => {
  const run = failedRun();
  const stale = receiptFor(run, { at: NOW - WINDOW_MS - 60_000 });
  const decision = repair({ failedRun: run, receipts: [stale] });
  assert.equal(decision.decision, REPAIR_DECISIONS.REPAIR);
  assert.equal(decision.charged, 0);
});

test("a new failure signature always earns its own allowance", () => {
  const spent = receiptFor(failedRun());
  const other = failedRun({ workflowFile: "thesis.yml", name: "thesis", id: "901" });
  const decision = repair({ failedRun: other, receipts: [spent] });
  assert.equal(decision.decision, REPAIR_DECISIONS.REPAIR);
  assert.equal(decision.signature, failingSignature(other, RUNTIME));
  assert.notEqual(decision.signature, spent.signature);
});

test("a run a receipt explains is not charged a second time", () => {
  const run = failedRun();
  const receipt = receiptFor(run);
  const ledger = normalizeSelfRepairReceipts([receipt]);
  const echo = failedRun({
    repo: RUNTIME,
    id: "1001",
    workflowFile: "improve.yml",
    name: "fleet-improve",
    createdAt: new Date(NOW - 4 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 2 * 60_000).toISOString(),
  });
  assert.equal(matchSelfRepairReceipt(echo, ledger)?.signature, receipt.signature);
  // `run` is deliberately reused as BOTH the trigger and the origin of its own
  // receipt: a double-charge attempt, not a legitimate second failure, so the
  // receipt's charge stands and the answer is REFUSE/BUDGET.
  assert.equal(repair({ failedRun: run, receipts: ledger }).decision, REPAIR_DECISIONS.REFUSE);
});

test("a cancelled repair run does not refund the budget it was charged", () => {
  const run = failedRun();
  const receipt = receiptFor(run);
  const cancelled = failedRun({
    repo: RUNTIME,
    id: "1002",
    workflowFile: "improve.yml",
    name: "fleet-improve",
    conclusion: "cancelled",
    createdAt: new Date(NOW - 3 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 1 * 60_000).toISOString(),
  });
  const classified = classifyRepairFailures({ failedRuns: [cancelled], receipts: [receipt] });
  assert.equal(classified.selfDispatched.length, 1);
  assert.equal(classified.other.length, 0);
  // The dispatch is still spent: the refund path does not exist.
  assert.equal(repair({ failedRun: run, receipts: [receipt] }).decision, REPAIR_DECISIONS.REFUSE);
});

test("a repair workflow is never dispatched at a target whose own repair workflow failed", () => {
  const run = failedRun({ repo: RUNTIME, workflowFile: "retro.yml", name: "fleet-retro" });
  const decision = repair({
    failedRun: run,
    workflow: "retro.yml",
    target: RUNTIME,
    failureRepository: RUNTIME,
  });
  assert.equal(decision.decision, REPAIR_DECISIONS.REFUSE);
  assert.match(decision.reason, /^repair-target-owns-the-failing-repair-workflow/);
});

test("a repair workflow is never dispatched at the control repository", () => {
  const decision = repair({ target: CONTROL });
  assert.equal(decision.decision, REPAIR_DECISIONS.REFUSE);
  assert.equal(decision.reason, REPAIR_REFUSALS.CONTROL_TARGET);
});

test("a repair workflow is never dispatched at a foreign owner", () => {
  const decision = repair({ target: OTHER });
  assert.equal(decision.decision, REPAIR_DECISIONS.REFUSE);
  assert.match(decision.reason, /^foreign-repo-target/);
});

test("a repair workflow is never dispatched with a repo input", () => {
  const decision = repair({ inputs: { repo: RUNTIME } });
  assert.equal(decision.decision, REPAIR_DECISIONS.REFUSE);
  assert.match(decision.reason, /^undeclared-workflow-input/);
});

test("an unreadable ledger or occupancy observation refuses rather than assuming budget", () => {
  assert.equal(repair({ ledgerReadable: false }).reason, REPAIR_REFUSALS.LEDGER_UNREADABLE);
  assert.equal(repair({ occupancyReadable: false }).reason, REPAIR_REFUSALS.OCCUPANCY_UNREADABLE);
  // Both refusals stand in for a budget that cannot be proven to be spent or free.
  for (const decision of [repair({ ledgerReadable: false }), repair({ occupancyReadable: false })]) {
    assert.equal(decision.decision, REPAIR_DECISIONS.REFUSE);
    assert.equal(decision.charged, undefined);
  }
});

test("a cancelled failure is not a defect and is never repaired", () => {
  const decision = repair({ failedRun: failedRun({ conclusion: "cancelled" }) });
  assert.equal(decision.decision, REPAIR_DECISIONS.REFUSE);
  assert.equal(decision.reason, REPAIR_REFUSALS.NO_FAILURE);
});

test("the receipt ledger round-trips a dispatch and reports an unreadable ledger", () => {
  const space = workspace();
  try {
    const run = failedRun();
    const receipt = receiptFor(run);
    appendSelfRepairReceipt(space.receiptPath, receipt);

    const read = readSelfRepairReceipts(space.receiptPath);
    assert.equal(read.readable, true);
    assert.equal(read.receipts.length, 1);
    assert.equal(read.receipts[0].signature, receipt.signature);
    assert.equal(read.receipts[0].workflow, "improve.yml");
    assert.equal(read.receipts[0].target, run.repo);
    assert.equal(read.receipts[0].version, SELF_REPAIR_RECEIPT_VERSION);

    // A directory in the receipt path is an unreadable ledger, not an empty one.
    mkdirSync(`${space.receiptPath}.blocked`);
    const blocked = readSelfRepairReceipts(`${space.receiptPath}.blocked`);
    assert.equal(blocked.readable, false);
    assert.deepEqual(blocked.receipts, []);
    assert.ok(String(blocked.error).length > 0);
  } finally {
    space.cleanup();
  }
});

test("the dispatcher answers a failure once, records the receipt, and refuses the second attempt", () => {
  const space = workspace();
  try {
    const calls = [];
    const dispatched = [];
    const repairer = createSelfRepairDispatcher({
      receiptPath: space.receiptPath,
      admission: {
        observation: () => ({ runs: [], unknownRepos: [] }),
        dispatchGuarded: (duty, dispatch) => {
          calls.push(duty);
          const done = dispatch();
          dispatched.push(done);
          return { dispatch: true, reason: "admitted" };
        },
      },
      dispatchWorkflow: (workflow, target) => {
        calls.push(`${workflow}@${target}`);
      },
      controlRepository: CONTROL,
      runtimeRepository: RUNTIME,
      owner: "fixture-owner",
      clock: () => NOW,
    });

    const run = failedRun();
    const first = repairer.respondToFailures([run]);
    const authorized = first.filter((outcome) => outcome.dispatched);
    // Both repair families are candidates for the failure, but the signature is
    // the failure's, so exactly one dispatch is authorized.
    assert.equal(authorized.length, 1);
    assert.equal(authorized[0].workflow, "improve.yml");
    assert.equal(calls.filter((call) => typeof call === "string").length, 1);

    const ledger = readSelfRepairReceipts(space.receiptPath);
    assert.equal(ledger.receipts.length, 1);
    assert.equal(ledger.receipts[0].signature, failingSignature(run, run.repo));

    const second = repairer.respondToFailures([run]);
    assert.equal(second.filter((outcome) => outcome.dispatched).length, 0);
    assert.ok(second.some((outcome) => outcome.reason === REPAIR_REFUSALS.BUDGET));
    assert.equal(readSelfRepairReceipts(space.receiptPath).receipts.length, 1);
  } finally {
    space.cleanup();
  }
});

test("the dispatcher refuses a refused target without dispatching or spending budget", () => {
  const space = workspace();
  try {
    const dispatched = [];
    const repairer = createSelfRepairDispatcher({
      receiptPath: space.receiptPath,
      admission: {
        observation: () => ({ runs: [], unknownRepos: [] }),
        dispatchGuarded: (duty, dispatch) => {
          dispatch();
          return { dispatch: true, reason: "admitted" };
        },
      },
      dispatchWorkflow: (workflow, target) => dispatched.push(`${workflow}@${target}`),
      controlRepository: CONTROL,
      runtimeRepository: CONTROL,
      owner: "fixture-owner",
      clock: () => NOW,
    });

    const outcomes = repairer.respondToFailures([failedRun()]);
    assert.equal(dispatched.length, 0);
    assert.equal(outcomes.every((outcome) => outcome.dispatched === false), true);
    assert.ok(outcomes.some((outcome) => outcome.reason === REPAIR_REFUSALS.CONTROL_TARGET));
    assert.equal(readSelfRepairReceipts(space.receiptPath).receipts.length, 0);
  } finally {
    space.cleanup();
  }
});

test("the dispatcher fails closed when the occupancy observation is unreadable", () => {
  const space = workspace();
  try {
    const dispatched = [];
    const repairer = createSelfRepairDispatcher({
      receiptPath: space.receiptPath,
      admission: {
        observation: () => ({ runs: [], unknownRepos: [CONTROL] }),
        dispatchGuarded: (duty, dispatch) => {
          dispatch();
          return { dispatch: true, reason: "admitted" };
        },
      },
      dispatchWorkflow: (workflow, target) => dispatched.push(`${workflow}@${target}`),
      controlRepository: CONTROL,
      runtimeRepository: RUNTIME,
      owner: "fixture-owner",
      clock: () => NOW,
    });

    const outcomes = repairer.respondToFailures([failedRun()]);
    assert.equal(dispatched.length, 0);
    assert.ok(outcomes.some((outcome) => outcome.reason === REPAIR_REFUSALS.OCCUPANCY_UNREADABLE));
  } finally {
    space.cleanup();
  }
});

test("the dispatcher fails closed when the receipt ledger cannot be read", () => {
  const space = workspace();
  try {
    const dispatched = [];
    mkdirSync(`${space.receiptPath}.blocked`);
    const repairer = createSelfRepairDispatcher({
      receiptPath: `${space.receiptPath}.blocked`,
      admission: {
        observation: () => ({ runs: [], unknownRepos: [] }),
        dispatchGuarded: (duty, dispatch) => {
          dispatch();
          return { dispatch: true, reason: "admitted" };
        },
      },
      dispatchWorkflow: (workflow, target) => dispatched.push(`${workflow}@${target}`),
      controlRepository: CONTROL,
      runtimeRepository: RUNTIME,
      owner: "fixture-owner",
      clock: () => NOW,
    });

    const outcomes = repairer.respondToFailures([failedRun()]);
    assert.equal(dispatched.length, 0);
    assert.ok(outcomes.some((outcome) => outcome.reason === REPAIR_REFUSALS.LEDGER_UNREADABLE));
  } finally {
    space.cleanup();
  }
});

test("the dispatcher charges budget before the dispatch leaves, so a cancelled run cannot refund it", () => {
  const space = workspace();
  try {
    let cancelled = false;
    const repairer = createSelfRepairDispatcher({
      receiptPath: space.receiptPath,
      admission: {
        observation: () => ({ runs: [], unknownRepos: [] }),
        dispatchGuarded: (duty, dispatch) => {
          dispatch();
          return { dispatch: true, reason: "admitted" };
        },
      },
      // The dispatched repair run is observed cancelled on the next tick.
      dispatchWorkflow: () => {
        cancelled = true;
      },
      controlRepository: CONTROL,
      runtimeRepository: RUNTIME,
      owner: "fixture-owner",
      clock: () => NOW,
    });

    const run = failedRun();
    repairer.respondToFailures([run]);
    assert.equal(cancelled, true);
    assert.equal(readSelfRepairReceipts(space.receiptPath).receipts.length, 1);

    const cancelledEcho = failedRun({
      repo: RUNTIME,
      id: "2001",
      workflowFile: "improve.yml",
      name: "fleet-improve",
      conclusion: "cancelled",
      createdAt: new Date(NOW + 2 * 60_000).toISOString(),
      updatedAt: new Date(NOW + 3 * 60_000).toISOString(),
    });
    const later = createSelfRepairDispatcher({
      receiptPath: space.receiptPath,
      admission: {
        observation: () => ({ runs: [cancelledEcho], unknownRepos: [] }),
        dispatchGuarded: (duty, dispatch) => {
          dispatch();
          return { dispatch: true, reason: "admitted" };
        },
      },
      dispatchWorkflow: () => {
        cancelled = true;
      },
      controlRepository: CONTROL,
      runtimeRepository: RUNTIME,
      owner: "fixture-owner",
      clock: () => NOW + 4 * 60_000,
    });

    const outcomes = later.respondToFailures([run, cancelledEcho]);
    assert.ok(outcomes.some((outcome) => outcome.reason === REPAIR_REFUSALS.BUDGET));
    assert.equal(readSelfRepairReceipts(space.receiptPath).receipts.length, 1);
  } finally {
    space.cleanup();
  }
});

test("watchdog.mjs dispatches self-repair through the policy gate, not through gh workflow run directly", () => {
  const source = readFileSync(path.join(ROOT, "scripts", "watchdog.mjs"), "utf8");
  // The ungoverned form this replaced: an unconditional improve/retro dispatch
  // carrying the `-f repo=` input no improve workflow in the fleet declares.
  assert.equal(/gh\(\["workflow", "run", "(improve|retro)\.yml"/.test(source), false);
  assert.equal(/-f", `repo=/.test(source), false);
  assert.match(source, /createSelfRepairDispatcher/);
  assert.match(source, /respondToFailures\(/);
});

test("the runtime target is still dispatchable, so the refusal is the control repository and not everything", () => {
  // The target must belong to the fixture owner: a real repository literal paired
  // with a fixture owner is a foreign-owner target, and the refusal it produced was
  // the foreign-owner guard working, not the runtime target being undispatchable.
  assert.notEqual(RUNTIME, CONTROL);
  assert.equal(repair({ target: RUNTIME }).decision, REPAIR_DECISIONS.REPAIR);
  for (const workflow of SELF_REPAIR_WORKFLOWS) {
    assert.equal(repair({ workflow, target: RUNTIME }).decision, REPAIR_DECISIONS.REPAIR);
  }
});

test("receipt lines are durable JSONL that survives a second read after a crash", () => {
  const space = workspace();
  try {
    const run = failedRun();
    appendSelfRepairReceipt(space.receiptPath, receiptFor(run));
    appendSelfRepairReceipt(space.receiptPath, receiptFor(run, { workflow: "retro.yml" }));
    const corrupt = `${readFileSync(space.receiptPath, "utf8")}not json\n`;
    writeFileSync(space.receiptPath, corrupt, "utf8");

    const read = readSelfRepairReceipts(space.receiptPath);
    assert.equal(read.readable, true);
    assert.equal(read.receipts.length, 2);
  } finally {
    space.cleanup();
  }
});
