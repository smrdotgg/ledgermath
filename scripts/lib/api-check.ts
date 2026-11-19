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
 *   would read it (strict-json.ts): UTF-8, with no byte-order mark, and no
 *   object holding a member name twice, so no two readers can read one file
 *   as two values.
 * - The tree holds exactly the files it should: the table of contents, the
 *   list, the four schemas, one file per Series of either file of
 *   Derivations and one per price file in the checkout; nothing else.
 * - Each schema in the tree is byte for byte this repository's, and every
 *   file matches this repository's schema of its kind: a price file as the
 *   schema is written, the API's own files with every object closed, so a
 *   field the schema does not describe is a problem here although the
 *   published schemas leave objects open for the fields v1 may gain.
 * - Each Series file equals what the Derivations hold for its Series: its
 *   identity, its count of Runs and the starts of its oldest and newest
 *   Run; under derivations, one key per Method that derives the Series, and
 *   under each every part of that Method's Derivation and its file's words,
 *   value for value. The only differences are those the design makes: each
 *   point gains its Run file's sha256 (the Derivation's), evidence and
 *   boot_summary, and the Derivation's series, method and runs are not
 *   repeated, being the file's head, its key and its points.
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
	/** Distinct Run files found in the checkout, read and hashed. */
	runFiles: number;
}

type Json = Record<string, unknown>;

const ROOT = resolve(import.meta.dir, "..", "..");

// The tree's layout, as ADR-0030 gives it.
const INDEX = "v1/index.json";
const LIST = "v1/series.json";
const seriesFile = (id: string): string => `v1/series/${id}.json`;
const priceFile = (date: string): string => `v1/prices/${date}.json`;
const schemaFile = (name: string): string => `v1/schemas/${name}.schema.json`;
/** The schemas the tree serves, in the table of contents' order: the files each describes, and the file of this repository it is. */
const SCHEMAS = [
	{ name: "index", describes: "v1/index.json", source: "schemas/api/v1/index.schema.json", closed: true },
	{ name: "series-list", describes: "v1/series.json", source: "schemas/api/v1/series-list.schema.json", closed: true },
	{ name: "series", describes: "v1/series/<id>.json", source: "schemas/api/v1/series.schema.json", closed: true },
	{ name: "prices", describes: "v1/prices/<yyyy-mm-dd>.json", source: "schemas/prices.schema.json", closed: false },
] as const;
type SchemaName = (typeof SCHEMAS)[number]["name"];
const SERIES_PATH = /^v1\/series\/([^/]+)\.json$/;
const TREE_PRICE = /^v1\/prices\/([0-9]{4})-([0-9]{2})-([0-9]{2})\.json$/;

/** At most this many points of one Method's part are reported as differing; then how many more. */
const POINTS_SHOWN = 10;

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

/** A Run file as the checkout holds it: the sha256 of its bytes, and what they parse to, if JSON. */
interface RunFileRead {
	sha256: string;
	record: unknown;
}

type SeriesDerivation = SeriesFile["derivations"][number];
type RequestsDerivation = RequestsFile["derivations"][number];
type CitedRun = SeriesDerivation["runs"][number];

export function checkApi(sources: CheckSources): CheckResult {
	const problems: string[] = [];
	const base = sources.base.replace(/\/+$/, "");
	const address = (path: string): string => `${base}/${path}`;
	const files = listFiles(sources.tree);
	const held = new Set(files);
	const read = (path: string): Buffer => readFileSync(join(sources.tree, ...path.split("/")));
	/** A file of the tree, read as strictly as its strictest reader would (strict-json.ts); undefined, and a problem, when it cannot be. */
	const parse = (path: string): unknown => {
		try {
			return parseStrictJson(read(path));
		} catch (error) {
			problems.push(`${path} is not strict JSON: ${error instanceof Error ? error.message : String(error)}`);
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
	let newest: string | null = null;
	for (const id of ids) {
		const starts = lead(id)
			.points.map((point) => point.started_at)
			.sort(byText);
		if (starts.length === 0) {
			problems.push(`Series ${id} has no Run in its Derivation`);
			continue;
		}
		const oldest = starts[0] as string;
		const latest = starts[starts.length - 1] as string;
		span.set(id, { oldest, newest: latest });
		if (newest === null || byText(latest, newest) > 0) newest = latest;
	}

	// The files the tree should hold, and no others.
	const checkoutPrices = listFiles(join(sources.runs, "prices"))
		.map((path) => `prices/${path}`)
		.filter((path) => PRICE_FILE_PATH.test(path));
	const dateOf = (path: string): string => path.replace(PRICE_FILE_PATH, "$1-$2-$3");
	const expected = new Map<string, string>([
		[INDEX, "the table of contents"],
		[LIST, "the list of Series"],
		...SCHEMAS.map(({ name }) => [schemaFile(name), `the schema ${name}`] as [string, string]),
		...ids.map((id) => [seriesFile(id), `Series ${id} of ${seriesV1.has(id) ? "series v1" : "requests v1"}`] as [string, string]),
		...checkoutPrices.map((path) => [priceFile(dateOf(path)), `the price file ${path}`] as [string, string]),
	]);
	for (const [path, what] of expected) if (!held.has(path)) problems.push(`${path} is missing: ${what} has no file in the tree`);
	for (const path of files) {
		if (expected.has(path)) continue;
		const series = SERIES_PATH.exec(path);
		problems.push(series ? `${path} is in the tree, but Series ${series[1]} is in neither file of Derivations` : `${path} is in the tree, but is no file the tree should hold`);
	}

	// The schemas: this repository's, byte for byte in the tree; and this repository's are what every file is validated against.
	const ajv = new Ajv2020({ strict: true, allErrors: true });
	const validators = new Map<SchemaName, ValidateFunction>();
	for (const { name, source, closed } of SCHEMAS) {
		const bytes = readFileSync(join(ROOT, source));
		if (held.has(schemaFile(name))) {
			if (!read(schemaFile(name)).equals(bytes)) problems.push(`${schemaFile(name)} is not byte for byte ${source} of this repository`);
			parse(schemaFile(name));
		}
		const schema: unknown = parseStrictJson(bytes);
		validators.set(name, ajv.compile((closed ? closeSchema(schema) : schema) as object));
	}
	const validate = (path: string, value: unknown, name: SchemaName): void => {
		const validator = validators.get(name) as ValidateFunction;
		if (validator(value)) return;
		const errors = (validator.errors ?? []).slice(0, 5).map((error) => {
			const extra = (error.params as { additionalProperty?: string }).additionalProperty;
			return `${error.instancePath || "/"} ${error.message ?? "is invalid"}${extra === undefined ? "" : `: ${extra}`}`;
		});
		problems.push(`${path} does not match ${schemaFile(name)}: ${errors.join("; ")}${(validator.errors?.length ?? 0) > 5 ? `; and ${(validator.errors?.length ?? 0) - 5} more` : ""}`);
	};

	// Link fields: each names a file under the base, checked once per address.
	const linked = new Set<string>();
	const link = (from: string, url: unknown, { mustBeUnderBase = true } = {}): void => {
		if (typeof url !== "string" || linked.has(url)) return; // the schema says what type it must be
		const under = url.startsWith(`${base}/`);
		if (!under && !mustBeUnderBase) return;
		linked.add(url);
		const path = under ? url.slice(base.length + 1) : "";
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
					series: { url: address(LIST), schema_url: address(schemaFile("series-list")), count: ids.length, series_file_schema_url: address(schemaFile("series")) },
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
			for (const url of [value.schema_url, value.url, ofSeries.url, ofSeries.schema_url, ofSeries.series_file_schema_url, ofPrices.schema_url]) link(INDEX, url);
			if (isObject(ofPrices.newest)) link(INDEX, ofPrices.newest.url);
			for (const entry of Array.isArray(ofPrices.files) ? ofPrices.files : []) if (isObject(entry)) link(INDEX, entry.url);
			for (const entry of Array.isArray(value.schemas) ? value.schemas : []) if (isObject(entry)) link(INDEX, entry.url);
			// The schema's pattern says what an address for the docs is written as; WHATWG's URL parser must read it as https with a host too.
			if (!isHttpsAddress(value.docs)) problems.push(`${INDEX}: docs is ${show(value.docs)}, not an absolute https address with a host`);
			link(INDEX, value.docs, { mustBeUnderBase: false });
		}
	}

	// The Series files, each against its Derivations; and what its row should say, read from the file.
	const rowsOfFiles = new Map<string, Json>();
	let seriesFiles = 0;
	for (const id of ids) {
		const path = seriesFile(id);
		if (!held.has(path)) continue;
		const file = parse(path);
		if (file === undefined) continue;
		seriesFiles++;
		validate(path, file, "series");
		if (!isObject(file)) continue;
		const derivation = lead(id);
		const times = span.get(id);
		compare(
			path,
			file,
			{
				schema: "ledgermath.api.series/1",
				schema_url: address(schemaFile("series")),
				index: address(INDEX),
				id,
				url: address(path),
				benchmark: derivation.series.benchmark,
				params: derivation.series.params,
				build: derivation.series.build,
				instance_type: derivation.series.instance_type,
				availability_zone_id: derivation.series.availability_zone_id,
				runs: derivation.runs.length,
				...(times === undefined ? {} : { oldest_run_started_at: times.oldest, newest_run_started_at: times.newest }),
			},
			"its Derivations and the base make it",
		);
		for (const url of [file.schema_url, file.index, file.url]) link(path, url);
		const derivations = isObject(file.derivations) ? file.derivations : {};
		const ofSeries = seriesV1.get(id);
		const ofRequests = requestsV1.get(id);
		members(`${path}: derivations`, derivations, [...(ofSeries === undefined ? [] : ["series_v1"]), ...(ofRequests === undefined ? [] : ["requests_v1"])]);
		const methods: Array<[string, SeriesDerivation | RequestsDerivation | undefined, Json, string]> = [
			[
				"series_v1",
				ofSeries,
				ofSeries === undefined
					? {}
					: {
							method: sources.series.method,
							definitions: sources.series.definitions,
							split_on: sources.series.split_on,
							left_out: sources.series.left_out,
							not_split_on: sources.series.not_split_on,
							percentiles: ofSeries.percentiles,
							groups: ofSeries.groups,
							differed: ofSeries.differed,
							sections: ofSeries.sections,
						},
				"series v1",
			],
			[
				"requests_v1",
				ofRequests,
				ofRequests === undefined
					? {}
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
							pool: ofRequests.pool,
							groups: ofRequests.groups,
						},
				"requests v1",
			],
		];
		for (const [key, method, parts, name] of methods) {
			const block = derivations[key];
			if (method === undefined || !isObject(block)) continue;
			const where = `${path}: ${key}`;
			members(where, block, [...Object.keys(parts), "points"]);
			compare(where, block, parts, `${name}'s Derivation of Series ${id} holds it`);
			// Every point is the Derivation's, with what the tree adds: its Run file's sha256, as cited; and its evidence and its boot's summary, which checkEvidence reads from the checkout.
			const points = Array.isArray(block.points) ? block.points : [];
			if (points.length !== method.points.length) problems.push(`${where}: /points has ${points.length} items, not the ${method.points.length} of ${name}'s Derivation of Series ${id}`);
			let differing = 0;
			points.forEach((point: unknown, i: number) => {
				const derived = method.points[i];
				const cited: CitedRun | undefined = method.runs[i];
				if (derived === undefined || !isObject(point)) return;
				if (cited === undefined || cited.id !== derived.run || cited.path !== derived.path) {
					problems.push(`${where}: ${name}'s Derivation of Series ${id} cites another Run at ${i} than its point ${i}`);
					return;
				}
				const { evidence: _evidence, boot_summary: _bootSummary, ...own } = point;
				const found = difference(own, { ...derived, sha256: cited.sha256 });
				if (found !== null && ++differing <= POINTS_SHOWN) problems.push(`${where}: point ${i}: ${found}, as ${name}'s Derivation of Series ${id} holds it`);
				checkEvidence(`${where}'s point ${String(point.run)}`, point);
				link(path, point.evidence);
				if (point.boot_summary !== null) link(path, point.boot_summary);
			});
			if (differing > POINTS_SHOWN) problems.push(`${where}: and ${differing - POINTS_SHOWN} more points differ`);
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
			for (const id of ids) if (!rowIds.has(id)) problems.push(`${LIST} has no row for Series ${id} of ${seriesV1.has(id) ? "series v1" : "requests v1"}`);
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

	return { problems, files: files.length, series: seriesFiles, runFiles: [...runFiles.values()].filter((file) => file !== null).length };
}

/**
 * The row a Series file makes, by the design: every field the row shares
 * with the file, with the file's value, and each Method's summary made from
 * the file's own figures (its points counted and not, its groups, and its
 * percentiles or pooled figures without the Runs or histograms behind them).
 */
function rowOf(file: Json): Json {
	const derivations = file.derivations as Json;
	const counts = (points: Json[]): Json => {
		const counted = points.filter((point) => point.counted === true).length;
		return { counted_runs: counted, failed_runs: points.length - counted };
	};
	const summary = (stat: unknown): unknown => {
		if (stat === null) return null;
		const { count, p5, p50, p95 } = stat as Json;
		return { count, p5, p50, p95 };
	};
	const series = derivations.series_v1 as Json;
	const percentiles = series.percentiles as Json;
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
				...counts(series.points as Json[]),
				groups: (series.groups as unknown[]).length,
				percentiles: { time_per_repetition_ns: summary(percentiles.time_per_repetition_ns), bytes_per_second: summary(percentiles.bytes_per_second) },
			},
		},
	};
	const requests = derivations.requests_v1 as Json | undefined;
	if (requests !== undefined) {
		const pool = requests.pool as Json;
		(row.derivations as Json).requests_v1 = {
			method: requests.method,
			...counts(requests.points as Json[]),
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
