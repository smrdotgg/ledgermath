# Methods

A Method is the versioned procedure that turns Runs into the numbers LedgerMath publishes. This page says, for each of the two Methods, what a reader needs to quote one of its numbers correctly: which Runs count, what is taken from each Run, how the figures across Runs are made, and when a figure is null.

Two Methods exist: `series` version 1, which derives every Series, and `requests` version 1, which derives the Series any of whose Runs' streams holds a request (on 2026-11-26, the 25 Series of `http_get`). The terms used here are defined in the [glossary](/docs/glossary).

## Each Method's own words

Each Method publishes its own definitions in the API, and those words are the authority. Both Methods' words are in the list of every Series, `https://api.ledgermath.com/v1/series.json`, under `methods.series_v1` and `methods.requests_v1`. A Series file repeats the words of each Method that derives that Series, under `derivations.series_v1` (in every Series file) and `derivations.requests_v1` (only in the file of a Series `requests` v1 derives; on 2026-11-26, 25 of the 187).

| Where | What it holds |
|---|---|
| `definitions` | How each number is made, in the Method's words, by name: `series`, `counted`, `time_per_repetition`, `bytes_per_second`, `percentiles`, `groups`, `differed` for `series` v1; `series`, `counted`, `request`, `succeeded`, `failed`, `per_run`, `support`, `histogram`, `pooled`, `through`, `groups`, `breakdown`, `recorded` for `requests` v1 |
| `split_on` | The facts that split a Series into groups, with what each is |
| `left_out` | What is removed from a dump section before it is compared, and why |
| `not_split_on` | (`series` v1) Facts the Runs record that do not split a Series, and why |
| `phases`, `percentiles`, `histogram`, `request_facts` | (`requests` v1) The phases of a request, the percentiles with the fewest requests each needs, the histogram's bins and precision, the facts each request records |

This page quotes those definitions, and says where it only summarises one. Where this page and a published definition seem to differ, the published definition is right.

## Method `series`, version 1

### Which Series

"The Runs that share a benchmark, params, build, instance type and zone ID." (`definitions.series`.) A Series' id is the first 12 hex digits of the sha256 of that key written as JSON with object keys sorted at every depth and no whitespace, as the [glossary](/docs/glossary) shows.

### Which Runs count

`definitions.counted` is the whole rule, and decides. This list names its main conditions only. A Run counts when:

- its binary exited with code 0;
- every line of its stdout is an event that matches the events schema (`https://api.ledgermath.com/v1/schemas/events.schema.json`);
- its stream obeys the order rules the definition lists: among them, `started` first and once, and not marked `quick: true`; `finished` last and once; samples numbered from 0, never overlapping; each `observed` key once; exactly one `verified`;
- it holds exactly as many counted samples as the Run asked for (`samples`).

Any other Run is failed. A failed Run is shown, as a point with `counted: false` and its reasons in `failure`, and is in no percentile; `failed_runs` counts it. The number is taken from the samples, so a Run whose stream is broken, out of order, or without exactly the samples it asked for gives none. Version 1 counts no exit code but 0: what another code means is the benchmark's own. So an `http_get` Run that exited 4 is failed here even when Method `requests` v1 counts it.

### The one number a Run gives: time per repetition

"Per Run: for each counted sample (warmup samples left out), sample_ended.t minus sample_started.t, divided by the sample's repetitions; the Run's number is the median of those (the mean of the two middle values when there is an even number of samples)." (`definitions.time_per_repetition`.)

- It is in nanoseconds of the Run's clock, as `time_per_repetition_ns` on the Run's point. The point also lists each counted sample's `ns`, `repetitions` and `ns_per_repetition` (`samples`).
- It is null when the Run is not counted. It is also null if it overflows a double, which no real clock comes near; such a Run is still counted.
- Warmup samples are never used.
- An `http_get` sample is one request, of one repetition, so its number is the median, over its counted samples, of a whole request's time from `sample_started` to `sample_ended`.

### Bytes per second

"Per Run, where the benchmark observed bytes_per_repetition: bytes_per_repetition × 10^9 / the Run's time per repetition in nanoseconds." (`definitions.bytes_per_second`.)

- `bytes_per_repetition` is the first finite positive `bytes_per_repetition` the benchmark reported in an `observed` event's `values`. A stream with none has none.
- A point's `bytes_per_second` is null when the Run is not counted, when the benchmark observed no bytes per repetition, or when the quotient is infinite, chiefly when the time per repetition is 0. A counted Run whose quotient is infinite is still among the Runs of the bytes-per-second percentiles, though its point shows null.
- A Series' or group's `bytes_per_second` percentiles are null when no counted Run observed bytes per repetition. On 2026-11-26 that was every Series of `http_get`, `mutex` and `syscall` (`https://api.ledgermath.com/v1/series.json`, read that day).
- Its percentiles are taken over the bytes-per-second values themselves, so they are not the time percentiles inverted.

### Percentiles across Runs

"5th, 50th and 95th percentiles across the counted Runs of a Series, and of each group, by linear interpolation between closest ranks (R type 7): with n values sorted, h = (n − 1) × p / 100 and the percentile is x[⌊h⌋] + (h − ⌊h⌋) × (x[⌊h⌋+1] − x[⌊h⌋])." (`definitions.percentiles`.)

- Each counted Run gives at most one value of each number, so `p5`, `p50` and `p95` are percentiles across Runs. They are not percentiles of samples or of requests.
- Which Runs enter: for `time_per_repetition_ns`, every counted Run; for `bytes_per_second`, the counted Runs that observed bytes per repetition.
- `count` is the number of Runs that entered. With one Run, all three equal its value.
- A Run whose value is infinite (its point shows null) still enters and is counted. A percentile taken from that value, or interpolated towards it, is null, though the statistic has a `count`.
- Example, with four made-up values 10, 20, 30 and 40: `p5` = 11.5 (h = 0.15), `p50` = 25 (h = 1.5), `p95` = 38.5 (h = 2.85).
- The Series' percentiles (`percentiles`) are taken over the Runs that enter from the whole Series, whatever their group; each group's (`groups[].percentiles`) over those of its own Runs.
- `time_per_repetition_ns` is null when no Run counts; `bytes_per_second` is null when no counted Run observed bytes per repetition.

### Groups and split facts

"Within a Series, the Runs whose split facts are all equal make one group. Groups are lettered in the order each first appears, and may interleave in time." (`definitions.groups`.)

- The split facts are listed in `split_on`: the binary that ran, the runner, the sample count, the image, and the dump sections `cpuid`, `lscpu`, `sys_cpu`, `kernel`, `process` and `packages`.
- `left_out` lists the three values removed before a section is compared, each measured or assigned anew at every boot. `not_split_on` lists the other facts the Runs record, each with why it does not split. The source commit is one of them.
- Each group gives its `facts`, its `counted_runs` and `failed_runs`, and when its oldest and newest Run started, counted or not.
- The month files hold a `differed` entry for each pair of consecutive Runs: which split facts and which dump sections changed, each section marked `splits`, `left out` or `not split on`.
- Version 1 splits only on recorded facts. A Run whose binary the Series has not seen before is in a new group, but the hash says only that the bytes differ, not why a figure moved. Runs that differ in a way no fact records are in one group when their split facts are equal.

### A Series with several groups

Several groups are common: 162 of the 187 Series had more than one on 2026-11-26 (`derivations.series_v1.groups` in `https://api.ledgermath.com/v1/series.json`, read that day). Version 1 does not say which group is current, or whether a change of split fact moved the figures.

- The Series' percentiles mix every group. To quote a figure for one setup, choose the group whose `facts` match that setup, and quote its percentiles with its letter, its `count` and the facts that set it apart.
- To see what split two groups, compare their `facts`, or read the `differed` entry where the letter changes.
- The group of the Series' newest Run is the `group` of the last point in `newest_points`, which are in time order. A group's `newest_run_started_at` is when its newest Run started, counted or not. Groups may interleave in time, so a group with no recent Run can gain Runs again.

Example, from `https://api.ledgermath.com/v1/series/7174549b8626.json`, read 2026-11-26 (the file changes as Runs arrive): the Series of `memory_read` with `path` `scalar` and `threads` `all`, build `static`, on `m5.large` in `use2-az3`, has 64 Runs, all counted, in two groups. Group A holds 2 Runs, both started on 2026-11-11; group B holds 62, the newest started on 2026-11-26. Their facts differ in the runner and the `packages` section. The Series' `bytes_per_second` `p50` is 11113430632.35203 bytes per second, and so is group B's.

## Method `requests`, version 1

### Which Series

"A Series is this Method's when any of its Runs' streams holds a request (a response_ended or request_failed event carrying an integer `request`); every Run of it is then shown, counted or not." (`definitions.series`.) Its Series are `series` v1's, by the same key. On 2026-11-26 these were the 25 Series of `http_get`. Method `series` v1 derives them too.

### Which Runs count

`definitions.counted` is the whole rule, and decides. This list names its main conditions only. A Run counts when:

- its binary exited 0 or 4;
- its stream passes every check of `series` v1: the events schema, the order rules, exactly the samples asked for;
- every timestamp is a whole number of at most 2^53 − 1;
- its stream holds a request: a `response_ended` or `request_failed` carrying an integer `request`;
- every sample, the warmup's included, reads as one request;
- the counted requests that succeeded all have the same phases (all over a new connection, or all over a reused one);
- every `connection_failed` outside a sample has a `phase` and an `error` that are words of a-z, 0-9 and _ starting with a letter, whatever the exit code;
- for exit 0, no request, warmup request or setup of a kept connection failed.

Any other Run is failed: shown with its reasons, in no figure.

Exit code 4 is accepted because `http_get` exits 4, only after printing its whole stream, when a request failed (an error status included), a setup of a kept connection failed, or it made fewer requests than it was asked for. The Method counts the failed requests instead of discarding the Run; a Run that made fewer requests than it asked for still fails, on the count of samples. In the definition's words, "the Method reads nothing into a 4 that it does not read into a 0, but for the last rule here, which holds an exit 0 alone".

### A request and its phases

A request is "One counted sample of the stream (warmup false)" (`definitions.request`). Its phases are differences of event timestamps, in nanoseconds of the Run's clock, as `phases` gives them:

| Phase | Name | Interval |
|---|---|---|
| `dns` | name lookup | `name_resolved.t − sample_started.t` (new connection only) |
| `connect` | connect (TCP) | `connection_opened.t − name_resolved.t` (new connection only) |
| `tls` | TLS handshake | `connection_secured.t − connection_opened.t` (new connection only) |
| `send` | send the request | `request_sent.t − connection_secured.t`; over a reused connection, `request_sent.t − sample_started.t` |
| `first_byte` | wait for the first byte | `first_byte.t − request_sent.t` |
| `headers` | headers | `response_headers.t − first_byte.t` |
| `body` | body | `response_ended.t − response_headers.t` |
| `total` | whole request | `sample_ended.t − sample_started.t` |

A request over a reused connection has only `send`, `first_byte`, `headers`, `body` and `total`. On 2026-11-26, `http_get`'s parameter sets gave `connection` as `new` or `reused`.

A request succeeded when its status is 2xx and its body matched the Fixture and S3's checksum (`definitions.succeeded`). Only succeeded requests are timed.

### A Run's own statistics, and pooled ones

- **A Run's own** (`phases` on its point; `definitions.per_run`): for each phase, over the Run's succeeded counted requests that had it, the `count`, the least and greatest time (`min`, `max`), and `p50`, `p90`, `p95`, `p99` and `p99.9`, each exact, by the same interpolation as `series` v1, per mille.
- **Pooled** (`definitions.pooled`): the counted Runs' histograms summed. The count, least and greatest are exact. Each percentile is read from the summed bins, "so it is within 0.78% of the exact percentile of the same requests" (1/128; `histogram.precision` is 0.0078125).
- Where pooled figures are: in the Series file, the Series' `pool` and each group's, each phase with its histogram as `[bin, count]` pairs; in the Series' row of `v1/series.json` and of its benchmark's list, the Series' pool only, with `runs`, `requests`, `failed` and each phase's statistics, and no histograms, failures or breakdowns.
- A pooled percentile is the percentile of every succeeded request of the counted Runs taken together. It is not an average of the Runs' own percentiles.
- A Series of one Run pools to figures within 1/128 of the Run's own, not always equal to them. Do not compare a pooled figure with a Run's own more closely than that.
- A phase no request in the set had is absent from `phases`.

### The fewest requests for each percentile

"The q-th per-mille percentile of n requests is reported only when n × (1000 − q) ≥ 1000: at least one request is expected above it." (`definitions.support`.) Here n is the phase's own `count`: the succeeded requests that had that phase, which can differ from phase to phase and from the pool's `requests`. Below these counts the percentile is null, within a Run and pooled alike:

| Percentile | Fewest requests |
|---|---|
| `p50` | 2 |
| `p90` | 10 |
| `p95` | 20 |
| `p99` | 100 |
| `p99.9` | 1000 |

Beside each percentile reported, `at_or_above` gives how many requests are ranked at or above it; "For a 99th percentile of 200 requests that is 2." On 2026-11-26 each `http_get` Run asked for 200 requests, or 40 for the 16 MiB object (the Run's `samples`; pooled counts in `https://api.ledgermath.com/v1/series.json`, read that day). So a Run's own `p99.9` was null, and so was a 40-request Run's own `p99`; pooled over enough Runs, both are reported.

### Failures

- A counted request's certificate events, and any withheld certificate line, are set aside first. It then failed when the binary withheld any other of its lines (phase `record`), when it holds a `request_failed` (its `phase`, kind its `error`), or when its complete response's status is not 2xx (phase `response`, kind `status_<code>`). A request with only a withheld certificate line can succeed and be timed. `definitions.failed` gives the rule in full.
- Failed requests are counted by phase and kind, and never timed. `failed` gives their number. The kinds are in `failures`: on each point, in each point's `through`, and in the Series' and each group's `pool` in the Series file. A row of a list gives `failed` only.
- In a counted Run, `counted_requests` is `succeeded` plus `failed`. In a pool, `requests` (the succeeded ones) plus `failed` is every counted request of its Runs.
- The warmup request's failure (`warmup_failure`) and failed setups of a kept connection (`setups_failed`) are counted apart, outside these figures.
- A failed Run's requests are in no figure: `succeeded` and `failed` are 0 on its point.

### Groups, through, and breakdowns

- **Groups** are `series` v1's, letter for letter (`definitions.groups`). What is said above for a Series with several groups holds here too.
- **Through** (`definitions.through`): each point gives `through`, the Series' pooled figures over the counted Runs that started at or before it, null before the Series' first counted Run. These are what a quotation of the Series as of that Run's start is checked against.
- **Group through**: each point also gives `group_through_as_of_run`, the pooled figures of its own group through that Run. It is null while the Series has had Runs of one group only, and while the Run's group has had no counted Run, even when `through` has figures. Do not fill such a null with `through`, which pools every group.
- **Breakdowns** (`by`, `definitions.breakdown`): the pooled figures again for each value of a request fact that took more than one value among the pool's succeeded requests. `facts` lists every value each fact took, one value included. Both are built from succeeded requests only: a value seen only on failed requests is in neither.
- **What the Runs record** (`recorded`): the Region each Run names and the Service with its inputs that are not secret. Words, not figures.

## Versions

- A Method's key is `<name>_v<version>`: `series_v1`, `requests_v1`. "A new Method, or a new version of one, is a new key beside the old ones." (`versioning` in `https://api.ledgermath.com/v1/index.json`.) The same text says that a field, once in a v1 file, keeps its name, its type and its meaning.
- `requests` is a Method of its own, not version 2 of `series`: `series` v1 still gives the Series of requests their one number per Run.
- A Method reads only the Run files and the blobs they name, and the same Runs give the same numbers.
- A figure can change whenever its Series gains a Run. Its moment is the Series' `newest_run_started_at` when the figure was read: the start of the Series' newest Run then.

## What a quotation names

- The Series' id, and the key of the Method: `series_v1` or `requests_v1`.
- The figure by its place: for example `percentiles.bytes_per_second.p50`, or `pool.phases.first_byte.p99`.
- The group's letter, when the figure is a group's.
- The count behind it: for a `series` v1 percentile, its `count`; for a `requests` v1 phase percentile, that phase's `count`, with the pool's `runs`.
- The unit: nanoseconds of the Run's clock for a time, bytes per second for bytes per second.
- The moment: the Series file's `newest_run_started_at` when the figure was read.
