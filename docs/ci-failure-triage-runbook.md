# Fleet CI Failure Triage Runbook

Scope: scheduled fleet workflows (patrol, watchdog, deep, improve).

This file is a general triage procedure for recurring scheduled-workflow failures.
It deliberately contains no incident facts; per-incident windows, run IDs, and root
causes live only in the canonical log referenced below.

## 0. Related documents
- Incident record for 2026-08-23: see `docs/runbooks/ci-failure-triage.md`. That runbook is
  the canonical log of observed failures (windows, run IDs, root cause). Do not restate or
  contradict its facts here; append corrections there.

## 1. Bucket the failures
- Single workflow failing -> inspect that workflow's recent diffs.
- All workflows failing simultaneously -> suspect shared infrastructure: runner quota,
  expired PAT/App token, runner-image change, network egress.
- Same step failing across workflows -> shared script or pinned action version regression.

## 2. Concurrency: do NOT cancel overlapping runs
All fleet workflows intentionally use a fixed per-workflow concurrency group with
`cancel-in-progress: false` (e.g. `.github/workflows/patrol.yml`: group `fleet-patrol`;
merge gate: group `fleet-merge-gate` with `queue: max`). This is deliberate:

- Fleet runs mutate shared private state (`state-control/`). Cancelling a run mid-flight
  can leave partial state behind and corrupt subsequent runs.
- Overlapping cron triggers therefore queue rather than pre-empt.

Enforcement note: this contract is asserted by `tests/workflow-contract.test.mjs` for the
merge gate only (that test reads solely `merge.yml` and asserts the single fixed group
`fleet-merge-gate` with `cancel-in-progress: false` and `queue: max`). The identical
settings on patrol/watchdog/deep/improve are an intentional repo-wide convention guarded
by review, not by an automated contract test.

Do not propose dynamic groups (`${{ github.workflow }}-${{ github.ref }}`) or
`cancel-in-progress: true` as remediation. To reduce overlap, adjust cron schedules via PR
so trigger windows do not collide; never weaken the concurrency contract.

## 3. Verification
- Re-run one canary run per workflow family before mass re-runs.
- Confirm two consecutive clean schedule windows before declaring the incident resolved.
- Record the outcome in `docs/runbooks/ci-failure-triage.md`.

## 4. Escalation
- If token/secret expiry is suspected, rotate via repo settings and re-run. Never commit
  secrets to the repository.
- If failures persist beyond two consecutive windows across all workflows, page the repo
  owner and mark open fleet PRs `do-not-merge`.