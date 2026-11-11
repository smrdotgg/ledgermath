# LedgerMath Dev Log

This is the working memory of the project. If you are an agent picking up a migration
task, **read this whole file first**, then read the specific PRD you were assigned in
`docs/prds/`. Append a Running Log entry (bottom) for every benchmark you land.

---

> **Note (2026-11-10).** Sections 3 to 7 describe the July 2026 proof of concept in
> `benchmarks/c/`, `infra/lambda/`, `infra/ec2/` and the stage `smr` of `sst.config.ts`.
> It keeps running beside the new runner until step 4 of the build plan (#36), which
> reverses the decision of Provider abstraction and declarative run spec (#22) to delete
> it. Section 2 is current: `memory_read` and the step-2 runner implement it.

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

**A benchmark is a static native binary that prints a stream of events to stdout, one
JSON object per line. All diagnostics go to stderr.** It receives its parameters and the
Provisioner's outputs as environment variables, and it prints nothing it was told, only
what it observed.

Decided in Provider abstraction and declarative run spec (#22) on 2026-10-24, replacing
the JSON array of result records the proof of concept printed. ADR-0022 records why. The
contract is language-agnostic on purpose: a Go or Rust benchmark is a first-class citizen
the moment it reads the same variables and prints the same lines. The exact shape of each
line is `schemas/events.schema.json`; `scripts/check-events.py` checks what a schema
cannot, the order of the stream.

### Where it lives

| Path | What it is |
|------|------------|
| `benchmarks/harness/c/` | The C harness (`lm.h`, `lm.c`), which prints the stream, and `lm_event.h` and `lm_event.c`, which emit a benchmark's own events and further `observed` events (`lm.c` stays as it is, so `memory_read`'s binary keeps its bytes). A benchmark in another language prints the same lines without them. |
| `benchmarks/<name>/` | One benchmark: its source, a `README.md` (what it measures, its parameters, its observed values, its elision guard, and every difference from July's version), and a `Makefile` offering `make BUILD=static` or `BUILD=dynamic` (one file at `build/<build>/<name>`), `make -s compiler` and `make -s resolved`. Nine are on the stream: `memory_read`, `compressed_memory_read`, `memory_read_random`, `memory_write`, `syscall`, `hash`, `sort`, `tcp_echo` and `mutex`. The other four, the disk benchmarks, are still only July's, in `benchmarks/c/`. |
| `schemas/events.schema.json` | One line of the stream. |
| `scripts/check-events.py` | The order of a stream: `./build/static/memory_read --quick \| python3 scripts/check-events.py --quick`. Needs only Python 3. |
| `scripts/check-scratch.py` | Runs every static build of `schedule.json` as the only file in a `FROM scratch` container, once per parameter set, and checks each stream. A set asking for CPUs this machine's topology cannot provide (`mutex`'s `distinct_cores` or `smt_siblings`) is reported as skipped, with the reason, and must exit 2. Needs Docker. |
| `schedule.json` | What a box runs: benchmarks, builds, samples, timeout, parameter sets. Not part of the runner. |
| `runner/` | The box side. `box.sh` is the user-data; `run.py` builds, launches each binary, dumps the environment around it and writes one Run per execution; `cpuid.c` is the raw cpuid dump. |
| `schemas/run.schema.json` | The Run, which holds the stream as `events`. |
| `scripts/check-runs.ts` | Checks Runs laid out as in the bucket: schemas, file names, every hash, events against stdout, stream order, and each runner manifest against the source archive when that is present. |

The benchmarks on the stream, each with one parameter set per execution. The values are
`schedule.json`'s; each `README.md` says what every key means.

| Benchmark | Parameters (`LM_PARAM_*`) | Observed | July's variants |
|---|---|---|---|
| `memory_read` | `size_bytes` 1 GiB, `threads` `1` or `all`, `path` `scalar` or `avx2` | `bytes_per_repetition`, `threads_used`, `path_taken` | the four of `memory_read` |
| `compressed_memory_read` | `blocks` 1000000, `bits` 8 | `bytes_per_repetition`, `compressed_bytes_per_repetition`, `blocks_verified`, `bits_per_value` | `bitpacker` |
| `memory_read_random` | `size_bytes` 1 GiB, `threads` `1` | `bytes_per_repetition`, `reads_per_repetition`, `threads_used` | `1 thread` |
| `memory_write` | `size_bytes` 1 GiB, `threads` `1`, `order` `sequential` or `random` | `bytes_per_repetition`, `threads_used`, `order_taken` | `1 thread, Sequential`, `1 thread, Random` |
| `syscall` | `call` `getpid`, `gettimeofday`, `getrusage` or `stat`; `path` `/tmp` with `stat` | `call_made`; `path_fs_type` with `stat` | `getpid`, `gettimeofday`, `getrusage`, `stat` |
| `hash` | `algorithm` `crc32`, `siphash` or `sha256`, `size_bytes` 64 | `bytes_per_repetition`, `algorithm_run`, `path_taken` | `crc32`, `siphash`, `sha256` |
| `sort` | `size_bytes` 1 MiB | `bytes_per_repetition` | `u64` |
| `tcp_echo` | `size_bytes` 32 KiB | `bytes_per_repetition` | `32 KiB` |
| `mutex` | `threads` `1` with `placement` `one_cpu`, or `2` with `distinct_cores` or `smt_siblings`; `critical_section_lines` `1`, or `8` with `distinct_cores`; `lock` `pthread_mutex_default` | `threads_used`, `cpus`, `core_ids`, `package_ids`, `lock_type`, `libc`, `critical_sections_per_repetition`, `protected_lines`; its own events `cpu_pair` and `mutex_threads` | none: July's `contended` Series ends, and this is a new measurement |

### What the binary receives

Exactly these environment variables and nothing else:

- `LM_PARAM_<KEY>` for every parameter of the Variant, key upper-cased. Values are plain
  strings: integers in decimal, booleans as `true` or `false`, strings verbatim.
- `LM_<ROLE>_<OUTPUT>` for every output of every role's Provisioner, such as
  `LM_BOX_DISK_DEVICE=/dev/nvme1n1`, `LM_BOX_FILE_PATH=/mnt/lm/fixture`, or
  `LM_SERVICE_URL_REGIONAL=https://…`. None exist yet: there is no Provisioner in step 2,
  and `memory_read` needs none.
- `LM_SAMPLES`, the number of counted samples to take, a Benchmark constant (default 10).

`runner/run.py` gives the binary exactly these variables and no others (no `PATH`, no
`HOME`), an empty working directory, stdin from `/dev/null` and files for stdout and
stderr, and launches it as an ordinary process with nothing wrapped around it.

A `memory_read` Run of the Variant "1 thread, AVX2, 4 GiB" sees
`LM_PARAM_SIZE_BYTES=4294967296`, `LM_PARAM_THREADS=1`, `LM_PARAM_PATH=avx2`, and
`LM_SAMPLES=10`. The `--quick` flag remains a developer convenience for small buffers and
few samples; its output never enters the Ledger.

### What the binary prints

Newline-delimited JSON, UTF-8, one complete object per line, no blank lines, nothing else
on stdout. Every object has `event` and `t`, where `t` is whole nanoseconds from
`CLOCK_MONOTONIC_RAW`. Six events are universal and the harness emits them:

| Event | Fields besides `t` | Meaning |
|-------|--------------------|---------|
| `started` | `schema` (`ledgermath.events/1`), `wall_utc`, `clock`, `clock_read_ns`, `quick` | Always first. `clock_read_ns` is the measured cost of one clock read on this box, so every interval carries an error bound. `quick` is `true` under `--quick`, whose stream is never recorded; the schema lets it be absent, and the C harness always prints it. |
| `observed` | `values` | The observed counterparts of the declared parameters, as the benchmark documents them (`memory_read`: `bytes_per_repetition`, `threads_used`, `path_taken`): bytes actually copied per repetition, threads actually joined, the code path actually dispatched. Never a value read back from the environment. May be emitted more than once, anywhere between `started` and `finished`, each key exactly once; a Service Benchmark emits what it learned from responses after its last sample. |
| `sample_started` | `sample`, `warmup`, `repetitions` | Opens one sample. Warmup samples are emitted and tagged, never dropped. |
| `sample_ended` | `sample` | Closes it. The sample's time is the difference of the two `t` values; dividing by `repetitions` is a Method's job, not the binary's. |
| `verified` | `checksum` | The elision guard, as a hex string (`0x` and sixteen lowercase digits). Exactly once. |
| `finished` | | Always last. Its absence is evidence of a crash. |

A Benchmark with phases of its own, such as `http_get` with `connected` and `first_byte`,
documents those event names and fields beside its source and emits them in the same
stream, anywhere between `started` and `finished`. They may not reuse the six universal
names.

A Benchmark that talks to a Service speaks HTTP over TLS itself: no provider SDK on the
measured path, no automatic retry, and any signing finished before a request's first
timestamp. Every connection and every response, errors included, is an event in the HTTP
event vocabulary the harness exports. Decided in Service benchmark trustworthiness (#19);
ADRs 0026 to 0028 record it.

No clock is read inside a measured interval: two reads per sample, at its edges. The
harness makes intervals long by putting many repetitions between the two edges, and
calibrates the repetition count so one sample lasts about a second. Both of a sample's
events are written after the sample ends, so a binary that dies mid-sample leaves no
trace of that sample in the stream; its exit status and stderr are the evidence.

### What is gone, and why

- `benchmark` and `variant`: declared values. The controller that launched the binary
  knows which Station it is running.
- `mean_ns`, `median_ns`, `throughput_bytes_per_second`, and the per-sample average:
  derivable. Methods compute them from the sample timestamps and repetition counts.
- `unit`: implied by the contract.
- `bytes_per_op` and `threads`: declared values. Their observed counterparts are whatever
  the Benchmark declares under `observed`.

Exit code 0 means the binary completed. Any other exit, a signal, or a missing `finished`
is still a Run: its `exit` holds the code or the signal, with `timeout_seconds` when the
runner's timeout killed it (`schedule.json` sets the limit, 600 seconds for
`memory_read`), and only then: a binary that ended by itself an instant before keeps its
own exit alone. Its `events` are whatever reached the pipe. Nothing in the Run judges
it.
`tests/samples/failures/` holds two such Runs.

When the runner is told to stop (SIGTERM, SIGINT or SIGHUP), it kills the binary it is
running and still writes that execution's Run, after-dump included. If the signal arrived
before the runner collected the binary's exit, the Run's `exit` also holds
`runner_signal`, beside the code or signal the binary actually ended with; a signal that
arrives after that is not written into the Run. Either way the runner starts nothing more,
and the boot summary records `stopped_by` and lists every execution that never started
under `not_run`; those have no Run. The box sends this TERM itself 35 minutes after it
started, so the 45-minute shutdown is only a backstop. `tests/samples/interrupted/` holds
such a boot. Not covered: a SIGKILL of the runner (three minutes after that TERM, or the
kernel's OOM killer) or the box losing power loses the execution in flight, and possibly
the boot summary. The README says what reaches the bucket, and what may not.

### Why `verified` exists (the compiler-elision trap)

We compile with `-O3`. If a benchmark's result is never observed, the optimizer will
delete the entire measured loop and you'll report physically impossible numbers (e.g.
memory bandwidth faster than the bus). Every benchmark's hot function must return a value
**derived from the data it processed** (a sum, a hash accumulator, an XOR of outputs),
which the harness emits as `verified`. Where a correct answer is knowable ahead of time,
validate it at startup and exit non-zero on mismatch. A benchmark with no elision guard
is not done.

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
- **Monorepo: this repo becomes the whole platform** (2026-08-08): the Ledger, Methods /
  Derivations, and the open data interface will be built here, superseding the §1 note
  that downstream is "not built here". Vocabulary is pinned in `CONTEXT.md`; the plan is
  the wayfinder map (issue #12). Targets widen from machines-only to **Machines and
  Services** — the "EC2 only" rule is now scoped as "Machine benchmarks require owned
  machines", not "only machines get benchmarked". The §2 output contract stays the
  runner-side foundation.

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
- **2026-07-05** — Added `disk_read_sequential` (`8 KiB`) as an O_DIRECT C benchmark:
  setup creates a 256 MiB quick / 1 GiB full deterministic scratch file via
  `bench_file_path()`, validates block 0, reads 8 KiB at sequential offsets with wraparound,
  and removes the scratch file on exit. Verified `make -C benchmarks/c` and
  `build/disk_read_sequential --quick` through `python3 -m json.tool`; quick run emitted
  ~100 us/op (~82 MB/s) on this virtualized disk.
- **2026-07-05** — Added `disk_read_random` (`8 KiB`) as `bench_disk_read_random.c`:
  creates a 256 MiB quick / 4 GiB full scratch file via `bench_file_path()`, fills 8 KiB
  blocks with an offset-derived pattern, reads via `O_DIRECT` in fixed-seed shuffled
  full-block order, validates block 0, and accumulates first-u64 checksums. Verified
  `make -C benchmarks/c`, `build/disk_read_random --quick`, and `python3 -m json.tool`;
  quick run emitted 98.799 us/op (~82.9 MB/s). Note: random ≈ sequential (~100 µs both)
  on this dev VPS — expected storage weirdness, not a methodology bug: with O_DIRECT QD1
  there is no readahead, and the virtualized disk's per-request latency dominates both
  access patterns. Real NVMe numbers from dedicated hardware should show the gap.
- **2026-07-05** — Added `disk_read_io_uring` (`32 KiB × 64 in flight`) as a standalone C
  benchmark using `O_DIRECT`, liburing queue depth 64, 64 separate aligned buffers, and an
  offset-derived scratch-file pattern validated before measurement. Verified
  `make -C benchmarks/c`, `build/disk_read_io_uring --quick`, and `python3 -m json.tool`;
  quick run emitted 1.303 ms per 2 MiB batch (~1.61 GB/s) on this dev box — ~20× PRD 09's
  QD1 sequential throughput on the same VPS.
- **2026-11-10** — Step 2 of the build plan (#36, brief #37), not yet deployed. The C
  harness `benchmarks/harness/c/` prints the event stream and `memory_read` moved to
  it. `runner/run.py` writes one Run per execution with the environment dumped around
  it, and on SIGTERM still records the execution in flight; `runner/box.sh` is the box's
  user-data (45-minute shutdown timer, image packages, source archive, a 35-minute budget
  for `run.py`, upload of only the blobs the bucket lacks and of Runs only after all their
  blobs, shutdown). The `-runs` SST stage (`infra/runs/`) pins `ami-03499a87bbb39a09a`,
  versions its bucket, and launches a `c6i.8xlarge` in `us-east-2c` at 22:10 UTC, never
  retried, one box per scheduled slot, and not at all when more than ten minutes late.
  `scripts/box-in-container/run.sh` boots `box.sh` in `amazonlinux:2023.12.20260710.0`,
  the image's release (Python 3.9.25, gcc 11.5.0, glibc-static 2.34): the whole
  schedule ran, eight Runs, every hash resolving, and so did its failure scenarios
  (stopped mid-execution, budget run out, blobs refused or dropped). Sample Runs and the
  schema test are in `tests/`; `.github/workflows/check.yml` runs the `FROM scratch` check
  and the tests.
- **2026-11-11** — Step 4 of the build plan (#36, brief #42), first part, not yet
  deployed. Seven of July's benchmarks moved to the event stream, each in its own
  directory with a `README.md` listing every difference from July's version:
  `compressed_memory_read`, `memory_read_random`, `memory_write`, `syscall`, `hash`,
  `sort`, `tcp_echo`. Each reads its parameters from `LM_PARAM_*` and runs one parameter
  set per process, so July's multi-variant binaries became 13 executions, each built
  static only. The measured code is July's: built by gcc 11.5 with July's flags, the
  measured functions' machine code is identical to July's except in `syscall`, whose
  four functions differ by an instruction or two beside the system call, and
  `tcp_echo`, whose round trip now takes its length from a variable. `lm.c` and `lm.h`
  are unchanged, and `memory_read`'s static binary still hashes to `a3674893…`.
  `scripts/check-scratch.py` runs every static build alone in a `FROM scratch`
  container, once per scheduled parameter set; `check.yml` runs it. The container
  test's full-schedule scenarios now require one Run of every scheduled execution, each
  exiting 0. A whole boot in `amazonlinux:2023.12.20260710.0` took about 6.6 minutes:
  21 s before `run.py`, then 376 s for the 21 executions (13 to 23 s each, 0.2 to 0.8 s
  of dumps and builds between them), of which the seven new benchmarks took 233 s. All
  seven scenarios pass. The new binaries came out byte-identical in two separate
  container builds.
- **2026-11-11** — Step 4 of the build plan (#36, brief #42), the targets, not yet
  deployed. `schedule.json` names the targets: `c6i.8xlarge`, `m5.large`, `c8i.2xlarge`,
  `c8a.2xlarge` and `i4i.2xlarge`, all in `us-east-2c`, booting at 04, 10, 16 and 22 UTC
  at :10, :20, :30, :40 and :50 respectively (58 vCPUs if all are up at once, 62 with the
  dev machine). The five types are offered in `us-east-2c`
  (`describe-instance-type-offerings`, this day). A benchmark entry may carry
  `instance_types`; two entries may share a name. `infra/runs/schedule.ts` is the one
  check of the file, run by the tests and at deploy; while July's pipeline runs it
  refuses a `c6i.8xlarge` boot from 22:20 to 23:40 UTC. `infra/runs/placement.ts` reads
  the targets and makes one EventBridge schedule per target (per minute past the hour,
  one each today), such as `cron(10 4,10,16,22 * * ? *)` with the payload
  `{"scheduledTime": "<aws.scheduler.scheduled-time>", "instanceType": "c6i.8xlarge"}`;
  the stack makes one launch function (`BoxLaunchHandler`) and a `CronV2` per schedule
  invoking it. Every payload names its instance type. A scheduled launch is refused
  when more than ten minutes late or when its type is not a target; the client token is
  the sha256 of the stage, the type and the scheduled time. `run.py` runs the entries
  for the type IMDS gives (none of the restricted ones when IMDS gives none), builds each
  benchmark once however many entries name it, and lists the executions of the other
  entries under a new boot summary field, `left_out`; the Run record is unchanged, but
  the runner's hash changes. The alarm watches every entry on every target it is for,
  and lists a Series that has never had a Run only once `schedule.json` has been
  unchanged on main for 48 hours (the workflow passes the commit time with
  `--schedule-changed-at`). The container test's new `instance-types` scenario runs a
  fake IMDS in a sidecar container whose network namespace the box joins, so the host's
  own IMDS is untouched; the box said `m5.large`, ran the two `syscall` entries for it
  from one build, and left out three executions, in about a minute. The `ok` scenario
  still runs the whole schedule (21 Runs; this machine is an `m6id.xlarge`, not a
  target, and no entry names types yet, so nothing is left out). Deploying this removes
  the stage's `BoxLaunch` CronV2, whose 22:10 schedule and scheduler role are deleted,
  and adds five `CronV2`s, each a schedule and a role. The launch function stays: a
  Pulumi alias to its old parent makes the standalone `BoxLaunchHandler` the same
  resource, so it is updated in place and keeps its name and its log group. None of
  this was checked with `sst diff`.
- **2026-11-11** — Step 4 of the build plan (#36, brief #42), `mutex`, not yet deployed.
  `benchmarks/mutex/` is the design of section 1.4 of the brief's study, as the decisions
  on it settled: one repetition is exactly 10,000 critical sections done by whichever
  threads win the lock, timed per critical section across all threads; the main thread
  is thread 0 and works too, releasing the others through a generation word they spin on
  with `pause`, never a barrier; the binary pins its threads from sysfs topology
  (`one_cpu`, `distinct_cores`, `smt_siblings`) and exits 2 after `started`, saying why,
  when the CPUs it may run on cannot provide the placement. Its own events are
  `cpu_pair` (the cache line round trip between the pinned CPUs, before measuring) and
  `mutex_threads` (each thread's work, acquisitions, context switches and CPU time, after
  measuring); they pass the events schema, `check-events.py` and the Method's stream
  check. They are emitted by a new harness file, `lm_event.h` and `lm_event.c`, which
  also gives a further `observed`, for the disk benchmarks next. One departure from the
  study: its guard (the counter equals 10,000 × every repetition, and every protected
  line equals the counter) cannot see a race with one protected line, because the counter
  is also the loop's stopping condition and still ends at its target; so the guard also
  checks that the threads' own counts of critical sections add up to the counter. With
  the lock skipped in one thread, or the other lines written outside it, the binary
  exits 1. `schedule.json` has the study's three entries, with `instance_types`.
  `check-scratch.py` now builds each benchmark once, decides from this machine's topology
  which `mutex` sets it can place, reports the rest as skipped with the reason (each must
  still exit 2) and fails a benchmark none of whose sets ran; under `taskset -c 1`,
  `1,3` and `0,1` it skipped exactly the sets those CPUs cannot provide. `lm.c` and `lm.h`
  are unchanged: built in the Amazon Linux 2023 container, `memory_read` still hashes to
  `a3674893…`, and the seven ported binaries hash as at `e112646`, `compressed_memory_read`
  included, whose README and comments now give its pool's size (244 MiB) instead of
  saying it exceeds every cache. All eight container scenarios pass: `ok` ran 22
  executions in 399 s of `run.py` (435 s for the boot; `mutex`'s one-thread set took
  19 s) and left out the three two-thread sets, because this machine is not a target;
  `instance-types` ran `mutex`'s one-thread and siblings sets from one build. The timings
  on this shared machine (4 vCPUs, 2 cores, with other work holding the load at 3 to 7)
  are not data. Of 15 executions of each set (three rounds of five, through `run.py`'s
  own `execute`), only the two or three per set in which every thread held at least 95%
  of its CPU (from `mutex_threads`) measured the lock: 4.5 ns a critical section for one
  thread, 71 and 83 ns on distinct cores, 113 to 207 ns with eight lines, and 68.6 to
  69.7 ns on siblings, within 0.2 to 3.5% from sample to sample, with a cache line round
  trip of 104 to 108 ns between the cores and 47 to 49 ns between the siblings; that is
  the range the study measured (5.9, 92, 128 and 75 ns). In the others the threads held
  40 to 80% of their CPUs, with thousands of involuntary switches, and the values were
  two to four times those. What only boxes can settle is item 15 of the study: about 20
  boots per type, the one-thread spread on a stock box, and whether the two-thread value
  follows `cpu_pair`.
- _(agents: append your entry here, one per merged benchmark)_
