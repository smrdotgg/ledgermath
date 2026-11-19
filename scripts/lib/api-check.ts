/**
 * Checks a tree of the data API as it was written to disk (scripts/lib/api.ts),
 * against the Derivations it was cut from, the Runs repository checkout whose
 * evidence it links and the schemas this repository keeps. Every way it fails
 * is a problem; none, and the tree may be kept.
 *
 * It establishes what it checks from the files it opens, by its own reading
 * of the design (ADR-0030): it calls nothing of the generator's, and compares
 * parsed values, member by member and number by number, never bytes the
 * generator wrote. A passing check establishes all of this:
 *
 * - Every JSON file of the tree is strict JSON, as the strictest reader
 *   would read it (strict-json.ts): UTF-8, with no byte-order mark, no
 *   object holding a member name twice, so no two readers can read one file
 *   as two values, and no number a double does not hold exactly, so no
 *   reader's parse changes a figure.
 * - The tree holds exactly the files it should: the table of contents, the
 *   list, the five schemas, one Series file per Series of either file of
 *   Derivations, one month file per month in which a Run of that Series
 *   started (UTC, by the Run's start), and one per price file in the
 *   checkout; nothing else. Each is reached from the table of contents by
 *   following the links in the files, and none is over its kind's ceiling
 *   of bytes (CEILINGS).
 * - Each schema in the tree is byte for byte this repository's and a valid
 *   JSON Schema, every kind of file in the tree is described by one schema
 *   the table of contents lists, and every file matches this repository's
 *   schema of its kind: a price file as the schema is written, the API's own
 *   files with every object closed, so a field the schema does not describe
 *   is a problem here although the published schemas leave objects open for
 *   the fields v1 may gain.
 * - Each month file holds every point of its month's Runs, each equal to
 *   the Derivations' (each Method's, under its key) with what the design
 *   adds (its Run file's sha256, evidence and boot_summary) and, for
 *   requests v1, group_through as it stood through the Run (null before the
 *   Series' first Run of a second group, where the Derivation's is the
 *   point's through); and every one of series v1's entries for a pair of
 *   consecutive Runs whose later Run started that month. Each Run of a Series
 *   is in exactly one month file, that of the month it started in; each
 *   entry for a pair is filed under the month of its later Run.
 * - Each Series file equals what the Derivations hold for its Series: its
 *   identity, its count of Runs and the starts of its oldest and newest Run;
 *   newest_runs, the design's 12; its months, exactly the month files of the
 *   tree, each with its address, count of Runs and oldest and newest start;
 *   under derivations, one key per Method that derives the Series, and under
 *   each the Method's words and its summary, value for value (the
 *   percentiles and groups without their lists of Runs; counted and failed
 *   Runs counted from the points); and the points of the newest 12 Runs,
 *   equal to the same points in the month files and to the Derivations'.
 * - What a Series file leaves out is recoverable from its month files: the
 *   Runs behind each of series v1's percentiles are the counted points (of
 *   the group), with a bytes_per_repetition for bytes per second; a group's
 *   Runs are the points of its letter, under either Method.
 * - Each point's evidence is that point's: the Run file at its path is in
 *   the checkout, has the point's Run id and boot, and hashes to its sha256;
 *   evidence is that path's address; boot_summary is the address of the one
 *   boot summary in the checkout that names that boot, or null when none
 *   does. Each Run file the list gives as unreadable is in the checkout with
 *   its sha256, named by its id, at the address its evidence gives.
 * - The list's words for each Method are its file of Derivations' (the
 *   unreadable Run files sorted by path, with their evidence; series v1's
 *   sections sorted by name); its count and newest Run are right; it has one
 *   row per Series, in the order of benchmark, instance type, zone ID,
 *   params, build; and each row's url is the address of the file of its id,
 *   and agrees with that file on every field they share.
 * - The table of contents lists exactly the price files and the schemas the
 *   tree holds, with the newest price file marked, counts the Series right,
 *   gives every address as the base and the file's path, and gives the docs
 *   as an absolute https address with a host.
 * - Every link field, in its place in the files, names a file under the
 *   base: under v1/ a file of the tree, under runs/ or boots/ a file of the
 *   checkout. Only the blob address template is not a file; it is checked to
 *   be exactly the base and /blobs/sha256/{hex}. Strings elsewhere, such as a
 *   Run's parameters, are data and are not read as links.
 * - Each price file is byte for byte the checkout's.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

import type { DerivationsFile as RequestsFile } from "../../methods/requests/v1/output";
import type { DerivationsFile as SeriesFile } from "../../methods/v1/output";
import { PRICE_FILE_PATH } from "./prices";
import { parseStrictJson } from "./strict-json";

export interface CheckSources {
	/** The directory the tree was written to: it holds v1/. */
	tree: string;
	/** The Runs repository checkout the tree's evidence is checked against. */
	runs: string;
	base: string;
	series: SeriesFile;
	requests: RequestsFile;
}

export interface CheckResult {
	problems: string[];
	files: number;
	series: number;
	/** Month files read. */
	months: number;
	/** Distinct Run files found in the checkout, read and hashed. */
	runFiles: number;
}

type Json = Record<string, unknown>;

const ROOT = resolve(import.meta.dir, "..", "..");

// The tree's layout, as ADR-0030 gives it.
const INDEX = "v1/index.json";
const LIST = "v1/series.json";
const seriesFile = (id: string): string => `v1/series/${id}.json`;
const monthFile = (id: string, month: string): string => `v1/series/${id}/${month}.json`;
const priceFile = (date: string): string => `v1/prices/${date}.json`;
const schemaFile = (name: string): string => `v1/schemas/${name}.schema.json`;
/** The schemas the tree serves, in the table of contents' order: the files each describes, and the file of this repository it is. */
const SCHEMAS = [
	{ name: "index", describes: "v1/index.json", source: "schemas/api/v1/index.schema.json", closed: true },
	{ name: "series-list", describes: "v1/series.json", source: "schemas/api/v1/series-list.schema.json", closed: true },
	{ name: "series", describes: "v1/series/<id>.json", source: "schemas/api/v1/series.schema.json", closed: true },
	{ name: "series-month", describes: "v1/series/<id>/<yyyy-mm>.json", source: "schemas/api/v1/series-month.schema.json", closed: true },
	{ name: "prices", describes: "v1/prices/<yyyy-mm-dd>.json", source: "schemas/prices.schema.json", closed: false },
] as const;
type SchemaName = (typeof SCHEMAS)[number]["name"];
const SERIES_PATH = /^v1\/series\/([^/]+)\.json$/;
const MONTH_PATH = /^v1\/series\/([^/]+)\/([^/]+)\.json$/;
const TREE_PRICE = /^v1\/prices\/([0-9]{4})-([0-9]{2})-([0-9]{2})\.json$/;
const SCHEMA_PATH = /^v1\/schemas\/[^/]+\.schema\.json$/;
/** A Run's start as the Run schema writes it: UTC, to the nanosecond; its first seven characters are its month. */
const STARTED_AT = /^([0-9]{4}-(?:0[1-9]|1[0-2]))-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{9}Z$/;

/** How many of a Series' newest Runs its Series file repeats the points of, by the design. */
const NEWEST_RUNS = 12;

/** At most this many points of one Method's part are reported as differing; then how many more. */
const POINTS_SHOWN = 10;

/**
 * The most bytes a file of each kind may hold, chosen from the data of
 * 2026-11-19 with room to spare, and what to do when one is hit. A ceiling is
 * there to say a file has outgrown what a reader, an agent above all, should
 * fetch in one request: raise it only once that is decided, not to make the
 * check pass.
 */
export const CEILINGS: ReadonlyArray<{ kind: string; path: RegExp; bytes: number; whenHit: string }> = [
	{
		kind: "the table of contents",
		path: /^v1\/index\.json$/,
		bytes: 100_000,
		whenHit:
			"it was 4.9 KB with 9 price files on 2026-11-19, and each day's price file adds 124 bytes to its list, which brings it here about two years on; listing the price files by month, as the Series are, changes v1's shape (v2), so decide that with the maintainer",
	},
	{
		kind: "the list of Series",
		path: /^v1\/series\.json$/,
		bytes: 1_000_000,
		whenHit:
			"a row is about 1 KB, so this is about 950 Series; splitting the list (by benchmark, say) changes what v1/series.json holds, a v2 change, so decide it with the maintainer",
	},
	{
		kind: "a Series file",
		path: SERIES_PATH,
		bytes: 1_000_000,
		whenHit:
			"it does not grow with its Runs (302 KB at most, for http_get, on 2026-11-19), so its newest points or its summary grew: more samples or requests per Run, more groups, more values of a request fact; find which, and lower newest_runs or move the part that grew to the month files before raising this",
	},
	{
		kind: "a month file",
		path: MONTH_PATH,
		bytes: 5_000_000,
		whenHit:
			"a full month at four Runs a day is about 2.7 MB for http_get (up to 22 KB a Run on 2026-11-19) and 0.56 MB for the others (up to 4.5 KB a Run); more Runs a day or larger points brought it here: a smaller unit than a month is a v2 change, so decide with the maintainer whether to raise this or split",
	},
	{
		kind: "a price file",
		path: TREE_PRICE,
		bytes: 1_000_000,
		whenHit: "it is the Runs repository's price file, byte for byte (39 KB on 2026-11-19): the price rules (scripts/lib/price-rules.ts) now keep far more records; look there first",
	},
	{
		kind: "a schema",
		path: SCHEMA_PATH,
		bytes: 256_000,
		whenHit: "the largest is 32 KB: a schema this large is past what a reader takes in; split what it describes into $defs it shares, or ask why it grew",
	},
];

/**
 * A schema with every object that lists its properties, and says nothing of
 * others, closed to others: what the check validates the API's own files
 * against, so that every field they hold is one the schema describes.
 */
export function closeSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(closeSchema);
	if (typeof schema !== "object" || schema === null) return schema;
	const out: Json = {};
	for (const [key, value] of Object.entries(schema as Json)) out[key] = key === "const" || key === "enum" ? value : closeSchema(value);
	if (isObject(out.properties) && !("additionalProperties" in out) && !("patternProperties" in out) && !("unevaluatedProperties" in out)) out.additionalProperties = false;
	return out;
}

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** JSON with every object's keys in JavaScript's default string order, by UTF-16 code unit: one text for one value, whatever order its members came in. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isObject(value)) {
		return `{${Object.keys(value)
			.sort(byText)
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** An absolute https address with a host and no user name or password, as WHATWG's URL parser reads it. */
export function isHttpsAddress(value: unknown): boolean {
	if (typeof value !== "string" || !URL.canParse(value)) return false;
	const url = new URL(value);
	return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "" && value.toLowerCase().startsWith(`https://${url.host}`);
}

/** A value as a problem shows it: its JSON, cut short. */
function show(value: unknown): string {
	if (value === undefined) return "absent";
	const text = JSON.stringify(value);
	return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** A name as a problem shows it: as it is when it is a string. */
const named = (value: unknown): string => (typeof value === "string" ? value : show(value));

const pointer = (at: string, key: string | number): string => `${at}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;

/**
 * Where a value read from the tree first differs from the value expected of
 * it, as a JSON Pointer with what each holds there; null when they are the
 * same value. Objects are compared member by member, whatever their order;
 * arrays item by item; strings, numbers, booleans and null by value. Both
 * sides are parsed JSON, so a number is the same number only when it was
 * written with the same value.
 */
export function difference(actual: unknown, expected: unknown, at = ""): string | null {
	const here = at === "" ? "/" : at;
	if (Array.isArray(expected) || Array.isArray(actual)) {
		if (!Array.isArray(actual) || !Array.isArray(expected)) return `${here} is ${show(actual)}, not ${show(expected)}`;
		for (let i = 0; i < Math.min(actual.length, expected.length); i++) {
			const found = difference(actual[i], expected[i], pointer(at, i));
			if (found !== null) return found;
		}
		return actual.length === expected.length ? null : `${here} has ${actual.length} items, not ${expected.length}`;
	}
	if (isObject(expected) || isObject(actual)) {
		if (!isObject(actual) || !isObject(expected)) return `${here} is ${show(actual)}, not ${show(expected)}`;
		for (const key of Object.keys(expected)) {
			if (!Object.hasOwn(actual, key)) return `${pointer(at, key)} is absent, not ${show(expected[key])}`;
			const found = difference(actual[key], expected[key], pointer(at, key));
			if (found !== null) return found;
		}
		for (const key of Object.keys(actual)) if (!Object.hasOwn(expected, key)) return `${pointer(at, key)} is ${show(actual[key])}, where nothing is expected`;
		return null;
	}
	return actual === expected ? null : `${here} is ${show(actual)}, not ${show(expected)}`;
}

/** Every file under directory, by its path from it with forward slashes, in path order. */
function listFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => !entry.isDirectory())
		.map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort(byText);
}

/** A path inside a directory: relative, forward slashes, no empty, "." or ".." parts. */
function isInside(path: string): boolean {
	return path.length > 0 && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** The name of the file at path, without .json. */
const fileName = (path: string): string => (path.split("/").pop() ?? "").replace(/\.json$/, "");

/** The files a schema's `describes` names, as a pattern: each <placeholder> one path segment's worth of characters. */
function describedBy(describes: string): RegExp {
	const parts = describes.split(/<[^>]+>/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`^${parts.join("[^/]+")}$`);
}

/** A Run file as the checkout holds it: the sha256 of its bytes, and what they parse to, if JSON. */
interface RunFileRead {
	sha256: string;
	record: unknown;
}

type SeriesDerivation = SeriesFile["derivations"][number];
type RequestsDerivation = RequestsFile["derivations"][number];
type CitedRun = SeriesDerivation["runs"][number];
type AnyPoint = SeriesDerivation["points"][number] | RequestsDerivation["points"][number];

export function checkApi(sources: CheckSources): CheckResult {
	const problems: string[] = [];
	const base = sources.base.replace(/\/+$/, "");
	const address = (path: string): string => `${base}/${path}`;
	const files = listFiles(sources.tree);
	const held = new Set(files);
	const read = (path: string): Buffer => readFileSync(join(sources.tree, ...path.split("/")));
	/** Files of the tree that could not be read: their links are not known, so which files are reached is not either. */
	let unreadable = 0;
	/** A file of the tree, read as strictly as its strictest reader would, every number exactly (strict-json.ts); undefined, and a problem, when it cannot be. */
	const parse = (path: string): unknown => {
		try {
			return parseStrictJson(read(path), { exactNumbers: true });
		} catch (error) {
			problems.push(`${path} is not strict JSON: ${error instanceof Error ? error.message : String(error)}`);
			unreadable++;
			return undefined;
		}
	};
	/** A problem for each member of `actual` that differs from the same member of `expected`, the members `expected` gives. */
	const compare = (where: string, actual: Json, expected: Json, against: string): void => {
		for (const [key, value] of Object.entries(expected)) {
			const found = difference(actual[key], value, `/${key}`);
			if (found !== null) problems.push(`${where}: ${found}, as ${against}`);
		}
	};
	/** A problem when an object's members are not exactly these. */
	const members = (where: string, value: Json, keys: readonly string[]): void => {
		const missing = keys.filter((key) => !Object.hasOwn(value, key));
		const extra = Object.keys(value).filter((key) => !keys.includes(key));
		if (missing.length > 0) problems.push(`${where} lacks ${missing.join(", ")}`);
		if (extra.length > 0) problems.push(`${where} holds ${extra.join(", ")}, which it should not`);
	};

	// The Derivations, by Series, and whether they hold together as the build requires.
	const seriesV1 = new Map<string, SeriesDerivation>();
	for (const derivation of sources.series.derivations) {
		if (seriesV1.has(derivation.series.id)) problems.push(`series v1's Derivations have Series ${derivation.series.id} twice`);
		seriesV1.set(derivation.series.id, derivation);
	}
	const requestsV1 = new Map<string, RequestsDerivation>();
	for (const derivation of sources.requests.derivations) {
		const id = derivation.series.id;
		if (requestsV1.has(id)) problems.push(`requests v1's Derivations have Series ${id} twice`);
		requestsV1.set(id, derivation);
		const other = seriesV1.get(id);
		if (other === undefined) problems.push(`requests v1's Derivations have Series ${id}, which series v1's, deriving every Series, do not`);
		else {
			if (canonical(other.runs) !== canonical(derivation.runs)) problems.push(`series v1 and requests v1 cite different Runs for Series ${id}`);
			if (canonical(other.series) !== canonical(derivation.series)) problems.push(`series v1 and requests v1 describe Series ${id} differently`);
		}
	}
	const ids = [...new Set([...seriesV1.keys(), ...requestsV1.keys()])].sort(byText);
	/** Each Series' Derivation that gives its identity and its Runs: series v1's, which derives every Series. */
	const lead = (id: string): SeriesDerivation | RequestsDerivation => (seriesV1.get(id) ?? requestsV1.get(id)) as SeriesDerivation | RequestsDerivation;
	const span = new Map<string, { oldest: string; newest: string }>();
	/** Each Series' months, in order: each the indexes of the Derivation's points whose Run started that month, in the Derivation's order. */
	const monthsOf = new Map<string, Map<string, number[]>>();
	let newest: string | null = null;
	for (const id of ids) {
		const points = lead(id).points;
		const starts = points.map((point) => point.started_at).sort(byText);
		if (starts.length === 0) {
			problems.push(`Series ${id} has no Run in its Derivation`);
			continue;
		}
		const oldest = starts[0] as string;
		const latest = starts[starts.length - 1] as string;
		span.set(id, { oldest, newest: latest });
		if (newest === null || byText(latest, newest) > 0) newest = latest;
		const months = new Map<string, number[]>();
		points.forEach((point, i) => {
			const month = STARTED_AT.exec(point.started_at)?.[1];
			if (month === undefined) {
				problems.push(`Series ${id}: the Derivation's point ${i} started at ${show(point.started_at)}, not a Run's start as the Run schema writes it`);
				return;
			}
			months.set(month, [...(months.get(month) ?? []), i]);
		});
		monthsOf.set(id, new Map([...months].sort(([a], [b]) => byText(a, b))));
	}

	// The files the tree should hold, and no others.
	const checkoutPrices = listFiles(join(sources.runs, "prices"))
		.map((path) => `prices/${path}`)
		.filter((path) => PRICE_FILE_PATH.test(path));
	const dateOf = (path: string): string => path.replace(PRICE_FILE_PATH, "$1-$2-$3");
	const ofWhich = (id: string): string => (seriesV1.has(id) ? "series v1" : "requests v1");
	const expected = new Map<string, string>([
		[INDEX, "the table of contents"],
		[LIST, "the list of Series"],
		...SCHEMAS.map(({ name }) => [schemaFile(name), `the schema ${name}`] as [string, string]),
		...ids.map((id) => [seriesFile(id), `Series ${id} of ${ofWhich(id)}`] as [string, string]),
		...ids.flatMap((id) => [...(monthsOf.get(id)?.keys() ?? [])].map((month) => [monthFile(id, month), `the month ${month} of Series ${id}`] as [string, string])),
		...checkoutPrices.map((path) => [priceFile(dateOf(path)), `the price file ${path}`] as [string, string]),
	]);
	for (const [path, what] of expected) if (!held.has(path)) problems.push(`${path} is missing: ${what} has no file in the tree`);
	for (const path of files) {
		if (expected.has(path)) continue;
		const series = SERIES_PATH.exec(path);
		const month = MONTH_PATH.exec(path);
		if (series) problems.push(`${path} is in the tree, but Series ${series[1]} is in neither file of Derivations`);
		else if (month && monthsOf.has(month[1] as string)) problems.push(`${path} is in the tree, but no Run of Series ${month[1]} started in ${month[2]}`);
		else if (month) problems.push(`${path} is in the tree, but Series ${month[1]} is in neither file of Derivations`);
		else problems.push(`${path} is in the tree, but is no file the tree should hold`);
	}

	// No file over its kind's ceiling.
	for (const path of files) {
		const ceiling = CEILINGS.find((kind) => kind.path.test(path));
		if (ceiling === undefined) continue;
		const size = statSync(join(sources.tree, ...path.split("/"))).size;
		if (size > ceiling.bytes) problems.push(`${path} is ${size} bytes, over the ceiling of ${ceiling.bytes} for ${ceiling.kind}: ${ceiling.whenHit}`);
	}

	// The schemas: this repository's, byte for byte in the tree, each a valid JSON Schema; and this repository's are what every file is validated against.
	const ajv = new Ajv2020({ strict: true, allErrors: true });
	const validators = new Map<SchemaName, ValidateFunction>();
	for (const { name, source, closed } of SCHEMAS) {
		const bytes = readFileSync(join(ROOT, source));
		if (held.has(schemaFile(name))) {
			if (!read(schemaFile(name)).equals(bytes)) problems.push(`${schemaFile(name)} is not byte for byte ${source} of this repository`);
			const published = parse(schemaFile(name));
			if (published !== undefined && !ajv.validateSchema(published as object)) {
				problems.push(`${schemaFile(name)} is not a valid JSON Schema: ${ajv.errorsText(ajv.errors)}`);
			}
		}
		try {
			const schema: unknown = parseStrictJson(bytes, { exactNumbers: true });
			validators.set(name, ajv.compile((closed ? closeSchema(schema) : schema) as object));
		} catch (error) {
			problems.push(`${source} of this repository is not a schema the check can use: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const validate = (path: string, value: unknown, name: SchemaName): void => {
		const validator = validators.get(name);
		if (validator === undefined || validator(value)) return;
		const errors = (validator.errors ?? []).slice(0, 5).map((error) => {
			const extra = (error.params as { additionalProperty?: string }).additionalProperty;
			return `${error.instancePath || "/"} ${error.message ?? "is invalid"}${extra === undefined ? "" : `: ${extra}`}`;
		});
		problems.push(`${path} does not match ${schemaFile(name)}: ${errors.join("; ")}${(validator.errors?.length ?? 0) > 5 ? `; and ${(validator.errors?.length ?? 0) - 5} more` : ""}`);
	};

	// Link fields: each names a file under the base, checked once per address; and each link to a file of the tree is a step a reader can take from the file that holds it.
	const linked = new Set<string>();
	const steps = new Map<string, Set<string>>();
	const link = (from: string, url: unknown, { mustBeUnderBase = true } = {}): void => {
		if (typeof url !== "string") return; // the schema says what type it must be
		const under = url.startsWith(`${base}/`);
		const path = under ? url.slice(base.length + 1) : "";
		if (under && held.has(path)) {
			let next = steps.get(from);
			if (next === undefined) {
				next = new Set();
				steps.set(from, next);
			}
			next.add(path);
		}
		if (linked.has(url)) return;
		if (!under && !mustBeUnderBase) return;
		linked.add(url);
		if (!under) problems.push(`${from} links ${url}, which is not under the base ${base}`);
		else if (path.startsWith("v1/")) {
			if (!held.has(path)) problems.push(`${from} links ${url}, which is not a file of the tree`);
		} else if (path.startsWith("runs/") || path.startsWith("boots/")) {
			const full = join(sources.runs, ...path.split("/"));
			if (!isInside(path) || !existsSync(full) || !statSync(full).isFile()) problems.push(`${from} links ${url}, which is not a file of the Runs repository checkout ${sources.runs}`);
		} else problems.push(`${from} links ${url}, under the base but neither in the tree nor evidence`);
	};

	// The evidence, as the checkout holds it.
	const runFiles = new Map<string, RunFileRead | null>();
	const openRun = (path: string): RunFileRead | null => {
		let found = runFiles.get(path);
		if (found === undefined) {
			const full = join(sources.runs, ...path.split("/"));
			if (!isInside(path) || !path.startsWith("runs/") || !existsSync(full) || !statSync(full).isFile()) found = null;
			else {
				const bytes = readFileSync(full);
				let record: unknown;
				try {
					record = JSON.parse(bytes.toString("utf8"));
				} catch {
					record = undefined;
				}
				found = { sha256: createHash("sha256").update(bytes).digest("hex"), record };
			}
			runFiles.set(path, found);
		}
		return found;
	};
	/** Each boot summary in the checkout, by the boot it names (its own `boot`, not its file name). */
	const summaries = new Map<string, string[]>();
	for (const path of listFiles(join(sources.runs, "boots")).map((name) => `boots/${name}`)) {
		if (!path.endsWith(".json")) continue;
		let summary: unknown;
		try {
			summary = JSON.parse(readFileSync(join(sources.runs, ...path.split("/")), "utf8"));
		} catch {
			continue;
		}
		if (!isObject(summary) || typeof summary.boot !== "string") continue;
		summaries.set(summary.boot, [...(summaries.get(summary.boot) ?? []), path]);
	}
	const twice = new Set<string>();
	/** The address of a boot's summary: null when the checkout has none; undefined, and a problem once, when it has two. */
	const summaryOf = (boot: string): string | null | undefined => {
		const paths = summaries.get(boot) ?? [];
		if (paths.length > 1) {
			if (!twice.has(boot)) problems.push(`the Runs repository checkout ${sources.runs} holds two summaries of boot ${boot}: ${paths.join(" and ")}`);
			twice.add(boot);
			return undefined;
		}
		return paths.length === 0 ? null : address(paths[0] as string);
	};

	/** A point's evidence is its own: its Run file's id, boot and sha256, the address of its path, and its boot's summary. */
	const checkEvidence = (where: string, point: Json): void => {
		const { run, path, sha256, evidence, boot, boot_summary: bootSummary } = point;
		if (typeof path !== "string" || typeof run !== "string") return; // the schema says so
		if (evidence !== address(path)) problems.push(`${where}: evidence is ${named(evidence)}, not ${address(path)}, the address of its path`);
		const file = openRun(path);
		if (file === null) {
			problems.push(`${where}: evidence ${String(evidence)} names a Run file that is not in the Runs repository checkout ${sources.runs}`);
			checkSummary(where, boot, bootSummary);
			return;
		}
		if (file.sha256 !== sha256) problems.push(`${where}: the Run file ${path} in the checkout has sha256 ${file.sha256}, not ${String(sha256)}`);
		const record = isObject(file.record) ? file.record : {};
		if (record.id !== run) problems.push(`${where}: the Run file ${path} in the checkout is Run ${named(record.id)}, not ${run}`);
		if (record.boot !== boot) problems.push(`${where}: the Run file ${path} in the checkout is of boot ${named(record.boot)}, not ${named(boot)}`);
		checkSummary(where, typeof record.boot === "string" ? record.boot : boot, bootSummary);
	};
	/** A point's boot_summary is the address of its boot's one summary in the checkout, or null when there is none. */
	const checkSummary = (where: string, boot: unknown, bootSummary: unknown): void => {
		if (typeof boot !== "string") return; // the schema says so
		const summary = summaryOf(boot);
		if (summary === undefined || bootSummary === summary) return;
		if (summary === null) problems.push(`${where}: boot_summary is ${named(bootSummary)}, but the checkout ${sources.runs} holds no summary of boot ${boot}`);
		else problems.push(`${where}: boot_summary is ${named(bootSummary)}, not ${summary}, the address of the summary of boot ${boot}`);
	};
	/** An unreadable Run file is in the checkout with its sha256, named by its id, at its evidence. */
	const checkUnreadable = (where: string, run: Json): void => {
		const { id, path, sha256, evidence } = run;
		if (typeof path !== "string") return; // the schema says so
		if (evidence !== address(path)) problems.push(`${where}: evidence is ${named(evidence)}, not ${address(path)}, the address of its path`);
		if (id !== fileName(path)) problems.push(`${where}: its id is ${named(id)}, but its Run file is named ${fileName(path)}.json`);
		const file = openRun(path);
		if (file === null) problems.push(`${where}: evidence ${String(evidence)} names a Run file that is not in the Runs repository checkout ${sources.runs}`);
		else if (file.sha256 !== sha256) problems.push(`${where}: the Run file ${path} in the checkout has sha256 ${file.sha256}, not ${String(sha256)}`);
	};

	// The table of contents.
	/** The schemas the table of contents lists; undefined when it could not be read. */
	let listedSchemas: Json[] | undefined;
	if (held.has(INDEX)) {
		const index = parse(INDEX);
		if (index !== undefined) {
			validate(INDEX, index, "index");
			const value = isObject(index) ? index : {};
			if (value.url !== address(INDEX)) problems.push(`${INDEX} says its address is ${String(value.url)}, not ${address(INDEX)}: the tree was built for another base`);
			const prices = files
				.map((path) => TREE_PRICE.exec(path))
				.filter((match): match is RegExpExecArray => match !== null)
				.map((match) => ({ date: `${match[1]}-${match[2]}-${match[3]}`, path: `prices/${match[1]}/${match[2]}/${match[3]}/aws.json`, url: address(match[0]) }));
			const ofIndex = (key: string): Json => (isObject(value[key]) ? value[key] : {});
			compare(
				INDEX,
				value,
				{
					schema: "ledgermath.api.index/1",
					schema_url: address(schemaFile("index")),
					newest_run_started_at: newest,
					series: {
						url: address(LIST),
						schema_url: address(schemaFile("series-list")),
						count: ids.length,
						series_file_schema_url: address(schemaFile("series")),
						month_file_schema_url: address(schemaFile("series-month")),
					},
					schemas: SCHEMAS.filter(({ name }) => held.has(schemaFile(name))).map(({ name, describes }) => ({ name, describes, url: address(schemaFile(name)) })),
				},
				"the tree and the Derivations make it",
			);
			const ofPrices = ofIndex("prices");
			compare(`${INDEX}: prices`, ofPrices, { schema_url: address(schemaFile("prices")), files: prices, newest: prices[prices.length - 1] ?? null }, "the price files in the tree make it");
			const ofEvidence = ofIndex("evidence");
			if (ofEvidence.blob_url_template !== `${base}/blobs/sha256/{hex}`) {
				problems.push(`${INDEX}: evidence.blob_url_template is ${show(ofEvidence.blob_url_template)}, not ${base}/blobs/sha256/{hex}`);
			}
			const ofSeries = ofIndex("series");
			for (const url of [value.schema_url, value.url, ofSeries.url, ofSeries.schema_url, ofSeries.series_file_schema_url, ofSeries.month_file_schema_url, ofPrices.schema_url]) link(INDEX, url);
			if (isObject(ofPrices.newest)) link(INDEX, ofPrices.newest.url);
			for (const entry of Array.isArray(ofPrices.files) ? ofPrices.files : []) if (isObject(entry)) link(INDEX, entry.url);
			listedSchemas = (Array.isArray(value.schemas) ? value.schemas : []).filter(isObject);
			for (const entry of listedSchemas) link(INDEX, entry.url);
			// The schema's pattern says what an address for the docs is written as; WHATWG's URL parser must read it as https with a host too.
			if (!isHttpsAddress(value.docs)) problems.push(`${INDEX}: docs is ${show(value.docs)}, not an absolute https address with a host`);
			link(INDEX, value.docs, { mustBeUnderBase: false });
		}
	}
	// Every file of the tree is of a kind one schema the table of contents lists describes, or is one of those schemas.
	if (listedSchemas !== undefined) {
		const kinds = listedSchemas.filter((entry) => typeof entry.describes === "string").map((entry) => ({ name: String(entry.name), pattern: describedBy(entry.describes as string) }));
		const schemaFiles = new Set(listedSchemas.map((entry) => (typeof entry.url === "string" && entry.url.startsWith(`${base}/`) ? entry.url.slice(base.length + 1) : "")));
		for (const path of files) {
			if (schemaFiles.has(path)) continue;
			if (SCHEMA_PATH.test(path)) {
				problems.push(`${path} is a schema, but ${INDEX} does not list it`);
				continue;
			}
			const by = kinds.filter((kind) => kind.pattern.test(path)).map((kind) => kind.name);
			if (by.length === 0) problems.push(`${path} is of no kind of file a schema listed in ${INDEX} describes`);
			else if (by.length > 1) problems.push(`${path} is described by ${by.length} schemas listed in ${INDEX}: ${by.join(", ")}`);
		}
	}

	/** A Derivation's point as the tree writes it: with its Run file's sha256 after its path, without evidence and boot_summary (checkEvidence sees to those), and requests v1's group_through as it stood through the Run. */
	const expectedPoints = (id: string, name: string, method: SeriesDerivation | RequestsDerivation): Array<Json | undefined> => {
		const first = method.points.findIndex((point) => point.group !== method.points[0]?.group);
		return method.points.map((derived: AnyPoint, i) => {
			const cited: CitedRun | undefined = method.runs[i];
			if (cited === undefined || cited.id !== derived.run || cited.path !== derived.path) {
				problems.push(`${name}'s Derivation of Series ${id} cites another Run at ${i} than its point ${i}`);
				return undefined;
			}
			const point: Json = { ...derived, sha256: cited.sha256 };
			if ("group_through" in derived && first >= 0 && i < first) {
				// Before the Series' first Run of a second group the tree writes null: the Derivation's value must then be its through, or the tree would lose it.
				if (canonical(derived.group_through) !== canonical(derived.through)) {
					problems.push(`${name}'s Derivation of Series ${id} holds, at point ${i}, before the Series' first Run of a second group, a group_through other than its through: the tree's null would lose it`);
				}
				point.group_through = null;
			}
			return point;
		});
	};
	/** Points read from the tree against the points expected of them, each compared without evidence and boot_summary; and each point's evidence. */
	const comparePoints = (where: string, file: string, read: unknown[], want: Array<Json | undefined>, against: string, offset = 0): void => {
		if (read.length !== want.length) problems.push(`${where}: /points has ${read.length} items, not ${want.length}, as ${against}`);
		let differing = 0;
		read.forEach((point, i) => {
			const expectedPoint = want[i];
			if (!isObject(point) || expectedPoint === undefined) return;
			const { evidence: _evidence, boot_summary: _bootSummary, ...own } = point;
			const found = difference(own, expectedPoint);
			if (found !== null && ++differing <= POINTS_SHOWN) problems.push(`${where}: point ${i + offset}: ${found}, as ${against}`);
			checkEvidence(`${where}'s point ${String(point.run)}`, point);
			link(file, point.evidence);
			if (point.boot_summary !== null) link(file, point.boot_summary);
		});
		if (differing > POINTS_SHOWN) problems.push(`${where}: and ${differing - POINTS_SHOWN} more points differ`);
	};
	const summaryOfStat = (stat: unknown): unknown => {
		if (!isObject(stat)) return stat;
		const { count, p5, p50, p95 } = stat;
		return { count, p5, p50, p95 };
	};
	const percentileSummaries = (percentiles: SeriesDerivation["percentiles"]): Json => ({
		time_per_repetition_ns: summaryOfStat(percentiles.time_per_repetition_ns),
		bytes_per_second: summaryOfStat(percentiles.bytes_per_second),
	});
	const counts = (points: readonly AnyPoint[]): Json => {
		const counted = points.filter((point) => point.counted).length;
		return { counted_runs: counted, failed_runs: points.length - counted };
	};

	// The month files and the Series files, each against its Derivations; and what its row should say, read from the Series file.
	const rowsOfFiles = new Map<string, Json>();
	let seriesFiles = 0;
	let monthFiles = 0;
	for (const id of ids) {
		const derivation = lead(id);
		const ofSeries = seriesV1.get(id);
		const ofRequests = requestsV1.get(id);
		const months = monthsOf.get(id) ?? new Map<string, number[]>();
		const methods: Array<{ key: string; name: string; method: SeriesDerivation | RequestsDerivation }> = [
			...(ofSeries === undefined ? [] : [{ key: "series_v1", name: "series v1", method: ofSeries }]),
			...(ofRequests === undefined ? [] : [{ key: "requests_v1", name: "requests v1", method: ofRequests }]),
		];
		const identity = {
			benchmark: derivation.series.benchmark,
			params: derivation.series.params,
			build: derivation.series.build,
			instance_type: derivation.series.instance_type,
			availability_zone_id: derivation.series.availability_zone_id,
		};
		const wanted = new Map(methods.map(({ key, name, method }) => [key, expectedPoints(id, name, method)] as const));
		/** Each Method's points as the month files hold them, by Run id, with the months each is in; whether every month file was read. */
		const readPoints = new Map<string, Map<string, { point: Json; months: string[] }>>(methods.map(({ key }) => [key, new Map()] as const));
		const pointsInOrder = new Map<string, Json[]>(methods.map(({ key }) => [key, []] as const));
		let allMonthsRead = true;
		/** Months whose file is there but could not be read: their problems are reported, and their Runs are not reported again as in no month file. */
		const unread = new Set<string>();

		// Its month files: those the Derivations make, and any other the tree holds for it.
		const heldMonths = files
			.map((path) => MONTH_PATH.exec(path))
			.filter((match): match is RegExpExecArray => match !== null && match[1] === id)
			.map((match) => match[2] as string);
		for (const month of [...new Set([...months.keys(), ...heldMonths])].sort(byText)) {
			const path = monthFile(id, month);
			if (!held.has(path)) {
				allMonthsRead = false;
				continue;
			}
			const file = parse(path);
			if (file === undefined || !isObject(file)) {
				if (file !== undefined) validate(path, file, "series-month");
				allMonthsRead = false;
				unread.add(month);
				continue;
			}
			monthFiles++;
			validate(path, file, "series-month");
			const indexes = months.get(month) ?? [];
			const ofMonth = indexes.map((i) => derivation.points[i] as AnyPoint);
			compare(
				path,
				file,
				{
					schema: "ledgermath.api.series-month/1",
					schema_url: address(schemaFile("series-month")),
					index: address(INDEX),
					id,
					month,
					url: address(path),
					series_url: address(seriesFile(id)),
					...identity,
					runs: indexes.length,
					...(ofMonth.length === 0
						? {}
						: {
								oldest_run_started_at: ofMonth.map((point) => point.started_at).sort(byText)[0],
								newest_run_started_at: ofMonth.map((point) => point.started_at).sort(byText)[ofMonth.length - 1],
							}),
				},
				"its Derivations and the base make it",
			);
			for (const url of [file.schema_url, file.index, file.url, file.series_url]) link(path, url);
			const derivations = isObject(file.derivations) ? file.derivations : {};
			members(`${path}: derivations`, derivations, methods.map(({ key }) => key));
			for (const { key, name, method } of methods) {
				const block = derivations[key];
				if (!isObject(block)) {
					allMonthsRead = false;
					unread.add(month);
					continue;
				}
				const where = `${path}: ${key}`;
				members(where, block, key === "series_v1" ? ["method", "points", "differed"] : ["method", "points"]);
				compare(where, block, { method: key === "series_v1" ? sources.series.method : sources.requests.method }, `${name}'s file of Derivations holds it`);
				const points = Array.isArray(block.points) ? block.points : [];
				const want = wanted.get(key) as Array<Json | undefined>;
				comparePoints(where, path, points, indexes.map((i) => want[i]), `${name}'s Derivation of Series ${id} holds it for ${month}`);
				const byRun = readPoints.get(key) as Map<string, { point: Json; months: string[] }>;
				for (const point of points) {
					if (!isObject(point) || typeof point.run !== "string") continue;
					const known = byRun.get(point.run);
					if (known === undefined) byRun.set(point.run, { point, months: [month] });
					else known.months.push(month);
					(pointsInOrder.get(key) as Json[]).push(point);
				}
				if (key === "series_v1") {
					// The entry of a pair of consecutive Runs is filed under the month of its later Run.
					const series = method as SeriesDerivation;
					const startOf = new Map(series.points.map((point) => [point.run, point.started_at] as const));
					const filed = series.differed.filter((entry) => STARTED_AT.exec(startOf.get(entry.to) ?? "")?.[1] === month);
					const differed = Array.isArray(block.differed) ? block.differed : [];
					const found = difference(differed, filed, "/differed");
					if (found !== null) problems.push(`${where}: ${found}, as series v1's Derivation of Series ${id} holds the entries whose later Run started in ${month}`);
					for (const entry of differed) {
						if (!isObject(entry) || typeof entry.to !== "string") continue;
						const later = STARTED_AT.exec(startOf.get(entry.to) ?? "")?.[1];
						if (later !== month) problems.push(`${where}: the entry from ${named(entry.from)} to ${entry.to} is filed under ${month}, but ${entry.to} ${later === undefined ? "is no Run of the Series" : `started in ${later}`}: an entry is filed under the month of its later Run`);
					}
				}
			}
		}
		// Each Run of the Series is in exactly one month file, that of the month it started in.
		for (const { key, name, method } of methods) {
			const byRun = readPoints.get(key) as Map<string, { point: Json; months: string[] }>;
			const cited = new Set(method.points.map((point) => point.run));
			for (const point of method.points) {
				const month = STARTED_AT.exec(point.started_at)?.[1];
				const found = byRun.get(point.run);
				if (found === undefined) {
					if (month !== undefined && held.has(monthFile(id, month)) && !unread.has(month)) problems.push(`Series ${id}: ${name}'s Run ${point.run}, which started in ${month}, is in no month file`);
				} else if (found.months.length > 1) problems.push(`Series ${id}: ${name}'s Run ${point.run} is in ${found.months.length} month files: ${found.months.join(", ")}`);
				else if (found.months[0] !== month) problems.push(`Series ${id}: ${name}'s Run ${point.run} started in ${month ?? show(point.started_at)}, but is in the month file of ${found.months[0]}`);
			}
			for (const [run, { months: where }] of byRun) if (!cited.has(run)) problems.push(`Series ${id}: the month file of ${where.join(", ")} holds a ${name} point of Run ${run}, which its Derivation does not cite`);
		}
		// What the Series file leaves out is what its month files' points recover.
		if (allMonthsRead) {
			const runsOf = (points: readonly Json[]): string[] => points.map((point) => String(point.run));
			const recovered = (what: string, held: readonly string[] | undefined, points: readonly Json[], rule: string): void => {
				const found = difference(held ?? [], runsOf(points));
				if (found !== null) problems.push(`${seriesFile(id)}: ${what} lists other Runs in its Derivation than ${rule} of the month files (${found}), so the Series file cannot leave it out`);
			};
			if (ofSeries !== undefined) {
				const points = pointsInOrder.get("series_v1") as Json[];
				const timed = (members: Json[]) => members.filter((point) => point.counted === true);
				const bytes = (members: Json[]) => members.filter((point) => point.counted === true && point.bytes_per_repetition !== null);
				const stats = (label: string, percentiles: SeriesDerivation["percentiles"], members: Json[]): void => {
					recovered(`series v1's ${label}percentiles of time_per_repetition_ns`, percentiles.time_per_repetition_ns?.runs, timed(members), "the counted points");
					recovered(`series v1's ${label}percentiles of bytes_per_second`, percentiles.bytes_per_second?.runs, bytes(members), "the counted points with a bytes_per_repetition");
				};
				stats("", ofSeries.percentiles, points);
				for (const group of ofSeries.groups) {
					const ofGroup = points.filter((point) => point.group === group.id);
					recovered(`series v1's group ${group.id}`, group.runs, ofGroup, `the points of group ${group.id}`);
					stats(`group ${group.id}'s `, group.percentiles, ofGroup);
				}
			}
			if (ofRequests !== undefined) {
				const points = pointsInOrder.get("requests_v1") as Json[];
				for (const group of ofRequests.groups) recovered(`requests v1's group ${group.id}`, group.runs, points.filter((point) => point.group === group.id), `the points of group ${group.id}`);
			}
		}

		// The Series file.
		const path = seriesFile(id);
		if (!held.has(path)) continue;
		const file = parse(path);
		if (file === undefined) continue;
		seriesFiles++;
		validate(path, file, "series");
		if (!isObject(file)) continue;
		const times = span.get(id);
		const monthEntries = [...months].map(([month, indexes]) => {
			const starts = indexes.map((i) => (derivation.points[i] as AnyPoint).started_at).sort(byText);
			return { month, url: address(monthFile(id, month)), runs: indexes.length, oldest_run_started_at: starts[0], newest_run_started_at: starts[starts.length - 1] };
		});
		compare(
			path,
			file,
			{
				schema: "ledgermath.api.series/1",
				schema_url: address(schemaFile("series")),
				index: address(INDEX),
				id,
				url: address(path),
				...identity,
				runs: derivation.runs.length,
				...(times === undefined ? {} : { oldest_run_started_at: times.oldest, newest_run_started_at: times.newest }),
				newest_runs: NEWEST_RUNS,
				months: monthEntries,
			},
			"its Derivations and the base make it",
		);
		for (const url of [file.schema_url, file.index, file.url]) link(path, url);
		// Its months are exactly the month files the tree holds for it.
		const listed = (Array.isArray(file.months) ? file.months : []).filter(isObject);
		for (const entry of listed) link(path, entry.url);
		const listedPaths = new Set(listed.map((entry) => (typeof entry.url === "string" && entry.url.startsWith(`${base}/`) ? entry.url.slice(base.length + 1) : String(entry.url))));
		for (const month of heldMonths) if (!listedPaths.has(monthFile(id, month))) problems.push(`${path} does not list its month file ${monthFile(id, month)} among its months`);
		const derivations = isObject(file.derivations) ? file.derivations : {};
		members(`${path}: derivations`, derivations, methods.map(({ key }) => key));
		const parts: Record<string, Json> = {
			...(ofSeries === undefined
				? {}
				: {
						series_v1: {
							method: sources.series.method,
							definitions: sources.series.definitions,
							split_on: sources.series.split_on,
							left_out: sources.series.left_out,
							not_split_on: sources.series.not_split_on,
							...counts(ofSeries.points),
							percentiles: percentileSummaries(ofSeries.percentiles),
							groups: ofSeries.groups.map((group) => ({ id: group.id, facts: group.facts, percentiles: percentileSummaries(group.percentiles) })),
							sections: ofSeries.sections,
						},
					}),
			...(ofRequests === undefined
				? {}
				: {
						requests_v1: {
							method: sources.requests.method,
							definitions: sources.requests.definitions,
							phases: sources.requests.phases,
							percentiles: sources.requests.percentiles,
							histogram: sources.requests.histogram,
							request_facts: sources.requests.request_facts,
							split_on: sources.requests.split_on,
							left_out: sources.requests.left_out,
							...counts(ofRequests.points),
							recorded: ofRequests.recorded,
							pool: ofRequests.pool,
							groups: ofRequests.groups.map((group) => ({ id: group.id, facts: group.facts, pool: group.pool })),
						},
					}),
		};
		for (const { key, name } of methods) {
			const block = derivations[key];
			if (!isObject(block)) continue;
			const where = `${path}: ${key}`;
			const expectedParts = parts[key] as Json;
			members(where, block, [...Object.keys(expectedParts), "newest_points"]);
			compare(where, block, expectedParts, `${name}'s Derivation of Series ${id} holds it`);
			// The newest points: the Derivation's last NEWEST_RUNS, and the same points, value for value, as the month files hold them.
			const newestPoints = Array.isArray(block.newest_points) ? block.newest_points : [];
			const want = wanted.get(key) as Array<Json | undefined>;
			const from = Math.max(want.length - NEWEST_RUNS, 0);
			comparePoints(`${where}: newest_points`, path, newestPoints, want.slice(from), `${name}'s Derivation of Series ${id} holds its newest ${NEWEST_RUNS}`, from);
			const byRun = readPoints.get(key) as Map<string, { point: Json; months: string[] }>;
			newestPoints.forEach((point: unknown, i: number) => {
				if (!isObject(point) || typeof point.run !== "string") return;
				const inMonth = byRun.get(point.run);
				if (inMonth === undefined) return; // reported above
				const found = difference(point, inMonth.point);
				if (found !== null) problems.push(`${where}: newest_points/${i}, Run ${point.run}, is not its point in the month file of ${inMonth.months[0]}: ${found}`);
			});
		}
		try {
			rowsOfFiles.set(id, rowOf(file));
		} catch {
			// The file is too broken to say what its row should be; its problems are reported above.
		}
	}

	// The list.
	if (held.has(LIST)) {
		const list = parse(LIST);
		if (list !== undefined) {
			validate(LIST, list, "series-list");
			const value = isObject(list) ? list : {};
			compare(
				LIST,
				value,
				{ schema: "ledgermath.api.series-list/1", schema_url: address(schemaFile("series-list")), index: address(INDEX), url: address(LIST), count: ids.length, newest_run_started_at: newest },
				"the tree and the Derivations make it",
			);
			for (const url of [value.schema_url, value.index, value.url]) link(LIST, url);
			const methods = isObject(value.methods) ? value.methods : {};
			members(`${LIST}: methods`, methods, ["series_v1", "requests_v1"]);
			const unreadable = (file: SeriesFile | RequestsFile) =>
				[...file.unreadable].sort((a, b) => byText(a.path, b.path)).map((run) => ({ ...run, evidence: address(run.path) }));
			const words: Array<[string, Json, string]> = [
				[
					"series_v1",
					{
						method: sources.series.method,
						definitions: sources.series.definitions,
						split_on: sources.series.split_on,
						left_out: sources.series.left_out,
						not_split_on: sources.series.not_split_on,
						runs_read: sources.series.runs_read,
						unreadable: unreadable(sources.series),
						sections: [...sources.series.sections].sort((a, b) => byText(a.section, b.section)),
					},
					"series v1's file of Derivations",
				],
				[
					"requests_v1",
					{
						method: sources.requests.method,
						definitions: sources.requests.definitions,
						phases: sources.requests.phases,
						percentiles: sources.requests.percentiles,
						histogram: sources.requests.histogram,
						request_facts: sources.requests.request_facts,
						split_on: sources.requests.split_on,
						left_out: sources.requests.left_out,
						runs_read: sources.requests.runs_read,
						unreadable: unreadable(sources.requests),
					},
					"requests v1's file of Derivations",
				],
			];
			for (const [key, expectedWords, against] of words) {
				const header = methods[key];
				if (!isObject(header)) continue;
				members(`${LIST}: methods.${key}`, header, Object.keys(expectedWords));
				compare(`${LIST}: methods.${key}`, header, expectedWords, `${against} holds it`);
				for (const run of Array.isArray(header.unreadable) ? header.unreadable : []) {
					if (!isObject(run)) continue;
					checkUnreadable(`${LIST}: ${key}'s unreadable Run ${String(run.id)}`, run);
					link(LIST, run.evidence);
				}
			}

			const rows = Array.isArray(value.series) ? value.series : [];
			const rowIds = new Set<string>();
			for (const row of rows) {
				const id = isObject(row) ? String(row.id) : "";
				if (rowIds.has(id)) problems.push(`${LIST} has Series ${id} twice`);
				rowIds.add(id);
				if (!seriesV1.has(id) && !requestsV1.has(id)) problems.push(`${LIST} has a row for Series ${id}, which is in neither file of Derivations`);
				if (!isObject(row)) continue;
				link(LIST, row.url);
				if (row.url !== address(seriesFile(id))) problems.push(`${LIST}: the row of Series ${id} has url ${show(row.url)}, not ${address(seriesFile(id))}, the address of its file`);
				const ofFile = rowsOfFiles.get(id);
				const found = ofFile === undefined ? null : difference(row, ofFile);
				if (found !== null) problems.push(`${LIST}: the row of Series ${id} differs from its file ${seriesFile(id)}: ${found}`);
			}
			for (const id of ids) if (!rowIds.has(id)) problems.push(`${LIST} has no row for Series ${id} of ${ofWhich(id)}`);
			const order = (id: string): string[] => {
				const { series } = lead(id);
				return [series.benchmark, series.instance_type ?? "", series.availability_zone_id ?? "", canonical(series.params), series.build, id];
			};
			const inOrder = ids
				.filter((id) => rowIds.has(id))
				.sort((a, b) => {
					const x = order(a);
					const y = order(b);
					for (let i = 0; i < x.length; i++) {
						const by = byText(x[i] as string, y[i] as string);
						if (by !== 0) return by;
					}
					return 0;
				});
			const listed = rows.map((row: unknown) => (isObject(row) ? String(row.id) : "")).filter((id: string) => inOrder.includes(id));
			if (listed.join("\n") !== inOrder.join("\n")) problems.push(`${LIST}: the rows are not in the order of benchmark, instance type, zone ID, params, build`);
		}
	}

	for (const path of checkoutPrices) {
		const at = priceFile(dateOf(path));
		if (!held.has(at)) continue;
		if (!read(at).equals(readFileSync(join(sources.runs, ...path.split("/"))))) problems.push(`${at} is not byte for byte ${path} of the checkout`);
		const value = parse(at);
		if (value !== undefined) validate(at, value, "prices");
	}

	// Every file is reached from the table of contents by following links: known only when every file could be read.
	if (held.has(INDEX) && unreadable === 0) {
		const reached = new Set([INDEX]);
		const queue = [INDEX];
		while (queue.length > 0) {
			for (const next of steps.get(queue.pop() as string) ?? []) {
				if (reached.has(next)) continue;
				reached.add(next);
				queue.push(next);
			}
		}
		for (const path of files) if (!reached.has(path)) problems.push(`${path} is in the tree, but no link leads to it from ${INDEX}`);
	}

	return { problems, files: files.length, series: seriesFiles, months: monthFiles, runFiles: [...runFiles.values()].filter((file) => file !== null).length };
}

/**
 * The row a Series file makes, by the design: every field the row shares
 * with the file, with the file's value, and each Method's summary made from
 * the file's own: its counts of counted and failed Runs, how many groups it
 * has, and its percentiles or pooled figures without the histograms behind
 * them.
 */
function rowOf(file: Json): Json {
	const derivations = file.derivations as Json;
	const series = derivations.series_v1 as Json;
	const row: Json = {
		id: file.id,
		url: file.url,
		benchmark: file.benchmark,
		params: file.params,
		build: file.build,
		instance_type: file.instance_type,
		availability_zone_id: file.availability_zone_id,
		runs: file.runs,
		oldest_run_started_at: file.oldest_run_started_at,
		newest_run_started_at: file.newest_run_started_at,
		derivations: {
			series_v1: {
				method: series.method,
				counted_runs: series.counted_runs,
				failed_runs: series.failed_runs,
				groups: (series.groups as unknown[]).length,
				percentiles: series.percentiles,
			},
		},
	};
	const requests = derivations.requests_v1 as Json | undefined;
	if (requests !== undefined) {
		const pool = requests.pool as Json;
		(row.derivations as Json).requests_v1 = {
			method: requests.method,
			counted_runs: requests.counted_runs,
			failed_runs: requests.failed_runs,
			groups: (requests.groups as unknown[]).length,
			pool: {
				runs: pool.runs,
				requests: pool.requests,
				failed: pool.failed,
				phases: Object.fromEntries(
					Object.entries(pool.phases as Json).map(([phase, pooled]) => {
						const { histogram: _histogram, ...stats } = pooled as Json;
						return [phase, stats];
					}),
				),
			},
		};
	}
	return row;
}

/**
 * Whether a tree keeps the promise its month files make (ADR-0030): once
 * written, a month file changes only when a Run of its month is added, or
 * when a point's boot summary arrives (boot_summary turns from null into an
 * address), and is never removed. Compares every month file of the tree a
 * reader was last served (`previous`) with the same file of this one; a file
 * of this tree that `previous` lacks is new, and passes. A problem for every
 * month file that changed otherwise: chiefly a Run that arrived after a later
 * Run of its Series, which changes its own month and the cumulative figures
 * (through, group_through, a group's letter) and pair entries of every later
 * month, as it changes the Derivations.
 */
export function checkStability(previous: string, tree: string): string[] {
	const problems: string[] = [];
	const months = (directory: string): string[] => listFiles(directory).filter((path) => MONTH_PATH.test(path));
	const now = new Set(months(tree));
	const read = (directory: string, path: string): unknown => {
		try {
			return parseStrictJson(readFileSync(join(directory, ...path.split("/"))), { exactNumbers: true });
		} catch (error) {
			problems.push(`${path} of ${directory} is not strict JSON: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	};
	/** Each Method's points of a month file, by key. */
	const pointsOf = (file: unknown): Map<string, Json[]> => {
		const derivations = isObject(file) && isObject(file.derivations) ? file.derivations : {};
		return new Map(Object.entries(derivations).map(([key, block]) => [key, (isObject(block) && Array.isArray(block.points) ? block.points : []).filter(isObject)] as const));
	};
	for (const path of months(previous)) {
		if (!now.has(path)) {
			problems.push(`${path} was in the previous tree and is not in this one: a month file, once written, stays`);
			continue;
		}
		const before = readFileSync(join(previous, ...path.split("/")));
		if (before.equals(readFileSync(join(tree, ...path.split("/"))))) continue;
		const was = read(previous, path);
		const is = read(tree, path);
		if (was === undefined || is === undefined) continue;
		const wasPoints = pointsOf(was);
		const isPoints = pointsOf(is);
		const added = [...isPoints].some(([key, points]) => {
			const known = new Set((wasPoints.get(key) ?? []).map((point) => point.run));
			return points.some((point) => !known.has(point.run));
		});
		if (added) continue;
		// No Run of its month was added: the one change allowed is a boot summary that arrived.
		const arrived = structuredClone(is) as Json;
		for (const [key, points] of pointsOf(arrived)) {
			const wasByRun = new Map((wasPoints.get(key) ?? []).map((point) => [point.run, point] as const));
			for (const point of points) if (wasByRun.get(point.run)?.boot_summary === null && typeof point.boot_summary === "string") point.boot_summary = null;
		}
		const found = difference(arrived, was);
		if (found !== null) problems.push(`${path} changed since the previous tree although no Run of its month was added: ${found}`);
	}
	return problems;
}
