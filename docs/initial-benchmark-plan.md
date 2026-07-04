# LedgerMath — Benchmark Code Brief

**Task:** write a benchmark program that runs on an x86 Intel Linux box and
**prints machine-readable numbers to stdout** (JSON). That's the whole job.
Deployment, database, and website are handled elsewhere — do not build them.

Reference code is in `local/napkin-math/` (git-ignored but present on disk).
Read `local/AGENTS.md` for background.

## What to port

Take these two benchmarks from Napkin Math's Criterion suite in
`local/napkin-math/benches/benchmarks/`:

1. **`memory_read.rs`** — sequential read of a 1 GiB buffer, 4 variants:
   - 1 thread, no SIMD (x86 inline-asm scalar loop)
   - 1 thread, SIMD (AVX2)
   - N threads, no SIMD (one thread pinned per physical core via `core_affinity`)
   - N threads, SIMD
2. **`compressed_memory_read.rs`** — BitPacker u32 integer-unpack (decompression).

You can reuse their code largely as-is. The only real change we need: **emit
structured output**, not Criterion's human-readable console format.

## Output requirement

Print JSON to stdout — one record per benchmark variant. Each record should carry
enough to be stored without re-parsing:

- `benchmark` (e.g. `"memory_read"`)
- `variant` (e.g. `"1 thread, SIMD"`)
- the measured numbers: at least mean and median (nanoseconds or ns/op), and
  throughput (bytes/s) where it applies
- `unit`

If you keep Criterion under the hood, it already writes
`target/criterion/<group>/<bench>/new/estimates.json` and `sample.json` — reading
those and re-printing a clean JSON array to stdout is a fine approach. So is
dropping Criterion and timing directly. Either way: **stdout, JSON, done.**

## Constraints / notes

- **x86 Intel only.** The hot loops use x86 inline asm + AVX2. Don't worry about
  AMD/Graviton.
- Build with `RUSTFLAGS="-C target-cpu=native"`, release mode. Debug numbers are
  meaningless.
- The `local/napkin-math/run` script shows the measurement tuning (turbo off,
  performance governor, HT off, etc.). You don't need to replicate it in code —
  that's an environment concern handled at deploy — but it's useful context for
  why the harness is written the way it is.
- Heads-up: `local/napkin-math`'s README references other Criterion groups
  (`hash`, `syscall`, `sort`, `blob_storage`, …) that **are not in the local
  checkout** — only `memory_read` and `compressed_memory_read` exist. Ignore the
  rest for now.
