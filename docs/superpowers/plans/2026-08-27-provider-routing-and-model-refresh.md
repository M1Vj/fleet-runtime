# Provider Routing and Model Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the fleet to the requested Gemini and Opus buckets through durable, free-or-explicitly-paid provider adapters, and refresh model metadata without relying on 0x Alpha, Chrome, a LaunchAgent, or Codex.

**Architecture:** A committed, secretless provider registry defines bucket order, model IDs, credential names, endpoint provenance, health freshness, and rollback metadata. The model runner resolves a route only after registry validation, credential presence, and policy gates. A fresh health record is preferred; for public-only APIs with no fresh record, the first bounded task request acts as the live canary and fails over without a second quota-consuming preflight. Antigravity OAuth remains local-only and uses the caller's existing credential cache without copying it. GitHub Actions uses durable provider keys. A scheduled refresh job may propose a registry update, but activation requires digest validation, deterministic tests, independent review, a canary, and an automatic rollback record.

**Tech Stack:** Node.js 20 ESM, GitHub Actions, OpenCode CLI, Antigravity CLI, `node:test`, JSON/YAML configuration.

---

### Task 1: Lock the requested provider policy

**Files:**
- Create: `config/providers.json`
- Create: `scripts/lib/provider-registry.mjs`
- Test: `tests/provider-registry.test.mjs`
- Modify: `scripts/lib/model.mjs`
- Test: `tests/model-isolation.test.mjs`

- [ ] **Step 1: Write failing route-selection tests**

  Add tests that load the committed registry, require `gemini-3.7-flash-high` as the first Gemini route, require `claude-opus-4-6` as the first non-Gemini route, reject unverified free slots, reject ambiguous credentials, and return no route when the health snapshot is missing or stale.

- [ ] **Step 2: Run the focused test file**

  Run: `node --test tests/provider-registry.test.mjs tests/model-isolation.test.mjs`

  Expected: FAIL until route resolution is wired into the model runner.

- [ ] **Step 3: Implement the route contract**

  Export these exact functions from `scripts/lib/provider-registry.mjs`: `loadProviderRegistry()`, `validateProviderRegistry(value)`, `resolveProviderCredentials(provider, env, options)`, `assessProviderHealth(provider, env, options)`, `selectProviderRoute(options)`, and `providerSecretMappings(registry)`. Keep credential values out of return objects and reject non-HTTPS endpoints, private addresses, placeholders, and unverified provider metadata.

  Update `resolveModelChain(env)` in `scripts/lib/model.mjs` to honor an explicit `FLEET_MODEL_CHAIN`, then use the registry's `other` bucket as the default chain with `opencode/claude-opus-4-6` first. Add `FLEET_GEMINI_MODEL` as an exact override for Gemini-only lanes; reject unknown model IDs before spawning OpenCode.

- [ ] **Step 4: Run the focused tests again**

  Run: `node --test tests/provider-registry.test.mjs tests/model-isolation.test.mjs`

  Expected: PASS, including assertions that the child process receives only its selected credential and never `FLEET_GH_TOKEN`, legacy auth, or unrelated provider keys.

- [ ] **Step 5: Commit the policy foundation**

  Run: `git add config/providers.json scripts/lib/provider-registry.mjs scripts/lib/model.mjs tests/provider-registry.test.mjs tests/model-isolation.test.mjs && git commit -m "feat: add governed provider routing"`

### Task 2: Add isolated Antigravity and free-provider adapters

**Files:**
- Modify: `scripts/lib/provider-registry.mjs`
- Test: `tests/provider-registry.test.mjs`
- Modify: `.github/workflows/*.yml` only where model env names are already declared
- Modify: `docs/RUNBOOK.md`

- [ ] **Step 1: Write adapter boundary tests**

  Test that Antigravity uses `agy -p <prompt> --model gemini-3.7-flash-high --output-format json`, runs from a disposable cwd, preserves the existing local OAuth cache without copying it, forwards no API key, rejects GitHub runners and calls without `FLEET_ANTIGRAVITY_LOCAL=true`, bounds output and time, and deletes the disposable cwd in `finally`. Test that the generic free API adapter performs no request until endpoint, model, terms, and credential metadata are verified.

- [ ] **Step 2: Implement the adapters**

  Keep `createAntigravityAdapter({ provider, env, allowLocal, spawnImpl })` and `createFreeProviderAdapter({ provider, env, fetchImpl })` as the only external boundaries. Use `shell: false`, an explicit environment allowlist, HTTPS with redirects disabled, an abort timeout, bounded response parsing, and structured output validation. Do not support browser cookies, OAuth snapshots, or arbitrary commands in GitHub jobs.

- [ ] **Step 3: Document credential setup without values**

  Document `GEMINI_API_KEY_1` and `GEMINI_API_KEY_2` as separate optional AI Studio backup secrets, `FLEET_ANTIGRAVITY_LOCAL` as the local OAuth gate, and `OPENCODE_API_KEY` as the durable paid production secret. State that Antigravity OAuth remains local-only and that browser key creation may require the owner to complete Google's challenge.

- [ ] **Step 4: Run adapter tests and syntax checks**

  Run: `node --test tests/provider-registry.test.mjs && node --check scripts/lib/provider-registry.mjs && ruby -e 'require "yaml"; Dir[".github/workflows/*.yml"].each { |f| YAML.load_file(f) }'`

  Expected: PASS with no secret-like values in committed files.

- [ ] **Step 5: Commit the adapters**

  Run: `git add scripts/lib/provider-registry.mjs tests/provider-registry.test.mjs docs/RUNBOOK.md .github/workflows && git commit -m "feat: isolate free provider adapters"`

### Task 3: Make model metadata refresh autonomous but governed

**Files:**
- Create: `scripts/model-registry-refresh.mjs`
- Create: `.github/workflows/model-refresh.yml`
- Modify: `scripts/lib/provider-registry.mjs`
- Test: `tests/model-registry-refresh.test.mjs`
- Modify: `docs/RUNBOOK.md`

- [ ] **Step 1: Write refresh and rollback tests**

  Test that a refresh accepts only allowlisted HTTPS model metadata, records `sha256:<64 hex>` plus `previousDigest`, rejects prompt-injected fields and secret-like text, keeps the active registry unchanged when health probes fail, and emits a bounded `MODEL_ROLLBACK_REQUESTED` record naming the failed digest.

- [ ] **Step 2: Implement refresh in proposal mode**

  Fetch only documented provider model metadata with bounded size, timeout, and redirects disabled. Store a redacted proposal artifact and provenance digest. Never activate it from the scheduled job. The proposal must pass schema validation, deterministic checks, two isolated judge calls, a synthetic canary, and an exact rollback check before a separate promotion step can update the active digest.

- [ ] **Step 3: Add the scheduled workflow**

  Use pinned actions, read-only checkout credentials for the proposal stage, a non-canceling state-writer concurrency group, and no mutation token in the model subprocess. Upload only redacted metadata. Keep the workflow disabled until the candidate passes the release gate.

- [ ] **Step 4: Run refresh tests**

  Run: `node --test tests/model-registry-refresh.test.mjs && node --check scripts/model-registry-refresh.mjs`

  Expected: PASS; failed health or malformed metadata leaves the active digest unchanged.

- [ ] **Step 5: Commit the governed refresh lane**

  Run: `git add scripts/model-registry-refresh.mjs .github/workflows/model-refresh.yml scripts/lib/provider-registry.mjs tests/model-registry-refresh.test.mjs docs/RUNBOOK.md && git commit -m "feat: govern model registry refresh"`

### Task 4: Integrated verification and release gate

**Files:**
- Test: all existing `tests/*.test.mjs`
- Review: every file in `git diff --name-only origin/main...HEAD`

- [ ] **Step 1: Run the full verification set**

  Run: `node --test tests/*.test.mjs`, `node --check` on every changed JS/MJS file, Ruby YAML parsing for every workflow, `actionlint` with only the documented `concurrency.queue` schema diagnostic ignored, `git diff --check`, and a secret-pattern scan classified against deliberate fixtures.

- [ ] **Step 2: Freeze and hash the candidate**

  Record the exact commit, tree, changed-file list, test count, and registry digest in the task ledger. Do not modify the candidate after independent review without re-freezing and re-reviewing.

- [ ] **Step 3: Obtain independent reviews**

  Request a fresh Luna review and a Sol-adversarial review covering credential isolation, prompt injection, provider terms/rate limits, model-selection reachability, rollback truthfulness, and Mac/Codex independence. A BLOCK requires a targeted correction and a new freeze.

- [ ] **Step 4: Release only after a controlled canary**

  Keep merge, patrol, watchdog, and private sentinels disabled during review. After both reviews PASS, configure only the required GitHub secrets, run a draft public-target canary with `allow_merge=false`, verify an attributed revision and rejudge on a new head, then restore schedules and record the exact workflow/run evidence. If no durable provider credential or health probe exists, report the blocker and leave schedules disabled.
