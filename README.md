# ledgermath

LedgerMath is a server benchmarking tool. Benchmarks are small native binaries that each
print a JSON array of results to stdout; diagnostics go to stderr. See
`docs/dev-log.md` for the north star, the output contract, and the migration roadmap.

## C benchmarks

Each `benchmarks/c/bench_<name>.c` is a standalone benchmark that links the shared harness
(`harness.c` / `harness.h`) and builds to its own binary at `benchmarks/c/build/<name>`.

```bash
make -C benchmarks/c           # build every bench_*.c
make -C benchmarks/c quick     # build + run all, smaller buffers/fewer samples (dev)
make -C benchmarks/c run       # build + run all, full samples
```

`make run` / `make quick` invoke `run-all.sh`, which executes every built binary and
merges their JSON arrays into a single array on stdout. To run one benchmark on its own:

```bash
./benchmarks/c/build/memory_read            # full
./benchmarks/c/build/memory_read --quick    # dev
```

Requires Linux x86_64 with AVX2. Build uses `-O3 -march=native`. Adding a benchmark means
adding one `bench_<name>.c` file — no edits to the harness or Makefile.

Current benchmarks:

- `memory_read`: 1 thread scalar, 1 thread AVX2, all allowed CPUs scalar, all allowed CPUs AVX2
- `compressed_memory_read`: BitPacker8x-compatible 8-bit unpack path

## Daily EC2 runner (SST)

Once a day (currently **23:10 UTC** smoke-test schedule; restore to 06:00 after)
EventBridge Scheduler invokes a Lambda that launches a bare-metal
EC2 instance. The instance builds `benchmarks/c`, runs `run-all.sh`, uploads JSON to S3,
and terminates itself.

| Piece | Location |
|-------|----------|
| Stack | `sst.config.ts` |
| Launch Lambda | `infra/lambda/launch-runner.ts` |
| Stale reaper (hourly, >2h) | `infra/lambda/reap-stale.ts` |
| Instance bootstrap | `infra/ec2/run-benchmarks.sh` |

```bash
bun install
# optional override (default is c6i.8xlarge to fit 32 vCPU quota):
LEDGERMATH_INSTANCE_TYPE=c6i.metal sst deploy --stage dev

# after deploy, trigger a run without waiting for the cron:
aws lambda invoke --function-name <DailyLaunch function name> /tmp/out.json
```

Results land at `s3://<Results bucket>/results/<instance-type>/<timestamp>.json`
(plus `.meta.json` and `.log`). Source for the runner is staged at
`s3://…/source/benchmarks-c.zip` on every deploy.
