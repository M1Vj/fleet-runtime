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
