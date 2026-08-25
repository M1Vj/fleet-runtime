# Self-Healing Research, Skill, and Tool Fleet Design

- Date: 2026-08-25
- Status: approved by owner through delegated full-autonomy instruction
- Applies to: `M1Vj/fleet-runtime` and the private `M1Vj/fleet-control` state plane

## Goal

The GitHub-hosted fleet must continue working after Codex and the owner Mac stop. It must diagnose and repair eligible rejected pull requests, improve judge results across exact-head revisions, research hard problems on the public internet, learn governed skills, create safe tools, recover from bounded workflow failures, and preserve a verifiable rollback path.

No agent system is perfect. This design targets autonomous recovery for known and testable failure classes. It reports GitHub-wide outages, revoked credentials, exhausted billing, and simultaneous sentinel failure as external blockers.

## Decisions

### GitHub-only runtime

Production jobs may depend on GitHub Actions, the public internet, the private fleet-control repository, and explicitly provisioned GitHub secrets. They may not depend on Codex, a local LaunchAgent, a logged-in Mac session, a local browser, or local OpenCode state.

Model access uses a dedicated provider API key stored in a protected GitHub Environment secret. The workflow exposes it only to the model process as `OPENCODE_API_KEY`. GitHub mutation continues to use the separate `FLEET_GH_TOKEN`. Missing, rejected, or exhausted model credentials fail closed and release retryable claims without mutating a target.

The current OAuth snapshot and Mac refresh service remain migration utilities only. They are not production dependencies. GitHub Models is not a fallback because GitHub [retired the service on July 30, 2026](https://github.blog/changelog/2026-07-01-github-models-is-being-fully-retired-on-july-30-2026/). OpenCode documents Zen as an API-key provider with tested coding models in its [Zen guide](https://opencode.ai/docs/zen/) and [provider guide](https://opencode.ai/docs/providers).

### Protected invariants

Autonomous promotion cannot change these controls:

- exact `M1Vj` identity, token scope, and commit attribution checks;
- public, allowlisted, same-repository `fleet/<kebab>` targets with a mandatory head SHA;
- the kill switch, emergency stop, secret scanner, private-state boundary, and audit persistence;
- target policy, atomic non-force mutation, model isolation, research isolation, or promotion policy;
- protected workflow files, credential configuration, repository visibility, branch protection, or this protected-path manifest;
- scheduled `allow_merge=false`; live target merges remain an intentional exact-SHA operation.

The fleet may open a draft proposal for a protected change. It cannot activate or merge that proposal through self-promotion.

## Self-healing state machine

Every dispatch uses a correlation key tied to repository, pull request, and exact head SHA. A terminal event either releases the claim for retry or holds it for a deterministic reason.

An `always()` finalizer runs after the merge gate. It releases only the exact latest `DISPATCH_CONSUMED` claim when setup failed before the trusted gate script recorded another state. It never releases `DISPATCH_HELD`, `REVISION_STARTED`, `MERGE_UNKNOWN`, a policy block, or a live-merge attempt.

The source collector accepts a tree only when `truncated === false`. Every returned blob must carry the exact SHA named by the tree. Missing or inconsistent API envelopes are retryable infrastructure errors. Explicit truncation, deleted paths, binary files, symlinks, submodules, and size-policy violations remain deterministic blocks.

The runtime watchdog monitors patrol, merge, research, promotion, and routine lanes. A second sentinel in fleet-control monitors the runtime watchdog. Each sentinel can restore the other repository's bounded workflow allowlist only when its own exact auto-recovery variable is `true` and the kill switch is absent. Neither sentinel overrides emergency stop. A malformed heartbeat becomes canonical `unknown`, so repeated runs reuse one alert.

If both sentinels stop or GitHub Actions is unavailable, the fleet records an external recovery limit when service returns. It does not claim that GitHub can recover GitHub itself.

## Research escalation

Research starts when any condition holds:

- the same normalized failure fingerprint occurs twice without a changed head;
- one hard failure has no high-confidence local diagnosis;
- a judge or revision attempt requests missing authoritative information;
- the improve lane seeks precedents for a new idea.

The normalized fingerprint contains an error class, affected check, tool/runtime version, and bounded redacted message digest. It never includes secrets, private paths, raw logs, or private repository text.

```text
failure fingerprint
  -> private RESEARCH_REQUESTED event
  -> isolated research planner
  -> secretless HTTPS retrieval
  -> hostile-content normalization and digest
  -> structured claim and citation extraction
  -> independent citation verifier
  -> local deterministic reproduction
  -> repair, skill, or tool proposal
```

### Research trust boundary

Every page, issue, repository snippet, search result, image, and document is hostile evidence. OWASP states that prompt injection has no foolproof model-only prevention and recommends least privilege, structured output validation, external-content segregation, and strict trust boundaries. The fleet follows those controls from [OWASP LLM01:2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/).

The research job receives no GitHub mutation token, private checkout, cookies, local browser state, or target credentials. It may use HTTPS only. The broker rejects URL credentials, non-public IP ranges, localhost, unsupported ports, unbounded redirects, executable MIME types, oversized responses, hidden payloads, and token-like output.

The retrieval model can search and fetch but cannot read repositories, run shell commands, edit files, invoke skills, create tools, or call mutation APIs. It returns strict JSON claims with source URL, title, retrieval time, content digest, evidence type, short bounded excerpt, confidence, and fact/inference/unknown status. A second deny-all model checks citation support. Deterministic code validates both outputs.

Official documentation and primary repositories receive priority. Community sources require two independent sources and a local reproduction. No command copied from a page executes directly. Research produces hypotheses; trusted local tests decide whether a solution works.

Transient DNS/connect errors, 408, 425, 429, and 5xx responses receive at most three jittered retries while honoring `Retry-After`. Authentication failures, injection flags, policy blocks, unsafe commands, and invalid schemas do not retry blindly. Three consecutive timeouts or five transient failures in ten minutes open a 30-minute source/provider circuit breaker.

## Skill registry

The fleet stores skills under `skills/<skill-id>/SKILL.md` and registers active digests in `config/skills.json`. Each manifest records:

- stable ID and semantic version;
- purpose, inputs, outputs, and applicable lanes;
- source provenance, license, author, and content digest;
- capabilities, protected-path exclusions, and token bounds;
- deterministic fixtures, judge results, canary result, and rollback digest.

Models never invoke unreviewed skill files through an unrestricted skill tool. Trusted code selects an active digest, loads bounded text, labels it as governed instructions, and places all target or web evidence in separate untrusted sections.

A skill can activate automatically only after schema validation, secret scanning, injection linting, deterministic fixtures, two independent judges, and a synthetic canary pass. Failed post-activation health rolls the registry pointer back to the previous digest through an attributed non-force commit.

## Tool registry

Autonomously activated tools use a declarative JSON tool language interpreted by trusted code. Initial operations cover bounded text extraction, JSON selection, source ranking, diff classification, templating, and result aggregation. Tool manifests live in `config/tools.json` and carry the same provenance, capability, test, canary, and rollback fields as skills.

The declarative interpreter has no shell, dynamic imports, package installation, filesystem writes, network access, environment access, credentials, or private state. A model can compose allowed operations but cannot add interpreter opcodes.

The fleet may draft arbitrary executable tool code for owner review. It cannot auto-activate executable code or modify the interpreter, sandbox, policy, workflows, credentials, or protected paths.

## Promotion pipeline

All research-derived repairs, skills, and tools use one promotion policy:

1. Create an isolated `fleet/<kebab>` branch at an exact base SHA.
2. Produce one atomic attributed commit with no force update.
3. Reject protected paths, unsafe file types, undeclared capabilities, secrets, and dependency changes.
4. Run deterministic target checks in a secretless job.
5. Run independent correctness and adversarial judges from private bounded evidence.
6. Run a synthetic canary against the exact candidate digest.
7. Auto-merge only safe skill manifests, skill text, declarative tool manifests, fixtures, and generated documentation after every gate passes.
8. Persist the prior active digest and monitor post-activation health for rollback.

Public PR comments are optional, bounded mirrors. Private append-only events remain canonical. Comment failures never relabel a repair, research result, promotion, or rollback.

## State and serialization

Private state adds:

- `state/research.jsonl` for request, source, claim, verification, and reproduction events;
- `state/promotions.jsonl` for candidate, judge, canary, activation, and rollback events;
- references from `state/pr-memory.jsonl` by digest and correlation ID only.

Runtime writers share one non-canceling `fleet-state-writer` concurrency group. The fleet-control sentinel does not write these logs. Events stay bounded, redacted, idempotent, append-only, recoverable, and durably committed before downstream mutation.

## Acceptance scenarios

```gherkin
Feature: Autonomous repair recovery
  Scenario: Gate setup fails after an exact dispatch was consumed
    Given the latest correlated state is DISPATCH_CONSUMED
    And no gate or mutation state was recorded
    When the finalizer runs
    Then it persists DISPATCH_RELEASED for only that correlation
    And the unchanged head becomes eligible for a later scan

  Scenario: GitHub returns an incomplete exact-source envelope
    Given a tree omits truncated=false or a blob SHA differs from its tree entry
    When revision collects exact-head sources
    Then it records a retryable private error
    And releases only the exact held claim
    And performs no model or Git mutation

  Scenario: A malformed heartbeat repeats
    Given the heartbeat timestamp is invalid
    When the watchdog runs twice
    Then both runs use the canonical unknown alert identity
    And reuse one verified open issue
```

```gherkin
Feature: Hostile internet research
  Scenario: A repair fails twice with the same fingerprint
    Given no changed target head
    When the second bounded repair attempt fails
    Then the fleet persists one RESEARCH_REQUESTED event
    And dispatches one secretless research run

  Scenario: A fetched page contains prompt injection
    Given a page tells the agent to reveal secrets or run commands
    When the research broker normalizes the page
    Then the text remains untrusted evidence
    And no credential, mutation tool, shell, or private file is available
    And promotion requires independent citations and a local reproduction
```

```gherkin
Feature: Governed self-improvement
  Scenario: A skill candidate passes every gate
    Given its manifest and digest pass protected-path and secret policy
    And deterministic fixtures and two judges pass
    And the synthetic canary passes
    When promotion activates the skill
    Then the active registry points to the exact candidate digest
    And the previous digest remains available for rollback

  Scenario: A generated tool requests executable authority
    Given a candidate uses code outside the declarative tool language
    When autonomous promotion evaluates it
    Then activation is blocked
    And the fleet may create only a draft owner-review proposal
```

## Verification and release

Implementation requires focused unit tests for every scenario, full Node tests, JavaScript syntax checks, workflow YAML parsing, actionlint with only documented stale-schema exceptions, secret scanning, cumulative diff checks, and a fresh exact-tree Luna plus Sol-adversarial review.

Deployment proceeds through a draft PR canary with `allow_merge=false`. The canary must show an actual rejected judge result, private actionable feedback, an attributed atomic revision, a changed head, and a new judge score. Production then receives the durable provider key, exact auto-recovery variables, paired sentinels, and restored schedules. The release is incomplete until a scheduled run succeeds with Codex and local refresh services stopped.

## Non-goals

- autonomous changes to credentials, billing, visibility, branch protection, emergency stop, or protected policy;
- automatic cleanup of existing duplicate watchdog issues;
- execution of commands copied from internet sources;
- claims of recovery from a GitHub-wide outage or simultaneous failure of both sentinels;
- arbitrary executable self-created tools without owner review.
