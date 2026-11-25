/**
 * Checks a tree of the data API as it was written to disk (scripts/lib/api.ts),
 * against the Derivations it was cut from, the Runs repository checkout whose
 * evidence it links and the schemas this repository keeps. Every way it fails
 * is a problem; none, and the tree may be kept.
 *
 * It establishes what it checks from the files it opens, by its own reading
 * of the design (ADR-0030): it compares parsed values, member by member and
 * number by number, with what it expects of them, never with what the
 * generator would make of the Derivations. It takes one thing from the
 * generator, its serialiser (writerForm()), and only to hold each file's
 * bytes to the one text the generator writes for that file's own value; that
 * says nothing of the values, which are checked apart. A passing check
 * establishes all of this:
 *
 * - Every JSON file of the tree is strict JSON, as the strictest reader
 *   would read it (strict-json.ts): UTF-8, with no byte-order mark, no
 *   object holding a member name twice, so no two readers can read one file
 *   as two values, and no number a double does not hold exactly, so no
 *   reader's parse changes a figure.
 * - Every file the build writes (all but the price files and the schemas,
 *   which it copies byte for byte) is, byte for byte, what the build writes
 *   for the value it parses to: its members in the build's order, its white
 *   space, numbers and strings as the build writes them. So no file differs
 *   from its one canonical text whatever else is going on: a reordered
 *   object, a space added or a number respelt fails here, though the values
 *   are the same.
 * - The table of contents gives the layout this build writes (LAYOUT).
 * - The tree holds exactly the files it should: the table of contents, the
 *   list, the six schemas, one Series file per Series of either file of
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
 *   requests v1, the Derivation's group_through as it stood through the Run,
 *   as group_through_as_of_run (null before the Series' first Run of a
 *   second group, where the Derivation's is the point's through; the
 *   Derivation's everywhere else); and every one of series v1's entries for a pair of
 *   consecutive Runs whose later Run started that month. Each Run of a Series
 *   is in exactly one month file, that of the month it started in; each
 *   entry for a pair is filed under the month of its later Run.
 * - Each Series file equals what the Derivations hold for its Series: its
 *   identity, its count of Runs and the starts of its oldest and newest Run;
 *   newest_runs, the design's 12; its months, exactly the month files of the
 *   tree, each with its address, count of Runs, oldest and newest start, and
 *   the sha256 and size of the month file as the tree holds it;
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
 *   the checkout, has the point's Run id, boot and start (so the month a
 *   point is filed under is its Run's own), and hashes to its sha256;
 *   evidence is that path's address; boot_summary is the address of that
 *   boot's summary in the checkout (the first, in path order, of the files
 *   named by the boot's id whose own boot, read as strict JSON, says so), or
 *   null when there is none. Each Run file the list gives as unreadable is in the checkout with
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
 * - The table of contents' recent_rounds holds, value for value, the newest
 *   rounds of boots and the boot summaries left out of them, as the
 *   checkout's boot summaries and the Derivations make them by the design
 *   (expectedRounds()): a summary the API does not serve, that cannot be
 *   read strictly or lacks what a round needs, of a boot another names too,
 *   listing a Run of another boot, or listing a Run twice or one another
 *   lists, is left out, with why; the rest in order of start, a new round
 *   after more than 40 minutes from the boot before, the newest 8, newest
 *   first; each boot's Runs, failed builds and executions not run as its
 *   summary lists them, each Run failed when the Method that decides for its
 *   Series (requests v1 where it derives it, else series v1) does not count
 *   it, in no Series when no Method has its point; each round its boots
 *   summed; how many are left out, and the newest 8 of them by path; each
 *   address it gives a file of the checkout, of a shape the API serves; and
 *   its words begin with that rule and that count, word for word. No boot
 *   summary is itself a problem.
 * - Every link field, in its place in the files, names a file under the
 *   base: under v1/ a file of the tree, under runs/ or boots/ a file of the
 *   checkout. Only the blob address template is not a file; it is checked to
 *   be exactly the base and /blobs/sha256/{hex}. Strings elsewhere, such as a
 *   Run's parameters, are data and are not read as links.
 * - Each price file is byte for byte the checkout's.
 *
 * checkStability() holds a tree, besides, to what its month files promise
 * against the tree before it: that a month file's bytes change only for the
 * four causes ADR-0030 gives (rule 9).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

import { isServedKey } from "../../infra/runs/public-blobs";
import type { DerivationsFile as RequestsFile } from "../../methods/requests/v1/output";
import type { DerivationsFile as SeriesFile } from "../../methods/v1/output";
import { LAYOUT, writerForm, writtenSchemaOf } from "./api";
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
/**
 * The schemas the tree serves, in the table of contents' order: the files each
 * describes, and the file of this repository it is. The events schema
 * describes no file of the tree but one line of a Run's stdout, which the
 * Methods' definitions name; no file of the tree is of its kind.
 */
const SCHEMAS = [
	{ name: "index", describes: "v1/index.json", source: "schemas/api/v1/index.schema.json", closed: true },
	{ name: "series-list", describes: "v1/series.json", source: "schemas/api/v1/series-list.schema.json", closed: true },
	{ name: "series", describes: "v1/series/<id>.json", source: "schemas/api/v1/series.schema.json", closed: true },
	{ name: "series-month", describes: "v1/series/<id>/<yyyy-mm>.json", source: "schemas/api/v1/series-month.schema.json", closed: true },
	{ name: "prices", describes: "v1/prices/<yyyy-mm-dd>.json", source: "schemas/prices.schema.json", closed: false },
	{ name: "events", describes: "one line of a Run's stdout: the blob at blobs/sha256/<hex> that the Run file's stdout names", source: "schemas/events.schema.json", closed: false },
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

/** How many of the newest rounds of boots the table of contents gives, by the design. */
const RECENT_ROUNDS = 8;
/** By the design, a boot starts a new round when it started more than 40 minutes after the boot before it: in nanoseconds. */
const ROUND_GAP_NS = 40n * 60n * 1_000_000_000n;
/** How the table of contents' words for a round must begin, word for word: the rule and the count the check holds the rounds to. The rest explains. */
const ROUND_OPENING =
	"A round is the boots that belong together in time, worked out from the boot summaries alone, so the same boot summaries always give the same rounds: " +
	"the boots in order of their start, a boot starting a new round when it started more than 40 minutes after the boot before it. " +
	`rounds holds the newest ${RECENT_ROUNDS} rounds, newest first. `;
/** How many boot summaries left out of the rounds the table of contents lists, by the design; the rest are counted. */
const LEFT_OUT_LISTED = 8;
/** Why a boot summary is left out of the rounds, by the design: the first that applies, in this order, word for word. */
const LEFT_OUT_BECAUSE = {
	address: "the API does not serve its address: a boot summary is served only under its boot's id, a UUID, and a boot whose id could not be read writes unknown.json",
	json: "it is not strict JSON",
	schema: "it is not a ledgermath.boot/1 summary",
	boot: "it names no boot",
	start: "it gives no start that is a real UTC time written to the nanosecond",
	provider: "it gives no provider, or an instance type that is not a string",
	runs: "it gives no list of Runs, each with its id",
	lists: "it gives no list of failed builds or of executions not run",
	sameBoot: "another boot summary names the same boot",
	otherBoot: "it lists a Run whose point is of another boot",
	sharedRun: "it lists a Run twice, or one that another boot summary lists too",
} as const;
/** A boot summary's path in the checkout. */
const BOOT_FILE = /^boots\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/[A-Za-z0-9._-]+\.json$/;

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
			"it was 6.3 KB with 9 price files on 2026-11-19, and 22.8 KB with 14 on 2026-11-24, once it gave the newest rounds of boots (13.3 KB for 8 rounds of five boots, about 300 bytes a boot: it grows with the boots a round holds, not with time; the summaries left out are at most 8 listed, each with one of a fixed few sentences); each day's price file adds 124 bytes to its list, which brings it here about 20 months on; listing the price files by month, as the Series are, changes v1's shape (v2), so decide that with the maintainer, and if the rounds grew, ask why a round holds so many boots before giving fewer",
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
			"the number of points in it is bounded (newest_runs), and it was 302 KB at most, for http_get, on 2026-11-19, so its newest points or its summaries grew: more samples or requests per Run, more groups (one per change of the machine's split facts), more distinct values of a request fact, or many years of month entries; find which, and lower newest_runs or move the part that grew to the month files before raising this",
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
		whenHit: "it is LedgerMath's price file of the day, byte for byte (39 KB on 2026-11-19): the price rules (scripts/lib/price-rules.ts) now keep far more records; look there first",
	},
	{
		kind: "a schema",
		path: SCHEMA_PATH,
		bytes: 256_000,
		whenHit: "a schema this large is past what a reader takes in at once: split what it describes into $defs it shares, or ask why it grew",
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
	/**
	 * A file of the tree, read as strictly as its strictest reader would, every
	 * number exactly (strict-json.ts); undefined, and a problem, when it cannot
	 * be. A file the build writes must besides be, byte for byte, what the
	 * build writes for the value it parses to (writerForm()).
	 */
	const parse = (path: string): unknown => {
		const bytes = read(path);
		let value: unknown;
		try {
			value = parseStrictJson(bytes, { exactNumbers: true });
		} catch (error) {
			problems.push(`${path} is not strict JSON: ${error instanceof Error ? error.message : String(error)}`);
			unreadable++;
			return undefined;
		}
		if (writtenSchemaOf(path) !== undefined) {
			const off = notWriterForm(path, bytes.toString("utf8"), value);
			if (off !== null) problems.push(`${path} ${off}`);
		}
		return value;
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
	/**
	 * Each boot's summary in the checkout, by the boot it names: a file under
	 * boots/ whose own `boot`, read as strict JSON, is its boot, and whose file
	 * is named by that boot (as the runner names it). Of two of one boot, the
	 * first in path order. One that cannot be read, or names another boot than
	 * its file's name (unknown.json names none), is no boot's. No summary is a
	 * problem of the tree: the table of contents lists those no round holds.
	 */
	const summaries = new Map<string, string>();
	for (const path of listFiles(join(sources.runs, "boots")).map((name) => `boots/${name}`)) {
		if (!BOOT_FILE.test(path)) continue;
		let summary: unknown;
		try {
			summary = parseStrictJson(readFileSync(join(sources.runs, ...path.split("/"))));
		} catch {
			continue;
		}
		if (!isObject(summary) || typeof summary.boot !== "string" || summary.boot !== fileName(path) || summaries.has(summary.boot)) continue;
		summaries.set(summary.boot, path);
	}
	/** The address of a boot's summary: null when the checkout has none. */
	const summaryOf = (boot: string): string | null => {
		const path = summaries.get(boot);
		return path === undefined ? null : address(path);
	};

	/** A point's evidence is its own: its Run file's id, boot, start and sha256, the address of its path, and its boot's summary. */
	const checkEvidence = (where: string, point: Json): void => {
		const { run, path, sha256, evidence, boot, boot_summary: bootSummary, started_at: startedAt } = point;
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
		// The point's start, which files it under its month, is its Run file's own, not only the Derivation's copy of it.
		if (record.started_at !== startedAt) problems.push(`${where}: the Run file ${path} in the checkout started at ${named(record.started_at)}, not ${named(startedAt)}: the point's month must be its Run's own`);
		checkSummary(where, typeof record.boot === "string" ? record.boot : boot, bootSummary);
	};
	/** A point's boot_summary is the address of its boot's one summary in the checkout, or null when there is none. */
	const checkSummary = (where: string, boot: unknown, bootSummary: unknown): void => {
		if (typeof boot !== "string") return; // the schema says so
		const summary = summaryOf(boot);
		if (bootSummary === summary) return;
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
					layout: LAYOUT,
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
			// The newest rounds of boots and the summaries left out of them: as the checkout's boot summaries and the Derivations make them, and each
			// address given a file of the checkout, and one the API serves.
			const ofRounds = ofIndex("recent_rounds");
			const expectedOfRounds = expectedRounds(sources.runs, seriesV1, requestsV1, address);
			for (const key of ["rounds", "left_out"] as const) {
				const found = difference(ofRounds[key], expectedOfRounds[key], `/recent_rounds/${key}`);
				if (found !== null) problems.push(`${INDEX}: ${found}, as the boot summaries of the checkout and the Derivations make it`);
			}
			if (typeof ofRounds.about !== "string" || !ofRounds.about.startsWith(ROUND_OPENING)) problems.push(`${INDEX}: recent_rounds.about does not begin, word for word, with the rule and the count the rounds are held to: ${JSON.stringify(ROUND_OPENING.trim())}`);
			const leftOut = isObject(ofRounds.left_out) && Array.isArray(ofRounds.left_out.summaries) ? ofRounds.left_out.summaries.filter(isObject) : [];
			const roundBoots = (Array.isArray(ofRounds.rounds) ? ofRounds.rounds : []).filter(isObject).flatMap((round) => (Array.isArray(round.by_boot) ? round.by_boot : []).filter(isObject));
			for (const entry of [...roundBoots, ...leftOut]) {
				if (typeof entry.boot_summary !== "string") continue;
				link(INDEX, entry.boot_summary);
				const path = entry.boot_summary.startsWith(`${base}/`) ? entry.boot_summary.slice(base.length + 1) : entry.boot_summary;
				if (!isServedKey(path)) problems.push(`${INDEX}: recent_rounds links ${entry.boot_summary}, an address the API does not serve`);
			}
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

	/**
	 * A Derivation's point as the tree writes it: with its Run file's sha256
	 * after its path, without evidence and boot_summary (checkEvidence sees to
	 * those), and requests v1's group_through as it stood through the Run, as
	 * group_through_as_of_run. The two differ only on the points before the
	 * first point whose group differs from the first point's, in a Series of
	 * more than one group: the Derivation's is that point's through there, and
	 * the tree's null. Everywhere else they are the same, null included.
	 */
	const expectedPoints = (id: string, name: string, method: SeriesDerivation | RequestsDerivation): Array<Json | undefined> => {
		const first = method.points.findIndex((point) => point.group !== method.points[0]?.group);
		return method.points.map((derived: AnyPoint, i) => {
			const cited: CitedRun | undefined = method.runs[i];
			if (cited === undefined || cited.id !== derived.run || cited.path !== derived.path) {
				problems.push(`${name}'s Derivation of Series ${id} cites another Run at ${i} than its point ${i}`);
				return undefined;
			}
			if (!("group_through" in derived)) return { ...derived, sha256: cited.sha256 };
			const { group_through: groupThrough, ...rest } = derived;
			const beforeSplit = first >= 0 && i < first;
			// Before the Series' first Run of a second group the tree writes null: the Derivation's value must then be its through, or the tree would lose it.
			if (beforeSplit && canonical(groupThrough) !== canonical(derived.through)) {
				problems.push(`${name}'s Derivation of Series ${id} holds, at point ${i}, before the Series' first Run of a second group, a group_through other than its through: the tree's null would lose it`);
			}
			return { ...rest, sha256: cited.sha256, group_through_as_of_run: beforeSplit ? null : groupThrough };
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
			const entry: Json = { month, url: address(monthFile(id, month)), runs: indexes.length, oldest_run_started_at: starts[0], newest_run_started_at: starts[starts.length - 1] };
			// The month file's sha256 and size, as the tree holds it: what a reader's copy is compared with.
			if (held.has(monthFile(id, month))) {
				const bytes = read(monthFile(id, month));
				entry.sha256 = createHash("sha256").update(bytes).digest("hex");
				entry.bytes = bytes.length;
			}
			return entry;
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

/** A start written yyyy-mm-ddThh:mm:ss.nnnnnnnnnZ, in nanoseconds since 1970 UTC; null when it is not so written or not a real time. */
function nanosSince1970(time: unknown): bigint | null {
	const match = typeof time === "string" ? /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{9})Z$/.exec(time) : null;
	if (match === null) return null;
	const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
	const ms = Date.UTC(year, month - 1, day, hour, minute, second);
	const back = new Date(ms);
	const real = back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day && back.getUTCHours() === hour && back.getUTCMinutes() === minute && back.getUTCSeconds() === second;
	return real ? BigInt(ms) * 1_000_000n + BigInt(match[7] as string) : null;
}

/**
 * The newest rounds of boots and the boot summaries left out of them, by the
 * design, from the checkout's boot summaries and the Derivations, never from
 * the build. No summary is a problem of the tree: one the rounds cannot be
 * told from is left out, with the first reason that applies
 * (LEFT_OUT_BECAUSE): an address the API does not serve (the shared list of
 * served shapes the edge is made from), bytes that are not strict JSON, not
 * ledgermath.boot/1, no boot, no start that is a real time to the nanosecond,
 * no provider with an instance type that is a string or none, no list of Runs
 * each with its id, no lists of failed builds and executions not run; then,
 * among the rest, every summary of a boot two or more name; every one listing
 * a Run whose point is of another boot; and, of the rest, every one listing a
 * Run twice, or one another lists. The rest, in order of start then path, a
 * boot starting a new round when it started more than 40 minutes after the
 * boot before it; the newest RECENT_ROUNDS, newest first. A boot's figures are
 * its summary's (its Runs, failed builds and executions not run) and, for
 * each Run it lists, its point's: failed when Method requests v1 does not
 * count it, if requests v1 derives its Series, else when series v1 does not;
 * in no Series when no Method has a point of it. A round's figures are its
 * boots' summed. Those left out: how many, and the newest LEFT_OUT_LISTED by
 * path, newest first, each with its path, its address when served, and why.
 */
function expectedRounds(runs: string, seriesV1: ReadonlyMap<string, SeriesDerivation>, requestsV1: ReadonlyMap<string, RequestsDerivation>, address: (path: string) => string): { rounds: Json[]; left_out: Json } {
	interface Boot {
		path: string;
		boot: string;
		startedAt: string;
		nanos: bigint;
		instanceType: string | null;
		runs: string[];
		buildFailures: number;
		notRun: number;
	}
	let boots: Boot[] = [];
	const because = new Map<string, string>();
	for (const path of listFiles(join(runs, "boots")).map((name) => `boots/${name}`).filter((path) => BOOT_FILE.test(path))) {
		const why = ((): string | Boot => {
			if (!isServedKey(path)) return LEFT_OUT_BECAUSE.address;
			let summary: unknown;
			try {
				summary = parseStrictJson(readFileSync(join(runs, ...path.split("/"))));
			} catch {
				return LEFT_OUT_BECAUSE.json;
			}
			if (!isObject(summary) || summary.schema !== "ledgermath.boot/1") return LEFT_OUT_BECAUSE.schema;
			if (typeof summary.boot !== "string") return LEFT_OUT_BECAUSE.boot;
			const nanos = nanosSince1970(summary.started_at);
			if (nanos === null) return LEFT_OUT_BECAUSE.start;
			const provider = isObject(summary.provider) ? summary.provider : undefined;
			const instanceType = provider === undefined ? undefined : (provider.instance_type ?? null);
			if (instanceType === undefined || (instanceType !== null && typeof instanceType !== "string")) return LEFT_OUT_BECAUSE.provider;
			const listed = Array.isArray(summary.runs) ? summary.runs : undefined;
			if (listed === undefined || !listed.every((run) => isObject(run) && typeof run.id === "string")) return LEFT_OUT_BECAUSE.runs;
			if (!Array.isArray(summary.build_failures) || !Array.isArray(summary.not_run)) return LEFT_OUT_BECAUSE.lists;
			return {
				path,
				boot: summary.boot,
				startedAt: summary.started_at as string,
				nanos,
				instanceType: instanceType as string | null,
				runs: listed.map((run) => (run as Json).id as string),
				buildFailures: summary.build_failures.length,
				notRun: summary.not_run.length,
			};
		})();
		if (typeof why === "string") because.set(path, why);
		else boots.push(why);
	}
	// Each Run's point: series v1 derives every Series and gives its boot; requests v1, where it derives the Series, says whether the Run counts.
	const pointOf = new Map<string, { boot: string; counted: boolean }>();
	for (const derivation of seriesV1.values()) for (const point of derivation.points) pointOf.set(point.run, { boot: point.boot, counted: point.counted });
	// Then what the summaries say together, each test over every summary still in: one boot named twice, a Run of another boot, a Run listed twice.
	const drop = (why: string, out: (boot: Boot) => boolean): void => {
		const dropped = boots.filter(out);
		for (const boot of dropped) because.set(boot.path, why);
		boots = boots.filter((boot) => !dropped.includes(boot));
	};
	const naming = new Map<string, number>();
	for (const boot of boots) naming.set(boot.boot, (naming.get(boot.boot) ?? 0) + 1);
	drop(LEFT_OUT_BECAUSE.sameBoot, (boot) => (naming.get(boot.boot) ?? 0) > 1);
	drop(LEFT_OUT_BECAUSE.otherBoot, (boot) => boot.runs.some((run) => { const point = pointOf.get(run); return point !== undefined && point.boot !== boot.boot; }));
	const listings = new Map<string, number>();
	for (const boot of boots) for (const run of boot.runs) listings.set(run, (listings.get(run) ?? 0) + 1);
	drop(LEFT_OUT_BECAUSE.sharedRun, (boot) => boot.runs.some((run) => (listings.get(run) ?? 0) > 1));

	boots.sort((a, b) => (a.nanos < b.nanos ? -1 : a.nanos > b.nanos ? 1 : byText(a.path, b.path)));
	const rounds: Boot[][] = [];
	boots.forEach((boot, i) => {
		const before = boots[i - 1];
		if (before === undefined || boot.nanos - before.nanos > ROUND_GAP_NS) rounds.push([boot]);
		else (rounds[rounds.length - 1] as Boot[]).push(boot);
	});

	const requestsCounted = new Map<string, boolean>();
	for (const derivation of requestsV1.values()) for (const point of derivation.points) requestsCounted.set(point.run, point.counted);
	const figures = (boot: Boot): Json => {
		let failed = 0;
		let inNoSeries = 0;
		for (const run of boot.runs) {
			const counted = requestsCounted.has(run) ? requestsCounted.get(run) : pointOf.get(run)?.counted;
			if (counted === undefined) inNoSeries++;
			else if (!counted) failed++;
		}
		return {
			boot_summary: address(boot.path),
			instance_type: boot.instanceType,
			started_at: boot.startedAt,
			runs: boot.runs.length,
			failed_runs: failed,
			runs_in_no_series: inNoSeries,
			build_failures: boot.buildFailures,
			not_run: boot.notRun,
		};
	};
	const newest = rounds.slice(Math.max(rounds.length - RECENT_ROUNDS, 0)).reverse();
	const out = newest.map((round) => {
		const byBoot = round.map(figures);
		const total = (key: string): number => byBoot.reduce((sum, boot) => sum + (boot[key] as number), 0);
		return {
			started_at: (round[0] as Boot).startedAt,
			boots: round.length,
			runs: total("runs"),
			failed_runs: total("failed_runs"),
			runs_in_no_series: total("runs_in_no_series"),
			build_failures: total("build_failures"),
			not_run: total("not_run"),
			instance_types: round.map((boot) => boot.instanceType),
			by_boot: byBoot,
		};
	});
	const leftOut = [...because.keys()].sort((a, b) => byText(b, a));
	return {
		rounds: out,
		left_out: {
			count: leftOut.length,
			summaries: leftOut.slice(0, LEFT_OUT_LISTED).map((path) => ({ path, boot_summary: isServedKey(path) ? address(path) : null, why: because.get(path) })),
		},
	};
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
 * Null when `text`, a file of the tree at `path`, is exactly what the build
 * writes for `value`, the value it parses to (writerForm()); otherwise where
 * it first differs. A file that is has no freedom left: its members are in
 * the build's order and its white space, numbers and strings are written as
 * the build writes them, so two such files differ in bytes only where their
 * values differ.
 */
export function notWriterForm(path: string, text: string, value: unknown): string | null {
	const want = writerForm(path, value);
	if (want === text) return null;
	let at = 0;
	while (at < text.length && at < want.length && text.charCodeAt(at) === want.charCodeAt(at)) at++;
	const line = text.slice(0, at).split("\n").length;
	return `is not what the build writes for its own values (its members in the build's order, its white space, numbers and strings as the build writes them): it first differs at character ${at} (line ${line}), ${show(text.slice(at, at + 40))} where the build writes ${show(want.slice(at, at + 40))}`;
}

/** How a tree was written, as its table of contents says: its layout (null for a tree that gives none, written before layout was) and the base it was built for. */
export interface TreeLayout {
	layout: number | null;
	base: string;
}

/** A tree's layout and base, from its v1/index.json; a sentence saying why when there is no tree of the data API to read them from. */
export function readLayout(directory: string): TreeLayout | string {
	if (!existsSync(directory)) return `${directory} does not exist`;
	if (!statSync(directory).isDirectory()) return `${directory} is not a directory`;
	if (listFiles(directory).length === 0) return `${directory} is empty`;
	const at = join(directory, ...INDEX.split("/"));
	if (!existsSync(at)) return `${directory} holds no ${INDEX}, so it is not a tree of the data API`;
	let index: unknown;
	try {
		index = parseStrictJson(readFileSync(at));
	} catch (error) {
		return `${directory}'s ${INDEX} is not strict JSON (${error instanceof Error ? error.message : String(error)}), so it is not a tree of the data API`;
	}
	if (!isObject(index) || typeof index.url !== "string" || !index.url.endsWith(`/${INDEX}`)) return `${directory}'s ${INDEX} gives no address of its own, so it is not a tree of the data API`;
	const layout = index.layout;
	return { layout: typeof layout === "number" && Number.isInteger(layout) && layout >= 1 ? layout : null, base: index.url.slice(0, -(INDEX.length + 1)) };
}

/** A layout as a sentence names it. */
const layoutName = (layout: number | null): string => (layout === null ? "none (it was written before layout was)" : String(layout));

/**
 * Why a tree of this layout is not whole: each month file its Series files
 * list must be in it with the size and sha256 listed, and nothing else;
 * each Series its list has must have its file, and nothing else; the list and
 * the table of contents must count them right. A tree that is not whole is
 * no baseline: a month file that is not there cannot be compared, and a
 * Series that is not there cannot be missed.
 */
function wholeness(directory: string): string[] {
	const out: string[] = [];
	const files = listFiles(directory);
	const held = new Set(files);
	const open = (path: string): unknown => {
		try {
			return parseStrictJson(readFileSync(join(directory, ...path.split("/"))));
		} catch (error) {
			out.push(`${path} is not strict JSON: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	};
	const seriesIds = files.map((path) => SERIES_PATH.exec(path)?.[1]).filter((id): id is string => id !== undefined);
	const index = held.has(INDEX) ? open(INDEX) : undefined;
	const list = held.has(LIST) ? open(LIST) : undefined;
	if (!held.has(LIST)) out.push(`${LIST} is missing`);
	else if (isObject(list)) {
		const rows = (Array.isArray(list.series) ? list.series : []).filter(isObject).map((row) => String(row.id));
		for (const id of rows) if (!seriesIds.includes(id)) out.push(`${seriesFile(id)} is missing, though ${LIST} has a row for Series ${id}`);
		for (const id of seriesIds) if (!rows.includes(id)) out.push(`${seriesFile(id)} is there, but ${LIST} has no row for Series ${id}`);
		if (list.count !== rows.length) out.push(`${LIST} counts ${show(list.count)} Series and has ${rows.length} rows`);
		const counted = isObject(index) && isObject(index.series) ? index.series.count : undefined;
		if (counted !== rows.length) out.push(`${INDEX} counts ${show(counted)} Series, and ${LIST} has ${rows.length} rows`);
	} else if (list !== undefined) out.push(`${LIST} is not an object`);
	const listed = new Set<string>();
	for (const id of seriesIds) {
		const file = open(seriesFile(id));
		if (file === undefined) continue;
		const months = isObject(file) && Array.isArray(file.months) ? file.months : undefined;
		if (months === undefined || months.length === 0) {
			out.push(`${seriesFile(id)} lists no months`);
			continue;
		}
		for (const entry of months) {
			if (!isObject(entry) || typeof entry.month !== "string" || !/^[0-9]{4}-[0-9]{2}$/.test(entry.month)) {
				out.push(`${seriesFile(id)} lists a month that is not one: ${show(entry)}`);
				continue;
			}
			const path = monthFile(id, entry.month);
			listed.add(path);
			if (!held.has(path)) {
				out.push(`${path} is missing, though ${seriesFile(id)} lists it`);
				continue;
			}
			const bytes = readFileSync(join(directory, ...path.split("/")));
			if (bytes.length !== entry.bytes) out.push(`${path} is ${bytes.length} bytes, not ${show(entry.bytes)} as ${seriesFile(id)} lists it`);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			if (sha256 !== entry.sha256) out.push(`${path} has sha256 ${sha256}, not ${show(entry.sha256)} as ${seriesFile(id)} lists it`);
		}
	}
	for (const path of files) if (MONTH_PATH.test(path) && !listed.has(path)) out.push(`${path} is there, but no Series file lists it`);
	return out;
}

/** The Series a tree published, by id, each with the Runs of its points, as well as the tree can be read; and how it was read. */
interface Published {
	series: Map<string, Set<string>>;
	/** The files whose points were read: month files (this layout's), and Series files holding points (the layout before the split). */
	monthFiles: number;
	seriesFilesWithPoints: number;
	/** Files that could not be read, whose Runs are therefore not known. */
	unread: string[];
}

/**
 * Every Series and Run a tree published, read whatever its layout: the
 * Series from its Series files and its list; the Runs from every Method's
 * points, in its month files (since the split by month) and in its Series
 * files (before it, a Series file held derivations.<key>.points). A Series
 * file's newest_points repeat its month files' and are not read.
 */
function publishedIn(directory: string): Published {
	const out: Published = { series: new Map(), monthFiles: 0, seriesFilesWithPoints: 0, unread: [] };
	const files = listFiles(directory);
	const runsOf = (id: string): Set<string> => {
		let runs = out.series.get(id);
		if (runs === undefined) {
			runs = new Set();
			out.series.set(id, runs);
		}
		return runs;
	};
	const open = (path: string): unknown => {
		try {
			return parseStrictJson(readFileSync(join(directory, ...path.split("/"))));
		} catch {
			out.unread.push(path);
			return undefined;
		}
	};
	const points = (file: unknown): string[] => {
		const derivations = isObject(file) && isObject(file.derivations) ? file.derivations : {};
		return Object.values(derivations).flatMap((block) => (isObject(block) && Array.isArray(block.points) ? block.points : []).filter(isObject).map((point) => String(point.run)));
	};
	if (files.includes(LIST)) {
		const list = open(LIST);
		for (const row of isObject(list) && Array.isArray(list.series) ? list.series : []) if (isObject(row) && typeof row.id === "string") runsOf(row.id);
	}
	for (const path of files) {
		const series = SERIES_PATH.exec(path);
		const month = MONTH_PATH.exec(path);
		if (series !== null) {
			const runs = runsOf(series[1] as string);
			const held = points(open(path));
			if (held.length > 0) out.seriesFilesWithPoints++;
			for (const run of held) runs.add(run);
		} else if (month !== null) {
			const file = open(path);
			if (file === undefined) continue;
			out.monthFiles++;
			const runs = runsOf(month[1] as string);
			for (const run of points(file)) runs.add(run);
		}
	}
	return out;
}

/** One of the four causes for which a month file's bytes may change (ADR-0030, rule 9). */
export type Cause = "a" | "b" | "c" | "d";

export const CAUSES: Readonly<Record<Cause, string>> = {
	a: "a Run that started in its month was added",
	b: "a boot summary that was missing arrived",
	c: "a Run arrived late, before a Run of its Series already in the files, in its month or an earlier one",
	d: "a Method first applies to its Series",
};

export interface StabilityResult {
	/** Whether the month files were compared: only with a previous tree of this layout and base. `none` says why not. */
	compared: boolean;
	none?: string;
	/** Whether a human declared a new baseline (--allow-no-previous). */
	newBaseline: boolean;
	/** The two trees' layouts, as their tables of contents give them, when they could be read. */
	layouts: { previous?: number | null; current?: number | null };
	problems: string[];
	/** Month files in both trees, and how many of them are byte for byte the same. */
	inBoth: number;
	unchanged: number;
	/** Month files of this tree the previous one did not have. */
	added: number;
	/** Each month file that changed, with each cause that explains it and what it changed. */
	explained: Array<{ path: string; causes: Array<{ cause: Cause; detail: string }> }>;
	/** With a new baseline declared and month files not compared: what the previous tree was read as having published, all of which must still be here. */
	published?: { series: number; runs: number; monthFiles: number; seriesFilesWithPoints: number; unread: number };
}

/**
 * What a Run that arrives late may change, by Method, in a point published
 * after it in its Series (placed after it, by start then Run id, in its
 * month or a later one): the fields that depend on earlier Runs, and nothing
 * else.
 *
 * - group: a group's letter is given in the order each group first appears,
 *   so a late Run of a group not seen before it moves every later letter on;
 * - requests v1's through: the Series' pooled figures through the point,
 *   pooling every counted Run that started at or before it. Its counts are
 *   checked besides (throughProblem()): unchanged when no late Run before
 *   the point is counted, else risen by exactly what the counted ones add;
 * - requests v1's group_through_as_of_run: its group's pooled figures as they
 *   stood through the point, the same way, for a group the late Run may join,
 *   split or start.
 *
 * Any other change to such a point fails, as does any change to a point
 * placed before every Run added late.
 */
export const LATE_RUN_MAY_CHANGE: Readonly<Record<string, readonly string[]>> = {
	series_v1: ["group"],
	requests_v1: ["group", "through", "group_through_as_of_run"],
};

/**
 * What a Run that arrives late may change in series v1's pair entry of the
 * Run right after it: its earlier Run (from), now the late Run, and what the
 * entry compares between the two (facts and sections). Its later Run (to)
 * stays.
 */
export const LATE_RUN_MAY_CHANGE_IN_PAIR: readonly string[] = ["from", "facts", "sections"];

/** What the comparison cannot establish, said with every comparison it makes. */
export const NOT_ESTABLISHED =
	"not established by this comparison: that a cumulative figure a late Run changed is right beyond its counts (a percentile of requests v1's through or group_through_as_of_run, a group's letter): " +
	"that is the Method's doing, and the check against the Derivations establishes only that the tree equals them";

/** A point's place in its Series: by start, then Run id, as both Methods order them. */
const placeOf = (point: Json): string => `${String(point.started_at)}\u0000${String(point.run)}`;

/** requests v1's pooled counts as through holds them; null pools nothing. */
interface PooledCounts {
	runs: number;
	requests: number;
	failed: number;
	failures: Map<string, number>;
}

function pooledCounts(through: unknown): PooledCounts | string {
	if (through === null) return { runs: 0, requests: 0, failed: 0, failures: new Map() };
	if (!isObject(through)) return `through is ${show(through)}, not an object or null`;
	const { runs, requests, failed, failures } = through;
	if (typeof runs !== "number" || typeof requests !== "number" || typeof failed !== "number" || !Array.isArray(failures)) return `through is ${show(through)}, without its counts`;
	const byKind = new Map<string, number>();
	for (const failure of failures) {
		if (!isObject(failure) || typeof failure.count !== "number") return `through holds a failure that is not one: ${show(failure)}`;
		const key = `${String(failure.phase)} ${String(failure.kind)}`;
		byKind.set(key, (byKind.get(key) ?? 0) + failure.count);
	}
	return { runs, requests, failed, failures: byKind };
}

/**
 * Holds a tree to the promise its month files make (ADR-0030, rule 9),
 * against the tree before it (`previous`, the tree readers were last served):
 * a month file's bytes change only when (a) a Run that started in that month
 * is added, (b) a boot summary that was missing arrives, (c) a Run arrives
 * late, having started before a Run of the Series already in the files, in
 * that month or an earlier one, or (d) a Method first applies to the Series.
 *
 * The comparison is made only with a previous tree of the same layout (the
 * layout its table of contents gives, LAYOUT in scripts/lib/api.ts) and base,
 * and then always, strictly. A previous tree that is missing, empty, of
 * another layout or built for another base is a problem, unless a human
 * declared a new baseline (`newBaseline`, --allow-no-previous): nothing
 * automatic may. Even then, when the previous tree can be read well enough
 * to list the Series and Runs it published (publishedIn(), whatever its
 * layout), every one of them must be in this tree; `published` says how
 * many were read and how.
 *
 * A previous tree of the same layout must be whole (wholeness()): every
 * month file its Series files list there with the size and sha256 listed,
 * and nothing more; one that is not is a problem, not a baseline. Every
 * Series it has must be in this tree, and every month file of it too. One
 * whose bytes are the same passes, but for what follows a counted late Run
 * (below). One that changed passes only when both its files are exactly
 * what the build writes for their values (notWriterForm()), so that no byte
 * changed but where a value did, and every value that changed is explained,
 * from the two trees, by one of the four causes:
 *
 * - (a) and (c): a point of a Run this tree's Series holds and the previous
 *   one's did not, filed under its own month; late, (c), when it is placed
 *   (by start, then Run id) before a Run of the Series the previous tree
 *   held. It brings its pair entry and the month's runs and span. A late Run
 *   may also change, in its month and every later one, on a point placed
 *   after it, what LATE_RUN_MAY_CHANGE lists and nothing else, and in the
 *   pair entry of the Run right after it, what LATE_RUN_MAY_CHANGE_IN_PAIR
 *   lists, the entry then coming from the late Run. Where the consequence
 *   can be checked without redoing the Method it is: on every published
 *   point after a late Run, changed or not, requests v1's through is
 *   unchanged when no late Run before it is counted, and its counts (runs,
 *   requests, failed and failures) have risen by exactly what the counted
 *   ones add, as this tree's points of them state (throughProblem()). That a
 *   changed percentile is right is not established (NOT_ESTABLISHED).
 * - (b): a point's boot_summary that turned from null into an address, and
 *   nothing else of that point.
 * - (d): a Method's block, present under its key in this tree's month file
 *   and in no month file nor the Series file of that Series in `previous`.
 *
 * Anything else is a problem: a figure, a fact or a field that changed, a
 * boot summary that went or changed, a block that went, a published Run that
 * is no longer in its month file, a byte that changed with no value. Month
 * files only this tree holds are new and pass (the check against the
 * Derivations sees to them).
 */
export function checkStability(previous: string, tree: string, options: { newBaseline?: boolean } = {}): StabilityResult {
	const problems: string[] = [];
	const result: StabilityResult = { compared: false, newBaseline: options.newBaseline === true, layouts: {}, problems, inBoth: 0, unchanged: 0, added: 0, explained: [] };
	const current = readLayout(tree);
	if (typeof current === "string") {
		problems.push(`this tree cannot be compared with the one before it: ${current}`);
		return result;
	}
	result.layouts.current = current.layout;
	const prior = readLayout(previous);
	if (typeof prior !== "string") result.layouts.previous = prior.layout;
	const none =
		typeof prior === "string"
			? prior
			: prior.layout !== current.layout
				? `${previous} is a tree of layout ${layoutName(prior.layout)}, this tree of layout ${layoutName(current.layout)}`
				: prior.base !== current.base
					? `${previous} was built for ${prior.base}, this tree for ${current.base}`
					: null;
	if (none !== null) {
		result.none = none;
		if (!result.newBaseline) {
			problems.push(
				`no previous tree of this layout to compare this one with: ${none}. Only a human may declare a new baseline (--allow-no-previous; in the runs workflow, its input new_baseline), for the first build of a new layout or once the last tree kept has expired`,
			);
			return result;
		}
		// A new baseline: the month files are not compared, but nothing the previous tree published may be missing.
		if (existsSync(previous) && statSync(previous).isDirectory()) {
			const was = publishedIn(previous);
			const is = publishedIn(tree);
			let runs = 0;
			for (const [id, published] of [...was.series].sort(([a], [b]) => byText(a, b))) {
				runs += published.size;
				const now = is.series.get(id);
				if (now === undefined || !existsSync(join(tree, ...seriesFile(id).split("/")))) {
					problems.push(`Series ${id} was published in the previous tree ${previous} and is not in this one: a published Series never disappears, a new baseline or not`);
					continue;
				}
				const gone = [...published].filter((run) => !now.has(run)).sort(byText);
				if (gone.length > 0) problems.push(`Series ${id}: ${gone.length} Run${gone.length === 1 ? "" : "s"} published in the previous tree ${previous} ${gone.length === 1 ? "is" : "are"} in no month file of this one (${gone.slice(0, 5).join(", ")}${gone.length > 5 ? ", ..." : ""}): a published Run never disappears, a new baseline or not`);
			}
			result.published = { series: was.series.size, runs, monthFiles: was.monthFiles, seriesFilesWithPoints: was.seriesFilesWithPoints, unread: was.unread.length };
		}
		return result;
	}
	const broken = wholeness(previous);
	if (broken.length > 0) {
		result.none = `${previous} is not whole`;
		for (const why of broken) problems.push(`the previous tree ${previous} is not whole, so it is no baseline: ${why}`);
		return result;
	}
	result.compared = true;
	for (const path of listFiles(previous)) {
		const series = SERIES_PATH.exec(path);
		if (series !== null && !existsSync(join(tree, ...path.split("/")))) problems.push(`Series ${series[1]} was published in the previous tree and is not in this one: a published Series never disappears`);
	}
	const months = (directory: string): string[] => listFiles(directory).filter((path) => MONTH_PATH.test(path));
	const wasMonths = months(previous);
	const isMonths = months(tree);
	const now = new Set(isMonths);
	const before = new Set(wasMonths);
	result.added = isMonths.filter((path) => !before.has(path)).length;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	/** A file's bytes, text and value; the value is undefined, and a problem, when it is not strict JSON. */
	const open = (directory: string, which: string, path: string): { bytes: Buffer; text: string; value: unknown } | undefined => {
		const bytes = readFileSync(join(directory, ...path.split("/")));
		try {
			const value = parseStrictJson(bytes);
			return { bytes, text: decoder.decode(bytes), value };
		} catch (error) {
			problems.push(`${path} of the ${which} tree is not strict JSON: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	};
	const blocksOf = (value: unknown): Json => (isObject(value) && isObject(value.derivations) ? value.derivations : {});
	const pointsOf = (block: unknown): Json[] => (isObject(block) && Array.isArray(block.points) ? block.points.filter(isObject) : []);
	/** The same value, members in the same order: both files are what the build writes for their values, so this is the order the build writes. */
	const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
	const order = (a: Json, b: Json): boolean => same(Object.keys(a), Object.keys(b));

	const bySeries = new Map<string, { was: string[]; is: string[] }>();
	for (const [list, side] of [[wasMonths, "was"], [isMonths, "is"]] as const) {
		for (const path of list) {
			const id = (MONTH_PATH.exec(path) as RegExpExecArray)[1] as string;
			const entry = bySeries.get(id) ?? { was: [], is: [] };
			entry[side].push(path);
			bySeries.set(id, entry);
		}
	}
	for (const path of wasMonths) if (!now.has(path)) problems.push(`${path} was in the previous tree and is not in this one: a month file, once written, stays`);

	for (const [id, paths] of [...bySeries].sort(([a], [b]) => byText(a, b))) {
		const was = new Map(paths.was.map((path) => [path, open(previous, "previous", path)] as const));
		const is = new Map(paths.is.map((path) => [path, open(tree, "this", path)] as const));
		// The Series as each tree holds it: its Runs (series v1 derives every Series) and the Methods that derive it.
		const runsOf = (files: Map<string, { value: unknown } | undefined>): Map<string, Json> => {
			const runs = new Map<string, Json>();
			for (const file of files.values()) for (const point of pointsOf(blocksOf(file?.value).series_v1)) runs.set(String(point.run), point);
			return runs;
		};
		const wasRuns = runsOf(was);
		const isRuns = runsOf(is);
		const added = new Set([...isRuns.keys()].filter((run) => !wasRuns.has(run)));
		const lastPublished = [...wasRuns.values()].map(placeOf).sort(byText).pop();
		const isLate = (run: string): boolean => {
			const point = isRuns.get(run);
			return added.has(run) && point !== undefined && lastPublished !== undefined && byText(placeOf(point), lastPublished) < 0;
		};
		const earliestAdded = [...added].map((run) => placeOf(isRuns.get(run) as Json)).sort(byText)[0];
		/** Whether a Run added in this tree is placed before this point: then a late Run may have changed it. */
		const afterAdded = (point: Json): boolean => earliestAdded !== undefined && byText(earliestAdded, placeOf(point)) < 0;
		/** Each Run's predecessor in the Series as this tree holds it, by start then Run id. */
		const predecessor = new Map<string, string>();
		[...isRuns.values()]
			.sort((a, b) => byText(placeOf(a), placeOf(b)))
			.forEach((point, i, sorted) => {
				if (i > 0) predecessor.set(String(point.run), String((sorted[i - 1] as Json).run));
			});
		/** requests v1's points as this tree holds them, by Run id. */
		const isRequests = new Map<string, Json>();
		for (const file of is.values()) for (const point of pointsOf(blocksOf(file?.value).requests_v1)) isRequests.set(String(point.run), point);
		/**
		 * Why requests v1's through on a published point (`was` before, `point`
		 * now) is not what the Runs added late before it make it; null when it
		 * is, or when no Run was added before it. Unchanged when none of them is
		 * counted; else its runs, requests, failed and failures risen by exactly
		 * what the counted ones add, as their points in this tree state it
		 * (counted, succeeded, failed, failures: what requests v1 pools).
		 */
		const throughProblem = (was: Json, point: Json): string | null => {
			const place = placeOf(point);
			const late = [...added].map((run) => isRequests.get(run)).filter((one): one is Json => one !== undefined && byText(placeOf(one), place) < 0);
			if (late.length === 0) return null;
			const counted = late.filter((one) => one.counted === true);
			const lateRuns = late.map((one) => String(one.run)).sort(byText).join(", ");
			if (counted.length === 0) {
				if (same(was.through, point.through)) return null;
				return `through is ${show(point.through)}, where it was ${show(was.through)}, but no Run added before it is counted (${lateRuns}), so the Series' pooled figures through it cannot have changed`;
			}
			const before = pooledCounts(was.through);
			const after = pooledCounts(point.through);
			if (typeof before === "string") return `in the previous file, ${before}`;
			if (typeof after === "string") return after;
			const want: PooledCounts = { runs: before.runs + counted.length, requests: before.requests, failed: before.failed, failures: new Map(before.failures) };
			for (const one of counted) {
				if (typeof one.succeeded !== "number" || typeof one.failed !== "number" || !Array.isArray(one.failures)) return `Run ${String(one.run)}, added late before it, gives no counts of its requests`;
				want.requests += one.succeeded;
				want.failed += one.failed;
				for (const failure of one.failures.filter(isObject)) {
					const key = `${String(failure.phase)} ${String(failure.kind)}`;
					want.failures.set(key, (want.failures.get(key) ?? 0) + (typeof failure.count === "number" ? failure.count : Number.NaN));
				}
			}
			const off: string[] = [];
			for (const count of ["runs", "requests", "failed"] as const) if (after[count] !== want[count]) off.push(`through.${count} is ${after[count]}, not ${want[count]}`);
			const kinds = [...new Set([...want.failures.keys(), ...after.failures.keys()])].sort(byText);
			for (const kind of kinds) if (after.failures.get(kind) !== want.failures.get(kind)) off.push(`through.failures counts ${after.failures.get(kind) ?? 0} of ${kind}, not ${want.failures.get(kind) ?? 0}`);
			if (off.length === 0) return null;
			return `${off.join("; ")}: it pooled ${before.runs} counted Runs before, and the ${counted.length} counted Run${counted.length === 1 ? "" : "s"} added late before it (of ${lateRuns}) add exactly what their points state`;
		};
		const wasMethods = new Set<string>();
		for (const file of was.values()) for (const key of Object.keys(blocksOf(file?.value))) wasMethods.add(key);
		const seriesPath = seriesFile(id);
		if (existsSync(join(previous, ...seriesPath.split("/")))) {
			try {
				for (const key of Object.keys(blocksOf(parseStrictJson(readFileSync(join(previous, ...seriesPath.split("/"))))))) wasMethods.add(key);
			} catch {
				problems.push(`${seriesPath} of the previous tree is not strict JSON, so which Methods derived Series ${id} is not known from it`);
			}
		}

		for (const path of paths.was) {
			const old = was.get(path);
			if (!now.has(path)) continue;
			result.inBoth++;
			const current = is.get(path);
			if (old === undefined || current === undefined) continue;
			if (old.bytes.equals(current.bytes)) {
				result.unchanged++;
				// Unchanged, it must not have had to change: no counted Run was added late before any of its points, and none right before a Run of its pair entries.
				const should = `${path} did not change since the previous tree, but a Run added late before it should have changed it`;
				for (const point of pointsOf(blocksOf(current.value).requests_v1)) {
					const wrong = throughProblem(point, point);
					if (wrong !== null) problems.push(`${should}: /derivations/requests_v1: the point of Run ${String(point.run)}: ${wrong}`);
				}
				const ofSeries = blocksOf(current.value).series_v1;
				for (const entry of (isObject(ofSeries) && Array.isArray(ofSeries.differed) ? ofSeries.differed : []).filter(isObject)) {
					const right = predecessor.get(String(entry.to));
					if (right !== undefined && right !== String(entry.from) && added.has(right)) problems.push(`${should}: /derivations/series_v1: the pair entry to ${named(entry.to)} is from ${named(entry.from)}, but the Run right before it is now ${right}, added late`);
				}
				continue;
			}
			const unexplained = (what: string): void => {
				problems.push(`${path} changed since the previous tree in a way none of the four causes explains: ${what}`);
			};
			const oldForm = notWriterForm(path, old.text, old.value);
			const newForm = notWriterForm(path, current.text, current.value);
			if (oldForm !== null) unexplained(`the previous file ${oldForm}`);
			if (newForm !== null) unexplained(`this file ${newForm}`);
			if (oldForm !== null || newForm !== null || !isObject(old.value) || !isObject(current.value)) continue;
			const causes = new Map<Cause, string[]>();
			const because = (cause: Cause, detail: string): void => {
				causes.set(cause, [...(causes.get(cause) ?? []), detail]);
			};
			const problemsBefore = problems.length;
			const month = (MONTH_PATH.exec(path) as RegExpExecArray)[2] as string;

			const wasBlocks = blocksOf(old.value);
			const isBlocks = blocksOf(current.value);
			// The Runs this month gained: each a Run its Series did not have, filed under the month it started in.
			const gained = pointsOf(isBlocks.series_v1).filter((point) => !pointsOf(wasBlocks.series_v1).some((other) => other.run === point.run));
			if (!order(old.value, current.value)) unexplained(`its members are ${show(Object.keys(current.value))}, where they were ${show(Object.keys(old.value))}`);
			for (const key of Object.keys(old.value)) {
				if (key === "derivations" || same(old.value[key], current.value[key])) continue;
				if (["runs", "oldest_run_started_at", "newest_run_started_at"].includes(key) && gained.length > 0) continue;
				unexplained(`/${key} is ${show(current.value[key])}, where it was ${show(old.value[key])}`);
			}
			const wasKeys = Object.keys(wasBlocks);
			const isKeys = Object.keys(isBlocks);
			for (const key of wasKeys) if (!isKeys.includes(key)) unexplained(`/derivations/${key} is gone: a Method that derives a Series goes on deriving it`);
			if (!same(isKeys.filter((key) => wasKeys.includes(key)), wasKeys.filter((key) => isKeys.includes(key)))) unexplained(`/derivations holds its Methods in another order: ${show(isKeys)}, where it was ${show(wasKeys)}`);
			for (const key of isKeys) {
				if (wasKeys.includes(key)) continue;
				if (wasMethods.has(key)) unexplained(`/derivations/${key} is new to this month file, but the previous tree's Series ${id} was already derived by it`);
				else because("d", `${key} first derives the Series`);
			}

			for (const key of wasKeys.filter((name) => isKeys.includes(name))) {
				const wasBlock = wasBlocks[key];
				const isBlock = isBlocks[key];
				const at = `/derivations/${key}`;
				if (!isObject(wasBlock) || !isObject(isBlock)) {
					if (!same(wasBlock, isBlock)) unexplained(`${at} is ${show(isBlock)}, where it was ${show(wasBlock)}`);
					continue;
				}
				if (!order(wasBlock, isBlock)) unexplained(`${at}'s members are ${show(Object.keys(isBlock))}, where they were ${show(Object.keys(wasBlock))}`);
				for (const member of Object.keys(wasBlock)) {
					if (member === "points" || member === "differed" || same(wasBlock[member], isBlock[member])) continue;
					unexplained(`${at}/${member} is ${show(isBlock[member])}, where it was ${show(wasBlock[member])}`);
				}
				// The points: every published one still here, in the same order, each the same but for what a cause changes.
				const wasPoints = pointsOf(wasBlock);
				const isPoints = pointsOf(isBlock);
				const wasIds = wasPoints.map((point) => String(point.run));
				const isById = new Map(isPoints.map((point) => [String(point.run), point] as const));
				for (const run of wasIds) if (!isById.has(run)) unexplained(`${at}: Run ${run}, published in this month file, is no longer in it: a published Run never disappears`);
				if (!same(isPoints.map((point) => String(point.run)).filter((run) => wasIds.includes(run)), wasIds.filter((run) => isById.has(run)))) unexplained(`${at}: the published points are in another order`);
				for (const point of isPoints) {
					const run = String(point.run);
					if (wasIds.includes(run)) continue;
					if (!added.has(run)) unexplained(`${at}: Run ${run} is new to this month file, but the previous tree already held it in another`);
					else if (typeof point.started_at !== "string" || point.started_at.slice(0, 7) !== month) unexplained(`${at}: Run ${run}, added, started at ${show(point.started_at)}, not in ${month}`);
					else if (key === "series_v1" || !isBlocks.series_v1) because(isLate(run) ? "c" : "a", isLate(run) ? `Run ${run}, added late` : `Run ${run}`);
				}
				const allowed = LATE_RUN_MAY_CHANGE[key] ?? [];
				for (const was of wasPoints) {
					const run = String(was.run);
					const point = isById.get(run);
					if (point === undefined) continue;
					// requests v1's through, changed or not: what the Runs added late before it make it.
					const wrongThrough = key === "requests_v1" ? throughProblem(was, point) : null;
					if (wrongThrough !== null) unexplained(`${at}: the point of Run ${run}, after a Run added late: ${wrongThrough}`);
					if (same(was, point)) continue;
					if (!order(was, point)) {
						unexplained(`${at}: the point of Run ${run} holds its members in another order`);
						continue;
					}
					for (const member of Object.keys(was)) {
						if (same(was[member], point[member])) continue;
						if (member === "boot_summary" && was[member] === null && typeof point[member] === "string") because("b", `Run ${run}'s boot_summary arrived`);
						else if (allowed.includes(member) && afterAdded(was)) {
							if (!(member === "through" && wrongThrough !== null)) because("c", `${key} Run ${run}'s ${member}, after a Run added late`);
						} else unexplained(`${at}: the point of Run ${run}: ${member} is ${show(point[member])}, where it was ${show(was[member])}`);
					}
				}
				// The pair entries: each the same, or the entry of the Run right after a late Run, now from it.
				if (!("differed" in wasBlock)) continue;
				const wasEntries = (Array.isArray(wasBlock.differed) ? wasBlock.differed : []).filter(isObject);
				const isEntries = (Array.isArray(isBlock.differed) ? isBlock.differed : []).filter(isObject);
				const wasByTo = new Map(wasEntries.map((entry) => [String(entry.to), entry] as const));
				const isTo = isEntries.map((entry) => String(entry.to));
				for (const entry of wasEntries) if (!isTo.includes(String(entry.to))) unexplained(`${at}: the pair entry from ${named(entry.from)} to ${named(entry.to)} is gone`);
				if (!same(isTo.filter((to) => wasByTo.has(to)), wasEntries.map((entry) => String(entry.to)).filter((to) => isTo.includes(to)))) unexplained(`${at}: the published pair entries are in another order`);
				for (const entry of isEntries) {
					const to = String(entry.to);
					const from = String(entry.from);
					const was = wasByTo.get(to);
					if (was !== undefined && same(was, entry)) continue;
					if (was === undefined && added.has(to)) continue; // the added Run's own entry: (a) or (c), above
					// The entry of the Run right after a late Run: now from the late Run, its predecessor, and only what LATE_RUN_MAY_CHANGE_IN_PAIR lists changed.
					const fromLate = isLate(from) && predecessor.get(to) === from;
					const onlyListed = was === undefined || (from !== String(was.from) && order(was, entry) && Object.keys(was).every((member) => LATE_RUN_MAY_CHANGE_IN_PAIR.includes(member) || same(was[member], entry[member])));
					if (fromLate && onlyListed) because("c", `the pair entry of Run ${to}, now from Run ${from}, added late`);
					else unexplained(`${at}: the pair entry to ${to} is ${show(entry)}, where it was ${show(was)}`);
				}
			}
			if (problems.length === problemsBefore && causes.size === 0) unexplained("its bytes changed, but no value in it did");
			if (problems.length === problemsBefore) {
				result.explained.push({ path, causes: [...causes].sort(([a], [b]) => byText(a, b)).map(([cause, details]) => ({ cause, detail: details.join("; ") })) });
			}
		}
	}
	return result;
}

/** What a stability check found, for a human: the comparison made, then each month file that changed, by cause, and what the comparison cannot establish. */
export function describeStability(result: StabilityResult, previous: string): string[] {
	const layouts = `layout ${layoutName(result.layouts.current ?? null)} here${result.layouts.previous === undefined ? "" : `, ${layoutName(result.layouts.previous)} there`}`;
	if (!result.compared) {
		const lines = [`past months: not compared with ${previous}: ${result.none ?? "none given"} (${layouts})`];
		if (!result.newBaseline) return lines;
		lines.push("  a new baseline was declared by hand (--allow-no-previous): this tree is the baseline the next is compared with");
		const published = result.published;
		if (published === undefined) lines.push("  published Series and Runs: none to compare, there being no previous tree to read");
		else {
			const reading = [published.monthFiles > 0 ? `${published.monthFiles} month files` : "", published.seriesFilesWithPoints > 0 ? `${published.seriesFilesWithPoints} Series files holding points` : ""].filter((part) => part !== "").join(" and ");
			lines.push(
				`  published Series and Runs: the previous tree, read from ${reading === "" ? "no file holding points" : reading}${published.unread > 0 ? ` (${published.unread} files unreadable)` : ""}, published ${published.series} Series and ${published.runs} Runs; ` +
					`${result.problems.length === 0 ? "every one is in this tree" : "not every one is in this tree"}`,
			);
		}
		return lines;
	}
	const lines = [
		`past months: compared with ${previous} (${layouts}): ${result.inBoth} month files in both, ${result.unchanged} the same byte for byte, ${result.explained.length} changed for a cause, ${result.added} new`,
	];
	for (const cause of ["a", "b", "c", "d"] as const) {
		const files = result.explained.filter((file) => file.causes.some((one) => one.cause === cause));
		if (files.length === 0) continue;
		lines.push(`  (${cause}) ${CAUSES[cause]}: ${files.length} month file${files.length === 1 ? "" : "s"}`);
		for (const file of files) lines.push(`      ${file.path}: ${file.causes.find((one) => one.cause === cause)?.detail}`);
	}
	lines.push(`  ${NOT_ESTABLISHED}`);
	return lines;
}
