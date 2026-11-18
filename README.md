# ledgermath

LedgerMath is a server benchmarking tool. A benchmark is one statically linked native
binary that prints a stream of events to stdout, one JSON object per line, and
diagnostics to stderr. A box on EC2 builds it, runs it as an ordinary process, dumps
its own environment around every execution, and writes one Run per execution: a
self-describing record kept forever. The plan is GitHub issue #36; step 2, one Run end
to end, is #37; step 3, the first Method and a page, is #39; step 6, prices, is #45; step 7,
the agent skill and opening the repository, is #47.
`docs/dev-log.md` section 2 is the event contract.

Two pipelines live here. The new one, described first, writes Runs. July's proof of
concept (`benchmarks/c/`, its own JSON format) was retired on 2026-11-13; its code stays,
as the base the build started from (last section).

## Layout

| Path | What it is |
|------|------------|
| `benchmarks/harness/c/` | The C harness that prints the event stream (`lm.h`, `lm.c`); `lm_event.h` and `lm_event.c`, which emit a benchmark's own events and further `observed` events; `lm_fixed.h` and `lm_fixed.c`, samples of fixed work; `lm_disk.h` and `lm_disk.c`, what a disk benchmark observes about its file and device; `lm_fixture.h`, the disk Fixture's pattern |
| `benchmarks/<name>/` | One benchmark on the stream: its source, a `README.md` (what it measures, its parameters and observed values, how it differs from July's), and a `Makefile` (`make BUILD=static`, `BUILD=dynamic`, `make -s compiler`, `make -s resolved`). All thirteen: `memory_read`, `compressed_memory_read`, `memory_read_random`, `memory_write`, `syscall`, `hash`, `sort`, `tcp_echo`, `mutex`, `disk_read_random`, `disk_read_io_uring`, `disk_read_sequential`, `disk_write` |
| `schedule.json` | The targets (instance types, their zone, the times of day each boots) and what a box runs: benchmarks, builds, samples, timeout, parameter sets, and the instance types an entry is for. Checked by `infra/runs/schedule.ts` |
| `runner/` | The box side: `box.sh` (user-data), `provision.py` (prepares the disks at boot and records it), `fixture.c` (writes a disk Fixture), `aws-lc-archive.sh` (fetches and checks the TLS library's source for `http_get`'s build), `run.py` (builds, runs, dumps, gives a Service's inputs to the entries that name it, writes Runs), `cpuid.c` |
| `schemas/` | `run.schema.json` (the Run), `events.schema.json` (one line of the stream) and `prices.schema.json` (a price file) |
| `scripts/check-events.py` | Checks a stream's order; needs only Python 3 |
| `scripts/check-runs.ts` | Checks a directory laid out like the bucket: schemas, every hash, every stream read from its stdout blob, runner manifests |
| `scripts/check-disk-runs.ts` | Checks that every disk Run in such a directory found the disk it declares, that its evidence adds up, and that its dump bears it out |
| `scripts/check-targets.ts` | Checks `schedule.json`'s targets' `vcpus`, their zone offerings and `vcpu_quota.limit` against AWS, read-only, in the account of the stage it is given; needs AWS access, so not part of `bun test` |
| `scripts/box-in-container/` | Boots `runner/box.sh` in Amazon Linux 2023 with S3 and shutdown stubbed, in several scenarios, `http_get` against a stand-in for S3 among them |
| `infra/runs/` | The `-runs` SST stage: stack, launch Lambda, reaper, user-data, the schedule's check (`schedule.ts`), the targets and their launch schedules (`placement.ts`), which account a stage deploys to and which one stage is scheduled (`stages.ts`), what stops SST acting on another account than a stage's (`deploy-account.ts`), the workflow's AWS role, the `s3_fixtures` Service's bucket, objects and role (`fixtures.ts`), AWS-LC's source archive (`tls-archive.ts`), the public blobs' CloudFront distribution on the Free plan, for one stage, off until switched on (`public-blobs.ts`; what a deploy may do from what is deployed, `public-blobs-guard.ts`; the resources, `public-blobs-stack.ts`; the watch that disables it without a plan, `plan-watch.ts`, `plan-watch-handler.ts`) |
| `methods/` | Methods, versioned, turning Runs into Derivations (`methods/README.md`): `series` v1 (`v1/`) one number per Run for every Series; `requests` v1 (`requests/v1/`) each phase of a request across requests, for the Series of requests; `records.ts` the reduced record of a stream, kept between runs |
| `scripts/copy-runs.ts` | The copy job: the bucket's Run files and boot summaries into the Runs repository |
| `scripts/copy-bucket.ts` | Copies one `-runs` bucket into another, across two accounts, only ever adding, and checks the copy (`scripts/lib/bucket-copy.ts`): the move to the production account |
| `scripts/derive.ts`, `scripts/build-page.ts` | Run the Methods over the Runs; turn their Derivations into the page |
| `scripts/alarm.ts` | Opens, or comments on, one issue when a watched Series has had no Run for 48 hours, or the newest price file is more than 48 hours old |
| `.github/workflows/runs.yml` | All four on a schedule: copy, push, derive, page, alarm |
| `scripts/fetch-prices.ts`, `scripts/check-prices.ts` | Make the day's price file from AWS's public price lists; check a price file by downloading its sources again and cutting them again |
| `scripts/lib/price-rules.ts` | The selection rules, versioned: which of AWS's price records a price file keeps |
| `scripts/lib/offer-file.ts`, `scripts/lib/prices.ts`, `scripts/lib/price-file-check.ts` | Reading AWS's offer files without holding them in memory; the cut, the download and the price file; whether a price file holds together |
| `.github/workflows/prices.yml` | The price fetch, twice a day, adding at most one file a day to the Runs repository |
| `skills/ledgermath/SKILL.md` | The agent skill: napkin math from LedgerMath's numbers, every number cited or marked as an assumption |
| `scripts/lookup.ts` | The lookup tool the skill uses: the Series, one Series' percentiles and Runs, prices by word, each number beside its citation (`scripts/lib/lookup.ts`, `scripts/lib/citation.ts`, `scripts/lib/ledger-data.ts`; what each benchmark measures, `scripts/lib/benchmark-notes.ts`) |
| `scripts/check-answer.ts` | Checks an answer written with the skill: every number from the question, cited, an assumption, recomputed arithmetic, or a repeat; every citation resolving in the data (`scripts/lib/answer-check.ts`, `scripts/lib/quantity.ts`) |
| `site/` | The placeholder website: one page, SolidJS 2, prerendered to static files (section "The website" below); `.github/workflows/site.yml` builds and checks it, and deploys it to Vercel (`site/deploy/`) at https://ledgermath.com |
| `CONTRIBUTING.md` | How to add a benchmark in any language, a target, a Method version, and what a pull request says |
| `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md` | The code's licence (Apache-2.0), its notice, and what comes from other projects, with their licences (section "Licence" below) |
| `third-party/` | glibc 2.34's `COPYING.LIB` and `LICENSES`, and `sources.lock.json`, the third-party source packages kept in the bucket beside the binaries |
| `scripts/publish-third-party-source.ts` | Puts the source packages `third-party/sources.lock.json` names into the bucket, create-only, and reads every one back to check its bytes (`scripts/lib/s3-create.ts` sends its conditional PUT, which `scripts/lib/sigv4.ts` signs) |
| `docs/runs-repository/` | The Runs repository's `README.md` and `LICENSE` (CC BY 4.0), kept here and copied there |
| `tests/` | `bun test`: the schemas against sample Runs, the Run checker, the schedule's check, the runner's timeout and stop races and its instance-type filtering, the dump's sections, the disk provisioning's decisions, the disk Fixture and the binaries' checks of it, the launch schedules, which account each stage deploys to and which one is scheduled, that SST stops before acting on another account, launch and reap logic, the box's and the workflow's roles, the Method (and that the move to the production account starts no group), the copy job, the bucket copy against a stand-in for S3, the page, the alarm and the workflows, and the price fetch, cut, schema and recompute check on excerpts of AWS's files (`tests/samples/prices/`) |

## A benchmark, locally

Requires Linux x86_64 with AVX2, gcc and the static C library (`libc6-dev` on Ubuntu,
`glibc-static` on Amazon Linux).

```bash
make -C benchmarks/memory_read                      # build/static/memory_read
./benchmarks/memory_read/build/static/memory_read --quick | python3 scripts/check-events.py --quick
LM_PARAM_SIZE_BYTES=1073741824 LM_PARAM_THREADS=all LM_PARAM_PATH=avx2 LM_SAMPLES=10 \
  ./benchmarks/memory_read/build/static/memory_read
```

`--quick` is a developer mode (small buffer, three samples); its stream is never recorded.
Every benchmark directory works the same way; its `README.md` lists its `LM_PARAM_*`
variables, and `schedule.json` the values a box gives them.

## Tests

```bash
bun install
bun test
python3 scripts/check-scratch.py    # needs Docker
```

`.github/workflows/check.yml` runs the tests, then `scripts/check-scratch.py`: it builds
every benchmark that `schedule.json` builds static, and runs each binary as the only file
in a `FROM scratch` container, once per parameter set with `--quick`, checking every
stream. A parameter set that asks for CPUs this machine does not have, such as `mutex` on
two distinct cores on a machine with one, is decided from the machine's topology and still
run once; it is reported as skipped, with the reason, only when the binary refuses it in
its own words (exit 2, `started` alone on stdout, and its refusal line for that set on
stderr), and anything else fails. Every other set must pass. The disk benchmarks get a 64 MiB Fixture, made by `runner/fixture.c` in a new
directory under `/tmp` (or `$LM_SCRATCH_DISK_DIR`) and mounted at each set's `dir`; under
`--quick` they read at most 64 MiB of a span. `disk_read_io_uring` runs without Docker's
seccomp filter, whose default refuses `io_uring`, and is skipped where the kernel refuses
it (`kernel.io_uring_disabled`), held to the same rule. It then shows that the same container refuses
`memory_read`'s dynamic build. No measured Run goes through Docker.

To boot the box script the way a box does, in `amazonlinux:2023.12.20260710.0` (the
release the pinned image is locked to), with the bucket as a local directory:

```bash
scripts/box-in-container/run.sh /tmp/box-test                           # HEAD, whole schedule
scripts/box-in-container/run.sh --worktree /tmp/box-test                # uncommitted changes
scripts/box-in-container/run.sh --scenario terminated /tmp/box-test     # see below
```

Each scenario boots the box and checks what it should have left
(`scripts/box-in-container/expect.ts`). The container reaches no S3, so every scenario but
the `http-get` ones (below) boots `schedule.json` without the entries that name a Service.
The scenarios are `ok` (the whole schedule for this machine's type as IMDS gives it,
about nine minutes; this machine is not a target, so the entries naming instance types,
`mutex`'s two-thread sets and the instance-store sets, are left out; every disk Run must
tie to its dump, `scripts/check-disk-runs.ts`),
`terminated` (run.py told to stop mid-execution), `shutdown` (every process told to stop,
as a shutdown does), `budget` (the time budget runs out), `blobs-rejected` (the bucket
refuses every blob), `blobs-flaky` (the first upload of blobs drops halfway),
`blobs-present` (the bucket already holds a blob the boot makes) and `instance-types`
(a fake IMDS says the box is an `m5.large`, and the box boots
`scripts/box-in-container/instance-types.json` as its schedule: the entries for other
types are left out and listed in the boot summary, and `mutex`'s one-thread and siblings
sets run from one build, about two minutes). The Runs describe this machine, seen from a
container; in `instance-types` their provider fields are the fake IMDS's. The stand-in
`aws` answers the six EC2 calls the box makes (the catalog records saved in
`scripts/box-in-container/ec2/`). The container has no device node of this machine's
disks, so `provision.py` prepares none, whatever it finds in `/sys`, and the scenarios
check that it did not; the root volume's disk directory is a tmpfs of the container's
own (the schedule's 1 GiB Fixture and 1 GiB scratch file do not fit beside everything
else on a development machine's disk), so the disk Runs there read and write memory and
say so (`device_found` false). The container runs without a seccomp filter, as the box
does.

Three scenarios run `http_get`, booting `scripts/box-in-container/http-get.json` (`syscall`
once, then `http_get`'s five sets as `schedule.json` has them, with the stand-in's CA and
resolver as `ca_file` and `resolv_conf`):

```bash
benchmarks/harness/c/vendor/fetch-aws-lc.sh /tmp/aws-lc.tar.gz      # once, as CI does
AWS_LC_ARCHIVE=/tmp/aws-lc.tar.gz scripts/box-in-container/run.sh --scenario http-get \
  --aws-lc-cache /tmp/aws-lc-cache /tmp/box-http-get
```

- `http-get`: `tests/http-get/standin.py`, the binary's own stand-in for S3 and the
  resolver, runs in a container whose network namespace the box joins, and the user-data
  names it as the fixtures endpoint. The stand-in `aws` answers `sts assume-role` with
  stand-in keys. Every execution must exit 0 and every Run check out; the `http_get` Runs
  must name their Service inputs; the stand-in must have received every request signed
  with the stand-in key ID and carrying its token; and no key may appear in the bucket,
  the box's work directory (apart from the source files it was given, as given), its log,
  or an `aws` command line. About four minutes with AWS-LC already built.
- `http-get-no-archive`: the bucket has no AWS-LC archive. `http_get` alone fails to build,
  recorded as a build failure; `syscall` runs.
- `http-get-refused`: `assume-role` is refused. `http_get` builds, its five executions are
  listed under `not_run` with AWS's words, and `syscall` runs.
- `build-tools-refused`: a stand-in in front of `dnf` refuses `cmake` and `gcc-c++`. The
  box goes on, `http_get` alone fails to build (its build failure says `cmake` is
  missing), and `syscall` runs.

The archive is `--aws-lc-archive FILE`, or `$AWS_LC_ARCHIVE` as for the Makefile and
`scripts/check-scratch.py`; without either, `run.sh` fetches it into OUT with
`vendor/fetch-aws-lc.sh`. `--aws-lc-cache DIR` keeps AWS-LC's build from one boot to the
next, as `AWS_LC_DIR`; a box has no such cache and builds it every boot. The stand-in is not S3: a throwaway CA, answers in a millisecond, no signature
checked. These scenarios show the path, not S3's numbers.

## The daily box: a `-runs` stage

Any SST stage whose name ends in `-runs` deploys `infra/runs/stack.ts`. Every other stage
deploys July's stack, below, unchanged; July's stage, `smr`, must not be deployed.

### Two accounts, one scheduled stage

Two AWS accounts, each reached through a profile of the AWS CLI on the machine that
deploys. `infra/runs/stages.ts` decides which a `-runs` stage deploys to, and nothing
else names a profile (`sst.config.ts` takes a `-runs` stage's settings from it):

| Stage | Account (profile) | On `sst remove` | For |
|-------|-------------------|-----------------|-----|
| `production-runs` | production (`tabot-production`) | the stack is kept, and SST refuses outright (`protect`) | The boxes that boot on the schedule, the bucket that keeps their Runs and blobs for good, and what the `runs` workflow reads, once it is the scheduled stage |
| any other `-runs` stage, such as `smr-runs` | development (`tabot-dev`) | the stack is kept | Trying changes, with boxes launched by hand |

Nothing in the shell that runs SST may choose another account. SST 4.17.0 lets a non-empty
`AWS_PROFILE` take the place of the profile `stages.ts` gives it, drops that profile under
`SST_AWS_NO_PROFILE`, and gives the provider that makes the stage's resources no profile of
its own: only `AWS_PROFILE` in its environment, after keys there (`AWS_ACCESS_KEY_ID` and
the rest, as `eval "$(aws configure export-credentials ...)"` leaves them) and a web identity
(`AWS_WEB_IDENTITY_TOKEN_FILE`). So for every `-runs` stage and every SST command (`deploy`,
`diff`, `dev`, `remove` and the rest), `sst.config.ts` stops SST before its first request
when the environment, or the `.env` SST loads after `app()`, holds an `AWS_PROFILE` other
than the stage's own, `SST_AWS_NO_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_ACCESS_KEY`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SECRET_KEY`, `AWS_SESSION_TOKEN` or
`AWS_WEB_IDENTITY_TOKEN_FILE` (`infra/runs/deploy-account.ts`). That `.env` is the one
beside the config SST selected, found from the file SST evaluates `app()` in,
`<that config's directory>/.sst/platform/sst.config.<n>.mjs`: wherever SST runs, and with
or without `--config`. Evaluated anywhere else (by another version of SST, say), `app()` cannot
tell which `.env` SST will load, and refuses. A line of that `.env` naming another account is
refused even when the shell already sets the variable (to the stage's profile, or empty), so
that SST, which lets the file replace no variable already set, would keep the shell's value:
the same checkout, run from a shell without it, would take the file's, so the line goes.
SST then prints only
"Unexpected error occurred"; the refusal, which names each variable and what to unset, is
written to the terminal, and SST keeps it in the log it starts each command with,
`/tmp/sst-<date>-<time>.log` (seen with `sst diff`: a stop in `app()` comes before SST has a
`.sst/log/sst.log` for the command); `--print-logs` prints it. A second check, in the stack before it
declares anything, compares the account the provider acts in with the one `aws sts
get-caller-identity --profile <the stage's profile>` names, and stops on a difference; it runs
for `sst deploy`, `diff`, `dev` and `refresh` (`sst remove` runs no program), and after SST's
own requests (its bootstrap, its state). Neither writes an account ID anywhere. What they
do not check: what a profile is. A profile is what the AWS CLI's configuration says it is,
`AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` included, for SST as for `aws`. No recipe
in this README exports a profile or keys: each `aws` command names its profile, and a script
that reads keys from the environment is given them in a subshell of its own.

What lives where:

- **Production**: the stage `production-runs` (its Runs bucket and fixtures bucket, launch
  function, reaper, box and fixtures roles, GitHub's OIDC provider and the role the
  workflow assumes) and SST's own state for the account.
- **Development**: the stage `smr-runs` (the same parts; its bucket holds every Run made
  before the move and is kept as it is), the dev machine, July's retired stack (stage
  `smr`) and its bucket, and SST's own state for the account.

One stage is the scheduled one: `SCHEDULED_STAGE` in `infra/runs/stages.ts`. Only it gets
the launch schedules below. Every other `-runs` stage gets the launch function, the reaper,
the buckets and the roles, and no schedule: its boxes start only by hand. Its launch
function's list of targets (`LEDGERMATH_TARGET_INSTANCE_TYPES`) names none, so a scheduled
payload, from a schedule left behind for instance, is refused and launches nothing; a launch
by hand names its type and is unaffected. The scheduled stage is `smr-runs` until the move
to the production account, below ("Moving the schedule to the production account"), which
makes it `production-runs`. The alarm and the workflow know no stage: the alarm watches
`schedule.json`'s targets in the Runs repository, which the workflow fills from the bucket
named by `RUNS_BUCKET`, so that must be the scheduled stage's bucket (if it is not, the
alarm reports every watched Series within 48 hours).

Each account has its own vCPU quota (`vcpu_quota` in `schedule.json` declares the scheduled
stage's account's; `reserved_outside_schedule` is what launches by hand and, in the
development account, the dev machine may hold), its own GitHub OIDC provider (an account
holds one per URL, so only one `-runs` stage per account can create it: `production-runs`
in production, `smr-runs` in development, where a second `-runs` stage would fail to
deploy), and its own SST state.

`schedule.json` names the targets: an instance type, its zone, and the times of day,
UTC, it boots. Today there are five, all in `us-east-2c`, four boots a day each:

| Type | vCPUs | Boots (UTC) |
|------|-------|-------------|
| `c6i.8xlarge` | 32 | 04:10, 10:10, 16:10, 22:10 |
| `m5.large` | 2 | 04:20, 10:20, 16:20, 22:20 |
| `c8i.2xlarge` | 8 | 04:30, 10:30, 16:30, 22:30 |
| `c8a.2xlarge` | 8 | 04:40, 10:40, 16:40, 22:40 |
| `i4i.2xlarge` | 8 | 04:50, 10:50, 16:50, 22:50 |

The scheduled stage makes one EventBridge schedule per target, a cron listing its boot times (for
`c6i.8xlarge`, `cron(10 4,10,16,22 * * ? *)`), and every schedule invokes the one launch
Lambda with the scheduled time and the instance type. The Lambda launches one box of that
type from `ami-03499a87bbb39a09a` (Amazon Linux 2023.12.20260710.0, the image July's
pipeline used from 2026-07-18 until it was retired). The Lambda is never retried, Lambda
drops the invocation if it waited in Lambda's queue for more than a minute, and the
handler refuses a scheduled launch more than ten minutes after its scheduled time, so a
late box cannot overlap boots the schedule keeps apart, and refuses a scheduled launch of
a type that is not a target. A scheduled launch's EC2 client token comes from the stage,
the instance type and the scheduled time, so one slot of one target can start at most one
box. Its user-data is `runner/box.sh`, which:

1. sets a shutdown timer that ends the box 45 minutes after it started, whatever happens;
2. installs `gcc`, `make`, `glibc-static`, `tar`, `gzip`, `util-linux`, `nvme-cli`,
   `xfsprogs` and `ethtool` from the image's own release (the image already has
   `ethtool`); then, in a step of their own that may fail without stopping the boot,
   `cmake` and `gcc-c++` for AWS-LC, the TLS library `http_get` links: without them only
   `http_get` fails to build;
3. fetches `source/<commit>.tar.gz`, a `git archive` of the deployed commit, and refuses to
   go on if the archive's commit or its own text is not that commit's; then fetches
   AWS-LC's source archive, a blob the deploy put in the bucket, checks it against
   `benchmarks/harness/c/vendor/aws-lc.lock` (`runner/aws-lc-archive.sh`), and gives its
   path to the builds as `AWS_LC_ARCHIVE`. If that fails, only `http_get` fails to build;
4. builds `runner/cpuid.c` and `runner/fixture.c`, and prepares the disks with
   `runner/provision.py` (below, "The disks"), which records everything it runs; nothing
   it does or fails to do stops the boot;
5. runs `runner/run.py` until 35 minutes after the box
   started. `run.py` reads the box's instance type from IMDS and runs the entries of
   `schedule.json` for it: every entry without `instance_types`, and every entry whose
   `instance_types` names it. It builds each of their benchmarks once, in each build the
   schedule names (`memory_read` static and dynamic, the others static), and writes one
   Run per execution. At 35 minutes it is sent TERM: it kills the binary it is running, still
   writes that execution's Run, starts nothing more, writes the boot summary, which lists
   what was not run, and exits. If it has not exited three minutes later, it is killed
   outright.

   The budget is not always enough. The disk benchmarks run last, and each disk set may
   run until its timeout of 180 seconds: on an `i4i.2xlarge` the eleven disk sets'
   timeouts alone add up to 33 minutes (the six root-volume sets on the other types, 18
   minutes), and provisioning, before `run.py`, may use up to 6 of the same 35 minutes.
   So if a disk misbehaves and its sets run to their timeouts, the budget ends the boot:
   the execution in flight still gets its Run, the rest are listed under `not_run`, and
   what exists is uploaded. On the real boxes the whole boot took 13 and 10.5 minutes;
6. uploads the blobs the bucket does not hold yet, then the Runs and the boot summary, then
   its log, and shuts down, which terminates the instance.

The stage's bucket is versioned, so a second write to a key keeps the first. It ends up
holding:

```
runs/<yyyy>/<mm>/<dd>/<id>.json      one Run (schemas/run.schema.json)
blobs/sha256/<hex>                   every blob a Run cites: binaries, dumps, stdout, stderr;
                                     and, put there by the deploy, AWS-LC's source archive and
                                     the bytes of each Fixture of the s3_fixtures Service
boots/<yyyy>/<mm>/<dd>/<boot>.json   what one boot ran, and what it did not
logs/<yyyy>/<mm>/<dd>/<boot>.log     the box's log
source/<commit>.tar.gz               the deployed source
```

A Run's events are its stdout blob, for every Run. `run.py` copies none of them into the
record and does not parse stdout: the Run names the blob and gives its size and number of
lines (`stdout_bytes`, `stdout_lines`), so Run files stay at about 2 KB for the small
benchmarks and 4 KB for `http_get`, whose streams are 130 to 620 KB. Runs written before
this change also hold their events as `events` (and, had a line failed to parse,
`events_error`); they are never edited, and they stay valid. Every reader reads the stdout
blob, for every Run, through one function, `readStream` in `methods/run.ts`:
`scripts/check-runs.ts` (which also checks that an older Run's `events` equal its blob),
`scripts/check-disk-runs.ts`, the container checks, and Method version 1. The lookup tool
and the page read Derivations, not events.

A reaper runs every five minutes and terminates any box of the stage older than 50
minutes. It touches nothing else; July's reaper cannot touch these boxes either.

The box's role reads its source and AWS-LC's archive, lists `blobs/`, writes `runs/`,
`blobs/`, `boots/` and `logs/`, calls six read-only EC2 actions
(`ec2:DescribeInstanceTypes`, `ec2:DescribeVolumes`, `ec2:DescribeVolumeStatus`,
`ec2:DescribeInstances`, `ec2:DescribeRouteTables`, `ec2:DescribeVpcEndpoints`), and may
assume the fixtures reader role, nothing else (`infra/runs/box-role.ts`).

### The Service benchmarks: `s3_fixtures`

`http_get` measures S3 from outside: HTTPS GETs of objects in a private bucket the stage
makes, signed with short-lived keys. A schedule entry says which Service its benchmark
measures, `"service": "s3_fixtures"`, the one Service there is (`infra/runs/schedule.ts`
refuses another name).

The fixtures bucket (`FixturesBucket`, `infra/runs/fixtures.ts`) is separate from the Runs
bucket: never versioned, private, SSE-S3 by default, HTTPS only, no CORS, lifecycle or
logging, and named without dots (S3's certificate covers one label). It holds three
objects, `http_get/v1/4096`, `http_get/v1/131072` and `http_get/v1/16777216`: the first N
bytes of the Fixture pattern of `benchmarks/harness/c/lm_fixture.h`, the pattern
`runner/fixture.c` writes to disk, generated in TypeScript at deploy (the tests compare
them with `fixture.c`'s bytes and the digests `benchmarks/http_get/README.md` lists).
`http_get` checks every body against the pattern and against the `x-amz-checksum-sha256`
S3 returns, so each object needs a SHA-256 checksum over the whole object, in the STANDARD
class. The provider uploads anything over 5 MiB in parts, and S3's SHA-256 of a multipart
object is a checksum of the parts' checksums, so the deploy does not upload into the
fixtures bucket: it uploads each Fixture to the Runs bucket as `blobs/sha256/<hex>`, and
S3 copies that blob into the fixtures bucket (`aws.s3.ObjectCopy`, the SHA256 algorithm).
A copy is one object in a single part, and S3 computes its checksum over the whole of it.
A new pattern or size gets a new key; an object is never overwritten with other bytes.

The fixtures reader role may be assumed by the box's role alone, and may do one thing:
`s3:GetObject` on those three objects. A session assumed from a role the box already holds
is role chaining, and lasts at most an hour.

How the keys travel. The launch puts the Service's values in the user-data,
`LEDGERMATH_FIXTURES_ENDPOINT` (`https://<fixtures bucket>.s3.us-east-2.amazonaws.com`),
`LEDGERMATH_FIXTURES_REGION` and `LEDGERMATH_FIXTURES_ROLE`, none of them secret. When an
entry naming `s3_fixtures` is first about to run, after its build, `run.py` runs `aws sts
assume-role` once for the boot and reads the keys from what it printed. They stay in
`run.py`'s memory until an execution of such an entry starts; that execution's
environment, and no other, gets `LM_SERVICE_ENDPOINT`, `LM_SERVICE_REGION`,
`LM_SERVICE_AWS_ACCESS_KEY_ID`, `LM_SERVICE_AWS_SECRET_ACCESS_KEY` and
`LM_SERVICE_AWS_SESSION_TOKEN` beside its `LM_PARAM_*`. Where they must never go, and
`tests/service.test.ts` and the `http-get` container scenario search for them: a Run, a
blob, a dump, the boot summary, a log line, an exception message, `run.py`'s own
environment (every command the dump runs inherits it, and its output is recorded), or a
command line. What `assume-role` printed is never recorded, whatever its shape: a reply
that does not parse is reported by its length. The binary's own guard keeps them out of
its stdout and stderr (`benchmarks/http_get/README.md`).

The Run says which Service inputs it was given, as it says which params: `service` holds
the Service's name, `inputs` (the endpoint and the Region, exactly as delivered) and
`secret_inputs` (the names of the three keys, never their values). A Run of an entry
without a Service has no `service` and is written exactly as before. When the keys cannot
be had (no values in the user-data, `assume-role` refused or failing, a reply without
keys), the entry's executions are not run: the boot summary lists them under `not_run`
with the reason, `services` says what became of the Service (the session's name and when
its keys expire, or why there are none), the rest of the boot goes on, and `run.py` exits
1, as for a build failure.

The dump records the path to S3 rather than assuming it. Once per boot, stored once,
`ec2_route_tables` (`describe-route-tables` for the table associated with the box's
subnet, and for the VPC's main table, which decides when none is) and
`ec2_vpc_endpoints` (`describe-vpc-endpoints` for the VPC); today the subnet has no table
of its own, the main table sends `0.0.0.0/0` to an internet gateway, and the VPC has no
endpoint. Around every Run, `network` (the routes, every interface's MTU, the TCP and
socket settings, `/etc/resolv.conf` and the resolver's other files, and `ethtool -i` of the
default route's interface) and `net_counters` (`ethtool -S` of that interface, whose ENA
`*_allowance_exceeded` counters say whether the instance shaped the traffic, and
`/proc/net/dev`, `/proc/net/snmp`, `/proc/net/netstat`). `net_counters` changes on every
read, so Method version 1 neither fetches nor splits on it, as with `block_stat`; it splits
on none of the four.

### The disks

The four disk benchmarks each name the disk a parameter set means, `"disk":
"root_volume"` or `"instance_store"`, which makes the Series, and the directory the
binary works in, `"dir"`. The binary never reads `disk`; it reports the file and device it
found (`observed`) and the change in the device's counters over its measuring
(`device_counters`). That change covers the whole measuring call, warmup samples and the
gaps between samples included, and every request to the device in that time, whoever
made it. So it shows that the device, not the page cache, served at least the bytes the
measured reads asked for, and it gives upper bounds of the writes and flushes a durable
write cost; it cannot tell the benchmark's requests from anyone else's. The `nvme amzn
stats` histograms in the dump, taken before and after each Run, cover the whole process
(a `disk_write` preparing its scratch file included) and everything else on the device.

On a `-runs` box, before `run.py`, `runner/provision.py`:

- finds the instance's own NVMe disk by its model, `Amazon EC2 NVMe Instance Storage`,
  never by its kernel name, and prepares it only when it is the one disk the catalog
  (`describe-instance-types`) lists and is empty: no partition, no holder, not mounted.
  Information that is missing, empty or unreadable (a model, a serial, a size, a holders
  directory, the mount table) is a refusal that says which, never a pass.
  From then on the disk is its device number: provisioning makes a block device node of
  its own for that `major:minor` (`mknod`, under `/dev/ledgermath`, which only root can
  write), so the node it works through can never come to mean another device, and nothing
  runs on the kernel's name for the disk. The node must be on a file system that allows
  device nodes, which provisioning checks in `/proc/self/mountinfo` first: on the image
  `/run` is mounted `nodev`, and a node there can be made but not opened, even by root;
  `/dev` (devtmpfs) is not. It records the disk (`lsblk`, `blkid`, `nvme id-ctrl`, `nvme
  id-ns`, `nvme amzn stats`), then opens it read-only and holds that descriptor until the
  mounted file system is confirmed, so the kernel cannot release the number for another
  disk in between. With it held, immediately before formatting, it checks everything
  again: through the descriptor, the device number, the size and the first MiB; by the
  number, the same disk in `/sys/dev/block/<major:minor>` (name, model, serial, size), no
  partition, holder or mount; and `blkid -p` exits 2 and prints nothing (it also exits 2
  when it cannot open the device). Then a default XFS file system (`mkfs.xfs`, never
  forced), the mount point made, `mount -t xfs` at `/mnt/lm/instance-store`, and the
  mounted file system's device number, by `stat` and by `/proc/self/mountinfo`, must be the
  number checked, with the disk's model and serial still the ones checked. If the mount
  fails or anything differs, the file system is unmounted and the mount point removed, so
  an instance-store set finds no directory and fails, saying why, instead of running on
  the root volume. Because the mount is made through that node, `findmnt` and a Run's
  `mount_source` read `/dev/ledgermath/instance-store-259-1` (for device 259:1), not
  `/dev/nvme1n1`.
  Anything else is refused and recorded. Of the targets only `i4i.2xlarge` has such a disk
  (one of 1,875 GB); the other types have no such step;
- makes the Fixtures with `runner/fixture.c` (`O_DIRECT` writes of 1 MiB, then
  `fdatasync`): 32 GiB on the instance store, and 1 GiB under `/var/tmp/ledgermath/disk` on
  the root volume on every type. A Fixture not made whole is removed, and the root
  volume's directory exists only when its Fixture was made;
- writes every command, exit code, output and timing to
  `/var/tmp/ledgermath/provision.json`, which every dump holds as the section `provision`.
  The record is rewritten whole (written beside it, then renamed) as provisioning starts,
  as each step starts and as it ends, so it always says what every step that started did,
  the one in progress included.

Every command it runs is in a process group of its own. A step that runs past its time,
or is told to stop, has its whole group sent TERM, then KILL five seconds later; anything
a step leaves running after it exits is killed too, and the record says so. Provisioning
stops itself at 300 seconds, and on SIGTERM, SIGINT or SIGHUP: it records what stopped it
and the output captured so far, undoes what is half done, and exits. `box.sh` runs it with
`--supervise-seconds 330`, its outer limit: the work runs as a child in a session of its
own, whose id the supervisor writes at once to `/var/tmp/ledgermath/provision.session`; it
is sent TERM at 330 seconds and KILL 15 seconds later (5, when the supervisor is itself
told to stop), and then every process left in that session is killed, any step whose end
was not recorded is recorded from its output files, and what a killed provisioning left
half done (a mount it did not verify, a partial Fixture, a root-volume directory without
one) is undone. `box.sh`'s own limit, `timeout --kill-after=10 360`, is for a supervisor
that is itself stuck. Whatever happened, once provisioning has returned, `box.sh`'s
`provision_leftovers` kills every process left in that session, unmounts the instance
store if the record does not say it was readied, removes an empty mount point with
nothing mounted on it and any Fixture the record does not say was made whole (and the
root volume's directory, if it is then empty), and writes what it did into the record
under `box_sh`; when there is nothing to do, it writes nothing. So nothing of
provisioning is running when the schedule starts, and the record is complete however
provisioning ended. Provisioning took 44 seconds on a real `i4i.2xlarge`, so these
limits, at most six minutes, are far from it.

On a real `i4i.2xlarge` this took 43 seconds: `mkfs.xfs` 6 s (it discards the whole disk
first), the 32 GiB Fixture 30 s, the root volume's 7 s. The root volume is the image's
default, 8 GiB of gp3 (3000 IOPS, 125 MiB/s); with everything installed, the Fixture made
and `disk_write`'s 1 GiB scratch file present, it still had 4.3 GB free.

The dump gains, around every Run, `block_stat` (every `/sys/block/*/stat`) and
`nvme_stats` (`nvme amzn stats` of every Amazon NVMe disk: its own counters, its read and
write latency histograms, and the time it spent over its limits), kept apart from
`devices`, which gains lsblk's sizes, queue and mount columns, the queue settings and
`xfs_info` of every XFS file system; `kernel` gains `/proc/sys/vm/dirty_*`. Once per boot,
stored once: `provision`, and what the EC2 API says, in three sections: `ec2_instance_type`
(the catalog record), `ec2_volumes` (the volumes attached and their status, with their
initialization state) and `ec2_instance` (the instance's own record). An API call that
fails is recorded with what it printed. `ec2_volumes` and `ec2_instance` name the account,
as the IMDS identity document in `provider` already does.

`bun scripts/check-disk-runs.ts DIR` checks, for every disk Run in a directory laid out
like the bucket, that the disk it found is the disk it declares (`instance_store`: an
`Amazon EC2 NVMe Instance Storage` device mounted at exactly its `dir`; `root_volume`: an
`Amazon Elastic Block Store` device holding the root file system; the binary never reads
`disk`, the checker holds what each name means), that the device it names is in its dump
(model and serial in `/sys` and `lsblk`, and `file_device` is lsblk's number for it), that
its counters add up (`change` is `after` minus `before`) and lie between the dump's, that
the device itself counted the reads and writes (`nvme amzn stats`), that an EBS serial
`vol…` is a volume the EC2 API lists, with its type, size and limits, and that an
instance-store disk is the one the provision record readied, by device number. Every
number it compares must be present and finite.

### Targets, boot times, and which types an entry runs on

To add a boot time, add it to the target's `boots_utc`. To add a target, add
`{ "instance_type": ..., "vcpus": ..., "zone": "us-east-2c", "boots_utc": [...] }` to
`targets`. To run a
benchmark entry on some types only, give it `"instance_types": [...]`; without it, it runs
on every target. Two entries may have the same `name`, so one benchmark can run different
parameter sets on different types:

```json
{ "name": "mutex", "builds": ["static"], "samples": 10, "timeout_seconds": 180,
  "params": [{ "threads": 1, "placement": "one_cpu", "critical_section_lines": 1, "lock": "pthread_mutex_default", "idle_threads": 1 }] },
{ "name": "mutex", "builds": ["static"], "samples": 10, "timeout_seconds": 180,
  "instance_types": ["m5.large", "c6i.8xlarge", "c8i.2xlarge", "i4i.2xlarge"],
  "params": [{ "threads": 2, "placement": "smt_siblings", "critical_section_lines": 1, "lock": "pthread_mutex_default", "idle_threads": 0 }] }
```

(`schedule.json` does this for `mutex`: `c8a.2xlarge` has one hardware thread per core,
so it runs no siblings set, and `m5.large` has one core, so it runs no distinct-cores
set.)

Then `bun test`, commit, and deploy: the stage's schedules change only with a deploy, and
a deploy stops if `schedule.json` fails its check (`infra/runs/schedule.ts`). The check
refuses: a malformed target or time; a time listed twice for one target; a type listed as
two targets; targets in more than one zone (the stage launches into one subnet); an
`instance_types` value that is not a target's type; a key it does not know (so a
misspelt `instance_types` cannot silently mean every type); and the same parameter set
twice for one benchmark, build and type. A target's boots usually share one minute past
the hour and so make one schedule; boots at other minutes get a schedule each, named by
the minute (`BoxLaunchC6i8xlargeAt10`).

The check also keeps every box inside the account's vCPU quota, whatever the times.
`"vcpu_quota": { "limit": 64, "reserved_outside_schedule": 4 }` declares the quota and
the dev machine's share. Every target's `vcpus` added together, plus what is reserved,
must fit the limit (58 + 4 = 62 of 64 today), and two boots of one target must be at least
60 minutes apart, across midnight too, because a box lives at most 55 minutes. A new
target's `vcpus` is AWS's `DefaultVCpus` for the type. Check every declared number against
AWS, read-only, in the account of the stage that is or will be scheduled:
`bun scripts/check-targets.ts --stage production-runs` reads the production account with
its profile, `--stage smr-runs` the development account.

A boot's summary (`boots/<yyyy>/<mm>/<dd>/<boot>.json`) accounts for every execution the
schedule names: `runs`; `not_run`, with the `reason` (told to stop before starting it, or
its Service's inputs could not be had); `build_failures`, a build that failed, whose
executions did not run; and `left_out`, each execution of an entry for other instance
types, with the `instance_types` it is for. A box whose type
IMDS did not give runs only the entries for every type.

### What a boot guarantees, and what it does not

What `run.py` writes on the box:

- One Run for every execution it started, whether the binary exited, crashed, or was killed
  by the runner's timeout. `exit.timeout_seconds` is there only when the runner's own kill
  ended the binary.
- When `run.py` is sent SIGTERM, SIGINT or SIGHUP, the execution in flight still gets its
  Run: the runner kills the binary and takes the after-dump as usual.
  `exit.runner_signal` records the signal if it arrived before the runner collected the
  binary's exit; a signal that arrives later stops the boot but is not written into that
  Run. Either way `run.py` starts nothing more and writes the boot summary, with
  `stopped_by`, and every execution it did not start listed under `not_run`.

What reaches the bucket:

- A Run or boot summary is uploaded only once every file of `blobs/` has been uploaded, or
  found in the bucket under the same key at the same size. A blob's key is the hash of its
  bytes, and a blob found there is not read back. `run.py` writes every blob before the
  Run that names it, so every hash in an uploaded Run names a blob in the bucket;
  `scripts/check-runs.ts` checks that afterwards.
- Each upload is tried three times. If the blobs still fail, no Run and no boot summary is
  uploaded. If the Runs fail partway, some Runs may be in the bucket without the boot
  summary. The log goes last, also tried three times.
- A failed upload, a failed build or a stopped schedule makes `box.sh` exit non-zero. Its
  log says why, if the log reached the bucket; the instance's console output shows it
  while the instance exists.

Not guaranteed:

- If `run.py` is killed outright (SIGKILL: three minutes after the budget's TERM, or the
  kernel's OOM killer), or the box loses power, fails, or is terminated by the reaper, the
  execution in flight has no Run, and the boot summary may be missing.
- Nothing leaves the box until the end of the boot. A box that dies before then, or cannot
  reach the bucket, leaves no Run, and possibly not even its log.
- If the 45-minute shutdown ends a boot instead of the 35-minute budget, the upload goes on
  only as long as systemd waits for it.
- A Run is written only if its after-dump and blob writes succeed. If they fail, a full disk
  for example, `run.py` stops with an error, which the boot summary records as `error` if
  that write succeeds.
- There is no boot at all when the launch is refused (late, of a type that is not a
  target, or a duplicate of its slot), waits in Lambda's queue for more than a minute, or
  fails. The launch function's log says which.

### Deploy

```bash
STAGE=smr-runs                    # or production-runs, which deploys to the production account
aws sso login --profile tabot-dev # production-runs: --profile tabot-production
bun install
# AWS-LC's source archive, once: the deploy uploads it as a blob, and stops if it is missing
# or its hash is not aws-lc.lock's. AWS_LC_ARCHIVE=<path> points it at a copy elsewhere.
benchmarks/harness/c/vendor/fetch-aws-lc.sh .sst/ledgermath-vendor/aws-lc-5.14.0.tar.gz
git status                        # must be clean (sst-env.d.ts aside): a deploy refuses a tree that differs from HEAD
bunx sst diff --stage "$STAGE"    # what the deploy would add, change and delete
bunx sst deploy --stage "$STAGE"  # the profile and the Region (us-east-2) come from infra/runs/stages.ts
cp .sst/outputs.json ".sst/outputs.$STAGE.json"   # outputs.json is the last deploy's, whichever stage that was
git checkout -- sst-env.d.ts      # SST rewrites it for the stage; the committed one is July's
```

The shell needs no `AWS_PROFILE` and no keys: `sst.config.ts` gives SST the stage's profile,
and refuses a `-runs` stage when the environment names another account (above, "Two
accounts, one scheduled stage"). When SST stops with "Unexpected error occurred", the
terminal says why just above it; so does the newest `/tmp/sst-<date>-<time>.log`, and
`.sst/log/sst.log` for a stop later than `app()`.

Mind the name: `--stage production`, without `-runs`, is July's stack's own production
stage, which `sst.config.ts` still sends to the production account. Never deploy it.

The stage's outputs (bucket, launch function, every target with its boot times and its
schedules' cron expressions and payloads, commit) are printed and written to
`.sst/outputs.json`, which the next deploy of any stage from the same checkout replaces;
the commands below read the copy kept per stage. A stage that is not the scheduled one lists
every target with no schedules. Deploying a new commit is the only way the box's source, or
the schedules, change. Avoid deploying the scheduled stage within ten minutes of a boot
time: a schedule the deploy creates, changes or removes could miss its slot, and while an
old schedule and its replacement both exist, one slot could launch twice. Any other stage
has no schedule, and can be deployed at any time.

`sst diff` changes nothing in a stage, but SST bootstraps itself in an account the first
time it needs its state there, once per account and Region (SST's documentation names `sst
deploy` and `sst dev`; expect a first `sst diff` to do it too, as it reads the same state): a
state bucket `sst-state-<random>` (versioned), an asset bucket `sst-asset-<random>`, an ECR
repository `sst-asset` and the SSM parameter `/sst/bootstrap`; and it stores each stage's
passphrase in the SSM parameter `/sst/passphrase/ledgermath/<stage>` (SecureString). The
development account has them, for `smr` and `smr-runs`; the production account has none
yet.

What the first deploy of `production-runs` creates in the production account, as long as
it is not the scheduled stage: the Runs bucket (versioned, public access blocked, an
HTTPS-only policy, CORS) holding `source/<commit>.tar.gz`, AWS-LC's source archive and the
three Fixture blobs; the fixtures bucket (public access blocked, HTTPS-only) with the
three Fixtures copied into it; the security group `BoxSg` in the default VPC; the box's
role, its policy and its instance profile; the fixtures reader role and its policy; the
launch function (its role, log group, code in SST's asset bucket, and the event-invoke
configuration that stops retries); the reaper (a function likewise, an EventBridge
Scheduler schedule every five minutes and the schedule's role); GitHub's OIDC provider for
`token.actions.githubusercontent.com`; and the role `RunsReaderRole` with its policy. No
launch schedule. Once it is the scheduled stage, a deploy adds the five launch schedules,
each with its role, and sets the launch function's list of targets.

What the first deploy with `http_get` adds to a stage: the fixtures bucket (with its
public access block and HTTPS-only policy), three Fixture blobs in the Runs bucket (16.9
MB) and their three copies in the fixtures bucket, AWS-LC's source archive as a blob (155
MB), the fixtures reader role and its policy; it changes the box's policy (the archive, two
EC2 actions, `sts:AssumeRole` on that role) and the launch function's environment (the
fixtures bucket and role). The Fixture files are written under `.sst/ledgermath-fixtures/`
at every deploy and `sst diff`. The archive and the Fixture blobs are kept for ever like
every blob: they are declared `retainOnDelete`, so when a new pin or recipe changes a key,
the old object is left in the bucket (Pulumi drops it from the stage's state and does not
delete it), and `sst remove` leaves them too, in the bucket the stage's `removal: "retain"`
keeps. Because `run.py` and `box.sh` change, every Run records a
new `runner` hash, and the new packages change the `packages` section (`cmake`, `gcc-c++`
and what they pull in: on the image, judging from the container and a real boot's package
list, `cmake-data`, `cmake-filesystem`, `cmake-rpm-macros`, `emacs-filesystem`, `jsoncpp`,
`libstdc++-devel` and `rhash`): every existing Series starts a new group at that deploy.
That is expected, and says exactly what changed.

### Trigger a boot by hand, and watch it

A launch by hand names its instance type, any type, target or not; there is no default.
It has no scheduled time, so it is never refused as late or as not a target, and it gets
a fresh client token each time. Its Runs are real Runs of that type, and its box runs
the entries of `schedule.json` for that type: every entry without `instance_types`, and
those whose `instance_types` name it.

In a stage that is not the scheduled one, which is what a stage in the development account
is for once the schedule has moved, this is the only way a box starts.

Mind the quota of the stage's account. A box that fails to end itself lives until the
reaper finds it, up to 55 minutes. In the scheduled stage's account, a 2-vCPU type such as
`c6i.large` fits at any time (the worst moment holds 62 of 64 vCPUs), and anything larger
can meet the quota from HH:10 to HH+1:55 for HH = 04, 10, 16 and 22, when the scheduled
boxes may be up (the last launches at HH:50, or up to ten minutes later). In an account with no scheduled stage, the scheduled boxes take nothing:
the development account then holds only the dev machine's 4 vCPUs. The production account's
quota is 5 vCPUs until the increase to 64 is granted, so until then only a type of at most
5 vCPUs, such as the target `m5.large` (2), can be launched there.

```bash
STAGE=smr-runs                                       # or production-runs
ACCOUNT=(--profile tabot-dev --region us-east-2)     # production-runs: --profile tabot-production
FN=$(jq -r .launchFunction ".sst/outputs.$STAGE.json")   # nothing is exported: each command names its account
BUCKET=$(jq -r .bucket ".sst/outputs.$STAGE.json")

aws lambda invoke "${ACCOUNT[@]}" --function-name "$FN" --cli-binary-format raw-in-base64-out \
  --payload '{"instanceType": "c6i.large"}' /tmp/launch.json && cat /tmp/launch.json
# any type: '{"instanceType": "i4i.2xlarge"}'; a payload without instanceType is an error

aws ec2 describe-instances "${ACCOUNT[@]}" --filters "Name=tag:ledgermath-stage,Values=$STAGE" \
  --query 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name,LaunchTime]' --output table
aws ec2 get-console-output "${ACCOUNT[@]}" --instance-id <id> --latest --output text | tail -40

aws s3 ls "${ACCOUNT[@]}" "s3://$BUCKET/logs/" --recursive
aws s3 cp "${ACCOUNT[@]}" "s3://$BUCKET/logs/<yyyy>/<mm>/<dd>/<boot>.log" -
```

### Check what a boot left

With `ACCOUNT` and `BUCKET` as above:

```bash
aws s3 sync "${ACCOUNT[@]}" "s3://$BUCKET" /tmp/runs-bucket --exclude 'source/*' --exclude 'logs/*'
bun scripts/check-runs.ts /tmp/runs-bucket
```

The source archive is also in `blobs/` (a Run's `source`), so this checks every Run's
runner manifest against it too.

### Public blobs: CloudFront on the Free plan

Published numbers are recomputed from Run files and blobs, so the blobs have to be
readable by anyone. A CloudFront distribution on the **Free flat-rate plan** does that:
$0 a month for CloudFront, and no CloudFront overage charge whatever strangers download
(S3 still bills each request that misses the cache: "What it still costs", below). It is
built and **off**:
nothing is public, and nothing of it exists in AWS, until `PUBLIC_BLOBS.state` in
`infra/runs/public-blobs.ts` says so.

**One stage only.** `PUBLIC_BLOBS.stage` names the stage that may have it:
`production-runs`, the stage that holds the permanent data (deployed with the profile
`tabot-production`). On every other stage, `smr-runs` included, nothing of it is created
and AWS is not even asked, whatever `PUBLIC_BLOBS.state` says; the public address exists
only on `production-runs`. Every AWS call the deploy makes, and every command it prints,
uses the profile of the stage being deployed (its provider's, from `sst.config.ts`, or
`AWS_PROFILE`). The workflow keeps reading the bucket directly with its role and is not
affected either way.

**What is public, and what is not.** In the state `on`, `GET` and `HEAD` of

```
https://<distribution>.cloudfront.net/blobs/sha256/<hex>     (stage output publicBlobs.blobAddress)
```

where `<hex>` is the 64 lowercase hex digits of the SHA-256 of the blob's bytes. Nothing
else: not `runs/`, `boots/`, `logs/` or `source/`, not a listing of the bucket, not an
older version of any key. Two locks, each enough alone. The bucket policy lets the
CloudFront service `s3:GetObject` under `blobs/sha256/` only, and only on behalf of this
distribution (`AWS:SourceArn`); never `s3:ListBucket`; and it carries that grant only in
`on`. And the distribution reaches the bucket only from its `blobs/sha256/*` behaviour,
whose viewer-request CloudFront Function answers 404 to any address that is not exactly a
hash, while the default behaviour's function answers 404 to everything; neither 404
reaches the cache or the bucket. Query strings are neither in the cache key nor passed on,
so `?versionId=` never reaches S3. The bucket stays private and its public access block
stays on: CloudFront signs its requests with Origin Access Control.

| Request | Answer |
|---------|--------|
| `GET /blobs/sha256/<hex>` of a blob the bucket holds | 200, the bytes as stored |
| the same, for a blob it does not hold (yet) | 403 `AccessDenied` from S3, which says 403 rather than 404 to a reader that may not list the bucket; CloudFront keeps the error 10 seconds, so a blob that appears later is served soon after |
| any other address, `/` included | 404 from a function |
| plain HTTP | 403 |
| over the per-address limit or the total limit (as WAF estimates them), or from an address on AWS's IP reputation list | 403 from WAF (a custom status such as 429 needs Pro) |

A blob's response carries `Cache-Control: public, max-age=31536000, immutable` (its key
is its hash, so it never changes), `Access-Control-Allow-Origin: *` (a page on any origin
can `fetch()` it), `X-Content-Type-Options: nosniff` and `Content-Security-Policy:
default-src 'none'; sandbox`, from the viewer-response function; the AWS managed
response-headers policy `CORS-and-SecurityHeadersPolicy` adds CORS and `nosniff` to every
response, errors included, which the function does not see (CloudFront runs
viewer-response functions only below status 400). CloudFront itself keeps a blob 24
hours, the managed cache policy's default, because the box uploads blobs without a
`Cache-Control` of their own; the Free plan allows only managed cache policies (custom
ones are Business), so a year at the edge would take uploads that carry
`max-age=31536000`.

**Every blob the boxes upload is served as `binary/octet-stream`**, because the upload
sets no content type: `aws s3 sync` in `runner/box.sh` guesses one from a file's name, a
blob's name has no extension, and S3 then stores `binary/octet-stream`. That is so for
dumps, stdout, binaries and source archives alike; only the deploy's own blobs differ
(`application/gzip` for AWS-LC's archive, `application/octet-stream` for the Fixtures).
The upload is not changed. None has a `Content-Encoding`, and the distribution does not
compress, so every client gets the stored bytes, the ones the hash names: `curl -O` saves
them as they are, and `fetch()` reads them. **A browser opened on a blob's address
therefore downloads it rather than showing it**, a text dump included; with `nosniff` it
does not sniff it into a page, nothing is rendered or run, binaries included, and should
a blob ever be rendered, the CSP sandbox lets it run nothing.

**Reading through it.** `bun scripts/derive.ts ... --blobs-url
https://<distribution>.cloudfront.net` reads blobs there instead of `--bucket`, with no
credentials (`publicBlobStore` in `scripts/lib/blobs.ts`). As with the bucket, every blob's
SHA-256 is checked before it is used or cached, which is what makes bytes from a public
address trustworthy at all. It never follows a redirect: it contacts the host it was given
and no other, and a 3xx stops the run with an error that names both addresses. 404 and S3's
403 `AccessDenied` mean no such blob; any other 403 (WAF) is a refusal and stops the run
rather than pass for a missing blob. It starts at most 4 requests a second, however many
are in flight (`--blobs-per-second N` to change that). `tests/public-blobs-derive.test.ts`
runs both Methods on the sample Runs from a directory and through a local HTTPS stand-in
and requires the same bytes. `scripts/check-runs.ts` reads a local copy (synchronously) and
the lookup tool reads Derivations, Runs and prices, not blobs: neither fetches a blob, so
neither has the option.

**The plan.** Free: $0 a month, for 1,000,000 requests and 100 GB a month. Requests WAF
blocks and blocked DDoS traffic do not count. AWS emails at 50%, 80% and 100%, and the
console shows the month's usage. Going over is never billed. AWS's words
([flat-rate-pricing-plan.html](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html),
"What happens when usage exceeds the allowance"): the allowance is "not a hard limit"; the
first spike to 3 times the allowance in a month does not affect service; sustained excess
is judged over 2 to 3 months or more; then "your traffic might be served from fewer or more
distant edge locations, or performance might be adjusted", in proportion to the excess. It
speaks of the distribution's traffic, everyone's, not of the addresses that caused it, and
gives no figure. The data grow by about 9,000 blobs a day, so one daily mirror of the new
blobs is about 270,000 requests a month, a quarter of the allowance; a full download of
the data outgrows it, and that is when to move to Pro.

**Two rate limits** (AWS WAF rate-based rules, in the web ACL the plan requires and pays
for), evaluated in this order after the two managed rule groups:

1. **Per address**: 1,500 requests in any 5 minutes, about 5 a second. A mirror fetching a
   day's new blobs at 4 a second, the pace `scripts/lib/blobs.ts` keeps, takes 37.5
   minutes at 1,200 per 5 minutes, 20% under the limit, which leaves room for WAF's
   estimate being near rather than exact. A runaway loop does tens to hundreds a second and
   passes 1,500 within a minute; WAF blocks that address until its rate, as WAF estimates
   it, falls back under. Over IPv6 one client can spread across many addresses; WAF
   counts each on its own.
2. **A limit on all requests for blobs together** (the total limit): 6,000 in any 5
   minutes, 20 a second, counted from every address as one (aggregation `CONSTANT`, "count
   all", which needs a scope-down statement: here, URI paths that start with `/blobs/`, so
   that anything else served from the distribution later is not counted). Every request the
   blob function lets through starts with `/blobs/`, so none reaches S3 uncounted; the
   malformed addresses under `/blobs/` that the function answers with 404 are counted too,
   since WAF sees a request before the function does.

   *What it is.* A rate limit that AWS enforces approximately, on the only requests that can
   reach the bucket. At its rate, all month, 6,000 × 288 × 31 = 53,568,000 requests get past
   the rule in a 31-day month (288 five-minute windows a day), about 53.6 million, which at
   $0.0004 per 1,000 GETs is $21.43 if every one of them missed CloudFront's cache: what a
   month costs at the configured steady rate. *What it is not.* A cap. AWS says rate-based
   rules are "not intended for precise request-rate limiting"
   ([rate-based rule caveats](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-caveats.html)):
   WAF estimates the rate, weighting recent requests, and limits near the limit rather than
   exactly at it; requests can come in over the limit for up to several minutes before WAF
   starts limiting them (usually under 30 seconds); and changing any of the rule's rate
   settings resets its counts, which can pause it for up to a minute. So bursts can exceed
   the figure, by much more than rounding when they are large or repeated. There is no hard
   cap on S3 request charges here. Nor is it selective: while the total is over the limit,
   every request for a blob is refused, for everyone, polite mirrors included (five of them
   at 4 a second fill it). Service resumes by itself when WAF's estimate of the rate falls
   below the limit; nothing needs to be done. The total limit also counts requests
   CloudFront serves from its cache.

Because the total limit comes last, a request a managed group or the per-address limit has
already blocked is never counted against everyone, so one runaway address is cut off by
its own rule without using up the total. Beside them, two free AWS managed rule groups,
`AWSManagedRulesAmazonIpReputationList` and `AWSManagedRulesKnownBadInputsRuleSet`: 4
rules of the Free plan's 5. `AWSManagedRulesCommonRuleSet`, the console's third default,
is left out: it guards applications that parse what they are sent, and it blocks requests
without a `User-Agent`. AWS accepted the four rules as written (`aws wafv2
check-capacity`, read-only, on 2026-11-14: 231 capacity units), which says they are valid
rules, not that the Free plan takes them ("Not verified", below).

**What it still costs.** S3 bills a GET for every request that misses CloudFront's cache,
$0.0004 per 1,000 in us-east-2 (AWS's price list of 2026-11-09), and the plan does not
cover it; transfer from S3 to CloudFront is free. On the Free allowance, if every request
missed: $0.40 a month, $1.20 in the month of a 3× spike; beyond that AWS keeps serving, at
$0.40 per further million misses: $21.43 for a month at the total limit's steady rate, and
more if bursts get past it, since nothing caps it. A blob already cached at an edge does
not miss; a 403 for a missing key may be free (S3 does not bill AccessDenied to requests
from outside the account), but count it. The plan's 5 GB of S3 storage credits offsets that
much of the bucket's storage.

**The states.** `PUBLIC_BLOBS.state`, on `production-runs`:

| State | Distribution | Bucket grant | Plan | Serves |
|-------|--------------|--------------|------|--------|
| `off` | none | none | none | nothing |
| `dark` | disabled | none | subscribed by the deploy (`plan: "code"`) or by hand (`"console"`) | nothing |
| `closed` | enabled | none | as in `dark` | 404 to every address it lets through (WAF's 403s, and CloudFront's for plain HTTP or another method, aside); no request reaches S3 |
| `on` | enabled | yes | must be ACTIVE: the deploy checks, once, as it starts | `/blobs/sha256/<hex>` |

`closed` is needed only if AWS refuses to subscribe a disabled distribution: it is
enabled so that the plan can be attached, but the blobs behaviour has the 404 function and
the bucket grants it nothing, so no blob can be read. Being enabled, it takes public
traffic, and until the plan is attached that traffic is billed at pay-as-you-go rates
(below, after the steps). `on` swaps in the real function and adds the grant, after the
same check that the plan is ACTIVE. The order is always `dark`, then `closed` only if
needed, then `on`.

**What a deploy may do from what is deployed.** Before it touches anything, a deploy to
`production-runs` reads what is deployed (`infra/runs/public-blobs-guard.ts`). Which
distribution is the stage's comes from the stage's own state: SST pulls the stage's Pulumi
state before every command and runs Pulumi against that copy, so the distribution it
records, by ID, is the one the deploy will update, and when it records none the deploy will
create one (the guard reads the copy that SST names in `PULUMI_BACKEND_URL`; SST 4.17's
`pkg/project/run.go`). Then, read-only, `aws cloudfront list-distributions` returns that
distribution beside `Enabled` and `Status`, and its comment records the state and plan
attachment the stage last deployed. The two must agree: the recorded ID listed, with the
ARN and the comment the state last saw, and no other distribution of the account carrying
the stage's comment. When the distribution exists, `aws pricing-plan-manager
list-subscriptions` says whether an ACTIVE plan covers it, by its ARN, and any scheduled
cancellation or downgrade, which the deploy prints as a warning with its date. A
transition the table refuses stops the deploy with a message saying what to deploy first;
`sst diff` and `sst refresh` only warn. When the stage's state cannot be read or the
distributions cannot be listed, nothing is allowed (the last row); when the subscriptions
cannot be listed, `on` is refused and the other columns are judged without them. Rows: what
is deployed; columns: the state deployed to, with the same plan attachment unless said.

| Deployed | `off` | `dark` | `closed` | `on`¹ | `dark`, plan changed | `closed`/`on`, plan changed |
|----------|-------|--------|----------|-------|----------------------|-----------------------------|
| nothing | yes | yes | no | no | yes | no |
| `dark`, disabled (`Deployed`) | yes | yes | yes | yes | yes | no |
| `dark`, still disabling (`InProgress`) | no | yes | yes | yes | no | no |
| `dark`, but enabled by hand | no | yes | yes | yes | no | no |
| `closed` or `on`, enabled | no | yes | yes | yes | no | no |
| `closed` or `on`, disabled by the watch or by hand | no | yes | no | no | no | no |
| cannot tell (below) | no | no | no | no | no | no |

¹ Only when an ACTIVE plan covers the distribution; otherwise no, in every row.

"Cannot tell" is any of: the stage's state cannot be read, or holds the distribution more
than once, or awaiting deletion, or with an operation on it unfinished; `aws cloudfront
list-distributions` fails, or answers something that does not add up; two distributions
carry the stage's comment; one carries it that the state does not record (made by hand,
say: a deploy would make another beside it, and that one's plan says nothing about the new
one); the recorded one is not listed (deleted outside the stage: `sst refresh` brings the
state up to date); or its comment is gone, or is not the one the state last saw (edited
outside the stage, whatever the edit). What this cannot see: a state that is itself wrong
(edited by hand, restored from an older copy, or refreshed after a change made outside the
stage, which it then takes for the stage's own); and anything that changes after the
deploy has read it. The checks are made once, as the deploy starts, so a plan cancelled, or
the distribution changed in the console, after that is not seen; in particular, `on`'s
approval holds for that moment only, and a cancellation during or after the deploy leaves
the distribution serving without a plan until the watch acts. SST's lock keeps two
commands that change the stage (`sst deploy`, `sst refresh`, `sst remove`) from running at
once. `sst diff` does not take it: a diff run while a deploy is under way can read the
state from before that deploy beside what AWS reports during it, and its checks only warn.
The watch, and changes made in the console or with the CLI, do not take the lock either.

So from an enabled distribution the only way out is `dark`; `off` and a change of
`PUBLIC_BLOBS.plan` come only after `dark` has been deployed and the distribution reports
disabled (`Enabled` false, `Status` `Deployed`). A distribution the watch disabled while the
stage says `closed` or `on` takes a `dark` deploy before anything else, because a deploy of
`on` would not enable it again (the stage still records it enabled).

**`sst remove` runs none of these checks.** SST 4.17's `sst remove` runs `pulumi destroy`,
which destroys what the stage's saved state holds without running the program
(`pkg/project/run.go`), so the table has no column for it: a removal would cancel the plan
and delete the distribution whatever the distribution is doing. What stops it is SST's
stage protection: for a stage whose app settings in `sst.config.ts` say `protect: true`,
SST refuses `sst remove` before it does anything. So public blobs are made only on a
protected stage: a deploy of `dark`, `closed` or `on` stops, before AWS is asked anything,
unless `$app.protect` is true (`off` is always allowed: it makes nothing).
`infra/runs/stages.ts` protects `production-runs`, the stage `PUBLIC_BLOBS` names, and no
other `-runs` stage; a test holds the two together. Nor does `sst dev` (or `sst deploy --dev`, which SST runs the same way, with
`$dev` true) deploy anything but `off` there: dev mode deploys each function as a stub that
works only while a local session runs, and redeploys whenever a file changes. What stage
protection does not prevent: it is a setting SST reads from `sst.config.ts` at each
command, not a lock in AWS, so `sst remove` from a checkout whose `sst.config.ts` says
otherwise, `pulumi destroy` run by hand on the state, and deleting the resources in the
console or with the AWS CLI all go ahead; and it does not stop a deploy, which deletes or
replaces what the program says (the table judges those). Pulumi's `protect` on the
distribution and the subscription, set while the distribution is enabled, is a second,
narrower lock, kept in the stage's saved state: Pulumi refuses to delete or replace either,
in a deploy or a destroy, until a `dark` deploy lifts it. It does not prevent changes made
in place, changes in the console or with the CLI, or cancelling the plan outside the stage.
A dev stage such as `smr-runs` never has any of this, so `sst remove` there removes what it
always did.

**The watch.** A Lambda in the stage, `PublicBlobsWatch` (stage output
`publicBlobs.watchFunction`), runs every 5 minutes, deploy or not
(`infra/runs/plan-watch.ts`). It is always deployed as the real function (`dev: false`; SST
4.17's functions otherwise default to live development, and `sst dev` would deploy a stub
in its place). If the distribution is enabled and no ACTIVE plan covers it, it disables it
(a listing that succeeds but leaves the plan out, should AWS ever answer so, counts as no
plan): it reads the configuration, writes it back with `Enabled` false under the ETag it
read, and when the configuration changed in between (a deploy, a person: CloudFront answers
`PreconditionFailed`), reads it again and retries, three attempts in all. If it cannot tell
whether a plan covers it (the plan API unreachable, or an answer it cannot read), it
records the time in a tag on the distribution (`ledgermath-plan-watch-unknown-since`), and
when it cannot tell and finds the tag already there, it disables it. A run that can tell
clears the tag, so the two runs are usually consecutive, but need not be if clearing failed
in between, and any value of the tag counts. If it cannot keep the tag, it disables the
distribution at once. It does nothing to a disabled distribution, and does not exist while
the state is `off`. A `closed` distribution is left alone for 60 minutes after its last
change (CloudFront's `LastModifiedTime`, by the Lambda's clock; each change to its
configuration starts them again), so that the plan can be attached, and is disabled by the
first run after that if still uncovered. If the distribution itself cannot be read, the
watch cannot tell whether it is enabled, or a `closed` one within its grace, so it takes it
to be enabled and past its grace: it still lists the plans, and disables it on the same
terms, through `GetDistributionConfig` and `UpdateDistribution`, which may answer when
`GetDistribution` did not; if CloudFront answers none of them, the run fails and the
distribution goes on as it is, serving if it was. A plan with a scheduled cancellation or
downgrade is logged as a warning with its date, and acted on once it stops being ACTIVE.
Every disable is logged as `public blobs watch: DISABLED the distribution`, with the
reason; a failure to disable fails the invocation. No alarm is raised on either.

*How long uncovered delivery lasts.* The watch polls, so it cannot guarantee that the
distribution never serves without a plan. From the moment a plan stops covering an enabled
distribution to the moment no edge serves it, the time is the wait for the watch's next run
(it is scheduled every 5 minutes), plus the run itself, plus CloudFront's propagation of
the disabled configuration, during which edges that do not have it yet keep serving with
the old one ([updating a distribution](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HowToUpdateDistribution.html));
one run more when the plans cannot be listed; 60 minutes or more for a `closed`
distribution; and no end at all while CloudFront refuses the watch's calls. What the
distribution serves in that time is billed at pay-as-you-go rates.

Its role may do exactly this (`watchPermissions`, plus the Lambda basic execution policy
SST adds for its own logs):

```
pricingplanmanager:ListSubscriptions     on "*" (Pricing Plan Manager has no resource type)
cloudfront:GetDistribution, cloudfront:GetDistributionConfig, cloudfront:UpdateDistribution,
cloudfront:ListTagsForResource, cloudfront:TagResource, cloudfront:UntagResource
                                         on this distribution's ARN only
```

**Turning it on, on `production-runs`**, with no moment when blobs are served on
pay-as-you-go pricing (`closed`, if it is needed, is billed at pay-as-you-go rates for the
404s and the inspection of what reaches it until the plan is attached). Every command uses
the stage's own profile (`tabot-production`); the deploy prints the next step each time.

1. Set `state: "dark"` in `infra/runs/public-blobs.ts`, commit, `bunx sst diff --stage
   production-runs`, then deploy that stage. It makes:
   - the web ACL `ledgermath-production-runs-public-blobs`, scope `CLOUDFRONT`, in
     us-east-1 (the provider's resources take a `region` since `@pulumi/aws` 7, so no
     second provider): default allow, the two managed groups, the per-address limit, the
     total limit;
   - the Origin Access Control `ledgermath-production-runs-public-blobs` (S3, always sign,
     SigV4);
   - the CloudFront Functions `ledgermath-production-runs-blob-request`,
     `ledgermath-production-runs-blob-response` and `ledgermath-production-runs-no-route`
     (`cloudfront-js-2.0`, published);
   - the distribution, **disabled**: it serves nothing, so it has no traffic to bill; its
     blobs behaviour has the 404 function, and the bucket policy is not touched;
   - the Free plan subscription, `AWS::PricingPlanManager::Subscription` in us-east-1,
     through Cloud Control (`aws.cloudcontrol.Resource`: the installed provider, 7.20.0,
     has no resource of its own for it). A Free plan activates at once;
   - the watch.
2. Check the plan: `aws pricing-plan-manager list-subscriptions --region us-east-1
   --profile tabot-production` lists it, tier `FREE`, status `ACTIVE`, with the
   distribution (`publicBlobs.distributionArn`) and the web ACL.
3. Only if step 1 failed because AWS refused to subscribe a disabled distribution: set
   `state: "closed"`, commit, deploy (the distribution is enabled, answering 404 to
   everything; with `plan: "code"` this deploy creates the subscription), and check the
   plan as in step 2 before the watch's 60 minutes are up.
4. Set `state: "on"`, commit, deploy. Before it changes anything the deploy checks that an
   ACTIVE plan covers the distribution, and stops if not; it checks once, so a plan
   cancelled after that is left to the watch. The distribution is enabled (or stays so),
   gets the real function, and the bucket policy gets the grant; it takes a few minutes to
   reach every edge.
5. `curl -sSI https://<distribution>.cloudfront.net/blobs/sha256/<hex>` for a blob a Run
   names: 200, and the headers above.

With `plan: "console"` the deploy makes no subscription and prints the console steps
instead, to take after step 1 (or 3): in the CloudFront console, signed in to the stage's
account, open the distribution whose description starts "LedgerMath production-runs
public blobs" (`publicBlobs.distributionId`), choose its pricing plan, pick Free, confirm
(its web ACL is already associated), and wait for it to show as active; or `aws
pricing-plan-manager create-subscription --region us-east-1 --profile tabot-production
--plan-family CloudFront --plan-tier FREE --resource-arns <publicBlobs.distributionArn>
<publicBlobs.webAclArn>`. Use it if Cloud Control cannot create the subscription.

Until the plan is attached the web ACL is billed as usual: by the hour ($5 a month and $1 a
rule), and for each request it inspects. With the distribution disabled that is cents, for
the minutes between the distribution and the subscription the same deploy makes. `closed`
is different: it enables the distribution before the plan is attached, so until then
public edge traffic is billed at pay-as-you-go rates, although no blob is served and S3 is
never reached. Every request that finds the address is inspected by the web ACL, which is
billed even when it blocks the request, and each one it lets through is a CloudFront
request, a function invocation (the 404) and the bytes of the answer. The address is not
published, so few should find it, but nothing limits them: the rate limits refuse
requests, and a refused request is still inspected. The watch disables a `closed`
distribution still uncovered once its 60 minutes are up, by its next run and with
propagation after that, if CloudFront answers it (above); there is no fixed maximum for
what that window costs.

**Not verified, because nothing has been deployed.** That the program, run by SST, sees
`PULUMI_BACKEND_URL` and the stage's state at the path the guard expects (seen with Pulumi
3.215, the version SST 4.17 runs, and a local file backend, not yet under SST; if not,
every deploy of `production-runs`, `off` included, stops with "the stage's state could not
be read", and `sst diff`, which only warns, shows it first); that Cloud Control creates the
subscription (the type is registered, `FULLY_MUTABLE`, and its list handler answers in both
accounts, read-only, on 2026-11-14); that AWS subscribes a disabled distribution (if not,
`closed`); that the Free plan takes the managed response-headers policy (AWS's feature
table allows managed ones; one report says the console refused a response-headers policy,
likely a custom one: if AWS refuses the plan over it, the subscription fails while the
distribution is still disabled; drop `responseHeadersPolicyId` in `distributionArgs`, and
the viewer-response function still gives every blob CORS and `nosniff`); that the Free plan
counts each managed rule group as one of its 5 rules, and takes a string match on the URI
path in a scope-down (regular expressions are a Business feature; a string match is not
listed as a paid one); that `cloudfront:UpdateDistribution` alone lets the watch disable a
distribution with a web ACL (the Service Authorization Reference lists no other dependency
for it); whether an ordinary update of the distribution's configuration, such as the deploy
of `on` itself, moves its subscription out of `ACTIVE` for a while (AWS documents
`SYNC_IN_PROGRESS` for changes to the subscription, not to the distribution; if an update
does it too, the watch disables a distribution it finds in that state, right after a deploy
of `on` if that is when, and it takes a `dark` deploy to recover); and the watch's own
behaviour against AWS.

**Changing or cancelling the plan: deploy `dark` first.** The deploy and the watch count a
plan only while its status is `ACTIVE`. While AWS applies a change to a subscription it
reports `SYNC_IN_PROGRESS` (AWS shows it for downgrades, scheduled cancellations and
approvals, and says it typically takes 2 to 5 minutes: [subscription
lifecycle](https://docs.aws.amazon.com/PricingPlanManager/latest/UserGuide/getting-started-pricingplanmanager-api.html)),
and the watch counts that as no plan, on purpose: it cannot tell a covered distribution
whose plan is being changed from one whose plan is going away, so it fails closed. A
distribution whose paid plan has a cancellation scheduled for the end of the month, and
covers it until then, is therefore disabled while AWS applies the cancellation. So before
changing the tier, scheduling a cancellation or downgrade, or calling one off, deploy
`dark`; make the change; wait until `list-subscriptions` shows the plan `ACTIVE` again;
then deploy `on`. Otherwise expect the watch to disable the distribution, and then only a
`dark` deploy brings it back (the deploy refuses `on` until the stage has recorded it
disabled). A deploy of `on` prints this, and the deploy and the watch repeat it beside any
scheduled change they see.

**Moving to Pro** ($15 a month, prorated, still flat: 10 million requests and 50 TB a
month, access logs, 10 behaviours, 25 WAF rules, custom WAF responses): with the
distribution `dark` (above), in the console, or `aws pricing-plan-manager
update-subscription --region us-east-1 --profile tabot-production --arn <publicBlobs.plan>
--if-match <eTag from get-subscription> --plan-tier PRO`; then, once the plan is `ACTIVE`,
deploy `on`. Leave `subscriptionState` in `infra/runs/public-blobs.ts` as it is:
CloudFormation's subscription refuses to change a tier itself, and a deploy touches the
subscription only when its desired state changes, so the upgrade stays. (Whether it would
accept a desired tier equal to the one AWS already has is not verified.) The deploy and
the watch accept any ACTIVE tier. With Pro, consider raising the total limit with the
allowance.

**A custom domain** is one line in `PUBLIC_BLOBS`, `domain: { name, certificateArn }` with
an ACM certificate in us-east-1, then a DNS record to the distribution. With it the TLS
policy is `TLSv1.2_2025`; on the `*.cloudfront.net` name CloudFront sets TLSv1 itself, and
no policy can be chosen.

**Turning it off.** Deploy `dark`: the distribution is disabled, the grant removed, the
plan kept, and Pulumi's protection lifted. The grant and the distribution are changed
independently, and edges keep serving with the old configuration, cached blobs included,
until the disabled one reaches them. Once `aws cloudfront list-distributions` shows
it `Enabled` false and `Status` `Deployed`, `off` deletes everything, the subscription
first (a Free plan is cancelled at once; AWS refuses to delete a distribution that is on a
plan). While on a plan the web ACL cannot be replaced, so do not rename it.

**The Free plan's limits, here and later.** Three Free plans per account: one is used
here, in the production account. 5 cache behaviours (2 used), 5 WAF rules (4 used), no
access logs, so no record of who downloaded what beyond the console's usage figures and
the WAF metrics. Only managed cache and response-headers policies; CloudFront Functions
are in. Nothing here uses a feature a plan refuses (no Origin Access Identity, legacy
`ForwardedValues`, real-time logs, Lambda@Edge, continuous deployment, customer rule
groups). A static site served later from the same distribution would take the default
behaviour (in place of the 404 function, with a second origin or an origin path) and fits
in the 5 behaviours, but would share the allowance and the per-address limit with the
blobs (not the total limit, which counts only `/blobs/`), could set its own headers only
through a function, and would have no logs below Pro. A second distribution, on a second
Free plan, would keep them apart.

## The Runs repository, the Method and the page

Step 3 (#39). The Run files and boot summaries are copied, byte for byte and under the
same paths, into the private repository `smrdotgg/ledgermath-runs`; blobs stay in the
bucket and are fetched by hash when needed. Method series v1 (`methods/README.md`) turns
the Runs into a file of Derivations, one per Series, and Method requests v1 another, one
per Series whose samples are requests (`http_get`'s): each phase of a request (name
lookup, connect, TLS, send, first byte, headers, body, the whole request) across the
requests, within each Run and pooled, with 99th and 99.9th percentiles where the requests
support them, a histogram of each phase, the breakdown by the server's address block and
the cipher, and failed requests counted. The page is one static HTML file built from both:
one chart per Series, every point a link to its Run file in the Runs repository,
percentiles with the number of Runs behind them, groups by colour and shape, failed Runs as
crosses, and what differed between consecutive Runs; then, for each Series of requests,
each Run's median, 95th and 99th percentile of the whole request and of the first byte over
time, and every phase's distribution. It opens from disk with no network. Until step 7 it
is a build artifact, not hosted.

### Locally

```bash
STAGE=production-runs                                      # the scheduled stage; smr-runs before the move
PROFILE=tabot-production                                   # smr-runs: tabot-dev
BUCKET=$(jq -r .bucket ".sst/outputs.$STAGE.json")        # or: aws s3 ls --profile "$PROFILE" | grep "ledgermath-$STAGE"
# Bun's S3 client reads keys from the environment. Each command that reads the bucket gets
# them in a subshell of its own, so this shell holds none (keys left in it would reach a deploy).
with_keys() { (eval "$(aws configure export-credentials --profile "$PROFILE" --format env)" && "$@"); }

git clone git@github.com:smrdotgg/ledgermath-runs.git /tmp/ledgermath-runs
git -C /tmp/ledgermath-runs remote set-url --push origin no-push   # a scratch clone pushes nowhere

# The copy job: adds what the bucket has and the clone does not; a second run adds nothing.
# It stops, writing nothing, if a file already in the clone differs from the bucket's (an
# ETag that is not the file's MD5 is settled by downloading and comparing the bytes), if a
# key is not shaped like a Run file or boot summary, or if any path passes through a
# symbolic link. Each file is created exclusively, so one that appears meanwhile stops it
# rather than being overwritten, and gets its name only once it is written whole and read
# back the same; a write that comes up short stops the job and adds no part of the file.
with_keys bun scripts/copy-runs.ts --bucket "$BUCKET" /tmp/ledgermath-runs

# The Methods, with dump blobs fetched by hash and kept in a cache, and each stream reduced
# once to a record per Method and kept: a stream is fetched again only for a Run without one.
with_keys bun scripts/derive.ts --runs /tmp/ledgermath-runs --bucket "$BUCKET" --cache /tmp/blob-cache \
  --records /tmp/records --out /tmp/page/derivations.json --requests-out /tmp/page/requests-derivations.json

# The page.
bun scripts/build-page.ts /tmp/page/derivations.json /tmp/page/index.html --requests /tmp/page/requests-derivations.json

# The alarm, posting nothing; --now sets the clock, --copy says whether the copy job worked,
# --schedule-changed-at says when main last changed schedule.json, --prices-since when the
# prices workflow first existed on main.
bun scripts/alarm.ts --runs /tmp/ledgermath-runs --copy succeeded --dry-run --now 2026-11-13T00:00:00Z \
  --schedule-changed-at "$(git log -1 --first-parent --format=%cI origin/main -- schedule.json)" \
  --prices-since "$(git log --first-parent --reverse --format=%cI origin/main -- .github/workflows/prices.yml | sed -n 1p)"
```

Without AWS, the samples are a directory of Runs with their blobs:

```bash
bun scripts/derive.ts --runs tests/samples/scheduled --blobs tests/samples/scheduled/blobs --out /tmp/samples.json
bun scripts/build-page.ts /tmp/samples.json /tmp/samples.html
```

The same Runs and blobs give the same Derivations, byte for byte, whatever the blobs come
from and whether the records were kept or not, so a Derivation is checked by computing it
again and comparing with `cmp`.

### The workflow

`.github/workflows/runs.yml` runs at 22:40 UTC (half an hour after the 22:10 boot), every
six hours, and by hand (`workflow_dispatch`), one run at a time. It checks out this
repository with its whole history (for the alarm's `--schedule-changed-at`), takes AWS
credentials through OIDC, checks out `smrdotgg/ledgermath-runs` with the deploy key,
runs the copy job, commits and pushes what it added, runs both Methods, builds the page,
uploads the page and both files of Derivations as the artifact `page`, and runs the alarm
with the workflow's own token. Each Method runs on its own: when one fails, `derive.ts`
still writes the other's Derivations and, in place of the failed one's, a note saying why
(`page/<name>.failed.json`); the page is built from what there is and says which part is
missing and why, the artifact is kept, and the run still ends as failed. Between runs it keeps, in GitHub's cache, the dump blobs it
fetched and each stream's reduced record per Method (`.cache/records`), never the stdout
blobs: a stream is fetched only for a Run no Method has a record of yet, about 2 MB of
records a day where the stdout blobs were about 44 MB. The alarm runs even when an earlier
step failed, as long as the Runs repository was checked out, and is told whether the copy
and its push succeeded on this pass.

It needs:

| Where | Name | What it holds |
|-------|------|---------------|
| Variable | `RUNS_AWS_ROLE_ARN` | The scheduled stage's output `runsReaderRole` (`jq -r .runsReaderRole .sst/outputs.<stage>.json` after a deploy) |
| Variable | `RUNS_BUCKET` | The scheduled stage's output `bucket`, the bucket's name |
| Secret | `RUNS_REPO_DEPLOY_KEY` | The private half of an SSH key whose public half is a deploy key of `smrdotgg/ledgermath-runs` **with write access** (it pushes) |

For the key: `ssh-keygen -t ed25519 -N '' -C ledgermath-runs-copy -f runs-deploy-key`,
add `runs-deploy-key.pub` under the Runs repository's Settings → Deploy keys with
"Allow write access", put the contents of `runs-deploy-key` in the secret, and delete
both files. The alarm needs nothing more: the workflow asks for `issues: write`.

The role comes with the stage. A deploy of a `-runs` stage creates GitHub's OIDC provider
for `token.actions.githubusercontent.com` in its account (audience `sts.amazonaws.com`; an
account holds one per URL, so only one `-runs` stage per account can create it:
`production-runs` in the production account, `smr-runs` in the development account) and
the role `RunsReaderRole`, which only workflows of `smrdotgg/ledgermath` on
`refs/heads/main` can assume and which may list the bucket and read `runs/*`, `boots/*` and
`blobs/*`, nothing else (`infra/runs/github-role.ts`). A workflow started from another
branch cannot assume it. Both variables name the scheduled stage's; the other stage's role
stays, unused.

### The alarm

A watched Series is one `schedule.json` runs (benchmark, params, build) on one of its
targets (instance type and zone), the same targets the stack launches: every entry on
every target, except that an entry with `instance_types` is watched only on those. A
one-off launch on another instance type is not watched; a Series taken out of the
schedule is not watched any more. When the newest Run of any watched Series started more
than 48 hours ago, the alarm opens one issue listing them all, or comments on the alarm
issue already open (found by a marker in its body; no label). Any Run counts, failed or
not.

A watched Series that has never had a Run is listed only once `schedule.json` has been
unchanged for more than 48 hours, so a Series is not reported the moment it is added.
The workflow fetches the whole history and passes the alarm
`--schedule-changed-at "$(git log -1 --first-parent --format=%cI -- schedule.json)"`: the
commit time of the last commit on main's first-parent line that changed the file, which
for a merge commit is the merge, not the branch commit it brought in. A fast-forward
merge keeps the branch commit's time, which may be earlier than main got it.

It writes only when something changed since its last post: the set of stale Series, or
whether the copy job is failing. Each post ends with that state in a hidden marker, which
the next pass compares with; otherwise it stays silent. When the copy or its push failed on
a pass, the Runs repository may be behind the bucket, and anything it writes says so at
the top, before the list. When every watched Series has a Run again it says so once on the
open issue, so a later incident is not mistaken for the old one. Closing the issue lets
the next incident open a new one.

The same issue says when the newest price file in the Runs repository (below, "Prices")
was fetched more than 48 hours ago, by its `fetched_at`. With no price file at all, it
says nothing until the prices workflow has existed for more than 48 hours, the same idea
as for a Series that has never had a Run: the workflow passes
`--prices-since "$(git log --first-parent --reverse --format=%cI -- .github/workflows/prices.yml | sed -n 1p)"`,
the commit time of the first commit on main's first-parent line that touched the
workflow, the merge that brought it. Without `--prices-since`, or with it empty, no price
file is not reported. Whether the price files are stale is part of the state each post
carries, so it too is written only when it changes; when they are fresh again while
Series are still stale, the next post says so.

## Moving the schedule to the production account

GitHub issue #57. The boxes that boot on the schedule, the bucket their Runs and blobs go
to, and what the workflow reads move from the development account to the production
account, in the same Region and zone, from the same image, with the same instance types and
schedule. The development account keeps the dev machine, `smr-runs` for boxes by hand, and
`smr-runs`'s bucket as it is: it holds the Runs of the first days, and nothing is deleted.

### Why no Series starts a new group

A Series is its benchmark, params, build, instance type and zone ID, and Method series v1
splits it on the binary, the runner manifest, `samples`, the image and the dump sections
`cpuid`, `lscpu`, `sys_cpu`, `kernel`, `process` and `packages` (`methods/v1/facts.ts`).
None of them reads the account:

- The zone ID `use2-az3` is `us-east-2c` in both accounts, and the pinned image
  `ami-03499a87bbb39a09a` (Amazon's, public) is visible from the production account in
  us-east-2 (both checked, read-only, on 2026-11-14). The instance types, `schedule.json`,
  `runner/` and the benchmarks do not change, as long as `production-runs` is deployed from
  a commit whose `runner/`, `benchmarks/` and `schedule.json` are those `smr-runs` runs;
  another commit there would start new groups by itself, for the commit and not the move.
- What a box records differently in the other account: the account ID in `provider` (the
  instance identity document), in `ec2_instance` and in `ec2_route_tables`; the IDs of the
  VPC, subnet, route table, internet gateway, security group and instance profile in
  `ec2_instance`, `ec2_route_tables` and `ec2_vpc_endpoints` (whose command lines name
  them); the stage in the box's `Name` tag (`ec2_instance`); and an `http_get` Run's Service
  inputs, which name the stage's own fixtures bucket. Version 1 splits on none of these
  sections, and `service` is neither in the Series nor split on.
- `network`, which version 1 does not split on either, stays the same: both default VPCs
  are 172.31.0.0/16 with DNS support and host names on and the DHCP options
  `us-east-2.compute.internal` and `AmazonProvidedDNS`; both default subnets in `use2-az3`
  are 172.31.32.0/20, map a public address at launch and have no route table of their own;
  both main route tables send 0.0.0.0/0 to an internet gateway; neither VPC has an
  endpoint; neither account encrypts EBS volumes by default. So the routes, the resolver
  (172.31.0.2) and the MTU a box records are the same.

`tests/account-move.test.ts` derives two boots made as the two accounts' boxes would make
them: one Series, one group, in both Methods. On the page, "what differed" between the last
Run before the move and the first after it lists those sections, as not split on, and
Method requests v1 lists both fixtures endpoints among what an `http_get` Series' Runs
record. Not caused by the move, and handled as before: a type that AWS places on more than
one processor (an `m5.large` can be a Skylake or a Cascade Lake) can still split on the
processor in either account.

### Copying the data

`scripts/copy-bucket.ts copy` copies every object under `blobs/`, `runs/`, `boots/` and
`logs/` from one bucket to another, reading with one profile's keys and writing with
another's (`aws configure export-credentials --profile`, which no variable in the environment
overrides; held in memory and never printed or written). It works either way: the
development bucket into the production bucket for the move, and the production bucket into
the development bucket to go back (step 14). It only ever adds:

- Everything at both ends is listed first, and every object the destination holds under a
  key the source also lists is read there and compared before anything is written: a blob's
  bytes there must hash to its key, the SHA-256 of the source's bytes (the source's copy of
  a blob already there is not read; `verify` reads both); any other object's bytes must
  equal the source's. A difference stops it, and nothing is written. That, exactly, is what
  its report calls "already at the destination, read there and the same". An object only
  the destination holds (going into production, those of the box of step 3 below, for one)
  is not read by `copy` at all; `verify` with `--check-dir` reads those under `blobs/`,
  `runs/` and `boots/`, hashes each blob to its key and gives them to `check-runs.ts`. A
  log only the destination holds is read by neither.
- Each object to copy is looked at in the source (its size and ETag must still be the
  listed ones), read whole and checked: a blob's bytes must hash to its key; any other
  object's must have the MD5 its ETag gives, and when they do not, it is read a second time
  and the two reads must agree. (An ETag is the MD5 of the bytes only for an object written
  in one part with SSE-S3 or no encryption, which the copy cannot tell from the ETag; the
  development bucket's default encryption is SSE-S3.)
- It is written in one PUT with `If-None-Match: *` and the source's exact `Content-Type`,
  signed with its bytes' SHA-256 (`scripts/lib/s3-create.ts`): S3 writes it only if the key
  does not exist, so no object is ever replaced, whoever else writes to the bucket and
  whenever, and refuses bytes other than those hashed. When S3 answers that the key exists
  (412) or is being written (409), the object there is read and compared with the bytes read
  from the source: the same counts as already there; other bytes stop the copy, naming the
  key. A written object is then looked at: its size and type must be what was sent, and its
  bytes too (by its ETag when that is their MD5, else read back).
- Any problem stops it. The report counts as copied every object whose PUT S3 acknowledged,
  whatever was found after; names every key a PUT went for without an answer that says
  whether S3 wrote it (none came, or a 5xx) and that nothing settled after (a PUT S3
  acknowledged, or the object there read and compared; a later refusal, a 403 say, settles
  nothing, as the earlier PUT may have written it), which a second run settles; and says
  "wrote nothing" only when no PUT was sent. Run again, it carries on, and a second complete
  run copies nothing.

Blobs are copied first, then Run files, boot summaries and logs, so the destination never
holds a Run whose blobs it lacks. At most 16 objects are in flight (`--concurrency`) and
256 MiB of their bytes counted as held (`--memory-mib`), an object twice when a second copy
of it may be read to compare with; one object counted at more (AWS-LC's archive, 155 MB,
counted at 310 MB) is held alone. That is a count of the objects' bytes, not of the
process's memory. `--dry-run` lists, compares and counts, writing nothing.

A key with a `.` or `..` segment (`logs/a/../b.log`) is listed but cannot be requested by
its name, because a request's URL resolves the segment away: one stops `copy` before
anything is written, and is a problem for `verify`. On 2026-11-14 no key of the development
bucket had one. Every other key is copied as it is.

Only `Content-Type` is carried: no object of a `-runs` bucket has other metadata (`box.sh`
sets none, and `aws s3 cp` and the deploy set only the type). The source is versioned and
the copy reads the current version of each key; on 2026-11-14 no key of the development
bucket had more than one version, and its one delete marker is on a `source/` archive a
deploy replaced, outside what is copied (every source archive a Run names is a blob too).

`scripts/copy-bucket.ts verify` reads both buckets and writes neither: every source object
under those prefixes must be at the destination with the same bytes (both read and compared,
and every blob's bytes hashed to its key), every Run file and boot summary of a checkout of
the Runs repository must be at the destination with the same bytes, and
`scripts/check-runs.ts` must pass on the destination's `blobs/`, `runs/` and `boots/`.
`--runs-repository` must be a checkout: a path without `runs/` and `boots/` directories is
refused before anything is read. The destination's objects are written into `--check-dir`,
which must be new or empty, with room for the bucket (about 650 MB): it refuses a directory
that holds anything, so every verification needs one of its own (`/tmp/prod-check-1`, then
`/tmp/prod-check-2`, ...; remove one once its verification has passed). `verify` is the
check of the copy, byte for byte at both ends; `copy` alone does not read the source's copy
of a blob the destination already holds, nor any object the destination holds and the
source does not.

Every Run is kept as it was recorded, whether it validates or not, and the copy carries it
byte for byte: when the source holds a Run that `check-runs.ts` fails on, it fails on the
destination's copy too, however faithful the copy. So `verify` takes `--source-check-dir`,
a second directory, new or empty, apart from `--check-dir` and with room for the source
bucket: the source's `blobs/`, `runs/` and `boots/` are written there as they are compared,
and when `check-runs.ts` fails on the destination's and the copy has no other problem, it is
run on the source's too. The verification then passes when every file it fails on at the
destination, it also fails on in the source's objects: it lists those files and ends "the
copy checks out; N files do not validate, at the destination as in the source". A file it
fails on at the destination alone is a problem, and when anything else is wrong the two are
not compared at all. (A Run file that does not validate against the schema is listed by the
Methods as unreadable, in no Series.) `--no-check-runs` is no way round: it leaves out
`check-runs.ts`, and with it every object only the destination holds, and reports the
verification as incomplete. Every verification below names both directories.

```bash
DEV_BUCKET=$(jq -r .bucket .sst/outputs.smr-runs.json)
PROD_BUCKET=$(jq -r .bucket .sst/outputs.production-runs.json)
FROM=(--from-bucket "$DEV_BUCKET" --from-profile tabot-dev --to-bucket "$PROD_BUCKET" --to-profile tabot-production)

bun scripts/copy-bucket.ts copy "${FROM[@]}" --dry-run
bun scripts/copy-bucket.ts copy "${FROM[@]}"

git clone git@github.com:smrdotgg/ledgermath-runs.git /tmp/ledgermath-runs-verify   # once; later, git -C ... pull
bun scripts/copy-bucket.ts verify "${FROM[@]}" --runs-repository /tmp/ledgermath-runs-verify \
  --check-dir /tmp/prod-check-1 --source-check-dir /tmp/dev-source-1
```

How long: on 2026-11-14 the development bucket held 33,366 objects under those prefixes
(627 MB: 30,852 blobs, 2,373 Run files, 66 boot summaries, 75 logs), growing by about
10,600 objects and 130 MB a day. From the dev machine, listing both ends took 11 s, and
reading every object twice and hashing every blob, as `verify` does, took 144 s. The copy
reads every object the destination holds that the source also lists, a blob at the
destination only and anything else at both ends (for a copy after the first, about the
whole bucket, and, blobs being most of its bytes, about half of what `verify` reads), and
makes four requests per object it writes (a HEAD and a GET at the source, the PUT and a
HEAD at the destination, and a GET more when an ETag is not the bytes' MD5). So expect 5 to
15 minutes for the first copy, and a few minutes for one that adds a day's objects; `verify`
takes a few minutes more for `check-runs.ts`.

### The cutover

Rounds start at 04:10, 10:10, 16:10 and 22:10 UTC, with a box at :10, :20, :30, :40 and :50.
A scheduled launch is refused more than ten minutes after its time, and the reaper ends a box
at most 55 minutes after it started, so the last box of a round (`i4i.2xlarge`, launched at
:50 or up to ten minutes later) has ended by HH+1:55 at the latest. The `runs` workflow runs
at 00:00, 06:00, 12:00, 18:00 and 22:40. The cutover itself (steps 6 to 12) happens in one
gap between rounds: after the 06:00 workflow run has finished, so that the Runs repository
holds the 04:10 round, and before the 10:10 slot. No slot fires in it, so a deploy made in it
can neither lose a round nor start one twice, as long as each has finished by its time in
the table below. The gaps from 12:00 to 16:10 and from 18:00 to 22:10 serve as well, with
every time six or twelve hours later.

Before, on any day:

1. **The quota.** `bun scripts/check-targets.ts --stage production-runs` must say
   "everything matches": the production account's quota is 64 vCPUs. Changes nothing.
2. **Deploy `production-runs`**, while it is not the scheduled stage, from main ("Deploy",
   with `STAGE=production-runs` and the profile `tabot-production`), at any time.
   Changes, in the production account only: SST's bootstrap and the stage's resources
   ("Deploy" lists them), with no launch schedule. Check: every target in its outputs has
   `schedules: []`, and
   `aws scheduler list-schedules --profile tabot-production --region us-east-2 --query 'Schedules[].[Name,State]' --output text`
   shows its reaper's schedule and nothing else.
3. **One box by hand there**, an `m5.large`, a target that fits the quota even before it is
   raised. First the two buckets' names and a clone of the Runs repository, which this step
   and every verification below read:

   ```bash
   DEV_BUCKET=$(jq -r .bucket .sst/outputs.smr-runs.json)
   PROD_BUCKET=$(jq -r .bucket .sst/outputs.production-runs.json)
   git clone git@github.com:smrdotgg/ledgermath-runs.git /tmp/ledgermath-runs-verify
   git -C /tmp/ledgermath-runs-verify remote set-url --push origin no-push   # it is only read
   ```

   Then the launch, as "Trigger a boot by hand" makes it, with production's launch function
   and an `m5.large`:

   ```bash
   FN=$(jq -r .launchFunction .sst/outputs.production-runs.json)
   aws lambda invoke --profile tabot-production --region us-east-2 --function-name "$FN" \
     --cli-binary-format raw-in-base64-out --payload '{"instanceType": "m5.large"}' /tmp/launch.json \
     && cat /tmp/launch.json
   aws s3 ls "s3://$PROD_BUCKET/logs/" --recursive --profile tabot-production --region us-east-2
   ```

   When its log is in the bucket (about 15 minutes; the last command lists it), check what it
   left:

   ```bash
   aws s3 sync "s3://$PROD_BUCKET" /tmp/prod-bucket --exclude 'source/*' --exclude 'logs/*' \
     --profile tabot-production --region us-east-2
   bun scripts/check-runs.ts /tmp/prod-bucket
   # The same runner, image and zone ID as the newest m5.large Runs of the development account,
   # in a clone of the Runs repository (as in "Copying the data"):
   jq -r '[.provider.instance_type, .provider.image_id, .provider.availability_zone_id, .runner] | @tsv' /tmp/prod-bucket/runs/*/*/*/*.json | sort | uniq -c
   jq -r 'select(.provider.instance_type == "m5.large") | [.started_at, .provider.image_id, .provider.availability_zone_id, .runner] | @tsv' \
     /tmp/ledgermath-runs-verify/runs/*/*/*/*.json | sort | tail -3
   ```

   Changes: one instance in the production account for at most 55 minutes, and its Runs,
   blobs, boot summary and log in the production bucket. They are real Runs of an
   `m5.large` and are published with the rest once the workflow reads that bucket.
4. **Copy the data** (`copy --dry-run`, then `copy`, as in "Copying the data"), while the
   development account goes on with its rounds. Changes: adds objects to the production
   bucket. The deploy has already put AWS-LC's archive and the Fixture blobs there, under the
   same keys and bytes as the development bucket's; they are read and found the same. What
   the box of step 3 left there, which the development bucket does not hold, the copy does
   not read; step 5 does.
5. **Verify** (as in "Copying the data", with `--check-dir /tmp/prod-check-1
   --source-check-dir /tmp/dev-source-1`). Changes nothing.

The cutover, in one gap (here, 06:30 to 10:10). Each deploy has a time by which it must have
succeeded, so that there is time left to go back; going back must be over before the first
slot:

| By | Must have succeeded | If it has not |
|----|---------------------|---------------|
| 09:00 | Step 9: `production-runs` deployed, with its schedules | Go back (below) |
| 09:30 | Step 10: `smr-runs` deployed, without them | Go back |
| 10:00 | Going back, when it was needed | Both stages are scheduled for the 10:10 round (below) |

6. **The last development round is complete**: `aws ec2 describe-instances --profile tabot-dev --region us-east-2 --filters Name=tag:ledgermath-stage,Values=smr-runs Name=instance-state-name,Values=pending,running`
   lists nothing, and `aws s3 ls "s3://$DEV_BUCKET/boots/<yyyy>/<mm>/<dd>/" --profile tabot-dev`
   holds that round's five boot summaries. Changes nothing.
7. **Copy again and verify again**: `git -C /tmp/ledgermath-runs-verify pull` (the 06:00 run
   has added the round), `copy`, and `verify` with directories of its own, `--check-dir
   /tmp/prod-check-2 --source-check-dir /tmp/dev-source-2` (it refuses `/tmp/prod-check-1`
   and `/tmp/dev-source-1`, which hold the first verification's objects; remove those first
   if the disk is short). The copy adds what the development
   bucket gained since step 4. From here until step 10 the development bucket gains nothing
   more, because its next slot is 10:10. Changes: adds objects to the production bucket. If
   either fails, stop here: nothing else has changed.
8. **Make `production-runs` the scheduled stage**: first note main as it is, `git fetch
   origin && BEFORE=$(git rev-parse origin/main)`; it schedules `smr-runs`, and going back
   deploys from it. Then `SCHEDULED_STAGE = "production-runs"` in `infra/runs/stages.ts`,
   and the one line of `tests/runs-stages.test.ts` that pins it; `bun test`; a pull request,
   merged to main; pull main. Changes: the repository.
9. **Deploy `production-runs`** from main, **succeeded by 09:00**. Changes, in the production
   account: the five launch schedules (each with its role) and the launch function's list of
   targets. Nothing fires before 10:10. Check: the command of step 11, with
   `--profile tabot-production`, lists the five `ledgermath-production-runs-BoxLaunch…`
   schedules and its reaper's. A deploy that fails partway can leave some of the five
   schedules made and others not, and the list of targets changed or not; run it again, and
   it carries on from what is there. Until step 10, development keeps its schedules and
   every round.
10. **Deploy `smr-runs`** from main, **succeeded by 09:30**. Changes, in the development
    account: its five launch schedules and their roles are deleted, and its launch
    function's list of targets becomes `none (this stage is not the scheduled stage)`, so
    even a schedule that survived would launch nothing. A deploy that fails partway can
    leave some schedules deleted and others not, and the list of targets as it was; run it
    again.

    Production first: between the two deploys both stages are scheduled, never neither; in
    the other order, a slot that fired between them would launch no box at all. No slot
    fires between them as long as both have succeeded by their times.

**Going back**, over by 10:00, when step 9 or 10 has not succeeded by its time: deploy both
stages from `BEFORE` ("Deploy", in a checkout of it, `git checkout --detach "$BEFORE"`, and
`git checkout main` after). `smr-runs` first, so that any of its schedules a partial step 10
deleted is back before production loses its own (when step 10 was never started, `smr-runs`
is as it was and needs no deploy); then `production-runs`, which loses whatever schedules
step 9 made and gets an empty list of targets again. Then step 11's command gives the other
answer: development lists its five launch schedules, its reaper's and July's reaper's;
production its reaper's alone. Revert step 8's commit on main (a pull request), and try
again another day. The workflow still reads the development bucket, as step 12 had not come,
and nothing else needs undoing: the production bucket keeps what the copy and the box of
step 3 put there, and the next try's copy finds it there and the same.

**If both stages are still scheduled at 10:10** (a deploy did not succeed in time, and
going back was not over): at each slot whose target has a launch schedule in both accounts,
two boxes start, one in each account, from separate quotas and with separate client tokens,
and each writes its Runs to its own stage's bucket. Nothing removes either set. Every Run is
recorded truthfully and kept, so these are two real sets of Runs of the same targets, made
by two boxes minutes apart, not damaged data. A reader of a Series sees, at that slot, two
Runs minutes apart where there is usually one; both count in the Series' percentiles and
counts, and they fall in one group unless a fact Method series v1 splits on differs between
the two boxes, as it can between any two boxes of a type (an `m5.large` can come on another
processor). Both sets are published: the development bucket's by the workflow while it reads
that bucket, the production bucket's once it reads that one. So when the cutover goes on
after such a round, copy and verify again (step 7) once the round's development boxes have
ended (step 6's check), before step 12; when it goes back, production's Runs of that round
wait in its bucket for the next try, as the box of step 3's do. Finish going back, or the
cutover, before the 16:10 round, so that it happens to one round only.

11. **Check the schedules.**
    `aws scheduler list-schedules --profile tabot-dev --region us-east-2 --query "Schedules[?State=='ENABLED'].Name" --output text`
    lists only `ledgermath-smr-runs-BoxReaperSchedule-…` and July's
    `ledgermath-smr-ReapStaleSchedule-…` (July's `DailyLaunch` is disabled): the
    development account has no enabled launch schedule. The same with
    `--profile tabot-production` lists the five `ledgermath-production-runs-BoxLaunch…`
    schedules and its reaper's. Changes nothing.
12. **Point the workflow at the production bucket**:

    ```bash
    gh variable set RUNS_BUCKET --repo smrdotgg/ledgermath --body "$(jq -r .bucket .sst/outputs.production-runs.json)"
    gh variable set RUNS_AWS_ROLE_ARN --repo smrdotgg/ledgermath --body "$(jq -r .runsReaderRole .sst/outputs.production-runs.json)"
    gh workflow run runs.yml --repo smrdotgg/ledgermath
    ```

    Changes: the two repository variables in GitHub. The run by hand shows the workflow
    assuming the production account's role through that account's OIDC provider; it adds
    to the Runs repository the files of the box of step 3, the only Run files and boot
    summary the repository lacks, and derives as before. Its cache holds dump blobs by hash
    and each stream's reduced record by the stdout blob's hash and the reducing code;
    nothing in it names a bucket, and the production bucket holds the same blobs under the
    same keys, verified byte for byte, so the cache is right as it is and need not be
    cleared.

After the cutover:

13. **The first production round**, 10:10 to 10:50. While it runs:
    `aws ec2 describe-instances --profile tabot-production --region us-east-2 --filters Name=tag:ledgermath-stage,Values=production-runs`
    shows the boxes, the launch function's log (`/aws/lambda/<launchFunction>`) has five
    launches and no refusal, and the development account starts no box. The round's last
    box has ended by 11:55 at the latest; check that it has, rather than wait for a time:
    the same command with `Name=instance-state-name,Values=pending,running` added lists
    nothing, `aws s3 ls "s3://$PROD_BUCKET/boots/<yyyy>/<mm>/<dd>/" --profile tabot-production`
    holds the round's five boot summaries, and `check-runs.ts` on a sync of the bucket
    passes. The first workflow run after that (normally the 12:00 one) copies, pushes and
    derives them; then, with its `page` artifact
    (`gh run download <run> --repo smrdotgg/ledgermath -n page -D /tmp/page`), this prints
    every Series whose group changed at the move, and should print nothing:

    ```bash
    CUT=2026-11-DDT10:00:00Z   # the day of the cutover, before the first production round
    jq -r --arg cut "$CUT" '.derivations[] | . as $d
      | ($d.points | map({key: .run, value: .started_at}) | from_entries) as $at
      | $d.differed[] | select($at[.from] < $cut and $at[.to] >= $cut and (.facts | length) > 0)
      | "\($d.series.id) \($d.series.benchmark) \($d.series.instance_type) \($d.series.params | tojson): \(.facts | join(", "))"' \
      /tmp/page/derivations.json
    ```

    Changes nothing.
14. **Going back, if the production round fails** (no boxes, too few, Runs that do not
    check out): in the next gap, after the 12:00 workflow run, with the times of steps 9
    and 10 six hours later (the first deploy succeeded by 15:00, the second by 15:30, going
    back over by 16:00). The production bucket now holds Runs and blobs the development
    bucket lacks, those of the box of step 3 and of every production round, and some are
    already in the Runs repository; they are copied back before the workflow reads the
    development bucket again.

    1. Note main as it is, `git fetch origin && AFTER=$(git rev-parse origin/main)`: it
       schedules `production-runs`. Revert step 8's commit (a pull request, merged), and
       pull main.
    2. Deploy `smr-runs`, then `production-runs`, from main: now the development stage gains
       its schedules first, for the reason step 10 gives. Check with step 11's command,
       whose answers are now the other way round. If a deploy has not succeeded by its
       time, put both back as they were, from `AFTER`, `production-runs` first and then
       `smr-runs`, by 16:00: the 16:10 round then runs in production, and going back is tried
       again in the next gap. If both are still scheduled at 16:10, see above.
    3. Once production has no box left (step 13's command, with `pending,running`, lists
       nothing; with its schedules gone, no more start), copy what only the production
       bucket holds into the development bucket, with the same add-only copy, and verify:

       ```bash
       BACK=(--from-bucket "$PROD_BUCKET" --from-profile tabot-production --to-bucket "$DEV_BUCKET" --to-profile tabot-dev)
       bun scripts/copy-bucket.ts copy "${BACK[@]}" --dry-run
       bun scripts/copy-bucket.ts copy "${BACK[@]}"
       git -C /tmp/ledgermath-runs-verify pull
       bun scripts/copy-bucket.ts verify "${BACK[@]}" --runs-repository /tmp/ledgermath-runs-verify \
         --check-dir /tmp/dev-check-1 --source-check-dir /tmp/prod-source-1
       ```

       The copy writes nothing the development bucket holds, and adds the Run files, boot
       summaries, logs and blobs only the production bucket holds, each byte for byte, a Run
       that does not validate like any other. The verification passes only when every
       object of the production bucket, and every Run file and boot summary of the Runs
       repository, is in the development bucket with the same bytes, and `check-runs.ts`
       either passes on the development bucket's objects or fails only on files it also
       fails on in the production bucket's (`--source-check-dir`, as in "Copying the data").
       So when the round failed with Runs that do not validate, this step still completes:
       those Runs are kept as they were recorded, in both buckets and in the Runs
       repository, never repaired or removed, and `verify` lists them and ends "the copy
       checks out; N files do not validate, at the destination as in the source". A file
       that fails in the development bucket alone is a problem, and the step is not done.
       Both directories need room for the bucket. Without this step, a Run already
       published could name blobs that only the production bucket holds: the workflow,
       reading the development bucket, might still find what it needs in its cache, and
       would fail once the cache is lost or evicted, or when a new reducing code reads a
       stream again.
    4. Then, and not before, point the workflow back at the development bucket:

       ```bash
       gh variable set RUNS_BUCKET --repo smrdotgg/ledgermath --body "$(jq -r .bucket .sst/outputs.smr-runs.json)"
       gh variable set RUNS_AWS_ROLE_ARN --repo smrdotgg/ledgermath --body "$(jq -r .runsReaderRole .sst/outputs.smr-runs.json)"
       gh workflow run runs.yml --repo smrdotgg/ledgermath
       ```

       The run by hand publishes, now from the development bucket, any production Run the
       Runs repository lacked, and derives.

    Changes: the schedules and launch functions' lists of targets of both stages, the
    development bucket (added to only), and the two variables. The 16:10 round runs in the
    development account, and its Runs are published once step 4 points the workflow at that
    bucket. Nothing is removed: the production bucket keeps its objects, and Run files
    already copied from it stay in the Runs repository (Runs are never removed, and the copy
    job only adds). For a later try, run steps 6 to 13 again: the copy adds what the
    development bucket gained, finds production's own objects there and the same, and the
    verification passes (a Run that does not validate, now in both buckets, fails at both
    ends alike).

## Prices

Step 6 (#45). Every day LedgerMath keeps a copy of what AWS publicly charges for what it
measures, so a price can be cited the way a Run can: a file that never changes, at a fixed
address, holding AWS's own words. One file a day, `prices/<yyyy>/<mm>/<dd>/aws.json` (the
UTC date of the fetch) in the Runs repository beside the Runs, added once and never
edited, even on a day when nothing changed, so "the price on a given day" is one lookup
and a missing day shows.

### Where the prices come from

AWS's Price List bulk files, which need no account. `scripts/fetch-prices.ts` starts at
the offer index, `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json`,
follows each offer's `currentRegionIndexUrl` to its region index, and takes the
Region's `currentVersionUrl`, the versioned URL of the offer file for that Region. The
three offers, on 2026-11-11:

| Offer | What it holds for us | Versioned file for `us-east-2` | Size |
|-------|----------------------|---------------------------------|------|
| `AmazonEC2` | Instance types, and EBS volumes | `…/offers/v1.0/aws/AmazonEC2/20261110173852/us-east-2/index.json` | 442 MB (108,279 products) |
| `AmazonS3` | S3 storage and requests | `…/offers/v1.0/aws/AmazonS3/20261109154310/us-east-2/index.json` | 0.5 MB |
| `AWSDataTransfer` | Data out of the Region, to the internet among others | `…/offers/v1.0/aws/AWSDataTransfer/20261110232936/us-east-2/index.json` | 1.5 MB |

How AWS versions them: a file's `version` is its `publicationDate` written as 14
digits, and the versioned URL holds it. `…/<offer>/current/<region>/index.json` serves
the newest version's bytes and moves; a price file records and cites only the versioned
URL. The EC2 offer is published several times a week. The version index,
`…/<offer>/index.json`, lists one version per period it was in effect (about a month),
not every publication; but every version tried was still at its versioned URL, listed or
not, among them unlisted EC2 versions of 2019-11-21, 2020-08-06 and 2026-10-12. AWS does
not promise that, so the price file also holds the size and SHA-256 of what it read.

### What a price file holds

The schema is `schemas/prices.schema.json` (`ledgermath.prices/1`). Besides `schema`,
`provider` (`aws`) and `fetched_at` (when the fetch started, to the millisecond):

- `measured`: what `schedule.json` said is measured when the file was cut, its instance
  types (sorted) and the Region of its zone. A new instance type in the schedule brings
  its price with it the next day.
- `rules`: the rule set the records were selected with, by name and version
  (`scripts/lib/price-rules.ts`).
- `sources`, one per offer file: the versioned `url`, the file's own `version` and
  `publication_date`, its size in `bytes` and its `sha256`, its `header` (every top-level
  member other than `products` and `terms`, verbatim, AWS's disclaimer included), the
  `selections` (each rule, what it selects in words, and the SKUs it selected), and the
  selected `products` and their `terms.OnDemand`, keyed as AWS keys them.

The records are verbatim: each product and each SKU's On-Demand terms is AWS's own
object, parsed and written back with nothing changed but the whitespace between tokens.
The cut proves this record by record (written back, a record must equal the file's text
with its whitespace removed, so no key moved, no number lost its digits and no escape
changed) and stops if it does not hold. Reserved terms are not kept.

The cut never reads a file differently from a standard JSON parser. The reader checks
the whole file against JSON's grammar as it goes (structure, strings and escapes, UTF-8,
numbers and literals, one top-level object and nothing after it), and stops on a key a
standard parser would silently keep only the last of: a repeated top-level member, a
repeated key directly under `products` or `terms`, a repeated SKU under any kind of
terms, and any repeated key inside a record it keeps (an offer term code, a rate code,
an attribute). The recompute check cuts with the same reader, so it refuses the same
files, and it refuses a price file that itself repeats a key.

Rule set 1 selects, in the Region:

| Rule | Offer | What it selects | Exactly |
|------|-------|-----------------|---------|
| `ec2-instance-on-demand-linux` | `AmazonEC2` | Each scheduled instance type as a box of the stage runs: Linux, shared tenancy, no pre-installed software, no licence, no capacity reservation | one per type |
| `ebs-gp3-storage` | `AmazonEC2` | gp3 storage, per GB-month | one |
| `ebs-gp3-iops` | `AmazonEC2` | gp3 IOPS bought beyond the volume's included 3,000 | one |
| `ebs-gp3-throughput` | `AmazonEC2` | gp3 throughput bought beyond the included 125 MiB/s | one |
| `s3-standard-storage` | `AmazonS3` | S3 Standard storage, in its three tiers | one |
| `s3-standard-requests` | `AmazonS3` | S3 Standard requests: Tier1 (PUT, COPY, POST, LIST) and Tier2 (GET and all others) | one of each |
| `data-transfer-out-to-internet` | `AWSDataTransfer` | Data out of the Region to the internet, in its four tiers | one |
| `data-transfer-out-to-internet-global-free-tier` | `AWSDataTransfer` | The 100 GB a month, across Regions, that the first tier is "beyond" | one |

Each rule's exact conditions are in the file (`selects`) and in the code. A record a rule
of the named version does not select is not in the file, whatever AWS charges for it.
A rule that selects nothing, or more than it may, stops the fetch before it writes
anything: a silently empty or wrong price file is the failure guarded against, and a
stopped fetch shows up in the alarm two days later at the latest. A rule set is never
edited once a stored file names it: a change is a new version beside the old one in
`RULE_SETS`, so every stored file can still be cut again.

One quirk, kept as AWS wrote it: the gp3 throughput record's `unit` is `GiBps-mo` at
`40.96` USD while its `description` says `$0.04 per provisioned MiBps-month`
(40.96 / 1024 = 0.04).

### Citing a price

A price is cited as the file, the SKU and the rate code:

```
prices/2026/11/11/aws.json, SKU 8D49XP354UEYTHGM, rate code 8D49XP354UEYTHGM.JRTCKXETXF.6YS6EN2CT7
```

The rate code is `<sku>.<offerTermCode>.<code>`, and the file files every term under
`<sku>.<offerTermCode>` and every price dimension under its rate code (the fetch checks
both), so the citation finds exactly one price dimension, with its unit, its range and
AWS's description:

```bash
jq --arg sku 8D49XP354UEYTHGM --arg rate 8D49XP354UEYTHGM.JRTCKXETXF.6YS6EN2CT7 \
  '.sources[] | select(.products[$sku]) | {product: .products[$sku], price: [.terms.OnDemand[$sku][].priceDimensions[$rate]] | map(select(.))[0]}' \
  prices/2026/11/11/aws.json
```

### Locally

No AWS access is needed. Fetch into a clone of the Runs repository that pushes nowhere,
then check the file it made:

```bash
git clone git@github.com:smrdotgg/ledgermath-runs.git /tmp/ledgermath-runs
git -C /tmp/ledgermath-runs remote set-url --push origin no-push

# Downloads about 445 MB under --work, cuts, adds prices/<today>/aws.json, removes the
# downloads (--keep-sources keeps them, as <offer code>.json). Run again the same day,
# it says the file exists and does nothing.
bun scripts/fetch-prices.ts --work /tmp/prices-work /tmp/ledgermath-runs

# The recompute check: downloads each source again at its versioned URL, checks its size
# and SHA-256, cuts it again with the rule set, measured inputs and fetch time the file
# records, and requires the result to be the file, byte for byte. --sources DIR reads
# <offer code>.json from DIR instead of downloading (still hashed and checked).
bun scripts/check-prices.ts --work /tmp/prices-work /tmp/ledgermath-runs/prices/2026/11/11/aws.json
```

Each source's hash can also be checked by hand:
`curl -sS "$(jq -r '.sources[0].url' FILE)" | sha256sum`.

On this machine (us-east-2, near AWS's CDN) the whole fetch took 5 to 12 s and at most
154 MB of memory: 1 to 5 s to download the EC2 file, 4 to 6 s to cut it. The check took
5 to 11 s and at most 166 MB. Most of the memory is the keys the reader keeps to refuse
a repeated SKU.

### The workflow

`.github/workflows/prices.yml` runs at 03:17 and 15:17 UTC and by hand. The second
run is a second chance on a day GitHub drops or delays the first; when the first worked,
it adds nothing. It checks out this repository and the Runs repository (with the same
deploy key as `runs.yml`), runs the fetch with its downloads under the runner's temporary
directory, and commits and pushes the new file as `github-actions[bot]`, refusing to
commit anything but new files. It shares `runs.yml`'s concurrency group, `runs`, so the
two never run at once and neither's push is refused because the other pushed after its
checkout. Its times are hours from `runs.yml`'s, because GitHub keeps at most one run of
a group waiting: a third run queued while one runs and one waits cancels the waiting one.

It needs only the secret `RUNS_REPO_DEPLOY_KEY`, which `runs.yml` already uses (above): a
deploy key of `smrdotgg/ledgermath-runs` with write access. No AWS credentials and no
variables. GitHub runs scheduled workflows from the default branch only, so it starts
once it is on `main`.

## The agent skill

Step 7 (#47). [`skills/ledgermath/SKILL.md`](skills/ledgermath/SKILL.md) teaches an agent
to answer a question such as "what would it cost to distribute a new update of a large
game to 30 million players?" as napkin math: a model of a few factors, each taken from
LedgerMath with its citation or marked as an assumption, the arithmetic shown, and a range
from the 5th and 95th percentiles.

`scripts/lookup.ts` is what it reads LedgerMath with. Its input is a location holding
`derivations.json` (Method series v1's output), `requests-derivations.json` (Method
requests v1's, if there is one), `runs/` and `prices/`: a clone of the Runs repository with
the derivations files beside `runs/`, or a base web address serving the same paths (a web address cannot be listed, so the newest price file there is found by trying
each of the last 14 days). It derives no number of its own and reads no clock.

```bash
bun scripts/lookup.ts --data DIR about                  # what the data hold
bun scripts/lookup.ts --data DIR series memory_read     # the Series matching every word
bun scripts/lookup.ts --data DIR show cdd7309941eb      # one Series: p5, p50, p95, groups, Runs; and for a
                                                        # Series of requests each phase's p50 to p99.9 across requests
bun scripts/lookup.ts --data DIR prices c6i.8xlarge     # prices matching every word, in AWS's words
bun scripts/check-answer.ts --data DIR --question q.txt answer.md
```

Every number the tool prints has its citation beside it, in a syntax the checker resolves
(`scripts/lib/citation.ts`): `[lm:series/<id>/<number>/<p5|p50|p95|count>@v1,<moment>]` for
a Series' percentile or its number of counted Runs, with the Run files behind it linked as
`runs/<yyyy>/<mm>/<dd>/<id>.json`; `[lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/<rate code>]`
for a price, the file, SKU and rate code of "Citing a price" above (`/beginRange` or
`/endRange` after it for its tier's bounds); `[assumption: <where it comes from>]` for
anything else. A figure across a Series' requests is
`[lm:requests/<id>/<phase>/<count|min|p50|p90|p95|p99|p99.9|max>@v1,<moment>]`, how many
requests are ranked at or above a percentile `…/<phase>/<p99>/at_or_above@v1,<moment>`, how
many counted Runs and failed requests `[lm:requests/<id>/runs@v1,<moment>]` and
`…/failed[/<phase>/<kind>]@v1,<moment>`, each also of one group (`requests/<id>/group/<G>/…`)
or of the requests with one value of a fact they record
(`requests/<id>/by/address_block/52.219.0.0/16/…`, as of the newest Run only).

`<moment>` is the start of the Series' newest Run, to the second: a citation is of the
Series as it stood then, under Method series version 1. When more Runs have arrived, the
checker recomputes the cited statistic from the Runs that had started by that moment (each
Run's number depends on that Run alone, so the population then is the Derivation's points
up to it, through Method version 1's own `percentile`). A figure across requests, pooled
from histograms, is checked against the pooled figures Method requests v1 keeps on each
Run, as they stood through it. It is the Series' own newest Run,
not the file's, because boots of one instance type never overlap and upload all their Runs
at once, while another type's boot still running when the Derivations were made can add
Runs that started earlier.

The checker holds every number in an answer, tables and code included, to one rule: it is
from the question, cited (in the cited unit; a price in AWS's own unit), an assumption with
a source in words, the result of a line of arithmetic it recomputes from accounted operands,
or a repeat of one of these with the same value and unit. A line of arithmetic passes when
its result follows from its operands either with units carried or as plain numbers exactly
as written; a count of things per unit of time ("10000000 GETs per day", "writes/s") carries
as a rate, and a time per thing ("30.06 µs per write") as a time. A mistake is reported once,
with how many other numbers depend on it, and every problem says what was expected, what
was found and what would fix it. `scripts/lib/answer-check.ts` says exactly how, and what it
does not read. It reads numbers, not meaning: a number that is
the cited figure, in its unit, passes whatever the words around it call it, so a pooled
99th percentile across requests described as "the first Run's", or a figure of one address
block described as the Series', passes as long as the value and the citation agree. Every
value the lookup tool prints reads back, under the checker's rule, as the value its
citation names (a value exactly halfway at six digits is printed with a digit more).

## The website (`site/`)

A placeholder: one page saying what LedgerMath is and that the site is on its way. It is
there so the site's build and its checks are in place; the real website is still to be
discussed, and nothing of it is designed yet.

It is SolidJS 2, built with Vite and Solid's Vite plugin (`@solidjs/vite-plugin`, in its
server-rendering mode), and prerendered: `vite build` writes the browser's files to
`site/dist/client` and a server bundle to `site/dist/server`, then
`site/scripts/prerender.ts` renders each page once with that bundle into
`site/dist/client` and removes the bundle. What is left is plain HTML, CSS and JavaScript
for any static host, with each page's content in its HTML, so it reads with JavaScript off;
the script then hydrates it. `site/` has its own `package.json` and `bun.lock`, apart from
the root's, and needs only Bun (Vite runs under Bun, not Node).

```bash
cd site
bun install --frozen-lockfile
bun run typecheck  # type-check
bun test           # the output check's and the live check's own tests (scripts/*.test.ts)
bun run build      # site/dist/client
bun run check      # checks site/dist/client, as the workflow does
bun run preview    # serves site/dist/client at http://127.0.0.1:4173 (a port as argument to change it)
bun run dev        # Vite's dev server, with hot reload
```

`.github/workflows/site.yml` runs on pull requests and pushes to main that touch `site/` or
the workflow, and by hand. It installs with the lockfile frozen, then runs the commands
above in the same order: type-check, test, build, `bun run check`. It keeps the built site
as the artifact `site`. `bun test` at the repository root leaves `site/` alone (root
`bunfig.toml`); the site's tests run inside `site/`.

`bun run check` (`site/scripts/check-output.ts`) checks two things in `site/dist/client`:

- `index.html` exists and holds each line of the page's text in its body, outside any
  script or style, which shows the prerender ran. The lines are listed in
  `site/src/App.text.ts`; change them there when the page's text changes.
- No HTML, CSS or JavaScript file refers to a file the output lacks, or loads anything from
  another origin. It reads `src`, `href`, `srcset`, `imagesrcset`, `poster` and
  `xlink:href` on any HTML element, `url()` in `<style>` blocks and `style` attributes,
  imports in inline scripts, `url()` and `@import` in CSS files, and `import`,
  `export … from` and `import()` of a quoted path in JavaScript files. `data:`, `about:`,
  `mailto:` and `tel:` URLs and fragment-only references (`#id`) are self-contained and
  pass. A link a reader follows (`href` on `<a>` or `<area>`) may go to another origin; a
  path it names must exist.

It does not read other file types (SVG, JSON, a web manifest), `image-set()` with bare
strings, or URLs that JavaScript builds as it runs, and it does not render the page: it
reads the HTML as text, so it cannot tell that text which is in the HTML is not shown (text
inside a `<template>`, say). It is a check on what an honest build writes, not an HTML
validator.

The built site carries Solid's runtime, so it also carries `third-party-notices.txt`
(`THIRD-PARTY-NOTICES.md`, section 3).

### Where it is deployed

The site is at https://ledgermath.com, hosted on Vercel (project `ledgermath`). Vercel only
hosts files: the site is built in GitHub Actions, by the build job above, and Vercel is
handed the finished files. The Vercel project has no Git repository connected, and
Vercel's build system never runs. (The real site will be built from benchmark data that
only the GitHub workflows have.)

The workflow's `deploy` job runs after the build job has passed, `bun run check` included.
It takes the `site` artifact that job uploaded, builds nothing, and runs
`site/deploy/deploy.sh`: that lays the files out as Vercel's Build Output API asks
(`.vercel/output/static`, and a `config.json` saying `{"version":3}`) in a temporary
directory, and runs `vercel deploy --prebuilt` on it. The Vercel CLI is pinned in
`site/deploy/package.json` and its `bun.lock`, apart from the site's own packages.

- A push to main, or a run by hand on main, deploys production: ledgermath.com moves to
  the new deployment. The job then fetches https://ledgermath.com/ and fails unless it
  answers 200, without a redirect, with each line of `site/src/App.text.ts` in its HTML
  outside any script (`site/scripts/check-live.ts`, the same test `bun run check` makes of
  the built file), so the live page reads with JavaScript off. Production deploys run one
  at a time and never cancel each other, so two cannot finish out of order.
- A pull request from a branch of this repository, or a run by hand on another branch,
  gets a preview deployment, which ledgermath.com does not serve. A newer push cancels the
  preview before it.
- A pull request from a fork is not given the repository's secrets, so its run skips the
  `deploy` job and still passes. The workflow uses `pull_request`, never
  `pull_request_target`, and the token is set only in the deploy step of a job that runs
  for this repository's own branches, so no code from a fork runs where the token is.

The job writes the deployment's URL to the run's summary. Preview URLs need a Vercel login
(the project's Vercel Authentication covers every deployment URL; only the custom domain is
public), so CI checks only production.

The workflow needs, in the repository's settings:

| Name | Kind | What it is |
|------|------|------------|
| `VERCEL_TOKEN` | secret | A Vercel token scoped to the project `ledgermath` alone; it expires on 2027-11-18 |
| `VERCEL_ORG_ID` | variable | The ID of the Vercel team that owns the project |
| `VERCEL_PROJECT_ID` | variable | The project's ID |

The Vercel CLI reads all three from the environment, so nothing runs `vercel login` or
`vercel link`. Nor does anything run `vercel pull`: it fetches the project's settings and
environment variables for a build, and this site is built without either. To deploy by
hand, with the three in the environment:

```bash
cd site && bun run build && bun run check && cd ..
(cd site/deploy && bun install --frozen-lockfile)
site/deploy/deploy.sh site/dist/client preview      # or production
```

It prints the deployment as JSON; `.url` is its URL. It needs `jq`.

The Vercel project was set up once by hand, not as infrastructure code. To repeat it:

1. `vercel project add ledgermath` in the Hobby team, with framework preset none and no Git
   repository connected.
2. `vercel domains add ledgermath.com ledgermath`, with the domain's nameservers pointed at
   Vercel's. `www.ledgermath.com` is not attached.
3. Vercel Authentication on for every deployment except custom domains.
4. A token scoped to that one project, saved as the secret `VERCEL_TOKEN`, and the team's
   and project's IDs as the variables `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`. Replace the
   token before it expires.

The box never sees it built or run: a box builds the benchmarks and runs `runner/`, nothing
else. `site/` is in the source archive a deploy makes (a `git archive` of the whole commit),
but not in a Run's runner manifest, which lists `runner/` alone.

## July's pipeline (`benchmarks/c/`, stage `smr`)

Each `benchmarks/c/bench_<name>.c` is a standalone benchmark that links the shared harness
(`harness.c` / `harness.h`) and prints a JSON array of results.

```bash
make -C benchmarks/c           # build every bench_*.c
make -C benchmarks/c quick     # build + run all, smaller buffers/fewer samples (dev)
make -C benchmarks/c run       # build + run all, full samples
```

**Retired on 2026-11-13.** From 2026-07-11, once a day at 23:10 UTC, EventBridge
Scheduler invoked a Lambda that launched a `c6i.8xlarge`; the instance built
`benchmarks/c`, ran `run-all.sh`, uploaded JSON to S3, and terminated itself. That daily
schedule is now switched off in AWS. The bucket and its results, the last for 2026-11-12,
are kept. The code stays as the proof of concept the build started from. **Do not deploy
the stage `smr`**: a deploy would switch its daily schedule back on.

| Piece | Location |
|-------|----------|
| Stack | `sst.config.ts` (every stage not ending in `-runs`) |
| Launch Lambda | `infra/lambda/launch-runner.ts` |
| Stale reaper (hourly, >2h) | `infra/lambda/reap-stale.ts` |
| Instance bootstrap | `infra/ec2/run-benchmarks.sh` |

Results land at `s3://<Results bucket>/results/<instance-type>/<timestamp>.json`
(plus `.meta.json`, `.status.json` and `.log`). Source for the runner is staged at
`s3://…/source/benchmarks-c.zip` on every deploy. July's stack picks the most recent
Amazon Linux 2023 image at every deploy, so deploying it again would change its image.

## Licence

LedgerMath's own code in this repository is licensed under the Apache License 2.0:
[`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Not everything in the repository is
LedgerMath's own. Files that came from other projects keep their own licences and notices:
napkin-math's MIT notice goes with the benchmarks translated or ported from it, AWS C Auth's
SigV4 test cases keep theirs, AWS's data in the test fixtures is AWS's, and the licence texts
under [`third-party/`](third-party/) and [`docs/runs-repository/`](docs/runs-repository/)
are their authors'. [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) says which, file by
file.

The benchmark binaries contain third-party libraries. Each static binary contains parts of
the GNU C Library (LGPL-2.1-or-later) and of GCC's runtime library, and `http_get`'s also
contains AWS-LC. The dynamic build of `memory_read` loads the C library at run time, and
contains only the start-up files of glibc and GCC and one object of GCC's runtime library.
`THIRD-PARTY-NOTICES.md` lists what is in which binary, with the licences, the notices and
where the source is. glibc's licence text and its other notices are in
[`third-party/glibc-2.34/`](third-party/glibc-2.34/).

The data, the Runs and boot summaries in the Runs repository (`smrdotgg/ledgermath-runs`),
are licensed under CC BY 4.0. That repository's README says how credit can be given and what
the licence does not cover, AWS's price records among them; it and the repository's
`LICENSE` are kept here, in [`docs/runs-repository/`](docs/runs-repository/), and copied
there.

### glibc's source beside the binaries

The binaries are blobs in the stage's bucket, and the source package of the glibc they were
built against is kept there too, as a blob named by its hash.
[`third-party/sources.lock.json`](third-party/sources.lock.json) names it (its name,
version, Amazon Linux's address, size and SHA-256), and
`scripts/publish-third-party-source.ts` puts it there:

```bash
STAGE=smr-runs                     # the scheduled stage, whose bucket holds the binaries; production-runs after the move
PROFILE=tabot-dev                  # production-runs: tabot-production
BUCKET=$(jq -r .bucket ".sst/outputs.$STAGE.json")
# The script reads keys from the environment: each run gets them in a subshell, and this shell holds none.
with_keys() { (eval "$(aws configure export-credentials --profile "$PROFILE" --format env)" && "$@"); }

with_keys bun scripts/publish-third-party-source.ts --bucket "$BUCKET" --dry-run   # checks what is there; uploads nothing
with_keys bun scripts/publish-third-party-source.ts --bucket "$BUCKET"             # downloads, checks, creates, reads back
with_keys bun scripts/publish-third-party-source.ts --bucket "$BUCKET"             # again: reads back, uploads nothing
```

The credentials need `s3:GetObject` and `s3:PutObject` on the bucket's `blobs/*`, and
`s3:ListBucket` on the bucket: without it, S3 answers a HEAD for a missing key with 403
instead of 404, and the script stops at the first source package it has to upload.

It never overwrites or deletes an object. It creates each one with `If-None-Match: *`, so S3
refuses the write if the key has appeared since the script looked, and it removes only the
directory it made for its own download. Every object it finds, or creates, it reads back
whole and hashes: one with other bytes than the lock's stops it, changing nothing. Its last
line says whether every source package of the lock is now in the bucket with the right bytes
(`VERIFIED: …`), and it exits non-zero when it stopped.

`--directory DIR` publishes into a directory laid out like the bucket instead, with no AWS,
and refuses a symbolic link anywhere on the path. The lock names the image
`infra/runs/stack.ts` pins, and `bun test` fails when the two differ. So a change of image
means a new entry for its glibc in the lock and in `THIRD-PARTY-NOTICES.md`, and a run of the
script before the new binaries are published.
