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

Once Derivations of a version are published, a change to what it outputs is a new
version, never an edit: version 2 goes in `v2/`, beside `v1/`, with its own
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
  before-dump section whose value changed, split on or not.
- **Which Runs count**: exit code 0, every stdout line an event matching the events
  schema, and every order rule of `scripts/check-events.py` (`v1/stream.ts` is a port of it,
  and `tests/stream.test.ts` checks the two agree), with the Run's own `samples` as the
  count of counted samples to expect.
- **Failed Runs**: shown, with the reasons, in their group, in no percentile.

### What version 1 splits on, and why

The binary, the runner, the sample count, the image (`provider.image_id`), and these
sections of the before-dump: `cpuid`, `lscpu`, `sys_cpu`, `kernel` (without its
`$ uname -a` entry), `process` and `packages`. Never `source_commit` or `source`.

The sections were chosen from the Runs. In every boot available (the real `c6i.8xlarge`
boot of 2026-11-10, eight Runs, and the three sample boots in `tests/samples`), eight
sections held the same hash before and after every Run and across all Runs of the boot:
`cpuid`, `lscpu`, `sys_cpu`, `kernel`, `devices`, `process`, `packages`, `provider`.
`cpuinfo` (each CPU's current MHz) and `memory` (meminfo, loadavg, uptime) changed on
every read, before against after in every Run. Of the steady eight, three name the box
itself, and would split every boot from every other:

- `provider`: the instance ID, private address and launch time. Its instance type and
  zone ID make the Series, and its image is split on.
- `devices`: the root volume's serial, new on every launch.
- `kernel`: the host name in `uname -a`. Everything else in it is the image's (kernel
  version, command line, sysctls, transparent hugepages, clocksource, NUMA layout), so
  version 1 splits on the section without that one entry.

So `provider` and `devices` are not split on. They, `cpuinfo` and `memory` are still in
"what differed", and the page counts how often each section changed. Only one real boot
exists so far, so steadiness across boots is unproven: the next boots show it.
