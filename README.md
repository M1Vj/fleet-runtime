# fleet-runtime

Public GitHub Actions execution shell that autonomously patrols, audits, improves, and revises the owner's M1Vj repositories. Private judging and revision use governed Zen `claude-opus-4-6`; verified-public research can use the local Antigravity Gemini route or configured public-only API fallbacks. Mutations are identity-gated and post-verified; merging requires an intentional manual dispatch.

## Architecture

```
+---------------------------------------------+
| M1Vj/fleet-runtime  (PUBLIC, this repo)     |
| .github/workflows/*.yml + scripts/*.mjs     |
| free Actions minutes; no private source, credentials, or raw state are durably stored here|
---+---------------------------------------+---
   | checkout/push state + audit           | gh api mutations: issues,
   | into private repo (FLEET_GH_TOKEN)    | comments, labels, draft PRs,
   v                                       | revisions; manual-only merges
+---------------------------------------------+
| M1Vj/fleet-control  (PRIVATE state repo)    |
| state/: targets.json queue.jsonl            |
|   heartbeat.json sessions.json events.jsonl |
|   merges.jsonl pr-memory.jsonl gateway-health.json|
| audit/<date>/<runId>.md   docs/reports/     |
---+---------------------------------------+---
   |
   +-- tier-1 repos (state/targets.json): labels, draft PRs,
   |   guarded revision/judge comments, autonomous revisions, manual merge gate
   +-- all other owned repos: observe-only; findings become
       issues in M1Vj/fleet-control
```

## Lanes

| Workflow | Trigger | Cadence (UTC) | Purpose | Model use |
| --- | --- | --- | --- | --- |
| fleet-patrol | cron, dispatch | 3x/hour :03 :23 :43 | triage repo signals; private reports, labels/draft PRs; enqueue deep tasks; heartbeat | 1 call + repair |
| fleet-watchdog | cron | 4x/hour :09 :24 :39 :54 | heartbeat staleness (90 min): report once, reclaim queue tasks, optional workflow recovery | none |
| fleet-deep | cron, dispatch | 3x/hour :11 :31 :51 | drain state/queue.jsonl, max 4 workers: security/redteam/code-review/docs reports on real clones | <=3 calls/wave |
| fleet-improve | cron, dispatch | hourly at :25 (top_k 3) | pick -> research -> plan -> implement draft PR -> 3-lens review persisted privately | ~5 calls/repo |
| fleet-merge-gate | cron, dispatch | every 15 min | select at most one draft; isolated deterministic checks; 2 advisory judges; block or bounded autonomous revision; merge only on intentional manual dispatch | 2 judges + optional revision |
| fleet-retro | cron, dispatch | daily 05:19 | file [RETRO] loop-improvement issue from telemetry; regenerate docs/status.md | 1 call |
| fleet-selftest | cron, dispatch | daily 06:00 | T1-T11: negatives, idempotency, validator, liveness, attribution proof, watchdog, vision canaries | 2-4 short calls |
| fleet-emergency-stop | dispatch only | manual | commit state/KILL_SWITCH, disable 8 workflows on both repos, confirmation issue | none |
| fleet-thesis | cron, dispatch | 2x/day 07:40 15:40 | THESIS improvement packages under v2/ only; draft PR on M1Vj/THESIS; mirror to docs/thesis-lab/ | 3 long calls |
| fleet-kb | cron, dispatch | 2x/day 09:55 21:55 | OKF knowledge-base synthesis, frontmatter-validated; draft PR on M1Vj/vj-knowledge-base; optional Drive ingest | 3 long calls |
| ci-diag | dispatch only | manual | opencode CLI and gateway connectivity probes | 3 tiny probes |
| revise (merge-gate sub-lane) | eligible judge rejection | automatic | apply one attributed atomic fix commit to the unchanged same-repo `fleet/` head; remember outcomes across runs | 1 call |

CLI is pinned to `opencode-ai@1.18.21`; model registry served from committed snapshot `config/models.json`.

## Provider accounts

Healthy API-key slots may use deterministic round-robin selection. Set
`FLEET_ACCOUNT_ROTATION_SEED` (or rely on `GITHUB_RUN_ID`) to keep one credential assignment
stable within a run while balancing different runs. Authentication rejection can move to another
named slot. Rate or quota errors remain provider-wide unless the provider registry declares
`quotaScope: "credential-group"` and every involved slot supplies validated, distinct group
variables. Gemini groups represent separately declared Google Cloud projects; missing or duplicate
groups fail closed. Use a standard lowercase 6-30 character Google project ID or a 6-20 digit
project number. OpenRouter free limits are account-wide and never trigger same-provider
rotation. No account, project, or API key is created automatically.

Antigravity OAuth remains one owner-Mac OS-keyring session through the official `agy` CLI. It is
not portable to GitHub Actions and does not support concurrent HOME-based profiles. On an owner
TTY, `node scripts/provider-accounts.mjs login antigravity` launches the official `agy --sandbox`
login flow; use the CLI's documented `/logout` before switching accounts. The command refuses
GitHub and non-TTY hosts. `node scripts/provider-accounts.mjs status` gives a secretless view of
configured slot names and health; the helper never reads or copies OAuth caches or keychain data.
Direct Gemini API-key slots may rotate only under the same quota-group policy.

## Safety model

- **Attribution fail-closed**: every run verifies the token identity equals `M1Vj` (type User) and holds `repo` + `workflow` scopes before acting; any mismatch aborts (exit 3/4). Commits are made as the M1Vj noreply identity and re-verified against the API post-push; `[bot]` attribution aborts.
- **Tiered scope**: only `tier1` repos in `state/targets.json` receive labels or draft PRs; everything else is observe-only. Fleet-wide findings may land as issues in fleet-control through the controlled fleet issue path.
- **Patrol freshness and comment boundary**: open-PR signals are keyed by stable head SHA, so comment activity cannot make the same PR look new. Patrol never publishes comments on existing PRs or issues; all such model directives downgrade to private reports, while actionable fixes must use `draft_pr`.
- **Improve review privacy**: the three improve review lenses are persisted as redacted private findings and no longer post advisory comments. Actionable score improvement is owned by the separate exact-head merge judge and bounded revision loop.
- **Directive validation**: model outputs must be strict JSON arrays of whitelisted kinds with size caps, path-safety rules (no `..`, `.env*`, keys, `state/`, `audit/`), branch regex `fleet/<kebab>`, and secret-pattern rejection; one repair round, else exit 5.
- **Human-only boundaries**: private repositories, UI files, workflows/actions, auth/security, login/oauth, permissions/session/access-control paths, migrations, deployment/infra, manifests and lockfiles, environment/credential paths, symlinks, submodules, incomplete metadata, deletions-only changes, and oversized diffs cannot be revised or merged autonomously.
- **Maker-checker judges**: two independent advisory judge lenses (correctness-and-security, industry-standards-and-maintainability) must both approve; score threshold 80 (LOW) or 90 (MEDIUM). Missing, unmarked, or generated-unavailable deterministic evidence produces a private `STALLED` result, no public comment, and `DISPATCH_RELEASED` for a later same-head retry. An unavailable or unparsable judge also produces `STALLED`, never a revision request. Their output cannot by itself authorize a scheduled merge.
- **Secretless deterministic gates**: an uncredentialed materialization job fetches the exact authorized head of an explicitly public target and emits a digest-bound source artifact. A fresh job that has never received the PAT, model credential, or private state checkout runs target-controlled install, build, and test commands; a separate fresh sanitizer job loads the canonical redactor and writes advisory evidence atomically. The exact target-check step outcome remains authoritative. Private repositories and UI work stay human-only.
- **Model workspace profiles**: merge/revise/patrol judges run in a fresh disposable deny-all OpenCode workspace with no repository or private-state checkout. The improve research/plan loop may opt into a fresh `public-read` workspace only after GitHub reports `private=false` and `visibility=public` (and an available tier-1 allowlist permits the repo); read/list/grep/glob are allowed there, while edit, shell, task, external-directory, and web-search tools remain denied. Private/internal targets are rejected before clone or model execution.
- **Expected-SHA mutation**: revisions use one attributed Git Data commit plus a non-forced ref update. A live merge requires an intentional `allow_merge=true` manual dispatch and an already-ready PR; it uses the PR merge endpoint with the re-fetched reviewed SHA and verifies the resulting PR and merge commit. Ambiguous responses are reconciled or held as `MERGE_UNKNOWN`.
- **Durable PR memory**: redacted idempotent events in private `state/pr-memory.jsonl` enforce the two-round revision cap and prevent blind duplicate dispatch after ambiguous failures. Policy `BLOCKED` outcomes hold a claim; retryable `STALLED` outcomes release the matching claim. See [the PR-memory runbook](docs/runbooks/pr-memory.md).
- **Fleet operational memory (per-repo + universal)**: deterministic, bounded memory pages live control-private under `state/memory/` (`UNIVERSAL.md`, `repos/<owner>__<name>.md`). Merge/revise/deep lanes append one-line entries inside the existing durable state commit; retro consolidates reason patterns; judges, the revision agent, and improve planning receive a clearly-labeled **untrusted** excerpt at the top of their private prompts (never in public comments). Only a distilled, redacted digest (`fleet/memory-digest.md`) reaches the personal knowledge base — as a draft PR via the existing KB pipeline, with `[private]` repos excluded and secret-pattern lines stripped. Retention: 40 entries per repo page, 60 universal, ≤32768 chars/page, 240-char summaries with secret-line scrubbing. See the [runbook](docs/RUNBOOK.md#11-fleet-operational-memory).
- **Steadiness**: sha256 idempotency ledger prevents duplicate actions; schedule runs within 10 minutes of the last patrol coalesce to NO-OP; a gateway circuit breaker (30-minute open window) converts sustained model outages into STALLED skips instead of red cascades.

## Attribution guarantee

Fleet-authored commits use `M1Vj <143296579+M1Vj@users.noreply.github.com>`. Post-hoc API verification covers the applicable author/login fields for each mutation. GitHub-generated merge commits are accepted only when the author matches M1Vj, the committer email is either M1Vj's noreply address or GitHub's noreply address, and the reviewed head is a merge parent. Verification failure aborts or holds the run and is recorded in private state.

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
| 7 | required private-state persistence failed |

Core lane terminal states written to `state/events.jsonl` are `SUCCESS`, `NO-OP`, `BLOCKED`, `STALLED`, and `EXHAUSTED`. PR-memory events also use `REVISION_INTENT`, `JUDGE_APPROVED`, `JUDGE_REJECTED`, `JUDGE_UNAVAILABLE`, `ROTATED`, and `ERROR`, plus the dispatch states documented in the PR-memory runbook. Merge-gate decisions in `state/merges.jsonl` additionally use `SCAN-DONE`, `REVISION_QUEUED`, `APPROVED_NO_MERGE`, `READY_REQUIRED`, `STALE_HEAD`, `MERGE_REJECTED`, `MERGE_UNKNOWN`, and `MERGE_VERIFY_FAILED`; `REVISION_QUEUED`, `APPROVED_NO_MERGE`, `READY_REQUIRED`, `MERGE_UNKNOWN`, `MERGE_VERIFY_FAILED`, and policy `BLOCKED` hold a scanner claim until a changed head or explicit reconciliation. Missing evidence is a private `STALLED` result with `DISPATCH_RELEASED`, so the same head can retry. These are merge output states, not additions to the shared lane enum.

## Known limitations

- `fleet-merge-gate` now reads `FLEET_KILL_SWITCH_PATH`; several other production lanes still do not. Committing the `state/KILL_SWITCH` file is the only complete stop: API-level workflow disabling alone is reversible while `FLEET_WATCHDOG_AUTO_ENABLE=true` is set, because an opted-in watchdog may re-enable allowlisted workflows (including `merge.yml`).
- `fleet-emergency-stop` does not disable `fleet-merge-gate` or `ci-diag`; for a fuller halt, disable them explicitly through the Actions API, but that API-level stop is still reversible under the watchdog opt-in (previous bullet).
- Watchdog stale recovery keeps workflow enablement off unless the trusted job receives the exact `FLEET_WATCHDOG_AUTO_ENABLE=true` opt-in. It reuses an open `[WATCHDOG] patrol stale...` issue instead of creating one on every run. The allowlist now includes `merge.yml`, so an opted-in watchdog can restore the merge gate. A watchdog cannot recover itself when it is the disabled or stale component; the paired fleet-control sentinel (hourly, `scripts/sentinel.mjs`) revives exactly runtime `watchdog.yml` + `merge.yml` when control's `FLEET_WATCHDOG_AUTO_ENABLE=true` and no kill switch exists, and if both sentinels stop, only an operator can restore them.
- An unresolved `DISPATCH_UNKNOWN` intentionally suppresses blind retry until a correlated target run consumes it or an operator reconciles GitHub Actions and private state.
- Free hosted fallbacks can still hit 429s or queue delays; hard timeouts, retry ladders, and the circuit breaker contain those failures. VLM color naming on synthetic images remains unreliable.
- Production model auth uses only durable `OPENCODE_API_KEY` provider secrets exposed to model steps; GitHub-hosted workflows do not receive the owner-Mac OAuth snapshot. Missing, rejected, or exhausted credentials fail closed into retryable private errors without mutating targets. The owner-Mac OAuth snapshot refresh (`FLEET_OPENCODE_AUTH`, LaunchAgent keepalive) remains a local migration utility.
- Dispatch inputs `top_files` (fleet-thesis) and `gdrive` (fleet-kb) are accepted but not wired into script behavior.

Operations, procedures, and troubleshooting: see [docs/RUNBOOK.md](docs/RUNBOOK.md).
