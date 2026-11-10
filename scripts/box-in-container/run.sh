#!/usr/bin/env bash
# Boots runner/box.sh the way a box of a -runs stage does, in an Amazon Linux
# 2023 container at the release the pinned image is locked to, with S3 and
# shutdown stubbed. The box's bucket becomes a directory, OUT/s3/<bucket>.
#
#   scripts/box-in-container/run.sh OUT              boots HEAD
#   scripts/box-in-container/run.sh --worktree OUT   boots the working tree, as a throwaway commit
#
# OUT must not exist. Takes about five minutes: the whole schedule runs.
#
# What this shows: box.sh, run.py, the Makefiles and cpuid.c work on the image's
# own packages (Python 3.9, gcc 11, glibc-static), with the user-data the launch
# Lambda builds, and the bucket ends up laid out as runs/, blobs/, boots/, logs/.
# What it cannot show: the container shares this machine's kernel and CPU, its
# /proc and /sys are this machine's, and IMDS answers for this machine when the
# hop limit lets a container reach it. Its Runs describe this machine.
#
# Docker must work for the caller; if the docker group is new to this login,
# run it as: sg docker -c "scripts/box-in-container/run.sh OUT"
set -euo pipefail

IMAGE=amazonlinux:2023.12.20260710.0 # the release ami-03499a87bbb39a09a is locked to
BUCKET=ledgermath-container-test
STAGE=container
REGION=us-east-2

worktree=false
if [ "${1:-}" = "--worktree" ]; then
  worktree=true
  shift
fi
OUT="${1:?usage: run.sh [--worktree] OUT}"
if [ -e "$OUT" ]; then
  echo "$OUT exists; give a new directory" >&2
  exit 2
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if $worktree; then
  index="$(mktemp)"
  cp "$(git rev-parse --git-path index)" "$index"
  GIT_INDEX_FILE="$index" git add -A
  tree="$(GIT_INDEX_FILE="$index" git write-tree)"
  rm -f "$index"
  COMMIT="$(GIT_AUTHOR_NAME=box-in-container GIT_AUTHOR_EMAIL=box-in-container@localhost \
    GIT_COMMITTER_NAME=box-in-container GIT_COMMITTER_EMAIL=box-in-container@localhost \
    git commit-tree "$tree" -p HEAD -m "box-in-container: the working tree")"
else
  COMMIT="$(git rev-parse HEAD)"
fi
KEY="source/$COMMIT.tar.gz"

mkdir -p "$OUT/s3/$BUCKET/source" "$OUT/calls" "$OUT/stubs"
OUT="$(cd "$OUT" && pwd)"
# Mounted from OUT, so the box's dump (findmnt) shows no path of this checkout.
cp "$HERE/aws" "$HERE/power" "$OUT/stubs/"
git archive --format=tar.gz -o "$OUT/s3/$BUCKET/$KEY" "$COMMIT"
git show "$COMMIT:runner/box.sh" >"$OUT/box.sh"
bun scripts/box-in-container/user-data.ts "$OUT/box.sh" "$BUCKET" "$STAGE" "$KEY" "$COMMIT" "$REGION" >"$OUT/user-data"
chmod +x "$OUT/user-data"

echo "booting $COMMIT in $IMAGE"
status=0
docker run --rm \
  -v "$OUT/s3:/fake-s3" \
  -v "$OUT/calls:/fake-calls" \
  -v "$OUT/stubs/aws:/usr/local/bin/aws:ro" \
  -v "$OUT/stubs/power:/usr/local/bin/shutdown:ro" \
  -v "$OUT/stubs/power:/usr/local/bin/poweroff:ro" \
  -v "$OUT/user-data:/var/lib/cloud/instance/scripts/part-001:ro" \
  "$IMAGE" /var/lib/cloud/instance/scripts/part-001 || status=$?
# The container wrote as root.
docker run --rm -v "$OUT:/out" "$IMAGE" chown -R "$(id -u):$(id -g)" /out

echo
echo "box exited with status $status"
echo "shutdown calls:"
sed 's/^/  /' "$OUT/calls/power.log" 2>/dev/null || echo "  none"
echo "bucket:"
(cd "$OUT/s3/$BUCKET" && find . -type f | sed 's|^\./||' | awk -F/ '{print "  " $1}' | sort | uniq -c)
echo
bun scripts/check-runs.ts "$OUT/s3/$BUCKET"
exit "$status"
