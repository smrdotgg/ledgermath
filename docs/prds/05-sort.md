# PRD 05 — `sort`

## Goal

Measure how fast the CPU can sort 64-bit integers — a stand-in for the CPU cost of the
sort-heavy inner loops in databases, analytics, and query engines. The napkin number is
roughly 500 MiB/s for 64-bit integer sorting.

## Prerequisite

Read `docs/dev-log.md` first (contract, schema, checksum rule, definition of done).

## Deliverable

A single new file `benchmarks/c/bench_sort.c` with its own `main()`, including `harness.h`.
**Do not edit `harness.*`, the `Makefile`, or any other file** except appending your Running
Log entry to `docs/dev-log.md`.

## Records to emit

| `benchmark` | `variant` | `threads` | `bytes_per_op` |
|-------------|-----------|-----------|----------------|
| `sort` | `u64` | 1 | 1 MiB (1048576) |

Matches napkin's `TOTAL_SIZE = 1 MiB` of `u64` (~131072 elements).

## Source to port

`local/napkin-math/src/main.rs`, `sort` (~1157). The original uses Rust's
`sort_unstable` (pattern-defeating quicksort).

## Implementation notes — do NOT use `qsort`

`qsort(3)` calls a function pointer per comparison; that indirection dominates and would
report a number ~2–3× worse than the machine's real sorting speed, corrupting the napkin
value. Instead use an **inlined-comparison** sort:

- Preferred: an LSD **radix sort** on the `u64` keys (deterministic, no comparator, easy to
  get right, closest to peak throughput). Or,
- An inline pdqsort/introsort/quicksort with the comparison written inline (no function
  pointer).

Requirements:
- Each timed op sorts a **fresh unsorted copy** of the data. Sorting an
  already-sorted array measures nothing. So: generate one random `u64` array in setup (fixed
  seed, no `Math.random`-style calls — use a small xorshift), and in each `fn(ctx)` call
  `memcpy` the pristine array into a scratch buffer, sort the scratch, then derive the
  checksum from it (e.g. sum of every k-th element, or `scratch[0] ^ scratch[mid] ^
  scratch[last]`). The copy is part of the measured op in napkin's model — that's fine and
  consistent; note it in the PR.
- Validate correctness once at startup: after sorting, assert the scratch is non-decreasing;
  exit non-zero if not.
- `bytes_per_op` = 1 MiB.

## Expected ballpark

- ~500 MiB/s → a 1 MiB sort in roughly ~2 ms (`mean_ns` ~2,000,000). Radix may be faster;
  comparison sorts around the napkin figure. If you see numbers implying tens of GiB/s,
  the sort is being elided or you're re-sorting already-sorted data.

## Definition of done

Per `docs/dev-log.md` §5. `./benchmarks/c/build/sort --quick` emits schema-correct JSON;
startup sortedness check passes; numbers in ballpark; Running Log entry appended.

## Git

- Branch: `bench/sort` off `main`.
- PR title: `bench: add sort (u64)`
- PR body: what it measures, which sort algorithm you used and why not `qsort`, the
  `--quick` JSON.
