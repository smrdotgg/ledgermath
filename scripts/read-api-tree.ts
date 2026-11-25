/**
 * Reads, from the API bucket itself, the files the website is built from, into a new directory
 * laid out as the API serves them: a tree for `bun run build --tree DIR` in site/ (ADR-0035).
 *
 *     bun scripts/read-api-tree.ts --bucket NAME --out DIR [--region us-east-2] [--endpoint URL]
 *
 * The bucket is what the public API serves, and what it holds is what is published: the runs
 * workflow's `publish` job writes it, and https://api.ledgermath.com serves it through a cache
 * that can be five minutes behind. So the production deploys read the bucket, not the edge and
 * not an artifact, inside their concurrency group, and build the page from exactly the bytes they
 * read (README, "Where it is deployed").
 *
 * It starts at v1/index.json and reads only the keys the table of contents' links give for the
 * files the site reads (the Series list and the newest price file): each link must be under the
 * table of contents' own address and a plain path to a JSON file under v1/, and that path is the
 * key (treePath in site/src/data/tree.ts). It never builds a key. Each read is one signed GET
 * (S3ApiStore.read, scripts/lib/api-upload.ts) with a time limit (TIMEOUT_MS) and a size limit
 * by file (LIMITS), with the credentials in the environment (the job's role, which it only
 * reads with). The three files must be of one publication: an upload by another run can be
 * under way, so a set that disagrees is read again, up to ATTEMPTS times in all, RETRY_WAIT_MS
 * apart, and nothing is written if it still disagrees (site/scripts/fetch-tree.ts, which this
 * reuses whole). The files are written all or none, into a directory beside DIR that then takes
 * DIR's name; DIR must not exist, or be empty.
 *
 * What it says when it fails names the file, the field of it that was refused, the key, the
 * HTTP status and S3's error code when it is a known one (ReadFailed): never a value refused
 * from a file (an address can carry a signature) and never S3's own message, neither of which
 * is this repository's to print in a public log.
 *
 * Exit 0 when the tree is written, 1 when it is not (with why), 2 on a bad command line.
 */

import { parseArgs } from "node:util";

import { ATTEMPTS, type FetchedTree, fetchTree, INDEX_URL, LIMITS, RETRY_WAIT_MS, TIMEOUT_MS } from "../site/scripts/fetch-tree";
import { INDEX_PATH, TreeError, TwoPublications } from "../site/src/data/tree";
import { S3ApiStore, S3Refused } from "./lib/api-upload";
import { hasDotSegment } from "./lib/s3-create";

/** A key the reader may ask for: a plain path to a JSON file under v1/, as treePath gives it. */
const KEY = /^v1\/[A-Za-z0-9._/-]+\.json$/;

/** A failure of the reader, in words that hold no value read from a file and no server's message. */
export class ReadFailed extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReadFailed";
	}
}

/** The key of a file at ADDRESS under the tree's address, or a description when it is not one. */
function keyOf(address: string): string {
	const base = INDEX_URL.slice(0, -INDEX_PATH.length);
	const path = address.startsWith(base) ? address.slice(base.length) : "";
	return KEY.test(path) && !hasDotSegment(path) ? path : "a file the table of contents links";
}

/** What files of two publications disagree on, by the check's own names for it, without the values. */
export const mismatchNames = (mismatches: readonly string[]): string[] => mismatches.map((mismatch) => mismatch.split(": ")[0] ?? "");

/** What a failure of the read says: see ReadFailed. */
export function failureWords(error: unknown): string {
	if (error instanceof ReadFailed) return error.message;
	if (error instanceof TwoPublications) return `the three files were of two publications each time they were read; they differ in ${mismatchNames(error.mismatches).join("; ")}`;
	if (error instanceof TreeError) return `${keyOf(error.file)}: ${error.path === "" ? "the file" : `the field ${error.path}`} was refused by the site's checks (its value is not printed)`;
	if (error instanceof Error && error.message.endsWith("exists and is not an empty directory: a tree is written into a new one")) return error.message;
	const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "an error";
	return `the tree could not be read or written (${name})`;
}

export type ReadOptions = {
	/** A stand-in's address in the tests; AWS's for the region otherwise. */
	endpoint?: string;
	region?: string;
	timeoutMs?: number;
	limits?: { index: number; seriesList: number; prices: number };
	attempts?: number;
	retryWaitMs?: number;
	/** The keys to use, asked for before every request; without it, the environment's. */
	credentials?: () => { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
	/** Told of each attempt whose files were of two publications, before the next. */
	onMismatch?: (attempt: number, mismatches: string[]) => void;
	/** Told of each key read, in order. */
	onRead?: (key: string) => void;
};

/** Reads the tree the site is built from out of BUCKET into DIR; see the comment at the top. */
export async function readApiTree(bucket: string, dir: string, options: ReadOptions = {}): Promise<FetchedTree> {
	const store = new S3ApiStore(bucket, options.region ?? "us-east-2", {
		...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
		...(options.credentials === undefined ? {} : { credentials: options.credentials }),
	});
	const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
	try {
		return await fetchTree(dir, {
			// The address the tree says it is served at: its links are under it, and its key is its path.
			index: INDEX_URL,
			limits: options.limits ?? LIMITS,
			attempts: options.attempts ?? ATTEMPTS,
			retryWaitMs: options.retryWaitMs ?? RETRY_WAIT_MS,
			...(options.onMismatch === undefined ? {} : { onMismatch: options.onMismatch }),
			read: async (file, limit) => {
				if (!KEY.test(file.path) || hasDotSegment(file.path) || (file.path !== INDEX_PATH && !file.url.endsWith(`/${file.path}`))) {
					throw new ReadFailed("a link of the table of contents is not a plain path to a JSON file under v1/: it is not read");
				}
				options.onRead?.(file.path);
				try {
					return await store.read(file.path, { limit, timeoutMs });
				} catch (error) {
					// S3ApiStore.read's words: the key, the status and a known code, never S3's message.
					throw new ReadFailed(error instanceof S3Refused ? error.message : `GET ${store.name}/${file.path} failed`);
				}
			},
		});
	} catch (error) {
		throw new ReadFailed(failureWords(error));
	}
}

const USAGE = "usage: bun scripts/read-api-tree.ts --bucket NAME --out DIR [--region REGION] [--endpoint URL]";

async function main(): Promise<void> {
	let values: { bucket?: string; out?: string; region?: string; endpoint?: string };
	try {
		({ values } = parseArgs({ options: { bucket: { type: "string" }, out: { type: "string" }, region: { type: "string" }, endpoint: { type: "string" } } }));
	} catch {
		console.error(USAGE);
		process.exit(2);
	}
	const { bucket, out, region, endpoint } = values;
	if (!bucket || !out || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
		console.error(bucket === "" ? `${USAGE}\n(--bucket is empty: is the repository variable API_BUCKET set?)` : USAGE);
		process.exit(2);
	}
	try {
		const tree = await readApiTree(bucket, out, {
			...(region === undefined ? {} : { region }),
			...(endpoint === undefined ? {} : { endpoint }),
			onMismatch: (attempt, mismatches) => console.error(`attempt ${attempt}: the files are of two publications (they differ in ${mismatchNames(mismatches).join("; ")}); reading them again`),
		});
		for (const file of tree.files) console.log(`${file.path}  ${file.bytes.toLocaleString("en")} bytes  from s3://${bucket}/${file.path}`);
		console.log(`wrote the tree to ${tree.dir}: newest Run ${tree.newestRunStartedAt}; ${tree.hasRecentRounds ? "the table of contents gives recent_rounds" : "the table of contents gives no recent_rounds"}`);
	} catch (error) {
		console.error(`no tree written: ${failureWords(error)}`);
		process.exit(1);
	}
}

if (import.meta.main) await main();
