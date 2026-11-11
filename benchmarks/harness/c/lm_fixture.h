#ifndef LEDGERMATH_LM_FIXTURE_H
#define LEDGERMATH_LM_FIXTURE_H

/* The disk Fixture: the file the disk read benchmarks read, made at boot by
 * the box (runner/fixture.c, run by runner/provision.py), never by a
 * benchmark. Defined once here, so the tool that writes it and the binaries
 * that check what they read agree.
 *
 * The file is named LM_FIXTURE_NAME in the directory a parameter set's `dir`
 * gives. The 64-bit little-endian word at byte offset o (a multiple of 8) is
 *
 *     lm_fixture_word(o) = mix64(o ^ 0x8d6d2f9d5f9d1b37)
 *
 * where mix64 is the finalizer of SplitMix64. It is July's io_uring pattern
 * (benchmarks/c/bench_disk_read_io_uring.c). Every word differs from its
 * neighbours and from the same word of any other block, so a read that
 * returned zeros, another block, or stale data is caught by its checksum.
 * Header only, so runner/fixture.c needs nothing else of the harness.
 */

#include <stdint.h>

#define LM_FIXTURE_NAME "ledgermath-fixture-v1"
#define LM_FIXTURE_SEED 0x8d6d2f9d5f9d1b37ULL

static inline uint64_t lm_mix64(uint64_t x) {
    x ^= x >> 30;
    x *= 0xbf58476d1ce4e5b9ULL;
    x ^= x >> 27;
    x *= 0x94d049bb133111ebULL;
    x ^= x >> 31;
    return x;
}

/* The word at byte offset `offset` of the Fixture. */
static inline uint64_t lm_fixture_word(uint64_t offset) {
    return lm_mix64(offset ^ LM_FIXTURE_SEED);
}

#endif /* LEDGERMATH_LM_FIXTURE_H */
