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
 * Plain data: no SST global, so tests and scripts can import it.
 */

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
 * schema; a Series file to its month files and its schema; the list to the
 * Series files; the table of contents to the list, the price files and the
 * schemas. The links up (to the table of contents, the list, a month file's
 * own Series file) are to files a reader has come through; on the first
 * upload, or for a Series new this round, they are written a phase or more
 * later, and nothing links down to the files that carry them until then.
 */
export const UPLOAD_PHASES = ["schemas", "month files and price files", "Series files", "the list of Series", "the table of contents"] as const;

export interface TreeKind {
	kind: string;
	path: RegExp;
	/** Its index in UPLOAD_PHASES. */
	phase: number;
}

/** Every kind of file the build writes (scripts/lib/api.ts), and its upload phase. */
export const TREE_KINDS: readonly TreeKind[] = [
	{ kind: "a schema", path: /^v1\/schemas\/[a-z0-9-]+\.schema\.json$/, phase: 0 },
	{ kind: "a month file", path: /^v1\/series\/[0-9a-f]{12}\/[0-9]{4}-[0-9]{2}\.json$/, phase: 1 },
	{ kind: "a price file", path: /^v1\/prices\/[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$/, phase: 1 },
	{ kind: "a Series file", path: /^v1\/series\/[0-9a-f]{12}\.json$/, phase: 2 },
	{ kind: "the list of Series", path: /^v1\/series\.json$/, phase: 3 },
	{ kind: "the table of contents", path: /^v1\/index\.json$/, phase: 4 },
];

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
