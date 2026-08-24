# Durable PR Memory and Autonomous Revision Implementation Plan

**Goal:** Make scheduled fleet PR gating dispatch correctly targeted revision jobs and preserve bounded, redacted memory across runs.

**Architecture:** Add pure memory and target-validation modules. Scheduled merge scans dispatch explicit target workflow runs. Targeted merge/revision runs append idempotent events to private `fleet-control`, mirror a bounded status comment, and pass recent context into revision prompts.

**Tech Stack:** Node.js ESM, GitHub CLI/REST, GitHub Actions YAML, Node built-in test runner.

---

### Task 1: Durable PR memory module

**Files:**
- Create: `scripts/lib/pr-memory.mjs`
- Test: `tests/pr-memory.test.mjs`

- [x] Write failing tests for deterministic event IDs, redaction of token-like text, duplicate no-op append, bounded context selection, and line rotation.
- [x] Run `node --test tests/pr-memory.test.mjs`; confirm the new module is missing.
- [x] Implement pure helpers plus file-backed `appendMemoryEvent`, `readMemoryEvents`, `buildMemoryContext`, and `rotateMemory` without external dependencies.
- [x] Make append/rotation durable and crash-safe: private permissions, complete writes plus fsync, atomic canonical replacement with recovery, fail-closed local writer contention, and no-follow checks for canonical/recovery files and the state directory.
- [x] Re-run focused and full tests.
- [x] Commit the memory implementation and security corrections.

### Task 2: Target validation and revision contract

**Files:**
- Modify: `scripts/revise.mjs`
- Create or modify: `scripts/lib/revision-queue.mjs`
- Test: `tests/revision-queue.test.mjs`, `tests/revise-contract.test.mjs`

- [x] Write failing tests for missing target rejection before API calls, valid owner/repo and PR parsing, changed-path allowlist, two-file supporting-file cap, unsafe path rejection, and declared summary/imported validators.
- [x] Run focused tests and record the expected failures.
- [x] Implement explicit target validation, changed-file policy, current-head verification, durable start/error/success events, and memory-fed revision prompts.
- [x] Replace the hard-coded `v2/` rule with the actual PR changed-path allowlist plus safe supporting-file policy.
- [x] Verify comments through the existing attribution helper and persist state through the private checkout.
- [x] Apply the complete revision as one attributed Git Data commit and one non-forced expected-head ref update.
- [x] Re-run focused and full tests and commit the implementation.

### Task 3: Targetized scheduled dispatch

**Files:**
- Modify: `scripts/merge.mjs`
- Modify: `.github/workflows/merge.yml`
- Test: `tests/revision-queue.test.mjs`, `tests/workflow-contract.test.mjs`

- [x] Write failing contract tests proving scan output contains explicit target tuples and workflow revision cannot run without `repo`, `pr`, and `headSha`.
- [x] Implement scan dispatch through the GitHub workflow-dispatch API with at most one target per scan; fan-out is prohibited.
- [x] Persist a correlated `DISPATCH_INTENT` before dispatch, distinguish accepted, definite failure, and ambiguous failure, suppress outstanding heads, consume only the matching correlation in authorization, and retain the claim until an explicit release/hold event.
- [x] Add workflow inputs for `repo`, `pr`, mandatory `headSha`, and optional scanner `dispatch_id`; keep one globally serialized state-writer workflow and keep scheduled scan and targeted runs distinct.
- [x] Run target-controlled checkout/install/build/test in a separate job with no model or mutation credential and no private state checkout.
- [x] Enforce the managed-repository, same-repository `fleet/` head, sensitive/UI-path, complete-patch, and exact-SHA policies.
- [x] Merge through the pull-request merge endpoint only with the reviewed SHA and verify the returned merge SHA, PR state, author/committer attribution, and merge-parent structure.
- [x] Configure global concurrency with `queue: max` so serialization does not cancel earlier pending target runs.
- [x] Preserve the latest active dispatch claims across memory rotation, even when they temporarily exceed the nominal line bound.
- [x] Ensure `GITHUB_OUTPUT` values are bounded and no scheduled path invokes `revise.mjs` with empty inputs.
- [x] Run focused tests and current actionlint. Actionlint 1.7.12 predates GitHub's May 2026 `queue` addition and reports only that known stale-schema diagnostic; with that one diagnostic ignored, it reports no other error.
- [x] Commit target dispatch and subsequent security corrections.

### Task 3b: Frozen-review hardening

**Files:** workflow, merge/revision/memory implementation, and direct contract tests.

- [x] Fail closed on incomplete GitHub file responses, non-success target checks, malformed memory, state/output persistence failures, and ambiguous merge responses.
- [x] Preserve per-PR revision totals through rotation and persist controlled judge blocker IDs in canonical memory.
- [x] Split uncredentialed public-target materialization from fresh credential-free target execution; prove by workflow contract test that neither job receives a mutation token or private state.
- [x] Keep scheduled dispatches at `allow_merge=false`; require an already-ready PR for a manually authorized live merge.
- [x] Unify secret detection/redaction and restrict public comments to controlled wording.
- [x] Isolate every judge/revision model in a deny-all disposable workspace, screen model output before Git objects, and keep target evidence on a fresh trusted sanitizer path.
- [x] Retain `APPROVED_NO_MERGE` and other held dispatch claims, make terminal/audit persistence fail visibly with code 7, and reject malformed merge response SHAs.
- [x] Run focused and full tests, syntax checks, diff check, and commit the hardening revisions (`b3cbe14`, `9ed7123`).

### Task 4: Documentation and operational diagnostics

**Files:**
- Modify: `README.md`
- Modify: `docs/RUNBOOK.md`
- Create: `docs/runbooks/pr-memory.md`

- [x] Document the event schema, redaction boundary, retention, target dispatch, and recovery procedure.
- [x] Add a failure taxonomy for missing target, stale head, model unavailable, validation rejection, dispatch ambiguity, and state-push conflict.
- [x] Document `REVISION_INTENT`, `JUDGE_APPROVED`, `JUDGE_REJECTED`, `ROTATED`, all held causes, explicit-public/declared-check constraints, and exact partial-revision reconciliation commands.
- [x] Run the final local secret-pattern scan and actionlint after the documentation commit candidate is frozen; actionlint is clean after ignoring only its documented stale `concurrency.queue` diagnostic.
- [x] Commit `docs: document autonomous PR memory and recovery` (`3e85357` after rebase).

### Task 5: Independent review and live proof

**Files:**
- Review all changed files and commits; no additional source files unless a review finding requires them.

- [x] Rebase onto current `origin/main` (`aef1d93`) without conflicts and run the complete local suite.
- [ ] Freeze the candidate commit and obtain independent correctness/security reviews of the actual diff plus an independent documentation review of the frozen hashes.
- [ ] Keep `merge.yml` disabled while merging the implementation and restoring credentials.
- [ ] Enable only long enough to dispatch a controlled `allow_merge=false` canary, verify non-empty target inputs, isolated target checks, atomic revision behavior, and private memory, then reconcile the canary.
- [ ] Re-enable scheduled operation only after the canary passes; otherwise leave it disabled and record the exact blocker.

- [x] Run `node --test tests/*.test.mjs` (164/164) and actionlint on all workflows; ignore only actionlint 1.7.12's documented stale `concurrency.queue` diagnostic.
- [x] Run a read-only static secret-pattern scan; hits are confined to deliberate scanner/test fixtures, and the commit hook passed the documentation packet.
- [ ] Dispatch one targeted merge-gate run against an existing fleet draft with no merge permission and inspect the workflow logs, private state event, and target inputs.
- [ ] Re-fetch both remotes, inspect the complete diff, and verify attribution on any state commit/comment.
- [ ] Record PASS/BLOCK evidence in the task ledger and only then consider pushing the implementation branch.
