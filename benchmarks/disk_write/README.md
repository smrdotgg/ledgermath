# disk_write

What a write costs: a buffered `pwrite` of 8 KiB at the next offset of a scratch file of
the binary's own, followed by `fdatasync` (the time until the device has the data) or by
nothing (the time until the page cache has it). The set with no sync is the page cache's
number, not the disk's, and is named and scheduled as such: on the root volume only.

The design is section 2 of the step-4 brief's study (#42) and the decisions on it.

| Parameter set | What the reader gets | `i4i.2xlarge`, 2026-11-11 | `m5.large`, 2026-11-11 |
|---|---|---|---|
| `disk` `root_volume`, `dir` `/var/tmp/ledgermath/disk`, `request_bytes` 8192, `sync` `none`, `file_bytes` 256 MiB | A buffered 8 KiB write absorbed by the page cache: the page cache's number | 1.47 µs a write; 0 device writes while measuring | 2.62 µs; 0 device writes |
| `disk` `root_volume`, `dir` `/var/tmp/ledgermath/disk`, `request_bytes` 8192, `sync` `fdatasync`, `file_bytes` 1 GiB | A durable 8 KiB write to the root gp3 volume at queue depth 1 | 913.5 µs, 0.11% between samples; 1.0002 device writes and 0 flushes a write | 910.8 µs; 1.0024 device writes, 0 flushes |
| `disk` `instance_store`, `dir` `/mnt/lm/instance-store`, `request_bytes` 8192, `sync` `fdatasync`, `file_bytes` 1 GiB; `i4i.2xlarge` only | A durable 8 KiB write to the instance's own NVMe disk, through XFS | 29.9 to 30.1 µs (two Runs); 1.0000 device writes and 0 flushes a write; device mean 22.6 µs | |

```bash
make -C benchmarks/disk_write                      # build/static/disk_write
LM_PARAM_DIR=/mnt/local/ledgermath-scratch/disk LM_PARAM_SYNC=fdatasync ./benchmarks/disk_write/build/static/disk_write --quick
```

It needs no Fixture, only a directory to write in. An execution takes 12 to 30 seconds,
of which up to 8 on the root volume go to writing the 1 GiB scratch file in full.

## Parameters

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

## The scratch file, and one repetition

The scratch file is `ledgermath-disk_write.scratch` in `dir`. Before measuring, it is
written in full with `O_DIRECT` in 1 MiB writes, then `fdatasync`ed, so every block is
allocated and written on the device and none is in the page cache; `FIEMAP` must then find
no unwritten or unallocated extent and no hole, or the binary exits 1. The measured writes
overwrite those blocks, so XFS allocates nothing and converts no extent while measuring.
The file is deleted at the end, and on any exit through `exit()`. It is never a Fixture.

One repetition writes the 8 KiB buffer at the next offset with `pwrite` through the page
cache, then calls `fdatasync` in the `fdatasync` sets. The buffer holds the Fixture
pattern of block 0, with its first word replaced by a tag of the offset, so every write is
distinct. A sample's time over its repetitions is the time per write.

## Observed

Everything `disk_read_random`'s README lists under "Observed" about the file and its
device, here the scratch file (`o_direct` is false: the measured writes are buffered), and:
`request_bytes`, `sync_call` (`fdatasync` or `none`, as called), `bytes_per_repetition`
(`request_bytes`).

## Events of its own

**`device_counters`**, as in `disk_read_random`, over `lm_measure`. Writes and flushes per
repetition are what a durable write cost the device: on both disks exactly one write and
no flush, because both report `write_cache` "write through", so `fdatasync` sends no flush
command. With no sync, the device saw no write at all while measuring (its 1,088 writes
in that Run were the scratch file's preallocation).

**`work`**: `writes` (the checked write before measuring included),
`writes_checked_before_measuring`, `fdatasyncs`, `bytes_written`, `file_passes`.

## Elision guard

Before measuring, one write is read back and compared with the buffer, then made durable.
`verified` is the running sum of every write's tag. After measuring, the last block written
is read back and must hold exactly what was written there, and the tags must add up to the
sum the writes returned; otherwise the binary exits 1. A failed `pwrite` or `fdatasync`
exits 1 at once.

## What will stay unstable, and what to read with care

- **With no sync it is a memory benchmark.** It measures copying 8 KiB into the page cache
  and marking it dirty, not the disk; the device counters show it.
- **fdatasync's cost depends on the write cache.** Both disks seen are "write through", so
  the number is the device's write latency plus what XFS and the kernel add (about 7.5 µs
  on the instance store: 30.1 µs against the device's mean of 22.6). A disk reporting
  "write back" would add a flush, which `device_counters` and the dump would show.
- **The root volume's numbers are gp3's**, with background writes of the box's own (the
  runner, journald) in the same counters.

## Differences from July's version

July's is `benchmarks/c/bench_disk_write.c`, variants `8 KiB, No fsync` and `8 KiB, fsync`.

- **The no-sync set is named as the page cache's** and runs on the root volume only; July
  reported it as the disk's. July's fsync value, 911 µs, was the root gp3 volume's durable
  write latency; here it is 913.5 µs on the same kind of volume.
- **One set per execution,** with both disks named, where July ran its two variants in one
  process on one file.
- **The scratch file is preallocated by writing it with `O_DIRECT`** and checked with
  `FIEMAP`; July wrote zeros through the page cache and synced.
- **The guard** reads back the last write and sums distinct tags; July's sum was of the
  same first word and the offset.
- **New:** `observed` with the device, `device_counters`, `work`, and the parameters.
- **What is common to every port:** the event stream, a static binary, and July's
  sampling, with the warmup samples emitted.
