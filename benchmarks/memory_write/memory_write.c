/* memory_write: write every 64-byte element of a large buffer, front to back
 * or in a shuffled order.
 *
 * Parameters:
 *   LM_PARAM_SIZE_BYTES  bytes written per repetition; a multiple of 64
 *   LM_PARAM_THREADS     "1" writes on the main thread, unpinned; the only value
 *   LM_PARAM_ORDER       "sequential" (front to back) or "random" (a shuffled order)
 *
 * Observed:
 *   bytes_per_repetition  bytes the write loop covers in one repetition
 *   threads_used          threads that wrote
 *   order_taken           the write loop that was dispatched
 *
 * The write loops, the element layout, the shuffle and its seed are the ones
 * the July 2026 proof of concept ran, unchanged. Each element is written with
 * two 32-byte AVX2 stores, then its last word is read back through a volatile
 * load, so the stores cannot be dropped.
 */

#if !defined(__linux__) || !defined(__x86_64__)
#error "memory_write requires Linux x86_64"
#endif

#include "lm.h"

#include <errno.h>
#include <immintrin.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>

#define ELEMENT_BYTES   64ULL
#define ALLOC_ALIGNMENT 4096ULL
#define SHUFFLE_SEED    0x6eed0e9da4d94a4fULL

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
    uint64_t state = SHUFFLE_SEED;
    for (size_t i = elements - 1; i > 0; i--) {
        size_t j = (size_t)(shuffle_next(&state) % (uint64_t)(i + 1));
        size_t tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
    }
}

__attribute__((target("avx2")))
static void fill_element(memory_element_t *element, uint64_t v) {
    __m256i value = _mm256_set1_epi64x((long long)v);
    _mm256_store_si256((__m256i *)(void *)&element->w[0], value);
    _mm256_store_si256((__m256i *)(void *)&element->w[4], value);
}

__attribute__((target("avx2")))
static void initialize_memory(memory_element_t *data, size_t elements) {
    for (size_t i = 0; i < elements; i++) fill_element(&data[i], 0);
}

/* One repetition: every element written once, front to back. */
__attribute__((noinline, target("avx2")))
static uint64_t memory_write_sequential(void *arg) {
    memory_write_ctx_t *ctx = (memory_write_ctx_t *)arg;
    uint64_t checksum = 0;
    for (size_t i = 0; i < ctx->elements; i++) {
        fill_element(&ctx->data[i], (uint64_t)i);
        checksum += *(const volatile uint64_t *)&ctx->data[i].w[7];
    }
    return checksum;
}

/* One repetition: every element written once, in the shuffled order. */
__attribute__((noinline, target("avx2")))
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

/* sum(0..count-1), with 64-bit wraparound */
static uint64_t sum_below(uint64_t count) {
    if (count == 0) return 0;
    uint64_t last = count - 1;
    return (count & 1ULL) == 0 ? (count / 2) * last : count * (last / 2);
}

int main(int argc, char **argv) {
    lm_start(argc, argv);

    uint64_t size_bytes = lm_param_u64("size_bytes", "67108864");
    const char *threads = lm_param("threads", "1");
    const char *order = lm_param("order", "sequential");
    if (size_bytes < 2 * ELEMENT_BYTES || size_bytes % ELEMENT_BYTES != 0) {
        lm_usage("parameter size_bytes must be a multiple of 64 of at least 128, got %llu", (unsigned long long)size_bytes);
    }
    if (strcmp(threads, "1") != 0) lm_usage("parameter threads must be \"1\", the only value implemented, got \"%s\"", threads);

    lm_fn write;
    if (strcmp(order, "sequential") == 0) write = memory_write_sequential;
    else if (strcmp(order, "random") == 0) write = memory_write_random;
    else lm_usage("parameter order must be \"sequential\" or \"random\", got \"%s\"", order);

    __builtin_cpu_init();
    if (!__builtin_cpu_supports("avx2")) lm_die("this CPU does not support AVX2, which the write loop uses");

    memory_write_ctx_t ctx = {0};
    ctx.elements = (size_t)(size_bytes / ELEMENT_BYTES);
    ctx.data = (memory_element_t *)lm_alloc(ALLOC_ALIGNMENT, (size_t)size_bytes);
    initialize_memory(ctx.data, ctx.elements);
    if (madvise(ctx.data, (size_t)size_bytes, MADV_RANDOM) != 0) {
        fprintf(stderr, "warning: madvise(MADV_RANDOM): %s\n", strerror(errno));
    }

    /* The shuffled order is built only for the random loop, which reads it. */
    if (write == memory_write_random) {
        ctx.order = (size_t *)lm_alloc(64, ctx.elements * sizeof(size_t));
        for (size_t i = 0; i < ctx.elements; i++) ctx.order[i] = i;
        shuffle_order(ctx.order, ctx.elements);
        if (order_is_identity(ctx.order, ctx.elements)) lm_die("the random write order was not shuffled");
    }

    if (write(&ctx) != sum_below((uint64_t)ctx.elements)) lm_die("the sum read back is wrong");

    lm_observe_u64("bytes_per_repetition", (uint64_t)ctx.elements * ELEMENT_BYTES);
    lm_observe_u64("threads_used", 1);
    lm_observe_str("order_taken", write == memory_write_random ? "random" : "sequential");
    lm_observed();

    lm_measure(write, &ctx);

    free(ctx.order);
    free(ctx.data);
    lm_finish();
    return 0;
}
