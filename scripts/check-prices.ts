/**
 * The recompute check of a price file: is every record in it exactly what
 * AWS's file at the address it names gives, cut by the rules it names?
 *
 *     bun scripts/check-prices.ts --work DIR [--sources DIR] FILE
 *
 * FILE is a price file, at prices/<yyyy>/<mm>/<dd>/aws.json in a checkout of
 * the Runs repository or anywhere else. The check:
 *
 *   1. validates it against schemas/prices.schema.json and checks it holds
 *      together (scripts/lib/price-file-check.ts), and, when its path is
 *      shaped like one in the Runs repository, that it is under the date it
 *      was fetched;
 *   2. finds the rule set it names, by name and version (scripts/lib/price-rules.ts
 *      keeps every version a stored file names);
 *   3. downloads each source again at its versioned URL, into a new directory
 *      under --work, and the cut computes its size and SHA-256 while reading
 *      it; with --sources DIR, a file DIR/<offer code>.json is used instead of
 *      downloading, and checked the same way (fetch-prices.ts --keep-sources
 *      leaves files so named);
 *   4. cuts again, with the rule set, the measured inputs and the fetch time the
 *      file records, and requires the result, written out, to be FILE's bytes
 *      exactly. A difference is reported source by source: size and hash,
 *      then each selection, product and set of terms that differs.
 *
 * Exit status 0 when FILE is exactly what its sources give, 1 when not.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { repeatedKey } from "./lib/offer-file";
import { checkPriceFile } from "./lib/price-file-check";
import { type OfferCode, OFFER_CODES, RULE_SETS } from "./lib/price-rules";
import { CutRefused, cutPrices, download, type Fetch, type PriceFile, PRICE_FILE_PATH, serializePriceFile, type SourceFile } from "./lib/prices";

export interface PriceCheck {
	problems: string[];
	/** What was checked of each source, for the report. */
	sources: Array<{ offer_code: string; url: string; bytes: number; sha256: string; records: number }>;
}

/** The path of file under a directory named prices/, as the Runs repository holds it, or null. */
function repositoryPath(path: string): string | null {
	const parts = resolve(path).split("/");
	const at = parts.lastIndexOf("prices");
	if (at < 0) return null;
	const candidate = parts.slice(at).join("/");
	return PRICE_FILE_PATH.test(candidate) ? candidate : null;
}

const canonical = (value: unknown): string => JSON.stringify(value);

/** What differs between the stored source and the recut one. */
function differences(stored: PriceFile, recut: PriceFile): string[] {
	const found: string[] = [];
	if (canonical({ ...stored, sources: [] }) !== canonical({ ...recut, sources: [] })) found.push("the file's own fields differ from the recut's");
	for (const source of stored.sources) {
		const again = recut.sources.find((candidate) => candidate.offer_code === source.offer_code);
		const where = `source ${source.offer_code}`;
		if (again === undefined) {
			found.push(`${where}: the recut has no such source`);
			continue;
		}
		if (again.bytes !== source.bytes || again.sha256 !== source.sha256) {
			found.push(`${where}: ${source.url} now gives ${again.bytes} bytes, ${again.sha256}; the file says ${source.bytes} bytes, ${source.sha256}`);
		}
		for (const key of ["version", "publication_date", "header", "selections"] as const) {
			if (canonical(source[key]) !== canonical(again[key])) found.push(`${where}: ${key} differs`);
		}
		for (const sku of new Set([...Object.keys(source.products), ...Object.keys(again.products)])) {
			if (canonical(source.products[sku]) !== canonical(again.products[sku])) found.push(`${where}: products.${sku} differs`);
			if (canonical(source.terms.OnDemand[sku]) !== canonical(again.terms.OnDemand[sku])) found.push(`${where}: terms.OnDemand.${sku} differs`);
		}
	}
	for (const source of recut.sources) {
		if (!stored.sources.some((candidate) => candidate.offer_code === source.offer_code)) found.push(`source ${source.offer_code}: only in the recut`);
	}
	return found;
}

export async function checkPrices(options: {
	/** The price file's path; its bytes are read from here. */
	path: string;
	work: string;
	fetcher: Fetch;
	/** A directory holding <offer code>.json for some sources, used instead of downloading them. */
	sources?: string;
	log?: (line: string) => void;
}): Promise<PriceCheck> {
	const log = options.log ?? ((line: string) => console.log(line));
	const text = readFileSync(options.path, "utf8");
	let file: unknown;
	try {
		file = JSON.parse(text);
	} catch (error) {
		return { problems: [`not JSON: ${error instanceof Error ? error.message : String(error)}`], sources: [] };
	}
	// A key twice in one object: a standard parser keeps the last, and the file would say two things.
	const repeated = repeatedKey(text);
	if (repeated !== null) {
		return { problems: [`the key ${JSON.stringify(repeated.key)} appears twice in one object, under ${repeated.within.map((part) => JSON.stringify(part)).join(" > ") || "the top level"}`], sources: [] };
	}
	const shapeProblems = checkPriceFile(file, repositoryPath(options.path) ?? undefined);
	if (shapeProblems.length > 0) return { problems: shapeProblems, sources: [] };
	const stored = file as PriceFile;

	const rules = RULE_SETS.get(stored.rules.version);
	if (rules === undefined || rules.name !== stored.rules.name) {
		return { problems: [`cut with ${stored.rules.name} version ${stored.rules.version}, which scripts/lib/price-rules.ts does not hold`], sources: [] };
	}

	mkdirSync(options.work, { recursive: true });
	const directory = mkdtempSync(join(options.work, "check-prices-"));
	try {
		const sources: SourceFile[] = [];
		for (const source of stored.sources) {
			if (!(OFFER_CODES as readonly string[]).includes(source.offer_code)) {
				return { problems: [`source ${source.offer_code}: no rule of any version reads that offer`], sources: [] };
			}
			const offerCode = source.offer_code as OfferCode;
			const local = options.sources === undefined ? null : join(options.sources, `${offerCode}.json`);
			if (local !== null && existsSync(local)) {
				log(`${offerCode}: using ${local}, not downloading ${source.url}`);
				sources.push({ offerCode, url: source.url, path: local });
				continue;
			}
			const path = join(directory, `${offerCode}.json`);
			const started = performance.now();
			const size = await download(options.fetcher, source.url, path);
			log(`downloaded ${source.url}: ${size} bytes in ${((performance.now() - started) / 1000).toFixed(1)} s`);
			sources.push({ offerCode, url: source.url, path });
		}

		let recut: PriceFile;
		try {
			recut = cutPrices({ fetchedAt: new Date(stored.fetched_at), measured: stored.measured, rules, sources });
		} catch (error) {
			if (error instanceof CutRefused) return { problems: error.problems.map((problem) => `the recut stopped: ${problem}`), sources: [] };
			throw error;
		}
		const report = recut.sources.map((source) => ({
			offer_code: source.offer_code,
			url: source.url,
			bytes: source.bytes,
			sha256: source.sha256,
			records: Object.values(source.terms.OnDemand).length,
		}));
		if (serializePriceFile(recut) === text) return { problems: [], sources: report };
		const found = differences(stored, recut);
		return { problems: found.length > 0 ? found : ["the recut has the same records and differs only in how the file is written"], sources: report };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({ options: { work: { type: "string" }, sources: { type: "string" } }, allowPositionals: true });
	const [path] = positionals;
	if (!path || positionals.length !== 1 || !values.work) {
		console.error("usage: bun scripts/check-prices.ts --work DIR [--sources DIR] FILE");
		process.exit(2);
	}
	const result = await checkPrices({ path, work: values.work, sources: values.sources, fetcher: (url, init) => fetch(url, init) });
	for (const source of result.sources) {
		console.log(`${source.offer_code}: ${source.url}\n  ${source.bytes} bytes, ${source.sha256}, ${source.records} products' On-Demand terms`);
	}
	const shown = relative(process.cwd(), path) || path;
	if (result.problems.length > 0) {
		console.error(`${shown}: ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}`);
		for (const problem of result.problems) console.error(`  ${problem}`);
		process.exit(1);
	}
	console.log(`${shown}: ok, every source hashes as recorded and the recut is the file, byte for byte`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
