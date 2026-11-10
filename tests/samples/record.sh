#!/usr/bin/env bash
# Records the three sample directories from HEAD, in the Amazon Linux 2023
# container, and prepares them (tests/samples/prepare.ts):
#
#   scheduled/    scripts/box-in-container/run.sh --scenario ok: the whole schedule
#   interrupted/  scripts/box-in-container/run.sh --scenario terminated: run.py told
#                 to stop while a binary runs
#   failures/     runner/run.py with failures/schedule.json, called as box.sh calls it
#
#   tests/samples/record.sh     (about ten minutes; Docker must work for the caller)
#
# Commit the result on top of the commit it was recorded from, so every Run's
# source_commit names a commit in the history.
set -euo pipefail

IMAGE=amazonlinux:2023.12.20260710.0
cd "$(dirname "$0")"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
COMMIT="$(git rev-parse HEAD)"
WORK="$(mktemp -d /tmp/ledgermath-samples-XXXXXX)"
echo "recording samples from $COMMIT in $WORK"

scripts/box-in-container/run.sh --scenario ok "$WORK/scheduled"
scripts/box-in-container/run.sh --scenario terminated "$WORK/interrupted"

mkdir -p "$WORK/failures"
git archive --format=tar.gz -o "$WORK/failures/source.tar.gz" "$COMMIT"
cp tests/samples/failures/schedule.json "$WORK/failures/schedule.json"
docker run --rm --hostname ip-192-0-2-10 -v "$WORK/failures:/work" "$IMAGE" bash -c "
  set -e
  dnf install -y -q gcc make glibc-static python3 tar gzip util-linux >/dev/null
  mkdir /src && tar -xzf /work/source.tar.gz -C /src
  cc -O2 -o /cpuid /src/runner/cpuid.c
  python3 /src/runner/run.py --root /src --out /work/out --source-commit $COMMIT \
    --source-archive /work/source.tar.gz --cpuid /cpuid --schedule /work/schedule.json
"
docker run --rm -v "$WORK:/out" "$IMAGE" chown -R "$(id -u):$(id -g)" /out

for name in scheduled interrupted; do
  bun tests/samples/prepare.ts "$WORK/$name/s3/ledgermath-container-test" "tests/samples/$name"
done
bun tests/samples/prepare.ts "$WORK/failures/out" tests/samples/failures
for name in scheduled interrupted failures; do
  bun scripts/check-runs.ts --omitted "tests/samples/$name/omitted-blobs.json" "tests/samples/$name"
done
echo "recorded from $COMMIT; the raw recording is in $WORK"
