# ADR-001: GitHub Actions execution with a private Fleet controller plane

## Status

Accepted

## Date

2026-09-13

## Context

Fleet must find and process new pull requests across the enrolled `M1Vj`
repositories, revisit older open pull requests, and dispatch upgrade work. The
runtime repository is public; durable queue, authorization, and audit state
live in the private control repository configured by `FLEET_CONTROL_REPOSITORY`.
The fixed `fleet-runner` self-hosted Actions job is the private lightweight
poll/controller plane. It reconciles bounded state and dispatches work, but it
runs no model and exposes no public listener. GitHub-hosted Actions remains the
model-heavy execution plane; public runtime workers remain read-only and the
private controller retains the only publication boundary.

The controller workflow is `cloud-agent.yml`; it dispatches the private
`orchestrate.yml` review workflow or `improve.yml` issue/build workflow after
admission, authorization, and target-contract checks. `scripts/orchestrate.mjs`
validates owner-scoped events and tasks. `scripts/lib/fleet-scheduler.mjs` keeps
scoring pure and samples upgrade work without replacement. A local `systemd`
timer, if enabled, is credential-free diagnostic refresh only and is not a
second controller or execution path.

## Decision

1. **Use GitHub Actions as a two-plane system.** The fixed `fleet-runner`
   self-hosted job is the private lightweight poll/controller plane: it owns
   bounded reconciliation, durable private state, admission, authorization,
   and workflow dispatch. GitHub-hosted Actions remains the model-heavy
   execution plane. The VM runs no model and is not an alternate publisher.
   Public runtime workers remain read-only; the private controller retains the
   only publication boundary. The controller and runtime workflows use
   `repository_dispatch`, `schedule`, and owner manual dispatch; payloads
   remain untrusted input and are validated before planning.

2. **Use `repository_dispatch` as event ingress.** A future ingress producer
   sends a `fleet-pr` event with the repository, pull-request number, action, and
   GitHub delivery identifier. The workflow runs from the runtime repository's
   default branch; the ingress/state path must record enough delivery history to
   deduplicate retries.

3. **Keep `*/5` as best-effort reconciliation, not delivery.** The private
   controller's five-minute schedule rediscovers repositories and open pull
   requests, reconciles work that arrived without a dispatch, and gives stale
   work another chance. GitHub documents that scheduled runs can be delayed or
   omitted under load, so this schedule is a recovery mechanism rather than an
   immediate-delivery guarantee. A local systemd timer, if present, is
   credential-free diagnostics only and cannot dispatch or publish.

4. **Bound each review plan at 15 agents and serialize heavy execution.**
   `MAX_AGENTS = 15` and
   `max-parallel: 15` are application limits chosen below GitHub Free's
   documented 20 concurrent standard-runner jobs, leaving room for other
   workflows and provider/API pressure. The private controller admits or
   dispatches at most one heavy issue-to-draft-PR execution at a time; review
   workers remain bounded independently.

5. **Use explainable weighted selection.** Pull-request priority combines base
   weight, age, time since last visit, event-trigger boost, and explicit
   priority. Repository upgrade weight combines base, tier, priority, manual
   weight, activity recency, repository newness, importance, backlog, and CI
   risk. Repository fairness grows with time since selection; the cooldown is a
   soft multiplier, so a recently selected repository is down-weighted rather
   than barred. Triggered pull requests run first, older pull requests remain
   eligible, and upgrade rows are sampled without replacement.

6. **Keep public review tasks read-only.** Review workers may read bounded PR
   metadata and diffs, but they use the default-branch checkout, never check
   out or execute a PR ref (including a ref containing secret-like material),
   and never publish comments. Findings are written as bounded local artifacts.
   Advisory review publication is a private-controller exception only when an
   enrolled repository sets `FLEET_ALLOW_REVIEW_COMMENTS=true`. It is limited to
   one idempotent summary comment and/or commit status after immediate `M1Vj`
   identity, source-head, task/revision binding, enrollment, and kill-switch
   revalidation. Inline comments, issue-build authority, and merges are never
   allowed. PR metadata and diff text are treated as untrusted data, not
   instructions.

7. **Dispatch upgrade work through the improve workflow.** An issue build
   dispatches `improve.yml` only after checking its declared `repo`, `issue`,
   `focus`, `top_k`, `request_id`, `request_revision`, and `authorization_id`
   inputs. The request must carry the exact canonical `issue-to-draft-pr`
   action, `fleet-cloud-agent.v1` policy, `draftOnly: true`, and an unexpired,
   single-use, revision-bound owner authorization. The controller revalidates
   the workflow and target just before dispatch; success, deferral, or unknown
   effect is recorded in private state. The runtime does not edit a target
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
| Model-heavy self-hosted worker | Rejected | A self-hosted model worker would add patching, availability, credential, and isolation burden. The fixed `fleet-runner` is retained only as a private lightweight controller/diagnostic host. |
| Schedule-only polling | Rejected | It is neither immediate nor fully reliable; GitHub may delay scheduled runs and missed events can wait for the next poll. |

## Consequences

- The fixed private controller supplies bounded reconciliation and dispatch while
  GitHub-hosted Actions supplies the model-heavy execution pool. No model runs
  on `fleet-runner`.
- Event-driven work can start promptly once the receiver exists; reconciliation
  limits the impact of dropped, delayed, or duplicate deliveries.
- Selection decisions are inspectable and fairer to old PRs and repositories,
  while the 15-task cap keeps bursts bounded.
- Public reviews produce evidence without executing untrusted PR code or
  publishing. The private controller may publish only the bounded advisory
  summary/status exception under an enrolled repository's
  `FLEET_ALLOW_REVIEW_COMMENTS=true` policy; issue builds incur a second
  `improve.yml` dispatch and their own exact authorization and draft gates.
- The pending receiver is an explicit operational dependency. Its deployment,
  webhook secret, delivery ledger, replay path, and free-tier capacity require
  separate verification before claiming account-wide immediate ingress.
- GitHub-hosted Actions billing for private execution remains an unresolved
  verification/blocker; this ADR makes no claim that private hosted minutes are
  free.

## References

- [GitHub Actions billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage)
- [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)
- [The `repository_dispatch` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch) and [`schedule`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub Actions concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)
- [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
- [Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
