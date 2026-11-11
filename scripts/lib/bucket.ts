/**
 * A bucket laid out like a -runs stage's (runs/, boots/, blobs/sha256/), read
 * only. Two implementations: the S3 bucket itself, through Bun's own S3
 * client, and a directory with the same layout, for tests and local copies.
 *
 * The S3 client takes its credentials from the environment
 * (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), as
 * aws-actions/configure-aws-credentials sets them in a workflow. Locally:
 *
 *     eval "$(aws configure export-credentials --profile tabot-dev --format env)"
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface BucketObject {
	key: string;
	size: number;
	/**
	 * The ETag's 32 hex digits, when it has that shape. For a single-part upload
	 * with SSE-S3 or no encryption it is the MD5 of the bytes; under SSE-KMS or
	 * SSE-C it has the same shape and is not. So a match with the MD5 of some
	 * bytes shows they are the object's, and a mismatch shows nothing.
	 */
	etag: string | null;
}

export interface Bucket {
	/** Every object whose key starts with prefix, in key order. */
	list(prefix: string): Promise<BucketObject[]>;
	/** An object's bytes, or null when there is no such key. */
	get(key: string): Promise<Uint8Array | null>;
	/** What this bucket is, for messages. */
	readonly name: string;
}

const ETAG_HEX = /^"?([0-9a-f]{32})"?$/;

export function md5Of(bytes: Uint8Array): string {
	return createHash("md5").update(bytes).digest("hex");
}

/** An ETag's 32 hex digits, or null when it does not have that shape (a multipart upload's has a -<parts> suffix). */
export function etagHex(etag: string | undefined): string | null {
	return ETAG_HEX.exec(etag ?? "")?.[1] ?? null;
}

export class S3Bucket implements Bucket {
	readonly name: string;
	private readonly client: Bun.S3Client;

	constructor(bucket: string, region: string) {
		this.name = `s3://${bucket}`;
		this.client = new Bun.S3Client({ bucket, region });
	}

	async list(prefix: string): Promise<BucketObject[]> {
		const objects: BucketObject[] = [];
		let continuationToken: string | undefined;
		do {
			const page = await this.client.list({ prefix, continuationToken });
			for (const object of page.contents ?? []) {
				if (object.size === undefined) throw new Error(`${this.name}: listing gave no size for ${object.key}`);
				objects.push({ key: object.key, size: object.size, etag: etagHex(object.eTag) });
			}
			continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
		} while (continuationToken !== undefined);
		return objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	}

	async get(key: string): Promise<Uint8Array | null> {
		try {
			return await this.client.file(key).bytes();
		} catch (error) {
			if ((error as { code?: unknown }).code === "NoSuchKey") return null;
			throw error;
		}
	}
}

/** A directory laid out like the bucket. Keys are paths from its root, with forward slashes. */
export class DirectoryBucket implements Bucket {
	readonly name: string;

	constructor(private readonly root: string) {
		this.name = root;
	}

	async list(prefix: string): Promise<BucketObject[]> {
		if (!existsSync(this.root)) return [];
		return readdirSync(this.root, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => relative(this.root, join(entry.parentPath, entry.name)).split(sep).join("/"))
			.filter((key) => key.startsWith(prefix))
			.sort()
			.map((key) => {
				const path = join(this.root, key);
				return { key, size: statSync(path).size, etag: md5Of(readFileSync(path)) };
			});
	}

	async get(key: string): Promise<Uint8Array | null> {
		const path = join(this.root, key);
		return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
	}
}
