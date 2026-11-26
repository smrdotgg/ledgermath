# disk_read_sequential

Reading a file front to back the way a program does, on one thread: buffered `pread`s of
`request_bytes` with the kernel's stock readahead, the kernel asked first to drop each
sample's region from the page cache. It is a cold read when the eviction worked, which
each Run records as each sample's resident pages.

## What a figure means

Reading a file front to back from a cold page cache, the way a program does: buffered
`pread`s of 8 KiB, with the kernel's stock readahead deciding what the device is asked
for. napkin-math's "sequential read". Each sample reads one region of the Fixture the box
made at boot, made cold beforehand, and says how cold it was.

### Samples of fixed work

A cold read is cold only once, so this benchmark does not calibrate as the harness's
`lm_measure` does (doubling until a sample lasts a second, repeating the same work). It
uses `lm_measure_fixed` (`benchmarks/harness/c/lm_fixed.c`), which emits the same events:
two warmup samples, then `LM_SAMPLES` counted ones, each of exactly
`bytes_per_sample / request_bytes` repetitions. Sample *k* reads region
*k* mod (`span_bytes` / `bytes_per_sample`) from its first byte to its last. Before each
sample, outside its interval, the region is dropped from the page cache with
`posix_fadvise(POSIX_FADV_DONTNEED)` and its resident pages are counted with `mincore`.
The descriptor carries no advice of its own (no `POSIX_FADV_SEQUENTIAL`), so readahead is
the kernel's default for the device (`read_ahead_kb` 128 on both disks). The two warmup
samples also drain the root volume's short burst (256 MiB against its ~128 MiB). On the
root volume the twelve samples wrap round the span's eight regions: each is made cold
again first.

One repetition is one `pread` of `request_bytes` at the next offset, then the block's
first word is added to a running sum. A sample's time over its repetitions is the time per
read call; `bytes_per_sample` over the sample's time is the throughput, which Method
version 1 gives from `bytes_per_repetition`.

### The figure

Each Run that Method `series` v1 counts gives one figure, the time of one repetition in
nanoseconds (`time_per_repetition_ns`): the median, over the Run's counted samples (10 in
the schedule), of a sample's time divided by its repetitions, so of the samples' mean time
per read call. A Run it does not count gives none. The harness reads the clock once at
each edge of a sample, around the whole loop of its repetitions, and never inside that
loop; the request to drop the region comes before the first read. Bytes per second
(`bytes_per_second`) is `bytes_per_repetition` × 10^9 divided by the time per repetition,
where `bytes_per_repetition` is `request_bytes`. A Series gives the 5th, 50th and 95th
percentiles of its counted Runs' figures ([Methods](https://ledgermath.com/docs/methods)).

So a figure is the median of the samples' mean times of one 8 KiB read call, each sample
reading one region of a file front to back after the kernel was asked to drop it from the
page cache, from one disk, on one instance type.

## What a figure does not show

- A sample is not known to be cold. Before each sample the binary asks the kernel to
  drop the region from the page cache (`posix_fadvise`), records the call's result
  (`fadvise_result`) and the region's pages still resident (`resident_pages_before`, -1
  when it cannot count them), and reads on whatever they say. Neither the binary nor the
  Method requires the region to be cold: a sample is a cold read as far as that count
  shows.
- Readahead asks the device for larger requests than the 8 KiB calls (128 KiB on both
  disks seen), and the figure is built from means over the calls, not from the latency of
  one device request.
- In the Runs examined readahead kept one or two requests in flight (see "Findings"), so
  it is not the disk's throughput at a deep queue; reads kept in flight at depth are
  [`disk_read_io_uring`](https://ledgermath.com/docs/benchmarks/disk_read_io_uring)'s.
- With `disk` `root_volume` the set reads the root EBS volume, not the instance's own
  disk: an EBS figure, whose volume type, size and provisioned IOPS and throughput are
  AWS's record in each boot's dump section `ec2_volumes`.

## Parameters

Each parameter set is a Series of its own on each instance type it runs on: the root
volume's set on every instance type in the schedule, the instance store's on
`i4i.2xlarge` only.

| Parameter set | What the reader gets | `i4i.2xlarge`, 2026-11-11 | `m5.large`, 2026-11-11 |
|---|---|---|---|
| `disk` `root_volume`, `dir` `/var/tmp/ledgermath/disk`, `request_bytes` 8192, `bytes_per_sample` 128 MiB, `span_bytes` 1 GiB | Cold sequential read from the root gp3 volume, which its 125 MiB/s limit caps | 125.0 MiB/s (62.5 µs an 8 KiB read); 127.6 KiB a device request; `ebs_volume_performance_exceeded_tp` +7.4 s | 125.2 MiB/s (62.4 µs); the same |
| `disk` `instance_store`, `dir` `/mnt/lm/instance-store`, `request_bytes` 8192, `bytes_per_sample` 2 GiB, `span_bytes` 32 GiB; `i4i.2xlarge` only | Cold sequential read from the instance's own NVMe disk with stock readahead | 1054 to 1094 MiB/s (7.14 to 7.41 µs a read, in two Runs); 128 KiB device requests; no limit exceeded | |

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_DISK` | `root_volume`, `instance_store` | The Series' name for the disk; never read here |
| `LM_PARAM_DIR` | `/var/tmp/ledgermath/disk`, `/mnt/lm/instance-store` | The directory holding the Fixture |
| `LM_PARAM_REQUEST_BYTES` | `8192` | Bytes per `pread`; a multiple of 8 |
| `LM_PARAM_BYTES_PER_SAMPLE` | 128 MiB, 2 GiB | Bytes one sample reads: one region of the span; a whole number of requests and of pages |
| `LM_PARAM_SPAN_BYTES` | 1 GiB, 32 GiB | Bytes of the Fixture the regions cover; a whole number of regions |

`--quick` uses `/var/tmp/ledgermath/disk`, 8 KiB and 128 MiB when the variables are unset,
and reads at most 8 MiB a sample of at most 64 MiB of the span.

## Observed values

Everything [`disk_read_random`'s README](https://ledgermath.com/docs/benchmarks/disk_read_random) lists under "Observed values" about the file and its
device (`o_direct` is false here), and: `request_bytes`, `bytes_per_sample` and
`span_bytes` (as used, after `--quick`'s caps), `regions`, `bytes_per_repetition`
(`request_bytes`).

## Findings

### What will stay unstable, and what to read with care

- **Readahead keeps one or two requests in flight**, so the instance store's number is
  what stock readahead gets from this disk (about 210 µs a 128 KiB request), well below its
  1.42 GB/s limit at queue depth 64. On the root volume the gp3 limit binds instead.
- **Regions differ.** On the instance store the first samples ran at 7.15 µs a read and
  the later ones at 7.42, a 4% spread within one Run that the same regions repeated.
- **On a file system whose pages cannot be dropped** (a tmpfs, as in the container test),
  `resident_pages_before` says so and the Run is not cold. Nothing stops it: the record
  says what happened.

## How it works

The design is section 2 of the step-4 brief's study (#42) and the decisions on it.

### Events of its own

**`device_counters`**, as in `disk_read_random`, over all of `lm_measure_fixed`: the
warmup samples, the steps between samples that make each region cold, and any other I/O
on the device at the time. Read sectors × 512 at least the bytes the samples read shows
the device, not the page cache, served them: 1.0005 times the bytes asked on the root
volume, 1.0001 on the instance store (readahead reads a little past each region's end,
and other I/O adds a little). Read sectors over reads is the mean size of the device's
read requests in that time, nearly all of them readahead's.

**`work`**: `reads`, `bytes_read`, and `samples`, one entry per sample: its `offset`,
`posix_fadvise`'s result (`fadvise_result`, 0 for success) and `resident_pages_before`,
the region's pages in the page cache as the sample began. Every sample on both disks began
with 0.

```json
{"event":"work","t":1304628415593,"reads":196608,"bytes_read":1610612736,"samples":[{"sample":0,"offset":0,"fadvise_result":0,"resident_pages_before":0},{"sample":1,"offset":134217728,"fadvise_result":0,"resident_pages_before":0}, …]}
```

### Elision guard

The Fixture's checks before measuring are `disk_read_random`'s, and exit 1 the same way;
they read through the page cache here, so the whole span is dropped from it before the
first sample. `verified` is the running sum of the first word of every 8 KiB block read.
After measuring, the binary checks that it made exactly the reads the samples ask for, and
that the sum equals the pattern's over every region read; otherwise it exits 1. The sum's
reach is `disk_read_random`'s: it shows that each 8 KiB block read began with the
Fixture's word, not that the rest of the block is, nor anything of the span not read. At the end
the whole span is dropped from the page cache, so the next Run finds it as this one did.

## Building and testing

```bash
make -C benchmarks/disk_read_sequential            # build/static/disk_read_sequential
LM_PARAM_DIR=/mnt/local/ledgermath-scratch/disk ./benchmarks/disk_read_sequential/build/static/disk_read_sequential --quick
```

(After making a Fixture there; see [`disk_read_random`'s README](https://ledgermath.com/docs/benchmarks/disk_read_random).) An execution takes 12 to
25 seconds.
