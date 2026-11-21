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
>
> **Note (2026-11-13).** July's pipeline was retired on 2026-11-13 (section 7, that day).
> Its code stays as sections 3 to 7 describe it; the stage `smr` must not be deployed.

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
JSON object per line. All diagnostics go to stderr.** It receives its parameters, and the
inputs of any Service it measures, as environment variables, and it prints nothing it was
told, only what it observed.

Decided in Provider abstraction and declarative run spec (#22) on 2026-10-24, replacing
the JSON array of result records the proof of concept printed. ADR-0022 records why. The
contract is language-agnostic on purpose: a Go or Rust benchmark is a first-class citizen
the moment it reads the same variables and prints the same lines. The exact shape of each
line is `schemas/events.schema.json`; `scripts/check-events.py` checks what a schema
cannot, the order of the stream.

### Where it lives

| Path | What it is |
|------|------------|
| `benchmarks/harness/c/` | The C harness (`lm.h`, `lm.c`), which prints the stream; `lm_event.h` and `lm_event.c`, which emit a benchmark's own events and further `observed` events; `lm_fixed.h` and `lm_fixed.c`, samples of fixed work with a step before each outside its interval (`disk_read_sequential`); `lm_disk.h` and `lm_disk.c`, what the disk benchmarks observe about the file they opened and its device, and their `device_counters` event; and `lm_fixture.h`, the disk Fixture's pattern, defined once. For `http_get`: `lm_lines.h` and `lm_lines.c`, a request's events built in one buffer and written after it ends, each received field decided once on the text written, and a guard that replaces any line still holding a registered secret; `lm_dns`, `lm_http`, `lm_sigv4` and `lm_tls` (a DNS client, an HTTP/1.1 parser, SigV4 signing, and AWS-LC with its offer pinned); `vendor/aws-lc.lock`, which pins AWS-LC's source archive by hash, with `vendor/build-aws-lc.sh` and `vendor/fetch-aws-lc.sh`. `lm.c` stays as it is, so `memory_read`'s binary keeps its bytes. A benchmark in another language prints the same lines without them. |
| `benchmarks/<name>/` | One benchmark: its source, a `README.md` (what it measures, its parameters, its observed values, its elision guard, and every difference from July's version), and a `Makefile` offering `make BUILD=static` or `BUILD=dynamic` (one file at `build/<build>/<name>`), `make -s compiler` and `make -s resolved`. All thirteen are on the stream: `memory_read`, `compressed_memory_read`, `memory_read_random`, `memory_write`, `syscall`, `hash`, `sort`, `tcp_echo`, `mutex`, `disk_read_random`, `disk_read_io_uring`, `disk_read_sequential` and `disk_write`. July's copies stay in `benchmarks/c/`, the code of the retired proof of concept. |
| `schemas/events.schema.json` | One line of the stream. |
| `scripts/check-events.py` | The order of a stream: `./build/static/memory_read --quick \| python3 scripts/check-events.py --quick`. Needs only Python 3. |
| `scripts/check-scratch.py` | Runs every static build of `schedule.json` as the only file in a `FROM scratch` container, once per parameter set, and checks each stream. A set asking for CPUs this machine's topology cannot provide (`mutex`'s `distinct_cores` or `smt_siblings`), or for `io_uring` a kernel refuses (`kernel.io_uring_disabled`), is reported as skipped, with the reason, only when the binary refuses it in its own words: exit 2, `started` alone on stdout, and its refusal line for that set on stderr; anything else fails (`tests/check-scratch.test.ts`). The disk sets get a 64 MiB Fixture made by `runner/fixture.c`, mounted at their `dir`. Needs Docker. |
| `schedule.json` | What a box runs: benchmarks, builds, samples, timeout, parameter sets. Not part of the runner. |
| `runner/` | The box side. `box.sh` is the user-data; `provision.py` prepares the disks at boot (the instance's own NVMe disk, where there is one, and the Fixtures, which `fixture.c` writes) and records all it did; `run.py` builds, launches each binary, dumps the environment around it and writes one Run per execution; `cpuid.c` is the raw cpuid dump. |
| `scripts/check-disk-runs.ts` | Checks that every disk Run found the disk its parameters declare (the checker, never the binary, knows what `instance_store` and `root_volume` mean) and that its evidence adds up and its dump bears it out: `file_device` is lsblk's number for the device, the device's model and serial in `/sys`, `device_counters`' change equal to its after minus its before and lying between the dumps', the device's own `nvme amzn stats`, the EBS volume in the EC2 API, the instance-store device number in the provision record. Every number it compares must be present and finite. |
| `schemas/run.schema.json` | The Run, which names its stdout blob, the stream, with the blob's size and lines. Runs written before the runner stopped copying stdout into the record also hold the stream as `events`; every reader reads the blob, for every Run (`readStream`, `methods/run.ts`). |
| `scripts/check-runs.ts` | Checks Runs laid out as in the bucket: schemas, file names, every hash, each stream read from its stdout blob (every event against the events schema, an older Run's `events` against the blob, stream order), and each runner manifest against the source archive when that is present. |

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
| `mutex` | `threads` `1` with `placement` `one_cpu` and `idle_threads` `0` or `1`, or `2` with `distinct_cores` or `smt_siblings` and `idle_threads` `0`; `critical_section_lines` `1`, or `8` with `distinct_cores`; `lock` `pthread_mutex_default` | `threads_used`, `cpus`, `core_ids`, `package_ids`, `lock_type`, `libc`, `critical_sections_per_repetition`, `protected_lines`, then just before measuring `libc_single_threaded`, `process_threads`, `idle_threads_sleeping`; its own events `cpu_pair` and `mutex_threads` | none: July's `contended` Series ends, and this is a new measurement |
| `disk_read_random` | `disk` `root_volume` or `instance_store` (the Series' name, never read by the binary), `dir` (where the Fixture is), `request_bytes` 8192, `span_bytes` 1 GiB or 32 GiB | the file and its device (every disk benchmark: `file_path`, `disk_device`, `disk_model`, `disk_serial`, `fs_type`, `mount_point`, `o_direct`, the queue settings, extents, resident pages; its README lists them), `request_bytes`, `queue_depth`, `span_bytes`, `span_blocks`, `bytes_per_repetition`; its own events `device_counters` and `work` | `8 KiB`, which measured the root EBS volume |
| `disk_read_io_uring` | `disk`, `dir`, `access` `sequential` with `request_bytes` 32768 or `random` with 4096, `queue_depth` 64, `span_bytes` | the file and its device, `access`, `request_bytes`, `queue_depth`, `span_bytes`, `span_blocks`, `bytes_per_repetition`, `ring_sq_entries`, `ring_cq_entries`, `ring_features`; `device_counters`, `work` | `32 KiB × 64 in flight`, whose queue drained to zero each batch |
| `disk_read_sequential` | `disk`, `dir`, `request_bytes` 8192, `bytes_per_sample` 128 MiB or 2 GiB, `span_bytes` | the file and its device, `request_bytes`, `bytes_per_sample`, `span_bytes`, `regions`, `bytes_per_repetition`; `device_counters`, `work` with each sample's resident pages | `8 KiB`, which read with `O_DIRECT`: now a cold buffered read |
| `disk_write` | `disk`, `dir`, `request_bytes` 8192, `sync` `none` (root volume only: the page cache's number) or `fdatasync`, `file_bytes` 256 MiB or 1 GiB | the scratch file and its device, `request_bytes`, `sync_call`, `bytes_per_repetition`; `device_counters`, `work` | `8 KiB, No fsync`, `8 KiB, fsync` |

### What the binary receives

Exactly these environment variables and nothing else:

- `LM_PARAM_<KEY>` for every parameter of the Variant, key upper-cased. Values are plain
  strings: integers in decimal, booleans as `true` or `false`, strings verbatim.
- `LM_SERVICE_<NAME>` for every input of the Service a schedule entry names (`"service":
  "s3_fixtures"`, the stage's private bucket of Fixtures): `LM_SERVICE_ENDPOINT`,
  `LM_SERVICE_REGION`, and three short-lived keys, `LM_SERVICE_AWS_ACCESS_KEY_ID`,
  `LM_SERVICE_AWS_SECRET_ACCESS_KEY` and `LM_SERVICE_AWS_SESSION_TOKEN`, given to that
  entry's executions alone. The Run records the inputs by value and the keys by name
  (`service`), never their values. The spec's general form, `LM_<ROLE>_<OUTPUT>` for every
  output of every role's Provisioner (such as `LM_BOX_DISK_DEVICE=/dev/nvme1n1`), has no
  other instance yet.
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

- `benchmark` and `variant`: declared values. The runner that launched the binary knows
  which benchmark and params it gave, and writes them into the Run.
- `mean_ns`, `median_ns`, `throughput_bytes_per_second`, and the per-sample average:
  derivable. Methods compute them from the sample timestamps and repetition counts.
- `unit`: implied by the contract.
- `bytes_per_op` and `threads`: declared values. Their observed counterparts are whatever
  the Benchmark declares under `observed`.

Exit code 0 means the binary completed. Any other exit, a signal, or a missing `finished`
is still a Run: its `exit` holds the code or the signal, with `timeout_seconds` when the
runner's timeout killed it (`schedule.json` sets the limit, 600 seconds for
`memory_read`), and only then: a binary that ended by itself an instant before keeps its
own exit alone. Its stdout blob holds whatever reached the pipe, and is the Run's events:
the runner copies none of it into the record and parses none of it. A reader that finds a
line that is not an event finds it in the blob. Nothing in the Run judges it.
`tests/samples/failures/` holds two such Runs.

When the runner is told to stop (SIGTERM, SIGINT or SIGHUP), it kills the binary it is
running and still writes that execution's Run, after-dump included. If the signal arrived
before the runner collected the binary's exit, the Run's `exit` also holds
`runner_signal`, beside the code or signal the binary actually ended with; a signal that
arrives after that is not written into the Run. Either way the runner starts nothing more,
and the boot summary records `stopped_by` and lists every execution that never started
under `not_run`; those have no Run. The box sends this TERM itself 35 minutes after it
started, so the 45-minute shutdown is only a backstop. The budget can run out: the disk
sets run last, and on an `i4i.2xlarge` their timeouts alone add up to 33 minutes (18 on
the other types), with provisioning allowed up to 6 minutes before them, so a
misbehaving disk ends the boot this way, with what exists uploaded. `tests/samples/interrupted/` holds
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
- **2026-11-11** — Step 4 of the build plan (#36, brief #42), the disk benchmarks, not yet
  deployed. The four are section 2 of the brief's study as the decisions on it settled,
  each in its own directory with a `README.md`: `disk_read_random` (one `O_DIRECT` read
  at a time, at the offsets of a seeded permutation), `disk_read_io_uring` (a queue of 64
  that stays full, by raw `io_uring` system calls: the image's `liburing-devel` 2.6 has no
  static library), `disk_read_sequential` (cold buffered reads with stock readahead, a
  region per sample, made cold outside the interval) and `disk_write` (the no-sync set,
  the page cache's number, on the root volume only; `fdatasync` on both disks). Every set
  carries `disk` (`root_volume` or `instance_store`, the Series' name, which the binary
  never reads) and `dir`. Each binary reports in `observed` the file it opened and the
  device behind it, and after measuring emits `device_counters`, the change in
  `/sys/block/<disk>/stat` over the measured interval, and `work`. No clock is read
  inside an interval and nothing is timed per operation. New harness files beside
  `lm.c`, which is unchanged: `lm_fixture.h` (the pattern), `lm_disk.{h,c}` (the
  observation and the counters) and `lm_fixed.{h,c}` (samples of fixed work). The box
  prepares the disks at boot: `runner/provision.py`, run by `box.sh` after the packages
  (now with `nvme-cli` and `xfsprogs`) and before `run.py`, finds the instance-store disk
  by its model, compares the count with the catalog, records the disk, refuses anything
  not an empty instance-store disk, makes a default XFS file system, mounts it at
  `/mnt/lm/instance-store`, and has `runner/fixture.c` write the Fixtures (32 GiB there, 1
  GiB under `/var/tmp/ledgermath/disk` on every type) with `O_DIRECT` and `fdatasync`;
  every command, exit code, output and timing goes to one record, which every dump holds
  as `provision`. Its failure never stops the boot. The dump gains `block_stat` and
  `nvme_stats` around every Run (kept apart from `devices`, which stays the same within a
  boot and so is stored once), lsblk's columns, the queue settings, `xfs_info`,
  `/proc/sys/vm/dirty_*`, and once per boot `ec2_instance_type`, `ec2_volumes` and
  `ec2_instance`; the box role gains exactly `ec2:DescribeInstanceTypes`,
  `ec2:DescribeVolumes`, `ec2:DescribeVolumeStatus` and `ec2:DescribeInstances`
  (`infra/runs/box-role.ts`). The Run record is unchanged; nothing restricts dump section
  names. Method version 1 reads the new sections, lists them under what differed, and
  splits on none. `schedule.json` has the study's eleven sets (six on the root volume, five
  on the instance store, for `i4i.2xlarge`; the study's prose counts four), after every
  other benchmark. Departures from the study: a refused
  `io_uring_setup` exits 2 (as `mutex`'s impossible placement does), so
  `check-scratch.py` can skip it from `kernel.io_uring_disabled`; on a file system with
  no `FIEMAP` (tmpfs) the extent checks are skipped and `observed` says so, the checksum
  staying the proof; provisioning refuses when the catalog cannot be read, and when
  there is more than one instance-store disk; the decisions are a Python script so fake
  sysfs trees can test them. Experiments on a real `i4i.2xlarge` (section 2.8, items 1 to
  9): the disk is `nvme1` this boot, model exactly `Amazon EC2 NVMe Instance Storage`, one
  namespace, write through, no FUA, `max_sectors_kb` 128, one 512-byte LBA format;
  `mkfs.xfs` took 6 s with its discard, the 32 GiB Fixture 30 s (1.15 GB/s); random 8 KiB
  reads at queue depth 1 took 120.3 µs at 0, 2 and 5 minutes after it (device mean 111.8
  µs, identical histograms), and fio found sequential equal to random there; a durable
  8 KiB write took 30.1 µs, one device write and no flush; a cold buffered read ran at
  1054 to 1094 MiB/s in 128 KiB requests; at queue depth 64, 199,996 random 4 KiB IOPS
  (AWS's 200,000) and 1356 MiB/s sequential, both at the instance store's limits (its
  exceeded counters grew), from one thread at 29% of a CPU, after a burst of about 2 GiB
  the warmup absorbed; `nvme amzn stats` gives JSON on both disks, with 28 power-of-two
  bins and EBS's field names on the instance store too. On `m5.large` (items 10 to 13):
  582.6 µs for a gp3 read at queue depth 1; the first ~128 MiB or ~4,000 reads of every
  Run burst, then the counted samples hold 125.2 MiB/s and 3000 IOPS; the instance's own
  EBS exceeded counters never moved; the root volume was `initializing`, 0%, at boot, and
  `completed` when next looked at, 6 minutes after launch (11 on the `i4i.2xlarge`); 6.5 GB free after install, 4.33 GB at the least during
  a boot, so the root volume stays the image's default. Whole boots of `box.sh` (S3,
  the EC2 API and shutdown stubbed) took about 13 minutes on the `i4i.2xlarge` (36 Runs;
  provisioning 43 s, the 11 disk executions 240 s) and 10.5 on the `m5.large` (29 Runs),
  against the 35-minute budget; `scripts/check-disk-runs.ts` tied every disk Run to its
  dump. The container test's disk directory is a tmpfs (this machine's disk has no room
  for the schedule's Fixture and scratch file), and its box runs without Docker's seccomp
  filter, which refuses `io_uring`. All other binaries keep their bytes; `memory_read`
  still hashes to `a3674893…`. None of this was checked with `sst diff`.
- **2026-11-11** — Step 4 (#42), what an independent review of `mutex` asked for, not yet
  deployed. **The one-thread number was a special case.** With one working thread and no
  other, glibc 2.34 locks and unlocks a default mutex with plain stores: both functions
  test a per-thread word (`%fs:0x18`, `header.multiple_threads`) that the first
  `pthread_create` sets, together with `__libc_single_threaded`, and only then use
  `lock cmpxchg` and `xchg`. A new parameter, `idle_threads`, on every `mutex` set: with
  1, the binary starts one more thread before the first critical section that blocks for
  the life of the process in `pause()` with every signal blocked, and waits until the
  kernel shows it sleeping. The one-thread entry now has two sets, `idle_threads` 0 and 1;
  the two-thread sets carry 0. A second `observed`, just before measuring, reports
  `libc_single_threaded`, `process_threads` (`/proc/self/status`) and
  `idle_threads_sleeping`. This machine has no hardware counters (no PMU in the guest,
  `perf_event_paranoid` 4), so the proof is a count: a small ptrace tool put breakpoints
  on the four instructions of the Amazon Linux build's glibc (lock's plain `movl $0x1` and
  its `lock cmpxchg`, unlock's plain `movl $0x0` and its `xchg`) and counted the first
  100,000 hits of a full run of each set, by mutex address. With `idle_threads` 0 the
  benchmark's mutex took the plain stores 49,999 and 49,998 times and the atomic
  instructions never; with 1, the atomic ones 49,998 times each and the plain stores
  never (the other few hits were glibc's own `object_mutex`, `_dl_load_write_lock` and
  `_dl_load_tls_lock`, at startup, before the second thread existed). With the machine
  quiet: 4.36 ns a critical section with `idle_threads` 0 and 18.57 ns with 1 (eight runs
  each, 4.35 to 4.39 and 18.56 to 18.59 ns); distinct cores 67.8 and 78.4 ns, eight lines
  282 and 308 ns, siblings 71.0 and 71.5 ns (two runs each). **`check-scratch.py`** now
  reports a skip only when the binary refuses the set in its own words (exit 2, `started`
  alone on stdout, and its refusal line for that set on stderr), for `mutex`'s placements
  and for `io_uring` alike; a stub `mutex` that exits 2 for another reason now fails the
  check where it passed as three skips, a real `io_uring` refusal (Docker's default
  seccomp filter) is accepted, and `tests/check-scratch.test.ts` runs stubs for both and
  the cases around them. **`lm_event.h`** says that it does not serialize writers: events
  come from the thread that owns stdout, between samples, and a line longer than
  `PIPE_BUF` or written while another thread writes can interleave; comments only, and no
  binary that links it changed. **Method version 1** does not fetch `block_stat` or
  `nvme_stats`, which change on every read; `provision`, `ec2_instance_type`,
  `ec2_volumes` and `ec2_instance` were already not split on and listed under what
  differed, and `NOT_SPLIT_ON` now says why for all six; `methods/README.md` says version
  1 may still change until the data is first published. Built in the Amazon Linux 2023
  container, every binary but `mutex` is byte-identical to its build at `b197dd8`, and
  `memory_read` is still `a3674893…`. All eight container scenarios pass (`ok`: 29 Runs,
  8 left out, 574 s while the machine's load was 10 to 15). `tests/fixture.test.ts`
  failed once under that load: its `beforeAll` builds `disk_read_random` within bun's
  default five seconds; alone, with a longer timeout, it passes.
- **2026-11-11** — Step 4 of the build plan (#36, brief #42), the disk build, after an
  independent verifier's review, not yet deployed. Five findings fixed. (1) `disk_write`
  opened its scratch file by name with `O_CREAT | O_TRUNC`, following links: as root on
  the box, a link at that name let it overwrite any file. It now creates it with
  `openat(dir, name, O_CREAT | O_EXCL | O_NOFOLLOW)`, refuses a name that exists in any
  form and touches nothing, preallocates through the same descriptor, and removes the
  file at the end only if the name is still that file. (2) Provisioning checked
  `/dev/<name>` and then formatted that pathname again: a node replaced in between was
  formatted. It now works only through a device node of its own, made with `mknod` for
  the disk's `major:minor` under `/run/ledgermath`; immediately before `mkfs.xfs` it
  checks again that the number names the same disk (by `/sys/dev/block`), the node is
  that number, there is no partition, holder or mount, `blkid -p` exits 2 and prints
  nothing (exit 2 alone also means it could not open the device), and it can read the
  first MiB; after `mount -t xfs` the mounted file system's number, by `stat` and by
  mountinfo, must be the one checked, or it is unmounted (lazily if need be). (3) The
  record was written only at the end, SIGTERM lost it, and a timeout left children
  running. Now the record is replaced whole as provisioning starts and as each step
  starts and ends; every command runs in a process group of its own, killed whole (TERM,
  KILL after five seconds) when it times out or provisioning is stopped, and whatever a
  step leaves behind is killed and recorded; provisioning stops itself at 840 seconds and
  on SIGTERM, recording why. `box.sh` runs it with `--supervise-seconds 900`: a
  supervisor runs it in a session of its own, kills that session when it ends, records
  any unfinished step from its output files, and undoes what a killed provisioning left
  half done. (4) A failed mount left `/mnt/lm/instance-store` as a directory on the root
  volume, where `disk_write`'s instance-store set ran and measured EBS. The mount point is
  now made just before `mount` and removed on any failure, one found at boot is removed
  or moved aside, and the root volume's directory exists only when its Fixture was made;
  `check-disk-runs.ts` also compares the disk found with the disk declared. (5) The
  checker accepted evidence that did not add up: a `file_device` lsblk contradicts, a
  `change` that is not `after` minus `before`, empty counters, NVMe JSON without
  counters (comparisons with `NaN` passed). Each is now a problem, and every number it
  compares must be present and finite. The READMEs now say what `device_counters`
  covers (the whole measuring call and any other I/O on the device) and proves, that
  `disk_read_io_uring` keeps 64 reads submitted (not 64 in the device, which it cannot
  see), and the budget's worst case. The container test drops `CAP_MKNOD`, so
  provisioning there cannot make a node for this machine's own instance-store disk, and
  accepts its tmpfs disk Runs explicitly. The tightened checker passes all 17 disk Runs of
  the two real boots. Only `disk_write`'s binary changed.
- **2026-11-11** — Step 4 of the build plan (#36, brief #42), the disk build, after a
  second review, not yet deployed. (1) The blocker: the private device node lived in
  `/run/ledgermath`, and on the image `/run` is `tmpfs` mounted `nodev` (both real boots'
  own `findmnt`), where a node can be made but not opened, even by root; every
  instance-store Run would have failed. The node now lives in `/dev/ledgermath`
  (devtmpfs, not `nodev`), and provisioning first checks in mountinfo that the
  directory's file system allows device nodes, refusing with the reason otherwise; in a
  root container a node in the `nodev` `/dev/shm` failed to open with `EACCES` exactly
  where the check said it would, and one in `/dev` opened. Runs' `mount_source` will
  read `/dev/ledgermath/instance-store-<major>-<minor>`. (2) The disk is opened
  read-only before the last checks and held until the mounted file system is confirmed;
  the last checks go through that descriptor (device number, `BLKGETSIZE64`, the first
  MiB), and after the mount the model and serial must still be the checked ones. (3) An
  empty or missing model, serial or size, an unlistable holders or partitions directory,
  or an unreadable mount table is a refusal that says which (before, two empty serials
  matched, and the old version prepared and formatted in both reviewer cases). (4)
  Limits of 300, 330 and 360 seconds (they were 840, 900 and 1,000; provisioning takes 44
  on a real `i4i.2xlarge`); the supervisor writes its worker's session id to a file at
  once, and after provisioning returns `box.sh` runs `runner/provision-leftovers.py`,
  which kills what is left in that session, unmounts an instance store the record does
  not say was readied, removes an empty mount point, partial Fixtures and an empty
  root-volume directory, and writes what it did into the record. With the old
  supervisor suspended and then killed, the worker, its tool and its grandchild kept
  running and the record stayed `running`; now nothing is left. GNU `timeout` sends
  SIGCONT with its TERM, so a merely suspended supervisor resumes and stops provisioning
  itself; the supervisor's grace, when it is told to stop, is 5 seconds, inside
  `box.sh`'s 10. (5) A cleanup command that times out keeps its output. (6)
  `check-disk-runs.ts` now refuses a file whose device is not the disk or below it, a
  declared value its observed counterpart contradicts, `work` that disagrees with the
  repetitions or the request size, an NVMe-model disk without its controller or its
  statistics, a counter that is not a safe whole number, and an NVMe counter that goes
  down; the checker at `b1c756c` reported none of the eight cases. It still passes all
  17 disk Runs of the two real boots. (8) The tests no longer depend on timing: the
  stop tests wait for conditions with generous bounds and run side by side with limits
  of 6 to 10 seconds; `runner-races.py` waits for the runner to have launched the binary
  instead of a two-second timer, and its alarm case no longer needs a stand-in to exit
  within a second; tests that run processes have explicit timeouts (`schemas.test.ts`
  had timed out once at 5.2 seconds). Ten runs of `bun test` under `nice -n 10`, with the
  load average at 3.7 to 5.9 on 4 CPUs: 10 passed, 322 tests each. All binaries keep
  their bytes. The `/dev/ledgermath` path has not yet run on a real box: AWS access was
  expired for this round.
- **2026-11-11** — Step 6 of the build plan (#36, brief #45), prices, on branch `prices`,
  not yet merged or run by the workflow. `scripts/fetch-prices.ts` follows AWS's public
  offer index to the versioned `us-east-2` files of `AmazonEC2` (442 MB), `AmazonS3` and
  `AWSDataTransfer`, streams them to disk, and cuts, in one pass that never holds a file
  in memory (`scripts/lib/offer-file.ts`, a byte scanner of AWS's layout; no
  dependency), the products rule set 1 selects (`scripts/lib/price-rules.ts`: each
  scheduled type On-Demand Linux shared tenancy, gp3 storage, IOPS and throughput, S3
  Standard storage and Tier1/Tier2 requests, data out to the internet and its global free
  tier) with their On-Demand terms, verbatim: each record, parsed and written back, must
  equal the file's text with its whitespace removed. Every rule says how many products it
  must select and stops the fetch otherwise. The day's file,
  `prices/<yyyy>/<mm>/<dd>/aws.json` in the Runs repository, names each source's
  versioned URL, version, publication date, size and SHA-256, and is written through the
  Runs repository's add-only writing (moved from the copy job to
  `scripts/lib/runs-repository.ts`); a second run that day does nothing.
  `scripts/check-prices.ts` downloads each source again and requires the recut to be the
  file byte for byte. `prices.yml` runs at 03:17 and 15:17 UTC in `runs.yml`'s
  concurrency group with the same deploy key and no AWS credentials, and the alarm also
  reports a newest price file more than 48 hours old (or none, 48 hours after the
  workflow first existed on main). The real fetch into a scratch clone took 12 s and
  96 MB; the check passed; `m5.large` (SKU `8D49XP354UEYTHGM`, $0.096/h) and S3 Standard
  GET (`DJEKB32FV4HNZJZY`, $0.0000004 per request) match the data AWS's EC2 and S3
  pricing pages render, rate code for rate code. Found about AWS's files: the version
  index lists one version per month or so, but unlisted versions back to 2019 are still
  at their versioned URLs; the gp3 throughput record's unit is `GiBps-mo` at 40.96 while
  its description says $0.04 per MiBps-month.
- **2026-11-11** — Step 6, after an independent review. (1) `addFile`, which the copy job
  and the price fetch both use, ignored the count `writeSync` returned: under `ulimit -f
  16` the fetch "added" a price file of 16,384 bytes out of 34,010, the next fetch said
  it existed, and under `ulimit -f 4` the copy job added eight Run files cut to 4,096
  bytes that every later copy refused. Now it writes until every byte is written, flushes,
  reads the file back through the same descriptor and compares length and bytes before
  the file gets its name; a short write adds nothing and fails loudly. (2) The price
  reader tracked brackets but not JSON's grammar, and kept no record of keys: a source
  with `"products":{},"terms":{}` appended, which `JSON.parse` reads as empty, was cut
  and certified, and the recompute check passed. It now checks the whole file against the
  grammar (structure, strings and escapes, UTF-8, numbers and literals) and refuses any
  repeated top-level member, key under `products` or `terms`, or SKU under a kind of
  terms, and the cut refuses a repeated key inside a record it keeps; on the real files
  its products and On-Demand terms still equal `JSON.parse`'s, all 109,733 and 109,644.
  (3) Every test file the branch added or touched sets a sixty-second default per test
  (`setDefaultTimeout`, per file); no repository-wide setting. Ten full `bun test` runs
  under `nice -n 10`, with the load rising from 1.3 to 7.9, all passed.
- **2026-11-11** — Step 5, first part (branch `http-get`): `http_get`, the binary and all
  that runs without AWS. One static binary (AWS-LC 5.14.0 built from its pinned archive,
  never in git) makes HTTPS GETs to S3: its own DNS query, TCP, TLS, HTTP/1.1 by hand,
  SigV4 by hand before each sample, no retry, one request per sample over a new or a kept
  connection, every phase an event with its own CPU time. An error is an event; the Run
  goes on and exits 4. Nothing secret is printed: credential values are withheld, and
  anything received is printed only if it holds none of our credentials or signatures,
  no key-ID shape and no lone twelve-digit number; a guard refuses any write that holds
  a secret. A Python stand-in for S3 and the resolver (`tests/http-get/standin.py`)
  misbehaves on demand for the tests and for `check-scratch.py`'s scratch container.
  Once, 25 requests to real S3 (a public object unsigned, and invalid credentials signed):
  the `InvalidToken` body echoes the session token, and a twelve-digit rule withheld an
  ETag until it was narrowed. Existing binaries keep their bytes. The runner, the
  stage's bucket and role, the schedule and Method version 2 are the next part;
  `benchmarks/http_get/README.md` lists what they must provide.
- **2026-11-11** — Step 5, the two reviews' findings fixed (branch `http-get`). Clocks:
  a failed write is timed when seen and writes no `request_sent` (it wrote `t` 0 before);
  the parser stops at the end of the header block, so the headers' moment is read before
  any body byte and a block that completed is always `response_headers`; the budget is
  asked before every sample, reopening included; `name_resolved` is read after the reply
  is parsed, its text formatted after the request. Record: all three DNS sections, the
  reply's real length, trailers, bytes after a response in its last record as a protocol
  error; a handshake failure is classified by the library's own error (an alert as the
  alert sent; `verify` only when the check ran), chains are uncut and a refused one is
  kept, TLS 1.2 tickets are counted as tickets, names match subject alternative names
  only. Keys: an error body is never printed (its length, four S3 fields, element
  names); each credential is searched for in its percent, base64, base64url and hex
  forms; one decision per field on the text written; the guard replaces a line instead
  of exiting; NUL is base64; no core file. Tests assert no `t` of 0 and time order in
  every sample, and that one response split three ways gives the same events. The
  reviewers' reflection driver recovered something in 296 of 639 Runs before, 27 after
  (encodings the rule does not claim, listed in the README).
- **2026-11-11** — Step 5, the timing reviewer's second pass (branch `http-get`). A body
  framed by the connection's end that fills the body buffer exactly now completes: the
  binary reads on for the end, and only a further body byte is "larger than the buffer"
  (a 69,632-byte close-delimited 403 failed three times before). Trailer lines read before
  a response fails are kept in the failure. A failed TLS call keeps only what the library
  returned until the clock is read, so failure timestamps no longer include classifying
  and formatting the error. The README's clock table now says that `connection_opened` is
  also written for a failed `connect`, what the Body phase holds, and what the budget is
  counted from (the first request's preparation, its first connection included).
- **2026-11-11** — Step 5 of the build plan (#36, brief #43), second part, on branch
  `http-get-box`, not yet merged or deployed: everything around `http_get`, whose binary
  is on `main` since `460149f`. The stage (`infra/runs/fixtures.ts`, `tls-archive.ts`,
  `stack.ts`) makes a private fixtures bucket holding the three Fixtures, generated in
  TypeScript (equal, byte for byte, to `runner/fixture.c`'s, with the binary README's
  digests). The provider uploads anything over 5 MiB in parts, and S3's SHA-256 of a
  multipart object is a checksum of the parts' checksums, which `http_get` would refuse; so
  each Fixture goes to the Runs bucket as a blob and S3 copies it into the fixtures bucket
  with the SHA256 algorithm (a copy is one part, its checksum over the whole object). A
  role only the box's role may assume can `s3:GetObject` on those three objects and nothing
  else. AWS-LC's source archive becomes a blob too; the deploy stops, saying how to fetch
  it, when the local copy is missing or its hash is not the lock's. The box installs
  `cmake`, `gcc-c++` and `ethtool`, fetches and checks the archive
  (`runner/aws-lc-archive.sh`), and exports it as `AWS_LC_ARCHIVE`; any failure there is
  `http_get`'s build failure alone. A schedule entry may name a Service (`"service":
  "s3_fixtures"`): `run.py` assumes the role once per boot through the `aws` CLI and gives
  the endpoint, the Region and the three keys to that entry's executions alone; the Run
  gains `service` (inputs by value, secret inputs by name); keys that cannot be had leave
  the entry not run, with the reason, and the boot going on. The dump gains, once per
  boot, the subnet's route tables and the VPC's endpoints, and around every Run `network`
  and `net_counters` (`ethtool -S`, `/proc/net/*`), which Method version 1 neither fetches
  nor splits on. `schedule.json` runs the study's five sets last, on every target, as two
  entries (200 and 40 counted requests; one entry holds one `samples`). Checked: `bun test`
  (`tests/service.test.ts` searches everything a boot writes for the stand-in keys, in
  their encodings), `scripts/check-scratch.py` (`http_get`'s five sets against its
  stand-in), and three container boots against the binary's stand-in for S3: a normal one
  (six Runs, every request signed with the stand-in keys, no key in the bucket, the box's
  work directory, its log or an `aws` command line), one with no archive (`http_get` alone
  fails to build) and one with `assume-role` refused (`http_get` not run, with AWS's
  words). AWS-LC built in 34 s at `-j2` here. Run files with every event inside: 981 KB
  and 984 KB for the new-connection sets, 682 KB and 684 KB for the reused ones, 208 KB for
  16 MiB (200 and 40 requests). Read-only AWS showed the stage's default VPC as the study
  assumed: no table on the subnet, `0.0.0.0/0` to an internet gateway in the main table,
  no endpoint; and the image already has `ethtool`.
- **2026-11-11** — Step 5: the stdout blob is every Run's events (brief #43, decision 4,
  the maintainer's rule; the last commit on `http-get-box`, to drop if they change their
  mind before the first S3 Run). `run.py` no longer copies stdout into the Run, nor parses
  it: the Run names its stdout blob, as every Run did, and gives `stdout_bytes` and
  `stdout_lines`. Every reader reads the blob, for every Run, through `readStream`
  (`methods/run.ts`): `check-runs.ts` (each event against the schema, the two facts, and for
  a Run written before, that its `events` equal the blob), `check-disk-runs.ts`, the
  container checks, Method version 1. Runs written before keep their `events` and stay
  valid: still `ledgermath.run/1`, `events` now optional, because nothing else changed and
  a reader's rule is the same for both. Method version 1 gives the same bytes as before for
  the 15 older sample Runs (`tests/samples/older-shape-derivations.json`, made by its code
  before the change) and for the 245 real Runs in the bucket (162 Series, compared with
  `cmp`); it now fetches one more blob per Run, the stdout (816 blobs instead of 571 for
  those Runs, 4.5 KB each on average). Run files: 5.5 to 12.8 KB before for the small
  benchmarks, 1.7 to 2.0 KB now; `http_get`'s, from 208 to 985 KB with events inside to
  3.8 KB.
- **2026-11-11** — Step 5, item 8 of the brief (#43): the Method for Series whose samples
  are requests, on branch `request-percentiles`. It is Method `requests` version 1
  (`methods/requests/v1/`), not version 2 of `series`: `series` v1 goes on charting every
  Series, `http_get`'s included, one number per Run, byte for byte as on `main` for the real
  Runs repository (316 Runs, compared with `cmp`, records kept or not). A Series is the new
  Method's when any of its Runs' streams holds a `response_ended` or `request_failed` with a
  `request`. Per request, the eight phases from the timestamps the binary's README names;
  per Run, each phase's count, least, greatest and percentiles exactly, a percentile only
  when n × (1000 − q) ≥ 1000, with how many requests are ranked at or above it; pooled
  across the Series and series v1's groups through fixed histograms (64 bins per doubling,
  so within 0.78%), with the figures as they stood through each Run kept for citations of
  an earlier moment; broken down by address block, cipher, TLS version and group where more
  than one occurs; failed requests counted by phase and kind, never timed. A Run that exited
  4 counts; one cut short, killed, exiting 1, or breaking the request contract is shown with
  why. Each Method now reduces a stream once to a record kept under
  `<method>-v<version>-r<revision>/<stdout hex>` (`methods/records.ts`), and the workflow
  caches those and the dump blobs, not the stdout blobs. The page gains a part per Series of
  requests (time charts of each Run's median, 95th and 99th of the whole request and of the
  first byte, cumulative distributions with the tail given room, breakdowns, failures); the
  lookup tool, citations (`[lm:requests/<id>/<phase>/<stat>@v1,<moment>]`), checker and skill
  learn the new figures. On the 35 real Runs of 2026-11-11 (the two boots started by hand
  at 21:23 UTC and the 22:10 round on all five types): 5,880 requests, none failed. 4 KiB
  over a new connection, pooled per instance type: 27.4 to 28.7 ms at the median, 33.4 to
  35.4 ms at the 95th, 38.7 to 59.0 ms at the 99th, each 99th resting on the 2 slowest
  requests of a Run. The brief's first look gave 47 and 54 ms at the 99th for the two Runs
  by hand, whose 99th by R type 7 is 37.8 and 43.9 ms: it took the 199th of 200 times, where
  type 7 puts the 99th 1% of the way from the 198th to the 199th. 81% of the new
  connections went to 3.5.0.0/16, 17% to 52.219.0.0/16 and 3% to 16.12.0.0/16; 52.219.0.0/16
  connects in 0.20 to 0.46 ms at the median where 3.5.0.0/16 takes 0.48 to 1.15 ms and
  16.12.0.0/16 0.85 to 1.06 ms, and its TLS handshake is 0.3 to 0.5 ms shorter; the first
  byte does not differ by block. ChaCha20 was negotiated 4 times, all on c8i.2xlarge.
  Records: 784 KB for the 503 Runs (9.5 KB per `http_get` Run for this Method, 3 KB for
  `series`, 0.3 and 0.4 KB for any other), against 19.8 MB of stdout blobs.
- **2026-11-12** — Step 5, item 8, after the review of `request-percentiles` (#36, #43): what
  happens off the happy path. **Kept records**: a record's key is now
  `<method>-v<version>-<16 hex digits of the digest of the code that made it>` (the
  reducer's module, every module it imports, transitively, and the schemas), so a change
  to that code can no longer be forgotten: a record made at `a92d510` was read at `549380c`
  and excluded a whole successful Run. The cost, every stream fetched once more after such a
  change, is accepted. A record is sealed with the sha256 of its content and checked on load
  (counts that are their histograms' sums, every percentile the support rule asks for and no
  other, in order, each between the bins of the times it lies between); an edited 99th
  percentile of 1 ns, a replaced histogram or a deleted percentile is ignored and the stream
  read again. **derive.ts** asks only valid Run files for streams, and runs each Method on its
  own: when one fails, the other's Derivations and the page are still made, the page says
  which part is missing and why, and the workflow run still fails. **Which Runs count**: a
  failed request is held to the binary's order up to where its phase says it got
  (`http_get.c`, `setup_events`, `setup_failure`, `exchange_events`), every event naming a
  request names its sample's, a request on a closed connection breaks the contract, an exit
  0 with a failed warmup or setup contradicts its Run, and a timestamp past 2^53 − 1 keeps
  the Run out (this Method only). **What is said**: the lookup tool describes a Series of
  requests from what its Runs record (params, the Service's inputs, the box's Region, the
  requests' own method, target, signing and TLS) and points to the dumps for the path; the
  distribution is now the true cumulative share, 100% at the slowest request, with a caption
  that says how the axis is drawn; a phase of 0 ns is drawn on the time chart's bottom edge;
  every 99th and 99.9th percentile on the page has its count of requests at or above it; and
  every value the tool prints reads back under the checker's rule (15 real values at
  six-digit rounding boundaries did not). The checker reads numbers, not meaning, and the
  README and the skill now say so for these figures. On the 35 real Runs every figure is as
  before.
- **2026-11-13** — Step 4 of the build plan (#36, brief #42): July's pipeline is retired.
  Its daily launch schedule (stage `smr`) was switched off in AWS by hand at 15:58 UTC,
  after check 6 on #38 passed; its hourly reaper is left on, and its bucket and results,
  the last for 2026-11-12, are kept. Its code stays in the repository, unchanged, as the
  proof of concept the build started from. The stage `smr` must not be deployed: a deploy
  would switch the schedule back on. With it goes the schedule check's rule that refused
  a `c6i.8xlarge` boot from 22:20 to 23:40 UTC (`JULY_RULE` in `infra/runs/schedule.ts`),
  with its tests and the comments and README passages that leaned on July's 23:10 launch.
  The other quota rules (every target's vCPUs together with what is reserved fit the
  quota; one target's boots at least 60 minutes apart) and the launch's protections (never
  retried, a one-minute event age, a scheduled launch more than ten minutes late refused,
  one box per slot) are unchanged: a late or duplicate box wastes money and can overlap
  another box of its own target, which the quota rules count on never happening.
  `schedule.json` and `runner/` are unchanged, so the boot times, what a box runs and the
  runner's hash stay as they were. Not deployed.
- **2026-11-14** — The move to the production account, prepared (#57); nothing deployed,
  nothing written in either account. **Accounts**: `infra/runs/stages.ts` decides which
  account a `-runs` stage deploys to: `production-runs` to the production account (profile
  `tabot-production`), retained and protected; every other to the development account
  (`tabot-dev`), as `smr-runs` always has. `sst.config.ts`'s `app()` takes a `-runs`
  stage's settings from it (now `async`, as SST allows; July's branch returns what it did).
  SST 4.17.0 lets a non-empty `AWS_PROFILE` replace that profile, drops it under
  `SST_AWS_NO_PROFILE`, and gives the provider that makes the resources only `AWS_PROFILE`,
  after keys and a web identity in the environment; so `app()` refuses a `-runs` stage when
  the environment or the `.env` beside `sst.config.ts` holds any of those for another
  account, before SST's first request, and the stack, before it declares anything, compares
  the provider's account with the one the stage's profile reaches
  (`infra/runs/deploy-account.ts`). No recipe exports a profile or keys any more.
  **One scheduled stage**: `SCHEDULED_STAGE`, `smr-runs` until the cutover, is the only stage
  with launch schedules; every other gets the launch function, the reaper, the buckets and
  the roles, and its launch function's list of targets names none, so a scheduled payload
  launches nothing there. With the constant at `smr-runs`, a deploy of `smr-runs` makes the
  same schedules and sets the same list as before; the launch and reaper code is untouched.
  `scripts/check-targets.ts` takes `--stage` and reads that stage's account. **The copy**:
  `scripts/copy-bucket.ts` copies `blobs/`, `runs/`, `boots/` and `logs/` between buckets in
  two accounts, with each profile's exported keys held in memory only, only ever adding,
  and verifies a copy, in either direction (back, for a rollback). Bun's S3 client adds
  `;charset=utf-8` to `application/json` and `text/plain` when it writes, and cannot send
  `If-None-Match`, so the copy writes each object with a PUT signed with the licence work's
  SigV4 signer (`scripts/lib/s3-create.ts`): `If-None-Match: *`, so S3 never replaces an
  object, and the exact type. Read-only against the development bucket: every one of its 30,852 blobs hashes to
  its key; no key has a second version; reading all 627 MB twice took 144 s. **Series**:
  read-only, both default VPCs and their subnets in `use2-az3` were compared (172.31.0.0/16
  and 172.31.32.0/20 in both, the same DHCP options, main route tables and no endpoints)
  and the image was found visible from the production account; what a dump records
  differently there (the account ID and the VPC's IDs in `provider`, `ec2_instance`,
  `ec2_route_tables`, `ec2_vpc_endpoints`; each stage's fixtures bucket in an `http_get`
  Run's Service inputs) is in no split fact, and `tests/account-move.test.ts` shows two such
  boots in one group. **The cutover** is a numbered procedure in the README ("Moving the
  schedule to the production account"). Waiting on the maintainer: the production quota
  (5 vCPUs; 64 requested).
- **2026-11-14** — Public blobs, built and off (`infra/runs/public-blobs.ts`,
  `public-blobs-stack.ts`). The maintainer's decision: a CloudFront distribution on the
  Free flat-rate plan in front of the private bucket, so that the bill never depends on
  what strangers download. Only `GET`/`HEAD` of `/blobs/sha256/<hex>`: the bucket policy
  lets this distribution's CloudFront service `s3:GetObject` under `blobs/sha256/` alone
  (never `ListBucket`), and only the `blobs/sha256/*` behaviour reaches the bucket, behind a
  function that answers 404 to anything but a hash; the default behaviour's function
  answers 404 to everything. Origin Access Control; the public access block stays on.
  What the Free plan allows decided the rest: managed policies only
  (`CachingOptimizedForUncompressedObjects`, `CORS-and-SecurityHeadersPolicy`; custom ones
  are Business), so `Cache-Control: public, max-age=31536000, immutable`, the CSP sandbox
  and CORS on success come from a viewer-response function, and CloudFront keeps a blob
  24 hours, since uploads carry no `Cache-Control`; no compression, so the bytes served are
  the hashed bytes. The web ACL a plan requires: a per-address limit of 1,500 requests per
  5 minutes (a day's ~9,000 new blobs at the readers' 4 a second takes 37.5 minutes, 20%
  under it; a runaway loop passes it within a minute), the IP reputation and known-bad-input
  groups. The plan itself is `AWS::PricingPlanManager::Subscription` through Cloud Control
  (Pulumi AWS 7.20.0 has no resource for it); the web ACL and it use the resources' own
  `region: "us-east-1"`. The switch is a committed constant with three states: `off` (no
  resource, the bucket's arguments exactly `{ versioning: true }`, no output), `dark`
  (everything, the distribution disabled, the plan subscribed), `on` (enabled, and the
  deploy first asks AWS, read-only, whether the web ACL is in an ACTIVE plan, and stops if
  not), so no moment is spent public on pay-as-you-go. `scripts/derive.ts --blobs-url`
  reads blobs through it, hash-checked as from the bucket, paced at 4 a second, a 403 that
  is not S3's `AccessDenied` taken as a refusal, never as a missing blob. Type-checked
  against SST 4.17's platform types; not deployed, so unverified: that Cloud Control can
  create the subscription and that AWS subscribes a disabled distribution (the README says
  what to do if not), and whether the Free plan accepts the managed response-headers
  policy, which AWS's table allows and one report says the console refused.
- **2026-11-14** — Public blobs, after an independent review: six findings, all about the
  bill not depending on outside traffic and the distribution never serving off a plan. The
  distribution is now for one stage, `PUBLIC_BLOBS.stage` = `production-runs` (the
  scheduled pipeline moves to that account; `smr-runs` becomes a development stage):
  elsewhere nothing is made and AWS is not asked, and every AWS call the deploy makes or
  prints uses the stage's own profile. **A limit on the total**: a second WAF rate rule
  counts every request under `/blobs/` together (aggregation `CONSTANT`, with a URI-path
  scope-down) and blocks all of them over 6,000 per 5 minutes, evaluated last so that
  requests the managed groups or the per-address limit already blocked are not counted; at
  that steady rate a 31-day month is 53,568,000 requests, $21.43 of S3 GETs if all missed
  the cache, an estimate and not a cap, since WAF enforces the rate approximately. AWS
  accepted the four rules (`wafv2 check-capacity`, read-only: 231 units; without the
  scope-down it refused).
  **Transitions**: the distribution's comment records the state and plan last deployed; a
  deploy first reads it with `aws cloudfront list-distributions` (paged by hand: the CLI's
  own paging prints nothing at all for an account with no distribution) and the plan
  listing, and refuses `off`, removal or a change of plan from anything but a `dark`
  distribution that reports disabled, `on` without an ACTIVE plan, and `closed`/`on` after
  the watch disabled the distribution behind the stage's back; Pulumi `protect` on the
  distribution and subscription while enabled is a second lock. **The watch**: a Lambda
  every 5 minutes disables an enabled distribution no ACTIVE plan covers, or one it cannot
  ask about twice in a row (a tag on the distribution remembers the first time), and logs
  a scheduled cancellation with its date; it may list subscriptions and read, update and
  tag that one distribution. **`closed`**, between `dark` and `on`, only if AWS will not
  subscribe a disabled distribution: enabled, 404 to everything, no bucket grant (the grant
  now exists only in `on`). **The reader** refuses redirects, naming both addresses.
  **Derivations through a public address**: both Methods on the sample Runs (and two
  hand-made `http_get` Runs, since no sample is one), from a directory and through a local
  HTTPS stand-in under a path prefix, give the same bytes. The README now says plainly that
  every blob a box uploads is served as `binary/octet-stream`, so a browser downloads it.
  Two SDK clients join the dependencies, for the watch. Not deployed.
- **2026-11-14** — Public blobs, after a re-check of the review's fixes. **The total limit
  is a rate limit, not a cap**: AWS documents rate-based rules as approximate (requests over
  the limit can pass for minutes, and changing a rule resets its counts), so $21.43 is what
  a month costs at the steady rate, and nothing caps S3 request charges; the README links
  AWS's caveats. **Which distribution is the stage's** now comes from the stage's own
  state, the copy SST pulls before every command and names in `PULUMI_BACKEND_URL` (SST
  4.17's `pkg/project/run.go`; checked with Pulumi 3.215 and a local file backend that the
  program sees it, and that `pulumi destroy` does not run the program): the distribution it
  records, by ID, is the one the deploy updates, and the listing must agree with it, so a
  look-alike carrying the comment, or the stage's own with its comment edited, is "unknown"
  and refuses. **`sst remove` runs no guard** (it is `pulumi destroy` without
  `--run-program`), so the `remove` target is gone, and any state but `off` needs a
  protected stage (`$app.protect`): SST refuses `sst remove` on one. `sst.config.ts`
  protects no `-runs` stage yet, so `production-runs` deploys only `off` until it does.
  **`sst dev`**: the watch sets `dev: false`, and any state but `off` is refused under
  `$dev`. **The watch** handles an unreadable distribution like its other unknowns (taken to
  be enabled and past any grace), retries an ETag conflict (`PreconditionFailed`) three
  times, and nothing promises it acts within so many minutes: the delay is the schedule, the
  run and CloudFront's propagation, and polling cannot rule out uncovered delivery. **Plan
  changes** still count as uncovered while `SYNC_IN_PROGRESS`, on purpose; the README, the
  deploy's reminder and the scheduled-change warning say to deploy `dark` before changing
  or cancelling the plan. Found on the way: the web ACL's description had a semicolon, which
  WAF's pattern refuses, so the first `dark` deploy would have failed; it is now a tested
  constant. Not deployed.
- **2026-11-14** — Public blobs, brought together with the two accounts (`stages.ts`).
  `production-runs`, the one stage `PUBLIC_BLOBS` names, is the stage `stages.ts` sends to
  the production account and protects, so the entry above's "protects no `-runs` stage yet"
  no longer holds: `dark`, `closed` and `on` can be deployed there, and a test fails if the
  two ever name different stages. Also corrected after a second re-check: SST's lock does
  not cover `sst diff`. Not deployed.
- **2026-11-18** — `memory_read` keeps its dynamic build (#37, decision 6; #38, check 5).
  The week of the static build beside the dynamic one ended with different numbers: on the
  `scalar` path the dynamic build is faster on `m5.large`, `i4i.2xlarge` and `c6i.8xlarge`
  (by 1.3% to 15.1%), and the same on `c8i.2xlarge`, `c8a.2xlarge` and the `avx2` path.
  The maintainer decided to keep both builds, with no end date, and to leave the other
  benchmarks static only for now. The cause, where the code or the buffer lands in memory,
  is not yet measured, and finding it is deferred. ADR-0029 (decision 4) and ADR-0008's
  note say so. Only documents changed: `schedule.json`, the code and the tests are as they
  were.
- **2026-11-19** — The schedule moved to the production account (#57), following the
  README's "Moving the schedule to the production account" as written. Steps 1 to 5 on
  2026-11-18, 19:53 to 20:27 UTC: `production-runs` deployed with no launch schedule, one
  `m5.large` booted there by hand (16.5 minutes to its log), the development bucket copied
  and verified. Steps 6 to 12 on 2026-11-19, 12:33 to 13:07 UTC, in the 12:30 to 15:00 gap:
  the copy again (13:01, `verify` compared 86,550 source objects, 568 s),
  `SCHEDULED_STAGE = "production-runs"` merged as `0a704fb` (#65), `production-runs`
  deployed with its five launch schedules, `smr-runs` deployed without them, and the
  workflow's `RUNS_BUCKET` and `RUNS_AWS_ROLE_ARN` pointed at production. Step 13, the
  first production round at 16:10 UTC, passed (checked 17:30 to 17:41 UTC): five launches,
  five boot summaries, `check-runs.ts` on the bucket, the workflow, and no Series of either
  Method starting a new group. Step 14, going back, was not needed. `smr-runs` and its
  bucket are kept, with no launch schedule. **One unplanned effect**: the deploy of
  `smr-runs` deleted the development bucket's previous source archive,
  `source/50db33a….tar.gz`, every version and no delete marker, as every deploy does to
  the previous `source/` key. No Run was affected: the 5,868 Runs built from it name its
  blob, which both buckets hold. The README now says so, with the other corrections the
  move showed (the launch function's log group, the names of production's launch
  schedules, how long `verify` takes, a group check that also reads the requests Series,
  the two new `sst-env.d.ts` files, and dated figures for the buckets).
- **2026-11-19** — The data API, first slice (#64, ADR-0030). `scripts/build-api.ts` cuts
  the two files of Derivations and the price files into a tree of static JSON files, laid
  out as `https://api.ledgermath.com` will serve it: `v1/index.json`, `v1/series.json` (one
  row per Series), `v1/series/<id>.json` (each Method's Derivation in full, every point
  linking its Run file), `v1/prices/<yyyy-mm-dd>.json` and `v1/schemas/`.
  `scripts/check-api.ts` checks what was written. The `runs` workflow builds and checks it
  after the page, and keeps it as the artifact `api`. Nothing is served or public, and the
  workflow uploads nothing anywhere else. On the data of 2026-11-19, 187 Series: the list is
  193 KB, a Series file 124 to 791 KB, and three builds gave the same bytes. Chosen while
  building: each Method's part keyed `<name>_v<version>`; samples kept in the Series file;
  no time of generation in any file, the newest Run's start instead; a point's
  `boot_summary` linked when the Runs repository holds it; blob addresses as a template in
  the table of contents, since Run files name blobs by hash. The lookup tool and the skill
  still read the files of Derivations.
- **2026-11-19** — The data API, split by month before it goes public (#64, ADR-0030
  rules 3 and 9 to 11). Each Series' points, and series v1's pair entries (filed under the
  later Run's month), moved to `v1/series/<id>/<yyyy-mm>.json`; the Series file keeps the
  summary, the newest 12 points (`newest_runs`) and the list of its months. Left out of it,
  as recoverable from the month files and refused by the build when not: the Runs behind each
  percentile (the counted points) and in each group (the points of its letter). Found while
  building: requests v1's `group_through` turns from null into the group's figures on every
  earlier point the day a Run first splits a Series, which would rewrite every past month; it
  is written as it stood through each Run, null before the split, where the Derivation's is
  the point's `through`. Also: a ceiling of bytes per kind of file in the check; the build
  refuses a number in the Derivations a double does not hold exactly (`-0` passes as 0); the
  check reads the tree's numbers the same way, finds every file reachable from the index,
  every schema valid and listed, and with `--previous DIR` reports any past month that
  changed but by a Run of its own or an arriving boot summary. On the data of 2026-11-19 a
  Series file is 29 to 31 KB (138 to 302 KB for `http_get`, from 124 to 791 KB), a month file
  grows by up to 4.5 KB a Run (22 KB), and the build and check take 1.0 s and 1.8 s. The
  index's list of price files still grows (124 bytes a day), and is left as it is.
- **2026-11-19** — After an independent review of the split (#69): the promise that a past
  month never changes was not true. A Run that arrives late changes its own month and the
  later ones, and a Method that first applies to a Series (requests v1, once one of its
  Runs' streams holds a request) adds its block to every past month. The Methods are left as
  they are; the contract now names the four causes (a Run of the month added, a missing boot
  summary arriving, a late Run, a Method first applying), word for word in the index
  (`months`), both Series schemas, ADR-0030 and the README, and each Series file's `months`
  gives every month file's sha256 and size. `group_through` is `group_through_as_of_run` in
  the tree, since it is not the Derivation's field, and its description gives both reasons it
  is null and the one rule that recovers the Derivation's value (`?? through` would hand a
  group with no counted Run the other groups' figures). `--previous` is a gate now: a missing
  or other-layout baseline is an error unless `--allow-no-previous`; a changed month passes
  only when both files are exactly the layout of their values and every change is one of the
  four causes, listed by cause. The `runs` workflow compares with its last successful run's
  artifact `api` (kept 7 days) and says in its summary when there is none. The check also
  takes a point's month from its Run file's own `started_at`. On page-3 to page-4 every one
  of the 187 month files changed, each for (a) only.
- **2026-11-19** — After a second review of #69, three ways the gate passed a tree it should
  refuse are closed. Every file the build writes must be, byte for byte, the build's writing
  of its own parsed value (`writerForm()`), so reversed members of a `through` no longer pass
  as a late Run's doing. A late Run excuses, in the points after it, only the fields listed
  as depending on earlier Runs (`LATE_RUN_MAY_CHANGE`), and requests v1's `through` counts
  are held to exactly what the late Runs add, so a `runs` of 999 fails; that a changed
  percentile is right is said, in the output and the docs, to be the Method's and beyond the
  gate. The layout is a number (`LAYOUT`, `layout` in `v1/index.json`), not the schemas'
  bytes, so a newline in a schema no longer turns the comparison off; a previous tree of the
  same layout must be whole and is always compared; with none, or another layout, only the
  workflow's `new_baseline` input, by hand, passes, and still nothing published may be
  missing (read from month files or, in the layout before the split, from Series files'
  points). The previous tree is the latest successful run created before this one, and a
  malformed reply is an error. On real data: page-3 to page-4 compares as 187 month files
  changed for (a); a counted late Run simulated in an `http_get` Series passes as (c) with
  its counts exact, and fails with `runs` 999. The first scheduled run after the merge fails
  on purpose (the kept tree has no layout) until it is run by hand with `new_baseline`.
- **2026-11-20** — The data API's serving, built and off (#64, slice 3; ADR-0031). One
  host, `https://api.ledgermath.com`: `/v1/…` from a new private API bucket, exactly as the
  build writes the tree, and `/runs/…`, `/boots/…`, `/blobs/sha256/…` from the Runs bucket at
  its own keys, through CloudFront on the Free flat-rate plan with Origin Access Control;
  nothing else of either bucket is reachable, and a test routes every kind of key, spelt as an
  attacker might, through the behaviours and the grants to show it. It grew from public blobs
  (2026-11-14), which nothing ever deployed: the plan, the states, the guard and the watch are
  kept; the switch is now `PUBLIC_API` (typed to `production-runs`, and refusing any other
  stage instead of ignoring it), the stage makes the certificate, its DNS validation and the
  `A`/`AAAA` alias records in the delegated zone `Z03039811C7UWLHZE7CZQ` (replacing the
  `domain` setting), the total WAF limit counts every request rather than `/blobs/` alone,
  and the blob request function is gone. The plan allows only managed policies, so the
  tree's `Content-Type: application/json` and `Cache-Control: public, max-age=300` are on its
  objects, set by the upload; CORS comes from the managed response-headers policy; the
  evidence's `immutable` and its JSON type come from the one viewer-response function; the
  default behaviour's function answers 404. Five minutes for the whole tree because no
  address in `v1/` is named by its content and a month file must not outlive the Series file
  listing its sha256. **Running now:** the `runs` workflow uploads the checked tree to the API
  bucket once the repository variable `API_BUCKET` is set (writing only files whose SHA-256,
  which S3 verifies and keeps, or headers differ; schemas, then month and price files, Series
  files, the list, the table of contents; deleting nothing), then checks that the bucket
  holds exactly the tree; while the variable is unset the step summary says so. The
  workflow's role gets a second policy, `RunsApiUploadPolicy` (list the API bucket, read and
  write its `v1/*`), and still cannot write to the Runs bucket. Not deployed; `sst diff` was
  not run, the AWS login having expired. A deploy of a `-runs` stage now creates the API
  bucket and that policy, and nothing of the serving.
- **2026-11-21** — The data API's serving, after an independent review (PASS WITH FIXES;
  the production `sst diff` agreed that, off, a deploy makes only the API bucket and the
  role's upload policy). **Only what the project writes is served, at one host**: a request
  function in front of every served behaviour lets through only the key shapes in `SERVED`
  (the tree's kinds; a Run file by the Run schema's UUIDv7; a boot summary by the kernel's
  boot id; a blob by its SHA-256: every one of the Runs repository's 7,270 Run files and 197
  boot summaries had them on 2026-11-21), answering 404 to anything else under a served
  prefix, and 403 to any `Host` but `api.ledgermath.com`, the distribution's own name
  included; tested against a stand-in for S3 that holds the malformed keys. **The upload
  lists the whole bucket first** and writes nothing while it holds a key the tree lacks (a
  price file taken out, a stray key anywhere), naming each, so a published table of
  contents can never leave the bucket unequal to the tree for good; the README says how to
  settle a key by hand, and the workflow still cannot delete. **A failed write fails the run
  naming its phase and key**, and the next run repairs the bucket by itself; a test stops an
  upload between the month files and the Series files on a filled bucket, shows the sha256
  mismatch a reader then finds, and shows the next run end it. A month file changes in place,
  so no order prevents that window: ADR-0031 and the README give readers the rule (check a
  month file against its Series file's sha256; on a mismatch fetch the Series file again).
  The generator's own words (`MONTH_CONTRACT`) do not yet say so, and are left for a change
  of their own. **Tests no longer depend on the committed switch**: one release-gate test
  pins it to `off`, and a rehearsal sets it to each state (and the `console` attachment) in
  child processes and finds that only that test fails; `checkSetting` refuses an unknown or
  missing state or attachment. **The stack's wiring is type-checked in CI**
  (`scripts/check-stack-types.ts`, after `bunx sst install`, which asks AWS nothing), and
  `tests/public-api-graph.test.ts` builds the resources of `dark`, `closed` and `on` with the
  stack's own code under Pulumi's mocks. ADR-0031 also states that the evidence's immutable
  caching assumes each key is written once, what holds that and what would catch a rewrite.
  Off, a deploy still makes only the API bucket and `RunsApiUploadPolicy`. Not deployed.
- **2026-11-21** — The data API's serving, after a second review (FAIL). **The rehearsal
  failed in CI and passed locally**: it counted failing tests from Bun's printed lines, and
  under GitHub Actions Bun repeats each failure in a recap, so the release gate counted
  twice. It now reads each child's JUnit report (`tests/junit.ts`), requires every test
  file to have run, and covers every state and both plan attachments; the gate and the
  rehearsal read one constant, `RELEASED_STATE`. A copy of the repository with the switch
  and the constant both at `dark` passed the whole suite; with the constant left at `off`
  it failed the gate alone. **Publishing is a job of its own**: the `runs` job does what it
  did on `main`; `publish` needs it, runs only when it succeeded and `API_BUCKET` is set,
  downloads the artifact `api`, and runs a preflight, the upload and the check, with a
  15-minute timeout and only the permissions it uses. The baseline is the artifact `api`
  of the latest earlier run that kept one (kept only when the check passed), so a run whose
  `publish` failed is one and a run whose check failed is not. The workflow's concurrency
  group keeps runs apart, the job's group keeps uploads apart, and each object now carries
  the id of the run that wrote it, so a re-run of an old `publish` job never writes an older
  tree over a newer one. **The edge's shapes are exact**: schema names are the generator's
  `API_SCHEMAS` (moved to `scripts/lib/api-schemas.ts`, which imports nothing, so the
  stack's bundle does not load the build), dates and months are real calendar values, and
  the default function checks the `Host` too. **`checkSetting` refuses another stage in
  every state**, `off` included. **The stack type check judges the compiler's exit**: a
  signal, a non-zero exit with no diagnostics or lines it cannot read now fail, tested with
  a stand-in compiler. Not deployed; the switch stays off.
- **2026-11-21** — The data API's serving, after a third review (FAIL on two findings).
  **A run that published nothing new left no trace**: run 100 wrote tree A, run 102
  published the same A with no `PUT`, and a retry of run 101 then wrote its tree B over it
  and passed its check. Every upload that succeeds now leaves its run on `v1/index.json`
  (the stamp: the same bytes written again with the run in its metadata, when the table of
  contents was not rewritten and does not record the run already), and the check, given
  the run, requires it; S3's ETag stays the same, only `Last-Modified` moves. Tests: the
  three-run case, the same run's retry (allowed, no write), the first upload (no stamp).
  The README says how to put right a run recorded too high. **The publish job no longer
  holds the lock `prices.yml` shares**: the group `runs` moved from the workflow to the
  first job (GitHub's groups are the repository's, jobs and workflow runs alike), and
  `publish` holds `api-bucket` alone. So the next run's first job can start while the run
  before publishes, and the baseline lookup now searches runs of every status (an artifact
  v4 can be downloaded as soon as it is kept); a test holds it to a run still going. The
  turn-on steps now require a tested route by which a failed publish reaches the
  maintainer. Not deployed; the switch stays off.
- **2026-11-21** — A stale or failed publish now reaches the maintainer the way stale
  data does (ADR-0032, README "The alarm", "The data API's publishing"). **The alarm reads
  the API bucket** in every run's first job, with the role's existing read: one `GET` of
  `v1/index.json`, whose `Last-Modified` S3 sets as the upload's last act writes it (in the
  last phase or as the stamp), so it moves on every successful upload of a new run and on
  nothing else the workflow does; the run in its metadata (which an upload by hand can set
  to anything) and the tree's `newest_run_started_at` (which stands still when the boxes
  do) decide nothing. **It raises two scheduled runs in a row** (00:00, 06:00, 12:00, 18:00,
  22:40 UTC, held to the crons by a test) that have each had an hour since their time
  without a publish, counted by the schedule because its gaps are uneven: one failed run
  can leave the tree as old as two in a row, 12 hours. It fires at the run after the second
  miss, the tree 12 to 18 hours old, and a test plays three days of runs at 4, 30 and 50
  minutes late to hold one miss silent and two always raised. A bucket with no table of
  contents, or one it cannot read (a `GET`, so a missing bucket is not taken for an empty
  one; a 5xx or no answer tried three times), is raised at once; nothing S3 answers fails
  the job. `API_BUCKET` unset raises nothing while `PUBLIC_API` is `off`, and is raised in
  any other state. Same issue, same rule of writing only on change, and once when the data
  API is published again; each pass writes what it found to the step summary. The workflow
  passes the variable to the alarm step only; the first job still writes nothing to the
  bucket. Turn-on step 0 now says what exists and gives the one thing left to do by hand:
  point `API_BUCKET` at a name that is no bucket of the stage, start a run, see the
  notification arrive, put it back. **README corrections from #72's last verification**:
  uploads must be serialized (the run guard reads before writing, not during), so an upload
  by hand goes through the workflow; and a run makes three passes, 3 `HEAD`s per file and 3
  listings, not two (about 176,000 `HEAD`s a month now, $0.07; $0.47 a year on), with the
  first publish's timings (391 files: preflight 1.7 s, upload 4.3 s, check 1.8 s). A test runs
  the `publish` job's own commands, read from the workflow, against the stand-in for S3 for
  trees of two sizes and requires exactly those counts and at most eight requests at once,
  and the README to state the same counts. ADR-0031's costs and its decision 7 point at the
  change. Not deployed; nothing in AWS changes; the switch stays off.
- **2026-11-21** — The publishing watch, after an independent verification (FAIL: the new
  check could suppress the existing alarm). **Bounded**: the read has 20 s in all, 5 s a try,
  waits of 1 and 2 s; the body of a 200 is cancelled unread, of an error at most 2 KB are read
  for at most a second, and what reaches the issue is one line of at most 300 characters,
  without backticks. Tests make the stand-in answer headers and then stall, not answer, and
  trickle, and find the existing alarm's verdict within the budget. **Guarded whole**:
  `watchApiBucket` does the whole check before anything is posted, and anything thrown in it
  becomes "The check of the API bucket failed", raised like an unreadable bucket, while
  `runAlarm` takes only finished strings; the step summary's write is best-effort. Tests
  throw at each stage (the reader, the read, the judgement, the words, the summary line, the
  job start, the cron, a thrown thing with no words) and find the stale-Series verdict as
  without the bucket; a step summary that is a directory is warned of, with the verdict and
  exit code unchanged. **The count, truthfully**: elapsed scheduled slots since the bucket
  was last written, judged only up to an hour before the job started and never the job's
  own slot (the cron that started it, `github.event.schedule`; the job's first step notes
  when it started). The verifier's two counterexamples are tests: the 22:40 run failing and
  the 00:00 job starting an hour late no longer raises; a publish by hand between two failed
  runs starts the count again. The simulation now draws lateness up to 79 minutes and adds
  runs by hand between slots. **Unset decided**: nothing raised while `PUBLIC_API` is `off`,
  raised in any other state. **The drill**: a `workflow_dispatch` input, `alarm_drill`, makes
  only the alarm's check read a name no bucket can have and say it is a drill; the publish
  job never sees it, and the next ordinary run clears it. Step 0 of turning the API on now
  uses it and closes the issue only when it reports nothing else. Not deployed; the switch
  stays off.
- **2026-11-21** — The publishing watch, after a second verification (FAIL, six findings).
  **The rule is now age, nothing else** (the orchestrator's decision): raised when
  `v1/index.json` was last written more than 14 hours before the check runs
  (`MAX_PUBLISH_AGE_MS`). Slot counting is gone (the cron reader, the run's own slot, the
  judgement cut-off, the workflow step that noted the job's start): three rounds each found
  a new way for it to be wrong, the last a re-run of an old run clearing a real alarm.
  ADR-0032 records why, and the guarantee in plain terms: one failed publish raises nothing
  unless a run starts more than two hours late; publishing that stops is raised within
  about 20 hours; two failures around the 22:40 to 00:00 gap can pass unnoticed when the
  next publish succeeds. Tests: ages either side of 14 hours; the real schedule (read from
  the crons) with one failure and starts up to two hours late; publishing stopped after each
  run of a day; a re-run whose child prints the same report; the first publish. **The check
  runs in a child process** (`scripts/check-api-publishing.ts`) that the alarm kills with
  `SIGKILL` after 20 seconds; a kill, a non-zero exit or output that is not a report is "the
  check of the API bucket failed", and the alarm writes nothing on the check's behalf.
  Tests: children that sleep past the budget, ignore `SIGTERM`, print garbage, exit
  non-zero, and the real check with a step summary that blocks (a FIFO); in each the
  stale-Series verdict as on main, on time. A first try kept the alarm alive for the grace
  timer's 22 seconds after its work; the timer is now cleared, and a test holds the alarm's
  run under ten seconds. **The drill posts one comment**, with the run's link, after the
  ordinary pass, reads nothing and carries no state marker, so an open finding stays
  reported. **The first job has main's steps again**, in main's order, with main's condition
  on the alarm step (a test holds both). **The error body's limit is tested**: an S3 code
  beyond byte 2,048 is not seen, and one chunk larger than the limit is decoded only up to
  it. Not deployed; the switch stays off.
- **2026-11-21** — The publishing watch, after a third verification (FAIL on five points;
  the design held). **Every post fits GitHub's limit**: GitHub refuses a body over 65,536
  characters, and with all 187 watched Series stale `main`'s body was 87,890, so the alarm's
  most important case posted nothing. Bodies are now built under 60,000 (`MAX_BODY_CHARS`):
  summary, counts and findings always; as many Series as fit, sorted; one line saying how
  many more and that the run's log and step summary list them all (the alarm now writes the
  full list there). The marker carries a count and a hash of the set, not the list; old
  markers read as the same state. 187 Series now give 59,797 characters (59,873 with the
  bucket finding). Tests: 141, 187 and 1,000 Series with and without findings; quiet on
  repeat; a change in a Series not shown is a change; a 422 fails loudly and is sent once.
  **Nothing in words from the child or S3 reaches the issue**: the child reports a closed-set
  result, validated field by field and rendered in fixed sentences; failures have four fixed
  reasons; the words go to the log. Its environment is the three AWS keys and
  `GITHUB_STEP_SUMMARY`, nothing else. Tests put a token's shape, a mention and a link in the
  child's stdout and stderr and in S3's error; none reaches an issue. **The guarantee,
  stated by checks**: raised by the first check made more than 14 hours after the last
  successful publish; one failed publish stays quiet while every alarm runs under two hours
  after its slot; stopped publishing is raised 16 h 40 m to 19 h 20 m after the last
  scheduled publish with on-time runs. The simulation varies each alarm's time after its slot
  and asserts exactly these. **A drill that cannot post does not fail the job** (a fake
  GitHub API answers 500 to it; the alarm exits 0); with no open issue, the drill opens the
  issue and posts no comment, one notification. **The kill is tested by death**: the child
  leads its own process group, killed with `SIGKILL` after the budget and as soon as the
  child exits; a child that ignores `SIGTERM`, and a grandchild holding the pipes, are found
  dead. The child now starts before the Runs repository is read. Not deployed; the switch
  stays off.
- **2026-11-21** — The publishing watch, after a fourth verification (four small points). No
  issue or comment names the bucket any more ("the API bucket"); the name stays in the log
  and the step summary, and this run's link is the fixed Actions address and a numeric
  `GITHUB_RUN_ID` (a test renders every result of the closed set and finds no bucket name).
  The line that cuts the list says the log lists every stale Series and the step summary as
  many as its size limit holds. The marker's hash is of the JSON of the sorted list, so
  `["a", "b"]` and `["a\nb"]` differ (old-format markers still read through the same
  function). The alarm's own step-summary writes are asynchronous, abandoned after two
  seconds, and the alarm exits explicitly with its verdict's code (a test gives it a FIFO
  nobody reads). Not deployed; the switch stays off.
- _(agents: append your entry here, one per merged benchmark)_
