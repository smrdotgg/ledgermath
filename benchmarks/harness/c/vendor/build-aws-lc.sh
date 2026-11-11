#!/bin/sh
# Builds AWS-LC's static libraries from its source archive, as aws-lc.lock pins
# it, into DIR, once: a later call with the same archive hash, flags and tools
# finds DIR's record of the earlier build and does nothing, so `make -B` does
# not rebuild the library.
#
#   build-aws-lc.sh ARCHIVE DIR
#
# The lock's values arrive in the environment (the Makefile passes them):
# AWS_LC_VERSION, AWS_LC_SHA256, AWS_LC_ARCHIVE_ROOT, AWS_LC_CMAKE_FLAGS and
# AWS_LC_TARGETS, with CC, CXX and AWS_LC_JOBS. Leaves DIR/src (the unpacked
# source; its include/ is the headers), DIR/build/crypto/libcrypto.a,
# DIR/build/ssl/libssl.a, DIR/build.log (everything CMake and the compiler
# printed) and DIR/built (what was built, from what, with what).
#
# Prints a few lines: the commands it ran and how long they took. They become
# part of the build record's `command`; the full log stays in DIR/build.log.
set -eu

archive=${1:-}
dir=${2:?usage: build-aws-lc.sh ARCHIVE DIR}
: "${AWS_LC_VERSION:?}" "${AWS_LC_SHA256:?}" "${AWS_LC_ARCHIVE_ROOT:?}" "${AWS_LC_CMAKE_FLAGS:?}" "${AWS_LC_TARGETS:?}"
CC=${CC:-cc}
CXX=${CXX:-c++}
jobs=${AWS_LC_JOBS:-2}

say() { printf 'aws-lc: %s\n' "$*"; }
die() { printf 'aws-lc: error: %s\n' "$*" >&2; exit 1; }

command -v cmake >/dev/null 2>&1 || die "cmake is not installed (on Amazon Linux 2023: dnf install cmake gcc-c++)"
command -v "$CXX" >/dev/null 2>&1 || die "the C++ compiler $CXX is not installed (on Amazon Linux 2023: dnf install gcc-c++)"

mkdir -p "$dir"
dir=$(cd "$dir" && pwd)
src=$dir/src
build=$dir/build
# The source file names compiled into the library (assertions, error queue
# entries) are written relative to these, so where the archive was unpacked
# does not change the library's bytes.
prefix_map="-ffile-prefix-map=$src=$AWS_LC_ARCHIVE_ROOT -ffile-prefix-map=$build=build"

record=$(printf '%s\n' \
    "version $AWS_LC_VERSION" \
    "archive sha256 $AWS_LC_SHA256" \
    "cmake flags $AWS_LC_CMAKE_FLAGS" \
    "c and c++ flags $prefix_map" \
    "targets $AWS_LC_TARGETS" \
    "cc $("$CC" --version | head -n 1)" \
    "c++ $("$CXX" --version | head -n 1)" \
    "$(cmake --version | head -n 1)")

if [ -f "$dir/built" ] && [ "$(cat "$dir/built")" = "$record" ] \
    && [ -f "$build/crypto/libcrypto.a" ] && [ -f "$build/ssl/libssl.a" ]; then
    say "AWS-LC $AWS_LC_VERSION is already built in $dir, from the archive with sha256 $AWS_LC_SHA256, by the same tools and flags:"
    printf '%s\n' "$record" | sed 's/^/aws-lc:   /'
    exit 0
fi

[ -n "$archive" ] || die "no source archive: set AWS_LC_ARCHIVE to the path of $AWS_LC_ARCHIVE_ROOT's archive, $(printf '%s' "$AWS_LC_SHA256" | cut -c1-12)... ($AWS_LC_URL)"
[ -f "$archive" ] || die "the source archive $archive does not exist"
actual=$(sha256sum "$archive" | cut -d' ' -f1)
[ "$actual" = "$AWS_LC_SHA256" ] || die "the source archive $archive has sha256 $actual, and aws-lc.lock pins $AWS_LC_SHA256"
say "the source archive $archive has the pinned sha256 $actual"

rm -rf "$src" "$build" "$dir/built" "$dir/build.log" "$dir/unpack"
mkdir -p "$dir/unpack"
tar -xzf "$archive" -C "$dir/unpack"
[ -d "$dir/unpack/$AWS_LC_ARCHIVE_ROOT" ] || die "the archive does not unpack to $AWS_LC_ARCHIVE_ROOT/"
mv "$dir/unpack/$AWS_LC_ARCHIVE_ROOT" "$src"
rm -rf "$dir/unpack"

start=$(date +%s)
# shellcheck disable=SC2086 # the flags are words
say "cmake -S $src -B $build $AWS_LC_CMAKE_FLAGS -DCMAKE_C_COMPILER=$CC -DCMAKE_CXX_COMPILER=$CXX -DCMAKE_C_FLAGS='$prefix_map' -DCMAKE_CXX_FLAGS='$prefix_map'"
cmake -S "$src" -B "$build" $AWS_LC_CMAKE_FLAGS "-DCMAKE_C_COMPILER=$CC" "-DCMAKE_CXX_COMPILER=$CXX" \
    "-DCMAKE_C_FLAGS=$prefix_map" "-DCMAKE_CXX_FLAGS=$prefix_map" >"$dir/build.log" 2>&1 \
    || { tail -n 30 "$dir/build.log" >&2; die "cmake failed; the whole log is $dir/build.log"; }
configured=$(date +%s)
say "cmake --build $build --target $AWS_LC_TARGETS -j $jobs"
# shellcheck disable=SC2086
cmake --build "$build" --target $AWS_LC_TARGETS -j "$jobs" >>"$dir/build.log" 2>&1 \
    || { tail -n 30 "$dir/build.log" >&2; die "the build failed; the whole log is $dir/build.log"; }
done_at=$(date +%s)
printf '%s\n' "$record" >"$dir/built"
say "configured in $((configured - start)) s, built in $((done_at - configured)) s; the log is $dir/build.log"
printf '%s\n' "$record" | sed 's/^/aws-lc:   /'
