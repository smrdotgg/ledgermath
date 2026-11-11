#!/bin/sh
# Fetches the source archive of AWS-LC, the TLS library http_get links, for
# its build: from the copy the deploy keeps in the stage's bucket as a blob,
# blobs/sha256/<hash>, the hash benchmarks/harness/c/vendor/aws-lc.lock pins
# (infra/runs/tls-archive.ts). Checks the bytes against that hash and prints
# the file's path, which runner/box.sh exports as AWS_LC_ARCHIVE, the variable
# http_get's Makefile reads.
#
#   aws-lc-archive.sh SRC DIR      SRC: the source tree; DIR: where to put it
#
# Needs LEDGERMATH_BUCKET, the aws CLI and sha256sum. When anything fails it
# says why on stderr, prints nothing on stdout and exits 1: http_get then
# fails to build, saying it has no archive, and every other benchmark runs.
set -eu

src=${1:?usage: aws-lc-archive.sh SRC DIR}
dir=${2:?usage: aws-lc-archive.sh SRC DIR}
say() { echo "ledgermath-box: $*" >&2; }

lock="$src/benchmarks/harness/c/vendor/aws-lc.lock"
if [ ! -f "$lock" ]; then
  say "the source has no benchmarks/harness/c/vendor/aws-lc.lock, so no TLS library archive is fetched"
  exit 1
fi
sha256=$(sed -n 's/^AWS_LC_SHA256 := //p' "$lock")
if ! printf '%s\n' "$sha256" | grep -qx '[0-9a-f]\{64\}'; then
  say "aws-lc.lock pins no 64-digit AWS_LC_SHA256; http_get will not build"
  exit 1
fi

url="s3://$LEDGERMATH_BUCKET/blobs/sha256/$sha256"
out="$dir/aws-lc-$sha256.tar.gz"
rm -f "$out" "$out.partial"
if ! aws s3 cp --only-show-errors "$url" "$out.partial" >&2; then
  rm -f "$out.partial"
  say "could not fetch AWS-LC's source archive, $url; http_get will not build"
  exit 1
fi
actual=$(sha256sum "$out.partial" | cut -d' ' -f1)
if [ "$actual" != "$sha256" ]; then
  rm -f "$out.partial"
  say "$url has sha256 $actual, and aws-lc.lock pins $sha256; http_get will not build"
  exit 1
fi
mv "$out.partial" "$out"
say "AWS-LC's source archive is $out, with the pinned sha256 $sha256"
printf '%s\n' "$out"
