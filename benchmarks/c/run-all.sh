#!/usr/bin/env bash
# Run every built benchmark binary and merge their JSON arrays into a single JSON
# array on stdout. Each binary prints one array; diagnostics go to their stderr,
# which we let pass through to this script's stderr untouched.
#
# Usage: ./run-all.sh [--quick]   (any args are forwarded to each binary)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build="$here/build"

if [ ! -d "$build" ]; then
  echo "run-all.sh: no build/ directory; run 'make' first" >&2
  exit 1
fi

bins=()
for f in "$build"/*; do
  [ -x "$f" ] && [ -f "$f" ] && bins+=("$f")
done

if [ "${#bins[@]}" -eq 0 ]; then
  echo "run-all.sh: no benchmark binaries in $build; run 'make' first" >&2
  exit 1
fi

# Collect each binary's stdout, then concatenate the arrays with python3.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

i=0
for bin in "${bins[@]}"; do
  "$bin" "$@" > "$tmp/$i.json"
  i=$((i + 1))
done

python3 - "$tmp" <<'PY'
import json, os, sys
d = sys.argv[1]
merged = []
for name in sorted(os.listdir(d)):
    with open(os.path.join(d, name)) as fh:
        merged.extend(json.load(fh))
json.dump(merged, sys.stdout, indent=2)
sys.stdout.write("\n")
PY
