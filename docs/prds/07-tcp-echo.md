# PRD 07 — `tcp_echo`

## Goal

Measure loopback TCP round-trip latency and throughput by echoing a 32 KiB buffer between a
client and a server in the same process. This isolates the kernel networking stack (syscall
+ TCP + loopback) from any real NIC — a useful floor for "how fast can two processes on the
same box talk over TCP."

## Prerequisite

Read `docs/dev-log.md` first (contract, schema, checksum rule, definition of done).

## Deliverable

A single new file `benchmarks/c/bench_tcp_echo.c` with its own `main()`, including
`harness.h`. **Do not edit `harness.*`, the `Makefile`, or any other file** except appending
your Running Log entry to `docs/dev-log.md`.

## Records to emit

| `benchmark` | `variant` | `threads` | `bytes_per_op` |
|-------------|-----------|-----------|----------------|
| `tcp_echo` | `32 KiB` | 1 | 32768 |

`bytes_per_op` = 32768 (one 32 KiB write+read round-trip). `threads` = 1 (the measured
client thread; the echo server runs on a helper thread but the measured path is the client).

## Source to port

`local/napkin-math/src/main.rs`, `tcp_read_write` (~996). The original spawns a localhost
echo server thread, connects a client, and measures write-then-read round-trips.

## Implementation notes — self-contained, no external services

- In setup, start a **loopback echo server on a helper thread**: bind `127.0.0.1:0` (let the
  kernel pick a free port — do **not** hardcode a port; read it back with `getsockname` and
  hand it to the client, so parallel/repeated runs don't collide), `listen`, accept one
  connection, then loop `read`→`write` echoing bytes back.
- Client: connect to that port, `setsockopt(TCP_NODELAY)` on both ends (matches the
  original — we're measuring latency, not Nagle batching). The measured op writes the 32 KiB
  buffer and reads 32 KiB back (loop the read until all bytes arrive; a single `read` may
  return short). Derive the checksum from the echoed bytes (e.g. sum a few bytes of the
  returned buffer) so the round-trip can't be optimized out.
- Handle short reads/writes correctly (loop until the full 32 KiB is transferred). Set
  sensible timeouts so a bug can't hang the harness forever.
- On exit, close sockets and join/stop the server thread cleanly so the process doesn't
  hang. `bytes_per_op` = 32768.

## Expected ballpark

- Round-trip latency for 32 KiB over loopback: tens of microseconds (`mean_ns` ~10,000–
  100,000). Throughput on the order of a few hundred MiB/s to low GiB/s. If you see
  sub-microsecond times, the round-trip isn't actually happening (server not echoing, or the
  read returned short and you didn't notice).

## Definition of done

Per `docs/dev-log.md` §5. `./benchmarks/c/build/tcp_echo --quick` emits schema-correct JSON;
process exits cleanly (server thread joined, no hang); numbers in ballpark; Running Log
entry appended.

## Git

- Branch: `bench/tcp-echo` off `main`.
- PR title: `bench: add tcp_echo (32 KiB loopback)`
- PR body: what it measures, note that the server binds an ephemeral port on a helper
  thread, the `--quick` JSON.
