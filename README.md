# ledgermath

LedgerMath is a server benchmarking tool. A benchmark is one statically linked native
binary that prints a stream of events to stdout, one JSON object per line, and
diagnostics to stderr. A box on EC2 builds it, runs it as an ordinary process, dumps
its own environment around every execution, and writes one Run per execution: a
self-describing record kept forever. The plan is GitHub issue #36; step 2, one Run end
to end, is #37; step 3, the first Method and a page, is #39; step 6, prices, is #45.
`docs/dev-log.md` section 2 is the event contract.

Two pipelines live here side by side. The new one, described first, writes Runs.
July's proof of concept (`benchmarks/c/`, its own JSON format) keeps running unchanged
until step 4 of the plan replaces it.

## Layout

| Path | What it is |
|------|------------|
| `benchmarks/harness/c/` | The C harness that prints the event stream (`lm.h`, `lm.c`); `lm_event.h` and `lm_event.c`, which emit a benchmark's own events and further `observed` events; `lm_fixed.h` and `lm_fixed.c`, samples of fixed work; `lm_disk.h` and `lm_disk.c`, what a disk benchmark observes about its file and device; `lm_fixture.h`, the disk Fixture's pattern |
| `benchmarks/<name>/` | One benchmark on the stream: its source, a `README.md` (what it measures, its parameters and observed values, how it differs from July's), and a `Makefile` (`make BUILD=static`, `BUILD=dynamic`, `make -s compiler`, `make -s resolved`). All thirteen: `memory_read`, `compressed_memory_read`, `memory_read_random`, `memory_write`, `syscall`, `hash`, `sort`, `tcp_echo`, `mutex`, `disk_read_random`, `disk_read_io_uring`, `disk_read_sequential`, `disk_write` |
| `schedule.json` | The targets (instance types, their zone, the times of day each boots) and what a box runs: benchmarks, builds, samples, timeout, parameter sets, and the instance types an entry is for. Checked by `infra/runs/schedule.ts` |
| `runner/` | The box side: `box.sh` (user-data), `provision.py` (prepares the disks at boot and records it), `fixture.c` (writes a disk Fixture), `run.py` (builds, runs, dumps, writes Runs), `cpuid.c` |
| `schemas/` | `run.schema.json` (the Run), `events.schema.json` (one line of the stream) and `prices.schema.json` (a price file) |
| `scripts/check-events.py` | Checks a stream's order; needs only Python 3 |
| `scripts/check-runs.ts` | Checks a directory laid out like the bucket: schemas, every hash, events against stdout, runner manifests |
| `scripts/check-disk-runs.ts` | Checks that every disk Run in such a directory found the disk it declares, that its evidence adds up, and that its dump bears it out |
| `scripts/check-targets.ts` | Checks `schedule.json`'s targets' `vcpus`, their zone offerings and `vcpu_quota.limit` against AWS, read-only; needs AWS access, so not part of `bun test` |
| `scripts/box-in-container/` | Boots `runner/box.sh` in Amazon Linux 2023 with S3 and shutdown stubbed, in several scenarios |
| `infra/runs/` | The `-runs` SST stage: stack, launch Lambda, reaper, user-data, the schedule's check (`schedule.ts`), the targets and their launch schedules (`placement.ts`), the workflow's AWS role |
| `methods/` | Methods, versioned: `v1/` turns Runs into Derivations (`methods/README.md`) |
| `scripts/copy-runs.ts` | The copy job: the bucket's Run files and boot summaries into the Runs repository |
| `scripts/derive.ts`, `scripts/build-page.ts` | Run a Method over the Runs; turn its Derivations into the page |
| `scripts/alarm.ts` | Opens, or comments on, one issue when a watched Series has had no Run for 48 hours, or the newest price file is more than 48 hours old |
| `.github/workflows/runs.yml` | All four on a schedule: copy, push, derive, page, alarm |
| `scripts/fetch-prices.ts`, `scripts/check-prices.ts` | Make the day's price file from AWS's public price lists; check a price file by downloading its sources again and cutting them again |
| `scripts/lib/price-rules.ts` | The selection rules, versioned: which of AWS's price records a price file keeps |
| `scripts/lib/offer-file.ts`, `scripts/lib/prices.ts`, `scripts/lib/price-file-check.ts` | Reading AWS's offer files without holding them in memory; the cut, the download and the price file; whether a price file holds together |
| `.github/workflows/prices.yml` | The price fetch, twice a day, adding at most one file a day to the Runs repository |
| `tests/` | `bun test`: the schemas against sample Runs, the Run checker, the schedule's check, the runner's timeout and stop races and its instance-type filtering, the dump's sections, the disk provisioning's decisions, the disk Fixture and the binaries' checks of it, the launch schedules, launch and reap logic, the box's and the workflow's roles, the Method, the copy job, the page, the alarm and the workflows, and the price fetch, cut, schema and recompute check on excerpts of AWS's files (`tests/samples/prices/`) |

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
(`scripts/box-in-container/expect.ts`): `ok` (the whole schedule for this machine's type
as IMDS gives it, about nine minutes; this machine is not a target, so the entries naming
instance types, `mutex`'s two-thread sets and the instance-store sets, are left out; every
disk Run must tie to its dump, `scripts/check-disk-runs.ts`),
`terminated` (run.py told to stop mid-execution), `shutdown` (every process told to stop,
as a shutdown does), `budget` (the time budget runs out), `blobs-rejected` (the bucket
refuses every blob), `blobs-flaky` (the first upload of blobs drops halfway),
`blobs-present` (the bucket already holds a blob the boot makes) and `instance-types`
(a fake IMDS says the box is an `m5.large`, and the box boots
`scripts/box-in-container/instance-types.json` as its schedule: the entries for other
types are left out and listed in the boot summary, and `mutex`'s one-thread and siblings
sets run from one build, about two minutes). The Runs describe this machine, seen from a
container; in `instance-types` their provider fields are the fake IMDS's. The stand-in
`aws` answers the four EC2 calls the box makes (the catalog records saved in
`scripts/box-in-container/ec2/`). The container has no device node of this machine's
disks, so `provision.py` prepares none, whatever it finds in `/sys`, and the scenarios
check that it did not; the root volume's disk directory is a tmpfs of the container's
own (the schedule's 1 GiB Fixture and 1 GiB scratch file do not fit beside everything
else on a development machine's disk), so the disk Runs there read and write memory and
say so (`device_found` false). The container runs without a seccomp filter, as the box
does.

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
2. installs `gcc`, `make`, `glibc-static`, `tar`, `gzip`, `util-linux`, `nvme-cli` and
   `xfsprogs` from the image's own release;
3. fetches `source/<commit>.tar.gz`, a `git archive` of the deployed commit, and refuses to
   go on if the archive's commit or its own text is not that commit's;
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
blobs/sha256/<hex>                   every blob a Run cites: binaries, dumps, stdout, stderr
boots/<yyyy>/<mm>/<dd>/<boot>.json   what one boot ran, and what it did not
logs/<yyyy>/<mm>/<dd>/<boot>.log     the box's log
source/<commit>.tar.gz               the deployed source
```

A reaper runs every five minutes and terminates any box of the stage older than 50
minutes. It touches nothing else; July's reaper cannot touch these boxes either.

The box's role reads its source, lists `blobs/`, writes `runs/`, `blobs/`, `boots/` and
`logs/`, and calls four read-only EC2 actions: `ec2:DescribeInstanceTypes`,
`ec2:DescribeVolumes`, `ec2:DescribeVolumeStatus` and `ec2:DescribeInstances`
(`infra/runs/box-role.ts`).

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
misspelt `instance_types` cannot silently mean every type); the same parameter set twice
for one benchmark, build and type; and, while July's pipeline runs, a `c6i.8xlarge` boot
from 22:20 to 23:40 UTC, so it never overlaps July's 23:10 box (that rule goes when July's
pipeline is retired). A target's boots usually share one minute past the hour and so make
one schedule; boots at other minutes get a schedule each, named by the minute
(`BoxLaunchC6i8xlargeAt10`).

The check also keeps every box inside the account's vCPU quota, whatever the times.
`"vcpu_quota": { "limit": 64, "reserved_outside_schedule": 4 }` declares the quota and
the dev machine's share. Every target's `vcpus` added together, plus what is reserved,
must fit the limit (58 + 4 = 62 of 64 today), and two boots of one target must be at least
60 minutes apart, across midnight too, because a box lives at most 55 minutes. A new
target's `vcpus` is AWS's `DefaultVCpus` for the type. Check every declared number against
AWS, read-only, with `AWS_PROFILE=tabot-dev bun scripts/check-targets.ts`. While July's
pipeline runs, its 23:10 box is the one thing these rules do not cover, hence the July
rule.

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

On this machine (us-east-2, near AWS's CDN) the whole fetch took 12 s and at most 96 MB of
memory: 5 s to download the EC2 file, 6 s to cut. The check took 11 s and 125 MB.

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
