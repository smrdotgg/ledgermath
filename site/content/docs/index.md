# From a question to a number you can cite

How to answer a question about the cost or speed of work on AWS from LedgerMath's data: find the measured figure and the price that fit the question, read them rightly, build the estimate, and cite every number so that another reader can check it.

You need nothing but a way to fetch a URL. LedgerMath gives you no program to install or run: every file named here is a static file at `https://api.ledgermath.com`, fetched with `curl` or any other client. The API's files, the Run files and the boot summaries are JSON; a blob, such as a Run's binary or its stdout, is the bytes its hash names.

## What LedgerMath holds, and what it does not

LedgerMath runs small benchmarks on real AWS machines several times a day and keeps every execution as a Run. A Series is the Runs of one benchmark, parameter set, build, instance type and Availability Zone ID; a versioned Method turns a Series' Runs into figures. Beside them, LedgerMath keeps at most one price file a day: AWS's public On-Demand prices for what it measures, in AWS's own words.

- **Measured figures** for small operations, such as reading memory, hashing, sorting, system calls, a mutex, loopback TCP, disk reads and writes, and HTTPS GETs from S3, on the instance types listed on [Machines](/docs/machines), which also says which benchmarks run on some types only. Each benchmark has a page of its own, such as [memory_read](/docs/benchmarks/memory_read).
- **AWS's prices** that LedgerMath's rules select. Rule set 1 selects each measured instance type's On-Demand Linux price by the hour, EBS gp3 storage, IOPS and throughput, S3 Standard storage and requests, and data sent out of the Region to the internet. See [Prices](/docs/prices).
- **No measured figure for anything LedgerMath has not measured.** On 2026-11-26 that meant, among others, a network between two machines, a CDN, a GPU, any Region but `us-east-2`, and any provider but AWS. Nor any price but AWS's public On-Demand price: no Reserved Instance, Savings Plan or Spot price, no negotiated or private rate, no tax ([Prices](/docs/prices), "What is not held").

LedgerMath does not estimate. You build the estimate from its numbers, and each number keeps its citation.

## Find a figure

Start from the table of contents, and follow the links each file gives. The words used below, such as Run, Series, group and point, are defined in the [glossary](/docs/glossary).

1. Fetch the table of contents:

   ```
   curl -s https://api.ledgermath.com/v1/index.json
   ```

   `benchmarks.list` names benchmarks' lists, each with how many Series it holds, as many as fit its budget (`benchmarks.unlisted` counts the lists it does not name); `series.url` is the list of every Series; `prices.newest` is the newest price file, null when none is held. See [the table of contents](/docs/api/table-of-contents).

2. Read the benchmark's page, such as [memory_read](/docs/benchmarks/memory_read), before its numbers: what a figure means, what it does not show, and what each parameter changes.

3. Fetch the benchmark's list:

   ```
   curl -s https://api.ledgermath.com/v1/benchmarks/memory_read.json
   ```

   One row per Series it lists: its `id`, `params`, `build`, `instance_type` and `availability_zone_id`; how many Runs it holds (`runs`); a summary of each Method's figures under `derivations`; and the address of the Series' file (`url`). A benchmark's list may leave rows out, and says how many (`left_out`). The list of every Series, `https://api.ledgermath.com/v1/series.json`, holds every row. See [a benchmark's list](/docs/api/benchmark-list) and [the list of Series](/docs/api/series-list).

4. Fetch the Series' file, at the row's `url`:

   ```
   curl -s https://api.ledgermath.com/v1/series/a655ffb3e7dd.json
   ```

   It holds each Method's figures beside the Method's own definitions, the Series' groups with each group's facts and figures, the points of its newest Runs, and `months`, the address, sha256 and size of each month file. See [a Series file](/docs/api/series).

   The table of contents, a benchmark's list, the list of every Series and a Series' file, fetched one after another, can be of different updates, and then disagree on a count or a row. Take each as true of its own update, and fetch them again later where they disagree.

5. To check a figure against its Runs, follow its evidence. Each month file (`months[].url`) holds the point of every Run of the Series that started that month, and each point links its Run file (`evidence`). A Run file names its binary, its stdout and the dumps of the machine by hash, each a blob at `https://api.ledgermath.com/blobs/sha256/<hex>`. See [a month file](/docs/api/series-month) and [a Run file](/docs/api/run).

   Before you use a month file, compare its sha256 with the one its Series file lists in `months`. If they differ, fetch the Series file again, then the month file, and use neither while they still differ ([the data API](/docs/api/)).

## Choose the Series that fits

Several Series can look alike: on 2026-11-26, `memory_read` had eight Series on `c6i.8xlarge`, two builds by two read loops by one thread or all. Match the parts of a Series' key to the question, and say which Series you chose, by its id, and why:

- **The benchmark**: the work it measures. Its page's "What a figure means" and "What a figure does not show" say what one figure is, and what it is not.
- **The parameters** (`params`): its page's "Parameters" says what each one changes.
- **The build** (`build`): a named way of building the benchmark, such as `static` or `dynamic`. Two builds are two Series.
- **The instance type** (`instance_type`): the question's. When the question names none, say which you used and why, or give the range across types.
- **The Availability Zone ID** (`availability_zone_id`): the zone its Runs ran in.

Where two Series fit equally well, give both, or the range across them.

For example, for a question about scanning memory with a whole `c6i.8xlarge`, [memory_read](/docs/benchmarks/memory_read)'s page says:

- `threads`: `all` reads on one pinned thread per allowed CPU; `1` is one unpinned thread, which is not what the whole box can read.
- `path`: `avx2` reads with four 32-byte loads per step, `scalar` with a loop of five x86 instructions written in assembly. A figure is of these loops: a program that reads memory with other code is not measured. Choose the loop nearer your program's, and say so.
- `build`: on the `avx2` path, the check of 2026-11-18 found no difference between the two builds. On the `scalar` path they have given different figures on some Intel instance types; an investigation found the cause in where the loop lands in each binary, not in how it is linked. Never use the pair to say that one kind of linking is faster.
- `size_bytes`: whether the buffer is read from memory or from cache depends on its size and on the machine's caches, which a Run's dump sections `lscpu` and `sys_cpu` record. A size that fits in a cache gives a cache figure, not a memory figure.

## Read a figure rightly

Each Method publishes its own definitions in the API, and [Methods](/docs/methods) says, for each Method, what you need to quote its numbers. What matters most:

- **What a percentile is taken across.** Method `series` v1 derives every Series. A counted Run can give two numbers: its time per repetition (`time_per_repetition_ns`), the median over its counted samples, and bytes per second (`bytes_per_second`), where the benchmark observed bytes per repetition; [Methods](/docs/methods) gives when a counted Run's point shows either as null. Each counted Run gives at most one value of each, so the 5th, 50th and 95th percentiles (`p5`, `p50`, `p95`) are percentiles across Runs, not of samples or of requests, and their spread is the spread across Runs. Method `requests` v1 derives the Series of requests (on 2026-11-26, the 25 Series of `http_get`): each phase's 50th to 99.9th percentiles across the counted requests that succeeded and had that phase, within each Run and pooled across Runs. A failed request gives no time, nor does the warmup, so a Run whose failures were slow can still show a good 99th percentile among its successes ([Methods](/docs/methods)). A pooled percentile is read from summed histograms, within 0.78% of the exact one.
- **The count behind it.** A `series` v1 percentile comes with `count`, the Runs it was taken over. A pooled `requests` v1 phase comes with its `count` of requests, beside the pool's `runs`, and each percentile reported comes with `at_or_above`, how many requests are ranked at or above it. Give the count with the figure, so that a reader sees how many Runs or requests it rests on.
- **Groups.** A Series' Runs are split into groups by facts recorded of each Run, such as the binary that ran, the runner and the machine image; the Method's `split_on` lists them all. The Series' percentiles mix every group, and `derivations.series_v1.groups` in its row says how many groups there are. To quote a figure for one setup, take the group whose `facts` match it from the Series' file, and quote its percentiles with its letter, its count and the facts that set it apart. Version 1 does not say which group is current: the group of the Series' newest Run is the `group` of the last point in `newest_points`, which are in time order. When you quote the Series-wide figures instead, say how many groups they mix.
- **Null.** A null figure is not held; it is never a zero. Among the causes: no counted Run, for `time_per_repetition_ns`; no counted Run that observed bytes per repetition, for `bytes_per_second` (on 2026-11-26, every Series of `http_get`, `mutex` and `syscall`); too few requests for a `requests` v1 percentile, which needs 2 for a 50th, 10 for a 90th, 20 for a 95th, 100 for a 99th and 1000 for a 99.9th. A phase no request had, such as `dns`, `connect` and `tls` over a reused connection, is absent. Never fill a null from another figure: say the figure is not held, and why. [Methods](/docs/methods) gives every case.
- **Units.** A duration is in nanoseconds of the Run's clock unless its field's name says otherwise. Bytes per second are bytes per second. A price is per its own `unit`, in AWS's words.
- **Runs a Method does not count.** Each Method decides which Runs it counts. A Run one Method does not count is still shown, as a point with `counted: false` and why, and is left out of that Method's figures; another Method may count it. An `http_get` Run that exited 4 is not counted by `series` v1, and can be by `requests` v1. `counted` and `failed_runs` are each Method's own.

## Find a price

1. The table of contents lists every price file (`prices.files`, oldest first) and the newest (`prices.newest`), each with its `date`, its `path` and its `url`:

   ```
   curl -s https://api.ledgermath.com/v1/prices/2026-11-26.json
   ```

2. Find a price by the name of the rule that selected it, not by searching AWS's words: in the file of 2026-11-26, a search for "storage" also finds every instance type's product. In `sources[]`, the selection whose `rule` names it lists its SKUs (`skus`); the product is `products[<sku>]`, and its prices are under `terms.OnDemand[<sku>]`, one price dimension per rate code. [Prices](/docs/prices) lists the rules, such as `ec2-instance-on-demand-linux` for an instance's hour, `data-transfer-out-to-internet` for data sent out to the internet and `s3-standard-requests` for S3 requests.

3. Read `pricePerUnit` against its `unit`, not against AWS's `description`, which can state the same price per another quantity. In the file of 2026-11-26, the S3 GET price is `0.0000004000` USD per `Requests`, which its description gives per 10,000 requests.

4. **Tiers.** In the file of 2026-11-26, each price with tiers is one product whose On-Demand term holds one price dimension per tier, each with its own rate code, its `beginRange` and `endRange`, and its price; AWS's descriptions give the tiers per month. LedgerMath applies no tier and states no rule for how AWS applies them. Cite each tier you use, with its bounds, and say in words how you applied them, as an assumption. For data sent out to the internet, that includes how you combine the global free tier, a record of its own, with the Region's tiers.

5. **AWS's words.** The price files give `GB`, `GB-Mo` and every other unit as AWS writes them; [Prices](/docs/prices) says what is, and what is not, published about how many bytes AWS's GB is. An instance type's product also carries AWS's catalog words, such as `memory` ("64 GiB" for `c6i.8xlarge` in the file of 2026-11-26) and `vcpu`. They are AWS's text, not LedgerMath's measurements: quote them as AWS's, and mark your reading of one as a number as your assumption.

A price being held does not mean LedgerMath measures what it prices, and a price file holds only the records its rules select.

## Build the estimate

1. **Write the model** as a few factors with units, such as cost = downloads × size × price per GB.
2. **Fill each factor** with a number from LedgerMath and its citation, a quantity from the question, or an assumption, marked as one, with where it comes from. A quantity the question leaves to you, such as the size of an update, is an assumption. When the answer needs a measurement LedgerMath does not hold, see below.
3. **Check that each figure fits what you use it for.** Read the benchmark's "What a figure does not show", and say so whenever you use a number outside what it measured: another instance type, one thread for a whole box, a loopback figure for a network, a client sending one request at a time for one under load, AWS's catalog words for a measurement.
4. **Check capacity as well as rate.** Where data must be held somewhere, in memory or on a disk, count the machines its size needs as well as those the rate needs, and take the larger. Some questions can be read both ways: "scan 10 TB a second" is a rate, and can also be a 10 TB data set that must fit in memory. Say which reading you answer, or answer both.
5. **Show the arithmetic**, one operation per line, every operand in digits with its unit. Round a count of machines up.
6. **Give a range** where the Runs give a spread: carry the 5th and the 95th percentile through the same arithmetic as the 50th. For a time, the slow end is the 95th percentile; for a rate, such as bytes per second, it is the 5th. Name what dominates the uncertainty.
7. **Never state a number LedgerMath does not hold as if it did.** An assumption is never written as a measurement, and AWS's catalog words are never written as LedgerMath's.

## What a citation names

A citation tells another reader where a number came from. As [Methods](/docs/methods) gives it, a figure's citation names:

- the Series' id, and the key of the Method: `series_v1` or `requests_v1`;
- the figure by its place: for example `percentiles.bytes_per_second.p50`, or `pool.phases.first_byte.p99`;
- the group's letter, when the figure is a group's;
- the count behind it: for a `series` v1 percentile, its `count`; for a pooled `requests` v1 phase percentile, the phase's `count` and the pool's `runs`; for one Run's own, the phase's `count` and the Run;
- the unit: nanoseconds of the Run's clock for a time, bytes per second for bytes per second;
- the moment: the Series' `newest_run_started_at`, in its file or its row, when you read the figure. It helps a later reader find the state of the Series you read, but does not pin it: a Run that arrives late, having started before the Series' newest, can change a figure while `newest_run_started_at` stays the same. If an exact check matters, keep the values you read.

For example:

```
Series a655ffb3e7dd, series_v1, percentiles.bytes_per_second.p50: 145497618462.33847 bytes per second, count 63, as of 2026-11-26T16:13:49.030665839Z
```

A price is cited by the price file's path, the SKU and the rate code, and a tier's bounds by the same price dimension's `beginRange` and `endRange` ([Prices](/docs/prices)). The path holds the file's date, which says which day's price you used:

```
prices/2026/11/26/aws.json, SKU NKB8DU47ZKKBXW65, rate code NKB8DU47ZKKBXW65.JRTCKXETXF.6YS6EN2CT7: 1.3600000000 USD per Hrs
```

An assumption says where it comes from: "20 GB (assumption: the size of the update)".

## When LedgerMath does not hold the answer

When the answer turns on a measurement or a price LedgerMath does not hold:

1. Say so first, plainly.
2. Name the nearest thing it does hold, and say why it is not the same thing.
3. Stop. Do not put an assumed or adjusted number in the missing one's place, and do not scale the nearest figure to stand for it. Say what would have to be measured.

When the question can also be answered for a design LedgerMath does price, you may answer it for that design: say so as an assumption, and say what is not priced. The first example below prices an update sent straight from S3, and says that a CDN is not priced.

## Worked examples

Each example takes its numbers from LedgerMath's fixed sample of the API, taken on 2026-11-26, and names the address of each file it read: that address serves the file as it is now, so your figures can be newer. Every input is in a table with where it comes from, every result is worked in the lines below it, and the answer names each result by its line.

<details>
<summary>Example: the cost of sending a game update to 30 million players, at a price with tiers</summary>

**Question.** What would it cost to distribute a new update of a large game to 30 million players?

This question needs prices only: in this model the cost is per GB sent and per request, so no Series is used. The prices are from the price file `https://api.ledgermath.com/v1/prices/2026-11-26.json`, path `prices/2026/11/26/aws.json`, as LedgerMath's fixed sample took it on 2026-11-26. A price file is never edited, so that address serves the same file.

**Model.** cost = transfer cost + request cost. The transfer is players × downloads per player × size, priced tier by tier after the global free tier. The requests are players × downloads per player × requests per download × the price of a GET request.

**Assumptions.** The update is served from S3 Standard in `us-east-2` straight to the players, and is charged as data sent out of the Region to the internet, with one GET request per download. Every download falls in one calendar month, the period AWS's descriptions give the tiers. Nothing else goes out to the internet that month. AWS counts the global free tier first and applies the Region's tiers, from their start, to the rest; LedgerMath states no rule for how AWS applies them, so this order is an assumption.

| Input | Value | From |
|---|---|---|
| Players | 30000000 | the question |
| Downloads per player | 1 | assumption: each player downloads the update once |
| Size of the update | 20 GB | assumption: the size of one download, in the unit of the price |
| GET requests per download | 1 Requests | assumption: one GET request for each download, in the unit of the price |
| Global free tier, bounds | 0 to 100 GB | `prices/2026/11/26/aws.json`, SKU `PB257JUQ8U6E6UPM`, rate code `PB257JUQ8U6E6UPM.A429C66SYZ.ETY2894C67`, `beginRange` to `endRange` |
| Global free tier, price | 0.0000000000 USD per GB | `prices/2026/11/26/aws.json`, SKU `PB257JUQ8U6E6UPM`, rate code `PB257JUQ8U6E6UPM.A429C66SYZ.ETY2894C67`, `pricePerUnit.USD` |
| Tier 1, bounds | 0 to 10240 GB | `prices/2026/11/26/aws.json`, SKU `36H7S3NU9B7S3UT5`, rate code `36H7S3NU9B7S3UT5.JRTCKXETXF.Q3Z75P77EN`, `beginRange` to `endRange` |
| Tier 1, price | 0.0900000000 USD per GB | `prices/2026/11/26/aws.json`, SKU `36H7S3NU9B7S3UT5`, rate code `36H7S3NU9B7S3UT5.JRTCKXETXF.Q3Z75P77EN`, `pricePerUnit.USD` |
| Tier 2, bounds | 10240 to 51200 GB | `prices/2026/11/26/aws.json`, SKU `36H7S3NU9B7S3UT5`, rate code `36H7S3NU9B7S3UT5.JRTCKXETXF.VF6T3GAUKQ`, `beginRange` to `endRange` |
| Tier 2, price | 0.0850000000 USD per GB | `prices/2026/11/26/aws.json`, SKU `36H7S3NU9B7S3UT5`, rate code `36H7S3NU9B7S3UT5.JRTCKXETXF.VF6T3GAUKQ`, `pricePerUnit.USD` |
| Tier 3, bounds | 51200 to 153600 GB | `prices/2026/11/26/aws.json`, SKU `36H7S3NU9B7S3UT5`, rate code `36H7S3NU9B7S3UT5.JRTCKXETXF.N9EW5UVVPA`, `beginRange` to `endRange` |
| Tier 3, price | 0.0700000000 USD per GB | `prices/2026/11/26/aws.json`, SKU `36H7S3NU9B7S3UT5`, rate code `36H7S3NU9B7S3UT5.JRTCKXETXF.N9EW5UVVPA`, `pricePerUnit.USD` |
| Tier 4, bounds | 153600 to Inf GB | `prices/2026/11/26/aws.json`, SKU `36H7S3NU9B7S3UT5`, rate code `36H7S3NU9B7S3UT5.JRTCKXETXF.GPHXDESFBB`, `beginRange` to `endRange` |
| Tier 4, price | 0.0500000000 USD per GB | `prices/2026/11/26/aws.json`, SKU `36H7S3NU9B7S3UT5`, rate code `36H7S3NU9B7S3UT5.JRTCKXETXF.GPHXDESFBB`, `pricePerUnit.USD` |
| S3 GET request, price | 0.0000004000 USD per Requests | `prices/2026/11/26/aws.json`, SKU `DJEKB32FV4HNZJZY`, rate code `DJEKB32FV4HNZJZY.JRTCKXETXF.6YS6EN2CT7`, `pricePerUnit.USD` |

```
Transfer in the month: 30000000 × 1 × 20 GB = 600000000 GB
Free tier: (100 GB − 0 GB) × 0 USD per GB = 0 USD
Beyond the free tier: 600000000 GB − 100 GB = 599999900 GB
Tier 1: (10240 GB − 0 GB) × 0.09 USD per GB = 921.6 USD
Tier 2: (51200 GB − 10240 GB) × 0.085 USD per GB = 3481.6 USD
Tier 3: (153600 GB − 51200 GB) × 0.07 USD per GB = 7168 USD
Tier 4: (599999900 GB − 153600 GB) × 0.05 USD per GB = 29992315 USD
Transfer cost: 0 USD + 921.6 USD + 3481.6 USD + 7168 USD + 29992315 USD = 30003886.2 USD
GET requests: 30000000 × 1 × 1 Requests × 0.0000004 USD per Requests = 12 USD
Cost: 30003886.2 USD + 12 USD = 30003898.2 USD
Cost of each GB of update size: 30000000 × 1 × 0.05 USD per GB = 1500000 USD per GB
```

**Answer.**

- Cost: 30003898.2 USD, about 30.0 million USD, to send a 20 GB update to 30 million players in one month.
- Transfer cost: 30003886.2 USD.
- GET requests: 12 USD.
- Cost of each GB of update size: 1500000 USD per GB, while the month's transfer stays in the last tier.

The update's size, an assumption, decides the result. LedgerMath holds no CDN price, so an update sent through a CDN is not priced here.

</details>

<details>
<summary>Example: how many machines a rate and a data set need, and their cost an hour (a fleet)</summary>

**Question.** How many `c6i.8xlarge` does it take to scan a 10 TB data set, held in memory, once a second, and what does that cost an hour?

The question binds two ways: the rate, 10 TB read each second, and the capacity, 10 TB held in memory at once. Count the machines each one sets, round each count up, and take the larger. The figures are from the list of every Series, `https://api.ledgermath.com/v1/series.json`, and the prices from the price file `https://api.ledgermath.com/v1/prices/2026-11-26.json`, as LedgerMath's fixed sample took them on 2026-11-26. The list changes as Runs arrive; a price file is never edited.

**The Series.** [memory_read](/docs/benchmarks/memory_read) on `c6i.8xlarge`, Series `a655ffb3e7dd`: `threads` `all`, since the whole box reads; `path` `avx2`, the vector loop; build `static`, the check of 2026-11-18 having found no difference between the two builds on the `avx2` path. Its buffer, 1073741824 bytes, is larger than this type's caches as a Run's `lscpu` dump section records them, so it gives a memory figure, not a cache figure; that the same rate holds for the far larger share of the data each box holds is an assumption. The benchmark reads each word and adds it to a sum: a scan that does more with each byte, or reads with other code, is not what was measured, and the answer says so.

**Groups.** The Series has 3 groups, and its row's percentiles mix them. The Series' file gives each group's figures; this example uses the Series-wide ones, whose spread takes in every group.

| Input | Value | From |
|---|---|---|
| Data set | 10 TB | the question |
| Scans | 1 per second | the question |
| Bytes in a TB | 10^12 bytes per TB | assumption: the question's TB read as 10^12 bytes |
| Read rate, 5th percentile | 133397432303.20653 bytes per second | Series `a655ffb3e7dd`, `series_v1`, `percentiles.bytes_per_second.p5`, count 63, as of `2026-11-26T16:13:49.030665839Z` |
| Read rate, 50th percentile | 145497618462.33847 bytes per second | Series `a655ffb3e7dd`, `series_v1`, `percentiles.bytes_per_second.p50`, count 63, as of `2026-11-26T16:13:49.030665839Z` |
| Read rate, 95th percentile | 149821518147.55743 bytes per second | Series `a655ffb3e7dd`, `series_v1`, `percentiles.bytes_per_second.p95`, count 63, as of `2026-11-26T16:13:49.030665839Z` |
| Groups | 3 | Series `a655ffb3e7dd`, `series_v1`, `groups`, as of `2026-11-26T16:13:49.030665839Z` |
| Buffer | 1073741824 bytes | Series `a655ffb3e7dd`, `params.size_bytes` |
| Memory of one box | 64 GiB | AWS's catalog words: `prices/2026/11/26/aws.json`, SKU `NKB8DU47ZKKBXW65`, `attributes.memory` |
| Bytes in a GiB | 2^30 bytes per GiB | assumption: AWS's "GiB" read as 2^30 bytes |
| Share of memory that holds data | 1 | assumption: all of it; if the program needs room of its own, take less, and the count rises |
| Price of one box | 1.3600000000 USD per Hrs | `prices/2026/11/26/aws.json`, SKU `NKB8DU47ZKKBXW65`, rate code `NKB8DU47ZKKBXW65.JRTCKXETXF.6YS6EN2CT7`, `pricePerUnit.USD` |

```
Bytes in the data set: 10 TB × 10^12 bytes per TB = 10000000000000 bytes
Bytes to read each second: 10000000000000 bytes × 1 per second = 10000000000000 bytes per second
Boxes for the rate, 50th percentile: 10000000000000 bytes per second ÷ 145497618462.33847 bytes per second = 68.73 → 69 (rounded up)
Boxes for the rate, 95th percentile: 10000000000000 bytes per second ÷ 149821518147.55743 bytes per second = 66.75 → 67 (rounded up)
Boxes for the rate, 5th percentile, the slow end: 10000000000000 bytes per second ÷ 133397432303.20653 bytes per second = 74.96 → 75 (rounded up)
Bytes one box holds for data: 64 GiB × 2^30 bytes per GiB × 1 = 68719476736 bytes
Boxes for the capacity: 10000000000000 bytes ÷ 68719476736 bytes = 145.52 → 146 (rounded up)
Boxes: max(69, 146) = 146
Boxes at the slow end: max(75, 146) = 146
Cost an hour: 146 × 1.36 USD per Hrs = 198.56 USD per Hrs
```

**Answer.**

- Boxes: 146 `c6i.8xlarge`.
- Boxes at the slow end: 146.
- Cost an hour: 198.56 USD per Hrs.

Capacity decides the count:

- Boxes for the capacity: 146, the fewest boxes of AWS's 64 GiB each that hold 10 TB.
- Boxes for the rate, 50th percentile: 69.
- Boxes for the rate, 95th percentile: 67.
- Boxes for the rate, 5th percentile, the slow end: 75.

The counts the rate sets are a lower bound from reading the question as a rate, not an answer to it: so few boxes cannot hold 10 TB. The rate is that of `memory_read`'s loop, over 63 Runs in 3 groups; a scan that does more with each byte than add it to a sum is not what was measured.

</details>

<details>
<summary>Example: an answer LedgerMath does not hold</summary>

**Question.** What is the 99th-percentile round trip of a 32 KiB message between two `c6i.8xlarge` in the same zone?

**Answer.** Not held. On 2026-11-26 LedgerMath measured nothing between two machines, so it held no round trip between them, and no 99th percentile of one.

The nearest measurement it holds is [tcp_echo](/docs/benchmarks/tcp_echo) on `c6i.8xlarge`, Series `d58cd285010e`: the round trip of 32768 bytes over loopback TCP inside one process, 24605.69761657715 ns at the 50th percentile across 61 Runs, in 2 groups. It is from the list of every Series, `https://api.ledgermath.com/v1/series.json`, as LedgerMath's fixed sample took it on 2026-11-26. It is not the same thing:

- Loopback involves no network card and no other machine, so it is not a figure for traffic between two machines.
- Each sample times many round trips together, and a Run's figure is the median of its samples' time per round trip; the Series gives the 5th, 50th and 95th percentiles of those across Runs. No 99th percentile of single round trips is held.

So the answer stops here. Do not scale the loopback figure, or add an assumed network time to it, to stand for the round trip asked about. What would have to be measured is a round trip between two instances.

| Input | Value | From |
|---|---|---|
| Message | 32 KiB | the question |
| Loopback round trip, 50th percentile across Runs | 24605.69761657715 ns | Series `d58cd285010e`, `series_v1`, `percentiles.time_per_repetition_ns.p50`, count 61, as of `2026-11-26T16:17:51.492430622Z` |
| Bytes sent and echoed back each round trip | 32768 bytes | Series `d58cd285010e`, `params.size_bytes` |
| Groups | 2 | Series `d58cd285010e`, `series_v1`, `groups`, as of `2026-11-26T16:17:51.492430622Z` |

</details>
