# ledgermath

LedgerMath is a server benchmarking tool. The first benchmark runner is a single C11 binary that emits JSON to stdout.

## C benchmarks

```bash
make -C benchmarks/c
make -C benchmarks/c quick   # development run, smaller buffers/fewer samples
make -C benchmarks/c run     # full run
```

The binary is built at `benchmarks/c/build/ledgermath-bench` and currently requires Linux x86_64 with AVX2. Build uses `-O3 -march=native`.

Current benchmark records:

- `memory_read`: 1 thread scalar, 1 thread AVX2, all allowed CPUs scalar, all allowed CPUs AVX2
- `compressed_memory_read`: BitPacker8x-compatible 8-bit unpack path

Stdout is a JSON array; diagnostic/calibration messages go to stderr.
