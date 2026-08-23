# RUNBOOK — fleet-control operations

All commands assume `gh` authenticated as M1Vj on the Mac.

## Secrets (owner Mac only, values never displayed)

Refresh model auth material (needed whenever OpenCode auth changes locally):

    node scripts/refresh-auth-secret.mjs ~/.local/share/opencode/auth.json

Refresh the GitHub token:

    gh auth token | gh secret set FLEET_GH_TOKEN -R M1Vj/fleet-control

or via the helper:

    gh auth token > /tmp/t && node scripts/refresh-auth-secret.mjs --token /tmp/t && rm /tmp/t

## Manual runs

    gh workflow run fleet-selftest -R M1Vj/fleet-control
    gh workflow run fleet-patrol -R M1Vj/fleet-control
    gh workflow run fleet-deep -R M1Vj/fleet-control -f workers=5
    gh run list -R M1Vj/fleet-control --limit 5

Watch a run: `gh run watch <id> -R M1Vj/fleet-control`. Deep reports land in
`docs/reports/`; the durable work queue is `state/queue.jsonl` (pending / in_progress /
done / blocked). A worker crash self-heals: its task is reclaimed after 40 minutes.

## Emergency stop

    gh workflow run fleet-emergency-stop -R M1Vj/fleet-control -f confirm=STOP

This commits `state/KILL_SWITCH`, disables patrol/watchdog/selftest, and opens a
confirmation issue. Re-arm:

    git rm state/KILL_SWITCH && git commit -m "[fleet] re-arm" && git push
    gh api -X PUT repos/M1Vj/fleet-control/actions/workflows/patrol.yml/enable
    gh api -X PUT repos/M1Vj/fleet-control/actions/workflows/watchdog.yml/enable
    gh api -X PUT repos/M1Vj/fleet-control/actions/workflows/selftest.yml/enable

## Changing fleet scope

Edit `state/targets.json` (`tier1` array) and push. Only tier-1 repos receive comments,
labels, or draft PRs; all other owned repos are observe-only with findings filed as
issues in this repo.

## Interpreting audit logs

Each run writes `audit/<YYYY-MM-DD>/<runId>.md`: steps, attempts, incidents. Exit codes:
2 kill switch, 3 identity mismatch, 4 scope mismatch, 5 rejected directives/executor,
1 other failure. A failed patrol still commits its failure audit when identity was
already verified.

## Session resume

Model sessions are recorded in `state/sessions.json`. To continue a prior reasoning
session manually on any machine with opencode installed:

    OPENCODE_AUTH_CONTENT="$(cat ~/.local/share/opencode/auth.json)" \
      opencode run -s <sessionId> "follow-up prompt"

## Known upstream behavior (opencode CLI, researched 2026-08-22)

The Ox/Alpha gateway model is free and popular; the CLI has documented failure modes
(anomalyco/opencode issues #8203, #22243, #29134): on API errors like 429 rate limits,
`opencode run` can hang silently with zero output instead of exiting. The fleet's
countermeasures:

- Hard per-call timeouts with spaced retries (fresh sessions; anonymous-mode fallback
  round — the free stealth endpoint accepts unauthenticated calls).
- Model-heavy matrix jobs run `max-parallel: 1` so sub-agents never stampede the
  gateway (self-inflicted rate limits were observed).
- On failure, workflows dump `~/.local/share/opencode/log/*.log` tails.
- Watchdog alerts persist when the model stays unreachable.

If hangs become chronic, options: raise cron spacing, or pin a paid/alternate model id
in `scripts/lib/model.mjs` (single line) — attribution and gating logic are
model-independent.

## Quota notes

Private-repo Actions minutes are metered (~2000/mo free). Patrol ≈ every 2h at :17;
watchdog hourly at :43 (lightweight). If quota pressure appears, raise the patrol cron
interval by editing `.github/workflows/patrol.yml`.

## Hardening backlog

- Pin actions/checkout and actions/setup-node by commit SHA.
- Optional: environment protection rules requiring owner review for patrol dispatches.
