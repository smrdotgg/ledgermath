import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { parseExportedCredentials, profileCredentials } from "../scripts/lib/aws-credentials";
import { type BucketObject, type ObjectHead, S3Bucket, type WritableBucket } from "../scripts/lib/bucket";
import { CopyStopped, checkRunsScript, copyBucket, verifyCopy } from "../scripts/lib/bucket-copy";
import { type StandinBucket, S3Standin } from "./s3-standin";

/** Each test talks to a local server, and some run scripts as processes: seconds on a loaded machine. */
const TIMEOUT_MS = 60_000;

const ROOT = join(import.meta.dir, "..");
const SAMPLE = join(import.meta.dir, "samples", "scheduled");
const scratch = mkdtempSync(join(tmpdir(), "copy-bucket-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;
const fresh = (name: string): string => join(scratch, `${made++}-${name}`);

const SOURCE_KEY = "AKIASOURCEEXAMPLE000";
const DESTINATION_KEY = "AKIADESTEXAMPLE00000";
const FAST = { retryDelaysMs: [1, 1] };

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function filesUnder(root: string): string[] {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();
}

let standin: S3Standin;
let source: S3Bucket;
let destination: S3Bucket;

/**
 * The source: the scheduled sample's Run files, boot summaries and blobs, a
 * box's log, a source archive and an object under another prefix, each with
 * the Content-Type a -runs bucket gives it; and a big blob of 3 MiB.
 */
const BIG = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 7) % 251);
const BIG_KEY = `blobs/sha256/${sha256(BIG)}`;
function fillSource(): void {
	for (const key of filesUnder(SAMPLE)) {
		if (!/^(runs|boots|blobs)\//.test(key)) continue;
		standin.put("source", key, new Uint8Array(readFileSync(join(SAMPLE, key))), key.endsWith(".json") ? "application/json" : "binary/octet-stream");
	}
	standin.put("source", BIG_KEY, BIG, "application/gzip");
	standin.put("source", "logs/2026/11/10/a-boot.log", "the box's log\n", "text/plain");
	standin.put("source", "logs/by-hand/2026-11-11/i-0123456789abcdef0/user-data.log", "by hand\n", "text/plain");
	standin.put("source", "source/0123456789abcdef0123456789abcdef01234567.tar.gz", "an archive", "application/gzip");
	standin.put("source", "other/thing", "not copied");
}

const sourceObjects = (): Map<string, { bytes: Uint8Array; contentType: string }> =>
	new Map([...(standin.buckets.get("source")?.objects ?? [])].filter(([key]) => /^(blobs|runs|boots|logs)\//.test(key)));
const destinationObjects = () => standin.buckets.get("destination")?.objects ?? new Map();
const puts = () => standin.requests.filter((request) => request.method === "PUT");

beforeEach(() => {
	standin = new S3Standin();
	standin.start();
	standin.bucket("source", { readers: [SOURCE_KEY] });
	standin.bucket("destination", { writers: [DESTINATION_KEY] });
	standin.secrets.set(SOURCE_KEY, "source-secret");
	standin.secrets.set(DESTINATION_KEY, "destination-secret");
	source = new S3Bucket("source", "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: SOURCE_KEY, secretAccessKey: "source-secret", sessionToken: "source-token" }) });
	destination = new S3Bucket("destination", "us-east-2", {
		endpoint: standin.url,
		credentials: () => ({ accessKeyId: DESTINATION_KEY, secretAccessKey: "destination-secret", sessionToken: "destination-token" }),
	});
	fillSource();
});
afterEach(() => standin.stop());

describe("the copy", () => {
	test("copies every object under blobs/, runs/, boots/ and logs/, byte for byte, with its Content-Type, and nothing else", async () => {
		const report = await copyBucket(source, destination, FAST);
		const expected = sourceObjects();
		expect(expected.size).toBe(filesUnder(SAMPLE).filter((key) => /^(runs|boots|blobs)\//.test(key)).length + 3);
		expect([...destinationObjects().keys()].sort()).toEqual([...expected.keys()].sort());
		for (const [key, object] of expected) {
			const copied = destinationObjects().get(key);
			expect(Buffer.from(copied?.bytes ?? []).equals(object.bytes)).toBe(true);
			expect(copied?.contentType).toBe(object.contentType);
			expect(copied?.writes).toBe(1);
		}
		expect(destinationObjects().get("runs/2026/11/10/01a1c7a6-0108-7db1-8ec4-3d1f9390b22b.json")?.contentType).toBe("application/json");
		expect(destinationObjects().get("logs/2026/11/10/a-boot.log")?.contentType).toBe("text/plain");
		expect(destinationObjects().get(BIG_KEY)?.contentType).toBe("application/gzip");

		const bytes = [...expected.values()].reduce((sum, object) => sum + object.bytes.length, 0);
		expect(report.copied).toEqual({ count: expected.size, bytes });
		expect(report.same).toEqual({ count: 0, bytes: 0 });
		expect(report.listed["logs/"].count).toBe(2);
		expect(report.listed["blobs/"].count + report.listed["runs/"].count + report.listed["boots/"].count + report.listed["logs/"].count).toBe(expected.size);
	}, TIMEOUT_MS);

	test("reads with the source's keys only and writes with the destination's only; the source is never written", async () => {
		await copyBucket(source, destination, FAST);
		for (const request of standin.requests) {
			expect(request.keyId).toBe(request.bucket === "source" ? SOURCE_KEY : DESTINATION_KEY);
		}
		expect(puts().every((request) => request.bucket === "destination")).toBe(true);
		expect(standin.requests.some((request) => request.bucket === "source" && request.method !== "GET" && request.method !== "HEAD")).toBe(false);
	}, TIMEOUT_MS);

	test("sends every PUT with If-None-Match: *, signed, so S3 creates and never replaces", async () => {
		await copyBucket(source, destination, FAST);
		expect(puts().length).toBe(sourceObjects().size);
		// The stand-in checked each one's signature and payload hash, or it would not have stored it.
		for (const request of puts()) expect(request.ifNoneMatch).toBe("*");

		// It does check: signed with another secret, the first PUT is refused.
		destinationObjects().clear();
		standin.secrets.set(DESTINATION_KEY, "not-the-destination-secret");
		const refused = (await copyBucket(source, destination, { ...FAST, concurrency: 1 }).catch((error: unknown) => error)) as CopyStopped;
		expect(refused.problems[0]).toContain("answered 403, SignatureDoesNotMatch");
		expect(destinationObjects().size).toBe(0);
	}, TIMEOUT_MS);

	test("writes every blob before any Run file, every Run file before any boot summary, and those before any log", async () => {
		await copyBucket(source, destination, FAST);
		const order = puts().map((request) => request.key.split("/")[0]);
		const last = (part: string): number => order.lastIndexOf(part);
		const first = (part: string): number => order.indexOf(part);
		expect(last("blobs")).toBeLessThan(first("runs"));
		expect(last("runs")).toBeLessThan(first("boots"));
		expect(last("boots")).toBeLessThan(first("logs"));
	}, TIMEOUT_MS);

	test("run a second time, copies nothing and finds everything the same", async () => {
		const first = await copyBucket(source, destination, FAST);
		const written = puts().length;
		const second = await copyBucket(source, destination, FAST);
		expect(puts().length).toBe(written);
		expect(second.copied).toEqual({ count: 0, bytes: 0 });
		expect(second.same).toEqual(first.copied);
	}, TIMEOUT_MS);

	test("a dry run writes nothing and says what it would copy; then the copy copies exactly that", async () => {
		standin.put("destination", "runs/2026/11/10/01a1c7a6-0108-7db1-8ec4-3d1f9390b22b.json", sourceObjects().get("runs/2026/11/10/01a1c7a6-0108-7db1-8ec4-3d1f9390b22b.json")?.bytes ?? text(""), "application/json");
		const dry = await copyBucket(source, destination, { ...FAST, dryRun: true });
		expect(puts()).toEqual([]);
		expect(dry.dryRun).toBe(true);
		expect(dry.same.count).toBe(1);
		const real = await copyBucket(source, destination, FAST);
		expect(real.copied).toEqual(dry.copied);
		expect(real.same).toEqual(dry.same);
	}, TIMEOUT_MS);

	test("stops before writing anything when an object at the destination differs from the source's", async () => {
		const key = "boots/2026/11/10/" + filesUnder(join(SAMPLE, "boots", "2026", "11", "10"))[0];
		const ours = sourceObjects().get(key)?.bytes as Uint8Array;
		const theirs = new Uint8Array(ours);
		theirs[10] = (theirs[10] as number) ^ 1; // the same size, other bytes
		standin.put("destination", key, theirs, "application/json");
		const [blob, sameSize] = [...sourceObjects().keys()].filter((name) => name.startsWith("blobs/") && name !== BIG_KEY) as [string, string];
		standin.put("destination", blob, text("a different size"));
		// A blob of the right size with other bytes: read at the destination, its bytes do not hash to its key.
		const wrong = new Uint8Array(sourceObjects().get(sameSize)?.bytes as Uint8Array);
		wrong[0] = (wrong[0] as number) ^ 1;
		standin.put("destination", sameSize, wrong);

		const stopped = await copyBucket(source, destination, FAST).catch((error: unknown) => error);
		expect(stopped).toBeInstanceOf(CopyStopped);
		const problems = (stopped as CopyStopped).problems;
		expect(problems).toContainEqual(`${key}: the destination's bytes differ from the source's`);
		expect(problems.some((problem) => problem.startsWith(`${blob}: 16 bytes at the destination`))).toBe(true);
		expect(problems).toContainEqual(`${sameSize}: the destination's bytes do not hash to its key`);
		expect((stopped as CopyStopped).message).toContain("the copy stopped and wrote nothing");
		expect((stopped as CopyStopped).report.putsSent).toBe(0);
		expect(puts()).toEqual([]);
		expect(destinationObjects().get(key)?.bytes).toEqual(theirs);
	}, TIMEOUT_MS);

	test("reads every object the destination already holds: a blob's bytes there are hashed, any other object's compared with the source's", async () => {
		await copyBucket(source, destination, FAST);
		const before = standin.requests.length;
		const second = await copyBucket(source, destination, FAST);
		const gets = standin.requests.slice(before).filter((request) => request.method === "GET" && request.key !== "");
		const blobs = [...sourceObjects().keys()].filter((key) => key.startsWith("blobs/"));
		const others = [...sourceObjects().keys()].filter((key) => !key.startsWith("blobs/"));
		for (const key of blobs) {
			expect(gets.filter((request) => request.key === key).map((request) => request.bucket)).toEqual(["destination"]);
		}
		for (const key of others) {
			expect(gets.filter((request) => request.key === key).map((request) => request.bucket).sort()).toEqual(["destination", "source"]);
		}
		expect(second.same.count).toBe(sourceObjects().size);
	}, TIMEOUT_MS);

	test("stops when a blob's bytes do not hash to its key, writing nothing after; the Run files wait for their blobs", async () => {
		const bad = `blobs/sha256/${"0".repeat(64)}`;
		standin.put("source", bad, "these bytes are not that hash");
		const stopped = (await copyBucket(source, destination, { ...FAST, concurrency: 1 }).catch((error: unknown) => error)) as CopyStopped;
		expect(stopped).toBeInstanceOf(CopyStopped);
		expect(stopped.problems).toEqual([`${bad}: its bytes hash to ${sha256("these bytes are not that hash")}, not to its key`]);
		// The bad blob sorts first: nothing was written at all, and no Run file.
		expect(puts()).toEqual([]);
		expect(stopped.report.copied.count).toBe(0);
		expect(stopped.message).toStartWith("the copy stopped and wrote nothing: 1 problem");
	}, TIMEOUT_MS);

	test("refuses, before anything, a key under blobs/ that is not named by a hash", async () => {
		standin.put("source", "blobs/README", "a note");
		const stopped = (await copyBucket(source, destination, FAST).catch((error: unknown) => error)) as CopyStopped;
		expect(stopped.problems).toEqual(["blobs/README: under blobs/ but not named blobs/sha256/<hex>, so it cannot be checked by its hash"]);
		expect(standin.requests.filter((request) => request.bucket === "destination" && request.key !== "")).toEqual([]);
	}, TIMEOUT_MS);

	test("stopped partway, it carries on when run again, and no object is ever written twice", async () => {
		let allowed = 10;
		standin.fault = (request) => {
			if (request.method !== "PUT") return undefined;
			if (allowed > 0) {
				allowed -= 1;
				return undefined;
			}
			return new Response("<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>", { status: 500 });
		};
		const stopped = (await copyBucket(source, destination, { ...FAST, concurrency: 4 }).catch((error: unknown) => error)) as CopyStopped;
		expect(stopped).toBeInstanceOf(CopyStopped);
		expect(stopped.problems[0]).toContain("(If-None-Match: *) answered 500, InternalError: We encountered an internal error.");
		expect(stopped.problems[0]).toContain("(tried 3 times)");
		expect(stopped.report.copied.count).toBe(10);
		expect(destinationObjects().size).toBe(10);
		// A 500 does not say whether S3 wrote the object: each key that got one is named as not known.
		expect(stopped.report.unknown.length).toBe(stopped.problems.length);
		for (const key of stopped.report.unknown) expect(destinationObjects().has(key)).toBe(false);
		expect(stopped.message).toContain(`the copy stopped and had written 10 objects (${stopped.report.copied.bytes} bytes), replacing none; whether`);
		expect(stopped.message).toContain(`written is not known: ${stopped.report.unknown.join(", ")}`);

		standin.fault = undefined;
		const resumed = await copyBucket(source, destination, FAST);
		expect(resumed.same.count).toBe(10);
		expect(resumed.copied.count + resumed.same.count).toBe(sourceObjects().size);
		for (const [key, object] of sourceObjects()) {
			expect(Buffer.from(destinationObjects().get(key)?.bytes ?? []).equals(object.bytes)).toBe(true);
			expect(destinationObjects().get(key)?.writes).toBe(1);
		}
	}, TIMEOUT_MS);

	test("a PUT that failed once is tried again; one whose answer was lost is refused when sent again (412) and found the same", async () => {
		const failedOnce = "logs/2026/11/10/a-boot.log";
		const lost = BIG_KEY;
		const seen = new Set<string>();
		standin.fault = (request) => {
			if (request.method !== "PUT" || seen.has(request.key)) return undefined;
			if (request.key === failedOnce) {
				seen.add(request.key);
				return new Response("<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>", { status: 503 });
			}
			if (request.key === lost) {
				// S3 stored it, and the answer never arrived.
				seen.add(request.key);
				standin.put("destination", lost, BIG, "application/gzip");
				return new Response("", { status: 500 });
			}
			return undefined;
		};
		const report = await copyBucket(source, destination, FAST);
		expect(destinationObjects().get(failedOnce)?.writes).toBe(1);
		expect(destinationObjects().get(lost)?.writes).toBe(1);
		expect(puts().filter((request) => request.key === lost).length).toBe(2);
		expect(report.copied.count + report.same.count).toBe(sourceObjects().size);
		expect(report.same.count).toBe(1);
		expect(report.unknown).toEqual([]);
	}, TIMEOUT_MS);

	test("an object that appears at the destination between the check and its PUT is never replaced: the same bytes count as there, other bytes stop the copy", async () => {
		const key = "runs/2026/11/10/01a1c7a6-0108-7db1-8ec4-3d1f9390b22b.json";
		const other = "logs/2026/11/10/a-boot.log";
		const placed = new Set<string>();
		standin.fault = (request) => {
			// Someone else writes the key just as the copy's PUT arrives; the stand-in then answers the PUT as S3 would.
			if (request.bucket === "destination" && request.method === "PUT" && (request.key === key || request.key === other) && !placed.has(request.key)) {
				placed.add(request.key);
				if (request.key === key) standin.put("destination", key, sourceObjects().get(key)?.bytes ?? text(""), "application/json");
				else standin.put("destination", other, "someone else's log\n", "text/plain");
			}
			return undefined;
		};
		const stopped = (await copyBucket(source, destination, { ...FAST, concurrency: 1 }).catch((error: unknown) => error)) as CopyStopped;
		expect(stopped).toBeInstanceOf(CopyStopped);
		expect(stopped.problems).toEqual([`${other}: appeared at the destination while it was being copied, with other bytes than the source's; it was not replaced`]);
		expect(puts().filter((request) => request.key === key || request.key === other).map((request) => request.key)).toEqual([key, other]);
		// Each was written once, by the other writer, and kept.
		expect(destinationObjects().get(key)?.writes).toBe(1);
		expect(destinationObjects().get(other)?.writes).toBe(1);
		expect(new TextDecoder().decode(destinationObjects().get(other)?.bytes)).toBe("someone else's log\n");
		expect(stopped.report.same.count).toBe(1);
		expect(stopped.report.unknown).toEqual([]);
		expect(stopped.message).toStartWith(`the copy stopped and had written ${stopped.report.copied.count} objects`);
	}, TIMEOUT_MS);

	test("an object S3 acknowledged is counted as written even when the look afterwards fails, and the report says so", async () => {
		const key = "logs/2026/11/10/a-boot.log";
		standin.fault = (request) =>
			request.bucket === "destination" && request.method === "HEAD" && request.key === key
				? new Response(null, { status: 503 })
				: undefined;
		const stopped = (await copyBucket(source, destination, { ...FAST, concurrency: 1 }).catch((error: unknown) => error)) as CopyStopped;
		expect(stopped).toBeInstanceOf(CopyStopped);
		expect(stopped.problems).toHaveLength(1);
		expect(stopped.problems[0]).toStartWith(`looking at s3://destination/${key} after writing it:`);
		expect(destinationObjects().has(key)).toBe(true);
		expect(stopped.report.copied.count).toBe(destinationObjects().size);
		expect(stopped.report.unknown).toEqual([]);
		expect(stopped.message).not.toContain("wrote nothing");
		expect(stopped.message).toContain(`had written ${destinationObjects().size} objects`);
	}, TIMEOUT_MS);

	test("a key whose PUT never got an answer that says what became of it is named as not known", async () => {
		const key = "logs/2026/11/10/a-boot.log";
		let first = true;
		standin.fault = (request) => {
			if (request.bucket !== "destination" || request.method !== "PUT" || request.key !== key) return undefined;
			// The first PUT is stored and its answer lost; every later one fails too.
			if (first) standin.put("destination", key, "the box's log\n", "text/plain");
			first = false;
			return new Response("<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>", { status: 500 });
		};
		const stopped = (await copyBucket(source, destination, { ...FAST, concurrency: 1 }).catch((error: unknown) => error)) as CopyStopped;
		expect(stopped).toBeInstanceOf(CopyStopped);
		expect(stopped.report.unknown).toEqual([key]);
		expect(stopped.message).toContain(`; whether 1 more was written is not known: ${key}`);
		expect(destinationObjects().has(key)).toBe(true);
		// Run again, it finds the object and compares it.
		standin.fault = undefined;
		const resumed = await copyBucket(source, destination, FAST);
		expect(resumed.copied.count + resumed.same.count).toBe(sourceObjects().size);
		expect(destinationObjects().get(key)?.writes).toBe(1);
	}, TIMEOUT_MS);

	test("a PUT S3 refuses outright (403) writes nothing and leaves nothing unknown, but is not \"wrote nothing\"", async () => {
		standin.fault = (request) =>
			request.method === "PUT" ? new Response("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>", { status: 403 }) : undefined;
		const stopped = (await copyBucket(source, destination, { ...FAST, concurrency: 1 }).catch((error: unknown) => error)) as CopyStopped;
		expect(stopped.problems[0]).toContain("answered 403, AccessDenied: Access Denied");
		expect(stopped.report.unknown).toEqual([]);
		expect(stopped.report.putsSent).toBe(3);
		expect(stopped.message).toStartWith("the copy stopped and had written 0 objects (0 bytes), replacing none: 1 problem");
	}, TIMEOUT_MS);

	test("with ETags that are not MD5s (SSE-KMS), an object is read twice instead of refused, and a written one is read back", async () => {
		(standin.buckets.get("source") as StandinBucket).opaqueEtags = true;
		(standin.buckets.get("destination") as StandinBucket).opaqueEtags = true;
		const report = await copyBucket(source, destination, FAST);
		expect(report.copied.count).toBe(sourceObjects().size);
		const key = "logs/2026/11/10/a-boot.log";
		const gets = standin.requests.filter((request) => request.method === "GET" && request.key === key);
		expect(gets.map((request) => request.bucket)).toEqual(["source", "source", "destination"]);
		// A blob is checked by its hash, whatever its ETag: read once at the source.
		expect(standin.requests.filter((request) => request.method === "GET" && request.key === BIG_KEY && request.bucket === "source").length).toBe(1);

		// An object that changes between the two reads stops the copy.
		standin.buckets.get("destination")?.objects.clear();
		let reads = 0;
		standin.fault = (request) => {
			if (request.bucket === "source" && request.method === "GET" && request.key === key && ++reads === 2) return new Response("the box's LOG\n", { headers: { etag: `"${"e".repeat(32)}"` } });
			return undefined;
		};
		const stopped = (await copyBucket(source, destination, FAST).catch((error: unknown) => error)) as CopyStopped;
		expect(stopped.problems).toEqual([`${key}: two reads of the source gave different bytes (and its ETag is not the MD5 of either)`]);
		expect(destinationObjects().has(key)).toBe(false);
	}, TIMEOUT_MS);

	test("refuses, before anything, a key with a . or .. segment, which a request cannot name", async () => {
		standin.put("source", "logs/a/../parent.log", "a log");
		standin.put("source", "logs/a/./self.log", "a log");
		const stopped = (await copyBucket(source, destination, FAST).catch((error: unknown) => error)) as CopyStopped;
		expect(stopped.problems).toEqual([
			'logs/a/../parent.log: has a "." or ".." segment, which a request\'s URL resolves away, so it cannot be read or written by its name; copy it by hand',
			'logs/a/./self.log: has a "." or ".." segment, which a request\'s URL resolves away, so it cannot be read or written by its name; copy it by hand',
		]);
		expect(standin.requests.filter((request) => request.bucket === "destination" && request.key !== "")).toEqual([]);
	}, TIMEOUT_MS);

	test("holds at most its memory budget of bytes at once, or one larger object alone, and at most its concurrency of objects", async () => {
		for (let i = 0; i < 24; i++) {
			const bytes = new Uint8Array(512 * 1024).fill(i);
			standin.put("source", `blobs/sha256/${sha256(bytes)}`, bytes);
		}
		let inFlight = 0;
		let mostInFlight = 0;
		const counting: WritableBucket = {
			name: source.name,
			list: (prefix: string): Promise<BucketObject[]> => source.list(prefix),
			head: (key: string): Promise<ObjectHead | null> => source.head(key),
			create: (key: string, bytes: Uint8Array, contentType: string) => source.create(key, bytes, contentType),
			get: async (key: string): Promise<Uint8Array | null> => {
				mostInFlight = Math.max(mostInFlight, ++inFlight);
				try {
					return await source.get(key);
				} finally {
					inFlight -= 1;
				}
			},
		};
		const budget = 2 * 1024 * 1024;
		const report = await copyBucket(counting, destination, { ...FAST, concurrency: 6, memoryBytes: budget });
		expect(report.copied.count).toBe(sourceObjects().size);
		// Each object in flight is counted twice: its bytes, and a second copy to compare them with.
		expect(report.peakBytesHeld).toBeLessThanOrEqual(Math.max(budget, 2 * BIG.length));
		expect(report.peakBytesHeld).toBeGreaterThanOrEqual(2 * BIG.length); // the big blob, alone
		expect(mostInFlight).toBeLessThanOrEqual(6);
		expect(mostInFlight).toBeGreaterThan(1);
	}, TIMEOUT_MS);
});

describe("the verification", () => {
	/** A Runs repository holding the sample's Run files and boot summaries. */
	function runsRepository(): string {
		const directory = fresh("ledgermath-runs");
		for (const part of ["runs", "boots"]) cpSync(join(SAMPLE, part), join(directory, part), { recursive: true });
		return directory;
	}
	/** check-runs as the CLI runs it, told which blobs the sample leaves out. */
	const checkRunsOmitting = (directory: string) => {
		const done = Bun.spawnSync([process.execPath, join(ROOT, "scripts", "check-runs.ts"), "--omitted", join(SAMPLE, "omitted-blobs.json"), directory]);
		return { status: done.exitCode, output: `${done.stdout.toString()}${done.stderr.toString()}` };
	};

	test("passes after a copy: every source object has the same bytes, every file of the Runs repository is there, check-runs passes", async () => {
		await copyBucket(source, destination, FAST);
		standin.put("destination", `blobs/sha256/${sha256("the destination's own")}`, "the destination's own");
		const checkDirectory = fresh("check");
		const report = await verifyCopy(source, destination, { ...FAST, runsRepository: runsRepository(), checkDirectory, checkRuns: checkRunsOmitting });
		expect(report.problems).toEqual([]);
		expect(report.same.count).toBe(sourceObjects().size);
		expect(report.onlyAtDestination).toBe(1);
		expect(report.repositoryFiles).toBe(filesUnder(join(SAMPLE, "runs")).length + filesUnder(join(SAMPLE, "boots")).length);
		expect(report.checkRuns?.passed).toBe(true);
		// The directory check-runs read: the destination's blobs, Run files and boot summaries, no logs.
		expect(filesUnder(checkDirectory)).toEqual(
			[...destinationObjects().keys()].filter((key) => !key.startsWith("logs/")).sort(),
		);
		expect(puts().length).toBe(sourceObjects().size); // the copy's, and nothing from the verification
	}, TIMEOUT_MS);

	test("finds a missing object, other bytes, a file of the Runs repository not copied, and a failing check-runs", async () => {
		await copyBucket(source, destination, FAST);
		const runKey = "runs/2026/11/10/01a1c7a6-0108-7db1-8ec4-3d1f9390b22b.json";
		const changed = new Uint8Array(destinationObjects().get(runKey)?.bytes);
		changed[5] = (changed[5] as number) ^ 1;
		standin.put("destination", runKey, changed, "application/json");
		destinationObjects().delete("logs/2026/11/10/a-boot.log");
		const repository = runsRepository();
		mkdirSync(join(repository, "runs", "2026", "11", "13"), { recursive: true });
		writeFileSync(join(repository, "runs", "2026", "11", "13", "01a1ccad-0000-7000-8000-000000000000.json"), "{}\n");

		const report = await verifyCopy(source, destination, { ...FAST, runsRepository: repository, checkDirectory: fresh("check"), checkRuns: checkRunsScript });
		expect(report.problems).toEqual([
			"logs/2026/11/10/a-boot.log: in the source, not at the destination",
			`${runKey}: the Runs repository's file differs from the destination's`,
			`${runKey}: the destination's bytes differ from the source's`,
			"runs/2026/11/13/01a1ccad-0000-7000-8000-000000000000.json: in the Runs repository, not at the destination",
			expect.stringMatching(/^scripts\/check-runs\.ts .* failed \(exit 1\)$/),
		]);
		// The sample leaves three blobs out, which check-runs, untold, reports.
		expect(report.checkRuns?.output).toContain("sha256:a3674893a396548874757acdd23df1028ce8789a4a82e35e41b209205b88f5f2");
	}, TIMEOUT_MS);

	test("without --check-dir, says the check of the Runs was not made", async () => {
		await copyBucket(source, destination, FAST);
		const report = await verifyCopy(source, destination, { ...FAST, runsRepository: runsRepository(), checkDirectory: null });
		expect(report.problems).toEqual([]);
		expect(report.checkRuns).toBeNull();
	}, TIMEOUT_MS);

	test("refuses, before reading anything, a Runs repository without runs/ and boots/: a mistyped path is not an empty repository", async () => {
		await copyBucket(source, destination, FAST);
		const before = standin.requests.length;
		const typo = fresh("ledgermath-runs-typo");
		await expect(verifyCopy(source, destination, { ...FAST, runsRepository: typo, checkDirectory: null })).rejects.toThrow(
			`${typo}: has no runs/ directory, so it is not a checkout of the Runs repository (--runs-repository)`,
		);
		const half = fresh("ledgermath-runs-half");
		mkdirSync(join(half, "runs"), { recursive: true });
		await expect(verifyCopy(source, destination, { ...FAST, runsRepository: half, checkDirectory: null })).rejects.toThrow("has no boots/ directory");
		expect(standin.requests.length).toBe(before);
	}, TIMEOUT_MS);

	test("reports a key with a . or .. segment, at either end, as a problem", async () => {
		await copyBucket(source, destination, FAST);
		standin.put("source", "logs/a/../parent.log", "a log");
		standin.put("destination", "runs/./x.json", "{}");
		const report = await verifyCopy(source, destination, { ...FAST, runsRepository: runsRepository(), checkDirectory: null });
		expect(report.problems).toEqual([
			'logs/a/../parent.log: has a "." or ".." segment, which a request\'s URL resolves away, so it cannot be read or written by its name; copy it by hand (in the source)',
			'runs/./x.json: has a "." or ".." segment, which a request\'s URL resolves away, so it cannot be read or written by its name; copy it by hand (at the destination)',
		]);
	}, TIMEOUT_MS);

	test("refuses a check directory that already holds something", async () => {
		const checkDirectory = fresh("check");
		mkdirSync(checkDirectory);
		writeFileSync(join(checkDirectory, "left"), "x");
		await expect(verifyCopy(source, destination, { ...FAST, runsRepository: runsRepository(), checkDirectory })).rejects.toThrow("must be an empty directory");
	}, TIMEOUT_MS);
});

describe("going back: production into development, after a failed cutover", () => {
	const PRODUCTION_KEY = "AKIAPRODUCTIONEXAMP0";
	const DEVELOPMENT_KEY = "AKIADEVELOPMENTEXAM0";
	const RUN = "runs/2026/11/10/01a1c7a6-0108-7db1-8ec4-3d1f9390b22b.json";
	const BY_HAND = "logs/by-hand/2026-11-15/i-0fedcba9876543210/user-data.log";

	test("adds to development what only production holds, touches nothing development has, and verifies", async () => {
		// Production holds every object development had at the cutover, and what its own boxes made since:
		// here a Run file, a boot summary and three blobs that development lacks. Development holds one
		// object of its own, a log of a box launched by hand there after the cutover.
		const production = standin.bucket("production", { readers: [PRODUCTION_KEY] });
		const development = standin.bucket("development", { writers: [DEVELOPMENT_KEY] });
		standin.secrets.set(DEVELOPMENT_KEY, "development-secret");
		for (const [key, object] of sourceObjects()) production.objects.set(key, { ...object, writes: 1 });
		const boot = [...sourceObjects().keys()].find((key) => key.startsWith("boots/")) as string;
		const blobs = [...sourceObjects().keys()].filter((key) => key.startsWith("blobs/") && key !== BIG_KEY).slice(0, 3);
		const productionOnly = [RUN, boot, ...blobs];
		for (const [key, object] of sourceObjects()) if (!productionOnly.includes(key)) development.objects.set(key, { ...object, writes: 1 });
		standin.put("development", BY_HAND, "by hand, after the cutover\n", "text/plain");
		const from = new S3Bucket("production", "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: PRODUCTION_KEY, secretAccessKey: "production-secret" }) });
		const to = new S3Bucket("development", "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: DEVELOPMENT_KEY, secretAccessKey: "development-secret" }) });

		// The Runs repository has published production's Run already: before the copy back, development fails the verification.
		const repository = fresh("ledgermath-runs");
		for (const part of ["runs", "boots"]) cpSync(join(SAMPLE, part), join(repository, part), { recursive: true });
		const before = await verifyCopy(from, to, { ...FAST, runsRepository: repository, checkDirectory: null });
		expect(before.problems).toContain(`${RUN}: in the Runs repository, not at the destination`);
		expect(before.problems).toContain(`${RUN}: in the source, not at the destination`);

		const report = await copyBucket(from, to, FAST);
		expect(report.copied.count).toBe(productionOnly.length);
		expect(puts().map((request) => request.key).sort()).toEqual([...productionOnly].sort());
		expect(puts().every((request) => request.bucket === "development" && request.keyId === DEVELOPMENT_KEY)).toBe(true);
		for (const [key, object] of development.objects) {
			expect(object.writes).toBe(1);
			if (key !== BY_HAND) expect(Buffer.from(object.bytes).equals(production.objects.get(key)?.bytes as Uint8Array)).toBe(true);
		}
		expect(new TextDecoder().decode(development.objects.get(BY_HAND)?.bytes)).toBe("by hand, after the cutover\n");

		const checkRunsOmitting = (directory: string) => {
			const done = Bun.spawnSync([process.execPath, join(ROOT, "scripts", "check-runs.ts"), "--omitted", join(SAMPLE, "omitted-blobs.json"), directory]);
			return { status: done.exitCode, output: `${done.stdout.toString()}${done.stderr.toString()}` };
		};
		const after = await verifyCopy(from, to, { ...FAST, runsRepository: repository, checkDirectory: fresh("check"), checkRuns: checkRunsOmitting });
		expect(after.problems).toEqual([]);
		expect(after.onlyAtDestination).toBe(1);
		expect(after.checkRuns?.passed).toBe(true);
		expect(standin.requests.some((request) => request.bucket === "production" && request.method !== "GET" && request.method !== "HEAD")).toBe(false);
	}, TIMEOUT_MS);
});

describe("the keys of each account", () => {
	const exported = {
		Version: 1,
		AccessKeyId: "AKIAEXPORTEDEXAMPLE0",
		SecretAccessKey: "an-exported-secret",
		SessionToken: "an-exported-token",
		Expiration: "2026-11-14T16:00:00+00:00",
	};

	test("are read from what `aws configure export-credentials --format process` prints", () => {
		expect(parseExportedCredentials(JSON.stringify(exported), "tabot-dev")).toEqual({
			accessKeyId: "AKIAEXPORTEDEXAMPLE0",
			secretAccessKey: "an-exported-secret",
			sessionToken: "an-exported-token",
			expiration: new Date("2026-11-14T16:00:00Z"),
		});
	});

	test("anything else is refused without being shown", () => {
		for (const printed of ["not json, an-exported-secret", JSON.stringify({ ...exported, SecretAccessKey: undefined }), JSON.stringify({ ...exported, Expiration: "soon" })]) {
			let message = "";
			try {
				parseExportedCredentials(printed, "tabot-dev");
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message).toContain("aws configure export-credentials --profile tabot-dev printed");
			expect(message).toContain("not shown");
			for (const secret of ["an-exported-secret", "an-exported-token", "AKIAEXPORTEDEXAMPLE0"]) expect(message).not.toContain(secret);
		}
	});

	test("are exported once, kept while they are good, exported again before they expire, and a failure shows the CLI's own words", () => {
		let now = Date.parse("2026-11-14T15:00:00Z");
		let exports = 0;
		const provider = profileCredentials("tabot-production", {
			now: () => now,
			exportCommand: (profile) => {
				exports += 1;
				expect(profile).toBe("tabot-production");
				return { status: 0, stdout: JSON.stringify({ ...exported, Expiration: new Date(now + 60 * 60 * 1000).toISOString() }), stderr: "" };
			},
		});
		const first = provider();
		expect(provider()).toBe(first);
		now += 49 * 60 * 1000; // 11 minutes left
		expect(provider()).toBe(first);
		now += 2 * 60 * 1000; // 9 minutes left: exported again
		const second = provider();
		expect(second).not.toBe(first);
		expect(exports).toBe(2);

		const failing = profileCredentials("tabot-production", {
			exportCommand: () => ({ status: 255, stdout: "an-exported-secret", stderr: "Error loading SSO Token: Token for tabot-production does not exist\n" }),
		});
		expect(() => failing()).toThrow("exited 255: Error loading SSO Token: Token for tabot-production does not exist (if the login has expired: aws sso login --profile tabot-production)");
		try {
			failing();
		} catch (error) {
			expect((error as Error).message).not.toContain("an-exported-secret");
		}
	});
});

describe("scripts/copy-bucket.ts", () => {
	/** A stand-in aws CLI on PATH that exports keys for the two profiles, and fails for any other. */
	function fakeAws(): string {
		const directory = fresh("bin");
		mkdirSync(directory);
		const keys = (id: string, secret: string, token: string) => JSON.stringify({ Version: 1, AccessKeyId: id, SecretAccessKey: secret, SessionToken: token, Expiration: "2099-01-01T00:00:00Z" });
		writeFileSync(
			join(directory, "aws"),
			[
				"#!/bin/sh",
				'case "$*" in',
				`  "configure export-credentials --profile from-profile --format process") echo '${keys(SOURCE_KEY, "source-secret", "source-token")}' ;;`,
				`  "configure export-credentials --profile to-profile --format process") echo '${keys(DESTINATION_KEY, "destination-secret", "destination-token")}' ;;`,
				'  *) echo "The config profile could not be found" >&2; exit 255 ;;',
				"esac",
				"",
			].join("\n"),
		);
		chmodSync(join(directory, "aws"), 0o755);
		return directory;
	}

	async function run(args: string[], bin: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
		const child = Bun.spawn([process.execPath, join(ROOT, "scripts", "copy-bucket.ts"), ...args], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			stdout: "pipe",
			stderr: "pipe",
		});
		const deadline = setTimeout(() => child.kill(), 45_000);
		try {
			const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			return { status, stdout, stderr };
		} finally {
			clearTimeout(deadline);
		}
	}

	const SECRETS = [SOURCE_KEY, DESTINATION_KEY, "source-secret", "destination-secret", "source-token", "destination-token"];
	const buckets = () => ["--from-bucket", "source", "--from-profile", "from-profile", "--to-bucket", "destination", "--to-profile", "to-profile", "--endpoint", standin.url];

	test("copies with each profile's keys, says how much, prints no key, and copies nothing the second time", async () => {
		const bin = fakeAws();
		const dry = await run(["copy", ...buckets(), "--dry-run"], bin);
		expect(dry.status).toBe(0);
		expect(dry.stdout).toContain(`would copy: ${sourceObjects().size} objects`);
		expect(puts()).toEqual([]);

		const first = await run(["copy", ...buckets()], bin);
		expect(first.stderr).toBe("");
		expect(first.status).toBe(0);
		expect(first.stdout).toContain(`copied: ${sourceObjects().size} objects`);
		expect(first.stdout).toMatch(/source logs\/\s+2 objects/);
		const second = await run(["copy", ...buckets()], bin);
		expect(second.status).toBe(0);
		expect(second.stdout).toContain("copied: 0 objects, 0.0 MB (0 bytes)");
		expect(second.stdout).toContain(`already at the destination, read there and the same: ${sourceObjects().size} objects`);

		const verified = await run(["verify", ...buckets(), "--runs-repository", join(SAMPLE), "--no-check-runs"], bin);
		expect(verified.status).toBe(0);
		expect(verified.stdout).toContain("THE VERIFICATION IS INCOMPLETE");
		expect(verified.stdout).toContain("the copy checks out");
		for (const output of [dry, first, second, verified]) for (const secret of SECRETS) expect(`${output.stdout}${output.stderr}`).not.toContain(secret);
	}, TIMEOUT_MS);

	test("stops with the CLI's words when a profile cannot be exported, and refuses bad usage", async () => {
		const bin = fakeAws();
		const failed = await run(["copy", ...buckets().map((arg) => (arg === "to-profile" ? "missing-profile" : arg))], bin);
		expect(failed.status).toBe(1);
		expect(failed.stderr).toContain("aws configure export-credentials --profile missing-profile exited 255: The config profile could not be found");
		expect(puts()).toEqual([]);
		const usage = await run(["copy", "--from-bucket", "source"], bin);
		expect(usage.status).toBe(2);
		expect(usage.stderr).toContain("usage: bun scripts/copy-bucket.ts copy");
		const both = await run(["verify", ...buckets(), "--runs-repository", SAMPLE], bin);
		expect(both.status).toBe(2);
		const typo = await run(["verify", ...buckets(), "--runs-repository", join(scratch, "no-such-checkout"), "--no-check-runs"], bin);
		expect(typo.status).toBe(1);
		expect(typo.stderr).toContain("no-such-checkout: has no runs/ directory, so it is not a checkout of the Runs repository (--runs-repository)");
		expect(existsSync(join(scratch, "nothing"))).toBe(false);
	}, TIMEOUT_MS);
});
