/**
 * A tree of LedgerMath's data API, read from a directory laid out as the API serves it
 * (https://api.ledgermath.com/v1/...). The build reads one (scripts/build.ts); nothing reads
 * it in the browser. A tree comes from scripts/fetch-tree.ts (the files the site needs,
 * fetched from the API), from the directory the `runs` workflow builds, or, for the tests,
 * from fixtures/tree/.
 *
 * The site reads three files of a tree (`treeFiles`):
 *
 *   v1/index.json          the table of contents, with its recent_rounds when it has them
 *   the Series list        at the address the table of contents gives (series.url)
 *   the newest price file  at the address it gives for it (prices.newest.url)
 *
 * A file's place in the directory is its address without the tree's base, the table of
 * contents' own address (`url`) without "v1/index.json". So nothing here builds an address:
 * the site follows the links the table of contents gives, as any reader of the API must.
 *
 * The types describe the parts the site reads; the API's schemas describe the files in full.
 * Each parse function checks that every part the site reads is there with its type and fails,
 * naming the file and the field, when one is not. Members the site does not read are kept
 * and not checked: version 1 of the API only ever gains fields.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** What the table of contents of version 1 says it is (its `schema`). */
export const INDEX_SCHEMA = "ledgermath.api.index/1";
export const SERIES_LIST_SCHEMA = "ledgermath.api.series-list/1";
export const PRICES_SCHEMA = "ledgermath.prices/1";
/** The table of contents' place in a tree, and the end of its own address. */
export const INDEX_PATH = "v1/index.json";

// ---------------------------------------------------------------- the parts the site reads

/**
 * Percentiles of one number across a Series' counted Runs (Method `series` v1). The schema lets
 * any of the three be null: "infinite or undefined", taken from or interpolated towards a Run's
 * figure past a double's range (a counted Run that took no time has an infinite rate).
 */
export type Percentiles = { count: number; p5: number | null; p50: number | null; p95: number | null };

/** Method `series` v1's summary of one Series, as the Series list gives it. */
export type SeriesDerivation = {
	counted_runs: number;
	failed_runs: number;
	percentiles: {
		/** Nanoseconds of one repetition. What a repetition is depends on the benchmark. */
		time_per_repetition_ns: Percentiles | null;
		/** Bytes per second, where the benchmark observes bytes per repetition; null otherwise. */
		bytes_per_second: Percentiles | null;
	};
	[more: string]: unknown;
};

/** One row of the Series list: one Series. */
export type SeriesRow = {
	id: string;
	/** The address of this Series' own file in the API. */
	url: string;
	benchmark: string;
	params: Record<string, string | number | boolean>;
	build: string;
	/** The EC2 instance type; the schema lets it be null, and such a Series stands under no machine type. */
	instance_type: string | null;
	runs: number;
	derivations: { series_v1: SeriesDerivation; [more: string]: unknown };
	[more: string]: unknown;
};

export type SeriesList = {
	schema: string;
	/** The address of the table of contents it belongs with, and its own. */
	index: string;
	url: string;
	count: number;
	/** When the newest Run of any Series started; null when there is no Series. */
	newest_run_started_at: string | null;
	series: SeriesRow[];
	[more: string]: unknown;
};

/** One round of boots, as the table of contents' recent_rounds lists it. */
export type RecentRound = {
	/** When the round's first boot started (UTC, to the nanosecond). */
	started_at: string;
	/** How many boots the round had: one machine each. */
	boots: number;
	/** How many Runs the round's boots made, and how many of those failed. */
	runs: number;
	failed_runs: number;
	[more: string]: unknown;
};

export type ApiIndex = {
	schema: string;
	/** The table of contents' own address: the tree's base followed by "v1/index.json". */
	url: string;
	/** When the newest Run of any Series started; null when there is no Series. */
	newest_run_started_at: string | null;
	series: { url: string; count: number; [more: string]: unknown };
	prices: { newest: { date: string; url: string; [more: string]: unknown }; [more: string]: unknown };
	/** The latest rounds of boots, newest first. A tree from before the API gave them has none. */
	recent_rounds?: { rounds: RecentRound[]; [more: string]: unknown };
	[more: string]: unknown;
};

export type PriceTerm = {
	effectiveDate: string;
	priceDimensions: Record<string, { rateCode: string; description: string; unit: string; pricePerUnit: { USD: string } }>;
};

export type PriceSource = {
	offer_code: string;
	selections: { rule: string; skus: string[] }[];
	products: Record<string, { sku: string; attributes: Record<string, string> }>;
	terms: { OnDemand: Record<string, Record<string, PriceTerm>> };
};

export type PriceFile = {
	schema: string;
	fetched_at: string;
	measured: { region: string; instance_types: string[] };
	sources: PriceSource[];
	[more: string]: unknown;
};

/** A tree, read: where it is, its base address, and the three files the site reads. */
export type Tree = {
	/** The directory, as an absolute path. */
	dir: string;
	/** The API's base address, "https://api.ledgermath.com/": the table of contents' address without "v1/index.json". */
	base: string;
	index: ApiIndex;
	seriesList: SeriesList;
	prices: PriceFile;
	/** Each file's place in the directory. */
	paths: { index: string; seriesList: string; prices: string };
};

// ---------------------------------------------------------------- checking what a file holds

type Where = { file: string; path: string };

/**
 * A file of the tree that does not hold what the site reads: which file (its address, or its
 * path), and where in it (a field's path, or "" for the whole file), beside the message, which
 * may quote the value refused. A reader that must not print values says the file and the field.
 */
export class TreeError extends Error {
	constructor(
		readonly file: string,
		readonly path: string,
		message: string,
	) {
		super(message);
		this.name = "TreeError";
	}
}

function fail(where: Where, what: string): never {
	throw new TreeError(where.file, where.path, `${where.file}: ${where.path || "the file"} ${what}`);
}

const at = (where: Where, key: string | number): Where => ({
	file: where.file,
	path: typeof key === "number" ? `${where.path}[${key}]` : where.path ? `${where.path}.${key}` : key,
});

function object(value: unknown, where: Where): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(where, "is not an object");
	return value as Record<string, unknown>;
}

function array(value: unknown, where: Where): unknown[] {
	if (!Array.isArray(value)) fail(where, "is not an array");
	return value;
}

function string(value: unknown, where: Where): string {
	if (typeof value !== "string") fail(where, "is not a string");
	return value;
}

function count(value: unknown, where: Where): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(where, "is not a whole number from 0");
	return value;
}

/** A finite number, or null where the schema allows it ("infinite or undefined"). */
function finiteOrNull(value: unknown, where: Where): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value)) fail(where, "is not a finite number or null");
	return value;
}

function stringOrNull(value: unknown, where: Where): string | null {
	if (value !== null && typeof value !== "string") fail(where, "is not a string or null");
	return value;
}

const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function moment(value: unknown, where: Where): string {
	const text = string(value, where);
	if (!MOMENT.test(text)) fail(where, `is not a UTC moment: ${JSON.stringify(text)}`);
	return text;
}

/** A moment, or null where the schema allows it (no Series at all). */
function momentOrNull(value: unknown, where: Where): string | null {
	return value === null ? null : moment(value, where);
}

/** Compares two UTC moments as the API writes them, to the nanosecond: negative when a is earlier. */
export function compareMoments(a: string, b: string): number {
	const [aSecond = "", aFraction = ""] = a.replace(/Z$/, "").split(".");
	const [bSecond = "", bFraction = ""] = b.replace(/Z$/, "").split(".");
	if (aSecond !== bSecond) return aSecond < bSecond ? -1 : 1;
	const width = Math.max(aFraction.length, bFraction.length);
	const x = aFraction.padEnd(width, "0");
	const y = bFraction.padEnd(width, "0");
	return x === y ? 0 : x < y ? -1 : 1;
}

function schema(json: Record<string, unknown>, expected: string, where: Where): string {
	const found = json.schema;
	if (found !== expected) fail(at(where, "schema"), `is ${JSON.stringify(found)}, not ${JSON.stringify(expected)}`);
	return expected;
}

// ---------------------------------------------------------------- the three files

/** The tree's base address: the table of contents' own address without "v1/index.json". */
export function baseOf(indexUrl: string, file = INDEX_PATH): string {
	if (!/^https:\/\/[^/?#\s]+\//.test(indexUrl) || !indexUrl.endsWith(INDEX_PATH)) {
		fail({ file, path: "url" }, `is ${JSON.stringify(indexUrl)}, not an https:// address ending in ${INDEX_PATH}`);
	}
	return indexUrl.slice(0, -INDEX_PATH.length);
}

/**
 * The place in a tree of the file at URL: URL without the tree's BASE. Refuses an address that
 * is not under the base, or whose path is not a plain path to a JSON file under v1/.
 */
export function treePath(url: string, base: string, where: Where): string {
	if (!url.startsWith(base)) fail(where, `is ${JSON.stringify(url)}, which is not under the tree's base ${base}`);
	const path = url.slice(base.length);
	const parts = path.split("/");
	if (!/^v1\/[A-Za-z0-9._/-]+\.json$/.test(path) || parts.some((part) => part === "" || part === "." || part === "..")) {
		fail(where, `is ${JSON.stringify(url)}, whose path is not a plain path to a JSON file under v1/`);
	}
	return path;
}

/** Checks the table of contents; FILE names it in errors. */
export function parseIndex(json: unknown, file = INDEX_PATH): ApiIndex {
	const where: Where = { file, path: "" };
	const index = object(json, where);
	schema(index, INDEX_SCHEMA, where);
	const url = string(index.url, at(where, "url"));
	baseOf(url, file);
	momentOrNull(index.newest_run_started_at, at(where, "newest_run_started_at"));
	const series = object(index.series, at(where, "series"));
	string(series.url, at(at(where, "series"), "url"));
	count(series.count, at(at(where, "series"), "count"));
	const prices = object(index.prices, at(where, "prices"));
	// The schema lets newest be null only when the API holds no price file at all. The page's
	// columns are the newest price file's machine types, with their prices, so it cannot be built.
	if (prices.newest === null) fail(at(at(where, "prices"), "newest"), "is null: the API holds no price file, and the page's machine types and prices come from the newest one");
	const newest = object(prices.newest, at(at(where, "prices"), "newest"));
	const date = string(newest.date, at(at(at(where, "prices"), "newest"), "date"));
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(at(at(at(where, "prices"), "newest"), "date"), `is not a date: ${JSON.stringify(date)}`);
	string(newest.url, at(at(at(where, "prices"), "newest"), "url"));
	if (index.recent_rounds !== undefined) {
		const recent = at(where, "recent_rounds");
		const rounds = array(object(index.recent_rounds, recent).rounds, at(recent, "rounds"));
		rounds.forEach((value, i) => {
			const r = at(at(recent, "rounds"), i);
			const round = object(value, r);
			const startedAt = moment(round.started_at, at(r, "started_at"));
			count(round.boots, at(r, "boots"));
			const runs = count(round.runs, at(r, "runs"));
			const failed = count(round.failed_runs, at(r, "failed_runs"));
			if (failed > runs) fail(at(r, "failed_runs"), `is ${failed}, more than the round's ${runs} Runs`);
			const before = i > 0 ? (rounds[i - 1] as RecentRound).started_at : null;
			if (before !== null && compareMoments(startedAt, before) > 0) fail(at(r, "started_at"), `is later than the round before it: the rounds are not newest first`);
		});
	}
	return index as ApiIndex;
}

function percentiles(value: unknown, where: Where): Percentiles | null {
	if (value === null) return null;
	const p = object(value, where);
	count(p.count, at(where, "count"));
	for (const key of ["p5", "p50", "p95"]) finiteOrNull(p[key], at(where, key));
	return p as Percentiles;
}

/**
 * Checks the Series list; FILE names it in errors. It takes everything the list's schema
 * (series-list.schema.json) allows, nulls included, so that no one Series can stop the build:
 * what the page cannot show of a Series it leaves out, and says so (siteData).
 */
export function parseSeriesList(json: unknown, file: string): SeriesList {
	const where: Where = { file, path: "" };
	const list = object(json, where);
	schema(list, SERIES_LIST_SCHEMA, where);
	string(list.index, at(where, "index"));
	string(list.url, at(where, "url"));
	count(list.count, at(where, "count"));
	momentOrNull(list.newest_run_started_at, at(where, "newest_run_started_at"));
	const rows = array(list.series, at(where, "series"));
	rows.forEach((value, i) => {
		const r = at(at(where, "series"), i);
		const row = object(value, r);
		for (const key of ["id", "url", "benchmark", "build"]) string(row[key], at(r, key));
		stringOrNull(row.instance_type, at(r, "instance_type"));
		const params = object(row.params, at(r, "params"));
		for (const [key, param] of Object.entries(params)) {
			if (!["string", "number", "boolean"].includes(typeof param)) fail(at(at(r, "params"), key), "is not a string, a number or a boolean");
		}
		count(row.runs, at(r, "runs"));
		const d = at(at(r, "derivations"), "series_v1");
		const derivation = object(object(row.derivations, at(r, "derivations")).series_v1, d);
		count(derivation.counted_runs, at(d, "counted_runs"));
		count(derivation.failed_runs, at(d, "failed_runs"));
		const p = object(derivation.percentiles, at(d, "percentiles"));
		percentiles(p.time_per_repetition_ns, at(at(d, "percentiles"), "time_per_repetition_ns"));
		percentiles(p.bytes_per_second, at(at(d, "percentiles"), "bytes_per_second"));
	});
	if (list.count !== rows.length) fail(at(where, "count"), `is ${list.count}, but the file lists ${rows.length} Series`);
	return list as SeriesList;
}

/** Checks a price file, as far as the site reads it; FILE names it in errors. */
export function parsePrices(json: unknown, file: string): PriceFile {
	const where: Where = { file, path: "" };
	const prices = object(json, where);
	schema(prices, PRICES_SCHEMA, where);
	moment(prices.fetched_at, at(where, "fetched_at"));
	const measured = object(prices.measured, at(where, "measured"));
	string(measured.region, at(at(where, "measured"), "region"));
	array(measured.instance_types, at(at(where, "measured"), "instance_types")).forEach((type, i) => string(type, at(at(at(where, "measured"), "instance_types"), i)));
	array(prices.sources, at(where, "sources")).forEach((value, i) => {
		const s = at(at(where, "sources"), i);
		const source = object(value, s);
		string(source.offer_code, at(s, "offer_code"));
		array(source.selections, at(s, "selections")).forEach((selection, j) => {
			const w = at(at(s, "selections"), j);
			string(object(selection, w).rule, at(w, "rule"));
			array((selection as Record<string, unknown>).skus, at(w, "skus"));
		});
		object(source.products, at(s, "products"));
		object(object(source.terms, at(s, "terms")).OnDemand, at(at(s, "terms"), "OnDemand"));
	});
	return prices as PriceFile;
}

/**
 * The files the site reads after the table of contents, each with its address and its place in
 * the tree, as INDEX gives them: the Series list, then the newest price file. Used by readTree
 * and by scripts/fetch-tree.ts, so the two agree on what a tree for the site holds.
 */
export function treeFiles(index: ApiIndex, file = INDEX_PATH): { kind: "seriesList" | "prices"; url: string; path: string }[] {
	const base = baseOf(index.url, file);
	return [
		{ kind: "seriesList", url: index.series.url, path: treePath(index.series.url, base, { file, path: "series.url" }) },
		{ kind: "prices", url: index.prices.newest.url, path: treePath(index.prices.newest.url, base, { file, path: "prices.newest.url" }) },
	];
}

/**
 * Where the three files of a tree disagree about which publication of the API they are: empty
 * when they are of one. A tree is published whole every six hours, but a reader can still get
 * its files from two publications, when a fetch overlaps an upload or a cache holds one file
 * from before the other changed; then the page would show one publication's figures under the
 * other's date. What the files give that ties them together:
 *
 *  - the Series list names the table of contents' address (`index`), and its own address and
 *    count as the table of contents gives them (`series.url`, `series.count`);
 *  - both say when the newest Run of any Series started (`newest_run_started_at`);
 *  - the newest price file was fetched on the date the table of contents gives it
 *    (`prices.newest.date` is "the UTC date the prices were fetched", and the Runs repository's
 *    own price check holds every price file to it).
 */
export function publicationMismatches(index: ApiIndex, seriesList: SeriesList, prices: PriceFile): string[] {
	const found: string[] = [];
	const differ = (what: string, a: unknown, b: unknown) => {
		if (a !== b) found.push(`${what}: ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
	};
	differ("the table of contents' address, as itself and as the Series list gives it", index.url, seriesList.index);
	differ("the Series list's address, as the table of contents and the list itself give it", index.series.url, seriesList.url);
	differ("the count of Series, in the table of contents and in the Series list", index.series.count, seriesList.count);
	differ("the newest Run's start, in the table of contents and in the Series list", index.newest_run_started_at, seriesList.newest_run_started_at);
	differ("the newest price file's date, in the table of contents and as the file's fetch time gives it", index.prices.newest.date, prices.fetched_at.slice(0, 10));
	return found;
}

/** The files of a tree are of two publications of the API (publicationMismatches). */
export class TwoPublications extends Error {
	readonly mismatches: string[];
	/** LEAD says what was of two publications; the mismatches follow it. */
	constructor(lead: string, mismatches: string[]) {
		super(`${lead}: ${mismatches.join("; ")}`);
		this.name = "TwoPublications";
		this.mismatches = mismatches;
	}
}

function readJson(dir: string, path: string): unknown {
	const file = join(dir, path);
	if (!existsSync(file)) throw new Error(`${path} is missing from the tree at ${dir}`);
	const text = readFileSync(file, "utf8");
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} in the tree at ${dir} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Reads and checks the tree in DIR; throws, saying what is wrong, when it is not one the site can be built from. */
export function readTree(dir: string): Tree {
	const root = resolve(dir);
	if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${dir} is not a directory`);
	const index = parseIndex(readJson(root, INDEX_PATH));
	const [seriesFile, pricesFile] = treeFiles(index);
	const seriesList = parseSeriesList(readJson(root, seriesFile!.path), seriesFile!.path);
	const prices = parsePrices(readJson(root, pricesFile!.path), pricesFile!.path);
	const mismatches = publicationMismatches(index, seriesList, prices);
	if (mismatches.length > 0) {
		throw new TwoPublications(`the tree at ${dir} holds files of two publications of the API, and the site is never built from such a tree (fetch a new one)`, mismatches);
	}
	return { dir: root, base: baseOf(index.url), index, seriesList, prices, paths: { index: INDEX_PATH, seriesList: seriesFile!.path, prices: pricesFile!.path } };
}
