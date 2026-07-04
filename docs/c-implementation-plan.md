# C Implementation Plan

Replace Rust/Criterion with a single C11 binary, direct timing, no dependencies — built with a plain Makefile.

## File structure

```
benchmarks/c/
├── ledgermath_bench.c   # everything: harness, hot loops, JSON output
└── Makefile
```

`ledgermath_bench.c` targets ~600 lines, straightforward to audit and build.

## 1. Timing harness

- `clock_gettime(CLOCK_MONOTONIC_RAW)` for wall-clock timing
- Warmup phase (run benchmark once)
- Calibration phase (double iterations until the run takes ≥1 s) to determine `iterations_per_sample`
- 10 measured samples (matches Napkin's `sample_size(10)`)
- Per-sample timing: run benchmark N times with no per-op overhead
- Compute `mean_ns`, `median_ns`, `throughput_bytes_per_second`
- Include raw `samples_ns[]` in JSON output for future histograms (see `local/AGENTS.md`)

## 2. memory_read (1 GiB buffer of `uint64_t`)

| Variant | Implementation |
|---|---|
| 1 thread, No SIMD | x86 inline asm scalar loop: `mov` / `add` per 8-byte element |
| 1 thread, SIMD | AVX2 intrinsics: `_mm256_loadu_si256` + `_mm256_add_epi64`, 4 accumulators |
| N threads, No SIMD | `pthread` workers pinned to allowed CPUs; same scalar loop per worker |
| N threads, SIMD | Same worker harness using AVX2 read loop |

Threaded variant uses `pthread_barrier_t` to synchronise start/end around the measured
region — exactly matching the Napkin `Barrier` pattern. `sched_setaffinity` for pinning.

Each op does a full pass over the shared buffer and returns an XOR-checksum
(to prevent the compiler from eliding the loop; the value is printed in the output for
auditability).

## 3. compressed_memory_read (BitPacker8x, num_bits=8, no delta)

Port only the exact path Napkin uses — **not** a full `bitpacking` crate port.

- Allocate 1,000,000 blocks of 256 `uint8_t` (= 256 MB)
- Generate data equivalent to Napkin: `data[0..255] = 0..255`, so `num_bits = 8`
- Compressed block layout matches BitPacker8x with 8-bit packing: each `uint32_t` in the
  256-element block packs directly into one byte, so a compressed block is exactly 256 bytes
- Hot path (`__attribute__((noinline))`):
  - Read one 256-byte compressed block
  - Expand each byte into a `uint32_t` and store into a 256-element `uint32_t` output buffer
  - XOR-output accumulator to prevent elision
  - Cycle through blocks in a round-robin (index wraps at 1,000,000) to avoid L1/L2 caching
    of the decompressed output across iterations
- Throughput unit: 1024 bytes (one block decompressed), matching Rust benchmark

A generalised BitPacker8x C port (all 0..32 bit widths) can come later when more
compressed benchmark scenarios are needed.

## 4. JSON output

```
[
  {
    "benchmark": "memory_read",
    "variant": "1 thread, No SIMD",
    "unit": "ns/op",
    "mean_ns": 123.4,
    "median_ns": 120.0,
    "throughput_bytes_per_second": 123456789.0,
    "bytes_per_op": 1073741824,
    "threads": 1,
    "checksum": 123456,
    "samples_ns": [120.0, 121.0, ...]
  }
]
```

Output is pretty-printed for readability; post-processing pipeline consumes it line by line.

## 5. Verification checks

Compile-time:
- `#error` if not `__linux__` + `__x86_64__`
- `#error` if not compiled with `-march=native` (heuristic: check `__AVX2__`)

Run-time (early abort):
- Verify AVX2 via `__builtin_cpu_supports("avx2")`
- Check `num_online_cpus()` matches expected physical count
- Validate memory-read checksums
- Validate decompressed block equals 0..255

## 6. Makefile

```make
CC      ?= gcc
CFLAGS  ?= -O3 -march=native -std=c11 -Wall -Wextra -D_GNU_SOURCE
LDFLAGS ?= -pthread

TARGET := build/ledgermath-bench
SRC    := ledgermath_bench.c

all: $(TARGET)

$(TARGET): $(SRC)
	mkdir -p build
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

run: $(TARGET)
	./$(TARGET)

quick: $(TARGET)
	./$(TARGET) --quick

clean:
	rm -rf build
```

A `--quick` flag halves buffer sizes and reduces iterations for fast dev cycles.

## 7. What comes after

- Add new C benchmarks without touching the harness (just add a `struct benchmark` entry)
- Infrastructure deploys the binary, runs it with turbo off / performance governor / HT off
  (see Napkin's `run` script), collects JSON, ships to the database
- Future: generalise BitPacker8x for arbitrary num_bits, add delta-encoding variants
