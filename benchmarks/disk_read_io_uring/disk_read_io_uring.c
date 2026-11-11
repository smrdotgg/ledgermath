/* disk_read_io_uring: O_DIRECT reads through io_uring with a queue that stays
 * full, from the Fixture the box made at boot.
 *
 * Parameters:
 *   LM_PARAM_DISK           root_volume or instance_store: the Series' name for the
 *                           disk. Never read here; the binary reports what it found
 *   LM_PARAM_DIR            the directory holding the Fixture (ledgermath-fixture-v1)
 *   LM_PARAM_ACCESS         sequential: consecutive requests from the start of the span,
 *                           wrapping at its end; random: the requests of a seeded
 *                           permutation of the span's blocks
 *   LM_PARAM_REQUEST_BYTES  bytes per read; a multiple of 512
 *   LM_PARAM_QUEUE_DEPTH    reads kept submitted and not yet reaped; 1 to 4096
 *   LM_PARAM_SPAN_BYTES     bytes of the Fixture the reads cover, from its start
 *
 * Before measuring, queue_depth reads are submitted. One repetition reaps one
 * completion, checks that it read the whole request, and submits one read in
 * its place, so the binary has queue_depth reads submitted, or queue_depth - 1
 * between a reap and the next submission, across every sample and every
 * sample edge. How many of them the device holds at a given instant it does
 * not see: a completion waiting to be reaped is still counted as submitted.
 * A sample's time over its repetitions is the time per completion, which
 * gives IOPS and bytes per second.
 *
 * The ring is made with raw io_uring system calls: Amazon Linux 2023's
 * liburing-devel (2.6) has no static library, and a benchmark is one static
 * binary. Reads are IORING_OP_READ into buffers of the process's own, on a
 * ring made with no setup flags.
 *
 * Exit status 2 when this kernel or its sandbox refuses io_uring; 1 when the
 * Fixture is missing or wrong, a read fails or comes back short, or the checksum
 * of what was read differs from the pattern's.
 */

#if !defined(__linux__) || !defined(__x86_64__)
#error "disk_read_io_uring requires Linux x86_64"
#endif

#include "lm.h"
#include "lm_disk.h"
#include "lm_event.h"
#include "lm_fixture.h"

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/io_uring.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

#define SHUFFLE_SEED 0x9e3779b97f4a7c15ULL /* disk_read_random's */
#define QUICK_SPAN_BYTES (64ULL << 20)
#define MAX_REQUEST_BYTES (16ULL << 20)
#define MAX_QUEUE_DEPTH 4096

typedef struct {
    int ring_fd;
    unsigned sq_entries, cq_entries;
    unsigned features;
    /* submission ring */
    _Atomic unsigned *sq_tail;
    unsigned *sq_mask;
    unsigned *sq_array;
    struct io_uring_sqe *sqes;
    unsigned sq_tail_local;
    /* completion ring */
    _Atomic unsigned *cq_head;
    _Atomic unsigned *cq_tail;
    unsigned *cq_mask;
    struct io_uring_cqe *cqes;
} ring_t;

typedef struct {
    ring_t ring;
    int fd;
    bool random;
    uint64_t request;
    uint64_t blocks;
    const uint32_t *order;   /* random: the permutation */
    unsigned char *buffers;  /* queue_depth buffers of `request` bytes */
    uint64_t submitted;      /* reads submitted so far; the next one's index */
    uint64_t completed;
    unsigned pending;        /* SQEs prepared but not yet submitted */
    unsigned in_flight;
    uint64_t enters;         /* io_uring_enter calls */
    uint64_t waits;          /* of them, the ones that waited for a completion */
    uint64_t sum;            /* the first word of every block read */
} ctx_t;

static int ring_setup(unsigned entries, struct io_uring_params *p) {
    return (int)syscall(__NR_io_uring_setup, entries, p);
}

static int ring_enter(int fd, unsigned to_submit, unsigned min_complete, unsigned flags) {
    return (int)syscall(__NR_io_uring_enter, fd, to_submit, min_complete, flags, NULL, 0);
}

static void *map_ring(int fd, size_t size, off_t offset, const char *what) {
    void *p = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE, fd, offset);
    if (p == MAP_FAILED) lm_die("mmap of the io_uring %s: %s", what, strerror(errno));
    return p;
}

static void ring_init(ring_t *r, unsigned entries) {
    struct io_uring_params p;
    memset(&p, 0, sizeof(p));
    r->ring_fd = ring_setup(entries, &p);
    if (r->ring_fd < 0) {
        int error = errno;
        if (error == ENOSYS || error == EPERM) {
            fprintf(stderr, "error: io_uring is not available here: io_uring_setup: %s "
                            "(a kernel without it, kernel.io_uring_disabled, or a seccomp filter such as Docker's default)\n",
                    strerror(error));
            exit(2);
        }
        lm_die("io_uring_setup(%u): %s", entries, strerror(error));
    }
    r->sq_entries = p.sq_entries;
    r->cq_entries = p.cq_entries;
    r->features = p.features;

    size_t sq_size = p.sq_off.array + p.sq_entries * sizeof(unsigned);
    size_t cq_size = p.cq_off.cqes + p.cq_entries * sizeof(struct io_uring_cqe);
    unsigned char *sq, *cq;
    if (p.features & IORING_FEAT_SINGLE_MMAP) {
        if (cq_size > sq_size) sq_size = cq_size;
        sq = cq = map_ring(r->ring_fd, sq_size, IORING_OFF_SQ_RING, "rings");
    } else {
        sq = map_ring(r->ring_fd, sq_size, IORING_OFF_SQ_RING, "submission ring");
        cq = map_ring(r->ring_fd, cq_size, IORING_OFF_CQ_RING, "completion ring");
    }
    r->sqes = map_ring(r->ring_fd, p.sq_entries * sizeof(struct io_uring_sqe), IORING_OFF_SQES, "submission entries");
    r->sq_tail = (_Atomic unsigned *)(void *)(sq + p.sq_off.tail);
    r->sq_mask = (unsigned *)(void *)(sq + p.sq_off.ring_mask);
    r->sq_array = (unsigned *)(void *)(sq + p.sq_off.array);
    r->sq_tail_local = atomic_load_explicit(r->sq_tail, memory_order_relaxed);
    r->cq_head = (_Atomic unsigned *)(void *)(cq + p.cq_off.head);
    r->cq_tail = (_Atomic unsigned *)(void *)(cq + p.cq_off.tail);
    r->cq_mask = (unsigned *)(void *)(cq + p.cq_off.ring_mask);
    r->cqes = (struct io_uring_cqe *)(void *)(cq + p.cq_off.cqes);
}

/* The offset of the read with index `i`. */
static inline uint64_t offset_of(const ctx_t *c, uint64_t i) {
    uint64_t block = c->random ? c->order[i % c->blocks] : i % c->blocks;
    return block * c->request;
}

/* Prepares the next read into buffer `slot`; it is submitted by the next
 * io_uring_enter. */
static inline void prepare(ctx_t *c, unsigned slot) {
    ring_t *r = &c->ring;
    unsigned tail = r->sq_tail_local;
    unsigned index = tail & *r->sq_mask;
    struct io_uring_sqe *sqe = &r->sqes[index];
    memset(sqe, 0, sizeof(*sqe));
    sqe->opcode = IORING_OP_READ;
    sqe->fd = c->fd;
    sqe->addr = (uint64_t)(uintptr_t)(c->buffers + (uint64_t)slot * c->request);
    sqe->len = (uint32_t)c->request;
    sqe->off = offset_of(c, c->submitted);
    sqe->user_data = slot;
    r->sq_array[index] = index;
    r->sq_tail_local = tail + 1;
    atomic_store_explicit(r->sq_tail, tail + 1, memory_order_release);
    c->submitted++;
    c->pending++;
}

/* Submits what is pending and, when asked, waits for at least one completion. */
static inline void enter(ctx_t *c, bool wait) {
    for (;;) {
        int n = ring_enter(c->ring.ring_fd, c->pending, wait ? 1 : 0, wait ? IORING_ENTER_GETEVENTS : 0);
        c->enters++;
        if (n >= 0) {
            if ((unsigned)n != c->pending) lm_die("io_uring_enter submitted %d of %u reads", n, c->pending);
            c->in_flight += c->pending;
            c->pending = 0;
            c->waits += wait;
            return;
        }
        if (errno == EINTR) continue;
        lm_die("io_uring_enter: %s", strerror(errno));
    }
}

/* Takes one completion, waiting for it if there is none yet; returns its slot. */
static inline unsigned reap(ctx_t *c) {
    ring_t *r = &c->ring;
    unsigned head = atomic_load_explicit(r->cq_head, memory_order_relaxed);
    if (head == atomic_load_explicit(r->cq_tail, memory_order_acquire)) {
        enter(c, true);
        while (head == atomic_load_explicit(r->cq_tail, memory_order_acquire)) enter(c, true);
    } else if (c->pending) {
        enter(c, false);
    }
    const struct io_uring_cqe *cqe = &r->cqes[head & *r->cq_mask];
    unsigned slot = (unsigned)cqe->user_data;
    int res = cqe->res;
    atomic_store_explicit(r->cq_head, head + 1, memory_order_release);
    if (__builtin_expect(res < 0, 0)) lm_die("a read failed: %s", strerror(-res));
    if (__builtin_expect((uint64_t)res != c->request, 0)) lm_die("a read returned %d of %" PRIu64 " bytes", res, c->request);
    c->in_flight--;
    c->completed++;
    uint64_t first;
    memcpy(&first, c->buffers + (uint64_t)slot * c->request, sizeof(first));
    c->sum += first;
    return slot;
}

/* One repetition: one completion reaped, one read submitted in its place (by
 * the next repetition's io_uring_enter, or this one's when it must wait). */
__attribute__((noinline))
static uint64_t complete_one(void *arg) {
    ctx_t *c = (ctx_t *)arg;
    unsigned slot = reap(c);
    prepare(c, slot);
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
    const char *access = lm_param("access", "sequential");
    uint64_t request = lm_param_u64("request_bytes", "32768");
    uint64_t depth = lm_param_u64("queue_depth", "64");
    uint64_t span = lm_param_u64("span_bytes", "1073741824");
    bool random;
    if (strcmp(access, "sequential") == 0) random = false;
    else if (strcmp(access, "random") == 0) random = true;
    else lm_usage("parameter access must be \"sequential\" or \"random\", got \"%s\"", access);
    if (request < 512 || request % 512 != 0 || request > MAX_REQUEST_BYTES) lm_usage("parameter request_bytes must be a multiple of 512 from 512 to %llu, got %" PRIu64, MAX_REQUEST_BYTES, request);
    if (depth < 1 || depth > MAX_QUEUE_DEPTH) lm_usage("parameter queue_depth must be 1 to %d, got %" PRIu64, MAX_QUEUE_DEPTH, depth);
    if (lm_quick() && span > QUICK_SPAN_BYTES) span = QUICK_SPAN_BYTES;
    if (span < request * depth || span % request != 0) lm_usage("parameter span_bytes must be a whole number of requests, at least queue_depth of them, got %" PRIu64, span);
    uint64_t blocks = span / request;
    if (blocks > UINT32_MAX) lm_usage("parameter span_bytes holds more than 2^32 requests");

    char path[4096];
    int fd = lm_fixture_open(dir, O_RDONLY | O_DIRECT | O_CLOEXEC, path, sizeof(path));
    ctx_t c = { .fd = fd, .random = random, .request = request, .blocks = blocks };
    c.buffers = lm_alloc(4096, depth * request);
    lm_fixture_check(fd, span, request, c.buffers);
    if (random) c.order = permutation(blocks);
    ring_init(&c.ring, (unsigned)depth);
    if (c.ring.sq_entries < depth || c.ring.cq_entries < depth) lm_die("the ring has %u submission and %u completion entries, fewer than %" PRIu64, c.ring.sq_entries, c.ring.cq_entries, depth);

    lm_disk d;
    lm_disk_find(&d, fd);
    lm_event e;
    lm_observed_begin(&e, lm_now_ns());
    lm_disk_observe(&d, &e, span);
    lm_event_str(&e, "access", random ? "random" : "sequential");
    lm_event_u64(&e, "request_bytes", request);
    lm_event_u64(&e, "queue_depth", depth);
    lm_event_u64(&e, "span_bytes", span);
    lm_event_u64(&e, "span_blocks", blocks);
    lm_event_u64(&e, "bytes_per_repetition", request);
    lm_event_u64(&e, "ring_sq_entries", c.ring.sq_entries);
    lm_event_u64(&e, "ring_cq_entries", c.ring.cq_entries);
    char features[32];
    snprintf(features, sizeof(features), "0x%x", c.ring.features);
    lm_event_str(&e, "ring_features", features);
    lm_event_emit(&e);

    /* Fill the queue, then measure with it full. */
    for (unsigned slot = 0; slot < depth; slot++) prepare(&c, slot);
    enter(&c, false);
    uint64_t submitted_before = c.submitted, completed_before = c.completed, enters_before = c.enters, waits_before = c.waits;
    lm_disk_stat before, after;
    lm_disk_stat_read(&d, &before);
    lm_measure(complete_one, &c);
    lm_disk_stat_read(&d, &after);
    uint64_t measured_completions = c.completed - completed_before;
    uint64_t measured_enters = c.enters - enters_before, measured_waits = c.waits - waits_before;
    uint64_t in_flight_after = c.in_flight + c.pending;

    /* Drain: submit what is pending and reap every read still in flight. */
    if (c.pending) enter(&c, false);
    while (c.in_flight > 0) (void)reap(&c);

    lm_disk_counters_emit(&d, &before, &after, "lm_measure", span);
    lm_event_begin(&e, "work", lm_now_ns());
    lm_event_u64(&e, "submitted", c.submitted);
    lm_event_u64(&e, "completed", c.completed);
    lm_event_u64(&e, "submitted_before_measuring", submitted_before);
    lm_event_u64(&e, "completed_during_measuring", measured_completions);
    lm_event_u64(&e, "in_flight_after_measuring", in_flight_after);
    lm_event_u64(&e, "enters_during_measuring", measured_enters);
    lm_event_u64(&e, "waits_during_measuring", measured_waits);
    lm_event_u64(&e, "bytes_read", c.completed * request);
    lm_event_u64(&e, "span_passes", c.submitted / blocks);
    lm_event_emit(&e);

    /* The elision guard: every read submitted completed, and the first word of
     * every block read, summed, equals what the pattern says those blocks hold. */
    if (c.completed != c.submitted) lm_die("%" PRIu64 " reads were submitted but %" PRIu64 " completed", c.submitted, c.completed);
    uint64_t want = 0;
    for (uint64_t i = 0; i < c.submitted; i++) want += lm_fixture_word(offset_of(&c, i));
    if (want != c.sum) lm_die("the reads returned 0x%016" PRIx64 " summed, but the Fixture's pattern at those offsets sums to 0x%016" PRIx64, c.sum, want);

    close(c.ring.ring_fd);
    close(fd);
    lm_finish();
    return 0;
}
