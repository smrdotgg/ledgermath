/* Makes the disk Fixture: runner/provision.py runs it at boot, before
 * run.py, for every disk the schedule's disk benchmarks read.
 *
 *     fixture PATH BYTES
 *
 * Writes BYTES (a whole number of MiB) to PATH, which must not exist, in
 * 1 MiB writes with O_DIRECT, then fdatasync()s it and fsync()s its
 * directory: every block is allocated and written on the device, and none is
 * left in the page cache. The content is the pattern of
 * benchmarks/harness/c/lm_fixture.h: the 64-bit word at byte offset o is
 * mix64(o ^ 0x8d6d2f9d5f9d1b37). Then it reads back the first, middle and last
 * MiB with O_DIRECT and checks every word, and maps the file's extents
 * (FIEMAP), failing if any is unwritten or the file has a hole; on a file
 * system that maps none (tmpfs, in the container test) it says so.
 *
 * Prints one JSON object to stdout saying what it did and how long each part
 * took, and exits 0; on any failure it says why on stderr and exits 1, and
 * removes the partial file. Built on the box by runner/box.sh:
 *
 *     cc -O2 -I benchmarks/harness/c -o fixture runner/fixture.c
 */

#define _GNU_SOURCE /* O_DIRECT */

#include "lm_fixture.h"

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <libgen.h>
#include <linux/fiemap.h>
#include <linux/fs.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <time.h>
#include <unistd.h>

#define CHUNK (1ULL << 20)

static const char *g_path;
static bool g_created;

static void fail(const char *fmt, ...) __attribute__((format(printf, 1, 2), noreturn));
static void fail(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fputs("fixture: error: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    if (g_created) unlink(g_path);
    exit(1);
}

static double now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static void fill(uint64_t *chunk, uint64_t offset) {
    for (uint64_t w = 0; w < CHUNK / 8; w++) chunk[w] = lm_fixture_word(offset + w * 8);
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: fixture PATH BYTES\n");
        return 2;
    }
    g_path = argv[1];
    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(argv[2], &end, 10);
    if (errno != 0 || end == argv[2] || *end != '\0' || argv[2][0] == '-' || parsed == 0 || parsed % CHUNK != 0) {
        fprintf(stderr, "fixture: BYTES must be a whole, non-zero number of MiB, got \"%s\"\n", argv[2]);
        return 2;
    }
    uint64_t bytes = parsed;

    uint64_t *chunk = NULL;
    if (posix_memalign((void **)&chunk, 4096, CHUNK) != 0) fail("posix_memalign");

    double started = now();
    int fd = open(g_path, O_WRONLY | O_CREAT | O_EXCL | O_DIRECT | O_CLOEXEC, 0644);
    if (fd < 0) fail("cannot create %s with O_DIRECT: %s", g_path, strerror(errno));
    g_created = true;

    double fill_seconds = 0;
    for (uint64_t offset = 0; offset < bytes; offset += CHUNK) {
        double t0 = now();
        fill(chunk, offset);
        fill_seconds += now() - t0;
        uint64_t done = 0;
        while (done < CHUNK) {
            ssize_t n = pwrite(fd, (char *)chunk + done, CHUNK - done, (off_t)(offset + done));
            if (n < 0) {
                if (errno == EINTR) continue;
                fail("pwrite at %" PRIu64 ": %s", offset + done, strerror(errno));
            }
            if (n == 0) fail("pwrite at %" PRIu64 " wrote nothing", offset + done);
            done += (uint64_t)n;
        }
    }
    double written = now();
    if (fdatasync(fd) != 0) fail("fdatasync: %s", strerror(errno));
    double synced = now();
    close(fd);
    char directory[4096];
    snprintf(directory, sizeof(directory), "%s", g_path);
    int dirfd = open(dirname(directory), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (dirfd < 0 || fsync(dirfd) != 0) fail("fsync of the directory of %s: %s", g_path, strerror(errno));
    close(dirfd);
    double durable = now();

    /* Read back the first, middle and last MiB, every word. */
    int rfd = open(g_path, O_RDONLY | O_DIRECT | O_CLOEXEC);
    if (rfd < 0) fail("cannot reopen %s with O_DIRECT: %s", g_path, strerror(errno));
    uint64_t chunks = bytes / CHUNK;
    const uint64_t checked[3] = { 0, chunks / 2, chunks - 1 };
    for (int i = 0; i < 3; i++) {
        uint64_t offset = checked[i] * CHUNK;
        ssize_t n = pread(rfd, chunk, CHUNK, (off_t)offset);
        if (n != (ssize_t)CHUNK) fail("reading back %" PRIu64 ": %s", offset, n < 0 ? strerror(errno) : "short read");
        for (uint64_t w = 0; w < CHUNK / 8; w++) {
            if (chunk[w] != lm_fixture_word(offset + w * 8)) fail("the word at byte %" PRIu64 " did not read back as written", offset + w * 8);
        }
    }
    double verified = now();

    /* Extents, by FIEMAP. */
    uint64_t extents = 0, unwritten = 0, mapped = 0;
    bool fiemap_ok = true;
    enum { BATCH = 256 };
    size_t size = sizeof(struct fiemap) + BATCH * sizeof(struct fiemap_extent);
    struct fiemap *map = calloc(1, size);
    uint64_t start = 0;
    while (map != NULL && start < bytes) {
        memset(map, 0, size);
        map->fm_start = start;
        map->fm_length = bytes - start;
        map->fm_extent_count = BATCH;
        if (ioctl(rfd, FS_IOC_FIEMAP, map) != 0) {
            if (errno != EOPNOTSUPP && errno != ENOTTY) fail("FIEMAP: %s", strerror(errno));
            fiemap_ok = false; /* tmpfs: no extents to map, and nothing unwritten */
            break;
        }
        if (map->fm_mapped_extents == 0) break;
        bool last = false;
        for (unsigned i = 0; i < map->fm_mapped_extents; i++) {
            const struct fiemap_extent *x = &map->fm_extents[i];
            extents++;
            if (x->fe_flags & FIEMAP_EXTENT_UNWRITTEN) unwritten++;
            mapped += x->fe_length;
            if (x->fe_flags & FIEMAP_EXTENT_LAST) last = true;
            start = x->fe_logical + x->fe_length;
        }
        if (last) break;
    }
    free(map);

    /* Resident pages, by mincore: O_DIRECT left none, as a rule. */
    long long resident = -1;
    void *addr = mmap(NULL, bytes, PROT_READ, MAP_SHARED, rfd, 0);
    long page = sysconf(_SC_PAGESIZE);
    if (addr != MAP_FAILED) {
        size_t pages = (size_t)(bytes / (uint64_t)page);
        unsigned char *vec = malloc(pages);
        if (vec != NULL && mincore(addr, bytes, vec) == 0) {
            resident = 0;
            for (size_t i = 0; i < pages; i++) resident += vec[i] & 1;
        }
        free(vec);
        munmap(addr, bytes);
    }
    struct stat st;
    if (fstat(rfd, &st) != 0) fail("fstat: %s", strerror(errno));
    close(rfd);

    double write_seconds = written - started;
    printf("{\"path\":\"%s\",\"bytes\":%" PRIu64 ",\"write_bytes\":%llu,\"writes\":%" PRIu64 ",\"o_direct\":true,"
           "\"pattern\":\"mix64(offset ^ 0x%016llx)\","
           "\"device\":\"%u:%u\",\"seconds_writing\":%.3f,\"seconds_filling_buffers\":%.3f,\"seconds_fdatasync\":%.3f,"
           "\"seconds_directory_fsync\":%.3f,\"seconds_reading_back\":%.3f,\"bytes_per_second_writing\":%.0f,"
           "\"fiemap\":%s,\"extents\":%" PRIu64 ",\"unwritten_extents\":%" PRIu64 ",\"mapped_bytes\":%" PRIu64 ",\"resident_pages\":%lld}\n",
           g_path, bytes, CHUNK, chunks, (unsigned long long)LM_FIXTURE_SEED, major(st.st_dev), minor(st.st_dev), write_seconds, fill_seconds,
           synced - written, durable - synced, verified - durable, (double)bytes / (synced - started), fiemap_ok ? "true" : "false",
           extents, unwritten, mapped, resident);
    if (fiemap_ok && (unwritten != 0 || mapped < bytes)) fail("FIEMAP finds %" PRIu64 " unwritten extents and %" PRIu64 " of %" PRIu64 " bytes mapped", unwritten, mapped, bytes);
    free(chunk);
    return 0;
}
