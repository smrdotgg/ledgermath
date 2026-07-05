# PRD 04 — `hash`

## Goal

Measure hashing throughput for three points on the speed/strength spectrum: a hardware
CRC32 (checksum-grade), SipHash (the hash-table default, DoS-resistant but not crypto), and
SHA-256 (cryptographic). The napkin insight is the order-of-magnitude gap between them.

## Prerequisite

Read `docs/dev-log.md` first (contract, schema, checksum rule, definition of done).

## Deliverable

A single new file `benchmarks/c/bench_hash.c` with its own `main()`, including `harness.h`.
**Do not edit `harness.*`, the `Makefile`, or any other file** except appending your Running
Log entry to `docs/dev-log.md`.

## Records to emit

| `benchmark` | `variant` | `threads` | `bytes_per_op` |
|-------------|-----------|-----------|----------------|
| `hash` | `crc32` | 1 | 64 |
| `hash` | `siphash` | 1 | 64 |
| `hash` | `sha256` | 1 | 64 |

Each op hashes a fixed 64-byte input (matches napkin's `size_of_writes = 64`).
`bytes_per_op` = 64; throughput will be reported per second from that.

## Source to port

`local/napkin-math/src/main.rs`: `hash_crc32` (~1224), `hash_siphash` (~1245),
`hash_sha256` (~1206). These call out to Rust crates; you will implement the C equivalents
described below.

## Implementation notes — fidelity matters here

Do **not** hand-roll slow textbook versions; the whole point is peak hardware throughput.

- **crc32**: use the SSE4.2 hardware instruction via `_mm_crc32_u64` (intrinsic, needs
  `-msse4.2` — already covered by `-march=native`). Feed the 64 bytes as 8× `u64`. Guard
  with `__builtin_cpu_supports("sse4.2")` at startup; if absent, print to stderr and exit
  non-zero. (Note: this is CRC32C / Castagnoli, which is what the HW instruction computes —
  fine for a throughput number.)
- **siphash**: vendor a small public-domain SipHash-1-3 reference implementation (the
  variant Rust's `DefaultHasher` uses) into the file, or SipHash-2-4 if simpler — document
  which in a comment. It must actually mix all 64 input bytes with a fixed key.
- **sha256**: prefer the x86 SHA-NI intrinsics (`_mm_sha256*`) guarded by
  `__builtin_cpu_supports("sha")`. If SHA-NI is unavailable on the build target, you may
  link OpenSSL's `SHA256` (`-lcrypto`) instead — **but** that would require a Makefile
  change, which is forbidden by this PRD. So: implement SHA-NI with a **portable scalar
  SHA-256 fallback** compiled into the same file for when `__builtin_cpu_supports("sha")`
  is false, and pick at runtime. Do not add link flags.
- Each op hashes the same 64-byte buffer (fill it once in setup with fixed bytes). Return
  the low 64 bits of the digest / hash as the checksum so the compiler keeps the work.

## Expected ballpark

- `crc32` (HW): very fast — multiple GiB/s, low-single-digit ns for 64 bytes.
- `siphash`: ~1 GiB/s-ish, ~10 ns for 64 bytes.
- `sha256`: slowest; ~1 GiB/s with SHA-NI, ~100 ns for 64 bytes. A scalar fallback will be
  slower — note in the PR which path ran (log the chosen implementation to stderr).

## Definition of done

Per `docs/dev-log.md` §5. `./benchmarks/c/build/hash --quick` emits schema-correct JSON
(three records); numbers in ballpark; Running Log entry appended.

## Git

- Branch: `bench/hash` off `main`.
- PR title: `bench: add hash (crc32, siphash, sha256)`
- PR body: what it measures, which SHA-256 path ran (SHA-NI vs scalar) and CRC variant, the
  `--quick` JSON.
