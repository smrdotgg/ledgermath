#include "lm.h"

#include <ctype.h>
#include <errno.h>
#include <inttypes.h>
#include <sched.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define LM_SCHEMA "ledgermath.events/1"
#define LM_CLOCK_NAME "CLOCK_MONOTONIC_RAW"
#define LM_TARGET_NS 1000000000ULL       /* one sample lasts about a second */
#define LM_TARGET_QUICK_NS 100000000ULL  /* a tenth of that under --quick */
#define LM_QUICK_SAMPLES 3

static bool g_started;
static bool g_quick;
static bool g_measured;
static int g_samples;
static uint64_t g_target_ns;
static unsigned g_next_sample;

static char g_observed[4096];
static size_t g_observed_len;
static bool g_observed_emitted;

/* ---- errors ---- */

void lm_die(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fputs("error: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    exit(1);
}

void lm_usage(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fputs("usage error: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    exit(2);
}

/* ---- clock ---- */

uint64_t lm_now_ns(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC_RAW, &ts) != 0) lm_die("clock_gettime: %s", strerror(errno));
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static int cmp_double(const void *a, const void *b) {
    double da = *(const double *)a;
    double db = *(const double *)b;
    return (da > db) - (da < db);
}

/* The median cost of one clock read, over a million back-to-back reads. Every
 * interval between two events is wrong by at most the reads inside it times
 * this. */
static double clock_read_cost_ns(void) {
    enum { BATCHES = 100, READS = 10000 };
    static double per_read[BATCHES];
    volatile uint64_t sink = 0;
    for (int b = 0; b < BATCHES; b++) {
        uint64_t t0 = lm_now_ns();
        for (int i = 0; i < READS; i++) sink += lm_now_ns();
        uint64_t t1 = lm_now_ns();
        per_read[b] = (double)(t1 - t0) / (double)(READS + 1);
    }
    (void)sink;
    qsort(per_read, BATCHES, sizeof(double), cmp_double);
    return (per_read[BATCHES / 2 - 1] + per_read[BATCHES / 2]) / 2.0;
}

/* ---- output ---- */

/* One write per call, at a phase boundary. stdio is not used for stdout, so no
 * buffer can hold a line back or split it. */
static void emit(const char *text, size_t len) {
    while (len > 0) {
        ssize_t n = write(STDOUT_FILENO, text, len);
        if (n < 0) {
            if (errno == EINTR) continue;
            fprintf(stderr, "error: write to stdout: %s\n", strerror(errno));
            _exit(3);
        }
        text += n;
        len -= (size_t)n;
    }
}

static void emitf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void emitf(const char *fmt, ...) {
    char line[8192];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= sizeof(line)) lm_die("event line too long");
    emit(line, (size_t)n);
}

/* Appends `text` to g_observed as a JSON string, quotes included. */
static void observed_append_json_string(const char *text) {
    size_t i = g_observed_len;
    const size_t cap = sizeof(g_observed) - 8;
    if (i >= cap) lm_die("observed values too long");
    g_observed[i++] = '"';
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        if (i >= cap) lm_die("observed values too long");
        if (*p == '"' || *p == '\\') {
            g_observed[i++] = '\\';
            g_observed[i++] = (char)*p;
        } else if (*p < 0x20) {
            i += (size_t)snprintf(g_observed + i, 7, "\\u%04x", *p);
        } else {
            g_observed[i++] = (char)*p;
        }
    }
    g_observed[i++] = '"';
    g_observed[i] = '\0';
    g_observed_len = i;
}

static void observed_append(const char *text) {
    size_t len = strlen(text);
    if (g_observed_len + len >= sizeof(g_observed) - 8) lm_die("observed values too long");
    memcpy(g_observed + g_observed_len, text, len + 1);
    g_observed_len += len;
}

static void observed_key(const char *key) {
    if (!g_started) lm_die("lm_start must be called first");
    if (g_observed_emitted) lm_die("lm_observed was already called");
    if (g_observed_len > 0) observed_append(",");
    observed_append_json_string(key);
    observed_append(":");
}

void lm_observe_u64(const char *key, uint64_t value) {
    char number[32];
    observed_key(key);
    snprintf(number, sizeof(number), "%" PRIu64, value);
    observed_append(number);
}

void lm_observe_str(const char *key, const char *value) {
    observed_key(key);
    observed_append_json_string(value);
}

void lm_observed(void) {
    if (!g_started) lm_die("lm_start must be called first");
    if (g_observed_emitted) lm_die("lm_observed was already called");
    g_observed_emitted = true;
    emitf("{\"event\":\"observed\",\"t\":%" PRIu64 ",\"values\":{%s}}\n", lm_now_ns(), g_observed);
}

/* ---- start, params ---- */

bool lm_quick(void) { return g_quick; }

static const char *param_env(const char *key, char *name, size_t name_size) {
    int n = snprintf(name, name_size, "LM_PARAM_%s", key);
    if (n < 0 || (size_t)n >= name_size) lm_die("parameter name too long: %s", key);
    for (char *p = name + strlen("LM_PARAM_"); *p; p++) *p = (char)toupper((unsigned char)*p);
    return getenv(name);
}

const char *lm_param(const char *key, const char *quick_default) {
    char name[128];
    const char *value = param_env(key, name, sizeof(name));
    if (value != NULL) return value;
    if (g_quick && quick_default != NULL) return quick_default;
    lm_usage("%s is not set", name);
}

uint64_t lm_param_u64(const char *key, const char *quick_default) {
    const char *text = lm_param(key, quick_default);
    char *end = NULL;
    errno = 0;
    unsigned long long value = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || text[0] == '-') {
        lm_usage("parameter %s must be a non-negative whole number, got \"%s\"", key, text);
    }
    return (uint64_t)value;
}

void lm_start(int argc, char **argv) {
    if (g_started) lm_die("lm_start was already called");
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--quick") == 0) g_quick = true;
        else lm_usage("unknown argument \"%s\"; the only argument is --quick", argv[i]);
    }

    const char *samples = getenv("LM_SAMPLES");
    if (samples != NULL) {
        char *end = NULL;
        long n = strtol(samples, &end, 10);
        if (end == samples || *end != '\0' || n < 1 || n > 1000000) {
            lm_usage("LM_SAMPLES must be a whole number of at least 1, got \"%s\"", samples);
        }
        g_samples = (int)n;
    } else if (g_quick) {
        g_samples = LM_QUICK_SAMPLES;
    } else {
        lm_usage("LM_SAMPLES is not set");
    }
    g_target_ns = g_quick ? LM_TARGET_QUICK_NS : LM_TARGET_NS;

    double clock_read_ns = clock_read_cost_ns();

    /* Monotonic first, wall clock straight after, so the two can be paired. */
    uint64_t t = lm_now_ns();
    struct timespec wall;
    if (clock_gettime(CLOCK_REALTIME, &wall) != 0) lm_die("clock_gettime: %s", strerror(errno));
    struct tm utc;
    if (gmtime_r(&wall.tv_sec, &utc) == NULL) lm_die("gmtime_r failed");
    char date[32];
    strftime(date, sizeof(date), "%Y-%m-%dT%H:%M:%S", &utc);

    g_started = true;
    emitf("{\"event\":\"started\",\"t\":%" PRIu64 ",\"schema\":\"" LM_SCHEMA "\","
          "\"wall_utc\":\"%s.%09ldZ\",\"clock\":\"" LM_CLOCK_NAME "\","
          "\"clock_read_ns\":%.3f,\"quick\":%s}\n",
          t, date, wall.tv_nsec, clock_read_ns, g_quick ? "true" : "false");
}

/* ---- measuring ---- */

static uint64_t run_sample(lm_fn fn, void *ctx, bool warmup, uint64_t repetitions, uint64_t *checksum) {
    unsigned sample = g_next_sample++;
    uint64_t last = 0;
    uint64_t t0 = lm_now_ns();
    for (uint64_t i = 0; i < repetitions; i++) last = fn(ctx);
    uint64_t t1 = lm_now_ns();
    *checksum = last;
    emitf("{\"event\":\"sample_started\",\"t\":%" PRIu64 ",\"sample\":%u,\"warmup\":%s,\"repetitions\":%" PRIu64 "}\n"
          "{\"event\":\"sample_ended\",\"t\":%" PRIu64 ",\"sample\":%u}\n",
          t0, sample, warmup ? "true" : "false", repetitions, t1, sample);
    return t1 - t0;
}

void lm_measure(lm_fn fn, void *ctx) {
    if (!g_started) lm_die("lm_start must be called first");
    if (g_measured) lm_die("lm_measure was already called");
    g_measured = true;

    uint64_t checksum = 0;
    uint64_t repetitions = 1;

    /* Warmup. Every sample is emitted; which ones count is for whoever reads
     * the stream to decide. */
    run_sample(fn, ctx, true, 1, &checksum);
    for (;;) {
        uint64_t elapsed = run_sample(fn, ctx, true, repetitions, &checksum);
        if (elapsed >= g_target_ns || repetitions > (1ULL << 40)) break;
        repetitions *= 2;
    }
    fprintf(stderr, "repetitions per sample: %" PRIu64 "\n", repetitions);

    for (int s = 0; s < g_samples; s++) run_sample(fn, ctx, false, repetitions, &checksum);

    emitf("{\"event\":\"verified\",\"t\":%" PRIu64 ",\"checksum\":\"0x%016" PRIx64 "\"}\n", lm_now_ns(), checksum);
}

void lm_finish(void) {
    if (!g_started) lm_die("lm_start must be called first");
    emitf("{\"event\":\"finished\",\"t\":%" PRIu64 "}\n", lm_now_ns());
}

/* ---- helpers ---- */

void *lm_alloc(size_t alignment, size_t size) {
    void *ptr = NULL;
    int rc = posix_memalign(&ptr, alignment, size);
    if (rc != 0) lm_die("posix_memalign(%zu): %s", size, strerror(rc));
    return ptr;
}

int lm_allowed_cpus(int *cpus, int max_cpus) {
    cpu_set_t set;
    if (sched_getaffinity(0, sizeof(set), &set) != 0) lm_die("sched_getaffinity: %s", strerror(errno));
    int n = 0;
    for (int cpu = 0; cpu < CPU_SETSIZE && n < max_cpus; cpu++) {
        if (CPU_ISSET(cpu, &set)) cpus[n++] = cpu;
    }
    return n;
}

void lm_pin_to_cpu(int cpu) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    if (sched_setaffinity(0, sizeof(set), &set) != 0) {
        lm_die("sched_setaffinity(cpu=%d): %s", cpu, strerror(errno));
    }
}
