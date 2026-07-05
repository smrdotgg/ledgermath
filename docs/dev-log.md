# LedgerMath Dev Log

This is the working memory of the project. If you are an agent picking up a migration
task, **read this whole file first**, then read the specific PRD you were assigned in
`docs/prds/`. Append a Running Log entry (bottom) for every benchmark you land.

---

## 1. North star

LedgerMath is "continuous napkin math." The inspiration is Simon Eskildsen's
[napkin-math](https://github.com/sirupsen/napkin-math) project — a collection of
first-principles performance numbers (how fast can you read 1 GiB of RAM? how long is a
syscall? what's a random SSD read?) that let you estimate whole-system performance by
multiplying a few numbers on a napkin.

The napkin-math checkout lives in `local/napkin-math/` (git-ignored but present on disk).
Read `local/AGENTS.md` for the origin story; the short version of the dream:

- Benchmarks run **daily**, on **every modern machine type**.
- We keep **latency distributions — P50 vs P99 histograms** — not just averages, because
  the tail is where the interesting performance questions live.
- An **active community** contributes benchmarks in **whatever low-level language they
  like**, disassembling and kernel-tuning to squeeze out peak numbers.

Downstream of this repo (not built here, owned by the project lead): the JSON these
benchmarks emit flows into a **database**, then a **website** that displays the numbers,
then an **agent-queryable estimation skill** ("how much would it cost to distribute a
Fortnite update to 30M players?").

Our job in this repo is narrow and well-defined: **produce trustworthy machine-readable
numbers.** Everything above is context for *why*, not scope for *what*.

---

## 2. The contract (read this twice)

**A benchmark is a native binary that prints a JSON array of result records to stdout.
All diagnostics — calibration notes, warnings, errors — go to stderr.**

That's the entire interface. It is what makes the project language-agnostic: a future Go
or Rust or Zig benchmark is a first-class citizen the moment it prints the same JSON
shape. Nothing downstream parses source code, links a library, or knows what language a
benchmark was written in. It reads stdout.

### Result record schema

Every object in the array has exactly these fields:

| Field | Type | Meaning |
|-------|------|---------|
| `benchmark` | string | The benchmark group, e.g. `"memory_read"`. Groups related variants. |
| `variant` | string | The specific configuration, e.g. `"1 thread, SIMD"`. Unique within a benchmark. |
| `unit` | string | Unit of the latency fields. Currently always `"ns/op"`. |
| `mean_ns` | number | Mean time for one operation, nanoseconds. The raw truth. |
| `median_ns` | number | Median of the samples, nanoseconds. More robust to noise. |
| `throughput_bytes_per_second` | number | Derived: `bytes_per_op / (mean_ns / 1e9)`. `0` when an op has no meaningful byte count (e.g. a syscall). |
| `bytes_per_op` | integer | Bytes processed per operation. `0` for latency-only benchmarks. |
| `threads` | integer | Hardware threads the variant used. `1` for single-threaded. |
| `checksum` | integer | A value derived from the actual computed data, used to prove the work happened (see below). Not a measurement — never charted. |
| `samples_ns` | array of number | The individual per-sample timings behind `mean`/`median`. Seed for future P50/P99 histograms — never drop these. |

An agent must not invent, rename, or drop fields. If a new benchmark genuinely needs a
new field, that is a schema change — raise it in the PR description, don't do it silently.

### Why `checksum` exists (the compiler-elision trap)

We compile with `-O3`. If a benchmark's result is never observed, the optimizer will
delete the entire measured loop and you'll report physically impossible numbers (e.g.
memory bandwidth faster than the bus). Every benchmark's hot function must return a value
**derived from the data it processed** (a sum, a hash accumulator, an XOR of outputs),
which `measure()` records as `checksum`. Where a correct answer is knowable ahead of time,
validate it at startup and exit non-zero on mismatch (see `bench_memory_read.c`, which
checks against `expected_sum_range`). A benchmark with no elision guard is not done.

---

## 3. Decisions log

- **C for v1** (2026-07): lowest-level language with the least runtime noise; the hot
  path can drop to inline asm / intrinsics. Not a permanent constraint — the contract is
  language-agnostic on purpose. Per-benchmark language choice is allowed for later tiers
  (e.g. blob storage, which is network-bound, need not be C).
- **EC2 only, never Lambda/Fargate/plain ECS**: the measurement requires root-level
  machine control (CPU governor, page-cache drop, hyperthreading toggle, perf counters)
  and, more fundamentally, **the machine type IS the measurement** — a number is only
  meaningful if it's attributable to a nameable, ownable instance type. Serverless is
  fine for *orchestration* (a scheduler that launches an instance), never for the
  benchmark itself.
- **x86 + AVX2 only, for now**: the memory hot loops use x86 inline asm and AVX2. Files
  guard on this at compile time (`harness.h`). AMD and Graviton are wanted eventually but
  require porting the asm/SIMD paths — out of scope until the Tier 1 CPU/memory/OS
  benchmarks are done.
- **One binary per benchmark**: each `bench_<name>.c` has its own `main()` and links the
  shared harness. This is deliberate — it lets many benchmarks be developed on parallel
  branches that all fork from `main` and **only add files**, so they never conflict at
  merge time. Do not consolidate benchmarks into a shared `main()`.
- **Keep `samples_ns` raw**: the north star is histograms, not averages. We store the raw
  per-sample timings now so percentiles are computable later without re-running anything.
- **Tier 2 disk reads use `O_DIRECT`, not buffered+drop-cache** (2026-07-05): napkin's
  original visited each page once and dropped the page cache between runs — a pattern our
  repeat-the-op harness can't express. Buffered reads would be served from the page cache
  from the second pass onward, silently turning disk benchmarks into RAM benchmarks.
  `O_DIRECT` bypasses the cache so every read hits the device regardless of repetition.
  Cost: alignment rules (4096-aligned buffers/offsets/lengths — use `xalloc(4096, ...)`)
  and a documented deviation from napkin's method. Writes stay buffered (±`fdatasync`) —
  the cache-vs-durable gap is the measurement there.
- **Disk scratch files go through `bench_file_path()`** (2026-07-05): default `/var/tmp`
  (FHS-guaranteed disk-backed), overridable via `LEDGERMATH_BENCH_DIR`, and it refuses
  tmpfs/ramfs outright — `/tmp` is RAM-backed on some distros and a disk benchmark there
  would measure memory. Never hardcode a path.
- **Per-benchmark link libraries via Makefile target-specific variables** (2026-07-05):
  e.g. `$(BUILD)/disk_read_io_uring: LDLIBS += -luring`. Adding one is a harness-owner
  change, not something a benchmark PR does — the no-shared-edits rule stands.

---

## 4. What's built

### Layout (`benchmarks/c/`)

- `harness.h` / `harness.c` — everything shared. Do not duplicate this logic into a
  benchmark file; include the header and call into it.
- One `bench_<name>.c` per benchmark group. Landed so far (Tier 1 complete):
  `memory_read`, `compressed_memory_read`, `memory_write`, `memory_read_random`,
  `syscall`, `hash`, `sort`, `mutex`, `tcp_echo`. Treat these as reference
  implementations — especially `bench_memory_read.c` (threading/NUMA) and
  `bench_memory_read_random.c` (fixed-seed shuffle pattern).
- `Makefile` — wildcard rule: every `bench_*.c` → `build/<name>`, linked against the
  harness. `make`, `make quick`, `make run`, `make clean`. Per-benchmark extra libs via
  target-specific `LDLIBS` (io_uring links `-luring`; needs `liburing-dev` installed).
- `run-all.sh` — runs every built binary and merges their JSON arrays into one array on
  stdout (via python3). Forwards args, so `./run-all.sh --quick` works.

### The harness API (`harness.h`)

- `measure(benchmark, variant, threads, bytes_per_op, fn, ctx, samples, target_ns)` —
  the core. Warms up, calibrates an iteration count until one sample takes ~`target_ns`,
  then takes `samples` timed samples and fills a `result_t` (mean/median/throughput/raw
  samples). `fn(ctx)` returns the checksum.
- `parse_opts(argc, argv)` — parses `[--quick]`, returns `{quick, samples,
  target_calibration_ns}`. `--quick` = smaller buffers, 3 samples, 100ms target (dev/CI
  smoke). Full = 10 samples, 1s target.
- `print_json(results, n)` — the stdout contract. Use it; don't hand-roll JSON.
- Helpers: `xalloc` (aligned alloc-or-die), `now_ns` (`CLOCK_MONOTONIC_RAW`), `die`,
  `expected_sum_range`, `allowed_cpus`, `pin_to_cpu`.
- `bench_file_path(name)` — scratch-file path for disk benchmarks:
  `$LEDGERMATH_BENCH_DIR/ledgermath-<name>.bench`, default dir `/var/tmp`, dies on
  tmpfs/ramfs. Disk benchmarks must use this — never a hardcoded path.

### Notable correctness detail: NUMA first-touch

The threaded `memory_read` variants do **not** allocate one big buffer on the main thread.
Each pinned worker allocates and fills *its own* slice after pinning, so pages land on the
worker's local NUMA node (Linux first-touch policy). Allocating centrally would put all
pages on one node and silently understate all-core bandwidth on multi-socket instances.
Any future multi-threaded benchmark must follow the same pattern.

### Verification status

The scaffold split was verified on **linux/amd64 (gcc:14 in Docker)** on 2026-07-05:
builds warning-clean under `-Wall -Wextra`, `run-all.sh --quick` emits a valid 5-record
JSON array, and all checksums match their expected constants. Note: it cannot build on
macOS/arm64 (the `#error` guards block it) — verify on a real Linux x86_64 box or the
amd64 container.

---

## 5. Definition of done (per benchmark)

A migrated benchmark is done only when **all** of these hold:

1. It is a single new `bench_<name>.c` that includes `harness.h`. **No edits to
   `harness.*`, the `Makefile`, or any other `bench_*.c`.** (If you think the harness is
   missing something, say so in the PR — don't fork shared code onto your branch.)
2. Builds warning-clean: `make -C benchmarks/c` with `-Wall -Wextra`, no warnings.
3. Has a compiler-elision guard: the hot function returns a data-derived checksum, and
   where possible a startup correctness check that exits non-zero on mismatch.
4. `./benchmarks/c/build/<name> --quick` runs and its stdout parses as JSON
   (`python3 -m json.tool`).
5. Emits records matching the schema in §2 exactly — correct `benchmark`/`variant`
   strings as specified by the PRD.
6. Numbers are in the ballpark the PRD gives (a 1000× miss means something is wrong —
   likely elision or a units bug).
7. You appended a Running Log entry below.

---

## 6. Non-goals (do not do these)

- **No database, pipeline, deployment, or website work.** That's owned by the project
  lead. This repo stops at "binary prints JSON."
- **No Tier 3–4 benchmarks yet**: Redis / MySQL (need running services), blob storage /
  S3 (needs buckets + credentials). Tier 1 (CPU / memory / OS) is complete; Tier 2 (disk:
  PRDs 08–11) is in play now.
- **Dev-box disk numbers are smoke tests, not data.** Virtualized VPS storage is noisy
  and unrepresentative; real disk numbers come later from dedicated EC2 hardware with
  local NVMe. Don't tune a benchmark to make VPS numbers look like the ballpark.
- **Don't trust the napkin-math README's benchmark list.** It references Criterion groups
  (`hash`, `syscall`, `sort`, `blob_storage`, …) that **do not exist** in the local
  checkout — only `memory_read` and `compressed_memory_read` are actually there. Port
  from `local/napkin-math/src/main.rs` (the older but real harness), using the line
  references in each PRD.
- **Don't change the JSON schema silently**, don't consolidate binaries, don't remove the
  x86/AVX2 guards.

---

## 7. Running log

- **2026-07-04** — Initial C benchmark runner implemented (`memory_read` ×4 +
  `compressed_memory_read`), single-file. Warmup + calibration + 10-sample harness,
  checksum validation, `--quick` mode, JSON-to-stdout.
- **2026-07-04** — Made threaded `memory_read` allocation NUMA-aware (per-worker
  first-touch). Verified on Linux: all four memory_read variants and compressed checksum
  match expected constants.
- **2026-07-05** — Restructured `benchmarks/c/` into shared harness (`harness.c/.h`) +
  one binary per benchmark (`bench_memory_read.c`, `bench_compressed_memory_read.c`),
  wildcard Makefile, `run-all.sh` JSON merger. Behavior-preserving; verified on
  linux/amd64 (gcc:14). This is the base all Tier 1 migration branches fork from.
- **2026-07-05** — Added standalone `memory_write` C benchmark (`1 thread, Sequential` +
  `1 thread, Random`) with 64-byte elements, setup-time shuffled random order, read-back
  checksum validation, and `--quick` sizing.
- **2026-07-05** — Added `memory_read_random` (`1 thread`) as a single C binary:
  fixed-seed shuffled random reads over 64-byte elements (512 MiB quick / 1 GiB full),
  `MADV_RANDOM` data and `MADV_SEQUENTIAL` index hints, plus checksum validation.
  Verified `make -C benchmarks/c`, `./benchmarks/c/build/memory_read_random --quick`,
  and `python3 -m json.tool`; quick run emitted 112.542 ms/pass over 512 MiB
  (~13.4 ns/element, 4.77 GB/s).
- **2026-07-05** — Added `bench_syscall.c` with `syscall` variants for `getpid`,
  `gettimeofday`, `getrusage`, and `stat`; `getpid` uses `syscall(SYS_getpid)` to
  force the real kernel crossing while `gettimeofday` captures the expected vDSO path.
- **2026-07-05** — Added `hash` benchmark (`crc32`, `siphash`, `sha256`) as
  `bench_hash.c`: hardware CRC32C, SipHash-1-3, SHA-256 with SHA-NI selected on this
  host. Verified `make -C benchmarks/c` and `build/hash --quick` JSON output.
- **2026-07-05** — Added `sort` (`u64`) as a standalone C benchmark using a fixed-seed
  1 MiB unsorted input, per-op copy into scratch, LSD radix sort (no `qsort`), startup
  sortedness validation, and a sparse checksum over the sorted output.
- **2026-07-05** — Added `mutex` contended pthread benchmark (`bench_mutex.c`): measured
  thread and contender pinned to separate allowed CPUs, shared counter checksum guard,
  clean contender join. Verified `make -C benchmarks/c` and `build/mutex --quick` JSON.
- **2026-07-05** — Added `tcp_echo` (`32 KiB`) loopback TCP benchmark as its own C
  binary. The server binds `127.0.0.1:0` on a helper thread, the client measures full
  32 KiB write/read round-trips with TCP_NODELAY and socket timeouts, and the checksum is
  derived from echoed bytes.
- **2026-07-05** — Tier 2 (disk) prep: added `bench_file_path()` harness helper
  (`/var/tmp` default, `LEDGERMATH_BENCH_DIR` override, tmpfs guard), Makefile
  target-specific `LDLIBS` (`-luring` for `disk_read_io_uring`), PRDs 08–11, and the
  O_DIRECT-for-reads decision. Verified on linux/amd64 (gcc:14): all 9 existing binaries
  build clean with the new Makefile; tmpfs guard refuses `/dev/shm`.
- **2026-07-05** — Added `disk_write` (`8 KiB, No fsync` + `8 KiB, fsync`) as a standalone
  C benchmark using `bench_file_path("disk_write")`, fixed-size wraparound writes, startup
  read-back validation, and cleanup on exit. Verified `make -C benchmarks/c` and
  `build/disk_write --quick` JSON; dev VPS smoke-test means were ~2.8 µs without fsync
  and ~174 µs with `fdatasync`.
- _(agents: append your entry here, one per merged benchmark)_
