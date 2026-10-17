// GitHub notices are diagnostics only: no error commands, payloads, or free text.
// Keep one of the ten per-step notice slots for the terminal outcome.
import { writeSync } from "node:fs";
const PHASES = new Set(["preflight", "model", "execution", "persistence", "children", "checks", "judges", "merge"]);
const OUTCOMES = new Set(["SUCCESS", "NO-OP", "BLOCKED", "EXHAUSTED", "STALLED", "REVISION_QUEUED", "NEEDS_HUMAN_REVIEW", "SCAN-DONE", "SCAN-FAILED", "FAILED"]);
const CAUSES = new Set(["none", "unexpected-error", "model-unavailable", "provider-access-denied", "directives-rejected", "directive-execution-failed", "gateway-circuit-open", "child-failed", "push-failed", "public-read-only", "kill-switch-engaged", "kill-switch-unavailable", "kill-switch-invalid", "identity-mismatch", "scope-mismatch", "gate-blocked"]);
const ERROR_CAUSES = new Map([
  ["MODEL_UNAVAILABLE", "model-unavailable"],
  ["PROVIDER_ACCESS_DENIED", "provider-access-denied"],
  ["DIRECTIVES_REJECTED", "directives-rejected"],
  ["PATROL_DIRECTIVE_EXECUTION_FAILED", "directive-execution-failed"],
  ["KILL_SWITCH_ENGAGED", "kill-switch-engaged"],
  ["KILL_SWITCH_SIGNAL_UNAVAILABLE", "kill-switch-unavailable"],
  ["KILL_SWITCH_SIGNAL_INVALID", "kill-switch-invalid"],
  ["KILL_SWITCH_CONFIG_INVALID", "kill-switch-invalid"],
  ["KILL_SWITCH_PATH_INVALID", "kill-switch-invalid"],
  ["KILL_SWITCH_WORKSPACE_PATH_INVALID", "kill-switch-invalid"],
  ["IDENTITY_MISMATCH", "identity-mismatch"],
  ["SCOPE_MISMATCH", "scope-mismatch"],
]);

export function workflowFailureCause(error) {
  // Never stringify an error or inspect its message, stdout, or stderr.
  try { return ERROR_CAUSES.get(error?.reason) || "unexpected-error"; }
  catch { return "unexpected-error"; }
}

export function createWorkflowTelemetry(lane, { now = Date.now, write = console.log, summaryOnly = false } = {}) {
  const safeLane = lane === "patrol" || lane === "merge" ? lane : "unknown";
  let phase = "preflight";
  let active = false;
  let started = 0;
  let notices = 0;
  let phaseLimit = 9;
  let finished = false;
  let failurePhase = "";
  let failureCause = "none";
  const clock = () => {
    try { const value = now(); return Number.isSafeInteger(value) ? value : 0; }
    catch { return 0; }
  };
  started = clock();
  const emit = (status, outcome, cause, terminal = false, outcomePhase) => {
    if (finished || (!terminal && (summaryOnly || notices >= phaseLimit))) return;
    // Time since this invocation began, including any persistence/recovery work.
    const elapsed = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, clock() - started));
    const safeCause = CAUSES.has(cause) ? cause : "unexpected-error";
    const safePhase = terminal ? (PHASES.has(outcomePhase) ? outcomePhase : failurePhase || phase) : phase;
    const line = `::notice title=Fleet runtime::lane=${safeLane} phase=${safePhase} status=${status} outcome=${outcome} cause=${safeCause} elapsed_ms=${elapsed}`;
    notices += 1;
    // A broken diagnostic sink must never change execution or gate results.
    try { write(line); } catch {}
  };
  const end = (cause = "none") => {
    if (!active) return;
    emit(cause === "none" ? "end" : "failed", "none", cause);
    active = false;
  };
  return {
    currentPhase: () => phase,
    phase(next) {
      if (finished) return;
      end();
      phase = PHASES.has(next) ? next : "preflight";
      // A scan reserves three notice slots for its bounded child summaries.
      if (phase === "children") phaseLimit = 6;
      active = true;
      emit("start", "none", "none");
    },
    end,
    fail(error) {
      failurePhase = phase;
      failureCause = workflowFailureCause(error);
      end(failureCause);
    },
    terminal(outcome, cause = failureCause, outcomePhase) {
      if (finished) return;
      end();
      if (cause === "none" && !new Set(["SUCCESS", "NO-OP", "SCAN-DONE"]).has(outcome)) cause = "gate-blocked";
      emit("terminal", OUTCOMES.has(outcome) ? outcome : "FAILED", cause, true, outcomePhase);
      finished = true;
    },
  };
}

export function createMergeWorkflowTelemetry(mode) {
  // Exact sentinels only: no arbitrary file path or descriptor is accepted.
  return createWorkflowTelemetry("merge", {
    summaryOnly: mode === "3" || mode === "off",
    ...(mode === "3" ? { write: (line) => writeSync(3, `${line}\n`) } : {}),
    ...(mode === "off" ? { write: () => {} } : {}),
  });
}
