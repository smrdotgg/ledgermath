#include "harness.h"

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define BLOCK_BYTES 8192ULL
#define BLOCK_ALIGNMENT 4096ULL
#define NORMAL_FILE_BYTES (1024ULL * 1024ULL * 1024ULL)
#define QUICK_FILE_BYTES  (256ULL * 1024ULL * 1024ULL)
#define PATTERN_SEED 0x4d595df4d0f33173ULL

typedef struct {
    int fd;
    uint8_t *buffer;
    uint64_t file_bytes;
    uint64_t offset;
    uint64_t checksum;
} disk_read_ctx_t;

static char *scratch_path;

static void cleanup_scratch(void) {
    if (scratch_path != NULL) unlink(scratch_path);
}

static uint64_t mix64(uint64_t x) {
    x ^= x >> 30;
    x *= 0xbf58476d1ce4e5b9ULL;
    x ^= x >> 27;
    x *= 0x94d049bb133111ebULL;
    x ^= x >> 31;
    return x;
}

static uint64_t block_first_word(uint64_t offset) {
    return mix64(PATTERN_SEED ^ offset);
}

static void fill_block(uint64_t *block, uint64_t offset) {
    uint64_t block_index = offset / BLOCK_BYTES;
    block[0] = block_first_word(offset);
    for (size_t i = 1; i < BLOCK_BYTES / sizeof(uint64_t); i++) {
        block[i] = mix64(PATTERN_SEED + block_index * 0x9e3779b97f4a7c15ULL + (uint64_t)i);
    }
}

static void write_all(int fd, const void *buf, size_t bytes, const char *path) {
    const uint8_t *p = (const uint8_t *)buf;
    size_t written = 0;
    while (written < bytes) {
        ssize_t n = write(fd, p + written, bytes - written);
        if (n < 0) {
            if (errno == EINTR) continue;
            fprintf(stderr, "error: write(%s) failed: %s\n", path, strerror(errno));
            exit(1);
        }
        if (n == 0) {
            fprintf(stderr, "error: write(%s) made no progress\n", path);
            exit(1);
        }
        written += (size_t)n;
    }
}

static void create_scratch_file(const char *path, uint64_t file_bytes) {
    int fd = open(path, O_CREAT | O_TRUNC | O_WRONLY | O_CLOEXEC, 0600);
    if (fd < 0) {
        fprintf(stderr, "error: open(%s) for write failed: %s\n", path, strerror(errno));
        exit(1);
    }

    uint64_t *block = (uint64_t *)xalloc(BLOCK_ALIGNMENT, BLOCK_BYTES);
    for (uint64_t offset = 0; offset < file_bytes; offset += BLOCK_BYTES) {
        fill_block(block, offset);
        write_all(fd, block, BLOCK_BYTES, path);
    }
    free(block);

    if (fdatasync(fd) != 0) {
        fprintf(stderr, "error: fdatasync(%s) failed: %s\n", path, strerror(errno));
        close(fd);
        exit(1);
    }
    if (close(fd) != 0) {
        fprintf(stderr, "error: close(%s) after write failed: %s\n", path, strerror(errno));
        exit(1);
    }
}

static void read_block_full(disk_read_ctx_t *ctx, uint64_t offset) {
    size_t done = 0;
    while (done < BLOCK_BYTES) {
        ssize_t n = pread(ctx->fd, ctx->buffer + done, BLOCK_BYTES - done, (off_t)(offset + done));
        if (n < 0) {
            if (errno == EINTR) continue;
            die("pread(O_DIRECT)");
        }
        if (n == 0) {
            fprintf(stderr, "error: short pread at offset %llu\n", (unsigned long long)(offset + done));
            exit(1);
        }
        done += (size_t)n;
    }
}

__attribute__((noinline))
static uint64_t disk_read_sequential_run(void *arg) {
    disk_read_ctx_t *ctx = (disk_read_ctx_t *)arg;
    read_block_full(ctx, ctx->offset);

    uint64_t first_word;
    memcpy(&first_word, ctx->buffer, sizeof(first_word));
    ctx->checksum += first_word;

    ctx->offset += BLOCK_BYTES;
    if (ctx->offset >= ctx->file_bytes) ctx->offset = 0;
    return ctx->checksum;
}

int main(int argc, char **argv) {
    bench_opts_t opts = parse_opts(argc, argv);
    uint64_t file_bytes = opts.quick ? QUICK_FILE_BYTES : NORMAL_FILE_BYTES;

    scratch_path = bench_file_path("disk_read_sequential");
    if (atexit(cleanup_scratch) != 0) die("atexit");
    create_scratch_file(scratch_path, file_bytes);

    int fd = open(scratch_path, O_RDONLY | O_DIRECT | O_CLOEXEC);
    if (fd < 0) {
        fprintf(stderr, "error: open(%s, O_DIRECT) failed: %s\n", scratch_path, strerror(errno));
        return 1;
    }

    disk_read_ctx_t ctx = {0};
    ctx.fd = fd;
    ctx.buffer = (uint8_t *)xalloc(BLOCK_ALIGNMENT, BLOCK_BYTES);
    ctx.file_bytes = file_bytes;

    read_block_full(&ctx, 0);
    uint64_t first_word;
    memcpy(&first_word, ctx.buffer, sizeof(first_word));
    if (first_word != block_first_word(0)) {
        fprintf(stderr, "error: disk_read_sequential startup validation failed\n");
        close(fd);
        free(ctx.buffer);
        return 1;
    }

    result_t result = measure("disk_read_sequential", "8 KiB", 1, BLOCK_BYTES,
                              disk_read_sequential_run, &ctx, opts.samples,
                              opts.target_calibration_ns);
    print_json(&result, 1);

    if (close(fd) != 0) die("close(O_DIRECT fd)");
    free(ctx.buffer);
    return 0;
}
