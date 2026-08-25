# Durable PR Memory and Autonomous Revision Design

- Status: approved by owner for autonomous implementation
- Date: 2026-08-24
- Scope: `M1Vj/fleet-runtime` and its private `M1Vj/fleet-control` state checkout

## Problem

Scheduled merge-gate scans discover rejected fleet PRs, but the workflow revision step receives only manual-dispatch inputs. Scheduled runs therefore invoke revision with an empty repository and PR number and fail at `/repos//pulls/0`. Revision attempts are not persisted to the private state repo, and `revise.mjs` rejects normal repository paths through a hard-coded `v2/` rule.

## Decision

Use existing GitHub Actions and the private `fleet-control` repository. No third-party account or external database is required.

1. Scheduled scans dispatch at most one target-specific merge-gate workflow run with explicit `repo`, `pr`, and mandatory `headSha` inputs and `allow_merge=false`. One global workflow concurrency group with `cancel-in-progress: false` and `queue: max` serializes the scanner, private state writer, and target runs without GitHub's default one-pending-run replacement behavior. Live merge requires a separate intentional manual dispatch.
2. `fleet-control/state/pr-memory.jsonl` is the canonical append-only, redacted event log. Events use deterministic IDs derived from lane, repo, PR, head SHA, event kind, attempt, and content hash. Duplicate writes are no-ops. Records are bounded and rotated through the existing state-commit path.
3. A revision-success PR comment containing a stable marker mirrors a bounded status for human visibility. Prompts, raw diffs, model replies, credentials, and secret-like values never enter state or comments.
4. Revision validates the target before any GitHub API call, verifies an allowlisted `M1Vj` repository, same-repository non-fork `fleet/` head, open PR, and unchanged mandatory head SHA. It allows only non-sensitive files already present in the PR plus at most two non-sensitive supporting files, applies the complete revision as one Git commit with a non-forced ref update, and records start, failure, success, and terminal events.
5. The next revision prompt includes recent sanitized memory events and unresolved judge blockers, so retries are stateful rather than starting from zero.
6. Autonomous targets must be explicitly public. An uncredentialed materialization job fetches the exact authorized head and produces a digest-bound source artifact. Target-controlled install, build, and test commands run from that artifact in a fresh job that has never received model credentials, mutation credentials, or the private state checkout. Trusted scan/gate jobs never execute target code. Private repositories, UI, and sensitive changes remain human-only.

## Interfaces

### Memory event

```json
{
  "schemaVersion": 1,
  "eventId": "sha256(...)",
  "runId": "merge-... (stored for diagnostics, excluded from logical duplicate identity)",
  "lane": "merge|revise",
  "repo": "owner/name",
  "pr": 123,
  "headSha": "40-hex-sha",
  "attempt": 1,
  "kind": "dispatch|judge|revision|terminal|error",
  "state": "DISPATCH_INTENT|DISPATCHED|DISPATCH_UNKNOWN|DISPATCH_FAILED|DISPATCH_CONSUMED|DISPATCH_RELEASED|DISPATCH_HELD|REVISION_INTENT|REVISION_STARTED|REVISION_QUEUED|JUDGE_APPROVED|JUDGE_REJECTED|JUDGE_UNAVAILABLE|ROTATED|SUCCESS|BLOCKED|STALLED|EXHAUSTED|ERROR",
  "createdAt": "ISO-8601",
  "summary": "bounded sanitized text",
  "changedPaths": ["src/example.js"],
  "reviewNotes": ["bounded redacted actionable judge note"],
  "judgeScores": {"correctness": 0, "standards": 0, "threshold": 0, "targetChecksPassed": false},
  "blockerIds": ["sha256(...)"],
  "artifactRefs": ["audit/...md"]
}
```

### Revision queue

The scan path must produce explicit target tuples. A target tuple is valid only when `repo` is an explicitly managed `M1Vj` repository, `pr` is a positive integer, and `headSha` is a 40-hex commit SHA. The workflow rejects missing targets before checkout or API calls, then verifies the live PR author, base/head repositories, `fleet/` branch, open state, and exact head SHA.

## Data flow

```text
scheduled scan
  -> discover fleet PRs
  -> authorize one target from private policy
  -> persist DISPATCH_INTENT with a correlation key
  -> workflow_dispatch(repo, pr, headSha, dispatch_id, allow_merge=false)
  -> append DISPATCHED after acceptance; retain DISPATCH_UNKNOWN on ambiguous failure
  -> authorization consumes only its matching dispatch_id and persists DISPATCH_CONSUMED
  -> uncredentialed public exact-SHA materialization
  -> fresh credential-free target-check job
  -> target merge gate
  -> persist DISPATCH_RELEASED after a retryable/completed result, including missing evidence, or DISPATCH_HELD after policy BLOCKED, APPROVED_NO_MERGE, READY_REQUIRED, MERGE_UNKNOWN, or MERGE_VERIFY_FAILED
  -> judge result + memory event + bounded PR mirror
  -> rejected fleet PR
  -> revision step with same explicit target
  -> model receives prior memory + blockers
  -> validate changed files, create one explicitly attributed commit parented to expected head, non-force update ref, verify attribution
  -> persist revision result; persistence failure is a failed run even after an unavoidable cross-repository partial mutation
  -> next target gate run
```

## Safety and retention

- The existing M1Vj PAT and identity gate remain the only mutation authority. Scheduled runs do not receive merge permission; a live merge additionally requires an intentional manual dispatch and an already-ready PR.
- The default `GITHUB_TOKEN` remains read-only; workflow permissions stay least-privilege.
- PAT and model auth are step-local to trusted orchestration. Neither the materialization job nor any target-controlled process or runner receives either credential or can read the private state checkout.
- Autonomous mutation and merge exclude private repositories, workflows/actions, authentication/security, migrations, infrastructure/deployment, package manifests/lockfiles, environment/credential paths, symlinks, submodules, UI changes, incomplete patches, and oversized file lists.
- State is private and redacted. Text is capped before persistence; secret-like patterns are replaced with `[REDACTED]`.
- At most 200 recent events per target are retained in the prompt; the state file rotates around 2,000 lines while preserving a summary, durable per-PR revision totals, and every latest active dispatch claim, even when that temporarily exceeds the nominal bound.
- Memory appends are durable before they report success. Rotation keeps the canonical file visible until one atomic replacement, maintains a private recovery copy, and fails closed under competing local writers.
- Stale head SHA, closed PR, kill switch, identity mismatch, or pre-mutation state-push conflict produces a named terminal event and no branch mutation. A post-mutation success-state conflict fails the run visibly; it never rewrites or rolls back the target branch automatically.
- Every promised terminal event and identity-verified audit must durably persist; otherwise the run exits code 7 with `STATE_PERSISTENCE_FAILED`.
- Discovery suppresses a target/head while its latest dispatch state is `DISPATCH_INTENT`, `DISPATCHED`, `DISPATCH_UNKNOWN`, `DISPATCH_CONSUMED`, or `DISPATCH_HELD`. A gate terminal state explicitly records `DISPATCH_RELEASED` when a later same-head attempt is allowed, including when the canonical evidence marker is missing. Missing evidence is private `STALLED` with no public comment or revision request. Policy `BLOCKED` records `DISPATCH_HELD` until the head changes. A definite non-ambiguous client rejection records `DISPATCH_FAILED`. An ambiguous result is never retried blindly; a correlated target run may consume it, otherwise an operator reconciles it from GitHub Actions before clearing or retrying.
- Raw model replies, full judge comments, raw diffs, prompts, and raw target test output are never persisted or mirrored. The cross-job evidence artifact is a bounded redacted summary with a digest, and public/private PR comments use controlled wording, blocker hashes, and validated safe paths only.

## Verification contract

- Unit tests must prove deterministic IDs, complete redaction, fail-closed corruption handling, bounded context, durable revision counters, target validation, changed-path policy, and duplicate no-op behavior.
- Workflow static checks must prove scheduled scans never call revision with empty target inputs, scheduled dispatches cannot merge, target code runs in a fresh credential-free job, and the shared state writer is globally serialized.
- Dispatch tests must prove intent is persisted before the API call, intent-push conflict prevents the API call, accepted-dispatch persistence failure leaves a suppressing remote intent across a fresh checkout, 409/429/timeouts remain ambiguous, definite validation rejection can retry, consumption remains claimed until explicit release/hold, active claims survive rotation, and one scan returns at most one eligible target.
- Atomic-update tests must prove a two-file repair produces one commit/ref update, while a stale ref, fork head, sensitive path, symlink, or submodule produces zero branch updates.
- The full local suite must remain green.
- A controlled canary dispatch with `allow_merge=false` must show that the target reaches revision with non-empty inputs and emits a private memory event. No canary or unrelated target PR may be merged during verification.
- A live merge, when later authorized manually, uses `PUT /repos/{owner}/{repo}/pulls/{pr}/merge` with `sha` equal to that gate run's final re-fetched reviewed head and `merge_method: merge`; a mismatch fails closed. A successful or ambiguously lost response is accepted only after the PR and attributed merge commit agree on the merge SHA and reviewed head. Otherwise the dispatch remains held for reconciliation.

## Authoritative references

- GitHub workflow dispatch REST API: https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
- GitHub concurrency queue: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
- GitHub token permissions: https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication#modifying-the-permissions-for-the-github_token
- GitHub workflow artifacts: https://docs.github.com/en/actions/using-workflows/storing-workflow-data-as-artifacts
- GitHub pull-request merge REST API: https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request
- GitHub ref update REST API: https://docs.github.com/en/rest/git/refs#update-a-reference
