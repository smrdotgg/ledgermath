# Methods

A Method is a versioned procedure that turns Runs into Derivations (`CONTEXT.md`). Its
input is a directory of Run files and the blobs they name, fetched by hash. Nothing
else: no schedule, no hand-kept list. Its output is a file of Derivations, each naming
the Method, its version, and every Run it used by id, path and the sha256 of the Run
file.

A Method is pure: the same Run files and blobs give the same bytes. So any Derivation can
be recomputed and compared with `cmp`, whoever computes it, wherever.

Two Methods exist, each with a name and a version:

- **`series`**, version 1, in `v1/`: every Series, one number per Run, percentiles across
  Runs.
- **`requests`**, version 1, in `requests/v1/`: the Series whose samples are requests, a
  distribution of each phase across the requests, within each Run and pooled.

`requests` is a Method of its own, not version 2 of `series`: a version replaces the one
before it, and `series` v1 goes on giving every Series, the Series of requests included,
its one number per Run. Method `series` keeps the directory it had before there were two
(`v<n>/`); any later Method goes in `<name>/v<n>/`.

| Path | What it is |
|------|------------|
| `run.ts` | The Run as every version reads it: types, schema validation, dump indexes, canonical JSON |
| `records.ts` | A stream's reduced record, kept between runs: the store, its keys, and reading each stream once for every Method |
| `v1/index.ts` | Method `series` v1: `gather()` fetches the blobs it reads, `derive()` is the Method, `serialize()` the file |
| `v1/facts.ts` | Series key, the facts version 1 splits on and why, which Runs count |
| `v1/numbers.ts` | The number a Run gives, the median, percentiles |
| `v1/stream.ts` | Whether a stream obeys the contract's order: a port of `scripts/check-events.py` |
| `v1/record.ts` | Version 1's reduced record of a stream: its summary |
| `v1/output.ts` | The shape of version 1's Derivations file |
| `requests/v1/index.ts` | Method `requests` v1: `gather()`, `derive()`, `serialize()` |
| `requests/v1/requests.ts` | A stream read request by request: the phases, the facts of each request's connection, failures |
| `requests/v1/numbers.ts` | Percentiles per mille, the support rule, the histogram's bins, percentiles read from a histogram |
| `requests/v1/record.ts` | Its reduced record of a stream |
| `requests/v1/output.ts` | The shape of its Derivations file |

`scripts/derive.ts` runs the Methods; `scripts/build-page.ts` turns their files into the page.

## Versions

A version may still change until its data is first published; from then on a change
is a new version. Once Derivations of a version are published, a change to what it
outputs is a new version, never an edit: version 2 of `series` goes in `v2/`, beside `v1/`
(of `requests`, in `requests/v2/`), with its own `output.ts`, and `scripts/derive.ts` and
the page learn to choose it. Rewriting a Method never touches a stored Run; only the Run
record is forever.

## The reduced record of a stream

A Method reads a Run's events from its stdout blob, 4 KB for most benchmarks and 150 to
750 KB for `http_get`. Each Method reduces a stream once to a small record of exactly what
its Derivations need of it (`StreamReducer` in `records.ts`), and a store keeps the records
between runs (`scripts/derive.ts --records DIR`, as
`DIR/<method>-v<version>-r<revision>/<stdout hex>.json`). A stream is fetched only when a
Method asked for has no record of it, and then once for all of them.

- **The key** is the stdout blob's hash and the reducer's key, `series-v1-r1` or
  `requests-v1-r1`: the Method, its version, and the revision of the record's form, which
  goes up whenever the code that makes the record or the form it is kept in changes, so a
  record made by other code is never read as this code's.
- **A record that does not parse, names another reducer or blob, or lacks the reducer's
  form** is ignored, and the stream read again.
- **The same bytes, kept or not.** A record is always used as it reads back from its kept
  form, on the run that makes it as on every later one, so the Derivations are the same
  bytes with or without kept records (`tests/requests-method.test.ts`,
  `tests/stdout-events.test.ts`).
- **What a record holds.** For `series` v1, its stream summary: the stream's problems, its
  count of counted samples, each counted sample as `[sample, ns, repetitions]`, and the bytes
  per repetition observed. For `requests` v1, see below.

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
  `block_stat`, `nvme_stats` and `net_counters`, which change on every read and are never
  fetched.
- **Which Runs count**: exit code 0, every stdout line an event matching the events
  schema, and every order rule of `scripts/check-events.py` (`v1/stream.ts` is a port of it,
  and `tests/stream.test.ts` checks the two agree), with the Run's own `samples` as the
  count of counted samples to expect. The events are read from each Run's stdout blob,
  which `gather` fetches with its dumps (`readStream`, `methods/run.ts`), reduces to what
  the Derivations need (`summarizeStream`, `v1/facts.ts`) and lets go, for every Run:
  those written before the runner stopped copying them into the record count as they did
  when version 1 read them there, byte for byte (`tests/samples/older-shape-derivations.json`).
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

Nor are those added for the Service benchmarks:

- `net_counters` (the network card's own statistics, `ethtool -S`, and the kernel's
  `/proc/net/dev`, `snmp` and `netstat`) changes on every read, so its contents are not
  fetched.
- `network` (routes, MTUs, TCP and socket settings, the resolver's files, the network
  driver), and `ec2_route_tables` and `ec2_vpc_endpoints` (the EC2 API's record of the
  path out of the subnet, once per boot) were added after version 1's facts were chosen;
  a Method that reads requests one by one is the place to split on them.

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

## Method `requests`, version 1

For the Series whose samples are requests: a distribution of each phase of a request,
within each Run and pooled across Runs.

### Which Runs

A Series (`series` v1's key: benchmark, params, build, instance type and zone ID) is this
Method's when the stream of any of its Runs holds a request: a `response_ended` or a
`request_failed` event carrying a whole-number `request`, the two ways a request ends in the
binary's contract (`benchmarks/http_get/README.md`). Then every Run of the Series is in it,
counted or not, so a Run whose stream breaks is shown with why. Nothing is keyed on a
benchmark's name; a Series whose Runs' streams never hold a request is not this Method's.

**A Run counts** when its binary exited 0 or 4 (4: the Run completed and holds at least one
failed request), its stream passes every check `series` v1 makes (each line an event of the
schema, every order rule of `scripts/check-events.py`), it has as many counted samples as
the Run asked for (fewer: the Run was cut short, at its budget or because nothing was
reachable), every request reads as below, and an exit 0 has no failed request. Any other
Run is failed: shown, with the reasons, in no figure. A Run that exited 1 (a body that did
not match the Fixture) or was killed is failed.

### One request

Each counted sample (`warmup` false) is one request. Its phases are differences of event
timestamps, in nanoseconds of the Run's clock, exactly as the binary's README defines them:

| Phase | Interval |
|---|---|
| `dns` | `name_resolved.t − sample_started.t` (new connection only) |
| `connect` | `connection_opened.t − name_resolved.t` (new connection only) |
| `tls` | `connection_secured.t − connection_opened.t` (new connection only) |
| `send` | `request_sent.t − connection_secured.t`; over a reused connection `request_sent.t − sample_started.t` |
| `first_byte` | `first_byte.t − request_sent.t` |
| `headers` | `response_headers.t − first_byte.t` |
| `body` | `response_ended.t − response_headers.t` |
| `total` | `sample_ended.t − sample_started.t` |

- **Succeeded**: its status (`response_headers.status`) is 2xx and its body matched
  (`response_ended.fixture` and `.s3_checksum` both `match`). Its events, `certificate`
  aside, must then be `name_resolved`, `connection_opened`, `connection_secured`,
  `request_sent`, `first_byte`, `response_headers`, `response_ended` in that order (a new
  connection: the three first on one connection) or the last four (a reused connection,
  opened and secured outside any sample), every phase at least 0, `sample_ended` at
  `response_ended`'s `t`, and one `request` throughout. Only succeeded requests are timed.
- **Failed**: it holds a `request_failed` (counted by its `phase` and `error`), or its
  status is not 2xx (phase `response`, kind `status_<code>`), or a line of it was withheld
  (phase `record`, kind `line_withheld_<event>`). Counted per Run and pooled, never timed.
  The warmup request's failure, and reused-connection setups that failed outside any sample
  (`connection_failed`), are counted apart.
- **Its connection's facts**, from the connection it went over: `address_block` (the /16 of
  the IPv4 address connected to, `a.b.0.0/16`; any other address whole), `cipher`,
  `tls_version` and `tls_group` (`connection_secured`'s `cipher`, `tls`, `group`).

Anything else in a sample is a problem: the Run breaks the contract.

### Within a Run

For each phase, over the Run's succeeded counted requests: the count, least and greatest
time, and the 50th, 90th, 95th, 99th and 99.9th percentiles, each exactly, by linear
interpolation between closest ranks (R type 7, `series` v1's rule, per mille here): with n
times sorted and h = (n − 1) × q / 1000, x[⌊h⌋] + (h − ⌊h⌋) × (x[⌊h⌋+1] − x[⌊h⌋]).

**The support rule.** The q-th per-mille percentile of n requests is reported only when
n × (1000 − q) ≥ 1000, that is when at least one request is expected above it: a median
needs 2 requests, a 90th 10, a 95th 20, a 99th 100 and a 99.9th 1000. So a Run of 200
requests has no 99.9th, and a Run of 40 (16 MiB) no 99th. Beside each percentile reported,
`at_or_above` is how many requests are ranked at or above it, n − ⌈h⌉, ties counted by
rank: for the 99th of 200 requests, 2.

### The histogram

Each phase's times are tallied in fixed bins, the same for every Run, so the tallies of any
Runs add. Below 128 ns every nanosecond is a bin (bin = ns). From 128 ns, with e = ⌊log2 ns⌋,
each doubling [2^e, 2^(e+1)) is cut into 64 bins of width 2^(e−6):
bin = 64 × (e − 5) + ⌊ns / 2^(e−6)⌋ − 64. A bin is at most 1/64 as wide as the least time
in it. Every power of two is exact in a double, so the bin of a time is computed exactly.

### Pooled

Across the counted Runs of a Series, and of each group (`series` v1's split facts and
letters: the same groups `series` v1 gives the same Runs), the Runs' tallies are summed. The
count, least and greatest are exact. Each percentile follows the same rules as within a Run,
with each ranked time read as the middle of its bin (the time itself in a bin of width 1),
held between the least and greatest, the least and greatest themselves exact: so a pooled
percentile is **within 1/128 (0.78%)** of the exact percentile of the same requests. A
Series of one Run therefore pools to figures within that of the Run's own. Each pooled
phase gives its histogram, `[bin, count]` pairs.

**Through each Run**, the pooled figures (without histograms) of the counted Runs that
started at or before it, for the Series and, when it has more than one group, for its
group: what a citation of the Series as of that Run's start is checked against.

**What the requests showed differed.** The pooled figures again for the requests that had
each value of a fact each request records (`address_block`, `cipher`, `tls_version`,
`tls_group`), for every fact that took more than one value among the pool's requests, with
how many Runs and requests each value had. Only the newest moment's breakdown is kept.

### Memory and the record

Each stream is read once, reduced to its record and let go. The record holds: whether the
stream holds requests, its problems, its count of counted samples, the counts of succeeded
and failed requests, each phase's exact statistics and tally, each request fact's values
with the tallies of the requests that had each (none when one value had them all), and the
failures counted by phase and kind. Its size grows with the bins a Run's times fall in, at
most 64 per doubling, never with the number of requests: 5 KB for a Run of 200 requests
over one connection, 16 KB over new connections. The pooled figures are made from the
records alone.

### What it writes

One file of Derivations (`ledgermath.derivations/1`, method `{"name": "requests",
"version": 1}`): the definitions above in words, the phases, the percentiles with the fewest
requests each needs, the histogram's definition and precision, the request facts, `series`
v1's split facts, and per Series its Runs cited by id, path and sha256, each Run's exact
figures, failures and the figures through it, the pooled figures with histograms and
breakdowns, and each group's. JSON, two-space indented, except that a value whose members
are all primitives or arrays of them (one phase's statistics, a histogram) is written on one
line. The same Runs give the same bytes, records kept or not, whatever order the files come
in.
