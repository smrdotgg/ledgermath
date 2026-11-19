/**
 * The data API, version 1: a tree of small static JSON files cut from the
 * Derivations of Method series v1 and Method requests v1 and from the price
 * files, laid out as it is served from the API's host (ADR-0030):
 *
 *     v1/index.json                    the table of contents
 *     v1/series.json                   one row per Series, and each Method's own words
 *     v1/series/<id>.json              one Series in full, every Method's Derivation of it
 *     v1/prices/<yyyy-mm-dd>.json      that day's price file, byte for byte
 *     v1/schemas/<name>.schema.json    the schema of each kind of file
 *
 * It is a re-cut, not a Method: every number is the Derivations' own, written
 * as they hold it, and nothing is computed but counts of points and the times
 * of a Series' oldest and newest Run. Every address a reader needs is written
 * in the files, under one base address; the evidence (Run files, boot
 * summaries, blobs) is linked at the bucket's own keys under the same base,
 * never copied.
 *
 * The same inputs give the same bytes, file for file, whatever order the
 * Series, price files or boot summaries come in, and no clock is read: a
 * Series file depends only on its own Runs, the Methods' fixed words and the
 * base address, so one whose Series gained no Run is the same bytes as before.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { DerivationsFile as RequestsFile, SeriesDerivation as RequestsDerivation, Point as RequestsPoint, Stats } from "../../methods/requests/v1/output";
import { canonicalJson, compareText } from "../../methods/run";
import type { DerivationsFile as SeriesFile, SeriesDerivation, Point as SeriesPoint, Stat } from "../../methods/v1/output";
import { PRICE_FILE_PATH } from "./prices";

const ROOT = resolve(import.meta.dir, "..", "..");

export const DEFAULT_BASE = "https://api.ledgermath.com";
/** Where the API is described in words, until the docs have pages of their own. */
export const DEFAULT_DOCS = "https://github.com/smrdotgg/ledgermath/blob/main/README.md#the-data-api";

/** Each kind of file's schema: its name in the tree, and where it is kept in this repository. */
export const API_SCHEMAS = [
	{ name: "index", describes: "v1/index.json", source: "schemas/api/v1/index.schema.json" },
	{ name: "series-list", describes: "v1/series.json", source: "schemas/api/v1/series-list.schema.json" },
	{ name: "series", describes: "v1/series/<id>.json", source: "schemas/api/v1/series.schema.json" },
	{ name: "prices", describes: "v1/prices/<yyyy-mm-dd>.json", source: "schemas/prices.schema.json" },
] as const;
export type SchemaName = (typeof API_SCHEMAS)[number]["name"];

export const SCHEMA_IDS = {
	index: "ledgermath.api.index/1",
	"series-list": "ledgermath.api.series-list/1",
	series: "ledgermath.api.series/1",
} as const;

export const schemaPath = (name: SchemaName): string => `v1/schemas/${name}.schema.json`;
export const seriesPath = (id: string): string => `v1/series/${id}.json`;
export const pricePath = (date: string): string => `v1/prices/${date}.json`;
export const INDEX_PATH = "v1/index.json";
export const LIST_PATH = "v1/series.json";

/** A Series id as Method series v1 makes it: the first 12 hex digits of the sha256 of its key. */
export const SERIES_ID = /^[0-9a-f]{12}$/;
/** A Run file's path in the Runs repository, which is also its key in the bucket. */
export const RUN_PATH = /^runs\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/[A-Za-z0-9._-]+\.json$/;
/** A boot summary's path in the Runs repository, which is also its key in the bucket. */
export const BOOT_PATH = /^boots\/([0-9]{4})\/([0-9]{2})\/([0-9]{2})\/([A-Za-z0-9._-]+)\.json$/;

export const VERSIONING =
	"Version 1 only ever gains fields. A field, once in a v1 file, keeps its name, its type and its meaning, and a reader ignores any field it does not know: " +
	"that is why no object in a v1 schema forbids members it does not list. A new Method, or a new version of one, is a new key beside the old ones. " +
	"A change that would break a reader is published as v2, beside v1.";
export const FIGURES =
	"Every number is exactly as the Methods' Derivations hold it: nothing is rounded, and nothing is computed that the Derivations do not hold, " +
	"apart from counts of a Series' Runs and the start times of its oldest and newest Run, taken from its points. A duration is in nanoseconds of the Run's clock " +
	"unless its field's name says otherwise; a moment is a UTC time, to the nanosecond, as the Run records it.";
export const ABOUT =
	"LedgerMath runs small benchmarks on real AWS machines several times a day and keeps every execution as a Run. A Series is the Runs of one benchmark, " +
	"parameter set, build, instance type and Availability Zone ID; a versioned Method turns its Runs into a Derivation. This is version 1 of the data API: " +
	"static JSON files cut from the Derivations and the daily price files, each kind with a JSON schema.";
export const EVIDENCE =
	"The evidence is served at the keys of LedgerMath's bucket of Runs, under the same address as the API: each point of a Series file links its Run file " +
	"(evidence) and its boot's summary (boot_summary). A Run file names its binary, streams and dumps by hash, sha256:<hex>; each is a blob at " +
	"blob_url_template with {hex} replaced by the 64 hex digits.";

export interface PriceSource {
	/** prices/<yyyy>/<mm>/<dd>/aws.json */
	path: string;
	bytes: Uint8Array;
}

export interface ApiSources {
	/** The address the tree is served from, without a final slash. */
	base: string;
	docs: string;
	series: SeriesFile;
	requests: RequestsFile;
	prices: readonly PriceSource[];
	/** Each boot summary in the Runs repository, by boot id: its path. */
	boots: ReadonlyMap<string, string>;
	/** Each schema's bytes, by name. */
	schemas: ReadonlyMap<SchemaName, Uint8Array>;
}

/** A base address as given, checked and without a final slash. */
export function normalizeBase(base: string): string {
	const trimmed = base.replace(/\/+$/, "");
	if (!/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[A-Za-z0-9._~-]+)*$/.test(trimmed)) {
		throw new Error(`${base} is not a base address: http(s)://host[:port][/path], with no query or fragment`);
	}
	return trimmed;
}

/** yyyy-mm-dd from prices/<yyyy>/<mm>/<dd>/aws.json */
export function priceDate(path: string): string {
	const match = PRICE_FILE_PATH.exec(path);
	if (match === null) throw new Error(`${path} is not a price file's path, prices/<yyyy>/<mm>/<dd>/aws.json`);
	return `${match[1]}-${match[2]}-${match[3]}`;
}

/** Every price file in a Runs repository checkout, in date order. */
export function readPriceFiles(runs: string): PriceSource[] {
	const directory = join(runs, "prices");
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(runs, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.filter((path) => PRICE_FILE_PATH.test(path))
		.sort(compareText)
		.map((path) => ({ path, bytes: new Uint8Array(readFileSync(join(runs, path))) }));
}

/** Every boot summary in a Runs repository checkout, by boot id (its file name). Two files of one boot id stop it. */
export function readBootSummaries(runs: string): Map<string, string> {
	const directory = join(runs, "boots");
	const boots = new Map<string, string>();
	if (!existsSync(directory)) return boots;
	const paths = readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(runs, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort(compareText);
	for (const path of paths) {
		const match = BOOT_PATH.exec(path);
		if (match === null) continue;
		const id = match[4] as string;
		const other = boots.get(id);
		if (other !== undefined) throw new Error(`two boot summaries for boot ${id}: ${other} and ${path}`);
		boots.set(id, path);
	}
	return boots;
}

/** The schemas, as this repository keeps them. */
export function readApiSchemas(): Map<SchemaName, Uint8Array> {
	return new Map(API_SCHEMAS.map(({ name, source }) => [name, new Uint8Array(readFileSync(join(ROOT, source)))] as const));
}

/** Reads a file of Derivations and checks it is the named Method's. */
export function readDerivations<T extends SeriesFile | RequestsFile>(path: string, name: T["method"]["name"]): T {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const file = value as Partial<T> | null;
	if (file === null || typeof file !== "object" || file.schema !== "ledgermath.derivations/1") throw new Error(`${path} is not a ledgermath.derivations/1 file`);
	if (file.method?.name !== name || file.method.version !== 1 || !Array.isArray(file.derivations)) {
		throw new Error(`${path} is not the output of Method ${name} version 1, the only version of it the API is cut from`);
	}
	return file as T;
}

// The shapes the tree's files take. schemas/api/v1/ says the same in JSON
// Schema, field by field, for readers.

/** A Series' percentiles in its row: the Derivation's, without the list of Runs behind them. */
interface StatSummary {
	count: number;
	p5: number;
	p50: number;
	p95: number;
}

interface RowSeriesV1 {
	method: SeriesFile["method"];
	counted_runs: number;
	failed_runs: number;
	groups: number;
	percentiles: { time_per_repetition_ns: StatSummary | null; bytes_per_second: StatSummary | null };
}

interface RowRequestsV1 {
	method: RequestsFile["method"];
	counted_runs: number;
	failed_runs: number;
	groups: number;
	pool: {
		runs: number;
		requests: number;
		failed: number;
		phases: Partial<Record<string, Stats>>;
	};
}

export interface Row extends Pick<SeriesDerivation["series"], "id" | "benchmark" | "params" | "build" | "instance_type" | "availability_zone_id"> {
	url: string;
	runs: number;
	oldest_run_started_at: string;
	newest_run_started_at: string;
	derivations: { series_v1: RowSeriesV1; requests_v1?: RowRequestsV1 };
}

/** What a point gains in the API: the Run file's sha256 and the addresses of its evidence. */
interface Linked {
	sha256: string;
	evidence: string;
	boot_summary: string | null;
}

type ApiSeriesPoint = Pick<SeriesPoint, "run" | "path"> & Linked & Omit<SeriesPoint, "run" | "path">;
type ApiRequestsPoint = Pick<RequestsPoint, "run" | "path"> & Linked & Omit<RequestsPoint, "run" | "path">;

/** A list of Runs with what failed, as each Method writes it, with the address of each Run file. */
type Unreadable = SeriesFile["unreadable"][number] & { evidence: string };

/**
 * Builds the tree: every file's bytes by its path from the root of the host,
 * in path order. Throws on Derivations that do not hold together: a Series id
 * that is not one, a Series twice, a Series of requests that series v1 does
 * not have, the two Methods citing different Runs for one Series, a point
 * that is not its Run, a price file's path or date twice.
 */
export function buildApi(sources: ApiSources): Map<string, Uint8Array> {
	const base = normalizeBase(sources.base);
	const at = (path: string): string => `${base}/${path}`;
	const files = new Map<string, string | Uint8Array>();

	const series = new Map<string, SeriesDerivation>();
	for (const derivation of sources.series.derivations) {
		const id = derivation.series.id;
		if (!SERIES_ID.test(id)) throw new Error(`series v1 has a Series whose id is not 12 hex digits: ${JSON.stringify(id)}`);
		if (series.has(id)) throw new Error(`series v1 has Series ${id} twice`);
		series.set(id, derivation);
	}
	const requests = new Map<string, RequestsDerivation>();
	for (const derivation of sources.requests.derivations) {
		const id = derivation.series.id;
		if (requests.has(id)) throw new Error(`requests v1 has Series ${id} twice`);
		const other = series.get(id);
		if (other === undefined) throw new Error(`requests v1 has Series ${id}, which series v1 does not`);
		if (canonicalJson(other.runs) !== canonicalJson(derivation.runs)) throw new Error(`series v1 and requests v1 cite different Runs for Series ${id}`);
		if (canonicalJson(other.series) !== canonicalJson(derivation.series)) throw new Error(`series v1 and requests v1 describe Series ${id} differently`);
		requests.set(id, derivation);
	}

	const evidence = (path: string): string => {
		if (!RUN_PATH.test(path)) throw new Error(`${path} is not a Run file's path, runs/<yyyy>/<mm>/<dd>/<id>.json`);
		return at(path);
	};
	const bootSummary = (boot: string): string | null => {
		const path = sources.boots.get(boot);
		return path === undefined ? null : at(path);
	};
	/** A point with the Run file's sha256 and its evidence's addresses after its path. */
	const link = <P extends SeriesPoint | RequestsPoint>(id: string, cited: SeriesDerivation["runs"], points: readonly P[]) =>
		points.map((point, i) => {
			const run = cited[i];
			if (run === undefined || run.id !== point.run || run.path !== point.path) throw new Error(`Series ${id}: point ${i} is not the Run cited at ${i}`);
			const { run: runId, path, ...rest } = point;
			return { run: runId, path, sha256: run.sha256, evidence: evidence(path), boot_summary: bootSummary(point.boot), ...rest };
		});

	const ordered = [...series.values()].sort(seriesOrder);
	const rows: Row[] = [];
	let newest: string | null = null;
	for (const derivation of ordered) {
		const id = derivation.series.id;
		if (derivation.points.length !== derivation.runs.length) throw new Error(`Series ${id}: ${derivation.points.length} points for ${derivation.runs.length} Runs`);
		if (derivation.points.length === 0) throw new Error(`Series ${id} has no Run`);
		const starts = derivation.points.map((point) => point.started_at).sort(compareText);
		const oldest = starts[0] as string;
		const latest = starts[starts.length - 1] as string;
		if (newest === null || compareText(latest, newest) > 0) newest = latest;
		// The Series' identity, its address right after its id, and its Runs' count and span: the same at the head of its row and of its file.
		const head = {
			id,
			url: at(seriesPath(id)),
			benchmark: derivation.series.benchmark,
			params: derivation.series.params,
			build: derivation.series.build,
			instance_type: derivation.series.instance_type,
			availability_zone_id: derivation.series.availability_zone_id,
			runs: derivation.runs.length,
			oldest_run_started_at: oldest,
			newest_run_started_at: latest,
		};
		const ofRequests = requests.get(id);

		rows.push({
			...head,
			derivations: {
				series_v1: {
					method: sources.series.method,
					...pointCounts(derivation.points),
					groups: derivation.groups.length,
					percentiles: {
						time_per_repetition_ns: summary(derivation.percentiles.time_per_repetition_ns),
						bytes_per_second: summary(derivation.percentiles.bytes_per_second),
					},
				},
				...(ofRequests === undefined
					? {}
					: {
							requests_v1: {
								method: sources.requests.method,
								...pointCounts(ofRequests.points),
								groups: ofRequests.groups.length,
								pool: {
									runs: ofRequests.pool.runs,
									requests: ofRequests.pool.requests,
									failed: ofRequests.pool.failed,
									phases: Object.fromEntries(Object.entries(ofRequests.pool.phases).map(([phase, pooled]) => [phase, withoutHistogram(pooled as Stats)])),
								},
							},
						}),
			},
		});

		const seriesV1 = {
			method: sources.series.method,
			definitions: sources.series.definitions,
			split_on: sources.series.split_on,
			left_out: sources.series.left_out,
			not_split_on: sources.series.not_split_on,
			points: link<SeriesPoint>(id, derivation.runs, derivation.points) satisfies ApiSeriesPoint[],
			percentiles: derivation.percentiles,
			groups: derivation.groups,
			differed: derivation.differed,
			sections: derivation.sections,
		};
		const requestsV1 =
			ofRequests === undefined
				? undefined
				: {
						method: sources.requests.method,
						definitions: sources.requests.definitions,
						phases: sources.requests.phases,
						percentiles: sources.requests.percentiles,
						histogram: sources.requests.histogram,
						request_facts: sources.requests.request_facts,
						split_on: sources.requests.split_on,
						left_out: sources.requests.left_out,
						recorded: ofRequests.recorded,
						points: link<RequestsPoint>(id, ofRequests.runs, ofRequests.points) satisfies ApiRequestsPoint[],
						pool: ofRequests.pool,
						groups: ofRequests.groups,
					};
		files.set(
			seriesPath(id),
			apiJson({
				schema: SCHEMA_IDS.series,
				schema_url: at(schemaPath("series")),
				index: at(INDEX_PATH),
				...head,
				derivations: { series_v1: seriesV1, ...(requestsV1 === undefined ? {} : { requests_v1: requestsV1 }) },
			}),
		);
	}

	const withEvidence = (unreadable: SeriesFile["unreadable"]): Unreadable[] =>
		[...unreadable].sort((a, b) => compareText(a.path, b.path)).map((run) => ({ ...run, evidence: evidence(run.path) }));
	files.set(
		LIST_PATH,
		apiJson({
			schema: SCHEMA_IDS["series-list"],
			schema_url: at(schemaPath("series-list")),
			index: at(INDEX_PATH),
			url: at(LIST_PATH),
			count: rows.length,
			newest_run_started_at: newest,
			methods: {
				series_v1: {
					method: sources.series.method,
					definitions: sources.series.definitions,
					split_on: sources.series.split_on,
					left_out: sources.series.left_out,
					not_split_on: sources.series.not_split_on,
					runs_read: sources.series.runs_read,
					unreadable: withEvidence(sources.series.unreadable),
					sections: [...sources.series.sections].sort((a, b) => compareText(a.section, b.section)),
				},
				requests_v1: {
					method: sources.requests.method,
					definitions: sources.requests.definitions,
					phases: sources.requests.phases,
					percentiles: sources.requests.percentiles,
					histogram: sources.requests.histogram,
					request_facts: sources.requests.request_facts,
					split_on: sources.requests.split_on,
					left_out: sources.requests.left_out,
					runs_read: sources.requests.runs_read,
					unreadable: withEvidence(sources.requests.unreadable),
				},
			},
			series: rows,
		}),
	);

	const prices = [...sources.prices].sort((a, b) => compareText(a.path, b.path));
	const priceEntries: Array<{ date: string; path: string; url: string }> = [];
	for (const price of prices) {
		const date = priceDate(price.path);
		if (files.has(pricePath(date))) throw new Error(`two price files for ${date}`);
		files.set(pricePath(date), price.bytes);
		priceEntries.push({ date, path: price.path, url: at(pricePath(date)) });
	}

	for (const { name } of API_SCHEMAS) {
		const bytes = sources.schemas.get(name);
		if (bytes === undefined) throw new Error(`no schema ${name}`);
		files.set(schemaPath(name), bytes);
	}

	files.set(
		INDEX_PATH,
		apiJson({
			schema: SCHEMA_IDS.index,
			schema_url: at(schemaPath("index")),
			url: at(INDEX_PATH),
			about: ABOUT,
			versioning: VERSIONING,
			figures: FIGURES,
			docs: sources.docs,
			newest_run_started_at: newest,
			series: {
				url: at(LIST_PATH),
				schema_url: at(schemaPath("series-list")),
				count: rows.length,
				series_file_schema_url: at(schemaPath("series")),
			},
			prices: {
				schema_url: at(schemaPath("prices")),
				newest: priceEntries.length === 0 ? null : priceEntries[priceEntries.length - 1],
				files: priceEntries,
			},
			schemas: API_SCHEMAS.map(({ name, describes }) => ({ name, describes, url: at(schemaPath(name)) })),
			evidence: { about: EVIDENCE, blob_url_template: `${base}/blobs/sha256/{hex}` },
		}),
	);

	const encoder = new TextEncoder();
	return new Map(
		[...files.entries()].sort(([a], [b]) => compareText(a, b)).map(([path, content]) => [path, typeof content === "string" ? encoder.encode(content) : content] as const),
	);
}

function pointCounts(points: ReadonlyArray<{ counted: boolean }>): { counted_runs: number; failed_runs: number } {
	const counted = points.filter((point) => point.counted).length;
	return { counted_runs: counted, failed_runs: points.length - counted };
}

function summary(stat: Stat | null): StatSummary | null {
	return stat === null ? null : { count: stat.count, p5: stat.p5, p50: stat.p50, p95: stat.p95 };
}

function withoutHistogram(pooled: Stats & { histogram?: unknown }): Stats {
	const { histogram: _histogram, ...stats } = pooled;
	return stats;
}

/** Method series v1's order, then the id: benchmark, instance type, zone ID, params, build. */
function seriesOrder(a: SeriesDerivation, b: SeriesDerivation): number {
	const tuple = (d: SeriesDerivation): string[] => [d.series.benchmark, d.series.instance_type ?? "", d.series.availability_zone_id ?? "", canonicalJson(d.series.params), d.series.build, d.series.id];
	const x = tuple(a);
	const y = tuple(b);
	for (let i = 0; i < x.length; i++) {
		const order = compareText(x[i] as string, y[i] as string);
		if (order !== 0) return order;
	}
	return 0;
}

/**
 * A file's text: JSON with a final newline. An object is written one member
 * per line, indented two spaces. An array of objects is written one object
 * per line, each whole on its line (a Series' row, a point, a group); any
 * other array is written on one line. Numbers are written as JSON.stringify
 * writes them, as the Derivations were, so each reads back as the same
 * number, digit for digit.
 */
export function apiJson(value: unknown): string {
	return `${write(value, "")}\n`;
}

function write(value: unknown, indent: string): string {
	if (value === undefined) throw new Error("undefined has no JSON");
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	const inner = `${indent}  `;
	if (Array.isArray(value)) {
		if (value.length > 0 && value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
			return `[\n${value.map((item) => `${inner}${JSON.stringify(item)}`).join(",\n")}\n${indent}]`;
		}
		return JSON.stringify(value);
	}
	const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
	if (entries.length === 0) return "{}";
	return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${write(item, inner)}`).join(",\n")}\n${indent}}`;
}
