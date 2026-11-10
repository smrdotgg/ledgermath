#ifndef LEDGERMATH_LM_H
#define LEDGERMATH_LM_H

/* The LedgerMath C harness.
 *
 * A benchmark is one program that prints a stream of events to stdout, one JSON
 * object per line, and diagnostics to stderr. The contract is docs/dev-log.md
 * section 2; schemas/events.schema.json is the same thing for a machine.
 *
 * A program built on this harness has this shape:
 *
 *     lm_start(argc, argv);                 // emits `started`
 *     ... read params, set up, check the answer ...
 *     lm_observe_u64("bytes_per_repetition", n);
 *     lm_observed();                        // emits `observed`
 *     lm_measure(fn, ctx);                  // emits the samples, then `verified`
 *     lm_finish();                          // emits `finished`
 *
 * The program receives LM_PARAM_<KEY> for each parameter and LM_SAMPLES, and
 * prints only what it observed, never what it was told.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* One repetition of the measured work. Its return value must be derived from
 * the data it processed, so the optimizer cannot delete the work. */
typedef uint64_t (*lm_fn)(void *ctx);

/* Call first. Accepts `--quick` and nothing else, reads LM_SAMPLES, measures the
 * cost of a clock read, and emits `started`. */
void lm_start(int argc, char **argv);

/* True under `--quick`, a developer mode whose output is never recorded. */
bool lm_quick(void);

/* The value of LM_PARAM_<KEY>; `key` is given in lower case. When the variable
 * is unset: `quick_default` under --quick if it is not NULL, otherwise the
 * program exits with status 2 naming the missing variable. */
const char *lm_param(const char *key, const char *quick_default);
uint64_t lm_param_u64(const char *key, const char *quick_default);

/* What the program observed about its own work. Add each value, then call
 * lm_observed() once to emit them as one `observed` event. */
void lm_observe_u64(const char *key, uint64_t value);
void lm_observe_str(const char *key, const char *value);
void lm_observed(void);

/* Runs warmup samples (one repetition, then doubling until a sample lasts the
 * target of one second), then LM_SAMPLES counted samples at that repetition
 * count, then emits `verified` with fn's last return value. The clock is read
 * twice per sample, at its edges, and both of a sample's events are written
 * after it ends, so nothing of the harness runs inside a measured interval.
 * Call once. */
void lm_measure(lm_fn fn, void *ctx);

/* Call last. Emits `finished`. */
void lm_finish(void);

/* Helpers. */
void lm_die(const char *fmt, ...) __attribute__((format(printf, 1, 2), noreturn));
void lm_usage(const char *fmt, ...) __attribute__((format(printf, 1, 2), noreturn));
void *lm_alloc(size_t alignment, size_t size);
uint64_t lm_now_ns(void);
int lm_allowed_cpus(int *cpus, int max_cpus);
void lm_pin_to_cpu(int cpu);

#endif /* LEDGERMATH_LM_H */
