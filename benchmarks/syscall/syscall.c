/* syscall: the cost of one call into the kernel, or of one call the C library
 * answers through the vDSO without entering it.
 *
 * Parameters:
 *   LM_PARAM_CALL  "getpid"        syscall(SYS_getpid), which always enters the kernel
 *                  "gettimeofday"  gettimeofday(), which the vDSO answers
 *                  "getrusage"     getrusage(RUSAGE_SELF)
 *                  "stat"          stat() of LM_PARAM_PATH
 *   LM_PARAM_PATH  the path stat() is given; read only when the call is "stat"
 *
 * Observed:
 *   call_made     the call the measured loop makes
 *   path_fs_type  for "stat" only: statfs()'s f_type for the path, in hex
 *                 (0x1021994 is tmpfs, 0x58465342 is XFS, 0xef53 is ext4)
 *
 * The four calls are the ones the July 2026 proof of concept made, unchanged,
 * one call per repetition. Each adds a field of what the call returned to a
 * running sum, so no call can be dropped.
 */

#if !defined(__linux__) || !defined(__x86_64__)
#error "syscall requires Linux x86_64"
#endif

#include "lm.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <unistd.h>

typedef struct {
    uint64_t checksum;
    const char *path;
} syscall_ctx_t;

__attribute__((noinline))
static uint64_t syscall_getpid_run(void *arg) {
    syscall_ctx_t *ctx = (syscall_ctx_t *)arg;
    long pid = syscall(SYS_getpid);
    if (pid < 0) lm_die("syscall(SYS_getpid): %s", strerror(errno));
    ctx->checksum += (uint64_t)pid;
    return ctx->checksum;
}

__attribute__((noinline))
static uint64_t syscall_gettimeofday_run(void *arg) {
    syscall_ctx_t *ctx = (syscall_ctx_t *)arg;
    struct timeval tv;
    if (gettimeofday(&tv, NULL) != 0) lm_die("gettimeofday: %s", strerror(errno));
    ctx->checksum += (uint64_t)tv.tv_sec + (uint64_t)tv.tv_usec;
    return ctx->checksum;
}

__attribute__((noinline))
static uint64_t syscall_getrusage_run(void *arg) {
    syscall_ctx_t *ctx = (syscall_ctx_t *)arg;
    struct rusage ru;
    if (getrusage(RUSAGE_SELF, &ru) != 0) lm_die("getrusage: %s", strerror(errno));
    ctx->checksum += (uint64_t)ru.ru_utime.tv_usec + (uint64_t)ru.ru_stime.tv_usec + (uint64_t)ru.ru_minflt;
    return ctx->checksum;
}

__attribute__((noinline))
static uint64_t syscall_stat_run(void *arg) {
    syscall_ctx_t *ctx = (syscall_ctx_t *)arg;
    struct stat st;
    if (stat(ctx->path, &st) != 0) lm_die("stat(%s): %s", ctx->path, strerror(errno));
    ctx->checksum += (uint64_t)st.st_ino + (uint64_t)st.st_size;
    return ctx->checksum;
}

int main(int argc, char **argv) {
    lm_start(argc, argv);

    const char *call = lm_param("call", "getpid");
    syscall_ctx_t ctx = {0};
    lm_fn run;
    if (strcmp(call, "getpid") == 0) run = syscall_getpid_run;
    else if (strcmp(call, "gettimeofday") == 0) run = syscall_gettimeofday_run;
    else if (strcmp(call, "getrusage") == 0) run = syscall_getrusage_run;
    else if (strcmp(call, "stat") == 0) run = syscall_stat_run;
    else lm_usage("parameter call must be \"getpid\", \"gettimeofday\", \"getrusage\" or \"stat\", got \"%s\"", call);

    if (run == syscall_stat_run) {
        ctx.path = lm_param("path", "/tmp");
        struct statfs fs;
        if (statfs(ctx.path, &fs) != 0) lm_die("statfs(%s): %s", ctx.path, strerror(errno));
        char fs_type[32];
        snprintf(fs_type, sizeof(fs_type), "0x%llx", (unsigned long long)(unsigned long)fs.f_type);
        /* One call before the observed event, so a path stat() refuses fails here. */
        run(&ctx);
        lm_observe_str("call_made", "stat");
        lm_observe_str("path_fs_type", fs_type);
    } else {
        run(&ctx);
        lm_observe_str("call_made", run == syscall_getpid_run       ? "getpid"
                                    : run == syscall_gettimeofday_run ? "gettimeofday"
                                                                      : "getrusage");
    }
    lm_observed();

    lm_measure(run, &ctx);

    lm_finish();
    return 0;
}
