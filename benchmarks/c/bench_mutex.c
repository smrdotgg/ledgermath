#include "harness.h"

#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    pthread_mutex_t mutex;
    pthread_barrier_t start_barrier;
    pthread_t contender;
    atomic_bool stop;
    uint64_t counter;
    int contender_cpu;
} mutex_ctx_t;

static void fail_pthread(int rc, const char *what) {
    if (rc != 0) {
        fprintf(stderr, "%s: %s\n", what, strerror(rc));
        exit(1);
    }
}

static void wait_barrier(pthread_barrier_t *barrier) {
    int rc = pthread_barrier_wait(barrier);
    if (rc != 0 && rc != PTHREAD_BARRIER_SERIAL_THREAD) fail_pthread(rc, "pthread_barrier_wait");
}

__attribute__((noinline))
static uint64_t mutex_lock_unlock(void *arg) {
    mutex_ctx_t *ctx = (mutex_ctx_t *)arg;
    fail_pthread(pthread_mutex_lock(&ctx->mutex), "pthread_mutex_lock");
    uint64_t value = ++ctx->counter;
    fail_pthread(pthread_mutex_unlock(&ctx->mutex), "pthread_mutex_unlock");
    return value;
}

static void *contender_main(void *arg) {
    mutex_ctx_t *ctx = (mutex_ctx_t *)arg;
    pin_to_cpu(ctx->contender_cpu);
    wait_barrier(&ctx->start_barrier);

    while (!atomic_load_explicit(&ctx->stop, memory_order_relaxed)) {
        fail_pthread(pthread_mutex_lock(&ctx->mutex), "pthread_mutex_lock");
        ctx->counter++;
        fail_pthread(pthread_mutex_unlock(&ctx->mutex), "pthread_mutex_unlock");
    }
    return NULL;
}

static void mutex_ctx_init(mutex_ctx_t *ctx) {
    memset(ctx, 0, sizeof(*ctx));
    atomic_init(&ctx->stop, false);
    fail_pthread(pthread_mutex_init(&ctx->mutex, NULL), "pthread_mutex_init");
}

static void mutex_reset_counter(mutex_ctx_t *ctx) {
    fail_pthread(pthread_mutex_lock(&ctx->mutex), "pthread_mutex_lock");
    ctx->counter = 0;
    fail_pthread(pthread_mutex_unlock(&ctx->mutex), "pthread_mutex_unlock");
}

static void wait_for_contender(mutex_ctx_t *ctx) {
    uint64_t deadline = now_ns() + 1000000000ULL;
    for (;;) {
        fail_pthread(pthread_mutex_lock(&ctx->mutex), "pthread_mutex_lock");
        uint64_t value = ctx->counter;
        fail_pthread(pthread_mutex_unlock(&ctx->mutex), "pthread_mutex_unlock");
        if (value != 0) return;
        if (now_ns() >= deadline) {
            fprintf(stderr, "error: mutex contender did not acquire the lock\n");
            exit(1);
        }
        sched_yield();
    }
}

static void mutex_start_contender(mutex_ctx_t *ctx, int contender_cpu) {
    ctx->contender_cpu = contender_cpu;
    fail_pthread(pthread_barrier_init(&ctx->start_barrier, NULL, 2), "pthread_barrier_init");
    fail_pthread(pthread_create(&ctx->contender, NULL, contender_main, ctx), "pthread_create");
    wait_barrier(&ctx->start_barrier);
    wait_for_contender(ctx);
}

static void mutex_stop_contender(mutex_ctx_t *ctx) {
    atomic_store_explicit(&ctx->stop, true, memory_order_relaxed);
    fail_pthread(pthread_join(ctx->contender, NULL), "pthread_join");
    fail_pthread(pthread_barrier_destroy(&ctx->start_barrier), "pthread_barrier_destroy");
}

static void mutex_ctx_destroy(mutex_ctx_t *ctx) {
    fail_pthread(pthread_mutex_destroy(&ctx->mutex), "pthread_mutex_destroy");
}

int main(int argc, char **argv) {
    bench_opts_t opts = parse_opts(argc, argv);

    int cpus[CPU_SETSIZE];
    int ncpus = allowed_cpus(cpus, CPU_SETSIZE);
    if (ncpus < 2) {
        fprintf(stderr, "error: mutex benchmark needs at least 2 allowed CPUs\n");
        return 1;
    }

    pin_to_cpu(cpus[0]);

    mutex_ctx_t ctx;
    mutex_ctx_init(&ctx);

    uint64_t validation = mutex_lock_unlock(&ctx);
    if (validation != 1 || ctx.counter != 1) {
        fprintf(stderr, "error: mutex checksum validation failed\n");
        return 1;
    }
    mutex_reset_counter(&ctx);

    mutex_start_contender(&ctx, cpus[1]);
    result_t result = measure("mutex", "contended", 2, 0, mutex_lock_unlock, &ctx,
                             opts.samples, opts.target_calibration_ns);
    mutex_stop_contender(&ctx);
    mutex_ctx_destroy(&ctx);

    print_json(&result, 1);
    return 0;
}
