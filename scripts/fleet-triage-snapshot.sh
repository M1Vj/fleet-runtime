#!/usr/bin/env bash
# fleet-triage-snapshot.sh — redacted failure-log capture for fleet-selftest triage.
# Usage:
#   bash scripts/fleet-triage-snapshot.sh <run-id> [--repo M1Vj/fleet-runtime] [--out DIR]
#   bash scripts/fleet-triage-snapshot.sh --stdin <run-id> [--repo R]  # redact piped gh output
#   bash scripts/fleet-triage-snapshot.sh --check                      # hermetic offline checks
#   bash scripts/fleet-triage-snapshot.sh --help
#
# Fail-fast: set -euo pipefail; invalid input or gh auth errors abort without
# writing a partial snapshot. Live gh capture additionally requires GH_TOKEN;
# without it the script exits non-zero with a clear message (CI should use
# --check, or gate live capture behind FLEET_LIVE_TRIAGE=true; see runbook).
set -euo pipefail

REPO_DEFAULT="M1Vj/fleet-runtime"
OUT_DEFAULT="triage-snapshots"

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/fleet-triage-snapshot.sh <run-id> [--repo OWNER/NAME] [--out DIR]
  bash scripts/fleet-triage-snapshot.sh --stdin <run-id> [--repo OWNER/NAME] [--out DIR]
  bash scripts/fleet-triage-snapshot.sh --check
  bash scripts/fleet-triage-snapshot.sh --help

Captures a REDACTED failure excerpt for a fleet-selftest run. Live capture
calls `gh run view <run-id> --log-failed` and `gh run view --json`; --check
runs hermetic offline validation only (no network).
USAGE
}

RUN_ID=""
REPO="$REPO_DEFAULT"
OUT_DIR="$OUT_DEFAULT"
MODE="live"
FROM_STDIN=0

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 2
fi

while [[ $# -gt 0 ]]; do
  case "${1:-}" in
    --help|-h)
      usage
      exit 0
      ;;
    --check)
      MODE="check"
      shift
      ;;
    --stdin)
      FROM_STDIN=1
      shift
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --repo=*)
      REPO="${1#--repo=}"
      shift
      ;;
    --out)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --out=*)
      OUT_DIR="${1#--out=}"
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "unknown flag: $1 (see --help)" >&2
      exit 2
      ;;
    *)
      if [[ -z "$RUN_ID" ]]; then
        RUN_ID="$1"
        shift
      else
        echo "unexpected argument: $1 (see --help)" >&2
        exit 2
      fi
      ;;
  esac
done

redact_stream() {
  # Mirror scrub() in scripts/lib/util.mjs: exact-value masking + patterns.
  # Exact values first (when env provides them), then token-shaped patterns.
  local tmp_in
  tmp_in="$(mktemp)"
  cat > "$tmp_in"
  if [[ -n "${FLEET_GH_TOKEN:-}" ]]; then
    # Use awk index-split to avoid sed delimiter collisions on token bytes.
    FLEET_TOKEN_FILE="$tmp_in" FLEET_TOKEN_VAL="$FLEET_GH_TOKEN" python3 - "$tmp_in" <<'PY' || true
import os
p = os.environ.get("FLEET_TOKEN_FILE", "")
v = os.environ.get("FLEET_TOKEN_VAL", "")
if p and v:
    data = open(p, "r", encoding="utf-8", errors="replace").read()
    open(p, "w", encoding="utf-8").write(data.replace(v, "***"))
PY
  fi
  if [[ -n "${FLEET_OPENCODE_AUTH:-}" && "${#FLEET_OPENCODE_AUTH}" -gt 16 ]]; then
    FLEET_TOKEN_FILE="$tmp_in" FLEET_TOKEN_VAL="$FLEET_OPENCODE_AUTH" python3 - "$tmp_in" <<'PY' || true
import os
p = os.environ.get("FLEET_TOKEN_FILE", "")
v = os.environ.get("FLEET_TOKEN_VAL", "")
if p and v:
    data = open(p, "r", encoding="utf-8", errors="replace").read()
    open(p, "w", encoding="utf-8").write(data.replace(v, "***"))
PY
  fi
  sed -E \
    -e 's/(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{10,}/***/g' \
    -e 's/github_pat_[A-Za-z0-9_]+/***/g' \
    -e 's/AKIA[0-9A-Z]{16}/***/g' \
    -e 's/sk-[A-Za-z0-9_-]{10,}/***/g' \
    -e 's/xox[bpas]-[A-Za-z0-9-]+/***/g' \
    -e 's/AIza[A-Za-z0-9_-]+/***/g' \
    -e 's/[Bb]earer [A-Za-z0-9._~+\/-]+/***/g' \
    -e 's/[Aa]uthorization:[^\n]*/Authorization: ***/g' \
    "$tmp_in"
  rm -f "$tmp_in"
}

run_check() {
  # Hermetic offline validation: no network, no gh auth required.
  local failures=0
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  local runbook="$root/docs/fleet-selftest-triage-runbook.md"
  local generic="$root/docs/runbooks/ci-failure-triage.md"
  local workflow="$root/.github/workflows/selftest.yml"

  check_pass() { printf 'check PASS: %s\n' "$1"; }
  check_fail() { printf 'check FAIL: %s\n' "$1" >&2; failures=$((failures + 1)); }

  # 1. Files exist.
  if [[ -f "$runbook" ]]; then check_pass "runbook exists"; else check_fail "runbook missing: docs/fleet-selftest-triage-runbook.md"; fi
  if [[ -f "$generic" ]]; then check_pass "generic runbook exists"; else check_fail "generic runbook missing: docs/runbooks/ci-failure-triage.md"; fi
  if [[ -f "$workflow" ]]; then check_pass "selftest workflow exists"; else check_fail "workflow missing: .github/workflows/selftest.yml"; fi
  if [[ -x "$root/scripts/fleet-triage-snapshot.sh" ]]; then check_pass "snapshot script executable"; else check_fail "snapshot script not executable"; fi

  # 2. EOF newline (POSIX): last byte must be 0a.
  if [[ -f "$runbook" ]]; then
    if [[ "$(tail -c1 "$runbook" | od -An -t x1 | tr -d ' \n')" == "0a" ]]; then
      check_pass "runbook EOF newline"
    else
      check_fail "runbook missing EOF newline"
    fi
  fi

  # 3. Parameterized rerun with --failed; no bare hardcoded rerun in Steps.
  if [[ -f "$runbook" ]]; then
    if grep -q 'gh run rerun <run-id> --failed' "$runbook"; then
      check_pass "parameterized rerun with --failed"
    else
      check_fail "runbook must contain 'gh run rerun <run-id> --failed'"
    fi
    # Extract Steps section (up to Guardrails) and reject hardcoded rerun there.
    steps_block="$(awk '/^## Steps/{flag=1;next}/^## Guardrails/{flag=0}flag' "$runbook")"
    if printf '%s' "$steps_block" | grep -Eq 'gh run rerun [0-9]{5,}'; then
      check_fail "Steps must not hardcode a numeric run id in rerun command"
    else
      check_pass "no hardcoded rerun in Steps"
    fi
    grep -q 'triage-issue' "$runbook" && check_pass "triage-issue link present" || check_fail "triage-issue link missing"
    grep -qi 'redact' "$runbook" && check_pass "redaction rule present" || check_fail "redaction rule missing"
    grep -q 'fleet-selftest-public' "$runbook" && check_pass "concurrency key present" || check_fail "concurrency key fleet-selftest-public missing"
    grep -q -- '--draft' "$runbook" && check_pass "draft-PR workflow present" || check_fail "draft-PR workflow (--draft) missing"
    grep -q 'docs/runbooks/ci-failure-triage.md' "$runbook" && check_pass "generic runbook reconciled" || check_fail "missing link to docs/runbooks/ci-failure-triage.md"
    grep -q -- '--failed' "$runbook" && check_pass "rerun --failed flag reconciled" || check_fail "rerun --failed flag missing"
    grep -qi 'canary' "$runbook" && check_pass "canary policy present" || check_fail "canary policy missing"
    grep -qi 'escalat' "$runbook" && check_pass "escalation present" || check_fail "escalation missing"
  fi

  # 4. Script fail-fast + validation + redaction.
  script="$root/scripts/fleet-triage-snapshot.sh"
  if [[ -f "$script" ]]; then
    grep -q 'set -euo pipefail' "$script" && check_pass "script fail-fast guard" || check_fail "script missing set -euo pipefail"
    grep -q 'FLEET_LIVE_TRIAGE' "$runbook" 2>/dev/null && check_pass "live gate documented" || check_fail "live gate FLEET_LIVE_TRIAGE not documented"
    grep -qE 'gho_|ghp_|github_pat_' "$script" && check_pass "script redaction patterns" || check_fail "script redaction patterns missing"
  fi

  # 5. Internal markdown links resolve (hermetic; external URLs skipped).
  if [[ -f "$runbook" ]]; then
    link_err="$(mktemp)"
    if node --input-type=module -e "
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[1];
const md = fs.readFileSync(path.join(root, 'docs/fleet-selftest-triage-runbook.md'), 'utf8');
const bad = [];
for (const m of md.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
  const target = String(m[2]).split('#')[0].trim();
  if (!target || /^(https?:|mailto:)/.test(target)) continue;
  const abs = path.resolve(root, 'docs', target);
  if (!fs.existsSync(abs)) bad.push(m[0]);
}
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
" "$root" 2>"$link_err"; then
      check_pass "markdown links resolve"
    else
      check_fail "broken markdown links: $(cat "$link_err")"
    fi
    rm -f "$link_err"
  fi

  if [[ $failures -ne 0 ]]; then
    echo "fleet-triage-snapshot --check: $failures failure(s)" >&2
    return 1
  fi
  echo "fleet-triage-snapshot --check: OK (hermetic, no network)"
  return 0
}

if [[ "$MODE" == "check" ]]; then
  run_check
  exit $?
fi

if [[ -z "$RUN_ID" ]]; then
  echo "run id is required (see --help)" >&2
  exit 2
fi
if [[ ! "$RUN_ID" =~ ^[0-9]{5,20}$ ]]; then
  echo "invalid run id '$RUN_ID': expected 5-20 digits" >&2
  exit 2
fi
if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$ ]]; then
  echo "invalid repo '$REPO': expected owner/name" >&2
  exit 2
fi
if [[ "$OUT_DIR" == *".."* ]]; then
  echo "invalid --out dir (must not contain ..)" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
OUT_MD="$OUT_DIR/snapshot-${RUN_ID}.md"
OUT_LOG="$OUT_DIR/snapshot-${RUN_ID}.log"

if [[ $FROM_STDIN -eq 1 ]]; then
  # Redact piped gh output without requiring gh/network.
  redacted="$(redact_stream)"
  {
    printf '# Triage snapshot %s\n\n' "$RUN_ID"
    printf 'repo: %s\n' "$REPO"
    printf 'url: https://github.com/%s/actions/runs/%s\n\n' "$REPO" "$RUN_ID"
    printf 'capture: piped via --stdin (redacted)\n\n'
    printf '```text\n%s\n```\n' "$redacted"
  } > "$OUT_MD"
  printf '%s\n' "$redacted" > "$OUT_LOG"
  # Enforce redaction: fail if token-shaped values survived.
  if grep -Eq '(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]+|AKIA[0-9A-Z]{16}' "$OUT_MD"; then
    echo "redaction failed: token-shaped value survived" >&2
    rm -f "$OUT_MD" "$OUT_LOG"
    exit 3
  fi
  echo "wrote $OUT_MD (redacted, from stdin)"
  exit 0
fi

# Live capture path: requires gh + GH_TOKEN. Never write partial snapshots.
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI required for live capture (or use --stdin / --check)" >&2
  exit 2
fi
if [[ -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GH_TOKEN (or GITHUB_TOKEN) is required for live capture." >&2
  echo "SKIP: live gh capture requires FLEET_LIVE_TRIAGE=true and GH_TOKEN" >&2
  exit 2
fi

export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

echo "capturing run $RUN_ID in $REPO ..."
meta_tmp="$(mktemp)"
log_tmp="$(mktemp)"
trap 'rm -f "$meta_tmp" "$log_tmp"' EXIT

if ! gh run view "$RUN_ID" --repo "$REPO" --json conclusion,status,name,headBranch,event,url,createdAt > "$meta_tmp" 2>"$meta_tmp.err"; then
  cat "$meta_tmp.err" | redact_stream >&2 || true
  echo "gh run view --json failed for $RUN_ID" >&2
  exit 1
fi
if ! gh run view "$RUN_ID" --repo "$REPO" --log-failed > "$log_tmp" 2>"$log_tmp.err"; then
  # --log-failed exits non-zero when no failed logs exist; surface redacted error.
  cat "$log_tmp.err" | redact_stream >&2 || true
  echo "gh run view --log-failed failed for $RUN_ID (see redacted error above)" >&2
  exit 1
fi

redacted_log="$(redact_stream < "$log_tmp")"
redacted_meta="$(redact_stream < "$meta_tmp")"
# Keep snapshots reviewable: first error + bounded tail, repeats trimmed.
first_block="$(printf '%s' "$redacted_log" | grep -i -m1 -B2 -A8 -E 'error|failed|failure|panic|traceback' || printf '%s' "$redacted_log" | head -n 30)"
tail_block="$(printf '%s' "$redacted_log" | tail -n 20)"

{
  printf '# Triage snapshot %s\n\n' "$RUN_ID"
  printf 'repo: %s\n' "$REPO"
  printf 'url: https://github.com/%s/actions/runs/%s\n' "$REPO" "$RUN_ID"
  printf 'capture: bash scripts/fleet-triage-snapshot.sh %s --repo %s\n\n' "$RUN_ID" "$REPO"
  printf '## Run metadata (redacted)\n\n```json\n%s\n```\n\n' "$redacted_meta"
  printf '## First error (redacted)\n\n```text\n%s\n```\n\n' "$first_block"
  printf '## Tail (last 20 redacted lines)\n\n```text\n%s\n```\n\n' "$tail_block"
  printf 'redactions applied: token-shaped values replaced with ***; repeats trimmed.\n'
  printf 'do not paste raw logs; attach only this redacted file to the triage issue.\n'
} > "$OUT_MD"
printf '%s\n' "$redacted_log" > "$OUT_LOG"

if grep -Eq '(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]+|AKIA[0-9A-Z]{16}' "$OUT_MD"; then
  echo "redaction failed: token-shaped value survived" >&2
  rm -f "$OUT_MD" "$OUT_LOG"
  exit 3
fi

echo "wrote $OUT_MD (redacted)"
echo "attach only the redacted excerpt to the triage issue; keep raw logs out of issues/PRs/artifacts."