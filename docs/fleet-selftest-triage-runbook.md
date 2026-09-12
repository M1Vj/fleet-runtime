# Fleet Selftest Triage Runbook

Failing run: 34589043909 (2026-09-11) https://github.com/M1Vj/fleet-runtime/actions/runs/34589043909

## Steps
1. Run scripts/fleet-triage-snapshot.sh <run-id> to capture failed-run logs (from #3).
2. Attach snapshot to triage issue and link to this run.
3. Fix forward, rerun via `gh run rerun 34589043909 --repo M1Vj/fleet-runtime`.
4. After landing, close superseded drafts #2 and #3.

## Guardrails
- Do not push to default branch; use draft PR.
- Keep workflow concurrency single-flight where applicable.
