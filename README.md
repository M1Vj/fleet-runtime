# fleet-runtime

`fleet-runtime` is the public, read-only execution shell for Fleet. It runs
audits, research, self-tests, model-catalog checks, and other bounded work over
repositories that are already public. The public shell never receives private
repository content, private credentials, private state, or private task
metadata. A separate controller owns private scheduling, credentials, durable
state, and consequential writes.

## Public airlock

Every operational workflow declares `FLEET_DATA_CLASS=public` and starts with a
public-target preflight. The preflight:

1. binds the target to the workflow's current repository (`github.repository`);
2. requires the owner to be the fixed public owner allowlist (`M1Vj`);
3. queries the GitHub repository API with the built-in `${{ github.token }}`;
4. requires `private === false`, `visibility === "public"`, a matching owner,
   and a non-archived repository; and
5. writes the validated target only to a step output, never to a run name or
   concurrency key before validation.

Repository targets are not workflow-dispatch inputs. After validation, the
workflow binds the exact result to `FLEET_PUBLIC_REPOSITORY`; manual runs may
use only any workflow-specific non-repository controls that are declared.
Private repository identifiers must never be supplied to a public workflow.

Unknown, malformed, private, internal, archived, or API-error targets fail
closed before checkout, model execution, or task execution. Public jobs use an
ephemeral state root below the runner temporary directory. Their only optional
artifact is the exact JSON file named by
`FLEET_PUBLIC_ARTIFACT_MANIFEST`; broad directories, recursive globs, and
failure-log dumps are not uploaded.

The built-in token is read-only (`contents: read`, with pull-request read access
only where a public pull-request check needs it). No workflow reads a secret,
checks out a private controller, receives a model credential, or consumes an
untrusted event payload. Public workflows are intentionally safe to leave
disabled while the private controller decides when to run them.

## Workflows

| Workflow | Cadence | Public capability |
| --- | --- | --- |
| `fleet-patrol` | `:03`, `:23`, `:43` | Public repository signal patrol and bounded recommendations |
| `fleet-watchdog` | `:09`, `:24`, `:39`, `:54` | Public liveness and stale-run checks |
| `fleet-deep` | `:11`, `:31`, `:51` | Public deep analysis with bounded worker fan-out |
| `fleet-improve` | Every two hours at `:25` | Public research, planning, implementation proposals, and review |
| `fleet-merge-gate` | Every 15 minutes | Read-only checks for a selected public pull request |
| `fleet-orchestrate` | Every five minutes or an empty `fleet-public` dispatch | Public task planning and execution |
| `fleet-retro` | Daily at `05:19` | Public telemetry digest and improvement proposal |
| `fleet-selftest` | Daily at `06:00` | Public negative and liveness checks |
| `fleet-thesis` | `07:40`, `15:40` | Public survey, draft, refine, and ship pipeline |
| `fleet-kb` | `09:55`, `21:55` | Public inventory and synthesis pipeline |
| `fleet-model-refresh` | Mondays at `03:23` | Free-model catalog ranking into an ephemeral manifest |
| `fleet-emergency-stop` | Manual | Validates a public stop request without changing external state |
| `ci-diag` | Manual | Anonymous CLI and public catalog probes |

Model selection remains adapter-owned. The public workflows pass model policy
and the public data class; they do not carry provider credentials or alter the
effective model/effort/tool capabilities. The contributor-free ladder remains
the default, with bounded retries and an explicit waiting state when compliant
capacity is unavailable.

## Safety and result handling

- Public jobs do not execute repository-provided workflow code. A target
  checkout is isolated at `public-target` and is treated as data.
- User inputs are passed through environment variables and validated in the
  shell; they are not interpolated into shell source, run names, or concurrency
  groups.
- Public result manifests are schema-checked by the runtime before a job can
  publish the exact JSON manifest. A missing or malformed result is a failed or
  deferred task, never an implied success.
- Public workflows have no write permission. Publishing comments, branches,
  pull requests, merges, durable state, or controller records belongs to the
  private plane.
- In `fleet-improve`, the public stage may inspect the validated repository,
  produce bounded research, and generate ephemeral plan/review proposals. Its
  final receipt is `awaiting-control` with `desiredTaskCompleted: false`; only
  the private controller may implement, comment, commit, or otherwise make the
  durable task change.
- Action references are immutable commit pins. Keep the pins current through a
  reviewed dependency update.

## Local checks

Run the focused public airlock suite from this repository:

```bash
node --test tests/public-airlock.test.mjs
```

The suite scans every workflow for private references, privileged secrets,
unsafe event contexts, broad artifact paths, and failure-log dumps; exercises
the owner/visibility fail-closed contract with fixtures; and parses all
workflow YAML with Ruby/Psych when available.

The remaining runtime suites can be run with the repository's normal Node test
command. Hosted workflows stay disabled until the controller and release gates
have independently verified privacy, target visibility, model parity, and
result integrity.
