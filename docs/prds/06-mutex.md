# PRD 06 — `mutex`

## Goal

Measure the cost of acquiring and releasing a **contended** mutex — the tax you pay for
coordinating threads around shared state. The napkin insight is how much a lock costs when
another thread is fighting you for it, versus the near-free uncontended case.

## Prerequisite

Read `docs/dev-log.md` first (contract, schema, checksum rule, definition of done). Note the
NUMA/threading discipline in §4 for anything multi-threaded.

## Deliverable

A single new file `benchmarks/c/bench_mutex.c` with its own `main()`, including `harness.h`.
**Do not edit `harness.*`, the `Makefile`, or any other file** except appending your Running
Log entry to `docs/dev-log.md`.

## Records to emit

| `benchmark` | `variant` | `threads` | `bytes_per_op` |
|-------------|-----------|-----------|----------------|
| `mutex` | `contended` | 2 | 0 |

Latency-only: `bytes_per_op` = 0. `threads` = 2 (the measured thread plus one contender).
Optionally also emit an `uncontended` variant (`threads` = 1) if cheap — but `contended` is
the required one.

## Source to port

`local/napkin-math/src/main.rs`, `mutex` (~1177). The original spawns a background thread
that locks/increments in a tight loop while the main thread also locks/increments, and
measures the main thread's lock/unlock.

## Implementation notes

- Use a `pthread_mutex_t` shared between the measured thread and one contender thread the
  benchmark spawns in setup (pin them to different CPUs via `pin_to_cpu` using
  `allowed_cpus`, so contention is real and cross-core).
- The contender loops forever: lock, mutate a shared counter, unlock. The measured op
  (`fn(ctx)`) does one lock → mutate shared counter → unlock. Accumulate the shared counter
  value into the checksum so the critical section isn't optimized away.
- Ensure the contender is actually running before measurement (it's spawned in setup, before
  `measure` is called — it will be by construction). On program exit, signal the contender
  to stop and join it, or just let the process exit after printing (document which; a clean
  join is preferred).
- `bytes_per_op` = 0.

## Expected ballpark

- Contended lock/unlock: tens to a few hundred nanoseconds per op depending on the machine
  and how hot the contention is (futex wakeups, cache-line ping-pong on the lock word). If
  you measure single-digit ns, there's probably no real contention — verify the contender
  thread is scheduled and hammering the same lock.

## Definition of done

Per `docs/dev-log.md` §5. `./benchmarks/c/build/mutex --quick` emits schema-correct JSON;
the process exits cleanly (no hang from an unjoined contender); numbers in ballpark; Running
Log entry appended.

## Git

- Branch: `bench/mutex` off `main`.
- PR title: `bench: add mutex (contended)`
- PR body: what it measures, how contention is generated (contender thread pinned to another
  core), the `--quick` JSON.
