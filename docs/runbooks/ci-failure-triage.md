# CI Failure Triage Runbook

Incident window: 2026-08-23 13:30-15:00 UTC.

## Observed failures

- `merge gate scan` - 3 failures (runs 32643967935, 32645177819, 32646450763). Blocks all merges; highest priority.
- `fleet deep` - 3 failures (32643136229, 32644224918, 32645876576).
- `fleet kb` - 1 failure (32645764880).
- `fleet thesis` - 1 failure (32645762890).
- `fleet patrol` - 1 failure (32645487525).

## Pattern

Unrelated workflows fail at near-identical timestamps (kb/thesis at 14:32:51/54), indicating a shared cause: expired or over-quota token, runner-image change, or a common setup script - not per-workflow logic bugs.

## Steps

1. Open the newest merge-gate run and capture the first error line; look for auth (401/403), rate-limit, or runner-provisioning errors.
2. Diff `.github/workflows/*` for changes merged in the preceding hour.
3. Auth/quota: rotate the PAT/App token or raise quota, then `gh run rerun <id> --failed`.
4. Workflow regression: revert via PR - never direct-push to a default branch.
5. Re-run one canary per workflow family before mass re-runs.
6. Log the root cause and resolution.

## Fail-fast guards

These guards are invariant across every triage below. Do not remove or weaken them:

1. Fail closed on the first error signal. An unknown, malformed, private, archived, or API-error target stops triage before checkout, model execution, or mass re-run.
2. One canary per workflow family before any mass re-run. If the canary fails, stop and re-triage; do not fan out.
3. Revert via PR only. Never direct-push to a default branch, never force-push, and never delete logs or artifacts to make a gate green.
4. Public-shell boundary: this repository is the public, read-only execution shell. It never receives private repository content, private credentials, or private task metadata. Credential rotation, durable state edits, and consequential writes belong to the private controller. This runbook must not instruct a public job to read a secret, handle a token value, or mutate controller state.
5. Preserve evidence: record the exact run identifier, head SHA, first error line, and gate verdict before any rerun. A missing or redacted-evidence rerun is not a pass.

## Hermetic verification and gated live triage

The required triage verification check is hermetic by default so it runs identically in CI, in a container without network, and on a laptop without credentials.

Hermetic (always runs, no network, no secrets) - run both suites locally:

    node --test tests/public-airlock.test.mjs
    node --test tests/ci-failure-triage.test.mjs

The hermetic check parses this runbook and every workflow with only local file reads: it asserts a single Escalation section, exactly one trailing newline, no secret-shaped values, no broad artifact paths, and that live GitHub API probes are never unconditional. It exits non-zero on any violation (fail-fast).

Live triage (gated, never unconditional):

- Live GitHub API probes (gh run view, gh api, hosted re-runs) are explicitly gated behind the repository variable FLEET_LIVE_TRIAGE.
- When FLEET_LIVE_TRIAGE is unset or set to any value other than 1, live steps are skipped with the clear skip reason live-triage-disabled (hermetic mode: set FLEET_LIVE_TRIAGE=1 to enable live probes).
- When FLEET_LIVE_TRIAGE=1, live steps run with the built-in read token only from this shell; any credential rotation is escalated to the private controller owner through the approved channel and is never performed from the public shell.

Example gate (indented shell, no fence needed):

    if [ "${FLEET_LIVE_TRIAGE:-0}" != "1" ]; then
      echo "SKIP live triage: live-triage-disabled (hermetic mode: set FLEET_LIVE_TRIAGE=1 to enable live probes)"
      exit 0
    fi
    gh run view <run-id> -R M1Vj/fleet-runtime --log-failed

## Incident - 2026-09-12 23:19-00:03 UTC (four-family correlated failure)

### Observed failures

- `merge gate` - 1 failure (run 34725129509). Blocks all merges; highest priority.
- `fleet deep` - 1 failure (run 34725422303 observed in M1Vj/fleet-control).
- `fleet kb` - 1 failure (run 34725502502).
- `fleet improve` - 1 failure (run 34727000584).

### Pattern (hypothesis, not confirmed)

Four unrelated workflows across two repositories fail within 44 minutes. The correlation window suggests a shared dependency rather than four independent per-workflow logic regressions. Candidate shared causes under investigation: credential expiry or quota exhaustion, model gateway rate-limit (429) cascade with circuit-breaker hold-open, or runner-image / setup-script change. Do not assert any single cause as fact until the evidence steps below confirm the first error signature.

### Steps (hermetic first, gated live second)

1. Hermetic first: run node --test tests/public-airlock.test.mjs and node --test tests/ci-failure-triage.test.mjs locally. If either fails, fix the local regression before any live probe.
2. Gated live (requires FLEET_LIVE_TRIAGE=1, otherwise skip with live-triage-disabled): open merge-gate run 34725129509 and capture the first error line. Classify strictly as auth failure (401/403), rate limit (429), gateway circuit-open message, runner-provisioning error, or workflow logic error. Record the exact line and head SHA.
3. Gated live: diff .github/workflows/* for changes merged in the preceding hour. If a workflow change precedes the window, treat it as a regression suspect and revert via PR.
4. Credential/quota hypothesis: do not read, print, or rotate token values from this public shell. Escalate to the private controller owner to verify credential health and quota through the approved channel, then perform a single canary gh run rerun <id> --failed per family only after the owner confirms.
5. Gateway cascade hypothesis: if the first error line shows repeated 429s followed by a circuit-open message, wait for the documented cooldown expiry before any rerun; do not loop reruns against an open circuit. Controller-state inspection and reset belong to the private plane.
6. Re-run one canary per family (merge-gate, fleet-deep, fleet-kb, fleet-improve). If any canary fails, stop (fail-fast) and return to step 2. Only after all four canaries pass may broader reruns proceed.
7. Log the confirmed root cause and resolution in this file under this incident heading, with run identifiers, first error lines, and the canary outcome.

### Evidence log (to be filled on resolution)

- First error line (merge-gate 34725129509): _pending_.
- First error lines (deep 34725422303, kb 34725502502, improve 34727000584): _pending_.
- Confirmed root cause: _pending (do not close as token expiry, quota, or gateway cascade without log evidence)_.
- Resolution and canary outcome: _pending_.

## Escalation

If the merge gate stays red beyond 2 hours, page the repo owner and mark open fleet PRs `do-not-merge`.