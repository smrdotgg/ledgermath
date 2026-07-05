#include "harness.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define NORMAL_MEMORY_BYTES (1024ULL * 1024ULL * 1024ULL)
#define QUICK_MEMORY_BYTES  (512ULL * 1024ULL * 1024ULL)
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
    if (page <= 0) die("sysconf(_SC_PAGESIZE)");
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

__attribute__((noinline))
static uint64_t memory_read_random_run(void *arg) {
    const random_read_ctx_t *ctx = (const random_read_ctx_t *)arg;
    uint64_t sum = 0;
    for (size_t i = 0; i < ctx->elements; i++) {
        sum += ctx->data[ctx->order[i]].words[0];
    }
    return sum;
}

int main(int argc, char **argv) {
    bench_opts_t opts = parse_opts(argc, argv);

    size_t memory_bytes = (size_t)(opts.quick ? QUICK_MEMORY_BYTES : NORMAL_MEMORY_BYTES);
    size_t elements = memory_bytes / ELEMENT_BYTES;
    size_t order_bytes = elements * sizeof(size_t);
    size_t alignment = page_alignment();

    element_t *data = (element_t *)xalloc(alignment, memory_bytes);
    size_t *order = (size_t *)xalloc(alignment, order_bytes);

    for (size_t i = 0; i < elements; i++) {
        for (size_t w = 0; w < ELEMENT_WORDS; w++) data[i].words[w] = (uint64_t)(i + w);
        order[i] = i;
    }
    shuffle_order(order, elements);

    advise_region(data, memory_bytes, MADV_RANDOM, "data");
    advise_region(order, order_bytes, MADV_SEQUENTIAL, "order");

    random_read_ctx_t ctx = { data, order, elements };
    uint64_t expected = expected_sum_range(0, (uint64_t)elements);
    if (memory_read_random_run(&ctx) != expected) {
        fprintf(stderr, "error: memory_read_random checksum validation failed\n");
        free(order);
        free(data);
        return 1;
    }

    result_t results[1];
    results[0] = measure("memory_read_random", "1 thread", 1, (uint64_t)elements * ELEMENT_BYTES,
                         memory_read_random_run, &ctx, opts.samples, opts.target_calibration_ns);
    print_json(results, 1);

    free(order);
    free(data);
    return 0;
}
