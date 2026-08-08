# Ledger storage substrate survey

- **Date:** 2026-08-08
- **Ticket:** [#15 — Ledger storage substrate survey](https://github.com/smrdotgg/ledgermath/issues/15) (part of #12)
- **Question:** What should hold the LedgerMath "Ledger" — an append-only, permanent, open, BI-queryable log of benchmark Observations (JSON records with raw nanosecond samples, ~daily appends, open-source-accessible, auditable for decades)?

## Context and workload shape

The workload is tiny by storage standards: one benchmark run per day producing a JSON Observation on the order of kilobytes (even with thousands of raw nanosecond samples, a day's record is well under a megabyte). That is **megabytes per year, low single-digit GB over decades**. Every candidate below is at or near $0/month at this scale, so cost is a tiebreaker, not a differentiator. The real differentiators are: open access without credentials, queryability by BI tools and AI agents, decades-scale permanence/portability, and whether append-only is *enforced* or merely a convention.

---

## 1. AWS S3 + Parquet (with/without Iceberg)

**Cost at small scale.** S3 Standard is $0.023/GB-month for the first 50 TB in us-east-1 ([confirmed current 2026 rate](https://www.cloudzero.com/blog/s3-pricing/); AWS's own [pricing page](https://aws.amazon.com/s3/pricing/) is interactive and states "pay only for what you use"). Egress to the internet is free for the first 100 GB/month aggregated across AWS services ([AWS S3 pricing](https://aws.amazon.com/s3/pricing/)); beyond that, ~$0.09/GB (unverified from the interactive table, widely corroborated). At ledger scale: cents per month for storage, but **public egress is the trap** — a popular open dataset that people repeatedly full-scan could generate real transfer bills once past the 100 GB/month free allowance.

**Query ergonomics.** Excellent with Parquet: DuckDB reads `s3://` and `https://` Parquet directly via httpfs with predicate/projection pushdown. Athena gives serverless SQL over the same files. Adding **Apache Iceberg** brings ACID table semantics, snapshots, and schema evolution, but requires a catalog (Glue, or an Iceberg REST catalog) — meaningful operational surface for a table that grows by one row a day. Iceberg is designed for large, mutating analytic tables; an append-only ledger of this size gets snapshots "for free" anyway if the raw JSON is versioned elsewhere.

**BI-tool compatibility.** Tableau and Metabase both have first-class Athena connectors ([Metabase official drivers list](https://www.metabase.com/docs/latest/developers-guide/community-drivers) distinguishes official vs community; Athena is official). Direct S3-Parquet into BI tools generally routes through DuckDB/Athena/Trino rather than a native connector.

**AI-agent accessibility.** Very good *if the bucket is public*: any agent with `curl` or DuckDB can hit `https://bucket.s3.amazonaws.com/...` anonymously. No credentials needed for public-read buckets.

**Permanence/portability.** Parquet is an open Apache format — fully portable. S3 itself is the de-facto object-storage API standard; migration to any S3-compatible store (R2, MinIO, Backblaze) is `aws s3 sync`. Risk is a billing lapse deleting the bucket, not format lock-in.

**Append-only enforcement.** The strongest of any candidate: **S3 Object Lock** provides true WORM. In *compliance mode*, "a protected object version can't be overwritten or deleted by any user, including the root user in your AWS account" — the only escape is deleting the AWS account itself ([S3 Object Lock docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)). Governance mode allows privileged override; legal holds lock indefinitely. Requires versioning enabled. Assessed by Cohasset Associates for SEC 17a-4/FINRA use.

---

## 2. Datasette / published SQLite files

**Cost at small scale.** The SQLite file itself is free to host anywhere (static hosting, object storage, a git repo — a decades-long ledger fits in a file measured in MB). `datasette publish` deploys the database + web UI + JSON API to Cloud Run, Heroku, Vercel, or Fly ([Datasette publish docs](https://docs.datasette.io/en/stable/publish.html)); Cloud Run and Vercel scale to zero, so a rarely-queried ledger costs ~$0/month but is a *running service*, not just data.

**Query ergonomics.** Outstanding for humans and agents: Datasette gives every table a browsable UI, arbitrary read-only SQL over HTTP, and a JSON API for every query. This is the "baked data" pattern — republish the file on each append. DuckDB can also attach SQLite files directly (local copy).

**BI-tool compatibility.** Weak point. Metabase's SQLite driver needs the file on the Metabase host; Tableau likewise treats SQLite as a local file (via ODBC). No BI tool queries a remote Datasette instance natively — BI access means downloading the file first (trivial at MB scale, but an extra hop).

**AI-agent accessibility.** Best in class: an agent can hit `https://host/db.json?sql=...` with zero credentials and zero tooling beyond HTTP. Datasette was designed for exactly this open-data publishing use case.

**Permanence/portability.** SQLite is arguably the most durable format on this list — the Library of Congress lists it as a recommended storage format, and the SQLite project pledges support through 2050. Single-file, no vendor. The *Datasette service* is the ephemeral part; the file is forever.

**Append-only enforcement.** None inherent. SQLite files are mutable; append-only is pure convention unless the file lives on WORM storage or in git history.

---

## 3. Hugging Face datasets

**Cost at small scale.** Free. Public repos get "best-effort" free storage — generous "beyond the first few gigabytes" for datasets useful to the community; PRO includes up to 10 TB public storage ([HF storage limits](https://huggingface.co/docs/hub/en/storage-limits)). A ledger of MBs is far inside the free zone. No egress charges; files served via CloudFront.

**Query ergonomics.** Surprisingly strong: DuckDB ≥ v0.10.3 has **native `hf://` support** — `SELECT * FROM 'hf://datasets/org/name/*.parquet'` works out of the box, no token needed for public datasets ([HF DuckDB docs](https://huggingface.co/docs/hub/en/datasets-duckdb)). The Hub auto-converts datasets to Parquet (the `@~parquet` / `refs/convert/parquet` revision), and the Dataset Viewer gives a browsable UI. Repos are git-backed, so appends are commits with history.

**BI-tool compatibility.** Indirect only: no Metabase/Tableau connector for HF. The path is DuckDB/MotherDuck reading `hf://`, or downloading Parquet. Fine for analysts, not turnkey for BI dashboards.

**AI-agent accessibility.** Excellent. `hf datasets sql "FROM 'hf://datasets/...' LIMIT 3"` one-liner, plain HTTPS download URLs, the datasets-server REST API, and every major agent framework already knows the Hub. Public datasets need no auth.

**Permanence/portability.** Data is git + Parquet/JSON — fully exportable with `git clone`. But free public storage is explicitly *best-effort* and conditioned on community usefulness ("we do have mitigations in place to prevent abuse of free public storage" — [storage limits](https://huggingface.co/docs/hub/en/storage-limits)). HF is a venture-backed company; a decades horizon requires assuming the Hub outlives its current business model. Mirroring elsewhere is mandatory if HF is the primary.

**Append-only enforcement.** Git history gives auditability, but repo owners can force-push, delete files, or `super_squash_history` (HF explicitly documents squashing to reclaim space). Convention plus history, not WORM.

---

## 4. BigQuery public datasets

**Cost at small scale.** Free tier: 10 GiB active storage + 1 TiB of query processing per month, no credit card required; on-demand queries beyond that are $6.25/TiB ([BigQuery pricing](https://cloud.google.com/bigquery/pricing), corroborated by [current 2026 guides](https://airbyte.com/data-engineering-resources/bigquery-pricing)). Under the official **Public Datasets Program**, "Google pays for the storage of these datasets"; users "pay only for the queries" with the first 1 TB/month free ([public data docs](https://docs.cloud.google.com/bigquery/public-data)). Caveat: getting into that program is not self-serve — it goes through `bq-public-data@google.com`, and a hobby-scale benchmark ledger may not qualify. Self-hosted in a normal project, the ledger fits the free tier indefinitely.

**Query ergonomics.** Best-in-class SQL: full warehouse, instant on TB-scale joins, scheduled queries. Massive overkill for MB-scale data, and appends require a load job or streaming insert through GCP credentials.

**BI-tool compatibility.** The gold standard — Metabase (official driver), Tableau (native connector), Looker, Sheets, everything connects to BigQuery.

**AI-agent accessibility.** Weakest of the list: **every query requires a GCP account and billing project**, even against public datasets (queries bill to *your* project). No anonymous HTTP access. An agent needs Google credentials configured, which contradicts "open-source-accessible" for casual users.

**Permanence/portability.** Proprietary serving layer; data is exportable (to GCS as Parquet/JSON/CSV) but the query endpoint is pure Google lock-in. If Google changes the free tier or the program, the access story changes with it.

**Append-only enforcement.** None native at table level for this use case; IAM can restrict who writes, but there is no WORM equivalent — deletion/rewrite is always possible for the owner.

---

## 5. Cloudflare R2

**Cost at small scale.** Free tier covers this project outright: 10 GB-month storage, 1M Class A (write) ops, 10M Class B (read) ops per month, and **egress is $0, always** ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). Beyond free: $0.015/GB-month, $4.50/M writes, $0.36/M reads. Zero egress is the structural win for an open dataset: unlimited public full-scans cost the project nothing, unlike S3.

**Query ergonomics.** Same as S3 (it's S3-API-compatible): DuckDB reads Parquet from R2 via the S3 API or plain HTTPS through public `r2.dev`/custom domains. Additionally, **R2 Data Catalog** (public beta as of Aug 2026) is "a managed Apache Iceberg data catalog built directly into your R2 bucket" exposing a standard Iceberg REST interface for Spark, Snowflake, PyIceberg, and Iceberg-capable engines ([R2 Data Catalog](https://developers.cloudflare.com/r2/data-catalog/)) — an upgrade path to real table semantics with no extra infrastructure.

**BI-tool compatibility.** Same story as S3-without-Athena: via DuckDB/MotherDuck (Metabase has a [community DuckDB driver maintained by MotherDuck](https://github.com/motherduckdb/metabase_duckdb_driver), self-hosted only; Tableau has a [MotherDuck-maintained DuckDB connector](https://github.com/MotherDuck-Open-Source/duckdb-tableau-connector) over JDBC). Iceberg-capable BI stacks can use the Data Catalog. No native Metabase/Tableau "R2" connector.

**AI-agent accessibility.** Excellent with a public bucket: anonymous HTTPS GETs on a custom domain, DuckDB one-liners, no credentials. Free egress means nobody has to worry about an agent hammering the dataset.

**Permanence/portability.** Open formats (Parquet/JSON) + S3-compatible API = trivially portable to any object store. Cloudflare is a large public company, but the product is younger than S3; the zero-egress promise is also the exit guarantee — copying everything out is free.

**Append-only enforcement.** **R2 bucket locks** "prevent the deletion and overwriting of objects... for a specified period — or indefinitely" via retention rules ([bucket locks docs](https://developers.cloudflare.com/r2/buckets/bucket-locks/)). Real WORM, including indefinite retention. Slightly less battle-hardened than S3 Object Lock (no compliance-mode/root-user distinction documented), but genuine enforcement, not convention.

---

## 6. Plain git / git-LFS on GitHub

**Cost at small scale.** Free. GitHub recommends repos stay "ideally less than 1 GB, and less than 5 GB is strongly recommended"; individual files are blocked above 100 MiB ([About large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)). A daily-append JSON ledger stays under 1 GB for decades. Git LFS (not needed at this scale) includes 10 GiB storage + 10 GiB/month bandwidth free on Free/Pro plans ([LFS billing](https://docs.github.com/en/billing/managing-billing-for-git-large-file-storage/about-billing-for-git-large-file-storage)) — but LFS objects live in GitHub's proprietary LFS store, weakening the "clone = full copy" guarantee, so avoid LFS entirely.

**Query ergonomics.** None natively — git stores files, not tables. But: raw.githubusercontent.com serves files over HTTPS, so DuckDB can `read_json`/`read_parquet` from raw URLs; `git log -p` is a free audit tool; and at MB scale "clone and query locally" is instant. Ergonomics are fine for agents and scripts, poor for ad-hoc SQL by strangers.

**BI-tool compatibility.** None direct. BI requires an ETL hop (download → DuckDB/SQLite → BI tool).

**AI-agent accessibility.** Excellent: `gh`, raw HTTPS URLs, and the GitHub API are in every agent's toolkit; public repos need no auth (only rate limits). Arguably the most agent-native substrate on the list.

**Permanence/portability.** The best story here: every clone is a full, cryptographically-linked replica of the entire history. GitHub dying costs nothing — the ledger lives in a thousand clones and can be pushed to any git host. Content-addressed hashes make silent tampering detectable by anyone holding an old clone. This is the only candidate where *auditability for decades* is a mathematical property rather than a vendor promise.

**Append-only enforcement.** Convention plus cryptography: history rewrites require force-push, which branch protection rules can forbid, and any rewrite changes all subsequent commit hashes — detectable, but not *preventable* against a malicious repo admin the way S3 compliance mode is. Signed commits/tags strengthen this further.

---

## Comparison table

| Axis | S3 + Parquet (±Iceberg) | Datasette/SQLite | Hugging Face datasets | BigQuery public | Cloudflare R2 | git on GitHub |
|---|---|---|---|---|---|---|
| **Cost @ MB–GB scale** | ~$0 storage; egress $ after 100 GB/mo free | ~$0 (scale-to-zero service) | $0 (best-effort public tier) | $0 (10 GiB + 1 TiB/mo free) | $0 (10 GB free, **$0 egress forever**) | $0 (<1 GB repo) |
| **Query ergonomics** | DuckDB/Athena over Parquet: great | HTTP SQL + JSON API: great | DuckDB `hf://` native: great | Full warehouse SQL: best | DuckDB via S3 API/HTTPS; Iceberg REST catalog (beta) | Files only; clone-and-query |
| **BI tools (Metabase/Tableau)** | Via Athena (official connectors) | Local-file only | Via DuckDB only | Native, official, best | Via DuckDB (community drivers) or Iceberg | ETL hop required |
| **AI-agent access (no creds)** | Yes, if bucket public | Yes — JSON API, best | Yes — `hf://`, HTTPS | **No — GCP account required** | Yes — public bucket, free egress | Yes — raw URLs, `gh` |
| **Permanence/portability** | Open formats; pay forever; export trivial | SQLite = archival-grade file | Git+Parquet exportable; free tier best-effort | Export possible; query layer locked-in | Open formats; free exit (no egress) | **Every clone = full replica; host-independent** |
| **Append-only enforcement** | **Object Lock compliance mode (true WORM, root-proof)** | None (convention) | Git history; squash/force-push possible | None (IAM only) | **Bucket locks (WORM, indefinite)** | Crypto-verifiable history; branch protection; not admin-proof |

## Shortlist recommendation

**Primary: git repo on GitHub as the canonical Ledger + Parquet mirror on Cloudflare R2 as the query surface.**

- **Git as source of truth** fits every hard requirement that vendors can't promise: it is the only substrate where decades-long auditability is guaranteed by content-addressed hashes and community clones rather than a company's continued goodwill, it's free at this scale forever, and it's the most natural surface for AI agents and open-source contributors (PRs *are* the append protocol — a new Observation is a commit, reviewable and signed). Daily JSON appends keep the repo tiny; no LFS.
- **R2 Parquet mirror** (regenerated from the repo by CI on each append, bucket-locked with an indefinite retention rule) supplies what git lacks: `SELECT`-ability. DuckDB — and through it Metabase and Tableau via the MotherDuck drivers — queries the public bucket anonymously, and zero egress means open access costs nothing no matter how hard people or agents hammer it. If table semantics ever matter, R2 Data Catalog adds an Iceberg REST endpoint on the same bucket with no new infrastructure.
- The mirror is derived data: if Cloudflare vanishes, CI re-publishes the same Parquet to any S3-compatible host in an afternoon. If GitHub vanishes, every clone is the ledger.

**Runner-up: Hugging Face datasets mirror** — near-zero effort (it's just another git remote), native DuckDB `hf://` querying, auto-Parquet conversion, a free browsable Dataset Viewer, and it puts the ledger where the ML/agent community already looks. Worth adding as a *second* mirror, but not as primary: free public storage is explicitly best-effort and append-only is not enforced.

**Rejected as primary:** BigQuery (credentials wall contradicts open agent access; program onboarding not self-serve), S3 (strictly dominated by R2 here — same formats and API but with egress fees; its one edge, compliance-mode Object Lock, matters more for regulated data than an open benchmark ledger), Datasette (superb agent API but a service to babysit and no BI path — worth revisiting later as a *frontend* over the same SQLite/Parquet, not as the substrate).

## Sources

- https://aws.amazon.com/s3/pricing/ — S3 pricing, 100 GB/mo free egress tier
- https://www.cloudzero.com/blog/s3-pricing/ — corroboration of $0.023/GB-mo S3 Standard (2026)
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html — S3 Object Lock WORM, compliance/governance modes
- https://docs.datasette.io/en/stable/publish.html — datasette publish targets and deployed components
- https://huggingface.co/docs/hub/en/storage-limits — HF storage plans, best-effort public storage, repo recommendations
- https://huggingface.co/docs/hub/en/datasets-duckdb — DuckDB native `hf://` access, `@~parquet` revision
- https://cloud.google.com/bigquery/pricing — BigQuery free tier and on-demand pricing
- https://airbyte.com/data-engineering-resources/bigquery-pricing — corroboration of 10 GiB / 1 TiB free, $6.25/TiB (2026)
- https://docs.cloud.google.com/bigquery/public-data — Public Datasets Program: Google pays storage, users pay queries
- https://developers.cloudflare.com/r2/pricing/ — R2 pricing and forever-free tier, zero egress
- https://developers.cloudflare.com/r2/data-catalog/ — R2 Data Catalog managed Iceberg REST catalog (public beta)
- https://developers.cloudflare.com/r2/buckets/bucket-locks/ — R2 bucket locks retention/WORM
- https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github — repo size guidance, 100 MiB file block
- https://docs.github.com/en/billing/managing-billing-for-git-large-file-storage/about-billing-for-git-large-file-storage — LFS free quotas (10 GiB Free/Pro)
- https://github.com/motherduckdb/metabase_duckdb_driver — Metabase DuckDB community driver (MotherDuck-maintained)
- https://github.com/MotherDuck-Open-Source/duckdb-tableau-connector — Tableau DuckDB JDBC connector
- https://www.metabase.com/docs/latest/developers-guide/community-drivers — Metabase official vs community driver policy
