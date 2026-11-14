/**
 * A bucket laid out like a -runs stage's (runs/, boots/, blobs/sha256/). Two
 * implementations: the S3 bucket itself, through Bun's own S3 client, and a
 * directory with the same layout, read only, for tests and local copies.
 *
 * The S3 client takes its credentials from the environment
 * (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), as
 * aws-actions/configure-aws-credentials sets them in a workflow, unless it is
 * given them (scripts/copy-bucket.ts reads one bucket and writes another, in
 * two accounts). Locally, with the profile of the stage whose bucket it is
 * (infra/runs/stages.ts: tabot-production for production-runs, tabot-dev for
 * any other):
 *
 *     eval "$(aws configure export-credentials --profile tabot-production --format env)"
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

/** Keys for S3, held in memory only. */
export interface S3Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

export interface S3BucketOptions {
	/**
	 * The keys to use, asked for before every request, so a provider can
	 * renew them before they expire. Without it, the environment's.
	 */
	credentials?: () => S3Credentials;
	/** Another endpoint than AWS's, path-style: a stand-in for S3 in the tests. */
	endpoint?: string;
}

/** What a HEAD of an object says. */
export interface ObjectHead {
	size: number;
	/** As BucketObject.etag. */
	etag: string | null;
	contentType: string;
}

/** A bucket that can also say what an object is, and add one. */
export interface WritableBucket extends Bucket {
	/** An object's size, ETag and Content-Type, or null when there is no such key. */
	head(key: string): Promise<ObjectHead | null>;
	/** Writes the object in one request, with exactly this Content-Type. */
	put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/**
 * What an error from S3 says, without anything that could carry a key: its
 * code and message, never a URL, a request or a response body.
 */
export function describeS3Error(error: unknown): string {
	if (typeof error !== "object" || error === null) return String(error);
	const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
	const label = typeof code === "string" && code !== "" ? code : typeof name === "string" && name !== "Error" ? name : "";
	const text = typeof message === "string" ? message.replace(/https?:\/\/\S+/g, "<url>") : "";
	if (label === "") return text === "" ? "Error" : text;
	return text === "" ? label : `${label}: ${text}`;
}

/** The text of an XML element in an S3 error body, or null. */
function xmlElement(body: string, name: string): string | null {
	return new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1] ?? null;
}

const PRESIGNED_PUT_SECONDS = 900;

export class S3Bucket implements WritableBucket {
	readonly name: string;
	private current: { credentials: S3Credentials | undefined; client: Bun.S3Client } | undefined;

	constructor(
		private readonly bucket: string,
		private readonly region: string,
		private readonly options: S3BucketOptions = {},
	) {
		this.name = `s3://${bucket}`;
	}

	/** The client for the keys of the moment: a new one when the provider hands out new keys. */
	private client(): Bun.S3Client {
		const credentials = this.options.credentials?.();
		if (this.current === undefined || this.current.credentials !== credentials) {
			this.current = {
				credentials,
				client: new Bun.S3Client({
					bucket: this.bucket,
					region: this.region,
					...(this.options.endpoint === undefined ? {} : { endpoint: this.options.endpoint }),
					...(credentials ?? {}),
				}),
			};
		}
		return this.current.client;
	}

	async list(prefix: string): Promise<BucketObject[]> {
		const objects: BucketObject[] = [];
		let continuationToken: string | undefined;
		do {
			const page = await this.client().list({ prefix, continuationToken });
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
			return await this.client().file(key).bytes();
		} catch (error) {
			if ((error as { code?: unknown }).code === "NoSuchKey") return null;
			throw error;
		}
	}

	async head(key: string): Promise<ObjectHead | null> {
		try {
			const stat = await this.client().file(key).stat();
			return { size: stat.size, etag: etagHex(stat.etag), contentType: stat.type };
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			if (code === "NoSuchKey" || code === "NotFound") return null;
			throw error;
		}
	}

	/**
	 * Through a presigned URL and fetch, not the client's write: the client
	 * adds ";charset=utf-8" to some types (application/json, text/plain),
	 * and the object must keep its type exactly. Only the host is signed; the
	 * URL carries the keys, so it is never shown, and a failure is reported
	 * by S3's error code and message alone.
	 */
	async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
		const url = this.client().presign(key, { method: "PUT", expiresIn: PRESIGNED_PUT_SECONDS });
		let response: Response;
		try {
			response = await fetch(url, { method: "PUT", body: bytes, headers: { "content-type": contentType } });
		} catch (error) {
			throw new Error(`${this.name}/${key}: PUT failed: ${describeS3Error(error)}`);
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			const code = xmlElement(body, "Code") ?? "no error code";
			const message = xmlElement(body, "Message") ?? "";
			throw new Error(`${this.name}/${key}: PUT answered ${response.status}, ${code}${message === "" ? "" : `: ${message}`}`);
		}
		await response.arrayBuffer();
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
