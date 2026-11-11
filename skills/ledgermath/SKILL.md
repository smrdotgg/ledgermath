---
name: ledgermath
description: Napkin math with cited numbers. Estimate what something costs, or how fast it goes, on cloud machines from LedgerMath's measurements of real AWS machines and AWS's public prices, with every number cited or marked as an assumption. Use when asked for a cost, throughput, latency or machine-count estimate on AWS, such as "what would it cost to distribute a new update of a large game to 30 million players?"
---

# LedgerMath

LedgerMath runs small benchmarks on real AWS machines several times a day and keeps every
execution as a **Run**. Runs of one benchmark, parameter set, build, instance type and zone
make a **Series**. For each Series it holds the 5th, 50th and 95th percentiles across its
Runs (each Run is a different boot, often a different box) and a link to every Run. It also
keeps a daily copy of AWS's public On-Demand prices for what it measures, in AWS's words.

That is all it holds. It is not a calculator and it does not estimate: you do, from its
numbers. Anything it has not measured (a network between machines, a CDN, a GPU, another
Region or provider, a 99th percentile) is not in it.

## The tool

From a checkout of the LedgerMath repository (`bun install` once):

    bun scripts/lookup.ts --data <location> <command>

`<location>` is a directory holding `derivations.json`, `runs/` and `prices/`, or a web
address serving them; `LEDGERMATH_DATA` can hold it instead. If you were given the tool or
the data at other paths, use those.

| Command | Answers |
|---|---|
| `about` | What the data hold: benchmarks, instance types, the price file and its date. Run it first. |
| `series [WORD...]` | The Series matching every word: `series memory_read c6i.8xlarge`, `series disk instance_store` |
| `show <id> [--runs N\|all]` | One Series: p5, p50, p95 with citations, what it measures, how many Runs, its groups, its Runs |
| `prices WORD...` | Prices matching every word: `prices c6i.8xlarge`, `prices transfer`, `prices GET`, `prices gp3` |

`--json` gives the same answer as JSON. When something is not held, the tool says so and
lists what is.

## Building an estimate

1. **Write the model** as a product of a few factors with units, at most six: for the game
   update, `cost = players × update size × price per GB delivered`.
2. **Fill each factor, one input per line**: the number in digits with its unit, then right
   after it the citation the tool printed beside it, copied whole. A factor LedgerMath does
   not hold is an assumption: its value, then `[assumption: <where it comes from>]`. A count
   of Runs takes the Series' `count` citation.
3. **Check the fit.** Read the tool's `measures:`, `this set:` and `Note:` lines, and say so
   whenever a number is used outside what it measured: another instance type, a loopback
   number (`tcp_echo`) for a network, the root EBS volume for an instance's own disk, one
   thread for many, AWS's catalog words (`networkPerformance`) for a measurement.
4. **Multiply, one operation per line**: `label: a × b = c`, with a label that holds no
   number. Every operand is a number accounted for above, written with the same unit
   (`$1.36 per hour`, never `$1.36` for it); round with an arrow, `71.3 → 72`. Changing a
   price's unit (per request to per 1000000 requests, per hour to per month) is such a line.
5. **Give a low and a high figure** from the p5 and p95 where the spread matters (for a
   time, the slow end is the p95; for a rate, the p5). Name the factor that dominates the
   uncertainty; it is usually an assumption.
6. **List the sources**: for every Series cited, link its Runs as `show` prints them.
7. **Check the answer**, if you have the checker:
   `bun scripts/check-answer.ts --data <location> --question <question file> <answer file>`.
   Fix every problem it reports.

Done when every number in the answer, tables and code included, is from the question,
cited, an assumption, the result of a line of arithmetic, or a repeat of one of these with
the same unit.

## Citations

| Number | Citation, right after it on its line |
|---|---|
| A Series' percentile | `[lm:series/<id>/<number>/<p5\|p50\|p95>@v1,<moment>]`, and at least one of its Runs in the answer: `runs/<yyyy>/<mm>/<dd>/<id>.json` |
| How many Runs it is over | `[lm:series/<id>/<number>/count@v1,<moment>]` |
| One group's, when a Series is split | `[lm:series/<id>/group/<G>/<number>/<stat>@v1,<moment>]` |
| A price, in AWS's unit | `[lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/<rate code>]`, with the price file's date in words |
| Where a price's tier begins or ends | `[lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/<rate code>/endRange]` (or `/beginRange`) |
| AWS's catalog words for a product (vCPUs, memory) | `[lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/attributes/<name>]` |
| Anything else | `[assumption: <where it comes from>]` |

`<moment>` is when the Series' newest Run started: the citation is of the Series as it
stood then, so it can be checked after more Runs arrive.

## Rules

- A number from LedgerMath always carries its citation; a price also its date.
- An assumption is never presented as a measurement, and AWS's catalog words are never
  presented as LedgerMath's measurements.
- When the question needs something LedgerMath does not hold, say so plainly, then stop
  or carry on with a marked assumption.
- A Series split into groups: say which group you use, or use the Series-wide spread.
  Few Runs: say the spread is that of a few boxes.
- Prices with tiers (data transfer, S3 storage) are charged per tier per month; use the
  tiers AWS's descriptions give.

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
