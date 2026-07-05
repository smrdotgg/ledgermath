# PRD 10 — `disk_read_random`

## Goal

Measure random-access disk read latency at 8 KiB — the "index lookup that misses every
cache" number, and one of the most consequential napkin figures (it's the gap between
"data is on NVMe" ~100 µs and "data is in RAM" ~100 ns).

## Prerequisite

Read `docs/dev-log.md` first — especially the Tier 2 **O_DIRECT** decision (same rationale
as PRD 09: our harness revisits offsets, so buffered reads would become page-cache hits;
O_DIRECT makes every read hit the device).

## Deliverable

A single new file `benchmarks/c/bench_disk_read_random.c` with its own `main()`, including
`harness.h`. **Do not edit `harness.*`, the `Makefile`, or any other file** except
appending your Running Log entry to `docs/dev-log.md`.

## Records to emit

| `benchmark` | `variant` | `threads` | `bytes_per_op` |
|-------------|-----------|-----------|----------------|
| `disk_read_random` | `8 KiB` | 1 | 8192 |

## Source to port

`local/napkin-math/src/main.rs`, `disk_read_random` (~832). The original used an 8 GiB
file, visited each page exactly once (shuffled), and stopped early — a mechanism our
harness doesn't have. With O_DIRECT, revisiting offsets is fine (each read still hits the
device), so we use a smaller file and wrap.

## Implementation requirements

- **File**: `bench_file_path("disk_read_random")`; create at FILE_BYTES (full: **4 GiB**,
  `--quick`: 256 MiB) with the same verifiable offset-derived pattern as PRD 09.
  `fdatasync`, delete on exit. (4 GiB rather than napkin's 8: with O_DIRECT the page cache
  is out of the picture; the size only needs to defeat the device's internal DRAM cache.)
- **Open with `O_DIRECT`**; exit non-zero if unsupported (no silent buffered fallback).
- **Access order**: build a `size_t` array of all 8 KiB-aligned block offsets, shuffle it
  once in setup with a fixed-seed Fisher–Yates (the house xorshift pattern — see
  `bench_memory_read_random.c`). The timed op reads the next offset in the shuffled order,
  wrapping the index at the end. This must be a full permutation — not `rand()` per op,
  not a small window.
- **The timed op**: one `pread` of 8 KiB at the shuffled offset (aligned buffer via
  `xalloc(4096, ...)`), loop on short reads, accumulate first-u64 checksum, advance index.
- **Startup validation**: as PRD 09 (read a known block, verify pattern).

## Expected ballpark

- Real NVMe, QD1: **~50–150 µs** per 8 KiB random read (tens of MiB/s throughput — yes,
  that low; that's the point of the number).
- Virtualized VPS storage: hugely variable, hundreds of µs to ms. Smoke-test only.
- **Red flags**: sub-10 µs per op (you're hitting a cache — O_DIRECT not in effect, file
  too small, or the order isn't actually random) or throughput within 2× of your
  sequential-read result (random ≈ sequential means the access pattern isn't random or the
  device is fully cache-backed; note it in the dev-log entry if it's genuinely the VPS
  storage doing this).

## Definition of done

Per `docs/dev-log.md` §5. `./benchmarks/c/build/disk_read_random --quick` emits
schema-correct JSON; file cleaned up; Running Log entry appended.

## Git

- Branch: `bench/disk-read-random` off `main`.
- PR title: `bench: add disk_read_random (8 KiB, O_DIRECT)`
- PR body: what it measures, observed random-vs-sequential gap on the dev box.
