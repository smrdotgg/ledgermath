# PRD 01 — `memory_write`

## Goal

Measure how fast the CPU can **write** to RAM, sequentially and in random order. This is
the write-side companion to the existing `memory_read` benchmark. Sequential write shows
the store-bandwidth ceiling; random write shows what happens when each store lands on a
different cache line / page.

## Prerequisite

Read `docs/dev-log.md` first (contract, schema, checksum rule, definition of done). This
PRD only specifies what's unique to this benchmark.

## Deliverable

A single new file `benchmarks/c/bench_memory_write.c` with its own `main()`, including
`harness.h` and using `measure()` + `print_json()`. **Do not edit `harness.*`, the
`Makefile`, or any other file** except appending your Running Log entry to `docs/dev-log.md`.

## Records to emit

| `benchmark` | `variant` | `threads` | `bytes_per_op` |
|-------------|-----------|-----------|----------------|
| `memory_write` | `1 thread, Sequential` | 1 | buffer size in bytes |
| `memory_write` | `1 thread, Random` | 1 | buffer size in bytes |

Single-threaded is sufficient for v1 (mirrors napkin). Do not add threaded variants here.

## Source to port

`local/napkin-math/src/main.rs`:
- `memory_write_sequential` (around line 393) — 1 GiB of 64-byte elements, write each in
  order.
- `memory_write_random` (around line 525) — same, but write via a pre-shuffled index array.

## Implementation notes

- Buffer: 1 GiB of 64-byte elements (use `struct { uint64_t w[8]; }` or `uint64_t[]`
  treating 8 words as one "element"), like `memory_read`. Use `QUICK` sizing (512 MiB) when
  `opts.quick`, matching the existing benchmark's pattern.
- One `fn(ctx)` call = one full pass writing every element. Return a checksum derived from
  what you wrote so `-O3` can't delete the stores — e.g. write `i`-dependent values and
  accumulate/xor a value read back from the buffer, or sum the last word of each element
  after writing. The checksum must depend on the writes actually happening.
- Random variant: pre-build and shuffle a `size_t` index array once in setup (not timed);
  the timed op walks the shuffled indices. Consider `madvise(MADV_RANDOM)` on the buffer
  (see PRD 02 for the pattern) so the kernel doesn't read-ahead.
- `bytes_per_op` = number of elements × 64.

## Expected ballpark (so wrong results smell)

- Sequential write: tens of GiB/s throughput (same order as sequential read, often a bit
  lower). `mean_ns` for a 1 GiB pass in the tens of milliseconds.
- Random write: markedly slower — low single-digit GiB/s, per-element cost in the tens of
  nanoseconds. If random ≈ sequential, your working set is fitting in cache (buffer too
  small) or the shuffle isn't being used.

## Definition of done

Per `docs/dev-log.md` §5: single added file, builds warning-clean, checksum guard present,
`./benchmarks/c/build/memory_write --quick` emits schema-correct JSON that
`python3 -m json.tool` accepts, numbers in ballpark, Running Log entry appended.

## Git

- Branch: `bench/memory-write` off `main`.
- PR title: `bench: add memory_write (sequential + random)`
- PR body: one line on what it measures, the two variants, and a paste of the `--quick`
  JSON output.
