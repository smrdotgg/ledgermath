/* mutex: critical sections under one pthread mutex, shared by threads the
 * binary pins itself, counting the work of every thread.
 *
 * Parameters:
 *   LM_PARAM_THREADS                 threads that take the lock, the main thread included
 *   LM_PARAM_PLACEMENT               where they run: one_cpu, distinct_cores or smt_siblings
 *   LM_PARAM_CRITICAL_SECTION_LINES  64-byte lines each critical section increments, 1 to 64
 *   LM_PARAM_LOCK                    pthread_mutex_default or pthread_mutex_adaptive
 *   LM_PARAM_IDLE_THREADS            0, or 1: one more thread that blocks for the life of the
 *                                    process and never touches the lock, so the process is
 *                                    multi-threaded even with one working thread
 *
 * One repetition is exactly K = 10,000 critical sections, done by whichever
 * threads win the lock: every thread loops lock, then stop if the counter has
 * reached the repetition's target, else increment the counter and the other
 * protected lines, then unlock. A sample's time over (repetitions x K) is the
 * time per critical section across all threads. The main thread is thread 0:
 * it runs lm_measure, starts a repetition by setting the target and bumping a
 * generation word the other threads spin on, works like the others, and ends
 * the repetition when every other thread has checked in.
 *
 * Observed (before measuring):
 *   threads_used                       threads that ran the repetition loop
 *   cpus, core_ids, package_ids        each thread's CPU, read back after pinning, and its
 *                                      core and package from sysfs, in thread order
 *   lock_type                          the mutex type, read back from its attribute
 *   libc                               gnu_get_libc_version()
 *   critical_sections_per_repetition   critical sections the threads counted in one repetition
 *   protected_lines                    lines found equal to the counter after it
 *
 * Observed (just before measuring, in a second observed event):
 *   libc_single_threaded               glibc's __libc_single_threaded: while it is true,
 *                                      glibc's mutex locks and unlocks with plain stores
 *   process_threads                    the Threads: line of /proc/self/status
 *   idle_threads_sleeping              idle threads the kernel shows sleeping (state S)
 *
 * Events of its own:
 *   cpu_pair       before measuring, with two or more threads: the round trip of a
 *                  cache line between thread 0's CPU and another thread's
 *   mutex_threads  after measuring: each thread's critical sections, acquisitions,
 *                  context switches and CPU time over lm_measure, and its CPU at the end
 *
 * Exit status 2 when the placement is impossible with the CPUs this process
 * may run on, and 1 when mutual exclusion did not hold (see README.md).
 */

#if !defined(__linux__) || !defined(__x86_64__)
#error "mutex requires Linux x86_64"
#endif

#include "lm.h"
#include "lm_event.h"

#include <errno.h>
#include <gnu/libc-version.h>
#include <immintrin.h>
#include <inttypes.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/resource.h>
#include <sys/single_threaded.h>
#include <sys/syscall.h>
#include <unistd.h>

#define K 10000ULL             /* critical sections per repetition */
#define MAX_LINES 64
#define MAX_THREADS 1024
#define PAIR_BATCHES 10
#define PAIR_WARMUP 10000ULL

typedef struct {
    uint64_t value;
    char pad[56];
} __attribute__((aligned(64))) line_t;

/* The lock alone in 128 bytes (a pair of lines, which Intel's adjacent-line
 * prefetcher moves together), then the protected lines; lines[0] is the counter. */
typedef struct {
    struct {
        pthread_mutex_t mutex;
    } __attribute__((aligned(128))) lock;
    line_t lines[MAX_LINES] __attribute__((aligned(128)));
} shared_t;

enum command { CMD_RUN = 1, CMD_PAIR, CMD_BEGIN, CMD_END, CMD_EXIT };

/* Written by thread 0 before it bumps `generation`, read by the others after. */
typedef struct {
    _Atomic uint64_t generation;
    int command;
    int pair_thread;           /* CMD_PAIR: the thread that answers */
    uint64_t target;           /* CMD_RUN: the counter's value at which to stop */
    uint64_t pair_round_trips; /* CMD_PAIR: how many */
} __attribute__((aligned(128))) control_t;

typedef struct {
    _Atomic uint64_t value;
} __attribute__((aligned(128))) pair_line_t;

typedef struct ctx ctx_t;

/* One per thread, each in its own lines, written by that thread. */
typedef struct {
    _Atomic uint64_t done;     /* the generation this thread last finished; 0 once ready */
    uint64_t sections;         /* critical sections done, since the start */
    uint64_t acquisitions;     /* lock acquisitions, since the start */
    uint64_t sections_begin, acquisitions_begin;
    struct rusage usage_begin, usage_end;
    int cpu;                   /* where the placement puts it */
    int cpu_seen;              /* sched_getcpu() straight after pinning */
    int cpu_at_end;            /* sched_getcpu() after measuring */
    int index;
    ctx_t *ctx;
    pthread_t thread;
} __attribute__((aligned(128))) thread_t;

struct ctx {
    shared_t *shared;
    control_t *control;
    pair_line_t *pair;
    thread_t *threads;
    int nthreads;
    int lines;
    uint64_t generation;       /* thread 0's copy of the last generation it published */
    uint64_t base;             /* the counter at the start of the next repetition */
    uint64_t repetitions;      /* every repetition so far, validation and warmup included */
};

/* ---- the measured work ---- */

/* Critical sections until the counter reaches `target`; returns how many this
 * thread did. Each thread also makes one acquisition that finds the target
 * reached, and does nothing under it. */
__attribute__((noinline))
static uint64_t critical_sections(shared_t *s, uint64_t target, int lines) {
    pthread_mutex_t *mutex = &s->lock.mutex;
    uint64_t mine = 0;
    for (;;) {
        int rc = pthread_mutex_lock(mutex);
        if (__builtin_expect(rc != 0, 0)) lm_die("pthread_mutex_lock: %s", strerror(rc));
        uint64_t counter = s->lines[0].value;
        if (counter >= target) {
            rc = pthread_mutex_unlock(mutex);
            if (__builtin_expect(rc != 0, 0)) lm_die("pthread_mutex_unlock: %s", strerror(rc));
            return mine;
        }
        s->lines[0].value = counter + 1;
        for (int i = 1; i < lines; i++) s->lines[i].value++;
        rc = pthread_mutex_unlock(mutex);
        if (__builtin_expect(rc != 0, 0)) lm_die("pthread_mutex_unlock: %s", strerror(rc));
        mine++;
    }
}

static void count(thread_t *t, uint64_t mine) {
    t->sections += mine;
    t->acquisitions += mine + 1;
}

/* Thread 0 publishes a command; with `target`, a repetition. */
static uint64_t publish(ctx_t *c, int command) {
    c->control->command = command;
    uint64_t generation = ++c->generation;
    atomic_store_explicit(&c->control->generation, generation, memory_order_release);
    return generation;
}

static void wait_for_others(ctx_t *c, uint64_t generation) {
    for (int i = 1; i < c->nthreads; i++) {
        while (atomic_load_explicit(&c->threads[i].done, memory_order_acquire) != generation) _mm_pause();
    }
}

/* One repetition, as lm_measure calls it: returns the counter afterwards. */
static uint64_t mutex_run(void *arg) {
    ctx_t *c = (ctx_t *)arg;
    uint64_t target = c->base + K;
    c->control->target = target;
    uint64_t generation = publish(c, CMD_RUN);
    count(&c->threads[0], critical_sections(c->shared, target, c->lines));
    wait_for_others(c, generation);
    c->base = target;
    c->repetitions++;
    return c->shared->lines[0].value;
}

/* ---- the cache line round trip between two CPUs ---- */

/* The answering side: waits for each odd value and writes the next even one. */
static void pair_answer(pair_line_t *pair, uint64_t round_trips) {
    for (uint64_t i = 0; i < round_trips; i++) {
        uint64_t odd = 2 * i + 1;
        while (atomic_load_explicit(&pair->value, memory_order_acquire) != odd) {
        }
        atomic_store_explicit(&pair->value, odd + 1, memory_order_release);
    }
}

/* Thread 0's side: one round trip writes an odd value and waits for the next
 * even one. No pause in either loop: it would add its own latency. */
static uint64_t pair_ask(pair_line_t *pair, uint64_t *value, uint64_t round_trips) {
    uint64_t v = *value;
    for (uint64_t i = 0; i < round_trips; i++) {
        atomic_store_explicit(&pair->value, v + 1, memory_order_release);
        while (atomic_load_explicit(&pair->value, memory_order_acquire) != v + 2) {
        }
        v += 2;
    }
    *value = v;
    return v;
}

static void cpu_pair(ctx_t *c, int other, uint64_t per_batch) {
    uint64_t batch_ns[PAIR_BATCHES];
    atomic_store_explicit(&c->pair->value, 0, memory_order_relaxed);
    c->control->pair_thread = other;
    c->control->pair_round_trips = PAIR_WARMUP + PAIR_BATCHES * per_batch;
    uint64_t generation = publish(c, CMD_PAIR);
    uint64_t value = 0;
    pair_ask(c->pair, &value, PAIR_WARMUP);
    for (int b = 0; b < PAIR_BATCHES; b++) {
        uint64_t t0 = lm_now_ns();
        pair_ask(c->pair, &value, per_batch);
        uint64_t t1 = lm_now_ns();
        batch_ns[b] = t1 - t0;
    }
    wait_for_others(c, generation);

    lm_event e;
    lm_event_begin(&e, "cpu_pair", lm_now_ns());
    lm_event_array(&e, "cpus");
    lm_event_u64(&e, NULL, (uint64_t)c->threads[0].cpu_seen);
    lm_event_u64(&e, NULL, (uint64_t)c->threads[other].cpu_seen);
    lm_event_close(&e);
    lm_event_u64(&e, "warmup_round_trips", PAIR_WARMUP);
    lm_event_u64(&e, "round_trips_per_batch", per_batch);
    lm_event_array(&e, "batch_ns");
    for (int b = 0; b < PAIR_BATCHES; b++) lm_event_u64(&e, NULL, batch_ns[b]);
    lm_event_close(&e);
    lm_event_emit(&e);
}

/* ---- threads ---- */

static void snapshot(thread_t *t, int command) {
    struct rusage *usage = command == CMD_BEGIN ? &t->usage_begin : &t->usage_end;
    if (getrusage(RUSAGE_THREAD, usage) != 0) lm_die("getrusage(RUSAGE_THREAD): %s", strerror(errno));
    if (command == CMD_BEGIN) {
        t->sections_begin = t->sections;
        t->acquisitions_begin = t->acquisitions;
    } else {
        t->cpu_at_end = sched_getcpu();
    }
}

/* Pins the calling thread and reads back where it is. */
static void pin(thread_t *t) {
    lm_pin_to_cpu(t->cpu);
    cpu_set_t set;
    if (sched_getaffinity(0, sizeof(set), &set) != 0) lm_die("sched_getaffinity: %s", strerror(errno));
    if (CPU_COUNT(&set) != 1 || !CPU_ISSET(t->cpu, &set)) lm_die("thread %d was pinned to CPU %d, but its affinity reads back otherwise", t->index, t->cpu);
    t->cpu_seen = sched_getcpu();
    if (t->cpu_seen != t->cpu) lm_die("thread %d was pinned to CPU %d but runs on CPU %d", t->index, t->cpu, t->cpu_seen);
}

static void *worker_main(void *arg) {
    thread_t *self = (thread_t *)arg;
    ctx_t *c = self->ctx;
    pin(self);
    atomic_store_explicit(&self->done, 0, memory_order_release);

    uint64_t seen = 0;
    for (;;) {
        uint64_t generation;
        while ((generation = atomic_load_explicit(&c->control->generation, memory_order_acquire)) == seen) _mm_pause();
        seen = generation;
        int command = c->control->command;
        switch (command) {
        case CMD_RUN:
            count(self, critical_sections(c->shared, c->control->target, c->lines));
            break;
        case CMD_PAIR:
            if (c->control->pair_thread == self->index) pair_answer(c->pair, c->control->pair_round_trips);
            break;
        case CMD_BEGIN:
        case CMD_END:
            snapshot(self, command);
            break;
        case CMD_EXIT:
            atomic_store_explicit(&self->done, generation, memory_order_release);
            return NULL;
        default:
            lm_die("worker %d: unknown command %d", self->index, command);
        }
        atomic_store_explicit(&self->done, generation, memory_order_release);
    }
}

/* ---- the idle thread ---- */

/* Its kernel thread id, written once it is about to block. */
static _Atomic pid_t g_idle_tid;

/* Blocks for the life of the process with every signal blocked, so pause()
 * never returns: it does no work, never spins, never touches the lock. Its
 * existence alone makes the process multi-threaded, so glibc's mutex takes
 * its atomic path for the working threads. */
static void *idle_main(void *arg) {
    (void)arg;
    sigset_t all;
    sigfillset(&all);
    pthread_sigmask(SIG_BLOCK, &all, NULL);
    atomic_store(&g_idle_tid, (pid_t)syscall(SYS_gettid));
    for (;;) pause();
    return NULL;
}

/* The state letter of one of this process's threads in /proc, or 0 if it cannot be read. */
static char thread_state(pid_t tid) {
    char path[64];
    char text[512];
    snprintf(path, sizeof(path), "/proc/self/task/%d/stat", (int)tid);
    FILE *f = fopen(path, "r");
    if (f == NULL) return 0;
    size_t n = fread(text, 1, sizeof(text) - 1, f);
    fclose(f);
    text[n] = '\0';
    const char *close_paren = strrchr(text, ')'); /* the name may hold spaces and parentheses */
    return close_paren != NULL && close_paren[1] == ' ' ? close_paren[2] : 0;
}

/* Starts the idle thread and waits, up to five seconds, until the kernel shows it sleeping. */
static void start_idle_thread(void) {
    pthread_t thread;
    int rc = pthread_create(&thread, NULL, idle_main, NULL);
    if (rc != 0) lm_die("pthread_create (the idle thread): %s", strerror(rc));
    uint64_t deadline = lm_now_ns() + 5000000000ULL;
    for (;;) {
        pid_t tid = atomic_load(&g_idle_tid);
        if (tid != 0 && thread_state(tid) == 'S') return;
        if (lm_now_ns() > deadline) lm_die("the idle thread did not block within five seconds");
        struct timespec pause_for = { 0, 1000000 };
        nanosleep(&pause_for, NULL);
    }
}

/* The Threads: line of /proc/self/status. */
static uint64_t process_threads(void) {
    FILE *f = fopen("/proc/self/status", "r");
    if (f == NULL) lm_die("cannot read /proc/self/status: %s", strerror(errno));
    char line[256];
    unsigned long long threads = 0;
    bool found = false;
    while (fgets(line, sizeof(line), f) != NULL) {
        if (sscanf(line, "Threads: %llu", &threads) == 1) {
            found = true;
            break;
        }
    }
    fclose(f);
    if (!found) lm_die("/proc/self/status has no Threads: line");
    return threads;
}

/* Every thread takes a snapshot of its counters and CPU time. */
static void snapshot_all(ctx_t *c, int command) {
    snapshot(&c->threads[0], command);
    wait_for_others(c, publish(c, command));
}

/* ---- topology and placement ---- */

static void read_file(const char *path, char *buf, size_t size) {
    FILE *f = fopen(path, "r");
    if (f == NULL) lm_die("cannot read %s: %s", path, strerror(errno));
    if (fgets(buf, (int)size, f) == NULL) lm_die("cannot read %s: empty", path);
    fclose(f);
    buf[strcspn(buf, "\n")] = '\0';
}

static int read_int(const char *path) {
    char buf[64];
    read_file(path, buf, sizeof(buf));
    char *end = NULL;
    long value = strtol(buf, &end, 10);
    if (end == buf || *end != '\0') lm_die("%s holds \"%s\", not a number", path, buf);
    return (int)value;
}

/* A kernel CPU list such as "0-3,8,10-11". */
static void parse_cpulist(const char *path, const char *text, cpu_set_t *set) {
    CPU_ZERO(set);
    const char *p = text;
    while (*p) {
        char *end = NULL;
        long first = strtol(p, &end, 10);
        if (end == p) lm_die("%s holds \"%s\", not a CPU list", path, text);
        long last = first;
        p = end;
        if (*p == '-') {
            p++;
            last = strtol(p, &end, 10);
            if (end == p) lm_die("%s holds \"%s\", not a CPU list", path, text);
            p = end;
        }
        if (first < 0 || last < first || last >= CPU_SETSIZE) lm_die("%s holds \"%s\", not a CPU list", path, text);
        for (long cpu = first; cpu <= last; cpu++) CPU_SET((int)cpu, set);
        if (*p == ',') p++;
        else if (*p != '\0') lm_die("%s holds \"%s\", not a CPU list", path, text);
    }
}

typedef struct {
    int cpu;
    int core;        /* the lowest CPU of its core: two CPUs share a core when these are equal */
    int core_id;     /* topology/core_id */
    int package_id;  /* topology/physical_package_id */
} cpu_info_t;

static cpu_info_t cpu_info(int cpu) {
    char path[128];
    char text[1024];
    cpu_info_t info = { .cpu = cpu };
    snprintf(path, sizeof(path), "/sys/devices/system/cpu/cpu%d/topology/thread_siblings_list", cpu);
    read_file(path, text, sizeof(text));
    cpu_set_t siblings;
    parse_cpulist(path, text, &siblings);
    if (!CPU_ISSET(cpu, &siblings)) lm_die("%s does not list CPU %d itself", path, cpu);
    for (info.core = 0; !CPU_ISSET(info.core, &siblings); info.core++) {
    }
    snprintf(path, sizeof(path), "/sys/devices/system/cpu/cpu%d/topology/core_id", cpu);
    info.core_id = read_int(path);
    snprintf(path, sizeof(path), "/sys/devices/system/cpu/cpu%d/topology/physical_package_id", cpu);
    info.package_id = read_int(path);
    return info;
}

/* "0-3,8" for the CPUs in `cpus`, which are in increasing order. */
static void format_cpus(const cpu_info_t *cpus, int n, char *buf, size_t size) {
    size_t len = 0;
    buf[0] = '\0';
    for (int i = 0; i < n; i++) {
        int j = i;
        while (j + 1 < n && cpus[j + 1].cpu == cpus[j].cpu + 1) j++;
        int written = j > i ? snprintf(buf + len, size - len, "%s%d-%d", len ? "," : "", cpus[i].cpu, cpus[j].cpu)
                            : snprintf(buf + len, size - len, "%s%d", len ? "," : "", cpus[i].cpu);
        if (written < 0 || (size_t)written >= size - len) {
            snprintf(buf + (size > 4 ? size - 4 : 0), 4, "...");
            return;
        }
        len += (size_t)written;
        i = j;
    }
}

static void impossible(const char *placement, const char *fmt, ...) __attribute__((format(printf, 2, 3), noreturn));
static void impossible(const char *placement, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "error: placement %s is impossible here: ", placement);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    exit(2);
}

/* Fills placed[0..threads-1] with the CPUs the threads run on, thread 0 first,
 * or exits 2 when the CPUs this process may run on cannot provide them. */
static void place(const char *placement, int threads, cpu_info_t *placed) {
    static int allowed_cpus[CPU_SETSIZE];
    static cpu_info_t allowed[CPU_SETSIZE];
    int n = lm_allowed_cpus(allowed_cpus, CPU_SETSIZE);
    if (n <= 0) lm_die("no CPU is allowed to this process");
    for (int i = 0; i < n; i++) allowed[i] = cpu_info(allowed_cpus[i]);
    char list[512];
    format_cpus(allowed, n, list, sizeof(list));

    /* The distinct cores among the allowed CPUs, in order of their first allowed CPU. */
    static int cores[CPU_SETSIZE];
    static int per_core[CPU_SETSIZE];
    int ncores = 0;
    for (int i = 0; i < n; i++) {
        int k = 0;
        while (k < ncores && cores[k] != allowed[i].core) k++;
        if (k == ncores) {
            cores[ncores] = allowed[i].core;
            per_core[ncores++] = 0;
        }
        per_core[k]++;
    }

    if (strcmp(placement, "one_cpu") == 0) {
        placed[0] = allowed[0];
    } else if (strcmp(placement, "distinct_cores") == 0) {
        /* The first allowed CPU of each of the first `threads` cores. */
        if (ncores < threads) {
            impossible(placement, "%d threads need CPUs on %d different cores, and the CPUs this process may run on (%s) are on %d core%s",
                       threads, threads, list, ncores, ncores == 1 ? "" : "s");
        }
        for (int k = 0; k < threads; k++) {
            int i = 0;
            while (allowed[i].core != cores[k]) i++;
            placed[k] = allowed[i];
        }
    } else if (strcmp(placement, "smt_siblings") == 0) {
        /* The first `threads` allowed CPUs of the first core that has that many. */
        int k = 0;
        int most = 0;
        while (k < ncores && per_core[k] < threads) {
            if (per_core[k] > most) most = per_core[k];
            k++;
        }
        if (k == ncores) {
            impossible(placement, "%d threads need %d hardware threads of one core, and of the CPUs this process may run on (%s) no core has more than %d",
                       threads, threads, list, most);
        }
        int taken = 0;
        for (int i = 0; i < n && taken < threads; i++) {
            if (allowed[i].core == cores[k]) placed[taken++] = allowed[i];
        }
    } else {
        lm_usage("parameter placement must be \"one_cpu\", \"distinct_cores\" or \"smt_siblings\", got \"%s\"", placement);
    }
}

/* ---- main ---- */

static const char *mutex_type_name(int type) {
    switch (type) {
    case PTHREAD_MUTEX_NORMAL: return "PTHREAD_MUTEX_NORMAL";
    case PTHREAD_MUTEX_RECURSIVE: return "PTHREAD_MUTEX_RECURSIVE";
    case PTHREAD_MUTEX_ERRORCHECK: return "PTHREAD_MUTEX_ERRORCHECK";
    case PTHREAD_MUTEX_ADAPTIVE_NP: return "PTHREAD_MUTEX_ADAPTIVE_NP";
    default: return "unknown";
    }
}

static void append(char *buf, size_t size, const char *fmt, int value) {
    size_t len = strlen(buf);
    int n = snprintf(buf + len, size - len, fmt, value);
    if (n < 0 || (size_t)n >= size - len) lm_die("observed list too long");
}

static uint64_t timeval_us(struct timeval tv) {
    return (uint64_t)tv.tv_sec * 1000000ULL + (uint64_t)tv.tv_usec;
}

int main(int argc, char **argv) {
    lm_start(argc, argv);

    uint64_t threads_param = lm_param_u64("threads", "1");
    const char *placement = lm_param("placement", "one_cpu");
    uint64_t lines_param = lm_param_u64("critical_section_lines", "1");
    const char *lock = lm_param("lock", "pthread_mutex_default");
    uint64_t idle_param = lm_param_u64("idle_threads", "0");

    if (threads_param < 1 || threads_param > MAX_THREADS) lm_usage("parameter threads must be 1 to %d, got %" PRIu64, MAX_THREADS, threads_param);
    if (lines_param < 1 || lines_param > MAX_LINES) lm_usage("parameter critical_section_lines must be 1 to %d, got %" PRIu64, MAX_LINES, lines_param);
    int nthreads = (int)threads_param;
    if (strcmp(placement, "one_cpu") == 0 && nthreads != 1) lm_usage("placement one_cpu takes threads 1, got %d", nthreads);
    if (strcmp(placement, "smt_siblings") == 0 && nthreads < 2) lm_usage("placement smt_siblings takes threads 2 or more, got %d", nthreads);
    if (idle_param > 1) lm_usage("parameter idle_threads must be 0 or 1, got %" PRIu64, idle_param);

    pthread_mutexattr_t attr;
    if (pthread_mutexattr_init(&attr) != 0) lm_die("pthread_mutexattr_init");
    if (strcmp(lock, "pthread_mutex_adaptive") == 0) {
        if (pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_ADAPTIVE_NP) != 0) lm_die("pthread_mutexattr_settype");
    } else if (strcmp(lock, "pthread_mutex_default") != 0) {
        lm_usage("parameter lock must be \"pthread_mutex_default\" or \"pthread_mutex_adaptive\", got \"%s\"", lock);
    }
    int lock_type = -1;
    if (pthread_mutexattr_gettype(&attr, &lock_type) != 0) lm_die("pthread_mutexattr_gettype");

    cpu_info_t *placed = calloc((size_t)nthreads, sizeof(cpu_info_t));
    if (placed == NULL) lm_die("calloc");
    place(placement, nthreads, placed);

    ctx_t c = { .nthreads = nthreads, .lines = (int)lines_param };
    c.shared = (shared_t *)lm_alloc(128, sizeof(shared_t));
    c.control = (control_t *)lm_alloc(128, sizeof(control_t));
    c.pair = (pair_line_t *)lm_alloc(128, sizeof(pair_line_t));
    c.threads = (thread_t *)lm_alloc(128, (size_t)nthreads * sizeof(thread_t));
    memset(c.shared, 0, sizeof(shared_t));
    memset(c.control, 0, sizeof(control_t));
    memset(c.pair, 0, sizeof(pair_line_t));
    memset(c.threads, 0, (size_t)nthreads * sizeof(thread_t));
    int rc = pthread_mutex_init(&c.shared->lock.mutex, &attr);
    if (rc != 0) lm_die("pthread_mutex_init: %s", strerror(rc));
    pthread_mutexattr_destroy(&attr);

    for (int i = 0; i < nthreads; i++) {
        c.threads[i].index = i;
        c.threads[i].ctx = &c;
        c.threads[i].cpu = placed[i].cpu;
        atomic_init(&c.threads[i].done, UINT64_MAX);
    }
    pin(&c.threads[0]);
    if (idle_param == 1) start_idle_thread();
    for (int i = 1; i < nthreads; i++) {
        rc = pthread_create(&c.threads[i].thread, NULL, worker_main, &c.threads[i]);
        if (rc != 0) lm_die("pthread_create: %s", strerror(rc));
    }
    wait_for_others(&c, 0);

    /* One repetition, checked: exactly K critical sections, counted by the
     * threads themselves, and every protected line moved with the counter. */
    uint64_t counter = mutex_run(&c);
    uint64_t counted = 0;
    for (int i = 0; i < nthreads; i++) counted += c.threads[i].sections;
    if (counter != K || counted != K) lm_die("one repetition did %" PRIu64 " critical sections by the threads' count and left the counter at %" PRIu64 "; expected %llu", counted, counter, K);
    int lines_equal = 0;
    for (int i = 0; i < c.lines; i++) lines_equal += c.shared->lines[i].value == counter;
    if (lines_equal != c.lines) lm_die("after one repetition %d of %d protected lines equal the counter", lines_equal, c.lines);

    char cpus[4096] = "", core_ids[4096] = "", package_ids[4096] = "";
    for (int i = 0; i < nthreads; i++) {
        const char *fmt = i ? ",%d" : "%d";
        append(cpus, sizeof(cpus), fmt, c.threads[i].cpu_seen);
        append(core_ids, sizeof(core_ids), fmt, placed[i].core_id);
        append(package_ids, sizeof(package_ids), fmt, placed[i].package_id);
    }
    int checked_in = 1;
    for (int i = 1; i < nthreads; i++) checked_in += atomic_load(&c.threads[i].done) == c.generation;
    lm_observe_u64("threads_used", (uint64_t)checked_in);
    lm_observe_str("cpus", cpus);
    lm_observe_str("core_ids", core_ids);
    lm_observe_str("package_ids", package_ids);
    lm_observe_str("lock_type", mutex_type_name(lock_type));
    lm_observe_str("libc", gnu_get_libc_version());
    lm_observe_u64("critical_sections_per_repetition", counted);
    lm_observe_u64("protected_lines", (uint64_t)lines_equal);
    lm_observed();

    uint64_t per_batch = lm_quick() ? 10000 : 100000;
    for (int i = 1; i < nthreads; i++) cpu_pair(&c, i, per_batch);

    /* What was the case just before measuring. */
    lm_event e;
    lm_observed_begin(&e, lm_now_ns());
    lm_event_bool(&e, "libc_single_threaded", __libc_single_threaded != 0);
    lm_event_u64(&e, "process_threads", process_threads());
    pid_t idle_tid = atomic_load(&g_idle_tid);
    lm_event_u64(&e, "idle_threads_sleeping", idle_tid != 0 && thread_state(idle_tid) == 'S' ? 1 : 0);
    lm_event_emit(&e);

    snapshot_all(&c, CMD_BEGIN);
    lm_measure(mutex_run, &c);
    snapshot_all(&c, CMD_END);
    wait_for_others(&c, publish(&c, CMD_EXIT));
    for (int i = 1; i < nthreads; i++) {
        rc = pthread_join(c.threads[i].thread, NULL);
        if (rc != 0) lm_die("pthread_join: %s", strerror(rc));
    }

    lm_event_begin(&e, "mutex_threads", lm_now_ns());
    lm_event_array(&e, "threads");
    for (int i = 0; i < nthreads; i++) {
        thread_t *t = &c.threads[i];
        lm_event_object(&e, NULL);
        lm_event_u64(&e, "thread", (uint64_t)i);
        lm_event_u64(&e, "cpu", (uint64_t)t->cpu_seen);
        lm_event_i64(&e, "cpu_at_end", t->cpu_at_end);
        lm_event_u64(&e, "critical_sections", t->sections - t->sections_begin);
        lm_event_u64(&e, "acquisitions", t->acquisitions - t->acquisitions_begin);
        lm_event_u64(&e, "voluntary_switches", (uint64_t)(t->usage_end.ru_nvcsw - t->usage_begin.ru_nvcsw));
        lm_event_u64(&e, "involuntary_switches", (uint64_t)(t->usage_end.ru_nivcsw - t->usage_begin.ru_nivcsw));
        lm_event_u64(&e, "user_time_us", timeval_us(t->usage_end.ru_utime) - timeval_us(t->usage_begin.ru_utime));
        lm_event_u64(&e, "system_time_us", timeval_us(t->usage_end.ru_stime) - timeval_us(t->usage_begin.ru_stime));
        lm_event_close(&e);
    }
    lm_event_close(&e);
    lm_event_emit(&e);

    /* The elision guard: every repetition, validation and warmup included, did
     * exactly K critical sections, no increment was lost (the threads' own
     * counts add up to the counter), and every protected line moved with it. */
    counter = c.shared->lines[0].value;
    counted = 0;
    for (int i = 0; i < nthreads; i++) counted += c.threads[i].sections;
    uint64_t expected = K * c.repetitions;
    if (counter != expected) lm_die("mutual exclusion did not hold: the counter is %" PRIu64 " after %" PRIu64 " repetitions, expected %" PRIu64, counter, c.repetitions, expected);
    if (counted != counter) lm_die("mutual exclusion did not hold: the threads did %" PRIu64 " critical sections, but the counter moved by %" PRIu64, counted, counter);
    for (int i = 1; i < c.lines; i++) {
        uint64_t value = c.shared->lines[i].value;
        if (value != counter) lm_die("mutual exclusion did not hold: protected line %d is %" PRIu64 ", the counter %" PRIu64, i, value, counter);
    }
    pthread_mutex_destroy(&c.shared->lock.mutex);

    lm_finish();
    return 0;
}
