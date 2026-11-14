/**
 * A stand-in for S3 for the tests, on a local port, path-style: buckets held
 * in memory, and the requests Bun's S3 client and scripts/lib/s3-create.ts
 * make (ListObjectsV2, HEAD, GET, PUT). Not S3. Each request's access key ID,
 * from its Authorization header or a presigned URL, must be one the bucket
 * allows for reading or for writing, so a test can tell which keys were used
 * where. A PUT is held to what S3 checks of it: If-None-Match: * refuses an
 * existing key (412), an x-amz-content-sha256 must be the body's SHA-256
 * (400), and, for a key ID whose secret the stand-in is given, the SigV4
 * signature must be right (403); other requests' signatures are not checked.
 * Every write is counted per key, so an overwrite shows. A bucket can give
 * ETags that are not the MD5 of the bytes, as S3 does under SSE-KMS. A test
 * can answer any request itself (fault).
 */

import { createHash } from "node:crypto";

import { signV4 } from "../scripts/lib/sigv4";

export interface StoredObject {
	bytes: Uint8Array;
	contentType: string;
	/** How many times the key was written. */
	writes: number;
}

export interface StandinRequest {
	method: string;
	bucket: string;
	key: string;
	keyId: string | null;
	/** The If-None-Match header, or null. */
	ifNoneMatch: string | null;
}

export interface StandinBucket {
	objects: Map<string, StoredObject>;
	readers: Set<string>;
	writers: Set<string>;
	/** ETags that are not the MD5 of the bytes, as under SSE-KMS: 32 hex digits all the same. */
	opaqueEtags: boolean;
}

const xml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const md5 = (bytes: Uint8Array): string => createHash("md5").update(bytes).digest("hex");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Whether a SigV4 Authorization header signs the request as received, with this secret. */
function signatureHolds(request: Request, url: URL, secret: string): boolean {
	const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/\d{8}\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(request.headers.get("authorization") ?? "");
	if (match === null) return false;
	const [, keyId, region, signedHeaders, signature] = match as unknown as [string, string, string, string, string];
	const expected = signV4({
		method: request.method,
		canonicalUri: url.pathname,
		canonicalQuery: "",
		headers: signedHeaders.split(";").map((name) => [name, request.headers.get(name) ?? ""] as [string, string]),
		payloadSha256: request.headers.get("x-amz-content-sha256") ?? "",
		amzDate: request.headers.get("x-amz-date") ?? "",
		region,
		service: "s3",
		accessKeyId: keyId,
		secretAccessKey: secret,
	});
	return expected.signature === signature;
}

function error(status: number, code: string, message: string): Response {
	return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`, {
		status,
		headers: { "content-type": "application/xml" },
	});
}

export class S3Standin {
	readonly buckets = new Map<string, StandinBucket>();
	readonly requests: StandinRequest[] = [];
	/** Objects in a listing page; small, so paging is exercised. */
	pageSize = 7;
	/** Answers a request instead of the stand-in when it returns a Response. */
	fault: ((request: StandinRequest) => Response | undefined) | undefined;
	/** Secrets by key ID: a PUT signed in the Authorization header by one of these keys must have a right signature. */
	readonly secrets = new Map<string, string>();
	private server: ReturnType<typeof Bun.serve> | undefined;

	/** A bucket that the keys in `readers` may read and those in `writers` may read and write. */
	bucket(name: string, access: { readers?: string[]; writers?: string[]; opaqueEtags?: boolean }): StandinBucket {
		const bucket: StandinBucket = {
			objects: new Map(),
			readers: new Set(access.readers ?? []),
			writers: new Set(access.writers ?? []),
			opaqueEtags: access.opaqueEtags ?? false,
		};
		this.buckets.set(name, bucket);
		return bucket;
	}

	put(bucket: string, key: string, bytes: Uint8Array | string, contentType = "binary/octet-stream"): void {
		const body = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
		const found = this.buckets.get(bucket);
		if (found === undefined) throw new Error(`no bucket ${bucket}`);
		found.objects.set(key, { bytes: body, contentType, writes: 1 });
	}

	get url(): string {
		if (this.server === undefined) throw new Error("the stand-in is not started");
		return `http://127.0.0.1:${this.server.port}`;
	}

	start(): void {
		this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => this.answer(request) });
	}

	stop(): void {
		this.server?.stop(true);
	}

	private async answer(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const [bucketName = "", ...rest] = url.pathname.slice(1).split("/");
		const key = rest.map((part) => decodeURIComponent(part)).join("/");
		const credential = /Credential=([^/,\s]+)\//.exec(request.headers.get("authorization") ?? "")?.[1] ?? url.searchParams.get("X-Amz-Credential")?.split("/")[0] ?? null;
		const seen: StandinRequest = { method: request.method, bucket: bucketName, key, keyId: credential, ifNoneMatch: request.headers.get("if-none-match") };
		this.requests.push(seen);
		const body = new Uint8Array(await request.arrayBuffer());
		const faulty = this.fault?.(seen);
		if (faulty !== undefined) return faulty;

		const bucket = this.buckets.get(bucketName);
		if (bucket === undefined) return error(404, "NoSuchBucket", "The specified bucket does not exist");
		const writing = request.method === "PUT";
		const allowed = credential !== null && (bucket.writers.has(credential) || (!writing && bucket.readers.has(credential)));
		if (!allowed) return error(403, "AccessDenied", "Access Denied");

		if (request.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
			const prefix = url.searchParams.get("prefix") ?? "";
			const after = url.searchParams.get("continuation-token");
			const keys = [...bucket.objects.keys()].filter((name) => name.startsWith(prefix) && (after === null || name > after)).sort();
			const page = keys.slice(0, this.pageSize);
			const truncated = keys.length > page.length;
			const contents = page
				.map((name) => {
					const object = bucket.objects.get(name) as StoredObject;
					return `<Contents><Key>${xml(name)}</Key><LastModified>2026-11-14T00:00:00.000Z</LastModified><ETag>&quot;${bucket.opaqueEtags ? "e".repeat(32) : md5(object.bytes)}&quot;</ETag><Size>${object.bytes.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
				})
				.join("");
			const next = truncated ? `<NextContinuationToken>${xml(page.at(-1) as string)}</NextContinuationToken>` : "";
			return new Response(
				`<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult><Name>${xml(bucketName)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${this.pageSize}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`,
				{ headers: { "content-type": "application/xml" } },
			);
		}
		const object = bucket.objects.get(key);
		const etag = (bytes: Uint8Array): string => (bucket.opaqueEtags ? "e".repeat(32) : md5(bytes));
		const headers = (stored: StoredObject): Record<string, string> => ({
			"content-type": stored.contentType,
			"content-length": String(stored.bytes.length),
			etag: `"${etag(stored.bytes)}"`,
			"last-modified": new Date("2026-11-14T00:00:00Z").toUTCString(),
		});
		if (request.method === "HEAD") return object === undefined ? new Response(null, { status: 404 }) : new Response(null, { headers: headers(object) });
		if (request.method === "GET") {
			return object === undefined ? error(404, "NoSuchKey", "The specified key does not exist.") : new Response(object.bytes, { headers: headers(object) });
		}
		if (writing) {
			const secret = credential === null ? undefined : this.secrets.get(credential);
			if (secret !== undefined && request.headers.has("authorization") && !signatureHolds(request, url, secret)) {
				return error(403, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided.");
			}
			const payload = request.headers.get("x-amz-content-sha256");
			if (payload !== null && payload !== "UNSIGNED-PAYLOAD" && payload !== sha256(body)) {
				return error(400, "XAmzContentSHA256Mismatch", "The provided 'x-amz-content-sha256' header does not match what was computed.");
			}
			if (request.headers.get("if-none-match") === "*" && object !== undefined) {
				return error(412, "PreconditionFailed", "At least one of the pre-conditions you specified did not hold");
			}
			const stored: StoredObject = { bytes: body, contentType: request.headers.get("content-type") ?? "binary/octet-stream", writes: (object?.writes ?? 0) + 1 };
			bucket.objects.set(key, stored);
			return new Response(null, { headers: { etag: `"${etag(body)}"` } });
		}
		return error(405, "MethodNotAllowed", `${request.method} is not answered here`);
	}
}
