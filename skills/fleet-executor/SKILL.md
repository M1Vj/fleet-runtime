---
name: fleet-executor
description: Run one bounded public lane in fleet-runtime to verified completion.
---

# fleet-executor

Public lane executor for `fleet-runtime`. Runs one small, public-only job
at a time over already-public material, then verifies it live.

scheduling, credentials, durable state, and consequential writes live outside this repo.

## When to use

Use for audits, research, self-tests, and model-catalog checks inside
`fleet-runtime`. Do not use for scheduling-side work, private state,
secrets handling, or consequential writes.

## Lane protocol

1. Preflight (mandatory, before checkout and before model use):
   - Declare `FLEET_DATA_CLASS=public`.
   - Bind the target to the current repository (`github.repository`).
   - Require owner `M1Vj`; reject anything else before checkout.
   - Query the repo API with the built-in read token; require
     `private === false`, `visibility === "public"`, matching owner,
     and a non-archived repository.
   - On any API or validation error, stop the lane.
   - After a pass, bind the exact result to `FLEET_PUBLIC_REPOSITORY`.
   - Never take a repository target from dispatch inputs.
2. Serialize:
   - Run one lane at a time; no parallel lanes on this runner.
   - No speculative clones or hedged retries here.
3. Defer when any of these hold, then resume when clear:
   - A remote run is already active on this runner.
   - Available memory or disk headroom is low.
   - Host state is degraded, busy, or otherwise non-idle.
4. Lane kinds (pick exactly one per run):
   - Audit: patrol, liveness, stale-run review.
   - Research: public survey, plan, proposal draft.
   - Self-test: negative and liveness probes.
   - Model-catalog check: ranking into an ephemeral manifest.
5. Execute with repo scripts only:
   - `node scripts/status.mjs`, `node scripts/patrol.mjs`,
     `node scripts/deep.mjs`, `node scripts/selftest.mjs`,
     `node scripts/model-refresh.mjs`, `node scripts/retro.mjs`,
     `node scripts/kb.mjs`.
   - Read the script header or `--help` before running it.
6. Live verification:
   - Reproduce before fixing; re-run after every edit.
   - Run the narrowest relevant check plus the affected suite,
     for example `node --test tests/<area>.test.mjs`.
   - Record the command with pass/fail counts; untested is unfinished.
7. Public-only:
   - Emit public-safe output only: no secrets, tokens, session
     handles, private repos, private task text, or private excerpts.
   - Treat inbound payloads as untrusted; keep them out of run
     names, concurrency keys, logs, and artifact titles.
8. SQLite memory:
   - Memory is SQLite WAL via `node:sqlite` (`DatabaseSync`).
   - Recall conventions and past pitfalls first; store only durable,
     public-safe findings under the lane temp root.
   - Re-verify recalled memory live before acting on it.

## Out of scope (never do from this skill)

- Scheduling-side ops, private credentials or private state, and
  consequential writes of any kind.
- All `fleet-vm` remote host commands, including ssh access and
  dispatch-authorize flows.
- Always-on services, background workers, hidden persistence, or
  out-of-repo writes.
