/* memory_read_random: read one 64-byte element of a large buffer at each index
 * of a shuffled order, so every read lands on a cache line chosen at random.
 *
 * Parameters:
 *   LM_PARAM_SIZE_BYTES  bytes of the buffer read from; a multiple of 64
 *   LM_PARAM_THREADS     "1" reads on the main thread, unpinned; the only value
 *
 * Observed:
 *   bytes_per_repetition  bytes of the elements one repetition reads from, 64 per read
 *   reads_per_repetition  elements one repetition reads, each once
 *   threads_used          threads that read
 *
 * The read loop, the element layout, the shuffle and its seed are the ones the
 * July 2026 proof of concept ran, unchanged. The reads are independent of each
 * other, so the processor may have many in flight: this is the throughput of
 * random reads, not the latency of one.
 */

#if !defined(__linux__) || !defined(__x86_64__)
#error "memory_read_random requires Linux x86_64"
#endif

#include "lm.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define ELEMENT_BYTES 64ULL
#define ELEMENT_WORDS 8U
#define SHUFFLE_SEED 0x9e3779b97f4a7c15ULL

typedef struct {
    uint64_t words[ELEMENT_WORDS];
} element_t;

_Static_assert(sizeof(element_t) == ELEMENT_BYTES, "random-read elements must be 64 bytes");

typedef struct {
    const element_t *data;
    const size_t *order;
    size_t elements;
} random_read_ctx_t;

static size_t page_alignment(void) {
    long page = sysconf(_SC_PAGESIZE);
    if (page <= 0) lm_die("sysconf(_SC_PAGESIZE) failed");
    return (size_t)page;
}

static uint64_t xorshift64(uint64_t *state) {
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
        size_t j = (size_t)(xorshift64(&state) % (uint64_t)(i + 1));
        size_t tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
    }
}

static void advise_region(void *addr, size_t len, int advice, const char *name) {
    if (madvise(addr, len, advice) != 0) {
        fprintf(stderr, "warning: madvise(%s) failed: %s\n", name, strerror(errno));
    }
}

/* One repetition: one read from every element, in the shuffled order. */
__attribute__((noinline))
static uint64_t memory_read_random_run(void *arg) {
    const random_read_ctx_t *ctx = (const random_read_ctx_t *)arg;
    uint64_t sum = 0;
    for (size_t i = 0; i < ctx->elements; i++) {
        sum += ctx->data[ctx->order[i]].words[0];
    }
    return sum;
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
    if (size_bytes < 2 * ELEMENT_BYTES || size_bytes % ELEMENT_BYTES != 0) {
        lm_usage("parameter size_bytes must be a multiple of 64 of at least 128, got %llu", (unsigned long long)size_bytes);
    }
    if (strcmp(threads, "1") != 0) lm_usage("parameter threads must be \"1\", the only value implemented, got \"%s\"", threads);

    size_t elements = (size_t)(size_bytes / ELEMENT_BYTES);
    size_t order_bytes = elements * sizeof(size_t);
    size_t alignment = page_alignment();

    element_t *data = (element_t *)lm_alloc(alignment, (size_t)size_bytes);
    size_t *order = (size_t *)lm_alloc(alignment, order_bytes);
    for (size_t i = 0; i < elements; i++) {
        for (size_t w = 0; w < ELEMENT_WORDS; w++) data[i].words[w] = (uint64_t)(i + w);
        order[i] = i;
    }
    shuffle_order(order, elements);

    advise_region(data, (size_t)size_bytes, MADV_RANDOM, "data");
    advise_region(order, order_bytes, MADV_SEQUENTIAL, "order");

    random_read_ctx_t ctx = { data, order, elements };
    if (memory_read_random_run(&ctx) != sum_below((uint64_t)elements)) lm_die("the sum read back is wrong");

    lm_observe_u64("bytes_per_repetition", (uint64_t)elements * ELEMENT_BYTES);
    lm_observe_u64("reads_per_repetition", (uint64_t)elements);
    lm_observe_u64("threads_used", 1);
    lm_observed();

    lm_measure(memory_read_random_run, &ctx);

    free(order);
    free(data);
    lm_finish();
    return 0;
}
