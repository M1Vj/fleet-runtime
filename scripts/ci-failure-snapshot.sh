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

for id in "$@"; do
  out="$OUT_DIR/run-$id.log"
  echo "snapshotting run $id -> $out"
  gh run view "$id" -R "$REPO" --log-failed >"$out" 2>&1 \
    || echo "run $id: fetch failed (run may have been deleted)" >&2
done

echo "done"
