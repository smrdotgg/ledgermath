#!/usr/bin/env bash
# The box's user-data, on the pinned Amazon Linux 2023 image. It runs once, as
# root, on a fresh instance launched with shutdown behaviour "terminate":
#
#   set a 45-minute shutdown timer, whatever happens after
#   install the compiler, the static C library and the dump's tools
#   fetch and unpack the source archive, a `git archive` of one commit
#   build the cpuid tool, then let runner/run.py build, run and record, until
#   35 minutes after the box started
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

# The compiler and static C library for the builds; tar and gzip for the
# source; util-linux for the dump's lscpu, lsblk and findmnt. Whatever the
# image already has stays as it is, and the dump lists every package.
dnf install -y gcc make glibc-static python3 tar gzip util-linux
say "$(rpm -q system-release gcc glibc-static python3 util-linux | tr '\n' ' ')"

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
  --source-archive "$ARCHIVE" --cpuid "$WORK/cpuid" || RUN_STATUS=$?
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
