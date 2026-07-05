#ifndef LEDGERMATH_HARNESS_H
#define LEDGERMATH_HARNESS_H

#if !defined(__linux__) || !defined(__x86_64__)
#error "ledgermath benchmarks currently require Linux x86_64"
#endif
#ifndef __AVX2__
#error "ledgermath benchmarks must be compiled with AVX2 enabled (use -march=native on an AVX2 machine)"
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

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

/* Sizing knobs derived from --quick. */
typedef struct {
    bool quick;
    int samples;                    /* 3 quick, 10 normal */
    uint64_t target_calibration_ns; /* 100ms quick, 1s normal */
} bench_opts_t;

void die(const char *msg);
void *xalloc(size_t alignment, size_t size);
uint64_t now_ns(void);

/* sum(first..first+count-1) with u64 wraparound semantics */
uint64_t expected_sum_range(uint64_t first, uint64_t count);

/* Parse [--quick]; exits with usage message on unknown args. */
bench_opts_t parse_opts(int argc, char **argv);

/* CPUs this process may run on; returns count. */
int allowed_cpus(int *cpus, int max_cpus);
void pin_to_cpu(int cpu);

/* Heap-allocated scratch-file path for a disk benchmark:
 * $LEDGERMATH_BENCH_DIR/ledgermath-<benchmark_name>.bench, default dir /var/tmp
 * (FHS-guaranteed disk-backed; /tmp is tmpfs on some distros). Dies if the target
 * directory is on tmpfs/ramfs — a disk benchmark there would silently measure RAM.
 * Caller frees. */
char *bench_file_path(const char *benchmark_name);

/* Warmup -> calibrate iteration count to target_calibration_ns -> sample_count timed
 * samples. fn's return value is recorded as the checksum; benchmarks MUST derive it
 * from the computed data so -O3 cannot elide the work. */
result_t measure(const char *benchmark, const char *variant, int threads,
                 uint64_t bytes_per_op, bench_fn fn, void *ctx,
                 int sample_count, uint64_t target_calibration_ns);

/* The output contract: a JSON array on stdout. Diagnostics belong on stderr. */
void print_json(const result_t *results, int n);

#endif /* LEDGERMATH_HARNESS_H */
