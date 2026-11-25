/**
 * scripts/read-api-tree.ts: the tree the website is built from, read from the API bucket itself
 * (ADR-0035), against a stand-in for S3 on this machine (tests/s3-standin.ts): only the keys the
 * table of contents' links give, under v1/; every read signed, bounded in time and in size; the
 * three files of one publication, read again while an upload is under way and refused if they
 * still disagree; written all or none.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readApiTree } from "../scripts/read-api-tree";
import { S3Standin } from "./s3-standin";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(ROOT, "site", "fixtures", "tree");
const BUCKET = "ledgermath-production-runs-apibucketbucket-abcdefgh";
/** The site job's key: the role may read the bucket. */
const READER = "AKIASITEJOBEXAMPLE00";
const KEYS = ["v1/index.json", "v1/series.json", "v1/prices/2026-11-19.json"] as const;
const scratch = mkdtempSync(join(tmpdir(), "read-api-tree-test-"));

const fixture = (key: string) => readFileSync(join(FIXTURE, key));
const json = (key: string) => JSON.parse(fixture(key).toString()) as Record<string, any>;
let made = 0;
const out = () => join(scratch, `tree-${++made}`);

describe("reading the tree from the API bucket", () => {
	let standin: S3Standin;
	const options = (extra: Parameters<typeof readApiTree>[2] = {}) => ({
		endpoint: standin.url,
		credentials: () => ({ accessKeyId: READER, secretAccessKey: "secret", sessionToken: "token" }),
		retryWaitMs: 0,
		...extra,
	});

	beforeEach(() => {
		standin = new S3Standin();
		standin.start();
		standin.bucket(BUCKET, { readers: [READER] });
		for (const key of KEYS) standin.put(BUCKET, key, fixture(key), "application/json");
		// Files the site does not read, which the reader must leave alone.
		standin.put(BUCKET, "v1/series/a0faf4326dd7.json", "{}", "application/json");
		standin.put(BUCKET, "v1/prices/2026-11-18.json", "{}", "application/json");
	});
	afterEach(() => standin.stop());

	test("reads the table of contents and only the two files its links give, each with one signed GET by the job's key, and writes them byte for byte", async () => {
		const dir = out();
		const read: string[] = [];
		const tree = await readApiTree(BUCKET, dir, options({ onRead: (key) => read.push(key) }));
		expect(read).toEqual([...KEYS]);
		expect(standin.requests).toEqual(KEYS.map((key) => ({ method: "GET", bucket: BUCKET, key, keyId: READER, ifNoneMatch: null })));
		for (const key of KEYS) expect(readFileSync(join(dir, key))).toEqual(fixture(key));
		expect(tree).toMatchObject({ dir, newestRunStartedAt: json("v1/index.json").newest_run_started_at, hasRecentRounds: true });
		expect(tree.files.map((file) => file.path)).toEqual([...KEYS]);
	});

	test("files of two publications are read again while an upload is under way, and the set that agrees is written", async () => {
		const index = json("v1/index.json");
		standin.put(BUCKET, "v1/index.json", JSON.stringify({ ...index, newest_run_started_at: "2026-11-19T22:59:59.000000000Z" }), "application/json");
		const told: number[] = [];
		const dir = out();
		const tree = await readApiTree(
			BUCKET,
			dir,
			options({
				onMismatch: (attempt) => {
					told.push(attempt);
					// The upload finishes: the table of contents is written last.
					standin.put(BUCKET, "v1/index.json", fixture("v1/index.json"), "application/json");
				},
			}),
		);
		expect(told).toEqual([1]);
		expect(readFileSync(join(dir, "v1/index.json"))).toEqual(fixture("v1/index.json"));
		expect(tree.newestRunStartedAt).toBe(index.newest_run_started_at);
		expect(standin.requests.length).toBe(6);
	});

	test("files that still disagree after every attempt: nothing is written", async () => {
		standin.put(BUCKET, "v1/index.json", JSON.stringify({ ...json("v1/index.json"), newest_run_started_at: "2026-11-19T22:59:59.000000000Z" }), "application/json");
		const dir = out();
		await expect(readApiTree(BUCKET, dir, options({ attempts: 3 }))).rejects.toThrow("were of two publications of the API each of the 3 times they were fetched");
		expect(existsSync(dir)).toBe(false);
		expect(standin.requests.length).toBe(9);
	});

	test("a missing key fails the read, saying which, and writes nothing", async () => {
		standin.buckets.get(BUCKET)?.objects.delete("v1/series.json");
		const dir = out();
		await expect(readApiTree(BUCKET, dir, options())).rejects.toThrow(`s3://${BUCKET}/v1/series.json (for https://api.ledgermath.com/v1/series.json): GET s3://${BUCKET}/v1/series.json answered 404 NoSuchKey`);
		expect(existsSync(dir)).toBe(false);
	});

	test("a key the job may not read fails the read with S3's refusal", async () => {
		const dir = out();
		await expect(readApiTree(BUCKET, dir, options({ credentials: () => ({ accessKeyId: "AKIASTRANGER00000000", secretAccessKey: "x" }) }))).rejects.toThrow("answered 403 AccessDenied");
		expect(existsSync(dir)).toBe(false);
	});

	test("a read whose body never ends, or whose answer never comes, is given up after its time limit, and nothing is written", async () => {
		standin.fault = (request) =>
			request.key === "v1/series.json"
				? new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("{")) }), { headers: { "content-type": "application/json" } })
				: undefined;
		const stalled = out();
		const started = performance.now();
		await expect(readApiTree(BUCKET, stalled, options({ timeoutMs: 500 }))).rejects.toThrow("the body was not read within 500 ms");
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(existsSync(stalled)).toBe(false);

		const silent = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
		try {
			const dir = out();
			await expect(readApiTree(BUCKET, dir, options({ endpoint: `http://127.0.0.1:${silent.port}`, timeoutMs: 500 }))).rejects.toThrow("no answer within 500 ms");
			expect(existsSync(dir)).toBe(false);
		} finally {
			silent.stop(true);
		}
	});

	test("a file over its limit is refused, by its declared length or as it is read", async () => {
		const dir = out();
		const limits = { index: 1_000_000, seriesList: 1_000, prices: 10_000_000 };
		await expect(readApiTree(BUCKET, dir, options({ limits }))).rejects.toThrow(`GET s3://${BUCKET}/v1/series.json: ${fixture("v1/series.json").length} bytes, over the limit of 1000`);
		expect(existsSync(dir)).toBe(false);
		// No Content-Length: counted as it comes.
		standin.fault = (request) =>
			request.key === "v1/series.json"
				? new Response(new ReadableStream({ start: (controller) => (controller.enqueue(fixture("v1/series.json")), controller.close()) }), { headers: { "content-type": "application/json" } })
				: undefined;
		await expect(readApiTree(BUCKET, out(), options({ limits }))).rejects.toThrow("over the limit of 1000 bytes");
	});

	test("a link that leaves v1/, or the table of contents' own address, is refused before anything but the table of contents is read", async () => {
		const index = json("v1/index.json");
		for (const url of ["https://api.ledgermath.com/runs/2026/11/19/x.json", "https://api.ledgermath.com/v1/../blobs/x.json", "https://elsewhere.example/v1/series.json"]) {
			standin.requests.length = 0;
			standin.put(BUCKET, "v1/index.json", JSON.stringify({ ...index, series: { ...index.series, url } }), "application/json");
			const dir = out();
			await expect(readApiTree(BUCKET, dir, options())).rejects.toThrow(/not a plain path to a JSON file under v1\/|not under the tree's base/);
			expect(standin.requests.map((request) => request.key)).toEqual(["v1/index.json"]);
			expect(existsSync(dir)).toBe(false);
		}
	});
});

describe("the command line", () => {
	let standin: S3Standin;
	beforeEach(() => {
		standin = new S3Standin();
		standin.start();
		standin.bucket(BUCKET, { readers: [READER] });
		for (const key of KEYS) standin.put(BUCKET, key, fixture(key), "application/json");
	});
	afterEach(() => standin.stop());

	/** The script in a child; spawned, not run synchronously, so the stand-in in this process can answer it. */
	const script = async (args: string[], env: Record<string, string> = {}) => {
		const child = Bun.spawn(["bun", join(ROOT, "scripts", "read-api-tree.ts"), ...args], {
			env: { ...process.env, AWS_ACCESS_KEY_ID: READER, AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "token", ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { code, stdout, stderr };
	};

	test("writes the tree with the environment's keys and says what it read; exits 1 writing nothing on a failure; 2 on a bad command line or no bucket", async () => {
		const dir = out();
		const done = await script(["--bucket", BUCKET, "--out", dir, "--endpoint", standin.url]);
		expect(done.code).toBe(0);
		expect(done.stdout).toContain(`v1/series.json  ${fixture("v1/series.json").length.toLocaleString("en")} bytes  from s3://${BUCKET}/v1/series.json`);
		expect(done.stdout).toContain("the table of contents gives recent_rounds");
		expect(readFileSync(join(dir, "v1/index.json"))).toEqual(fixture("v1/index.json"));

		const none = out();
		const failed = await script(["--bucket", BUCKET, "--out", none, "--endpoint", standin.url], { AWS_ACCESS_KEY_ID: "" });
		expect(failed.code).toBe(1);
		expect(failed.stderr).toContain("no tree written");
		expect(failed.stderr).toContain("no AWS credentials in the environment");
		expect(existsSync(none)).toBe(false);

		for (const args of [["--out", out()], ["--bucket", BUCKET], ["--bucket", "", "--out", out()], ["--bucket", BUCKET, "--out", out(), "--unknown", "x"]]) {
			expect({ args, code: (await script(args)).code }).toEqual({ args, code: 2 });
		}
		expect((await script(["--bucket", "", "--out", out()])).stderr).toContain("is the repository variable API_BUCKET set?");
	});
});
