# Methods

A Method is a versioned procedure that turns Runs into Derivations (`CONTEXT.md`). Its
input is a directory of Run files and the blobs they name, fetched by hash. Nothing
else: no schedule, no hand-kept list. Its output is a file of Derivations, each naming
the Method, its version, and every Run it used by id, path and the sha256 of the Run
file.

A Method is pure: the same Run files and blobs give the same bytes. So any Derivation can
be recomputed and compared with `cmp`, whoever computes it, wherever.

| Path | What it is |
|------|------------|
| `run.ts` | The Run as every version reads it: types, schema validation, dump indexes, canonical JSON |
| `v1/index.ts` | Version 1: `gather()` fetches the blobs it reads, `derive()` is the Method, `serialize()` the file |
| `v1/facts.ts` | Series key, the facts version 1 splits on and why, which Runs count |
| `v1/numbers.ts` | The number a Run gives, the median, percentiles |
| `v1/stream.ts` | Whether a stream obeys the contract's order: a port of `scripts/check-events.py` |
| `v1/output.ts` | The shape of version 1's Derivations file |

`scripts/derive.ts` runs a Method; `scripts/build-page.ts` turns its file into the page.

## Versions

Version 1 may still change until the data is first published; from then on a change
is a new version. Once Derivations of a version are published, a change to what it
outputs is a new version, never an edit: version 2 goes in `v2/`, beside `v1/`, with its own
`output.ts`, and `scripts/derive.ts` and the page learn to choose it. Rewriting a Method
never touches a stored Run; only the Run record is forever.

## Version 1, briefly

- **Series**: the Runs that share a benchmark, params, build, instance type and zone ID.
- **One number per Run**: the median, over its counted samples, of
  (`sample_ended.t` − `sample_started.t`) / `repetitions`. Warmup samples are left out.
  Where the benchmark observed `bytes_per_repetition`, bytes per second is
  `bytes_per_repetition × 10^9 /` that median.
- **Percentiles** (5th, 50th, 95th) across the counted Runs of a Series and of each
  group, by linear interpolation between closest ranks (R type 7), with the Runs behind
  them.
- **Groups**: the Runs whose split facts are all equal. They may interleave in time.
- **What differed**: for each pair of consecutive Runs, every split fact and every
  before-dump section whose value changed, split on or not, with the top-level keys
  that changed, except for the sections it does not read: `cpuinfo`, `memory`,
  `block_stat` and `nvme_stats`, which change on every read and are never fetched.
- **Which Runs count**: exit code 0, every stdout line an event matching the events
  schema, and every order rule of `scripts/check-events.py` (`v1/stream.ts` is a port of it,
  and `tests/stream.test.ts` checks the two agree), with the Run's own `samples` as the
  count of counted samples to expect.
- **Failed Runs**: shown, with the reasons, in their group, in no percentile.

### What version 1 splits on, and why

The binary, the runner, the sample count, the image (`provider.image_id`), and these
sections of the before-dump: `cpuid`, `lscpu`, `sys_cpu`, `kernel`, `process` and
`packages`, each compared whole apart from the short list of per-boot values below.
Never `source_commit` or `source`. Any other difference in those sections splits,
whether anyone foresaw it or not.

The sections were chosen from the Runs. Within every boot available (the real
`c6i.8xlarge` boots of 2026-11-10 23:36 UTC and 2026-11-11 00:23 UTC, eight Runs each,
and the three sample boots in `tests/samples`), eight sections held the same hash before
and after every Run and across all Runs of the boot: `cpuid`, `lscpu`, `sys_cpu`,
`kernel`, `devices`, `process`, `packages`, `provider`. `cpuinfo` (each CPU's current MHz)
and `memory` (meminfo, loadavg, uptime) changed on every read, before against after in
every Run. Of the steady eight, two name the box itself, and would split every boot from
every other, so they are not split on:

- `provider`: the instance ID, private address and launch time. Its instance type and
  zone ID make the Series, and its image is split on.
- `devices`: the root volume's serial, new on every launch.

Sections added to the dump since then for the disk benchmarks are not split on either,
and "what differed" lists each one that changed:

- `block_stat` (every block device's I/O counters) and `nvme_stats` (every Amazon NVMe
  disk's counters and latency histograms) change on every read, before against after,
  like `cpuinfo` and `memory`, so their contents are not fetched.
- `provision` (the box script's record of preparing its disks, with every command's start
  and end times and the disks' serials), `ec2_volumes` (the volumes' IDs, creation times
  and status) and `ec2_instance` (the instance's ID, addresses and launch time) are new on
  every boot.
- `ec2_instance_type`, the catalog record of the instance type, is taken once per boot:
  the instance type already makes the Series, AWS may revise the record without the
  machine changing, and a failed call records its error instead.

### What is left out of a section before it is compared

Between the two real boots, `sys_cpu`, `process`, `packages`, the binaries, the runner
and the image were identical. Three sections differed, each only in a value assigned or
measured anew at every boot. Version 1 leaves out exactly these (`LEFT_OUT` in
`v1/facts.ts`), and nothing else:

| Section | Left out | Why, with what the Runs show |
|---------|----------|------------------------------|
| `cpuid` | Every line of hypervisor leaf `0x40000010` (one per CPU) | Its `eax` is the TSC frequency in kHz, as calibrated for the boot: `0x002c401c` = 2,899,996 on the first boot, `0x002c400a` = 2,899,978 on the second. Those 32 lines were the only difference among the 2,240 lines of each dump. |
| `lscpu` | The `BogoMIPS` field | The kernel's delay-loop calibration at boot, from the same TSC frequency: `5799.99` and `5799.95`. It was the only difference. |
| `kernel` | The `$ uname -a` entry | It holds the host name, which comes from the private address and is new on every launch. The kernel version, command line, sysctls, transparent hugepages, clocksource and NUMA layout in the rest of the section were identical. |

The fact read from one of these sections is `canonical-json-sha256:<hex>`: the sha256 of
what remains, as JSON with keys sorted and no whitespace; `lscpu`'s output is parsed and
re-written that way too, without any entry whose field is `BogoMIPS:` (if it does not
parse as JSON, it is compared as it is). With these left out, each of the eight real
Series is one group of two Runs; without them, every boot was a group of its own.

"What differed" still lists every section whose raw hash changed, and marks each change:
it splits, it lies only in what is left out, or the section is not split on. If a value
on this list turns out to matter, or another per-boot value turns up, that is a new
version, never an edit to this one.
