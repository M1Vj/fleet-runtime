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

## Escalation
If the merge gate stays red beyond 2 hours, page the repo owner and mark open fleet PRs `do-not-merge`.

---

Incident window: 2026-09-12 23:19-00:03 UTC.

## Observed failures
- `merge gate scan#` - 1 failure (run 34725129509). Blocks all merges; highest priority.
- `fleet deep` - 1 failure (run 34725422303 in M1Vj/fleet-control).
- `fleet kb` - 1 failure (run 34725502502).
- `fleet improve` - 1 failure (run 34727000584).

## Pattern
Four unrelated workflows across two repos fail within 44 minutes. Strongly indicates shared root cause: FLEET_GH_TOKEN / FLEET_OPENCODE_AUTH expiry or quota exhaustion, or opencode gateway 429 cascade triggering circuit breaker (model.mjs gateway health opens for 30 min after full chain failure). Not per-workflow logic regressions.

## Steps
1. Check merge-gate run 34725129509 logs for first error: auth failure (401/403), rate limit (429), or 'gateway circuit open' message.
2. Verify secrets on both repos: `gh secret list -R M1Vj/fleet-runtime` and `gh secret list -R M1Vj/fleet-control` — confirm FLEET_GH_TOKEN and FLEET_OPENCODE_AUTH exist and are current.
3. If token expiry: run `scripts/refresh-auth-secret.mjs` locally with fresh PAT and opencode auth, then push to both repos via `gh secret set`.
4. If gateway 429 cascade: wait for 30-min circuit breaker expiry (or manually remove `state/gateway-health.json` in fleet-control), then re-run failed jobs.
5. Re-run one canary per family: merge-gate, fleet-deep, fleet-kb, fleet-improve.
6. Log root cause and resolution in this file.

## Escalation
If the merge gate stays red beyond 2 hours, page the repo owner and mark open fleet PRs `do-not-merge`.