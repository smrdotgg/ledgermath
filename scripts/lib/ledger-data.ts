/**
 * How scripts/assemble-location.ts reads the data API's tree (ADR-0030) from
 * a directory: v1/ (v1/index.json, the list of Series, one file per Series and
 * per month of a Series, the price files and the schemas). Nothing else is
 * read.
 *
 * Every file is reached by following the links the tree writes, from
 * v1/index.json down, as its rule says (a reader never builds an address from
 * an id). The links are absolute, under the address the tree was built for,
 * which v1/index.json gives as its own url; a link is read from the directory
 * at its path under that address.
 *
 * The contract the tree gives a reader is kept:
 * - A month file's bytes must have the sha256 (and size) its Series file
 *   lists. When they do not, or the month file is missing, neither is used,
 *   and the error says the directory holds files of two builds.
 * - Every file has a size limit (LIMITS, the tree's own ceilings, CEILINGS in
 *   scripts/lib/api-check.ts).
 * - v1/index.json's layout is read, never refused: by the tree's own words a
 *   new layout changes how the files are written, not what a JSON reader
 *   reads (only a v2 would).
 *
 * Nothing outside the directory is read: a path is plain segments of safe
 * characters (isInsidePath), and the file a path resolves to, through any
 * symbolic link, must be inside the directory. A file that is not there reads
 * as null.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import type { Pool, PoolSummary, Point as RequestsPoint, Recorded } from "../../methods/requests/v1/output";
import type { Point as SeriesPoint } from "../../methods/v1/output";
import type { Facts } from "../../methods/v1/facts";
import type { ParamValue } from "../../methods/run";
import { checkPriceFile } from "./price-file-check";
import { PRICE_FILE_PATH, type PriceFile } from "./prices";

/** The most bytes each kind of file may hold: the tree's own ceilings (CEILINGS in scripts/lib/api-check.ts, which a test holds these to). */
export const LIMITS = {
	index: 120_000,
	list: 1_050_000,
	series: 1_470_000,
	month: 5_000_000,
	prices: 1_000_000,
	schema: 256_000,
} as const;

/** An error whose message is for the reader, as it is: no stack trace. */
export class LedgerError extends Error {
	override name = "LedgerError";
}

export interface DataLocation {
	/** The directory, as given. */
	base: string;
	/**
	 * A file's bytes by its path in the directory, or null when it is not there.
	 * Throws a LedgerError when the path, or what it resolves to, leads outside
	 * the directory, or when it is larger than `limit` bytes (`what` names the
	 * kind of file).
	 */
	read(path: string, limit: number, what: string): Promise<Uint8Array | null>;
}

/**
 * A path inside a location: relative, forward slashes, and every part made of
 * letters, digits and . _ ~ - only, never "." or "..": nothing a resolver could
 * read as a way out (no %, \, ?, # or encoded dot). Every path the tree writes
 * is of this kind.
 */
function isInsidePath(path: string): boolean {
	return path.length > 0 && path.split("/").every((part) => /^[A-Za-z0-9._~-]+$/.test(part) && part !== "." && part !== "..");
}

function outside(path: string, base: string): LedgerError {
	return new LedgerError(`${path} is not a plain path inside ${base}, so it was not read: LedgerMath's data never lead outside the location they are read from.`);
}

function tooLarge(where: string, limit: number, what: string): LedgerError {
	return new LedgerError(`${where} is larger than ${limit} bytes, the most ${what} of LedgerMath's data may be, so it was not read. This is not a file the data API writes.`);
}

/** The directory `base`, to read the tree from. */
export function openLocation(base: string): DataLocation {
	const root = resolve(base);
	return {
		base,
		async read(path, limit, what) {
			if (!isInsidePath(path)) throw outside(path, base);
			const full = join(root, ...path.split("/"));
			// What the path resolves to, through any symbolic link, must be inside the directory, itself resolved.
			let real: string;
			let realRoot: string;
			try {
				real = realpathSync(full);
				realRoot = realpathSync(root);
			} catch {
				return null;
			}
			if (!real.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) {
				throw new LedgerError(`${full} leads outside the directory ${base} (to ${real}), so it was not read: LedgerMath's data never lead outside the location they are read from.`);
			}
			const stat = statSync(real);
			if (!stat.isFile()) return null;
			if (stat.size > limit) throw tooLarge(full, limit, what);
			return new Uint8Array(readFileSync(real));
		},
	};
}

// ---------------------------------------------------------------- the tree's files, as they are read here

const INDEX_PATH = "v1/index.json";
const SCHEMAS = {
	index: "ledgermath.api.index/1",
	list: "ledgermath.api.series-list/1",
	series: "ledgermath.api.series/1",
	month: "ledgermath.api.series-month/1",
} as const;

export interface PriceEntry {
	/** yyyy-mm-dd */
	date: string;
	/** prices/<yyyy>/<mm>/<dd>/aws.json: the path a price is cited by. */
	path: string;
	url: string;
}

/** A round of boots' figures in all, as v1/index.json gives them. */
export interface TreeRoundFigures {
	started_at: string;
	boots: number;
	runs: number;
	failed_runs: number;
	runs_in_no_series: number;
	build_failures: number;
	not_run: number;
	instance_types: Array<string | null>;
}

/** One of the newest rounds of boots, as v1/index.json gives it: of each boot, only its summary's address is read here. */
export interface TreeRound extends TreeRoundFigures {
	by_boot: Array<{ boot_summary: string }>;
}

/** A boot summary in no round, as v1/index.json lists it. */
export interface TreeLeftOut {
	path: string;
	boot_summary: string | null;
	why: string;
}

export interface TreeIndex {
	schema: string;
	url: string;
	layout: number;
	newest_run_started_at: string | null;
	/** Absent from a tree built before 2026-11-24. */
	recent_rounds?: { about: string; rounds: TreeRound[]; left_out: { count: number; summaries: TreeLeftOut[] } };
	series: { url: string; count: number };
	prices: { newest: PriceEntry | null; files: PriceEntry[] };
	schemas: Array<{ name: string; describes: string; url: string }>;
}

/** A Derivation's percentiles without the Runs behind them. A percentile is null when it is infinite (the Method writes it so). */
export interface StatSummary {
	count: number;
	p5: number | null;
	p50: number | null;
	p95: number | null;
}

export interface SummaryPercentiles {
	time_per_repetition_ns: StatSummary | null;
	bytes_per_second: StatSummary | null;
}

export interface MethodName {
	name: string;
	version: number;
}

export interface SeriesIdentity {
	id: string;
	benchmark: string;
	params: Record<string, ParamValue>;
	build: string;
	instance_type: string | null;
	availability_zone_id: string | null;
}

/** A row of v1/series.json. */
export interface TreeRow extends SeriesIdentity {
	url: string;
	runs: number;
	oldest_run_started_at: string;
	newest_run_started_at: string;
	derivations: {
		series_v1?: { method: MethodName; counted_runs: number; failed_runs: number; groups: number; percentiles: SummaryPercentiles };
		requests_v1?: { method: MethodName; counted_runs: number; failed_runs: number; groups: number };
	};
}

export interface Unreadable {
	path: string;
	sha256: string;
	reason: string;
	evidence: string;
}

/** v1/series.json */
export interface TreeList {
	schema: string;
	url: string;
	count: number;
	newest_run_started_at: string | null;
	methods: {
		series_v1?: { method: MethodName; runs_read: number; unreadable: Unreadable[] };
		requests_v1?: { method: MethodName; runs_read: number; unreadable: Unreadable[] };
	};
	series: TreeRow[];
}

/** What a point gains in the tree: its Run file's sha256 and the addresses of its evidence. */
interface Linked {
	sha256: string;
	evidence: string;
	boot_summary: string | null;
}

export type TreeSeriesPoint = SeriesPoint & Linked;
/** A point of requests v1: its group's figures as they stood through its own Run, group_through_as_of_run, in place of the Derivation's group_through. */
export type TreeRequestsPoint = Omit<RequestsPoint, "group_through"> & { group_through_as_of_run: PoolSummary | null } & Linked;

export interface MonthEntry {
	/** yyyy-mm */
	month: string;
	url: string;
	runs: number;
	oldest_run_started_at: string;
	newest_run_started_at: string;
	sha256: string;
	bytes: number;
}

export interface TreeSeriesV1 {
	method: MethodName;
	split_on: Array<{ fact: string; what: string }>;
	counted_runs: number;
	failed_runs: number;
	percentiles: SummaryPercentiles;
	groups: Array<{ id: string; facts: Facts; percentiles: SummaryPercentiles }>;
	newest_points: TreeSeriesPoint[];
}

export interface TreeRequestsV1 {
	method: MethodName;
	phases: Array<{ phase: string; name: string }>;
	histogram: { bins_per_doubling: number; precision: number };
	request_facts: Array<{ fact: string; what: string }>;
	counted_runs: number;
	failed_runs: number;
	recorded: Recorded;
	pool: Pool;
	groups: Array<{ id: string; facts: Facts; pool: Pool }>;
	newest_points: TreeRequestsPoint[];
}

/** v1/series/<id>.json */
export interface TreeSeries extends SeriesIdentity {
	schema: string;
	url: string;
	runs: number;
	oldest_run_started_at: string;
	newest_run_started_at: string;
	newest_runs: number;
	months: MonthEntry[];
	derivations: { series_v1?: TreeSeriesV1; requests_v1?: TreeRequestsV1 };
}

/** v1/series/<id>/<yyyy-mm>.json */
export interface TreeMonth {
	schema: string;
	id: string;
	month: string;
	url: string;
	derivations: { series_v1?: { points: TreeSeriesPoint[] }; requests_v1?: { points: TreeRequestsPoint[] } };
}

export interface LoadedPrices {
	path: string;
	/** yyyy-mm-dd, from the path. */
	date: string;
	file: PriceFile;
}

export interface LedgerData {
	index: TreeIndex;
	/** The address the tree was built for, from v1/index.json's own url, without a final slash. */
	treeBase: string;
	/** Every price file the table of contents lists, by path, oldest first. */
	priceFiles: string[];
	/** v1/series.json, read once. */
	list(): Promise<TreeList>;
	/**
	 * A Series' file and the month files `want` picks from it, each checked
	 * against the sha256 and size the Series file lists (the tree's contract):
	 * when one does not match, or is missing, neither is used and a LedgerError
	 * says so. Null when the list has no such Series.
	 */
	seriesWithMonths(id: string, want: (series: TreeSeries) => readonly MonthEntry[]): Promise<{ series: TreeSeries; months: TreeMonth[] } | null>;
	/** A price file by the path a price is cited by, through the table of contents; null when it lists none. */
	readPrices(path: string): Promise<LoadedPrices | null>;
	/** The path in the directory of a link the tree writes, or null when it is not a plain path under the tree's own address. */
	pathOf(url: string): string | null;
	/**
	 * A file the tree links (a schema, a point's evidence), followed as every
	 * link is: its path in the directory, and its bytes or null when it is not
	 * there. Throws a LedgerError when the link leads outside the tree.
	 */
	readLinked(url: string, limit: number, what: string): Promise<{ path: string; bytes: Uint8Array | null }>;
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parse(bytes: Uint8Array, where: string, schema: string, what: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(decode(bytes));
	} catch {
		throw new LedgerError(`${where} is not JSON, so it is not ${what} of LedgerMath's data API.`);
	}
	if (!isObject(value) || value.schema !== schema) {
		throw new LedgerError(`${where} is not ${what} of LedgerMath's data API version 1 (its schema is not ${schema}).`);
	}
	return value;
}

/**
 * Reads the table of contents and checks it is one this reader can read: v1,
 * with its own address. Its layout is read, never refused (a new layout
 * changes how files are written, not what they mean). Everything else is read
 * when asked for.
 */
export async function loadLedger(location: DataLocation): Promise<LedgerData> {
	const bytes = await location.read(INDEX_PATH, LIMITS.index, "the table of contents");
	if (bytes === null) {
		throw new LedgerError(`No LedgerMath data at ${location.base}: there is no ${INDEX_PATH} there. The directory must hold the data API's tree, v1/.`);
	}
	const index = parse(bytes, INDEX_PATH, SCHEMAS.index, "the table of contents") as unknown as TreeIndex;
	const own = `/${INDEX_PATH}`;
	if (typeof index.url !== "string" || !index.url.endsWith(own)) throw new LedgerError(`${INDEX_PATH} does not give its own address as …${own}, so its links cannot be followed.`);
	const treeBase = index.url.slice(0, -own.length);

	const pathOf = (url: string): string | null => {
		if (typeof url !== "string" || !url.startsWith(`${treeBase}/`)) return null;
		const path = url.slice(treeBase.length + 1);
		return isInsidePath(path) ? path : null;
	};
	const readLink = async (url: string, limit: number, what: string): Promise<{ path: string; bytes: Uint8Array | null }> => {
		const path = pathOf(url);
		if (path === null) {
			throw new LedgerError(`${url}, a link in LedgerMath's data, is not a plain path under the address the tree was built for, ${treeBase}, so it was not followed: LedgerMath's data never lead outside the location they are read from.`);
		}
		return { path, bytes: await location.read(path, limit, what) };
	};

	let listRead: Promise<TreeList> | undefined;
	const list = (): Promise<TreeList> => {
		listRead ??= (async () => {
			const { path, bytes } = await readLink(index.series.url, LIMITS.list, "the list of Series");
			if (bytes === null) throw new LedgerError(`${path}, the list of Series the table of contents links, is not there.`);
			const value = parse(bytes, path, SCHEMAS.list, "the list of Series") as unknown as TreeList;
			if (!Array.isArray(value.series)) throw new LedgerError(`${path} holds no list of Series.`);
			return value;
		})();
		return listRead;
	};

	const readSeries = async (id: string): Promise<TreeSeries | null> => {
		const row = (await list()).series.find((r) => r.id === id);
		if (row === undefined) return null;
		const { path, bytes } = await readLink(row.url, LIMITS.series, "a Series file");
		if (bytes === null) throw new LedgerError(`${path}, Series ${id}'s file, is not there although the list of Series links it.`);
		const value = parse(bytes, path, SCHEMAS.series, "a Series file") as unknown as TreeSeries;
		if (value.id !== id || !Array.isArray(value.months)) throw new LedgerError(`${path} is not Series ${id}'s file.`);
		return value;
	};

	const twoBuilds = (problem: string): LedgerError => new LedgerError(`The directory ${location.base} holds files of two different builds of LedgerMath's data: ${problem}. Neither file was used.`);

	const seriesWithMonths: LedgerData["seriesWithMonths"] = async (id, want) => {
		const series = await readSeries(id);
		if (series === null) return null;
		const months: TreeMonth[] = [];
		for (const entry of want(series)) {
			const { path, bytes } = await readLink(entry.url, LIMITS.month, "a month file");
			if (bytes === null) throw twoBuilds(`${path} is not there, although Series ${series.id}'s file lists it`);
			if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw twoBuilds(`${path} does not have the sha256 and size Series ${series.id}'s file lists for it`);
			const value = parse(bytes, path, SCHEMAS.month, "a month file") as unknown as TreeMonth;
			if (value.id !== series.id || value.month !== entry.month) throw new LedgerError(`${path} is not the month ${entry.month} of Series ${series.id}.`);
			months.push(value);
		}
		return { series, months };
	};

	const readPrices = async (path: string): Promise<LoadedPrices | null> => {
		if (!PRICE_FILE_PATH.test(path)) return null;
		const entry = index.prices.files.find((e) => e.path === path);
		if (entry === undefined) return null;
		const { path: at, bytes } = await readLink(entry.url, LIMITS.prices, "a price file");
		if (bytes === null) throw new LedgerError(`${at}, the price file of ${entry.date} the table of contents lists, is not there.`);
		let value: unknown;
		try {
			value = JSON.parse(decode(bytes));
		} catch {
			throw new LedgerError(`${at} is not JSON, so it is not a price file.`);
		}
		const problems = checkPriceFile(value, path);
		if (problems.length > 0) throw new LedgerError(`${at} is not a valid price file: ${problems.join("; ")}`);
		return { path, date: entry.date, file: value as PriceFile };
	};

	return {
		index,
		treeBase,
		priceFiles: index.prices.files.map((entry) => entry.path),
		list,
		seriesWithMonths,
		readPrices,
		pathOf,
		readLinked: readLink,
	};
}

/** Every point of series v1 the month files hold, in order of start (the tree's order). */
export function seriesPoints(months: readonly TreeMonth[]): TreeSeriesPoint[] {
	return [...months].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0)).flatMap((month) => month.derivations.series_v1?.points ?? []);
}
