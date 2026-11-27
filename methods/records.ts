/**
 * The reduced record of a Run's stream: what one Method needs of a stdout
 * blob, made once and kept, so that the stream is fetched again only for a
 * Run that has no record yet. Shared by every Method.
 *
 * A record is keyed by the stdout blob's hash and by its reducer's key,
 * `<method name>-v<version>-<code>`: the Method and version that made it, and
 * the first 16 hex digits of the digest of the code that made it (codeDigest:
 * the source text of the reducer's module and of every file it imports,
 * transitively, and what the schemas that code reads say a value must be,
 * their titles and descriptions left out). Any change to that code,
 * remembered or not, gives a new key, so a record made by other code is never
 * read: its stream is fetched and reduced again. That is the cost of a change
 * to the code that reduces, every stream fetched once more, and it is
 * accepted: a record that may be wrong costs more than a fetch. A schema's
 * words change nothing the code computes, so they cost nothing.
 *
 * A record is kept with the sha256 of its own content. One found under its
 * key is used only when it parses, names its reducer and its blob, has that
 * digest, and holds together by the reducer's own checks (fromJson: counts,
 * bins, the support rule, the order of its statistics). Any other is ignored,
 * and the stream fetched and reduced again.
 *
 * Whether the records are kept or not, a Method's Derivations are the same
 * bytes: a record holds exactly what the Method would have taken from the
 * stream, and the Method always uses a record as it reads back from its kept
 * form, on the run that makes it as on every later one (tests check it).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { canonicalJson, compareText, type FetchBlob } from "./run";

/** The root of the source tree: paths in a code digest are relative to it. */
const ROOT = resolve(import.meta.dir, "..");

/** What a Method makes of a stream, and how its record is kept. */
export interface StreamReducer<R> {
	/** `<method name>-v<version>-<code>` (reducerKey). */
	key: string;
	/** The record of one stdout blob's bytes. */
	reduce(stdout: Uint8Array): R;
	/** The record as JSON, to keep. */
	toJson(record: R): unknown;
	/** A kept record read back, or null when it does not have the reducer's form or does not hold together. */
	fromJson(value: unknown): R | null;
}

/** Where records are kept between runs of a Method. */
export interface RecordStore {
	/** The kept JSON of a record, or null when there is none, or none that is whole. */
	get(key: string, stdout: string): Promise<unknown>;
	put(key: string, stdout: string, value: unknown): Promise<void>;
}

const HASH = /^sha256:([0-9a-f]{64})$/;
const KEY = /^[a-z][a-z0-9_]*-v[0-9]+-[0-9a-f]{16}$/;
/** An import or export from a module, with its specifier: `import … from "x"`, `export … from "x"`, `import "x"`. */
const IMPORT = /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[^;'"]*?\sfrom\s*)?["']([^"']+)["']/g;

function hexOf(hash: string): string {
	const hex = HASH.exec(hash)?.[1];
	if (hex === undefined) throw new Error(`${JSON.stringify(hash)} is not a sha256:<hex> hash`);
	return hex;
}

function resolveImport(from: string, specifier: string): string {
	const base = resolve(dirname(from), specifier);
	for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
		if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
	}
	throw new Error(`${relative(ROOT, from)} imports ${JSON.stringify(specifier)}, which is no .ts file`);
}

/** The keywords of a JSON Schema whose value is one schema. */
const ONE_SCHEMA: ReadonlySet<string> = new Set(["items", "additionalItems", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "if", "then", "else", "not"]);
/** Those whose value is a list of schemas (items too, as older drafts wrote it). */
const SCHEMA_LIST: ReadonlySet<string> = new Set(["allOf", "anyOf", "oneOf", "prefixItems", "items"]);
/** Those whose value maps names to schemas: the names are a member's, a pattern's or a definition's, never a keyword. */
const SCHEMA_MAP: ReadonlySet<string> = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
/** The annotations a schema's words are written in, which no validator reads. */
const ANNOTATIONS: ReadonlySet<string> = new Set(["title", "description"]);

/**
 * A JSON Schema with its words taken out: every string-valued title and
 * description where a schema can hold one, at its root and in every schema
 * inside it (under properties, items, a branch, a definition…). A member
 * named title or description is a name under properties, not an annotation,
 * and stays with its schema; so does anything under const, enum, default or
 * examples, which is a value, not a schema. The order of what remains is
 * kept: a validator reports what a value lacks in the order the schema lists
 * it, and those words go into a record's problems.
 */
export function withoutAnnotations(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema; // true, false, or not a schema
	const kept: Array<[string, unknown]> = [];
	for (const [key, value] of Object.entries(schema)) {
		if (ANNOTATIONS.has(key) && typeof value === "string") continue;
		if (SCHEMA_LIST.has(key) && Array.isArray(value)) kept.push([key, value.map(withoutAnnotations)]);
		else if (ONE_SCHEMA.has(key)) kept.push([key, withoutAnnotations(value)]);
		else if (SCHEMA_MAP.has(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
			kept.push([key, Object.fromEntries(Object.entries(value).map(([name, member]) => [name, withoutAnnotations(member)]))]);
		} else kept.push([key, value]);
	}
	return Object.fromEntries(kept);
}

/**
 * The digest of the code a reducer runs: the sha256, over the files in path
 * order, of each one's path from `root` and its content. The files are the
 * entry modules, every module they import by a relative path, transitively
 * (type-only imports too), whose content is their bytes, and `data`, the JSON
 * Schemas the code reads that no import names (the Run and event schemas),
 * whose content is what they say a value must be: the schema parsed, its
 * titles and descriptions taken out (withoutAnnotations), written as JSON
 * with no white space. So rewording or reflowing a schema leaves the digest as
 * it was, and a change to what it accepts (a type, a required list, a
 * pattern, a member) changes it. A module imported by a package name (ajv,
 * node:) is not in it: those are pinned by the lockfile.
 */
export function codeDigest(entries: readonly string[], data: readonly string[] = [], root = ROOT): { digest: string; files: string[] } {
	const seen = new Set<string>();
	const visit = (file: string): void => {
		if (seen.has(file)) return;
		seen.add(file);
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(IMPORT)) {
			const specifier = match[1] as string;
			if (specifier.startsWith(".")) visit(resolveImport(file, specifier));
		}
	};
	for (const entry of entries) visit(resolve(entry));
	const schemas = new Set(data.map((file) => resolve(root, file)));
	for (const file of schemas) seen.add(file);
	const files = [...seen].map((file) => ({ file, path: relative(root, file).split(sep).join("/") })).sort((a, b) => compareText(a.path, b.path));
	const hash = createHash("sha256");
	for (const { file, path } of files) {
		hash.update(`${path}\u0000`);
		hash.update(schemas.has(file) ? JSON.stringify(withoutAnnotations(JSON.parse(readFileSync(file, "utf8")))) : readFileSync(file));
		hash.update("\u0000");
	}
	return { digest: hash.digest("hex"), files: files.map(({ path }) => path) };
}

/** The files the shared Run reader (run.ts) reads at run time: the schemas it compiles, digested without their words. */
export const SCHEMA_FILES: readonly string[] = ["schemas/run.schema.json", "schemas/events.schema.json"];

/** `<name>-v<version>-<first 16 hex digits of the code digest of entry and what it imports>`. */
export function reducerKey(name: string, version: number, entry: string, data: readonly string[] = SCHEMA_FILES): string {
	return `${name}-v${version}-${codeDigest([entry], data).digest.slice(0, 16)}`;
}

/** The sha256 of a record's content, as kept: its canonical JSON (keys sorted, no whitespace). */
export function recordDigest(record: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(record)).digest("hex")}`;
}

/** What is written for a record: it names its reducer and its blob, so a misplaced file is never taken for another, and its own digest. */
interface Envelope {
	schema: "ledgermath.reduced/2";
	reducer: string;
	stdout: string;
	digest: string;
	record: unknown;
}

const envelopeOf = (key: string, stdout: string, record: unknown): Envelope => ({ schema: "ledgermath.reduced/2", reducer: key, stdout, digest: recordDigest(record), record });

function envelopeRecord(value: unknown, key: string, stdout: string): unknown {
	const envelope = value as Partial<Envelope> | null;
	if (typeof envelope !== "object" || envelope === null) return null;
	if (envelope.schema !== "ledgermath.reduced/2" || envelope.reducer !== key || envelope.stdout !== stdout) return null;
	if (envelope.record === undefined || envelope.digest !== recordDigest(envelope.record)) return null;
	return envelope.record;
}

/**
 * Records kept as files: <directory>/<reducer key>/<hex of the stdout blob>.json,
 * each written whole under a temporary name and then renamed into place.
 */
export function directoryRecords(directory: string): RecordStore {
	const path = (key: string, stdout: string): string => {
		if (!KEY.test(key)) throw new Error(`${JSON.stringify(key)} is not a reducer key`);
		return join(directory, key, `${hexOf(stdout)}.json`);
	};
	return {
		async get(key, stdout) {
			const file = path(key, stdout);
			if (!existsSync(file)) return null;
			try {
				return envelopeRecord(JSON.parse(readFileSync(file, "utf8")), key, stdout);
			} catch {
				return null; // a damaged file is no record: the stream is read again
			}
		},
		async put(key, stdout, value) {
			const file = path(key, stdout);
			mkdirSync(join(directory, key), { recursive: true });
			writeFileSync(`${file}.tmp`, `${JSON.stringify(envelopeOf(key, stdout, value))}\n`);
			renameSync(`${file}.tmp`, file);
		},
	};
}

/** Records kept in memory, as JSON text, for tests. */
export function memoryRecords(): RecordStore & { texts: Map<string, string> } {
	const texts = new Map<string, string>();
	return {
		texts,
		async get(key, stdout) {
			const text = texts.get(`${key}/${stdout}`);
			return text === undefined ? null : envelopeRecord(JSON.parse(text), key, stdout);
		},
		async put(key, stdout, value) {
			texts.set(`${key}/${stdout}`, JSON.stringify(envelopeOf(key, stdout, value)));
		},
	};
}

/** How many streams were fetched, and how many records were read back instead. */
export interface ReduceCounts {
	fetched: number;
	kept: number;
}

/**
 * Each stdout blob's record for each reducer. A blob whose records are all
 * kept is not fetched; any other is fetched once, at most `concurrency` at a
 * time, reduced by every reducer that lacks a record, its new records kept,
 * and let go. Throws if a blob that must be read cannot be fetched, once the
 * reads already started have ended, and starts none after it (eachAtMost).
 */
export async function reduceStreams(
	hashes: Iterable<string>,
	reducers: ReadonlyArray<StreamReducer<unknown>>,
	fetchStream: FetchBlob,
	store: RecordStore | null,
	concurrency = 16,
	counts: ReduceCounts = { fetched: 0, kept: 0 },
): Promise<Array<Map<string, unknown>>> {
	const results = reducers.map(() => new Map<string, unknown>());
	await walk(hashes, reducers, fetchStream, store, concurrency, counts, (index, hash, record) => {
		(results[index] as Map<string, unknown>).set(hash, record);
	});
	return results;
}

/**
 * Makes and keeps in `store` every record a reducer lacks, fetching each blob
 * that lacks one at most once, and holds none of them: what a run of several
 * Methods does first, so that no stream is fetched once per Method.
 */
export async function keepRecords(
	hashes: Iterable<string>,
	reducers: ReadonlyArray<StreamReducer<unknown>>,
	fetchStream: FetchBlob,
	store: RecordStore,
	concurrency = 16,
	counts: ReduceCounts = { fetched: 0, kept: 0 },
): Promise<void> {
	await walk(hashes, reducers, fetchStream, store, concurrency, counts, () => {});
}

/**
 * Calls `each` on every item, at most `concurrency` at a time, starting them
 * in order. On the first failure no other item is started, those already
 * started are let finish, and then that failure is thrown: once the caller is
 * told of a failure, nothing goes on reading behind its back (with Promise.all
 * alone, the other workers would go on fetching, beside whatever the caller
 * does next).
 */
export async function eachAtMost<T>(items: readonly T[], concurrency: number, each: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const failures: unknown[] = [];
	const worker = async (): Promise<void> => {
		while (failures.length === 0 && next < items.length) {
			const item = items[next++] as T;
			try {
				await each(item);
			} catch (error) {
				failures.push(error);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	if (failures.length > 0) throw failures[0];
}

async function walk(
	hashes: Iterable<string>,
	reducers: ReadonlyArray<StreamReducer<unknown>>,
	fetchStream: FetchBlob,
	store: RecordStore | null,
	concurrency: number,
	counts: ReduceCounts,
	found: (index: number, hash: string, record: unknown) => void,
): Promise<void> {
	const wanted = [...new Set(hashes)].sort(compareText);
	await eachAtMost(wanted, concurrency, async (hash) => {
		const missing: number[] = [];
		for (const [index, reducer] of reducers.entries()) {
			const kept = store === null ? null : reducer.fromJson(await store.get(reducer.key, hash));
			if (kept === null) missing.push(index);
			else {
				found(index, hash, kept);
				counts.kept++;
			}
		}
		if (missing.length === 0) return;
		const bytes = await fetchStream(hash);
		if (bytes === null) throw new Error(`blob ${hash} cannot be fetched`);
		counts.fetched++;
		for (const index of missing) {
			const reducer = reducers[index] as StreamReducer<unknown>;
			// The record is used as it reads back from its kept form, kept or not, so a
			// Method sees the same values on the run that makes a record as on every later one.
			const json = reducer.toJson(reducer.reduce(bytes));
			const record = reducer.fromJson(JSON.parse(JSON.stringify(json)));
			if (record === null) throw new Error(`reducer ${reducer.key} does not read back its own record of ${hash}`);
			found(index, hash, record);
			if (store !== null) await store.put(reducer.key, hash, json);
		}
	});
}
