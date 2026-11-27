# Glossary

The words a reader of LedgerMath's data API meets, each defined in a sentence or two as the built system uses it, with where the reader meets it.

Where the API's own published text defines a word, the entry gives the same definition and says where that text is; the published text is the authority. Field names are in `code`. A file's address written in `code`, such as `v1/series.json` or `runs/<yyyy>/<mm>/<dd>/<id>.json`, is relative to `https://api.ledgermath.com/`.

## at_or_above

Beside each percentile Method `requests` v1 reports, how many of the n requests it is taken over are ranked at or above it. With the n times sorted and ranked from 0, the q-th per-mille percentile (q = 990 for the 99th) lies at rank h = (n − 1) × q / 1000, and n − ⌈h⌉ requests are ranked at or above it, ties counted by rank (`definitions.support`). It is absent for a percentile that is not reported. Met in: every phase's statistics in [Series files](/docs/api/series) and [month files](/docs/api/series-month).

## Availability Zone ID

AWS's identifier of an Availability Zone, such as `use2-az3`, as the box reads it from the instance metadata service. It is part of a Series' key (`availability_zone_id`). A Run also records the zone's name (`provider.availability_zone`, such as `us-east-2c`). Met in: every Series' identity; [Machines](/docs/machines).

## benchmark

A program LedgerMath builds and runs on a box, named in lower case, such as `memory_read` or `http_get`. A Run names its benchmark (`benchmark`). Each benchmark is described on a page of its own, such as [memory_read](/docs/benchmarks/memory_read). Every Series of every benchmark is listed in `v1/series.json`; a benchmark's list, `v1/benchmarks/<benchmark>.json`, may leave some out, and says how many. Met in: every Series' identity; [benchmark lists](/docs/api/benchmark-list).

## benchmark's list

`v1/benchmarks/<benchmark>.json`: one benchmark's rows of the list of every Series, the same byte for byte when both files are of one update. Its address is the table of contents' `benchmarks.benchmark_file_url_template` with the benchmark's name in place of `{benchmark}`. A list may leave rows out, and says how many (`left_out`); a benchmark whose name is not 1 to 64 characters, a lower-case letter, then lower-case letters, digits and underscores, has no list. `v1/series.json` is the complete list. Met in: [benchmark list](/docs/api/benchmark-list); `benchmarks.about` in the table of contents.

## blob

Bytes stored once and named by their SHA-256, written `sha256:<hex>`. A Run names this way its binary, its source archive, its runner, its resolved compiler flags, its stdout, its stderr and its dumps. Each blob is served at `blobs/sha256/<hex>`, the table of contents' `evidence.blob_url_template`. Met in: [Run files](/docs/api/run).

## boot

One fresh launch of an EC2 instance of one instance type. The box builds the benchmarks it is to run and runs each execution LedgerMath's schedule names for its instance type, then shuts down, which terminates the instance. An execution that runs normally leaves a Run. At the end the box writes one boot summary; a boot cut off can leave Runs with no boot summary, or no boot summary. A boot's id (`boot`) is the kernel's boot id, the same in every Run of the boot. Met in: `boot` and `boot_summary` on every point; `boots` in each Series file and row.

## boot summary

The file a boot writes as it ends, at `boots/<yyyy>/<mm>/<dd>/<boot>.json`, dated by the boot's start (UTC). It names the instance, the source commit and the runner. Its parts are `runs`, the Runs the boot left; `not_run`, the executions it did not start because it was told to stop or a Service's inputs could not be had, each with the reason; `build_failures`, the builds that failed and the binaries that could not be started; `left_out`, the executions of entries that are for other instance types; and `error`, when the runner stopped on one. It is not a complete account in every case: a failed build has one entry, not one for each of its executions, and a boot that stops on an error lists only what it reached. An absence from it proves nothing. A point links its boot's summary as `boot_summary`, null when none is held. Met in: [month files](/docs/api/series-month); `recent_rounds` in the [table of contents](/docs/api/table-of-contents).

## breakdown

In Method `requests` v1, the pooled figures again for the requests that had each value of a request fact, for every fact that took more than one value among the pool's succeeded requests (`by`). Built from succeeded requests only. Met in: each pool in [Series files](/docs/api/series).

## build

A named way of building a benchmark, such as `static` or `dynamic` (`build`, the Run's `binary.build`). The box builds a benchmark from source at each boot that runs it, once for each of its builds, and the bytes that ran are kept as a blob (`binary.blob`). The build is part of a Series' key, so two builds of one benchmark are two Series. Met in: every Series' identity.

## bytes per second

Method `series` v1's second number per Run: "Per Run, where the benchmark observed bytes_per_repetition: bytes_per_repetition × 10^9 / the Run's time per repetition in nanoseconds." (`definitions.bytes_per_second`). A point's `bytes_per_second` is null when the Run is not counted, when the benchmark observed no bytes per repetition, or when the quotient is not a finite number. Met in: `bytes_per_second` on points and in percentiles; [Methods](/docs/methods).

## counted Run

A Run a Method uses in its figures. Each Method decides by its own rule, published in full as its `definitions.counted`. In outline: Method `series` v1 requires exit code 0 and a stream that passes the events schema and the order rules with exactly the samples the Run asked for; Method `requests` v1 also accepts exit code 4, and requires every sample to read as one request. One Run can be counted by one Method and failed by the other. Met in: `counted` on every point; `counted_runs`; [Methods](/docs/methods).

## Derivation

What a Method derives from one Series' Runs: every number it gives for that Series, naming the Method and its version and resting on Runs each cited by id, path and sha256. Each Method's Derivation of a Series is under `derivations.<method name>_v<version>`: summarised in the Series' row; the Series file holds each Method's summary, and the month files its points and `differed` entries. Met in: [Series files](/docs/api/series).

## differed

Method `series` v1's entry for each pair of consecutive Runs of a Series: every split fact and every section of the before-dump whose hash changed, each section marked `splits`, `left out` (its change lies only in what is left out) or `not split on`, with the top-level keys that changed for the sections that are read (`definitions.differed`). Filed in the month file of the later Run. Met in: [month files](/docs/api/series-month).

## dump

The box's environment dump, taken just before a Run's binary is launched (the before-dump) and just after it exits (the after-dump). Each is an index blob that lists the dump's sections by hash (`environment.before`, `environment.after`). Met in: [Run files](/docs/api/run).

## dump section

One part of a dump, stored as a blob of its own, such as `cpuid` (the raw cpuid leaves of every CPU), `sys_cpu` (topology, caches, vulnerabilities, microcode, cpufreq, cpuidle), `kernel`, `packages` (every installed package and version) or `memory`. Method `series` v1 lists the sections it splits on (`split_on`) and why it does not split on the others it names (`not_split_on`). Met in: group `facts` and `sections` in [Series files](/docs/api/series).

## event

One line of a Run's stdout: a JSON object with its name (`event`) and its time (`t`, whole nanoseconds on the Run's clock). Six events are universal: `started`, `observed`, `sample_started`, `sample_ended`, `verified` and `finished`. A benchmark may print events of its own, such as `http_get`'s `request_sent`. The events schema gives the shape of one line; the order of the stream is a rule of its own. Met in: the [events schema](/docs/api/events), served at `v1/schemas/events.schema.json`.

## evidence

The records behind the numbers, served under the API's address and linked, never copied: Run files (`runs/…`), boot summaries (`boots/…`) and blobs (`blobs/sha256/…`). A point's `evidence` is the address of its Run file. Met in: `evidence` in the [table of contents](/docs/api/table-of-contents); every point.

## exit code

How a Run's binary ended, in the Run's `exit`: its exit `code`, or the `signal` that ended it, with `timeout_seconds` when the runner killed it for running that long. 0 means the binary completed; any other code means what the benchmark says it means, and does not by itself mean the binary stopped short. Method `series` v1 counts a Run only with code 0; Method `requests` v1 accepts 4 as well. Met in: [Run files](/docs/api/run); `exit_code` on `requests` v1 points.

## failed request

In Method `requests` v1, a counted request that failed. When deciding the request's outcome, its certificate events and any withheld certificate line are set aside first; it then failed when the binary withheld any other of its lines (phase `record`), when it holds a `request_failed`, or when its complete response's status is not 2xx (phase `response`). `definitions.failed` gives the rule in full. A failed request is counted by phase and kind (`failures`) and never timed. Met in: [Methods](/docs/methods).

## failed Run

A Run a Method does not count. It is still shown: its point has `counted: false` and a `failure`, the first 10 of its reasons, each cut to its first 500 characters, joined by "; ", then how many more there are. It is in no figure, and is counted in `failed_runs`. Met in: [month files](/docs/api/series-month).

## Fixture

Data a benchmark reads that is written in a known pattern, so that the benchmark can check what it read: the files the disk benchmarks read, which the box makes at boot, and the S3 objects `http_get` fetches. Met in: Method `requests` v1's `definitions.succeeded` ("its body matched the Fixture").

## group

Within a Series, the Runs whose split facts are all equal. Groups are lettered A, B, C… in the order each first appears, and may interleave in time (`definitions.groups`). Both Methods give their figures for the Series and for each group; Method `requests` v1's groups are Method `series` v1's, letter for letter. Met in: `groups` in [Series files](/docs/api/series); `group` on every point.

## histogram

How Method `requests` v1 tallies a phase's times, in the same fixed bins for every Run so that tallies of different Runs add: below 128 ns each nanosecond is a bin of its own, and from 128 ns each doubling is cut into 64 bins. A pooled percentile is read from the summed bins, within 1/128 of the exact one. Published at `methods.requests_v1.histogram` in `v1/series.json`. Met in: `histogram`, as `[bin, count]` pairs, in each pooled phase of a Series file.

## image

The machine image the box booted, by AWS's ID (`provider.image_id`, such as `ami-03499a87bbb39a09a`). It is a split fact of Method `series` v1. Met in: `image` in group `facts`; [Machines](/docs/machines).

## instance store

In the disk benchmarks, the disk of a Series whose parameter `disk` is `instance_store`: the instance's own NVMe disk, not an EBS volume. The box uses it only when it finds exactly one disk whose controller's model is `Amazon EC2 NVMe Instance Storage`, as many as EC2's catalog record of the instance type lists, and that disk is empty; it then formats it with XFS, mounts it at `/mnt/lm/instance-store` and writes there the Fixture the disk read benchmarks read; `disk_write` writes a file of its own there. The schedule runs these sets on `i4i.2xlarge` only. Met in: `params.disk` of the Series of [disk_read_random](/docs/benchmarks/disk_read_random), [disk_read_sequential](/docs/benchmarks/disk_read_sequential), [disk_read_io_uring](/docs/benchmarks/disk_read_io_uring) and [disk_write](/docs/benchmarks/disk_write); dump sections `provision` and `devices`.

## instance type

The EC2 instance type a Run ran on, as AWS names it, such as `m5.large`. It is part of a Series' key (`instance_type`). Met in: every Series' identity; [Machines](/docs/machines).

## kept connection

See reused connection.

## layout

A number in the table of contents (`layout`; 2 on 2026-11-26) that increases when LedgerMath changes how the API's files are written. For a given layout, a month file changes only for the four causes the table of contents' `months` gives. Met in: the [table of contents](/docs/api/table-of-contents).

## left out

In Method `series` v1, a value measured or assigned anew at every boot, removed from a dump section before the section is compared: the lines of hypervisor leaf `0x40000010` in `cpuid`, the BogoMIPS field of `lscpu`, and the `$ uname -a` entry of `kernel`. Published, with why, at `methods.series_v1.left_out`. Met in: `differed` (`"effect": "left out"`).

## list of every Series

`v1/series.json`: one row per Series, with its identity, a summary of each Method's Derivation and its file's address; above the rows, each Method's own words (`methods`). Met in: [series list](/docs/api/series-list).

## Method

A versioned procedure that turns Runs into published numbers. Two exist: `series` version 1, for every Series, and `requests` version 1, for the Series any of whose Runs' streams holds a request. Each publishes its own definitions in the API. Met in: [Methods](/docs/methods); `methods` in `v1/series.json`.

## month file

`v1/series/<id>/<yyyy-mm>.json`: every point of a Series' Runs that started that month (UTC), under each Method, and Method `series` v1's `differed` entries. A Series file lists each month file's address, sha256 and size. Met in: [month file](/docs/api/series-month).

## new connection

In `http_get`, what a request has when its parameter `connection` is `new`: it resolves the name, connects and secures a connection of its own inside its sample, so a request that succeeds has the phases `dns`, `connect` and `tls`. See reused connection. Met in: [http_get](/docs/benchmarks/http_get); [Methods](/docs/methods).

## observed

An event in which a benchmark reports what it observed of its own work, under `values`, each key once in the stream; for example `bytes_per_repetition`, from which Method `series` v1 makes bytes per second. Met in: the [events schema](/docs/api/events); `bytes_per_repetition` on `series` v1 points.

## parameter set

The parameters one execution of a benchmark is given: one entry of the benchmark's parameter sets in LedgerMath's schedule. The binary receives each as an environment variable `LM_PARAM_<KEY>`, and the Run records them as `params`. The parameter set is part of a Series' key: a Series is one parameter set with one build, one instance type and one zone ID, so one parameter set gives a Series for each build, instance type and zone it runs with. Met in: `params` in every Series' identity.

## params

A Run's or a Series' parameter set, as a JSON object of names and values. See parameter set.

## percentile

In Method `series` v1, the 5th, 50th and 95th percentiles (`p5`, `p50`, `p95`) of one number across counted Runs of a Series or of a group, by linear interpolation between closest ranks (R type 7). Each Run gives at most one value, so these are percentiles across Runs, not across samples. Time per repetition is taken over every counted Run; bytes per second over the counted Runs that observed bytes per repetition. In Method `requests` v1, the 50th, 90th, 95th, 99th and 99.9th percentiles (`p50` to `p99.9`) of a phase's times across requests, within one Run or pooled. Met in: [Methods](/docs/methods).

## phase

In Method `requests` v1, one interval of a request between two of its events, in nanoseconds of the Run's clock: `dns`, `connect`, `tls`, `send`, `first_byte`, `headers`, `body` and `total`. Published, with the events each is the difference of, at `methods.requests_v1.phases`. Met in: [Methods](/docs/methods).

## point

A Method's record of one Run of a Series: the Run's id, start and boot, its group, whether it counts and why not, its figures, its Run file's sha256 and the addresses of its evidence. Every point is in the month file of its Run's start; a Series file repeats the points of its newest 12 Runs, or of every Run when it has fewer (`newest_points`). Met in: [month files](/docs/api/series-month).

## pool

In Method `requests` v1, every succeeded request of a set of counted Runs taken together: the Runs' histograms summed, each phase's count, least and greatest time exact, and each percentile read from the sum (`definitions.pooled`). Met in: `pool` of the Series and of each group in [Series files](/docs/api/series); in rows of the [series list](/docs/api/series-list), without histograms, failures or breakdowns.

## price file

A day's copy of AWS's public On-Demand prices selected by LedgerMath's rules, holding AWS's own records verbatim. At most one for each UTC day, named by the day its fetch started, added once and never edited, and served at `v1/prices/<yyyy-mm-dd>.json`. Met in: [Prices](/docs/prices); `prices` in the [table of contents](/docs/api/table-of-contents).

## provider

A Run's record of where it ran, in the provider's own words (`provider`). When the box could not read its instance ID from the instance metadata service, `provider` is `{"name": "unknown"}`, with no other key. Otherwise `name` is `aws`, and the others are the instance type, Region, zone name, zone ID, image ID and instance ID, as that service gives them, each null when the box could not read it. Met in: [Run files](/docs/api/run).

## Region

The AWS Region a box ran in, as the Run's provider names it (`provider.region`, such as `us-east-2`). Met in: `recorded.regions` of Method `requests` v1; `measured.region` in [price files](/docs/prices).

## repetition

One pass of the work a sample times. A `sample_started` event says how many repetitions lie between the sample's two timestamps (`repetitions`, at least 1), and Method `series` v1 divides the sample's time by that number. An `http_get` sample is one request, of one repetition. Met in: `samples` on `series` v1 points.

## request

In Method `requests` v1, one counted sample of a stream (`warmup` false): the events from its `sample_started` to its `sample_ended` (`definitions.request`). Met in: [Methods](/docs/methods).

## request fact

A fact each request records of its connection or of itself: `address_block`, `cipher`, `tls_version`, `tls_group`, `method`, `target` and `signing`. Published, with what each is, at `methods.requests_v1.request_facts`. Met in: `facts` and `by` of each pool in a Series file, which are built from succeeded requests only: a value seen only on failed requests is in neither.

## reused connection

In `http_get`, a connection opened and secured outside any sample and used by the requests that follow (its parameter `connection` set to `reused`); the API also calls it a kept connection. A request over it has no `dns`, `connect` or `tls` phase. A failed setup of such a connection is counted apart (`setups_failed`). Met in: [Methods](/docs/methods).

## root volume

In the disk benchmarks, the disk of a Series whose parameter `disk` is `root_volume`: the EBS volume the instance boots from, which holds its root file system. The disk read benchmarks read the Fixture the box makes at boot under `/var/tmp/ledgermath/disk` on it, and `disk_write` writes a file of its own there. The value names where the file is; what a figure measures is on the benchmark's page. The volume's type, size and provisioned IOPS and throughput are AWS's record in each boot's dump section `ec2_volumes`, where the dump took it. The schedule runs these sets on every instance type. Met in: `params.disk` of the Series of [disk_read_random](/docs/benchmarks/disk_read_random), [disk_read_sequential](/docs/benchmarks/disk_read_sequential), [disk_read_io_uring](/docs/benchmarks/disk_read_io_uring) and [disk_write](/docs/benchmarks/disk_write).

## round

"A round is the boots that belong together in time, worked out from the boot summaries alone, so the same boot summaries always give the same rounds: the boots in order of their start, a boot starting a new round when it started more than 40 minutes after the boot before it." (`recent_rounds.about` in the table of contents, which gives the newest 8.) Met in: `recent_rounds` in the [table of contents](/docs/api/table-of-contents).

## Run

One execution of one benchmark binary, with one parameter set, on one box, written whether it succeeded or failed. It holds the parameters it was given, the provider's own words for where it ran, and, by hash, the bytes that ran, the box's environment before and after, and its stdout, whose lines are its events. Nothing in it is a judgement: whether it counts is each Method's decision. A Run file is at `runs/<yyyy>/<mm>/<dd>/<id>.json`, dated by the Run's start (UTC); its id is a version 7 UUID. Met in: [Run file](/docs/api/run); `evidence` on every point.

## Run's clock

The clock a Run's `started` event names (`clock`). Every event's `t` is whole nanoseconds on it. "A duration is in nanoseconds of the Run's clock unless its field's name says otherwise" (`figures` in the table of contents). Met in: every duration the API gives.

## runner

The program on the box that builds the benchmarks, runs each execution, takes the dumps, and writes the Runs and the boot summary. A Run names it (`runner`) by a blob listing each of its files with its sha256. It is a split fact of Method `series` v1. Met in: `runner` in group `facts`.

## sample

One timed interval of a Run, between a `sample_started` and a `sample_ended` event of the same number; its time is the difference of their `t`. A Run asks its binary for a number of samples (`samples`, delivered as `LM_SAMPLES`), warmup samples not included. Met in: `samples` on `series` v1 points.

## Series

"The Runs that share a benchmark, params, build, instance type and zone ID." (`definitions.series` of Method `series` v1.) Its id is 12 lower-case hex digits, the first of the sha256 of its key written as JSON with object keys sorted at every depth and no whitespace, each key and value written as JavaScript's `JSON.stringify` writes it; the UTF-8 bytes of that text are hashed. For example, Series `b433e2d4c4b0` has the key `{"availability_zone_id":"use2-az3","benchmark":"compressed_memory_read","build":"static","instance_type":"c6i.8xlarge","params":{"bits":8,"blocks":1000000}}`. Met in: [Series file](/docs/api/series); [series list](/docs/api/series-list).

## Series file

`v1/series/<id>.json`: one Series' identity, the summary of each Method that derives it with that Method's definitions, the points of its newest Runs, and its months. Its address is the table of contents' `series.series_file_url_template` with the id in place of `{id}`. Met in: [Series file](/docs/api/series).

## Service

A managed service a benchmark measures from the outside, named in the benchmark's schedule entry and recorded in the Run (`service`) with the inputs that are not secret; secret inputs are named, and their values are written nowhere. On 2026-11-26 the schedule named one: `s3_fixtures`, a private S3 bucket of Fixtures. Met in: `recorded.services` of Method `requests` v1.

## split fact

A recorded fact Method `series` v1 compares between Runs to put them in groups: the binary, the runner, the sample count, the image, and the dump sections `cpuid`, `lscpu`, `sys_cpu`, `kernel`, `process` and `packages`. A fact read from a section with values left out (`cpuid`, `lscpu`, `kernel`) is written `canonical-json-sha256:<hex>`; the binary, the runner and the other sections are given by their blob's `sha256:<hex>`. A fact is null when the Run does not record it: a section its before-dump lacks, or no image ID. Published, with what each is, at `methods.series_v1.split_on`. Met in: group `facts`.

## stream

A Run's events: the lines of its stdout blob, in order. Met in: the [events schema](/docs/api/events).

## succeeded request

In Method `requests` v1, "A request whose response status (response_headers.status) is 2xx and whose body matched the Fixture and S3's checksum" (`definitions.succeeded`). Only succeeded requests are timed. Met in: [Methods](/docs/methods).

## support rule

Method `requests` v1 reports the q-th per-mille percentile of a phase only when n × (1000 − q) ≥ 1000, where n is that phase's own `count`, the succeeded requests that had the phase: 2 requests for a 50th, 10 for a 90th, 20 for a 95th, 100 for a 99th and 1000 for a 99.9th (`definitions.support`). A percentile not supported is null. Met in: `methods.requests_v1.percentiles` in `v1/series.json`.

## table of contents

`v1/index.json`: where the lists of Series, the price files, the schemas and the evidence are, with the API's own words on versioning, figures and months. Met in: [table of contents](/docs/api/table-of-contents).

## through

On each point of Method `requests` v1, the Series' pooled figures, without histograms, over the counted Runs up to and including that Run, in the Method's order (by start, then Run id) (`definitions.through`); null before the Series' first counted Run. Beside it, `group_through_as_of_run` gives the same for the Run's own group. That is null while the Series has had Runs of one group only, and while the Run's group has had no counted Run, even when `through` has figures; a null there is not to be filled with `through`, which pools every group. Met in: [month files](/docs/api/series-month).

## time per repetition

Method `series` v1's one number per Run, in nanoseconds (`time_per_repetition_ns`): "for each counted sample (warmup samples left out), sample_ended.t minus sample_started.t, divided by the sample's repetitions; the Run's number is the median of those (the mean of the two middle values when there is an even number of samples)" (`definitions.time_per_repetition`). Null on a point whose Run is not counted, and on one whose number overflows a double, which no real clock comes near. Met in: [Methods](/docs/methods).

## unreadable

A Run file that does not validate against the Run schema. It is in no Series; each Method lists it, with why, under `methods.<method name>_v<version>.unreadable` in `v1/series.json`. Met in: [series list](/docs/api/series-list).

## warmup sample

A sample marked `warmup: true` in its `sample_started` event. It is printed in the stream, is not one of the samples the Run asked for, and no Method times it. In `http_get` the warmup sample is one request, and its failure is counted apart (`warmup_failure`). Met in: the [events schema](/docs/api/events).

## zone

See Availability Zone ID. A Series is keyed on the zone's ID, not its name.
