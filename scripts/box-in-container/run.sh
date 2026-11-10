#!/usr/bin/env bash
# Boots runner/box.sh the way a box of a -runs stage does, in an Amazon Linux
# 2023 container at the release the pinned image is locked to, with S3 and
# shutdown stubbed. The box's bucket becomes a directory, OUT/s3/<bucket>, and
# scripts/box-in-container/expect.ts checks what the scenario says should happen.
#
#   scripts/box-in-container/run.sh [--worktree] [--scenario NAME] OUT
#
#   --worktree   boot the working tree, as a throwaway commit, instead of HEAD
#   OUT          a directory that does not exist yet
#
# Scenarios:
#   ok           the whole schedule runs and every Run checks out (about five minutes)
#   terminated   run.py is sent TERM while a binary runs, as the time budget does:
#                that execution still has a Run, the boot summary lists what was
#                not run, and the boot fails
#   shutdown     every process is sent TERM while a binary runs, as a shutdown
#                does: the same
#   budget       a 120-second budget runs out mid-schedule: the same, by way of
#                timeout(1)
#   blobs-rejected  the bucket refuses every blob: no Run and no boot summary is
#                published, the log is, and the boot fails
#   blobs-flaky  the first upload of blobs/ fails halfway: the retry uploads only
#                the rest, and every Run checks out
#   blobs-present  the bucket already holds a blob the boot makes, from an earlier
#                boot: it is not uploaded again, and every Run checks out
#
# What this shows: box.sh, run.py, the Makefiles and cpuid.c work on the image's
# own packages (Python 3.9, gcc 11, glibc-static), with the user-data the launch
# Lambda builds. What it cannot show: the container shares this machine's
# kernel and CPU, its /proc and /sys are this machine's, and IMDS answers for
# this machine when the hop limit lets a container reach it. Its Runs describe
# this machine.
#
# Docker must work for the caller; if the docker group is new to this login,
# run it as: sg docker -c "scripts/box-in-container/run.sh OUT"
set -euo pipefail

IMAGE=amazonlinux:2023.12.20260710.0 # the release ami-03499a87bbb39a09a is locked to
BUCKET=ledgermath-container-test
STAGE=container
REGION=us-east-2
HOSTNAME_EXAMPLE=ip-192-0-2-10 # a documentation address, not this machine's

worktree=false
SCENARIO=ok
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) worktree=true; shift ;;
    --scenario) SCENARIO="${2:?--scenario needs a name}"; shift 2 ;;
    *) break ;;
  esac
done
OUT="${1:?usage: run.sh [--worktree] [--scenario NAME] OUT}"
if [ -e "$OUT" ]; then
  echo "$OUT exists; give a new directory" >&2
  exit 2
fi

ENVIRONMENT=()
case "$SCENARIO" in
  ok | terminated | shutdown | blobs-present) ;;
  budget) ENVIRONMENT+=(-e LEDGERMATH_RUN_SECONDS=120) ;;
  blobs-rejected) ENVIRONMENT+=(-e FAKE_S3_REJECT=blobs/) ;;
  blobs-flaky) ENVIRONMENT+=(-e FAKE_S3_FAIL_ONCE=blobs/) ;;
  *) echo "unknown scenario $SCENARIO" >&2; exit 2 ;;
esac

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
if [ "$SCENARIO" = blobs-present ]; then
  # The source archive is a blob of every Run; put it there as an earlier boot
  # would have, older than the box's copy will be.
  hex="$(sha256sum "$OUT/s3/$BUCKET/$KEY" | cut -d' ' -f1)"
  mkdir -p "$OUT/s3/$BUCKET/blobs/sha256"
  cp "$OUT/s3/$BUCKET/$KEY" "$OUT/s3/$BUCKET/blobs/sha256/$hex"
  touch -d 2026-01-01 "$OUT/s3/$BUCKET/blobs/sha256/$hex"
  echo "blobs/sha256/$hex" >"$OUT/seeded"
fi
git show "$COMMIT:runner/box.sh" >"$OUT/box.sh"
bun scripts/box-in-container/user-data.ts "$OUT/box.sh" "$BUCKET" "$STAGE" "$KEY" "$COMMIT" "$REGION" >"$OUT/user-data"
chmod +x "$OUT/user-data"

NAME="ledgermath-box-test-$$"
echo "booting $COMMIT in $IMAGE, scenario $SCENARIO"
docker run -d --name "$NAME" --hostname "$HOSTNAME_EXAMPLE" "${ENVIRONMENT[@]}" \
  -v "$OUT/s3:/fake-s3" \
  -v "$OUT/calls:/fake-calls" \
  -v "$OUT/stubs/aws:/usr/local/bin/aws:ro" \
  -v "$OUT/stubs/power:/usr/local/bin/shutdown:ro" \
  -v "$OUT/stubs/power:/usr/local/bin/poweroff:ro" \
  -v "$OUT/user-data:/var/lib/cloud/instance/scripts/part-001:ro" \
  "$IMAGE" /var/lib/cloud/instance/scripts/part-001 >/dev/null

in_box() { docker exec "$NAME" sh -c "$1"; }
case "$SCENARIO" in
  terminated | shutdown)
    # Once one Run is written and a binary has been running a few seconds.
    until in_box 'ls /var/tmp/ledgermath/out/runs/*/*/*/*.json' >/dev/null 2>&1; do sleep 2; done
    until in_box 'grep -lx memory_read /proc/[0-9]*/comm' >/dev/null 2>&1; do sleep 0.5; done
    sleep 3
    if [ "$SCENARIO" = terminated ]; then
      # run.py alone: the python3 process, not timeout(1), whose arguments name it too.
      in_box 'for p in /proc/[0-9]*; do
        [ "$(cat $p/comm 2>/dev/null)" = python3 ] && grep -q runner/run.py $p/cmdline 2>/dev/null && kill -TERM ${p#/proc/}
      done; true'
    else
      in_box 'kill -TERM -1' || true
      docker kill -s TERM "$NAME" >/dev/null
    fi
    echo "sent TERM ($SCENARIO)"
    ;;
esac
status="$(docker wait "$NAME")"
docker logs "$NAME" >"$OUT/console.log" 2>&1
docker rm "$NAME" >/dev/null
# The container wrote as root.
docker run --rm -v "$OUT:/out" "$IMAGE" chown -R "$(id -u):$(id -g)" /out

echo "box exited with status $status"
echo "shutdown calls:"
sed 's/^/  /' "$OUT/calls/power.log" 2>/dev/null || echo "  none"
echo "bucket:"
(cd "$OUT/s3/$BUCKET" && find . -type f | sed 's|^\./||' | awk -F/ '{print "  " $1}' | sort | uniq -c)
echo
bun scripts/box-in-container/expect.ts "$SCENARIO" "$OUT/s3/$BUCKET" "$status" "$OUT"
