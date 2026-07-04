#if !defined(__linux__) || !defined(__x86_64__)
#error "ledgermath-bench currently requires Linux x86_64"
#endif
#ifndef __AVX2__
#error "ledgermath-bench must be compiled with AVX2 enabled (use -march=native on an AVX2 machine)"
#endif

#include <errno.h>
#include <immintrin.h>
#include <pthread.h>
#include <sched.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define NORMAL_MEMORY_BYTES (1024ULL * 1024ULL * 1024ULL)
#define QUICK_MEMORY_BYTES  (512ULL * 1024ULL * 1024ULL)
#define NORMAL_BLOCKS 1000000ULL
#define QUICK_BLOCKS  100000ULL
#define BLOCK_LEN 256U
#define COMPRESSED_BYTES_PER_BLOCK 256U
#define DECOMPRESSED_BYTES_PER_OP (BLOCK_LEN * sizeof(uint32_t))
#define MAX_SAMPLES 10

typedef uint64_t (*bench_fn)(void *ctx);

typedef struct {
    const char *benchmark;
    const char *variant;
    const char *unit;
    double mean_ns;
    double median_ns;
    double throughput_bytes_per_second;
    uint64_t bytes_per_op;
    int threads;
    uint64_t checksum;
    int sample_count;
    double samples_ns[MAX_SAMPLES];
} result_t;

static void die(const char *msg) {
    perror(msg);
    exit(1);
}

static void *xalloc(size_t alignment, size_t size) {
    void *ptr = NULL;
    int rc = posix_memalign(&ptr, alignment, size);
    if (rc != 0) {
        fprintf(stderr, "posix_memalign(%zu) failed: %s\n", size, strerror(rc));
        exit(1);
    }
    return ptr;
}

static uint64_t now_ns(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC_RAW, &ts) != 0) die("clock_gettime");
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static int cmp_double(const void *a, const void *b) {
    double da = *(const double *)a;
    double db = *(const double *)b;
    return (da > db) - (da < db);
}

static uint64_t expected_sum_range(uint64_t first, uint64_t count) {
    /* sum(first..first+count-1), computed with wraparound but avoiding overflow where possible */
    uint64_t a = first;
    uint64_t b = first + count - 1;
    if (count == 0) return 0;
    if ((count & 1ULL) == 0) return (count / 2) * (a + b);
    return count * ((a + b) / 2);
}

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

static void pin_to_cpu(int cpu) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    if (sched_setaffinity(0, sizeof(set), &set) != 0) {
        fprintf(stderr, "warning: sched_setaffinity(cpu=%d) failed: %s\n", cpu, strerror(errno));
    }
}

static void *worker_main(void *arg) {
    worker_t *w = (worker_t *)arg;
    pin_to_cpu(w->cpu);

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

static int allowed_cpus(int *cpus, int max_cpus) {
    cpu_set_t set;
    if (sched_getaffinity(0, sizeof(set), &set) != 0) die("sched_getaffinity");
    int n = 0;
    for (int cpu = 0; cpu < CPU_SETSIZE && n < max_cpus; cpu++) {
        if (CPU_ISSET(cpu, &set)) cpus[n++] = cpu;
    }
    return n;
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

typedef struct {
    uint8_t *compressed;
    uint32_t out[BLOCK_LEN];
    uint64_t blocks;
    uint64_t index;
} compressed_ctx_t;

__attribute__((noinline))
static uint64_t decompress_one_block(compressed_ctx_t *ctx) {
    uint8_t *in = ctx->compressed + ctx->index * COMPRESSED_BYTES_PER_BLOCK;
    uint64_t checksum = 0;
    for (uint32_t i = 0; i < BLOCK_LEN; i++) {
        uint32_t v = (uint32_t)in[i];
        ctx->out[i] = v;
        checksum += v;
    }
    ctx->index++;
    if (ctx->index == ctx->blocks) ctx->index = 0;
    return checksum;
}

static uint64_t compressed_run(void *arg) {
    return decompress_one_block((compressed_ctx_t *)arg);
}

static result_t measure(const char *benchmark, const char *variant, int threads,
                        uint64_t bytes_per_op, bench_fn fn, void *ctx,
                        int sample_count, uint64_t target_calibration_ns) {
    result_t r = {0};
    r.benchmark = benchmark;
    r.variant = variant;
    r.unit = "ns/op";
    r.bytes_per_op = bytes_per_op;
    r.threads = threads;
    r.sample_count = sample_count;

    volatile uint64_t warm = fn(ctx);
    (void)warm;

    uint64_t iterations = 1;
    for (;;) {
        uint64_t checksum = 0;
        uint64_t start = now_ns();
        for (uint64_t i = 0; i < iterations; i++) checksum = fn(ctx);
        uint64_t elapsed = now_ns() - start;
        r.checksum = checksum;
        if (elapsed >= target_calibration_ns || iterations > (1ULL << 40)) break;
        iterations *= 2;
    }
    fprintf(stderr, "%s / %s: iterations_per_sample=%llu\n", benchmark, variant, (unsigned long long)iterations);

    double total = 0.0;
    for (int s = 0; s < sample_count; s++) {
        uint64_t checksum = 0;
        uint64_t start = now_ns();
        for (uint64_t i = 0; i < iterations; i++) checksum = fn(ctx);
        uint64_t elapsed = now_ns() - start;
        r.checksum = checksum;
        r.samples_ns[s] = (double)elapsed / (double)iterations;
        total += r.samples_ns[s];
    }
    r.mean_ns = total / (double)sample_count;
    double sorted[MAX_SAMPLES];
    memcpy(sorted, r.samples_ns, sizeof(double) * (size_t)sample_count);
    qsort(sorted, (size_t)sample_count, sizeof(double), cmp_double);
    if (sample_count & 1) r.median_ns = sorted[sample_count / 2];
    else r.median_ns = (sorted[sample_count / 2 - 1] + sorted[sample_count / 2]) / 2.0;
    r.throughput_bytes_per_second = ((double)bytes_per_op * 1000000000.0) / r.mean_ns;
    return r;
}

static void print_json(const result_t *results, int n) {
    printf("[\n");
    for (int i = 0; i < n; i++) {
        const result_t *r = &results[i];
        printf("  {\n");
        printf("    \"benchmark\": \"%s\",\n", r->benchmark);
        printf("    \"variant\": \"%s\",\n", r->variant);
        printf("    \"unit\": \"%s\",\n", r->unit);
        printf("    \"mean_ns\": %.3f,\n", r->mean_ns);
        printf("    \"median_ns\": %.3f,\n", r->median_ns);
        printf("    \"throughput_bytes_per_second\": %.3f,\n", r->throughput_bytes_per_second);
        printf("    \"bytes_per_op\": %llu,\n", (unsigned long long)r->bytes_per_op);
        printf("    \"threads\": %d,\n", r->threads);
        printf("    \"checksum\": %llu,\n", (unsigned long long)r->checksum);
        printf("    \"samples_ns\": [");
        for (int s = 0; s < r->sample_count; s++) {
            printf("%s%.3f", s ? ", " : "", r->samples_ns[s]);
        }
        printf("]\n");
        printf("  }%s\n", (i + 1 == n) ? "" : ",");
    }
    printf("]\n");
}

static void usage(const char *argv0) {
    fprintf(stderr, "usage: %s [--quick]\n", argv0);
}

int main(int argc, char **argv) {
    bool quick = false;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--quick") == 0) quick = true;
        else { usage(argv[0]); return 2; }
    }

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

    size_t memory_bytes = (size_t)(quick ? QUICK_MEMORY_BYTES : NORMAL_MEMORY_BYTES);
    size_t memory_len = memory_bytes / sizeof(uint64_t);
    uint64_t *data = (uint64_t *)xalloc(64, memory_bytes);
    for (size_t i = 0; i < memory_len; i++) data[i] = (uint64_t)i;
    uint64_t expected = expected_sum_range(0, (uint64_t)memory_len);
    if (memory_read_scalar(data, memory_len) != expected || memory_read_simd(data, memory_len) != expected) {
        fprintf(stderr, "error: memory_read checksum validation failed\n");
        return 1;
    }

    uint64_t blocks = quick ? QUICK_BLOCKS : NORMAL_BLOCKS;
    compressed_ctx_t comp = {0};
    comp.blocks = blocks;
    comp.compressed = (uint8_t *)xalloc(64, (size_t)blocks * COMPRESSED_BYTES_PER_BLOCK);
    for (uint64_t b = 0; b < blocks; b++) {
        uint8_t *block = comp.compressed + b * COMPRESSED_BYTES_PER_BLOCK;
        for (uint32_t i = 0; i < BLOCK_LEN; i++) block[i] = (uint8_t)i;
    }
    uint64_t comp_sum = decompress_one_block(&comp);
    if (comp_sum != 32640ULL) {
        fprintf(stderr, "error: decompression checksum validation failed\n");
        return 1;
    }
    for (uint32_t i = 0; i < BLOCK_LEN; i++) {
        if (comp.out[i] != i) {
            fprintf(stderr, "error: decompression output validation failed at %u\n", i);
            return 1;
        }
    }

    threaded_ctx_t threaded_scalar;
    threaded_ctx_t threaded_simd;
    threaded_init(&threaded_scalar, memory_len, false, cpus, ncpus);
    threaded_init(&threaded_simd, memory_len, true, cpus, ncpus);
    if (threaded_run(&threaded_scalar) != expected || threaded_run(&threaded_simd) != expected) {
        fprintf(stderr, "error: threaded memory_read checksum validation failed\n");
        return 1;
    }

    int samples = quick ? 3 : 10;
    uint64_t target_ns = quick ? 100000000ULL : 1000000000ULL;
    result_t results[5];
    int ri = 0;
    memory_ctx_t mem_scalar = { data, memory_len, false };
    memory_ctx_t mem_simd = { data, memory_len, true };

    results[ri++] = measure("memory_read", "1 thread, No SIMD", 1, (uint64_t)memory_bytes, memory_run_single, &mem_scalar, samples, target_ns);
    results[ri++] = measure("memory_read", "1 thread, SIMD", 1, (uint64_t)memory_bytes, memory_run_single, &mem_simd, samples, target_ns);

    char threaded_scalar_name[64];
    char threaded_simd_name[64];
    snprintf(threaded_scalar_name, sizeof(threaded_scalar_name), "%d threads, No SIMD", ncpus);
    snprintf(threaded_simd_name, sizeof(threaded_simd_name), "%d threads, SIMD", ncpus);
    results[ri++] = measure("memory_read", threaded_scalar_name, ncpus, (uint64_t)memory_bytes, threaded_run, &threaded_scalar, samples, target_ns);
    results[ri++] = measure("memory_read", threaded_simd_name, ncpus, (uint64_t)memory_bytes, threaded_run, &threaded_simd, samples, target_ns);
    results[ri++] = measure("compressed_memory_read", "bitpacker", 1, DECOMPRESSED_BYTES_PER_OP, compressed_run, &comp, samples, target_ns);

    print_json(results, ri);

    threaded_destroy(&threaded_scalar);
    threaded_destroy(&threaded_simd);
    free(comp.compressed);
    free(data);
    return 0;
}
