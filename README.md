# fleet-runtime

PUBLIC execution shell for the M1Vj engineering fleet (state & audit trail live in the
private `M1Vj/fleet-control`). Public repos get free unlimited Actions minutes, so all
heavy Ox/Alpha agent waves run here at high cadence while sensitive data stays private.

Nothing sensitive lives in this repo: no secrets (GitHub-masked), no state files, no
audit logs. All mutations across M1Vj repos are performed by the authenticated user
**M1Vj** and verified post-hoc; runs fail closed on any identity mismatch.

## Lanes

| Workflow | Cadence | Purpose |
| --- | --- | --- |
| fleet-patrol | every 20 min | triage all owned repos; comments/labels/draft-PRs |
| fleet-deep | every 20 min | drain audit queue: security / redteam / review / docs sub-agents |
| fleet-improve | every 2h | research → plan → implement draft PR → 3-lens review |
| fleet-watchdog | every 15 min | heartbeat + auto-re-enable + alerts |
| fleet-selftest | daily + manual | negative tests, model liveness, attribution proof |

Model: `opencode/x-preview-f-free` (`--variant max`) via OpenCode CLI pinned to 1.18.21,
registry served from a committed snapshot (`config/models.json`) to avoid upstream hangs.
