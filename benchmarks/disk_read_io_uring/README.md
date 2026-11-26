# disk_read_io_uring

How many reads a disk completes when one thread keeps `queue_depth` of them submitted,
`O_DIRECT` through `io_uring`. On EC2 the counted samples sit on the provider's throughput
or IOPS limit for the disk, not on the device's own, and the device's counters in each Run
say which limit bound.

## What a figure means

How many reads a disk completes when the binary keeps 64 of them submitted: `O_DIRECT`
reads through `io_uring`, from the Fixture the box made at boot. A sample's time over its
repetitions is the time per completion, which gives IOPS and bytes per second. On EC2
both disks hold their provider's limits, so the counted samples sit on them; the device's
own counters say which limit bound.

"Submitted" is what the binary controls and all it sees: a read it has submitted and not
yet reaped. How many of those the device holds at a given instant it does not see. A
completed read waiting to be reaped still counts as submitted, so the device may hold
fewer than 64, and a probe found moments with 64 completions waiting and none in the
device. `device_counters` gives the device's own count of requests in flight, at the two
edges of the measuring only (`in_flight_before`, `in_flight_after`).

One repetition takes one completed read and prepares a read in its place. A Run's figure is
the time of one repetition, in nanoseconds (`time_per_repetition_ns`): the median, over the
Run's counted samples, of a sample's time divided by its repetitions, so the time per
completed read. 10^9 divided by it is reads per second. The binary reads the clock only at
the two edges of a sample. Before the counted samples it runs warmup samples, doubling the
repetitions until a sample lasts at least a second; each of the 10 counted samples the
schedule asks for then runs that many repetitions. Bytes per second (`bytes_per_second`)
is `bytes_per_repetition` × 10^9 divided by the time per repetition, where
`bytes_per_repetition` is `request_bytes`, the bytes one read asks for. A Series gives the
5th, 50th and 95th percentiles of its counted Runs' figures
([Methods](https://ledgermath.com/docs/methods)).

So a figure is the time per completed read with `queue_depth` reads kept submitted, from
one disk, on one instance type.

## What a figure does not show

- The counted samples sit on the provider's limit for the disk, not the device's own; the
  device's counters in the Run say which limit bound (see "Findings").
- With `queue_depth` reads submitted, the figure is the time between completions, not the
  latency of one read.
- `queue_depth` counts reads submitted and not yet reaped, not reads the device held at
  any instant.
- With `disk` `root_volume` the sets read the root EBS volume, not the instance's own
  disk: an EBS figure, whose volume type, size and provisioned IOPS and throughput are
  AWS's record in each boot's dump section `ec2_volumes`.

## Parameters

Each parameter set is a Series of its own on each instance type it runs on: the root
volume's sets on every instance type in the schedule, the instance store's on
`i4i.2xlarge` only.

| Parameter set (all `queue_depth` 64) | What the reader gets | `i4i.2xlarge`, 2026-11-11 | `m5.large`, 2026-11-11 |
|---|---|---|---|
| root volume, `sequential`, 32 KiB, span 1 GiB | The root gp3 volume's throughput limit, as provisioned (125 MiB/s) | 125.0 MiB/s (249.9 µs a completion); `ebs_volume_performance_exceeded_tp` +23.4 s | 125.2 MiB/s |
| root volume, `random`, 4 KiB, span 1 GiB | Its IOPS limit, as provisioned (3000) | 3000 IOPS (333.3 µs); `ebs_volume_performance_exceeded_iops` +15.3 s | 3000 IOPS |
| instance store, `sequential`, 32 KiB, span 32 GiB; `i4i.2xlarge` only | The instance store's sustained throughput limit | 1356.3 MiB/s (23.04 µs), 0.01% between samples; the instance-store throughput limit was exceeded for 29.8 s | |
| instance store, `random`, 4 KiB, span 32 GiB; `i4i.2xlarge` only | Its sustained IOPS limit; AWS gives 200,000 random 4 KiB read IOPS for the type | 199,996 IOPS (5.0001 µs), 0.00%; the IOPS limit was exceeded for 22.2 s | |

The root volume's sets have `"disk": "root_volume", "dir": "/var/tmp/ledgermath/disk"`,
the instance store's `"disk": "instance_store", "dir": "/mnt/lm/instance-store"`.

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_DISK` | `root_volume`, `instance_store` | The Series' name for the disk; never read here |
| `LM_PARAM_DIR` | `/var/tmp/ledgermath/disk`, `/mnt/lm/instance-store` | The directory holding the Fixture |
| `LM_PARAM_ACCESS` | `sequential`, `random` | `sequential`: consecutive requests from the start of the span, wrapping at its end. `random`: the requests of a seeded permutation of the span's blocks (`disk_read_random`'s seed), each at most once until it is used up |
| `LM_PARAM_REQUEST_BYTES` | `32768` with `sequential`, `4096` with `random` | Bytes per read; a multiple of 512, at most 16 MiB |
| `LM_PARAM_QUEUE_DEPTH` | `64` | Reads the binary keeps submitted and not yet reaped; 1 to 4096 |
| `LM_PARAM_SPAN_BYTES` | 1 GiB, 32 GiB | Bytes of the Fixture the reads cover; at least `queue_depth` requests |

`--quick` uses `/var/tmp/ledgermath/disk`, `sequential`, 32 KiB and 64 when the variables
are unset, and reads at most 64 MiB of the span.

## Observed values

Everything [`disk_read_random`'s README](https://ledgermath.com/docs/benchmarks/disk_read_random) lists under "Observed values" about the file and its
device, and: `access` (as carried out), `request_bytes`, `queue_depth` (reads submitted
before measuring and kept submitted), `span_bytes` and `span_blocks`, `bytes_per_repetition`
(`request_bytes`), `ring_sq_entries` and `ring_cq_entries` (the ring the kernel made), and
`ring_features` (`io_uring_params.features`, in hexadecimal).

## Findings

### What will stay unstable, and what to read with care

- **These are the provider's limits, not the device's.** The device's counters
  `ebs_volume_performance_exceeded_{iops,tp}` (root volume) and, on the instance store, the
  fields nvme-cli 2.13 names `ec2_instance_ebs_performance_exceeded_{iops,tp}` (its JSON
  gives every disk EBS's field names) grew for most of each Run.
- **Both disks burst first.** On the root volume the first ~128 MiB, or ~4,000 random
  reads, of each Run went at 0.8 to 1.9 GB/s, or 77,000 to 116,000 IOPS; on the instance
  store, about 2 GiB at 3.2 GB/s, or 265,000 IOPS. Then the limits held. The burst came
  back for a second Run started a few seconds after the first. In every Run seen, the last
  warmup sample straddled the change and the counted samples were all after it; a larger
  burst would show in the counted samples' times and in the exceeded counters, and a
  Method should look there.
- **`m5.large`'s own EBS limit** (81.25 MB/s baseline, 593.75 MB/s while its burst credit
  lasts, 30 minutes a day) never bound on a fresh box: the instance's exceeded counters
  stayed at zero and gp3's bound first.

## How it works

The design is section 2 of the step-4 brief's study (#42) and the decisions on it.

### One repetition, and the ring

The ring is made with raw `io_uring_setup` and `io_uring_enter` system calls and no setup
flags: Amazon Linux 2023's `liburing-devel` (2.6) ships no static library (checked on a
real box: `rpm -ql liburing-devel` lists only `liburing.so` and `liburing-ffi.so`), and a
benchmark is one static binary. Each read is an `IORING_OP_READ` into a buffer of the
process's own.

Before measuring, `queue_depth` reads are submitted. One repetition takes one completion
(waiting in `io_uring_enter` only when none has arrived), checks that it read the whole
request, adds the block's first word to a running sum, and prepares a read in its place,
which the next `io_uring_enter` submits. So the binary has `queue_depth` reads submitted,
or `queue_depth - 1` between reaping one and submitting its replacement, across every
sample and every sample edge, unlike July's batches, whose submissions drained to zero at
the end of each. That is the count of reads submitted and not reaped, not of reads in the
device (see above). After measuring, every read still submitted is reaped. One thread is enough: at 200,000 IOPS on the `i4i.2xlarge` the process used 29% of
a CPU (0.8 s in user space and 8.4 s in the kernel over 31 s), and the device's own counter
showed its IOPS limit binding.

### Events of its own

**`device_counters`**, as in `disk_read_random`, over all of `lm_measure`: its warmup
samples, the gaps between samples, and any other I/O on the device at the time. It starts
with `queue_depth` reads already submitted and ends with as many still submitted, so the
reads it counts can differ from the repetitions by up to `queue_depth`. On the instance
store's random set: 6,291,475 device reads of 4 KiB for 6,291,456 completions measured.

**`work`**: `submitted` and `completed` (all of them, the fill and the drain included),
`submitted_before_measuring`, `completed_during_measuring`, `in_flight_after_measuring`,
`enters_during_measuring` and `waits_during_measuring` (the `io_uring_enter` calls, and of
them those that waited for a completion), `bytes_read`, `span_passes`.

### Elision guard

The Fixture's checks before measuring are `disk_read_random`'s, and exit 1 the same way.
`verified` is the running sum of the first word of every block whose read completed while
measuring. After the drain, every read submitted must have completed, and the sum over all
of them must equal the pattern's at the offsets submitted; otherwise the binary exits 1.
The sum's reach is `disk_read_random`'s: it shows that the blocks read began with the
Fixture's words, not that the rest of each block is, nor anything of the blocks not read.
A read that fails or comes back short exits 1 at once. `io_uring_setup` refused with
`ENOSYS` or `EPERM` (a kernel without it, `kernel.io_uring_disabled`, or a seccomp filter
such as Docker's default) exits 2, saying so.

## Building and testing

```bash
make -C benchmarks/disk_read_io_uring              # build/static/disk_read_io_uring
LM_PARAM_DIR=/mnt/local/ledgermath-scratch/disk LM_PARAM_ACCESS=random LM_PARAM_REQUEST_BYTES=4096 \
  ./benchmarks/disk_read_io_uring/build/static/disk_read_io_uring --quick
```

(After making a Fixture there; see [`disk_read_random`'s README](https://ledgermath.com/docs/benchmarks/disk_read_random).) An execution takes 15 to
35 seconds.
