# Sample price sources and price file

Used by `tests/prices.test.ts` and `tests/prices-schema.test.ts`; also readable as an
example of a price file.

| Path | What it is | Made by |
|------|------------|---------|
| `sources/AmazonEC2.json`, `sources/AmazonS3.json`, `sources/AWSDataTransfer.json` | Excerpts of AWS's real offer files for `us-east-2`, in AWS's own layout: the real header, and the real text of each product and its On-Demand terms, byte for byte, for the records the rules must select and for decoys they must not (other tenancies, operating systems and types, gp2 and io2, annotation and Infrequent Access requests, accelerated, inter-Region and inbound transfer, products with no `productFamily`), plus one product's Reserved terms, which a cut must skip | `make-sources.ts`, on 2026-11-11, from the versioned files it names |
| `repository/prices/2026/11/11/aws.json` | The price file the excerpts give, cut with rule set 1, the tests' measured inputs (`c6i.8xlarge`, `i4i.2xlarge`, `m5.large` in `us-east-2`) and fetch time (`tests/prices-fixtures.ts`), where the Runs repository would hold it | `make-sample.ts` |

The excerpts are not AWS's files, so their sizes and hashes are not those files'. The
tests serve them under the real files' versioned URLs from a fake fetch, so the fetch and
the recompute check run with no network. The tests require the cut to give the sample's
bytes exactly; run `make-sample.ts` again only when the rules or the file's shape change
on purpose, and read the diff.
