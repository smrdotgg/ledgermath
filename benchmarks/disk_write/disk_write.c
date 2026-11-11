/* disk_write: buffered writes at consecutive offsets of a scratch file of the
 * binary's own, each followed by fdatasync() or by nothing.
 *
 * Parameters:
 *   LM_PARAM_DISK           root_volume or instance_store: the Series' name for the
 *                           disk. Never read here; the binary reports what it found
 *   LM_PARAM_DIR            the directory the scratch file is made in
 *   LM_PARAM_REQUEST_BYTES  bytes per write; a multiple of 8
 *   LM_PARAM_SYNC           none: pwrite alone, which the page cache absorbs;
 *                           fdatasync: pwrite, then fdatasync, which returns once the
 *                           device has the data
 *   LM_PARAM_FILE_BYTES     the scratch file's size; writes wrap at its end
 *
 * The scratch file, ledgermath-disk_write.scratch in dir, is created
 * exclusively (O_CREAT | O_EXCL | O_NOFOLLOW, relative to dir): if that name
 * exists in any form, a file, a directory or a symbolic link, the binary exits
 * 1 and touches nothing. It is then written in full through the same
 * descriptor with O_DIRECT and fdatasync, so every block is allocated and
 * written (FIEMAP must find no unwritten extent) and none is in the page cache.
 * At the end it is deleted, only if the name is still the file it created. It
 * is never a Fixture. One
 * repetition is one pwrite of request_bytes at the next offset, then
 * fdatasync in the fdatasync sets. A sample's time over its repetitions is
 * the time per write. With sync none it is the page cache's number, not the
 * device's: device_counters shows how few of the writes reached the device.
 *
 * Exit status 1 when the scratch file cannot be made as described, a write or
 * fdatasync fails, or what is read back differs from what was written.
 */

#if !defined(__linux__) || !defined(__x86_64__)
#error "disk_write requires Linux x86_64"
#endif

#include "lm.h"
#include "lm_disk.h"
#include "lm_event.h"
#include "lm_fixture.h"

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define SCRATCH_NAME "ledgermath-disk_write.scratch"
#define QUICK_FILE_BYTES (16ULL << 20)
#define PREALLOCATE_CHUNK (1ULL << 20)
#define MAX_REQUEST_BYTES (64ULL << 20)
#define TAG_SEED 0x5bd1e9955bd1e995ULL

typedef struct {
    int fd;
    uint64_t *buf;
    uint64_t request;
    uint64_t file_bytes;
    bool sync;
    uint64_t offset;   /* the next write's */
    uint64_t writes;
    uint64_t syncs;
    uint64_t passes;
    uint64_t sum;      /* the tag of every write */
} ctx_t;

static char g_scratch[4096];   /* dir/SCRATCH_NAME, for messages */
static int g_dirfd = -1;        /* dir, opened once */
static int g_scratch_fd = -1;   /* the file this binary created, while it may still need removing */

/* Removes the scratch file, only if its name in dir is still the very file
 * this binary created (same device and inode, a regular file). */
static void remove_scratch(void) {
    if (g_scratch_fd < 0 || g_dirfd < 0) return;
    struct stat mine, named;
    if (fstat(g_scratch_fd, &mine) == 0 && fstatat(g_dirfd, SCRATCH_NAME, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
        S_ISREG(named.st_mode) && named.st_dev == mine.st_dev && named.st_ino == mine.st_ino) {
        if (unlinkat(g_dirfd, SCRATCH_NAME, 0) != 0) fprintf(stderr, "warning: unlink %s: %s\n", g_scratch, strerror(errno));
    } else {
        fprintf(stderr, "warning: %s is no longer the file this binary created; it is left as it is\n", g_scratch);
    }
    g_scratch_fd = -1;
}

/* Sets or clears O_DIRECT on an open descriptor. */
static void set_direct(int fd, bool on) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0) lm_die("fcntl(F_GETFL) on %s: %s", g_scratch, strerror(errno));
    flags = on ? (flags | O_DIRECT) : (flags & ~O_DIRECT);
    if (fcntl(fd, F_SETFL, flags) != 0) lm_die("fcntl(F_SETFL) %s O_DIRECT on %s: %s", on ? "setting" : "clearing", g_scratch, strerror(errno));
}

/* What the first word of a block written at `offset` holds; the rest of the
 * block is the Fixture pattern of block 0. */
static inline uint64_t tag(uint64_t offset) {
    return lm_mix64(offset ^ TAG_SEED);
}

__attribute__((noinline))
static uint64_t write_next(void *arg) {
    ctx_t *c = (ctx_t *)arg;
    uint64_t t = tag(c->offset);
    c->buf[0] = t;
    ssize_t n = pwrite(c->fd, c->buf, c->request, (off_t)c->offset);
    if (__builtin_expect((uint64_t)n != c->request, 0)) {
        if (n < 0) lm_die("pwrite of %" PRIu64 " bytes at %" PRIu64 ": %s", c->request, c->offset, strerror(errno));
        lm_die("pwrite of %" PRIu64 " bytes at %" PRIu64 " wrote %zd", c->request, c->offset, n);
    }
    if (c->sync) {
        if (__builtin_expect(fdatasync(c->fd) != 0, 0)) lm_die("fdatasync: %s", strerror(errno));
        c->syncs++;
    }
    c->sum += t;
    c->writes++;
    c->offset += c->request;
    if (c->offset == c->file_bytes) {
        c->offset = 0;
        c->passes++;
    }
    return c->sum;
}

/* Writes the whole file through `fd` with O_DIRECT, then fdatasync: every
 * block allocated and written, none of it in the page cache. The same
 * descriptor, never the name again, so it is the file that was created. */
static void preallocate(int fd, const char *path, uint64_t file_bytes) {
    set_direct(fd, true);
    uint64_t *chunk = lm_alloc(4096, PREALLOCATE_CHUNK);
    for (uint64_t offset = 0; offset < file_bytes; offset += PREALLOCATE_CHUNK) {
        uint64_t len = file_bytes - offset < PREALLOCATE_CHUNK ? file_bytes - offset : PREALLOCATE_CHUNK;
        for (uint64_t w = 0; w < len / 8; w++) chunk[w] = lm_fixture_word(offset + w * 8);
        uint64_t done = 0;
        while (done < len) {
            ssize_t n = pwrite(fd, (char *)chunk + done, len - done, (off_t)(offset + done));
            if (n < 0) {
                if (errno == EINTR) continue;
                lm_die("writing %s in full: pwrite at %" PRIu64 ": %s", path, offset + done, strerror(errno));
            }
            done += (uint64_t)n;
        }
    }
    if (fdatasync(fd) != 0) lm_die("fdatasync of %s: %s", path, strerror(errno));
    free(chunk);
    set_direct(fd, false);
}

int main(int argc, char **argv) {
    lm_start(argc, argv);

    const char *dir = lm_param("dir", "/var/tmp/ledgermath/disk");
    uint64_t request = lm_param_u64("request_bytes", "8192");
    const char *sync = lm_param("sync", "fdatasync");
    uint64_t file_bytes = lm_param_u64("file_bytes", "268435456");
    bool do_sync;
    if (strcmp(sync, "none") == 0) do_sync = false;
    else if (strcmp(sync, "fdatasync") == 0) do_sync = true;
    else lm_usage("parameter sync must be \"none\" or \"fdatasync\", got \"%s\"", sync);
    if (request < 8 || request % 8 != 0 || request > MAX_REQUEST_BYTES) lm_usage("parameter request_bytes must be a multiple of 8 up to %llu, got %" PRIu64, MAX_REQUEST_BYTES, request);
    if (lm_quick() && file_bytes > QUICK_FILE_BYTES) file_bytes = QUICK_FILE_BYTES;
    if (file_bytes < request || file_bytes % request != 0 || file_bytes % 4096 != 0) lm_usage("parameter file_bytes must be a whole number of requests and of 4096-byte blocks, got %" PRIu64, file_bytes);

    int n = snprintf(g_scratch, sizeof(g_scratch), "%s/%s", dir, SCRATCH_NAME);
    if (n < 0 || (size_t)n >= sizeof(g_scratch)) lm_usage("parameter dir is too long");
    g_dirfd = open(dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (g_dirfd < 0) lm_die("cannot open the directory %s: %s", dir, strerror(errno));
    /* Exclusively, and never through a symbolic link: an existing name of any
     * kind, a leftover scratch file included, is refused and left untouched. */
    int fd = openat(g_dirfd, SCRATCH_NAME, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) {
        int error = errno;
        if (error == EEXIST) lm_die("%s exists already (as a file, a directory or a symbolic link); this binary creates its scratch file only where nothing is, and has touched nothing", g_scratch);
        lm_die("cannot create the scratch file %s: %s", g_scratch, strerror(error));
    }
    g_scratch_fd = fd;
    atexit(remove_scratch);
    if (ftruncate(fd, (off_t)file_bytes) != 0) lm_die("ftruncate %s: %s", g_scratch, strerror(errno));
    preallocate(fd, g_scratch, file_bytes);
    lm_file_extents x = lm_file_extents_of(fd, file_bytes);
    if (x.ok && (x.unwritten_extents != 0 || x.delalloc_extents != 0 || x.mapped_bytes != file_bytes)) {
        lm_die("after writing %s in full, FIEMAP finds %" PRIu64 " unwritten and %" PRIu64 " unallocated extents, and %" PRIu64 " of %" PRIu64 " bytes mapped",
               g_scratch, x.unwritten_extents, x.delalloc_extents, x.mapped_bytes, file_bytes);
    }

    ctx_t c = { .fd = fd, .request = request, .file_bytes = file_bytes, .sync = do_sync };
    c.buf = lm_alloc(4096, request);
    for (uint64_t w = 0; w < request / 8; w++) c.buf[w] = lm_fixture_word(w * 8);

    /* One write, checked by reading it back, then made durable. */
    uint64_t *check = lm_alloc(4096, request);
    (void)write_next(&c);
    lm_pread_exact(fd, check, request, 0, "reading back the checked write");
    if (memcmp(check, c.buf, request) != 0) lm_die("the checked write at offset 0 did not read back as written");
    if (fdatasync(fd) != 0) lm_die("fdatasync: %s", strerror(errno));
    uint64_t checked_writes = c.writes;

    lm_disk d;
    lm_disk_find(&d, fd);
    lm_event e;
    lm_observed_begin(&e, lm_now_ns());
    lm_disk_observe(&d, &e, file_bytes);
    lm_event_u64(&e, "request_bytes", request);
    lm_event_str(&e, "sync_call", do_sync ? "fdatasync" : "none");
    lm_event_u64(&e, "bytes_per_repetition", request);
    lm_event_emit(&e);

    lm_disk_stat before, after;
    lm_disk_stat_read(&d, &before);
    lm_measure(write_next, &c);
    lm_disk_stat_read(&d, &after);
    lm_disk_counters_emit(&d, &before, &after, "lm_measure", file_bytes);

    lm_event_begin(&e, "work", lm_now_ns());
    lm_event_u64(&e, "writes", c.writes);
    lm_event_u64(&e, "writes_checked_before_measuring", checked_writes);
    lm_event_u64(&e, "fdatasyncs", c.syncs);
    lm_event_u64(&e, "bytes_written", c.writes * request);
    lm_event_u64(&e, "file_passes", c.passes);
    lm_event_emit(&e);

    /* The elision guard: the last block written reads back as written, and
     * the tags of every write add up to the sum the writes returned. */
    uint64_t last = c.offset == 0 ? file_bytes - request : c.offset - request;
    lm_pread_exact(fd, check, request, last, "reading back the last write");
    c.buf[0] = tag(last);
    if (memcmp(check, c.buf, request) != 0) lm_die("the last write, at offset %" PRIu64 ", did not read back as written", last);
    uint64_t want = 0;
    for (uint64_t i = 0, offset = 0; i < c.writes; i++) {
        want += tag(offset);
        offset += request;
        if (offset == file_bytes) offset = 0;
    }
    if (want != c.sum) lm_die("the writes' tags sum to 0x%016" PRIx64 ", expected 0x%016" PRIx64, c.sum, want);

    remove_scratch();
    close(fd);
    close(g_dirfd);
    lm_finish();
    return 0;
}
