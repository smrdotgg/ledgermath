import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex, signV4 } from "../scripts/lib/sigv4";
import {
	blobKey,
	type BlobStore,
	DirectoryBlobStore,
	type Fetch,
	publishSources,
	readSourcesLock,
	S3BlobStore,
	SOURCES_LOCK,
	type SourceEntry,
	type SourcesLock,
	verdict,
} from "../scripts/publish-third-party-source";

// scripts/publish-third-party-source.ts against stand-ins: a directory laid
// out like the bucket, and a local server that answers HEAD, GET and PUT as
// S3 does for what the script relies on (it checks each PUT's SigV4 signature
// and payload hash, and honours If-None-Match: *), with a fake fetch serving
// the source package. No network, no AWS.

const ROOT = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "publish-third-party-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PACKAGE = new TextEncoder().encode("a stand-in for a source package\n".repeat(1000));
const SHA256 = createHash("sha256").update(PACKAGE).digest("hex");
const KEY = blobKey(SHA256);
const PACKAGE_URL = "https://example.invalid/blobstore/stand-in-1.0.src.rpm";
/** The same length as PACKAGE, other bytes. */
const OTHER = new Uint8Array(PACKAGE.length).fill(0x78);

function lockFor(bytes = PACKAGE.length, sha256 = SHA256): SourcesLock {
	return readSourcesLock(
		JSON.stringify({
			description: "test",
			image: { id: "ami-0123456789abcdef0", release: "2023.0.0" },
			sources: [
				{
					name: "stand-in",
					version: "1.0",
					why: "test",
					binary_package: "stand-in-1.0.x86_64",
					file: "stand-in-1.0.src.rpm",
					url: PACKAGE_URL,
					bytes,
					sha256,
					content_type: "application/x-rpm",
				},
			],
		}),
	);
}

/** A fetch that serves `body` at PACKAGE_URL, counts its calls, and first runs `during` (to make something happen mid-download). */
function serving(body: Uint8Array, during?: () => void): Fetch & { calls: number } {
	const fetcher = (async (url: string | URL) => {
		fetcher.calls++;
		during?.();
		if (String(url) !== PACKAGE_URL) return new Response("not found", { status: 404, statusText: "Not Found" });
		return new Response(body, { headers: { "content-length": String(body.length) } });
	}) as Fetch & { calls: number };
	fetcher.calls = 0;
	return fetcher;
}

let n = 0;
const fresh = (name: string) => join(scratch, `${name}-${++n}`);

function place(root: string, key: string, bytes: Uint8Array): string {
	const path = join(root, key);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, bytes);
	return path;
}

describe("publishSources, into a directory laid out like the bucket", () => {
	test("uploads a package the bucket lacks, reads it back, and a second run uploads nothing", async () => {
		const store = new DirectoryBlobStore(fresh("bucket"));
		const work = fresh("work");
		const fetcher = serving(PACKAGE);
		const first = await publishSources(lockFor(), store, { fetcher, work });
		expect(first).toEqual([{ name: "stand-in", key: KEY, action: "uploaded" }]);
		expect(new Uint8Array(readFileSync(join(store.name, KEY)))).toEqual(PACKAGE);
		expect(readdirSync(work)).toEqual([]);
		expect(verdict(lockFor(), store.name, first)).toStartWith("VERIFIED: every source package of third-party/sources.lock.json (1 of 1)");

		const second = await publishSources(lockFor(), store, { fetcher, work });
		expect(second.map((result) => result.action)).toEqual(["present"]);
		expect(fetcher.calls).toBe(1);
	});

	test("a dry run says what it would upload and downloads nothing", async () => {
		const store = new DirectoryBlobStore(fresh("bucket"));
		const fetcher = serving(PACKAGE);
		const results = await publishSources(lockFor(), store, { fetcher, dryRun: true });
		expect(results.map((result) => result.action)).toEqual(["would upload"]);
		expect(fetcher.calls).toBe(0);
		expect(existsSync(join(store.name, KEY))).toBe(false);
		expect(verdict(lockFor(), store.name, results)).toStartWith("NOT YET: 0 of the 1 source packages");
	});

	test("refuses downloaded bytes whose hash or size is not the lock's, and creates nothing", async () => {
		const store = new DirectoryBlobStore(fresh("bucket"));
		const work = fresh("work");
		await expect(publishSources(lockFor(), store, { fetcher: serving(OTHER), work })).rejects.toThrow(/SHA-256 .* pins/);
		await expect(publishSources(lockFor(PACKAGE.length + 1), store, { fetcher: serving(PACKAGE), work })).rejects.toThrow(/gave \d+ bytes/);
		expect(existsSync(join(store.name, KEY))).toBe(false);
		expect(readdirSync(work)).toEqual([]);
	});

	test("a failed download leaves a file that was already in --work alone", async () => {
		const work = fresh("work");
		mkdirSync(work);
		writeFileSync(join(work, SHA256), "someone else's file");
		const failing: Fetch = async () => new Response("gone", { status: 404, statusText: "Not Found" });
		await expect(publishSources(lockFor(), new DirectoryBlobStore(fresh("bucket")), { fetcher: failing, work })).rejects.toThrow(/404/);
		expect(readdirSync(work)).toEqual([SHA256]);
		expect(readFileSync(join(work, SHA256), "utf8")).toBe("someone else's file");
	});

	test("an object of the right length with other bytes stops it, unread from the url and unchanged", async () => {
		const root = fresh("bucket");
		const path = place(root, KEY, OTHER);
		const fetcher = serving(PACKAGE);
		await expect(publishSources(lockFor(), new DirectoryBlobStore(root), { fetcher })).rejects.toThrow(/holds \d+ bytes with SHA-256 [0-9a-f]{64} already, not/);
		expect(fetcher.calls).toBe(0);
		expect(new Uint8Array(readFileSync(path))).toEqual(OTHER);
	});

	test("an object that appears during the download is not replaced: with the right bytes it is taken as there", async () => {
		const root = fresh("bucket");
		let placed = "";
		const fetcher = serving(PACKAGE, () => {
			placed = place(root, KEY, PACKAGE);
		});
		const results = await publishSources(lockFor(), new DirectoryBlobStore(root), { fetcher });
		expect(results.map((result) => result.action)).toEqual(["appeared"]);
		expect(lstatSync(placed).nlink).toBe(1); // the file placed, never linked over
	});

	test("an object that appears during the download with other bytes stops it, and stays as it was", async () => {
		const root = fresh("bucket");
		const fetcher = serving(PACKAGE, () => place(root, KEY, OTHER));
		await expect(publishSources(lockFor(), new DirectoryBlobStore(root), { fetcher })).rejects.toThrow(/appeared during the download/);
		expect(new Uint8Array(readFileSync(join(root, KEY)))).toEqual(OTHER);
	});

	test("checks the object after the upload, and stops when it is not the bytes uploaded", async () => {
		class Corrupting extends DirectoryBlobStore {
			override async create(key: string, path: string): Promise<"created" | "exists"> {
				const other = join(fresh("corrupt"));
				writeFileSync(other, OTHER);
				return super.create(key, other);
			}
		}
		const store = new Corrupting(fresh("bucket"));
		await expect(publishSources(lockFor(), store, { fetcher: serving(PACKAGE) })).rejects.toThrow(/after the upload, not/);
	});

	test("refuses a symbolic link on the path, and writes nothing through it", async () => {
		const root = fresh("bucket");
		const outside = fresh("outside");
		mkdirSync(root);
		mkdirSync(outside);
		symlinkSync(outside, join(root, "blobs"));
		await expect(publishSources(lockFor(), new DirectoryBlobStore(root), { fetcher: serving(PACKAGE) })).rejects.toThrow(/blobs is a symbolic link/);
		expect(readdirSync(outside)).toEqual([]);

		const linkedRoot = fresh("linked-root");
		symlinkSync(outside, linkedRoot);
		await expect(publishSources(lockFor(), new DirectoryBlobStore(linkedRoot), { fetcher: serving(PACKAGE) })).rejects.toThrow(/symbolic link/);
		expect(readdirSync(outside)).toEqual([]);
	});

	test("the verdict of a run that stopped says it is not verified", () => {
		expect(verdict(lockFor(), "s3://b", null)).toStartWith("NOT VERIFIED:");
	});
});

describe("S3BlobStore, against a local stand-in for S3", () => {
	const CREDENTIALS = { accessKeyId: "AKIDSTANDIN", secretAccessKey: "stand-in-secret", sessionToken: "stand-in-token" };
	const objects = new Map<string, { body: Uint8Array; type: string | null }>();
	const requests: string[] = [];
	const behaviour = { forbidMissing: false, conflicts: 0, corrupt: false };
	const puts: Array<{ status: number; headers: Record<string, string> }> = [];

	/** What S3 checks of a SigV4-signed PUT: the signature over the request as received, and the payload's hash. */
	function signatureProblem(request: Request, path: string, body: Uint8Array): string | null {
		const authorization = request.headers.get("authorization") ?? "";
		const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(authorization);
		if (m === null) return `malformed Authorization: ${authorization}`;
		const [, keyId, , region, signedHeaders, signature] = m as unknown as [string, string, string, string, string, string];
		const headers = (signedHeaders as string).split(";").map((name) => [name, request.headers.get(name) ?? ""] as [string, string]);
		const payload = request.headers.get("x-amz-content-sha256") ?? "";
		if (payload !== sha256Hex(body)) return "XAmzContentSHA256Mismatch";
		const expected = signV4({
			method: request.method,
			canonicalUri: path,
			canonicalQuery: "",
			headers,
			payloadSha256: payload,
			amzDate: request.headers.get("x-amz-date") ?? "",
			region,
			service: "s3",
			accessKeyId: keyId,
			secretAccessKey: CREDENTIALS.secretAccessKey,
		});
		return expected.signature === signature ? null : "SignatureDoesNotMatch";
	}

	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			requests.push(`${request.method} ${path}`);
			if (!path.startsWith("/stand-in-bucket/")) return new Response(null, { status: 400 });
			const key = decodeURIComponent(path.slice("/stand-in-bucket/".length));
			const object = objects.get(key);
			if (request.method === "HEAD" || request.method === "GET") {
				if (object === undefined) return new Response(null, { status: behaviour.forbidMissing ? 403 : 404 });
				const headers = { "content-length": String(object.body.length), etag: '"0"', "last-modified": new Date(0).toUTCString(), "content-type": object.type ?? "binary/octet-stream" };
				return new Response(request.method === "GET" ? object.body : null, { headers });
			}
			if (request.method === "PUT") {
				const body = new Uint8Array(await request.arrayBuffer());
				const headers = Object.fromEntries(request.headers.entries());
				const problem = signatureProblem(request, path, body);
				let status = 200;
				if (problem !== null) status = 403;
				else if (request.headers.get("if-none-match") === "*" && object !== undefined) status = 412;
				else if (behaviour.conflicts > 0) {
					behaviour.conflicts--;
					status = 409;
				} else {
					const stored = behaviour.corrupt ? body.map((byte, i) => (i === 0 ? byte ^ 1 : byte)) : body;
					objects.set(key, { body: stored, type: request.headers.get("content-type") });
				}
				puts.push({ status, headers });
				return new Response(problem ?? null, { status, headers: status === 200 ? { etag: '"0"' } : {} });
			}
			return new Response(null, { status: 405 });
		},
	});
	afterAll(() => server.stop(true));

	const store = (): BlobStore =>
		new S3BlobStore("stand-in-bucket", "us-east-2", { endpoint: `http://127.0.0.1:${server.port}`, credentials: CREDENTIALS });

	const reset = () => {
		objects.clear();
		requests.length = 0;
		puts.length = 0;
		Object.assign(behaviour, { forbidMissing: false, conflicts: 0, corrupt: false });
	};

	test("creates the object with one signed PUT, If-None-Match: *, the payload's hash and the lock's content type, then reads it back", async () => {
		reset();
		const fetcher = serving(PACKAGE);
		const first = await publishSources(lockFor(), store(), { fetcher });
		expect(first.map((result) => result.action)).toEqual(["uploaded"]);
		expect(puts).toHaveLength(1);
		const sent = puts[0]?.headers as Record<string, string>;
		expect(puts[0]?.status).toBe(200); // the stand-in checked the signature and the payload's hash
		expect(sent["if-none-match"]).toBe("*");
		expect(sent["x-amz-content-sha256"]).toBe(SHA256);
		expect(sent["content-length"]).toBe(String(PACKAGE.length));
		expect(sent["x-amz-security-token"]).toBe(CREDENTIALS.sessionToken);
		expect(sent.authorization).toContain("SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-security-token,");
		expect(objects.get(KEY)?.body).toEqual(PACKAGE);
		expect(objects.get(KEY)?.type).toBe("application/x-rpm");
		expect(requests).toContain(`GET /stand-in-bucket/${KEY}`); // read back after the upload

		const second = await publishSources(lockFor(), store(), { fetcher });
		expect(second.map((result) => result.action)).toEqual(["present"]);
		expect(puts).toHaveLength(1);
		expect(fetcher.calls).toBe(1);
	});

	test("an object that appears during the download makes S3 refuse the PUT (412), and is checked, not replaced", async () => {
		reset();
		const results = await publishSources(lockFor(), store(), { fetcher: serving(PACKAGE, () => objects.set(KEY, { body: PACKAGE, type: "x/placed" })) });
		expect(results.map((result) => result.action)).toEqual(["appeared"]);
		expect(puts.map((put) => put.status)).toEqual([412]);
		expect(objects.get(KEY)?.type).toBe("x/placed");

		reset();
		await expect(publishSources(lockFor(), store(), { fetcher: serving(PACKAGE, () => objects.set(KEY, { body: OTHER, type: "x/placed" })) })).rejects.toThrow(
			/appeared during the download/,
		);
		expect(puts.map((put) => put.status)).toEqual([412]);
		expect(objects.get(KEY)?.body).toEqual(OTHER);
	});

	test("an object of the right length with other bytes stops it before any download or PUT", async () => {
		reset();
		objects.set(KEY, { body: OTHER, type: null });
		const fetcher = serving(PACKAGE);
		await expect(publishSources(lockFor(), store(), { fetcher })).rejects.toThrow(/already, not the \d+ bytes/);
		expect(fetcher.calls).toBe(0);
		expect(puts).toHaveLength(0);
		expect(objects.get(KEY)?.body).toEqual(OTHER);
	});

	test("checks the object after the upload, and stops when S3 holds other bytes", async () => {
		reset();
		behaviour.corrupt = true;
		await expect(publishSources(lockFor(), store(), { fetcher: serving(PACKAGE) })).rejects.toThrow(/after the upload, not/);
	});

	test("tries a PUT again after 409 Conflict, at most three times in all", async () => {
		reset();
		behaviour.conflicts = 1;
		const results = await publishSources(lockFor(), store(), { fetcher: serving(PACKAGE) });
		expect(results.map((result) => result.action)).toEqual(["uploaded"]);
		expect(puts.map((put) => put.status)).toEqual([409, 200]);

		reset();
		behaviour.conflicts = 3;
		await expect(publishSources(lockFor(), store(), { fetcher: serving(PACKAGE) })).rejects.toThrow(/409/);
		expect(puts.map((put) => put.status)).toEqual([409, 409, 409]);
	});

	test("without s3:ListBucket (403 for a missing key) it stops at the HEAD, saying which permission", async () => {
		reset();
		behaviour.forbidMissing = true;
		const fetcher = serving(PACKAGE);
		await expect(publishSources(lockFor(), store(), { fetcher })).rejects.toThrow(/s3:ListBucket/);
		expect(fetcher.calls).toBe(0);
		expect(puts).toHaveLength(0);
	});
});

describe(SOURCES_LOCK, () => {
	test("is well formed, and names glibc's source package", () => {
		const lock = readSourcesLock(readFileSync(join(ROOT, SOURCES_LOCK), "utf8"));
		expect(lock.sources.map((entry: SourceEntry) => entry.name)).toContain("glibc");
		for (const entry of lock.sources) expect(entry.url.endsWith(`/${entry.file}`)).toBe(true);
	});

	test("refuses an entry without a 64-digit hash", () => {
		expect(() => lockFor(PACKAGE.length, "abc")).toThrow(/64 hex digits/);
	});
});
