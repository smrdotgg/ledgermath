# disk_read_random

The latency of one read from a disk, with nothing else outstanding: one `pread` of 8 KiB
with `O_DIRECT`, at the next offset of a seeded permutation of the span's blocks, from the
Fixture the box made at boot. A sample's time over its repetitions is the mean time of one
read; the device's own latency histogram, which the dump records before and after every
Run, gives its distribution.

The design is section 2 of the step-4 brief's study (#42) and the decisions on it.

| Parameter set | What the reader gets | `i4i.2xlarge`, 2026-11-11 | `m5.large`, 2026-11-11 |
|---|---|---|---|
| `disk` `root_volume`, `dir` `/var/tmp/ledgermath/disk`, `request_bytes` 8192, `span_bytes` 1 GiB | The root EBS volume's read latency at queue depth 1 (the AMI's 8 GiB gp3: 3000 IOPS, 125 MiB/s) | 582.6 µs a read, 0.16% between samples | 582.6 and 582.9 µs (two Runs), 0.15% |
| `disk` `instance_store`, `dir` `/mnt/lm/instance-store`, `request_bytes` 8192, `span_bytes` 32 GiB; `i4i.2xlarge` only | The instance's own NVMe disk's read latency at queue depth 1 | 120.4 µs, 1.0% (120.3 µs at 0, 2 and 5 minutes after the Fixture was written) | |

```bash
make -C benchmarks/disk_read_random                # build/static/disk_read_random
cc -O2 -I benchmarks/harness/c -o /tmp/fixture runner/fixture.c
mkdir -p /mnt/local/ledgermath-scratch/disk && /tmp/fixture /mnt/local/ledgermath-scratch/disk/ledgermath-fixture-v1 67108864
LM_PARAM_DIR=/mnt/local/ledgermath-scratch/disk ./benchmarks/disk_read_random/build/static/disk_read_random --quick
```

On the box the Fixture is made by `runner/provision.py` at boot; the binary never makes or
repairs one. An execution takes 15 to 25 seconds.

## Parameters

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_DISK` | `root_volume`, `instance_store` | The name of the disk the set means, which makes the Series. The binary never reads it: what it found is in `observed`, and matching a model string to a name is a Method's work |
| `LM_PARAM_DIR` | `/var/tmp/ledgermath/disk`, `/mnt/lm/instance-store` | The directory holding the Fixture, `ledgermath-fixture-v1`. On Amazon Linux 2023 `/tmp` is a tmpfs, hence `/var/tmp` |
| `LM_PARAM_REQUEST_BYTES` | `8192` | Bytes per read; a multiple of 512 |
| `LM_PARAM_SPAN_BYTES` | 1 GiB, 32 GiB | Bytes of the Fixture the reads cover, from its start; a whole number of requests, at most 2^32 of them |

`--quick` uses `/var/tmp/ledgermath/disk` and 8 KiB when the variables are unset, and
reads at most 64 MiB of the span, so a 64 MiB Fixture serves any set.

## One repetition

One `pread` of `request_bytes` at the next offset of the permutation, with `O_DIRECT`, then
the first word of the block is added to a running sum. The permutation is a Fisher-Yates
shuffle of the span's block numbers with a fixed seed (July's), so every Run reads the same
blocks in the same order, each block at most once until the permutation is used up: about
200,000 reads per Run on the instance store and 25,000 on the root volume, of 4,194,304 and
131,072 blocks. `work` says how many reads were made and whether the permutation wrapped.

## Observed

Emitted once, before measuring, after the Fixture has been checked. What every disk
benchmark observes about the file it opened and the device behind it comes from
`benchmarks/harness/c/lm_disk.c`; a key is absent when the kernel does not give it.

| Key | What it is, and where it comes from |
|---|---|
| `file_path` | The file the binary opened, as `/proc/self/fd/N` names it: the observed counterpart of `dir` |
| `file_device` | The file's device number, `major:minor`, from `fstat` |
| `device_found` | Whether a block device was found for it in `/sys`; false on a file system with no device (a tmpfs) |
| `device_from` | `st_dev` when `/sys/dev/block/<major:minor>` exists; `mount_source` when the mount's source names the device instead (btrfs, overlayfs); `none` |
| `block_device` | The kernel name of that device: a partition (`nvme0n1p1`) or a whole disk |
| `disk_device` | The whole disk it belongs to |
| `disk_controller` | The disk's controller, such as `nvme1` |
| `disk_model`, `disk_serial`, `disk_firmware` | `/sys/block/<disk>/device/{model,serial,firmware_rev}`, trimmed: `Amazon Elastic Block Store` with serial `vol…` (the EBS volume `vol-…`), or `Amazon EC2 NVMe Instance Storage` with serial `AWS…` |
| `disk_bytes` | The disk's size |
| `logical_block_size`, `physical_block_size`, `write_cache`, `fua`, `max_sectors_kb`, `max_hw_sectors_kb`, `read_ahead_kb`, `nr_requests`, `scheduler`, `rotational`, `nomerges` | `/sys/block/<disk>/queue/*` |
| `fs_type`, `mount_point`, `mount_source`, `mount_options`, `super_options` | The file's mount in `/proc/self/mountinfo`, found by `statx`'s mount id |
| `o_direct` | Whether the descriptor has `O_DIRECT`, by `fcntl(F_GETFL)` |
| `statx_mask`, `dio_offset_align`, `dio_mem_align` | `statx(STATX_DIOALIGN)`: the alignment direct I/O needs here, when the file system says |
| `file_mtime`, `file_birth` | When the file was last written and made: with the Run's `started_at`, the time since the Fixture was made |
| `file_bytes` | The file's size |
| `fiemap`, `file_extents`, `file_unwritten_extents`, `file_delalloc_extents`, `file_mapped_bytes` | `FIEMAP` over the span: how many extents, how many not yet written or not yet allocated, and how much of the span they cover. `fiemap` is false where the file system maps none (tmpfs) |
| `file_resident_pages`, `page_bytes` | Pages of the span in the page cache, by `mincore` |

And this benchmark's own: `request_bytes` (bytes each `pread` asks for), `queue_depth` (1),
`span_bytes` and `span_blocks` (the span actually read, after `--quick`'s cap), and
`bytes_per_repetition` (`request_bytes`; Method version 1 divides by it to give bytes per
second).

```json
{"event":"observed","t":1158781068975,"values":{"file_path":"/mnt/lm/instance-store/ledgermath-fixture-v1","file_device":"259:1","device_found":true,"device_from":"st_dev","block_device":"nvme1n1","disk_device":"nvme1n1","disk_controller":"nvme1","disk_model":"Amazon EC2 NVMe Instance Storage","disk_serial":"AWS6468346A58D1B021F","disk_firmware":"0","disk_bytes":1875000000000,"logical_block_size":512,"physical_block_size":512,"write_cache":"write through","fua":0,"max_sectors_kb":128,"max_hw_sectors_kb":128,"read_ahead_kb":128,"nr_requests":127,"scheduler":"[none] mq-deadline kyber bfq","rotational":0,"nomerges":0,"fs_type":"xfs","mount_point":"/mnt/lm/instance-store","mount_source":"/dev/nvme1n1","mount_options":"rw,relatime","super_options":"rw,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota","o_direct":true,"statx_mask":"0x3fff","dio_offset_align":512,"dio_mem_align":4,"file_mtime":"2026-11-11T06:57:15.474341291Z","file_birth":"2026-11-11T06:56:45.575002837Z","file_bytes":34359738368,"fiemap":true,"file_extents":5,"file_unwritten_extents":0,"file_delalloc_extents":0,"file_mapped_bytes":34359738368,"file_resident_pages":0,"page_bytes":4096,"request_bytes":8192,"queue_depth":1,"span_bytes":34359738368,"span_blocks":4194304,"bytes_per_repetition":8192}}
```

(The instance-store set on a real `i4i.2xlarge`, in a whole boot of the box script.)

## Events of its own

Both come after `verified` and pass `schemas/events.schema.json` and
`scripts/check-events.py`.

**`device_counters`**, the same in all four disk benchmarks: the change in
`/sys/block/<disk>/stat` over the interval it names (`lm_measure`, warmup samples
included), both reads raw, the partition's too when the file is on one, and the span's
resident pages afterwards. It is the proof that the device, not the page cache, served the
reads: `read_sectors` × 512 against the repetitions of every sample times
`request_bytes`. The `O_DIRECT` flag alone does not prove it. Field names follow the
kernel's `Documentation/block/stat.rst`; `in_flight` is a level, so it is given before and
after instead of as a change.

```json
{"event":"device_counters","t":1182574280616,"interval":"lm_measure","device_found":true,"disk_device":"nvme1n1","stat":"/sys/class/block/nvme1n1/stat","change":{"reads":196608,"read_merges":0,"read_sectors":3145728,"read_ticks_ms":23206,"writes":1,"write_merges":0,"write_sectors":2,"write_ticks_ms":0,"io_ticks_ms":22760,"time_in_queue_ms":23205,"discards":0,"discard_merges":0,"discard_sectors":0,"discard_ticks_ms":0,"flushes":0,"flush_ticks_ms":0},"in_flight_before":0,"in_flight_after":0,"before":[8062132,48,163625541,3109953,939971,9,146193322,234549,0,229930,3355791,1748,0,7324218748,11288,0,0],"after":[8258740,48,166771269,3133159,939972,9,146193324,234549,0,252690,3378996,1748,0,7324218748,11288,0,0],"file_resident_pages":0}
```

196,608 reads of 16 sectors (8 KiB) for 196,608 repetitions: every read went to the device.

**`work`**: `reads`, `bytes_read`, `distinct_blocks`, `permutation_passes`.

## Elision guard, and the Fixture's checks

Before measuring, outside every interval, the binary exits 1 when the Fixture is missing
(saying it is made at boot), shorter than the span, has an unwritten or unallocated extent
in the span or a hole (reads of never-written blocks return zeros without touching the
device), or when any word of its first, middle and last block differs from the pattern
(`benchmarks/harness/c/lm_fixture.h`). `verified` is the running sum of the first word of
every block read. After measuring, the binary recomputes that sum from the pattern at the
offsets it read, warmups included, and exits 1 if it differs: every read returned the
Fixture, not zeros, another block or stale data.

## Tying a Run to its dump

`scripts/check-disk-runs.ts` does all of this for every disk Run in a directory laid out
like the bucket.

- `disk_controller`, `disk_model` and `disk_serial` are `/sys/class/nvme/<controller>/` in
  the `devices` section, and the disk's row of its `lsblk`.
- `device_counters.before` and `.after` lie between `/sys/block/<disk>/stat` in the
  `block_stat` sections of the dumps before and after the Run.
- `nvme amzn stats` of `/dev/<disk>` (the `nvme_stats` sections) gives the device's own
  account of the same reads, with its latency histogram (28 power-of-two bins, in µs) and
  the time spent over the volume's or the instance's limits.
- An EBS serial `vol0abc…` is the volume `vol-0abc…` in `ec2_volumes`, which gives its type,
  size, IOPS and throughput; an instance-store disk is the one the `provision` section's
  record prepared (`mkfs.xfs` and `mount` of that device), and `ec2_instance_type` lists
  the instance's storage.

## What will stay unstable, and what to read with care

- **The same blocks every Run.** The device's histogram put 33.3% of the instance store's
  reads in [64, 128) µs and 66.7% in [128, 256) µs, with the same counts to the read in
  three Runs: the latency is a property of the blocks, and the Series is of these blocks.
- **gp3's first seconds.** On the root volume the first ~4,000 reads of a Run took about
  310 µs each, then 582 µs. The warmup samples took them; they show in its stream.
- **The device histogram's bins** are powers of two: they say where the tail is, not a
  percentile to the microsecond. Per-operation timing inside the binary is not done (the
  contract reads the clock only at a sample's edges); whether a disk benchmark may time
  each operation as its own sample is an open question for the maintainer.
- **Sequential equals random here.** fio measured 120.7 µs for sequential 8 KiB `O_DIRECT`
  reads at queue depth 1 on the instance store and 122.7 µs for random: an `O_DIRECT`
  sequential read would only duplicate this benchmark, which is why
  `disk_read_sequential` reads through the page cache instead.

## Differences from July's version

July's is `benchmarks/c/bench_disk_read_random.c`, variant `8 KiB`.

- **July measured the root EBS volume and reported it as the instance's disk.** A
  `c6i.8xlarge` has no disk of its own. Now each set names its disk, the binary reports
  the device it opened, and the dump proves it.
- **The Fixture is the box's, made at boot** by `runner/fixture.c` with `O_DIRECT` and
  `fdatasync`, and checked here; July's binary wrote a 4 GiB scratch file of its own with
  buffered writes before measuring, and deleted it after. The pattern is July's io_uring
  pattern; July's random-read pattern differed.
- **The span** is 1 GiB on the root volume and 32 GiB on the instance store, where July's
  was 4 GiB. The permutation's seed and the read are July's.
- **The guard** recomputes the sum of every block read from the pattern; July's checked
  block 0 before measuring and emitted an unchecked sum.
- **New:** `observed` with the device, `device_counters` and `work`; the parameters.
- **What is common to every port:** the event stream (`docs/dev-log.md` section 2), a
  static binary, and July's sampling (one repetition, then doubling until a sample lasts a
  second, then `LM_SAMPLES` counted samples), with the warmup samples emitted.
