import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	blobKey,
	type BlobStore,
	DirectoryBlobStore,
	type Fetch,
	publishSources,
	readSourcesLock,
	S3BlobStore,
	SOURCES_LOCK,
	type SourcesLock,
} from "../scripts/publish-third-party-source";

// scripts/publish-third-party-source.ts against stand-ins: a directory laid
// out like the bucket, and a local server answering S3's HEAD and PUT, with
// a fake fetch serving the source package. No network, no AWS.

const ROOT = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "publish-third-party-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PACKAGE = new TextEncoder().encode("a stand-in for a source package\n".repeat(1000));
const SHA256 = createHash("sha256").update(PACKAGE).digest("hex");
const PACKAGE_URL = "https://example.invalid/blobstore/stand-in-1.0.src.rpm";

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

/** A fetch that serves `body` at URL and counts its calls. */
function serving(body: Uint8Array): Fetch & { calls: number } {
	const fetcher = (async (url: string) => {
		fetcher.calls++;
		if (url !== PACKAGE_URL) return new Response("not found", { status: 404 });
		return new Response(body, { headers: { "content-length": String(body.length) } });
	}) as Fetch & { calls: number };
	fetcher.calls = 0;
	return fetcher;
}

let n = 0;
const fresh = (name: string) => join(scratch, `${name}-${++n}`);

describe("publishSources, into a directory laid out like the bucket", () => {
	test("uploads a package the bucket lacks, and a second run uploads nothing", async () => {
		const store = new DirectoryBlobStore(fresh("bucket"));
		const work = fresh("work");
		const fetcher = serving(PACKAGE);
		const first = await publishSources(lockFor(), store, { fetcher, work });
		expect(first).toEqual([{ name: "stand-in", key: `blobs/sha256/${SHA256}`, action: "uploaded" }]);
		expect(new Uint8Array(readFileSync(join(store.name, blobKey(SHA256))))).toEqual(PACKAGE);
		expect(readdirSync(work)).toEqual([]);

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
		expect(existsSync(join(store.name, blobKey(SHA256)))).toBe(false);
	});

	test("refuses bytes whose hash is not the lock's, and uploads nothing", async () => {
		const store = new DirectoryBlobStore(fresh("bucket"));
		const work = fresh("work");
		const other = new TextEncoder().encode("other bytes of the same length\n".padEnd(PACKAGE.length, "x"));
		expect(other.length).toBe(PACKAGE.length);
		await expect(publishSources(lockFor(), store, { fetcher: serving(other), work })).rejects.toThrow(/SHA-256 .* pins/);
		expect(existsSync(join(store.name, blobKey(SHA256)))).toBe(false);
		expect(readdirSync(work)).toEqual([]);
	});

	test("refuses bytes of another size", async () => {
		const store = new DirectoryBlobStore(fresh("bucket"));
		await expect(publishSources(lockFor(PACKAGE.length + 1), store, { fetcher: serving(PACKAGE) })).rejects.toThrow(/gave \d+ bytes/);
		expect(existsSync(join(store.name, blobKey(SHA256)))).toBe(false);
	});

	test("refuses a failed download", async () => {
		const store = new DirectoryBlobStore(fresh("bucket"));
		const failing: Fetch = async () => new Response("gone", { status: 404, statusText: "Not Found" });
		await expect(publishSources(lockFor(), store, { fetcher: failing })).rejects.toThrow(/404/);
	});

	test("stops, overwriting nothing, when the key holds an object of another size", async () => {
		const root = fresh("bucket");
		const key = join(root, blobKey(SHA256));
		mkdirSync(join(root, "blobs", "sha256"), { recursive: true });
		writeFileSync(key, "short");
		const fetcher = serving(PACKAGE);
		await expect(publishSources(lockFor(), new DirectoryBlobStore(root), { fetcher })).rejects.toThrow(/never overwritten/);
		expect(readFileSync(key, "utf8")).toBe("short");
		expect(fetcher.calls).toBe(0);
	});
});

describe("S3BlobStore, against a local stand-in for S3", () => {
	const objects = new Map<string, { body: Uint8Array; type: string | null }>();
	const requests: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const path = decodeURIComponent(new URL(request.url).pathname);
			requests.push(`${request.method} ${path}`);
			if (!path.startsWith("/stand-in-bucket/")) return new Response(null, { status: 400 });
			const key = path.slice("/stand-in-bucket/".length);
			const object = objects.get(key);
			if (request.method === "HEAD") {
				if (object === undefined) return new Response(null, { status: 404 });
				return new Response(null, {
					headers: { "content-length": String(object.body.length), etag: '"0"', "last-modified": new Date(0).toUTCString(), "content-type": object.type ?? "binary/octet-stream" },
				});
			}
			if (request.method === "PUT") {
				objects.set(key, { body: new Uint8Array(await request.arrayBuffer()), type: request.headers.get("content-type") });
				return new Response(null, { headers: { etag: '"0"' } });
			}
			return new Response(null, { status: 405 });
		},
	});
	afterAll(() => server.stop(true));

	const store: BlobStore = new S3BlobStore("stand-in-bucket", "us-east-2", {
		endpoint: `http://127.0.0.1:${server.port}`,
		accessKeyId: "stand-in",
		secretAccessKey: "stand-in",
	});

	test("uploads through Bun's S3 client with the lock's content type, then finds it there", async () => {
		const fetcher = serving(PACKAGE);
		const first = await publishSources(lockFor(), store, { fetcher });
		expect(first.map((result) => result.action)).toEqual(["uploaded"]);
		const object = objects.get(blobKey(SHA256));
		expect(object?.body).toEqual(PACKAGE);
		expect(object?.type).toBe("application/x-rpm");

		const puts = requests.filter((line) => line.startsWith("PUT")).length;
		const second = await publishSources(lockFor(), store, { fetcher });
		expect(second.map((result) => result.action)).toEqual(["present"]);
		expect(requests.filter((line) => line.startsWith("PUT")).length).toBe(puts);
		expect(fetcher.calls).toBe(1);
	});
});

describe(SOURCES_LOCK, () => {
	test("is well formed, and names glibc's source package", () => {
		const lock = readSourcesLock(readFileSync(join(ROOT, SOURCES_LOCK), "utf8"));
		expect(lock.sources.map((entry) => entry.name)).toContain("glibc");
		for (const entry of lock.sources) expect(entry.url.endsWith(`/${entry.file}`)).toBe(true);
	});

	test("refuses an entry without a 64-digit hash", () => {
		expect(() => lockFor(PACKAGE.length, "abc")).toThrow(/64 hex digits/);
	});
});
