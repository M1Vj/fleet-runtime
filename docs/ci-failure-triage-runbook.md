# Fleet CI Failure Triage Runbook

Scope: scheduled fleet workflows (patrol, watchdog, deep, improve).

## 1. Bucket the failures
- Single workflow failing -> inspect that workflow's recent diffs.
- All workflows failing simultaneously -> suspect shared infrastructure: runner quota, expired GITHUB_TOKEN/PAT, network egress.
- Same step failing across workflows -> shared script or action version regression.

## 2. Incident notes: 2026-08-23
- 15 failures between 19:37Z and 21:55Z spanning every fleet workflow.
- No open PRs or issues correlate with the start time.
- Action: pull logs for run 32661809220 (earliest) and compare with run 32669011795 (latest).

## 3. Stop the bleeding: concurrency
Add a concurrency block to each scheduled workflow so overlapping cron triggers cancel stale runs:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

## 4. Verification
- Manually re-run the earliest failed run.
- Confirm two consecutive clean schedule windows before declaring the incident resolved.

## 5. Escalation
- If token/secret expiry is suspected, rotate via repo settings and re-run. Never commit secrets to the repository.