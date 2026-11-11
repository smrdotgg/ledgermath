#ifndef LEDGERMATH_LM_EVENT_H
#define LEDGERMATH_LM_EVENT_H

/* Events of a benchmark's own, and further `observed` events, for the C harness.
 *
 * lm.h emits the six universal events and one `observed`. The contract
 * (docs/dev-log.md section 2) also lets a benchmark emit events of its own,
 * under any name but the six universal ones, and `observed` more than once,
 * each key once across all of them. This file does both, without changing
 * lm.c, whose bytes are part of every Artifact already built on it.
 *
 * Build one event, then emit it as one line:
 *
 *     lm_event e;
 *     lm_event_begin(&e, "device_counters", lm_now_ns());
 *     lm_event_u64(&e, "reads", reads);
 *     lm_event_array(&e, "per_cpu");
 *     for (int i = 0; i < n; i++) lm_event_u64(&e, NULL, counts[i]);
 *     lm_event_close(&e);
 *     lm_event_emit(&e);
 *
 *     lm_observed_begin(&e, lm_now_ns());   // `observed`; members go in "values"
 *     lm_event_u64(&e, "requests_completed", n);
 *     lm_event_emit(&e);
 *
 * Inside an object every member has a key; inside an array none has one (pass
 * NULL). Call these between lm_start() and lm_finish(), never inside a measured
 * interval: they allocate, read nothing of the clock, and write to stdout.
 *
 * Emit events only from the thread that owns stdout (the one that calls lm.h's
 * functions), between samples. Nothing here serializes writers: a line is
 * passed to write(2) in one call, retried for whatever part was not written,
 * and the kernel writes a pipe's data in one piece only up to PIPE_BUF bytes
 * (4096 on Linux). So a line longer than that, or any line while another
 * thread or lm.c writes to stdout at the same moment, can interleave with
 * other output.
 *
 * A key given to lm_observed_begin's event must not be one lm_observe_*() gave,
 * nor one an earlier `observed` gave; this file cannot see lm.c's keys, so that
 * is the caller's to keep. Misuse exits 1 naming the mistake.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define LM_EVENT_MAX_DEPTH 8

typedef struct {
    char *text;
    size_t len;
    size_t cap;
    int depth;                          /* open objects and arrays, the event itself included */
    int floor;                          /* the levels lm_event_close() may not close */
    bool is_array[LM_EVENT_MAX_DEPTH];  /* whether each open level is an array */
    bool empty[LM_EVENT_MAX_DEPTH];     /* whether each open level has no member yet */
} lm_event;

/* Starts an event of the benchmark's own, named `name`, at time `t` (a value of
 * lm_now_ns()). Refuses the six universal names. */
void lm_event_begin(lm_event *e, const char *name, uint64_t t);

/* Starts a further `observed` event at time `t`; its members go in `values`. */
void lm_observed_begin(lm_event *e, uint64_t t);

/* Members. `key` is NULL inside an array and required inside an object. At the
 * top level of an event, `event` and `t` are taken. */
void lm_event_u64(lm_event *e, const char *key, uint64_t value);
void lm_event_i64(lm_event *e, const char *key, int64_t value);
void lm_event_str(lm_event *e, const char *key, const char *value);
void lm_event_bool(lm_event *e, const char *key, bool value);

/* Opens an object or an array as the next member; lm_event_close() closes the
 * innermost one. */
void lm_event_object(lm_event *e, const char *key);
void lm_event_array(lm_event *e, const char *key);
void lm_event_close(lm_event *e);

/* Closes whatever is open, writes the event as one line to stdout, as lm.c
 * writes its own (one write(2), then more for any part not written), and frees
 * it. It does not serialize writers; see the top of this file. */
void lm_event_emit(lm_event *e);

#endif /* LEDGERMATH_LM_EVENT_H */
