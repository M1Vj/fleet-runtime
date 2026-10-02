/**
 * Self-repair dispatch policy for the fleet runtime watchdog.
 *
 * Why this exists: the watchdog answered every failed run with an improve (or
 * retro) dispatch on a 15-minute cron, through admission but with no cap, no
 * receipt ledger and no target refusal. That is an unbounded feedback loop, and
 * one that cannot even produce a repair run:
 *
 *   - `improve.yml` at the control repository is `repository_dispatch`-only
 *     (the proof-bound cloud-agent build path). It has no `workflow_dispatch`
 *     trigger, so `gh workflow run improve.yml -R <control>` can only fail.
 *   - The `-f repo=<target>` input the watchdog passed is declared by no improve
 *     workflow in the fleet, so `gh workflow run` rejects the call outright.
 *   - Either way the attempt is a fresh failed run, which the next cron tick
 *     observes and answers with another dispatch. One refusal, forever.
 *
 * Invariants live here so every caller shares one policy:
 *   1. Never dispatch an improve/retro workflow at a target the fleet refuses:
 *      the control repository, a foreign owner, or a `repo` input no workflow
 *      declares. Never dispatch at a target whose own repair workflow is the
 *      thing that failed.
 *   2. Repair budget is counted PER FAILING SIGNATURE per window: a repeated
 *      signature is suppressed, a brand-new signature always gets its own
 *      attempt, and a CANCELLED run spends no budget at all. Budget is charged
 *      when the dispatch is made and the receipt is durable, so a cancelled run
 *      never refunds it.
 *   3. A failure of a repair this runtime itself just dispatched is not a new
 *      defect. That is decided from dispatch receipts, never from a
 *      workflow-name pattern.
 *   4. Fail CLOSED: an unreadable ledger or occupancy observation refuses the
 *      dispatch instead of assuming budget remains.
 *
 * Normalization happens on the caller's own values inside this policy, so a
 * caller cannot check one repository and dispatch another.
 *
 * Pure module: no network, no filesystem, no clock beyond `now`.
 */

export const REPAIR_WINDOW_MINUTES = 360;
export const REPAIR_MAX_DISPATCHES_PER_SIGNATURE = 1;
export const REPAIR_RECEIPT_MATCH_SLACK_MS = 10 * 60 * 1000;
export const REPAIR_RECEIPT_RETENTION_HOURS = 72;
export const SELF_REPAIR_RECEIPT_VERSION = 1;

export const REPAIR_DECISIONS = Object.freeze({
  REPAIR: "repair",
  REFUSE: "refuse",
});

export const REPAIR_REFUSALS = Object.freeze({
  CONTROL_TARGET: "control-repository-requires-proof-bound-cloud-agent-authorization",
  FOREIGN_OWNER: "foreign-repo-target",
  UNDECLARED_INPUT: "undeclared-workflow-input",
  SELF_ECHO: "repair-target-owns-the-failing-repair-workflow",
  BUDGET: "within-repair-window-budget",
  LEDGER_UNREADABLE: "repair-ledger-unreadable",
  OCCUPANCY_UNREADABLE: "repair-occupancy-unreadable",
  NO_FAILURE: "no-repairable-failure",
});

/** Improve/retro workflow families, matched on file key so `.yml`/`.yaml` agree. */
const REPAIR_WORKFLOW_RE = /^(improve|retro|self-repair)/i;
const WORKFLOW_NAME_RE = /\.ya?ml$/i;

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
/** Conclusions that spend repair budget. `cancelled` deliberately is not one. */
const BUDGET_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

export function canonicalRepoName(value) {
  return String(value ?? "")
    .trim()
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/**
 * Owner-qualify a caller-supplied target the way the fleet reads it: a bare
 * name belongs to the owner, an explicit foreign owner is never rewritten into
 * the owner's namespace.
 */
export function qualifyRepoName(value, owner) {
  const raw = String(value ?? "")
    .trim()
    .replace(/\.git$/i, "");
  if (!raw) return "";
  if (raw.includes("/")) return raw;
  const namespace = String(owner ?? "").trim();
  return namespace ? `${namespace}/${raw}` : raw;
}

/** The workflow file key used for identity comparison, or "" when absent. */
export function workflowFileKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const name = raw.split("/").pop() || "";
  if (!WORKFLOW_NAME_RE.test(name)) return name.toLowerCase();
  return name.toLowerCase().replace(/\.ya?ml$/, "");
}

export function isRepairWorkflow(value) {
  return REPAIR_WORKFLOW_RE.test(workflowFileKey(value));
}

/**
 * A repair workflow must never be dispatched at a target the fleet refuses, and
 * must never be handed a `repo` input: the improve workflows in this fleet take
 * their target from the workflow's own repository context, so passing `repo`
 * is rejected by `gh workflow run` before a run exists. Every refusal is
 * evaluated against the same normalized string that would be dispatched.
 */
export function repairTargetRefusal({ workflow = "", target = "", inputs = {}, controlRepository = "", controlRepositories = [], owner = "" } = {}) {
  if (!isRepairWorkflow(workflow)) return null;
  const raw = String(inputs?.repo ?? "").trim();
  if (raw) {
    return `${REPAIR_REFUSALS.UNDECLARED_INPUT}: ${workflowFileKey(workflow) || "workflow"} declares no repo input`;
  }
  const dispatched = canonicalRepoName(qualifyRepoName(target, owner));
  if (!dispatched) return null;
  const controlTargets = new Set(
    [controlRepository, ...(Array.isArray(controlRepositories) ? controlRepositories : [])]
      .map((value) => canonicalRepoName(qualifyRepoName(value, owner)))
      .filter(Boolean),
  );
  if (controlTargets.has(dispatched)) return REPAIR_REFUSALS.CONTROL_TARGET;
  const namespace = String(owner ?? "").trim().split("/")[0].toLowerCase();
  if (namespace && dispatched.split("/")[0] !== namespace) {
    return `${REPAIR_REFUSALS.FOREIGN_OWNER}: ${dispatched}`;
  }
  return null;
}

/**
 * Requirement (a): never answer a target's own repair-workflow failure with
 * another dispatch of that same workflow at that same target. The dispatch that
 * just failed is the loop's own echo, not a new defect.
 *
 * `failureRepository` is the repository the run list was sampled from. GitHub's
 * repo-scoped run list carries no per-run repository field, so the run's own
 * `repo` is absent in practice; comparing against the sampled repository is what
 * makes the check fire at all.
 */
export function selfEchoRefusal({ workflow = "", target = "", failedRun = null, failureRepository = "" } = {}) {
  if (!failedRun || !isRepairWorkflow(workflow)) return null;
  if (!isRepairWorkflow(failedRun?.workflowFile ?? failedRun?.name ?? "")) return null;
  const failedRepo = canonicalRepoName(failedRun?.repo ?? "") || canonicalRepoName(failureRepository);
  if (failedRepo !== canonicalRepoName(target ?? "")) return null;
  return `${REPAIR_REFUSALS.SELF_ECHO}: ${workflowFileKey(workflow)} failed at ${canonicalRepoName(target)}`;
}

/**
 * The run shape that is a repairable defect and the only one that spends budget:
 * completed, and failed in a way the fleet would call a failure. A cancelled run
 * is the runner declining the work rather than a defect — charging the fleet for
 * it is how a repair cap turns into a permanent mute. An attempt still queued or
 * running has already spent its budget.
 */
export function runSpendsBudget(run) {
  if (!run?.status || String(run.status) === "completed") {
    return BUDGET_CONCLUSIONS.has(String(run?.conclusion ?? "").trim().toLowerCase());
  }
  return true;
}

export function runCancelled(run) {
  const completed = !run?.status || String(run.status) === "completed";
  return completed && String(run?.conclusion ?? "").trim().toLowerCase() === "cancelled";
}

export function runFailed(run) {
  const completed = !run?.status || String(run.status) === "completed";
  return completed && FAILED_CONCLUSIONS.has(String(run?.conclusion ?? "").trim().toLowerCase());
}

function runTimestamp(run) {
  for (const key of ["createdAt", "created_at", "updatedAt", "updated_at", "at", "startedAt"]) {
    const parsed = Date.parse(String(run?.[key] ?? ""));
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function runIdentifier(run) {
  const parsed = Number(run?.databaseId ?? run?.id ?? run?.database_id);
  return Number.isFinite(parsed) ? String(parsed) : null;
}

export function createSelfRepairReceipt({
  signature = "none",
  target = null,
  workflow = "improve.yml",
  at = null,
  now = Date.now(),
  runId = null,
  conclusion = null,
} = {}) {
  const numeric = Number(at);
  const dispatchedAt = Number.isFinite(numeric) ? numeric : Number(now);
  return {
    version: SELF_REPAIR_RECEIPT_VERSION,
    signature: String(signature || "none"),
    target: target === null || target === undefined ? null : String(target),
    workflow: String(workflow || "improve.yml"),
    dispatchedAt: new Date(dispatchedAt).toISOString(),
    runId: runId === null || runId === undefined || runId === "" ? null : String(runId),
    conclusion: conclusion === null || conclusion === undefined || conclusion === "" ? null : String(conclusion).toLowerCase(),
  };
}

/**
 * Tolerant parse of whatever the ledger holds on disk: a bare array of receipts
 * or `{ version, receipts }`. A malformed entry is dropped rather than fatal —
 * a corrupt line must not crash the caller — but the caller must still treat an
 * unreadable ledger as a refusal (invariant 4) rather than as an empty budget.
 */
export function normalizeSelfRepairReceipts(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.receipts) ? value.receipts : [];
  return list.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const at = Date.parse(String(entry.dispatchedAt ?? entry.at ?? entry.t ?? entry.createdAt ?? ""));
    if (Number.isNaN(at)) return [];
    return [
      {
        ...createSelfRepairReceipt({
          signature: entry.signature,
          target: entry.target,
          workflow: entry.workflow,
          at,
          runId: entry.runId,
          conclusion: entry.conclusion,
        }),
        id: `${entry.signature ?? "none"}|${entry.workflow ?? ""}|${at}|${index}`,
      },
    ];
  });
}

/**
 * Bind a run to the dispatch receipt that created it. A dispatch receipt and the
 * run it produced cannot share a timestamp — GitHub creates the run after the API
 * call returns and the run list is sampled later — so the slack is one-sided: an
 * old receipt cannot claim a run that started before it was written.
 */
export function matchSelfRepairReceipt(run, receipts = []) {
  const at = runTimestamp(run);
  if (at === null) return null;
  const id = runIdentifier(run);
  const claimed = new Set();
  const ordered = [...receipts].sort((a, b) => Date.parse(a.dispatchedAt) - Date.parse(b.dispatchedAt));
  if (id) {
    for (const receipt of ordered) {
      if (receipt.runId && receipt.runId === id && !claimed.has(receipt.id)) {
        claimed.add(receipt.id);
        return receipt;
      }
    }
  }
  const key = workflowFileKey(run?.workflowFile ?? run?.name ?? "");
  if (!key) return null;
  for (const receipt of ordered) {
    if (claimed.has(receipt.id)) continue;
    if (workflowFileKey(receipt.workflow) !== key) continue;
    if (at < Date.parse(receipt.dispatchedAt) - REPAIR_RECEIPT_MATCH_SLACK_MS) continue;
    claimed.add(receipt.id);
    return receipt;
  }
  return null;
}

/**
 * Split failing runs into the shapes the watchdog must treat differently: our own
 * repair echo (not a trigger), a cancelled or unexplained attempt (not a
 * trigger), and any other failure — the only thing a repair dispatch may answer.
 *
 * The receipt is matched BEFORE `cancelled` is excluded. A cancelled run is
 * usually nobody's defect, but a cancelled run that one of our own receipts
 * explains is our own echo and must be recognized as such: it is what proves the
 * budget was already charged, so the next tick does not re-dispatch it. Excluding
 * cancelled runs first made every echo look unexplained, which both hid the
 * charge and misfiled our own run as a fresh failure.
 */
export function classifyRepairFailures({ failedRuns = [], receipts = [] } = {}) {
  const ledger = normalizeSelfRepairReceipts(receipts);
  const runs = Array.isArray(failedRuns) ? failedRuns : [];
  const claimed = new Set();
  const selfDispatched = [];
  const other = [];
  for (const run of runs) {
    if (!runFailed(run)) continue;
    const receipt = matchSelfRepairReceipt(run, ledger.filter((r) => !claimed.has(r.id)));
    if (receipt) {
      claimed.add(receipt.id);
      selfDispatched.push({ run, receipt });
      continue;
    }
    if (runCancelled(run) || !runSpendsBudget(run)) continue;
    other.push(run);
  }
  return { selfDispatched, other, receiptLedgerSize: ledger.length };
}

/**
 * Budget charged against `signature` inside the window.
 *
 * Two evidence sources, never double counted: a receipt names the signature it
 * was dispatched for, and an observed repair run that no receipt explains is
 * attributed to the failure set that already existed when it started. A run a
 * receipt explains belongs to that receipt's signature, never to this one. A
 * cancelled run is excluded because it spends nothing.
 */
export function chargedRepairAttempts({
  signature,
  recentRuns = [],
  receipts = [],
  now = Date.now(),
  windowMinutes = REPAIR_WINDOW_MINUTES,
} = {}) {
  const windowStart = Number(now) - Math.max(1, Number(windowMinutes) || REPAIR_WINDOW_MINUTES) * 60000;
  const window = (Array.isArray(recentRuns) ? recentRuns : []).filter((run) => {
    const at = runTimestamp(run);
    return at !== null && at >= windowStart;
  });
  const ledger = normalizeSelfRepairReceipts(receipts).filter(
    (receipt) => Date.parse(receipt.dispatchedAt) >= windowStart,
  );
  const key = String(signature || "");
  let charged = 0;
  const claimed = new Set();
  for (const receipt of ledger) {
    if (receipt.signature !== key) continue;
    charged += 1;
    claimed.add(receipt.id);
  }
  for (const run of window) {
    if (!runSpendsBudget(run) || runCancelled(run)) continue;
    const receipt = matchSelfRepairReceipt(run, ledger.filter((r) => !claimed.has(r.id)));
    if (receipt) {
      claimed.add(receipt.id);
      continue;
    }
    charged += 1;
  }
  return charged;
}

/**
 * The one decision every repair dispatch goes through.
 *
 * Order is deliberate. Refusals are evaluated before any budget is charged, so
 * a refused dispatch can never consume a signature's single allowance, and an
 * unreadable ledger or occupancy observation refuses rather than assuming the
 * budget is still available.
 */
export function evaluateSelfRepair({
  failedRun = null,
  workflow = "",
  target = "",
  inputs = {},
  signature = null,
  receipts = [],
  recentRuns = [],
  controlRepository = "",
  owner = "",
  failureRepository = "",
  now = Date.now(),
  windowMinutes = REPAIR_WINDOW_MINUTES,
  maxPerSignature = REPAIR_MAX_DISPATCHES_PER_SIGNATURE,
  ledgerReadable = true,
  occupancyReadable = true,
} = {}) {
  const refuse = (reason) => ({
    decision: REPAIR_DECISIONS.REFUSE,
    reason,
    workflow: String(workflow || ""),
    target: String(target || ""),
    signature: String(signature || ""),
  });

  if (!failedRun) return refuse(REPAIR_REFUSALS.NO_FAILURE);
  if (!runFailed(failedRun) || runCancelled(failedRun)) return refuse(REPAIR_REFUSALS.NO_FAILURE);
  if (!ledgerReadable) return refuse(REPAIR_REFUSALS.LEDGER_UNREADABLE);
  if (!occupancyReadable) return refuse(REPAIR_REFUSALS.OCCUPANCY_UNREADABLE);

  const echo = selfEchoRefusal({ workflow, target, failedRun });
  if (echo) return refuse(echo);

  const targetRefusal = repairTargetRefusal({ workflow, target, inputs, controlRepository, owner });
  if (targetRefusal) return refuse(targetRefusal);

  const key = String(signature || failingSignature(failedRun, target));
  const charged = chargedRepairAttempts({
    signature: key,
    recentRuns,
    receipts,
    now,
    windowMinutes,
  });
  if (charged >= Math.max(1, Number(maxPerSignature) || REPAIR_MAX_DISPATCHES_PER_SIGNATURE)) {
    return refuse(REPAIR_REFUSALS.BUDGET);
  }

  return {
    decision: REPAIR_DECISIONS.REPAIR,
    reason: "repair-authorized",
    workflow: String(workflow || ""),
    target: String(target || ""),
    signature: key,
    charged,
  };
}

/**
 * The identity a repair budget is charged against: the failing run's repository,
 * workflow and conclusion together, so a genuinely new failure signature always
 * earns its own allowance.
 */
export function failingSignature(run, target = "") {
  const repo = canonicalRepoName(run?.repo ?? target ?? "") || "unknown";
  const workflow = workflowFileKey(run?.workflowFile ?? run?.name ?? "") || "unknown";
  const conclusion = String(run?.conclusion ?? "").trim().toLowerCase() || "unknown";
  return `${repo}#${workflow}#${conclusion}`;
}

/** Receipts older than the retention horizon are dropped when the ledger is rewritten. */
export function pruneSelfRepairReceipts(receipts = [], now = Date.now()) {
  const cutoff = Number(now) - REPAIR_RECEIPT_RETENTION_HOURS * 3600 * 1000;
  return normalizeSelfRepairReceipts(receipts).filter((receipt) => Date.parse(receipt.dispatchedAt) >= cutoff);
}