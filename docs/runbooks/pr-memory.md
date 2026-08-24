# PR Memory and Dispatch Recovery

`M1Vj/fleet-control/state/pr-memory.jsonl` is the private canonical record for targeted
merge-gate dispatches, judge blocker hashes, and autonomous revision attempts. PR comments are
only bounded, controlled status mirrors. Never copy raw diffs, prompts, model replies, complete
judge comments, raw target test output, credentials, or secret-like values into either surface.

## Record contract

Each line is a versioned JSON event scoped by repository, pull-request number, and head SHA.
The logical event ID also includes lane, event kind, attempt, and a hash of the bounded
content; `runId` is diagnostic and does not defeat cross-run idempotency. Stored text and
arrays are capped and secret-like strings are replaced with `[REDACTED]`.

The canonical file and its `.prev` recovery copy must be regular, non-symlink files inside a
real `state` directory. Appends use private permissions, complete writes, `fsync`, a local
writer lock, and idempotent duplicate detection. Rotation retains recent history plus a
`ROTATED` summary, durable per-PR revision totals, and every latest active dispatch claim;
preserved records may temporarily make the file exceed the nominal line bound. Rotation never
removes the visible canonical file before atomic replacement.

Readers fail closed on malformed JSONL. Under the writer lock, append may repair only a
provably incomplete final fragment that lacks a newline; an invalid complete line or interior
record is corruption and requires operator reconciliation. A valid final record without a
newline is preserved and separated before the next append.

## Dispatch state machine

| State | Meaning | Automatic next action |
| --- | --- | --- |
| `DISPATCH_INTENT` | Correlation key durably committed before the REST request | Suppress the same repo/PR/head until its correlated run consumes it |
| `DISPATCHED` | GitHub accepted the dispatch | Wait for the correlated target run |
| `DISPATCH_UNKNOWN` | Acceptance is ambiguous, such as a network or server failure | Do not retry blindly; reconcile first |
| `DISPATCH_FAILED` | A definite client rejection means no run was accepted | A later scan may make a new attempt after the cause is fixed |
| `DISPATCH_CONSUMED` | Authorization matched the target and correlation key | Keep the same head claimed while the globally serialized target run proceeds |
| `DISPATCH_RELEASED` | The gate completed or reached a retryable terminal state | A later scan may make a new same-head attempt if the PR remains eligible |
| `DISPATCH_HELD` | The gate reached a policy `BLOCKED` result | Suppress the same head; a changed head is evaluated as a new target |

Scanner-generated runs carry a 64-hex `dispatch_id`. Authorization validates the live PR
policy first, then consumes only the matching active event before any target checkout.
Intent consumption is idempotent for a deliberate GitHub run rerun. Intentional manual
dispatches leave `dispatch_id` empty and still must provide an exact repo, positive decimal PR
number, and 40-hex head SHA.

## Revision lifecycle

`REVISION_STARTED` must be appended and pushed before the model call or branch mutation.
`SUCCESS` is appended and pushed immediately after the single attributed commit and
non-forced ref update, before the public status comment. `ERROR`, `BLOCKED`, `STALLED`, and
`EXHAUSTED` explain bounded terminal outcomes. The default cap is two
`REVISION_STARTED` events per repo and PR, so a successful revision's new head does not reset
the allowance. Rotation preserves a summary count, so age or unrelated events cannot reset the
allowance either.

A pre-mutation persistence failure exits without changing the target branch. If the target
commit succeeds but the required `SUCCESS` push fails, the workflow exits nonzero and does
not attempt an automatic rollback across repositories. Reconcile the target commit and the
private state explicitly.

## Reconciliation procedure

1. Keep `merge.yml` disabled if the workflow or credentials are under repair.
2. Identify the exact repo, PR, head SHA, attempt, and `dispatch-key:` reference from the
   private event. Do not print the PAT, model credential, raw evidence, or unrelated state.
3. Check GitHub Actions for a workflow-dispatch run created for that correlation. If it
   exists, let that run consume the event or inspect its terminal result. If evidence is
   inconclusive, preserve `DISPATCH_UNKNOWN` and stop.
4. For a definite rejected dispatch, fix the request or workflow validation problem. A new
   scan may append a higher attempt after `DISPATCH_FAILED`.
5. For post-revision state failure, verify the PR head and attributed commit through the
   GitHub API before recording any recovery event. Never force-update or roll back the branch
   merely to make state agree.
6. For `MERGE_UNKNOWN`, re-fetch the exact PR and commit. Accept success only when the PR is
   merged from the reviewed head and the merge SHA, attribution, and parent structure verify;
   otherwise keep the dispatch held for owner reconciliation.
7. Run an explicit `allow_merge=false` canary and confirm private memory before restoring the
   schedule. A canary must never be used to prove a live merge.

The memory file is append-only operational evidence. Do not hand-edit, truncate, replace, or
delete it during routine recovery.
