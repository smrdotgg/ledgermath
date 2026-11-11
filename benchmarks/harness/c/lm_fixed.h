#ifndef LEDGERMATH_LM_FIXED_H
#define LEDGERMATH_LM_FIXED_H

/* Samples of fixed work, for the C harness.
 *
 * lm_measure() (lm.h) calibrates: it doubles the repetitions until a sample
 * lasts a second. Some work cannot be repeated that way: a cold read of a
 * region is cold only the first time, so each sample must read a region of its
 * own, made cold beforehand, outside the measured interval. lm_measure_fixed()
 * takes samples of a fixed number of repetitions instead, with a preparation
 * step before each sample that runs outside its interval, and emits the same
 * events as lm_measure(): sample_started and sample_ended for each sample,
 * warmup samples first and tagged, then `verified` with fn's last return
 * value. A Method reads the stream exactly as it reads lm_measure()'s.
 *
 *     lm_start(argc, argv);
 *     ... observed ...
 *     lm_measure_fixed(read_one_block, make_region_cold, &ctx, blocks_per_region, 2);
 *     lm_finish();
 *
 * Use it instead of lm_measure(), never as well: each numbers its samples from
 * 0. lm.c is not changed, so every binary already built on it keeps its bytes.
 */

#include <stdbool.h>
#include <stdint.h>

#include "lm.h"

/* Called before each sample, outside its interval: `sample` is the sample's
 * number in the stream (warmup samples first, from 0), `warmup` whether it is
 * one. */
typedef void (*lm_prepare_fn)(void *ctx, unsigned sample, bool warmup);

/* Takes `warmup_samples` warmup samples, then LM_SAMPLES counted ones (3 under
 * --quick when LM_SAMPLES is unset), each of exactly `repetitions` calls of fn,
 * with prepare (if not NULL) before each. The clock is read twice per sample,
 * at its edges, and both of a sample's events are written after it ends. Then
 * emits `verified` with fn's last return value. Call once, after lm_start(). */
void lm_measure_fixed(lm_fn fn, lm_prepare_fn prepare, void *ctx, uint64_t repetitions, unsigned warmup_samples);

/* The number of counted samples lm_measure_fixed() takes. */
unsigned lm_fixed_samples(void);

#endif /* LEDGERMATH_LM_FIXED_H */
