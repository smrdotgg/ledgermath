/* sort: copy an unsorted array of 64-bit keys into a scratch buffer and sort it
 * with an LSD radix sort, one byte per pass.
 *
 * Parameters:
 *   LM_PARAM_SIZE_BYTES  bytes of keys sorted per repetition; a multiple of 8
 *
 * Observed:
 *   bytes_per_repetition  bytes of keys one repetition copies and sorts
 *
 * The input (xorshift64* from a fixed seed), the copy, the radix sort and the
 * checksum are the ones the July 2026 proof of concept ran, unchanged. Each
 * repetition sorts a fresh copy of the same unsorted input, and returns a sum
 * of every 512th key of the sorted result, so the sort cannot be dropped.
 */

#if !defined(__linux__) || !defined(__x86_64__)
#error "sort requires Linux x86_64"
#endif

#include "lm.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#define RADIX_BUCKETS 256U
#define INPUT_SEED 0x6a09e667f3bcc909ULL

typedef struct {
    const uint64_t *input;
    uint64_t *scratch;
    uint64_t *tmp;
    size_t len;
} sort_ctx_t;

static uint64_t xorshift64star(uint64_t *state) {
    uint64_t x = *state;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    *state = x;
    return x * 2685821657736338717ULL;
}

__attribute__((noinline))
static void radix_sort_u64(uint64_t *values, uint64_t *tmp, size_t len) {
    uint64_t *in = values;
    uint64_t *out = tmp;
    size_t counts[RADIX_BUCKETS];
    size_t offsets[RADIX_BUCKETS];

    for (unsigned shift = 0; shift < 64; shift += 8) {
        memset(counts, 0, sizeof(counts));
        for (size_t i = 0; i < len; i++) {
            counts[(in[i] >> shift) & 0xffU]++;
        }

        size_t total = 0;
        for (unsigned i = 0; i < RADIX_BUCKETS; i++) {
            offsets[i] = total;
            total += counts[i];
        }

        for (size_t i = 0; i < len; i++) {
            unsigned bucket = (unsigned)((in[i] >> shift) & 0xffU);
            out[offsets[bucket]++] = in[i];
        }

        uint64_t *swap = in;
        in = out;
        out = swap;
    }

    if (in != values) memcpy(values, in, len * sizeof(uint64_t));
}

static bool is_sorted_u64(const uint64_t *values, size_t len) {
    for (size_t i = 1; i < len; i++) {
        if (values[i - 1] > values[i]) return false;
    }
    return true;
}

static uint64_t sum_u64(const uint64_t *values, size_t len) {
    uint64_t sum = 0;
    for (size_t i = 0; i < len; i++) sum += values[i];
    return sum;
}

/* Sparse probe of the sorted output: it depends on the completed sort, but is
 * cheap beside it. */
static uint64_t checksum_u64(const uint64_t *values, size_t len) {
    uint64_t sum = values[0] ^ values[len / 2] ^ values[len - 1];
    for (size_t i = 0; i < len; i += 512) sum += values[i];
    return sum;
}

/* One repetition: copy the unsorted input, then sort the copy. */
__attribute__((noinline))
static uint64_t sort_run(void *arg) {
    sort_ctx_t *ctx = (sort_ctx_t *)arg;
    memcpy(ctx->scratch, ctx->input, ctx->len * sizeof(uint64_t));
    radix_sort_u64(ctx->scratch, ctx->tmp, ctx->len);
    return checksum_u64(ctx->scratch, ctx->len);
}

int main(int argc, char **argv) {
    lm_start(argc, argv);

    uint64_t size_bytes = lm_param_u64("size_bytes", "1048576");
    if (size_bytes == 0 || size_bytes % sizeof(uint64_t) != 0) {
        lm_usage("parameter size_bytes must be a positive multiple of 8, got %llu", (unsigned long long)size_bytes);
    }
    size_t len = (size_t)(size_bytes / sizeof(uint64_t));

    uint64_t *input = (uint64_t *)lm_alloc(64, (size_t)size_bytes);
    uint64_t *scratch = (uint64_t *)lm_alloc(64, (size_t)size_bytes);
    uint64_t *tmp = (uint64_t *)lm_alloc(64, (size_t)size_bytes);

    uint64_t seed = INPUT_SEED;
    for (size_t i = 0; i < len; i++) input[i] = xorshift64star(&seed);

    sort_ctx_t ctx = { input, scratch, tmp, len };
    sort_run(&ctx);
    if (!is_sorted_u64(ctx.scratch, len)) lm_die("the sorted copy is not in order");
    if (sum_u64(ctx.scratch, len) != sum_u64(input, len)) lm_die("the sorted copy does not hold the input's keys");

    lm_observe_u64("bytes_per_repetition", (uint64_t)len * sizeof(uint64_t));
    lm_observed();

    lm_measure(sort_run, &ctx);

    free(input);
    free(scratch);
    free(tmp);
    lm_finish();
    return 0;
}
