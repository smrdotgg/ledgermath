/**
 * Checks a tree of the data API as it was written to disk (scripts/lib/api.ts),
 * against the Derivations it was cut from and the Runs repository checkout
 * whose evidence it links. Every way it fails is a problem; none, and the
 * tree may be kept:
 *
 * - The tree holds exactly the files it should: the table of contents, the
 *   list, the schemas, one file per Series of either file of Derivations and
 *   one per price file in the checkout; nothing missing, nothing else.
 * - Every Series of the Derivations has its row and its file, and every row
 *   and file is a Series of the Derivations; a Series file's points are its
 *   Derivations' Runs, Method by Method.
 * - Every file matches its schema, the tree's own copy: the price files as
 *   their schema is written, the API's own files with every object closed, so
 *   a field the schema does not describe is a problem here although the
 *   published schemas leave objects open for the fields v1 may gain.
 * - Every address under the base in the table of contents, the list and the
 *   Series files names a file: under v1/ a file of the tree, under runs/ or
 *   boots/ a file of the checkout. A point's or an unreadable Run's evidence
 *   is the base and its path, and the Run file there has the sha256 it gives.
 * - Each price file is byte for byte the checkout's.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

import type { DerivationsFile as RequestsFile } from "../../methods/requests/v1/output";
import { compareText } from "../../methods/run";
import type { DerivationsFile as SeriesFile } from "../../methods/v1/output";
import { API_SCHEMAS, INDEX_PATH, LIST_PATH, normalizeBase, pricePath, priceDate, readPriceFiles, type SchemaName, schemaPath, seriesPath } from "./api";

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
	/** Distinct Run files whose sha256 was checked. */
	runFiles: number;
}

type Json = Record<string, unknown>;

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

/** Every file under directory, by its path from it with forward slashes, in path order. */
function listFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => !entry.isDirectory())
		.map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort(compareText);
}

/** A path inside a directory: relative, forward slashes, no empty, "." or ".." parts. */
function isInside(path: string): boolean {
	return path.length > 0 && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function visitStrings(value: unknown, visit: (text: string) => void): void {
	if (typeof value === "string") visit(value);
	else if (Array.isArray(value)) for (const item of value) visitStrings(item, visit);
	else if (isObject(value)) for (const item of Object.values(value)) visitStrings(item, visit);
}

export function checkApi(sources: CheckSources): CheckResult {
	const problems: string[] = [];
	const base = normalizeBase(sources.base);
	const files = listFiles(sources.tree);
	const held = new Set(files);
	const read = (path: string): Uint8Array => new Uint8Array(readFileSync(join(sources.tree, ...path.split("/"))));
	const parse = (path: string): unknown => {
		try {
			return JSON.parse(new TextDecoder().decode(read(path)));
		} catch (error) {
			problems.push(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	};

	// The files the tree should hold, and no others.
	const seriesIds = new Map<string, string>();
	for (const d of sources.series.derivations) seriesIds.set(d.series.id, "series v1");
	for (const d of sources.requests.derivations) if (!seriesIds.has(d.series.id)) seriesIds.set(d.series.id, "requests v1");
	const prices = readPriceFiles(sources.runs);
	const expected = new Map<string, string>([
		[INDEX_PATH, "the table of contents"],
		[LIST_PATH, "the list of Series"],
		...API_SCHEMAS.map(({ name }) => [schemaPath(name), `the schema ${name}`] as [string, string]),
		...[...seriesIds].map(([id, method]) => [seriesPath(id), `Series ${id} of ${method}`] as [string, string]),
		...prices.map(({ path }) => [pricePath(priceDate(path)), `the price file ${path}`] as [string, string]),
	]);
	for (const [path, what] of expected) if (!held.has(path)) problems.push(`${path} is missing: ${what} has no file in the tree`);
	for (const path of files) {
		if (expected.has(path)) continue;
		const series = /^v1\/series\/([^/]+)\.json$/.exec(path);
		problems.push(series ? `${path} is in the tree, but Series ${series[1]} is in neither file of Derivations` : `${path} is in the tree, but is no file the tree should hold`);
	}

	// The schemas, as the tree serves them.
	const ajv = new Ajv2020({ strict: true, allErrors: true });
	const validators = new Map<SchemaName, ValidateFunction>();
	for (const { name } of API_SCHEMAS) {
		if (!held.has(schemaPath(name))) continue;
		const schema = parse(schemaPath(name));
		if (schema === undefined) continue;
		try {
			validators.set(name, ajv.compile((name === "prices" ? schema : closeSchema(schema)) as object));
		} catch (error) {
			problems.push(`${schemaPath(name)} does not compile: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const validate = (path: string, value: unknown, name: SchemaName): void => {
		const validator = validators.get(name);
		if (validator === undefined || validator(value)) return;
		const errors = (validator.errors ?? []).slice(0, 5).map((error) => {
			const extra = (error.params as { additionalProperty?: string }).additionalProperty;
			return `${error.instancePath || "/"} ${error.message ?? "is invalid"}${extra === undefined ? "" : `: ${extra}`}`;
		});
		problems.push(`${path} does not match ${schemaPath(name)}: ${errors.join("; ")}${(validator.errors?.length ?? 0) > 5 ? `; and ${(validator.errors?.length ?? 0) - 5} more` : ""}`);
	};

	// Addresses under the base, each checked once.
	const linked = new Map<string, string>();
	const checkLink = (from: string, url: string): void => {
		if (!url.startsWith(`${base}/`) || url.includes("{") || linked.has(url)) return;
		const path = url.slice(base.length + 1);
		let problem = "";
		if (path.startsWith("v1/")) {
			if (!held.has(path)) problem = `${from} links ${url}, which is not a file of the tree`;
		} else if (path.startsWith("runs/") || path.startsWith("boots/")) {
			if (!isInside(path) || !existsSync(join(sources.runs, ...path.split("/")))) problem = `${from} links ${url}, which is not a file of the Runs repository checkout ${sources.runs}`;
		} else problem = `${from} links ${url}, under the base but neither in the tree nor evidence`;
		linked.set(url, problem);
		if (problem !== "") problems.push(problem);
	};
	const checkLinks = (path: string, value: unknown): void => visitStrings(value, (text) => checkLink(path, text));

	// Evidence: the base and the path, and the Run file there with the sha256 given.
	const hashes = new Map<string, string | null>();
	const runSha256 = (path: string): string | null => {
		if (!hashes.has(path)) {
			const full = join(sources.runs, ...path.split("/"));
			hashes.set(path, isInside(path) && existsSync(full) && statSync(full).isFile() ? createHash("sha256").update(readFileSync(full)).digest("hex") : null);
		}
		return hashes.get(path) ?? null;
	};
	const checkEvidence = (where: string, cited: { path?: unknown; sha256?: unknown; evidence?: unknown }): void => {
		if (typeof cited.path !== "string" || typeof cited.evidence !== "string") return; // the schema says so
		if (cited.evidence !== `${base}/${cited.path}`) problems.push(`${where}: evidence ${cited.evidence} is not the address of its path, ${cited.path}`);
		const sha256 = runSha256(cited.path);
		if (sha256 === null) problems.push(`${where}: evidence ${cited.evidence} names a Run file that is not in the Runs repository checkout ${sources.runs}`);
		else if (sha256 !== cited.sha256) problems.push(`${where}: the Run file ${cited.path} in the checkout has sha256 ${sha256}, not ${String(cited.sha256)}`);
	};

	if (held.has(INDEX_PATH)) {
		const index = parse(INDEX_PATH);
		if (index !== undefined) {
			validate(INDEX_PATH, index, "index");
			if (isObject(index) && index.url !== `${base}/${INDEX_PATH}`) problems.push(`${INDEX_PATH} says its address is ${String(index.url)}, not ${base}/${INDEX_PATH}: the tree was built for another base`);
			checkLinks(INDEX_PATH, index);
		}
	}

	if (held.has(LIST_PATH)) {
		const list = parse(LIST_PATH);
		if (list !== undefined) {
			validate(LIST_PATH, list, "series-list");
			checkLinks(LIST_PATH, list);
			const rows = isObject(list) && Array.isArray(list.series) ? list.series : [];
			const rowIds = new Set<string>();
			for (const row of rows) {
				const id = isObject(row) ? String(row.id) : "";
				if (rowIds.has(id)) problems.push(`${LIST_PATH} has Series ${id} twice`);
				rowIds.add(id);
				if (!seriesIds.has(id)) problems.push(`${LIST_PATH} has a row for Series ${id}, which is in neither file of Derivations`);
			}
			for (const [id, method] of seriesIds) if (!rowIds.has(id)) problems.push(`${LIST_PATH} has no row for Series ${id} of ${method}`);
			const methods = isObject(list) && isObject(list.methods) ? list.methods : {};
			for (const [key, header] of Object.entries(methods)) {
				const unreadable = isObject(header) && Array.isArray(header.unreadable) ? header.unreadable : [];
				for (const run of unreadable) if (isObject(run)) checkEvidence(`${LIST_PATH}: ${key}'s unreadable Run ${String(run.id)}`, run);
			}
		}
	}

	const seriesV1 = new Map(sources.series.derivations.map((d) => [d.series.id, d]));
	const requestsV1 = new Map(sources.requests.derivations.map((d) => [d.series.id, d]));
	let seriesFiles = 0;
	for (const [id] of seriesIds) {
		const path = seriesPath(id);
		if (!held.has(path)) continue;
		const file = parse(path);
		if (file === undefined) continue;
		seriesFiles++;
		validate(path, file, "series");
		checkLinks(path, file);
		if (!isObject(file)) continue;
		if (file.id !== id) problems.push(`${path} holds Series ${String(file.id)}`);
		if (file.url !== `${base}/${path}`) problems.push(`${path} says its address is ${String(file.url)}, not ${base}/${path}`);
		const derivations = isObject(file.derivations) ? file.derivations : {};
		const methods: Array<[string, { runs: ReadonlyArray<{ id: string }> } | undefined]> = [
			["series_v1", seriesV1.get(id)],
			["requests_v1", requestsV1.get(id)],
		];
		for (const [key, derivation] of methods) {
			const block = derivations[key];
			if (derivation === undefined) {
				if (block !== undefined) problems.push(`${path} holds ${key}, which has no Derivation of Series ${id}`);
				continue;
			}
			if (!isObject(block)) {
				problems.push(`${path} holds no ${key}, whose Derivations have Series ${id}`);
				continue;
			}
			const points = Array.isArray(block.points) ? block.points : [];
			const runs = points.map((point) => (isObject(point) ? String(point.run) : ""));
			const cited = derivation.runs.map((run) => run.id);
			if (runs.join("\n") !== cited.join("\n")) problems.push(`${path}: ${key}'s points are ${runs.length} Runs, not the ${cited.length} its Derivation cites, in its order`);
			for (const point of points) if (isObject(point)) checkEvidence(`${path}: ${key}'s point ${String(point.run)}`, point);
		}
	}

	for (const { path } of prices) {
		const at = pricePath(priceDate(path));
		if (!held.has(at)) continue;
		const bytes = read(at);
		if (Buffer.compare(Buffer.from(bytes), readFileSync(join(sources.runs, ...path.split("/")))) !== 0) problems.push(`${at} is not byte for byte ${path} of the checkout`);
		const value = parse(at);
		if (value !== undefined) validate(at, value, "prices");
	}

	return { problems, files: files.length, series: seriesFiles, runFiles: hashes.size };
}
