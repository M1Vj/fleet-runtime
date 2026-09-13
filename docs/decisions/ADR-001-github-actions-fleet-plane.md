# ADR-001: GitHub Actions as the Fleet execution plane

## Status

Accepted

## Date

2026-09-13

## Context

Fleet must find and process new pull requests across the enrolled `M1Vj`
repositories, revisit older open pull requests, and dispatch upgrade work. The
runtime repository is public; durable queue and audit state live in the private
control repository configured by `FLEET_CONTROL_REPOSITORY`. A single repository workflow cannot receive
pull-request events from every repository without an external ingress service.

The current `orchestrate.yml` workflow plans a matrix from repository and open-PR
discovery, then fans out bounded tasks. `scripts/orchestrate.mjs` validates
owner-scoped events and tasks. `scripts/lib/fleet-scheduler.mjs` keeps scoring
pure and samples upgrade work without replacement.

## Decision

1. **Use public GitHub Actions as the execution plane.** Standard
   GitHub-hosted runners in public repositories are free, while the private
   control repository configured by `FLEET_CONTROL_REPOSITORY` remains the
   state and audit store. The workflow uses
   `repository_dispatch`, `schedule`, and manual dispatch; payloads remain
   untrusted input and are validated before planning.

2. **Use `repository_dispatch` as event ingress.** A future ingress producer
   sends a `fleet-pr` event with the repository, pull-request number, action, and
   GitHub delivery identifier. The workflow runs from the runtime repository's
   default branch; the ingress/state path must record enough delivery history to
   deduplicate retries.

3. **Keep `*/5` as reconciliation, not the real-time path.** Each scheduled
   run rediscovers repositories and open pull requests, reconciles work that
   arrived without a dispatch, and gives stale work another chance. GitHub
   documents that scheduled runs can be delayed under load, so the schedule is
   a recovery mechanism rather than an immediate-delivery guarantee.

4. **Bound each plan at 15 agents.** `MAX_AGENTS = 15` and
   `max-parallel: 15` are application limits chosen below GitHub Free's
   documented 20 concurrent standard-runner jobs, leaving room for other
   workflows and provider/API pressure.

5. **Use explainable weighted selection.** Pull-request priority combines base
   weight, age, time since last visit, event-trigger boost, and explicit
   priority. Repository upgrade weight combines base, tier, priority, manual
   weight, activity recency, repository newness, importance, backlog, and CI
   risk. Repository fairness grows with time since selection; the cooldown is a
   soft multiplier, so a recently selected repository is down-weighted rather
   than barred. Triggered pull requests run first, older pull requests remain
   eligible, and upgrade rows are sampled without replacement.

6. **Keep review tasks read-only.** Review workers may read bounded PR metadata
   and diffs, but they use the default-branch checkout, never check out or
   execute a PR ref (including a ref containing secret-like material), and never
   post comments. Findings are written as bounded local artifacts. PR metadata
   and diff text are treated as untrusted data, not instructions.

7. **Dispatch upgrade work through the improve workflow.** An upgrade task
   dispatches `improve.yml` with an owner-scoped `repo` input only after checking
   that the workflow declares that input. Dispatch success or deferral is
   recorded in the task artifact; the orchestrator does not edit a target
   repository directly.

8. **Defer true account-wide immediate ingress to a GitHub App receiver.**
   Immediate pull-request events from all enrolled repositories require a
   deployed GitHub App webhook receiver that verifies signatures and forwards
   validated events to `repository_dispatch`. A Cloudflare Worker plus Queue is
   an optional free-tier receiver/buffer within its documented limits; it is not
   the execution plane and is not deployed or verified yet. The receiver must
   use the GitHub delivery ID as an idempotency key, support replay/redelivery,
   and leave the five-minute schedule in place to reconcile missed deliveries.

## Alternatives considered

| Alternative | Decision | Reason |
| --- | --- | --- |
| Per-repository bridge workflows | Rejected | Token, secret, and workflow-configuration sprawl across every enrolled repository. |
| Renovate | Rejected as the orchestrator | Useful for optional dependency updates, but it does not provide account-wide PR ingress, review scheduling, stale-work fairness, or upgrade dispatch policy. |
| Self-hosted always-on runner | Rejected | Avoids hosted-minute charges but adds a continuously running machine, patching, availability, and credential/security burden. |
| Schedule-only polling | Rejected | It is neither immediate nor fully reliable; GitHub may delay scheduled runs and missed events can wait for the next poll. |

## Consequences

- One public workflow supplies a free, bounded execution pool without duplicating
  bridge configuration in each target repository.
- Event-driven work can start promptly once the receiver exists; reconciliation
  limits the impact of dropped, delayed, or duplicate deliveries.
- Selection decisions are inspectable and fairer to old PRs and repositories,
  while the 15-task cap keeps bursts bounded.
- Reviews produce evidence without executing untrusted PR code or creating
  automatic comments. Upgrade work incurs a second workflow dispatch and its
  own gates.
- The pending receiver is an explicit operational dependency. Its deployment,
  webhook secret, delivery ledger, replay path, and free-tier capacity require
  separate verification before claiming account-wide immediate ingress.

## References

- [GitHub Actions billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage)
- [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)
- [The `repository_dispatch` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch) and [`schedule`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub Actions concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)
- [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
- [Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
