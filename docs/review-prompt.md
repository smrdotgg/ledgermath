# Review & merge the Tier 2 disk benchmark PRs

You are reviewing open PRs on `smrdotgg/ledgermath` (this repo). They were written
autonomously by another AI agent (GPT-5.5 via OpenCode, driven by `ralph.ts`) and cover
the **Tier 2 disk benchmarks**: `disk_write`, `disk_read_sequential`, `disk_read_random`,
`disk_read_io_uring` (PRDs 08–11). Your job: **review every open `bench/*` PR, fix small
problems yourself, flag big ones, and merge everything that passes.** You have full
authority to push to PR branches and merge to `main`. The human (smr) only gets involved
for PRs you flag as fundamentally broken.

## Context — read these first

1. `docs/dev-log.md` — north star, the JSON output contract, decisions log (READ THE
   TIER 2 DECISIONS: O_DIRECT-for-reads, `bench_file_path()`, LDLIBS), definition of done.
2. `docs/prds/08…11-*.md` — one PRD per PR. Each PR must implement its PRD **exactly**:
   same `benchmark`/`variant` strings, same single file added, same ballparks.
3. The merged Tier 1 benchmarks in `benchmarks/c/` — human-verified reference
   implementations for house style (fixed-seed shuffles, checksum guards, cleanup).

The mission: **LedgerMath's numbers must reflect the limits of the hardware, never the
quality of the benchmark code.** Disk benchmarks are the easiest place to get a number
that is plausible, stable, reproducible — and wrong, because the page cache, the
filesystem, and virtualized storage all love to answer instead of the device. The
automated gate proved "builds + runs + valid JSON"; your review adds what machines can't:
**is the measurement methodologically sound?**

## Your powers and limits

- `gh` CLI is authenticated; `git` has push access. Use them freely.
- Verify builds/behavior on linux/amd64 via Docker (install liburing first):
  `docker run --rm --platform linux/amd64 -v "$PWD/benchmarks/c":/src -w /src gcc:14 sh -c 'apt-get update -qq && apt-get install -y -qq liburing-dev && make clean && make && ./run-all.sh --quick'`
  (start Docker Desktop with `open -a Docker` if needed). **Timing under emulation is
  meaningless** — Docker is for: clean compile under `-Wall -Wextra`, no crashes/hangs,
  valid JSON, startup validations passing, scratch files actually deleted afterwards.
  Note: O_DIRECT usually works on Docker's overlayfs/ext4, but if a bench dies with
  "O_DIRECT unsupported" under Docker, that alone is not a PR defect — verify the failure
  is the *loud* kind (clear error, non-zero exit), never a silent buffered fallback.
- Judge the *numbers* from the `--quick` JSON embedded in each PR body (captured on the
  real VPS by ralph). Remember the dev-log rule: VPS disk numbers are smoke tests —
  virtualized storage is noisy — so judge *shape* (relative gaps, plausibility bounds),
  not absolute closeness to the PRD ballparks.
- Do not weaken the harness, the schema, or the PRD requirements to make a PR pass.

## Workflow

Process PRs one at a time, in PR-number order:

1. `gh pr list --state open` — enumerate. For each: read its PRD, then `gh pr diff <n>` /
   check out the branch and read the full new file.
2. Review against the checklist below. Decide: **pass / small problems / big problems**.
3. **Small problems** (confident fix, doesn't change the measurement methodology): fix on
   the PR branch — commit with a clear message, push, re-verify the build in Docker.
   Examples: missing include, a warning, wrong `variant` string, missing dev-log entry,
   merge conflicts, missed `unlink` of the scratch file, unchecked syscall return.
4. **Big problems** (the measurement is wrong or the approach needs redesign): do NOT
   merge. `gh pr comment <n>` with a precise statement of the problem and what correct
   looks like — the comment goes verbatim to the authoring agent for rework. Move on.
5. **Merge passing PRs**: `gh pr merge <n> --squash --delete-branch`, sequentially. After
   each merge the next PR will likely conflict on `docs/dev-log.md` (every PR appends a
   Running Log entry — expected, not a mistake). Resolve by keeping **all** entries in
   chronological order, push, then merge.
6. Report back in your final message: a table of PR → verdict → action taken.

## Review checklist — the disk-specific failure modes to hunt

### 1. The page cache answered, not the disk (the #1 trap)

- **Reads must be `O_DIRECT`** (PRDs 09/10/11). Verify the flag is on the fd that is
  actually read in the timed op — not just present somewhere in the file. Verify there is
  **no silent fallback to buffered** if `open(O_DIRECT)` fails; the required behavior is a
  loud error and non-zero exit.
- Red flags in the PR's real-VPS JSON: sequential read at RAM-like throughput (10+ GiB/s);
  random read under ~10 µs/op; random ≈ sequential. Any of those means the cache or a
  too-small/too-clever access pattern answered.
- `disk_write` is the inverse: it must be **buffered** (no O_DIRECT) — the no-fsync
  variant *is* a page-cache measurement by design. Check the label honesty instead: the
  fsync variant must call `fdatasync` after **every** write inside the timed op.
- **fsync gap check**: `fsync` variant should be dramatically slower than `No fsync`
  (typically 10–1000×). If they're within ~2×, durability isn't reaching the device —
  either a bug (fdatasync outside the op, wrong fd, `fsync` on a different file) or lying
  virtualized storage; a bug must be fixed, storage weirdness must be noted in the
  dev-log entry.

### 2. O_DIRECT correctness (it fails ugly, not loud)

- Alignment: buffers from `xalloc(4096, ...)`, offsets and lengths multiples of the
  block size (8192 at 8192-aligned offsets is fine). Misalignment → `EINVAL` at runtime;
  make sure errors from `pread`/CQEs are actually checked, not ignored.
- Short reads must be looped, and every syscall/CQE result checked. An unchecked
  `pread` returning -1 forever produces a very fast, very fake benchmark.

### 3. io_uring completion discipline (PRD 11)

- Every op must **submit 64 SQEs and reap all 64 CQEs before returning** — submitting
  without waiting measures queueing, not I/O. Look for `io_uring_wait_cqe`/peek loops
  that see all 64, with each CQE's `res` checked against 32768 and `cqe_seen` called.
- Checksum must be computed from buffers **after** their completion is reaped.
- The 64 buffers must be distinct allocations (or distinct regions); a single shared
  buffer with 64 in-flight reads is a data race and measures nothing meaningful.
- Throughput plausibility: QD64 should beat PRD 09's QD1 on real hardware. Wildly above
  device plausibility → completions not awaited.

### 4. Scratch-file discipline

- File paths must come from `bench_file_path(...)` — never hardcoded (`/tmp/...` is an
  automatic fail: tmpfs risk is the whole reason the helper exists).
- File created at the PRD's size (`--quick`: 256 MiB), `fdatasync`ed after creation,
  **deleted on every exit path** (including validation failure). Run the binary in Docker
  and check nothing is left in `/var/tmp` afterwards.
- Content must be the verifiable offset-derived pattern the PRD requires, with a startup
  validation read that exits non-zero on mismatch.

### 5. Timed-region contamination (same as ever, disk flavor)

- File creation, pattern filling, shuffle building, `fdatasync`-after-creation — all
  setup, all outside the timed op. If the op re-opens the file, re-seeds, or re-shuffles,
  it's measuring syscalls and PRNGs, not the device.
- `disk_read_random`'s access order: a fixed-seed Fisher–Yates full permutation of all
  block offsets (house pattern from `bench_memory_read_random.c`), not `rand()` per op,
  not a small cycling window.
- No `printf`/logging inside timed ops.

### 6. Contract and scope

- Schema: exactly the dev-log §2 fields; `benchmark`/`variant` strings must match the
  PRD tables **character for character**; `bytes_per_op` truthful (8192 for 08–10;
  2097152 for PRD 11 — one op is the whole 64×32 KiB batch) since throughput derives
  from it.
- Scope: exactly one new `bench_<name>.c` + one dev-log Running Log entry per PR. Any
  edit to `harness.*`, `Makefile`, `run-all.sh`, other benchmarks, or PRDs is a
  violation — the Makefile already handles `-luring`; a PR that touched it anyway needs
  that hunk reverted or flagged.
- Warnings under `-Wall -Wextra` are your problem to catch (the gate tolerates them).
  Fixed seeds, `--quick` sizing honored, every syscall checked.

## Judgment calls

- For each PR, first write down what the *shape* of a correct result looks like (fsync ≫
  no-fsync; random ≫ sequential per-op latency; QD64 ≫ QD1 throughput), then check the
  embedded JSON against that shape. Shape violations are methodology bugs until proven
  to be VPS storage weirdness.
- Prefer fixing over flagging for mechanical issues; prefer flagging over fixing when the
  measurement itself is wrong — a rewritten benchmark should go back through the
  authoring loop, not be smuggled in via review.
- If a PR body is missing its embedded `--quick` JSON (ralph normally adds it), judge
  from code and say so in your report.
