# fleet-runtime

Public GitHub Actions execution shell that autonomously patrols, audits, improves, and safely merges the owner's M1Vj repositories using the Ox/Alpha model (`opencode/x-preview-f-free`), with every mutation attributed fail-closed to the M1Vj user account.

## Architecture

```
+---------------------------------------------+
| M1Vj/fleet-runtime  (PUBLIC, this repo)     |
| .github/workflows/*.yml + scripts/*.mjs     |
| free Actions minutes; no secrets or state   |
---+---------------------------------------+---
   | checkout/push state + audit           | gh api mutations: issues,
   | into private repo (FLEET_GH_TOKEN)    | comments, labels, draft PRs,
   v                                       | merges -- always as M1Vj
+---------------------------------------------+
| M1Vj/fleet-control  (PRIVATE state repo)    |
| state/: targets.json queue.jsonl            |
|   heartbeat.json sessions.json events.jsonl |
|   merges.jsonl gateway-health.json          |
| audit/<date>/<runId>.md   docs/reports/     |
---+---------------------------------------+---
   |
   +-- tier-1 repos (state/targets.json): comments, labels,
   |   draft PRs, judge-gated auto-merges
   +-- all other owned repos: observe-only; findings become
       issues in M1Vj/fleet-control
```

## Lanes

| Workflow | Trigger | Cadence (UTC) | Purpose | Model use |
| --- | --- | --- | --- | --- |
| fleet-patrol | cron, dispatch | 3x/hour :03 :23 :43 | triage repo signals; comments/labels/draft PRs; enqueue deep tasks; heartbeat | 1 call + repair |
| fleet-watchdog | cron | 4x/hour :09 :24 :39 :54 | heartbeat staleness (90 min): re-enable workflows, reclaim queue tasks, alert issue | none |
| fleet-deep | cron, dispatch | 3x/hour :11 :31 :51 | drain state/queue.jsonl, max 3 workers: security/redteam/code-review/docs reports on real clones | <=3 calls/wave |
| fleet-improve | cron, dispatch | every 2 h at :25 | pick -> research -> plan -> implement draft PR -> 3-lens review posted | ~5 calls/repo |
| fleet-merge-gate | cron, dispatch | every 15 min | risk classify, secret scan, build, visual gate, 2 judges, auto-merge or block; PR hygiene; autonomous revision | 2 judges (+VLM advisory) |
| fleet-retro | cron, dispatch | daily 05:19 | file [RETRO] loop-improvement issue from telemetry; regenerate docs/status.md | 1 call |
| fleet-selftest | cron, dispatch | daily 06:00 | T1-T11: negatives, idempotency, validator, liveness, attribution proof, watchdog, vision canaries | 2-4 short calls |
| fleet-emergency-stop | dispatch only | manual | commit state/KILL_SWITCH, disable 8 workflows on both repos, confirmation issue | none |
| fleet-thesis | cron, dispatch | 2x/day 07:40 15:40 | THESIS improvement packages under v2/ only; draft PR on M1Vj/THESIS; mirror to docs/thesis-lab/ | 3 long calls |
| fleet-kb | cron, dispatch | 2x/day 09:55 21:55 | OKF knowledge-base synthesis, frontmatter-validated; draft PR on M1Vj/vj-knowledge-base; optional Drive ingest | 3 long calls |
| ci-diag | dispatch only | manual | opencode CLI and gateway connectivity probes | 3 tiny probes |
| revise (merge-gate sub-lane) | on judge rejection | automatic | push fixes addressing judge blockers on the PR branch | 1 call |

CLI is pinned to `opencode-ai@1.18.21`; model registry served from committed snapshot `config/models.json`.

## Safety model

- **Attribution fail-closed**: every run verifies the token identity equals `M1Vj` (type User) and holds `repo` + `workflow` scopes before acting; any mismatch aborts (exit 3/4). Commits are made as the M1Vj noreply identity and re-verified against the API post-push; `[bot]` attribution aborts.
- **Tiered scope**: only `tier1` repos in `state/targets.json` receive comments, labels, or PRs; everything else is observe-only. Fleet-wide findings always land as issues in fleet-control.
- **Directive validation**: model outputs must be strict JSON arrays of whitelisted kinds with size caps, path-safety rules (no `..`, `.env*`, keys, `state/`, `audit/`), branch regex `fleet/<kebab>`, and secret-pattern rejection; one repair round, else exit 5.
- **Tiered merge risk**: HIGH (`.env*`, migrations, `infra/`, `.okf/`, workflow deletions, deletions-only, >800-line diffs) blocks auto-merge and requires a human; MEDIUM (Dockerfile, additive workflow edits, auth/security paths, lockfiles, 250-800 lines) raises the judge bar; LOW is standard.
- **Maker-checker judges**: two independent judge lenses (correctness-and-security, industry-standards-and-maintainability) must both approve; score threshold 80 (LOW) or 90 (MEDIUM); an unavailable or unparsable judge counts as reject.
- **Visual gates** (UI-touching PRs): before/after screenshots at desktop and mobile viewports; console errors or critical axe violations block; pixel diff is recorded; the VLM regression verdict is advisory only.
- **Deterministic gates**: npm install and build must pass on the PR head; secret-pattern hits in the diff block immediately.
- **Steadiness**: sha256 idempotency ledger prevents duplicate actions; schedule runs within 10 minutes of the last patrol coalesce to NO-OP; a gateway circuit breaker (30-minute open window) converts sustained model outages into STALLED skips instead of red cascades.

## Attribution guarantee

All writes are performed by `M1Vj <143296579+M1Vj@users.noreply.github.com>`. Post-hoc API verification covers commit author and committer email/login, issue authors, comment authors, and PR authors (PRs must also be drafts until judged). Verification failure aborts the run and is recorded in the audit log.

Exit codes (defined in `scripts/lib/gate.mjs` and lane scripts):

| Code | Meaning |
| --- | --- |
| 0 | success or intentional skip (coalesced, circuit-open) |
| 1 | generic failure |
| 2 | KILL_SWITCH_ENGAGED (requires `FLEET_KILL_SWITCH_PATH`; see limitations) |
| 3 | IDENTITY_MISMATCH (missing token, wrong login, or bot identity) |
| 4 | SCOPE_MISMATCH (token lacks repo/workflow scopes) |
| 5 | rejected model output (directives / thesis draft / KB package failed validation) |
| 6 | MODEL_UNAVAILABLE after the full fallback ladder |

Named terminal states written to `state/events.jsonl`: `SUCCESS`, `NO-OP`, `BLOCKED`, `STALLED`, `EXHAUSTED`. Merge decisions go to `state/merges.jsonl` using the same vocabulary.

## Known limitations

- Production workflows do not set `FLEET_KILL_SWITCH_PATH`, so exit 2 is exercised only by selftest T2; the operational stop is API-level workflow disabling.
- `fleet-emergency-stop` does not disable `fleet-merge-gate` or `ci-diag`; merge-gate keeps scanning on its 15-minute schedule unless manually disabled.
- The watchdog's stale-alert issue body references an undefined variable (`ageMs`), so stale-recovery runs apply the re-enables but then exit nonzero without filing the alert or committing that cycle's state.
- `revise.mjs` fails to persist `state/revisions.jsonl` (unimported fs helpers, silently caught), so the intended 2-revision cap is not enforced across runs.
- Deterministic checks run `npm test` non-blockingly (`|| true`); builds and installs are blocking.
- If visual evidence cannot be produced (app not servable), the visual gate records a neutral pass with a note rather than blocking.
- Single free gateway model: 429-driven silent hangs are mitigated by hard timeouts, retry ladders, and the circuit breaker, not eliminated; VLM color naming on synthetic images is unreliable.
- Model auth freshness depends on the owner Mac refreshing `FLEET_OPENCODE_AUTH` every ~30 minutes; the anonymous fallback round works but is degraded capacity.
- Dispatch inputs `top_files` (fleet-thesis) and `gdrive` (fleet-kb) are accepted but not wired into script behavior.

Operations, procedures, and troubleshooting: see [docs/RUNBOOK.md](docs/RUNBOOK.md).
