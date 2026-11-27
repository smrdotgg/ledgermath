/**
 * Reading blobs from the bucket survives a failure that may pass: a read is
 * made again, a bounded number of times, after a pause that grows, never more
 * than a bounded number at once; a read that keeps failing, or fails for a
 * reason that would not pass, throws plainly; a blob that is not there is
 * never tried again (scripts/lib/blobs.ts, retryingStore). First with a
 * stand-in store, then with Bun's own S3 client against the stand-in for S3,
 * whose failures are the client's own ("an unexpected error has occurred",
 * the words two runs of the workflow failed with on 2026-11-27), and last
 * through scripts/derive.ts itself.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { keepRecords, memoryRecords, type StreamReducer } from "../methods/records";
import { type BlobStore, blobsFromBucket, mayPass, NO_READABLE_ANSWER, retryingStore } from "../scripts/lib/blobs";
import { S3Bucket } from "../scripts/lib/bucket";
import { S3Standin } from "./s3-standin";

setDefaultTimeout(180_000);

const ROOT = resolve(import.meta.dir, "..");
const SAMPLES = join(ROOT, "tests", "samples", "scheduled");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const BYTES = new TextEncoder().encode("a blob");
const HASH = `sha256:${sha256(BYTES)}`;
const KEY = `blobs/sha256/${HASH.slice("sha256:".length)}`;

/** An error as Bun's S3 client throws it. */
const s3Error = (code: string, message: string): Error => Object.assign(new Error(message), { name: "S3Error", code });
const NO_ANSWER = s3Error("ConnectionClosed", NO_READABLE_ANSWER);

/** A store that answers each read with the next of `answers` (an error is thrown), then with the last for ever. */
function scripted(answers: Array<Uint8Array | null | Error>): BlobStore & { calls: number } {
	const store = {
		name: "s3://scripted",
		calls: 0,
		async get(_key: string): Promise<Uint8Array | null> {
			const answer = answers[Math.min(store.calls, answers.length - 1)] as Uint8Array | null | Error;
			store.calls++;
			if (answer instanceof Error) throw answer;
			return answer;
		},
	};
	return store;
}

/** The waits a store asked for, and its log, with each pause drawn at three quarters of its length. */
function recorded(): { sleeps: number[]; lines: string[]; options: { sleep: (ms: number) => Promise<void>; random: () => number; log: (line: string) => void } } {
	const sleeps: number[] = [];
	const lines: string[] = [];
	return { sleeps, lines, options: { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5, log: (line) => void lines.push(line) } };
}

describe("a read that fails for a reason that may pass", () => {
	test("is made again after a pause that doubles, and gives the blob; each try is logged with the client's code", async () => {
		const store = scripted([NO_ANSWER, s3Error("UnknownError", NO_READABLE_ANSWER), s3Error("SlowDown", "Please reduce your request rate."), BYTES]);
		const { sleeps, lines, options } = recorded();
		const retrying = retryingStore(store, options);
		expect(await retrying.get(KEY)).toEqual(BYTES);
		expect(store.calls).toBe(4);
		// 0.5, 1 and 2 seconds, each drawn between half and all of it (here three quarters).
		expect(sleeps).toEqual([375, 750, 1500]);
		expect(retrying.retried()).toBe(3);
		expect(lines).toEqual([
			`s3://scripted/${KEY}: ConnectionClosed: an unexpected error has occurred; try 2 of 8 in 375 ms`,
			`s3://scripted/${KEY}: UnknownError: an unexpected error has occurred; try 3 of 8 in 750 ms`,
			`s3://scripted/${KEY}: SlowDown: Please reduce your request rate.; try 4 of 8 in 1500 ms`,
		]);
	});

	test("is any read with no readable answer, or S3's answer for its own load or fault; not one about the request itself", () => {
		for (const error of [
			NO_ANSWER,
			s3Error("ConnectionRefused", NO_READABLE_ANSWER),
			s3Error("SomeNameBunMayUse", NO_READABLE_ANSWER),
			s3Error("UnknownError", "<html><body>502 Bad Gateway</body></html>"),
			s3Error("InternalError", "We encountered an internal error. Please try again."),
			s3Error("ServiceUnavailable", "Service Unavailable"),
			s3Error("SlowDown", "Please reduce your request rate."),
			s3Error("RequestTimeout", "Your socket connection to the server was not read from or written to within the timeout period."),
			Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
		]) {
			expect({ error: `${(error as { code?: string }).code}: ${error.message}`, mayPass: mayPass(error) }).toEqual({ error: `${(error as { code?: string }).code}: ${error.message}`, mayPass: true });
		}
		for (const error of [
			s3Error("AccessDenied", "Access Denied"),
			s3Error("ExpiredToken", "The provided token has expired."),
			s3Error("InvalidAccessKeyId", "The AWS Access Key Id you provided does not exist in our records."),
			new Error("s3://b/blobs/sha256/x: its bytes hash to sha256:y, not sha256:x"),
			"a string",
			null,
		]) {
			expect({ error: String(error), mayPass: mayPass(error) }).toEqual({ error: String(error), mayPass: false });
		}
	});

	test("is decided by S3's code when the code says: a refusal with the client's generic words is not made again, nor is any code about the request", () => {
		// S3's body named a code but no message: the client keeps its generic words, and the code decides.
		for (const code of ["AccessDenied", "ExpiredToken", "InvalidAccessKeyId", "SignatureDoesNotMatch", "NoSuchBucket", "RequestTimeTooSkewed", "PermanentRedirect"]) {
			expect({ code, mayPass: mayPass(s3Error(code, NO_READABLE_ANSWER)) }).toEqual({ code, mayPass: false });
		}
		// A code that may pass does, whatever its words.
		for (const code of ["SlowDown", "InternalError", "ServiceUnavailable", "RequestTimeout", "UnknownError", "ConnectionClosed"]) {
			expect({ code, mayPass: mayPass(s3Error(code, "any words")) }).toEqual({ code, mayPass: true });
		}
		// A code that says neither: the words decide.
		expect(mayPass(s3Error("SomeNameBunMayUse", NO_READABLE_ANSWER))).toBe(true);
		expect(mayPass(s3Error("SomeCodeS3MayAdd", "Some words of S3's."))).toBe(false);
		expect(mayPass(Object.assign(new Error(NO_READABLE_ANSWER), { name: "S3Error" }))).toBe(true);
	});

	test("a refusal with the client's generic words fails at once, and the error is true of every try that was made", async () => {
		const refused = scripted([s3Error("AccessDenied", NO_READABLE_ANSWER), BYTES]);
		await expect(retryingStore(refused, recorded().options).get(KEY)).rejects.toThrow(
			`s3://scripted/${KEY}: AccessDenied: an unexpected error has occurred (not tried again: an answer about the request itself)`,
		);
		expect(refused.calls).toBe(1);
		// Tries that met different answers: each is named, with how many times, and the last; never "on each of" one of them.
		const mixed = scripted([NO_ANSWER, s3Error("SlowDown", "Please reduce your request rate."), NO_ANSWER]);
		const error = await retryingStore(mixed, { ...recorded().options, tries: 3 })
			.get(KEY)
			.then(
				() => null,
				(caught: Error) => caught,
			);
		expect(error?.message).toBe(
			`s3://scripted/${KEY}: 3 tries met: ConnectionClosed: an unexpected error has occurred (2 times), SlowDown: Please reduce your request rate. (once); ` +
				"the last: ConnectionClosed: an unexpected error has occurred",
		);
		expect(error?.message).not.toContain("on each of");
		// A retried failure, then a refusal: both are named, and the refusal says it was not tried again.
		const thenRefused = scripted([NO_ANSWER, s3Error("AccessDenied", "Access Denied"), BYTES]);
		await expect(retryingStore(thenRefused, recorded().options).get(KEY)).rejects.toThrow(
			`s3://scripted/${KEY}: 2 tries met: ConnectionClosed: an unexpected error has occurred (once), AccessDenied: Access Denied (once); ` +
				"the last: AccessDenied: Access Denied (not tried again: an answer about the request itself)",
		);
		expect(thenRefused.calls).toBe(2);
	});

	test("that never succeeds is made 8 times in all, then fails plainly, naming the key, the client's code and words, and the tries", async () => {
		const store = scripted([NO_ANSWER]);
		const { sleeps, options } = recorded();
		await expect(retryingStore(store, options).get(KEY)).rejects.toThrow(`s3://scripted/${KEY}: ConnectionClosed: an unexpected error has occurred, on each of 8 tries`);
		expect(store.calls).toBe(8);
		// 0.5, 1, 2, 4 and 8 seconds, then 8 seconds at most: 31.5 seconds of pauses at most for one read.
		expect(sleeps).toEqual([375, 750, 1500, 3000, 6000, 6000, 6000]);
	});

	test("stops the Method as a blob that cannot be had always has, once it has been tried enough", async () => {
		const series = await import("../methods/v1");
		const { readRunFiles } = await import("../scripts/lib/run-files");
		const files = readRunFiles(SAMPLES);
		const failing = retryingStore(scripted([NO_ANSWER]), { ...recorded().options, tries: 2 });
		await expect(series.gather(files, blobsFromBucket(failing, null))).rejects.toThrow("an unexpected error has occurred, on each of 2 tries");
	});
});

describe("a read that would not pass, or a blob that is not there", () => {
	test("an answer about the request itself is not made again, and says so", async () => {
		const store = scripted([s3Error("AccessDenied", "Access Denied"), BYTES]);
		const { sleeps, options } = recorded();
		await expect(retryingStore(store, options).get(KEY)).rejects.toThrow(`s3://scripted/${KEY}: AccessDenied: Access Denied (not tried again: an answer about the request itself)`);
		expect(store.calls).toBe(1);
		expect(sleeps).toEqual([]);
	});

	test("a blob that is not there is answered at once and never tried again, and the caller fails on it as before", async () => {
		const store = scripted([null, BYTES]);
		const { sleeps, options } = recorded();
		const retrying = retryingStore(store, options);
		expect(await retrying.get(KEY)).toBeNull();
		expect(store.calls).toBe(1);
		expect(sleeps).toEqual([]);
		expect(retrying.retried()).toBe(0);
	});
});

describe("a damaged blob in the cache", () => {
	const scratch = mkdtempSync(join(tmpdir(), "blob-cache-"));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));
	/** A cache holding the blob cut short, as a cache restored only in part can. */
	const damagedCache = (name: string): { cache: string; file: string } => {
		const cache = join(scratch, name);
		const file = join(cache, "sha256", HASH.slice("sha256:".length));
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, BYTES.slice(0, 3));
		return { cache, file };
	};

	test("is fetched again from the bucket, through the retrying store, checked, and put in place of the damaged file", async () => {
		const { cache, file } = damagedCache("repaired");
		const store = scripted([NO_ANSWER, BYTES]);
		const lines: string[] = [];
		const fetch = blobsFromBucket(retryingStore(store, recorded().options), cache, { log: (line) => void lines.push(line) });
		expect(await fetch(HASH)).toEqual(BYTES);
		// The bucket was asked, and its first failure tried again.
		expect(store.calls).toBe(2);
		expect(new Uint8Array(readFileSync(file))).toEqual(BYTES);
		expect(lines).toEqual([`${file}: its bytes hash to sha256:${sha256(BYTES.slice(0, 3))}, not ${HASH}: fetched again from s3://scripted, and put in its place`]);
		// The next read is the cache's, the bucket not asked.
		expect(await fetch(HASH)).toEqual(BYTES);
		expect(store.calls).toBe(2);
	});

	test("fails as before when the bucket's bytes do not have the hash either, or the bucket has no such blob; the damaged file is left as it is", async () => {
		const wrong = damagedCache("wrong");
		await expect(blobsFromBucket(scripted([new TextEncoder().encode("not the blob")]), wrong.cache, { log: () => {} })(HASH)).rejects.toThrow(
			`${wrong.file}: its bytes hash to sha256:${sha256(BYTES.slice(0, 3))}, not ${HASH}; fetched again, s3://scripted/${KEY}: its bytes hash to`,
		);
		expect(new Uint8Array(readFileSync(wrong.file))).toEqual(BYTES.slice(0, 3));
		const none = damagedCache("none");
		await expect(blobsFromBucket(scripted([null]), none.cache, { log: () => {} })(HASH)).rejects.toThrow(`and s3://scripted has no ${KEY} to put in its place`);
	});

	test("read where blobs are not kept (the stdout reader) is fetched again and not written", async () => {
		const { cache, file } = damagedCache("not-kept");
		const lines: string[] = [];
		expect(await blobsFromBucket(scripted([BYTES]), cache, { keep: false, log: (line) => void lines.push(line) })(HASH)).toEqual(BYTES);
		expect(new Uint8Array(readFileSync(file))).toEqual(BYTES.slice(0, 3));
		expect(lines[0]).toEndWith(": fetched again from s3://scripted");
	});
});

describe("a pass over the streams that meets a read it cannot make", () => {
	test("starts no other read, lets those already started end, and only then fails: nothing goes on reading behind the caller", async () => {
		const hashes = Array.from({ length: 200 }, (_, i) => `sha256:${i.toString(16).padStart(64, "0")}`);
		// Every read waits until the test answers it, so the order is the test's, not a clock's.
		const started: string[] = [];
		const answers = new Map<string, { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }>();
		const fetchStream = (hash: string): Promise<Uint8Array | null> => {
			started.push(hash);
			return new Promise((resolve, reject) => answers.set(hash, { resolve, reject }));
		};
		/** Lets every promise that can move, move. */
		const settle = (): Promise<void> => Bun.sleep(0);
		const reducer: StreamReducer<unknown> = { key: "series-v1-0123456789abcdef", reduce: () => ({}), toJson: (record) => record, fromJson: (value) => value };
		const counts = { fetched: 0, kept: 0 };
		let ended = false;
		const pass = keepRecords(hashes, [reducer], fetchStream, memoryRecords(), 16, counts).then(
			() => null,
			(error: Error) => error,
		);
		void pass.finally(() => {
			ended = true;
		});
		await settle();
		// The first 16, one per worker, and no more.
		expect(started).toEqual(hashes.slice(0, 16));
		answers.get(hashes[5] as string)?.reject(new Error("s3://b/blobs/sha256/5: ConnectionClosed: an unexpected error has occurred, on each of 8 tries"));
		await settle();
		// Failed, but not yet thrown: 15 reads are still in flight, and none has been started since.
		expect(ended).toBe(false);
		expect(started.length).toBe(16);
		for (const hash of hashes.slice(0, 16)) if (hash !== hashes[5]) answers.get(hash)?.resolve(BYTES);
		const error = await pass;
		expect(error?.message).toContain("on each of 8 tries");
		// Every read it started ended before it threw, and not one more was started, then or after.
		expect(started.length).toBe(16);
		await settle();
		expect(started.length).toBe(16);
		// The count says what was read, and is not added to afterwards.
		expect(counts.fetched).toBe(15);
	});
});

describe("reads in flight", () => {
	test("never more than inFlight at once, however many are asked for; a read waiting out its pause holds no place", async () => {
		const keys = Array.from({ length: 60 }, (_, i) => `blobs/sha256/${String(i).padStart(64, "0")}`);
		// The first read of every third key fails once and is made again: decided by the key and its tries, when the read starts.
		const failsOnce = new Set(keys.filter((_, i) => i % 3 === 0));
		const tries = new Map<string, number>();
		let now = 0;
		let pausing = 0;
		let peak = 0;
		let peakWithPauses = 0;
		const slow: BlobStore = {
			name: "s3://slow",
			async get(key) {
				const attempt = (tries.get(key) ?? 0) + 1;
				tries.set(key, attempt);
				now++;
				peak = Math.max(peak, now);
				peakWithPauses = Math.max(peakWithPauses, now + pausing);
				await Bun.sleep(2);
				now--;
				if (failsOnce.has(key) && attempt === 1) throw NO_ANSWER;
				return BYTES;
			},
		};
		const retrying = retryingStore(slow, {
			inFlight: 4,
			random: () => 0,
			log: () => {},
			sleep: async (ms) => {
				pausing++;
				await Bun.sleep(ms / 100);
				pausing--;
			},
		});
		const got = await Promise.all(keys.map((key) => retrying.get(key)));
		expect(got.every((bytes) => bytes === BYTES)).toBe(true);
		expect(peak).toBe(4);
		expect(retrying.retried()).toBe(20);
		expect([...tries.values()].reduce((sum, n) => sum + n, 0)).toBe(80);
		// A read started while another waited out its pause: in flight and pausing together exceeded the bound, so the pausing one held no place.
		expect(peakWithPauses).toBeGreaterThan(4);
	});
});

describe("Bun's own S3 client, against the stand-in for S3", () => {
	const standin = new S3Standin();
	const READER = "AKIDREADER";
	beforeAll(() => {
		standin.start();
		standin.bucket("runs", { readers: [READER] });
		standin.put("runs", KEY, BYTES);
	});
	afterAll(() => standin.stop());
	const bucket = (): S3Bucket => new S3Bucket("runs", "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: READER, secretAccessKey: "x" }) });

	test("an empty error answer is 'an unexpected error has occurred' to it, and S3's own errors are in S3's words; each is tried again and the blob, hash checked, is read", async () => {
		const seen: string[] = [];
		standin.fault = (request) => {
			if (request.method !== "GET" || request.key !== KEY) return undefined;
			seen.push(request.key);
			if (seen.length === 1) return new Response(null, { status: 503 });
			if (seen.length === 2) return s3Answer(500, "InternalError", "We encountered an internal error. Please try again.");
			if (seen.length === 3) return s3Answer(503, "SlowDown", "Please reduce your request rate.");
			return undefined;
		};
		try {
			const { lines, options } = recorded();
			const fetch = blobsFromBucket(retryingStore(bucket(), { ...options, sleep: async () => {} }), null);
			expect(await fetch(HASH)).toEqual(BYTES);
			expect(seen.length).toBe(4);
			expect(lines.map((line) => line.replace(/ in \d+ ms$/, ""))).toEqual([
				`s3://runs/${KEY}: UnknownError: an unexpected error has occurred; try 2 of 8`,
				`s3://runs/${KEY}: InternalError: We encountered an internal error. Please try again.; try 3 of 8`,
				`s3://runs/${KEY}: SlowDown: Please reduce your request rate.; try 4 of 8`,
			]);
		} finally {
			standin.fault = undefined;
		}
	});

	test("a key the bucket does not hold is asked for once, and is no blob", async () => {
		const before = standin.requests.length;
		const missing = `sha256:${"0".repeat(64)}`;
		expect(await blobsFromBucket(retryingStore(bucket(), { ...recorded().options, sleep: async () => {} }), null)(missing)).toBeNull();
		expect(standin.requests.slice(before).length).toBe(1);
	});

	test("a connection closed with no answer, or part way through one, is 'an unexpected error has occurred' with the code ConnectionClosed, and is tried again", async () => {
		// A bare server: the first connections are closed as soon as a request arrives, the next part way through the answer, and then the blob is served whole.
		let requests = 0;
		const server = Bun.listen<{ buffered: string }>({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					socket.data = { buffered: "" };
				},
				data(socket, data) {
					socket.data.buffered += data.toString("latin1");
					if (!socket.data.buffered.includes("\r\n\r\n")) return;
					socket.data.buffered = "";
					requests++;
					if (requests <= 2) socket.end();
					else if (requests <= 4) socket.end(`HTTP/1.1 200 OK\r\ncontent-length: ${BYTES.length}\r\n\r\n${new TextDecoder().decode(BYTES.slice(0, 2))}`);
					else socket.write(`HTTP/1.1 200 OK\r\ncontent-length: ${BYTES.length}\r\n\r\n${new TextDecoder().decode(BYTES)}`);
				},
			},
		});
		try {
			const cutting = new S3Bucket("runs", "us-east-2", { endpoint: `http://127.0.0.1:${server.port}`, credentials: () => ({ accessKeyId: READER, secretAccessKey: "x" }) });
			const { lines, options } = recorded();
			const retrying = retryingStore(cutting, { ...options, sleep: async () => {} });
			expect(await blobsFromBucket(retrying, null)(HASH)).toEqual(BYTES);
			// The client may make a request again itself after a closed connection; whatever reaches the store is tried again by it.
			expect(requests).toBe(5);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(line).toMatch(new RegExp(`^s3://runs/${KEY}: ConnectionClosed: an unexpected error has occurred; try \\d of 8 in \\d+ ms$`));
		} finally {
			server.stop(true);
		}
	});
});

/** An error answer as S3 writes it. */
function s3Answer(status: number, code: string, message: string): Response {
	return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message></Error>`, { status, headers: { "content-type": "application/xml" } });
}

describe("scripts/derive.ts --bucket", () => {
	const standin = new S3Standin();
	const READER = "AKIDDERIVE";
	const scratch = mkdtempSync(join(tmpdir(), "blob-retries-"));
	beforeAll(() => {
		standin.start();
		standin.bucket("runs", { readers: [READER] });
		const blobs = join(SAMPLES, "blobs", "sha256");
		for (const hex of readdirSync(blobs)) standin.put("runs", `blobs/sha256/${hex}`, readFileSync(join(blobs, hex)));
	});
	afterAll(() => {
		standin.stop();
		rmSync(scratch, { recursive: true, force: true });
	});

	/** derive.ts as a process, its bucket the stand-in (Bun's S3 client reads S3_ENDPOINT), awaited so the stand-in keeps answering. */
	async function derive(out: string, extra: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
		const child = Bun.spawn(
			["bun", join(ROOT, "scripts", "derive.ts"), "--runs", SAMPLES, "--bucket", "runs", "--out", join(scratch, `${out}.json`), "--requests-out", join(scratch, `${out}-requests.json`), ...extra],
			{
				cwd: ROOT,
				stdout: "pipe",
				stderr: "pipe",
				env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir(), S3_ENDPOINT: standin.url, AWS_ACCESS_KEY_ID: READER, AWS_SECRET_ACCESS_KEY: "x" },
			},
		);
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { code, stdout, stderr };
	}

	test("a cold rebuild whose every read fails twice before it succeeds gives the same bytes as reading the blobs from disk, and says how many reads were made again", async () => {
		const local = Bun.spawnSync(["bun", join(ROOT, "scripts", "derive.ts"), "--runs", SAMPLES, "--blobs", join(SAMPLES, "blobs"), "--out", join(scratch, "local.json"), "--requests-out", join(scratch, "local-requests.json")], { cwd: ROOT });
		expect(local.exitCode).toBe(0);
		failFirstTwice(standin);
		const before = standin.requests.length;
		const result = await derive("retried", ["--records", join(scratch, "records"), "--cache", join(scratch, "cache")]);
		standin.fault = undefined;
		expect(result.code).toBe(0);
		expect(readFileSync(join(scratch, "retried.json"), "utf8")).toBe(readFileSync(join(scratch, "local.json"), "utf8"));
		expect(readFileSync(join(scratch, "retried-requests.json"), "utf8")).toBe(readFileSync(join(scratch, "local-requests.json"), "utf8"));
		// Every blob read failed twice, first with no body, then with S3's SlowDown: two reads made again for each blob the Methods read, and each read three times in all.
		const read = standin.requests.slice(before).map((request) => request.key);
		const blobs = new Set(read).size;
		expect(blobs).toBeGreaterThan(8);
		expect(read.length).toBe(3 * blobs);
		expect(result.stdout).toContain(`reads from s3://runs made again after a failure that may pass: ${2 * blobs} (each is logged above, with why)`);
		expect(result.stderr.split("\n").filter((line) => line.includes("UnknownError: an unexpected error has occurred; try 2 of 8")).length).toBe(blobs);
		expect(result.stderr.split("\n").filter((line) => line.includes("SlowDown: Please reduce your request rate.; try 3 of 8")).length).toBe(blobs);
	});

	test("a dump blob cut short in a restored cache is fetched again, once, and put right: the next run is not failed by it", async () => {
		const state = ["--records", join(scratch, "damaged-records"), "--cache", join(scratch, "damaged-cache")];
		expect((await derive("damaged-first", state)).code).toBe(0);
		const before = (JSON.parse(readFileSync(join(SAMPLES, "runs", firstRun()), "utf8")) as { environment: { before: string } }).environment.before;
		const file = join(scratch, "damaged-cache", "sha256", before.slice("sha256:".length));
		const good = readFileSync(file);
		writeFileSync(file, good.subarray(0, Math.floor(good.length / 2)));
		const asked = standin.requests.length;
		const result = await derive("damaged", state);
		expect(result.code).toBe(0);
		expect(readFileSync(join(scratch, "damaged.json"), "utf8")).toBe(readFileSync(join(scratch, "damaged-first.json"), "utf8"));
		expect(result.stderr).toContain(`${file}: its bytes hash to sha256:`);
		expect(result.stderr).toContain(`fetched again from s3://runs, and put in its place`);
		// The one damaged blob was asked for, and nothing else: the records and the rest of the cache were whole.
		expect(standin.requests.slice(asked).map((request) => request.key)).toEqual([`blobs/sha256/${before.slice("sha256:".length)}`]);
		expect(readFileSync(file).equals(good)).toBe(true);
	});

	test("a blob the bucket does not hold stops the Methods that read it, plainly, after one read of it", async () => {
		const stdout = (JSON.parse(readFileSync(join(SAMPLES, "runs", firstRun()), "utf8")) as { stdout: string }).stdout;
		const key = `blobs/sha256/${stdout.slice("sha256:".length)}`;
		const held = standin.buckets.get("runs")?.objects.get(key);
		standin.buckets.get("runs")?.objects.delete(key);
		const before = standin.requests.length;
		const result = await derive("missing");
		if (held !== undefined) standin.buckets.get("runs")?.objects.set(key, held);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`blob ${stdout} cannot be fetched`);
		expect(result.stderr).not.toContain("try 2 of 8");
		// Without records, each Method reads every stream itself: one read of the missing blob each, none made again.
		expect(standin.requests.slice(before).filter((request) => request.key === key).length).toBe(2);
	});
});

/** The path, under runs/, of the samples' first Run file. */
function firstRun(): string {
	const found = (readdirSync(join(SAMPLES, "runs"), { recursive: true }) as string[]).filter((path) => path.endsWith(".json")).sort();
	return found[0] as string;
}

/** The stand-in fails the first two reads of every blob: an empty 503, then S3's SlowDown. */
function failFirstTwice(standin: S3Standin): void {
	const seen = new Map<string, number>();
	standin.fault = (request) => {
		if (request.method !== "GET" || !request.key.startsWith("blobs/")) return undefined;
		const n = seen.get(request.key) ?? 0;
		seen.set(request.key, n + 1);
		if (n === 0) return new Response(null, { status: 503 });
		if (n === 1) return s3Answer(503, "SlowDown", "Please reduce your request rate.");
		return undefined;
	};
}
