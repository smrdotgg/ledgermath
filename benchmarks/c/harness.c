#include "harness.h"

#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

void die(const char *msg) {
    perror(msg);
    exit(1);
}

void *xalloc(size_t alignment, size_t size) {
    void *ptr = NULL;
    int rc = posix_memalign(&ptr, alignment, size);
    if (rc != 0) {
        fprintf(stderr, "posix_memalign(%zu) failed: %s\n", size, strerror(rc));
        exit(1);
    }
    return ptr;
}

uint64_t now_ns(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC_RAW, &ts) != 0) die("clock_gettime");
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static int cmp_double(const void *a, const void *b) {
    double da = *(const double *)a;
    double db = *(const double *)b;
    return (da > db) - (da < db);
}

uint64_t expected_sum_range(uint64_t first, uint64_t count) {
    /* sum(first..first+count-1), computed with wraparound but avoiding overflow where possible */
    uint64_t a = first;
    uint64_t b = first + count - 1;
    if (count == 0) return 0;
    if ((count & 1ULL) == 0) return (count / 2) * (a + b);
    return count * ((a + b) / 2);
}

static void usage(const char *argv0) {
    fprintf(stderr, "usage: %s [--quick]\n", argv0);
}

bench_opts_t parse_opts(int argc, char **argv) {
    bench_opts_t opts = {0};
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--quick") == 0) opts.quick = true;
        else {
            usage(argv[0]);
            exit(2);
        }
    }
    opts.samples = opts.quick ? 3 : 10;
    opts.target_calibration_ns = opts.quick ? 100000000ULL : 1000000000ULL;
    return opts;
}

int allowed_cpus(int *cpus, int max_cpus) {
    cpu_set_t set;
    if (sched_getaffinity(0, sizeof(set), &set) != 0) die("sched_getaffinity");
    int n = 0;
    for (int cpu = 0; cpu < CPU_SETSIZE && n < max_cpus; cpu++) {
        if (CPU_ISSET(cpu, &set)) cpus[n++] = cpu;
    }
    return n;
}

void pin_to_cpu(int cpu) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    if (sched_setaffinity(0, sizeof(set), &set) != 0) {
        fprintf(stderr, "warning: sched_setaffinity(cpu=%d) failed: %s\n", cpu, strerror(errno));
    }
}

result_t measure(const char *benchmark, const char *variant, int threads,
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

void print_json(const result_t *results, int n) {
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
