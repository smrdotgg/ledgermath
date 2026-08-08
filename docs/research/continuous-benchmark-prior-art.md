# Prior art: how continuous-benchmark projects publish data

Research for issue #16. Question: how do existing continuous-benchmark projects
structure, publish, and version their data and methodology — and what should
LedgerMath steal or avoid?

Projects covered: Lucene nightly benchmarks, ClickBench, cloudping.co,
ec2instances.info, SPEC CPU, and sirupsen/napkin-math (read from the checkout
at `local/napkin-math/`).

Date: 2026-08-08. Sources are cited inline; all claims verified against primary
sources (project sites, repos, official docs) unless noted.

---

## 1. Lucene nightly benchmarks (Mike McCandless)

Site: <https://benchmarks.mikemccandless.com/> · Code: <https://github.com/mikemccand/luceneutil>

**Raw data storage.** Each night an automated Python tool checks out Lucene
trunk and runs the full suite. Raw results are stored as Python pickle files at
`{NIGHTLY_LOG_DIR}/{timestamp}/results.pk` (a tuple of indexing times, byte
counts, search results, git revisions, etc.), run logs archived as
`logs.tar.bz2`, plus a cumulative JSON export at
`reports.nightly/for_all_time.json` (`src/python/nightlyBench.py`). Each run
records the git hashes of both Lucene and luceneutil and captures hardware/OS
state (`lscpu`, kernel, transparent hugepages, Java version/flags). History is
*not* kept in git — the pickles live on the benchmark machine's disk — but the
full time series is effectively re-published nightly because every chart page
embeds the complete CSV history inline: `indexing.html` is a ~1.4 MB static
page whose embedded data runs from 2011-04-03 to the present, fed straight
into a Dygraphs constructor.

**Methodology documentation/versioning.** The harness *is* the methodology:
luceneutil is Apache-2.0 open source ("Utility scripts for running Lucene
performance tests, and 15 years of nightly benchmarks"); defaults like "20 JVM
iterations, 20 query repetitions per JVM" are code, overridable via
`localconstants.py`. The killer feature is the annotation system:
`KNOWN_CHANGES` in `src/python/notation.py` — a hand-maintained list of ~250+
dated entries rendered as lettered markers (A…Z, AA…, now past JX) on every
chart. Every jump in a 15-year time series has a human-written explanation:
"Switched from Java 1.6.0_21 to 1.6.0_26" (2011), "Upgrade to beast2 (72
cores, 256 GB RAM)" (2015), "Move to new beast3 Ryzen Threadripper 3990X
hardware" (2020), and candidly self-inflicted ones like "Fully fix the Jan 29
sudden massive regression: CPU governor back to 'performance', BIOS upgrade,
fix memory clock speed from 2400 MHz -> 3200 MHz". There is even an in-band
"regold" protocol: commit messages containing
`// nightly-benchmarks-results-changed //` tell the harness a change
legitimately altered expected results.

**Explorability.** A static HTML index linking to one static page per metric
(15+ sections: indexing, boolean/fuzzy/proximity/vector queries, faceting,
sorting, geo), each an interactive client-side Dygraphs chart (zoom/pan,
hover for annotations), plus JFR flame charts via a blunders.io integration.
No server, no database, no API — the "database" is HTML.

**What earned trust.** Longevity and daily cadence (nightly since April 2011,
explicitly to catch "boiling frog" gradual regressions); annotations that
honestly explain every artifact including harness bugs, BIOS/memory-clock
mishaps, and hardware changes — McCandless's own slide: "Trust is vital —
quickly address issues that erode trust!"; it catches real bugs, not just
slowdowns (e.g. a >2GB mmap EOFException in the HNSW vector reader found only
by the nightly); statistical care (warmup discarding, many JVM iterations,
recently added p-values); a named, reachable human.

**What rotted** (largely from McCandless's own "battle scars" slides,
ApacheCon 2022). Bus factor of one: the whole pipeline runs on a single
physical machine ("beast3") in his home — outages produce gaps, and restarts
confound variables ("Hardware, OS, JDK, benchmark tooling, Lucene can all
change!" at once). Three hardware upgrades (2011 SSD, 2015 beast2, 2020
beast3) caused "misleading jumps across the board" — the series is annotated,
never normalized, across hardware eras. Regressions are noticed days or weeks
later with no automated alerting ("We need auto-WTF alarms"). Raw pickles are
a Python-only, schema-less format and aren't published, so nobody else can
re-analyze or take over easily. Self-admitted: "Benchmark code is scratchy
and smelly and has no unit tests"; the nightly run now takes ~28-29 hours —
longer than a day.

---

## 2. ClickBench

Repo: <https://github.com/ClickHouse/ClickBench> · Site: <https://benchmark.clickhouse.com/>

**Raw data storage.** One directory per system (60+ of them: `clickhouse/`,
`duckdb/`, …), each with `results/YYYYMMDD/<machine>.json`. "Each new run for
an existing machine goes into a new dated subdirectory; older runs are kept
for history" — the git repo *is* the database and the audit log (the
`clickhouse/` system alone has ~70 dated result dirs spanning 2016-2026). The
JSON schema is small and fixed: `system`, `date`, `machine`, `cluster_size`,
`proprietary`, `tuned`, `tags`, `load_time` (seconds), `data_size` (bytes),
and `result`: a 43-element array of `[cold, hot1, hot2]` triples, `null` for
failed queries. `generate-results.sh` concatenates the latest dated JSON per
`<system>/<machine>` pair (skipping entries tagged `historical`) into
`data.generated.js`, regenerated by CI on merge.

**Methodology documentation/versioning.** The README carries the rules
(indexing restrictions, no pre-aggregation/materialized views, result caching
disabled, client-to-client timing, single-file data loading, true-cold runs
requiring DB restart + OS page-cache drop) and every system directory must
ship a full reproduction kit: `benchmark.sh`, `install`, `load`, `query`,
`create.sql`, `queries.sql`, `check`, `data-size` — many now delegating to a
shared `lib/benchmark-common.sh`. Crucially, methodology changes get an
explicit dated `CHANGELOG.md` (2022-07-13 full rewrite establishing 100%
reproducibility; 2025-10-26 excluding in-memory DBs from cold ratings;
2026-05-11 unifying scripts and mandating restart-before-cold-run), and
older-semantics results carry tags like `"lukewarm-cold-run"` rather than
being silently reinterpreted. Canonical hardware is pinned ("AWS c6a.4xlarge
EC2 VMs with 500 GB gp2 disks") with a fixed menu of accepted alternatives.

**Explorability.** A single static HTML page reading the generated JS blob
client-side, with filters for system, machine type, cluster size,
tuned/untuned, proprietary/open, and metric, plus per-query drill-down.
Scoring is published: geometric mean of per-query ratios against the fastest
system with a `+10ms` constant to damp tiny-query noise; "Combined" = 10%
load + 10% size + 20% cold + 60% hot; missing queries penalized at 2x the
entry's max runtime.

**What earned trust.** Anyone can submit results via PR — adding a system is
copying a directory; "the benchmark allows to reproduce every test result
quickly in as little as 20 minutes" on stock Ubuntu; ClickHouse publishes
results where competitors beat ClickHouse; DeWitt-clause systems get
reproduction instructions committed without numbers; and the README's
limitations section ("All Benchmarks Are Liars") candidly lists that the
dataset is small, a single flat table, and queries run serially with no
concurrency.

**What rotted / criticisms.** It's vendor-run and workload-shaped-to-the-
vendor — MotherDuck's "Perf is not enough": "the benchmark didn't do any
JOINs, so operated out of a single table, and also relied heavily on counting
distinct items"; QuestDB and TigerData make similar points about joins,
pre-aggregation, and concurrency. Entries go stale — the dashboard shows only
"latest," however old, and some systems' newest entry is years old. Cold-run
semantics changed over time, so cross-era comparisons require reading the
tags. Hardware normalization is by filter only; results on different machines
simply coexist.

---

## 3. cloudping.co

Site: <https://www.cloudping.co/> · Repo: <https://github.com/mda590/cloudping.co>

**Raw data storage.** A monorepo of AWS Chalice (Python/Lambda) microservices:
`ping_from_region/` runs on a cron (`0,6,12,18` — every 6 hours) in every
active region, measuring TCP connect time (Python `socket`, not ICMP) to
`dynamodb.{region}.amazonaws.com:443` in every other region — 5 attempts,
1-second timeout. Each run writes a full record to DynamoDB `PingTest`
including avg/min/max, attempt counts, and the raw per-attempt results list.
`account-region-manager/` auto-detects and enables new AWS regions;
`scheduled_functions/` compute daily/weekly/monthly/yearly averages and
percentiles (P10, P25, P50, P75, P90, P98, P99) into `cloudping_stored_avgs`;
recent commits added a parallel deployment for the AWS European Sovereign
Cloud partition.

**Methodology documentation/versioning.** The open-source repo is the
methodology — but only loosely documented in prose. Details like the
DynamoDB-endpoint target and the 5-sample count live only in code, and an
issue ("Ping: Latency vs Round-Trip", #54, open since 2023) asks for
methodology clarification. There is no versioned methodology document and no
annotation mechanism for measurement changes.

**Explorability.** A Next.js 35x35 region matrix with percentile dropdown
(P10-P99), timeframe selector (1D/1W/1M/1Y), and region filters. The API
splits access: `GET /latencies?percentile=&timeframe=` is public (CORS `*`),
but `GET /history` — raw `PingTest` samples — requires an API key. There is
no bulk raw-sample download.

**What earned trust.** It answers exactly one question, well; the fully open
pipeline means you can audit exactly what a number means; percentiles rather
than just averages; automated region onboarding; independent of AWS ("in no
way associated with Amazon or AWS"); running since 2016 with a decade of AWS-
community citation. Napkin-math itself cites it as *the* source for
inter-region latency (README link `[i]`).

**What rotted / limitations.** Effectively single-maintainer (Matt Adorjan) —
an issue titled "Project status and contributing" (Jan 2025) asks whether the
project is alive; licensing is ambiguous (README claims MIT but the repo has
no LICENSE file; "License for code and data?" has been open since March
2021); accessibility requests sit unaddressed for years; TCP-connect-to-
endpoint is a proxy metric (connection setup, not pure RTT); 6-hour cadence x
5 samples is sparse; raw data is gated behind an API key, limiting independent
re-analysis.

---

## 4. ec2instances.info

Site: <https://instances.vantage.sh/> · Repo: <https://github.com/vantage-sh/ec2instances.info> (MIT)

**Raw data storage.** No measurements at all — a Go scraper (rewritten from
the original Python) pulls AWS (`ec2:DescribeInstanceTypes`,
`ec2:DescribeSpotPriceHistory`, RDS/ElastiCache APIs, plus scraping the AWS
pricing site), Azure, and GCP into JSON, enriched with launch dates from
instancetyp.es. The dataset is *not* versioned in git — it's a build artifact:
a GitHub Actions cron (`0 */8 * * *`) re-scrapes, rebuilds the static Next.js
site, and deploys every 8 hours, with Slack success/failure notifications so
staleness fails loudly. The public data contract is one canonical bulk URL:
`https://instances.vantage.sh/instances.json` (>10 MB). There is no
first-class historical record of past prices.

**Methodology documentation/versioning.** No prose methodology doc — the
open-source scraper is the methodology; anyone can read exactly which API
field each column comes from. Because the source of truth is AWS's own API,
methodology disputes collapse into "the scraper has a bug," fixed via
community PRs.

**Explorability.** A filterable, sortable comparison table over every
instance type, with export, currency selection, a pricing calculator, and
per-instance detail pages — the entire product is the explorer UI. That UI
beat AWS's own pricing pages, which is the whole reason the project exists
(Garret Heaton built it in 2011 because Amazon's comparison interface was
cumbersome).

**What earned trust.** MIT-licensed and open since 2011; 15 years of
continuous history; community PRs (626 forks); a verifiable pipeline. When
the lone volunteer drifted ("I haven't had time to improve the site at the
same rate"), Vantage acquired it in Feb 2021, kept it free, and funded a
rewrite, 8-hour automation, and multi-cloud expansion — the handoff worked
*because* the scraper and site were open and self-contained.

**What rotted.** The full cycle: volunteer rot (stale periods pre-2021) →
corporate rescue → corporate attention rot. A Jan-2026 fork announcement
(cloud-instances.info, LeanerCloud) reports that after a key engineer left
Vantage "development all but stopped" — last CTO commits Oct 2024, the Azure
UI "broken and nobody fixed it in more than a year," Azure scraping never
fully open-sourced — so heavy users forked to protect the `instances.json`
contract they depend on. The MIT license was the community's escape hatch
both times. AWS API/pricing-format churn breaks scrapers regularly, and the
lack of stored history means you can't ask "what did an m5.large cost in
2019?"

---

## 5. SPEC (SPEC CPU as the canonical case)

Site: <https://www.spec.org/> · Run rules: <https://www.spec.org/cpu2017/Docs/runrules.html>

**Raw data storage.** Results live at `spec.org/cpu2017/results/` in
per-quarter directories (`res2017q3/` … `res2026q3/`). Each result has a
stable ID (`cpu2017-YYYYMMDD-NNNNN`) and is published in six parallel
formats: `.html`, `.csv`, `.txt`, `.pdf`, `.ps`, and — critically — the
tester's actual `.cfg` config file used to produce the run. A full-disclosure
report includes per-benchmark raw seconds and ratios for every iteration,
exact compiler invocations and flags, hardware down to cache hierarchy and
cooling, BIOS settings, a full `sysinfo` appendix, and Meltdown/Spectre
mitigation attestations.

**Methodology documentation/versioning.** Each suite is a distinct versioned
product with its own frozen run-rules document (CPU95 → CPU2000 → CPU2006 →
CPU2017 → CPU2026, released 2026-05-05); results are never comparable across
generations. Base metrics require one common flag set for the whole suite;
peak allows per-benchmark tuning. Every metric is a ratio against a fixed
reference machine (CPU2017: a 2006 Sun Fire V490). Publication goes through
subcommittee peer review on a two-week cycle, with conflict-of-interest rules
for reviewers; violations get published metrics replaced with "NC"
(non-compliant), and results are retroactively invalidated if shipped hardware
underperforms the published number by more than 1.75%.

**Explorability.** Searchable database (`spec.org/cgi-bin/osgresults`) with an
advanced query form, multi-level sorts, and "Dump All Records As CSV" — a
full-database export is a first-class feature, alongside bulk "All Results"
pages ("a huge download, with dozens of megabytes of text").

**What earned trust.** Vendor-neutral consortium governance; mandatory full
disclosure "sufficient to independently reproduce the results" (rule 4);
reproducibility as a *rule* (the continuous-build requirement: a new tester
must be able to rebuild performance-equivalent binaries from the published
config file); anti-gaming rules (optimizations must help "a class of programs
larger than the SPEC CPU 2017 suites"; benchmark source/variable names banned
in flags); and enforcement with teeth (NC markings).

**What rotted or died.** Compiler gaming happened anyway — the CPU2006
libquantum case, where autoparallelization legally inflated one benchmark so
badly that analysts had to hand-exclude it for meaningful comparisons; the
lesson is that per-benchmark visibility, not rules, is what let outsiders
detect it. Suites age out and take their result history's relevance with them
(CPU2006 retired 2018). The suite is paywalled ($1,000 for CPU2017, $3,000
for CPU2026) and source-licensed, so outsiders can't casually reproduce.
Cadence is glacial (9–11 years between generations) and reference machines
become museum pieces, making absolute scores unintuitive.

---

## 6. sirupsen/napkin-math (read from `local/napkin-math/`)

Repo: <https://github.com/sirupsen/napkin-math> · Checkout: `local/napkin-math/`

**Raw data storage.** There is none, structurally. The published artifact is
the README itself: hand-edited Markdown tables of numbers deliberately
"rounded for memorization, not faux precision." Raw runs occasionally survive
as linked gists (footnote `[9]`) or as ad hoc CSV/gnuplot/png droppings in
`newsletter/` directories. The only history is git blame on a Markdown table.

**Methodology documentation/versioning.** The methodology is split between
code and prose. The `run` wrapper encodes the noise-control discipline —
disable turbo boost, set the performance governor, drop caches, disable ASLR,
disable hyperthreading, set transparent hugepages — citing easyperf.net.
`script/provision.sh` sets up the bench machine. But *which* run produced
*which* published number is recorded only in README prose ("re-measured and
revalidated on fresh GCP `c4-standard-48-lssd` instances on March 8, 2026").
The harness itself is mid-migration and dual-sourced: "The active benchmark
path today is Criterion.rs in `benches/`. `src/main.rs` is still the older ad
hoc harness and remains the source of truth for the benches that have not
been fully migrated." A Go port (`go/`) adds a third, unreconciled
implementation.

**Explorability.** None. One static table, one number per operation. No
history, no percentiles, no per-machine breakdown — which is exactly what
sirupsen says he wants next (podcast, `local/AGENTS.md`): "I want a histogram
of the latencies… with object storage, the P99 is quite far from the P50," and
"my dream would be Napkin Math running like, daily — kind of like the Lucene
benchmarks — and then on pretty much all of the modern machine types."

**What earned trust.** The author's reputation and the first-principles
framing (SRECON talk, newsletter with practice problems); radical honesty in
the README ("Take the numbers with a grain of salt", "I am aware of some
inefficiencies in this suite… I find it highly unlikely any of them will be
more than 2-3x off"); every external number footnoted to a source; and the
numbers being *useful* — memorable orders of magnitude beat precise noise for
the napkin-math use case.

**What rotted.** Nearly everything operational. Single maintainer who "used
to maintain — I mean, I still kind of maintain it"; no automated cadence, so
numbers silently fossilized across hardware generations — the blob-storage GET
row sat at 500 MiB/s for years until a 2026 re-measurement revised it down 5x
to 100 MiB/s ("The old `500 MiB/s` single-stream blob GET row above did not
reproduce on either provider"). Because there's no structured metadata layer,
the README has ballooned with paragraph-length caveats per row (which rows are
Criterion vs. old harness, which env vars, which cloud, which date). The
newsletter dirs show one-off experiments whose artifacts were never folded
back into anything queryable.

---

## Steal this (for LedgerMath)

1. **Annotations as first-class data (Lucene).** Keep a machine-readable,
   append-only list of dated annotations — harness change, kernel change,
   instance-type change, methodology fix — rendered on every chart. This is
   the single highest-trust-per-byte feature in the entire survey: it turns
   every artifact in a time series into evidence of honesty instead of a
   credibility hole.
2. **Git repo as the results database, one JSON file per (benchmark, machine,
   date) (ClickBench).** Dated, append-only result files in a rigid schema;
   the site renders "latest per machine" but history is never deleted.
   PR-based submission gives community contribution and review for free.
3. **Stable result IDs + the exact config published beside every result
   (SPEC).** Every published number should link to the full run manifest:
   instance type, region, AMI/kernel, harness git SHA, tuning applied, raw
   samples. SPEC's `.cfg`-next-to-`.html` pattern is the trust anchor; "NC"
   shows results can be flagged, not silently edited.
4. **Full reproduction kit per benchmark (ClickBench + SPEC).** A single
   entrypoint (`benchmark.sh`-equivalent) that provisions, tunes, runs, and
   emits the standard JSON — "reproduce any result in ~20 minutes" should be
   a stated, tested guarantee. This also serves the language-agnostic goal:
   the contract is the manifest + output schema, not the implementation
   language.
5. **Percentiles and timeframes, precomputed (cloudping).** Store raw samples,
   serve P10/P50/P90/P99 over day/week/month/year windows via a small API +
   static-friendly frontend. Histograms are the explicitly stated dream for
   napkin-math's successor.
6. **Noise-control discipline in a wrapper, in code (napkin-math `run`).**
   Turbo/HT/ASLR/governor/THP tuning belongs in the versioned harness, and the
   manifest should record exactly which knobs were set for each run.
7. **Bulk export as a first-class feature (SPEC).** "Dump everything as
   CSV/JSON" — both per-result and whole-database. This is also what the
   planned agent/estimation skill will consume.
8. **A brutal limitations section (ClickBench).** "All benchmarks are
   bastards" upfront. Napkin-math's "grain of salt" honesty is a big part of
   why people trust it.
9. **Rounded headline numbers over faux precision (napkin-math).** Keep a
   human-facing "numbers to memorize" view derived from, and linked to, the
   precise data — that's the product people actually loved.
10. **Design for handoff (ec2instances.info).** Clear OSS license, infra as
    code, no private machine in the loop — ec2instances survived *two*
    maintainer failures (volunteer burnout 2021, corporate neglect 2026)
    purely because the MIT license made adoption and forking possible.
11. **A dated methodology CHANGELOG plus semantic tags on old results
    (ClickBench).** When cold-run semantics changed, old results were tagged
    `lukewarm-cold-run` rather than silently reinterpreted or deleted.
12. **Loud failure on the update pipeline (ec2instances.info).** CI cron +
    Slack alert on scrape/build failure — continuous data rots silently
    unless staleness is an alarm, not a diff nobody reads.

## Avoid this

1. **Opaque single-machine pipelines (Lucene).** Raw pickles on one person's
   box, no raw-data publishing, bus factor of one. Publish raw data from day
   one; run on reproducible cloud instances, not a pet machine.
2. **Python pickle or any language-private format for raw results (Lucene).**
   Schema'd JSON (or similar) or it didn't happen.
3. **Prose as the only run metadata (napkin-math).** "Re-measured on March 8,
   2026 on c4-standard-48-lssd" buried in a README paragraph is how you get
   200-line caveat blobs. Every number must carry structured provenance.
4. **Numbers with no expiry (napkin-math's 5x-stale blob row; ClickBench's
   stale entries).** Show measurement age everywhere; flag or fade results
   older than a threshold; let the daily cadence make staleness structurally
   impossible for supported platforms.
5. **Gating raw samples (cloudping).** Aggregates are public but raw history
   needs an API key — so nobody can independently re-analyze, and later
   distribution questions are unanswerable. Publish raw (or finely bucketed
   histogram) data openly.
6. **Unversioned methodology changes (cloudping, ec2instances).** If the
   measurement method changes, that's an annotation + a methodology version
   bump, never a silent redeploy — otherwise the time series lies. cloudping's
   method details (target endpoint, 5 samples, 1s timeout) live only in code,
   and users file issues asking what the numbers mean.
7. **Ambiguous licensing (cloudping).** README says MIT but no LICENSE file
   exists; "License for code and data?" has been open since 2021. License the
   code *and* the data explicitly from day one.
8. **Cross-hardware comparison without labels (ClickBench).** Never let the UI
   juxtapose numbers from different machine types/eras without loud labeling;
   Lucene's hardware swaps and ClickBench's mixed machines both confuse casual
   readers.
9. **Paywalls, member gates, and licensing friction (SPEC).** They bought
   rigor at the cost of relevance; open + reproducible is LedgerMath's edge.
10. **Rules as the only anti-gaming defense (SPEC/libquantum).** Publish
    per-benchmark, per-run detail so outliers are visible; transparency
    catches what rules miss.
11. **Parallel half-migrated harnesses (napkin-math's Criterion + ad hoc +
    Go).** One source of truth per number; if a harness is replaced, annotate
    the switch and retire the old path — don't run both indefinitely.
12. **Decade-scale methodology freezes (SPEC).** Version the methodology like
    software (small, frequent, annotated), not like a boxed product.
13. **No alerting on the numbers themselves (Lucene).** Fifteen years in,
    regressions are still spotted by a human eyeballing charts days later
    ("We need auto-WTF alarms"). Build regression detection into the pipeline
    from the start.
