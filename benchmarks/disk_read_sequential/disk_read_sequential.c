/* disk_read_sequential: cold buffered reads, front to back, with the kernel's
 * stock readahead, from the Fixture the box made at boot.
 *
 * Parameters:
 *   LM_PARAM_DISK              root_volume or instance_store: the Series' name for the
 *                              disk. Never read here; the binary reports what it found
 *   LM_PARAM_DIR               the directory holding the Fixture (ledgermath-fixture-v1)
 *   LM_PARAM_REQUEST_BYTES     bytes per read() call
 *   LM_PARAM_BYTES_PER_SAMPLE  bytes one sample reads: one region of the span
 *   LM_PARAM_SPAN_BYTES        bytes of the Fixture the regions cover, from its start
 *
 * Samples are of fixed work (lm_measure_fixed): sample k reads region
 * k mod (span / bytes_per_sample) from its first byte to its last with
 * buffered preads of request_bytes. Before each sample, outside its interval,
 * the region is dropped from the page cache (POSIX_FADV_DONTNEED) and its
 * resident pages are counted, so every sample starts cold and says so. The
 * descriptor carries no advice of its own: readahead is whatever the kernel
 * does by default for this device. Two warmup samples come first; on EBS they
 * also drain the volume's short burst. A sample's time over its repetitions is
 * the time per read call; bytes_per_sample over the sample's time is the
 * throughput.
 *
 * Exit status 1 when the Fixture is missing or wrong, a read fails, or the
 * checksum of what was read differs from the pattern's.
 */

#if !defined(__linux__) || !defined(__x86_64__)
#error "disk_read_sequential requires Linux x86_64"
#endif

#include "lm.h"
#include "lm_disk.h"
#include "lm_event.h"
#include "lm_fixed.h"
#include "lm_fixture.h"

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define WARMUP_SAMPLES 2
#define QUICK_SPAN_BYTES (64ULL << 20)
#define QUICK_BYTES_PER_SAMPLE (8ULL << 20)
#define MAX_REQUEST_BYTES (64ULL << 20)

typedef struct {
    uint64_t offset;
    int64_t resident_before;   /* pages of the region in the page cache as the sample began; -1 unknown */
    int advice;                /* posix_fadvise's result */
} region_t;

typedef struct {
    int fd;
    uint64_t *buf;
    uint64_t request;
    uint64_t per_sample;
    uint64_t regions;
    uint64_t offset;           /* the next read's */
    uint64_t reads;
    uint64_t sum;              /* the first word of every block read */
    unsigned char *map;        /* the span, mapped only to ask mincore about it */
    unsigned char *vec;
    region_t *samples;
    unsigned nsamples;
} ctx_t;

__attribute__((noinline))
static uint64_t read_next(void *arg) {
    ctx_t *c = (ctx_t *)arg;
    ssize_t n = pread(c->fd, c->buf, c->request, (off_t)c->offset);
    if (__builtin_expect((uint64_t)n != c->request, 0)) {
        if (n < 0) lm_die("pread of %" PRIu64 " bytes at %" PRIu64 ": %s", c->request, c->offset, strerror(errno));
        lm_die("pread of %" PRIu64 " bytes at %" PRIu64 " returned %zd", c->request, c->offset, n);
    }
    c->sum += c->buf[0];
    c->offset += c->request;
    c->reads++;
    return c->sum;
}

static int64_t resident(ctx_t *c, uint64_t offset, uint64_t length) {
    if (c->map == NULL) return -1;
    long page = sysconf(_SC_PAGESIZE);
    if (mincore(c->map + offset, length, c->vec) != 0) return -1;
    int64_t n = 0;
    for (uint64_t i = 0; i < (length + (uint64_t)page - 1) / (uint64_t)page; i++) n += c->vec[i] & 1;
    return n;
}

/* Before each sample: the region is made cold, and how cold is recorded. */
static void make_cold(void *arg, unsigned sample, bool warmup) {
    (void)warmup;
    ctx_t *c = (ctx_t *)arg;
    uint64_t offset = (sample % c->regions) * c->per_sample;
    int advice = posix_fadvise(c->fd, (off_t)offset, (off_t)c->per_sample, POSIX_FADV_DONTNEED);
    if (sample < c->nsamples) {
        c->samples[sample].offset = offset;
        c->samples[sample].advice = advice;
        c->samples[sample].resident_before = resident(c, offset, c->per_sample);
    }
    c->offset = offset;
}

int main(int argc, char **argv) {
    lm_start(argc, argv);

    const char *dir = lm_param("dir", "/var/tmp/ledgermath/disk");
    uint64_t request = lm_param_u64("request_bytes", "8192");
    uint64_t per_sample = lm_param_u64("bytes_per_sample", "134217728");
    uint64_t span = lm_param_u64("span_bytes", "1073741824");
    if (request < 8 || request % 8 != 0 || request > MAX_REQUEST_BYTES) lm_usage("parameter request_bytes must be a multiple of 8 up to %llu, got %" PRIu64, MAX_REQUEST_BYTES, request);
    if (lm_quick()) {
        if (span > QUICK_SPAN_BYTES) span = QUICK_SPAN_BYTES;
        if (per_sample > QUICK_BYTES_PER_SAMPLE) per_sample = QUICK_BYTES_PER_SAMPLE;
    }
    if (per_sample < request || per_sample % request != 0) lm_usage("parameter bytes_per_sample must be a whole number of requests, got %" PRIu64, per_sample);
    if (span < per_sample || span % per_sample != 0) lm_usage("parameter span_bytes must be a whole number of samples' regions, got %" PRIu64, span);
    long page = sysconf(_SC_PAGESIZE);
    if (per_sample % (uint64_t)page != 0) lm_usage("parameter bytes_per_sample must be a whole number of %ld-byte pages", page);

    char path[4096];
    int fd = lm_fixture_open(dir, O_RDONLY | O_CLOEXEC, path, sizeof(path));
    ctx_t c = { .fd = fd, .request = request, .per_sample = per_sample, .regions = span / per_sample };
    c.buf = lm_alloc(4096, request);
    lm_fixture_check(fd, span, request, c.buf);
    c.nsamples = WARMUP_SAMPLES + lm_fixed_samples();
    c.samples = calloc(c.nsamples, sizeof(region_t));
    c.vec = malloc((size_t)(per_sample / (uint64_t)page) + 1);
    if (c.samples == NULL || c.vec == NULL) lm_die("calloc");
    void *map = mmap(NULL, span, PROT_READ, MAP_SHARED, fd, 0);
    c.map = map == MAP_FAILED ? NULL : map;
    /* The check above read through the page cache: start the whole span cold. */
    posix_fadvise(fd, 0, (off_t)span, POSIX_FADV_DONTNEED);

    lm_disk d;
    lm_disk_find(&d, fd);
    lm_event e;
    lm_observed_begin(&e, lm_now_ns());
    lm_disk_observe(&d, &e, span);
    lm_event_u64(&e, "request_bytes", request);
    lm_event_u64(&e, "bytes_per_sample", per_sample);
    lm_event_u64(&e, "span_bytes", span);
    lm_event_u64(&e, "regions", c.regions);
    lm_event_u64(&e, "bytes_per_repetition", request);
    lm_event_emit(&e);

    lm_disk_stat before, after;
    lm_disk_stat_read(&d, &before);
    lm_measure_fixed(read_next, make_cold, &c, per_sample / request, WARMUP_SAMPLES);
    lm_disk_stat_read(&d, &after);
    lm_disk_counters_emit(&d, &before, &after, "lm_measure_fixed", span);

    lm_event_begin(&e, "work", lm_now_ns());
    lm_event_u64(&e, "reads", c.reads);
    lm_event_u64(&e, "bytes_read", c.reads * request);
    lm_event_array(&e, "samples");
    for (unsigned s = 0; s < c.nsamples; s++) {
        lm_event_object(&e, NULL);
        lm_event_u64(&e, "sample", s);
        lm_event_u64(&e, "offset", c.samples[s].offset);
        lm_event_i64(&e, "fadvise_result", c.samples[s].advice);
        lm_event_i64(&e, "resident_pages_before", c.samples[s].resident_before);
        lm_event_close(&e);
    }
    lm_event_close(&e);
    lm_event_emit(&e);

    /* The elision guard: the first word of every block read, summed, equals
     * what the pattern says those blocks hold. */
    uint64_t want = 0;
    uint64_t per = per_sample / request;
    for (unsigned s = 0; s < c.nsamples; s++) {
        uint64_t offset = (s % c.regions) * per_sample;
        for (uint64_t i = 0; i < per; i++) want += lm_fixture_word(offset + i * request);
    }
    if (c.reads != (uint64_t)c.nsamples * per) lm_die("%" PRIu64 " reads were made, not %" PRIu64, c.reads, (uint64_t)c.nsamples * per);
    if (want != c.sum) lm_die("the reads returned 0x%016" PRIx64 " summed, but the Fixture's pattern at those offsets sums to 0x%016" PRIx64, c.sum, want);

    /* Leave the page cache as it was found, for whatever runs next. */
    posix_fadvise(fd, 0, (off_t)span, POSIX_FADV_DONTNEED);
    if (c.map != NULL) munmap(c.map, span);
    close(fd);
    lm_finish();
    return 0;
}
