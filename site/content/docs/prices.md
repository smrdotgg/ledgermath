# Prices

A price file is a day's copy of AWS's public On-Demand prices selected by LedgerMath's rules, holding AWS's own records verbatim. This page says which prices are kept, in which Region, currency and units, how tiers appear, how to cite a price, and what is not held.

## What a price file is

- At most one file for each UTC day, named by the day its fetch started (`fetched_at`). The fetch is scheduled at 03:17 and 15:17 UTC; when the day's file already exists, the later one adds nothing. Some days may have no price file, and the files do not say why.
- A file is added once and never edited.
- It holds AWS's own product and On-Demand term objects, parsed from AWS's Price List files and written back with nothing changed but the whitespace between tokens. LedgerMath converts and rounds nothing in them.
- Each file names, for each AWS file it read, the versioned URL, the file's own version and publication date, its size in bytes and its SHA-256, so that each source can be downloaded again while AWS serves it. Cutting the price file again takes all its sources, with the rule set, the measured inputs and the fetch time the file records.

## Where the files are

- Each is served at `https://api.ledgermath.com/v1/prices/<yyyy-mm-dd>.json`, byte for byte as LedgerMath keeps it.
- The table of contents, `https://api.ledgermath.com/v1/index.json`, lists every file held under `prices.files`, oldest first, and the newest under `prices.newest`. Each entry gives the file's `date`, its `path` (`prices/<yyyy>/<mm>/<dd>/aws.json`, the name a citation gives it) and its `url`.
- The first file is that of 2026-11-11.
- Each file follows its own schema, `ledgermath.prices/1`, at `https://api.ledgermath.com/v1/schemas/prices.schema.json`. Its fields are described in the [price file reference](/docs/api/prices).

## What a file holds

| Field | What it is |
|---|---|
| `fetched_at` | When the fetch started, UTC, to the millisecond. Its date names the file. |
| `measured` | What LedgerMath's schedule said was measured when the file was cut: the `region` of its zone and its `instance_types`, sorted. |
| `rules` | The rule set the records were selected with, by `name` (`ledgermath.aws-price-rules`) and `version`. |
| `sources` | One per AWS offer file read: `offer_code`, `url`, `version`, `publication_date`, `bytes`, `sha256`, the file's `header` (every top-level member but `products` and `terms`, AWS's disclaimer among them when AWS gives one), the `selections`, and the selected `products` and their `terms.OnDemand`. |
| `sources[].selections` | Each rule, what it `selects` in words, and the SKUs it selected (`skus`). |

## Which prices are kept

Rule set version 1 selects these, from three of AWS's offers. Each file describes each rule in words, under `selections[].selects`; some rules test more than their words say (for example that a record's location is an AWS Region). The prices a rule kept are found through its `skus`.

| Rule | Offer | What it selects | How many |
|---|---|---|---|
| `ec2-instance-on-demand-linux` | `AmazonEC2` | Each instance type in `measured.instance_types`: Linux, shared tenancy, no pre-installed software, no licence, not a capacity reservation | one per instance type |
| `ebs-gp3-storage` | `AmazonEC2` | EBS gp3 volume storage | one |
| `ebs-gp3-iops` | `AmazonEC2` | EBS gp3 provisioned IOPS | one |
| `ebs-gp3-throughput` | `AmazonEC2` | EBS gp3 provisioned throughput | one |
| `s3-standard-storage` | `AmazonS3` | S3 Standard storage | one |
| `s3-standard-requests` | `AmazonS3` | S3 Standard requests: Tier1 (PUT, COPY, POST, LIST) and Tier2 (GET and all others) | one of each |
| `data-transfer-out-to-internet` | `AWSDataTransfer` | Data transfer out of the Region to the internet | one |
| `data-transfer-out-to-internet-global-free-tier` | `AWSDataTransfer` | The global free tier of data transfer out to the internet, which the Region's first tier is beyond | one |

- The instance types are those in `measured.instance_types`, taken from LedgerMath's schedule when the file was cut. On 2026-11-26 they were `c6i.8xlarge`, `c8a.2xlarge`, `c8i.2xlarge`, `i4i.2xlarge` and `m5.large`.
- A rule that selects none, or more or fewer than its count, stops the fetch, which then writes no file. Every file cut with rule set 1 holds exactly the counts above.
- A rule set is never changed once a file names it: a change is a new version, named in the files cut with it.

## Region, currency and units

- **Region.** Every rule but the global free tier selects records of `measured.region`, the Region of the schedule's zone: `us-east-2` (AWS's "US East (Ohio)") in every file from 2026-11-11 to 2026-11-26. The global free tier is AWS's record for all Regions together.
- **Currency.** A price is `pricePerUnit`, keyed by currency code, with the number written as a string, as AWS writes it. In every file from 2026-11-11 to 2026-11-26, every price is in `USD` and in no other currency.
- **Units.** Each price dimension gives its `unit` in AWS's own words and, where AWS gives one, AWS's `description` of the price. LedgerMath does not interpret either. In the file of 2026-11-26 (`https://api.ledgermath.com/v1/prices/2026-11-26.json`, read that day):

| Rule | `unit` | Example of AWS's `description` |
|---|---|---|
| `ec2-instance-on-demand-linux` | `Hrs` | "$0.096 per On Demand Linux m5.large Instance Hour" |
| `ebs-gp3-storage` | `GB-Mo` | "$0.08 per GB-month of General Purpose (gp3) provisioned storage - US East (Ohio)" |
| `ebs-gp3-iops` | `IOPS-Mo` | "$0.005 per provisioned IOPS-month of gp3 - US East (Ohio)" |
| `ebs-gp3-throughput` | `GiBps-mo` | "$0.04 per provisioned MiBps-month of gp3 - US East (Ohio)" |
| `s3-standard-storage` | `GB-Mo` | "$0.023 per GB - first 50 TB / month of storage used" |
| `s3-standard-requests` | `Requests` | "$0.005 per 1,000 PUT, COPY, POST, or LIST requests" |
| `data-transfer-out-to-internet` | `GB` | "$0.090 per GB - first 10 TB / month data transfer out beyond the global free tier" |
| `data-transfer-out-to-internet-global-free-tier` | `GB` | "$0 for 100GB of data transfer out to the internet, aggregated globally, each month" |

`pricePerUnit` is the price of one `unit`. AWS's description can state the same price per another quantity, so read the number against its `unit`:

- The S3 Tier1 request price is `0.0000050000` USD per `Requests`, which the description gives as $0.005 per 1,000 requests.
- The gp3 throughput price is `40.9600000000` USD per `GiBps-mo`, while its description says $0.04 per MiBps-month (40.96 / 1024 = 0.04). Both are kept as AWS wrote them.

**How many bytes AWS's "GB" is.** The price files give `GB`, `GB-Mo` and `GiBps-mo` as AWS writes them. Nothing in a price file, and nothing LedgerMath publishes, says whether AWS's GB is 10^9 or 2^30 bytes; AWS's own documentation is the place to look. What the records show is how AWS's words relate its TB to its GB in a tier: the first transfer tier is described as "first 10 TB / month" and its `endRange` is `10240`.

## Tiers

In the file of 2026-11-26, each price with tiers is one product whose single On-Demand term holds one price dimension per tier. Each tier has its own rate code, its `beginRange` and `endRange` as AWS writes them, and its price. For S3 Standard storage and data transfer out, the last tier's `endRange` is `Inf`; the global free tier has one range, ending at `100`:

| Product | `unit` | Tiers, `beginRange` to `endRange` |
|---|---|---|
| S3 Standard storage | `GB-Mo` | 0 to 51200, 51200 to 512000, 512000 to Inf |
| Data transfer out to the internet | `GB` | 0 to 10240, 10240 to 51200, 51200 to 153600, 153600 to Inf |
| Global free tier of data transfer out | `GB` | 0 to 100, at 0 USD |

In that file, AWS's descriptions give the tiers per month, and the first transfer tier as "beyond the global free tier". LedgerMath applies no tier and states no rule for how AWS applies them; an estimate that uses several tiers cites each tier's price and bounds.

## Finding a price

Find a price by its rule's name, not by searching AWS's words. In `sources[]`, the selection whose `rule` names it lists its SKUs (`skus`); the product is `products[<sku>]`, and its prices are under `terms.OnDemand[<sku>]`.

A search of the words in a file finds more than it means to. "Storage", for example, is in:

- the S3 Standard storage product (`productFamily` `Storage`, offer `AmazonS3`), selected by `s3-standard-storage`;
- the gp3 volume product (`productFamily` `Storage`, offer `AmazonEC2`), selected by `ebs-gp3-storage`;
- in the file of 2026-11-26, every instance type's product, whose attribute `storage` describes the instance's own disks (such as "EBS only" or "1 x 1875 NVMe SSD"), and `i4i.2xlarge`'s `instanceFamily`, "Storage optimized".

An instance type's product also carries AWS's catalog words for it as attributes, such as `vcpu` ("8") and `memory` ("64 GiB") for `i4i.2xlarge`. They are AWS's text, not always a number with a unit: `networkPerformance` is "12500 Megabit" for `c6i.8xlarge`, with no unit of time.

## Citing a price

"A price is cited by the price file's path (path), the SKU and the rate code." (The description of `prices` in the table of contents' schema, `https://api.ledgermath.com/v1/schemas/index.schema.json`.) For example, the price of an `m5.large` hour in the file of 2026-11-11, $0.096:

```
prices/2026/11/11/aws.json, SKU 8D49XP354UEYTHGM, rate code 8D49XP354UEYTHGM.JRTCKXETXF.6YS6EN2CT7
```

- The rate code is `<sku>.<offerTermCode>.<code>`. Each term is filed under `<sku>.<offerTermCode>`, and each price dimension under its rate code, so within the source whose `products` hold the SKU, the citation finds exactly one price dimension: `terms.OnDemand[<sku>][<sku>.<offerTermCode>].priceDimensions[<rate code>]`, with its `unit`, `pricePerUnit`, and, where AWS gives them, `beginRange`, `endRange` and `description`.
- The path holds the file's date, which says which day's price was used.
- A tier is cited by its own rate code; its bounds by the same price dimension's `beginRange` and `endRange`.

## What is not held

A record no rule of the file's rule set selects is not in the file, whatever AWS charges for it. In particular:

- No price that is not AWS's public On-Demand price: no Reserved Instance or other term, no Savings Plans, no Spot price, no negotiated or private rate, no tax.
- No CDN: no CloudFront price, and no transfer to CloudFront.
- No transfer but out of the Region to the internet: none between Regions, between zones, or between S3 and EC2.
- No other S3 storage class, no other EBS volume type, no EBS snapshot.
- No other operating system, tenancy or licence for an instance, and no instance type LedgerMath does not measure.
- No other Region's prices.

A price being held does not mean LedgerMath measures what it prices. The rules keep, for example, the price of S3's PUT, COPY, POST and LIST requests, while the one benchmark that measures S3, `http_get`, makes GET requests only.
