/**
 * The data API, version 1: a tree of small static JSON files cut from the
 * Derivations of Method series v1 and Method requests v1 and from the price
 * files, laid out as it is served from the API's host (ADR-0030):
 *
 *     v1/index.json                    the table of contents
 *     v1/series.json                   one row per Series, and each Method's own words
 *     v1/series/<id>.json              one Series: each Method's summary, the newest Runs' points, its months
 *     v1/series/<id>/<yyyy-mm>.json    one month of a Series: every point of its Runs that started that month
 *     v1/prices/<yyyy-mm-dd>.json      that day's price file, byte for byte
 *     v1/schemas/<name>.schema.json    the schema of each kind of file
 *
 * It is a re-cut, not a Method: every number is the Derivations' own, written
 * as they hold it, and nothing is computed but counts of points, the times of
 * a Series' (and a month's) oldest and newest Run, and each month file's
 * sha256 and size. Every address a reader needs is written in the files, under
 * one base address; the evidence (Run files, boot summaries, blobs) is linked
 * under the same base, never copied.
 *
 * What grows with a Series' Runs is in its month files, never in its Series
 * file: each Method's points and the entries of a pair of consecutive Runs
 * (series v1's differed), filed under the month of the later Run. The Series
 * file holds the rest: each Method's summary, its fixed words, the points of
 * its newest NEWEST_RUNS Runs (again) and the list of its months, each with
 * its month file's sha256 and size. The lists of Run ids behind a percentile
 * and in a group are left out: each is the points of the month files that the
 * Method's rule picks, and the build refuses Derivations where it is not
 * (recoverable()).
 *
 * The same inputs give the same bytes, file for file, whatever order the
 * Series, price files or boot summaries come in, and whatever order the
 * members of their objects come in (apiJson), and no clock is read: a file's
 * bytes are writerForm() of its own value. For a given LAYOUT, a month file's
 * bytes change only for the four causes MONTH_CONTRACT names: a Run of its
 * month added, a missing boot summary arriving, a Run arriving late (before a
 * Run of its Series already in the files) in its month or an earlier one, a
 * Method first applying to its Series. requests v1's group_through is written
 * as it stood through each Run, as group_through_as_of_run (asOfRun()), so
 * that a Run that splits a Series is none of them. scripts/check-api.ts
 * --previous holds a tree to that against the tree before it.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { DerivationsFile as RequestsFile, SeriesDerivation as RequestsDerivation, Point as RequestsPoint, Stats } from "../../methods/requests/v1/output";
import { canonicalJson, compareText } from "../../methods/run";
import type { DerivationsFile as SeriesFile, SeriesDerivation, Point as SeriesPoint, Stat } from "../../methods/v1/output";
import { API_SCHEMAS } from "./api-schemas";
import { PRICE_FILE_PATH } from "./prices";
import { parseStrictJson } from "./strict-json";

const ROOT = resolve(import.meta.dir, "..", "..");

export const DEFAULT_BASE = "https://api.ledgermath.com";
/** Where the API is described in words, until the docs have pages of their own. */
export const DEFAULT_DOCS = "https://github.com/smrdotgg/ledgermath/blob/main/README.md#the-data-api";

/**
 * How many of a Series' newest Runs have their points in its Series file as
 * well as in their month's file, so its latest figures take one request: three
 * days at four Runs a day. Each Series file names it (newest_runs).
 */
export const NEWEST_RUNS = 12;

/**
 * How the files are written, as a number, in v1/index.json (layout). Raise it
 * by one whenever this writer changes how it writes the files, whatever the
 * change: the order of a file's fields (the order of its schema's
 * properties), the white space or line breaks between them, a field that
 * every file of a kind gains, the spelling of a value. Such a change may
 * change the bytes of any file without one of the four causes MONTH_CONTRACT
 * gives, and for a given layout nothing else may. Editing a schema's words
 * does not change it; neither do the data. tests/api-golden.test.ts fails on
 * any change to the bytes the build writes, and says so.
 *
 * The runs workflow compares each tree with the one before only when both are
 * of one layout; a tree of a new layout is compared with nothing until a
 * human starts the workflow by hand declaring a new baseline (its input
 * new_baseline), and even then no Series and no Run the tree before published
 * may be missing from it.
 */
export const LAYOUT = 1;

/** Each kind of file's schema: its name in the tree, and where it is kept in this repository (kept in scripts/lib/api-schemas.ts, which the stack imports too). */
export { API_SCHEMAS };
export type SchemaName = (typeof API_SCHEMAS)[number]["name"];

export const SCHEMA_IDS = {
	index: "ledgermath.api.index/1",
	"series-list": "ledgermath.api.series-list/1",
	series: "ledgermath.api.series/1",
	"series-month": "ledgermath.api.series-month/1",
} as const;

export const schemaPath = (name: SchemaName): string => `v1/schemas/${name}.schema.json`;
export const seriesPath = (id: string): string => `v1/series/${id}.json`;
export const monthPath = (id: string, month: string): string => `v1/series/${id}/${month}.json`;
export const pricePath = (date: string): string => `v1/prices/${date}.json`;
export const INDEX_PATH = "v1/index.json";
export const LIST_PATH = "v1/series.json";

/** A Series id as Method series v1 makes it: the first 12 hex digits of the sha256 of its key. */
export const SERIES_ID = /^[0-9a-f]{12}$/;
/** A Run file's path in the Runs repository, which is also its key in the bucket. */
export const RUN_PATH = /^runs\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/[A-Za-z0-9._-]+\.json$/;
/** A boot summary's path in the Runs repository, which is also its key in the bucket. */
export const BOOT_PATH = /^boots\/([0-9]{4})\/([0-9]{2})\/([0-9]{2})\/([A-Za-z0-9._-]+)\.json$/;
/** A Run's start as the Run schema writes it: UTC, to the nanosecond. Its first seven characters are its month. */
const STARTED_AT = /^([0-9]{4}-(?:0[1-9]|1[0-2]))-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{9}Z$/;

/** The UTC month, yyyy-mm, of a Run's start as the Run records it. */
export function monthOf(startedAt: string): string {
	const match = STARTED_AT.exec(startedAt);
	if (match === null) throw new Error(`${JSON.stringify(startedAt)} is not a Run's start as the Run schema writes it, yyyy-mm-ddThh:mm:ss.nnnnnnnnnZ`);
	return match[1] as string;
}

export const VERSIONING =
	"Version 1 only ever gains fields. A field, once in a v1 file, keeps its name, its type and its meaning, and a reader ignores any field it does not know: " +
	"that is why no object in the schemas index, series-list, series and series-month forbids members it does not list. A new Method, or a new version of one, is a new key beside the old ones. " +
	"A change that would break a reader is published as v2, beside v1. The price files are the exception: each is the day's price file as LedgerMath keeps it, byte for byte, " +
	"and follows its own schema, ledgermath.prices/1, whose root and LedgerMath's own objects are closed (AWS's objects within it are open).";
export const FIGURES =
	"Every number is exactly as the Methods' Derivations hold it: nothing is rounded, and nothing is computed that the Derivations do not hold, " +
	"apart from counts of a Series' Runs (in all, in a month, counted and not), the start times of its oldest and newest Run (in all, in a month), taken from its points, " +
	"and each month file's sha256 and size in bytes. " +
	"A duration is in nanoseconds of the Run's clock unless its field's name says otherwise; a moment is a UTC time, to the nanosecond, as the Run records it.";
export const ABOUT =
	"LedgerMath runs small benchmarks on real AWS machines several times a day and keeps every execution as a Run. A Series is the Runs of one benchmark, " +
	"parameter set, build, instance type and Availability Zone ID; a versioned Method turns its Runs into a Derivation. This is version 1 of the data API: " +
	"static JSON files cut from the Derivations and the daily price files, each kind with a JSON schema. A Series' file holds each Method's summary and its newest Runs; " +
	"every Run's point is in the file of the month it started in, and months says when such a file changes.";
/**
 * When a month file's bytes change, in the API's own words: stated, word for
 * word, in v1/index.json (months), the schemas series and series-month,
 * ADR-0030 and the README, and held to by scripts/check-api.ts --previous.
 */
export const MONTH_CONTRACT =
	"For a given layout (the layout of v1/index.json), a month file's bytes change only when (a) a Run that started in that month is added, (b) a boot summary that was missing arrives, " +
	"(c) a Run arrives late, having started before a Run of the Series already in the files, in that month or an earlier one, " +
	"or (d) a Method first applies to the Series; otherwise they do not change. " +
	"These four are the only causes for a given layout: layout increases when LedgerMath changes how the files are written, and only then may a file's bytes change without one of them. " +
	"A past month is therefore not immutable: each entry of the Series file's months gives its month file's sha256 and size in bytes, " +
	"so a reader holding a copy can tell whether it is current, and fetches the file again only when the sha256 differs.";
export const MONTHS =
	"Each Series is split by month: every Run's point is in the file of the month the Run started in (UTC, by the Run's start), " +
	"with series v1's entry for each pair of consecutive Runs under the month of the later Run, and the Series' file lists its months. " +
	MONTH_CONTRACT +
	" What each cause changes: (a) the month gains the Run's point, its pair entry and its count and span; " +
	"(b) the point's boot_summary turns from null into the summary's address, and nothing else; " +
	"(c) as (a), and in that month and every later one the points after the late Run may change only what depends on earlier Runs: their group, and requests v1's through and group_through_as_of_run " +
	"(through's counts rise by exactly what the late Runs it pools add, and not at all when none of them is counted), " +
	"and the pair entry of the Run right after it then comes from the late Run; " +
	"(d) the Method's block appears, under its key, in every month file of the Series.";
export const EVIDENCE =
	"The evidence is served under the same address as the API: each point links its Run file (evidence), at runs/<yyyy>/<mm>/<dd>/<id>.json, " +
	"and its boot's summary (boot_summary), at boots/<yyyy>/<mm>/<dd>/<boot>.json. A Run file names its binary, streams and dumps by hash, sha256:<hex>; " +
	"each is a blob at blob_url_template with {hex} replaced by the 64 hex digits.";

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

/** The schemas of the files the build writes (every kind but the price files, which it copies). */
export type WrittenSchema = Exclude<SchemaName, "prices">;
/** Each written kind's schema, parsed: what fixes the order of the members of its files' objects (apiJson). */
export type Shapes = Readonly<Record<WrittenSchema, Json>>;

/** The schemas of the written kinds, parsed. */
export function apiShapes(schemas: ReadonlyMap<SchemaName, Uint8Array>): Shapes {
	const shape = (name: WrittenSchema): Json => {
		const bytes = schemas.get(name);
		if (bytes === undefined) throw new Error(`no schema ${name}`);
		const schema: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (!isJson(schema)) throw new Error(`the schema ${name} is not a JSON object`);
		return schema;
	};
	return { index: shape("index"), "series-list": shape("series-list"), series: shape("series"), "series-month": shape("series-month") };
}

/** The schema a file of the tree is written by, from its path; undefined for a file the build copies (a price file, a schema) or no file of the tree. */
export function writtenSchemaOf(path: string): WrittenSchema | undefined {
	if (path === INDEX_PATH) return "index";
	if (path === LIST_PATH) return "series-list";
	if (/^v1\/series\/[^/]+\.json$/.test(path)) return "series";
	if (/^v1\/series\/[^/]+\/[^/]+\.json$/.test(path)) return "series-month";
	return undefined;
}

let repositoryShapes: Shapes | undefined;

/**
 * The text the build writes for a file of the tree holding `value`: apiJson
 * with the schema of the file's kind. Whatever order `value`'s members come
 * in and however its numbers were spelled, the text is the one the build
 * writes for that value, so a file whose bytes are not this text for its own
 * parsed value is not as the build wrote it (scripts/lib/api-check.ts holds
 * every written file to it). `shapes` defaults to this repository's schemas.
 */
export function writerForm(path: string, value: unknown, shapes?: Shapes): string {
	const name = writtenSchemaOf(path);
	if (name === undefined) throw new Error(`${path} is not a file the build writes: a price file and a schema are copied, byte for byte`);
	const used = shapes ?? (repositoryShapes ??= apiShapes(readApiSchemas()));
	return apiJson(value, used[name]);
}

/**
 * Reads a file of Derivations, as strictly as its strictest reader would and
 * with every number checked to be written back with its value
 * (strict-json.ts), and checks it is the named Method's. A number a double
 * does not hold (an integer past 2^53, a value past a double's range, more
 * digits than a double holds) would be changed on its way into the tree
 * without a word: the file is refused, naming the number and where it is.
 */
export function readDerivations<T extends SeriesFile | RequestsFile>(path: string, name: T["method"]["name"]): T {
	let value: unknown;
	try {
		value = parseStrictJson(new Uint8Array(readFileSync(path)), { exactNumbers: true });
	} catch (error) {
		throw new Error(`${path} cannot be read exactly: ${error instanceof Error ? error.message : String(error)}`);
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

/**
 * A Series' percentiles in its row and its Series file: the Derivation's,
 * without the list of Runs behind them (recoverable from the month files'
 * points). A percentile of bytes per second that is infinite, from a counted
 * Run of 0 ns per repetition, is null in the Derivations' JSON, and so here,
 * although the Method's type says number.
 */
interface StatSummary {
	count: number;
	p5: number | null;
	p50: number | null;
	p95: number | null;
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
/**
 * A point of requests v1 as the tree writes it: group_through, which a Run
 * that started later can change, is written as it stood through the point's
 * own Run, under its own name (asOfRun()).
 */
type AsOfRunPoint = Omit<RequestsPoint, "group_through"> & { group_through_as_of_run: RequestsPoint["group_through"] };
type ApiRequestsPoint = Pick<AsOfRunPoint, "run" | "path"> & Linked & Omit<AsOfRunPoint, "run" | "path">;

/** A list of Runs with what failed, as each Method writes it, with the address of each Run file. */
type Unreadable = SeriesFile["unreadable"][number] & { evidence: string };

/** One entry of a Series file's list of months: with its month file's sha256 and size, so a reader can tell whether its copy is current. */
interface MonthEntry {
	month: string;
	url: string;
	runs: number;
	oldest_run_started_at: string;
	newest_run_started_at: string;
	sha256: string;
	bytes: number;
}

/**
 * Builds the tree: every file's bytes by its path from the root of the host,
 * in path order. Throws on Derivations that do not hold together: a Series id
 * that is not one, a Series twice, a Series of requests that series v1 does
 * not have, the two Methods citing different Runs for one Series, a point
 * that is not its Run, Runs out of time order, a price file's path or date
 * twice; and on Derivations whose lists of Runs the tree leaves out could not
 * be recovered from it (recoverable(), asOfRun()).
 */
export function buildApi(sources: ApiSources): Map<string, Uint8Array> {
	const base = normalizeBase(sources.base);
	const at = (path: string): string => `${base}/${path}`;
	const encoder = new TextEncoder();
	const files = new Map<string, string | Uint8Array>();
	/** Each of the API's own schemas, parsed: it fixes the order of the members of its files' objects (apiJson). */
	const shapes = apiShapes(sources.schemas);
	// The docs' address is the one link the build is given whole: refuse it unless it is what the index schema allows.
	const docsPattern = ((shapes.index.properties as Json | undefined)?.docs as Json | undefined)?.pattern;
	if (typeof docsPattern !== "string") throw new Error("the schema index gives no pattern for docs");
	if (!new RegExp(docsPattern, "u").test(sources.docs)) throw new Error(`${sources.docs} is not an address for the docs: an absolute https address with a host`);

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
	const link = <P extends SeriesPoint | AsOfRunPoint>(id: string, cited: SeriesDerivation["runs"], points: readonly P[]) =>
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
		const points = derivation.points;
		if (points.length !== derivation.runs.length) throw new Error(`Series ${id}: ${points.length} points for ${derivation.runs.length} Runs`);
		if (points.length === 0) throw new Error(`Series ${id} has no Run`);
		// The months, each a run of consecutive points: the Method writes them in time order, and a month file holds a stretch of it.
		const months: Array<{ month: string; from: number; to: number }> = [];
		points.forEach((point, i) => {
			const previous = points[i - 1];
			if (previous !== undefined && compareText(previous.started_at, point.started_at) > 0) throw new Error(`Series ${id}: point ${i} started before point ${i - 1}: its points are not in time order`);
			const month = monthOf(point.started_at);
			const last = months[months.length - 1];
			if (last?.month === month) last.to = i + 1;
			else months.push({ month, from: i, to: i + 1 });
		});
		const oldest = (points[0] as SeriesPoint).started_at;
		const latest = (points[points.length - 1] as SeriesPoint).started_at;
		if (newest === null || compareText(latest, newest) > 0) newest = latest;
		recoverable(id, derivation, requests.get(id));
		// The Series' identity, its address right after its id, and its Runs' count and span: the same at the head of its row and of its file.
		const identity = {
			benchmark: derivation.series.benchmark,
			params: derivation.series.params,
			build: derivation.series.build,
			instance_type: derivation.series.instance_type,
			availability_zone_id: derivation.series.availability_zone_id,
		};
		const head = { id, url: at(seriesPath(id)), ...identity, runs: derivation.runs.length, oldest_run_started_at: oldest, newest_run_started_at: latest };
		const ofRequests = requests.get(id);

		const seriesCounts = pointCounts(points);
		const seriesPercentiles = { time_per_repetition_ns: summary(derivation.percentiles.time_per_repetition_ns), bytes_per_second: summary(derivation.percentiles.bytes_per_second) };
		const requestsCounts = ofRequests === undefined ? undefined : pointCounts(ofRequests.points);
		rows.push({
			...head,
			derivations: {
				series_v1: { method: sources.series.method, ...seriesCounts, groups: derivation.groups.length, percentiles: seriesPercentiles },
				...(ofRequests === undefined
					? {}
					: {
							requests_v1: {
								method: sources.requests.method,
								...(requestsCounts as { counted_runs: number; failed_runs: number }),
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

		const seriesPoints = link<SeriesPoint>(id, derivation.runs, points) satisfies ApiSeriesPoint[];
		const requestsPoints = ofRequests === undefined ? undefined : (link<AsOfRunPoint>(id, ofRequests.runs, asOfRun(id, ofRequests)) satisfies ApiRequestsPoint[]);
		const entries: MonthEntry[] = [];
		for (const { month, from, to } of months) {
			const url = at(monthPath(id, month));
			const span = { runs: to - from, oldest_run_started_at: (points[from] as SeriesPoint).started_at, newest_run_started_at: (points[to - 1] as SeriesPoint).started_at };
			const bytes = encoder.encode(
				apiJson(
					{
						schema: SCHEMA_IDS["series-month"],
						schema_url: at(schemaPath("series-month")),
						index: at(INDEX_PATH),
						id,
						month,
						url,
						series_url: head.url,
						...identity,
						...span,
						derivations: {
							// The entry of the pair of points i and i + 1 is filed under the month of point i + 1.
							series_v1: { method: sources.series.method, points: seriesPoints.slice(from, to), differed: derivation.differed.slice(Math.max(from - 1, 0), to - 1) },
							...(requestsPoints === undefined ? {} : { requests_v1: { method: sources.requests.method, points: requestsPoints.slice(from, to) } }),
						},
					},
					shapes["series-month"],
				),
			);
			files.set(monthPath(id, month), bytes);
			entries.push({ month, url, ...span, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
		}

		const seriesV1 = {
			method: sources.series.method,
			definitions: sources.series.definitions,
			split_on: sources.series.split_on,
			left_out: sources.series.left_out,
			not_split_on: sources.series.not_split_on,
			...seriesCounts,
			percentiles: seriesPercentiles,
			groups: derivation.groups.map((group) => ({
				id: group.id,
				facts: group.facts,
				percentiles: { time_per_repetition_ns: summary(group.percentiles.time_per_repetition_ns), bytes_per_second: summary(group.percentiles.bytes_per_second) },
			})),
			sections: derivation.sections,
			newest_points: seriesPoints.slice(-NEWEST_RUNS),
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
						...requestsCounts,
						recorded: ofRequests.recorded,
						pool: ofRequests.pool,
						groups: ofRequests.groups.map((group) => ({ id: group.id, facts: group.facts, pool: group.pool })),
						newest_points: (requestsPoints as ApiRequestsPoint[]).slice(-NEWEST_RUNS),
					};
		files.set(
			seriesPath(id),
			apiJson(
				{
					schema: SCHEMA_IDS.series,
					schema_url: at(schemaPath("series")),
					index: at(INDEX_PATH),
					...head,
					newest_runs: NEWEST_RUNS,
					months: entries,
					derivations: { series_v1: seriesV1, ...(requestsV1 === undefined ? {} : { requests_v1: requestsV1 }) },
				},
				shapes.series,
			),
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
		}, shapes["series-list"]),
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
			months: MONTHS,
			layout: LAYOUT,
			docs: sources.docs,
			newest_run_started_at: newest,
			series: {
				url: at(LIST_PATH),
				schema_url: at(schemaPath("series-list")),
				count: rows.length,
				series_file_schema_url: at(schemaPath("series")),
				month_file_schema_url: at(schemaPath("series-month")),
			},
			prices: {
				schema_url: at(schemaPath("prices")),
				newest: priceEntries.length === 0 ? null : priceEntries[priceEntries.length - 1],
				files: priceEntries,
			},
			schemas: API_SCHEMAS.map(({ name, describes }) => ({ name, describes, url: at(schemaPath(name)) })),
			evidence: { about: EVIDENCE, blob_url_template: `${base}/blobs/sha256/{hex}` },
		}, shapes.index),
	);

	return new Map(
		[...files.entries()].sort(([a], [b]) => compareText(a, b)).map(([path, content]) => [path, typeof content === "string" ? encoder.encode(content) : content] as const),
	);
}

/**
 * Throws unless every list of Runs the tree leaves out of a Series file is
 * exactly what a reader recovers from the Series' points, in time order, by
 * the Method's own rule (methods/v1/index.ts stat(), deriveSeries();
 * methods/requests/v1/index.ts deriveSeries()):
 *
 * - the Runs behind series v1's percentiles of time per repetition, for the
 *   Series or a group: its counted points (every counted Run has a time per
 *   repetition, an infinite one written null included);
 * - behind its percentiles of bytes per second: its counted points whose
 *   bytes_per_repetition is not null (a Method v1 only observes a finite
 *   positive one, so null means none);
 * - a group's Runs, under either Method: the points of its letter;
 * - series v1's differed: one entry per pair of consecutive points, from the
 *   earlier to the later, in order, which the month files file by the later.
 *
 * And a percentile is null exactly when no point qualifies, with count the
 * number that do.
 */
function recoverable(id: string, derivation: SeriesDerivation, ofRequests: RequestsDerivation | undefined): void {
	const ids = (points: readonly { run: string }[]): string[] => points.map((point) => point.run);
	const same = (what: string, held: readonly string[] | undefined, recovered: readonly string[]): void => {
		if (canonicalJson(held ?? []) !== canonicalJson(recovered)) {
			throw new Error(`Series ${id}: ${what} lists other Runs than its points recover (${held?.length ?? 0} held, ${recovered.length} recovered); the tree leaves that list out, so it must be recoverable`);
		}
	};
	const stat = (what: string, held: Stat | null, recovered: string[]): void => {
		if (held === null) {
			if (recovered.length > 0) throw new Error(`Series ${id}: ${what} is null, yet ${recovered.length} of its points qualify`);
			return;
		}
		if (held.count !== held.runs.length) throw new Error(`Series ${id}: ${what} counts ${held.count} Runs and lists ${held.runs.length}`);
		same(what, held.runs, recovered);
	};
	const percentiles = (what: string, held: SeriesDerivation["percentiles"], points: readonly SeriesPoint[]): void => {
		stat(`series v1's ${what}percentiles of time_per_repetition_ns`, held.time_per_repetition_ns, ids(points.filter((point) => point.counted)));
		stat(`series v1's ${what}percentiles of bytes_per_second`, held.bytes_per_second, ids(points.filter((point) => point.counted && point.bytes_per_repetition !== null)));
	};
	percentiles("", derivation.percentiles, derivation.points);
	let grouped = 0;
	for (const group of derivation.groups) {
		const members = derivation.points.filter((point) => point.group === group.id);
		grouped += members.length;
		same(`series v1's group ${group.id}`, group.runs, ids(members));
		percentiles(`group ${group.id}'s `, group.percentiles, members);
	}
	if (grouped !== derivation.points.length) throw new Error(`Series ${id}: series v1's groups hold ${grouped} of its ${derivation.points.length} points`);
	if (derivation.differed.length !== Math.max(derivation.points.length - 1, 0)) throw new Error(`Series ${id}: series v1 has ${derivation.differed.length} differed entries for ${derivation.points.length} points`);
	derivation.differed.forEach((entry, i) => {
		if (entry.from !== derivation.points[i]?.run || entry.to !== derivation.points[i + 1]?.run) throw new Error(`Series ${id}: series v1's differed entry ${i} is not of points ${i} and ${i + 1}`);
	});
	if (ofRequests === undefined) return;
	let requested = 0;
	for (const group of ofRequests.groups) {
		const members = ofRequests.points.filter((point) => point.group === group.id);
		requested += members.length;
		same(`requests v1's group ${group.id}`, group.runs, ids(members));
	}
	if (requested !== ofRequests.points.length) throw new Error(`Series ${id}: requests v1's groups hold ${requested} of its ${ofRequests.points.length} points`);
}

/**
 * Requests v1's points as the tree writes them: each point's group_through as
 * it stood through that point's Run, named group_through_as_of_run, since it
 * is not always the Derivation's group_through. The Method writes a point's
 * group's pooled figures only when the Series has more than one group, so
 * when a Run that started later first brings a second group, every earlier point's
 * group_through turns from null into its group's figures, and would change
 * the month files of every earlier month. Before that first Run of a second
 * group, though, every Run is of the first group, and its group's figures are
 * the Series' own: through. The tree writes null there, whatever came later,
 * and a reader recovers the Derivation's value as through, for those points
 * only, when the Series has more than one group. Everywhere else the two are
 * the same, null included: null for a point of a group that has had no
 * counted Run yet, although through, the other groups' figures, is not.
 * Throws when the Derivation holds anything else.
 */
function asOfRun(id: string, derivation: RequestsDerivation): AsOfRunPoint[] {
	const points = derivation.points;
	const first = points.findIndex((point) => point.group !== points[0]?.group);
	return points.map((point, i) => {
		const { group_through: groupThrough, ...rest } = point;
		if (first < 0 && groupThrough !== null) throw new Error(`Series ${id}: requests v1's point ${i} holds a group_through in a Series of one group`);
		if (first >= 0 && i < first && canonicalJson(groupThrough) !== canonicalJson(point.through)) {
			throw new Error(`Series ${id}: requests v1's point ${i}, before the Series' first Run of a second group, holds a group_through other than its through`);
		}
		return { ...rest, group_through_as_of_run: first >= 0 && i < first ? null : groupThrough };
	});
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
 *
 * The order of every object's members is fixed, whatever order the input
 * held them in: the members its schema lists come first, in the schema's
 * order (the order the files were designed in), and any other member, such as
 * a key of a free-form object (parameters, a group's facts, the Methods'
 * definitions, a Service's inputs), after them, in JavaScript's default
 * string order, by UTF-16 code unit (byte order for the ASCII names in use).
 * Without a schema every object's members are in that order. The order of
 * the schemas' properties thus fixes the files' bytes: tests/api-golden.test.ts
 * shows any change to it.
 */
export function apiJson(value: unknown, schema?: unknown): string {
	const root = isJson(schema) ? schema : {};
	return `${write(value, "", schema, root)}\n`;
}

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A schema with its $ref followed, within the same document. */
function follow(node: unknown, root: Json): Json | undefined {
	let current = node;
	for (let depth = 0; depth < 64; depth++) {
		if (!isJson(current)) return undefined;
		if (typeof current.$ref !== "string") return current;
		const ref = current.$ref;
		if (!ref.startsWith("#")) throw new Error(`a schema refers to ${ref}, outside itself`);
		current = ref
			.slice(1)
			.split("/")
			.filter((part) => part !== "")
			.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
			.reduce<unknown>((at, part) => (isJson(at) ? at[part] : undefined), root);
	}
	throw new Error("a schema's $ref goes round in a circle");
}

/** branch()'s answers, by kind and schema node: a file has many objects of one schema. */
const branches = new Map<(schema: Json) => boolean, WeakMap<Json, Json | null>>();

/** The first schema among node and its anyOf or oneOf branches that is of the given kind. */
function branch(node: unknown, root: Json, kind: (schema: Json) => boolean): Json | undefined {
	if (!isJson(node)) return undefined;
	let known = branches.get(kind);
	if (known === undefined) {
		known = new WeakMap();
		branches.set(kind, known);
	}
	const cached = known.get(node);
	if (cached !== undefined) return cached ?? undefined;
	const found = findBranch(node, root, kind);
	known.set(node, found ?? null);
	return found;
}

function findBranch(node: unknown, root: Json, kind: (schema: Json) => boolean): Json | undefined {
	const schema = follow(node, root);
	if (schema === undefined) return undefined;
	if (kind(schema)) return schema;
	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = schema[key];
		if (!Array.isArray(branches)) continue;
		for (const item of branches) {
			const found = branch(item, root, kind);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

const describesObject = (schema: Json): boolean => schema.type === "object" || isJson(schema.properties) || "additionalProperties" in schema;
const describesArray = (schema: Json): boolean => schema.type === "array" || "items" in schema || "prefixItems" in schema;

/** Where an object's members go: the members its schema lists, in order, with their schemas; and the schema of any other member. */
interface Layout {
	listed: string[];
	/** Each listed member's name as JSON. */
	quoted: string[];
	schemas: unknown[];
	isListed: ReadonlySet<string>;
	others: unknown;
}

const NO_SCHEMA: Layout = { listed: [], quoted: [], schemas: [], isListed: new Set(), others: undefined };
const layouts = new WeakMap<Json, Layout>();

function layoutOf(node: unknown, root: Json): Layout {
	const schema = branch(node, root, describesObject);
	if (schema === undefined) return NO_SCHEMA;
	let layout = layouts.get(schema);
	if (layout === undefined) {
		const properties = isJson(schema.properties) ? schema.properties : {};
		const listed = Object.keys(properties);
		layout = {
			listed,
			quoted: listed.map((key) => JSON.stringify(key)),
			schemas: listed.map((key) => properties[key]),
			isListed: new Set(listed),
			others: schema.additionalProperties,
		};
		layouts.set(schema, layout);
	}
	return layout;
}

/** An object's members in their written order, each with the schema it is written by. */
function members(value: Json, node: unknown, root: Json): Array<[string, unknown, unknown]> {
	const { listed, schemas, isListed, others } = layoutOf(node, root);
	const out: Array<[string, unknown, unknown]> = [];
	for (let i = 0; i < listed.length; i++) {
		const key = listed[i] as string;
		if (Object.hasOwn(value, key) && value[key] !== undefined) out.push([key, value[key], schemas[i]]);
	}
	const keys = Object.keys(value);
	if (keys.length === out.length) return out;
	const rest = keys.filter((key) => !isListed.has(key) && value[key] !== undefined).sort(compareText);
	for (const key of rest) out.push([key, value[key], others]);
	return out;
}

/** The schema of an array's item at index. */
function itemSchema(node: unknown, root: Json, index: number): unknown {
	const schema = branch(node, root, describesArray);
	if (schema === undefined) return undefined;
	if (Array.isArray(schema.prefixItems) && index < schema.prefixItems.length) return schema.prefixItems[index];
	return schema.items;
}

function write(value: unknown, indent: string, schema: unknown, root: Json): string {
	if (value === undefined) throw new Error("undefined has no JSON");
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	const inner = `${indent}  `;
	if (Array.isArray(value)) {
		if (value.length > 0 && value.every(isJson)) {
			return `[\n${value.map((item, i) => `${inner}${line(item, itemSchema(schema, root, i), root)}`).join(",\n")}\n${indent}]`;
		}
		return line(value, schema, root);
	}
	const entries = members(value as Json, schema, root);
	if (entries.length === 0) return "{}";
	return `{\n${entries.map(([key, item, itemSchema]) => `${inner}${JSON.stringify(key)}: ${write(item, inner, itemSchema, root)}`).join(",\n")}\n${indent}}`;
}

/** A value on one line, as JSON.stringify writes it, with every object's members in their written order. */
function line(value: unknown, schema: unknown, root: Json): string {
	if (value === null || typeof value !== "object") {
		if (value === undefined) throw new Error("undefined has no JSON");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		const array = branch(schema, root, describesArray);
		const prefix = array !== undefined && Array.isArray(array.prefixItems) ? array.prefixItems : [];
		const items = array?.items;
		let out = "[";
		for (let i = 0; i < value.length; i++) {
			if (i > 0) out += ",";
			out += line(value[i], i < prefix.length ? prefix[i] : items, root);
		}
		return `${out}]`;
	}
	const object = value as Json;
	const { listed, quoted, schemas, isListed, others } = layoutOf(schema, root);
	let out = "{";
	let present = 0;
	for (let i = 0; i < listed.length; i++) {
		const key = listed[i] as string;
		if (!Object.hasOwn(object, key)) continue;
		present++;
		const item = object[key];
		if (item === undefined) continue;
		out += `${out.length > 1 ? "," : ""}${quoted[i]}:${line(item, schemas[i], root)}`;
	}
	const keys = Object.keys(object);
	if (keys.length > present) {
		for (const key of keys.filter((name) => !isListed.has(name)).sort(compareText)) {
			const item = object[key];
			if (item === undefined) continue;
			out += `${out.length > 1 ? "," : ""}${JSON.stringify(key)}:${line(item, others, root)}`;
		}
	}
	return `${out}}`;
}
