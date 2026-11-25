---
name: ledgermath
description: Napkin math with cited numbers. Estimate what something costs, or how fast it goes, on cloud machines from LedgerMath's measurements of real AWS machines and AWS's public prices, with every number cited or marked as an assumption. Use when asked for a cost, throughput, latency or machine-count estimate on AWS, such as "what would it cost to distribute a new update of a large game to 30 million players?"
---

# LedgerMath

LedgerMath runs small benchmarks on real AWS machines several times a day and keeps every
execution as a **Run**. Runs of one benchmark, parameter set, build, instance type and zone
make a **Series**. For each Series it holds the 5th, 50th and 95th percentiles across its
Runs (each Run is a different boot, often a different box) and a link to every Run. For the
Series of requests (below) it also holds percentiles across the requests themselves. It also
keeps a daily copy of AWS's public On-Demand prices for what it measures, in AWS's words.

That is all it holds. It is not a calculator and it does not estimate: you do, from its
numbers. Anything it has not measured (a network between machines, a CDN, a GPU, another
Region or provider, a 99th percentile of anything but a request's phases) is not in it.

## The tool

From a checkout of the LedgerMath repository (`bun install` once):

    bun scripts/lookup.ts about

It reads LedgerMath's data from https://api.ledgermath.com. If you were given the data in
a directory or at another address, pass it to every command,
`bun scripts/lookup.ts --data <location> about`, or set `LEDGERMATH_DATA` to it. Such a
directory holds `v1/` with `runs/` and `boots/` beside it. If you were given the tool at
another path, use that.

| Command | Answers |
|---|---|
| `about` | What the data hold: benchmarks, instance types, the price files and their dates, and when the newest round of boots started and what it held (how fresh the data are). Run it first. |
| `series [WORD...]` | The Series matching every word: `series memory_read c6i.8xlarge`, `series disk instance_store` |
| `show <id> [--runs N\|all]` | One Series: p5, p50, p95 with citations, what it measures, how many Runs, its groups, its Runs; for a Series of requests, each phase's percentiles across requests too |
| `prices WORD...` | Prices matching every word: `prices c6i.8xlarge`, `prices transfer`, `prices GET`, `prices gp3` |

`--json` gives the same answer as JSON. When something is not held, the tool says so and
lists what is.

If the tool says LedgerMath's data are being updated and to try again in a few minutes,
two of its files did not agree, so it used neither and gave no number. Wait a few minutes
and run the same command again; do not put a number from anywhere else in its place.

## Series of requests

The `http_get` Series are HTTPS GETs of an object (4 KiB, 128 KiB, 16 MiB) from an EC2
instance, over a new connection per request or one kept connection. What each Series
measured is what its Runs record, and `show` says it: the endpoint its Service names, the box's
Region, how the requests were signed, the TLS they negotiated, the servers' address blocks.
Say no more than that: the path between box and server (an internet gateway, an endpoint)
is not in what `show` says, and is not to be assumed. Their percentiles (Method
requests) are **across requests**, each request one sample, pooled across the Runs: p50 to
p99.9 of each phase (`dns`, `connect`, `tls`, `send`, `first_byte`, `headers`, `body`,
`total`). A tail figure rests on few requests: `show` prints how many are ranked at or above
each one; say it, citing it, beside the figure ("47 ms, 2 requests at or above it"). A
percentile the requests cannot support (a 99th below 100 requests) is not given: do not make
one up. The figures may differ by the server's address block, and `show` breaks them down.
Say which figure a number is in your words as the citation names it: a pooled figure is of
every counted Run, not of one; a figure `by/address_block/…` is of those requests only.

## Building an estimate

1. **Write the model** as a product of a few factors with units, at most six: for the game
   update, `cost = players × update size × price per GB delivered`.
2. **Fill each factor, one input per line**: the number in digits with its unit, then right
   after it the citation the tool printed beside it, copied whole. A factor LedgerMath does
   not hold is an assumption: its value, then `[assumption: <where it comes from>]`. A count
   of Runs takes the Series' `count` citation. A quantity from the question is written once
   the same way, in digits with its unit (`Reads: 10000000 per day, from the question.`); it
   is then accounted for. A unit follows its number directly: `33269.9 writes per second`,
   not `33269.9 durable 8 KiB writes per second`. When the question names no instance type,
   say which Series you used and why, or give the range across the types.
3. **Check the fit.** Read the tool's `measures:`, `this set:` and `Note:` lines, and say so
   whenever a number is used outside what it measured: another instance type, a loopback
   number (`tcp_echo`) for a network, the root EBS volume for an instance's own disk, one
   thread for many, AWS's catalog words (`networkPerformance`) for a measurement. The
   `http_get` requests were made one at a time, spaced apart (`gap_mean_ms`): a figure is
   for a lightly loaded client. When the question's load is heavier, say so, and check it:
   requests per second × seconds per request is how many must be in flight at once, more
   than one connection can carry if it is above 1.
   `memory_read` has a static and a dynamic Series of each set. Where they differ, the
   cause is where one loop landed in each binary, not the kind of linking: never use the
   two to say that dynamic (or static) linking is faster.
4. **Multiply, one operation per line**: `label: a × b = c`, with no number in the label
   but a tier's or step's (`Tier 1`). Every operand is a number accounted for above, written
   with the same unit (`$1.36 per hour`, never `$1.36` for it). A line passes when its result
   follows from its operands either as plain numbers or with their units. A rate from a
   time: things per second = 1 ÷ seconds per thing (`1 ÷ 30.0572 µs per write = 33269.9 writes
   per second`). Round with an arrow (`33269.9 → 33300`); a figure repeated in prose may be
   written to fewer digits. Changing a price's unit (per request to per 1000000 requests,
   per hour to per month) is such a line.
5. **Give a low and a high figure** from the p5 and p95 where the spread matters (for a
   time, the slow end is the p95; for a rate, the p5). For a request's time, the tail is its
   p99 across requests, with the requests behind it. Name the factor that dominates the
   uncertainty; it is usually an assumption.
6. **List the sources**: for every Series cited, link its Runs as `show` prints them; for
   prices, name the price file by its path. An answer from prices alone says that no Series
   was used.
7. **Check the answer**, if you have the checker:
   `bun scripts/check-answer.ts --question <question file> <answer file>`, with
   `--data <location>` as for the tool. Fix every problem it reports. It checks numbers, not meaning: a figure written with the
   right citation passes even if your words call it something else (the pooled 99th
   percentile called "the first Run's", a figure of one address block called the Series'),
   so the words around each number are yours to get right.

Done when every number in the answer, tables and code included, is from the question,
cited, an assumption, the result of a line of arithmetic, or a repeat of one of these with
the same unit.

## Citations

| Number | Citation, right after it on its line |
|---|---|
| A Series' percentile | `[lm:series/<id>/<number>/<p5\|p50\|p95>@v1,<moment>]`, and at least one of its Runs in the answer, as `show` prints it: `runs/<yyyy>/<mm>/<dd>/<id>.json` |
| How many Runs it is over | `[lm:series/<id>/<number>/count@v1,<moment>]` |
| A percentile across a Series' requests | `[lm:requests/<id>/<phase>/<p50\|p90\|p95\|p99\|p99.9\|min\|max>@v1,<moment>]` |
| How many requests are at or above it | `[lm:requests/<id>/<phase>/<p90\|p95\|p99\|p99.9>/at_or_above@v1,<moment>]` |
| How many requests, Runs, failed requests | `[lm:requests/<id>/<phase>/count@v1,<moment>]`, `[lm:requests/<id>/runs@v1,<moment>]`, `[lm:requests/<id>/failed@v1,<moment>]` |
| One group's, when a Series is split | `[lm:series/<id>/group/<G>/<number>/<stat>@v1,<moment>]` |
| A price, in AWS's unit | `[lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/<rate code>]`, with the price file's date in words |
| Where a price's tier begins or ends | `[lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/<rate code>/endRange]` (or `/beginRange`) |
| AWS's catalog words for a product (vCPUs, memory) | `[lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/attributes/<name>]` |
| Anything else | `[assumption: <where it comes from>]` |

`<moment>` is when the Series' newest Run started: the citation is of the Series as it
stood then, so it can be checked after more Runs arrive. The one exception is a figure of
the requests with one value of a fact (`…/by/address_block/…`): it is held only as of the
Series' newest Run, so once more Runs arrive it can no longer be checked.

- A marker goes directly after its number, on the same line: it belongs to the nearest
  number before it and to no other.
- Write a date as 2026-11-11 or November 11, 2026, and name a price file by its path,
  `prices/2026/11/11/aws.json`. A price is quoted with its file's date because AWS changes
  prices: the date says which day's price the answer used.
- `[lm:benchmark/<name>]` cites what a benchmark measures, in a sentence describing a
  number; it accounts for no number itself.
- AWS's catalog words are AWS's text, not always a quantity with a unit: network
  performance is "12500 Megabit", with no unit of time; memory is "64 GiB". Quote them with
  their citation. To compute with one, write your reading of it as an assumption:
  `12500 Mbit/s [assumption: AWS's "12500 Megabit" read as per second]`.
- A Run's dump records more than the tool shows, cache sizes for one. The tool does not show
  them, so a number about them is an assumption.

## Rules

- A number from LedgerMath always carries its citation; a price also its date.
- An assumption is never presented as a measurement, and AWS's catalog words are never
  presented as LedgerMath's measurements.
- A Series split into groups: say which group you use, or use the Series-wide spread.
  Few Runs: say the spread is that of a few boxes.
- Prices with tiers (data transfer, S3 storage) are charged per tier per month: cite each
  tier's price and its bounds (`…/beginRange`, `…/endRange`, the last tier's end AWS's word
  `Inf`). AWS's free allowance for transfer out (the first 100 GB a month, across all
  Regions) is a record of its own, while the Region's first tier starts at 0: combining the
  two is your own arithmetic, so show it. The order in which AWS applies the allowance and
  the tiers is not something LedgerMath holds: the order you use is an assumption, marked.
- Traffic between S3 and EC2 in the same Region has no price in the price file: what you
  use for it (AWS publishes it as free) is an assumption, marked.

## When LedgerMath does not hold it

Say so first, plainly. Stopping there is the better answer when every factor that decides
the result would be an assumption (a latency between machines, a 99th percentile of
anything but a request's phases): say what would have to be measured. Otherwise carry on, marking each missing factor as an assumption
and keeping it apart from what is measured, for example:

> LedgerMath holds no CDN price, so the CDN's part below is assumed; the rest is cited.
> - Transfer out of us-east-2, first tier: $0.09 per GB [lm:prices/2026/11/11/aws.json#36H7S3NU9B7S3UT5/36H7S3NU9B7S3UT5.JRTCKXETXF.Q3Z75P77EN], price file of 2026-11-11
> - Share of downloads a CDN serves from its cache: 90% [assumption: a typical hit ratio, not measured by LedgerMath]

## Worked example

Numbers from the data of 2026-11-11; yours will be newer.

> How long does one c6i.8xlarge take to read 48 GiB held in memory once, on one thread, and what does that cost?

**Model**: time = data ÷ one-thread read bandwidth; cost = time × price per hour.

**Inputs** (`memory_read` on one thread with AVX2, static build; it only sums what it reads, and a program that does more per byte is slower)
- Data: 48 GiB, from the question.
- Memory of one c6i.8xlarge: 64 GiB [lm:prices/2026/11/11/aws.json#NKB8DU47ZKKBXW65/attributes/memory], so the data fit.
- Read bandwidth, p5: 13.1709 GB/s [lm:series/c96b6f40c007/bytes_per_second/p5@v1,2026-11-11T00:24:16Z]
- Read bandwidth, p50: 13.5922 GB/s [lm:series/c96b6f40c007/bytes_per_second/p50@v1,2026-11-11T00:24:16Z]
- Read bandwidth, p95: 14.0136 GB/s [lm:series/c96b6f40c007/bytes_per_second/p95@v1,2026-11-11T00:24:16Z]
- Runs behind them: 2 [lm:series/c96b6f40c007/bytes_per_second/count@v1,2026-11-11T00:24:16Z]
- Price: $1.36 per hour [lm:prices/2026/11/11/aws.json#NKB8DU47ZKKBXW65/NKB8DU47ZKKBXW65.JRTCKXETXF.6YS6EN2CT7], price file of 2026-11-11.

**Arithmetic**
- 48 GiB = 51.54 GB
- Central: 51.54 GB ÷ 13.5922 GB/s = 3.79 s
- Low: 51.54 GB ÷ 14.0136 GB/s = 3.68 s
- High: 51.54 GB ÷ 13.1709 GB/s = 3.91 s
- Cost: 3.79 s × $1.36 per hour = $0.00143

**Answer**: about 3.79 s (3.68 to 3.91 s across the Runs), $0.00143 of instance time. The
spread is that of 2 boxes. What the program does per byte dominates the uncertainty, not
the measured spread.

**Sources**: Series c96b6f40c007: runs/2026/11/11/01a1c7fd-b820-72bd-8136-2958e1e58dbd.json, runs/2026/11/10/01a1c7d3-0bd4-7437-a615-e1a498bc73f5.json
