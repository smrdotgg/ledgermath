/**
 * The reduced record of a Run's stream: what one Method needs of a stdout
 * blob, made once and kept, so that the stream is fetched again only for a
 * Run that has no record yet. Shared by every Method.
 *
 * A record is keyed by the stdout blob's hash and by its reducer's key,
 * `<method name>-v<version>-r<revision>`: the Method and version that made
 * it, and the revision of the record's form within that version, which goes
 * up whenever the code that makes a record, or the form it is kept in,
 * changes. A record found under its key is used as it is; a record that does
 * not parse, names another reducer or another blob, or does not have the
 * reducer's form is ignored, and the stream is fetched and reduced again.
 *
 * Whether the records are kept or not, a Method's Derivations are the same
 * bytes: a record holds exactly what the Method would have taken from the
 * stream, and the Method always uses a record as it reads back from its kept
 * form, on the run that makes it as on every later one (tests check it).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compareText, type FetchBlob } from "./run";

/** What a Method makes of a stream, and how its record is kept. */
export interface StreamReducer<R> {
	/** `<method name>-v<version>-r<revision>`. */
	key: string;
	/** The record of one stdout blob's bytes. */
	reduce(stdout: Uint8Array): R;
	/** The record as JSON, to keep. */
	toJson(record: R): unknown;
	/** A kept record read back, or null when it does not have the reducer's form. */
	fromJson(value: unknown): R | null;
}

/** Where records are kept between runs of a Method. */
export interface RecordStore {
	/** The kept JSON of a record, or null when there is none. */
	get(key: string, stdout: string): Promise<unknown>;
	put(key: string, stdout: string, value: unknown): Promise<void>;
}

const HASH = /^sha256:([0-9a-f]{64})$/;
const KEY = /^[a-z][a-z0-9_]*-v[0-9]+-r[0-9]+$/;

function hexOf(hash: string): string {
	const hex = HASH.exec(hash)?.[1];
	if (hex === undefined) throw new Error(`${JSON.stringify(hash)} is not a sha256:<hex> hash`);
	return hex;
}

/** What is written for a record: it names its reducer and its blob, so a misplaced file is never taken for another. */
interface Envelope {
	schema: "ledgermath.reduced/1";
	reducer: string;
	stdout: string;
	record: unknown;
}

function envelopeRecord(value: unknown, key: string, stdout: string): unknown {
	const envelope = value as Partial<Envelope> | null;
	if (typeof envelope !== "object" || envelope === null) return null;
	if (envelope.schema !== "ledgermath.reduced/1" || envelope.reducer !== key || envelope.stdout !== stdout) return null;
	return envelope.record ?? null;
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
			const envelope: Envelope = { schema: "ledgermath.reduced/1", reducer: key, stdout, record: value };
			writeFileSync(`${file}.tmp`, `${JSON.stringify(envelope)}\n`);
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
			const envelope: Envelope = { schema: "ledgermath.reduced/1", reducer: key, stdout, record: value };
			texts.set(`${key}/${stdout}`, JSON.stringify(envelope));
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
 * and let go. Throws if a blob that must be read cannot be fetched.
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
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < wanted.length) {
			const hash = wanted[next++] as string;
			const missing: number[] = [];
			for (const [index, reducer] of reducers.entries()) {
				const kept = store === null ? null : reducer.fromJson(await store.get(reducer.key, hash));
				if (kept === null) missing.push(index);
				else {
					found(index, hash, kept);
					counts.kept++;
				}
			}
			if (missing.length === 0) continue;
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
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
}
