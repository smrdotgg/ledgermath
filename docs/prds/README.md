# Tier 1 migration PRDs

Each PRD migrates one napkin-math benchmark group into a standalone `benchmarks/c/bench_<name>.c`.
They are independent and may be done in any order, but are numbered for a sensible sequence
(easiest/highest-value first). Every branch forks from `main` and only **adds** files, so
they never conflict.

**Before implementing any PRD, read `docs/dev-log.md` in full** — it defines the output
contract, the schema, the elision/checksum rule, and the definition of done that every PRD
relies on.

| # | PRD | Benchmark (JSON `benchmark`) | New file | Branch |
|---|-----|------------------------------|----------|--------|
| 01 | `01-memory-write.md` | `memory_write` | `bench_memory_write.c` | `bench/memory-write` |
| 02 | `02-memory-read-random.md` | `memory_read_random` | `bench_memory_read_random.c` | `bench/memory-read-random` |
| 03 | `03-syscall.md` | `syscall` | `bench_syscall.c` | `bench/syscall` |
| 04 | `04-hash.md` | `hash` | `bench_hash.c` | `bench/hash` |
| 05 | `05-sort.md` | `sort` | `bench_sort.c` | `bench/sort` |
| 06 | `06-mutex.md` | `mutex` | `bench_mutex.c` | `bench/mutex` |
| 07 | `07-tcp-echo.md` | `tcp_echo` | `bench_tcp_echo.c` | `bench/tcp-echo` |

Source of truth to port from: `local/napkin-math/src/main.rs` (git-ignored, on disk). The
napkin-math README's benchmark list is unreliable — use the source, at the line references
each PRD gives.
