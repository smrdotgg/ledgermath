# Review & merge the Tier 1 benchmark PRs

You are reviewing a set of open PRs on `smrdotgg/ledgermath` (this repo). They were
written autonomously by another AI agent (GPT-5.5 via OpenCode, driven by `ralph.ts`).
Your job: **review every open `bench/*` PR, fix small problems yourself, flag big ones,
and merge everything that passes.** You have full authority to push to PR branches and
merge to `main`. The human (smr) will only get involved for PRs you flag as
fundamentally broken.

## Context — read these first

1. `docs/dev-log.md` — the project's north star, the JSON output contract, the decisions
   log, and the definition of done. This is the ground truth for what "correct" means.
2. `docs/prds/` — one PRD per PR. Each PR must implement its PRD **exactly**: same
   `benchmark`/`variant` strings, same file added, same ballpark numbers.
3. `benchmarks/c/harness.{h,c}` and the two pre-existing benchmarks
   (`bench_memory_read.c`, `bench_compressed_memory_read.c`) — the house style and the
   quality bar. They were human-reviewed and verified; treat them as reference
   implementations.

The one-sentence mission: **LedgerMath's numbers must reflect the limits of the
hardware, never the quality of the benchmark code.** A benchmark that builds, runs, and
prints valid JSON but measures the wrong thing is worse than no benchmark — it poisons a
public dataset people will use for capacity planning. The automated gate already
guaranteed "builds + runs + valid JSON," so your review adds the part machines couldn't:
**is the measurement methodologically sound?**

## Your powers and limits

- `gh` CLI is authenticated; `git` has push access. Use them freely.
- You can verify builds/behavior on linux/amd64 via Docker:
  `docker run --rm --platform linux/amd64 -v "$PWD/benchmarks/c":/src -w /src gcc:14 sh -c 'make clean && make && ./run-all.sh --quick'`
  (start Docker Desktop with `open -a Docker` if the daemon isn't up). **Timing numbers
  under emulation are meaningless** — use Docker only to confirm: clean compile under
  `-Wall -Wextra`, no crashes/hangs, valid JSON, checksums/validation pass. Judge the
  *numbers* by reading the code and comparing the PR's pasted `--quick` output (from the
  real x86 VPS) against the PRD's ballpark.
- Do not weaken the harness, the schema, or the PRD requirements to make a PR pass.

## Workflow

Process PRs one at a time, in PR-number order:

1. `gh pr list --state open` — enumerate. For each PR: read the PRD it implements, then
   `gh pr diff <n>` / check out the branch and read the full new file.
2. Review against the checklist below. Decide: **pass / small problems / big problems**.
3. **Small problems** (you are confident in the fix, it doesn't change the measurement
   methodology): fix them yourself on the PR branch — commit with a clear message
   explaining what you changed and why, push, re-verify the build in Docker.
   Examples: missing include, a warning, wrong `variant` string, missing dev-log entry,
   merge conflicts, an unjoined thread at exit, `bytes_per_op` off by a factor.
4. **Big problems** (the measurement itself is wrong, the approach needs redesign, or a
   scope violation you can't untangle): do NOT merge. Leave a PR comment via
   `gh pr comment <n>` that states the problem precisely and what a correct
   implementation looks like — it will be handed verbatim to the authoring agent for
   rework. Move on to the next PR.
5. **Merge passing PRs**: `gh pr merge <n> --squash --delete-branch`. Merge them
   **sequentially as you go** — after each merge, the next PR will likely conflict on
   `docs/dev-log.md` (every PR appends a Running Log entry at the same place; this is
   expected, not a mistake). Resolve by keeping **both** entries in chronological order:
   update the branch (merge `main` into it or rebase), fix the conflict, push, then merge.
6. When all PRs are handled, post nothing anywhere — just report back in your final
   message: a table of PR → verdict → action taken (merged / fixed-then-merged /
   commented-and-left-open, with one line on why).

## Review checklist — the mistakes to actively hunt for

These are the specific failure modes AI-written benchmarks tend to have. The gate could
not catch any of them; you can.

### 1. The work isn't really happening (elision / dead code)

- The hot function must return a checksum **derived from the data it processed**, and
  `measure()` records it. Verify the dependency is real: if the checksum could be
  computed without doing the work (e.g. summing an index variable instead of loaded
  data, or hashing the same cached result), `-O3` may delete the loop.
- Cross-check with physics: **compare the PR's pasted `--quick` numbers against the
  PRD's ballpark.** Sequential RAM writes at 500 GiB/s, a "random" read at 1 ns, a sort
  at 50 GiB/s — those aren't fast code, they're deleted code (or cache hits, see #3).
  A number wildly *better* than the ballpark is a stronger red flag than one that's worse.

### 2. Measuring the wrong thing (timed-region contamination)

- Setup (allocation, filling buffers, building/shuffling index arrays, generating random
  data) must happen **once, outside the measured op** — in `main` before `measure()`, or
  in the context struct. If `fn(ctx)` re-shuffles or re-generates data per call, the
  benchmark measures the PRNG, not the hardware.
- Special case, PRD 05 (sort): each op legitimately needs a fresh unsorted copy, so a
  `memcpy` inside the op is correct there (the PRD says so). But the *random generation*
  must still be setup-only. And verify iteration 2+ actually sorts unsorted data — if
  the op sorts in place without re-copying, every iteration after the first sorts an
  already-sorted array and the number is fiction.
- No `printf`/logging inside the timed op. No syscalls in ops that aren't syscall
  benchmarks.

### 3. Cache instead of RAM (working-set too small)

- Memory benchmarks need working sets far beyond LLC: the PRDs specify 1 GiB
  (512 MiB `--quick`). If an agent shrank the buffer "for speed," random access becomes
  an L2/L3 benchmark and the number is ~10× too good.
- For `memory_read_random`: verify the access order is genuinely a shuffled permutation
  of *all* elements (fixed-seed PRNG shuffle of an index array), not `rand()` per
  iteration (contaminates, see #2) and not a small cycling window (cache-resident).

### 4. Known single-benchmark traps (each PRD warns about its own — verify the PR obeyed)

- **sort**: must NOT use `qsort` (function-pointer comparison overhead ≈ 2–3× slow).
  Inlined-comparison sort (radix/pdq-style) required. Startup sortedness validation
  required.
- **hash**: CRC32 must be the SSE4.2 hardware intrinsic (`_mm_crc32_u64`) — a table CRC
  is ~10× slow. SipHash must actually mix all 64 input bytes with a real key schedule
  (check against the SipHash reference if unsure). SHA-256 must runtime-dispatch SHA-NI
  vs scalar fallback via `__builtin_cpu_supports("sha")`; stderr should say which path
  ran. No new link flags (OpenSSL forbidden — that would need a Makefile edit).
- **syscall**: `getpid` must use `syscall(SYS_getpid)` — glibc caches `getpid()` and a
  ~2 ns result means it measured the cache. `gettimeofday` being only a few ns is
  CORRECT (vDSO, no trap) — don't let a "fix" force it into a real syscall.
- **mutex**: contention must be real — a contender thread pinned to a *different* CPU,
  hammering the same `pthread_mutex_t`, running for the whole measurement. Single-digit
  ns per lock/unlock means the contender wasn't actually running. Process must exit
  cleanly (contender stopped/joined) — a hang would have shown up as the gate's 5-min
  timeout, but check the join logic anyway.
- **tcp_echo**: reads and writes must loop until all 32 KiB is transferred — a single
  `read()` returning 8 KiB early, unlooped, silently measures a quarter round-trip.
  `TCP_NODELAY` on both ends. Ephemeral port via `getsockname` (no hardcoded port).
  Sub-microsecond "round-trips" mean the echo isn't happening.
- **memory_write**: the write loop must not be optimizable into `memset` of a constant
  (values should depend on `i` or similar), and the checksum must read back written data.

### 5. Contract and scope violations

- **Schema**: exactly the fields in dev-log §2 — no renames, no extras, no drops. The
  `benchmark`/`variant` strings must match the PRD tables **character for character**
  (the future database keys on them). `threads` and `bytes_per_op` must be truthful —
  throughput is derived from `bytes_per_op`, so an off-by-2× there is an off-by-2×
  headline number.
- **Scope**: each PR may add exactly one `bench_<name>.c` and append one dev-log entry.
  Any edit to `harness.*`, `Makefile`, `run-all.sh`, another benchmark, or the PRDs is a
  violation — revert it if trivial, flag the PR if load-bearing (e.g. it "needed" a
  harness change to work).
- Threading discipline: anything multi-threaded must follow the NUMA first-touch pattern
  from `bench_memory_read.c` (per-worker allocation after pinning).

### 6. C correctness that moves numbers

- Warnings under `-Wall -Wextra` (build in Docker to check — the gate tolerated
  warnings, your review shouldn't).
- UB that optimizers exploit: signed overflow in index math, strict-aliasing casts,
  uninitialized reads. UB can make a loop faster *and wrong*.
- Fixed-seed PRNG (reproducibility across daily runs), not `time(NULL)` seeding.
- `--quick` sizing actually implemented (not ignored), matching the house pattern.

## Judgment calls

- Assume the code is guilty until the numbers make physical sense: for each PR, write
  down (in your head) what the hardware limit should be, then check the pasted output
  against it. That single habit catches most of the list above.
- Prefer fixing over flagging when the fix is mechanical and you can re-verify the build.
  Prefer flagging over fixing when the *methodology* is wrong — a rewritten benchmark
  should go back through the authoring loop, not be smuggled in via review.
- If a PR is missing its pasted `--quick` output (so you can't sanity-check real-hardware
  numbers), that alone is not a big problem — note it in your report and judge from code.
