#!/usr/bin/env bash
# The box's user-data, on the pinned Amazon Linux 2023 image. It runs once, as
# root, on a fresh instance launched with shutdown behaviour "terminate":
#
#   set a 45-minute shutdown timer, whatever happens after
#   install the compiler, the static C library and the dump's tools
#   fetch and unpack the source archive, a `git archive` of one commit
#   build the cpuid tool, then let runner/run.py build, run and record
#   upload blobs/, runs/, boots/ and this script's log to the stage's bucket
#   shut down, which terminates the instance
#
# A failure anywhere still uploads what exists, and the log, and shuts down.
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
set -euo pipefail

# First, before anything can fail: end the box in 45 minutes.
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

upload() {
  if [ -z "${LEDGERMATH_BUCKET:-}" ] || ! command -v aws >/dev/null 2>&1; then
    say "cannot upload: no bucket or no aws CLI"
    return
  fi
  local bucket="s3://$LEDGERMATH_BUCKET"
  # Blobs first, so nothing in the bucket cites a blob that is not there yet.
  local part
  for part in blobs runs boots; do
    if [ -d "$OUT/$part" ]; then
      say "uploading $part/"
      aws s3 cp --recursive --only-show-errors --exclude '*.tmp' "$OUT/$part" "$bucket/$part" \
        || say "UPLOAD FAILED: $part/"
    fi
  done
  say "uploading this log to $bucket/logs/$DAY/$BOOT.log"
  sleep 1 # let tee write what came before
  aws s3 cp --only-show-errors --content-type text/plain "$LOG" "$bucket/logs/$DAY/$BOOT.log" \
    || say "UPLOAD FAILED: the log"
}

on_exit() {
  local code=$?
  trap - EXIT
  trap '' TERM INT # nothing cuts the upload short
  set +e
  say "exiting with status $code"
  upload
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

say "running the schedule at $COMMIT"
python3 "$SRC/runner/run.py" --root "$SRC" --out "$OUT" --source-commit "$COMMIT" \
  --source-archive "$ARCHIVE" --cpuid "$WORK/cpuid"
say "done"
# The EXIT trap uploads and shuts down.
