#!/usr/bin/env bash
# Boots runner/box.sh the way a box of a -runs stage does, in an Amazon Linux
# 2023 container at the release the pinned image is locked to, with S3 and
# shutdown stubbed. The box's bucket becomes a directory, OUT/s3/<bucket>, and
# scripts/box-in-container/expect.ts checks what the scenario says should happen.
#
#   scripts/box-in-container/run.sh [--worktree] [--scenario NAME]
#       [--aws-lc-archive FILE] [--aws-lc-cache DIR] OUT
#
#   --worktree   boot the working tree, as a throwaway commit, instead of HEAD
#   --aws-lc-archive FILE   AWS-LC's source archive, which the http-get
#                scenarios (but http-get-no-archive) put in the bucket as the
#                deploy puts it; by default $AWS_LC_ARCHIVE, as for the
#                Makefile and scripts/check-scratch.py, and without either it is
#                fetched into OUT with benchmarks/harness/c/vendor/fetch-aws-lc.sh
#   --aws-lc-cache DIR      keep AWS-LC's build in DIR, from one boot to the
#                next: the box builds into it, as AWS_LC_DIR, and a later boot
#                finds it built (a box builds it anew every time)
#   OUT          a directory that does not exist yet
#
# Scenarios:
#   ok           the whole schedule runs for this machine's type, as IMDS gives
#                it, but for the entries that name a Service (http_get), which
#                need S3 and are left out of the booted schedule.json in every
#                scenario but the http-get ones: one Run of every benchmark, build
#                and parameter set of every entry for it, each exiting 0, every other entry's executions
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
#   http-get     the box boots scripts/box-in-container/http-get.json as its
#                schedule.json (syscall getpid, then http_get's five sets with
#                the stand-in's CA and resolver as ca_file and resolv_conf)
#                against tests/http-get/standin.py, a stand-in for S3 and the
#                resolver in a container whose network namespace the box's
#                joins, as the endpoint the user-data names. The aws stand-in
#                answers assume-role with stand-in keys. Every execution runs
#                and exits 0, every Run checks out, the http_get Runs say which
#                Service inputs they were given, the stand-in received every
#                request signed with those keys, and no key is in anything the
#                box wrote: the bucket, its work directory, its log (about
#                eight minutes with AWS-LC built; add three to build it)
#   http-get-no-archive  the bucket has no AWS-LC archive: http_get alone fails
#                to build, recorded as a build failure, and syscall runs
#   http-get-refused  assume-role is refused: http_get builds, its executions
#                are not run and the boot summary says why, and syscall runs
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
# The disks: provision.py sees this machine's NVMe controllers in /sys, and so
# this machine's own instance-store disk. It must never format it, and it
# cannot: the container runs without CAP_MKNOD, so provision.py cannot make the
# device node it works through and refuses at once (and Docker's device cgroup
# would refuse to open the device, blkid would find its file system, and
# mkfs.xfs, never forced, would refuse it). The scenarios check that it
# prepared nothing and ran neither mkfs.xfs nor mount. The root volume's directory, /var/tmp/ledgermath/disk, is
# a tmpfs of the container's own: the disk Runs read and write memory there,
# and say so (their device_found is false). The schedule's root volume
# Fixture (1 GiB) and the scratch file of disk_write (up to 1 GiB) do not fit
# on this machine's disk beside everything else. The container runs without a
# seccomp filter, as the box does: Docker's default one refuses io_uring.
#
# The http-get scenarios: the stand-in is not S3. Its certificates come from a
# throwaway CA, its answers take a millisecond, it checks no signature, and
# the keys are not credentials; what they show is the path (the archive from
# the bucket, the build, the Service's inputs reaching http_get and its Runs,
# and the keys reaching nothing else), not S3's numbers. The stand-in's CA and
# resolver come in as ca_file and resolv_conf, which on a box are the box's
# own. With --aws-lc-cache AWS-LC is built once, by the first boot, and later
# boots find it built; a box has no such cache and builds it every boot (34 s
# at -j2 on a quiet m6id.xlarge, 122 to 208 s on a busy one).
#
# Docker must work for the caller; if the docker group is new to this login,
# run it as: sg docker -c "scripts/box-in-container/run.sh OUT"
set -euo pipefail

IMAGE=amazonlinux:2023.12.20260710.0 # the release ami-03499a87bbb39a09a is locked to
BUCKET=ledgermath-container-test
STAGE=container
REGION=us-east-2
HOSTNAME_EXAMPLE=ip-192-0-2-10 # a documentation address, not this machine's
# The s3_fixtures Service as a stage would give it; the http-get scenarios
# point the endpoint at the stand-in instead. The role is the documentation's
# example account's.
FIXTURES_ENDPOINT=https://ledgermath-container-test-fixtures.s3.us-east-2.amazonaws.com
FIXTURES_ROLE=arn:aws:iam::123456789012:role/ledgermath-container-test-fixtures

worktree=false
SCENARIO=ok
AWS_LC_ARCHIVE_FILE="${AWS_LC_ARCHIVE:-}"
AWS_LC_CACHE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) worktree=true; shift ;;
    --scenario) SCENARIO="${2:?--scenario needs a name}"; shift 2 ;;
    --aws-lc-archive) AWS_LC_ARCHIVE_FILE="$(realpath "${2:?--aws-lc-archive needs a file}")"; shift 2 ;;
    --aws-lc-cache) AWS_LC_CACHE="$(realpath "${2:?--aws-lc-cache needs a directory}")"; shift 2 ;;
    *) break ;;
  esac
done
OUT="${1:?usage: run.sh [--worktree] [--scenario NAME] [--aws-lc-archive FILE] [--aws-lc-cache DIR] OUT}"
if [ -n "$AWS_LC_ARCHIVE_FILE" ]; then AWS_LC_ARCHIVE_FILE="$(realpath "$AWS_LC_ARCHIVE_FILE")"; fi
if [ -e "$OUT" ]; then
  echo "$OUT exists; give a new directory" >&2
  exit 2
fi

ENVIRONMENT=()
FAKE_IMDS_TYPE=""     # when set, a fake IMDS says the box is of this type
SCHEDULE_FILE=""      # when set, the booted commit's schedule.json is this file of it
HTTP_GET=false        # the stand-in for S3, AWS-LC's archive, the http_get source
case "$SCENARIO" in
  ok | terminated | shutdown | blobs-present) ;;
  http-get | http-get-no-archive | http-get-refused)
    HTTP_GET=true
    SCHEDULE_FILE=scripts/box-in-container/http-get.json
    [ "$SCENARIO" = http-get-refused ] && ENVIRONMENT+=(-e FAKE_STS_REFUSE=1)
    ;;
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
if [ -z "$SCHEDULE_FILE" ] && git show "$COMMIT:schedule.json" | grep -q '"service"'; then
  # The container reaches no S3, so the entries that name a Service (http_get)
  # are left out of the booted schedule.json; the http-get scenarios run them
  # against a stand-in.
  blob="$(git show "$COMMIT:schedule.json" | python3 -c 'import json, sys
schedule = json.load(sys.stdin)
schedule["benchmarks"] = [entry for entry in schedule["benchmarks"] if "service" not in entry]
print(json.dumps(schedule, indent=2))' | git hash-object -w --stdin)"
  index="$(mktemp)"
  GIT_INDEX_FILE="$index" git read-tree "$COMMIT"
  GIT_INDEX_FILE="$index" git update-index --cacheinfo "100644,$blob,schedule.json"
  tree="$(GIT_INDEX_FILE="$index" git write-tree)"
  rm -f "$index"
  COMMIT="$(GIT_AUTHOR_NAME=box-in-container GIT_AUTHOR_EMAIL=box-in-container@localhost \
    GIT_COMMITTER_NAME=box-in-container GIT_COMMITTER_EMAIL=box-in-container@localhost \
    git commit-tree "$tree" -p "$COMMIT" -m "box-in-container: schedule.json without the entries that name a Service")"
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
if $HTTP_GET; then
  # AWS-LC's archive, a blob as the deploy puts it, and the one blob the box's
  # role may read; the stand-in for S3, as its own branch or tree holds it.
  TLS_SHA256="$(git show "$COMMIT:benchmarks/harness/c/vendor/aws-lc.lock" | sed -n 's/^AWS_LC_SHA256 := //p')"
  ENVIRONMENT+=(-e "FAKE_S3_TLS_ARCHIVE=blobs/sha256/$TLS_SHA256")
  echo "blobs/sha256/$TLS_SHA256" >"$OUT/tls-archive"
  if [ "$SCENARIO" != http-get-no-archive ]; then
    if [ -z "$AWS_LC_ARCHIVE_FILE" ]; then
      AWS_LC_ARCHIVE_FILE="$OUT/aws-lc.tar.gz"
      benchmarks/harness/c/vendor/fetch-aws-lc.sh "$AWS_LC_ARCHIVE_FILE"
    fi
    [ "$(sha256sum "$AWS_LC_ARCHIVE_FILE" | cut -d' ' -f1)" = "$TLS_SHA256" ] || { echo "$AWS_LC_ARCHIVE_FILE is not the archive aws-lc.lock pins" >&2; exit 2; }
    mkdir -p "$OUT/s3/$BUCKET/blobs/sha256"
    cp "$AWS_LC_ARCHIVE_FILE" "$OUT/s3/$BUCKET/blobs/sha256/$TLS_SHA256"
  fi
  git show "$COMMIT:tests/http-get/standin.py" >"$OUT/stubs/standin.py"
  mkdir -p "$OUT/standin" "$OUT/standin-box"
  if [ -n "$AWS_LC_CACHE" ] && [ "$SCENARIO" != http-get-no-archive ]; then
    ENVIRONMENT+=(-e AWS_LC_DIR=/var/cache/ledgermath-aws-lc -v "$AWS_LC_CACHE:/var/cache/ledgermath-aws-lc")
  fi
fi
git show "$COMMIT:runner/box.sh" >"$OUT/box.sh"
git show "$COMMIT:schedule.json" >"$OUT/schedule.json" # what the box runs, for expect.ts

NAME="ledgermath-box-test-$$"
NETWORK=(--hostname "$HOSTNAME_EXAMPLE")
if $HTTP_GET; then
  # The stand-in for S3 and the resolver, on the loopback of a namespace the
  # box's container joins. It makes its CA with the openssl command, which the
  # image lacks; it serves until its stdin, a pipe from sleep, closes.
  STANDIN_NAME="$NAME-standin"
  docker run -d --name "$STANDIN_NAME" --hostname "$HOSTNAME_EXAMPLE" \
    -v "$OUT/stubs/standin.py:/standin.py:ro" -v "$OUT/standin:/standin" "$IMAGE" \
    sh -c 'dnf install -y -q openssl >/dev/null 2>&1 && sleep infinity | python3 -I /standin.py /standin' >/dev/null
  trap 'docker rm -f "$STANDIN_NAME" >/dev/null 2>&1 || true' EXIT
  until docker logs "$STANDIN_NAME" 2>/dev/null | grep -q '"https_port"'; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$STANDIN_NAME")" != true ]; then
      docker logs "$STANDIN_NAME" >&2
      echo "the stand-in for S3 did not start" >&2
      exit 1
    fi
    sleep 0.5
  done
  ports="$(docker logs "$STANDIN_NAME" 2>/dev/null | grep '"https_port"' | head -n 1)"
  json() { python3 -c 'import json, sys; print(json.loads(sys.argv[1])[sys.argv[2]])' "$ports" "$1"; }
  cp "$OUT/standin/ca.pem" "$OUT/standin-box/ca.pem"
  echo "nameserver 127.0.0.1:$(json dns_port)" >"$OUT/standin-box/resolv.conf"
  FIXTURES_ENDPOINT="https://ok.s3.lm.test:$(json https_port)"
  echo "$FIXTURES_ENDPOINT" >"$OUT/fixtures-endpoint"
  ENVIRONMENT+=(-v "$OUT/standin-box:/lm-standin:ro")
  NETWORK=(--network "container:$STANDIN_NAME")
  echo "a stand-in for S3 answers at $FIXTURES_ENDPOINT, its resolver at 127.0.0.1:$(json dns_port)"
fi
bun scripts/box-in-container/user-data.ts "$OUT/box.sh" "$BUCKET" "$STAGE" "$KEY" "$COMMIT" "$REGION" \
  "$FIXTURES_ENDPOINT" "$REGION" "$FIXTURES_ROLE" >"$OUT/user-data"
chmod +x "$OUT/user-data"
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
  --cap-drop MKNOD \
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
if $HTTP_GET; then
  # What the box wrote, for the keys search: its work directory, but for
  # AWS-LC's archive and build, and its log.
  mkdir -p "$OUT/box-work"
  docker cp "$NAME:/var/tmp/ledgermath" - | tar -x -C "$OUT/box-work" --exclude='ledgermath/aws-lc-*.tar.gz' --exclude='*/build/aws-lc'
  docker cp "$NAME:/var/log/ledgermath-box.log" "$OUT/box-work/ledgermath-box.log"
  docker rm -f "$STANDIN_NAME" >/dev/null
fi
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
