#include "lm_fixed.h"

#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define LM_FIXED_QUICK_SAMPLES 3

static bool g_fixed_measured;

/* One write per line set, as lm.c does: stdio is not used for stdout. */
static void fixed_emit(const char *text, size_t len) {
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

unsigned lm_fixed_samples(void) {
    /* lm_start() has already refused a bad LM_SAMPLES, and an absent one
     * outside --quick. */
    const char *text = getenv("LM_SAMPLES");
    if (text == NULL) {
        if (!lm_quick()) lm_usage("LM_SAMPLES is not set");
        return LM_FIXED_QUICK_SAMPLES;
    }
    char *end = NULL;
    long n = strtol(text, &end, 10);
    if (end == text || *end != '\0' || n < 1 || n > 1000000) lm_usage("LM_SAMPLES must be a whole number of at least 1, got \"%s\"", text);
    return (unsigned)n;
}

void lm_measure_fixed(lm_fn fn, lm_prepare_fn prepare, void *ctx, uint64_t repetitions, unsigned warmup_samples) {
    if (g_fixed_measured) lm_die("lm_measure_fixed was already called");
    if (repetitions < 1) lm_die("lm_measure_fixed: a sample needs at least one repetition");
    g_fixed_measured = true;

    unsigned counted = lm_fixed_samples();
    unsigned total = warmup_samples + counted;
    uint64_t last = 0;
    char line[512];
    for (unsigned sample = 0; sample < total; sample++) {
        bool warmup = sample < warmup_samples;
        if (prepare != NULL) prepare(ctx, sample, warmup);
        uint64_t t0 = lm_now_ns();
        for (uint64_t i = 0; i < repetitions; i++) last = fn(ctx);
        uint64_t t1 = lm_now_ns();
        int n = snprintf(line, sizeof(line),
                         "{\"event\":\"sample_started\",\"t\":%" PRIu64 ",\"sample\":%u,\"warmup\":%s,\"repetitions\":%" PRIu64 "}\n"
                         "{\"event\":\"sample_ended\",\"t\":%" PRIu64 ",\"sample\":%u}\n",
                         t0, sample, warmup ? "true" : "false", repetitions, t1, sample);
        if (n < 0 || (size_t)n >= sizeof(line)) lm_die("event line too long");
        fixed_emit(line, (size_t)n);
    }
    int n = snprintf(line, sizeof(line), "{\"event\":\"verified\",\"t\":%" PRIu64 ",\"checksum\":\"0x%016" PRIx64 "\"}\n", lm_now_ns(), last);
    if (n < 0 || (size_t)n >= sizeof(line)) lm_die("event line too long");
    fixed_emit(line, (size_t)n);
}
