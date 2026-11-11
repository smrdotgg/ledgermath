#!/usr/bin/env bash
# The box's user-data, on the pinned Amazon Linux 2023 image. It runs once, as
# root, on a fresh instance launched with shutdown behaviour "terminate":
#
#   set a 45-minute shutdown timer, whatever happens after
#   install the compilers, the static C library, cmake and the dump's tools
#   fetch and unpack the source archive, a `git archive` of one commit, and
#   fetch AWS-LC's source archive for http_get's build
#   build the cpuid and fixture tools
#   prepare the disks (runner/provision.py): the instance's own NVMe disk, if
#   it has one, gets an XFS file system, and the disk Fixtures are made;
#   whatever that does or fails to do is recorded and never stops the boot
#   let runner/run.py build, run and record, until 35 minutes after the box
#   started
#   upload blobs/, runs/, boots/ and this script's log to the stage's bucket
#   shut down, which terminates the instance
#
# At 35 minutes run.py is sent TERM: it kills the binary it is running, records
# that execution and the boot summary, and exits; 3 minutes later it is killed
# outright. Recording and uploading so happen in ordinary time, well before the
# 45-minute shutdown, which stays as the backstop. A failure anywhere still
# uploads what can be uploaded, and the log, and shuts down.
#
# The launch Lambda (infra/runs/launch-box.ts) puts these above this script:
#
#   LEDGERMATH_BUCKET         the stage's bucket
#   LEDGERMATH_STAGE          the SST stage
#   LEDGERMATH_SOURCE_KEY     the key of the source archive in that bucket
#   LEDGERMATH_SOURCE_COMMIT  the commit the archive was made from
#   AWS_DEFAULT_REGION        for the aws CLI
#   LEDGERMATH_FIXTURES_ENDPOINT, _REGION, _ROLE: the s3_fixtures Service (run.py)
#
# then the marker line below, then this file without its first line. The box
# checks that what it is running is runner/box.sh from that commit.
#
# LEDGERMATH_RUN_SECONDS, the budget in seconds from the box's start, is 2100
# unless set. The launch never sets it; scripts/box-in-container/run.sh does.
set -euo pipefail

# First, before anything can fail: end the box in 45 minutes.
BOX_STARTED="$(date +%s)"
if shutdown -h +45 "ledgermath: the box's 45-minute limit" 2>/dev/null; then
  TIMER="shutdown -h +45"
else
  nohup sh -c 'sleep 2700; poweroff -f' >/dev/null 2>&1 &
  TIMER="sleep 2700; poweroff -f (shutdown -h +45 failed)"
fi

LOG=/var/log/ledgermath-box.log
# tee ignores the TERM a shutdown sends, so the log keeps being written while
# the EXIT trap uploads.
exec > >(trap '' TERM INT; exec tee -a "$LOG") 2>&1

MARKER="# ---- runner/box.sh follows ----"
WORK=/var/tmp/ledgermath
ARCHIVE="$WORK/source.tar.gz"
SRC="$WORK/src"
OUT="$WORK/out"
BOOT="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)"
DAY="$(date -u +%Y/%m/%d)"

say() { echo "ledgermath-box: $*"; }

# What failed to upload; empty while everything has.
UPLOAD_FAILED=""

# Three tries, 10 and 20 seconds apart. The aws CLI already retries each
# request; this covers a whole command failing.
retry() {
  local attempt
  for attempt in 1 2 3; do
    "$@" && return 0
    say "attempt $attempt of 3 failed: $*"
    if [ "$attempt" -lt 3 ]; then sleep $((attempt * 10)); fi
  done
  return 1
}

put_part() {
  if [ "$1" = blobs ]; then
    # A blob's key is the hash of its bytes, so a blob the bucket already holds
    # under the same key and size is this blob: --size-only skips it, and the
    # versioned bucket keeps no second copy. sync lists blobs/ to find out, and
    # exits 0 only when every blob was uploaded or found there.
    aws s3 sync --size-only --only-show-errors --exclude '*.tmp' "$OUT/blobs/" "s3://$LEDGERMATH_BUCKET/blobs/"
  else
    aws s3 cp --recursive --only-show-errors --exclude '*.tmp' "$OUT/$1/" "s3://$LEDGERMATH_BUCKET/$1/"
  fi
}

# A Run, and a boot summary, names blobs. run.py writes every blob before the
# Run that names it, so once every blob of blobs/ is in the bucket, uploaded
# now or found there, every hash in runs/ and boots/ resolves. Until then
# neither is published.
upload_results() {
  if [ -z "${LEDGERMATH_BUCKET:-}" ] || ! command -v aws >/dev/null 2>&1; then
    UPLOAD_FAILED="everything (no bucket or no aws CLI)"
    return
  fi
  if [ -d "$OUT/blobs" ]; then
    say "uploading blobs/"
    if ! retry put_part blobs; then
      UPLOAD_FAILED="blobs/"
      say "UPLOAD FAILED: blobs/. No Run and no boot summary is published: they would name blobs the bucket may not hold."
      return
    fi
  fi
  local part
  for part in runs boots; do
    if [ -d "$OUT/$part" ]; then
      say "uploading $part/"
      if ! retry put_part "$part"; then
        UPLOAD_FAILED="$part/"
        say "UPLOAD FAILED: $part/"
        return
      fi
    fi
  done
}

upload_log() {
  if [ -z "${LEDGERMATH_BUCKET:-}" ] || ! command -v aws >/dev/null 2>&1; then
    return 1
  fi
  say "uploading this log to s3://$LEDGERMATH_BUCKET/logs/$DAY/$BOOT.log"
  sleep 1 # let tee write what came before
  retry aws s3 cp --only-show-errors --content-type text/plain "$LOG" "s3://$LEDGERMATH_BUCKET/logs/$DAY/$BOOT.log"
}

on_exit() {
  local code=$?
  trap - EXIT
  trap '' TERM INT # nothing cuts the upload short
  set +e
  say "the boot's work ended with status $code"
  upload_results
  if [ -n "$UPLOAD_FAILED" ]; then
    say "BOOT FAILED: the upload of $UPLOAD_FAILED failed"
    [ "$code" -ne 0 ] || code=1
  fi
  say "exiting with status $code"
  if ! upload_log; then
    say "UPLOAD FAILED: the log"
    [ "$code" -ne 0 ] || code=1
  fi
  say "shutting down"
  sync
  shutdown -h now || poweroff || true
  exit "$code"
}
trap on_exit EXIT
# A shutdown, the 45-minute one included, still uploads what exists.
trap 'say "terminated by a signal"; exit 143' TERM INT

say "start boot=$BOOT stage=${LEDGERMATH_STAGE:-?} timer: $TIMER"
: "${LEDGERMATH_BUCKET:?is not set}"
: "${LEDGERMATH_SOURCE_KEY:?is not set}"
: "${LEDGERMATH_SOURCE_COMMIT:?is not set}"

# For this log only; run.py records the provider's words in every Run.
imds() {
  local token
  token="$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')" || return 0
  curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1" || true
}
say "instance=$(imds instance-id) type=$(imds instance-type) image=$(imds ami-id) zone=$(imds placement/availability-zone)"

# The compiler and static C library for the builds; cmake and g++ for
# AWS-LC, which http_get links; tar and gzip for the source; util-linux for
# the dump's lscpu, lsblk and findmnt; nvme-cli for the NVMe disks' own
# records and latency histograms; xfsprogs for the instance store's file
# system and the dump's xfs_info; ethtool for the network's counters.
# Whatever the image already has stays as it is, and the dump lists every
# package.
dnf install -y gcc gcc-c++ cmake make glibc-static python3 tar gzip util-linux nvme-cli xfsprogs ethtool
say "$(rpm -q system-release gcc gcc-c++ cmake glibc-static python3 nvme-cli xfsprogs ethtool | tr '\n' ' ')"

rm -rf "$SRC" "$OUT"
mkdir -p "$SRC"
say "fetching s3://$LEDGERMATH_BUCKET/$LEDGERMATH_SOURCE_KEY"
aws s3 cp --only-show-errors "s3://$LEDGERMATH_BUCKET/$LEDGERMATH_SOURCE_KEY" "$ARCHIVE"

# git archive writes the commit into the archive's pax header. That, not the
# variable, is what the Runs record, and the two must agree.
COMMIT="$(python3 -I -c 'import sys, tarfile; print(tarfile.open(sys.argv[1]).pax_headers.get("comment", ""))' "$ARCHIVE")"
if [ "$COMMIT" != "$LEDGERMATH_SOURCE_COMMIT" ]; then
  say "the archive says commit '$COMMIT'; the launch said '$LEDGERMATH_SOURCE_COMMIT'"
  exit 1
fi
tar -xzf "$ARCHIVE" -C "$SRC"

RUNNING="$(sed "1,\%^$MARKER\$%d" "$0" | sha256sum)"
COMMITTED="$(tail -n +2 "$SRC/runner/box.sh" | sha256sum)"
if [ "$RUNNING" != "$COMMITTED" ]; then
  say "this user-data is not runner/box.sh at $COMMIT"
  exit 1
fi

cc -O2 -o "$WORK/cpuid" "$SRC/runner/cpuid.c"
# For http_get's build; without it only http_get fails to build.
if AWS_LC_ARCHIVE="$(sh "$SRC/runner/aws-lc-archive.sh" "$SRC" "$WORK")"; then export AWS_LC_ARCHIVE; fi
export AWS_LC_JOBS="$(nproc)"

# The disks, before the schedule: what provision.py does and finds is in its
# record, which every dump holds as the section `provision`. Its failure is
# never the boot's: every other benchmark still runs, and a disk Run that
# finds no Fixture fails by itself and says why.
#
# --supervise-seconds 330 is provisioning's outer limit: provision.py runs the
# work as a child in a session of its own (it writes that session's id to
# $PROVISION_SESSION at once), sends it TERM at 330 seconds (it stops itself at
# 300) and KILL 15 seconds later, then kills whatever is left in that session
# and completes the record. timeout(1) at 360 seconds is box.sh's own limit,
# for a supervisor that is itself stuck; after it, runner/provision-leftovers.py
# ends whatever is left of provisioning's session, removes what a half-done
# preparation left where a benchmark could find it, and says so in the record.
# On a real i4i.2xlarge provisioning took 44 seconds.
PROVISION_RECORD="$WORK/provision.json"
PROVISION_SESSION="$WORK/provision.session"


if ! cc -O2 -I "$SRC/benchmarks/harness/c" -o "$WORK/fixture" "$SRC/runner/fixture.c"; then
  say "the fixture tool did not build; the disk Fixtures cannot be made"
fi
say "preparing the disks"
PROVISION_STATUS=0
timeout --kill-after=10 360 python3 "$SRC/runner/provision.py" --supervise-seconds 330 \
  --session-file "$PROVISION_SESSION" --record "$PROVISION_RECORD" --fixture-tool "$WORK/fixture" \
  --instance-type "$(imds instance-type)" --region "$(imds placement/region)" || PROVISION_STATUS=$?
python3 "$SRC/runner/provision-leftovers.py" "$PROVISION_RECORD" "$PROVISION_SESSION" /mnt/lm/instance-store \
  "$WORK/disk" "$PROVISION_STATUS" || say "provision-leftovers.py failed with status $?"
if [ "$PROVISION_STATUS" -eq 0 ]; then
  say "the disks are ready"
else
  say "preparing the disks failed, refused a disk, or was stopped, with status $PROVISION_STATUS; $PROVISION_RECORD says what happened. The schedule runs all the same."
fi

BUDGET=$((BOX_STARTED + ${LEDGERMATH_RUN_SECONDS:-2100} - $(date +%s)))
if [ "$BUDGET" -lt 10 ]; then
  say "only ${BUDGET}s of the time budget is left; not starting the schedule"
  exit 1
fi
say "running the schedule at $COMMIT, for at most ${BUDGET}s"
# --foreground: the TERM goes to run.py alone, which stops the binary itself
# and records it. The exit status is 124 when the budget ran out, whether
# run.py then exited or was killed; its boot summary tells the two apart.
RUN_STATUS=0
timeout --foreground --signal=TERM --kill-after=180 "$BUDGET" \
  python3 "$SRC/runner/run.py" --root "$SRC" --out "$OUT" --source-commit "$COMMIT" \
  --source-archive "$ARCHIVE" --cpuid "$WORK/cpuid" --provision-record "$PROVISION_RECORD" || RUN_STATUS=$?
case "$RUN_STATUS" in
  0) say "done" ;;
  124)
    if compgen -G "$OUT/boots/*/*/*/*.json" >/dev/null; then
      say "the time budget ran out; run.py recorded the execution in flight and the boot summary"
    else
      say "the time budget ran out and run.py did not stop within 180s; it was killed, so the execution in flight has no Run"
    fi
    ;;
  *) say "run.py exited with status $RUN_STATUS" ;;
esac
exit "$RUN_STATUS"
# The EXIT trap uploads and shuts down.
