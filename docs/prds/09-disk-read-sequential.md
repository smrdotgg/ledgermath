# PRD 09 — `disk_read_sequential`

## Goal

Measure sequential disk read throughput at 8 KiB granularity — the "scan a file/table off
disk" number. On real NVMe this is GiB/s; the per-8-KiB latency is single-digit
microseconds.

## Prerequisite

Read `docs/dev-log.md` first — especially the Tier 2 decision on **O_DIRECT**: our harness
re-runs the op continuously, so buffered reads would be served from the page cache after
the first pass and the number would silently become a RAM benchmark. All Tier 2 *read*
benchmarks therefore use `O_DIRECT`, which bypasses the page cache so every read hits the
device, no matter how often offsets repeat.

## Deliverable

A single new file `benchmarks/c/bench_disk_read_sequential.c` with its own `main()`,
including `harness.h`. **Do not edit `harness.*`, the `Makefile`, or any other file**
except appending your Running Log entry to `docs/dev-log.md`.

## Records to emit

| `benchmark` | `variant` | `threads` | `bytes_per_op` |
|-------------|-----------|-----------|----------------|
| `disk_read_sequential` | `8 KiB` | 1 | 8192 |

## Source to port

`local/napkin-math/src/main.rs`, `disk_read_sequential` (~674). The original used buffered
reads + page-cache dropping; we use O_DIRECT instead (see prerequisite).

## Implementation requirements

- **File**: `bench_file_path("disk_read_sequential")`; create it in setup at FILE_BYTES
  (full: 1 GiB, `--quick`: 256 MiB) filled with a fixed-seed pseudo-random pattern where
  each 8 KiB block's first u64 is a known function of its offset (so reads are
  verifiable). `fdatasync` after creation. Delete on exit.
- **Open for reading with `O_DIRECT`** (a separate `open()` after creation). O_DIRECT
  alignment rules: the read buffer must be allocated with `xalloc(4096, ...)`, and offset
  and length must be multiples of the logical block size — 8192 at 8192-aligned offsets
  satisfies this. If `open(O_DIRECT)` fails, print a clear error to stderr and exit
  non-zero (do not silently fall back to buffered — that would produce cache numbers).
- **The timed op**: `pread` 8 KiB at the current offset, advance, wrap to 0 at EOF.
  Loop on short reads. Checksum: accumulate the first u64 of each block read (data-
  dependent on the read actually happening).
- **Startup validation**: read block 0 and verify its first u64 matches the known
  pattern function; exit non-zero on mismatch.

## Expected ballpark

- Real NVMe: ~1–8 GiB/s sequential → single-digit µs per 8 KiB op.
- A virtualized VPS disk: anywhere from tens of MiB/s to a few GiB/s — noisy, smoke-test
  only.
- **Red flag: throughput at RAM speeds (10+ GiB/s sustained)** — means O_DIRECT isn't
  actually in effect and you're reading the page cache. Verify the flag is set on the fd
  you actually read from.

## Definition of done

Per `docs/dev-log.md` §5. `./benchmarks/c/build/disk_read_sequential --quick` emits
schema-correct JSON; file cleaned up; Running Log entry appended.

## Git

- Branch: `bench/disk-read-sequential` off `main`.
- PR title: `bench: add disk_read_sequential (8 KiB, O_DIRECT)`
- PR body: what it measures, note that O_DIRECT replaces napkin's drop-cache approach.
