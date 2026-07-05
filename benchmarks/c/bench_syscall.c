#include "harness.h"

#include <stdint.h>
#include <stdio.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <unistd.h>

#define STAT_PATH "/tmp"

typedef struct {
    uint64_t checksum;
} syscall_ctx_t;

__attribute__((noinline))
static uint64_t syscall_getpid_run(void *arg) {
    syscall_ctx_t *ctx = (syscall_ctx_t *)arg;
    long pid = syscall(SYS_getpid);
    if (pid < 0) die("syscall(SYS_getpid)");
    ctx->checksum += (uint64_t)pid;
    return ctx->checksum;
}

__attribute__((noinline))
static uint64_t syscall_gettimeofday_run(void *arg) {
    syscall_ctx_t *ctx = (syscall_ctx_t *)arg;
    struct timeval tv;
    if (gettimeofday(&tv, NULL) != 0) die("gettimeofday");
    ctx->checksum += (uint64_t)tv.tv_sec + (uint64_t)tv.tv_usec;
    return ctx->checksum;
}

__attribute__((noinline))
static uint64_t syscall_getrusage_run(void *arg) {
    syscall_ctx_t *ctx = (syscall_ctx_t *)arg;
    struct rusage ru;
    if (getrusage(RUSAGE_SELF, &ru) != 0) die("getrusage");
    ctx->checksum += (uint64_t)ru.ru_utime.tv_usec + (uint64_t)ru.ru_stime.tv_usec + (uint64_t)ru.ru_minflt;
    return ctx->checksum;
}

__attribute__((noinline))
static uint64_t syscall_stat_run(void *arg) {
    syscall_ctx_t *ctx = (syscall_ctx_t *)arg;
    struct stat st;
    if (stat(STAT_PATH, &st) != 0) die("stat(" STAT_PATH ")");
    ctx->checksum += (uint64_t)st.st_ino + (uint64_t)st.st_size;
    return ctx->checksum;
}

int main(int argc, char **argv) {
    bench_opts_t opts = parse_opts(argc, argv);

    syscall_ctx_t getpid_ctx = {0};
    syscall_ctx_t gettimeofday_ctx = {0};
    syscall_ctx_t getrusage_ctx = {0};
    syscall_ctx_t stat_ctx = {0};

    result_t results[4];
    int ri = 0;
    results[ri++] = measure("syscall", "getpid", 1, 0, syscall_getpid_run, &getpid_ctx, opts.samples, opts.target_calibration_ns);
    results[ri++] = measure("syscall", "gettimeofday", 1, 0, syscall_gettimeofday_run, &gettimeofday_ctx, opts.samples, opts.target_calibration_ns);
    results[ri++] = measure("syscall", "getrusage", 1, 0, syscall_getrusage_run, &getrusage_ctx, opts.samples, opts.target_calibration_ns);
    results[ri++] = measure("syscall", "stat", 1, 0, syscall_stat_run, &stat_ctx, opts.samples, opts.target_calibration_ns);

    print_json(results, ri);
    return 0;
}
