#include "harness.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#define NORMAL_FILE_BYTES (4ULL * 1024ULL * 1024ULL * 1024ULL)
#define QUICK_FILE_BYTES  (256ULL * 1024ULL * 1024ULL)
#define BLOCK_BYTES 8192ULL
#define ALIGNMENT 4096ULL
#define PATTERN_SEED 0x4d595df4d0f33173ULL
#define SHUFFLE_SEED 0x9e3779b97f4a7c15ULL

typedef struct {
    int fd;
    uint8_t *buf;
    const size_t *offsets;
    size_t block_count;
    size_t index;
    uint64_t checksum;
} disk_read_random_ctx_t;

static char *scratch_path;

static void cleanup_scratch(void) {
    if (scratch_path != NULL) (void)unlink(scratch_path);
}

static uint64_t mix64(uint64_t x) {
    x ^= x >> 30;
    x *= 0xbf58476d1ce4e5b9ULL;
    x ^= x >> 27;
    x *= 0x94d049bb133111ebULL;
    x ^= x >> 31;
    return x;
}

static uint64_t pattern_word(uint64_t offset, uint64_t word_index) {
    return mix64(PATTERN_SEED ^ offset ^ (word_index * 0x9e3779b97f4a7c15ULL));
}

static uint64_t xorshift64(uint64_t *state) {
    uint64_t x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    return x;
}

static void fill_block(uint8_t *buf, uint64_t offset) {
    uint64_t *words = (uint64_t *)buf;
    for (size_t i = 0; i < BLOCK_BYTES / sizeof(uint64_t); i++) {
        words[i] = pattern_word(offset, (uint64_t)i);
    }
}

static void write_all(int fd, const uint8_t *buf, size_t len) {
    size_t done = 0;
    while (done < len) {
        ssize_t n = write(fd, buf + done, len - done);
        if (n < 0) {
            if (errno == EINTR) continue;
            die("write scratch file");
        }
        if (n == 0) {
            fprintf(stderr, "error: write scratch file made no progress\n");
            exit(1);
        }
        done += (size_t)n;
    }
}

static void read_exact_at(int fd, uint8_t *buf, size_t len, size_t offset) {
    size_t done = 0;
    while (done < len) {
        ssize_t n = pread(fd, buf + done, len - done, (off_t)(offset + done));
        if (n < 0) {
            if (errno == EINTR) continue;
            die("pread O_DIRECT scratch file");
        }
        if (n == 0) {
            fprintf(stderr, "error: short read at offset %zu\n", offset + done);
            exit(1);
        }
        done += (size_t)n;
    }
}

static void create_scratch_file(const char *path, size_t file_bytes, uint8_t *buf) {
    int fd = open(path, O_CREAT | O_TRUNC | O_WRONLY, 0600);
    if (fd < 0) die("open scratch file for write");

    for (size_t offset = 0; offset < file_bytes; offset += BLOCK_BYTES) {
        fill_block(buf, (uint64_t)offset);
        write_all(fd, buf, BLOCK_BYTES);
    }

    if (fdatasync(fd) != 0) die("fdatasync scratch file");
    if (close(fd) != 0) die("close scratch file after write");
}

static int open_direct_read(const char *path) {
    int fd = open(path, O_RDONLY | O_DIRECT);
    if (fd < 0) {
        fprintf(stderr, "error: open(%s, O_DIRECT) failed: %s\n", path, strerror(errno));
        exit(1);
    }
    return fd;
}

static void init_offsets(size_t *offsets, size_t block_count) {
    for (size_t i = 0; i < block_count; i++) offsets[i] = i * BLOCK_BYTES;

    uint64_t state = SHUFFLE_SEED;
    for (size_t i = block_count - 1; i > 0; i--) {
        size_t j = (size_t)(xorshift64(&state) % (uint64_t)(i + 1));
        size_t tmp = offsets[i];
        offsets[i] = offsets[j];
        offsets[j] = tmp;
    }
}

static void validate_known_block(int fd, uint8_t *buf) {
    read_exact_at(fd, buf, BLOCK_BYTES, 0);
    uint64_t got = ((const uint64_t *)buf)[0];
    uint64_t want = pattern_word(0, 0);
    if (got != want) {
        fprintf(stderr,
                "error: disk_read_random validation failed: got %llu, want %llu\n",
                (unsigned long long)got, (unsigned long long)want);
        exit(1);
    }
}

__attribute__((noinline))
static uint64_t disk_read_random_run(void *arg) {
    disk_read_random_ctx_t *ctx = (disk_read_random_ctx_t *)arg;
    size_t offset = ctx->offsets[ctx->index];

    read_exact_at(ctx->fd, ctx->buf, BLOCK_BYTES, offset);
    ctx->checksum += ((const uint64_t *)ctx->buf)[0];

    ctx->index++;
    if (ctx->index == ctx->block_count) ctx->index = 0;
    return ctx->checksum;
}

int main(int argc, char **argv) {
    bench_opts_t opts = parse_opts(argc, argv);
    size_t file_bytes = (size_t)(opts.quick ? QUICK_FILE_BYTES : NORMAL_FILE_BYTES);
    size_t block_count = file_bytes / BLOCK_BYTES;
    size_t offsets_bytes = block_count * sizeof(size_t);

    scratch_path = bench_file_path("disk_read_random");
    if (atexit(cleanup_scratch) != 0) die("atexit cleanup_scratch");

    uint8_t *buf = (uint8_t *)xalloc(ALIGNMENT, BLOCK_BYTES);
    size_t *offsets = (size_t *)xalloc(ALIGNMENT, offsets_bytes);

    create_scratch_file(scratch_path, file_bytes, buf);
    int fd = open_direct_read(scratch_path);
    validate_known_block(fd, buf);
    init_offsets(offsets, block_count);

    disk_read_random_ctx_t ctx = { fd, buf, offsets, block_count, 0, 0 };
    result_t results[1];
    results[0] = measure("disk_read_random", "8 KiB", 1, BLOCK_BYTES,
                         disk_read_random_run, &ctx, opts.samples,
                         opts.target_calibration_ns);
    print_json(results, 1);

    if (close(fd) != 0) die("close O_DIRECT scratch file");
    free(offsets);
    free(buf);
    cleanup_scratch();
    free(scratch_path);
    scratch_path = NULL;
    return 0;
}
