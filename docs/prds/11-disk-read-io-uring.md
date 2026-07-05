# PRD 11 — `disk_read_io_uring`

## Goal

Measure sequential disk read throughput with **io_uring at queue depth 64** — the "how
fast can this device actually go when you keep it busy" number, versus PRD 09's one-
request-at-a-time floor. Modern NVMe only reaches its rated GiB/s with many requests in
flight; this benchmark shows that headroom.

## Prerequisite

Read `docs/dev-log.md` first (contract, Tier 2 disk conventions, O_DIRECT decision).

**Build dependency**: this benchmark links `liburing` (`#include <liburing.h>`). The
Makefile already handles it — `build/disk_read_io_uring` gets `-luring` via a target-
specific variable. **Do not edit the Makefile.** If the build box lacks liburing
(`apt-get install liburing-dev`), the build will fail with a clear missing-header error;
that's an environment problem, not a code problem.

## Deliverable

A single new file `benchmarks/c/bench_disk_read_io_uring.c` with its own `main()`,
including `harness.h`. **Do not edit `harness.*`, the `Makefile`, or any other file**
except appending your Running Log entry to `docs/dev-log.md`.

## Records to emit

| `benchmark` | `variant` | `threads` | `bytes_per_op` |
|-------------|-----------|-----------|----------------|
| `disk_read_io_uring` | `32 KiB × 64 in flight` | 1 | 2097152 |

`bytes_per_op` = 64 requests × 32 KiB = 2 MiB (one op = one full submit/complete batch).

## Source to port

`local/napkin-math/src/main.rs`, `disk_read_sequential_io_uring` (~738): 32 KiB reads, 64
per batch, sequential offsets through a large file. The original used the Rust `rio`
crate; you write the liburing equivalent.

## Implementation requirements

- **File**: `bench_file_path("disk_read_io_uring")`; create at FILE_BYTES (full: 1 GiB,
  `--quick`: 256 MiB) with the verifiable offset-derived pattern (as PRDs 09/10),
  `fdatasync`, delete on exit. Open for reading with **O_DIRECT** (same no-fallback rule).
- **Setup**: `io_uring_queue_init(64, &ring, 0)`; allocate 64 separate 32 KiB buffers via
  `xalloc(4096, ...)`.
- **The timed op**: prepare 64 `io_uring_prep_read` SQEs at consecutive 32 KiB offsets
  (each into its own buffer), `io_uring_submit`, then **wait for and reap all 64 CQEs**,
  checking each CQE's `res` == 32768 (loop/resubmit on short reads; die on errors).
  Advance the base offset by 2 MiB, wrapping at EOF. Checksum: accumulate the first u64
  of every completed buffer — after the completion is reaped, never before.
- **Completion discipline is the whole benchmark**: submitting without waiting measures
  nothing. Every SQE submitted in an op must have its CQE seen in the same op.
- **Startup validation**: one full batch, then verify each buffer's first u64 matches the
  offset pattern; exit non-zero on mismatch.
- Clean up: `io_uring_queue_exit`, close fd, unlink file.

## Expected ballpark

- Real NVMe: this should approach the device's rated sequential throughput (several
  GiB/s) and beat PRD 09's QD1 number substantially — the ratio is the insight.
- Virtualized VPS: unpredictable; possibly little better than QD1. Smoke-test only.
- **Red flags**: throughput above device/RAM plausibility (completions not actually
  awaited, or O_DIRECT missing); or exactly ≈ PRD 09 QD1 numbers on real hardware
  (batching not actually in flight — e.g. submitting one at a time).

## Definition of done

Per `docs/dev-log.md` §5. Builds via plain `make` (liburing installed),
`./benchmarks/c/build/disk_read_io_uring --quick` emits schema-correct JSON; file cleaned
up; Running Log entry appended.

## Git

- Branch: `bench/disk-read-io-uring` off `main`.
- PR title: `bench: add disk_read_io_uring (32 KiB × 64)`
- PR body: what it measures, the observed QD64-vs-QD1 ratio vs PRD 09 if available.
