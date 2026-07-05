# PRD 03 — `syscall`

## Goal

Measure the cost of crossing into the kernel. Several "syscalls" are actually served from
userspace (vDSO) and cost only nanoseconds; others are real mode switches costing hundreds
of nanoseconds. Capturing all four together shows that spread, which is itself the useful
napkin insight ("a syscall is ~300 ns — unless it isn't").

## Prerequisite

Read `docs/dev-log.md` first (contract, schema, checksum rule, definition of done).

## Deliverable

A single new file `benchmarks/c/bench_syscall.c` with its own `main()`, including
`harness.h`. **Do not edit `harness.*`, the `Makefile`, or any other file** except appending
your Running Log entry to `docs/dev-log.md`.

## Records to emit

| `benchmark` | `variant` | `threads` | `bytes_per_op` |
|-------------|-----------|-----------|----------------|
| `syscall` | `getpid` | 1 | 0 |
| `syscall` | `gettimeofday` | 1 | 0 |
| `syscall` | `getrusage` | 1 | 0 |
| `syscall` | `stat` | 1 | 0 |

These are latency-only: `bytes_per_op` = 0 (which makes `throughput_bytes_per_second` = 0;
that's expected and correct for these).

## Source to port

`local/napkin-math/src/main.rs`: `syscall_getpid` (~914), `syscall_time` (~929),
`syscall_getrusage` (~942), `syscall_stat` (~981).

## Implementation notes

- **Force the real call; defeat caching/elision.**
  - `getpid`: glibc caches the PID, so `getpid()` may not trap. Call
    `syscall(SYS_getpid)` directly to measure the actual syscall. Accumulate the returned
    pid into the checksum.
  - `gettimeofday`: `clock_gettime(CLOCK_MONOTONIC, ...)` or `gettimeofday(...)` — on Linux
    x86_64 these usually go through the vDSO (expect a very small number, that's the point).
    Accumulate `tv_nsec`/`tv_usec` into the checksum.
  - `getrusage`: `getrusage(RUSAGE_SELF, &ru)` — a real syscall. Accumulate a field of the
    result.
  - `stat`: `stat("/tmp", &st)` (or `fstat` on a held fd, matching the original's intent).
    Accumulate `st.st_ino` or `st.st_size`.
- One `fn(ctx)` = one syscall. The op is tiny, so calibration will pick a large iteration
  count — that's fine.
- Checksum: accumulate a result field across the loop so the compiler can't drop the call.
  `bytes_per_op` = 0.

## Expected ballpark

- `gettimeofday`: single-digit to low-tens of ns (vDSO, no real trap).
- `getpid` (via `syscall()`), `getrusage`, `stat`: on the order of ~100–1000 ns (real mode
  switch). Exact values are machine/kernel dependent; the shape (one cheap, three
  expensive) is the signal. If `getpid` reads as a few ns, you're hitting glibc's cache —
  use `syscall(SYS_getpid)`.

## Definition of done

Per `docs/dev-log.md` §5. `./benchmarks/c/build/syscall --quick` emits schema-correct JSON
(four records, `bytes_per_op` 0); Running Log entry appended.

## Git

- Branch: `bench/syscall` off `main`.
- PR title: `bench: add syscall (getpid, gettimeofday, getrusage, stat)`
- PR body: what it measures, note on vDSO vs real syscalls, and the `--quick` JSON.
