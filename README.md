# ledgermath

LedgerMath is a server benchmarking tool. A benchmark is one statically linked native
binary that prints a stream of events to stdout, one JSON object per line, and
diagnostics to stderr. A box on EC2 builds it, runs it as an ordinary process, dumps
its own environment around every execution, and writes one Run per execution: a
self-describing record kept forever. The plan is GitHub issue #36; step 2, one Run end
to end, is #37; step 3, the first Method and a page, is #39. `docs/dev-log.md` section 2
is the event contract.

Two pipelines live here side by side. The new one, described first, writes Runs.
July's proof of concept (`benchmarks/c/`, its own JSON format) keeps running unchanged
until step 4 of the plan replaces it.

## Layout

| Path | What it is |
|------|------------|
| `benchmarks/harness/c/` | The C harness that prints the event stream |
| `benchmarks/<name>/` | One benchmark on the stream: its source, a `README.md` (what it measures, its parameters and observed values, how it differs from July's), and a `Makefile` (`make BUILD=static`, `BUILD=dynamic`, `make -s compiler`, `make -s resolved`). Eight so far: `memory_read`, `compressed_memory_read`, `memory_read_random`, `memory_write`, `syscall`, `hash`, `sort`, `tcp_echo` |
| `schedule.json` | The targets (instance types, their zone, the times of day each boots) and what a box runs: benchmarks, builds, samples, timeout, parameter sets, and the instance types an entry is for. Checked by `infra/runs/schedule.ts` |
| `runner/` | The box side: `box.sh` (user-data), `run.py` (builds, runs, dumps, writes Runs), `cpuid.c` |
| `schemas/` | `run.schema.json` (the Run) and `events.schema.json` (one line of the stream) |
| `scripts/check-events.py` | Checks a stream's order; needs only Python 3 |
| `scripts/check-runs.ts` | Checks a directory laid out like the bucket: schemas, every hash, events against stdout, runner manifests |
| `scripts/box-in-container/` | Boots `runner/box.sh` in Amazon Linux 2023 with S3 and shutdown stubbed, in several scenarios |
| `infra/runs/` | The `-runs` SST stage: stack, launch Lambda, reaper, user-data, the schedule's check (`schedule.ts`), the targets and their launch schedules (`placement.ts`), the workflow's AWS role |
| `methods/` | Methods, versioned: `v1/` turns Runs into Derivations (`methods/README.md`) |
| `scripts/copy-runs.ts` | The copy job: the bucket's Run files and boot summaries into the Runs repository |
| `scripts/derive.ts`, `scripts/build-page.ts` | Run a Method over the Runs; turn its Derivations into the page |
| `scripts/alarm.ts` | Opens, or comments on, one issue when a watched Series has had no Run for 48 hours |
| `.github/workflows/runs.yml` | All four on a schedule: copy, push, derive, page, alarm |
| `tests/` | `bun test`: the schemas against sample Runs, the Run checker, the schedule's check, the runner's timeout and stop races and its instance-type filtering, the launch schedules, launch and reap logic, the role, the Method, the copy job, the page, the alarm and the workflow |

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
stream. It then shows that the same container refuses `memory_read`'s dynamic build. No
measured Run goes through Docker.

To boot the box script the way a box does, in `amazonlinux:2023.12.20260710.0` (the
release the pinned image is locked to), with the bucket as a local directory:

```bash
scripts/box-in-container/run.sh /tmp/box-test                           # HEAD, whole schedule
scripts/box-in-container/run.sh --worktree /tmp/box-test                # uncommitted changes
scripts/box-in-container/run.sh --scenario terminated /tmp/box-test     # see below
```

Each scenario boots the box and checks what it should have left
(`scripts/box-in-container/expect.ts`): `ok` (the whole schedule, about seven minutes),
`terminated` (run.py told to stop mid-execution), `shutdown` (every process told to stop,
as a shutdown does), `budget` (the time budget runs out), `blobs-rejected` (the bucket
refuses every blob), `blobs-flaky` (the first upload of blobs drops halfway),
`blobs-present` (the bucket already holds a blob the boot makes) and `instance-types`
(a fake IMDS says the box is an `m5.large`, and the box boots
`scripts/box-in-container/instance-types.json` as its schedule: the entries for other
types are left out and listed in the boot summary, about a minute). The Runs describe
this machine, seen from a container; in `instance-types` their provider fields are the
fake IMDS's.

## The daily box: a `-runs` stage

Any SST stage whose name ends in `-runs` deploys `infra/runs/stack.ts`. Every other stage
deploys July's stack, below, unchanged.

`schedule.json` names the targets: an instance type, its zone, and the times of day,
UTC, it boots. Today there are five, all in `us-east-2c`, four boots a day each:

| Type | vCPUs | Boots (UTC) |
|------|-------|-------------|
| `c6i.8xlarge` | 32 | 04:10, 10:10, 16:10, 22:10 |
| `m5.large` | 2 | 04:20, 10:20, 16:20, 22:20 |
| `c8i.2xlarge` | 8 | 04:30, 10:30, 16:30, 22:30 |
| `c8a.2xlarge` | 8 | 04:40, 10:40, 16:40, 22:40 |
| `i4i.2xlarge` | 8 | 04:50, 10:50, 16:50, 22:50 |

The stage makes one EventBridge schedule per target, a cron listing its boot times (for
`c6i.8xlarge`, `cron(10 4,10,16,22 * * ? *)`), and every schedule invokes the one launch
Lambda with the scheduled time and the instance type. The Lambda launches one box of that
type from `ami-03499a87bbb39a09a` (Amazon Linux 2023.12.20260710.0, the image July has
used since 2026-07-18). The Lambda is never retried, Lambda drops the invocation if it
waited in Lambda's queue for more than a minute, and the handler refuses a scheduled
launch more than ten minutes after its scheduled time, so a late box cannot overlap boots
the schedule keeps apart, and refuses a scheduled launch of a type that is not a target.
A scheduled launch's EC2 client token comes from the stage, the instance type and the
scheduled time, so one slot of one target can start at most one box. Its user-data is
`runner/box.sh`, which:

1. sets a shutdown timer that ends the box 45 minutes after it started, whatever happens;
2. installs `gcc`, `make`, `glibc-static`, `tar`, `gzip` and `util-linux` from the image's
   own release;
3. fetches `source/<commit>.tar.gz`, a `git archive` of the deployed commit, and refuses to
   go on if the archive's commit or its own text is not that commit's;
4. builds `runner/cpuid.c` and runs `runner/run.py` until 35 minutes after the box
   started. `run.py` reads the box's instance type from IMDS and runs the entries of
   `schedule.json` for it: every entry without `instance_types`, and every entry whose
   `instance_types` names it. It builds each of their benchmarks once, in each build the
   schedule names (`memory_read` static and dynamic, the others static), and writes one
   Run per execution. At 35 minutes it is sent TERM: it kills the binary it is running, still
   writes that execution's Run, starts nothing more, writes the boot summary, which lists
   what was not run, and exits. If it has not exited three minutes later, it is killed
   outright;
5. uploads the blobs the bucket does not hold yet, then the Runs and the boot summary, then
   its log, and shuts down, which terminates the instance.

The stage's bucket is versioned, so a second write to a key keeps the first. It ends up
holding:

```
runs/<yyyy>/<mm>/<dd>/<id>.json      one Run (schemas/run.schema.json)
blobs/sha256/<hex>                   every blob a Run cites: binaries, dumps, stdout, stderr
boots/<yyyy>/<mm>/<dd>/<boot>.json   what one boot ran, and what it did not
logs/<yyyy>/<mm>/<dd>/<boot>.log     the box's log
source/<commit>.tar.gz               the deployed source
```

A reaper runs every five minutes and terminates any box of the stage older than 50
minutes. It touches nothing else; July's reaper cannot touch these boxes either.

### Targets, boot times, and which types an entry runs on

To add a boot time, add it to the target's `boots_utc`. To add a target, add
`{ "instance_type": ..., "zone": "us-east-2c", "boots_utc": [...] }` to `targets`. To run a
benchmark entry on some types only, give it `"instance_types": [...]`; without it, it runs
on every target. Two entries may have the same `name`, so one benchmark can run different
parameter sets on different types:

```json
{ "name": "mutex", "builds": ["static"], "samples": 10, "timeout_seconds": 180,
  "params": [{ "threads": 1, "placement": "one_cpu" }] },
{ "name": "mutex", "builds": ["static"], "samples": 10, "timeout_seconds": 180,
  "instance_types": ["c6i.8xlarge", "c8i.2xlarge"],
  "params": [{ "threads": 2, "placement": "distinct_cores" }] }
```

Then `bun test`, commit, and deploy: the stage's schedules change only with a deploy, and
a deploy stops if `schedule.json` fails its check (`infra/runs/schedule.ts`). The check
refuses: a malformed target or time; a time listed twice for one target; a type listed as
two targets; targets in more than one zone (the stage launches into one subnet); an
`instance_types` value that is not a target's type; a key it does not know (so a
misspelt `instance_types` cannot silently mean every type); the same parameter set twice
for one benchmark, build and type; and, while July's pipeline runs, a `c6i.8xlarge` boot
from 22:20 to 23:40 UTC, so it never overlaps July's 23:10 box (that rule goes when July's
pipeline is retired). A target's boots usually share one minute past the hour and so make
one schedule; boots at other minutes get a schedule each, named by the minute
(`BoxLaunchC6i8xlargeAt10`).

Mind the account's 64-vCPU quota. A box lives at most 55 minutes (the reaper's 50 plus
its five-minute interval), so the boots from HH:10 to HH:50 can all be up from HH:50 to
HH+1:05: the five targets' 58 vCPUs and the dev machine's 4 make 62. July's 32-vCPU box
starts at 23:10, while the small types' 26 vCPUs booted from 22:20 may still be up: 62
again, which is why no `c6i.8xlarge` boots from 22:20 to 23:40 while July's pipeline runs.

A boot's summary (`boots/<yyyy>/<mm>/<dd>/<boot>.json`) accounts for every execution the
schedule names: `runs`; `not_run`, told to stop before starting it; `build_failures`, a
build that failed, whose executions did not run; and `left_out`, each execution of an
entry for other instance types, with the `instance_types` it is for. A box whose type
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
aws sso login --profile tabot-dev
bun install
git status                        # must be clean (sst-env.d.ts aside): a deploy refuses a tree that differs from HEAD
bunx sst diff --stage smr-runs    # what the deploy would add, change and delete; changes nothing
bunx sst deploy --stage smr-runs  # the stage uses profile tabot-dev in us-east-2
git checkout -- sst-env.d.ts      # SST rewrites it for the stage; the committed one is July's
```

The stage's outputs (bucket, launch function, every target with its boot times and its
schedules' cron expressions and payloads, commit) are printed and written to
`.sst/outputs.json`. Deploying a new commit is the only way the box's source, or the
schedules, change. Avoid deploying within ten minutes of a boot time: a schedule the
deploy creates, changes or removes could miss its slot, and while an old schedule and its
replacement both exist, one slot could launch twice.

### Trigger a boot by hand, and watch it

A launch by hand names its instance type, any type, target or not; there is no default.
It has no scheduled time, so it is never refused as late or as not a target, and it gets
a fresh client token each time. Its Runs are real Runs of that type, and its box runs
the entries of `schedule.json` for that type: every entry without `instance_types`, and
those whose `instance_types` name it.

Mind the quota. A box that fails to end itself lives until the reaper finds it, up to 55
minutes. A 2-vCPU type such as `c6i.large` fits at any time (the worst moment holds 62 of
64 vCPUs). Anything larger can meet the quota from HH:10 to HH+1:45 for HH = 04, 10, 16
and 22, when the scheduled boxes may be up; a 32-vCPU type also from 23:10 until July's
box has ended, while July's pipeline runs.

```bash
export AWS_PROFILE=tabot-dev AWS_REGION=us-east-2
FN=$(jq -r .launchFunction .sst/outputs.json)
BUCKET=$(jq -r .bucket .sst/outputs.json)

aws lambda invoke --function-name "$FN" --cli-binary-format raw-in-base64-out \
  --payload '{"instanceType": "c6i.large"}' /tmp/launch.json && cat /tmp/launch.json
# any type: '{"instanceType": "i4i.2xlarge"}'; a payload without instanceType is an error

aws ec2 describe-instances --filters Name=tag:ledgermath-stage,Values=smr-runs \
  --query 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name,LaunchTime]' --output table
aws ec2 get-console-output --instance-id <id> --latest --output text | tail -40

aws s3 ls "s3://$BUCKET/logs/" --recursive
aws s3 cp "s3://$BUCKET/logs/<yyyy>/<mm>/<dd>/<boot>.log" -
```

### Check what a boot left

```bash
aws s3 sync "s3://$BUCKET" /tmp/runs-bucket --exclude 'source/*' --exclude 'logs/*'
bun scripts/check-runs.ts /tmp/runs-bucket
```

The source archive is also in `blobs/` (a Run's `source`), so this checks every Run's
runner manifest against it too.

## The Runs repository, the Method and the page

Step 3 (#39). The Run files and boot summaries are copied, byte for byte and under the
same paths, into the private repository `smrdotgg/ledgermath-runs`; blobs stay in the
bucket and are fetched by hash when needed. Method version 1 (`methods/README.md`) turns
the Runs into a file of Derivations, one per Series. The page is one static HTML file
built from that file: one chart per Series, every point a link to its Run file in the
Runs repository, percentiles with the number of Runs behind them, groups by colour and
shape, failed Runs as crosses, and what differed between consecutive Runs. It opens from
disk with no network. Until step 7 it is a build artifact, not hosted.

### Locally

```bash
export AWS_PROFILE=tabot-dev AWS_REGION=us-east-2
eval "$(aws configure export-credentials --format env)"   # Bun's S3 client reads keys from the environment
BUCKET=$(jq -r .bucket .sst/outputs.json)                 # or: aws s3 ls | grep ledgermath-smr-runs

git clone git@github.com:smrdotgg/ledgermath-runs.git /tmp/ledgermath-runs
git -C /tmp/ledgermath-runs remote set-url --push origin no-push   # a scratch clone pushes nowhere

# The copy job: adds what the bucket has and the clone does not; a second run adds nothing.
# It stops, writing nothing, if a file already in the clone differs from the bucket's (an
# ETag that is not the file's MD5 is settled by downloading and comparing the bytes), if a
# key is not shaped like a Run file or boot summary, or if any path passes through a
# symbolic link. Each file is created exclusively, so one that appears meanwhile stops it
# rather than being overwritten.
bun scripts/copy-runs.ts --bucket "$BUCKET" /tmp/ledgermath-runs

# The Method, with blobs fetched by hash and kept in a cache.
bun scripts/derive.ts --runs /tmp/ledgermath-runs --bucket "$BUCKET" --cache /tmp/blob-cache \
  --out /tmp/page/derivations.json

# The page.
bun scripts/build-page.ts /tmp/page/derivations.json /tmp/page/index.html

# The alarm, posting nothing; --now sets the clock, --copy says whether the copy job worked,
# --schedule-changed-at says when main last changed schedule.json.
bun scripts/alarm.ts --runs /tmp/ledgermath-runs --copy succeeded --dry-run --now 2026-11-13T00:00:00Z \
  --schedule-changed-at "$(git log -1 --first-parent --format=%cI origin/main -- schedule.json)"
```

Without AWS, the samples are a directory of Runs with their blobs:

```bash
bun scripts/derive.ts --runs tests/samples/scheduled --blobs tests/samples/scheduled/blobs --out /tmp/samples.json
bun scripts/build-page.ts /tmp/samples.json /tmp/samples.html
```

The same Runs and blobs give the same Derivations, byte for byte, whatever the blobs come
from, so a Derivation is checked by computing it again and comparing with `cmp`.

### The workflow

`.github/workflows/runs.yml` runs at 22:40 UTC (half an hour after the 22:10 boot), every
six hours, and by hand (`workflow_dispatch`), one run at a time. It checks out this
repository with its whole history (for the alarm's `--schedule-changed-at`), takes AWS
credentials through OIDC, checks out `smrdotgg/ledgermath-runs` with the deploy key,
runs the copy job, commits and pushes what it added, runs the Method, builds the page,
uploads the page and the Derivations as the artifact `page`, and runs the alarm with the
workflow's own token. The alarm runs even when an earlier
step failed, as long as the Runs repository was checked out, and is told whether the copy
and its push succeeded on this pass.

It needs:

| Where | Name | What it holds |
|-------|------|---------------|
| Variable | `RUNS_AWS_ROLE_ARN` | The stage's output `runsReaderRole` (`jq -r .runsReaderRole .sst/outputs.json` after a deploy) |
| Variable | `RUNS_BUCKET` | The stage's output `bucket`, the bucket's name |
| Secret | `RUNS_REPO_DEPLOY_KEY` | The private half of an SSH key whose public half is a deploy key of `smrdotgg/ledgermath-runs` **with write access** (it pushes) |

For the key: `ssh-keygen -t ed25519 -N '' -C ledgermath-runs-copy -f runs-deploy-key`,
add `runs-deploy-key.pub` under the Runs repository's Settings → Deploy keys with
"Allow write access", put the contents of `runs-deploy-key` in the secret, and delete
both files. The alarm needs nothing more: the workflow asks for `issues: write`.

The role comes with the stage. A deploy of a `-runs` stage creates GitHub's OIDC provider
for `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`; an account holds
one per URL, so only one `-runs` stage per account can create it) and the role
`RunsReaderRole`, which only workflows of `smrdotgg/ledgermath` on `refs/heads/main` can
assume and which may list the bucket and read `runs/*`, `boots/*` and `blobs/*`, nothing
else (`infra/runs/github-role.ts`). A workflow started from another branch cannot assume
it.

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

## July's pipeline (`benchmarks/c/`, stage `smr`)

Each `benchmarks/c/bench_<name>.c` is a standalone benchmark that links the shared harness
(`harness.c` / `harness.h`) and prints a JSON array of results.

```bash
make -C benchmarks/c           # build every bench_*.c
make -C benchmarks/c quick     # build + run all, smaller buffers/fewer samples (dev)
make -C benchmarks/c run       # build + run all, full samples
```

Once a day at **23:10 UTC** EventBridge Scheduler invokes a Lambda that launches a
`c6i.8xlarge`. The instance builds `benchmarks/c`, runs `run-all.sh`, uploads JSON to S3,
and terminates itself.

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
