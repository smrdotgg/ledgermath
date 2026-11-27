# Contributing to LedgerMath

LedgerMath runs small benchmarks on real cloud machines several times a day and keeps every
execution as a Run, a record that is never edited. Numbers are worked out afterwards from
the Runs by a versioned Method. The working rules are in GitHub issue #36 ("Build plan:
record every Run, judge afterwards"); the words used here (Run, Series, Method, Derivation)
are defined in the [glossary](site/content/docs/glossary.md). The [README](README.md) says how every part works;
this guide says where to make each kind of change and what a pull request needs.

What you can add without access to the AWS accounts: a benchmark, a parameter set, a target
or boot time in the schedule, a Method version, a price rule set, and changes to the tools.
What only the maintainer does: deploying (`bunx sst deploy`; `production-runs` goes to the
production account, every other `-runs` stage to the development account), the checks that
read an account (`scripts/check-targets.ts --stage`), and anything that needs a higher vCPU
quota.

## Write a benchmark, in any language

A benchmark is one directory, `benchmarks/<name>/`, that builds one statically linked
x86-64 Linux binary. The binary may be written in any language; the contract is what it
reads and what it prints. The contract is section 2 of
[`docs/dev-log.md`](docs/dev-log.md#2-the-contract-read-this-twice): read it whole. In short:

- **What it reads.** Only environment variables: `LM_PARAM_<KEY>` for each parameter
  (upper-cased key, value as a plain string) and `LM_SAMPLES`, the number of counted samples.
  The runner (`runner/run.py`) gives it nothing else: no `PATH`, no `HOME`, an empty working
  directory, stdin from `/dev/null`. `--quick` is a developer mode (small sizes, few
  samples): the scheduled box never passes it, and no Method counts a Run whose stream says
  `quick: true`, though `runner/run.py --quick` still writes one.
- **What it prints.** On stdout, one JSON object per line and nothing else; diagnostics go to
  stderr. Every line has `event` and `t`, whole nanoseconds of `CLOCK_MONOTONIC_RAW`. The six
  universal events are `started`, `observed`, `sample_started`, `sample_ended`, `verified`
  and `finished`. It prints only what it observed, never a value it was told:
  `observed` holds the counterparts of its parameters (bytes actually processed per
  repetition, threads actually used, the code path actually taken). Observe
  `bytes_per_repetition` if bytes per second should be derived for it. The shape of each
  line is [`schemas/events.schema.json`](schemas/events.schema.json).
- **The order rules.** `started` first and once; `finished` last and once; samples numbered
  from 0, each `sample_started` closed by its own `sample_ended` before the next starts;
  warmup samples tagged, never dropped; each `observed` key once; exactly one `verified`;
  as many counted samples as `LM_SAMPLES`. No clock read inside a sample, only at its two
  edges. [`scripts/check-events.py`](scripts/check-events.py) is the authority, and Method
  version 1 counts a Run only when its stream passes the same rules.
- **The elision guard.** The measured loop must return a value derived from the data it
  processed, printed once as `verified` (`0x` and sixteen hex digits), so the compiler
  cannot delete the work. Where the right answer is knowable, check it at startup and exit
  non-zero on a mismatch. [Why](docs/dev-log.md#why-verified-exists-the-compiler-elision-trap).
- **Static linking.** One self-contained file, so the hash of its bytes covers its own code
  and every library it was built with (ADR-0008,
  [`docs/adr/0008-static-linking-with-glibc.md`](docs/adr/0008-static-linking-with-glibc.md)).
- **A parameter set it cannot run here** (too few CPUs, a kernel without `io_uring`): exit
  2 after printing `started` alone, with one stderr line saying why. A run that fails is
  still a Run; nothing is hidden.

The directory holds the source, a `Makefile` and a `README.md`:

- The `Makefile` offers `make BUILD=static` (and `BUILD=dynamic` if the schedule asks for
  it), writing `build/<build>/<name>`; `make -s compiler`, one line naming the compiler and
  its version; and `make -s resolved`, what the compiler resolved for this machine. The
  runner calls exactly these. [`benchmarks/sort/Makefile`](benchmarks/sort/Makefile) is a
  short one to copy.
- The `README.md` says what one repetition is and what it measures, its parameters, what it
  observes, its elision guard, and what its numbers must not be used for.
  [`benchmarks/tcp_echo/README.md`](benchmarks/tcp_echo/README.md) is a short one. It is
  also the benchmark's page at `https://ledgermath.com/docs/benchmarks/<name>`, for readers
  who have a number from the data API and no repository. So it opens with `# <name>` and
  one paragraph of one or two sentences saying what the benchmark measures, which the index
  of pages shows on its own, then has these headings, in this order: "What a figure means"
  (what one repetition is, the figure's unit, and what bytes per second counts), "What a
  figure does not show", "Parameters" (each with the values the schedule runs), "Observed
  values", "Findings", "How it works" (its elision guard and its own events) and "Building
  and testing". A link to another file of the repository is relative; a link to another
  page of the documentation is its full address. `tests/benchmark-pages.test.ts` checks the
  headings.
- The C benchmarks share a harness, [`benchmarks/harness/c/`](benchmarks/harness/c/), which
  prints the stream. A benchmark in another language prints the same lines without it.

The box builds every benchmark itself, at boot, with what
[`runner/box.sh`](runner/box.sh) installs from the image's own Amazon Linux release
(today `gcc`, `make` and `glibc-static`). A benchmark in another language adds its compiler
to that install line. That is a change under `runner/`, which Method version 1 splits
every Series on, so say so in the pull request.

Add one line for it to [`scripts/lib/benchmark-notes.ts`](scripts/lib/benchmark-notes.ts):
what it measures and what one repetition is, in the README's words. The lookup tool shows
it to agents, and `bun test` fails until it is there.

## Add it to the schedule

[`schedule.json`](schedule.json) says what each box runs: one entry per benchmark (its
`name` is the directory's), with `builds`, `samples`, `timeout_seconds`, the parameter sets
under `params`, and optionally `instance_types` to run it on some targets only. The README's
section ["Targets, boot times, and which types an entry runs on"](README.md#targets-boot-times-and-which-types-an-entry-runs-on)
has the format and everything the check (`infra/runs/schedule.ts`) refuses. Each boot has a
35-minute budget for the whole schedule, so say how long one execution takes.

A benchmark that needs something prepared at boot, such as a Fixture on a disk, needs
[`runner/provision.py`](runner/provision.py) to make it; see the README's section
["The disks"](README.md#the-disks).

## Add an instance type or a boot time

Both are lines in `schedule.json`'s `targets`; the same README section says how, and what
the check refuses (a second zone, boots less than 60 minutes apart, a total beyond the
account's vCPU quota). A new instance type's price is in the next day's price file without
further work: the price rules select each scheduled type. The maintainer checks the
declared numbers against AWS (`scripts/check-targets.ts`) and deploys; schedules change
only with a deploy.

## Propose a Method version

A Method turns Runs into Derivations; [`methods/README.md`](methods/README.md) describes
the two there are, `series` v1 (`methods/v1/`) and `requests` v1 (`methods/requests/v1/`).
Once a version's Derivations are published, it is never edited: a change to what it outputs
is a new version in its own directory (`methods/v2/` beside `methods/v1/` for `series`,
`methods/requests/v2/` for `requests`), with its own `output.ts`, and `scripts/derive.ts`,
the page (`scripts/build-page.ts`) and the lookup tool (which reads the data API's
`series_v1` and `requests_v1` only, `scripts/lib/lookup.ts` and `scripts/lib/citation.ts`) learn to choose it. The data API (`scripts/lib/api.ts`) gives
it a key of its own, `series_v2` beside `series_v1`, never in its place (ADR-0030). A record kept of a stream is keyed by the
digest of the code that made it (`methods/records.ts`), so any change to that code makes
every stream be read again once, and records kept by other code are never read. A stored Run is never touched. The pull request says what the new
version does differently and shows it on the Runs: what it splits or counts that the old
one did not, and why.

Price rules follow the same rule: a change to what a price file keeps is a new rule set
version beside the old one in [`scripts/lib/price-rules.ts`](scripts/lib/price-rules.ts),
never an edit to one a stored file names.

## Run every check locally

```bash
bun install --frozen-lockfile
bun test                               # needs gcc with the static C library, and Python 3
bunx tsc --noEmit

# One benchmark (here sort), built as the box builds it, and its stream checked; its
# README lists its LM_PARAM_* variables, and schedule.json the values a box gives them:
make -C benchmarks/sort
./benchmarks/sort/build/static/sort --quick | python3 scripts/check-events.py --quick
LM_PARAM_SIZE_BYTES=1048576 LM_SAMPLES=10 ./benchmarks/sort/build/static/sort \
  | python3 scripts/check-events.py --samples 10

# Every static build runs as the only file in a FROM scratch container, once per
# parameter set of schedule.json (needs Docker):
python3 scripts/check-scratch.py sort

# The box's whole boot, in Amazon Linux 2023, with the bucket as a local directory
# (needs Docker; about nine minutes), when you change runner/ or the schedule:
scripts/box-in-container/run.sh --worktree /tmp/box-test
```

A benchmark that can refuse a parameter set (exit 2 after `started` alone, as above) needs
two additions to `scripts/check-scratch.py`, or `check-scratch.py` fails it on any machine
that lacks the capability:

- `unmet(name, params, topology)` decides, from this machine and before running the binary,
  that it cannot provide what the set asks for, and returns why (`mutex` reads the CPU
  topology in `/sys`, `disk_read_io_uring` reads `kernel.io_uring_disabled`). It returns
  `None` for a benchmark it does not know, and a set with no reason must then run and pass:
  its exit 2 is a failure, and nothing else is consulted.
- `refusal(name, params)` gives the start of the stderr line with which the binary refuses
  that set. Only when `unmet()` gave a reason does the check accept the run as skipped, and
  only if the binary exited 2, printed `started` alone, and wrote that line.

GitHub runs `bun test` and `check-scratch.py` on every push (`.github/workflows/check.yml`).

## What a pull request says

- **What changes, in one sentence**, and for a benchmark, what one repetition measures.
- **Which Series it adds or changes**: benchmark, parameter sets, builds, instance types.
  Any change to a benchmark's source or build changes its binary's bytes, and any change
  under `runner/` changes the runner; Method version 1 starts a new group in every Series
  either touches. Say whether the numbers should move, and why.
- **The evidence**: the checks above that you ran and what they printed, a stream from a
  full-length execution with the schedule's parameters, and the numbers you saw with the
  machine you saw them on. A number a thousand times off is elision or a unit.
- **What it costs a boot**: seconds per execution, against the 35-minute budget.
- **For a Method or a rule set**: the new version, and that no published version changed.

Never edit a Run, a boot summary or a price file: they are added once and kept as they
are. A correction is a new Method version, never a changed record.

## Licence

A contribution to this repository is made under its licence, the Apache License 2.0
([`LICENSE`](LICENSE)), whose section 5 provides that anything submitted for inclusion is
under its terms unless the contributor says otherwise. Code that comes from another project
keeps its own licence: name it in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) in the
same pull request. The Runs that the project's own boxes produce are published under CC BY
4.0 in the Runs repository ([`docs/runs-repository/README.md`](docs/runs-repository/README.md)).
