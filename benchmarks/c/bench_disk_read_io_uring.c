#include "harness.h"

#include <errno.h>
#include <fcntl.h>
#include <liburing.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define READ_BYTES          (32ULL * 1024ULL)
#define REQUESTS_PER_BATCH  64U
#define BATCH_BYTES         (READ_BYTES * REQUESTS_PER_BATCH)
#define QUICK_FILE_BYTES    (256ULL * 1024ULL * 1024ULL)
#define NORMAL_FILE_BYTES   (1024ULL * 1024ULL * 1024ULL)
#define ALLOC_ALIGNMENT     4096ULL
#define PATTERN_SEED        0x8d6d2f9d5f9d1b37ULL

_Static_assert(READ_BYTES % ALLOC_ALIGNMENT == 0, "read size must be O_DIRECT-aligned");
_Static_assert(BATCH_BYTES == 2097152ULL, "batch size must be 2 MiB");

typedef struct {
    int fd;
    struct io_uring ring;
    bool ring_initialized;
    unsigned char *buffers[REQUESTS_PER_BATCH];
    uint64_t file_bytes;
    uint64_t next_offset;
} disk_read_ctx_t;

typedef struct {
    unsigned char *buffer;
    uint64_t offset;
    size_t done;
} read_request_t;

static char *cleanup_path = NULL;
static int cleanup_fd = -1;

static uint64_t mix64(uint64_t x) {
    x ^= x >> 30;
    x *= 0xbf58476d1ce4e5b9ULL;
    x ^= x >> 27;
    x *= 0x94d049bb133111ebULL;
    x ^= x >> 31;
    return x;
}

static uint64_t pattern_for_offset(uint64_t offset) {
    return mix64(offset ^ PATTERN_SEED);
}

static void cleanup_file(void) {
    if (cleanup_fd >= 0) {
        if (close(cleanup_fd) != 0) perror("warning: close benchmark read fd");
        cleanup_fd = -1;
    }
    if (cleanup_path != NULL) {
        if (unlink(cleanup_path) != 0 && errno != ENOENT) {
            fprintf(stderr, "warning: unlink(%s) failed: %s\n", cleanup_path, strerror(errno));
        }
    }
}

static void die_msg(const char *msg) {
    fprintf(stderr, "%s\n", msg);
    exit(1);
}

static void die_uring(const char *what, int rc) {
    fprintf(stderr, "%s failed: %s\n", what, strerror(-rc));
    exit(1);
}

static void write_all(int fd, const unsigned char *buffer, size_t len) {
    size_t written = 0;
    while (written < len) {
        ssize_t n = write(fd, buffer + written, len - written);
        if (n < 0) {
            if (errno == EINTR) continue;
            die("write benchmark file");
        }
        if (n == 0) die_msg("write benchmark file returned 0 bytes");
        written += (size_t)n;
    }
}

static void fill_pattern(unsigned char *buffer, size_t len, uint64_t base_offset) {
    for (size_t offset = 0; offset < len; offset += sizeof(uint64_t)) {
        uint64_t value = pattern_for_offset(base_offset + (uint64_t)offset);
        memcpy(buffer + offset, &value, sizeof(value));
    }
}

static void create_benchmark_file(const char *path, uint64_t file_bytes) {
    int fd = open(path, O_CREAT | O_TRUNC | O_WRONLY, 0644);
    if (fd < 0) die("open benchmark file for writing");

    unsigned char *buffer = (unsigned char *)xalloc(ALLOC_ALIGNMENT, (size_t)BATCH_BYTES);
    for (uint64_t offset = 0; offset < file_bytes; offset += BATCH_BYTES) {
        fill_pattern(buffer, (size_t)BATCH_BYTES, offset);
        write_all(fd, buffer, (size_t)BATCH_BYTES);
    }
    free(buffer);

    if (fdatasync(fd) != 0) die("fdatasync benchmark file");
    if (close(fd) != 0) die("close benchmark file writer");
}

static int open_direct_read_fd(const char *path) {
    int fd = open(path, O_RDONLY | O_DIRECT);
    if (fd < 0) {
        fprintf(stderr,
                "open(%s, O_DIRECT) failed: %s\n"
                "disk_read_io_uring requires direct I/O; not falling back to buffered reads.\n",
                path, strerror(errno));
        exit(1);
    }
    return fd;
}

static void submit_pending(disk_read_ctx_t *ctx, unsigned expected) {
    unsigned submitted = 0;
    while (submitted < expected) {
        int rc = io_uring_submit(&ctx->ring);
        if (rc < 0) die_uring("io_uring_submit", rc);
        if (rc == 0) die_msg("io_uring_submit submitted 0 SQEs");
        submitted += (unsigned)rc;
    }
}

static void prepare_read(disk_read_ctx_t *ctx, read_request_t *req) {
    struct io_uring_sqe *sqe = io_uring_get_sqe(&ctx->ring);
    if (sqe == NULL) die_msg("io_uring_get_sqe returned NULL");

    size_t remaining = (size_t)READ_BYTES - req->done;
    io_uring_prep_read(sqe, ctx->fd, req->buffer + req->done,
                       (unsigned int)remaining, req->offset + req->done);
    io_uring_sqe_set_data(sqe, req);
}

__attribute__((noinline))
static uint64_t disk_read_io_uring_batch(void *arg) {
    disk_read_ctx_t *ctx = (disk_read_ctx_t *)arg;
    read_request_t reqs[REQUESTS_PER_BATCH];
    uint64_t base_offset = ctx->next_offset;
    if (base_offset + BATCH_BYTES > ctx->file_bytes) base_offset = 0;

    for (unsigned i = 0; i < REQUESTS_PER_BATCH; i++) {
        reqs[i].buffer = ctx->buffers[i];
        reqs[i].offset = base_offset + (uint64_t)i * READ_BYTES;
        reqs[i].done = 0;
        prepare_read(ctx, &reqs[i]);
    }
    submit_pending(ctx, REQUESTS_PER_BATCH);

    unsigned completed = 0;
    uint64_t checksum = 0;
    while (completed < REQUESTS_PER_BATCH) {
        struct io_uring_cqe *cqe = NULL;
        int rc = io_uring_wait_cqe(&ctx->ring, &cqe);
        if (rc < 0) die_uring("io_uring_wait_cqe", rc);

        read_request_t *req = (read_request_t *)io_uring_cqe_get_data(cqe);
        int res = cqe->res;
        io_uring_cqe_seen(&ctx->ring, cqe);

        if (req == NULL) die_msg("io_uring completion had no request data");
        if (res < 0) {
            fprintf(stderr, "io_uring read at offset %llu failed: %s\n",
                    (unsigned long long)(req->offset + req->done), strerror(-res));
            exit(1);
        }
        if (res == 0) die_msg("io_uring read returned 0 bytes before EOF wrap point");
        if ((size_t)res > (size_t)READ_BYTES - req->done) {
            die_msg("io_uring read completed more bytes than requested");
        }

        req->done += (size_t)res;
        if (req->done == READ_BYTES) {
            uint64_t first = 0;
            memcpy(&first, req->buffer, sizeof(first));
            checksum += first;
            completed++;
        } else {
            prepare_read(ctx, req);
            submit_pending(ctx, 1);
        }
    }

    ctx->next_offset = base_offset + BATCH_BYTES;
    if (ctx->next_offset >= ctx->file_bytes) ctx->next_offset = 0;
    return checksum;
}

static void validate_first_batch(disk_read_ctx_t *ctx) {
    ctx->next_offset = 0;
    volatile uint64_t checksum = disk_read_io_uring_batch(ctx);
    (void)checksum;

    for (unsigned i = 0; i < REQUESTS_PER_BATCH; i++) {
        uint64_t got = 0;
        uint64_t offset = (uint64_t)i * READ_BYTES;
        uint64_t expected = pattern_for_offset(offset);
        memcpy(&got, ctx->buffers[i], sizeof(got));
        if (got != expected) {
            fprintf(stderr,
                    "error: disk_read_io_uring validation failed at offset %llu: got %llu expected %llu\n",
                    (unsigned long long)offset,
                    (unsigned long long)got,
                    (unsigned long long)expected);
            exit(1);
        }
    }
    ctx->next_offset = 0;
}

static void cleanup_ctx(disk_read_ctx_t *ctx) {
    if (ctx->ring_initialized) {
        io_uring_queue_exit(&ctx->ring);
        ctx->ring_initialized = false;
    }
    if (ctx->fd >= 0) {
        if (close(ctx->fd) != 0) perror("warning: close benchmark read fd");
        if (cleanup_fd == ctx->fd) cleanup_fd = -1;
        ctx->fd = -1;
    }
    for (unsigned i = 0; i < REQUESTS_PER_BATCH; i++) {
        free(ctx->buffers[i]);
        ctx->buffers[i] = NULL;
    }
}

int main(int argc, char **argv) {
    bench_opts_t opts = parse_opts(argc, argv);
    uint64_t file_bytes = opts.quick ? QUICK_FILE_BYTES : NORMAL_FILE_BYTES;
    disk_read_ctx_t ctx = {.fd = -1, .file_bytes = file_bytes};

    cleanup_path = bench_file_path("disk_read_io_uring");
    atexit(cleanup_file);
    create_benchmark_file(cleanup_path, file_bytes);

    ctx.fd = open_direct_read_fd(cleanup_path);
    cleanup_fd = ctx.fd;

    int rc = io_uring_queue_init(REQUESTS_PER_BATCH, &ctx.ring, 0);
    if (rc < 0) die_uring("io_uring_queue_init", rc);
    ctx.ring_initialized = true;

    for (unsigned i = 0; i < REQUESTS_PER_BATCH; i++) {
        ctx.buffers[i] = (unsigned char *)xalloc(ALLOC_ALIGNMENT, (size_t)READ_BYTES);
    }

    validate_first_batch(&ctx);

    result_t result = measure("disk_read_io_uring", "32 KiB × 64 in flight", 1, BATCH_BYTES,
                              disk_read_io_uring_batch, &ctx,
                              opts.samples, opts.target_calibration_ns);
    print_json(&result, 1);

    cleanup_ctx(&ctx);
    cleanup_file();
    free(cleanup_path);
    cleanup_path = NULL;
    return 0;
}
