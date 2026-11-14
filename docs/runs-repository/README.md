# LedgerMath Runs

The measurements of [LedgerMath](https://github.com/smrdotgg/ledgermath): a file for every
execution of a benchmark on a LedgerMath box, failed or not, a file for every boot of a box,
and AWS's published prices for what is measured, one file a day. How they are made, and the
schemas they follow, are in the source repository, <https://github.com/smrdotgg/ledgermath>.

| Path | What it is |
|---|---|
| `runs/<yyyy>/<mm>/<dd>/<id>.json` | A Run: one execution of one benchmark binary, under the UTC date it started; `<id>` is the Run's id. Schema: `schemas/run.schema.json` |
| `boots/<yyyy>/<mm>/<dd>/<boot>.json` | A boot summary: every execution one boot of a box was scheduled to make, and what became of it, under the UTC date the boot's runner started; `<boot>` is the kernel's boot id |
| `prices/<yyyy>/<mm>/<dd>/aws.json` | AWS's published price-list records for what is measured, as fetched that UTC day. Schema: `schemas/prices.schema.json` |

Files are only added, never edited or removed. The source repository's workflows copy the
Runs and boot summaries here byte for byte from the bucket the boxes upload to, and make the
price files from AWS's price lists. A correction is a new version of a Method in the source
repository, never a changed file.

## Licence

The Runs and boot summaries are published by The LedgerMath Authors under the Creative
Commons Attribution 4.0 International licence (CC BY 4.0), whose legal code is
[`LICENSE`](LICENSE). In short, though the legal code is what governs: you may share and
adapt them for any purpose, if you give credit, link to the licence, and say if you changed
them.

To give credit, name LedgerMath, this repository's address, the Run's id or path, and the
licence, and say if what you show was computed from the Runs or changed. For example:

> LedgerMath, Run `<id>` (`runs/<yyyy>/<mm>/<dd>/<id>.json`),
> https://github.com/smrdotgg/ledgermath-runs, CC BY 4.0.

For a figure computed from many Runs, the source repository's lookup tool
(`scripts/lookup.ts`) prints a citation beside every number, naming the Series, the Method
version and the moment, with the Run files behind it; for a price, the file, SKU and rate
code. Its README's section "The agent skill" gives the forms.

## What the licence does not cover

- **Prices.** `prices/` holds AWS's own published price-list records, reproduced as AWS
  published them. Each file gives, for each record's source, its address and the SHA-256 of
  the file read there. LedgerMath claims no rights in AWS's records, and the licence above
  does not apply to them. What LedgerMath adds around them in each file (when they were
  fetched, from where, which rule selected each record) is under CC BY 4.0 like the Runs.
- **Blobs.** A Run names other files by the SHA-256 of their bytes (`sha256:<hex>`): its
  environment dumps, its stdout and stderr, the binary that ran, and the source archive the
  binary was built from. They are not in this repository but in a bucket, each at
  `blobs/sha256/<hex>` under:

  **[Placeholder: the bucket's public address, not decided yet.]**

  The dumps, stdout and stderr are published with the Runs, under CC BY 4.0, except what the
  dumps reproduce of AWS's records (what the instance metadata service and the EC2 API
  returned to the box), in which LedgerMath claims no rights. The source archives hold
  LedgerMath's source code, under its own licence, Apache-2.0. The binaries contain
  third-party code under its own licences: the GNU C Library and parts of GCC's runtime
  library in every binary, and AWS-LC in `http_get`'s. `THIRD-PARTY-NOTICES.md` in the
  source repository lists them, with their licences and where their source is.

## No warranty

The numbers are measurements, published as they were recorded, failed and interrupted
executions included. They describe the machines and software as they were when measured,
and may be wrong. They come with no warranty of any kind (section 5 of the licence).

The page that charts them:

**[Placeholder: the page's address, not decided yet.]**
