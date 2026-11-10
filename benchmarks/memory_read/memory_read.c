/* memory_read: sum a buffer of 64-bit words, front to back.
 *
 * Parameters:
 *   LM_PARAM_SIZE_BYTES  bytes read per repetition; a multiple of 8
 *   LM_PARAM_THREADS     "1" reads on the main thread, unpinned;
 *                        "all" reads on one pinned thread per allowed CPU
 *   LM_PARAM_PATH        "scalar" (an x86 assembly loop) or "avx2"
 *
 * Observed:
 *   bytes_per_repetition  bytes the read loops cover in one repetition
 *   threads_used          threads that read
 *   path_taken            the read loop that was dispatched
 *
 * The hot loops are the ones the July 2026 proof of concept ran, unchanged.
 */

#if !defined(__linux__) || !defined(__x86_64__)
#error "memory_read requires Linux x86_64"
#endif

#include "lm.h"

#include <immintrin.h>
#include <pthread.h>
#include <sched.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

typedef uint64_t (*read_fn)(const uint64_t *vec, size_t len);

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
static uint64_t memory_read_avx2(const uint64_t *vec, size_t len) {
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

/* sum(0..count-1), with 64-bit wraparound */
static uint64_t sum_below(uint64_t count) {
    if (count == 0) return 0;
    uint64_t last = count - 1;
    return (count & 1ULL) == 0 ? (count / 2) * last : count * (last / 2);
}

/* ---- one thread ---- */

typedef struct {
    const uint64_t *data;
    size_t len;
    read_fn read;
} single_t;

static uint64_t single_run(void *arg) {
    single_t *s = (single_t *)arg;
    return s->read(s->data, s->len);
}

/* ---- one pinned thread per allowed CPU ---- */

typedef struct pool pool_t;

typedef struct {
    pthread_t thread;
    pool_t *pool;
    int cpu;
    uint64_t *data;
    size_t start;
    size_t end;
    uint64_t checksum;
} worker_t;

struct pool {
    worker_t *workers;
    int nthreads;
    read_fn read;
    pthread_barrier_t ready;
    pthread_barrier_t go;
    pthread_barrier_t done;
    volatile bool stop;
};

static void *worker_main(void *arg) {
    worker_t *w = (worker_t *)arg;
    pool_t *pool = w->pool;
    lm_pin_to_cpu(w->cpu);

    /* Each pinned worker allocates and first-touches its own slice, so its
     * pages land on its own NUMA node. */
    size_t len = w->end - w->start;
    w->data = (uint64_t *)lm_alloc(64, len * sizeof(uint64_t));
    for (size_t i = 0; i < len; i++) w->data[i] = (uint64_t)(w->start + i);
    pthread_barrier_wait(&pool->ready);

    for (;;) {
        pthread_barrier_wait(&pool->go);
        if (pool->stop) break;
        w->checksum = pool->read(w->data, len);
        pthread_barrier_wait(&pool->done);
    }
    pthread_barrier_wait(&pool->done);
    free(w->data);
    w->data = NULL;
    return NULL;
}

static uint64_t pool_run(void *arg) {
    pool_t *pool = (pool_t *)arg;
    pthread_barrier_wait(&pool->go);
    pthread_barrier_wait(&pool->done);
    uint64_t sum = 0;
    for (int i = 0; i < pool->nthreads; i++) sum += pool->workers[i].checksum;
    return sum;
}

static void pool_init(pool_t *pool, size_t len, read_fn read, const int *cpus, int nthreads) {
    pool->workers = calloc((size_t)nthreads, sizeof(worker_t));
    if (!pool->workers) lm_die("calloc workers");
    pool->nthreads = nthreads;
    pool->read = read;
    pool->stop = false;
    unsigned parties = (unsigned)nthreads + 1;
    if (pthread_barrier_init(&pool->ready, NULL, parties) != 0) lm_die("pthread_barrier_init");
    if (pthread_barrier_init(&pool->go, NULL, parties) != 0) lm_die("pthread_barrier_init");
    if (pthread_barrier_init(&pool->done, NULL, parties) != 0) lm_die("pthread_barrier_init");
    size_t slice = len / (size_t)nthreads;
    for (int i = 0; i < nthreads; i++) {
        worker_t *w = &pool->workers[i];
        w->pool = pool;
        w->cpu = cpus[i];
        w->start = (size_t)i * slice;
        w->end = (i + 1 == nthreads) ? len : w->start + slice;
        if (pthread_create(&w->thread, NULL, worker_main, w) != 0) lm_die("pthread_create");
    }
    pthread_barrier_wait(&pool->ready);
}

static void pool_destroy(pool_t *pool) {
    pool->stop = true;
    pthread_barrier_wait(&pool->go);
    pthread_barrier_wait(&pool->done);
    for (int i = 0; i < pool->nthreads; i++) pthread_join(pool->workers[i].thread, NULL);
    pthread_barrier_destroy(&pool->ready);
    pthread_barrier_destroy(&pool->go);
    pthread_barrier_destroy(&pool->done);
    free(pool->workers);
}

/* ---- main ---- */

int main(int argc, char **argv) {
    lm_start(argc, argv);

    uint64_t size_bytes = lm_param_u64("size_bytes", "67108864");
    const char *threads = lm_param("threads", "1");
    const char *path = lm_param("path", "avx2");

    if (size_bytes == 0 || size_bytes % sizeof(uint64_t) != 0) {
        lm_usage("parameter size_bytes must be a positive multiple of 8, got %llu", (unsigned long long)size_bytes);
    }
    size_t len = (size_t)(size_bytes / sizeof(uint64_t));

    read_fn read;
    if (strcmp(path, "scalar") == 0) {
        read = memory_read_scalar;
    } else if (strcmp(path, "avx2") == 0) {
        __builtin_cpu_init();
        if (!__builtin_cpu_supports("avx2")) lm_die("this CPU does not support AVX2");
        read = memory_read_avx2;
    } else {
        lm_usage("parameter path must be \"scalar\" or \"avx2\", got \"%s\"", path);
    }
    const char *path_taken = read == memory_read_avx2 ? "avx2" : "scalar";
    uint64_t expected = sum_below((uint64_t)len);

    if (strcmp(threads, "1") == 0) {
        uint64_t *data = (uint64_t *)lm_alloc(64, len * sizeof(uint64_t));
        for (size_t i = 0; i < len; i++) data[i] = (uint64_t)i;
        single_t single = { data, len, read };
        if (single_run(&single) != expected) lm_die("the sum read back is wrong");

        lm_observe_u64("bytes_per_repetition", (uint64_t)len * sizeof(uint64_t));
        lm_observe_u64("threads_used", 1);
        lm_observe_str("path_taken", path_taken);
        lm_observed();

        lm_measure(single_run, &single);
        free(data);
    } else if (strcmp(threads, "all") == 0) {
        int cpus[CPU_SETSIZE];
        int ncpus = lm_allowed_cpus(cpus, CPU_SETSIZE);
        if (ncpus <= 0) lm_die("no CPU is allowed to this process");
        if ((size_t)ncpus > len) lm_usage("parameter size_bytes is too small for %d threads", ncpus);

        pool_t pool;
        pool_init(&pool, len, read, cpus, ncpus);
        if (pool_run(&pool) != expected) lm_die("the sum read back is wrong");

        uint64_t covered = 0;
        for (int i = 0; i < pool.nthreads; i++) covered += (uint64_t)(pool.workers[i].end - pool.workers[i].start);
        lm_observe_u64("bytes_per_repetition", covered * sizeof(uint64_t));
        lm_observe_u64("threads_used", (uint64_t)pool.nthreads);
        lm_observe_str("path_taken", path_taken);
        lm_observed();

        lm_measure(pool_run, &pool);
        pool_destroy(&pool);
    } else {
        lm_usage("parameter threads must be \"1\" or \"all\", got \"%s\"", threads);
    }

    lm_finish();
    return 0;
}
