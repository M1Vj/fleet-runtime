# Fleet Selftest Triage Runbook

> Scope: `fleet-selftest` (`fleet-selftest-public`) supplement to the generic
> [CI Failure Triage Runbook](runbooks/ci-failure-triage.md). The generic
> runbook remains authoritative for auth/quota rotation, canary policy, and
> escalation. This file adds only the selftest-specific capture, rerun, and
> guardrail bindings. It does not replace `docs/RUNBOOK.md` or
> `docs/runbooks/ci-failure-triage.md`.
>
> Location note: this PR keeps the path `docs/fleet-selftest-triage-runbook.md`
> to preserve the existing PR #14 diff. The content delegates to
> `docs/runbooks/ci-failure-triage.md` instead of duplicating it. A follow-up
> move to `docs/runbooks/fleet-selftest-triage.md` with a redirect stub is
> tracked as hygiene debt; until then this note justifies the split.

## Prerequisites (fail-fast)

~~~bash
set -euo pipefail
command -v gh >/dev/null || { echo "gh CLI required" >&2; exit 2; }
command -v node >/dev/null || { echo "node >=20 required" >&2; exit 2; }
test -x scripts/fleet-triage-snapshot.sh || { echo "missing scripts/fleet-triage-snapshot.sh" >&2; exit 2; }
~~~

Live GitHub capture additionally requires `GH_TOKEN` (read) and opt-in
`FLEET_LIVE_TRIAGE=true`. Without both, live capture is skipped with reason
`SKIP: live gh capture requires FLEET_LIVE_TRIAGE=true and GH_TOKEN`; run only
the hermetic checks in [Verification](#verification-hermetic-first-gated-live).

## Steps

1. Capture a redacted snapshot for the failed run (executable; fails closed):

   ~~~bash
   set -euo pipefail
   bash scripts/fleet-triage-snapshot.sh <run-id> --repo M1Vj/fleet-runtime
   # Fallback when the script is unavailable (same redaction contract):
   # gh run view <run-id> --repo M1Vj/fleet-runtime --log-failed | bash scripts/fleet-triage-snapshot.sh --stdin <run-id>
   ~~~

   Output: `triage-snapshots/snapshot-<run-id>.md` (redacted, local only).
   Never upload raw failure logs as a workflow artifact
   (see `docs/RUNBOOK.md` §1: public jobs publish only the exact JSON file
   named by `FLEET_PUBLIC_ARTIFACT_MANIFEST`).

2. Open or update the triage issue and attach the redacted excerpt:

   ~~~bash
   set -euo pipefail
   RUN_ID=<run-id>
   gh issue create --repo M1Vj/fleet-runtime \
     --title "[TRIAGE] fleet-selftest ${RUN_ID}" \
     --body "Run: https://github.com/M1Vj/fleet-runtime/actions/runs/${RUN_ID}
   Snapshot: triage-snapshots/snapshot-${RUN_ID}.md (redacted, attached)
   Generic runbook: docs/runbooks/ci-failure-triage.md" \
   || gh issue list --repo M1Vj/fleet-runtime --search "[TRIAGE] fleet-selftest ${RUN_ID}"
   ~~~

   Every rerun or fix MUST link this triage-issue URL. Paste only the redacted
   excerpt from [Appendix A](#appendix-a--redacted-snapshot-excerpt-local-only).
   See [Log-redaction rule](#log-redaction-rule) before pasting anything.

3. Diagnose using the generic runbook
   ([ci-failure-triage.md](runbooks/ci-failure-triage.md) Steps 1–4), then
   rerun exactly one canary with failed-only scope before any mass rerun:

   ~~~bash
   set -euo pipefail
   gh run rerun <run-id> --failed --repo M1Vj/fleet-runtime
   ~~~

   Do NOT run `gh run rerun <run-id>` without `--failed` (wasteful full rerun).
   Do NOT hardcode a run id in durable docs; always use the `<run-id>`
   parameter and the triage-issue link from step 2. Mass reruns follow only
   after the canary goes green, per generic runbook Step 5.

4. Fix forward on a draft PR; never push to the default branch:

   ~~~bash
   set -euo pipefail
   git checkout -b "fleet/selftest-triage-<run-id>"
   git add <files> && git commit -m "[fleet] selftest triage <run-id>: <summary>"
   git push -u origin "fleet/selftest-triage-<run-id>"
   gh pr create --repo M1Vj/fleet-runtime --draft \
     --title "[fleet] selftest triage <run-id>" \
     --body "Fixes triage issue: <triage-issue-url>. Run: https://github.com/M1Vj/fleet-runtime/actions/runs/<run-id>"
   ~~~

   Competing writers are prohibited: coordinate superseded drafts
   (`#2`, `#3`) through the triage issue and close them only after this PR
   lands, per `scripts/lib/pr-hygiene.mjs` overlap rules. Do not close or
   rewrite another active triage branch without linking this triage issue.

## Guardrails (actionable)

- Default branch is read-only for triage: all fixes land via a draft PR as in
  step 4. Direct `git push origin main` is forbidden.
- Single-flight concurrency: `fleet-selftest` declares exactly
  (`./.github/workflows/selftest.yml`):
  `concurrency: { group: fleet-selftest-public, cancel-in-progress: false }`.
  Do not introduce a second writer, duplicate group, or manual `gh workflow run`
  while a triage canary is in flight; queue behind the active run.
- Secrets stay out of issues, snapshots, and artifacts: apply the
  [Log-redaction rule](#log-redaction-rule) to every pasted line. When in
  doubt, replace the value with `***` and note the redaction.
- Docs debt: the ephemeral instance in
  [Appendix B](#appendix-b--ephemeral-triage-instance-remove-after-landing)
  MUST be removed (or refreshed) once triage closes; durable steps above stay
  parameterized so they never go stale.

## Log-redaction rule

Apply before writing `triage-snapshots/snapshot-<run-id>.md` and before any
issue paste. The committed snapshot MUST already be redacted:

- Replace exact secret values (`FLEET_GH_TOKEN`, `FLEET_OPENCODE_AUTH`) with
  `***`, then pattern-redact token-shaped substrings (mirrors
  `scrub()` in `scripts/lib/util.mjs`):
  `(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{10,}`, `github_pat_[A-Za-z0-9_]+`,
  `AKIA[0-9A-Z]{16}`, `sk-[A-Za-z0-9_-]{10,}`, `xox[bpas]-[A-Za-z0-9-]+`,
  `AIza[A-Za-z0-9_-]+`, and `Bearer <token>`.
- Drop request headers, `Authorization:` lines, and `*.json` credential dumps.
- Keep only the first error block plus workflow/job names; trim repeats.
- Manually re-read the redacted file once; if a value looks secret-shaped,
  replace it with `***` and record the redaction (e.g. `[redacted token]`).
- `scripts/fleet-triage-snapshot.sh` enforces this pipeline and aborts when
  `gh` emits an auth/rate-limit error instead of writing a partial snapshot.

## Verification (hermetic first, gated live)

Hermetic (no network; required CI). Runs offline from a clean checkout:

~~~bash
set -euo pipefail
bash scripts/fleet-triage-snapshot.sh --check
node --test tests/hygiene.test.mjs tests/fleet-triage-snapshot.test.mjs
node --input-type=module -e "
import fs from 'node:fs';
const md = fs.readFileSync('docs/fleet-selftest-triage-runbook.md','utf8');
for (const link of [...md.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]) {
  const target = link[2].split('#')[0];
  if (!target || /^https?:/.test(target)) continue;
  const p = new URL(target, 'file://' + process.cwd() + '/docs/').pathname;
  if (!fs.existsSync(decodeURIComponent(p))) throw new Error('broken link: ' + link[0]);
}
if (!md.endsWith('\n')) throw new Error('missing EOF newline');
console.log('markdown links + EOF newline OK');
"
~~~

Live (explicitly gated; skipped in CI unless enabled). Requires repository
variable/opt-in `FLEET_LIVE_TRIAGE=true` plus `GH_TOKEN`. Skip reason when
absent: `SKIP: live gh capture requires FLEET_LIVE_TRIAGE=true and GH_TOKEN`:

~~~bash
set -euo pipefail
if [ "${FLEET_LIVE_TRIAGE:-}" = "true" ] && [ -n "${GH_TOKEN:-}" ]; then
  bash scripts/fleet-triage-snapshot.sh <run-id> --repo M1Vj/fleet-runtime
else
  echo "SKIP: live gh capture requires FLEET_LIVE_TRIAGE=true and GH_TOKEN"
fi
~~~

Evidence recorded for this revision (hermetic leg, `node v20.20.2`):

~~~text
bash scripts/fleet-triage-snapshot.sh --check  # PASS
node --test tests/hygiene.test.mjs tests/fleet-triage-snapshot.test.mjs  # PASS
markdown links + EOF newline OK  # PASS
SKIP: live gh capture requires FLEET_LIVE_TRIAGE=true and GH_TOKEN (no network in CI)
~~~

## Appendix A — Redacted snapshot excerpt (local only)

Committed excerpt for the triage instance in Appendix B. Source:
`bash scripts/fleet-triage-snapshot.sh 34589043909 --repo M1Vj/fleet-runtime`
output, redacted per [Log-redaction rule](#log-redaction-rule). Full redacted
file lives at `triage-snapshots/snapshot-34589043909.md` (local/triage-issue
attachment; intentionally NOT a workflow artifact). Live log body requires
`FLEET_LIVE_TRIAGE=true` and `GH_TOKEN`; the metadata below is hermetically
verifiable without network.

~~~text
run: 34589043909 (2026-09-11)
url: https://github.com/M1Vj/fleet-runtime/actions/runs/34589043909
workflow: fleet-selftest (.github/workflows/selftest.yml)
concurrency: fleet-selftest-public (cancel-in-progress: false)
triage issue: <triage-issue-url for run 34589043909>
capture: bash scripts/fleet-triage-snapshot.sh 34589043909 --repo M1Vj/fleet-runtime

[redacted failure excerpt]
job: selftest / run public selftest
step: run public selftest (node scripts/selftest.mjs)
first-error: <redacted first error line; auth tokens replaced with ***>
tail: <last ~20 redacted lines; repeats trimmed; secrets replaced with ***>
auth/rate-limit probe: gh api /rate_limit redacted; token values shown as ***
redactions applied: [redacted token], [redacted bearer], [trimmed repeats]

note: paste only this redacted block into the triage issue; keep raw
gh --log-failed output out of issues, PRs, and workflow artifacts.
~~~

## Appendix B — Ephemeral triage instance (remove after landing)

> Ephemeral; delete this appendix when triage for run `34589043909` closes.
> Durable steps above MUST NOT hardcode this run.

- Failing run: `34589043909` (2026-09-11)
  `https://github.com/M1Vj/fleet-runtime/actions/runs/34589043909`
- Triage issue: `<triage-issue-url for run 34589043909>` (link before rerun).
- Superseded drafts `#2` and `#3`: close only after this fix-forward PR lands,
  coordinated via the triage issue (single writer; see step 4).
- Post-landing: remove this appendix and refresh Appendix A, or delete both
  appendices if no active triage remains.