/**
 * The data API's bucket (ADR-0031): where the runs workflow puts the checked
 * tree of static files (scripts/build-api.ts, ADR-0030) after every run, in
 * private, so that the day the public serving is turned on
 * (infra/runs/public-blobs.ts, PUBLIC_API) it serves real, current files.
 *
 * A bucket of its own in the stage, not a prefix of the Runs bucket:
 *
 *   - the workflow's role writes here, and stays unable to write to the Runs
 *     bucket, which only the boxes and the deploy write to; a prefix would
 *     put the role's PutObject one wildcard away from every Run;
 *   - its objects are rewritten every round (the current month, the Series
 *     files, the list, the table of contents), where the Runs bucket's are
 *     written once and kept, versioned, for good: versioning here would keep
 *     every overwritten copy of a month file, which the Runs repository and
 *     the build already reproduce;
 *   - the public serving reads it through its own origin and its own bucket
 *     policy, so what readers can reach of each bucket is one list per bucket.
 *
 * It is private and not behind PUBLIC_API: it exists in every -runs stage,
 * holds only the tree, under v1/, and grants nothing to anyone until the
 * public serving is "on". It is not versioned, has no CORS (the public
 * serving adds Access-Control-Allow-Origin itself) and keeps SST's
 * HTTPS-only policy and public access block.
 *
 * Each object carries the headers it is served with: its Content-Type and its
 * Cache-Control, set by the upload (scripts/upload-api.ts), because the Free
 * flat-rate plan allows only AWS managed cache and response-headers policies
 * (README, "The public data API"), and the managed cache policy takes its
 * time to live from the object's own Cache-Control.
 *
 * Plain data: no SST global, so tests and scripts can import it; and nothing
 * that needs Bun, since the stack, bundled to run under Node, imports it.
 */

import { API_SCHEMAS } from "../../scripts/lib/api-schemas";
import type { PolicyDocument } from "./github-role";

/** Every key of the tree starts with it: the tree is served from the host's root exactly as written. */
export const TREE_PREFIX = "v1/";

/** Every file of the tree is JSON. */
export const TREE_CONTENT_TYPE = "application/json";

/**
 * Every file of the tree, whatever its kind: kept five minutes, by
 * CloudFront's edges and by readers alike, then revalidated by its ETag.
 * No address in v1/ is named by its content: the table of contents, the
 * list and a Series file change every round, a month file whenever one of
 * ADR-0030's four causes applies (the current month every round), a schema
 * whenever its words are edited, and a price file only if the Runs
 * repository's is ever corrected. So none can be cached as immutable; and
 * since a Series file lists each month file's sha256, a month file must not
 * outlive the Series file that lists it, so one time serves the whole tree.
 * Five minutes is under 2% of the six hours between the workflow's runs.
 */
export const TREE_CACHE_CONTROL = "public, max-age=300";

/**
 * The order of the upload: every file of a phase is written before any file
 * of the next, so that a reader who starts at the table of contents and
 * follows links down never finds one to a file that is not there yet. Each
 * file links down only to files of earlier phases: a month file to its
 * schema; a Series file to its month files and its schema; the list, and
 * each benchmark's list, to the Series files; the table of contents to the
 * lists, the price files and the schemas. The links up (to the table of
 * contents, the list, a month file's own Series file, a Series file's
 * benchmark's list) are to files a reader has come through or that list the
 * file; on the first upload, or for a Series or benchmark new this round,
 * they are written a phase or more later, and nothing links down to the
 * files that carry them until then (a Series file already published, written
 * again with its first benchmark_url, links its benchmark's list a phase
 * before that list is written: for that phase, on that one upload, the link
 * answers S3's 403).
 */
export const UPLOAD_PHASES = ["schemas", "month files and price files", "Series files", "the lists of Series", "the table of contents"] as const;

export interface TreeKind {
	kind: string;
	path: RegExp;
	/** Its index in UPLOAD_PHASES. */
	phase: number;
}

/** A leap year, as a regular expression over its four digits: divisible by 4, and not by 100 unless by 400. */
const LEAP_YEAR = "(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)";

/**
 * A day of the calendar, year, month and day joined by `separator` (as it is
 * written in a regular expression: "-", or "\\/"): months 01 to 12, and days
 * that month has, February the 29th in leap years only. What a date in a key
 * of the build's or a box's is: the start of a Run, a boot's day, a price
 * file's day, all written from a clock, never typed.
 */
export function calendarDate(separator: string): string {
	const s = separator;
	return (
		`(?:[0-9]{4}${s}(?:0[1-9]|1[0-2])${s}(?:0[1-9]|1[0-9]|2[0-8])` +
		`|[0-9]{4}${s}(?:0[13-9]|1[0-2])${s}(?:29|30)` +
		`|[0-9]{4}${s}(?:0[13578]|1[02])${s}31` +
		`|${LEAP_YEAR}${s}02${s}29)`
	);
}

/** A month of the calendar, yyyy-mm, months 01 to 12: a month file's name. */
export const CALENDAR_MONTH = "[0-9]{4}-(?:0[1-9]|1[0-2])";

/** The most characters of a benchmark's name that the address of its list of Series takes. */
export const BENCHMARK_NAME_CHARACTERS = 64;
/**
 * A benchmark's name as the address of its list of Series takes it,
 * unanchored: what the Run schema admits for a benchmark (a lower-case
 * letter, then lower-case letters, digits and underscores), at most
 * BENCHMARK_NAME_CHARACTERS long. The Run schema sets no length; a benchmark
 * is a directory of the repository, and the longest name on 2026-11-25 was
 * 22 characters (compressed_memory_read). A Series whose benchmark's name is
 * anything else has no such list, and is in the list of every Series alone.
 */
export const BENCHMARK_NAME = `[a-z][a-z0-9_]{0,${BENCHMARK_NAME_CHARACTERS - 1}}`;

/**
 * Every kind of file the build writes (scripts/lib/api.ts), and its upload
 * phase. Each pattern admits what the build can write and nothing more: the
 * schemas by the build's own list of them (API_SCHEMAS), a Series by its
 * 12-hex id, a month and a day as calendar values. The public serving
 * serves these, and the shapes it serves ahead of the build (SERVED_AHEAD),
 * and no other key under v1/ (infra/runs/public-blobs.ts, SERVED).
 */
export const TREE_KINDS: readonly TreeKind[] = [
	{ kind: "a schema", path: new RegExp(`^v1\\/schemas\\/(?:${API_SCHEMAS.map((schema) => schema.name).join("|")})\\.schema\\.json$`), phase: 0 },
	{ kind: "a month file", path: new RegExp(`^v1\\/series\\/[0-9a-f]{12}\\/${CALENDAR_MONTH}\\.json$`), phase: 1 },
	{ kind: "a price file", path: new RegExp(`^v1\\/prices\\/${calendarDate("-")}\\.json$`), phase: 1 },
	{ kind: "a Series file", path: /^v1\/series\/[0-9a-f]{12}\.json$/, phase: 2 },
	{ kind: "the list of Series", path: /^v1\/series\.json$/, phase: 3 },
	{ kind: "a benchmark's list of Series", path: new RegExp(`^v1\\/benchmarks\\/${BENCHMARK_NAME}\\.json$`), phase: 3 },
	{ kind: "the table of contents", path: /^v1\/index\.json$/, phase: 4 },
];

/** A shape of key under v1/ the public serving serves before the build writes it (SERVED_AHEAD). */
export interface AheadKind {
	kind: string;
	path: RegExp;
}

/**
 * The shapes of key under v1/ the public serving serves before the build
 * writes any file of them. The edge answers 404 to every key of no served
 * shape, and a production deploy, made by hand, is the only way it learns a
 * new one, while the runs workflow publishes a new tree every six hours on
 * its own. So a new kind of file, or a new schema, is served in a change of
 * its own, merged and deployed before the change that makes the build write
 * it, and no tree ever links an address the edge refuses (README, "Deploy",
 * "A new kind of file in the data API"). Until the build writes it, the edge
 * answers a request for one with S3's 403, as for any missing key of a
 * served shape. When the build writes it, its shape moves to TREE_KINDS (a
 * schema's name to API_SCHEMAS), and leaves this list.
 *
 * Now: none. Each benchmark's list of Series, v1/benchmarks/<benchmark>.json,
 * and its schema were the first served so, and moved to TREE_KINDS and
 * API_SCHEMAS when the build began writing them.
 */
export const SERVED_AHEAD: readonly AheadKind[] = [];

export interface TreeObject {
	kind: string;
	phase: number;
	contentType: string;
	cacheControl: string;
}

/**
 * What a file of the tree is, and the headers its object carries. Throws for
 * a path of no known kind: a kind the build starts writing gets its rule here
 * first, so that no file is ever uploaded with headers nobody chose.
 */
export function treeObject(path: string): TreeObject {
	const found = TREE_KINDS.find((kind) => kind.path.test(path));
	if (found === undefined) {
		throw new Error(`${JSON.stringify(path)} is of no kind of the data API's tree that infra/runs/api-bucket.ts knows (TREE_KINDS), so it has no headers to be uploaded with`);
	}
	return { kind: found.kind, phase: found.phase, contentType: TREE_CONTENT_TYPE, cacheControl: TREE_CACHE_CONTROL };
}

/**
 * What the runs workflow's role (RunsReaderRole) may do in the API bucket,
 * and nothing else: list it, and read and write objects under v1/. GetObject
 * is what a HEAD needs, to compare an object's SHA-256 with the file's before
 * writing it, and to check what was written. No DeleteObject: the upload
 * never deletes. The listing is not narrowed to v1/ by a condition on
 * s3:prefix: S3 answers a HEAD of a missing key with 404 only to a requester
 * that may list the bucket, and a HEAD carries no prefix for such a
 * condition to match, so a missing file would come back as a 403,
 * indistinguishable from a refusal; the bucket holds the tree and nothing
 * else, so listing all of it shows nothing more. Nothing of the Runs bucket
 * is in it; the role's own policy there (infra/runs/github-role.ts,
 * readPolicy) only reads.
 */
export function apiUploadPolicy(apiBucketArn: string): PolicyDocument {
	return {
		Version: "2012-10-17",
		Statement: [
			{ Effect: "Allow", Action: ["s3:ListBucket"], Resource: [apiBucketArn] },
			{ Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: [`${apiBucketArn}/${TREE_PREFIX}*`] },
		],
	};
}

/**
 * The API bucket's arguments: no CORS configuration, and, only while the
 * public serving is "on", a transform of SST's policy that adds the grant to
 * the distribution (public-blobs.ts, withGrants). Otherwise the policy is
 * SST's alone: HTTPS only, nothing granted.
 */
export function apiBucketArgs<T>(policyTransform: T | null): { cors: false; transform?: { policy: T } } {
	return policyTransform === null ? { cors: false } : { cors: false, transform: { policy: policyTransform } };
}
