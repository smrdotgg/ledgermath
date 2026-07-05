#include "harness.h"

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define WRITE_BYTES       8192ULL
#define NORMAL_FILE_BYTES (1024ULL * 1024ULL * 1024ULL)
#define QUICK_FILE_BYTES  (256ULL * 1024ULL * 1024ULL)
#define SETUP_CHUNK_BYTES (1024ULL * 1024ULL)

typedef struct {
    int fd;
    const uint8_t *buf;
    uint64_t file_bytes;
    uint64_t offset;
    uint64_t checksum;
    uint64_t first_word;
    bool sync_data;
} disk_write_ctx_t;

static char *cleanup_path;
static int cleanup_fd = -1;

static void fail_msg(const char *msg) {
    fprintf(stderr, "error: %s\n", msg);
    exit(1);
}

static int cleanup_file_checked(void) {
    int rc = 0;
    if (cleanup_fd >= 0) {
        if (close(cleanup_fd) != 0) {
            fprintf(stderr, "warning: close(%s) failed: %s\n",
                    cleanup_path ? cleanup_path : "disk_write", strerror(errno));
            rc = -1;
        }
        cleanup_fd = -1;
    }
    if (cleanup_path != NULL) {
        if (unlink(cleanup_path) != 0 && errno != ENOENT) {
            fprintf(stderr, "warning: unlink(%s) failed: %s\n", cleanup_path, strerror(errno));
            rc = -1;
        }
        free(cleanup_path);
        cleanup_path = NULL;
    }
    return rc;
}

static void cleanup_file(void) {
    (void)cleanup_file_checked();
}

static uint64_t splitmix64(uint64_t *state) {
    uint64_t z = (*state += 0x9e3779b97f4a7c15ULL);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    return z ^ (z >> 31);
}

static void fill_pattern(uint8_t *buf) {
    uint64_t state = 0x4d595df4d0f33173ULL;
    for (size_t i = 0; i < WRITE_BYTES; i += sizeof(uint64_t)) {
        uint64_t word = splitmix64(&state);
        memcpy(buf + i, &word, sizeof(word));
    }
}

static void pwrite_all(int fd, const void *buf, size_t len, uint64_t offset) {
    size_t done = 0;
    const uint8_t *bytes = (const uint8_t *)buf;
    while (done < len) {
        ssize_t n = pwrite(fd, bytes + done, len - done, (off_t)(offset + done));
        if (n < 0) {
            if (errno == EINTR) continue;
            die("pwrite");
        }
        if (n == 0) fail_msg("pwrite returned 0");
        done += (size_t)n;
    }
}

static void pread_exact(int fd, void *buf, size_t len, uint64_t offset) {
    size_t done = 0;
    uint8_t *bytes = (uint8_t *)buf;
    while (done < len) {
        ssize_t n = pread(fd, bytes + done, len - done, (off_t)(offset + done));
        if (n < 0) {
            if (errno == EINTR) continue;
            die("pread");
        }
        if (n == 0) fail_msg("pread reached EOF before validation buffer was read");
        done += (size_t)n;
    }
}

static void preallocate_file(int fd, uint64_t file_bytes) {
    if (ftruncate(fd, (off_t)file_bytes) != 0) die("ftruncate");

    uint8_t *zeros = (uint8_t *)xalloc(4096, SETUP_CHUNK_BYTES);
    memset(zeros, 0, SETUP_CHUNK_BYTES);
    for (uint64_t offset = 0; offset < file_bytes; offset += SETUP_CHUNK_BYTES) {
        uint64_t remaining = file_bytes - offset;
        size_t chunk = remaining < SETUP_CHUNK_BYTES ? (size_t)remaining : (size_t)SETUP_CHUNK_BYTES;
        pwrite_all(fd, zeros, chunk, offset);
    }
    free(zeros);

    if (fdatasync(fd) != 0) die("fdatasync preallocate");
}

__attribute__((noinline))
static uint64_t disk_write_run(void *arg) {
    disk_write_ctx_t *ctx = (disk_write_ctx_t *)arg;
    uint64_t written_offset = ctx->offset;
    pwrite_all(ctx->fd, ctx->buf, WRITE_BYTES, written_offset);
    if (ctx->sync_data && fdatasync(ctx->fd) != 0) die("fdatasync write");

    ctx->checksum += ctx->first_word + written_offset;
    ctx->offset += WRITE_BYTES;
    if (ctx->offset >= ctx->file_bytes) ctx->offset = 0;
    return ctx->checksum;
}

static void reset_ctx(disk_write_ctx_t *ctx) {
    ctx->offset = 0;
    ctx->checksum = 0;
}

static void validate_write(disk_write_ctx_t *ctx, uint8_t *read_buf) {
    reset_ctx(ctx);
    (void)disk_write_run(ctx);
    pread_exact(ctx->fd, read_buf, WRITE_BYTES, 0);
    if (memcmp(ctx->buf, read_buf, WRITE_BYTES) != 0) {
        fail_msg("disk_write validation read did not match the write buffer");
    }
    if (fdatasync(ctx->fd) != 0) die("fdatasync validation");
    reset_ctx(ctx);
}

int main(int argc, char **argv) {
    bench_opts_t opts = parse_opts(argc, argv);
    uint64_t file_bytes = opts.quick ? QUICK_FILE_BYTES : NORMAL_FILE_BYTES;

    cleanup_path = bench_file_path("disk_write");
    if (atexit(cleanup_file) != 0) fail_msg("atexit failed");
    if (unlink(cleanup_path) != 0 && errno != ENOENT) die("unlink stale disk_write file");

    int fd = open(cleanup_path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd < 0) die("open disk_write file");
    cleanup_fd = fd;

    preallocate_file(fd, file_bytes);

    uint8_t *buf = (uint8_t *)xalloc(64, WRITE_BYTES);
    uint8_t *read_buf = (uint8_t *)xalloc(64, WRITE_BYTES);
    fill_pattern(buf);

    uint64_t first_word = 0;
    memcpy(&first_word, buf, sizeof(first_word));

    disk_write_ctx_t no_fsync_ctx = {
        .fd = fd,
        .buf = buf,
        .file_bytes = file_bytes,
        .first_word = first_word,
        .sync_data = false,
    };
    disk_write_ctx_t fsync_ctx = no_fsync_ctx;
    fsync_ctx.sync_data = true;

    validate_write(&no_fsync_ctx, read_buf);

    result_t results[2];
    results[0] = measure("disk_write", "8 KiB, No fsync", 1, WRITE_BYTES,
                         disk_write_run, &no_fsync_ctx, opts.samples, opts.target_calibration_ns);

    if (fdatasync(fd) != 0) die("fdatasync before fsync variant");
    reset_ctx(&fsync_ctx);
    results[1] = measure("disk_write", "8 KiB, fsync", 1, WRITE_BYTES,
                         disk_write_run, &fsync_ctx, opts.samples, opts.target_calibration_ns);
    print_json(results, 2);

    free(read_buf);
    free(buf);
    return cleanup_file_checked() == 0 ? 0 : 1;
}
