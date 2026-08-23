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

## Dedicated agents

- **fleet-thesis** (2×/day): a THESIS genius agent — surveys the thesis repo, drafts a
  substantial improvement package, red-teams and polishes it in a second long session,
  then opens a draft PR. **Everything lands under `v2/` only; existing files are never
  touched.** Mirrors land in private `fleet-control/docs/thesis-lab/`.
- **fleet-kb** (2×/day): knowledge-base synthesis agent — inventories the OKF graph,
  finds stale claims/missing links, writes new OKF-compliant files (frontmatter-validated),
  opens draft PRs on `vj-knowledge-base`. Google Drive ingestion activates automatically
  once owner sets `GDRIVE_REFRESH_TOKEN` / `GDRIVE_CLIENT_ID` / `GDRIVE_CLIENT_SECRET`
  secrets (+ optional `GDRIVE_FOLDER_ID` var); fetched text lands in
  `fleet-control/docs/gdrive-inbox/` and gets synthesized into proper domain files.
  Until then it runs in local-content mode and reports `DRIVE_NOT_CONFIGURED`.

Long-session policy: these agents get up to 5-round model ladders with session resume,
600s per call, 45–75 minute job ceilings — depth over cheapness.
