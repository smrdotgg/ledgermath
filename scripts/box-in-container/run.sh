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
#   ok           the whole schedule runs for this machine's type, as IMDS gives
#                it: one Run of every benchmark, build and parameter set of every
#                entry for it, each exiting 0, every other entry's executions
#                listed under left_out, every Run checks out, every disk Run ties
#                to its dump (scripts/check-disk-runs.ts), and provision.py
#                prepared no disk (about nine minutes; this machine is not a
#                target, so the entries that name instance types, such as mutex's
#                two-thread sets and the instance-store sets, are left out)
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
#   instance-types  the box boots scripts/box-in-container/instance-types.json as
#                its schedule.json, and a fake IMDS says it is an m5.large: the
#                entries for every type and for m5.large run (among them mutex's
#                one-thread and siblings sets, which this machine can provide),
#                the others are listed under left_out in the boot summary, a
#                benchmark two entries name is built once, and provision.py,
#                told the box is an m5.large, prepares no disk (about two minutes)
#
# What this shows: box.sh, provision.py, run.py, the Makefiles, cpuid.c and
# fixture.c work on the image's own packages (Python 3.9, gcc 11,
# glibc-static, nvme-cli, xfsprogs), with the user-data the launch Lambda
# builds. What it cannot show: the container shares this machine's kernel and
# CPU, its /proc and /sys are this machine's, and IMDS answers for this
# machine when the hop limit lets a container reach it. Its Runs describe this
# machine. In the instance-types scenario IMDS is
# scripts/box-in-container/fake-imds.py instead, in a container whose network
# namespace the box's joins, so the Runs' provider fields are its words while
# the dumps are still this machine's.
#
# The disks: the container is not privileged and has no device node of this
# machine's disks, so provision.py, which sees this machine's NVMe controllers
# in /sys, can format nothing; it refuses (the scenarios check that it did not
# prepare anything). The root volume's directory, /var/tmp/ledgermath/disk, is
# a tmpfs of the container's own: the disk Runs read and write memory there,
# and say so (their device_found is false). The schedule's root volume
# Fixture (1 GiB) and the scratch file of disk_write (up to 1 GiB) do not fit
# on this machine's disk beside everything else. The container runs without a
# seccomp filter, as the box does: Docker's default one refuses io_uring.
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
FAKE_IMDS_TYPE=""     # when set, a fake IMDS says the box is of this type
SCHEDULE_FILE=""      # when set, the booted commit's schedule.json is this file of it
case "$SCENARIO" in
  ok | terminated | shutdown | blobs-present) ;;
  instance-types)
    FAKE_IMDS_TYPE=m5.large
    SCHEDULE_FILE=scripts/box-in-container/instance-types.json
    ;;
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
if [ -n "$SCHEDULE_FILE" ]; then
  # The same tree with SCHEDULE_FILE, as that tree holds it, as schedule.json.
  index="$(mktemp)"
  GIT_INDEX_FILE="$index" git read-tree "$COMMIT"
  GIT_INDEX_FILE="$index" git update-index --cacheinfo "100644,$(git rev-parse "$COMMIT:$SCHEDULE_FILE"),schedule.json"
  tree="$(GIT_INDEX_FILE="$index" git write-tree)"
  rm -f "$index"
  COMMIT="$(GIT_AUTHOR_NAME=box-in-container GIT_AUTHOR_EMAIL=box-in-container@localhost \
    GIT_COMMITTER_NAME=box-in-container GIT_COMMITTER_EMAIL=box-in-container@localhost \
    git commit-tree "$tree" -p "$COMMIT" -m "box-in-container: $SCHEDULE_FILE as schedule.json")"
fi
KEY="source/$COMMIT.tar.gz"

mkdir -p "$OUT/s3/$BUCKET/source" "$OUT/calls" "$OUT/stubs"
OUT="$(cd "$OUT" && pwd)"
# Mounted from OUT, so the box's dump (findmnt) shows no path of this checkout.
cp "$HERE/aws" "$HERE/power" "$OUT/stubs/"
cp -R "$HERE/ec2" "$OUT/stubs/ec2"
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
git show "$COMMIT:schedule.json" >"$OUT/schedule.json" # what the box runs, for expect.ts
bun scripts/box-in-container/user-data.ts "$OUT/box.sh" "$BUCKET" "$STAGE" "$KEY" "$COMMIT" "$REGION" >"$OUT/user-data"
chmod +x "$OUT/user-data"

NAME="ledgermath-box-test-$$"
NETWORK=(--hostname "$HOSTNAME_EXAMPLE")
if [ -n "$FAKE_IMDS_TYPE" ]; then
  # The box joins this container's network namespace, and with it its host
  # name; only that namespace has 169.254.169.254 on its loopback.
  IMDS_NAME="$NAME-imds"
  cp "$HERE/fake-imds.py" "$OUT/stubs/"
  docker run -d --name "$IMDS_NAME" --hostname "$HOSTNAME_EXAMPLE" --cap-add NET_ADMIN \
    -v "$OUT/stubs/fake-imds.py:/fake-imds.py:ro" "$IMAGE" python3 /fake-imds.py "$FAKE_IMDS_TYPE" >/dev/null
  trap 'docker rm -f "$IMDS_NAME" >/dev/null 2>&1 || true' EXIT
  until docker logs "$IMDS_NAME" 2>&1 | grep -q answering; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$IMDS_NAME")" != true ]; then
      docker logs "$IMDS_NAME" >&2
      echo "the fake IMDS did not start" >&2
      exit 1
    fi
    sleep 0.5
  done
  NETWORK=(--network "container:$IMDS_NAME")
  echo "a fake IMDS says the box is an $FAKE_IMDS_TYPE"
fi
echo "booting $COMMIT in $IMAGE, scenario $SCENARIO"
docker run -d --name "$NAME" "${NETWORK[@]}" "${ENVIRONMENT[@]}" \
  --security-opt seccomp=unconfined \
  --tmpfs /var/tmp/ledgermath/disk:rw,size=2560m \
  -v "$OUT/s3:/fake-s3" \
  -v "$OUT/calls:/fake-calls" \
  -v "$OUT/stubs/aws:/usr/local/bin/aws:ro" \
  -v "$OUT/stubs/ec2:/fake-ec2:ro" \
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
if [ -n "$FAKE_IMDS_TYPE" ]; then
  docker logs "$IMDS_NAME" >"$OUT/fake-imds.log" 2>&1
  docker rm -f "$IMDS_NAME" >/dev/null
fi
# The container wrote as root.
docker run --rm -v "$OUT:/out" "$IMAGE" chown -R "$(id -u):$(id -g)" /out

echo "box exited with status $status"
echo "shutdown calls:"
sed 's/^/  /' "$OUT/calls/power.log" 2>/dev/null || echo "  none"
echo "bucket:"
(cd "$OUT/s3/$BUCKET" && find . -type f | sed 's|^\./||' | awk -F/ '{print "  " $1}' | sort | uniq -c)
echo
bun scripts/box-in-container/expect.ts "$SCENARIO" "$OUT/s3/$BUCKET" "$status" "$OUT"
