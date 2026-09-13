# RUNBOOK — fleet-runtime public operations

This repository is the public execution shell. Its workflows are secretless,
read-only, and limited to live-verified public repositories owned by `M1Vj`.
The private controller is the only place that may retain credentials, private
repository content, durable queue/state, model sessions, or write authority.
Do not move those responsibilities into this repository.

## 1. Public target contract

Each operational workflow starts with a `validate public target` step. The
workflow target is always its current `github.repository`, and it is accepted
only when all of the following hold:

- it is a single `owner/name` value with a conservative repository-name regex;
- `owner` is exactly `M1Vj`;
- `GET /repos/{owner}/{name}` succeeds with the built-in read token (or an
  anonymous public request);
- the response says `private: false` and `visibility: public`;
- the API owner matches the allowlist; and
- the repository is not archived.

The target is rejected before checkout, model execution, and task execution on
any validation or API error. Scheduled runs use the current public repository
and manual runs are bound to that same repository; no workflow-dispatch input
can select another repository. After the preflight passes, the exact validated
target is exported as `FLEET_PUBLIC_REPOSITORY`. Pull-request numbers and
other workflow-specific controls are accepted only after the target has passed
the same check. Never supply a private repository identifier to a public run.

Public state is ephemeral below `${{ runner.temp }}/fleet-public-state`.
`FLEET_PUBLIC_ARTIFACT_MANIFEST` points to one exact JSON file. A missing,
invalid, or incomplete manifest is not a successful result. No workflow uploads
a directory, recursive glob, prompt, provider trace, private path, or failure
log.

## 2. Running a public workflow

The hosted workflows are intentionally kept disabled until the owner approves
the release gates. A local operator can inspect or dispatch a workflow without
changing its permissions:

```bash
gh workflow list -R M1Vj/fleet-runtime
gh workflow run fleet-patrol.yml -R M1Vj/fleet-runtime
gh workflow run fleet-deep.yml -R M1Vj/fleet-runtime -f workers=3
gh workflow run fleet-merge-gate.yml -R M1Vj/fleet-runtime -f pr=1
gh run list -R M1Vj/fleet-runtime --limit 10
gh run watch <run-id> -R M1Vj/fleet-runtime
```

Do not pass private repository names, private task identifiers, prompts, source
excerpts, session identifiers, or credentials as inputs. Public workflow event
payloads are treated as untrusted and are never copied into run metadata.

The `fleet-public` repository-dispatch type carries no target data; an empty
dispatch causes the workflow to use its own public repository. A controller
that needs to process a private target must use its private execution plane.

## 3. Public workflow capabilities

- `fleet-patrol`, `fleet-watchdog`, and `fleet-retro` perform public liveness,
  signal, and telemetry checks.
- `fleet-deep` and `fleet-improve` preserve bounded fan-out, research,
  planning, implementation proposals, and independent review for public data.
- `fleet-merge-gate` performs read-only risk, deterministic, and visual checks
  for a public pull request. It cannot merge, comment, label, or push.
- `fleet-kb` and `fleet-thesis` preserve their multi-stage public pipelines;
  each stage exchanges only the exact public manifest.
- `fleet-model-refresh` ranks the public free-model catalog into ephemeral
  state. Model adapters retain their configured capability and waiting behavior;
  no provider credential is placed in a public job.
- `ci-diag` runs anonymous CLI and catalog probes only.
- `fleet-emergency-stop` validates a stop request and records a local,
  ephemeral marker. Durable halt/re-arm actions belong to the private plane.

## 4. Model and capacity policy

Model selection is adapter-owned. Workflows provide the public data class and
the public target; adapters preserve the contributor-free primary, configured
effort, tool access, parallelism, continuation, compaction, and output floors.
When all compliant free capacity is unavailable, the task enters a durable
waiting state and resumes after the provider reset/cooldown. It never switches
to paid capacity, fabricates progress, or bypasses provider limits.

## 5. Verification and incident handling

Run the focused airlock checks before any review:

```bash
node --test tests/public-airlock.test.mjs
```

The suite verifies that every workflow has no private-control references,
secrets, unsafe event contexts, broad artifacts, or failure-log dumps; uses only
the built-in token; declares `FLEET_DATA_CLASS=public`; validates targets before
work; and parses YAML with Ruby/Psych when available.

For a failed validation or provider response, preserve the run and its exact
error status. Do not retry with another credential, alter visibility, disable
the guard, or delete logs/artifacts. Record the run identifier and hand the
private details to the controller through its approved channel.

## 6. Release gates

Before enabling any hosted workflow, the owner must verify:

1. all public taint sentinels stay out of logs, metadata, artifacts, and model
   requests;
2. every target is rechecked for public visibility at execution time;
3. public jobs use only the built-in read token and immutable action pins;
4. manifests reject unknown fields, private identifiers, prompts, paths, and
   secret-shaped values;
5. runtime, controller, and adapter manifests agree on capability and data
   class; and
6. rollback preserves active sessions and does not replay uncertain effects.

Keep hosted workflows disabled when any gate is unverified. Historical logs and
artifacts are preserved; cleanup requires a separate owner decision.
