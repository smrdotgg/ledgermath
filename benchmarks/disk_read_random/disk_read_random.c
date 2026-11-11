/* disk_read_random: one O_DIRECT read at a time, at the offsets of a seeded
 * permutation of the span's blocks, from the Fixture the box made at boot.
 *
 * Parameters:
 *   LM_PARAM_DISK           root_volume or instance_store: the Series' name for the
 *                           disk. Never read here; the binary reports what it found
 *   LM_PARAM_DIR            the directory holding the Fixture (ledgermath-fixture-v1)
 *   LM_PARAM_REQUEST_BYTES  bytes per read; a multiple of 512
 *   LM_PARAM_SPAN_BYTES     bytes of the Fixture the reads cover, from its start
 *
 * One repetition is one pread of request_bytes, with O_DIRECT, at the next
 * offset of the permutation; one request is outstanding at a time. A sample's
 * time over its repetitions is the mean latency of one read.
 *
 * Observed (before measuring): what lm_disk_observe() finds about the file and
 * its device, and request_bytes, queue_depth, span_bytes, span_blocks,
 * bytes_per_repetition. Events of its own, after measuring: device_counters
 * (the change in the disk's /sys/block/<disk>/stat over lm_measure) and work
 * (the reads made). Exit status 1 when the Fixture is missing or wrong, or when
 * the checksum of what was read differs from the pattern's.
 */

#if !defined(__linux__) || !defined(__x86_64__)
#error "disk_read_random requires Linux x86_64"
#endif

#include "lm.h"
#include "lm_disk.h"
#include "lm_event.h"
#include "lm_fixture.h"

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define SHUFFLE_SEED 0x9e3779b97f4a7c15ULL /* July's */
#define QUICK_SPAN_BYTES (64ULL << 20)
#define MAX_REQUEST_BYTES (64ULL << 20)

typedef struct {
    int fd;
    uint64_t *buf;
    uint64_t request;
    const uint32_t *order;
    uint64_t blocks;
    uint64_t next;   /* the next index into order */
    uint64_t passes; /* times the permutation was finished */
    uint64_t reads;
    uint64_t sum;    /* the first word of every block read */
} ctx_t;

__attribute__((noinline))
static uint64_t read_next(void *arg) {
    ctx_t *c = (ctx_t *)arg;
    uint64_t offset = (uint64_t)c->order[c->next] * c->request;
    ssize_t n = pread(c->fd, c->buf, c->request, (off_t)offset);
    if (__builtin_expect((uint64_t)n != c->request, 0)) {
        if (n < 0) lm_die("pread of %" PRIu64 " bytes at %" PRIu64 ": %s", c->request, offset, strerror(errno));
        lm_die("pread of %" PRIu64 " bytes at %" PRIu64 " returned %zd", c->request, offset, n);
    }
    c->sum += c->buf[0];
    c->reads++;
    if (++c->next == c->blocks) {
        c->next = 0;
        c->passes++;
    }
    return c->sum;
}

static uint64_t xorshift64(uint64_t *state) {
    uint64_t x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    return x;
}

/* A Fisher-Yates shuffle of 0..blocks-1 from a fixed seed. */
static uint32_t *permutation(uint64_t blocks) {
    uint32_t *order = lm_alloc(64, blocks * sizeof(uint32_t));
    for (uint64_t i = 0; i < blocks; i++) order[i] = (uint32_t)i;
    uint64_t state = SHUFFLE_SEED;
    for (uint64_t i = blocks - 1; i > 0; i--) {
        uint64_t j = xorshift64(&state) % (i + 1);
        uint32_t t = order[i];
        order[i] = order[j];
        order[j] = t;
    }
    return order;
}

int main(int argc, char **argv) {
    lm_start(argc, argv);

    const char *dir = lm_param("dir", "/var/tmp/ledgermath/disk");
    uint64_t request = lm_param_u64("request_bytes", "8192");
    uint64_t span = lm_param_u64("span_bytes", "1073741824");
    if (request < 512 || request % 512 != 0 || request > MAX_REQUEST_BYTES) lm_usage("parameter request_bytes must be a multiple of 512 from 512 to %llu, got %" PRIu64, MAX_REQUEST_BYTES, request);
    /* --quick reads a small span, so a small Fixture serves (its stream is never recorded). */
    if (lm_quick() && span > QUICK_SPAN_BYTES) span = QUICK_SPAN_BYTES;
    if (span < request || span % request != 0) lm_usage("parameter span_bytes must be a whole number of requests, got %" PRIu64, span);
    uint64_t blocks = span / request;
    if (blocks > UINT32_MAX) lm_usage("parameter span_bytes holds more than 2^32 requests");

    char path[4096];
    int fd = lm_fixture_open(dir, O_RDONLY | O_DIRECT | O_CLOEXEC, path, sizeof(path));
    uint64_t *buf = lm_alloc(4096, request);
    lm_fixture_check(fd, span, request, buf);
    uint32_t *order = permutation(blocks);

    lm_disk d;
    lm_disk_find(&d, fd);
    lm_event e;
    lm_observed_begin(&e, lm_now_ns());
    lm_disk_observe(&d, &e, span);
    lm_event_u64(&e, "request_bytes", request);
    lm_event_u64(&e, "queue_depth", 1);
    lm_event_u64(&e, "span_bytes", span);
    lm_event_u64(&e, "span_blocks", blocks);
    lm_event_u64(&e, "bytes_per_repetition", request);
    lm_event_emit(&e);

    ctx_t c = { .fd = fd, .buf = buf, .request = request, .order = order, .blocks = blocks };
    lm_disk_stat before, after;
    lm_disk_stat_read(&d, &before);
    lm_measure(read_next, &c);
    lm_disk_stat_read(&d, &after);
    lm_disk_counters_emit(&d, &before, &after, "lm_measure", span);

    lm_event_begin(&e, "work", lm_now_ns());
    lm_event_u64(&e, "reads", c.reads);
    lm_event_u64(&e, "bytes_read", c.reads * request);
    lm_event_u64(&e, "distinct_blocks", c.reads < blocks ? c.reads : blocks);
    lm_event_u64(&e, "permutation_passes", c.passes);
    lm_event_emit(&e);

    /* The elision guard: the first word of every block read, summed, equals
     * what the pattern says those blocks hold. */
    uint64_t want = 0;
    for (uint64_t i = 0; i < c.reads; i++) want += lm_fixture_word((uint64_t)order[i % blocks] * request);
    if (want != c.sum) lm_die("the reads returned 0x%016" PRIx64 " summed, but the Fixture's pattern at those offsets sums to 0x%016" PRIx64, c.sum, want);

    close(fd);
    lm_finish();
    return 0;
}
