#include "harness.h"

#include <immintrin.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>

#define NORMAL_MEMORY_BYTES (1024ULL * 1024ULL * 1024ULL)
#define QUICK_MEMORY_BYTES  (512ULL * 1024ULL * 1024ULL)
#define ELEMENT_BYTES       64ULL
#define ALLOC_ALIGNMENT     4096ULL

typedef struct {
    uint64_t w[8];
} memory_element_t;

_Static_assert(sizeof(memory_element_t) == ELEMENT_BYTES, "memory element must be 64 bytes");

typedef struct {
    memory_element_t *data;
    size_t *order;
    size_t elements;
} memory_write_ctx_t;

static uint64_t shuffle_next(uint64_t *state) {
    uint64_t x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    return x;
}

static void shuffle_order(size_t *order, size_t elements) {
    uint64_t state = 0x6eed0e9da4d94a4fULL;
    for (size_t i = elements - 1; i > 0; i--) {
        size_t j = (size_t)(shuffle_next(&state) % (uint64_t)(i + 1));
        size_t tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
    }
}

static void fill_element(memory_element_t *element, uint64_t v) {
    __m256i value = _mm256_set1_epi64x((long long)v);
    _mm256_store_si256((__m256i *)(void *)&element->w[0], value);
    _mm256_store_si256((__m256i *)(void *)&element->w[4], value);
}

static void initialize_memory(memory_element_t *data, size_t elements) {
    for (size_t i = 0; i < elements; i++) fill_element(&data[i], 0);
}

__attribute__((noinline))
static uint64_t memory_write_sequential(void *arg) {
    memory_write_ctx_t *ctx = (memory_write_ctx_t *)arg;
    uint64_t checksum = 0;
    for (size_t i = 0; i < ctx->elements; i++) {
        fill_element(&ctx->data[i], (uint64_t)i);
        checksum += *(const volatile uint64_t *)&ctx->data[i].w[7];
    }
    return checksum;
}

__attribute__((noinline))
static uint64_t memory_write_random(void *arg) {
    memory_write_ctx_t *ctx = (memory_write_ctx_t *)arg;
    uint64_t checksum = 0;
    for (size_t i = 0; i < ctx->elements; i++) {
        size_t idx = ctx->order[i];
        fill_element(&ctx->data[idx], (uint64_t)idx);
        checksum += *(const volatile uint64_t *)&ctx->data[idx].w[7];
    }
    return checksum;
}

static bool order_is_identity(const size_t *order, size_t elements) {
    for (size_t i = 0; i < elements; i++) {
        if (order[i] != i) return false;
    }
    return true;
}

int main(int argc, char **argv) {
    bench_opts_t opts = parse_opts(argc, argv);

    size_t memory_bytes = (size_t)(opts.quick ? QUICK_MEMORY_BYTES : NORMAL_MEMORY_BYTES);
    size_t elements = memory_bytes / sizeof(memory_element_t);
    memory_write_ctx_t ctx = {0};
    ctx.elements = elements;
    ctx.data = (memory_element_t *)xalloc(ALLOC_ALIGNMENT, memory_bytes);
    ctx.order = (size_t *)xalloc(64, elements * sizeof(size_t));

    initialize_memory(ctx.data, elements);
    if (madvise(ctx.data, memory_bytes, MADV_RANDOM) != 0) {
        perror("warning: madvise(MADV_RANDOM)");
    }
    for (size_t i = 0; i < elements; i++) ctx.order[i] = i;
    shuffle_order(ctx.order, elements);
    if (elements > 1 && order_is_identity(ctx.order, elements)) {
        fprintf(stderr, "error: random write order was not shuffled\n");
        return 1;
    }

    uint64_t expected = expected_sum_range(0, (uint64_t)elements);
    if (memory_write_sequential(&ctx) != expected || memory_write_random(&ctx) != expected) {
        fprintf(stderr, "error: memory_write checksum validation failed\n");
        return 1;
    }

    result_t results[2];
    results[0] = measure("memory_write", "1 thread, Sequential", 1, (uint64_t)memory_bytes,
                         memory_write_sequential, &ctx, opts.samples, opts.target_calibration_ns);
    results[1] = measure("memory_write", "1 thread, Random", 1, (uint64_t)memory_bytes,
                         memory_write_random, &ctx, opts.samples, opts.target_calibration_ns);
    print_json(results, 2);

    free(ctx.order);
    free(ctx.data);
    return 0;
}
