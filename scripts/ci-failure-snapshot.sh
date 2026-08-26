#!/usr/bin/env bash
set -euo pipefail

REPO=${REPO:-M1Vj/fleet-runtime}
OUT_DIR=${OUT_DIR:-./ci-failure-snapshots}

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <run_id> [run_id ...]" >&2
  exit 2
fi

command -v gh >/dev/null 2>&1 || { echo "gh CLI is required" >&2; exit 1; }

mkdir -p "$OUT_DIR"

failures=0

for id in "$@"; do
  if [[ ! "$id" =~ ^[1-9][0-9]*$ ]]; then
    echo "run $id: invalid run id (expected positive integer), skipping" >&2
    failures=$((failures + 1))
    continue
  fi

  out="$OUT_DIR/run-$id.log"
  tmp=$(mktemp "$OUT_DIR/.run-$id.XXXXXX")
  echo "snapshotting run $id -> $out"

  if gh run view "$id" -R "$REPO" --log-failed >"$tmp"; then
    mv "$tmp" "$out"
  else
    rm -f "$tmp"
    echo "run $id: fetch failed (run may have been deleted)" >&2
    failures=$((failures + 1))
  fi
done

if [ "$failures" -gt 0 ]; then
  echo "done with $failures failure(s)" >&2
  exit 1
fi

echo "done"