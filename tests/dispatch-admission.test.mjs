import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMISSION_GUARD,
  ADMISSION_REFUSALS,
  createAdmissionGate,
  repositoryOccupiesRunner,
} from "../scripts/lib/dispatch-admission.mjs";
import {
  DEFAULT_ADMISSION_LIMITS,
  DISPATCH_REASONS,
  admissionLedgerKey,
  selfRunFromEnv,
} from "../scripts/lib/watchdog-admission.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The private repository identity is resolved from the environment at run time
// and is deliberately never compiled into source, so the tests name a fixture.
const CONTROL = "fixture-owner/control-plane";
const RUNTIME = "fixture-owner/controller";

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);

/**
 * Every source that participates in admission. The private-identity and
 * no-cancellation invariants are structural, so they are asserted over all of
 * them rather than over one file.
 */
function admissionSources() {
  return [
    path.join(ROOT, "scripts", "lib", "dispatch-admission.mjs"),
    path.join(ROOT, "scripts", "lib", "watchdog-admission.mjs"),
    path.join(ROOT, "scripts", "orchestrate.mjs"),
    path.join(ROOT, "scripts", "patrol.mjs"),
    path.join(ROOT, "scripts", "watchdog.mjs"),
  ];
}

function run(overrides = {}) {
  return {
    repo: CONTROL,
    id: "900",
    workflowFile: "patrol.yml",
    status: "in_progress",
    createdAt: new Date(NOW - 5 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 1 * 60_000).toISOString(),
    ...overrides,
  };
}

/**
 * The duty under test. A live run of the *same* workflow is reported as
 * `same_purpose_live` and any other live run as `runner_occupied`, so a test
 * that wants the general occupancy reason dispatches a different workflow.
 */
const DUTY = { duty: "patrol", repo: CONTROL, workflow: "patrol.yml" };

/**
 * A gate whose every side effect is a spy, so a deferral is proved by the
 * dispatch function never being called rather than by inspecting source text.
 */
function makeGate(options = {}) {
  const appended = [];
  const notes = [];
  const events = [];
  const dispatched = [];
  const gate = createAdmissionGate({
    observe: () => ({ runs: options.runs || [], unknownRepos: options.unknownRepos || [] }),
    loadHistory: () => options.history || [],
    loadLedger: () => new Set(options.seen || []),
    appendLedger: (key, meta) => appended.push({ key, meta }),
    hasLedger: (seen, key) => seen.has(key),
    audit: { note: (kind, text) => notes.push({ kind, text }) },
    terminal: (event, payload) => events.push({ event, payload }),
    contendedRepository: options.contendedRepository === undefined ? CONTROL : options.contendedRepository,
    selfRun: options.selfRun === undefined ? null : options.selfRun,
    clock: () => NOW,
  });
  return {
    gate,
    appended,
    notes,
    events,
    dispatched,
    run(input, dispatchFn = () => dispatched.push(input)) {
      return gate.dispatchGuarded(input, dispatchFn);
    },
  };
}

test("a duty is dispatched when the runner is idle", () => {
  const h = makeGate({ runs: [] });
  const outcome = h.run(DUTY);
  assert.equal(outcome.dispatch, true);
  assert.equal(outcome.plan.reasonCode, DISPATCH_REASONS.RUNNER_IDLE);
  assert.equal(outcome.plan.cancel, false, "every decision states that nothing was cancelled");
  assert.deepEqual(h.dispatched.length, 1);
  // The dispatch itself is recorded so a later cycle can tell that the
  // deferral chain ended here, but it is not a deferral and raises no NO-OP.
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].meta.decision, "dispatch");
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.notes, []);
});

test("an occupied runner defers before dispatch and the dispatch function is never called", () => {
  const h = makeGate({ runs: [run()] });
  const outcome = h.run(DUTY);
  assert.equal(outcome.dispatch, false);
  assert.equal(outcome.plan.reasonCode, DISPATCH_REASONS.SAME_PURPOSE_LIVE);
  assert.deepEqual(h.dispatched, [], "a deferral must not reach the dispatch function");
});

test("a different duty on an occupied runner defers with the general occupancy reason", () => {
  const h = makeGate({ runs: [run()] });
  const outcome = h.run({ duty: "retro", repo: CONTROL, workflow: "retro.yml" });
  assert.equal(outcome.dispatch, false);
  assert.equal(outcome.plan.reasonCode, DISPATCH_REASONS.RUNNER_OCCUPIED);
  assert.deepEqual(h.dispatched, []);
});

test("every deferral is recorded in the ledger, the audit and the terminal event", () => {
  const h = makeGate({ runs: [run()] });
  h.run(DUTY);

  assert.equal(h.appended.length, 1, "one ledger record per deferral");
  assert.equal(h.appended[0].meta.admission, true);
  assert.equal(h.appended[0].meta.decision, "defer");
  assert.equal(h.appended[0].meta.reasonCode, DISPATCH_REASONS.SAME_PURPOSE_LIVE);

  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].kind, ADMISSION_GUARD);

  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].event, "NO-OP");
  assert.equal(h.events[0].payload.admission, ADMISSION_GUARD);
  assert.equal(h.events[0].payload.reason, DISPATCH_REASONS.SAME_PURPOSE_LIVE);
});

test("a deferral already recorded for this cycle is not recorded twice", () => {
  const h = makeGate({ runs: [run()] });
  const first = h.run(DUTY);
  const key = admissionLedgerKey(first.plan, NOW);
  assert.equal(h.appended[0].key, key, "the appended key is the one a later cycle re-derives");
  const second = makeGate({ runs: [run()], seen: [key] });
  const outcome = second.run(DUTY);

  assert.equal(outcome.duplicate, true);
  assert.deepEqual(second.appended, [], "an idempotent key must not append a second record");
  assert.deepEqual(second.dispatched, []);
});

/**
 * The dedupe above is proven with two gates, so it only covers a *durable* ledger
 * snapshot. It does not cover the gate folding its own just-appended key into its
 * cache, which is what actually happens inside one cycle: two admissions of the
 * same duty against a loader that keeps returning its pre-append snapshot. Both
 * rows would then be charged, so the ledger -- the thing the deferral chain is
 * rebuilt from -- would hold one duty twice.
 */
test("one gate admitting the same duty twice charges one ledger row", () => {
  const h = makeGate({ runs: [run()] });
  const first = h.run(DUTY);
  const second = h.run(DUTY);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true, "the gate's own appended row dedupes the second admission");
  assert.equal(h.appended.length, 1, "one duty in one cycle is one ledger row, not two");
  assert.equal(h.appended[0].key, admissionLedgerKey(second.plan, NOW));
  assert.deepEqual(h.events.length, 1, "the recorded deferral is published once, not re-published as a second NO-OP");
});

/**
 * A duplicate is not an advisory flag. The first admission may have *dispatched*,
 * in which case a second real `gh workflow run` would queue a second Actions run
 * for a duty already in flight -- the exact un-executable work the gate exists to
 * prevent, and one that no later cancellation could take back, because admission
 * deliberately has no cancellation capability.
 */
test("a duplicate admission of a dispatched duty does not create a second run", () => {
  const h = makeGate({ runs: [] });
  const first = h.run(DUTY);
  const second = h.run(DUTY);

  assert.equal(first.dispatch, true, "the runner is idle, so the first duty runs");
  assert.equal(second.duplicate, true);
  assert.equal(second.dispatch, false, "a duplicate row must not authorise a second dispatch");
  assert.equal(second.reason, DISPATCH_REASONS.DUPLICATE_ADMISSION);
  assert.equal(h.dispatched.length, 1, "the dispatch thunk ran once, so exactly one Actions run exists");
  assert.equal(second.result, undefined, "the suppressed duplicate produced no dispatch result");
  assert.equal(second.plan.reasonCode, DISPATCH_REASONS.RUNNER_IDLE, "the occupancy plan is still reported for observability");
  assert.deepEqual(h.events, [], "neither a dispatched duty nor its duplicate has a deferral NO-OP to publish");
});

test("an unreadable repository defers closed rather than assuming an idle runner", () => {
  const h = makeGate({ runs: [], unknownRepos: [CONTROL] });
  const outcome = h.run(DUTY);
  assert.equal(outcome.dispatch, false);
  assert.equal(outcome.plan.reasonCode, DISPATCH_REASONS.OBSERVATION_UNAVAILABLE);
  assert.deepEqual(h.dispatched, []);
});

// The unobserved-state guard is deliberately not subject to the starvation
// bounds: a duty that has already waited must never be dispatched blind.
test("an unreadable repository defers even past the starvation bound", () => {
  const bound = DEFAULT_ADMISSION_LIMITS.maxConsecutiveDefers;
  const aged = Array.from({ length: bound }, (_, i) => ({
    duty: "patrol",
    cycle: `aged-${i}`,
    decision: "defer",
    reasonCode: DISPATCH_REASONS.RUNNER_OCCUPIED,
    t: NOW - (bound - i) * DEFAULT_ADMISSION_LIMITS.cycleMs,
  }));
  const h = makeGate({ runs: [], unknownRepos: [CONTROL], history: aged });
  const outcome = h.run(DUTY);
  assert.ok(
    outcome.plan.consecutiveDefers >= bound,
    `the chain is already at the starvation bound (${outcome.plan.consecutiveDefers})`,
  );
  assert.equal(outcome.dispatch, false, "an unknown runner state must never be force-dispatched");
  assert.equal(outcome.plan.reasonCode, DISPATCH_REASONS.OBSERVATION_UNAVAILABLE);
});

// The load-bearing regression: the dispatching run is itself occupying the one
// runner. Counting it defers every duty with a false reason, and the starvation
// bound then turns that false deferral into a forced dispatch every fourth
// cycle. A duty must never be deferred by the run that is deferring it.
test("the observing run's own occupancy does not defer the duty it is deciding", () => {
  const h = makeGate({
    runs: [run({ id: "self-1" })],
    selfRun: { id: "self-1", repo: CONTROL },
  });
  const outcome = h.run(DUTY);
  assert.equal(outcome.plan.selfRunsExcluded, 1);
  assert.equal(outcome.plan.occupancy.live, 0);
  assert.equal(outcome.plan.occupancy.queued, 0);
  assert.equal(outcome.dispatch, true);
  assert.equal(outcome.plan.reasonCode, DISPATCH_REASONS.RUNNER_IDLE);
  assert.deepEqual(
    h.appended.map((a) => a.meta.decision),
    ["dispatch"],
    "an idle runner records a dispatch, never a deferral",
  );
  assert.deepEqual(h.events, [], "no NO-OP is raised when nothing was dropped");
  assert.deepEqual(h.dispatched.length, 1);
});

test("another run on the same runner still defers the duty", () => {
  const h = makeGate({
    runs: [run({ id: "self-1" }), run({ id: "other-2", workflowFile: "improve.yml" })],
    selfRun: { id: "self-1", repo: CONTROL },
  });
  const outcome = h.run({ duty: "patrol", repo: CONTROL, workflow: "patrol.yml" });
  assert.equal(outcome.plan.selfRunsExcluded, 1);
  assert.equal(outcome.dispatch, false, "self-exclusion must not discount a genuine neighbour");
});

/**
 * Drive the gate over consecutive cycles against a single shared ledger and
 * deferral history, exactly as a controller's per-cycle gate is reused.
 *
 * `selfRunId` is the run doing the observing. It is the whole point of the
 * regression: with it, every cycle sees an idle runner; without it, every cycle
 * defers and the deferral chain grows until the starvation bound forces a
 * dispatch on a busy runner.
 */
function simulateCycles({ cycles, selfRunId }) {
  const history = [];
  const seen = new Set();
  const appended = [];
  const dispatched = [];
  const decisions = [];

  for (let i = 0; i < cycles; i += 1) {
    const now = NOW + i * DEFAULT_ADMISSION_LIMITS.cycleMs;
    // The observing run is live on the single runner for the whole cycle.
    const runs = [run({ id: selfRunId, createdAt: new Date(now - 60_000).toISOString(), updatedAt: new Date(now).toISOString() })];
    const gate = createAdmissionGate({
      observe: () => ({ runs, unknownRepos: [] }),
      loadHistory: () => history.slice(),
      loadLedger: () => new Set(seen),
      appendLedger: (key, meta) => {
        seen.add(key);
        appended.push(meta);
        history.push({ duty: meta.duty, cycle: meta.cycle, decision: meta.decision, reasonCode: meta.reasonCode, t: meta.t });
      },
      hasLedger: (s, key) => s.has(key),
      contendedRepository: CONTROL,
      selfRun: selfRunId ? { id: selfRunId, repo: CONTROL } : null,
      clock: () => now,
    });
    const outcome = gate.dispatchGuarded(DUTY, () => dispatched.push(i));
    decisions.push({ dispatch: outcome.dispatch, reasonCode: outcome.plan.reasonCode, chain: outcome.plan.consecutiveDefers });
  }
  return { decisions, appended, dispatched };
}

test("self-exclusion stops a false deferral chain from forcing a dispatch onto a busy runner", () => {
  const aware = simulateCycles({ cycles: 6, selfRunId: "self-1" });
  for (const [i, decision] of aware.decisions.entries()) {
    assert.equal(decision.dispatch, true, `cycle ${i} must dispatch on an idle runner`);
    assert.equal(decision.reasonCode, DISPATCH_REASONS.RUNNER_IDLE, `cycle ${i} reason`);
    assert.equal(decision.chain, 0, `cycle ${i} deferral chain`);
  }
  assert.deepEqual(
    aware.appended.map((a) => a.decision),
    ["dispatch", "dispatch", "dispatch", "dispatch", "dispatch", "dispatch"],
    "no cycle may record a deferral it did not take",
  );
  assert.deepEqual(aware.dispatched, [0, 1, 2, 3, 4, 5]);

  // The defect this replaces, reproduced: an observer that cannot exclude itself
  // defers on a runner that is in fact idle, and the starvation bound then
  // force-dispatches work the fleet still cannot execute.
  const blind = simulateCycles({ cycles: 6, selfRunId: null });
  const reasons = blind.decisions.map((d) => d.reasonCode);
  const bound = DEFAULT_ADMISSION_LIMITS.maxConsecutiveDefers;

  // Three false deferrals, then the bound force-dispatches onto the busy runner
  // on the fourth cycle: this is exactly the reported symptom.
  assert.deepEqual(reasons.slice(0, bound), Array(bound).fill(DISPATCH_REASONS.SAME_PURPOSE_LIVE));
  assert.equal(blind.decisions[bound].reasonCode, DISPATCH_REASONS.STARVATION_COUNT_BOUND);
  assert.equal(blind.decisions[bound].dispatch, true, "the bound force-dispatches onto a busy runner");
  assert.deepEqual(blind.dispatched, [bound], "and it is the only force-dispatch in the window");
  assert.deepEqual(
    blind.decisions.slice(bound + 1).map((d) => d.chain),
    [0, 1],
    "the recorded dispatch terminates the chain, so the bound does not latch",
  );
  assert.equal(
    blind.decisions.filter((d) => d.reasonCode === DISPATCH_REASONS.STARVATION_COUNT_BOUND).length,
    1,
    "a force-dispatch must not leave the gate permanently forcing",
  );
  assert.deepEqual(
    blind.decisions.slice(bound + 1).map((d) => d.dispatch),
    [false, false],
    "the gate returns to deferring instead of latching into a permanent force-dispatch",
  );
});

test("a dispatcher that cannot name itself keeps the safe deferring behaviour", () => {
  const h = makeGate({ runs: [run({ id: "self-1" })], selfRun: null });
  const outcome = h.run(DUTY);
  assert.equal(outcome.plan.selfRunsExcluded, 0);
  assert.equal(outcome.dispatch, false, "an unidentifiable observer excludes nothing");
});

test("selfRunFromEnv reads the identity GitHub injects, and yields null when absent", () => {
  assert.deepEqual(selfRunFromEnv({ GITHUB_RUN_ID: "42", GITHUB_REPOSITORY: "Owner/Repo" }), {
    id: "42",
    repo: "owner/repo",
  });
  assert.equal(selfRunFromEnv({}), null);
  assert.equal(selfRunFromEnv({ GITHUB_RUN_ID: "", GITHUB_REPOSITORY: "Owner/Repo" }), null);
});

// Contention is decided from the identity the caller resolved at run time, so a
// private repository name is never compiled into this module. The scan covers
// the decision module, the gate and both dispatchers, because a compiled-in
// identity in any one of them would leak it.
test("only the resolved contended repository is gated, and no identity is compiled in", () => {
  assert.equal(repositoryOccupiesRunner(CONTROL, CONTROL), true);
  assert.equal(repositoryOccupiesRunner("FIXTURE-OWNER/CONTROL-PLANE", CONTROL), true);
  assert.equal(repositoryOccupiesRunner(RUNTIME, CONTROL), false);
  assert.equal(repositoryOccupiesRunner(CONTROL, null), false);
  assert.equal(repositoryOccupiesRunner("", CONTROL), false);

  // Assembled from parts so this assertion file is not itself a violation.
  const privateIdentity = new RegExp(["fleet", "control"].join("-"), "i");
  const offenders = admissionSources()
    .filter((file) => privateIdentity.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(ROOT, file));
  assert.deepEqual(offenders, [], `a private repository identity is compiled into ${offenders.join(", ")}`);
});

/**
 * A `/` opens a regex literal only after something that cannot end an
 * expression. After an identifier, a closing bracket or `this` the `/` is
 * division, which is what keeps a `//` in that position a real comment.
 */
const REGEX_PRECEDERS = new Set([
  "", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";",
  "+", "-", "*", "%", "<", ">", "~", "^",
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await",
]);

function scanQuoted(source, i, quote) {
  i += 1;
  while (i < source.length) {
    if (source[i] === "\\") { i += 2; continue; }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

function scanRegex(source, i) {
  i += 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "\n") break;
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) { i += 1; break; }
    i += 1;
  }
  while (i < source.length && /[a-z]/.test(source[i])) i += 1;
  return i;
}

function scanBraces(source, i) {
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") { i = scanQuoted(source, i, ch); continue; }
    if (ch === "`") { i = scanTemplate(source, i); continue; }
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === "{") { depth += 1; i += 1; continue; }
    if (ch === "}") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return i;
}

function scanTemplate(source, i) {
  i += 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") return i + 1;
    if (ch === "$" && source[i + 1] === "{") { i = scanBraces(source, i + 1); continue; }
    i += 1;
  }
  return i;
}

function lastSignificant(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j -= 1;
  if (j < 0) return "";
  if (!/[A-Za-z0-9_$]/.test(text[j])) return text[j];
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k -= 1;
  return text.slice(k + 1, j + 1);
}

/**
 * Two views of one source, both at identical byte offsets and line numbers:
 * `noComments` keeps literals so a `gh workflow run` argument list is still
 * readable, and `code` blanks literals so a bracket or a callee name inside a
 * string can never be mistaken for structure. Comments are removed from both,
 * which is what makes prose unable to stand in for a guard.
 */
function maskJs(source) {
  const noComments = source.split("");
  const code = source.split("");
  const blank = (target, from, to) => {
    for (let i = from; i < to; i += 1) if (source[i] !== "\n") target[i] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const pair = source.slice(i, i + 2);
    if (pair === "//" || pair === "/*") {
      let stop;
      if (pair === "//") {
        stop = i;
        while (stop < source.length && source[stop] !== "\n") stop += 1;
      } else {
        const end = source.indexOf("*/", i + 2);
        stop = end === -1 ? source.length : end + 2;
      }
      blank(noComments, i, stop);
      blank(code, i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const stop = scanQuoted(source, i, ch);
      blank(code, i, stop);
      i = stop;
      continue;
    }
    if (ch === "`") {
      const stop = scanTemplate(source, i);
      blank(code, i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && REGEX_PRECEDERS.has(lastSignificant(noComments, i))) {
      const stop = scanRegex(source, i);
      blank(code, i, stop);
      i = stop;
      continue;
    }
    i += 1;
  }
  return { noComments: noComments.join(""), code: code.join("") };
}

/**
 * The open brackets enclosing `offset`, innermost last. A group that closed
 * before `offset` is jumped over whole, so a bracket inside a finished call
 * never counts as an enclosing one.
 */
function enclosingBrackets(code, offset) {
  const open = [];
  let i = offset - 1;
  while (i >= 0) {
    const ch = code[i];
    if (ch === ")" || ch === "]" || ch === "}") {
      const partner = ch === ")" ? "(" : ch === "]" ? "[" : "{";
      let depth = 0;
      for (; i >= 0; i -= 1) {
        if (code[i] === ch) depth += 1;
        else if (code[i] === partner) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") open.push(i);
    i -= 1;
  }
  return open;
}

/** The callee expression written immediately before the bracket at `bracket`. */
function calleeBefore(code, bracket) {
  let j = bracket - 1;
  while (j >= 0 && /\s/.test(code[j])) j -= 1;
  if (j < 0 || !/[A-Za-z0-9_$.]/.test(code[j])) return "";
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$.]/.test(code[k])) k -= 1;
  return code.slice(k + 1, j + 1);
}

/** Top-level `key` / `key =` names of a destructuring pattern, with defaults. */
function patternKeys(code, open, close) {
  const keys = [];
  const readDefault = (segment, matched) => segment.slice(matched.length).replace(/^=/, "").trim();
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (depth !== 0 || ch !== ",") continue;
    const segment = code.slice(start, i);
    const match = segment.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?==|:)/);
    if (match) keys.push({ name: match[1], defaultValue: readDefault(segment, match[0]) });
    start = i + 1;
  }
  const tail = code.slice(start, close);
  const last = tail.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?==|:)/);
  if (last) keys.push({ name: last[1], defaultValue: readDefault(tail, last[0]) });
  return keys;
}

/** The `IDENT:` property whose value encloses `offset`, or null. */
function propertyKeyOwning(code, callOpen, offset) {
  const head = code.slice(callOpen + 1, offset);
  let found = null;
  for (const match of head.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=:)/g)) found = match;
  if (!found) return null;
  const valueStart = callOpen + 1 + found.index + found[0].length;
  return code.slice(valueStart, offset).trim() ? { name: found[1], valueStart } : null;
}

/** The final segment of the callee expression: `admission.dispatchGuarded` -> `dispatchGuarded`. */
function calleeMethod(code, bracket) {
  const expression = calleeBefore(code, bracket);
  return expression ? expression.split(".").pop() : "";
}

/** The `name` property of a source importing `name`, resolved to disk. */
function resolveImportedModule(file, name) {
  const { noComments } = maskJs(readFileSync(file, "utf8"));
  const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"([^"]+)"`).exec(noComments);
  if (!imported || !imported[1].startsWith(".")) return null;
  const target = path.resolve(path.dirname(file), imported[1]);
  return existsSync(target) ? { file: target, source: readFileSync(target, "utf8") } : null;
}

const SELF_REPAIR_FACTORY = "createSelfRepairDispatcher";

/**
 * Prove the delegated form: the dispatch is the body of a named property handed
 * to `createSelfRepairDispatcher(...)`, and that property's parameter is
 * referenced *only* as an argument of `<admission>.dispatchGuarded(...)`
 * inside the factory. Both halves are required, so neither moving the call out
 * of the gate nor pointing the gate at a different parameter can pass.
 */
function delegationProof(file, code, factoryOpen, siteOffset) {
  const property = propertyKeyOwning(code, factoryOpen, siteOffset);
  if (!property) return { gated: false, via: `not the value of a named ${SELF_REPAIR_FACTORY} property` };

  const factory = resolveImportedModule(file, SELF_REPAIR_FACTORY);
  if (!factory) return { gated: false, via: `${SELF_REPAIR_FACTORY} is not imported from a module this file can resolve` };

  const factoryCode = maskJs(factory.source).code;
  const definition = factoryCode.indexOf(`export function ${SELF_REPAIR_FACTORY}(`);
  if (definition < 0) return { gated: false, via: `${SELF_REPAIR_FACTORY} is not defined in ${path.basename(factory.file)}` };

  const paramsOpen = factoryCode.indexOf("{", definition);
  const paramsClose = findPatternClose(factoryCode, paramsOpen);
  if (paramsOpen < 0 || paramsClose < 0) return { gated: false, via: `${SELF_REPAIR_FACTORY} has no destructured parameter` };

  const keys = patternKeys(factoryCode, paramsOpen, paramsClose);
  const param = keys.find((k) => k.name === property.name);
  // The gate parameter is the null-defaulted one the body actually calls
  // `<name>.dispatchGuarded` on. Picking by declaration order instead would fail
  // on a harmless reordering of `admission` and `audit`.
  const admission = keys.find((k) => k.defaultValue === "null"
    && new RegExp(`\\b${k.name}\\.dispatchGuarded\\s*\\(`).test(factoryCode));
  if (!param) return { gated: false, via: `${property.name} is not a parameter of ${SELF_REPAIR_FACTORY}` };
  if (!admission) return { gated: false, via: `${SELF_REPAIR_FACTORY} has no gate parameter defaulting to null` };

  const gateCallee = `${admission.name}.dispatchGuarded`;
  const references = [...factoryCode.matchAll(new RegExp(`\\b${property.name}\\b`, "g"))]
    .map((m) => m.index)
    .filter((at) => at > paramsClose);

  if (references.length === 0) return { gated: false, via: `${property.name} is never referenced in the factory` };

  const ungated = references.filter((at) => !enclosingBrackets(factoryCode, at)
    .some((b) => factoryCode[b] === "(" && calleeBefore(factoryCode, b) === gateCallee));
  if (ungated.length > 0) {
    return { gated: false, via: `${property.name} is also called outside ${gateCallee} in ${path.basename(factory.file)}` };
  }
  return { gated: true, via: `${property.name} is only ever reached through ${gateCallee} in ${path.basename(factory.file)}` };
}

function findPatternClose(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineOf(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

/**
 * Whether the `gh workflow run` at `siteOffset` is proven gated, by structure
 * alone. Two proofs are accepted and nothing else: the call is an argument of
 * `dispatchGuarded(...)`, or it is delegated through
 * `createSelfRepairDispatcher(...)` as described above.
 */
function gatingProof(file, source, siteOffset) {
  const { noComments, code } = maskJs(source);
  const brackets = enclosingBrackets(code, siteOffset);
  for (const bracket of brackets) {
    if (code[bracket] === "(" && calleeMethod(code, bracket) === "dispatchGuarded") {
      return { gated: true, via: `dispatchGuarded(...) at line ${lineOf(noComments, bracket)}` };
    }
  }
  const factories = brackets.filter((b) => code[b] === "(" && calleeMethod(code, b) === SELF_REPAIR_FACTORY).reverse();
  for (const factoryOpen of factories) {
    const proof = delegationProof(file, code, factoryOpen, siteOffset);
    if (proof.gated) return proof;
  }
  return { gated: false, via: "not inside dispatchGuarded(...) and not a gated self-repair delegation" };
}

const DISPATCH_SITE = /["']workflow["']\s*,\s*["']run["']/g;

function siteOffsetsIn(source) {
  return [...maskJs(source).noComments.matchAll(DISPATCH_SITE)].map((m) => m.index);
}

const SITE_LINE = /["']workflow["']\s*,\s*["']run["']/;

/**
 * The gate is only worth anything if every real dispatch goes through it. A bare
 * `workflow run` in a controller creates the pending run admission exists to
 * prevent, so the wiring is asserted structurally over every controller: the
 * command may only appear inside the closure handed to `dispatchGuarded`, or
 * inside the `dispatchWorkflow` the self-repair dispatcher itself runs through
 * `admission.dispatchGuarded`. Exercising this for real needs a live runner and
 * a token, which is exactly what this lane must not use.
 */
test("no controller dispatch bypasses the admission gate", () => {
  const proof = [];
  const counts = {};
  let sites = 0;
  for (const rel of ["scripts/orchestrate.mjs", "scripts/patrol.mjs", "scripts/watchdog.mjs"]) {
    const file = path.join(ROOT, rel);
    const source = readFileSync(file, "utf8");
    for (const offset of siteOffsetsIn(source)) {
      sites += 1;
      counts[rel] = (counts[rel] || 0) + 1;
      const verdict = gatingProof(file, source, offset);
      assert.ok(verdict.gated, `${rel}:${lineOf(source, offset)} dispatches without admission: ${verdict.via}`);
      proof.push(`${rel}:${lineOf(source, offset)} via ${verdict.via}`);
    }
  }
  // Exact, not a floor. A duplicated `gh workflow run` is the one defect no
  // per-site proof can catch: both copies sit inside a legitimate guard and
  // pass, while the fleet enqueues the duty twice. A `>=` bound tolerates that
  // regression, so the count that keeps it honest is pinned per controller.
  assert.deepEqual(counts, {
    "scripts/orchestrate.mjs": 1,
    "scripts/patrol.mjs": 3,
    "scripts/watchdog.mjs": 3,
  }, `every controller has exactly its own dispatch sites; found ${sites} total`);
  assert.equal(sites, 7, `expected the controllers to still dispatch; found ${sites} sites`);
  assert.equal(new Set(proof).size, proof.length, `every site needs its own proof: ${proof.join(" | ")}`);
});

/**
 * The window-and-comment check this replaced was defeatable, so the replacement
 * is asserted against that defeat rather than only against the happy path.
 */
test("a comment claiming the guard cannot satisfy the dispatch gate check", () => {
  const file = path.join(ROOT, "scripts", "watchdog.mjs");
  const planted = [
    "export function controller(gh, controlRepository) {",
    "  // every dispatch below is already inside admission.dispatchGuarded(",
    "  /* admission.dispatchGuarded( */",
    '  return () => gh(["workflow", "run", "patrol.yml", "-R", controlRepository]);',
    "}",
    "",
  ].join("\n");

  const line = planted.split("\n")[3];
  const legacyWindow = planted.split("\n").slice(0, 4).join("\n");
  assert.match(legacyWindow, /dispatchGuarded\(/, "the superseded window check would have accepted this");

  const [offset] = siteOffsetsIn(planted);
  const verdict = gatingProof(file, planted, offset);
  assert.equal(verdict.gated, false, `a comment must not prove a guard: ${verdict.via}`);
  assert.match(line, SITE_LINE);
});

test("a real dispatch has to name the guard, not merely mention it nearby", () => {
  const file = path.join(ROOT, "scripts", "watchdog.mjs");
  const ungated = [
    "export function controller(gh, controlRepository) {",
    "  const dispatchGuarded = (input, fn) => fn(input);",
    '  return () => gh(["workflow", "run", "patrol.yml", "-R", controlRepository]);',
    "}",
    "",
  ].join("\n");
  const [offset] = siteOffsetsIn(ungated);
  const verdict = gatingProof(file, ungated, offset);
  assert.equal(verdict.gated, false, `a local binding named dispatchGuarded is not the choke point: ${verdict.via}`);
});

test("self-repair delegation is proven by following the parameter, not by proximity", () => {
  const file = path.join(ROOT, "scripts", "watchdog.mjs");
  const source = readFileSync(file, "utf8");
  const offsets = siteOffsetsIn(source);
  const delegated = offsets.filter((at) => gatingProof(file, source, at).via.includes("self-repair.mjs"));
  assert.ok(delegated.length >= 1, "watchdog.mjs must still hand its self-repair dispatch to the factory");

  const factoryFile = path.join(ROOT, "scripts", "lib", "watchdog-self-repair.mjs");
  const factoryCode = maskJs(readFileSync(factoryFile, "utf8")).code;
  assert.match(
    factoryCode,
    /admission\?\.dispatchGuarded\s*\?\s*admission\.dispatchGuarded\(/,
    "the factory must refuse rather than dispatch when no gate is supplied",
  );
});

test("a dispatch outside the contended repository is ungated and dispatches", () => {
  const h = makeGate({ runs: [run()] });
  const outcome = h.run({ duty: "improve", repo: RUNTIME, workflow: "improve.yml" });
  assert.equal(outcome.ungated, true);
  assert.equal(outcome.dispatch, true);
  assert.deepEqual(h.dispatched.length, 1);
});

/**
 * A caller that cannot name the contended repository has no answer to the only
 * question this gate asks, so it refuses for every duty rather than assuming the
 * target does not contend. This is the `privateRepository()`-throws-to-null shape
 * a caller in the public data class produces, so the refusal has to be a decision
 * and not a crash: a throw here would be caught upstream and republished as an
 * unrelated dispatch failure, and any future copy that let it through as `ungated`
 * would put a run on the one runner whose occupancy nobody read.
 */
test("an unresolved contended repository refuses closed, and never dispatches ungated", () => {
  // `undefined` is omitted here: the harness above uses it as its own "use the
  // default" sentinel, so the dependency-absent shape is asserted directly below.
  for (const unresolved of [null, "", "   "]) {
    const h = makeGate({ runs: [], contendedRepository: unresolved });
    const outcome = h.run({ duty: "patrol", repo: CONTROL, workflow: "patrol.yml" });
    assert.equal(outcome.dispatch, false, `dispatched with contendedRepository ${JSON.stringify(unresolved)}`);
    assert.equal(outcome.ungated, false, `reported ungated with contendedRepository ${JSON.stringify(unresolved)}`);
    assert.equal(outcome.unresolved, true, `did not report the refusal with contendedRepository ${JSON.stringify(unresolved)}`);
    assert.equal(outcome.reason, ADMISSION_REFUSALS.unresolvedContendedRepository);
    assert.deepEqual(h.dispatched, [], `the dispatch ran with contendedRepository ${JSON.stringify(unresolved)}`);
    // Nothing was read, so no occupancy claim is made and no ledger row is charged
    // on a fiction; the refusal is still visible in the audit.
    assert.deepEqual(h.appended, [], `charged a ledger row with contendedRepository ${JSON.stringify(unresolved)}`);
    assert.equal(h.notes.length, 1, `the refusal was not audited for ${JSON.stringify(unresolved)}`);
    assert.equal(h.notes[0].kind, ADMISSION_GUARD);
  }
});

test("an unresolved contended repository refuses closed even with no audit sink", () => {
  // The dependency-absent shape a caller produces when `privateRepository()`
  // throws and the identity is swallowed to null: the gate has no contended
  // repository to compare against and no audit buffer to record the refusal.
  const dispatched = [];
  const gate = createAdmissionGate({});
  const outcome = gate.dispatchGuarded(
    { duty: "patrol", repo: CONTROL, workflow: "patrol.yml" },
    () => dispatched.push(1),
  );
  assert.equal(outcome.dispatch, false);
  assert.equal(outcome.ungated, false);
  assert.equal(outcome.unresolved, true);
  assert.deepEqual(dispatched, [], "a caller with no audit sink must still be refused, not waved through");
});

test("the gate exposes no cancellation capability of any kind", () => {
  // Scanned across the whole admission path, not just the choke point: a cancel
  // verb reintroduced into either dispatcher would defeat the invariant.
  for (const file of admissionSources()) {
    const source = readFileSync(file, "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
      .replace(/^\s*\/\/.*$/gm, "")          // line comments
      .replace(/cancel\s*:\s*false/g, "")    // the invariant flag itself
      .replace(/`(?:[^`\\]|\\.)*`/g, "``")  // template literals
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')  // double-quoted literals
      .replace(/'(?:[^'\\]|\\.)*'/g, "''"); // single-quoted literals
    // Prose may describe what admission prevents; code may not name, bind,
    // import, call, or dispatch a cancellation capability.
    assert.equal(/cancel/i.test(code), false, `${file} names a cancellation capability`);
  }
  // The flag is what makes the invariant checkable at every call site, so pin it.
  assert.match(
    readFileSync(path.join(ROOT, "scripts", "lib", "watchdog-admission.mjs"), "utf8"),
    /cancel: false/,
    "every decision must state that nothing was cancelled",
  );
  assert.deepEqual(
    Object.keys(makeGate().gate).sort(),
    ["admit", "dispatchGuarded", "observation", "reset"],
  );
});

// The contention rule is "a dispatch into the control repository contends",
// which is only true while this repository's own workflows are GitHub-hosted.
// The rule is re-derived here from the workflow files themselves so it cannot rot
// silently if a self-hosted label is ever added.
function schedulesOnSelfHosted(workflowText) {
  // Only the declared value counts; a trailing comment cannot schedule a runner.
  return String(workflowText ?? "")
    .split("\n")
    .some((line) => {
      const value = line.split("#")[0];
      return /^\s*runs-on:/.test(value) && /self-hosted/.test(value);
    });
}

test("fleet-runtime dispatches do not contend for the self-hosted runner", () => {
  // The predicate is pinned in both directions, so this assertion cannot pass
  // merely because the predicate is inert.
  assert.equal(schedulesOnSelfHosted("jobs:\n  b:\n    runs-on: [self-hosted, linux, x64]\n"), true);
  assert.equal(schedulesOnSelfHosted("jobs:\n  b:\n    runs-on: ubuntu-latest\n"), false);
  assert.equal(schedulesOnSelfHosted("runs-on: ubuntu-latest # self-hosted is discussed here\n"), false);

  const dir = path.join(ROOT, ".github", "workflows");
  const contended = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .filter((f) => schedulesOnSelfHosted(readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(contended, [], "a self-hosted workflow here would make ungated dispatches contend");
});
