#include "harness.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SORT_BYTES (1024ULL * 1024ULL)
#define SORT_ELEMENTS (SORT_BYTES / sizeof(uint64_t))
#define RADIX_BUCKETS 256U

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

static uint64_t checksum_u64(const uint64_t *values, size_t len) {
    uint64_t hash = 1469598103934665603ULL;
    for (size_t i = 0; i < len; i++) {
        hash ^= values[i];
        hash *= 1099511628211ULL;
    }
    return hash;
}

__attribute__((noinline))
static uint64_t sort_run(void *arg) {
    sort_ctx_t *ctx = (sort_ctx_t *)arg;
    memcpy(ctx->scratch, ctx->input, ctx->len * sizeof(uint64_t));
    radix_sort_u64(ctx->scratch, ctx->tmp, ctx->len);
    return checksum_u64(ctx->scratch, ctx->len);
}

int main(int argc, char **argv) {
    bench_opts_t opts = parse_opts(argc, argv);

    uint64_t *input = (uint64_t *)xalloc(64, SORT_BYTES);
    uint64_t *scratch = (uint64_t *)xalloc(64, SORT_BYTES);
    uint64_t *tmp = (uint64_t *)xalloc(64, SORT_BYTES);

    uint64_t seed = 0x6a09e667f3bcc909ULL;
    for (size_t i = 0; i < SORT_ELEMENTS; i++) input[i] = xorshift64star(&seed);

    sort_ctx_t sort = { input, scratch, tmp, SORT_ELEMENTS };
    memcpy(sort.scratch, sort.input, SORT_BYTES);
    radix_sort_u64(sort.scratch, sort.tmp, sort.len);
    if (!is_sorted_u64(sort.scratch, sort.len)) {
        fprintf(stderr, "error: sort validation failed\n");
        return 1;
    }

    result_t results[1];
    results[0] = measure("sort", "u64", 1, SORT_BYTES, sort_run, &sort,
                         opts.samples, opts.target_calibration_ns);
    print_json(results, 1);

    free(input);
    free(scratch);
    free(tmp);
    return 0;
}
