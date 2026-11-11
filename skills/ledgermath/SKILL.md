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
2. **Fill each factor.** Look in LedgerMath first (`series`, `show`, `prices`). A factor it
   holds takes its number with the citation the tool prints beside it. Every other factor
   is an assumption: give its value and `[assumption: <where it comes from>]`.
3. **Check the fit.** Read the tool's `measures:`, `this set:` and `Note:` lines, and say so
   whenever a number is used outside what it measured: another instance type, a loopback
   number (`tcp_echo`) for a network, the root EBS volume for an instance's own disk, one
   thread for many, AWS's catalog words (`networkPerformance`) for a measurement.
4. **Multiply, showing the arithmetic**, one step per line: `a × b = c`. Show rounding with
   an arrow: `71.3 → 72`.
5. **Give a low and a high figure** from the p5 and p95 where the spread matters (for a
   time, the slow end is the p95; for a rate, the p5). Name the factor that dominates the
   uncertainty; it is usually an assumption.
6. **List the sources**: for every Series cited, link its Runs as `show` prints them.
7. **Check the answer**, if you have the checker:
   `bun scripts/check-answer.ts --data <location> --question <question file> <answer file>`.
   Fix every problem it reports.

Done when every number in the answer is cited, marked as an assumption, taken from the
question, or the result of a line of arithmetic shown in the answer.

## Citations

Write the citation right after the number, on the same line, as the tool prints it.

| Number | Citation |
|---|---|
| A Series' percentile | `[lm:series/<id>/<number>/<p5\|p50\|p95>]`, and somewhere in the answer at least one of its Runs: `runs/<yyyy>/<mm>/<dd>/<id>.json` |
| One group's, when a Series is split | `[lm:series/<id>/group/<G>/<number>/<stat>]` |
| A price | `[lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/<rate code>]`, with the price file's date in words |
| AWS's catalog words for a product (vCPUs, memory) | `[lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/attributes/<name>]` |
| Anything else | `[assumption: <where it comes from>]` |

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

**Inputs**
- Data: 48 GiB, from the question; it fits in the box's 64 GiB [lm:prices/2026/11/11/aws.json#NKB8DU47ZKKBXW65/attributes/memory].
- One-thread read bandwidth of a c6i.8xlarge (`memory_read`, `threads=1 path=avx2`, static build): p5 13.1709 GB/s [lm:series/c96b6f40c007/bytes_per_second/p5], p50 13.5922 GB/s [lm:series/c96b6f40c007/bytes_per_second/p50], p95 14.0136 GB/s [lm:series/c96b6f40c007/bytes_per_second/p95], from 2 Runs. It sums 64-bit words; a program that does more per byte is slower.
- Price: $1.36 per hour [lm:prices/2026/11/11/aws.json#NKB8DU47ZKKBXW65/NKB8DU47ZKKBXW65.JRTCKXETXF.6YS6EN2CT7], price file of 2026-11-11.

**Arithmetic**
- 48 GiB = 51.54 GB
- Central: 51.54 GB ÷ 13.5922 GB/s = 3.79 s
- Low: 51.54 GB ÷ 14.0136 GB/s = 3.68 s; high: 51.54 GB ÷ 13.1709 GB/s = 3.91 s
- Cost: 3.79 s ÷ 3600 × $1.36 = $0.00143

**Answer**: about 3.79 s (3.68 to 3.91 s across the Runs), $0.00143 of instance time. The
spread is that of 2 boxes. What the program does per byte dominates the uncertainty, not
the measured spread.

**Sources**: Series c96b6f40c007: runs/2026/11/11/01a1c7fd-b820-72bd-8136-2958e1e58dbd.json, runs/2026/11/10/01a1c7d3-0bd4-7437-a615-e1a498bc73f5.json
