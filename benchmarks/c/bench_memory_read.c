#include "harness.h"

#include <immintrin.h>
#include <pthread.h>
#include <sched.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define NORMAL_MEMORY_BYTES (1024ULL * 1024ULL * 1024ULL)
#define QUICK_MEMORY_BYTES  (512ULL * 1024ULL * 1024ULL)

__attribute__((noinline))
static uint64_t memory_read_scalar(const uint64_t *vec, size_t len) {
    const uint64_t *ptr = vec;
    size_t remaining = len;
    uint64_t sum;
    uint64_t tmp;
    __asm__ __volatile__(
        "xor %[sum], %[sum]\n\t"
        "test %[remaining], %[remaining]\n\t"
        "je 3f\n\t"
        "2:\n\t"
        "mov (%[ptr]), %[tmp]\n\t"
        "add %[tmp], %[sum]\n\t"
        "add $8, %[ptr]\n\t"
        "dec %[remaining]\n\t"
        "jne 2b\n\t"
        "3:"
        : [ptr] "+r" (ptr), [remaining] "+r" (remaining), [sum] "=&r" (sum), [tmp] "=&r" (tmp)
        :
        : "memory", "cc");
    return sum;
}

__attribute__((noinline, target("avx2")))
static uint64_t memory_read_simd(const uint64_t *vec, size_t len) {
    __m256i acc0 = _mm256_setzero_si256();
    __m256i acc1 = _mm256_setzero_si256();
    __m256i acc2 = _mm256_setzero_si256();
    __m256i acc3 = _mm256_setzero_si256();
    size_t i = 0;
    for (; i + 16 <= len; i += 16) {
        acc0 = _mm256_add_epi64(acc0, _mm256_loadu_si256((const __m256i *)(const void *)(vec + i)));
        acc1 = _mm256_add_epi64(acc1, _mm256_loadu_si256((const __m256i *)(const void *)(vec + i + 4)));
        acc2 = _mm256_add_epi64(acc2, _mm256_loadu_si256((const __m256i *)(const void *)(vec + i + 8)));
        acc3 = _mm256_add_epi64(acc3, _mm256_loadu_si256((const __m256i *)(const void *)(vec + i + 12)));
    }
    acc0 = _mm256_add_epi64(acc0, acc1);
    acc2 = _mm256_add_epi64(acc2, acc3);
    acc0 = _mm256_add_epi64(acc0, acc2);
    uint64_t lanes[4];
    _mm256_storeu_si256((__m256i *)(void *)lanes, acc0);
    uint64_t sum = lanes[0] + lanes[1] + lanes[2] + lanes[3];
    for (; i < len; i++) sum += vec[i];
    return sum;
}

typedef struct {
    const uint64_t *data;
    size_t len;
    bool simd;
} memory_ctx_t;

static uint64_t memory_run_single(void *arg) {
    memory_ctx_t *ctx = (memory_ctx_t *)arg;
    return ctx->simd ? memory_read_simd(ctx->data, ctx->len) : memory_read_scalar(ctx->data, ctx->len);
}

typedef struct {
    pthread_t thread;
    int cpu;
    uint64_t *data;
    size_t start;
    size_t end;
    bool simd;
    pthread_barrier_t *done_allocating_barrier;
    pthread_barrier_t *start_barrier;
    pthread_barrier_t *end_barrier;
    volatile bool *stop;
    uint64_t checksum;
} worker_t;

typedef struct {
    worker_t *workers;
    int nthreads;
    pthread_barrier_t done_allocating_barrier;
    pthread_barrier_t start_barrier;
    pthread_barrier_t end_barrier;
    volatile bool stop;
} threaded_ctx_t;

static void *worker_main(void *arg) {
    worker_t *w = (worker_t *)arg;
    pin_to_cpu(w->cpu);

    /* NUMA correctness: each pinned worker allocates and first-touches its own slice,
     * so pages land on the local node rather than all on the main thread's node. */
    size_t len = w->end - w->start;
    w->data = (uint64_t *)xalloc(64, len * sizeof(uint64_t));
    for (size_t i = 0; i < len; i++) {
        w->data[i] = (uint64_t)(w->start + i);
    }
    pthread_barrier_wait(w->done_allocating_barrier);

    for (;;) {
        pthread_barrier_wait(w->start_barrier);
        if (*w->stop) break;
        w->checksum = w->simd ? memory_read_simd(w->data, len) : memory_read_scalar(w->data, len);
        pthread_barrier_wait(w->end_barrier);
    }
    pthread_barrier_wait(w->end_barrier);
    free(w->data);
    w->data = NULL;
    return NULL;
}

static uint64_t threaded_run(void *arg) {
    threaded_ctx_t *ctx = (threaded_ctx_t *)arg;
    pthread_barrier_wait(&ctx->start_barrier);
    pthread_barrier_wait(&ctx->end_barrier);
    uint64_t sum = 0;
    for (int i = 0; i < ctx->nthreads; i++) sum += ctx->workers[i].checksum;
    return sum;
}

static void threaded_init(threaded_ctx_t *ctx, size_t len, bool simd, const int *cpus, int nthreads) {
    ctx->workers = calloc((size_t)nthreads, sizeof(worker_t));
    if (!ctx->workers) die("calloc workers");
    ctx->nthreads = nthreads;
    ctx->stop = false;
    if (pthread_barrier_init(&ctx->done_allocating_barrier, NULL, (unsigned)nthreads + 1) != 0) die("pthread_barrier_init");
    if (pthread_barrier_init(&ctx->start_barrier, NULL, (unsigned)nthreads + 1) != 0) die("pthread_barrier_init");
    if (pthread_barrier_init(&ctx->end_barrier, NULL, (unsigned)nthreads + 1) != 0) die("pthread_barrier_init");
    size_t slice = len / (size_t)nthreads;
    for (int i = 0; i < nthreads; i++) {
        worker_t *w = &ctx->workers[i];
        w->cpu = cpus[i];
        w->start = (size_t)i * slice;
        w->end = (i + 1 == nthreads) ? len : w->start + slice;
        w->simd = simd;
        w->done_allocating_barrier = &ctx->done_allocating_barrier;
        w->start_barrier = &ctx->start_barrier;
        w->end_barrier = &ctx->end_barrier;
        w->stop = &ctx->stop;
        if (pthread_create(&w->thread, NULL, worker_main, w) != 0) die("pthread_create");
    }
    pthread_barrier_wait(&ctx->done_allocating_barrier);
}

static void threaded_destroy(threaded_ctx_t *ctx) {
    ctx->stop = true;
    pthread_barrier_wait(&ctx->start_barrier);
    pthread_barrier_wait(&ctx->end_barrier);
    for (int i = 0; i < ctx->nthreads; i++) pthread_join(ctx->workers[i].thread, NULL);
    pthread_barrier_destroy(&ctx->done_allocating_barrier);
    pthread_barrier_destroy(&ctx->start_barrier);
    pthread_barrier_destroy(&ctx->end_barrier);
    free(ctx->workers);
}

int main(int argc, char **argv) {
    bench_opts_t opts = parse_opts(argc, argv);

    __builtin_cpu_init();
    if (!__builtin_cpu_supports("avx2")) {
        fprintf(stderr, "error: CPU does not support AVX2\n");
        return 1;
    }

    int cpus[CPU_SETSIZE];
    int ncpus = allowed_cpus(cpus, CPU_SETSIZE);
    long online = sysconf(_SC_NPROCESSORS_ONLN);
    if (ncpus <= 0 || online <= 0) {
        fprintf(stderr, "error: could not determine online CPUs\n");
        return 1;
    }
    if (ncpus != online) {
        fprintf(stderr, "warning: affinity allows %d CPUs, system reports %ld online CPUs\n", ncpus, online);
    }

    size_t memory_bytes = (size_t)(opts.quick ? QUICK_MEMORY_BYTES : NORMAL_MEMORY_BYTES);
    size_t memory_len = memory_bytes / sizeof(uint64_t);
    uint64_t *data = (uint64_t *)xalloc(64, memory_bytes);
    for (size_t i = 0; i < memory_len; i++) data[i] = (uint64_t)i;
    uint64_t expected = expected_sum_range(0, (uint64_t)memory_len);
    if (memory_read_scalar(data, memory_len) != expected || memory_read_simd(data, memory_len) != expected) {
        fprintf(stderr, "error: memory_read checksum validation failed\n");
        return 1;
    }

    threaded_ctx_t threaded_scalar;
    threaded_ctx_t threaded_simd;
    threaded_init(&threaded_scalar, memory_len, false, cpus, ncpus);
    threaded_init(&threaded_simd, memory_len, true, cpus, ncpus);
    if (threaded_run(&threaded_scalar) != expected || threaded_run(&threaded_simd) != expected) {
        fprintf(stderr, "error: threaded memory_read checksum validation failed\n");
        return 1;
    }

    result_t results[4];
    int ri = 0;
    memory_ctx_t mem_scalar = { data, memory_len, false };
    memory_ctx_t mem_simd = { data, memory_len, true };

    results[ri++] = measure("memory_read", "1 thread, No SIMD", 1, (uint64_t)memory_bytes, memory_run_single, &mem_scalar, opts.samples, opts.target_calibration_ns);
    results[ri++] = measure("memory_read", "1 thread, SIMD", 1, (uint64_t)memory_bytes, memory_run_single, &mem_simd, opts.samples, opts.target_calibration_ns);

    char threaded_scalar_name[64];
    char threaded_simd_name[64];
    snprintf(threaded_scalar_name, sizeof(threaded_scalar_name), "%d threads, No SIMD", ncpus);
    snprintf(threaded_simd_name, sizeof(threaded_simd_name), "%d threads, SIMD", ncpus);
    results[ri++] = measure("memory_read", threaded_scalar_name, ncpus, (uint64_t)memory_bytes, threaded_run, &threaded_scalar, opts.samples, opts.target_calibration_ns);
    results[ri++] = measure("memory_read", threaded_simd_name, ncpus, (uint64_t)memory_bytes, threaded_run, &threaded_simd, opts.samples, opts.target_calibration_ns);

    print_json(results, ri);

    threaded_destroy(&threaded_scalar);
    threaded_destroy(&threaded_simd);
    free(data);
    return 0;
}
