#!/bin/sh
# Fetches AWS-LC's source archive, as aws-lc.lock pins it, and checks its hash.
#
#   fetch-aws-lc.sh OUT [URL]
#
# URL defaults to the lock's AWS_LC_URL (GitHub's archive for the tag); a box
# may give another copy of the same bytes, such as a blob in its bucket. OUT
# is written only when the bytes have the pinned SHA-256. Needs curl and
# sha256sum.
set -eu

out=${1:?usage: fetch-aws-lc.sh OUT [URL]}
lock=$(dirname "$0")/aws-lc.lock
value() { sed -n "s/^$1 := //p" "$lock"; }
url=${2:-$(value AWS_LC_URL)}
sha256=$(value AWS_LC_SHA256)
[ -n "$url" ] && [ -n "$sha256" ] || { echo "fetch-aws-lc: $lock has no AWS_LC_URL or AWS_LC_SHA256" >&2; exit 1; }

partial=$out.partial
curl --fail --silent --show-error --location --retry 3 --output "$partial" "$url"
actual=$(sha256sum "$partial" | cut -d' ' -f1)
if [ "$actual" != "$sha256" ]; then
    rm -f "$partial"
    echo "fetch-aws-lc: $url has sha256 $actual, and aws-lc.lock pins $sha256" >&2
    exit 1
fi
mv "$partial" "$out"
echo "fetch-aws-lc: $out has the pinned sha256 $sha256"
