# PRD 08 — `disk_write`

## Goal

Measure sequential disk write cost, with and without durability. The napkin insight is the
enormous gap between "write into the page cache" (microseconds) and "write and make it
durable with fsync" (hundreds of microseconds on real NVMe) — the price every database
pays per committed transaction.

## Prerequisite

Read `docs/dev-log.md` first (contract, schema, checksum rule, definition of done, and the
Tier 2 disk conventions in the decisions log).

## Deliverable

A single new file `benchmarks/c/bench_disk_write.c` with its own `main()`, including
`harness.h`. **Do not edit `harness.*`, the `Makefile`, or any other file** except
appending your Running Log entry to `docs/dev-log.md`.

## Records to emit

| `benchmark` | `variant` | `threads` | `bytes_per_op` |
|-------------|-----------|-----------|----------------|
| `disk_write` | `8 KiB, No fsync` | 1 | 8192 |
| `disk_write` | `8 KiB, fsync` | 1 | 8192 |

## Source to port

`local/napkin-math/src/main.rs`: `disk_write_sequential_no_fsync` (~641),
`disk_write_sequential_fsync` (~607). The originals append forever; we adapt to a bounded
wrap-around model (below) so disk usage is fixed.

## Implementation requirements

- **File location**: use the harness's `bench_file_path("disk_write")` — never a hardcoded
  path. It handles `LEDGERMATH_BENCH_DIR`, defaults to `/var/tmp`, and refuses tmpfs.
  Delete the file on exit (and pre-delete any stale one at startup).
- **Bounded size**: preallocate the file to FILE_BYTES (full: 1 GiB, `--quick`: 256 MiB)
  once in setup (write zeros or use `ftruncate` + a full write pass, then `fdatasync`).
- **The timed op**: write one 8 KiB buffer at the current offset, advance by 8 KiB, wrap
  to offset 0 at end of file. The `fsync` variant additionally calls `fdatasync(fd)` after
  every write (matches the Rust original's `sync_data()`). Plain buffered I/O — **no
  O_DIRECT here**; the two variants exist precisely to show page-cache write vs durable
  write.
- **Checksum**: fill the 8 KiB buffer once in setup with a fixed-seed pattern; per op,
  accumulate a value that depends on the write having been issued (e.g. add the buffer's
  first u64 plus the offset written). Syscalls can't be compiler-elided, but the checksum
  chain keeps the harness contract honest.
- **Startup validation**: after one warm-up write, `pread` the 8 KiB back and `memcmp`
  against the buffer; exit non-zero on mismatch. This proves data actually reaches the
  file.
- Handle short writes (loop until 8192 bytes written). Check every syscall's return.

## Expected ballpark

- `No fsync`: single-digit **microseconds** per 8 KiB (it's a memcpy into the page cache
  plus syscall overhead). GiB/s-scale "throughput" is normal here — label honesty comes
  from the variant name.
- `fsync`: hundreds of microseconds to a few **milliseconds** per op depending on the
  device (real NVMe ~300 µs; a virtualized VPS disk can be worse or suspiciously better).
  **The gap between the two variants is the signal.** If `fsync` ≈ `No fsync`, durability
  isn't reaching the device — that's a bug (or lying virtualized storage; note it in the
  dev-log entry).
- Note: numbers measured on the dev VPS are smoke-test-only (virtualized storage). Real
  numbers come from dedicated EC2 hardware later. Say this in your PR body if your numbers
  look odd.

## Definition of done

Per `docs/dev-log.md` §5. `./benchmarks/c/build/disk_write --quick` emits schema-correct
JSON (two records); file cleaned up on exit; Running Log entry appended.

## Git

- Branch: `bench/disk-write` off `main`.
- PR title: `bench: add disk_write (8 KiB, ±fsync)`
- PR body: what it measures and the observed fsync/no-fsync gap.
