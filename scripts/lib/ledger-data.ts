/**
 * Where the lookup tool and the answer checker read LedgerMath's data from:
 * the data API's tree (ADR-0030), and the evidence its citations point to.
 *
 * A location is a base web address, https://api.ledgermath.com by default,
 * or a directory laid out the same way: v1/ (the tree: v1/index.json, the list
 * of Series, one file per Series and per month of a Series, the price files)
 * and, beside it, runs/ and boots/ (the Run files and boot summaries the
 * tree's points link). Nothing else is read.
 *
 * Every file is reached by following the links the tree writes, from
 * v1/index.json down, as its rule says (a reader never builds an address from
 * an id). The links are absolute, under the address the tree was built for,
 * which v1/index.json gives as its own url; a link is read from the location
 * at its path under that address, so a directory, or a copy served from
 * another address, reads the same.
 *
 * The contract the tree gives a reader is kept:
 * - v1/index.json's layout must be one this tool knows (KNOWN_LAYOUTS);
 *   another is refused, plainly, and nothing more is read.
 * - A month file's bytes must have the sha256 (and size) its Series file
 *   lists. On a mismatch, or a month file missing, the Series file is read
 *   again, then the month file, up to ATTEMPTS times in all, with a pause
 *   between; while they still differ neither is used, and the error says to
 *   try again in a few minutes (a web address) or that the directory holds two
 *   builds (a directory).
 * - Every request has a time limit (REQUEST_TIMEOUT_MS) and every file a size
 *   limit (LIMITS, the tree's own ceilings, CEILINGS in
 *   scripts/lib/api-check.ts); nothing is retried but the step above.
 *
 * A file that is not there reads as null: 404, or 403, which is what S3
 * behind the API answers for a key it does not hold.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Pool, PoolSummary, Point as RequestsPoint, Recorded } from "../../methods/requests/v1/output";
import type { Point as SeriesPoint } from "../../methods/v1/output";
import type { Facts } from "../../methods/v1/facts";
import type { ParamValue } from "../../methods/run";
import { checkPriceFile } from "./price-file-check";
import { PRICE_FILE_PATH, type PriceFile } from "./prices";

/** Where the data are read from when no location is given. */
export const DEFAULT_LOCATION = "https://api.ledgermath.com";

/** The layouts of v1/index.json this tool reads (LAYOUT in scripts/lib/api.ts, as of this tool). */
export const KNOWN_LAYOUTS: readonly number[] = [1];

/** How long one request may take, start to last byte. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** How many times a Series file and its month files are read before a mismatch is given up on. */
export const ATTEMPTS = 3;

/** The pause between two such attempts, at a web address. */
export const RETRY_PAUSE_MS = 2_000;

/**
 * The most bytes each kind of file may hold: the tree's own ceilings
 * (CEILINGS in scripts/lib/api-check.ts, which a test holds these to), and
 * for a Run file, which the tree links and never copies, a limit of its own.
 */
export const LIMITS = {
	index: 100_000,
	list: 1_000_000,
	series: 1_000_000,
	month: 5_000_000,
	prices: 1_000_000,
	run: 1_000_000,
} as const;

/** An error whose message is for the agent, as it is: no stack trace. */
export class LedgerError extends Error {
	override name = "LedgerError";
}

/** The location the tools read when given none: --data, then LEDGERMATH_DATA, then DEFAULT_LOCATION. */
export function locationFrom(flag: string | undefined, environment: string | undefined): { base: string; isDefault: boolean } {
	if (flag !== undefined && flag !== "") return { base: flag, isDefault: false };
	if (environment !== undefined && environment !== "") return { base: environment, isDefault: false };
	return { base: DEFAULT_LOCATION, isDefault: true };
}

export type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface LocationOptions {
	fetch?: Fetch;
	timeoutMs?: number;
	pauseMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export interface DataLocation {
	/** As given: a directory or a base web address. */
	base: string;
	isUrl: boolean;
	/**
	 * A file's bytes by its path in the location, or null when it is not there.
	 * Throws a LedgerError when it is larger than `limit` bytes (`what` names
	 * the kind of file), when a request takes longer than the time limit, or
	 * when it cannot be read.
	 */
	read(path: string, limit: number, what: string): Promise<Uint8Array | null>;
	/** How a file is shown: its path in a directory, its address under a web address. */
	link(path: string): string;
	/** The pause between two attempts at a Series file and its months. */
	pauseMs: number;
	sleep(ms: number): Promise<void>;
}

/** A path inside a location: relative, forward slashes, no "." or ".." parts. */
export function isInsidePath(path: string): boolean {
	return path.length > 0 && !path.startsWith("/") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const realSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function tooLarge(where: string, limit: number, what: string): LedgerError {
	return new LedgerError(`${where} is larger than ${limit} bytes, the most ${what} of LedgerMath's data may be, so it was not read. This is not a file the data API writes.`);
}

function directoryLocation(base: string, options: LocationOptions): DataLocation {
	const root = resolve(base);
	return {
		base,
		isUrl: false,
		async read(path, limit, what) {
			if (!isInsidePath(path)) return null;
			const full = join(root, ...path.split("/"));
			let size: number;
			try {
				const stat = statSync(full);
				if (!stat.isFile()) return null;
				size = stat.size;
			} catch {
				return null;
			}
			if (size > limit) throw tooLarge(full, limit, what);
			return new Uint8Array(readFileSync(full));
		},
		link: (path) => path,
		pauseMs: options.pauseMs ?? 0,
		sleep: options.sleep ?? realSleep,
	};
}

/** The body, read until it passes `limit` bytes, when reading stops. */
async function readLimited(response: Response, limit: number, onTooLarge: () => Error): Promise<Uint8Array> {
	if (response.body === null) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length > limit) throw onTooLarge();
		return bytes;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			throw onTooLarge();
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return bytes;
}

function urlLocation(base: string, options: LocationOptions): DataLocation {
	const prefix = base.endsWith("/") ? base : `${base}/`;
	const fetchFile: Fetch = options.fetch ?? ((url, init) => fetch(url, { signal: init.signal }));
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const seconds = timeoutMs >= 1000 ? `${timeoutMs / 1000} s` : `${timeoutMs} ms`;
	return {
		base,
		isUrl: true,
		async read(path, limit, what) {
			if (!isInsidePath(path)) return null;
			const url = `${prefix}${path}`;
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new LedgerError(`${url} did not answer within ${seconds}, so LedgerMath's data could not be read. Try again in a few minutes.`));
				}, timeoutMs);
			});
			try {
				const response = await Promise.race([fetchFile(url, { signal: controller.signal }), timeout]);
				if (response.status === 404 || response.status === 403) {
					await response.body?.cancel().catch(() => undefined);
					return null;
				}
				if (!response.ok) {
					await response.body?.cancel().catch(() => undefined);
					throw new LedgerError(`${url} answered HTTP ${response.status}, so LedgerMath's data could not be read. Try again in a few minutes.`);
				}
				const length = Number(response.headers.get("content-length") ?? Number.NaN);
				if (Number.isFinite(length) && length > limit) {
					controller.abort();
					throw tooLarge(url, limit, what);
				}
				return await Promise.race([readLimited(response, limit, () => tooLarge(url, limit, what)), timeout]);
			} catch (error) {
				if (error instanceof LedgerError) throw error;
				const why = error instanceof Error ? error.message : String(error);
				throw new LedgerError(`${url} could not be read (${why}), so LedgerMath's data could not be read. Try again in a few minutes.`);
			} finally {
				clearTimeout(timer);
				controller.abort();
			}
		},
		link: (path) => `${prefix}${path}`,
		pauseMs: options.pauseMs ?? RETRY_PAUSE_MS,
		sleep: options.sleep ?? realSleep,
	};
}

export function openLocation(base: string, options: LocationOptions = {}): DataLocation {
	if (/^https?:\/\//.test(base)) return urlLocation(base, options);
	return directoryLocation(base, options);
}

// ---------------------------------------------------------------- the tree's files, as this tool reads them

export const INDEX_PATH = "v1/index.json";
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

export interface TreeIndex {
	schema: string;
	url: string;
	layout: number;
	newest_run_started_at: string | null;
	series: { url: string; count: number };
	prices: { newest: PriceEntry | null; files: PriceEntry[] };
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
	location: DataLocation;
	index: TreeIndex;
	/** The address the tree was built for, from v1/index.json's own url, without a final slash. */
	treeBase: string;
	/** Every price file the table of contents lists, by path, oldest first. */
	priceFiles: string[];
	/** The price file in use, by path: the newest, or the one asked for; null when there is none. */
	pricesPath: string | null;
	/** v1/series.json, read once. */
	list(): Promise<TreeList>;
	/** A Series' file, by its id, through its row's url; null when the list has no such Series. */
	series(id: string): Promise<TreeSeries | null>;
	/**
	 * A Series' file and the month files `want` picks from it, each checked
	 * against the sha256 and size the Series file lists (the tree's contract):
	 * on a mismatch, the Series file and then the month files are read again,
	 * ATTEMPTS times in all; while they differ, neither is used and a
	 * LedgerError says so. Null when the list has no such Series.
	 */
	seriesWithMonths(id: string, want: (series: TreeSeries) => readonly MonthEntry[]): Promise<{ series: TreeSeries; months: TreeMonth[] } | null>;
	/** A price file by the path a price is cited by, through the table of contents; null when it lists none. */
	readPrices(path: string): Promise<LoadedPrices | null>;
	/** The price file in use, or null. */
	prices(): Promise<LoadedPrices | null>;
	/** The path in the location of a link the tree writes, or null when it is not under the tree's own address. */
	pathOf(url: string): string | null;
	/** A Run file's bytes, by its path (runs/<yyyy>/<mm>/<dd>/<id>.json), or null. */
	runFile(path: string): Promise<Uint8Array | null>;
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
 * Reads the table of contents and checks it is one this tool can read: v1,
 * of a known layout, with its own address. Everything else is read when a
 * command needs it. `pricesDate` (yyyy-mm-dd) picks a price file other than
 * the newest. `isDefault` says the location was not given, so an error says
 * how to give one.
 */
export async function loadLedger(location: DataLocation, options: { pricesDate?: string; isDefault?: boolean } = {}): Promise<LedgerData> {
	const hint = options.isDefault ? ` No location was given, so ${DEFAULT_LOCATION} was read; if you were given LedgerMath's data in a directory or at another address, pass it with --data.` : "";
	let bytes: Uint8Array | null;
	try {
		bytes = await location.read(INDEX_PATH, LIMITS.index, "the table of contents");
	} catch (error) {
		if (error instanceof LedgerError) throw new LedgerError(`${error.message}${hint}`);
		throw error;
	}
	if (bytes === null) {
		throw new LedgerError(
			`No LedgerMath data at ${location.base}: there is no ${INDEX_PATH} there. A location is a web address or a directory holding the data API's tree, v1/, with runs/ and boots/ beside it.${hint}`,
		);
	}
	const raw = parse(bytes, location.link(INDEX_PATH), SCHEMAS.index, "the table of contents");
	if (typeof raw.layout !== "number" || !KNOWN_LAYOUTS.includes(raw.layout)) {
		throw new LedgerError(
			`The data at ${location.base} are written in layout ${JSON.stringify(raw.layout)}, which this tool does not know: it reads layout ${KNOWN_LAYOUTS.join(" or ")}. Nothing more was read. Update the LedgerMath checkout the tool runs from (git pull) and try again.`,
		);
	}
	const index = raw as unknown as TreeIndex;
	const own = `/${INDEX_PATH}`;
	if (typeof index.url !== "string" || !index.url.endsWith(own)) throw new LedgerError(`${location.link(INDEX_PATH)} does not give its own address as …${own}, so its links cannot be followed.`);
	const treeBase = index.url.slice(0, -own.length);

	const pathOf = (url: string): string | null => {
		if (typeof url !== "string" || !url.startsWith(`${treeBase}/`)) return null;
		const path = url.slice(treeBase.length + 1);
		return isInsidePath(path) ? path : null;
	};
	const readLink = async (url: string, limit: number, what: string): Promise<{ path: string; bytes: Uint8Array | null }> => {
		const path = pathOf(url);
		if (path === null) throw new LedgerError(`${url}, a link in LedgerMath's data, is not under the address the tree was built for, ${treeBase}, so it cannot be followed.`);
		return { path, bytes: await location.read(path, limit, what) };
	};

	let listRead: Promise<TreeList> | undefined;
	const list = (): Promise<TreeList> => {
		listRead ??= (async () => {
			const { path, bytes } = await readLink(index.series.url, LIMITS.list, "the list of Series");
			if (bytes === null) throw new LedgerError(`${location.link(path)}, the list of Series the table of contents links, is not there.`);
			const value = parse(bytes, location.link(path), SCHEMAS.list, "the list of Series") as unknown as TreeList;
			if (!Array.isArray(value.series)) throw new LedgerError(`${location.link(path)} holds no list of Series.`);
			return value;
		})();
		return listRead;
	};

	const seriesFiles = new Map<string, TreeSeries>();
	const readSeries = async (id: string, fresh: boolean): Promise<TreeSeries | null> => {
		if (!fresh) {
			const known = seriesFiles.get(id);
			if (known !== undefined) return known;
		}
		const row = (await list()).series.find((r) => r.id === id);
		if (row === undefined) return null;
		const { path, bytes } = await readLink(row.url, LIMITS.series, "a Series file");
		if (bytes === null) throw new LedgerError(`${location.link(path)}, Series ${id}'s file, is not there although the list of Series links it.${tryAgain(location)}`);
		const value = parse(bytes, location.link(path), SCHEMAS.series, "a Series file") as unknown as TreeSeries;
		if (value.id !== id || !Array.isArray(value.months)) throw new LedgerError(`${location.link(path)} is not Series ${id}'s file.`);
		seriesFiles.set(id, value);
		return value;
	};

	/** Month files read, by address and sha256: one whose bytes matched is not read again. */
	const monthFiles = new Map<string, TreeMonth>();
	const readMonths = async (series: TreeSeries, entries: readonly MonthEntry[]): Promise<{ months: TreeMonth[] } | { problem: string }> => {
		const months: TreeMonth[] = [];
		for (const entry of entries) {
			const key = `${entry.url}#${entry.sha256}`;
			const known = monthFiles.get(key);
			if (known !== undefined) {
				months.push(known);
				continue;
			}
			const { path, bytes } = await readLink(entry.url, LIMITS.month, "a month file");
			const shown = location.link(path);
			if (bytes === null) return { problem: `${shown} is not there, although Series ${series.id}'s file lists it` };
			if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) return { problem: `${shown} does not have the sha256 Series ${series.id}'s file lists for it` };
			const value = parse(bytes, shown, SCHEMAS.month, "a month file") as unknown as TreeMonth;
			if (value.id !== series.id || value.month !== entry.month) throw new LedgerError(`${shown} is not the month ${entry.month} of Series ${series.id}.`);
			monthFiles.set(key, value);
			months.push(value);
		}
		return { months };
	};

	const seriesWithMonths: LedgerData["seriesWithMonths"] = async (id, want) => {
		for (let attempt = 1; ; attempt++) {
			const series = await readSeries(id, attempt > 1);
			if (series === null) return null;
			const read = await readMonths(series, want(series));
			if ("months" in read) return { series, months: read.months };
			if (attempt >= ATTEMPTS) {
				if (location.isUrl) {
					throw new LedgerError(
						`LedgerMath's data at ${location.base} are being updated, or a cache holds part of an older copy: ${read.problem} (read ${ATTEMPTS} times, with the Series file read again each time). Neither file was used, so no number of Series ${id} is given. Try again in a few minutes.`,
					);
				}
				throw new LedgerError(
					`The directory ${location.base} holds files of two different builds of LedgerMath's data: ${read.problem}. Neither file was used, so no number of Series ${id} is given. Put the directory together again from one build (README, "The agent skill").`,
				);
			}
			await location.sleep(location.pauseMs);
		}
	};

	const priceFiles = index.prices.files.map((entry) => entry.path);
	let pricesPath = index.prices.newest?.path ?? null;
	if (options.pricesDate !== undefined) {
		const [year, month, day] = options.pricesDate.split("-");
		const path = `prices/${year}/${month}/${day}/aws.json`;
		if (!priceFiles.includes(path)) {
			const held = priceFiles.length === 0 ? "none" : `${index.prices.files[0]?.date} to ${index.prices.files.at(-1)?.date}`;
			throw new LedgerError(`no price file for ${options.pricesDate} at ${location.base} (${path}): the table of contents lists ${priceFiles.length} price files, ${held}.`);
		}
		pricesPath = path;
	}
	const priceCache = new Map<string, LoadedPrices | null>();
	const readPrices = async (path: string): Promise<LoadedPrices | null> => {
		if (!PRICE_FILE_PATH.test(path)) return null;
		if (priceCache.has(path)) return priceCache.get(path) ?? null;
		const entry = index.prices.files.find((e) => e.path === path);
		let loaded: LoadedPrices | null = null;
		if (entry !== undefined) {
			const { path: at, bytes } = await readLink(entry.url, LIMITS.prices, "a price file");
			if (bytes === null) throw new LedgerError(`${location.link(at)}, the price file of ${entry.date} the table of contents lists, is not there.${tryAgain(location)}`);
			let value: unknown;
			try {
				value = JSON.parse(decode(bytes));
			} catch {
				throw new LedgerError(`${location.link(at)} is not JSON, so it is not a price file.`);
			}
			const problems = checkPriceFile(value, path);
			if (problems.length > 0) throw new LedgerError(`${location.link(at)} is not a valid price file: ${problems.join("; ")}`);
			loaded = { path, date: entry.date, file: value as PriceFile };
		}
		priceCache.set(path, loaded);
		return loaded;
	};

	return {
		location,
		index,
		treeBase,
		priceFiles,
		pricesPath,
		list,
		series: (id) => readSeries(id, false),
		seriesWithMonths,
		readPrices,
		prices: async () => (pricesPath === null ? null : readPrices(pricesPath)),
		pathOf,
		runFile: (path) => location.read(path, LIMITS.run, "a Run file"),
	};
}

function tryAgain(location: DataLocation): string {
	return location.isUrl ? " Try again in a few minutes." : "";
}

/** The month (yyyy-mm) a Run file's path names by its date, or null. */
export function pathMonth(path: string): string | null {
	const match = /^runs\/([0-9]{4})\/([0-9]{2})\//.exec(path);
	return match === null ? null : `${match[1]}-${match[2]}`;
}

/** Every point of series v1 the month files hold, in order of start (the tree's order). */
export function seriesPoints(months: readonly TreeMonth[]): TreeSeriesPoint[] {
	return [...months].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0)).flatMap((month) => month.derivations.series_v1?.points ?? []);
}

/** Every point of requests v1 the month files hold, in order of start. */
export function requestPoints(months: readonly TreeMonth[]): TreeRequestsPoint[] {
	return [...months].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0)).flatMap((month) => month.derivations.requests_v1?.points ?? []);
}

/**
 * The point of a Run, by its path, among the Series given: in each Series
 * file's newest points first, then in the month its path names, then in its
 * other months, newest first. Null when it is a Run of none of them.
 */
export async function findRun(data: LedgerData, ids: readonly string[], path: string): Promise<{ series: string; point: TreeSeriesPoint } | null> {
	for (const id of ids) {
		const series = await data.series(id);
		const newest = series?.derivations.series_v1?.newest_points.find((point) => point.path === path);
		if (newest !== undefined) return { series: id, point: newest };
	}
	const named = pathMonth(path);
	for (const pass of ["named", "others"] as const) {
		for (const id of ids) {
			const loaded = await data.seriesWithMonths(id, (series) =>
				series.months.filter((entry) => (pass === "named" ? entry.month === named : entry.month !== named)).sort((a, b) => (a.month < b.month ? 1 : -1)),
			);
			const point = loaded === null ? undefined : seriesPoints(loaded.months).find((p) => p.path === path);
			if (point !== undefined) return { series: id, point };
		}
	}
	return null;
}

export const datePart = (path: string): string => {
	const match = PRICE_FILE_PATH.exec(path);
	return match === null ? "" : `${match[1]}-${match[2]}-${match[3]}`;
};
