# disk_write

What a buffered `pwrite` of `request_bytes` costs, on one thread, one write at a time:
followed by `fdatasync` (the time until the device has the data) or by nothing (the time
until the page cache has it). How the kernel and the device make the data durable is
theirs, not the binary's; where the binary could read them, each Run observes the disk's
write cache and FUA support.

## What a figure means

What a write costs: a buffered `pwrite` of 8 KiB at the next offset of a scratch file of
the binary's own, followed by `fdatasync` (the time until the device has the data) or by
nothing (the time until the page cache has it). The set with no sync is the page cache's
number, not the disk's, and is named and scheduled as such: on the root volume only.

One repetition is one write, with its `fdatasync` when `sync` is `fdatasync`. Each Run that
Method `series` v1 counts gives one figure, the time of one repetition in nanoseconds
(`time_per_repetition_ns`): the median, over the Run's counted samples, of a sample's time
divided by its repetitions, so of the samples' mean time of one write. A Run it does not
count gives none. The harness reads the clock once at each edge of a sample, around the
whole loop of its repetitions, and never inside that loop. Before the counted samples it
runs warmup samples, doubling the repetitions until a sample lasts at least a second; each
of the 10 counted samples the schedule asks for then runs that many repetitions. Bytes per
second (`bytes_per_second`)
is `bytes_per_repetition` × 10^9 divided by the time per repetition, where
`bytes_per_repetition` is `request_bytes`, the bytes one write writes. A Series gives the
5th, 50th and 95th percentiles of its counted Runs' figures
([Methods](https://ledgermath.com/docs/methods)).

So a figure is the time of one 8 KiB write at queue depth 1, made durable or not, to one
disk, on one instance type.

## What a figure does not show

- With `sync` `none`, the measured loop calls `pwrite` alone and asks for nothing to be
  made durable: the figure is the time of a buffered write, whatever the kernel made that
  call wait for.
- The binary only calls `fdatasync`; how the kernel and the device make the write durable
  is theirs. On the two disks seen, the root gp3 volume and the instance store of an
  `i4i.2xlarge`, both reporting `write_cache` "write through", the device counted no flush
  while measuring. Each Run records `write_cache` and `fua` where the binary could read
  them; an absent value says nothing either way (see "Findings").
- The scratch file is written in full before measuring, so the measured writes overwrite
  blocks that are already allocated. Writes that allocate blocks are not measured.
- With `disk` `root_volume` the sets write to the root EBS volume, not the instance's own
  disk: an EBS figure, whose volume type, size and provisioned IOPS and throughput are
  AWS's record in each boot's dump section `ec2_volumes`.

## Parameters

Each parameter set is a Series of its own on each instance type it runs on: the root
volume's sets on every instance type in the schedule, the instance store's on
`i4i.2xlarge` only.

| Parameter set | What the reader gets | `i4i.2xlarge`, 2026-11-11 | `m5.large`, 2026-11-11 |
|---|---|---|---|
| `disk` `root_volume`, `dir` `/var/tmp/ledgermath/disk`, `request_bytes` 8192, `sync` `none`, `file_bytes` 256 MiB | A buffered 8 KiB write absorbed by the page cache: the page cache's number | 1.47 µs a write; 60 device writes while measuring, for 12.6 million writes | 2.62 µs; 49 device writes for 6.3 million |
| `disk` `root_volume`, `dir` `/var/tmp/ledgermath/disk`, `request_bytes` 8192, `sync` `fdatasync`, `file_bytes` 1 GiB | A durable 8 KiB write to the root gp3 volume at queue depth 1 | 913.5 µs, 0.11% between samples; 1.0002 device writes and 0 flushes a write | 910.8 µs; 1.0024 device writes, 0 flushes |
| `disk` `instance_store`, `dir` `/mnt/lm/instance-store`, `request_bytes` 8192, `sync` `fdatasync`, `file_bytes` 1 GiB; `i4i.2xlarge` only | A durable 8 KiB write to the instance's own NVMe disk, through XFS | 29.9 to 30.1 µs (two Runs); 1.0000 device writes and 0 flushes a write; device mean 22.6 µs | |

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_DISK` | `root_volume`, `instance_store` | The Series' name for the disk; never read here |
| `LM_PARAM_DIR` | `/var/tmp/ledgermath/disk`, `/mnt/lm/instance-store` | The directory the scratch file is made in |
| `LM_PARAM_REQUEST_BYTES` | `8192` | Bytes per write; a multiple of 8 |
| `LM_PARAM_SYNC` | `none`, `fdatasync` | `none`: `pwrite` alone. `fdatasync`: `pwrite`, then `fdatasync` |
| `LM_PARAM_FILE_BYTES` | 256 MiB with `none`, 1 GiB with `fdatasync` | The scratch file's size; writes wrap at its end. A whole number of requests and of 4 KiB blocks |

`--quick` uses `/var/tmp/ledgermath/disk`, 8 KiB, `fdatasync` and 256 MiB when the
variables are unset, and writes a scratch file of at most 16 MiB.

256 MiB with no sync stays under the kernel's background writeback threshold (10% of
available memory: about 750 MiB on an `m5.large`), so the flusher leaves it alone for the
30 seconds `dirty_expire_centisecs` gives; the dump's `kernel` section holds every
`/proc/sys/vm/dirty_*` value.

## Observed values

Everything [`disk_read_random`'s README](https://ledgermath.com/docs/benchmarks/disk_read_random) lists under "Observed values" about the file and its
device, here the scratch file (`o_direct` is false: the measured writes are buffered), and:
`request_bytes`, `sync_call` (`fdatasync` or `none`, as called), `bytes_per_repetition`
(`request_bytes`).

## Findings

### What will stay unstable, and what to read with care

- **With no sync it is a memory benchmark.** It measures copying 8 KiB into the page cache
  and marking it dirty, not the disk; the device counters show it.
- **fdatasync's cost depends on the write cache.** Both disks seen are "write through", so
  the number is the device's write latency plus what XFS and the kernel add (about 7.5 µs
  on the instance store: 30.1 µs against the device's mean of 22.6). No disk reporting
  "write back" was seen.
- **The root volume's numbers are gp3's**, with background writes of the box's own (the
  runner, journald) in the same counters.

## How it works

The design is section 2 of the step-4 brief's study (#42) and the decisions on it.

### The scratch file, and one repetition

The scratch file is `ledgermath-disk_write.scratch` in `dir`. The binary runs as root on
the box, so it creates that name exclusively and never through a symbolic link
(`openat(dir, name, O_CREAT | O_EXCL | O_NOFOLLOW)`): if the name exists in any form, a
file, a directory, a symbolic link (dangling or not), a leftover of an earlier Run, the
binary exits 1, saying so, and touches nothing. A missing `dir` exits 1 too.

Before measuring, the file is written in full with `O_DIRECT` in 1 MiB writes through the
same descriptor (never by opening the name again), then `fdatasync`ed, so every block is
allocated and written on the device and none is in the page cache; `FIEMAP` must then find
no unwritten or unallocated extent and no hole, or the binary exits 1. The measured writes
overwrite those blocks, so XFS allocates nothing and converts no extent while measuring.
At the end, and on any exit through `exit()`, the file is deleted, but only if its name is
still the file the binary created (the same device and inode); otherwise it is left and
the binary says so. It is never a Fixture. A Run killed outright (a timeout's `SIGKILL`)
leaves the file, and the next Run in that directory then refuses to start.

One repetition writes the 8 KiB buffer at the next offset with `pwrite` through the page
cache, then calls `fdatasync` in the `fdatasync` sets. The buffer holds the Fixture
pattern of block 0, with its first word replaced by a tag of the offset, so every write is
distinct. A sample's time over its repetitions is the time per write.

### Events of its own

**`device_counters`**, as in `disk_read_random`, over all of `lm_measure`: its warmup
samples, the gaps between samples, and every other request to the device in that time.
So writes and flushes per repetition are upper bounds of what a durable write cost the
device; on both disks they came to exactly one write and no flush, because both report
`write_cache` "write through", so `fdatasync` sends no flush command. The `nvme amzn
stats` histograms in the dump, taken before and after the whole process, also hold the
preparation's 1 GiB of writes. With no sync, the root volume saw 60 writes while measuring, for 12.6 million
`pwrite`s (5 per million, which the box's own background writes could account for); the
1,088 writes of that Run's whole life were mostly the scratch file's preallocation.

**`work`**: `writes` (the checked write before measuring included),
`writes_checked_before_measuring`, `fdatasyncs`, `bytes_written`, `file_passes`.

### Elision guard

Before measuring, one write is read back and compared with the buffer, then made durable.
`verified` is the running sum of every write's tag. After measuring, the last block written
is read back and must hold exactly what was written there, and the tags must add up to the
sum the writes returned; otherwise the binary exits 1. A failed `pwrite` or `fdatasync`
exits 1 at once.

## Building and testing

```bash
make -C benchmarks/disk_write                      # build/static/disk_write
LM_PARAM_DIR=/mnt/local/ledgermath-scratch/disk LM_PARAM_SYNC=fdatasync ./benchmarks/disk_write/build/static/disk_write --quick
```

It needs no Fixture, only a directory to write in. An execution takes 12 to 30 seconds,
of which up to 8 on the root volume go to writing the 1 GiB scratch file in full.
