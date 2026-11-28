# ledgermath

LedgerMath is a server benchmarking tool. A benchmark is one statically linked native
binary that prints a stream of events to stdout, one JSON object per line, and
diagnostics to stderr. A box on EC2 builds it, runs it as an ordinary process, dumps
its own environment around every execution, and writes one Run per execution: a
self-describing record kept forever. The plan is GitHub issue #36; step 2, one Run end
to end, is #37; step 3, the first Method and a page, is #39; step 6, prices, is #45; step 7,
the agent skill and opening the repository, is #47 (the skill and its tools were removed on
2026-11-27: an agent reads the data API and the documentation, starting at
`https://ledgermath.com/llms.txt`). `docs/dev-log.md` section 2 is the event contract.

Two pipelines live here. The new one, described first, writes Runs. July's proof of
concept (`benchmarks/c/`, its own JSON format) was retired on 2026-11-13; its code stays,
as the base the build started from (last section).

## Layout

| Path | What it is |
|------|------------|
| `benchmarks/harness/c/` | The C harness that prints the event stream (`lm.h`, `lm.c`); `lm_event.h` and `lm_event.c`, which emit a benchmark's own events and further `observed` events; `lm_fixed.h` and `lm_fixed.c`, samples of fixed work; `lm_disk.h` and `lm_disk.c`, what a disk benchmark observes about its file and device; `lm_fixture.h`, the disk Fixture's pattern |
| `benchmarks/<name>/` | One benchmark on the stream: its source, a `README.md` (what it measures, its parameters and observed values; also its page at `https://ledgermath.com/docs/benchmarks/<name>`; how it differs from July's version, or for `http_get` from its study, is in `docs/dev-log.md`, section 8), and a `Makefile` (`make BUILD=static`, `BUILD=dynamic`, `make -s compiler`, `make -s resolved`). All fourteen: `memory_read`, `compressed_memory_read`, `memory_read_random`, `memory_write`, `syscall`, `hash`, `sort`, `tcp_echo`, `mutex`, `disk_read_random`, `disk_read_io_uring`, `disk_read_sequential`, `disk_write`, `http_get` |
| `schedule.json` | The targets (instance types, their zone, the times of day each boots) and what a box runs: benchmarks, builds, samples, timeout, parameter sets, and the instance types an entry is for. Checked by `infra/runs/schedule.ts` |
| `runner/` | The box side: `box.sh` (user-data), `provision.py` (prepares the disks at boot and records it), `fixture.c` (writes a disk Fixture), `aws-lc-archive.sh` (fetches and checks the TLS library's source for `http_get`'s build), `run.py` (builds, runs, dumps, gives a Service's inputs to the entries that name it, writes Runs), `cpuid.c` |
| `schemas/` | `run.schema.json` (the Run), `events.schema.json` (one line of the stream) and `prices.schema.json` (a price file); `api/v1/`, the data API's files (section "The data API"). Every field of every one has a description |
| `scripts/check-events.py` | Checks a stream's order; needs only Python 3 |
| `scripts/check-runs.ts` | Checks a directory laid out like the bucket: schemas, every hash, every stream read from its stdout blob, runner manifests |
| `scripts/check-disk-runs.ts` | Checks that every disk Run in such a directory found the disk it declares, that its evidence adds up, and that its dump bears it out |
| `scripts/check-targets.ts` | Checks `schedule.json`'s targets' `vcpus`, their zone offerings and `vcpu_quota.limit` against AWS, read-only, in the account of the stage it is given; needs AWS access, so not part of `bun test` |
| `scripts/box-in-container/` | Boots `runner/box.sh` in Amazon Linux 2023 with S3 and shutdown stubbed, in several scenarios, `http_get` against a stand-in for S3 among them |
| `infra/runs/` | The `-runs` SST stage: stack, launch Lambda, reaper, user-data, the schedule's check (`schedule.ts`), the targets and their launch schedules (`placement.ts`), which account a stage deploys to and which one stage is scheduled (`stages.ts`), what stops SST acting on another account than a stage's (`deploy-account.ts`), the workflow's AWS role, the `s3_fixtures` Service's bucket, objects and role (`fixtures.ts`), AWS-LC's source archive (`tls-archive.ts`), the data API's private bucket and the workflow's permission to upload to it (`api-bucket.ts`), the public data API's CloudFront distribution on the Free plan at `api.ledgermath.com`, for one stage, behind one switch (`public-blobs.ts`, named for the design it grew from; what a deploy may do from what is deployed, `public-blobs-guard.ts`; the resources, `public-blobs-stack.ts`; the watch that disables it without a plan, `plan-watch.ts`, `plan-watch-handler.ts`) |
| `methods/` | Methods, versioned, turning Runs into Derivations (`methods/README.md`): `series` v1 (`v1/`) one number per Run for every Series; `requests` v1 (`requests/v1/`) each phase of a request across requests, for the Series of requests; `records.ts` the reduced record of a stream, kept between runs |
| `scripts/copy-runs.ts` | The copy job: the bucket's Run files and boot summaries into the Runs repository |
| `scripts/copy-bucket.ts` | Copies one `-runs` bucket into another, across two accounts, only ever adding, and checks the copy (`scripts/lib/bucket-copy.ts`): the move to the production account |
| `scripts/derive.ts`, `scripts/build-page.ts` | Run the Methods over the Runs; turn their Derivations into the page |
| `scripts/build-api.ts`, `scripts/check-api.ts`, `scripts/previous-api.ts` | Cut the Derivations and the price files into the data API's static files, laid out as they will be served; check what was written against its schemas, its links, the Derivations and the Runs repository, and against the tree before it; fetch that tree, the one the latest run that checked its tree kept (`scripts/lib/api.ts`, `scripts/lib/api-check.ts`; section "The data API") |
| `scripts/api-reference.ts`, `scripts/lib/api-reference.ts`, `scripts/lib/api-reference-words.ts` | The data API's reference, as Markdown, generated from the schemas: a page per kind of file with every field, the overview with the API's contract quoted from `scripts/lib/api.ts`, and the machines page from `schedule.json`; the words written by hand (section "The API reference") |
| `scripts/lib/docs-addresses.ts` | The addresses of the documentation pages, the one list a link between pages is held to |
| `scripts/fetch-api-sample.ts`, `docs/api-sample/` | Takes the fixed sample of the data API's files the reference's examples come from; the sample, as served, with its manifest `sample.json` |
| `scripts/read-api-tree.ts` | Reads from the API bucket itself the three files the website is built from (the table of contents, the Series list, the newest price file), of one publication, for the production deploys (section "Where it is deployed") |
| `scripts/alarm.ts` | Opens, or comments on, one issue when a watched Series has had no Run for 48 hours, the newest price file is more than 48 hours old, or the API bucket's table of contents is more than 14 hours old (or missing, or unreadable) |
| `.github/workflows/runs.yml` | On a schedule: copy, push, derive, page, the data API's files, alarm; then publish the data API, and rebuild and deploy the website from what the API bucket holds |
| `scripts/fetch-prices.ts`, `scripts/check-prices.ts` | Make the day's price file from AWS's public price lists; check a price file by downloading its sources again and cutting them again |
| `scripts/lib/price-rules.ts` | The selection rules, versioned: which of AWS's price records a price file keeps |
| `scripts/lib/offer-file.ts`, `scripts/lib/prices.ts`, `scripts/lib/price-file-check.ts` | Reading AWS's offer files without holding them in memory; the cut, the download and the price file; whether a price file holds together |
| `.github/workflows/prices.yml` | The price fetch, twice a day, adding at most one file a day to the Runs repository |
| `site/` | The website: the home page (design v9) with every figure read at build time from a tree of the data API, and a placeholder at `/docs/`; SolidJS 2, rendered to static files and hydrated in the browser, where Solid Router changes the page in place (section "The website" below); `.github/workflows/site.yml` builds and checks it, and deploys it to Vercel (`site/deploy/`) at https://ledgermath.com, and the `runs` workflow rebuilds and deploys it after every publish |
| `CONTRIBUTING.md` | How to add a benchmark in any language, a target, a Method version, and what a pull request says |
| `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md` | The code's licence (Apache-2.0), its notice, and what comes from other projects, with their licences (section "Licence" below) |
| `third-party/` | glibc 2.34's `COPYING.LIB` and `LICENSES`, and `sources.lock.json`, the third-party source packages kept in the bucket beside the binaries |
| `scripts/publish-third-party-source.ts` | Puts the source packages `third-party/sources.lock.json` names into the bucket, create-only, and reads every one back to check its bytes (`scripts/lib/s3-create.ts` sends its conditional PUT, which `scripts/lib/sigv4.ts` signs) |
| `docs/runs-repository/` | The Runs repository's `README.md` and `LICENSE` (CC BY 4.0), kept here and copied there |
| `tests/` | `bun test`: the schemas against sample Runs, the Run checker, the schedule's check, the runner's timeout and stop races and its instance-type filtering, the dump's sections, the disk provisioning's decisions, the disk Fixture and the binaries' checks of it, the launch schedules, which account each stage deploys to and which one is scheduled, that SST stops before acting on another account, launch and reap logic, the box's and the workflow's roles, the Method (and that the move to the production account starts no group), the copy job, the bucket copy against a stand-in for S3, the page, the data API's files and their check, the alarm and the workflows, the price fetch, cut, schema and recompute check on excerpts of AWS's files (`tests/samples/prices/`), and that every field of every schema has a description (`tests/schema-descriptions.test.ts`), and the API reference: every schema with a page, every field on it with its words, the sample, the examples, the links (`tests/api-reference.test.ts`) |

## A benchmark, locally

Requires Linux x86_64 with AVX2, gcc and the static C library (`libc6-dev` on Ubuntu,
`glibc-static` on Amazon Linux).

```bash
make -C benchmarks/memory_read                      # build/static/memory_read
./benchmarks/memory_read/build/static/memory_read --quick | python3 scripts/check-events.py --quick
LM_PARAM_SIZE_BYTES=1073741824 LM_PARAM_THREADS=all LM_PARAM_PATH=avx2 LM_SAMPLES=10 \
  ./benchmarks/memory_read/build/static/memory_read
```

`--quick` is a developer mode (small buffer, three samples). The scheduled box never passes
it; `runner/run.py --quick` passes it to every binary and still writes their Runs, but no
Method counts a Run whose stream says `quick: true`.
Every benchmark directory works the same way; its `README.md` lists its `LM_PARAM_*`
variables, and `schedule.json` the values a box gives them.

## Tests

```bash
bun install
bun test
python3 scripts/check-scratch.py    # needs Docker
```

The suite makes no request to any other machine: what it checks never depends on a
service. `bun test` preloads `tests/no-network.ts` (`bunfig.toml`, and `site/bunfig.toml`
for the website's tests), which refuses any host that is not this machine, with an error
that says the test reached for the network. A test gives the code it runs a directory, a
server on `127.0.0.1`, or a fetch of its own instead. The guard catches a test's ordinary
mistake, not every way out:

- **Guarded:** `fetch`, and every redirect it would follow; `node:http` and `node:https`,
  however imported, the AWS SDK among their callers; `node:net` and `node:tls`, and
  `node:http2`, which connects through them; a `Worker` (`new Worker`), which is given the
  guard as its first preload; and every Bun process a test starts with its environment,
  through `BUN_OPTIONS`, which names the guard as a preload.
- **Redirects:** to check each destination before it is asked, the guarded `fetch` follows
  redirects itself (`tests/no-network-redirects.ts`), as Bun's own `fetch` does: the same
  statuses, methods, headers (`Authorization`, `Cookie` and `Proxy-Authorization` dropped
  across origins), bodies sent again, signal, limit (126 redirects, Bun's, where the Fetch
  standard says 20), errors, and `redirected` and `url` on the response and its clones. A
  caller asking for `redirect: "manual"` or `"error"` gets Bun's `fetch` untouched.
  `tests/no-network-redirects.test.ts` sends each of some 430 requests through both, to
  local servers, and requires the same response and the same requests received. One
  exception: a body that is a stream, answered with a 301, 302, 307 or 308 that would be
  followed, is refused by the guard, with a message saying to give `redirect: "manual"` or
  a body that can be sent again. Bun follows those for a Blob's stream and refuses them for
  most others, and the two cannot be told apart from outside.
- **Not guarded:** a child started with an environment of its own, without `BUN_OPTIONS`;
  a program that is not Bun (Python, C, `curl`), which its test points at a local stand-in;
  `node:worker_threads`; `Bun.connect`; `WebSocket`; `node:dgram` (UDP); and DNS lookups.
- **This machine:** `localhost` and names ending in `.localhost`; `127.0.0.0/8`, also
  mapped into IPv6 (`::ffff:127.0.0.1`); `::1`; `0.0.0.0` and `::`; and a Unix socket. Other
  names `/etc/hosts` may give loopback, such as `ip6-localhost`, count as other machines, so
  a test passes or fails alike on every machine.

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

## Where the workflows run

The repository is public, and its four workflows (`check`, `prices`, `runs` and `site`) are
enabled. Every job of every workflow under `.github/workflows/` runs on GitHub's hosted
runner `ubuntu-24.04`, which is free for a public repository: each job says exactly
`runs-on: ubuntu-24.04`. Each job gets a fresh machine, and nothing is kept between jobs
but what the workflow keeps on purpose (GitHub's cache, artifacts).

**No job ever runs on a self-hosted runner.** In a public repository, a stranger's pull
request could then run on that machine. `tests/workflow-runners.test.ts` holds every job of
every workflow file to the plain string `ubuntu-24.04`, and refuses anything that could
name another runner: an expression (`${{ … }}`, which a variable could point anywhere), a
list of labels, an object (`group:` or `labels:`), the word `self-hosted`, any other label,
and a job with no `runs-on` that is not a call to a reusable workflow in
`.github/workflows/` of this repository (whose jobs it checks too).

When a pull request from a fork runs `check`, or `site` (it changes `site/` or
`.github/workflows/site.yml`), its jobs get a read-only GitHub token and none of the
repository's secrets, and `site` runs only its `build` job, skipping both deploy jobs
("Where it is deployed"). `runs` and `prices` never run for a pull request.

## The daily box: a `-runs` stage

Any SST stage whose name ends in `-runs` deploys `infra/runs/stack.ts`. Every other stage
deploys July's stack, below, unchanged; July's stage, `smr`, must not be deployed.

### Two accounts, one scheduled stage

Two AWS accounts, each reached through a profile of the AWS CLI on the machine that
deploys. `infra/runs/stages.ts` decides which a `-runs` stage deploys to, and nothing
else names a profile (`sst.config.ts` takes a `-runs` stage's settings from it):

| Stage | Account (profile) | On `sst remove` | For |
|-------|-------------------|-----------------|-----|
| `production-runs` | production (`tabot-production`) | the stack is kept, and SST refuses outright (`protect`) | The boxes that boot on the schedule, the bucket that keeps their Runs and blobs for good, and what the `runs` workflow reads: the scheduled stage since 2026-11-19 |
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
  workflow assumes) and SST's own state for the account. Its Runs bucket holds every Run:
  all those of the development bucket (copied, and verified byte for byte), the 35 Runs of
  the `m5.large` booted there by hand on 2026-11-18 (step 3 of the move, boot
  `b3d26616-de4e-42b6-80b9-dcf72db34995`), which no other bucket holds, and every Run since.
- **Development**: the stage `smr-runs` (the same parts, with no launch schedule since
  2026-11-19; its bucket is kept as it is, and holds every Run its own scheduled rounds and
  boxes by hand made, up to its last round, at 10:10 UTC on 2026-11-19), the dev machine,
  July's retired stack (stage `smr`) and its bucket, and SST's own state for the account.

One stage is the scheduled one: `SCHEDULED_STAGE` in `infra/runs/stages.ts`. Only it gets
the launch schedules below. Every other `-runs` stage gets the launch function, the reaper,
the buckets and the roles, and no schedule: its boxes start only by hand. Its launch
function's list of targets (`LEDGERMATH_TARGET_INSTANCE_TYPES`) names none, so a scheduled
payload, from a schedule left behind for instance, is refused and launches nothing; a launch
by hand names its type and is unaffected. The scheduled stage has been `production-runs`
since 2026-11-19, when the move to the production account, below ("Moving the schedule to
the production account"), took it over from `smr-runs`. The alarm and the workflow know no
stage: the alarm watches `schedule.json`'s targets in the Runs repository, which the
workflow fills from the bucket named by `RUNS_BUCKET`, so that must be the scheduled stage's
bucket (if it is not, the alarm reports every watched Series within 48 hours).

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
   Run per execution. On three Intel types `memory_read`'s two builds give different
   numbers on its `scalar` path because the scalar loop lands in a different place in each
   binary, not because of how they are linked (`benchmarks/memory_read/README.md`). At 35 minutes it is sent TERM: it kills the binary it is running, still
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
`scripts/check-disk-runs.ts`, the container checks, and Method version 1. The page reads
Derivations, not events.

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

A boot's summary (`boots/<yyyy>/<mm>/<dd>/<boot>.json`) lists these parts, though it is
not a complete account in every case: `runs`; `not_run`, with the `reason` (told to stop before starting it, or
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
git status                        # must be clean (any sst-env.d.ts aside): a deploy refuses a tree that differs from HEAD
bunx sst diff --stage "$STAGE"    # what the deploy would add, change and delete
bunx sst deploy --stage "$STAGE"  # the profile and the Region (us-east-2) come from infra/runs/stages.ts
cp .sst/outputs.json ".sst/outputs.$STAGE.json"   # outputs.json is the last deploy's, whichever stage that was
git checkout -- sst-env.d.ts      # SST rewrites it for the stage; the committed one is July's
```

`sst diff` and `sst deploy` also write `site/sst-env.d.ts` and `site/deploy/sst-env.d.ts`
(one beside each `package.json`). Neither is committed, `.gitignore` leaves both out, and
the check of the tree ignores every path ending in `sst-env.d.ts`, as it does the root one.

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

**A new kind of file in the data API.** The public serving answers 404 to every key of
no served shape (`SERVED` in `infra/runs/public-blobs.ts`, "The public data API", below),
and only a deploy of `production-runs`, made by hand, changes what it serves; but the
`runs` workflow publishes a new tree every six hours on its own. A tree that linked a new
kind of file, or a new schema, before that deploy would send readers to a 404. So the
change comes in two pull requests, in this order:

1. The served shape alone: it goes into `SERVED_AHEAD` in `infra/runs/api-bucket.ts`
   (a schema's address too), with the README's list of addresses. The build writes nothing
   new, so merging it changes no tree.
2. Merge it, and deploy `production-runs` from `main` as above (not within ten minutes of a
   boot time). Then check four addresses (a status alone proves little: S3 and the web ACL
   both answer 403, and only S3's says the shape reached the bucket):
   - each new shape, for a file that does not exist yet: 403 from S3, its `Server` header
     `AmazonS3` or its body S3's `<Code>AccessDenied</Code>`, as `curl -si` shows
     (`https://api.ledgermath.com/v1/benchmarks/memory_read.json`,
     `https://api.ledgermath.com/v1/schemas/benchmark.schema.json`); before the deploy, the
     edge's own 404;
   - a file that exists: 200 (`https://api.ledgermath.com/v1/index.json`);
   - a path of no shape: 404 with the edge's own words, `curl -s
     https://api.ledgermath.com/v1/notes.md` printing `Not found. LedgerMath's data API
     starts at /v1/index.json; …`.

   A check from one place reaches one edge location; a deploy reaches the others over some
   minutes.
3. Only then merge the second pull request, which makes the build write the files: their
   shape moves from `SERVED_AHEAD` to `TREE_KINDS` (a schema's name to `API_SCHEMAS`), which
   leaves what is served unchanged, so it needs no deploy. The next run of `runs` publishes
   them, each phase whole before the next ("The API bucket"). If it also raises `layout`
   (`LAYOUT` in `scripts/lib/api.ts`), start `runs` by hand right after the merge (Actions,
   `runs`, "Run workflow", on `main`, with `new_baseline` ticked). A scheduled run fails its
   gate against the tree of the layout before: it still keeps its artifact `page`, with the
   Derivations, but not the artifact `api`, and publishes nothing ("The data API", "A new
   baseline is declared by a human"). Then check, from what `runs.yml` does: its first job
   holds the concurrency group `runs`, which keeps one pending run and never cancels the one
   running, so a newer scheduled run can take the place of your run only while yours is
   pending; once your run's first job has kept its checked artifact `api` of the new layout,
   a later scheduled run takes that as its baseline, even while your `publish` job waits;
   and the `publish` job holds a group of its own, `api-bucket`, with its own pending slot,
   so a newer run's `publish` job can take the place of yours there. So check two things:
   that a run's first job of the new layout kept its artifact `api` (your run's, or a later
   one's), and that a `publish` job after it succeeded. If either did not happen, start the
   run by hand again the same way.
4. Check that each new address the table of contents gives answers 200, and that the
   table of contents gives the new `layout`.

**Merged out of order**, before the deploy, the second pull request's `publish` job stops
the publish when the edge answers with its own refusal: its first step asks the public edge
for one file of each kind in the tree, and every schema, and stops, naming the kind, when
the edge answers one of them with its own 404 (`scripts/check-api-edge.ts`, "The API
bucket"); the bucket, and so every reader, then keeps the tree before until the deploy,
after which the next run publishes. If the public address cannot be reached at that moment,
the step lets the upload go on, by design (the edge being down or slow never stops a
publish), and the tree it publishes can link addresses the edge refuses until the deploy.

**Forward only, from the first new key.** The `publish` job never deletes, and its
preflight refuses a tree that lacks any key the bucket holds ("A key the tree does not
have"), which `new_baseline` does not get past. So forward only starts with the first
successful write of a new key, one the bucket did not hold and the change's writer alone
writes (here the new schema, `v1/schemas/benchmark.schema.json`, in the upload's first
phase, or a benchmark's list, in its fourth), not with any write: the verification failed
only the new schema's write, the three existing schemas the change rewrites were updated in
the same phase, and the old tree's preflight still passed afterwards. Once a new key is
written, even by an upload that stopped there, reverting the change that writes it stops
every later publish (a tree without the new files, "holds N keys the tree does not have,
so nothing was uploaded"), and a fault found after that is fixed by a change forward. The
safe reading is to treat the first write of the migration, whatever it wrote, as the point
of no return. Likewise, any later change or rollback of the infrastructure must keep serving the
shapes the published tree links, or the table of contents links to addresses that answer
404.

The lists of Series by benchmark (ADR-0030, rule 13) came this way: the shapes in one pull
request (#99), the files, which raised `layout` to 2, in the next.

Every deploy of a new commit also does three things a reader of `sst diff` may not expect,
in whichever stage. The source archive's key is git `HEAD`'s commit, so a deploy of the
commit already deployed does none of them:

- It uploads the new source archive, `source/<commit>.tar.gz`, and points the launch
  function at it (`LEDGERMATH_SOURCE_KEY`).
- It updates the box's policy, `BoxPolicy`, which lets a box read its source archive by
  that exact key: the new key in, the previous one out.
- It deletes the previous commit's `source/` key. Where that object has a real version ID,
  the delete removes every version and nothing of it is kept; where its version is `null`,
  a delete marker is left. No Run loses its source: every box puts the archive it ran from
  in the bucket as a blob, `blobs/sha256/<hex>`, and that blob is what its Runs name (their
  `source`), not the `source/` key. On 2026-11-19 the deploy of `smr-runs` deleted the
  development bucket's `source/50db33a….tar.gz` this way, every version and no marker; the
  5,868 Runs built from it name its blob, which both buckets hold.

A deploy may also redeploy the reaper function with unchanged code, as both deploys of
2026-11-19 did: SST names a function's code by the hash of its zip, so a zip that differs
gives an update and an identical one gives none.

Under `blobs/`, `runs/` and `boots/` a deploy never deletes or overwrites anything. The only
objects it writes there are AWS-LC's source archive and the three Fixture blobs, each at
`blobs/sha256/<its SHA-256>`, and it writes one only when that key is new to the stage: on
its first deploy, and on a deploy with a new AWS-LC pin or a changed Fixture. The object it
replaces stays in the bucket (`retainOnDelete`). Its key is the hash of its bytes, so where
a box has already put the same blob there, the write stores the same bytes again as a new
version, and nothing is lost.

`sst diff` changes nothing in a stage, but SST bootstraps itself in an account the first
time it needs its state there, once per account and Region (SST's documentation names `sst
deploy` and `sst dev`; expect a first `sst diff` to do it too, as it reads the same state): a
state bucket `sst-state-<random>` (versioned), an asset bucket `sst-asset-<random>`, an ECR
repository `sst-asset` and the SSM parameter `/sst/bootstrap`; and it stores each stage's
passphrase in the SSM parameter `/sst/passphrase/ledgermath/<stage>` (SecureString). The
development account has them, for `smr` and `smr-runs`; the production account has had
them, for `production-runs`, since its first deploy on 2026-11-18.

What the first deploy of `production-runs` creates in the production account, as long as
it is not the scheduled stage (made on 2026-11-18, step 2 of "Moving the schedule to the
production account", below): the Runs bucket (versioned, public access blocked, an
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

In a stage that is not the scheduled one, which every stage in the development account has
been since the schedule moved on 2026-11-19, this is the only way a box starts.

Mind the quota of the stage's account. A box that fails to end itself lives until the
reaper finds it, up to 55 minutes. In the scheduled stage's account, a 2-vCPU type such as
`c6i.large` fits at any time (the worst moment holds 62 of 64 vCPUs), and anything larger
can meet the quota from HH:10 to HH+1:55 for HH = 04, 10, 16 and 22, when the scheduled
boxes may be up (the last launches at HH:50, or up to ten minutes later). In an account with no scheduled stage, the scheduled boxes take nothing:
the development account, which has had none since 2026-11-19, holds only the dev machine's
4 vCPUs. The production account's quota was 5 vCPUs until the increase to 64 was granted on
2026-11-14; until then only a type of at most 5 vCPUs, such as the target `m5.large` (2),
could be launched there.

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

### The public data API: CloudFront on the Free plan at `api.ledgermath.com`

The data API ("The data API", below) and the evidence it links are served from one host,
`https://api.ledgermath.com`, by a CloudFront distribution on the **Free flat-rate plan**
in front of two private buckets of `production-runs`: $0 a month for CloudFront, and no
CloudFront overage charge whatever strangers download (S3 still bills each request that
misses the cache: "What it still costs", below). ADR-0031 records the design. It is built
and **on** (`PUBLIC_API.state` in `infra/runs/public-blobs.ts`, which was `"off"`, then
`"dark"`, before it): deployed, the distribution is enabled, with its certificate, its
`api.ledgermath.com` records, its web ACL and its Free plan, and serves the four served
prefixes publicly, and each bucket's policy grants it `GetObject` under its served
prefixes and nothing more ("Turning it on, on `production-runs`", below). It has been
public since 2026-11-24, 17:51 UTC: what the deploys showed is in "Seen on the first
deploy" and "Seen when it was turned on", and what is still unseen in "Not verified yet",
all below. The file keeps the name of the
design it grew from, which served blobs alone at the distribution's `*.cloudfront.net`
name ("What became of public blobs", below).

What the switch does not cover already exists, and is private: the API bucket, which the
`runs` workflow fills after every run that checked the tree, and the workflow role's
permission to write to it ("The data API", "The API bucket").

**One stage only.** `PUBLIC_API.stage` is `production-runs`, the stage that holds the
permanent data (deployed with the profile `tabot-production`). Its type allows no other
stage, and a setting that names another, in any state, `off` included, stops every deploy,
of every stage (`checkSetting`), so that a typo is caught while it is harmless rather than
on the day the state changes. On every other stage, `smr-runs` included, nothing of it is
created and AWS is not even asked, whatever `PUBLIC_API.state` says. Every AWS call the
deploy makes, and every command it prints, uses the profile of the stage being deployed
(its provider's, from `sst.config.ts`, or `AWS_PROFILE`). The workflow keeps reading the
Runs bucket directly with its role and is not affected either way.

**What is served, and what is not.** In the state `on`, `GET` and `HEAD` of these paths,
at the host's root, exactly as the tree's links already give them, and nothing else
(`SERVED` in `infra/runs/public-blobs.ts`; a test holds this table to it):

| Path | From | Cache-Control | Content-Type | Access-Control-Allow-Origin | Compressed |
|------|------|---------------|--------------|-----------------------------|------------|
| `/v1/…` | the API bucket (`v1/`), the tree as the build wrote it | `public, max-age=300`, on the object | `application/json`, on the object | `*` | yes, when asked |
| `/runs/…` | the Runs bucket (`runs/`), Run files | `public, max-age=31536000, immutable`, from the function | `application/json`, from the function | `*` | yes, when asked |
| `/boots/…` | the Runs bucket (`boots/`), boot summaries | `public, max-age=31536000, immutable`, from the function | `application/json`, from the function | `*` | yes, when asked |
| `/blobs/sha256/…` | the Runs bucket (`blobs/sha256/`), blobs at `/blobs/sha256/<hex>` | `public, max-age=31536000, immutable`, from the function | as stored (`binary/octet-stream`) | `*` | no |

Every response from a bucket also carries its `ETag` (weak, `W/"…"`, when CloudFront
compressed it: CloudFront turns a strong ETag weak when it compresses), `Last-Modified`
and, when it is not compressed, `Content-Length`. The AWS managed response-headers policy
`CORS-and-SecurityHeadersPolicy` adds `X-Content-Type-Options: nosniff` (with
`Referrer-Policy`, `Strict-Transport-Security`, `X-Frame-Options: SAMEORIGIN` and
`X-XSS-Protection`) to every response, errors included. It adds
`Access-Control-Allow-Origin: *` only to a request that carries an `Origin` header, which
is what a browser sends when a page of another site calls `fetch()`; then every response
gets it, errors included. A request without `Origin`, such as a plain `curl`, does not get
it from the policy (seen on 2026-11-24). The evidence's function adds it anyway, `Origin`
or not, to every evidence response below 400, with `Content-Security-Policy: default-src
'none'; sandbox`. "Compressed": CloudFront compresses JSON with gzip or Brotli for a `GET`
that sends `Accept-Encoding`, and says so with `Content-Encoding` and `Vary:
Accept-Encoding`; a `HEAD` shows them only once a compressed copy is already in the edge's
cache. The bytes a reader decodes are the stored ones, whose sha256 the tree gives. Blobs
are never compressed, so the bytes served are the bytes their address hashes.

**Only the keys the project writes, and only at one host.** Under each prefix, only keys of
the shapes the project writes there are served: the tree's kinds (`TREE_KINDS` in
`infra/runs/api-bucket.ts`, the layout of ADR-0030: a schema by the build's own list of
them, `API_SCHEMAS`, kept in `scripts/lib/api-schemas.ts` and used by the build and the
edge alike; a month as a real month, a price file's day as a real day), a Run file as
`runner/run.py` names it (its day a real day, its id the Run schema's version 7 UUID), a
boot summary as it names it (its day a real day, the kernel's boot id), a blob by its
SHA-256. "A real day": months 01 to 12, and days the month has, February the 29th in leap
years only. On 2026-11-21 every one of the Runs repository's 7,270 Run files and 197 boot
summaries had these shapes. The request function, in front of every served behaviour,
answers 404 to any other key, before the cache or a bucket sees it, so an object left under
a served prefix in another shape (a `.bak`, an upper-case id, a schema the build does not
publish, a date such as `2026-99-99` or `2026-02-29`, a boot's `unknown.json`, which two
boots of one day without a boot id would share) is never served. Every function, the
default behaviour's included, answers 403 to a request whose `Host` is not
`api.ledgermath.com`, the distribution's own `*.cloudfront.net` name included, whatever the
path: the API has one host, and a wrong host gets the same answer everywhere. The list is
`SERVED` in `infra/runs/public-blobs.ts`, from which the function is written; a test holds
this list to it, and others hold the samples' and the built tree's every address to it.
The addresses, as the request function matches them:

- a schema: `^\/v1\/schemas\/(?:index|series-list|benchmark|series|series-month|prices|events)\.schema\.json$`
- a month file: `^\/v1\/series\/[0-9a-f]{12}\/[0-9]{4}-(?:0[1-9]|1[0-2])\.json$`
- a price file: `^\/v1\/prices\/(?:[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|1[0-9]|2[0-8])|[0-9]{4}-(?:0[13-9]|1[0-2])-(?:29|30)|[0-9]{4}-(?:0[13578]|1[02])-31|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29)\.json$`
- a Series file: `^\/v1\/series\/[0-9a-f]{12}\.json$`
- the list of Series: `^\/v1\/series\.json$`
- a benchmark's list of Series: `^\/v1\/benchmarks\/[a-z][a-z0-9_]{0,63}\.json$`
- the table of contents: `^\/v1\/index\.json$`
- a Run file: `^\/runs\/(?:[0-9]{4}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|1[0-9]|2[0-8])|[0-9]{4}\/(?:0[13-9]|1[0-2])\/(?:29|30)|[0-9]{4}\/(?:0[13578]|1[02])\/31|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)\/02\/29)\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$`
- a boot summary: `^\/boots\/(?:[0-9]{4}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|1[0-9]|2[0-8])|[0-9]{4}\/(?:0[13-9]|1[0-2])\/(?:29|30)|[0-9]{4}\/(?:0[13578]|1[02])\/31|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)\/02\/29)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$`
- a blob: `^\/blobs\/sha256\/[0-9a-f]{64}$`

A new kind of file, or a new shape of id, is served only once it is added there, and
deployed. A kind the build does not write yet is served ahead of it (`SERVED_AHEAD` in
`infra/runs/api-bucket.ts`, empty now), so that the deploy can come before the first tree
that links such a file ("A new kind of file in the data API", under "Deploy"). Each
benchmark's list of Series and its schema were the first.

**Notes for readers.**

- **Check a month file against its Series file.** A month file changes in place, at the
  same address, so a Series file and a month file can come from different rounds: for up
  to five minutes after a round (each is cached that long), and, should an upload stop
  between the month files and the Series files, until the next upload succeeds ("The data
  API", "The API bucket"). The rule: verify the bytes of a month file against the `sha256`
  its Series file lists; on a mismatch, fetch the Series file again, then the month file,
  and retry; while they still differ, the pair is not yet consistent, so wait and retry
  rather than use either. A month file whose sha256 the Series file lists need not be
  fetched again at all.
- **`GET` and `HEAD` only.** `OPTIONS` gets 403, so a browser's CORS preflight fails: a
  plain `fetch()`, with no custom request header, needs none and works from any origin. A
  script on another origin should not count on reading the `ETag` header: the managed
  policy does not put it in `Access-Control-Expose-Headers`, though the browser's own cache
  still uses it. (A Run file, boot summary or blob sometimes comes with the Runs bucket's
  own CORS headers, which do expose it: "Seen when it was turned on", below. A file of the
  tree never does.) Both are the managed response-headers policy's: on the Free plan no
  custom one can be used, and the managed ones that answer preflights or expose headers are
  not this one.

**Why these cache times**, held to ADR-0030's contract:

- **Nothing under `/v1/` is named by its content.** `v1/index.json`, `v1/series.json` and
  the Series file of every Series that gained a Run change every round; a month file
  changes whenever one of ADR-0030's four causes applies (the current month every round, a
  past one when a boot summary arrives, a Run arrives late, or a Method first applies); a
  schema when its words are edited; a price file only if the Runs repository's is ever
  corrected. So none can be `immutable`; and since a Series file lists its month files'
  sha256, a month file must not be cached longer than the Series file that lists it. One
  time serves the whole tree: five minutes, at CloudFront's edges (its managed policy keeps
  an object for the object's own `max-age`) and in readers' caches alike, after which a
  reader revalidates with the ETag. Five minutes is under 2% of the six hours between the
  workflow's runs. For up to five minutes after a round a reader may get a Series file and
  a month file of different rounds; the month's `sha256` in the Series file says so, and
  the reader fetches again once `max-age` has passed. A reader holding a month file whose
  sha256 the Series file still lists need not fetch it at all, which is what saves
  requests, not a long cache time.
- **The evidence never changes.** A Run file is never edited (ADR-0001; the copy job stops
  if the bucket's file ever differs from the Runs repository's), and each point cites it
  with its sha256; a boot summary is written once; a blob is named by its hash. So readers
  may keep it a year, `immutable`. The boxes upload it with no `Cache-Control`, so
  CloudFront's edges keep it for the managed policy's default, 24 hours, and then
  revalidate it.
- **A key the bucket does not hold** gets S3's 403 `AccessDenied`: the distribution may not
  list a bucket, so S3 does not say 404. CloudFront caches a 403 only when it carries a
  `max-age`, which S3's does not, so every such request reaches S3, and the limits below
  count it.

**Three locks.** Each bucket's policy lets the CloudFront service `s3:GetObject` under that
bucket's served prefixes only (`v1/` in the API bucket; `runs/`, `boots/` and
`blobs/sha256/` in the Runs bucket), only on behalf of this distribution
(`AWS:SourceArn`); never `s3:ListBucket` or `s3:GetObjectVersion`; and it carries that
grant only in `on`. The distribution reaches a bucket only from the behaviour of a served
prefix: the default behaviour's function answers 404 to every other address, so `/`,
`/source/…`, `/logs/…` and whatever is put in either bucket later reach no bucket. And
within a served prefix, the request function lets through only the shapes above, at one
host. Query strings are neither in the cache key nor passed on, so `?versionId=` never
reaches S3. Both buckets stay private, their public access blocks on; CloudFront signs its
requests to both with one Origin Access Control. `tests/public-blobs.test.ts` proves it: it
takes every kind of key the two buckets hold or may hold, served prefix or not and of a
served shape or not, spelt as an attacker might (`//`, `/./`, `..` before and inside a
prefix, percent-encoded, another case), picks the behaviour as CloudFront does (with dot
segments removed and without), runs its viewer-request function, applies the grants as the
policies hold them, and finds nothing but the served shapes ever read, in any state, under
no other host, and nothing at all in `dark` or `closed`; and, in front of a stand-in for S3
that holds every one of those keys, it gets each served key's bytes and a 404 from the
function for every other key under a served prefix, the bucket never asked.

| Request | Answer |
|---------|--------|
| `GET` of a served shape whose object exists | 200, with the headers above |
| the same, for an object the bucket does not hold (yet) | 403 `AccessDenied` from S3, not cached by CloudFront |
| a key under a served prefix of no served shape | 404 from the request function, `Cache-Control: public, max-age=300` |
| any `Host` but `api.ledgermath.com`, the distribution's `*.cloudfront.net` name included | 403 from the request function |
| any other address, `/` included | 404 from a function, `Cache-Control: public, max-age=300` |
| plain HTTP | 403 |
| any method but `GET` and `HEAD`, `OPTIONS` included (no CORS preflight is answered; a plain `fetch()` needs none) | 403 |
| over the per-address limit or the total limit (as WAF estimates them), or from an address on AWS's IP reputation list | 403 from WAF (a custom status such as 429 needs Pro) |

**Three functions, and why.** The Free plan allows only AWS managed cache and
response-headers policies (custom ones are Business), so no policy can add a header the
object does not carry, and nothing but a function can look at a request's path or host.
The request function, `ledgermath-production-runs-request`, is the shapes and the one
host above, on every served behaviour in `on`. The tree's objects carry their own headers,
set by the upload, so `/v1/` needs nothing more. The boxes upload Run files, boot summaries
and blobs with no `Cache-Control`, the box is not changed for this, and the workflow may
not write to the Runs bucket; so a viewer-response function,
`ledgermath-production-runs-evidence-response`, gives the evidence its `Cache-Control`,
`nosniff`, the CSP sandbox and, for `.json`, `Content-Type: application/json` (which the
boxes' upload already guesses from the name, `application/json` on the objects read on
2026-11-19, but no longer depends on). CloudFront runs it only below status 400. The third,
`ledgermath-production-runs-no-route`, answers 404 for the default behaviour, which must
name an origin and would otherwise send every address of no served prefix to a bucket; in
`dark` and `closed` every behaviour has it. Each is far under CloudFront Functions' 10 KB,
and the Free plan's feature table sets no number of functions; a behaviour takes one
viewer-request and one viewer-response function, which is what the evidence's have.

**Every blob the boxes upload is served as `binary/octet-stream`**, because the upload
sets no content type: `aws s3 sync` in `runner/box.sh` guesses one from a file's name, a
blob's name has no extension, and S3 then stores `binary/octet-stream`. That is so for
dumps, stdout, binaries and source archives alike; only the deploy's own blobs differ
(`application/gzip` for AWS-LC's archive, `application/octet-stream` for the Fixtures).
The upload is not changed. None has a `Content-Encoding`, and the distribution does not
compress blobs, so every client gets the stored bytes, the ones the hash names: `curl -O` saves
them as they are, and `fetch()` reads them. **A browser opened on a blob's address
therefore downloads it rather than showing it**, a text dump included; with `nosniff` it
does not sniff it into a page, nothing is rendered or run, binaries included, and should
a blob ever be rendered, the CSP sandbox lets it run nothing.

**Reading through it.** `bun scripts/derive.ts ... --blobs-url
https://api.ledgermath.com` reads blobs there instead of `--bucket`, with no
credentials (`publicBlobStore` in `scripts/lib/blobs.ts`). As with the bucket, every blob's
SHA-256 is checked before it is used or cached, which is what makes bytes from a public
address trustworthy at all. It never follows a redirect: it contacts the host it was given
and no other, and a 3xx stops the run with an error that names both addresses. 404 and S3's
403 `AccessDenied` mean no such blob; any other 403 (WAF) is a refusal and stops the run
rather than pass for a missing blob. It starts at most 4 requests a second, however many
are in flight (`--blobs-per-second N` to change that). `tests/public-blobs-derive.test.ts`
runs both Methods on the sample Runs from a directory and through a local HTTPS stand-in
and requires the same bytes. `scripts/check-runs.ts` reads a local copy (synchronously): it
fetches no blob, so it does not have the option.

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
blobs is about 270,000 requests a month, a quarter of the allowance; the whole tree is 390
files and 46.6 MB on 2026-11-19 (compressed for readers that ask, much less), so a reader
fetching all of it is 390 requests. A full download of the data outgrows the allowance,
and that is when to move to Pro.

**Two rate limits** (AWS WAF rate-based rules, in the web ACL the plan requires and pays
for), evaluated in this order after the two managed rule groups:

1. **Per address**: 1,500 requests in any 5 minutes, about 5 a second. A mirror fetching a
   day's new blobs at 4 a second, the pace `scripts/lib/blobs.ts` keeps, takes 37.5
   minutes at 1,200 per 5 minutes, 20% under the limit, which leaves room for WAF's
   estimate being near rather than exact; so does an agent walking the tree at that pace. A
   runaway loop does tens to hundreds a second and passes 1,500 within a minute; WAF blocks
   that address until its rate, as WAF estimates it, falls back under. Over IPv6 one client
   can spread across many addresses; WAF counts each on its own.
2. **A limit on all requests together** (the total limit): 6,000 in any 5 minutes, 20 a
   second, counted from every address as one (aggregation `CONSTANT`, "count all", which
   needs a scope-down statement: here, one that matches every request, "from Antarctica, or
   not from Antarctica", a geographic match and its negation, which together leave nothing
   out, a request whose country WAF cannot tell included). The odd shape is the Free plan's
   doing: it allows no string match, size constraint or regular expression in a rule, so
   "every path" cannot be written as a match on the path, which is how the rule was first
   built and what the plan refused on the first deploy ("Seen on the first deploy", below;
   `everyRequest` in `infra/runs/public-blobs.ts`). Every request that can reach a bucket
   (the tree, Run files, boot summaries, blobs) is counted, so none reaches S3 uncounted; so
   are the ones CloudFront answers from its cache, and the 404s the function answers, since
   WAF sees a request before either. In the design this grew from, it counted `/blobs/`
   alone, the only path that reached a bucket; now four prefixes do, and a 403 for a
   missing key is never cached, so it counts them all.

   *What it is.* A rate limit that AWS enforces approximately, on every request, those that
   can reach a bucket among them. At its rate, all month, 6,000 × 288 × 31 = 53,568,000
   requests get past the rule in a 31-day month (288 five-minute windows a day), about 53.6
   million, which at $0.0004 per 1,000 GETs is $21.43 if every one of them missed
   CloudFront's cache: what a month costs at the configured steady rate. *What it is not.*
   A cap. AWS says rate-based
   rules are "not intended for precise request-rate limiting"
   ([rate-based rule caveats](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-caveats.html)):
   WAF estimates the rate, weighting recent requests, and limits near the limit rather than
   exactly at it; requests can come in over the limit for up to several minutes before WAF
   starts limiting them (usually under 30 seconds); and changing any of the rule's rate
   settings resets its counts, which can pause it for up to a minute. So bursts can exceed
   the figure, by much more than rounding when they are large or repeated. There is no hard
   cap on S3 request charges here. Nor is it selective: while the total is over the limit,
   every request is refused, for everyone, polite mirrors and agents included (five of them
   at 4 a second fill it). Service resumes by itself when WAF's estimate of the rate falls
   below the limit; nothing needs to be done. It counts requests CloudFront serves from its
   cache too, so it is also the most the API serves in all, which is a decision to revisit
   once there are readers to count (ADR-0031).

Because the total limit comes last, a request a managed group or the per-address limit has
already blocked is never counted against everyone, so one runaway address is cut off by
its own rule without using up the total. Beside them, two free AWS managed rule groups,
`AWSManagedRulesAmazonIpReputationList` and `AWSManagedRulesKnownBadInputsRuleSet`: 4
rules of the Free plan's 5. `AWSManagedRulesCommonRuleSet`, the console's third default,
is left out: it guards applications that parse what they are sent, and it blocks requests
without a `User-Agent`. The Free plan takes these four rules as written: on 2026-11-24 a
web ACL on the plan held all four, 231 capacity units, and the plan stayed `ACTIVE` ("Seen
on the first deploy", below). It counts each managed group as one of its 5 rules, though
each holds several. `tests/free-plan-waf.ts` holds every statement of every rule, nested
ones included, to what the plan was seen to accept (the two managed groups, rate-based
rules by address or counting all, geographic matches, Or, Not), and at most 5 rules; a new
kind of statement must first be shown to be accepted by a web ACL on the plan.

**What it still costs.** S3 bills a GET for every request that misses CloudFront's cache,
$0.0004 per 1,000 in us-east-2 (AWS's Price List API, publication of 2026-11-19: $0.004 per
10,000), and the plan does not cover it; transfer from S3 to CloudFront is free. On the
Free allowance, if every request missed: $0.40 a month, $1.20 in the month of a 3× spike;
beyond that AWS keeps serving, at $0.40 per further million misses: $21.43 for a month at
the total limit's steady rate, and more if bursts get past it, since nothing caps it. A
file already cached at an edge does not miss (the tree for five minutes, the evidence for
24 hours); a 403 for a missing key may be free (S3 does not bill AccessDenied to requests
from outside the account), but count it. The plan's 5 GB of S3 storage credits offsets that
much of the buckets' storage. The rest is fixed: the hosted zone of `api.ledgermath.com`,
$0.50 a month, exists already, on or off; alias queries to CloudFront are free; the
certificate is free; the watch's 8,640 invocations a month are within Lambda's free tier.
Off, nothing of this exists; `dark`, it all exists and serves nothing, so it bills only
the fixed part; `on`, as merged, it serves, and S3's misses above are billed on top. In
every state the API bucket and its upload cost cents a month ("The data API", "The API
bucket").

**The states.** `PUBLIC_API.state`, on `production-runs`:

| State | Distribution | Certificate, `api.ledgermath.com` records | Bucket grants | Plan | Serves |
|-------|--------------|-------------------------------------------|---------------|------|--------|
| `off` | none | none | none | none | nothing |
| `dark` | disabled | made | none | subscribed by the deploy (`plan: "code"`) or by hand (`"console"`) | nothing |
| `closed` | enabled | made | none | as in `dark` | 404 to every address it lets through (WAF's 403s, and CloudFront's for plain HTTP or another method, aside); no request reaches S3 |
| `on` | enabled | made | both buckets, their served prefixes | must be ACTIVE: the deploy checks, once, as it starts | the four served prefixes |

`closed` is needed only if AWS refuses to subscribe a disabled distribution: it is
enabled so that the plan can be attached, but every behaviour has the 404 function and
neither bucket grants it anything, so nothing can be read. Being enabled, it takes public
traffic, and until the plan is attached that traffic is billed at pay-as-you-go rates
(below, after the steps). `on` takes the 404 function off the served behaviours and adds
the grants, after the same check that the plan is ACTIVE. The order is always `dark`, then
`closed` only if needed, then `on`.

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
`PUBLIC_API.plan` come only after `dark` has been deployed and the distribution reports
disabled (`Enabled` false, `Status` `Deployed`). A distribution the watch disabled while the
stage says `closed` or `on` takes a `dark` deploy before anything else, because a deploy of
`on` would not enable it again (the stage still records it enabled).

**`sst remove` runs none of these checks.** SST 4.17's `sst remove` runs `pulumi destroy`,
which destroys what the stage's saved state holds without running the program
(`pkg/project/run.go`), so the table has no column for it: a removal would cancel the plan
and delete the distribution whatever the distribution is doing. What stops it is SST's
stage protection: for a stage whose app settings in `sst.config.ts` say `protect: true`,
SST refuses `sst remove` before it does anything. So the public API is made only on a
protected stage: a deploy of `dark`, `closed` or `on` stops, before AWS is asked anything,
unless `$app.protect` is true (`off` is always allowed: it makes nothing).
`infra/runs/stages.ts` protects `production-runs`, the stage `PUBLIC_API` names, and no
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

**The watch.** A Lambda in the stage, `PublicApiWatch` (stage output
`publicApi.watchFunction`), runs every 5 minutes, deploy or not
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
Every disable is logged as `public API watch: DISABLED the distribution`, with the
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

**Turning it on, on `production-runs`**, with no moment when anything is served on
pay-as-you-go pricing (`closed`, if it is needed, is billed at pay-as-you-go rates for the
404s and the inspection of what reaches it until the plan is attached). The change is one
line, `state` in `PUBLIC_API` (`infra/runs/public-blobs.ts`), made twice: `"off"` to
`"dark"`, then `"dark"` to `"on"`, each in its own reviewed pull request, merged, and
deployed from `main`. **Each of those commits also changes, on purpose, the one constant
that pins the switch:** `RELEASED_STATE` in `tests/public-blobs.test.ts`, set to the state
the commit sets, in the same commit. The test "RELEASE GATE: the committed switch is the
released state, for production-runs" is the only one that reads the committed setting, and
it fails until the two agree, so that no commit turns the API on by accident; every other
test builds each state from its own fixture. A test rehearses the change for every state
and both plan attachments: it copies the repository, sets both the switch and
`RELEASED_STATE` there, runs the whole suite in the copy with Bun's JUnit report, and
expects no failing test and every test file run.
Every command uses the stage's own profile (`tabot-production`); the deploy prints the next
step each time.

0. Before: the stage is deployed with the API bucket, `API_BUCKET` is set, and the latest
   run of the `runs` workflow passed "Check that the API bucket holds the data API's
   files" in its `publish` job ("The data API", "The API bucket"), so what goes public is
   the current, checked tree. **And a stale or failed publish reaches the maintainer by a
   route that has been tested.** The route exists: the alarm ("The Runs repository, the
   Method and the page", "The alarm", "The data API's publishing") reads the API bucket in
   every run's first job and opens, or comments on, the alarm issue when its table of
   contents is more than 14 hours old, when it holds none, or when it cannot be read, and,
   once the state leaves `off`, when `API_BUCKET` is unset. Its
   tests cover each of those against a stand-in for S3, and the issue clearing itself when
   publishing recovers. Each time it writes on the issue it also sends the maintainer one
   Telegram message, where the maintainer looks first ("The alarm", "A Telegram message");
   its tests use a stand-in for Telegram. What no test can show is that the message reaches
   the maintainer's phone (GitHub's own notification of the issue goes to those who watch
   the repository, by web, email or mobile as their settings say, and arrives among many
   others). Confirm it once, by hand, with the drill, which touches nothing
   shared: no variable changes, nothing the alarm reads back changes, and publishing goes on
   as on any run.
   1. Start the workflow by hand with the drill: Actions, `runs`, "Run workflow", tick
      "Drill the alarm" (the input `alarm_drill`), or
      `gh workflow run runs.yml --repo smrdotgg/ledgermath -f alarm_drill=true`. Its alarm
      runs as on any run, then posts one comment on the alarm issue, or opens the issue
      with it if none is open, beginning "**This is a drill**" and linking the run, and
      then sends one Telegram message beginning "LedgerMath alarm drill" (or "And a drill",
      after a line saying what the alarm's own pass posted), with the issue's and the run's
      addresses.
   2. See the Telegram message arrive: that is the one the maintainer confirms. If it does
      not, the alarm step's log and summary say why, in a warning ("The alarm's Telegram
      message was not sent: …") or a notice (the secrets unset).
   3. If the drill opened the issue, close it when it reports nothing else (no stale
      Series, price file or bucket); an issue already open stays as the alarm left it.

   Until that is done, the state does not leave `off`: while the API is private a stale
   bucket harms no reader, but once it is served, publishing that has stopped leaves
   readers an old tree, and the alarm is what says so.
1. Set `state: "dark"` and `RELEASED_STATE` to `"dark"`, merge, `bunx sst
   diff --stage production-runs`, then deploy that stage. It makes, and changes nothing
   else:
   - the web ACL `ledgermath-production-runs-public-api`, scope `CLOUDFRONT`, in us-east-1
     (the provider's resources take a `region` since `@pulumi/aws` 7, so no second
     provider): default allow, the two managed groups, the per-address limit, the total
     limit;
   - the Origin Access Control `ledgermath-production-runs-public-api` (S3, always sign,
     SigV4), for both origins;
   - the CloudFront Functions `ledgermath-production-runs-request`,
     `ledgermath-production-runs-evidence-response` and `ledgermath-production-runs-no-route`
     (`cloudfront-js-2.0`, published);
   - the certificate for `api.ledgermath.com` in ACM, us-east-1, and the CNAME record that
     validates it, in the hosted zone `Z03039811C7UWLHZE7CZQ` (whose `CAA 0 issue
     "amazon.com"` lets Amazon issue it); the deploy waits until ACM has issued it;
   - the distribution, **disabled**, under `api.ledgermath.com` with that certificate: it
     serves nothing, so it has no traffic to bill; every behaviour has the 404 function,
     and neither bucket policy is touched;
   - the `A` and `AAAA` alias records `api.ledgermath.com` to the distribution, in the
     same zone;
   - the Free plan subscription, `AWS::PricingPlanManager::Subscription` in us-east-1,
     through Cloud Control (`aws.cloudcontrol.Resource`: the installed provider, 7.20.0,
     has no resource of its own for it). A Free plan activates at once;
   - the watch.
2. Check: `aws pricing-plan-manager list-subscriptions --region us-east-1 --profile
   tabot-production` lists the plan, tier `FREE`, status `ACTIVE`, with the distribution
   (`publicApi.distributionArn`) and the web ACL; `aws acm describe-certificate --region
   us-east-1 --profile tabot-production --certificate-arn <publicApi.certificateArn>`
   says `ISSUED`; `aws cloudfront get-distribution --profile tabot-production --id
   <publicApi.distributionId>` says `Enabled` false, `Status` `Deployed`, alias
   `api.ledgermath.com`; `aws route53 list-resource-record-sets --profile tabot-production
   --hosted-zone-id Z03039811C7UWLHZE7CZQ` lists the `A` and `AAAA` alias records of
   `api.ledgermath.com`, pointing at the distribution's `*.cloudfront.net` name. `dig +short
   api.ledgermath.com` gives nothing while the distribution is disabled, although the
   records are there (seen on 2026-11-24): CloudFront's addresses come only once it is
   enabled (step 4, or 3). On 2026-11-24 it gave three addresses a minute after the deploy
   of `on`.
3. Only if step 1 failed because AWS refused to subscribe a disabled distribution: set
   `state: "closed"` (and `RELEASED_STATE`), merge, deploy (the distribution is enabled, answering 404 to
   everything; with `plan: "code"` this deploy creates the subscription), and check the
   plan as in step 2 before the watch's 60 minutes are up.
4. Set `state: "on"` and `RELEASED_STATE` to `"on"`, merge, deploy. Before it
   changes anything the deploy checks that an ACTIVE plan covers the distribution, and
   stops if not; it checks once, so a plan cancelled after that is left to the watch. The
   distribution is enabled (or stays so), the request function takes the 404 function's
   place on the four served behaviours, and both bucket policies get their grant; it takes
   a few minutes to reach every edge (the update took 170 seconds on 2026-11-24).
5. Check, from anywhere, with no credentials. Two of the headers come only when the request
   is made as a browser makes it, so two of the commands ask that way:
   - `curl -sSI https://api.ledgermath.com/v1/index.json`: 200, `content-type:
     application/json`, `cache-control: public, max-age=300`, an `etag`,
     `x-content-type-options: nosniff`;
   - `curl -sSI -H 'Origin: https://example.com' https://api.ledgermath.com/v1/index.json`:
     the same, and `access-control-allow-origin: *`. The managed policy sends that header
     only to a request that carries `Origin`, as a browser's `fetch()` from another site
     does; without one it is absent, and that is not a fault;
   - `curl -sS -o /dev/null -D - -H 'accept-encoding: gzip'
     https://api.ledgermath.com/v1/index.json`: `content-encoding: gzip`, a weak `etag`
     (`W/"…"`) and `vary: Accept-Encoding`. This is a `GET` that throws the body away and
     prints the headers, not a `HEAD`: a `HEAD` gets no body, so CloudFront compresses
     nothing for it, and shows these headers only once a compressed copy is already in the
     edge's cache. The first `curl -sSI` with that header showed neither;
   - the first command for a Series file, and for a month file whose `sha256` (from its
     Series file's `months`) is that of `curl -sS <its url> | sha256sum`;
   - `curl -sSI` of a point's `evidence` and its `boot_summary`: 200, `content-type:
     application/json`, `cache-control: public, max-age=31536000, immutable`,
     `x-content-type-options: nosniff`, and `access-control-allow-origin: *` (the
     function adds it, `Origin` or not); of
     `https://api.ledgermath.com/blobs/sha256/<hex>` for a blob a Run file names: 200, the
     same `cache-control`, `content-type: binary/octet-stream`, no `content-encoding`;
   - 404 for `/`, `/source/<commit>.tar.gz` and `/logs/…` (any key: the default
     behaviour's function answers before a bucket is asked), and for `/v1/nothing.json`
     and `/runs/<a Run file's path>.bak` (from the request function: no served shape); 403
     from S3 for `/v1/series/000000000000.json` (a served shape, no object); 403 for
     `http://api.ledgermath.com/`;
   - 403 for `curl -sSI https://<publicApi.domainName>/v1/index.json`, the distribution's
     own name, and for `curl -sSI -H 'host: example.org' https://api.ledgermath.com/v1/index.json`
     (CloudFront may refuse the second itself, as no alternate name matches it);
   - `curl -sSI -X OPTIONS https://api.ledgermath.com/v1/index.json` and the same with
     `-X POST`: 403.

With `plan: "console"` the deploy makes no subscription and prints the console steps
instead, to take after step 1 (or 3): in the CloudFront console, signed in to the stage's
account, open the distribution whose description starts "LedgerMath production-runs
public API" (`publicApi.distributionId`), choose its pricing plan, pick Free, confirm
(its web ACL is already associated), and wait for it to show as active; or `aws
pricing-plan-manager create-subscription --region us-east-1 --profile tabot-production
--plan-family CloudFront --plan-tier FREE --resource-arns <publicApi.distributionArn>
<publicApi.webAclArn>`. Use it if Cloud Control cannot create the subscription.

Until the plan is attached the web ACL is billed as usual: by the hour ($5 a month and $1 a
rule), and for each request it inspects. With the distribution disabled that is cents, for
the minutes between the distribution and the subscription the same deploy makes. `closed`
is different: it enables the distribution before the plan is attached, so until then
public edge traffic is billed at pay-as-you-go rates, although nothing is served and S3 is
never reached. Every request that finds the address is inspected by the web ACL, which is
billed even when it blocks the request, and each one it lets through is a CloudFront
request, a function invocation (the 404) and the bytes of the answer. The address is not
published, so few should find it, but nothing limits them: the rate limits refuse
requests, and a refused request is still inspected. The watch disables a `closed`
distribution still uncovered once its 60 minutes are up, by its next run and with
propagation after that, if CloudFront answers it (above); there is no fixed maximum for
what that window costs.

**Seen on the first deploy, 2026-11-24.** `bunx sst deploy --stage production-runs` of
`dark` (`a2b2b68`) made everything but the Free plan subscription, and a throwaway web ACL
and disabled distribution in the development account, tried by hand with the AWS CLI,
showed why and what the plan takes. Seen:

- **The program, run by SST, reads the stage's state where the guard expects it.** `sst
  diff` and `sst deploy` ran the guard with no complaint; it read the stage's state and
  reported that no distribution was deployed before the deploy.
- **ACM issued the certificate by the record in the delegated zone**, inside the deploy.
- **The deploy made the rest**: the distribution, disabled, `Deployed`, with the comment
  `state=dark plan=code`; the web ACL with its four rules; the three functions; the Origin
  Access Control; the `A` and `AAAA` alias records. Nothing was public.
- **The Free plan gates WAF's features, and the total rule's first scope-down was one it
  refuses.** The subscription failed: `InvalidRequest: ... The following resources are not
  eligible for this subscription tier:` the web ACL. On a web ACL already on the plan, in
  the development account, WAF refused the total rule as built, a byte match on the URI
  path, with `WAFFeatureNotIncludedInPricingPlanException`, `DisallowedFeatures`: "String
  match statement", `RequiredPricingPlan` `PRO`; a size constraint was refused the same way
  ("Size constraint statement", `PRO`). It accepted the rate-based rule itself, its
  `CONSTANT` aggregation included, with a scope-down of geographic matches: the total rule
  as it is now. With it the web ACL held all four rules, 231 capacity units, and the plan
  stayed `ACTIVE`, so the plan counts each managed group as one of its 5 rules. AWS's own
  table (CloudFront Developer Guide, "flat-rate pricing plans") lists for Free 5 WAF rules
  and "IP-based rate limiting", for Pro header-based filtering, custom responses and WAF
  logs, and for Business regular expressions, challenges and Bot Control; it does not list
  string matches, which is why the first version was thought to be allowed. How it was
  tried, and how to try a new kind of statement before a rule uses it: in the development
  account, make a web ACL (scope `CLOUDFRONT`, us-east-1) and a disabled distribution that
  names it, subscribe the two (`aws pricing-plan-manager create-subscription --region
  us-east-1 --plan-family CloudFront --plan-tier FREE --resource-arns <distribution> <web
  ACL>`), then `aws wafv2 update-web-acl` it with the rule: WAF either takes it or names
  each feature the plan disallows and the plan it needs. Afterwards, cancel the
  subscription and delete both.
- **AWS subscribes a disabled distribution to the Free plan.** `aws pricing-plan-manager
  create-subscription --plan-family CloudFront --plan-tier FREE` succeeded for a disabled,
  `Deployed` distribution whose web ACL had the two managed groups and the per-address
  limit: `SYNC_IN_PROGRESS`, then `ACTIVE` within half a minute. So `closed` is not needed
  for that reason.
- **`dig +short api.ledgermath.com` gives nothing while the distribution is disabled**,
  although the alias records are in the zone and point at it (step 2).

**Seen when it was turned on, 2026-11-24.** `dark` was deployed again at 17:42 UTC
(`8c6923a`, #86), with the total rule's new scope-down, and `on` at 17:51 UTC (`d38e76d`,
#85). The data API has been public at `https://api.ledgermath.com` since then. Seen:

- **Cloud Control creates the subscription.** With the web ACL eligible, the deploy of
  `dark` created `PublicApiFreePlan` (`aws:cloudcontrol:Resource`,
  `AWS::PricingPlanManager::Subscription`) in 33 seconds. `aws pricing-plan-manager
  list-subscriptions` showed it tier `FREE`, status `ACTIVE`, covering the distribution and
  the web ACL.
- **The Free plan takes the distribution as built**: two origins, five behaviours, the
  alternate name `api.ledgermath.com`, the managed response-headers policy and the Origin
  Access Control. Nothing had to be dropped.
- **The deploy of `on`.** The guard saw the plan `ACTIVE` and allowed it. The
  distribution's update took 170 seconds. Each bucket's policy got one statement, `Sid`
  `PublicApiThroughCloudFront`: `s3:GetObject` for `cloudfront.amazonaws.com`, with
  `AWS:SourceArn` this distribution, on `v1/*` in the API bucket and on `runs/*`, `boots/*`
  and `blobs/sha256/*` in the Runs bucket.
- **The watch runs every five minutes.** While `dark`, it logged no action, "the
  distribution is disabled (Deployed)". After `on`, no action, "the FREE plan ... is
  ACTIVE".
- **The name resolves once the distribution is enabled.** `dig +short api.ledgermath.com`
  gave three addresses a minute after the deploy of `on`, and nothing while the
  distribution was disabled.
- **Step 5's checks pass from outside, with no credentials**: every answer and header the
  step lists. So the functions, the grants and the one host work at CloudFront's edges as
  the tests say they do. Two headers came only when asked as a browser asks, and step 5's
  commands were corrected for them: `access-control-allow-origin: *` comes from the managed
  policy only to a request that carries `Origin`; and `content-encoding: gzip`, with a weak
  `etag` and `vary: Accept-Encoding`, comes to a `GET` with `accept-encoding: gzip`, while
  the first `curl -sSI` with that header showed neither.
- **The Runs bucket answers CORS itself.** A Run file asked for with an `Origin` header
  came, on a miss at the edge, with S3's own `access-control-allow-methods: POST, GET,
  HEAD, DELETE, PUT`, `access-control-expose-headers: ETag` and `access-control-max-age:
  0`, from the Runs bucket's CORS configuration (SST's default for a bucket; the API bucket
  has none). A copy the edge had cached from a request without `Origin` came without them.
  They change nothing that is served: the distribution still takes only `GET` and `HEAD`.

**Not verified yet.** That CloudFront runs the viewer-response function for a `304` too,
so a revalidated Run file keeps its `cache-control` (AWS documents only that it does not
for 400 and above); that `cloudfront:UpdateDistribution` alone lets the watch disable a
distribution with a web ACL (the Service Authorization Reference lists no other dependency
for it); the rest of the watch's behaviour against AWS, since it has had nothing to
disable: its tag, its retries, its disabling; whether an ordinary update of the
distribution's configuration, such as the deploy of `on` itself, moves its subscription
out of `ACTIVE` for a while (AWS documents `SYNC_IN_PROGRESS` for changes to the
subscription, not to the distribution; the watch's first run after the deploy of `on`
found the plan `ACTIVE`, which shows it was not out of it then, not that it never leaves
it; if an update does it, the watch disables a distribution it finds in that state, and it
takes a `dark` deploy to recover); the rate limits under real load; and the plan under
real traffic: its emails at 50%, 80% and 100%, and what AWS does when the allowance is
exceeded.

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
update-subscription --region us-east-1 --profile tabot-production --arn <publicApi.plan>
--if-match <eTag from get-subscription> --plan-tier PRO`; then, once the plan is `ACTIVE`,
deploy `on`. Leave `subscriptionState` in `infra/runs/public-blobs.ts` as it is:
CloudFormation's subscription refuses to change a tier itself, and a deploy touches the
subscription only when its desired state changes, so the upgrade stays. (Whether it would
accept a desired tier equal to the one AWS already has is not verified.) The deploy and
the watch accept any ACTIVE tier. With Pro, consider raising the total limit with the
allowance.

**The name and its TLS.** `api.ledgermath.com` is the distribution's one alternate name,
with a certificate the stage makes in ACM (us-east-1, where CloudFront takes certificates
from), validated by a record in the hosted zone the subdomain is delegated to,
`Z03039811C7UWLHZE7CZQ` in the production account; the parent domain's DNS, at Vercel, is
not touched. The TLS policy is `TLSv1.2_2025`, the newest that still speaks TLS 1.2 to
clients without 1.3. The distribution's own `*.cloudfront.net` name (the stage output
`publicApi.domainName`) still reaches it, as every distribution's does, and gets 403 from
the request function: the API has one host.

**Turning it off.** Set `state: "dark"`, merge, deploy: the distribution is disabled, both
grants removed, the plan, the certificate and the records kept, and Pulumi's protection
lifted. The grants and the distribution are changed independently, and edges keep serving
with the old configuration, cached files included, until the disabled one reaches them.
Check it with `aws cloudfront get-distribution` (`Enabled` false, `Status` `Deployed`) and
`curl -sSI https://api.ledgermath.com/v1/index.json` (no longer 200). That is enough to
stop serving. Only then, if everything should go, set `state: "off"`, merge, deploy: it
deletes the subscription first (a Free plan is cancelled at once; AWS refuses to delete a
distribution that is on a plan), then the distribution, the web ACL, the functions, the
access control, the alias records, the certificate and its validation record; the
hosted zone and its `CAA` record stay, since the stage did not make them. While on a plan
the web ACL cannot be replaced, so do not rename it. The API bucket and its upload are
not behind the switch and go on; to stop the upload as well, unset the repository variable
`API_BUCKET`.

**The Free plan's limits, here and later.** Three Free plans per account: one is used
here, in the production account. 5 cache behaviours (all 5 used), 5 WAF rules (4 used), one
apex domain, no access logs, so no record of who downloaded what beyond the console's usage
figures and the WAF metrics. Only managed cache and response-headers policies; CloudFront
Functions are in. Nothing here uses a feature a plan refuses (no Origin Access Identity,
legacy `ForwardedValues`, real-time logs, Lambda@Edge, continuous deployment, customer rule
groups). A sixth path, or a website on this host, does not fit the Free plan's five
behaviours: it needs Pro (10) or a second distribution on a second Free plan, which would
also keep its traffic out of this one's allowance and limits.

**What became of public blobs.** The design this grew from (2026-11-14, dev log) served
`/blobs/sha256/<hex>` alone, at the distribution's `*.cloudfront.net` name, from the Runs
bucket. *Kept:* the Free flat-rate plan, so the bill never depends on what strangers
download; the states `off`, `dark`, `closed` and `on` and the order between them; the guard
that reads what is deployed and judges each deploy (`public-blobs-guard.ts`); the watch;
the web ACL's two managed groups and per-address limit; Origin Access Control and private
buckets with their grants only in `on`; managed policies only; the evidence's immutable
headers and CSP sandbox from a viewer-response function; the reader of blobs at a public
address (`--blobs-url`). *Changed:* the setting is `PUBLIC_API` (`PUBLIC_BLOBS` before),
and naming another stage than `production-runs`, in any state, now stops every deploy
instead of being ignored; it serves four prefixes from two buckets, not one; the total limit counts every
request, not `/blobs/` alone; JSON is compressed for readers that ask; the distribution's
comment, by which the guard and the watch recognise it, says `public API
(api.ledgermath.com)`; every resource's name says `PublicApi`, and AWS names
`public-api` (nothing of the design before was ever deployed: on 2026-11-19 the production
account held no distribution, web ACL or certificate). *Replaced:* the optional `domain`
setting (a name and an existing certificate's ARN) by the certificate, its validation
record and the alias records the stage makes for `api.ledgermath.com`; the blob request
function, which answered 404 to any address under `/blobs/sha256/` that was not a hash, by
the request function, which does the same for every served prefix, from `SERVED`'s
shapes, and refuses any other host.

## The Runs repository, the Method and the page

Step 3 (#39). The Run files and boot summaries are copied, byte for byte and under the
same paths, into the public repository `smrdotgg/ledgermath-runs`; blobs stay in the
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
STAGE=production-runs                                      # the scheduled stage; smr-runs before 2026-11-19
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
# At most 16 reads from the bucket at once; one that fails for a reason that may pass (no
# answer, a throttling or 5xx answer, one the client cannot read) is made again, up to 8
# tries with a growing pause, each logged with the client's code; S3's code for a refusal
# (AccessDenied, ExpiredToken…) is never tried again. A cached blob whose bytes do not have
# its hash is fetched again and put in its place. With empty --cache and
# --records (a cold rebuild): 11,758 streams and 25,574 dump blobs in under two minutes
# from inside AWS on 2026-11-27.
with_keys bun scripts/derive.ts --runs /tmp/ledgermath-runs --bucket "$BUCKET" --cache /tmp/blob-cache \
  --records /tmp/records --out /tmp/page/derivations.json --requests-out /tmp/page/requests-derivations.json

# The page.
bun scripts/build-page.ts /tmp/page/derivations.json /tmp/page/index.html --requests /tmp/page/requests-derivations.json

# The alarm, posting nothing and sending no Telegram message (it prints both instead); --now
# sets the clock, --copy says whether the copy job worked, --schedule-changed-at says when
# main last changed schedule.json, --prices-since when the prices workflow first existed on main.
bun scripts/alarm.ts --runs /tmp/ledgermath-runs --copy succeeded --dry-run --now 2026-11-13T00:00:00Z \
  --schedule-changed-at "$(git log -1 --first-parent --format=%cI origin/main -- schedule.json)" \
  --prices-since "$(git log --first-parent --reverse --format=%cI origin/main -- .github/workflows/prices.yml | sed -n 1p)"

# The same, also reading the API bucket (one GET of v1/index.json), with the keys in a subshell.
(eval "$(aws configure export-credentials --profile tabot-production --format env)" && bun scripts/alarm.ts \
  --runs /tmp/ledgermath-runs --copy succeeded --dry-run --schedule-changed-at 2026-10-01T00:00:00Z \
  --api-bucket "$(gh variable get API_BUCKET --repo smrdotgg/ledgermath)")
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

`.github/workflows/runs.yml` runs at 00:05, 06:05, 12:05 and 18:05 UTC, once after each
round of boots, and by hand (`workflow_dispatch`), its first job one at a time (the job
holds the concurrency group `runs`, which `prices.yml` holds too). **The times.** Rounds
start at 04:10, 10:10, 16:10 and 22:10, with a box every ten minutes to :50. A launch more
than ten minutes late is refused, and the reaper, every five minutes, asks EC2 to end any
box older than 50 minutes, so by those limits a round's last box has ended by HH+1:55; the
run is scheduled ten minutes after that, and four hours before the next round.
`tests/runs-workflow.test.ts` holds the crons to `schedule.json` and those limits (ADR-0035).
(Until 2026-11-25 a run at 22:40 also cut the 22:10 round while its last boxes were still
running, and the tree showed it with only the boots that had ended.) What this does not
promise: a tree can still hold part of a round when a run starts during one (one started
by hand, or a scheduled run that GitHub starts, or that waits for its runner, more than
four hours late), or when a box outlives those limits (the reaper asks for a box to be
ended and does not confirm that it was). The API's own words allow for that: a month file
changes when a Run or a missing boot summary arrives late. GitHub often starts a scheduled
run late (7 to 15 minutes at the top of the hour on 2026-11-24); a late start of under four
hours cuts the same round, later. It checks out this
repository with its whole history (for the alarm's `--schedule-changed-at`), takes AWS
credentials through OIDC, checks out `smrdotgg/ledgermath-runs` with the deploy key,
runs the copy job, commits and pushes what it added, runs both Methods, builds the page,
uploads the page and both files of Derivations as the artifact `page`, builds and checks
the data API's files and keeps them for a week as the artifact `api` (section "The data
API"; to compare them with the tree an earlier run checked and kept, its token may read
Actions), and runs the alarm with the workflow's own token. That is its first job, `runs`,
which does not publish: its alarm only reads, with one `GET`, when the API bucket's table of
contents was last written ("The alarm", below), and whatever S3 answers is reported, never a
failure of the job. A second job, `publish`, runs after it, only when it
succeeded and `API_BUCKET` is set, and puts the checked tree into the API bucket ("The data
API", "The API bucket"); its failure is its own and changes nothing of the first job's
(its caches, its artifacts, the next run's baseline). It holds its own group, `api-bucket`,
not `runs`, so the shared lock is held exactly as long as before it existed. A third job,
`site`, runs after `publish`, only when it succeeded and only on main: inside the production
deploys' concurrency group, it reads the tree from the API bucket itself, with the same role
(only reading), builds the website from exactly those bytes, checks it, deploys it to Vercel
production and checks the live pages, so ledgermath.com shows what the public API holds ("The
website", "Where it is deployed"). Each Method runs on its own: when one fails, `derive.ts`
still writes the other's Derivations and, in place of the failed one's, a note saying why
(`page/<name>.failed.json`); the page is built from what there is and says which part is
missing and why, the artifact is kept, and the run still ends as failed. Between runs it keeps, in GitHub's cache, the dump blobs it
fetched and each stream's reduced record per Method (`.cache/records`), never the stdout
blobs: a stream is fetched only for a Run no Method has a record of yet, about 2 MB of
records a day where the stdout blobs were about 44 MB. The cache is restored before the
derive step and saved right after it, however that step ended (succeeded, failed, or cut
off by the job's time limit or a cancellation), under the key of the run's attempt: every
blob and record is written whole as it is made, so a cold rebuild stopped part way is taken
up by the next run where it stopped, not begun again (#77). The derive step has 40 of the
job's 60 minutes, so one that runs long is stopped with time left for the save, which
`always()` runs after a stopped step but not once the job is out of time. A blob in a
restored cache that does not have the hash it is named by (a cache restored only in part)
is fetched again from the bucket and put in its place, so a damaged cache costs a fetch,
never a run. Until 2026-11-27 the cache was
saved only when the whole job succeeded, and two runs in a row that failed while reading
every stream again (a schema's words had changed the records' keys, which they no longer
do: `methods/README.md`, "The reduced record of a stream") each started from nothing. A
read from the bucket that fails for a reason that may pass is made again, up to 8 tries
(`scripts/derive.ts --bucket`); those two failed on the first such read. The alarm runs even when an earlier
step failed, as long as the Runs repository was checked out, and is told whether the copy
and its push succeeded on this pass.

It needs:

| Where | Name | What it holds |
|-------|------|---------------|
| Variable | `RUNS_AWS_ROLE_ARN` | The scheduled stage's output `runsReaderRole` (`jq -r .runsReaderRole .sst/outputs.<stage>.json` after a deploy) |
| Variable | `RUNS_BUCKET` | The scheduled stage's output `bucket`, the bucket's name |
| Variable | `API_BUCKET` | The scheduled stage's output `apiBucket`, once the stage is deployed with it; while unset, the `publish` job is skipped, nothing is uploaded and the alarm does not read the bucket ("The data API", "The API bucket") |
| Secret | `RUNS_REPO_DEPLOY_KEY` | The private half of an SSH key whose public half is a deploy key of `smrdotgg/ledgermath-runs` **with write access** (it pushes) |
| Secret | `TELEGRAM_BOT_TOKEN` | The token of the Telegram bot the alarm's message comes from ("The alarm", "A Telegram message") |
| Secret | `TELEGRAM_CHAT_ID` | The maintainer's chat with that bot; while either secret is unset, no message is sent and nothing fails |
| Secret | `VERCEL_TOKEN` | For the `site` job's deploy step alone: the Vercel token `site.yml` uses ("Where it is deployed") |
| Variable | `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | The same two IDs `site.yml` uses, also for that one step |

For the key: `ssh-keygen -t ed25519 -N '' -C ledgermath-runs-copy -f runs-deploy-key`,
add `runs-deploy-key.pub` under the Runs repository's Settings → Deploy keys with
"Allow write access", put the contents of `runs-deploy-key` in the secret, and delete
both files. For its issue, the alarm needs nothing more: the workflow asks for
`issues: write`. For its Telegram message, the two Telegram secrets, set in the
repository's Settings → Secrets and variables → Actions.

The role comes with the stage. A deploy of a `-runs` stage creates GitHub's OIDC provider
for `token.actions.githubusercontent.com` in its account (audience `sts.amazonaws.com`; an
account holds one per URL, so only one `-runs` stage per account can create it:
`production-runs` in the production account, `smr-runs` in the development account) and
the role `RunsReaderRole`, which only workflows of `smrdotgg/ledgermath` on
`refs/heads/main` can assume and which may list the bucket and read `runs/*`, `boots/*` and
`blobs/*` (`infra/runs/github-role.ts`), and list the API bucket and read and write its
`v1/*` (`RunsApiUploadPolicy`, `infra/runs/api-bucket.ts`), nothing else. A workflow
started from another branch cannot assume it. The variables name the scheduled stage's;
the other stage's role stays, unused.

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

**Every post fits GitHub's limit.** GitHub refuses an issue or comment body over 65,536
characters, and the whole post with it: with every watched Series stale (187 today, with
their Run links), the post on `main` was 87,890 characters, so the alarm's most important
case would have posted nothing. Every body the alarm posts (a new issue, a comment, a
recovery, a drill) is now built under 60,000 characters (`MAX_BODY_CHARS`), the hidden
marker included. The summary and its counts, the copy job's warning, the price finding and
the bucket finding are always there; the stale Series are listed, in sorted order, as many
as fit, then one line says how many more are not shown, that the run's log lists every one
and that its step summary lists them up to its size limit (900 KB of the summary's 1 MiB:
thousands of Series). The marker carries the number of stale Series and a hash of the JSON of
the whole sorted set rather than the list, so it stays a few hundred characters: the same set
gives the same hash, so a repeat pass stays quiet, and any change to the set, shown or not,
changes it. Posts written before, whose marker listed the Series, read as the same state. A
body over the limit is refused before it is sent, and a post GitHub refuses (a 422) fails the
alarm loudly and is not sent again. Tests: 141, 187 and 1,000 stale Series, with and without
the bucket and price findings. The alarm's own writes to the step summary (the list, a drill
that could not post) are given two seconds each and then abandoned, and the alarm exits
explicitly with its verdict's code, so a summary that cannot be written never holds the job.
An issue names no bucket: the bucket's name is only in the log and the step summary.

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

**The data API's publishing.** With `API_BUCKET` set (the workflow passes it as
`--api-bucket`), the same issue says when publishing has stopped
(`scripts/lib/api-freshness.ts`). It judges by what the API bucket holds, never by any
job's conclusion, so every way publishing can stop looks the same: the `publish` job
failed, was skipped (its first job failed, or the variable was unset at the time) or
cancelled, never ran, or its preflight refused the bucket. In each, the table of contents,
`v1/index.json`, is not written again.

- **The evidence is that object's `Last-Modified`.** S3 sets it, from its own clock, as the
  object is written, and no writer can set it; the upload writes `v1/index.json` only as its
  last act, after every phase (in the last phase when it changed, otherwise as the stamp),
  so it moves on every upload of a new run that succeeded and on nothing else the workflow
  does. The two other things there could lie, so they decide nothing: the run the object's
  metadata records is whatever the uploader passed ("A run recorded too high"), and the
  tree's own `newest_run_started_at` says when the newest Run started, which stands still
  when the boxes do, however well publishing works. The run is named in the alarm's words,
  linked, as a lead. `Last-Modified` moves without the workflow only when a person writes the
  object with their own credentials (an upload by hand, the `copy-object` of "A run recorded
  too high").
- **The rule is age, and nothing else.** The alarm is raised by the first check made more
  than 14 hours after the last successful publish, that is, when `v1/index.json` was last
  written more than 14 hours before the check runs (`MAX_PUBLISH_AGE_MS`); it is clear
  otherwise. Its inputs are that `Last-Modified` and the time of the check: no schedule, no
  run attempt, no start time, so a re-run of an old run, a run started by hand and a late
  run all judge alike, and none can clear a real alarm. What that means for the schedule,
  whose runs are 6 hours apart (00:05, 06:05, 12:05 and 18:05; a test holds the crons to at
  most 6 hours): after one failed publish, the next check comes at most 12 hours after the
  last publish, plus however late that run's alarm step runs after its slot, so it stays
  quiet when the alarm runs less than two hours after its slot (and may raise if it runs
  later: the 06:05 publish failing and the 12:05 run's alarm checking at 14:09 raises it).
  Two failed publishes in a row are raised by the next run's check, when every alarm runs
  less than two hours after its slot. Publishing that has stopped is raised by the first
  check made after 14 hours; with on-time runs, that is 18 hours after the last scheduled
  publish, by the third run after it, and later by however late that check runs. (Until
  2026-11-25 the runs were at 00:00, 06:00, 12:00, 18:00 and 22:40: stopped publishing was
  raised 16 h 40 m to 19 h 20 m after the last publish, and two failed runs either side of
  the short gap from 22:40 to 00:00 could pass unnoticed. ADR-0035.) Tests: ages either side
  of 14 hours; the real schedule over three days, each alarm checking up to three hours after
  its slot, every check raised exactly when it is more than 14 hours after the last publish;
  one failed publish with every alarm under two hours late (never raised); two failed in a
  row, each pair of a day, with every alarm under two hours late (raised by the next check,
  and only by it); publishing stopped after each run of a day with on-time runs (18 hours); a
  re-run of an old run, which gets the same result as any run at that moment; the first
  publish, 2026-11-21 01:49:48 UTC, fresh until 15:49:48.
- **A bucket with no table of contents, or one that cannot be read, is raised at once.**
  No `v1/index.json` means no publish has ever finished there: expected only between
  setting `API_BUCKET` to a new bucket and its first publish (the run after the change
  raises it, since its alarm comes before its own `publish` job, and the run after that says
  the data API is published), and otherwise a sign that the variable names another bucket.
  A bucket that cannot be read (the role refused, the bucket missing, no credentials, or a
  5xx or no answer three times) means whether publishing works cannot be told: the
  `publish` job reads it with the same role and the same variable. A single 5xx is tried
  again quietly, 1 and then 2 seconds later. The read is one `GET`, not a `HEAD`, because a
  `HEAD`'s 404 has no body to tell a missing key from a missing bucket; only its headers are
  used, and the body of a 200 is cancelled unread. Of an error's body at most the first
  2,048 bytes are read, for at most a second.
- **Nothing the check or S3 says in words reaches the issue.** The check reports one of a
  closed set of results: published (with the date and run), empty, refused (with the HTTP
  status), no credentials, server error (with the HTTP status), no answer, no date, or unset.
  The alarm validates it field by field and writes fixed sentences from it: "S3 refused the
  read (HTTP 403)", "the job had no AWS credentials to read it with", and so on. A check that
  gives no result is "the check of the API bucket failed" for one of four reasons, also in
  fixed words: it gave no result within 20 s and was stopped, it exited with code N, its
  output was not understood, it could not be started. What S3 or the check said goes to the
  job's log only. The repository is public, and an issue must not carry a mention, a link or
  anything shaped like a token from elsewhere; tests put a token's shape, a mention and a
  link in the check's output and in S3's error, and find none of it in any issue.
- **The check runs in a child process, with only what it needs, killed after 20 seconds.**
  The alarm starts `scripts/check-api-publishing.ts` before it reads the Runs repository, so
  the wait overlaps that work. The child's environment is `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `GITHUB_STEP_SUMMARY` and nothing else (not
  `GITHUB_TOKEN`; Bun needs no `PATH` or `HOME` to run it); the bucket, the time and
  `PUBLIC_API`'s state go as arguments, and the Region is `us-east-2`, in the code. It runs in
  a process group of its own, which the alarm kills with `SIGKILL` if it has not finished
  within 20 seconds, and, in any case, as soon as the child exits, so nothing it started can
  outlive it or hold its pipes open. The child writes its own line to the step summary; the
  alarm writes nothing on its behalf, so nothing the check meets (an answer that stalls, a
  step summary that blocks) holds up the alarm's own verdict for longer than the budget and
  two seconds' grace. Tests start children that sleep past the budget, ignore `SIGTERM` (and
  are found dead afterwards), start a grandchild that holds the pipes (found dead too), print
  garbage, exit non-zero, and the real check with a step summary that blocks; each time the
  stale-Series verdict is as without the check.
- **With `API_BUCKET` unset, nothing is raised while `PUBLIC_API` is `off`, and the alarm
  is raised in any other state**: unsetting the variable is how publishing is stopped on
  purpose while nothing is served ("The API bucket", "Setting it up"), but once serving is
  on (`dark`, `closed` or `on`), a missing bucket name means publishing has stopped. The
  bucket is not read either way, and the step summary says the variable is unset.
- **It speaks as the rest of the alarm does**: once when raised, again only when what it
  raises changes (a stale bucket is named by when it was last written, so it stays the same
  while the bucket only grows older), and once more, on the open issue, when the data API is
  published again.
- **A drill shows the route and touches nothing: exactly one notification on GitHub, and
  one Telegram message.** Started by
  hand with the input `alarm_drill` (Actions, `runs`, "Run workflow"), the alarm runs its
  ordinary pass and then posts one comment on the open alarm issue, saying it is a drill,
  with the run's link, and that nothing is wrong; with no issue open, it opens the alarm
  issue with those words as its body and posts no comment, since a second post would be a
  second notification. Then it sends one Telegram message saying the same (below, "A
  Telegram message"). It reads nothing, carries no state marker, and changes nothing the
  alarm reads back, so an open finding stays reported and the next pass writes as it would
  have. An issue opened only by a drill is closed by the maintainer. A drill that cannot post
  says so in the log and the step summary and does not fail the job, which exits as its
  verdict earned (the `publish` job runs only when the first job succeeded). The `publish`
  job never sees the input; a scheduled run has no inputs.

It reads with the first job's role, which may already list the API bucket and read its
`v1/*` (`RunsApiUploadPolicy`); the role gains nothing.

**A Telegram message** (ADR-0033). GitHub's own notifications (email, the phone app) arrive
among many others, and the maintainer looks at Telegram first. So whenever the alarm writes
on GitHub, it also sends the maintainer one plain-text Telegram message
(`scripts/lib/telegram.ts`, `pingText` and `pingSafely` in `scripts/alarm.ts`).

- **When.** The issue opened, a comment because something changed, the comment saying all
  is clear again, a drill; and when the alarm had something to post and it failed (after it
  tried to write, or with something stale), when the message matters most. The alarm then
  fails as before. A failed post is said as one of two things: **this run could not post an
  update** (GitHub refused it with a 4xx, even one whose body is cut off, or could not be
  reached or read), which claims nothing of what the issue already says; or **its post
  could not be confirmed**, because GitHub did not confirm the write (no answer, a 5xx, an
  answer cut short), since such a post may well be on the issue. The issue's address is in
  the message whenever the issue is known: noted as soon as it is found, before its
  comments are read, and kept for the drill. A pass that writes
  nothing sends nothing. One message per run, sent last, after every post: a run whose pass
  comments and which is also a drill sends one message saying both, and if only the drill's
  post fails, the message says so and the run still exits 0.
- **What it says.** Fixed words chosen by the code: which kind of post it was, the counts
  from the alarm's verdict ("3 of 187 watched Series stale"), whether the price files are
  stale, whether publishing is raised, whether the copy job failed, the issue's address
  (its number, accepted only as a positive whole number) and the run's (the fixed Actions
  address and `GITHUB_RUN_ID`, accepted only as a number). Nothing S3, the check's child or
  the environment said, the same rule as for the issue; no `parse_mode`. At most a few
  hundred characters, far under Telegram's limit of 4,096, by construction.
- **Sent from inside the alarm, in its own step.** Not by a workflow started by issue
  events: the alarm posts with the workflow's own token, and GitHub starts no workflow run
  for an event made with that token (GitHub's docs, "Triggering a workflow from a
  workflow"). One POST of the form fields `chat_id` and `text` to the Bot API's
  `sendMessage`, with Bun's `fetch`: no new dependency.
- **It never changes the alarm.** It comes after everything else and is given up after 15
  seconds (a second more as a backstop, then two for the step summary's line): the verdict,
  the posts, the marker and the exit code are those of a run without Telegram. A message
  not sent is a warning annotation and a line in the step summary, in fixed words: Telegram
  could not be reached, gave no whole answer within 15 s, answered HTTP N, its answer was
  not understood, or it did not accept the message. Never the request's address, which
  holds the token, and nothing of Telegram's answer but its HTTP status; no second try. The
  request is never traced by Bun (`verbose: false`), nor are the alarm's calls to GitHub, so
  setting `BUN_CONFIG_VERBOSE_FETCH` to diagnose delivery prints neither Telegram key nor
  GitHub's token (the check's child never has that variable). A Telegram outage never fails the step, so it
  never skips the `publish` job. With the secrets unset (a fork, or never set), a notice and
  nothing else.
- **The secrets stay in one place.** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are in the
  alarm step's own environment and nowhere else in any workflow, and `runs.yml` never runs
  for a pull request, so a stranger's pull request cannot reach them; the check's child
  does not get them. A test reads every file under `.github` and fails otherwise, judging a
  job's `secrets` by its parsed value, so `secrets: "inherit"` fails like `secrets: inherit`.
- **Tests**, against a stand-in for Telegram: each kind of post sends exactly one message
  with its words, a drill one that says so, a run that comments and drills one, a pass with
  no post none; a comment GitHub records and then cuts its answer short, and a whole 503
  (unconfirmed, with the issue's address); a comment refused on a known issue, with its body
  whole or cut off; the issue's comments, or the drill's lookup, failing to be read (the
  address kept); Telegram down, never
  sending its headers, stalling in its body, answering 401, 429, what is not JSON, or the
  word `timeout`: the same exit code, posts and marker as without Telegram, the token never
  in the log or the step summary, even with Bun's tracing on (nor GitHub's token); the secrets unset; nothing S3
  said in the message; the length bound. Stalls get a short deadline
  (`--telegram-budget-ms`, which the workflow never passes and which can only be shorter
  than 15 s), so the file runs in seconds.

The alarm runs in the same workflow, so a workflow that does not run at all, or a first
job that fails before the Runs repository is checked out (the alarm's condition), reports
nothing here and sends no Telegram message; GitHub's failed-run email is then the only
word.

## Moving the schedule to the production account

**Carried out, 2026-11-19.** The steps below were followed as written, and the move held
([issue #57](https://github.com/smrdotgg/ledgermath/issues/57) records each step's output):
steps 1 to 5 on 2026-11-18, 19:53 to 20:27 UTC; steps 6 to 12 on 2026-11-19, 12:33 to 13:07
UTC, in the gap from 12:30 to 15:00 UTC, with step 8's change merged as `0a704fb` (pull
request #65); step 13, the first production round at 16:10 UTC, checked from 17:30 to 17:41
UTC and passed. Step 14, going back, was not needed. Since then `production-runs` is the
scheduled stage and the workflow reads its bucket; `smr-runs` and its bucket are still there,
with no launch schedule. The procedure stays as the record of what was done and as the way to
move again or go back. Where carrying it out showed the text wrong or silent, it has been
corrected, with the date.

The boxes that boot on the schedule, the bucket their Runs and blobs go to, and what the
workflow reads move from the development account to the production account, in the same
Region and zone, from the same image, with the same instance types and schedule. The
development account keeps the dev machine, `smr-runs` for boxes by hand, and `smr-runs`'s
bucket as it is: it holds the Runs of the first days, all but the 35 of step 3's box,
which only the production bucket holds, and nothing under `runs/`, `blobs/`, `boots/` or
`logs/` is deleted (step 10's deploy, like every deploy of a new commit, deletes the
previous commit's `source/` archive: "Deploy").

### Why no Series starts a new group

A Series is its benchmark, params, build, instance type and zone ID, and Method series v1
splits it on the binary, the runner manifest, `samples`, the image and the dump sections
`cpuid`, `lscpu`, `sys_cpu`, `kernel`, `process` and `packages` (`methods/v1/facts.ts`).
None of them reads the account:

- The zone ID `use2-az3` is `us-east-2c` in both accounts, and the pinned image
  `ami-03499a87bbb39a09a` (Amazon's, public) is visible from the production account in
  us-east-2 (both checked, read-only, on 2026-11-14). The instance types, `schedule.json`,
  `runner/` and the benchmarks do not change, as long as `production-runs` is deployed from
  a commit whose `runner/`, `benchmarks/` and `schedule.json` are those the stage it takes
  over from runs (`smr-runs`, for the move of 2026-11-19); another commit there would start
  new groups by itself, for the commit and not the move.
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
A deploy of a new commit deletes the previous commit's `source/` archive, sometimes leaving
no marker; a redeploy of the same commit keeps it. Under the copied prefixes a deploy never
deletes or overwrites anything, and adds at most AWS-LC's archive and the three Fixture
blobs under `blobs/`, when one of them is new to the stage ("Deploy", above).

`scripts/copy-bucket.ts verify` reads both buckets and writes neither: every source object
under those prefixes must be at the destination with the same bytes (both read and compared,
and every blob's bytes hashed to its key), every Run file and boot summary of a checkout of
the Runs repository must be at the destination with the same bytes, and
`scripts/check-runs.ts` must pass on the destination's `blobs/`, `runs/` and `boots/`.
`--runs-repository` must be a checkout: a path without `runs/` and `boots/` directories is
refused before anything is read. The destination's objects are written into `--check-dir`,
which must be new or empty, with room for the bucket (about 650 MB on 2026-11-14, about
1.2 GB on 2026-11-18, and growing): it refuses a directory
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
reading every object twice and hashing every blob, as `verify` does, took 144 s. Those
figures are far too low now. On 2026-11-18 the development bucket held 78,572 objects
under those prefixes (1.21 GB); the first copy into production wrote 78,524 of them
(1,016.6 MB) in 7.7 minutes. On 2026-11-19 at 13:01 UTC a `verify` compared 86,550 source
objects, and at 17:38 UTC the production bucket held 89,526 files of Runs, blobs and boots.
`verify` took 480 s on 2026-11-18, then 590 s and 568 s on 2026-11-19. The copy
reads every object the destination holds that the source also lists, a blob at the
destination only and anything else at both ends (for a copy after the first, about the
whole bucket, and, blobs being most of its bytes, about half of what `verify` reads), and
makes four requests per object it writes (a HEAD and a GET at the source, the PUT and a
HEAD at the destination, and a GET more when an ETag is not the bytes' MD5). So expect 5 to
15 minutes for the first copy, and a few minutes for one that adds a day's objects; `verify` takes about 10 minutes, and
more as the bucket grows.

### The cutover

Rounds start at 04:10, 10:10, 16:10 and 22:10 UTC, with a box at :10, :20, :30, :40 and :50.
A scheduled launch is refused more than ten minutes after its time, and the reaper ends a box
at most 55 minutes after it started, so the last box of a round (`i4i.2xlarge`, launched at
:50 or up to ten minutes later) has ended by HH+1:55 at the latest. The `runs` workflow runs
ten minutes after that, at 00:05, 06:05, 12:05 and 18:05 (it ran at 00:00, 06:00, 12:00,
18:00 and 22:40 until 2026-11-25, when this was written). The cutover itself (steps 6 to 12)
happens in one gap between rounds: after the 06:05 workflow run has finished, so that the
Runs repository holds the 04:10 round, and before the 10:10 slot. No slot fires in it, so a
deploy made in it can neither lose a round nor start one twice, as long as each has finished
by its time in the table below. The gaps from 12:05 to 16:10 and from 18:05 to 22:10 serve as
well, with every time six or twelve hours later.

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

   When its log is in the bucket (16.5 minutes on 2026-11-18; the last command lists it),
   check what it left:

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
7. **Copy again and verify again**: `git -C /tmp/ledgermath-runs-verify pull` (the 06:05 run
   has added the round), `copy`, and `verify` with directories of its own, `--check-dir
   /tmp/prod-check-2 --source-check-dir /tmp/dev-source-2` (it refuses `/tmp/prod-check-1`
   and `/tmp/dev-source-1`, which hold the first verification's objects; remove those first
   if the disk is short). The copy adds what the development
   bucket gained since step 4. From here until step 10 the development bucket gains nothing
   more, because its next slot is 10:10. Changes: adds objects to the production bucket. If
   either fails, stop here: nothing else has changed.
8. **Make `production-runs` the scheduled stage**: first note main as it is, `git fetch
   origin && BEFORE=$(git rev-parse origin/main)`; it schedules `smr-runs`, and going back
   deploys from it (on 2026-11-19, `e22dd1d`). Then `SCHEDULED_STAGE = "production-runs"` in `infra/runs/stages.ts`,
   and the one line of `tests/runs-stages.test.ts` that pins it; `bun test`; a pull request,
   merged to main; pull main. Changes: the repository.
9. **Deploy `production-runs`** from main, **succeeded by 09:00**. Changes, in the production
   account: the five launch schedules (each with its role) and the launch function's list of
   targets; as every deploy of a new commit does ("Deploy"), a new
   `source/<commit>.tar.gz` that the launch function now points at, `BoxPolicy` updated to
   read it, and the previous `source/` key deleted; and, on 2026-11-19, the reaper function
   redeployed with unchanged code ("Deploy" says why it may be). Nothing fires before
   10:10. Check: the command of step 11, with `--profile tabot-production`, lists the five
   launch schedules and its reaper's. Four of the five are named
   `ledgerm-production-runs-BoxLaunch…`, the name cut short to fit AWS's limit of 64
   characters; only the `m5.large` one starts `ledgermath-production-runs-BoxLaunch`. A deploy that fails partway can leave some of the five
   schedules made and others not, and the list of targets changed or not; run it again, and
   it carries on from what is there. Until step 10, development keeps its schedules and
   every round.
10. **Deploy `smr-runs`** from main, **succeeded by 09:30**. Changes, in the development
    account: its five launch schedules and their roles are deleted, and its launch
    function's list of targets becomes `none (this stage is not the scheduled stage)`, so
    even a schedule that survived would launch nothing. As in step 9, a new source archive is
    uploaded and pointed at, `BoxPolicy` is updated to read it, the reaper was redeployed (on
    2026-11-19, with unchanged code), and the previous `source/` key is deleted: on 2026-11-19 that removed `source/50db33a….tar.gz` from the development bucket,
    every version and no delete marker, and no Run lost its source ("Deploy" says why). A
    deploy that fails partway can
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
    `--profile tabot-production` lists the five launch schedules (four
    `ledgerm-production-runs-BoxLaunch…` and one `ledgermath-production-runs-BoxLaunch…`, as
    in step 9) and its reaper's. Changes nothing.
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
    shows the boxes, the launch function's log has five `launched a ledgermath box` lines
    and no refusal, and the development account starts no box. The round's last
    box has ended by 11:55 at the latest; check that it has, rather than wait for a time:
    the same command with `Name=instance-state-name,Values=pending,running` added lists
    nothing, `aws s3 ls "s3://$PROD_BUCKET/boots/<yyyy>/<mm>/<dd>/" --profile tabot-production`
    holds the round's five boot summaries, and `check-runs.ts` on a sync of the bucket
    passes. The log group is not `/aws/lambda/<launchFunction>`: its name has a generated
    suffix of its own, so read it from the function:

    ```bash
    FN=$(jq -r .launchFunction .sst/outputs.production-runs.json)
    LOG_GROUP=$(aws lambda get-function-configuration --profile tabot-production --region us-east-2 \
      --function-name "$FN" --query LoggingConfig.LogGroup --output text)
    aws logs filter-log-events --profile tabot-production --region us-east-2 --log-group-name "$LOG_GROUP" \
      --start-time "$(date -d '2 hours ago' +%s)000" --filter-pattern '"launched a ledgermath box"' \
      --query 'events[].message' --output text
    ```

    `"refused"` as the pattern shows the refusals, of which there should be none. The first
    workflow run after that (normally the 12:05 one) copies, pushes and derives them; then, with its `page` artifact
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

    That reads only `derivations.json`: the Series of requests (`requests-derivations.json`)
    have no `differed` list, so it cannot see them. This second check works on both files.
    For each Series it compares the group of its last point before the cut with the groups
    of its points after it; it prints, per file, the number of Series and of those with a
    point at or after the cut, then a `CHANGED` line for every Series whose group changed,
    and should print only the summary lines, one per file and two in all (as it did on
    2026-11-19, with `CUT=2026-11-19T16:00:00Z`: `series: 187; with a point at or after the
    cut: 187` for `derivations.json` and `series: 25; with a point at or after the cut: 25`
    for `requests-derivations.json`, each Series with one new point and none changed):

    ```bash
    for f in derivations requests-derivations; do jq -r --arg cut "$CUT" '
      [.derivations[] | . as $d | ($d.points | sort_by(.started_at)) as $p
       | ($p | map(select(.started_at < $cut)) | last) as $before
       | ($p | map(select(.started_at >= $cut))) as $after
       | {id: $d.series.id, b: $d.series.benchmark, t: $d.series.instance_type, before: $before.group, after: ($after | map(.group) | unique), n: ($after|length)}]
      | "series: \(length); with a point at or after the cut: \(map(select(.n>0))|length)",
        (map(select(.n>0 and .before!=null and (.after != [.before])))[] | "CHANGED \(.id) \(.b) \(.t): \(.before) -> \(.after|join(","))")' /tmp/page/$f.json; done
    ```

    Changes nothing.
14. **Going back, if the production round fails** (no boxes, too few, Runs that do not
    check out): in the next gap, after the 12:05 workflow run, with the times of steps 9
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
commit anything but new files. It shares the concurrency group of `runs.yml`'s first job,
`runs` (a workflow's group and a job's of the same name are one lock: GitHub's groups are
the repository's, for jobs and workflow runs alike), so the two never run at once and
neither's push is refused because the other pushed after its checkout. `runs.yml`'s
`publish` job holds a group of its own, so it never keeps this workflow waiting. Its times are hours from `runs.yml`'s, because GitHub keeps at most one run of
a group waiting: a third run queued while one runs and one waits cancels the waiting one.

It needs only the secret `RUNS_REPO_DEPLOY_KEY`, which `runs.yml` already uses (above): a
deploy key of `smrdotgg/ledgermath-runs` with write access. No AWS credentials and no
variables. GitHub runs scheduled workflows from the default branch only, so it starts
once it is on `main`.

## The data API

Issue #64, ADR-0030. LedgerMath's numbers, for agents first, as a tree of small static JSON
files, each kind with a JSON schema. `scripts/build-api.ts` cuts it from the two files of
Derivations and the Runs repository's price files and boot summaries, laid out exactly as it will be served
from `https://api.ledgermath.com`. The `runs` workflow builds the
tree, checks it, against the tree the latest earlier run that checked its own kept too,
keeps it for a week as the artifact `api`, beside `page`, and, in a job of its own,
`publish`, uploads it to the stage's private API bucket ("The API bucket", below). The
serving is built and on, on the maintainer's go ("The public data API: CloudFront on
the Free plan at `api.ledgermath.com`", under "The daily box"): CloudFront serves the
bucket's tree there.

| Path | Holds |
|------|-------|
| `v1/index.json` | The table of contents: the list's address, each benchmark's list with its counts (`benchmarks`, as many as fit its budget), every price file held with the newest marked, the schemas, the docs, the templates of a blob's address, a Series file's (`series.series_file_url_template`) and a benchmark's list's (`benchmarks.benchmark_file_url_template`), `layout`, the number of the way the files are written, and `recent_rounds`, the newest 8 rounds of boots with their figures (below) |
| `v1/series.json` | One row per Series, each on a line of its own: what it is, how many Runs and on how many boots, its oldest and newest Run, a summary of each Method's Derivation under `derivations.<method>_v<version>`, and the `url` of its file. Above the rows, each Method's own words, with the Run files it could not read (`methods.<method>_v<version>.unreadable`) |
| `v1/benchmarks/<benchmark>.json` | One benchmark's rows of `v1/series.json`, each row byte for byte and in the same order in files of one update, as many as fit its budget, under a head like the list's (`count`, `newest_run_started_at`), with how many of its Series are in `v1/series.json` alone (`left_out`, below) |
| `v1/series/<id>.json` | One Series: its Runs and boots; each Method's summary at the Derivations' own paths (percentiles, groups and their facts and figures, each group with its `counted_runs`, `failed_runs` and the starts of its oldest and newest Run, section counts, `counted_runs`, `failed_runs`), with the Method's definitions; the points of its newest 12 Runs (`newest_points`; `newest_runs` says how many); and `months`, each month a Run of it started in, oldest first, with the month file's `url`, its Runs, its first and last start, and the month file's `sha256` and size in `bytes` |
| `v1/series/<id>/<yyyy-mm>.json` | One month of a Series: every point of the Runs that started that month (UTC), each Method's under its key, and series v1's `differed` entry for each pair of consecutive Runs whose later Run started that month. Every point gives its Run file's `sha256`, `evidence` (the Run file's address) and `boot_summary` (its boot's, or null when the Runs repository has none) |
| `v1/prices/<yyyy-mm-dd>.json` | That day's price file, byte for byte |
| `v1/schemas/<name>.schema.json` | `index`, `series-list`, `benchmark`, `series`, `series-month` (kept in `schemas/api/v1/`) and `prices`; and `events`, the schema of one line of a Run's stdout (`schemas/events.schema.json`), which describes no file of the tree but is what both Methods' definitions hold a Run's events to |

The evidence is linked, never copied: Run files, boot summaries and blobs, at the bucket's
own keys under the same address (`/runs/…`, `/boots/…`, `/blobs/sha256/<hex>`). The base
address is `--base`, so a private or test address can stand in.

- **A re-cut, not a Method.** Every number is a Derivation's, written exactly as the
  Derivation holds it, never rounded. The only figures added are taken from a Series'
  points: its Runs (in all, in each month and in each group), how many each Method counts
  and does not, the boots they name, its groups, and when its oldest and newest Run
  started (in all, in each month and in each group); each benchmark's count of Series and
  of their Runs and its newest Run, and how many Series are in no benchmark's list; and
  the counts of the newest rounds of boots, from the boot summaries and the points. A
  group's Runs and their starts are the Derivation's own list of the group's Runs (left out
  of the files, as recoverable), counted and looked up in its points; a Series' boots, the
  distinct boot ids its points hold.
- **Each benchmark's list of Series** (ADR-0030, rule 13): so that a reader finds one
  Series without fetching `v1/series.json` (197 KB for 187 Series on 2026-11-25, and
  growing). Each list, `v1/benchmarks/<benchmark>.json`, holds rows of `v1/series.json`, each
  row byte for byte the list's in files of one update (both schemas define a row word for
  word alike: `tests/api-months.test.ts`), in its order. **Files of different updates**: the
  upload writes the lists a phase before `v1/series.json` and two before the table of
  contents ("The API bucket", below), and a stopped upload leaves them so until one
  succeeds; on a rehearsal of two new Runs stopped after the lists, the reachable table of
  contents said 40 `memory_read` Series and 2,336 Runs while the list it links held 41 and
  2,337. As `months` gives the reader's rule for a month file and its Series file,
  `benchmarks.about` gives it for these, word for word in the schema `benchmark`: "The table
  of contents, a benchmark's list, the list of every Series and a Series' file are each
  whole, but fetched together they can be of different updates of the files: an update
  writes them one after another, a cache may hold one of them from before another changed,
  and an update that stopped part way leaves them so until the next one. Their counts and
  rows can then differ: one may hold a Series, or count a Run, that another does not. So a
  reader takes each file as true of its own update; where two of them differ, it fetches
  them again later, and they agree once both are of one update." **Every benchmark whose name an address takes
  has its list, always**: 1 to 64 characters, a lower-case letter, then lower-case letters,
  digits and underscores (what the Run schema admits for `benchmark`, which sets no length;
  `BENCHMARK_NAME` in `infra/runs/api-bucket.ts`, which the edge serves). Once published, a
  list must go on being written, since the upload refuses a tree that lacks a key the bucket
  holds, so no list is ever dropped; the Series of a benchmark named otherwise are in
  `v1/series.json` alone. Its address is `benchmarks.benchmark_file_url_template` with the
  name in it, the name every row and every Series file gives (`benchmark`): the tree's
  rule that every file is reached from the table of contents now reads "linked from a file
  of the tree, or the list of a benchmark a row names, at the address the template gives",
  and the set of lists is exactly the set of benchmarks whose names fit. No file links a
  list but the table of contents, so no link points up or across to a file written in a
  later phase of the upload. **No total of the Runs can stop a publish.** A list holds, of its Series whose rows take at most 16,384 bytes as JSON with no
  white space (`ROW_BYTES`: a row's params, build, instance type and zone ID come from the
  Runs, and the Run schema bounds none), in its order, as many as fit in 250,000 bytes, each
  row counted as its bytes and 6 more (`LIST_BYTES`); the first that does not fit and every
  one after it are left out and counted (`left_out`), so a list stays under its 256 KB
  ceiling however many Series there are. The table of contents' `benchmarks.list` gives
  each benchmark's `name`, the `url` of its list, how many Series it lists (`series`), how
  many Runs they hold (`runs`) and when the newest started (`newest_run_started_at`): in name
  order, as many as fit in 16,000 bytes (`BENCHMARKS_LISTED_BYTES`), so the table of
  contents stays under its ceiling however many benchmarks there are. `benchmarks.count`
  says how many have a list, `unlisted` how many of those `list` does not name, `left_out`
  how many Series are in no list. **The promise**: a Series its benchmark's list holds is two
  requests from the table of contents (the list, at most 256 KB, then the Series file, at
  most 1.47 MB); a Series in no list is found through `v1/series.json`; every Series keeps its
  file. A reader holding a Series' id gets its file in one, at
  `series.series_file_url_template` with `{id}` replaced (a Series file lists its month
  files' addresses, so no month file needs a template). `tests/api-bounds.test.ts` builds
  18 Series of one benchmark with a param of 14,500 characters, 1,100 Series of one
  benchmark and 501 benchmarks of names of 64 characters, each from valid Runs, and finds
  each tree publishable with the right counts. On 2026-11-25 the lists, built from the
  published `v1/series.json` by the build's own writer, were 3.9 to 57.3 KB (`http_get`'s 25
  Series; `memory_read`'s 40 took 29.8 KB), the largest row 2,527 bytes, nothing left out
  and every benchmark listed, and the table of contents, re-cut whole, came to 30,745 bytes
  (24,526 before).
- **The newest rounds of boots** (ADR-0030, rule 12): what was measured most recently, for
  the home page's "Latest runs" and for an agent asking whether the data are fresh.
  `recent_rounds.rounds` in `v1/index.json` holds the newest 8 rounds, newest first, each
  with `started_at` (its first boot's start), `boots`, `instance_types`, `runs` (the Runs
  its boots' summaries list), `failed_runs`, `runs_in_no_series`, `build_failures`,
  `not_run`, and `by_boot`: the same for each boot, with its summary's address
  (`boot_summary`). A round is worked out from the boot summaries alone (nothing a boot
  records says the schedule started it, and `schedule.json` is configuration): in order of
  `started_at`, a boot starts a new round when it started more than 40 minutes after the
  boot before it, so a round stays whole with two machine types in a row refused a boot or
  one boot as late as a scheduled launch may start, and a boot started by hand away from
  the schedule's times is a round of its own. A Run is failed when Method requests v1 does
  not count it, for a Run of a Series requests v1 derives, and when series v1 does not,
  for any other: an `http_get` Run that exited 4 because a request failed is counted by
  requests v1 and is not failed, as its Series file's `requests_v1.failed_runs` says. A Run
  the summaries list that no Method has a point of (no Run file, or one no Method could
  read) is in `runs_in_no_series`. A boot is there once its summary is, written when it
  ends, so the newest round may still gain boots: on 2026-11-24 the run of 22:43 UTC saw
  the 22:10 round with two of its five boots. Any round shown may change, not only the
  newest: a summary that arrives late joins its round (which may start earlier, or become
  one with its neighbour), one that arrives in conflict takes a boot out, and a Run file
  that arrives late moves its Run out of `runs_in_no_series`. **Nothing added to the Runs
  data stops a publish or changes a published link.** Every regular file under `boots/` is
  listed by the bytes of its name (no symbolic link, no directory), and only one at an
  address the API serves is opened; a path is written with each byte that is not printable
  ASCII, and each `%`, `"` and `\`, as `%XX`. One the rounds cannot be told from is in no
  round: an address the API does not serve, such as `unknown.json` (decided by its name
  alone); not strict JSON; not `ledgermath.boot/1`; without a boot, a start to the
  nanosecond, a provider with an instance type of 1 to 64 letters, digits, dots, hyphens or
  underscores, a list of Runs with their ids, or the lists of failed builds and executions
  not run; not at the path its own contents give (`boots/<UTC day of its started_at>/<its
  boot>.json`); a summary of a boot another started earlier; listing a Run of another boot;
  listing a Run twice or one another lists. `recent_rounds.left_out` counts them, of every
  day, and lists the newest 8 by path, each with its path (over 120 characters, its first
  101, `...` and 16 hex digits of the SHA-256 of the whole), its address when served, and
  one of a fixed few sentences saying why. A round lists at most 12 boots, its figures
  counting all. Bounded in bytes as written, at every bound at once, the rounds and the
  summaries left out take 48,297 bytes, a table of contents of 60,373 bytes on the data of
  2026-11-24 (its ceiling is 100,000), whatever the summaries hold. A point links its boot's summary only if that
  summary is in a round's reach on its own (served, at its own path, readable), the
  earliest-started of its boot, so a copy or a stray file can fill a missing link but never
  change one. What that implies, none of it in the real data, each refused by the gate out
  loud: a summary filed under a day that is not its own `started_at` day, as the only
  copy, is not linked (`main` linked it; checked against the tree published on 2026-11-24,
  where all 187 month files are the same, so the move changes nothing published); a
  summary rewritten at its address so it can no longer be read loses its link (the rule
  relies on the Runs repository only ever being added to); and a second summary of a boot
  at its own path claiming an earlier start changes the link, which no rule without
  history can tell from the first: it is listed as left out. That last needs no forged
  file, only someone running the runner twice by hand on one booted box, before and after
  midnight UTC (the runner takes `started_at` when it starts, and the box's script runs it
  once and shuts the box down).
  `tests/api-additions.test.ts` adds every other kind of file, alone and in pairs, and holds
  the build, the check, the gate, every link and the ceiling. `recent_rounds.about` says
  all this for a reader of the API alone, beginning with the rule and the count, which the
  check holds word for word; the check works the rounds, the summaries left out and every
  point's link from the checkout itself and compares.
- **No figure loses a digit.** The build reads every number of both files of Derivations as
  text too, and refuses the file, naming it, the number's place and the number, when the
  number's value is not exactly that of what it would write: an integer past 2^53, a value
  past or below a double's range, more digits than a double holds. `1e3` passes, written
  `1000`; `-0` passes, written `0`, the same value.
- **Split by month.** What grows with every Run is in the month files: the points, and the
  pair entries (`differed`), filed under the month of the later Run. The Series file holds
  the rest and the newest 12 points, so the number of points in it is bounded; its summaries
  still grow with what the data hold (a group per change of the machine's split facts, a
  value per new distinct value of a request fact, an entry per month). The Runs behind each
  percentile and in each group are not repeated: they are the month files' counted points
  (with a `bytes_per_repetition`, for bytes per second) and the points with a group's
  letter, counted or not (then filtered the same way, for a group's percentile), in order of
  start, then Run id, and the build refuses Derivations where that is not so. In place of
  requests v1's `group_through` the month files hold `group_through_as_of_run`, the group's
  figures as they stood through each Run, which no Run that started later changes (one that
  started earlier and arrives late can: cause (c) below). It is null before the
  Series' first Run of a second group, and for a group with no counted Run yet (though
  `through` then holds the other groups' figures); the Derivation's `group_through` is that
  point's `through` for exactly the points before the first point of a second group, in a
  Series of more than one group, and this field for every other point.
- **When a month file changes.** For a given layout (the layout of v1/index.json), a month
  file's bytes change only when (a) a Run that started in that month is added, (b) a boot
  summary that was missing arrives, (c) a Run arrives late, having started before a Run of
  the Series already in the files, in that month or an earlier one, or (d) a Method first
  applies to the Series; otherwise they do not change. These four are the only causes for a
  given layout: layout increases when LedgerMath changes how the files are written, and
  only then may a file's bytes change without one of them. A past month is therefore not
  immutable: each entry of the Series file's months gives its month file's sha256 and size
  in bytes, so a reader holding a copy can tell whether it is current, and fetches the file
  again only when the sha256 differs. A Series file and a month file fetched together can
  still be from different updates of the files: a cache may hold one of them from before
  the other changed, and an update that stopped halfway leaves them so until the next one.
  So a reader checks the sha256 of every month file it fetches against the one its Series
  file lists; on a mismatch, it fetches the Series file again, then the month file, and
  compares again; while they still differ, it uses neither, and tries again later. (a)
  brings the Run's point, its pair entry, and the
  month's count and span; (b) turns a point's `boot_summary` from null into its address,
  and nothing else; (c) does what (a) does and, in that month and every later one, may
  change in the later points only what depends on earlier Runs: their group and requests
  v1's `through` and `group_through_as_of_run` (`through`'s counts rise by exactly what the
  late Runs it pools add, and not at all when none of them is counted), and the pair entry
  of the Run right after it then comes from the late Run; (d) adds the Method's block to
  every month file of the Series. The last two are what the Methods produce, and the tree
  neither changes them nor hides them.
- **Served, a Series file and a month file can be of different rounds.** A month file
  changes in place, at its address, so no order of upload makes the pair change at once:
  the upload writes the month files before the Series files ("The API bucket", below), and
  should it stop between the two, a Series file lists a month's previous sha256 while the
  month's address already gives the new bytes, until the next upload succeeds (the
  workflow fails visibly meanwhile, and the next run repairs it by itself); for up to five
  minutes after each round, too, a reader's cache or CloudFront's may hold one of the two
  from before. No cache expiry repairs the first case. **The rule a reader follows:** verify
  a month file's bytes against the `sha256` its Series file lists; on a mismatch, fetch the
  Series file again and then the month file, and retry; while they still differ, use
  neither, and retry later. The table of contents and the schemas say the same, in the
  contract's last sentences (above; `MONTH_CONTRACT` in `scripts/lib/api.ts`), so a reader
  who has only the API has the rule too.
- **The layout is a number.** `layout` in `v1/index.json` is `LAYOUT` in
  `scripts/lib/api.ts`: raise it whenever the build changes how it writes the files (the
  order of a file's fields, their white space, a field every file of a kind gains). Editing
  a schema's words does not raise it, and neither does a field the table of contents alone
  gains (`recent_rounds`, 2026-11-24): the four causes are a month file's, the table of
  contents changes with the data at every update and no promise covers its bytes, and no
  other file's bytes change, so the next run is compared with the tree before as ever and
  needs no new baseline. The golden test fails on any change to the bytes and says so: if
  the change is on purpose, raise `layout`, unless only the table of contents changed.
  `layout` is 2 since 2026-11-25 (ADR-0030, rule 13): every Series file and every row
  gained `boots`, and every group its counted and failed Runs and the starts of its oldest
  and newest Run; no month file's bytes changed. The first scheduled run after that change
  fails its gate against the tree of layout 1, so the maintainer starts `runs` by hand with
  `new_baseline` once it is merged ("A new kind of file in the data API", under "Deploy").
  Since layout 2 writes month files as layout 1 did (`MONTH_FILES_WRITTEN_SO_SINCE_LAYOUT`
  in `scripts/lib/api.ts`, which `tests/api-golden.test.ts` holds to a month file layout 1
  wrote, kept in `tests/api-layout-1/`), that run's gate still compares every month file
  with the tree before, by the four causes: the new baseline lets the Series files, the list
  and the table of contents change, and no month file. It does so only when every file of
  the tree before could be read and parsed and that tree is whole; a broken tree before is a
  plain new baseline, as before, holding only the Series and Runs that can still be read of
  it, since the new baseline is the way out of a broken previous tree. The published schemas of the kinds that existed
  before leave every field layout 2 added optional, so a file fetched before and a schema
  fetched today agree, and so do the reverse; the check requires the present build to write
  them all (`tests/api-layouts.test.ts`).
- **The gate against the tree before.** `check-api.ts --previous DIR` holds a tree to the
  contract against the tree before it. A previous tree of the same layout and base is
  compared strictly, always: it must be whole (every month file its Series files list
  there, with the size and sha256 listed, and nothing more), or it is an error, not a
  baseline; every Series and month file of it must be in the new tree, each month file byte
  for byte or changed only for the four causes, no published Run gone. After a late Run, a
  later point may change only the fields `LATE_RUN_MAY_CHANGE` lists (its group, requests
  v1's `through` and `group_through_as_of_run`), and the pair entry of the Run right after
  it only its earlier Run and what it compares; `through`'s counts are held, on every point
  after a late Run, to exactly what the counted late Runs add (none at all when none is
  counted), as their points state it. **What the gate cannot establish** is that a changed
  cumulative percentile (of `through` or `group_through_as_of_run`), or a changed letter,
  is right: that is the Method's doing, and the check against the Derivations establishes
  only that the tree equals them; the check's output says so with every comparison. It
  lists each changed month file by cause.
- **A new baseline is declared by a human, never granted.** A previous tree that is
  missing, empty, of another layout or built for another base fails the check, unless
  `--allow-no-previous` declares a new baseline. The `runs` workflow passes it only from
  its `workflow_dispatch` input `new_baseline`, so the first scheduled run after `layout`
  is raised, or after the artifact `api` expired (it is kept 7 days), fails until the
  maintainer starts a run by hand with that input; the step's summary says so. Even then,
  when the previous tree can be read well enough to list the Series and Runs it published
  (its month files, or, in the layout before the split, its Series files' `points`), none
  of them may be missing, and the check says how many it compared. The workflow fetches the
  artifact `api` of the latest run on main created before it that kept one
  (`scripts/previous-api.ts`, among the 50 latest runs, ended or not: the run before may
  still be publishing when this one's first job starts). A run keeps it only when
  its tree passed this check, so the baseline is a checked tree whatever happened after:
  a run whose `publish` job failed (or was skipped) still is one, and a run whose check
  failed never is. It says what it found in the step's summary; a tree it could not
  download, or a reply it cannot read, fails the step.
- **When the gate fails on a real late Run** of a kind the allowance does not cover, the
  tree is not kept, and the next run fails the same way against the same earlier tree. The
  new-baseline input is not the fix (it does not apply to a tree of the same layout): find
  the field that changed; if the Method's definition makes it depend on earlier Runs, add it
  to `LATE_RUN_MAY_CHANGE` in `scripts/lib/api-check.ts`, with its consequence check where
  one can be made, and to cause (c) everywhere the contract is written, in a reviewed
  change; if it does not, the Method or the tree is wrong.
- **Each Method's part is labelled.** The 25 `http_get` Series carry both `series_v1` and
  `requests_v1`, each with its `method`; the others carry `series_v1` only.
- **Words a reader of the API alone can follow.** Its first readers have the API and
  nothing else, so no word the tree publishes (its own texts, each Method's definitions
  and words, the price rules' words for what each selects, the schemas' descriptions)
  names a file or directory of this repository, a README or a document's section, an
  issue, a pull request, an ADR, a function of the code or a program's option: a
  definition states its rule instead, and what it names, the tree serves (the events
  schema, at `v1/schemas/events.schema.json`). `tests/api-words.test.ts` builds a tree and
  scans every string but the data (what the Runs recorded, and what a Method derived from
  them for one Series or one Run: a point's `failure`, a Run file's `path`; in a price
  file, AWS's own words and identifiers), and fails on any such reference. None remains:
  `docs`, which named the README's section on GitHub until the documentation had pages of
  its own, is `https://ledgermath.com/docs/api/`, the documentation's reference to the API
  (`DEFAULT_DOCS` in `scripts/lib/api.ts`, ADR-0037).
- **Every field has words.** Every schema under `schemas/` has a title and a description,
  and so does every field it declares, wherever it sits (under an array's elements, a branch
  of `anyOf`, `oneOf` or `allOf`, `then` or `else`, or a definition in `$defs`): each member
  of `properties` and `patternProperties`, and `additionalProperties` when it is a schema.
  A field's words are its own, or, when it has none, those of the definition its `$ref`
  names. Every name in a `required` list is declared, with words, at that level: under
  `properties`, or matched by a `patternProperties` pattern, in the schema holding the list or
  one that applies to the same value (a schema it is a branch of, a `$ref`'s target, an
  `allOf` branch); `additionalProperties` does not count, being the schema of names an object
  does not declare. So is every name an `if` requires, in the schema around the `if`.
  `tests/schema-descriptions.test.ts` finds the schemas by directory and
  fails naming every gap, so a reference made from the schemas has no empty cell. A
  change to a schema's words alone needs no new baseline: the gate compares month files,
  not schemas (`tests/api-gate.test.ts`), and the next publish serves the new words.
- **`v1` only ever gains fields.** The API's own schemas forbid no member they do not list, so
  a field added later fails no older reader; a change that would break one is a `v2` beside
  `v1`. The price files are the exception: each is the Runs repository's, byte for byte, and
  follows its own closed schema, `ledgermath.prices/1`. The schemas admit everything the
  Methods can emit, not only what today's data show (a percentile of bytes per second is null
  when it comes from a counted Run of 0 ns per repetition, and one of time per repetition when
  it comes from a counted Run whose time per repetition overflows a double).
- **The same inputs give the same bytes**, whatever order they come in, the members of their
  objects included (known fields in their schema's order, the keys of params, facts,
  definitions and a Service's inputs in JavaScript's default string order, by UTF-16 code
  unit, which is byte order for the ASCII names in use), and no clock is read.
  `tests/api-golden/` holds every file the build writes from the tests' small fixture, so any
  change to the bytes, a reordered schema included, shows in review as a diff of those files;
  `LEDGERMATH_WRITE_GOLDEN=1 bun test tests/api-golden.test.ts` writes them anew on purpose.
  A Series file depends only on its own Runs, its Methods' words, its boots' summaries and
  the base, so a Series that gained no Run, and none of whose boot summaries arrived, keeps
  its file byte for byte. The data's own moment, the start of the
  newest Run, is in `v1/index.json` and `v1/series.json`; no file says when it was made.
- **Every file has a ceiling of bytes**: the table of contents 120,000 bytes, the list
  1,050,000, a Series file 1,470,000, a benchmark's list 256,000, a month file 5 MB, a price
  file 1 MB, a schema 256 KB (`CEILINGS` in `scripts/lib/api-check.ts`, each with what to do
  when it is hit). The check fails a tree with a file over its ceiling. Layout 2 raised the
  first three, from 100,000, 1,000,000 and 1,000,000, by the most its additions can add, so
  that no tree the layout-1 check accepted is refused for size by the change
  (`tests/api-ceilings.test.ts` derives each bound from the writer and builds the two trees
  the verification found): the table of contents gains at most 19,851 bytes (the benchmarks
  at their budget, the templates and words, the new schema's entry, longer words); a row of
  the list at most 25 (its `boots`), against the 484 a layout-1 row takes at least, so the
  list at most 4.9%; a group of a Series file at most 177 (its counts and starts), against
  the 377 a layout-1 group takes at least, and the file 29 for its `boots`, so a Series file
  at most 47%. **What one Run can add to the list, a Series file or a month file is still
  unbounded**: a string of any length in its params, build, instance type or zone ID can
  put a file over its ceiling and stop every publish. That is #81's to fix, not this
  change's.
- **What a Method left out is shown.** A failed Run is a point with `counted: false` and its
  `failure`, counted in the row as `failed_runs`. A Run file no Method could read is listed
  under its Method's `unreadable` in `v1/series.json`, with why and its `evidence`.

```bash
# From the two files of Derivations and the clone of the Runs repository made in "The Runs repository, the Method and the page", "Locally".
bun scripts/build-api.ts --derivations /tmp/page/derivations.json \
  --requests-derivations /tmp/page/requests-derivations.json --runs /tmp/ledgermath-runs --out /tmp/api
bun scripts/check-api.ts --tree /tmp/api --derivations /tmp/page/derivations.json \
  --requests-derivations /tmp/page/requests-derivations.json --runs /tmp/ledgermath-runs
# And that every month file of the tree before it, in /tmp/api-before, changed only for one of the four causes
# (--allow-no-previous declares a new baseline: only by hand, for the first build of a new layout, or with no tree kept):
bun scripts/check-api.ts --tree /tmp/api --derivations /tmp/page/derivations.json \
  --requests-derivations /tmp/page/requests-derivations.json --runs /tmp/ledgermath-runs --previous /tmp/api-before
```

The build writes only into a new or empty directory. The check reads back what was written and
compares it, by its own reading of the design and never by calling the build (but for the
build's serialiser, to hold each file to the one text the build writes for its value), with the
Derivations, the Runs repository and this repository's schemas. A passing check establishes
that every file of the tree is strict JSON (UTF-8 with no byte-order mark, no object holding a
member name twice, no number a double does not hold exactly), that every file the build writes
is byte for byte what the build writes for the value it parses to (a reordered object, a space
or a respelt number fails, the values unchanged), that `v1/index.json` gives this build's
`layout`, that the tree holds exactly the
files it should, each reached from `v1/index.json` by its links, none over its ceiling, each
matching this repository's schema of its kind (the API's own closed, so an undescribed field
fails) and of a kind the table of contents lists a schema for, with the schemas byte for byte
this repository's and valid JSON Schemas; that every month file holds every point of its
month's Runs value for value as the Derivations hold them, apart from what each point adds,
and the pair entries whose later Run started that month; that each Run is in exactly one
month file, its own month's; that every Series file holds each Method's words and summary
value for value, lists exactly the month files of the tree, each with its sha256 and size as
the tree holds it, and holds the newest 12 points as the month files and the Derivations do; that the lists of Runs it leaves out are what the
month files recover; that each point's Run file is in the Runs repository with the point's Run
id, boot, start and sha256, at the point's evidence, and its boot_summary is that boot's summary or
null when there is none; that each row agrees with its Series file and links it, the table of
contents lists exactly the price files and schemas the tree holds and counts the Series right,
and gives the docs as an absolute https address with a host; that its newest rounds of boots,
and the summaries it leaves out of them, are, value for value, what the checkout's boot
summaries and the Derivations make, each address given a file of the checkout of a shape the
API serves, and its words begin with the rule and the count; and that every link field, in its
place, names a file of the tree or of the Runs repository (`scripts/lib/api-check.ts` lists it
all).

On the data of 2026-11-19 (187 Series, 6,335 Runs, all of November, 9 price files) the tree is
390 files and 45.6 MB: `v1/index.json` 6.3 KB, `v1/series.json` 193 KB, a Series file 29 to
31 KB (median 31 KB) or, for `http_get`, 138 to 302 KB (median 264 KB), a month file 107 to
128 KB or, for `http_get`, 285 to 714 KB, a price file 39 KB. A month file grows by up to
4.5 KB a Run (22 KB for `http_get`): a full month at four Runs a day is about 0.56 MB (2.7 MB).
The build takes about 1.0 s and the check about 1.8 s on the dev machine, and comparing the
tree with the one before about 2 s more. Between the trees of two snapshots of that day in
which every Series gained one Run, every one of the 187 month files changed, each for
cause (a) only. On 2026-11-24 (187 Series, 10,147 Runs, 274 boot summaries, 14 price files)
`v1/index.json` is 23.6 KB, 15.4 KB of it `recent_rounds` (13.3 KB the newest 8 rounds of boots); built from the same
inputs, the tree before the rounds and the tree after them differ in `v1/index.json` and its
schema alone.

### The API bucket

ADR-0031. Every `-runs` stage has a private bucket, `ApiBucket` (stage output
`apiBucket`), that holds the checked tree under `v1/` and nothing else, so that the day the
public serving is turned on it serves real, current files. It is not behind `PUBLIC_API`:
it exists whatever the switch says, is not versioned, has no CORS configuration, keeps
SST's HTTPS-only policy and public access block, and grants nothing to anyone until
`PUBLIC_API.state` is `on` (`infra/runs/api-bucket.ts`). It is a bucket of its own rather
than a prefix of the Runs bucket so that the workflow's role, which writes here, stays
unable to write to the Runs bucket; so that the Runs bucket stays written once and
versioned for good, while these files are rewritten every round; and so that what readers
can reach of each bucket is one list per bucket.

**The upload is a job of its own.** The `runs` workflow's first job, `runs`, builds and
checks the tree and keeps it as the artifact `api`; it writes nothing to the bucket (its
alarm only reads when the table of contents was last written: "The alarm"). Its
second job, `publish`, `needs` it and runs only when it succeeded and the repository
variable `API_BUCKET` is set (to the scheduled stage's `apiBucket` output); while the
variable is unset the job is skipped, which is not an error. It has its own 15-minute
timeout and only the permissions it uses (read the repository, ask for the OIDC token), and
it downloads the artifact `api` this run kept, so it uploads exactly the tree that was
checked. Its steps: "Check that the public edge serves every kind of file in the tree"
(`scripts/check-api-edge.ts`, below), "Check the API bucket before anything is written"
(`scripts/upload-api.ts --preflight`), "Upload the data API's files to the API bucket"
(`scripts/upload-api.ts`), and "Check that the API bucket holds the data API's files"
(`scripts/check-api-bucket.ts --run`). When one fails, the `publish` job is red and the run is marked failed (GitHub's own
failed-run email goes to whoever last changed the workflow's schedule, per their
notification settings), but the `runs` job stays green, its artifacts are kept, and the
next run's baseline is this run's tree ("The data API"). Publishing that stops, however it
stops, is raised by the alarm in a later run's first job once the bucket's table of
contents is more than 14 hours old ("The alarm", "The data API's publishing").

**Never two at once, and never an older tree after a newer one.** The `publish` job holds
the concurrency group `api-bucket` (never cancelled in progress), and only that: the group
`runs`, which `prices.yml` shares, is held by the first job alone, exactly as long as before
the `publish` job existed. So the next run's first job, or `prices.yml`, may run while a
`publish` job uploads (the next run then takes this run's artifact `api` as its baseline,
though the run has not ended: "The data API"). Two `publish` jobs never run at once; of
those waiting, GitHub keeps only the newest and cancels the older, whose tree is older too,
so its run shows as cancelled and the newer tree is published. Every object the upload
writes carries the run that wrote it (`x-amz-meta-ledgermath-run`, the run's id, which only
grows), and every upload that succeeds leaves its run on the table of contents, even when
it had nothing else to write (below): when the bucket records a later run than this one,
anywhere, nothing is written and the job fails ("Not uploaded: ... later than this run").
That covers every order the group does not: a re-run of an old run's `publish` job, a job
that began waiting after a newer one had published, a newer run whose upload stopped
halfway, or whose tree equalled the bucket's. One order is left, and it overwrites nothing
newer: a re-run of an old `publish` job, started by hand while a newer one waits, takes the
newer one's place in the group, which cancels it; the older tree is then published (if no
later run is recorded) until the next run publishes. Re-run a `publish` job only when none
is waiting.

**Uploads must be serialized.** The run guard reads the bucket before the upload writes
anything, not while it writes: two uploads that overlap in time can each pass it, and
their writes then interleave, so the older tree can be written last and roll the bucket
back (its table of contents, list and Series files those of the older run, until the next
upload). Nothing in the bucket stops that; only the group `api-bucket` keeps two uploads
apart, which is why the `publish` job holds it. So an upload by hand goes through the
workflow, never from a laptop while a `publish` job may be running: re-run a `publish` job
(when none is waiting), or start the workflow by hand (Actions, `runs`, "Run workflow").
The commands below that upload from a laptop are for a bucket no `publish` job writes to:
`API_BUCKET` unset, or naming another bucket.

`scripts/upload-api.ts` writes the tree to the bucket, each file at its own path as key:

- **First, the whole bucket is listed**, before anything is written or asked about. If it
  holds a key the new tree does not have, under `v1/` or anywhere else, nothing at all is
  written: the step fails, and its summary lists each such key ("A key the tree does not
  have", below). Publishing a table of contents that no longer lists a file the bucket
  still serves would leave the bucket unequal to the tree for good, every later run failing
  the same way, since nothing deletes. The preflight step does this listing, and the
  `HEAD`s below, and writes nothing: its summary says what the upload would write.
- **Only what changed.** One `HEAD` per file, with `x-amz-checksum-mode: ENABLED`, gives
  back the SHA-256 S3 verified and kept when the object was written, its headers and the
  run that wrote it; a file is written only when the bucket does not hold it, holds it
  without a SHA-256, holds other bytes, or holds other headers (the run alone is no reason).
  A month file that did not change is not rewritten.
- **The run is recorded, even when nothing changed.** When every phase is written, and the
  table of contents, `v1/index.json`, was not rewritten and does not record this run
  already, the upload's last act is to write it again, the same bytes and headers, with
  this run (the stamp; `STAMP_KEY` in `scripts/lib/api-upload.ts`). It adds no key, and at
  most one `PUT` a round. Without it, a run that published a tree equal to the bucket's
  would leave no trace, and a retry of an earlier run, its tree older, would be let through.
  A retry of this same run finds its run already recorded and writes nothing. To a reader
  the stamp changes nothing but the time: S3's `ETag` is the MD5 of the bytes, so it stays
  the same and a reader that revalidates with it gets `304 Not Modified`; `Last-Modified`
  moves on, so a reader that revalidates by date alone fetches the same bytes again, at
  most once a round, and only after the five minutes its copy may be kept.
- **In an order that never leaves a reachable link hanging**, six phases, each whole
  before the next starts: the schemas; the month files and price files; the Series files;
  each benchmark's list, `v1/benchmarks/<benchmark>.json`; the list, `v1/series.json`, whose
  rows name every benchmark (so a row never names one whose list is not there yet); the
  table of contents, `v1/index.json`. Each file links down only to files of earlier phases
  (a test reads every link of a built tree to hold it to that); its links up, to the table
  of contents, the list or a month file's own Series file, are to files a reader came
  through. `tests/api-stopped.test.ts` stops an upload in each phase in turn, and by each of
  its writes alone, on the move from layout 1 to layout 2 and on an ordinary publish that
  brings a benchmark never seen before, and walks every link reachable from the table of
  contents, the template's included: none names a file the bucket lacks. **What a stopped
  upload can leave, truthfully:** files not yet reachable from the table of contents. A new
  month file (phase 2) links its Series file, a Series new this round (phase 3), and both
  link a table of contents that may not list them yet; a new benchmark's list (phase 4)
  may stand before the list of every Series names it. A reader who asks for such a file by
  its address, without following links from the table of contents, can find it, and its
  link up to a file not written yet. They stay so until an upload succeeds: the next run,
  six hours on, or longer while publishing stays stopped (the alarm raises it after 14
  hours). No link reachable from the table of contents names a missing file; but the files
  a reader reaches can be of different updates, their counts and rows differing (a list
  written, `v1/series.json` and the table of contents not), as `benchmarks.about` tells a
  reader ("The data API", above).
- **A failed write fails the `publish` job, and the next run repairs the bucket.** It
  stops the upload once the writes of its phase have settled; no later phase starts; the
  step fails, and its summary names the phase, each key that failed and why. A month file changes in
  place, so when the stop falls between the month files and the Series files, a Series
  file lists a month's previous sha256 while the month's address gives the new bytes, and
  no cache expiry repairs that (readers check the sha256: "The data API", above). The next
  run's upload repairs it by itself, with nobody's help: the month files are then the
  bucket's already, and only the Series files, the list and the table of contents differ
  from it, so only they are written. A test stops an upload there, on a filled bucket,
  shows the mismatch a reader would find, and shows the next run end it.
- **Nothing deleted.** The upload sends no `DELETE`, and the role has no `s3:DeleteObject`.
  Nothing the previous tree published can go: the gate of "The data API" keeps every Series
  file and month file in every new tree, and a key the tree no longer has (a price file
  taken out of the Runs repository, a schema dropped, anything put in the bucket by hand)
  stops the upload, as above, until a person settles it.
- **Each object carries the headers it is served with**: `Content-Type: application/json`
  and `Cache-Control: public, max-age=300` (the public serving's managed policies take
  nothing else; "The public data API"), and `x-amz-checksum-sha256`, which S3 verifies, as
  it verifies the signed body's SHA-256, so other bytes are refused; and, not served, the
  run that wrote it.

Then `scripts/check-api-bucket.ts` checks that the whole bucket holds exactly the tree:
the same keys, under `v1/` and nothing anywhere else, none missing and none more, each with
the tree's SHA-256, size, `Content-Type` and `Cache-Control`; and, given the run that
uploaded it (`--run`, as the `publish` job passes it), that the table of contents records
that run and no object a later one, so a stamp that did not happen fails the job. Each step
writes what it did, or why it stopped, to the step summary.

**The edge is asked first.** Before anything is uploaded, the `publish` job asks the public
edge, at the tree's own address (its table of contents' `url`), for one file of each kind
the tree holds, and for every schema (the edge serves schemas by a list of their names, so
a new schema is a shape of its own). Only the edge's own refusal stops the job, naming the
kind and saying to deploy `production-runs` first: a 404 whose body begins with the words
of the edge's functions, `Not found. LedgerMath's data API` (`EDGE_NOT_FOUND_OPENING` in
`infra/runs/public-blobs.ts`), which S3 never sends. Any other answer lets the upload go on:
200, S3's 403 for a file not yet written, a redirect, WAF's 403, a 5xx, a timeout (10 s) or
a network error, so the public address being down never stops a publish. Nothing is asked
of a tree the public API does not serve: one built for another host than
`api.ledgermath.com`, or while `PUBLIC_API.state` is not `on`. It is what makes the order of
"A new kind of file in the data API" (under "Deploy") safe even when it is not followed: the
code of a checkout always knows its own served shapes, the deployed edge may not. **What it
shows is narrow, by design**, and its output says only that: how many addresses it asked,
what each answered, and that the edge refused none. It asks one address of each kind, so an
edge refusing another address of a kind passes (13 redirects pass too); and one question
from one place reaches one edge location, while a deploy reaches the others over some
minutes. `tests/api-edge.test.ts` holds it to all this against stand-ins running the request
function's own code: each kind refused alone, an edge from before the benchmark lists, every
kind answering, redirects everywhere, a name it does not ask, and each failure that must not
stop the upload.

**Requests and time.** Each of the `publish` job's three steps that read the bucket (the
preflight, the upload, the check) lists the whole bucket and sends one `HEAD` per file of the tree, so a run makes
three passes: 3 `HEAD`s per file of the tree and 3 listings of the whole bucket (a listing
is one request per 1,000 keys), and a `PUT` per file written, with at most one more for the
stamp. For the tree of 391 files that is 1,173 `HEAD`s and 3 listing requests a round. The
first publish, run 44852356733 on 2026-11-21, wrote all 391 files: the preflight took 1.7 s,
the upload 4.3 s and the check 1.8 s, so at least 230 `HEAD`s a second at eight at once
(those times include reading and hashing the 46.6 MB tree). At that rate a pass over a
year's tree (about 2,600 files) takes about 11 s, and the job's 15 minutes hold the three
passes of roughly 60,000 files. A test holds the counts to the number of files, without
AWS: it runs the `publish` job's own three commands, read from the workflow, against the
stand-in for S3, for trees of two sizes, for a first publish, a round that changed one
Series and a round that changed nothing, and requires exactly these counts, with never more
than eight requests at once (`tests/api-upload.test.ts`); a fourth pass, a second `HEAD` per
file or a listing per file fails it. Time itself needs AWS: time a publish again when the
tree is several times larger (each step's summary gives its milliseconds).

**A key the tree does not have.** The preflight step stopped, nothing was written, and its
summary lists the keys; the published files are those of the last upload that succeeded,
and every run's `publish` job fails the same way until the key is settled (its `runs` job
is unaffected). The workflow cannot delete and never will; a person
does, with the stage's own profile:

1. For each key, find why the tree lacks it. A price file: was it taken out of the Runs
   repository on purpose (`git log -- prices/<yyyy>/<mm>/<dd>/aws.json` in
   `smrdotgg/ledgermath-runs`)? A schema: was it dropped from `API_SCHEMAS` in
   `scripts/lib/api-schemas.ts` on purpose? A key outside `v1/`, or of no shape the build writes:
   who put it there (`aws s3api head-object --bucket <apiBucket> --key <key> --profile
   tabot-production` gives its date and size)? A Series file or month file cannot be the
   cause: the gate keeps every one in every new tree, and a run would have failed there
   first.
2. If the tree is wrong (the file was taken out by mistake), put it back where the build
   reads it from and start the workflow again; nothing in the bucket changes.
3. If the key should go, delete it, and nothing else, with the stage's own profile: `aws s3
   rm s3://<apiBucket>/<key> --profile tabot-production`. While the public API is on, the
   deleted file stops being served once CloudFront's copies expire (five minutes for the
   tree); readers who kept it keep it.
4. Start the workflow by hand (Actions, `runs`, "Run workflow"), or wait for the next run:
   its `publish` job uploads, and "Check that the API bucket holds the data API's files"
   passes. (Re-running the failed `publish` job of an earlier run works too, unless a later
   run has written to the bucket since; then it refuses, as above, and the later run's
   tree is the one to keep.)

**A run recorded too high.** Every `publish` job fails with "Not uploaded: `<key>` as
written by run N, later than this run", and N is no run of `runs.yml` that published (an
upload by hand with a wrong `--run`, say, or an id from another repository): until it is
put right, no run can publish. The run is the object metadata `ledgermath-run` (sent and
read as the header `x-amz-meta-ledgermath-run`), usually on the table of contents,
`v1/index.json`, which every upload stamps, and on each file that upload wrote. Put it
right with your own credentials, the stage's profile; the workflow's role cannot, and
nothing is deleted:

1. Find the id of the latest run of `runs.yml` whose `publish` job succeeded (Actions,
   `runs`; the id is the number in the run's address). Call it R.
2. List the objects that record a later run than R (one `HEAD` per object, a few thousand
   for a year's tree):

   ```bash
   for key in $(aws s3api list-objects-v2 --bucket <apiBucket> --query 'Contents[].Key' --output text --profile tabot-production); do
     echo "$key $(aws s3api head-object --bucket <apiBucket> --key "$key" --query 'Metadata."ledgermath-run"' --output text --profile tabot-production)"
   done
   ```

3. For each key whose run is later than R, write the object over itself with R as its run,
   keeping its bytes, its headers and a SHA-256 S3 computes again:

   ```bash
   aws s3api copy-object --bucket <apiBucket> --key <key> --copy-source <apiBucket>/<key> \
     --metadata-directive REPLACE --metadata ledgermath-run=R \
     --content-type application/json --cache-control "public, max-age=300" \
     --checksum-algorithm SHA256 --profile tabot-production
   ```

   (`REPLACE` drops whatever is not given again, which is why the headers are. If an object
   is left without its SHA-256 or headers all the same, the next upload sees it and writes
   it again.)
4. Start the workflow by hand: its `publish` job uploads, stamps the table of contents with
   its own run, and the check passes.

**The permission.** The workflow writes with the role it already assumes, `RunsReaderRole`,
through a second policy of that role, `RunsApiUploadPolicy`: `s3:ListBucket` on the API
bucket, `s3:GetObject` and `s3:PutObject` on its `v1/*`, and nothing else. The role, its
trust policy and its first policy (list the Runs bucket, read `runs/`, `boots/` and
`blobs/`) are unchanged, so it still cannot write to the Runs bucket; a test holds both
policies together to that. The listing is not narrowed to `v1/` by a condition: S3 answers
a `HEAD` of a missing key with 404 only to a requester that may list the bucket, and a
`HEAD` carries no prefix for such a condition, so a missing file would look like a refusal.

**Setting it up.** A deploy of a `-runs` stage with this change creates, and changes nothing
else for it: the bucket (`ApiBucket`, with its public access block and SST's HTTPS-only
policy, which grants nothing), the role policy `RunsApiUploadPolicy`, and the output
`apiBucket`. Then, for the scheduled stage:

```bash
gh variable set API_BUCKET --repo smrdotgg/ledgermath --body <the apiBucket output of production-runs>
```

The next run of the workflow uploads every file (all new), the one after writes only what
changed. That first run's alarm, which comes before its own `publish` job, finds a new
bucket with no table of contents and raises it on the alarm issue ("The alarm", "The data
API's publishing"): expected, and the run after says the data API is published. To stop
the upload, `gh variable delete API_BUCKET --repo smrdotgg/ledgermath`; the alarm then stops
reading the bucket, and raises nothing for it while `PUBLIC_API` is `off`, but raises it in
any other state, `on` (as merged) included ("The alarm", "The data API's publishing").

```bash
# Locally, with the profile of the stage whose bucket it is, in a subshell, so that this shell keeps no keys.
# --run is the id of the run whose artifact api /tmp/api is (it is refused if a later run wrote to the bucket).
# The preflight and the check only read, and are safe at any time.
(eval "$(aws configure export-credentials --profile tabot-production --format env)" && bun scripts/upload-api.ts --tree /tmp/api --bucket <apiBucket> --run <run id> --preflight)
(eval "$(aws configure export-credentials --profile tabot-production --format env)" && bun scripts/check-api-bucket.ts --tree /tmp/api --bucket <apiBucket> --run <run id>)
# The upload writes: only to a bucket no publish job writes to (API_BUCKET unset, or naming another bucket).
# Uploads must be serialized ("Uploads must be serialized", above); to the scheduled stage's bucket, go through the workflow.
(eval "$(aws configure export-credentials --profile tabot-production --format env)" && bun scripts/upload-api.ts --tree /tmp/api --bucket <apiBucket> --run <run id>)
```

**What it costs**, at the prices of AWS's Price List API on 2026-11-19 (us-east-2): S3
Standard storage $0.023 per GB-month, so the 46.6 MB tree is about $0.001 a month and a
year's growth (about 1.8 GB) about $0.04; `PUT` and `LIST` $0.005 per 1,000, and a round
writes the Series files and month files that gained a Run, the list and the table of
contents, at most about 380 files, so at five rounds a day at most about 57,000 `PUT`s a
month, $0.29, while the three listings a round add 450 requests a month (1,350 a year on, at
three pages each), under a cent; `HEAD` and `GET` $0.0004 per 1,000, three `HEAD`s per file
per round (the preflight's, the upload's and the check's: "Requests and time", above), so
about 176,000 a month for today's 391 files, $0.07, growing with the tree (about 2,600 files
a year on, 1,170,000 a month, $0.47), and the alarm's one `GET` a round, 150 a month.
Transfer into S3 is free.

### The API reference

The documentation's reference to the data API (#64, decision 9) is Markdown generated from
the schemas, and never kept in the repository: the site's build writes it.

```bash
bun scripts/api-reference.ts --out /tmp/reference    # /tmp/reference/docs/api/*.md and /tmp/reference/docs/machines.md
```

| File | Address | From |
|------|---------|------|
| `docs/api/index.md` | `/docs/api/` | The overview: words in `scripts/lib/api-reference-words.ts`, with `ABOUT`, `VERSIONING`, `FIGURES`, `MONTHS`, `LIST_UPDATES` and `EVIDENCE` of `scripts/lib/api.ts` quoted where they stand, so the API's contract has one source |
| `docs/api/<page>.md` | `/docs/api/<page>` | One schema each (`FILE_PAGES`): `table-of-contents`, `series-list`, `benchmark-list`, `series`, `series-month`, `prices`, `run`, `events` |
| `docs/machines.md` | `/docs/machines` | `schedule.json`: each target, and the entries for some types only |

`writeApiReference(dir)` in `scripts/lib/api-reference.ts` does the same for another caller. The
site's build runs the script itself, into a new directory of its own (`site/scripts/docs.ts`,
`generateApiReference`; "The documentation" under "The website"). It needs the root's packages
(`bun install` at the root), since `scripts/lib/api.ts` brings in the Methods' code: the `site`
workflow's build job and both production deploys install them before the site's. It refuses,
writing nothing, when any of its files is already there. The same input gives the same bytes:
no clock, no locale, no directory order.

A file page holds, in this order: its title and one paragraph that stands alone (what an index
of pages shows as its description); where the file is, how a reader reaches it and what it
links, with its schema (the API serves seven of the eight at `v1/schemas/<name>.schema.json`;
the Run's is not served, and is linked on GitHub); the schema's own description; an example;
every field; the shared shapes.

- **Every field, by its full path** from the top of the file (`[]` each element of a list, `*`
  a member whose name is not fixed, `/…/` a member whose name matches a pattern, `["p99.9"]` a
  name with a dot), its type in plain words with every constraint its schema states (a pattern
  the names must match, `propertyNames`, and how many members there are, "one or more of them",
  among them), whether it is required, and its description whole, copied from the schema and
  only escaped for Markdown (a code span a description writes in backticks stays one). Beside its
  own words, a field shows those of a definition it names, and "Each element: …" for a list.
  `KEYWORDS` lists the keywords of JSON Schema the generator puts into words, and the tests fail
  on a schema that uses another. An object a schema closes is said to have "no other members";
  the legend says any other object may hold members the page does not list, and the price and
  events pages say which (AWS's objects; a benchmark's own events and observed values).
- **Shared shapes.** A definition the schema names from more than one place, and which has
  fields of its own, is described once, under "Shared shapes", its fields written `….p50`; it
  lists every place it is used, and each place links to it. A definition named from one place is
  written out there. The Series page so has 221 entries and 12 shapes, where writing every path
  out would take 1,102.
- **Choices in words.** "string or null"; a `oneOf` of objects is "exactly one of these N
  shapes", each listed with what it has, may have and never has, and each field says in which
  shapes it is required or absent (the Run's two shapes, its `exit`); an `allOf` branch with
  `if`/`then` is a heading, "When `event` is `"started"`", with the branch's words and fields
  (the events schema); `enum` is "one of …", `const` "always …", `additionalProperties: false`
  "no other members".
- **The fold.** A description longer than 200 characters, of more than one sentence, is a
  `<details>` with its first sentence as the `<summary>`: a person scans, and an agent reading
  the Markdown has every word. An example longer than 150 lines folds too.
- **Examples come from the fixed sample**, `docs/api-sample/`, real files taken once from the
  live API, so a page changes only when its schema, its words or the sample do. Each is an
  excerpt the generator makes by one rule, `EXCERPT_RULE`, which the page prints word for word
  beside the list of every place it shortened (a test holds the code to it), and the page links
  the file at the same address: as it is now, for a file of the API's own that changes in place;
  the same bytes, for a price file or a Run file, which is never edited (`writtenOnce` in
  `scripts/lib/api-reference-words.ts`).

**The sample** follows one Series, `124066cf09f9` (`http_get` on `m5.large`, which Method
requests v1 derives beside series v1), through every kind of file, taken on 2026-11-26: the
table of contents, the list of Series, `http_get`'s list, the Series' file, its month file of
2026-11, the Run file of its newest point, that Run's stdout blob, and the day's price file.
Beside them, one Run's environment dump, for the start-here page's fleet example: the Run file
of the newest point of a second Series, `a655ffb3e7dd` (`memory_read` on `c6i.8xlarge`), the
index of its before-dump, and the dump's section `memory`, which holds the box's own
`/proc/meminfo` (added on 2026-11-27 from the Run the sample's list names as that Series'
newest; a Run file and its blobs never change). 1,216,792 bytes in eleven files, 565,082 of
them the month file. `docs/api-sample/sample.json` lists each with its kind, address, size and
sha256. To take it again (into a directory that does not exist yet, or is empty):

```bash
bun scripts/fetch-api-sample.ts --series 124066cf09f9 --dump-series a655ffb3e7dd --out docs/api-sample
```

It follows the files' own links, and writes nothing unless they agree as one update (the month
file's sha256 the one the Series file lists, the Run file's the one its point gives, the stdout
blob's the one the Run names, the row the same line in both lists; the dump's Run the newest
its row gives, the index's sha256 the one the Run names, the section's the one the index
names). A new sample can change any figure the start-here page's examples cite, and its test
then fails until they are worked again.

`tests/api-reference.test.ts` holds: every schema under `schemas/` has a page, or is in
`SCHEMAS_WITHOUT_A_PAGE` (empty); every field the description test finds is on its schema's
page with its words in full, under the path or the shared shape that owns it (a field of a
definition written out where it is used, at each place the definition is named from; one of a
shared shape, in that shape's section), found by a walk of the test's own; every schema uses only
the keywords in `KEYWORDS`; the excerpt does what `EXCERPT_RULE` says; each file of the sample is
the one its manifest lists, validates against its schema (the API's own five against the schema
closed too, each line of the stream against the events schema; a dump's index and section have
none), agrees with the others (the dump's Run of a Series of the list, its index and section by
the hashes the Run and the index name), and
holds no AWS key; every example is an excerpt of its sample that keeps every top-level member,
and every list or object it keeps holds something when its source does; every link is a page `scripts/lib/docs-addresses.ts`
lists, a heading of its own page, the API or the repository; each page starts with its title
and a paragraph and holds no HTML but `<details>` and `<summary>`; the overview quotes each
contract paragraph word for word; the machines page gives every target; the same input gives
the same bytes; and a small schema written in the test gives `tests/api-reference-golden.md`,
which shows what a page looks like (`LEDGERMATH_WRITE_GOLDEN=1 bun test tests/api-reference.test.ts`
writes it anew, on purpose).

## The website (`site/`)

The home page and the documentation:

- **`/`, the home page.** Design v9, the one the maintainer chose from the home-page
  variations (issue #64; the exploration stays on the branch `home-variations`, never
  merged): a headline with the latest rounds of boots beside it, three graphs, the table of
  all benchmarks (14 rows, one per benchmark, by the written rule in
  `site/src/data/headline.ts`, × the 5 machine types, with their hourly prices), in Geist
  Pixel, black and white: the Circle face, white on black, in the dark colour scheme, and
  the Square face, black on white, in the light one, with the art beside the headline and
  the graphs' bars drawn in round dots or in squares to match. Every figure is read at build time from a tree of the
  data API and links to its Series file there. Each shows a median rounded to four
  significant digits, with every digit, its 5th and 95th percentiles and its count of Runs
  in its `title`. Under the headline the page credits the project LedgerMath began from:
  "Inspired by Simon Eskildsen's Napkin Math", the name a link to its repository. Each
  benchmark's name in the table links to its page in the documentation
  (`/docs/benchmarks/<benchmark>`; `site/src/data/headline.ts` holds the documentation's
  addresses in one place).
- **`/docs/…`, the documentation** (ADR-0037, "The documentation" below): 28 pages on
  2026-11-27, each rendered at build time from one Markdown file, and each served as that
  Markdown too: the start-here page with every page listed after it, the API reference,
  a page per benchmark, the machines, the Methods, the prices and the glossary; and
  `/llms.txt`, the index of them for agents.

The pages link inside the site; under `https://api.ledgermath.com/`; to the repository's
files on GitHub, under `https://github.com/smrdotgg/ledgermath/blob/main/` or `…/tree/main/`
(`REPOSITORY_FILES` in `site/src/pages.text.ts`), which the documentation links to (a
README's relative link to a source file, a schema the API does not serve), each to a file
or directory the checkout has; and to one address besides, named whole in `OUTSIDE_LINKS`:
Napkin Math's repository, from the home page's credit. `bun run check` fails on any other.
Until the repository was public and the documentation linked its files, the rule was
`OUTSIDE_LINKS` alone, so that no link went to the source repository.

**Navigation is in place** (ADR-0036, ADR-0037). Each page is complete HTML, rendered at build
time, and each also loads the site as a Solid application (`site/src/app.tsx`): one script,
`assets/app-*.js`, and the runtime chunk it imports, which the page's `<head>` asks for beside
it. In the browser it hydrates the page (it takes over what the build rendered without
rendering it again), once the browser reports the page's first contentful paint, so that the
first frame the reader sees comes as it would without it, and from then on Solid Router
(`@solidjs/router` 2) does the navigation: a click on a link to another page of the site
renders that page in place, with no request, from what the application already holds: the
home page and the figures it was built from (compiled into the script at build time:
`pageData`, `site/src/data`), the documentation's layout, every documentation page's title
and description, and the body of every documentation page whose chunk the router has loaded
ahead, which, but for a reader who asks to save data, is every page a link on screen leads to,
once the page has loaded and the browser is idle (below). With JavaScript off, or before the application
has taken over, the same links are ordinary links between complete pages. The router leaves to the browser the links to another origin (the API),
those with `target` or `download`, and clicks with a modifier key or another button than
the first. The site gives `target="_self"` to its links that are not page changes, so the
router leaves them to the browser too: a file that is not a page (`third-party-notices.txt`),
and a place on the page on screen (the header's "Numbers" on the home page), which the
browser's own jump handles, moving the keyboard focus there as on any page; `bun run check`
fails on such a link without it. After a page change in place: the `<title>` and
description change (Solid's `useHead`); the keyboard focus starts again where a page load
would start it, at the element the address's `#…` names (so Tab after "Numbers" from
`/docs/` goes into the table) or else at the top, and a screen reader is told the new page's
title (a link that changes only the `#…`, LedgerMath from `/#numbers`, moves the focus the
same way; a `#…` that does not decode, as in `/#%`, names nothing, and the focus goes to the
top); the page's feature flags (below) follow its address; the page starts at the top, or
at its `#…` target; back and forward restore the scroll position (the browser's own
restoration: the router's is turned off, since it lost the place of a page the reader never
scrolled). A link to the page already on screen (the footer's "Docs" on `/docs/`) starts it
again at its top, with the focus there, as loading it again would. An address no
route knows goes to the browser, which loads whatever the host has there. The host serves
`/docs/glossary`, `/docs/glossary/` and `/docs/glossary/index.html` alike, and so do the
routes. The script holds the figures of the build that wrote it: a tab left open across a
rebuild shows them until it loads a page again. A documentation page's chunk, once loaded, is
not asked for again, so a deploy can leave an open tab asking for a file that is gone only
for a chunk the tab had not loaded yet (a click that came before the router loaded it ahead,
or a reader who asks to save data): that click is then left to the browser, which loads the
page whole from the new deploy (`useBeforeLeave` in `site/src/app.tsx`; without it the
router stopped on the failed import, and no click worked after it).

`bun scripts/measure-navigation.ts TARGET…` (in `site/`, by hand) measures a click in
Chromium, Firefox and WebKit, against a built directory or an address: from the click to
the changed page and to the next frame, the requests it made for the page it shows, and the
first load's bytes and paint (`--first PATH` for another page than `/`, `--cycle A,B,…` for
the pages the clicks go round, each by a link on the one before). Measured on 2026-11-26 on a
2-vCPU cloud machine (an Intel Xeon at 2.9 GHz, headless, no GPU), 15 clicks each way per
browser, locally and on a Vercel preview: a click from `/` to `/docs/` reached the next frame
in a median of 6 to 15 ms, and a click to `/`, whose table is most of the site's markup, in
17 to 28 ms (at most 45), and no click made a request; with Chromium's CPU slowed four times,
as a slower phone would be, 24 and 90 ms. The same clicks on the site as it was before, as
ordinary navigations to `https://ledgermath.com`, took 55 to 97 ms (medians) to the new page's
first paint, up to 198 ms, with three requests each. The first paint of a cold load is within
a few milliseconds of the site without the application (the larger HTML and the script's
fetch; hydration comes after it), and the application takes over 25 to 55 ms after it, about
90 ms on a phone-class CPU (ADR-0036 has the figures by browser; `--loads N` repeats the first
load, taking turns between targets). The documentation's clicks and first loads, measured on
2026-11-27, are in ADR-0037.

**Feature flags.** A flag is a part of a page that is in its HTML but hidden. A page names
its flags in `site/src/pages.text.ts` (`flags`); with `?NAME` in the page's address, the
inline script sets `data-NAME` on `<html>` and the stylesheet shows the part, and after a
page change in place the application sets or clears it by the same rule. There is one:
`napkin`, on the home page (<https://ledgermath.com/?napkin>). It shows a closing note,
centred between the table and the footer, "LedgerMath began as a port of Simon Eskildsen's Napkin
Math", with a napkin drawn beside it on the font's grid (`site/src/home/napkin.tsx`); the
sum on the napkin is four rounds a day for a year. Without the parameter, or with
JavaScript off, the note is not shown. To show a flagged part to everyone, remove the rule
that hides it (`.closing` in `site/src/site.css`) and the flag.

**Built from a tree.** The build reads a directory in the data API's own layout: the
table of contents (`v1/index.json`), the Series list and the newest price file, at the
places the table of contents' links give (`site/src/data/tree.ts`). It is given
explicitly, with `--tree DIR` or `LEDGERMATH_TREE=DIR`; with neither the build fails and
says so, so the site is never built from old numbers by accident.
`site/scripts/fetch-tree.ts` fetches exactly those three files from
`https://api.ledgermath.com` into a new directory: it starts at the table of contents and
follows only the links it gives, never building an address, with a time limit and a size
limit on every request, and refuses anything that does not parse or does not say what it
is (`ledgermath.api.index/1` for the table of contents). The production deploys read the
same three files from the API bucket itself instead, with the same check
(`scripts/read-api-tree.ts`, "Where it is deployed"); the build needs only the directory.

What a tree lacks, the page leaves out rather than fill, and the build says so in one line
each (`note: …`):

- no `recent_rounds` in the table of contents (the API does not give them yet): no "Latest
  runs" list, and no gap where it was;
- no Series for a headline cell, or one without a median (no Run counts yet, or the median
  is null, which the schema allows for "infinite or undefined"): a dash, with why in its
  `title`;
- a 5th or 95th percentile given as null: the figure stands, and its `title` says the
  percentile is infinite or undefined;
- a machine type the price file names but no Series ran on: its column stays, with a dash
  in every cell;
- Series on a type the price file does not price, Series that name no instance type (the
  schema allows null), a benchmark with no headline choice: left out of the table.

The reader takes everything the Series list's schema allows, so no one Series can stop the
build. A round with failed Runs says how many; it says "0 failed" only when the tree says
0. Two Series that both match a headline choice on one machine type fail the build, since
the rule no longer says which to show. An old tree still builds: the page shows the dates
it holds. A table of contents that names no price file fails it: the columns and prices
come from the newest one.

**One publication.** The three files must be of the same publication of the API: the
Series list must name the table of contents' address and give the address and count of
Series the table of contents gives, both must give the same newest Run, and the newest
price file must have been fetched on the date the table of contents gives it. A fetch that
overlaps an upload, or meets a cache holding one file from before another changed, could
otherwise pair one publication's table of contents with another's figures, and the page
would show old figures under a new date. `fetch-tree` then fetches the whole set again, up
to three times, ten seconds apart, and fails, writing nothing, if they still disagree; the
build refuses a directory whose files disagree, saying it holds two publications.

**Where it writes.** The build replaces its output whole, so it guards it: it refuses an
empty `--out`, an output that is or holds the repository, one inside the repository
anywhere but under `site/dist/`, and one that is, holds or is inside the tree it reads. It
builds into new directories of its own with unique names (the server bundle under
`site/dist/`, the site beside the output) and puts the site in the output's place only
when the output is absent, empty or written by an earlier build, which it recognises by the
file `.ledgermath-site-build` the build leaves in it (served with the site; it says only
that the build wrote the directory). Anything else there is left as it is, and the build
fails before writing anything. A `site/dist/client` from before this mark existed must be
removed by hand once.

It is SolidJS 2, built with Vite and Solid's Vite plugin (`site/scripts/build.ts`). The
build takes what the pages render from the tree (`pageData`: plain JSON, a few kilobytes),
makes the documentation from its Markdown ("The documentation", below), and Vite makes two
bundles, each with that JSON compiled in: the browser's, from `site/src/entry-client.tsx`,
the application's script, the runtime chunk it imports and a chunk per documentation page;
and the server's, from `site/src/entry-server.tsx`, which renders each page once with
Solid's server renderer. The HTML, the scripts, the stylesheet, the two self-hosted fonts,
each documentation page's Markdown, `llms.txt` and `public/` are written to
`site/dist/client`. The document around each page (`site/src/Document.tsx`) is the build's
and is never hydrated; its body is the application's. At the top of every page, before
`<html>`, a comment tells an agent that reads the HTML where the site is in Markdown
(`AGENTS_COMMENT` in `site/scripts/build.ts`), and each page's `<head>` names `/llms.txt`
(`<link rel="describedby">`, as the convention asks). Each page's `<head>` loads the script
as a module, which runs once the HTML is parsed and hydrates after the first contentful
paint (`site/src/entry-client.tsx`; `check:browser` holds the order), so the page paints as
it did without it (in a browser without Paint Timing or `PerformanceObserver`, once the body is shown and two
animation frames, one asked for inside the other, have passed, so that the frame showing the
text has been painted);
an inline script sets the page's feature flags (above) and holds the page back, hidden from
before the body is read, until the font of the reader's colour scheme has loaded, so that
the text and the dot art and bars, which are not text, appear in the same frame. The
guarantee is the stylesheet's: the rule that hides the body ends the hiding by itself, with
an animation, 3.5 s after it first applies, whatever the script sees or misses. The script
acts on the load and error events of every stylesheet, without asking whose: the first
starts a bound of 3 s (the block period CSS Fonts 4 recommends for `font-display: block`);
once `--pixel` names a face it waits for that face, and when the wait settles it reads
`--pixel` again, waits for the new face if the reader changed colour scheme meanwhile, starts
again at the next stylesheet event if the face was not known yet, and else shows the page.
If the face failed or the bound came first, it shows the page with its text in the reader's
own monospace font (the class `font-fallback`), and the text changes to the face if it comes
later. Showing the page takes the class away first, so that nothing that goes wrong
afterwards can leave it hidden. Not handled: around a change of colour scheme during the
first load the page may wait for the old face, or for the 3 s, before it is shown; a change
once the page is shown in its face is left to the browser, which hides the text in the new
face for its own block period, as on any change of scheme; under `font-fallback` the text
stays in the fallback font until the face it was set for comes. A repeat visit, the font in
the browser's cache, was held 6 to 7 ms in Chromium, and shown before its first frame.
Without JavaScript nothing is hidden. Another inline script, Solid's, prepares
the hydration. The pages read the same with JavaScript off. `site/` has its own `package.json`
and `bun.lock`, apart from the root's, and needs Bun (Vite runs under Bun, not Node), and
the root's packages for the API reference's generator (`bun install` at the root).

```bash
bun install --frozen-lockfile           # at the root: the API reference's generator needs it
cd site
bun install --frozen-lockfile
bun run typecheck                       # type-check
bun test                                # the data module's, the documentation's, the build's, the fetcher's, the checks' and the deploy scripts' tests, on fixtures/tree/
bun run fetch-tree /path/to/tree        # the three files from https://api.ledgermath.com, into a new directory
LEDGERMATH_TREE=/path/to/tree bun run build   # site/dist/client (or: bun run build --tree /path/to/tree)
LEDGERMATH_TREE=/path/to/tree bun run check   # checks site/dist/client against that tree, as the workflow does
bun run preview                         # serves site/dist/client at http://127.0.0.1:4173 (a port as argument to change it)
bun run check:browser                   # the browser checks (below), which the workflow runs too
bun scripts/measure-navigation.ts dist/client   # by hand: what a click and the first load cost, in three browsers (above)
```

`site/fixtures/tree/` is a small tree for the tests only: the API as it was on
2026-11-19, with `recent_rounds` added by hand (its README says how). Nothing published is
built from it.

`.github/workflows/site.yml` runs on pull requests and pushes to main that touch what the
site is built from (`site/`, `benchmarks/`, `schemas/`, `scripts/`, `methods/` and
`infra/runs/`, which the API reference's generator imports through `scripts/lib/api.ts`,
`docs/`, `schedule.json`, the root's `package.json` and `bun.lock`, and the workflow; a test of
`site/deploy/fresh.ts` holds the list to every file the build and the generator import; a pull
request that breaks a documentation link, or the generator, there fails here, not in the next
rebuild of production), and by hand.
It installs the root's packages and the site's with the lockfiles frozen, then type-checks,
tests, fetches the tree as published (`bun scripts/fetch-tree.ts`), builds from it, runs
`bun run check` with it and then the browser checks (`bun run check:browser`, below), and
keeps the built site as the artifact `site`, which a preview deploys. Production is built again, from the API bucket, inside the production deploys'
group ("Where it is deployed"). The same commands work locally, inside `site/`.
`bun test` at the repository root leaves `site/` alone
(root `bunfig.toml`); the site's tests run inside `site/`.

`bun run check` runs two scripts on `site/dist/client`:

- `site/scripts/check-output.ts`: each page exists and holds its fixed words in its body,
  outside any script or style, which shows the prerender ran: the home page's
  (`site/src/pages.text.ts`; change them there with the page), and each documentation
  page's, read back from the site's `llms.txt` (`site/scripts/site-pages.ts`): the header's
  and footer's words, its title and its description; `llms.txt` lists every documentation
  page and nothing else, each by its Markdown, which the site has beside it, starting with
  the page's title, and which the page names in its `<head>` (`checkDocs`); no HTML, CSS or
  JavaScript file refers to a file the output lacks or loads anything from another origin;
  every link a reader follows (`href` on `<a>` or `<area>`) goes to a file the site has (and,
  with a fragment, one that decodes, to an id that page has), under
  `https://api.ledgermath.com/`, under `REPOSITORY_FILES` to a file or directory the
  repository's checkout has, or is exactly one of `OUTSIDE_LINKS`; every link inside the site
  that is not a page change (to a file that is not one of the pages, a page's Markdown among
  them, or to a place on its own page) carries `target` or `download`, which leaves it to
  the browser rather than the router; and the weights, text gzipped at level 9: each page's
  first load (the page and what it loads to show itself and be taken over: the stylesheet,
  both fonts, of which the check counts both and a browser fetches only the one its colour
  scheme uses, the application, and a documentation page's own chunk) under 300,000 bytes
  (119,125 for the home page, up to 159,221 for a documentation page, http_get's, on
  2026-11-27; 113 KB for the home page before the documentation); the application, its
  script and what it imports, under 60,000 (54,902; about 45 KB before); each documentation
  page's chunk under 40,000 (the largest, http_get's, 21,409); and every chunk the
  application may load ahead, together, under 250,000 (181,164 for 28 pages). Past the last,
  preload fewer pages ahead rather than raise it (ADR-0037). It reads `src`, `href`, `srcset`,
  `imagesrcset`, `poster` and `xlink:href` on any HTML element (a `<link>` whose `rel` is
  `alternate` or `describedby` names a file the site must have, which no browser loads),
  `url()` in `<style>` blocks and `style` attributes, imports in inline scripts, `url()` and
  `@import` in CSS files, and `import`, `export … from` and `import()` of a quoted path in
  JavaScript files (a template literal with nothing to fill counts as quoted; `import()` is a
  chunk loaded ahead). It does not read other file types, `image-set()` with bare strings, or
  URLs that JavaScript builds as it runs, and it reads the HTML as text: a check on what an
  honest build writes, not an HTML validator. Its reading of a page's text drops the tags of an
  element inside a line of text (`code`, `a`, `em`…) without a space, as a reader sees them,
  so that a description with code in it is found as written.
- `site/scripts/check-figures.ts`: every figure on the home page is one the tree holds,
  exactly. It goes back from the page to the tree: each link to a Series file must be a
  Series of the tree, the one the headline selection names for its row and machine type,
  and the median, percentiles and count in its `title`, moved back into the tree's unit
  digit by digit, must be the tree's numbers; the figure shown must be that median to four
  significant digits, and the row's unit the unit of its figures; a percentile the tree
  gives as null must be said to be infinite or undefined. Dashes stand only where the tree
  has no figure, with the data module's reason; every cell of the headline selection, in
  the table and in each graph, holds exactly one figure or one dash, none blank, and the
  columns are the machine types; the home page has exactly its three graphs
  (`GRAPH_BENCHMARKS` in `site/src/data/headline.ts`), by their headings, in order, so a
  graph missing whole fails though no figure is wrong; prices and machine facts are the
  price file's; "Latest runs" is
  there only when the tree gives rounds, and says what they say; the region is the price
  file's. Anything else on a page that holds a digit and is not a fixed word fails, so a
  new figure needs a rule there.

**The browser checks** (`bun run check:browser [DIR] [--shots OUT]`,
`site/scripts/check-browser.ts`) run in `site.yml`'s build job, after `bun run check`, and
by hand; not in the rebuild after each round of boots, which must be quick and needs no
browser. They load each page in Playwright's Chromium (installed once with
`bunx playwright install chromium` in `site/`) at 1440×900 and at 390×844: the home page and
four documentation pages (`/docs/`, the longest reference page, the longest README and the
glossary) each in light and dark, every other documentation page in light, and a page with
feature flags again with each flag on; and fail on a console error, a failed request or a request to another origin,
a horizontal scroll at 390 px, an axe-core violation of WCAG 2.0 and 2.1 A and AA or of
its structure rules, a first load over the size budget as transferred (the chunks of other
documentation pages, which the router loads ahead, are weighed apart, under their own
budget), a line with a figure
that is missing with JavaScript off, hydration that begins before the page's first
contentful paint (the mark `hydrate` before the paint entry; and once more, on the home page
and those four, with Paint
Timing hidden from the page and the font 300 ms late, before the first contentful frame's
paint time), or hydration that changes an
element or text of the page (only the attributes the router derives from the address may
change). They fail, too, when the page is not held back for its font: with the font held
back by the host and the stylesheet made late, on the home page and the glossary in light
and dark, every frame between the stylesheet's load and the font's response must have the body
hidden (by the page's own record), the page shown within a second of the font's response
ending, and the first frame that shows it must draw the heading in the scheme's face; another
stylesheet loading or failing before the site's (from another origin; on the site's own
origin empty, failing, or naming the face whose `@font-face` comes later) must change
nothing; switched from light to dark during the hold, the page must be shown only after the
dark face's response, in it (a load in which the page's record shows the bound came before
the check could act is made again, three times at most); opened at an address with a
username, shown in the face; with the script deaf to every stylesheet event, the body shown
by the stylesheet's own animation 3.5 s after it loaded; with the font not come, the page
must be shown 3 s after the stylesheet loaded (and not a second later), its heading in a
fallback font from the first frame, then in the face once it comes;
with the font refused (404, a network error), shown at once in a fallback font; and with
JavaScript off, shown once the HTML is parsed and the stylesheet loaded. Then a round of clicks, each on a link to the next page: from `/` to `/docs/`, a
benchmark's page, two reference pages, `/` again and a benchmark's page by its name in the
table, and back: each must change the page in place, with no request for it (the chunks the
router then loads ahead for the new page's links are counted apart)
and no new document, to the page the build wrote for that address (the body, compared with
the built file's; hydration keeps the HTML's words without comparing them, so a page the
application would render differently is caught here), with its title and words, the
keyboard focus at the top, its title announced, and no axe violation; back and forward
through them the same, each page scrolled to where it was left; with the keyboard, on the
home page and the glossary, a link
to a place on another page must leave the focus at the place (Tab goes on from it), a link
from there to the same page without the fragment must put it back at the top (Tab starts
from the first link), and a page's own link must bring the page back to its top; after a
visit to an address whose fragment does not decode (`/#%`), clicks, back and clicks again
must still change the page, with no uncaught error; and with JavaScript off each link must
load its page as a new document. The time from each click to the next frame is printed, not
judged. And the documentation's own: Tab from the top of a documentation page reaches the
breadcrumb, "View as Markdown", "Copy page" and the list of pages; "Copy page" puts the page's
Markdown on the clipboard, byte for byte the file the site serves; a link to a heading of
another page lands on the heading, at the top of the window with the focus on it; a click to
a page whose chunk the host refuses, as after a deploy, loads that page as a new document
with no uncaught error; a page opened with its own chunk refused stays the static page it is,
with "View as Markdown" and no "Copy page", each link loading its page as a new document; a
click held for its page's chunk and superseded by another does not come back when the chunk
arrives; and with JavaScript off "Copy page" is not shown and "View as Markdown" is. They took about three and a half minutes on a 4-vCPU machine. `--shots OUT`
also writes each page's first screen and whole page as PNG files.

The built site serves two fonts of one family, Geist Pixel Circle and Geist Pixel Square,
and so carries `third-party-notices.txt`, their copyright and licence (`THIRD-PARTY-NOTICES.md`,
section 3); the pages link it as "Licences".

### The documentation

Every documentation page has one source, a Markdown file, and the site serves both the HTML
rendered from it at build time and the Markdown itself, so the two cannot differ (ADR-0037;
`site/scripts/docs.ts`). The sources, by section, which is the order of the list of pages on
every documentation page, of `/docs/`'s contents and of `llms.txt`:

| Section | Pages | From |
|---|---|---|
| Start here | `/docs/` | `site/content/docs/index.md`, followed by "All pages", every other page with its description; without that file, the contents alone |
| API reference | `/docs/api/` and its eight pages | `scripts/api-reference.ts`, run by the build into a directory of its own and never kept ("The API reference" under "The data API") |
| Benchmarks | `/docs/benchmarks/<name>`, each benchmark `schedule.json` runs, in the home table's order | `benchmarks/<name>/README.md` |
| Machines, Methods, prices and the glossary | `/docs/machines`, `/docs/methods`, `/docs/prices`, `/docs/glossary`, then any other | `docs/machines.md` from the generator; every other `site/content/docs/**.md`, at the address its path gives |

Each source keeps one contract, which the build holds and fails on, naming the file and why:
GitHub-flavoured Markdown (rendered with `marked`, pinned in `site/package.json`, at build time
only), no front matter, no image, no HTML but `<details>` and `<summary>`, the first line
`# Title` and the first block after it a paragraph, the page's description (its `<meta>`, its
line in `/docs/` and in `llms.txt`). `scripts/lib/docs-addresses.ts` lists the documentation's
addresses (the list the generated pages' links are held to): an address it lists with no page
there fails the build, and so does a page at an address it does not list, so a new page is
added there first. Links become the site's own: `/docs/…` and `https://ledgermath.com/docs/…` are
the router's; a `#…` on the same page carries `target="_self"`, the browser's own jump; a
README's relative link to a file of the repository becomes its address on GitHub, on main,
in the served Markdown too, where the relative one would lead nowhere; links to the API stay.
A link is rewritten only where it is a link: an example in code that shows one is served as
written, in the HTML and in the Markdown. The build holds each page's served Markdown to its
HTML (`servedProblems`): the Markdown's links, parsed again, must lead where the HTML's do, one
for one and in order, each read from the address it is served at, and its code spans and blocks
must be the source's, byte for byte; so a link the rewriting misses (a form it does not know,
such as a destination written with an escape) fails the build, naming the link.
A link with no target fails the build: a `/docs/…` address that is no page, a `#…` that is
no heading of its page (headings get GitHub's anchors, which the generated pages link to, a
repeated one numbered `-1`, `-2`), a file the checkout does not have, or an address outside
the site that the site does not link to. A table scrolls in a box of its own, named for its
headings; one whose header row starts empty takes its first column as its rows' headings.

Each page's Markdown is at its address with `.md` added (`/docs/glossary.md`), or `index.md`
in it for an address that ends in a slash (`/docs/index.md`, `/docs/api/index.md`), as the
llms.txt convention has it, and at its own address when the request's `Accept` names
`text/markdown` at full weight (one of its media ranges, in any case, is `text/markdown` with
any parameters but a `q` below 1, `text/markdown; charset=utf-8` among them, a `;` with
nothing after it allowed and no white space around a parameter's `=`, as RFC 9110 writes them;
a media range starts after a comma outside a quoted string, so `text/markdown` inside a
parameter's quoted value is none; `ACCEPTS_MARKDOWN`, which no text can match in two ways, so
that no header makes it slow): the deploy's `config.json` holds a route per page,
read from the built files (`site/deploy/vercel-config.ts`), with `Vary: Accept` on every
answer at a page's address and `Content-Type: text/markdown` on the Markdown, and it refuses
a site with a documentation page that has no Markdown, which would answer an agent with 404.
`/llms.txt` follows the convention (<https://llmstxt.org>, v2): the site's name, what
LedgerMath is (the home page's description), where the numbers are, then each section's
pages, each a link to its Markdown and its description. Every page of the site starts with a
comment for agents saying where the Markdown is, and names `/llms.txt` in its `<head>`; each
documentation page also names its Markdown there (`<link rel="alternate"
type="text/markdown">`, which follows the page after a click).

A documentation page shows the site's header and footer; a breadcrumb ("Docs", which leads
to `/docs/`, and the page's section); "View as Markdown", a plain link to the `.md`, and
"Copy page", which fetches it and puts it on the clipboard, the one control that needs the
application, and so is shown only once the application has taken the page over (the
stylesheet reads `data-hydrated` on `<html>`, which `src/app.tsx` sets; until then its place is
kept, so that nothing moves, and without JavaScript, or on a page whose script could not be
loaded, it is never shown); the page; and the list of
every page by section, beside the page on a wide screen and below it on a narrow one, the
page on screen marked. Headings and chrome are in the site's pixel type; the page's text,
tables and code in the reader's own system fonts, which read easily at length and cost no
file. A long description folds behind its first sentence (`<details>`, which the generated
pages write), with no JavaScript.

The documentation's pages are routes of the application under one layout, `/docs`, which
stays while the reader goes from page to page; each page's body is a `lazy()` component whose
module holds the page's HTML, a chunk of its own (`virtual:ledgermath-docs`, which the build
writes). The server renders with every body loaded and with the browser's build manifest, so
a page's `<head>` asks for its own chunk (`modulepreload`) and hydration imports it before
taking the page over. The router loads the other chunks ahead (`eagerPreload({ all: true })`
and `intentPreload()`): every link's on the page once it has loaded and the browser is idle,
which on a documentation page, whose list links every page, is every chunk (181 KB for 28
pages, 1.4 to 21 KB each), and on the home page the 15 its links lead to (88 KB); and a link's
at once when the pointer rests on it, it takes the focus or a touch starts on it. A reader
whose browser asks to save data (Save-Data, or a 2g connection) is spared the first, and a
click on a link whose chunk has not come yet keeps the page on screen until it has
(ADR-0037, "What is not instant"), unless the reader clicks elsewhere or goes back or forward
meanwhile, when the newer wish stands and the older one is dropped. The page the browser opened
is taken over only once its own chunk has loaded; if it cannot be, the page stays the static
page it is, every link an ordinary link (`src/entry-client.tsx`).

### Where it is deployed

The site is at https://ledgermath.com, hosted on Vercel (project `ledgermath`). Vercel only
hosts files: the site is built in GitHub Actions, and Vercel is handed the finished files.
Two jobs build and deploy production: the `runs` workflow's job `site`, after every publish
of the data API, and `site.yml`'s `deploy-production`, after a push to main that touches
`site/` or `site.yml`. It can also be deployed by hand (below). The
Vercel project has no Git repository connected, and Vercel's build system never runs.

**Kept fresh: rebuilt after every publish** (ADR-0035). The home page's figures are read
when the site is built, so they are only as new as its last build. The `runs` workflow's
third job, `site`, runs after its `publish` job, four times a day (00:05, 06:05, 12:05 and
18:05 UTC, once after each round of boots, "The workflow"), and when the workflow is run by
hand on main; only when `publish` succeeded, not when it failed, was skipped or was
cancelled. It builds the page from what the API bucket holds, by the rule below, runs
`bun run check` against those files, compares the notices, deploys with
`site/deploy/deploy.sh site/dist/client production`, and runs `site/scripts/check-live.ts`.
The deployment records the commit that was checked out, and the summary names the
deployment, the newest Run of the tree it read, and main's commit.

A rebuild takes about a minute. Run by hand on 2026-11-25 against the production API bucket,
stopping before the deploy, the page held 85 figures (70 in the table, 15 in the graphs), no
dash, 20 prices, and three rounds under "Latest runs" (24 Nov 2026 at 22:11, 16:11 and 10:11
UTC, each 5 machines, 187 Runs, 0 failed); its newest Run started 2026-11-24 at 23:07 UTC;
and every one passed `bun run check`.

**The rule: production deploys take turns, and each builds the page from what the API
bucket holds when its turn comes.** The `site` job and `site.yml`'s `deploy-production` hold
one concurrency group, `site-deploy-production` (`queue: max`), each for its whole job: one
runs at a time, a running one is never cancelled, and every one that arrives meanwhile
waits. Inside the group, in this order, each:

1. has the site's sources: the `site` job checks out main as it is now (never its run's
   commit, which main may have left); `deploy-production` deploys its own commit only if
   main has not moved on in the site's files (`site/deploy/fresh.ts`, below);
2. takes AWS credentials with the role the `publish` job uses (`RUNS_AWS_ROLE_ARN`, which
   may read and write the bucket's `v1/*`; these jobs only read). The action gives the keys
   as its outputs, not to the job's environment (`output-env-credentials: false`), and only
   the reading step is handed them, so the build, the checks and the deploy never hold them
   (a test holds that);
3. reads the tree from the bucket `API_BUCKET` names, itself (`scripts/read-api-tree.ts`):
   not `https://api.ledgermath.com`, whose cache can be five minutes behind an upload, and
   not an artifact;
4. builds the site from exactly those bytes, and runs `bun run check` against them;
5. deploys, and checks the live site.

Why that is enough:

- **The page shows what the public API holds.** The bucket is the record of what is
  published: the `publish` job writes it, and the edge serves it. A page built from what the
  bucket held when the job read it shows those files' figures, whatever was run again and
  whichever artifact a job happened to take.
- **The last deploy has the newest tree.** Deploys come one at a time, and each reads the
  bucket afresh, so the last one to run deploys the newest tree there was when it read. A job
  whose turn comes late reads the same bucket and deploys the same page again, which is
  harmless. No job asks whether its tree is the newest: there are no run ids, no artifact
  ids and no reading of GitHub's record of runs (a test holds that none creeps back).
- **The sources catch up.** The `site` job checks out main when its turn starts, and
  `deploy-production` checks then that its commit is still main's site. Neither checks
  again before it uploads, so a job can deploy the site of the commit before main moved;
  the job the newer commit starts, or the next `site` job, waits its turn and deploys after
  it (below).

What it does not cover:

- **What the "one publication" check can see.** While a `publish` job writes, the bucket can
  hold files of two publications (the table of contents is written last). The check
  compares only what the three files say about each other: the table of contents' address
  and the Series list's, the count of Series, the newest Run's start, and the newest price
  file's date. When they disagree, the reader reads them again, up to three times in all,
  ten seconds apart, and then fails, writing nothing; production keeps the build it had. A
  difference it cannot see passes: Runs or boot summaries that arrived late, or a Method's
  figures that changed while all of those stayed the same. The page may then show the newer
  list's figures under the older table of contents' rounds until the next rebuild.
- **An upload that stopped halfway.** If the three files then disagree on something the
  check compares, every deploy fails until the next publish repairs the bucket. If it
  stopped before it changed any of the three, the previous files are still readable, and
  the page is built from them.
- **A publish whose final check failed.** If the upload finished and the `publish` job's own
  last step (the check of the bucket) then failed, the bucket already holds the new tree, but
  no `site` job runs: the page stays on the previous tree until the next successful publish,
  a re-run of a `site` job, or a deploy by hand. The "about a minute" below holds for a
  publish that succeeded.
- **The minute between a publish and its rebuild.** Once a successful `publish` has written
  the bucket, the page shows the tree before until the `site` job deploys, about a minute
  later; the edge itself may serve the previous table of contents for up to five minutes.
- **A deploy by hand from this machine**, which is outside the group (below).

A publish (run N) and a push to main (commit C) that overlap end with ledgermath.com on C's
site and N's tree, whatever the order. N's `site` job starts only after N's upload has
ended, so a deploy that runs after it reads N's tree or a newer one. The last deploy to run
is either C's own, which reads the bucket after any earlier `site` job, or a `site` job whose
turn came after C's deploy, so after C was on main, which checks out C.

So the page reaches production in two ways, and both go through the group:

- **After every publish that succeeds**, the `runs` workflow's `site` job (publishes are
  scheduled four times a day), and when `runs.yml` is run by hand on main. When its turn
  comes, it checks out main as it is then.
- **After a push to main that touches `site/` or `site.yml`**, `site.yml`'s
  `deploy-production`, and when `site.yml` is run by hand on main. When its turn comes, it
  checks with `site/deploy/fresh.ts` that main has not moved on in the site's files since
  its commit, and skips the deploy if it has.

The group gives one thing: the jobs run one at a time, so their uploads never overlap, and
none is cancelled. Each job checks main once, when its turn starts, and not again before it
uploads. If main moves on in between, the job deploys the site of the commit before. The
push that moved main, if it touched `site/` or `site.yml`, started its own
`deploy-production`, which waits its turn and then puts the newer site up; otherwise the
next `site` job does. Each job reads the bucket
when its turn comes, so the last deploy to run has the newest tree the bucket held when it
read it. A change to main outside `site/` and `site.yml` (`scripts/read-api-tree.ts`, say)
starts no deploy. It reaches ledgermath.com with the next rebuild that succeeds: rebuilds
follow the publishes, which are scheduled every six hours, and GitHub may start a scheduled
run late. To deploy it sooner, deploy by hand (below).

**Reading the bucket.** `bun scripts/read-api-tree.ts --bucket NAME --out DIR` starts at
`v1/index.json` and reads only the keys the table of contents' links give for the files the
page needs, the Series list and the newest price file: each link must be under the table of
contents' own address and a plain path to a JSON file under `v1/`, and that path is the key;
it never builds one. Each read is one signed `GET` (`S3ApiStore.read`,
`scripts/lib/api-upload.ts`), within 30 seconds and under its file's size limit, with the
keys in the environment, following no redirect: a 3xx is a refusal, since the key was
checked and an address S3 points to was not. The three files must be of one publication (the
check and the retry of `site/scripts/fetch-tree.ts`, which it reuses), and it writes them all
or none, into a new directory. When it fails, it names the file, the refused field, the key,
the HTTP status and S3's error code from a closed list: never a value refused from a file
(an address can carry a signature) and never S3's own message, which are not ours to print
in a public log. `tests/read-api-tree.test.ts` holds it to that against a stand-in for S3:
the ordinary case, two publications cured by a retry and not cured, a missing key, a refused
key, a body that never ends and an answer that never comes, a file over its limit, a link
that leaves `v1/`, a redirect (refused, its address never asked), and marker text in a
refused address and in S3's message, which reaches neither stdout nor stderr.

**When a rebuild fails.** The `site` job fails, red, and its last step names the step that
failed, in an error at the top of the run's page and in the job's summary, and says what
ledgermath.com serves. A failure before the deploy step (the packages, the credentials,
reading the bucket, the build, `bun run check`, the notices, the Vercel CLI) leaves
production on the build it had.
A failure of the deploy step itself is not confirmed either way: `deploy.sh` calls Vercel
with `--prod` and only then reads and checks the receipt, so production may already serve
the new deployment; the notice says so, and to look at the project's deployments in Vercel.
A failure after a deploy step that succeeded (reading the deployment's URL, the live check)
cannot undo the deploy, and says that the new build is served. The next publish rebuilds
from scratch; to rebuild sooner, re-run the failed job, which reads the bucket afresh.
Nothing tells the maintainer beyond the red run and GitHub's own failed-run e-mail (#87).
The first job, its caches and `publish` are untouched by it.

`site.yml`'s deploy jobs run after its build job has passed, `bun run check` included. The
preview job, `deploy-preview`, takes the `site` artifact that job uploaded (built from the
public API's tree) and builds nothing. The production job, `deploy-production`, does not
take it: it builds again inside the group, from the bucket, by the rule above. Both deploy
with `site/deploy/deploy.sh`: that lays the files out as Vercel's Build Output API asks
(`.vercel/output/static`, and a `config.json` of version 3 with the routes that serve each
documentation page's Markdown to `Accept: text/markdown`, which `site/deploy/vercel-config.ts`
writes from the files, with Bun) in a temporary directory, and runs `vercel deploy --prebuilt`
on it. The Vercel CLI is pinned in `site/deploy/package.json` and its `bun.lock`, apart from
the site's own packages.

- A push to main, or a run by hand on main, deploys production: ledgermath.com moves to
  the new deployment. The job then checks the live site (`site/scripts/check-live.ts`) and
  fails unless each answer is 200, without a redirect, of its type: https://ledgermath.com/
  with each of its fixed words (`site/src/pages.text.ts`) in its HTML outside any script, the
  same test `bun run check` makes of the built files; https://ledgermath.com/docs/index.md,
  as `text/markdown`; https://ledgermath.com/docs/ with the header's and footer's words and
  that Markdown's title and description; the same address asked for with
  `Accept: text/markdown`, which must give the Markdown, with `Vary: Accept`; and `/llms.txt`.
  So the live pages are this site's, read with JavaScript off, and the host serves the
  Markdown. It looks for the fixed words, not the figures, which change with every tree.

  Production deploys run in the job `deploy-production`; its jobs, one per run, share one
  concurrency group with each other and with the `runs` workflow's `site` job (above): one
  runs at a time, and a running one is never cancelled, so no
  upload is cut off. A job that arrives while another runs waits, and the group keeps
  every waiting job (`queue: max`; GitHub's default keeps one, and the next arrival
  cancels it), so none is dropped. GitHub runs the waiting jobs one by one, roughly in the
  order they began waiting; it does not promise that order. Up to 100 can wait; GitHub
  cancels any beyond that. Jobs arrive in the order their builds finish, not the order of
  their commits, and a re-run of an old run arrives whenever it is started, still with its
  old commit. So before calling Vercel, each production job checks out main as it is then
  (all its commits and trees, and of its files only the workflow) and runs
  `site/deploy/fresh.ts`: the deploy goes ahead only if the run's commit is on main and
  nothing under the paths that start the workflow on a push (`site/**` and the workflow
  itself, read from the workflow's `on.push.paths`) differs between that commit and main's
  tip. Otherwise the job skips the deploy and the live check, passes, and says in the
  run's summary that main has moved on (or that the commit is not on main), naming both
  commits. A newer commit that changed those paths started a run of its own, whose job
  waits in the same group and deploys after this one, or already has; a newer commit that
  changed nothing under them started none, and then the older run's site is main's site
  and it deploys. If git itself fails in the check (a corrupt object, say), the job fails
  rather than skip. When the sources are current, the job takes the role, reads the bucket,
  and builds and checks the site from it, as the `site` job does (above). So:

  - two pushes close together: ledgermath.com ends on the newer commit's site. The older
    commit's job skips if the newer commit is on main when it starts, which it always is
    when the newer job ran first; if the older job starts first and deploys, the newer
    one deploys after it;
  - three runs, A deploying, then C (the newest commit) and B (an older one whose build
    finished last) waiting: both wait, each takes its turn, B skips and C deploys, in
    either order;
  - a re-run of an old production run skips, unless main's site has not changed since,
    when it deploys the same site again;
  - a run by hand on main deploys main's tip, unless main moves on while it builds;
  - a run whose commit is no longer on main (main was force-pushed past it) skips.

  Main's site is deployed by the run of the commit that last changed it, and again by
  every publish's rebuild. If that run's build fails, someone cancels it, or it never
  starts (a push that skips CI), ledgermath.com stays on an older site while every older
  run's job skips, until the next publish's rebuild; run the workflow by hand on main to
  deploy main's tip sooner.
- A pull request from a branch of this repository, or a run by hand on another branch,
  gets a preview deployment from the job `deploy-preview`, which ledgermath.com does not
  serve. A newer push cancels the preview before it.
- A pull request from a fork is not given the repository's secrets, so its run skips
  `deploy-preview` and still passes. The workflow uses `pull_request`, never
  `pull_request_target`, and the token is set only in the deploy step of a job that runs
  for this repository's own branches, so no code from a fork runs where the token is. No
  pull request gets AWS credentials either: only `deploy-production`, on main, asks for an
  OIDC token, and the role trusts main alone (`infra/runs/github-role.ts`).

So a pull request from a fork runs only the `build` job, with a read-only GitHub token and
no repository secret: no AWS credential and no Vercel token. `deploy-production` never runs
for a pull request, and `deploy-preview` runs only when the pull request's head is a branch
of this repository. Such a pull request gets the Vercel token in its preview's deploy step,
and never the AWS role.

The job writes the deployment's URL to the run's summary. Preview URLs need a Vercel login
(the project's Vercel Authentication covers every deployment URL; only the custom domain is
public), so CI checks only production.

The workflows need, in the repository's settings:

| Name | Kind | What it is |
|------|------|------------|
| `VERCEL_TOKEN` | secret | A Vercel token scoped to the project `ledgermath` alone; it expires on 2027-11-18 |
| `VERCEL_ORG_ID` | variable | The ID of the Vercel team that owns the project |
| `VERCEL_PROJECT_ID` | variable | The project's ID |

Only deploy steps see them: in `runs.yml`, the `site` job's deploy step; in `site.yml`, the
deploy step of each of its two deploy jobs. `tests/runs-workflow.test.ts` reads every file
under `.github` and fails on a reference anywhere else, on secrets handed over whole
(`secrets: inherit`, `toJSON(secrets)`), and on `runs.yml` being started by a pull request.
The production deploys also read the variables `RUNS_AWS_ROLE_ARN` and `API_BUCKET`, which
`runs.yml` already uses ("The workflow").

**What `site.yml`'s production deploy relies on.** In AWS, the role, which trusts any
workflow of this repository on `refs/heads/main` (the OIDC token's `sub`,
`infra/runs/github-role.ts`), which `deploy-production` is (a push to main, or a run by hand
on main), and which may read the bucket's `v1/*`. In GitHub, the workflow enabled, and the
repository variables it reads, which `runs.yml` reads too. If the role's trust is
ever narrowed to `runs.yml` alone (by `job_workflow_ref`), `deploy-production` must be
added to it, or production deployed by a re-run of the `site` job instead.

The Vercel CLI reads all three from the environment, so nothing runs `vercel login` or
`vercel link`. Nor does anything run `vercel pull`: it fetches the project's settings and
environment variables for a build, and this site is built without either.

**To deploy by hand.** The safe way goes through the queue: re-run the `site` job of any run
of `runs.yml` on main whose `publish` job succeeded (the run's page, "Re-run jobs"). It
reads the bucket afresh and deploys main's site by the rule above, whichever run it was.
(Running `runs.yml` by hand on main does the same after a whole pass of copying, deriving
and publishing.) A deploy from this machine with `site/deploy/deploy.sh` is outside the
queue: make it only while no production deploy of either workflow is running or waiting,
from a tree read from the bucket just before, or it can put an older tree over a newer one
until the next publish. With the three Vercel values in the environment:

```bash
# The tree as the bucket holds it, into a directory that does not exist yet, with the
# production account's keys in a subshell, so this shell keeps none (the bucket is the
# scheduled stage's apiBucket output, the repository variable API_BUCKET). Or
# `(cd site && bun run fetch-tree /path/to/new-tree)`, the tree the API serves now, which can
# lag a publish by five minutes.
bun install --frozen-lockfile   # the root's packages: the tree's reader, and the API reference's generator, which the build runs
( eval "$(aws configure export-credentials --profile tabot-production --format env)" && bun scripts/read-api-tree.ts --bucket "$API_BUCKET" --out /path/to/new-tree )
cd site
bun install --frozen-lockfile
export LEDGERMATH_TREE=/path/to/new-tree
bun run typecheck && bun test && bun run build && bun run check
cmp public/third-party-notices.txt dist/client/third-party-notices.txt
cd ..
(cd site/deploy && bun install --frozen-lockfile)
site/deploy/deploy.sh site/dist/client preview      # or production
(cd site && bun scripts/check-live.ts)              # after production: / and /docs/ are this site's, and the Markdown is served
```

It prints the deployment as JSON; `.url` is its URL. It needs `jq`, and checks for it
before the CLI runs. It fails, saying what was wrong, unless the CLI printed exactly one
deployment object, READY, whose `url` is an absolute `https://` URL; with `production`, that
check comes after Vercel has been asked to move production, so a failure there does not mean
nothing was deployed. The deployment records, as its `commit`, the commit of the checkout
`deploy.sh` is in (`GITHUB_SHA` only outside a git checkout): the `site` job checks out
main, which can be newer than its run's commit.

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
STAGE=production-runs              # the scheduled stage, whose bucket holds the binaries (smr-runs before 2026-11-19)
PROFILE=tabot-production           # smr-runs: tabot-dev
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
