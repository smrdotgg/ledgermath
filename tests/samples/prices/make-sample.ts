/**
 * Writes the sample price file, repository/prices/2026/11/11/aws.json: the
 * excerpts in sources/ cut with the current rules, the tests' measured inputs
 * and fetch time (tests/prices-fixtures.ts). tests/prices.test.ts requires
 * the cut to give these bytes, so run this again only when the rules or the
 * file's shape change on purpose, and read the diff.
 *
 *     bun tests/samples/prices/make-sample.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CURRENT_RULES } from "../../../scripts/lib/price-rules";
import { cutPrices, serializePriceFile } from "../../../scripts/lib/prices";
import { FETCHED_AT, MEASURED, SAMPLE_FILE, sampleSources } from "../../prices-fixtures";

const file = cutPrices({ fetchedAt: FETCHED_AT, measured: MEASURED, rules: CURRENT_RULES, sources: sampleSources() });
mkdirSync(dirname(SAMPLE_FILE), { recursive: true });
writeFileSync(SAMPLE_FILE, serializePriceFile(file));
console.log(`wrote ${SAMPLE_FILE}`);
