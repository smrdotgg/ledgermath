/**
 * The price fetch: makes the day's price file in a checkout of the Runs
 * repository, prices/<yyyy>/<mm>/<dd>/aws.json (UTC date), from AWS's public
 * Price List files (issue #45; what a price file is: scripts/lib/prices.ts).
 *
 *     bun scripts/fetch-prices.ts --work DIR [--schedule FILE] [--keep-sources] REPOSITORY
 *
 * What is measured comes from schedule.json: its instance types and the Region
 * of its zone. The rules (scripts/lib/price-rules.ts) add the fixed list.
 *
 *   1. If the day's file exists, it does nothing and says so. It never
 *      overwrites, and never writes through a symbolic link.
 *   2. It resolves each offer's versioned URL for the Region (offer index,
 *      region index), and streams each file to a new directory under --work.
 *      The EC2 file for one Region is over 400 MB; it is never held in memory.
 *   3. It cuts the records the rules select, verbatim, and the size and
 *      SHA-256 of every byte it read. A rule that selects nothing, or an
 *      implausible number of products, stops it, and it writes nothing.
 *   4. The file must validate against schemas/prices.schema.json and hold
 *      together (checkPriceFile); then it is added, exclusively.
 *   5. The downloaded files are removed, unless --keep-sources.
 *
 * It does not commit: the workflow does (.github/workflows/prices.yml). It
 * needs no AWS credentials.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { parseSchedule, type Schedule } from "../infra/runs/schedule";
import { CURRENT_RULES, measuredFromSchedule, type RuleSet } from "./lib/price-rules";
import { checkPriceFile } from "./lib/price-file-check";
import { cutPrices, download, type Fetch, type PriceFile, priceFilePath, resolveSources, serializePriceFile, type SourceFile } from "./lib/prices";
import { addFile, lstatOrNull, symlinkOnPath } from "./lib/runs-repository";

export type FetchOutcome =
	| { outcome: "added"; path: string; file: PriceFile; sources: SourceFile[] }
	| { outcome: "exists"; path: string }
	| { outcome: "appeared"; path: string };

export async function fetchPrices(options: {
	/** A checkout of the Runs repository. */
	repository: string;
	/** Where the offer files are downloaded, each run in a new directory of its own. */
	work: string;
	schedule: Schedule;
	now: Date;
	fetcher: Fetch;
	rules?: RuleSet;
	keepSources?: boolean;
	log?: (line: string) => void;
}): Promise<FetchOutcome> {
	const log = options.log ?? ((line: string) => console.log(line));
	const rules = options.rules ?? CURRENT_RULES;
	const path = priceFilePath(options.now);
	const link = symlinkOnPath(options.repository, path);
	if (link !== null) throw new Error(`${path}: ${link} is a symbolic link; the price fetch writes through none`);
	if (lstatOrNull(join(options.repository, path)) !== null) return { outcome: "exists", path };

	const measured = measuredFromSchedule(options.schedule);
	log(`measured: ${measured.instance_types.join(", ")} in ${measured.region}; rules ${rules.name} version ${rules.version}`);
	const resolved = await resolveSources(options.fetcher, rules, measured.region);

	mkdirSync(options.work, { recursive: true });
	const directory = mkdtempSync(join(options.work, "prices-"));
	try {
		const sources: SourceFile[] = [];
		for (const { offerCode, url } of resolved) {
			const started = performance.now();
			const file = join(directory, `${offerCode}.json`);
			const size = await download(options.fetcher, url, file);
			log(`downloaded ${url}: ${size} bytes in ${((performance.now() - started) / 1000).toFixed(1)} s`);
			sources.push({ offerCode, url, path: file });
		}
		const started = performance.now();
		const file = cutPrices({ fetchedAt: options.now, measured, rules, sources });
		log(`cut in ${((performance.now() - started) / 1000).toFixed(1)} s`);
		const problems = checkPriceFile(file, path);
		if (problems.length > 0) throw new Error([`${path}: the cut does not hold together, so nothing was written`, ...problems.map((p) => `  ${p}`)].join("\n"));

		const outcome = addFile(options.repository, path, new TextEncoder().encode(serializePriceFile(file)));
		if (outcome === "appeared") return { outcome: "appeared", path };
		return { outcome: "added", path, file, sources };
	} finally {
		if (!options.keepSources) rmSync(directory, { recursive: true, force: true });
		else log(`kept the downloaded files in ${directory}`);
	}
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		options: { work: { type: "string" }, schedule: { type: "string" }, "keep-sources": { type: "boolean" } },
		allowPositionals: true,
	});
	const [repository] = positionals;
	if (!repository || positionals.length !== 1 || !values.work) {
		console.error("usage: bun scripts/fetch-prices.ts --work DIR [--schedule FILE] [--keep-sources] REPOSITORY");
		process.exit(2);
	}
	const schedulePath = values.schedule ?? join(resolve(import.meta.dir, ".."), "schedule.json");
	const schedule = parseSchedule(JSON.parse(readFileSync(schedulePath, "utf8")), schedulePath);
	const result = await fetchPrices({
		repository,
		work: values.work,
		schedule,
		now: new Date(),
		fetcher: (url, init) => fetch(url, init),
		keepSources: values["keep-sources"] === true,
	});
	if (result.outcome === "exists") {
		console.log(`${result.path} already exists; nothing to do`);
		return;
	}
	if (result.outcome === "appeared") {
		console.log(`${result.path} appeared while the fetch ran; it was left as it is, and nothing was written`);
		return;
	}
	for (const source of result.file.sources) {
		console.log(`${source.offer_code} ${source.version} (${source.publication_date}): ${source.bytes} bytes, ${source.sha256}`);
		for (const selection of source.selections) console.log(`  ${selection.rule}: ${selection.skus.length} (${selection.skus.join(", ")})`);
	}
	console.log(`added ${result.path}`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
