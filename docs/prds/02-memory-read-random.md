# PRD 02 — `memory_read_random`

## Goal

Measure the latency/throughput of **random** memory reads — the classic "cache miss to
main memory" number (~20–100 ns per access depending on working-set size). This is one of
the most-quoted napkin numbers: it's the cost you pay every time you chase a pointer into a
cold part of a large data structure.

## Prerequisite

Read `docs/dev-log.md` first (contract, schema, checksum rule, definition of done).

## Deliverable

A single new file `benchmarks/c/bench_memory_read_random.c` with its own `main()`,
including `harness.h`. **Do not edit `harness.*`, the `Makefile`, or any other file** except
appending your Running Log entry to `docs/dev-log.md`.

## Records to emit

| `benchmark` | `variant` | `threads` | `bytes_per_op` |
|-------------|-----------|-----------|----------------|
| `memory_read_random` | `1 thread` | 1 | elements × 64 |

## Source to port

`local/napkin-math/src/main.rs`, `memory_read_random` + `memory_read_random_setup` +
`memory_read_random_iteration` (lines ~565–605). Note the original uses `madvise` on both
the data and the index array.

## Implementation notes

- Buffer: 1 GiB of 64-byte elements (`QUICK` = 512 MiB). It **must** exceed cache, or you
  measure L2/L3 instead of RAM.
- Setup (not timed): allocate the buffer, build a `size_t` index array `0..N-1`, shuffle it
  (a simple xorshift/PRNG is fine — do not use `Math.random`-style calls; seed a fixed
  constant so runs are comparable). `madvise(data, ..., MADV_RANDOM)` to suppress
  read-ahead; `madvise(order, ..., MADV_SEQUENTIAL)` on the index array.
- Timed op: walk every index in the shuffled array, read one word from each target element,
  accumulate into a checksum sum. One `fn(ctx)` = one full pass over all elements in random
  order. Return the sum as the checksum (elision guard).
- `bytes_per_op` = elements × 64.

## Expected ballpark

- Per-element latency (`mean_ns / element_count`) in the ~20–100 ns range.
- Throughput a few GiB/s — much lower than sequential read's tens of GiB/s. If you see
  sequential-read-like throughput, the access isn't actually random (buffer fits in cache,
  or the shuffle/index walk got optimized).

## Definition of done

Per `docs/dev-log.md` §5. `./benchmarks/c/build/memory_read_random --quick` emits
schema-correct JSON; numbers in ballpark; Running Log entry appended.

## Git

- Branch: `bench/memory-read-random` off `main`.
- PR title: `bench: add memory_read_random`
- PR body: what it measures, the derived per-access latency you observed, and the `--quick`
  JSON.
