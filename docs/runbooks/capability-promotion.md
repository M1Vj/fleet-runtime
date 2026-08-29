# Governed capability promotion

`scripts/promote-capability.mjs` evaluates a candidate skill or declarative-v1
tool and emits a redacted plan. Its default planner mode does not commit, push,
dispatch a workflow, call a model, or contact a remote service. The trusted
workflow opts into the separately guarded `--execute` adapter described below.

The private state log lives at `state/promotions.jsonl`. Writers normalize and
redact events, use deterministic IDs, fsync complete records, reject symlinks,
and keep the file bounded. An equivalent retry is a no-op. State corruption
fails closed. The trusted workflow commits each execution event in the private
state checkout; candidate jobs never receive that checkout or its token.

Automatic activation requires every gate below:

- the manifest schema and digest match the candidate bytes or declarative
  manifest;
- changed paths stay within `skills/<id>/SKILL.md` plus the intended registry,
  and the secret scan finds no credential-like value;
- each deterministic fixture records a named observed result and passes;
- at least two distinct named trusted judge IDs pass for the exact candidate
  digest;
- a synthetic canary passes for that exact digest;
- the rollback digest matches a real digest-pinned registry seed for the same
  ID. The seed may be `inactive` (the built-in first-promotion path) or
  `active`; rollback restores the exact prior status and bytes.

Missing IDs, duplicate identities, generic placeholders, pending fixtures,
generic canaries, equal candidate and rollback digests, and absent prior
registry seeds remain blocked. Existing built-ins are intentionally inactive
and have no judge, canary, or rollback evidence. They cannot activate until a
new candidate supplies real evidence and names the committed inactive seed.

Protected paths and executable tools produce an owner-review draft only. The
auto path prepares a branch and draft pull request with an exact expected
digest, `force: false`, and the `M1Vj` noreply attribution. `activatePromotion`
accepts an injected committer for tests. The trusted workflow's `--execute`
path uses a separately audited GitHub-data adapter: it verifies `runGate`
identity, creates `fleet/capability-*` from the exact base SHA, writes only the
registry pointer (and skill bytes when applicable), updates the branch with
`force: false`, and opens a draft PR. It never writes the default branch or
opens a ready PR. The default CLI path remains plan-only.

Post-activation health failures produce a pointer-only rollback plan. The plan
re-reads the current `main` SHA and registry, requires the live pointer to still
match the candidate digest, restores the verified prior digest from that fresh
base, uses a non-force draft pull request, and contains no arbitrary code.

## Manual workflow boundary

`.github/workflows/promote-capability.yml` accepts manual dispatches only. Both
jobs require `vars.FLEET_PROMOTION_ENABLE == 'true'`. The candidate job runs
without secrets or private state, executes the local contract tests, and
uploads the immutable plan. The trusted job has `contents: write` and
`pull-requests: write`, checks `runGate` identity with its step-local token,
executes the exact non-force branch/commit/push/draft-PR adapter, and commits
the redacted event log to the private state checkout. No job runs unless the
owner gate is exactly enabled.

## Recovery

1. Preserve the candidate JSON, plan digest, and private promotion event.
2. Confirm the registry still points at the candidate digest before preparing a
   rollback plan.
3. Use the exact rollback transaction in a separate owner-approved draft PR;
   it restores the verified prior manifest status, bytes, and digest.
4. Re-run the candidate and state tests after any source or registry change.
