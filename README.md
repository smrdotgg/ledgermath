# ledgermath

LedgerMath is a server benchmarking tool. A benchmark is one statically linked native
binary that prints a stream of events to stdout, one JSON object per line, and
diagnostics to stderr. A box on EC2 builds it, runs it as an ordinary process, dumps
its own environment around every execution, and writes one Run per execution: a
self-describing record kept forever. The plan is GitHub issue #36; step 2, one Run end
to end, is #37. `docs/dev-log.md` section 2 is the event contract.

Two pipelines live here side by side. The new one, described first, writes Runs.
July's proof of concept (`benchmarks/c/`, its own JSON format) keeps running unchanged
until step 4 of the plan replaces it.

## Layout

| Path | What it is |
|------|------------|
| `benchmarks/harness/c/` | The C harness that prints the event stream |
| `benchmarks/memory_read/` | The first benchmark on the stream, with a `Makefile` (`make BUILD=static`, `BUILD=dynamic`, `make -s compiler`, `make -s resolved`) |
| `schedule.json` | What a box runs: benchmarks, builds, samples, timeout, parameter sets |
| `runner/` | The box side: `box.sh` (user-data), `run.py` (builds, runs, dumps, writes Runs), `cpuid.c` |
| `schemas/` | `run.schema.json` (the Run) and `events.schema.json` (one line of the stream) |
| `scripts/check-events.py` | Checks a stream's order; needs only Python 3 |
| `scripts/check-runs.ts` | Checks a directory laid out like the bucket: schemas, every hash, events against stdout, runner manifests |
| `scripts/box-in-container/` | Boots `runner/box.sh` in Amazon Linux 2023 with S3 and shutdown stubbed, in several scenarios |
| `infra/runs/` | The `-runs` SST stage: stack, launch Lambda, reaper, user-data |
| `tests/` | `bun test`: the schemas against sample Runs, the Run checker, the runner's timeout and stop races, and the launch and reap logic |

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

## Tests

```bash
bun install
bun test
```

`.github/workflows/check.yml` runs the tests and builds `memory_read`, then runs the static
build with `--quick` as the only file in a `FROM scratch` container and checks its stream.
No measured Run goes through Docker.

To boot the box script the way a box does, in `amazonlinux:2023.12.20260710.0` (the
release the pinned image is locked to), with the bucket as a local directory:

```bash
scripts/box-in-container/run.sh /tmp/box-test                           # HEAD, whole schedule
scripts/box-in-container/run.sh --worktree /tmp/box-test                # uncommitted changes
scripts/box-in-container/run.sh --scenario terminated /tmp/box-test     # see below
```

Each scenario boots the box and checks what it should have left
(`scripts/box-in-container/expect.ts`): `ok` (the whole schedule, about five minutes),
`terminated` (run.py told to stop mid-execution), `shutdown` (every process told to stop,
as a shutdown does), `budget` (the time budget runs out), `blobs-rejected` (the bucket
refuses every blob), `blobs-flaky` (the first upload of blobs drops halfway) and
`blobs-present` (the bucket already holds a blob the boot makes). The
Runs describe this machine, seen from a container.

## The daily box: a `-runs` stage

Any SST stage whose name ends in `-runs` deploys `infra/runs/stack.ts`. Every other stage
deploys July's stack, below, unchanged.

Once a day at **22:10 UTC**, an hour before July's run, a Lambda launches one
`c6i.8xlarge` from `ami-03499a87bbb39a09a` (Amazon Linux 2023.12.20260710.0, the image
July has used since 2026-07-18) in `us-east-2c`. The Lambda is never retried, Lambda
drops the invocation if it waited in Lambda's queue for more than a minute, and the
handler refuses a scheduled launch more than ten minutes after its scheduled time, so a
late box cannot overlap July's. A scheduled launch's EC2 client token comes from the
stage and the scheduled time, so one slot can start at most one box. Its user-data is
`runner/box.sh`, which:

1. sets a shutdown timer that ends the box 45 minutes after it started, whatever happens;
2. installs `gcc`, `make`, `glibc-static`, `tar`, `gzip` and `util-linux` from the image's
   own release;
3. fetches `source/<commit>.tar.gz`, a `git archive` of the deployed commit, and refuses to
   go on if the archive's commit or its own text is not that commit's;
4. builds `runner/cpuid.c` and runs `runner/run.py` until 35 minutes after the box
   started. `run.py` builds every benchmark in `schedule.json` both static and dynamic and
   writes one Run per execution. At 35 minutes it is sent TERM: it kills the binary it is
   running, still writes that execution's Run, starts nothing more, writes the boot
   summary, which lists what was not run, and exits. If it has not exited three minutes
   later, it is killed outright;
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
- There is no boot at all when the launch is refused (late, or a duplicate of its slot),
  waits in Lambda's queue for more than a minute, or fails. The launch function's log says
  which.

### Deploy

```bash
aws sso login --profile tabot-dev
bun install
git status                        # must be clean (sst-env.d.ts aside): a deploy refuses a tree that differs from HEAD
bunx sst deploy --stage smr-runs  # the stage uses profile tabot-dev in us-east-2
git checkout -- sst-env.d.ts      # SST rewrites it for the stage; the committed one is July's
```

The stage's outputs (bucket, launch function, commit) are printed and written to
`.sst/outputs.json`. Deploying a new commit is the only way the box's source changes.

### Trigger a boot by hand, and watch it

Two 32-vCPU runners and the dev machine exceed the 64-vCPU quota. A box that fails to end
itself lives until the reaper finds it, up to 55 minutes, so do not launch a `c6i.8xlarge`
by hand between 21:15 and 23:30 UTC, when it could overlap the scheduled box or July's. A
smoke test can name a smaller type, which fits beside either; its Runs are real Runs of
that type. A launch by hand gets a fresh client token each time.

```bash
export AWS_PROFILE=tabot-dev AWS_REGION=us-east-2
FN=$(jq -r .launchFunction .sst/outputs.json)
BUCKET=$(jq -r .bucket .sst/outputs.json)

aws lambda invoke --function-name "$FN" --cli-binary-format raw-in-base64-out \
  --payload '{"instanceType": "c6i.large"}' /tmp/launch.json && cat /tmp/launch.json
# or --payload '{}' for the configured c6i.8xlarge

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
