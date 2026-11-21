/**
 * The data API's bucket and the upload into it (infra/runs/api-bucket.ts,
 * scripts/lib/api-upload.ts, scripts/upload-api.ts, scripts/check-api-bucket.ts;
 * ADR-0031): which files the build writes and the headers each object
 * carries, the role's permission, and the upload and its check against a
 * stand-in for S3 (tests/s3-standin.ts): only changed files written, in an
 * order that never leaves a readable file linking one not there yet, nothing
 * deleted, and a bucket that differs from the tree caught.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { apiBucketArgs, apiUploadPolicy, TREE_CACHE_CONTROL, TREE_CONTENT_TYPE, TREE_KINDS, TREE_PREFIX, treeObject, UPLOAD_PHASES } from "../infra/runs/api-bucket";
import { readPolicy } from "../infra/runs/github-role";
import { buildApi, DEFAULT_BASE, readApiSchemas, readBootSummaries, readPriceFiles } from "../scripts/lib/api";
import { CEILINGS } from "../scripts/lib/api-check";
import { API_SCHEMAS } from "../scripts/lib/api-schemas";
import {
	checkBucket,
	checksumHeader,
	checksumHex,
	inParallel,
	NotStamped,
	OlderTree,
	parseRun,
	RUN_METADATA,
	readTree,
	S3ApiStore,
	STAMP_KEY,
	type TreeFile,
	UnexpectedKeys,
	UploadStopped,
	unexpectedKeys,
	uploadTree,
	writeReason,
} from "../scripts/lib/api-upload";
import { makeApiFixture } from "./api-fixtures";
import { S3Standin } from "./s3-standin";

// A fixture of Methods' Derivations, and a local server: seconds on a loaded machine.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "api-upload-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;
const fresh = (name: string): string => join(scratch, `${made++}-${name}`);

const KEY_ID = "AKIAWORKFLOWEXAMPLE0";
const SECRET = "workflow-secret";
const BUCKET = "ledgermath-production-runs-apibucketbucket-abcdefgh";
const BUCKET_ARN = `arn:aws:s3:::${BUCKET}`;
const RUNS_BUCKET_ARN = "arn:aws:s3:::ledgermath-production-runs-runsbucketbucket-abcdefgh";
/** The workflow run uploading, as GITHUB_RUN_ID gives it. */
const RUN = { run: 44_844_744_565 };

/** Writes a tree (path to bytes) into a new directory, as scripts/build-api.ts does. */
function writeTree(tree: Map<string, Uint8Array>): string {
	const directory = fresh("api");
	for (const [path, bytes] of tree) {
		const full = join(directory, ...path.split("/"));
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, bytes);
	}
	return directory;
}

/** The small fixture's tree: every kind of file the build writes, price files and schemas included. */
let TREE: Map<string, Uint8Array>;
beforeAll(async () => {
	const fixture = await makeApiFixture({ small: true });
	TREE = buildApi({
		base: DEFAULT_BASE,
		docs: "https://example.test/docs",
		series: fixture.series,
		requests: fixture.requests,
		prices: readPriceFiles(fixture.runs),
		boots: readBootSummaries(fixture.runs),
		schemas: readApiSchemas(),
	});
});

describe("the tree's objects", () => {
	test("every file the build writes is of exactly one kind, with a phase, Content-Type application/json and the tree's Cache-Control", () => {
		const kinds = new Set<string>();
		for (const path of TREE.keys()) {
			expect(TREE_KINDS.filter((kind) => kind.path.test(path)).length).toBe(1);
			const object = treeObject(path);
			kinds.add(object.kind);
			expect(object.contentType).toBe("application/json");
			expect(object.cacheControl).toBe("public, max-age=300");
			expect(path.startsWith(TREE_PREFIX)).toBe(true);
		}
		// The fixture's tree holds every kind there is.
		expect([...kinds].sort()).toEqual(TREE_KINDS.map((kind) => kind.kind).sort());
		expect(TREE_CONTENT_TYPE).toBe("application/json");
		expect(TREE_CACHE_CONTROL).toBe("public, max-age=300");
	});

	test("the kinds are the check's: each has a ceiling, and every kind of the check is a kind here", () => {
		for (const path of TREE.keys()) expect(CEILINGS.find((ceiling) => ceiling.path.test(path))?.kind).toBe(treeObject(path).kind);
		expect(new Set(CEILINGS.map((ceiling) => ceiling.kind))).toEqual(new Set(TREE_KINDS.map((kind) => kind.kind)));
	});

	test("refuses a path of no known kind, so nothing goes up with headers nobody chose", () => {
		for (const path of ["v1/other.json", "v1/series/0cacb5fd6fae/2026-11.json.bak", "v1/series/ABC.json", "runs/2026/11/19/x.json", "v2/index.json", "index.html", "v1/series/0cacb5fd6fae/extra/2026-11.json"]) {
			expect(() => treeObject(path)).toThrow("of no kind of the data API's tree");
		}
	});

	test("are uploaded leaves first and the table of contents last: schemas; month files and price files; Series files; the list; the table of contents", () => {
		expect(UPLOAD_PHASES).toEqual(["schemas", "month files and price files", "Series files", "the list of Series", "the table of contents"]);
		expect(treeObject("v1/schemas/series-month.schema.json").phase).toBe(0);
		expect(treeObject("v1/series/0cacb5fd6fae/2026-11.json").phase).toBe(1);
		expect(treeObject("v1/prices/2026-11-19.json").phase).toBe(1);
		expect(treeObject("v1/series/0cacb5fd6fae.json").phase).toBe(2);
		expect(treeObject("v1/series.json").phase).toBe(3);
		expect(treeObject("v1/index.json").phase).toBe(4);
	});

	test("each file links down only to files of earlier phases; its other links go up, to the table of contents, the list, or a month file's own Series file", () => {
		const phaseOf = new Map([...TREE.keys()].map((path) => [path, treeObject(path).phase]));
		let down = 0;
		for (const [path, bytes] of TREE) {
			const text = new TextDecoder().decode(bytes);
			const links = [...text.matchAll(/"https:\/\/api\.ledgermath\.com\/(v1\/[^"]+)"/g)].map((match) => match[1] as string).filter((link) => link !== path);
			for (const link of links) {
				expect(phaseOf.has(link)).toBe(true);
				const up = link === "v1/index.json" || link === "v1/series.json" || (treeObject(path).kind === "a month file" && path.startsWith(link.replace(/\.json$/, "/")));
				if (up) continue;
				down++;
				expect(phaseOf.get(link) as number).toBeLessThan(phaseOf.get(path) as number);
			}
		}
		expect(down).toBeGreaterThan(TREE.size);
	});
});

describe("the API bucket and the role", () => {
	test("the bucket has no CORS configuration and grants nothing unless the public API is on", () => {
		expect(apiBucketArgs(null)).toStrictEqual({ cors: false });
		const transform = (): undefined => undefined;
		expect(apiBucketArgs(transform)).toStrictEqual({ cors: false, transform: { policy: transform } });
	});

	test("the role may list the API bucket and read and write v1/ there, and delete nothing", () => {
		expect(apiUploadPolicy(BUCKET_ARN)).toEqual({
			Version: "2012-10-17",
			Statement: [
				{ Effect: "Allow", Action: ["s3:ListBucket"], Resource: [BUCKET_ARN] },
				{ Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: [`${BUCKET_ARN}/v1/*`] },
			],
		});
		const actions = JSON.stringify(apiUploadPolicy(BUCKET_ARN).Statement.flatMap((statement) => statement.Action));
		for (const action of ["Delete", "s3:*", "Acl", "Tagging", "PutBucket", "Version"]) expect(actions).not.toContain(action);
	});

	test("with both its policies, the role can still write nothing to the Runs bucket, and writes only under v1/ of the API bucket", () => {
		const statements = [...readPolicy(RUNS_BUCKET_ARN).Statement, ...apiUploadPolicy(BUCKET_ARN).Statement];
		const writes = statements.filter((statement) => statement.Action.some((action) => !/^s3:(Get|List)/.test(action)));
		expect(writes.flatMap((statement) => statement.Resource ?? [])).toEqual([`${BUCKET_ARN}/v1/*`]);
		for (const statement of statements) {
			if ((statement.Resource ?? []).some((resource) => resource.startsWith(RUNS_BUCKET_ARN))) {
				expect(statement.Action.every((action) => action === "s3:GetObject" || action === "s3:ListBucket")).toBe(true);
			}
		}
	});

	test("the stack gives the role the upload policy as a second policy, leaving the role and its read policy as they were", () => {
		const stack = readFileSync(join(ROOT, "infra", "runs", "stack.ts"), "utf8");
		expect(stack).toContain('new aws.iam.RolePolicy("RunsApiUploadPolicy", {\n\t\trole: readerRole.id,\n\t\tpolicy: apiBucket.arn.apply((arn) => JSON.stringify(apiUploadPolicy(arn))),\n\t});');
		expect(stack).toContain('new aws.iam.RolePolicy("RunsReaderPolicy", {\n\t\trole: readerRole.id,\n\t\tpolicy: bucket.arn.apply((arn) => JSON.stringify(readPolicy(arn))),\n\t});');
		expect(stack).toContain('description: "Assumed by .github/workflows/runs.yml on main: lists the bucket, reads runs/, boots/, blobs/",');
		expect(stack).toContain("apiBucket: apiBucket.name,");
	});
});

describe("checksums", () => {
	test("S3's base64 SHA-256 and the tree's hex one are the same value", () => {
		const hex = createHash("sha256").update("test").digest("hex");
		expect(checksumHeader(hex)).toBe(createHash("sha256").update("test").digest("base64"));
		expect(checksumHex(checksumHeader(hex))).toBe(hex);
		expect(checksumHex("not base64 of 32 bytes")).toBeNull();
		expect(checksumHex(Buffer.from("short").toString("base64"))).toBeNull();
	});

	test("a file is written when it is new, has no SHA-256 stored, differs in content or in headers; otherwise not", () => {
		const file: TreeFile = { key: "v1/index.json", bytes: new Uint8Array([1]), sha256: "a".repeat(64), ...treeObject("v1/index.json") };
		const same = { size: 1, sha256: file.sha256, contentType: file.contentType, cacheControl: file.cacheControl, run: 1 };
		expect(writeReason(file, null)).toBe("new");
		// The run that wrote it is no reason to write it again.
		expect(writeReason(file, { ...same, run: 2 })).toBeNull();
		expect(writeReason(file, { ...same, sha256: null })).toBe("no SHA-256 stored with the object");
		expect(writeReason(file, { ...same, sha256: "b".repeat(64) })).toBe("content changed");
		expect(writeReason(file, { ...same, cacheControl: "max-age=60" })).toBe("headers changed");
		expect(writeReason(file, { ...same, contentType: "binary/octet-stream" })).toBe("headers changed");
		expect(writeReason(file, same)).toBeNull();
	});

	test("in parallel, every item is worked on, at most so many at once, and the first failure is thrown once all have settled", async () => {
		let running = 0;
		let most = 0;
		const done: number[] = [];
		await inParallel([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
			running++;
			most = Math.max(most, running);
			await Bun.sleep(2);
			done.push(item);
			running--;
		});
		expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(most).toBe(3);
		const settled: number[] = [];
		await expect(
			inParallel([1, 2, 3], 3, async (item) => {
				if (item === 1) throw new Error("one failed");
				await Bun.sleep(5);
				settled.push(item);
			}),
		).rejects.toThrow("one failed");
		expect(settled.sort()).toEqual([2, 3]);
	});
});

describe("reading a tree", () => {
	test("gives every file with its key, SHA-256 and headers, in key order", () => {
		const files = readTree(writeTree(TREE));
		expect(files.map((file) => file.key)).toEqual([...TREE.keys()].sort());
		for (const file of files) {
			expect(file.sha256).toBe(createHash("sha256").update(TREE.get(file.key) as Uint8Array).digest("hex"));
			expect(file).toMatchObject(treeObject(file.key));
		}
	});

	test("refuses a file outside v1/, of no known kind, a link, or no file at all", () => {
		const outside = writeTree(TREE);
		writeFileSync(join(outside, "notes.txt"), "x");
		expect(() => readTree(outside)).toThrow("outside v1/");
		const unknown = writeTree(TREE);
		writeFileSync(join(unknown, "v1", "extra.json"), "{}");
		expect(() => readTree(unknown)).toThrow("of no kind");
		const linked = writeTree(TREE);
		symlinkSync(join(linked, "v1", "index.json"), join(linked, "v1", "series", "0123456789ab.json"));
		expect(() => readTree(linked)).toThrow("not a plain file");
		const empty = fresh("empty");
		mkdirSync(empty);
		expect(() => readTree(empty)).toThrow("holds no file");
	});
});

describe("the upload, against a stand-in for S3", () => {
	let standin: S3Standin;
	let store: S3ApiStore;
	const objects = () => standin.buckets.get(BUCKET)?.objects ?? new Map();
	const puts = () => standin.requests.filter((request) => request.method === "PUT").map((request) => request.key);

	beforeEach(() => {
		standin = new S3Standin();
		standin.start();
		standin.bucket(BUCKET, { writers: [KEY_ID] });
		standin.secrets.set(KEY_ID, SECRET);
		store = new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: KEY_ID, secretAccessKey: SECRET, sessionToken: "token" }) });
	});
	afterEach(() => standin.stop());

	test("writes every file of a new tree, each with its headers and its SHA-256 kept, phase by phase, leaves first and the table of contents last", async () => {
		const files = readTree(writeTree(TREE));
		const report = await uploadTree(store, files, { ...RUN, concurrency: 4 });
		expect(report.phases.map((phase) => phase.phase)).toEqual([...UPLOAD_PHASES]);
		expect(report.phases.reduce((sum, phase) => sum + phase.written.length, 0)).toBe(files.length);
		expect([...report.reasons.values()].every((reason) => reason === "new")).toBe(true);
		for (const file of files) {
			const stored = objects().get(file.key);
			expect(Buffer.from(stored?.bytes ?? []).equals(Buffer.from(file.bytes))).toBe(true);
			expect(stored?.contentType).toBe("application/json");
			expect(stored?.cacheControl).toBe("public, max-age=300");
			expect(stored?.checksumSha256).toBe(checksumHeader(file.sha256));
		}
		// Every PUT of a phase comes before every PUT of the next: the table of contents last of all.
		const order = puts().map((key) => treeObject(key).phase);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(puts().at(-1)).toBe("v1/index.json");
		expect(puts().at(-2)).toBe("v1/series.json");
		// Signed as S3 checks it (the stand-in verifies the signature of each PUT with the secret).
		expect(standin.requests.every((request) => request.keyId === KEY_ID)).toBe(true);
	});

	test("a second upload of the same tree writes nothing: unchanged files, month files included, are not rewritten", async () => {
		const files = readTree(writeTree(TREE));
		await uploadTree(store, files, RUN);
		const before = puts().length;
		const report = await uploadTree(store, files, RUN);
		expect(puts().length).toBe(before);
		expect(report.reasons.size).toBe(0);
		expect(report.phases.map((phase) => phase.written.length)).toEqual([0, 0, 0, 0, 0]);
		for (const object of objects().values()) expect(object.writes).toBe(1);
	});

	test("writes only the files whose content changed, still in phase order", async () => {
		await uploadTree(store, readTree(writeTree(TREE)), RUN);
		const month = [...TREE.keys()].find((path) => treeObject(path).kind === "a month file") as string;
		const series = [...TREE.keys()].find((path) => treeObject(path).kind === "a Series file") as string;
		const changed = new Map(TREE);
		for (const path of [month, series, "v1/series.json", "v1/index.json"]) changed.set(path, new TextEncoder().encode(`${new TextDecoder().decode(TREE.get(path))} `));
		const already = puts().length;
		const report = await uploadTree(store, readTree(writeTree(changed)), RUN);
		const written = puts().slice(already);
		expect(written).toEqual([month, series, "v1/series.json", "v1/index.json"]);
		expect(new Set(report.reasons.values())).toEqual(new Set(["content changed"]));
		expect(objects().get(month)?.writes).toBe(2);
		const untouched = [...TREE.keys()].filter((path) => ![month, series, "v1/series.json", "v1/index.json"].includes(path));
		for (const path of untouched) expect(objects().get(path)?.writes).toBe(1);
	});

	test("rewrites a file whose headers, or stored SHA-256, are not what they should be, even with the same bytes", async () => {
		await uploadTree(store, readTree(writeTree(TREE)), RUN);
		const [first, second] = [...TREE.keys()];
		const object = objects().get(first as string);
		if (object === undefined) throw new Error("not uploaded");
		object.cacheControl = "public, max-age=31536000, immutable";
		standin.put(BUCKET, second as string, TREE.get(second as string) as Uint8Array, "application/json");
		const report = await uploadTree(store, readTree(writeTree(TREE)), RUN);
		expect(report.reasons.get(first as string)).toBe("headers changed");
		expect(report.reasons.get(second as string)).toBe("no SHA-256 stored with the object");
		expect(report.reasons.size).toBe(2);
		expect(objects().get(first as string)?.cacheControl).toBe("public, max-age=300");
	});

	test("a key the tree does not have, under v1/ or anywhere else, stops the upload before it writes, or even asks about, anything; and nothing is ever deleted", async () => {
		for (const extra of ["v1/series/ffffffffffff.json", "notes.txt", "v2/index.json"]) {
			standin = (() => {
				standin.stop();
				const fresh = new S3Standin();
				fresh.start();
				fresh.bucket(BUCKET, { writers: [KEY_ID] });
				fresh.secrets.set(KEY_ID, SECRET);
				return fresh;
			})();
			store = new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: KEY_ID, secretAccessKey: SECRET }) });
			standin.put(BUCKET, extra, "{}", "application/json");
			const refused = await uploadTree(store, readTree(writeTree(TREE)), RUN).catch((error: unknown) => error);
			expect(refused).toBeInstanceOf(UnexpectedKeys);
			expect((refused as UnexpectedKeys).keys).toEqual([extra]);
			expect(String(refused)).toContain(`holds 1 key the tree does not have, so nothing was uploaded`);
			expect(standin.requests.map((request) => request.method)).toEqual(["GET"]);
			expect([...objects().keys()]).toEqual([extra]);
		}
		expect(standin.requests.some((request) => request.method === "DELETE")).toBe(false);
		expect(readFileSync(join(ROOT, "scripts", "lib", "api-upload.ts"), "utf8")).not.toMatch(/"DELETE"|DeleteObject/);
	});

	test("a price file the tree no longer has: the published table of contents and list stay as they were until a person settles the key, then the next upload brings the bucket to the tree", async () => {
		await uploadTree(store, readTree(writeTree(TREE)), RUN);
		const price = [...TREE.keys()].find((path) => treeObject(path).kind === "a price file") as string;
		const before = { index: objects().get("v1/index.json")?.bytes, list: objects().get("v1/series.json")?.bytes };
		// The next tree: the price file gone (a person took it out of the Runs repository), and the table of contents no longer listing it.
		const next = new Map(TREE);
		next.delete(price);
		next.set("v1/index.json", new TextEncoder().encode(`${new TextDecoder().decode(TREE.get("v1/index.json"))} `));
		const writes = puts().length;
		await expect(uploadTree(store, readTree(writeTree(next)), RUN)).rejects.toThrow(`${price}`);
		expect(puts().length).toBe(writes);
		expect(objects().get("v1/index.json")?.bytes).toEqual(before.index);
		expect(objects().get("v1/series.json")?.bytes).toEqual(before.list);
		// The bucket still equals the tree last published, so its check of that tree passes: nothing is half-published.
		expect(await checkBucket(store, readTree(writeTree(TREE)))).toEqual([]);
		// The person deletes the key by hand (README, "A key the tree does not have"); the next run uploads, and the bucket is the tree.
		objects().delete(price);
		await uploadTree(store, readTree(writeTree(next)), RUN);
		expect(await checkBucket(store, readTree(writeTree(next)))).toEqual([]);
	});

	test("stops at a failed write, naming the phase and the key: no later phase is started, so nothing readable links down to what is not there", async () => {
		const files = readTree(writeTree(TREE));
		const failing = files.find((file) => file.phase === 0) as TreeFile;
		standin.fault = (request) => (request.method === "PUT" && request.key === failing.key ? new Response("<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>", { status: 500 }) : undefined);
		const stopped = await uploadTree(store, files, RUN).catch((error: unknown) => error);
		expect(stopped).toBeInstanceOf(UploadStopped);
		expect((stopped as UploadStopped).phase).toBe(0);
		expect((stopped as UploadStopped).failed.map((failure) => failure.key)).toEqual([failing.key]);
		expect(String(stopped)).toContain(`stopped in phase 1 of 5, schemas: 1 write failed, the first ${failing.key}: PUT s3://${BUCKET}/${failing.key} answered 500, InternalError`);
		expect(puts().map((key) => treeObject(key).phase).every((phase) => phase === 0)).toBe(true);
		expect(objects().has("v1/index.json")).toBe(false);
		expect(objects().has("v1/series.json")).toBe(false);
	});

	/** What a reader following the rule finds: every month a Series file in the bucket lists, against the bytes at that month's address. */
	function monthsAgainstSeries(): string[] {
		const mismatches: string[] = [];
		for (const [key, object] of objects()) {
			if (treeObject(key).kind !== "a Series file") continue;
			const months = (JSON.parse(new TextDecoder().decode(object.bytes)) as { months: Array<{ url: string; sha256: string }> }).months;
			for (const month of months) {
				const at = month.url.replace("https://api.ledgermath.com/", "");
				const bytes = objects().get(at)?.bytes;
				const sha = bytes === undefined ? "missing" : createHash("sha256").update(bytes).digest("hex");
				if (sha !== month.sha256) mismatches.push(`${key} lists ${at} as ${month.sha256}, and it is ${sha}`);
			}
		}
		return mismatches.sort();
	}

	/** A next round of the tree: one month file gained bytes, and its Series file lists the new sha256 and size, as the build would write them. */
	function nextRound(): { tree: Map<string, Uint8Array>; month: string; series: string } {
		const tree = new Map(TREE);
		const month = [...TREE.keys()].find((path) => treeObject(path).kind === "a month file") as string;
		const series = `${month.slice(0, month.lastIndexOf("/"))}.json`;
		const monthBytes = new TextEncoder().encode(`${new TextDecoder().decode(TREE.get(month))}\n`);
		tree.set(month, monthBytes);
		const value = JSON.parse(new TextDecoder().decode(TREE.get(series))) as { months: Array<{ url: string; sha256: string; bytes: number }> };
		for (const entry of value.months) {
			if (entry.url.endsWith(month)) {
				entry.sha256 = createHash("sha256").update(monthBytes).digest("hex");
				entry.bytes = monthBytes.length;
			}
		}
		tree.set(series, new TextEncoder().encode(JSON.stringify(value)));
		return { tree, month, series };
	}

	test("an upload that dies after the month files, on a populated bucket: the run fails naming the Series files' phase, and a reader sees a Series file whose sha256 the month's address no longer gives", async () => {
		await uploadTree(store, readTree(writeTree(TREE)), RUN);
		expect(monthsAgainstSeries()).toEqual([]);
		const { tree, month, series } = nextRound();
		standin.fault = (request) => (request.method === "PUT" && treeObject(request.key).kind === "a Series file" ? new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 }) : undefined);
		const stopped = await uploadTree(store, readTree(writeTree(tree)), RUN).catch((error: unknown) => error);
		expect(stopped).toBeInstanceOf(UploadStopped);
		expect((stopped as UploadStopped).phase).toBe(2);
		expect((stopped as UploadStopped).failed.map((failure) => failure.key)).toEqual([series]);
		expect(String(stopped)).toContain("stopped in phase 3 of 5, Series files");
		// The month is new, its Series file is old: the mismatch a reader detects by the rule, and no cache expiry repairs.
		expect(createHash("sha256").update(objects().get(month)?.bytes ?? new Uint8Array()).digest("hex")).toBe(createHash("sha256").update(tree.get(month) as Uint8Array).digest("hex"));
		expect(monthsAgainstSeries()).toEqual([expect.stringContaining(`${series} lists ${month} as `)]);
		// The table of contents and the list were not touched.
		expect(objects().get("v1/index.json")?.writes).toBe(1);
		expect(objects().get("v1/series.json")?.writes).toBe(1);
	});

	test("the next run repairs it by itself: it writes only what is still missing, and the bucket is the tree again", async () => {
		await uploadTree(store, readTree(writeTree(TREE)), RUN);
		const { tree, month, series } = nextRound();
		standin.fault = (request) => (request.method === "PUT" && treeObject(request.key).kind === "a Series file" ? new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 }) : undefined);
		await uploadTree(store, readTree(writeTree(tree)), RUN).catch(() => undefined);
		standin.fault = undefined;
		const already = puts().length;
		const report = await uploadTree(store, readTree(writeTree(tree)), RUN);
		// The month was written by the failed run; only the Series file is still to write.
		expect(puts().slice(already)).toEqual([series]);
		expect(objects().get(month)?.writes).toBe(2);
		expect(report.reasons.get(series)).toBe("content changed");
		expect(monthsAgainstSeries()).toEqual([]);
		expect(await checkBucket(store, readTree(writeTree(tree)))).toEqual([]);
	});

	test("says a refused HEAD is a refusal, not a missing file", async () => {
		standin.fault = (request) => (request.method === "HEAD" ? new Response(null, { status: 403 }) : undefined);
		await expect(uploadTree(store, readTree(writeTree(TREE)), RUN)).rejects.toThrow("answered 403 (the role may not read it");
		expect(puts()).toEqual([]);
	});

	test("S3 refuses bytes that are not the ones hashed", async () => {
		const [file] = readTree(writeTree(TREE));
		if (file === undefined) throw new Error("no file");
		await expect(store.put({ ...file, sha256: "0".repeat(64) }, RUN.run)).rejects.toThrow("answered 400");
		expect(objects().has(file.key)).toBe(false);
	});

	test("records on every object it writes the run that wrote it", async () => {
		await uploadTree(store, readTree(writeTree(TREE)), RUN);
		for (const object of objects().values()) expect(object.metadata).toEqual({ [RUN_METADATA]: String(RUN.run) });
		expect((await store.head("v1/index.json"))?.run).toBe(RUN.run);
	});

	test("refuses, writing nothing, a tree from an earlier run than one that wrote to the bucket; takes the same run again, or a later one", async () => {
		await uploadTree(store, readTree(writeTree(TREE)), RUN);
		const { tree } = nextRound();
		const writes = puts().length;
		const refused = await uploadTree(store, readTree(writeTree(tree)), { run: RUN.run - 1 }).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(OlderTree);
		expect(refused).toMatchObject({ run: RUN.run - 1, newest: RUN.run });
		expect(puts().length).toBe(writes);
		// The same run, run again (a re-run keeps its id), and a later run, go ahead.
		expect((await uploadTree(store, readTree(writeTree(TREE)), RUN)).newestRunBefore).toBe(RUN.run);
		const later = await uploadTree(store, readTree(writeTree(tree)), { run: RUN.run + 1 });
		expect(later.newestRunBefore).toBe(RUN.run);
		expect(later.phases.flatMap((phase) => phase.written).length).toBe(2);
		// The table of contents did not change, and is written again only to record the later run.
		expect(later.stamped).toBe(true);
	});

	test("refuses an older run's tree even when the newer run's upload stopped part way, its month files written and nothing after", async () => {
		await uploadTree(store, readTree(writeTree(TREE)), RUN);
		const { tree, month } = nextRound();
		standin.fault = (request) => (request.method === "PUT" && treeObject(request.key).kind === "a Series file" ? new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 }) : undefined);
		await expect(uploadTree(store, readTree(writeTree(tree)), { run: RUN.run + 2 })).rejects.toBeInstanceOf(UploadStopped);
		standin.fault = undefined;
		expect(objects().get(month)?.metadata?.[RUN_METADATA]).toBe(String(RUN.run + 2));
		// The older run, run again by hand, would put its month back under the newer Series file.
		await expect(uploadTree(store, readTree(writeTree(TREE)), { run: RUN.run + 1 })).rejects.toThrow(`holds ${month} as written by run ${RUN.run + 2}, later than this run, ${RUN.run + 1}`);
	});

	test("takes objects that record no run, as written before runs were recorded, as no newer than any", async () => {
		for (const [key, bytes] of TREE) standin.put(BUCKET, key, bytes, "application/json");
		const report = await uploadTree(store, readTree(writeTree(TREE)), { run: 1 });
		expect(report.newestRunBefore).toBeNull();
		// Its run is recorded all the same, on the table of contents (rewritten in its phase here, as those objects carry no SHA-256).
		expect(report.reasons.get(STAMP_KEY)).toBe("no SHA-256 stored with the object");
		expect(report.stamped).toBe(false);
		expect(objects().get(STAMP_KEY)?.metadata).toEqual({ [RUN_METADATA]: "1" });
	});

	test("a run that publishes the tree the bucket already holds still records its run, so a retry of an earlier run, its tree older, is refused afterwards", async () => {
		const treeA = readTree(writeTree(TREE));
		const treeB = readTree(writeTree(nextRound().tree));
		// Run 100 writes tree A.
		await uploadTree(store, treeA, { run: 100 });
		// Run 102 publishes the same tree A: no file of it differs, so the one PUT is the table of contents again, unchanged, recording run 102.
		const before = puts().length;
		const published = await uploadTree(store, treeA, { run: 102 });
		expect(published.phases.flatMap((phase) => phase.written)).toEqual([]);
		expect(published.reasons.size).toBe(0);
		expect(published.stamped).toBe(true);
		expect(puts().slice(before)).toEqual([STAMP_KEY]);
		expect(STAMP_KEY).toBe("v1/index.json");
		expect(objects().get(STAMP_KEY)?.metadata).toEqual({ [RUN_METADATA]: "102" });
		expect(Buffer.from(objects().get(STAMP_KEY)?.bytes ?? []).equals(Buffer.from(treeA.find((file) => file.key === STAMP_KEY)?.bytes ?? []))).toBe(true);
		expect(await checkBucket(store, treeA, { run: 102 })).toEqual([]);
		// A retry of run 101, whose tree B is older than what run 102 published, writes nothing.
		const writes = puts().length;
		const refused = await uploadTree(store, treeB, { run: 101 }).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(OlderTree);
		expect(refused).toMatchObject({ run: 101, newest: 102, key: STAMP_KEY });
		expect(puts().length).toBe(writes);
		expect(await checkBucket(store, treeA, { run: 102 })).toEqual([]);
	});

	test("the same run again, after it published nothing new, goes ahead and writes nothing at all", async () => {
		const treeA = readTree(writeTree(TREE));
		await uploadTree(store, treeA, { run: 100 });
		await uploadTree(store, treeA, { run: 102 });
		const before = puts().length;
		const again = await uploadTree(store, treeA, { run: 102 });
		expect(again.newestRunBefore).toBe(102);
		expect(again.stamped).toBe(false);
		expect(puts().length).toBe(before);
		expect(objects().get(STAMP_KEY)?.writes).toBe(2);
		expect(await checkBucket(store, treeA, { run: 102 })).toEqual([]);
	});

	test("the first upload to an empty bucket writes each file once, the table of contents in its own phase, with no stamp after", async () => {
		const files = readTree(writeTree(TREE));
		const report = await uploadTree(store, files, { run: 100 });
		expect(report.stamped).toBe(false);
		expect(report.newestRunBefore).toBeNull();
		expect(puts().length).toBe(files.length);
		expect(puts().filter((key) => key === STAMP_KEY)).toEqual([STAMP_KEY]);
		for (const object of objects().values()) expect(object.writes).toBe(1);
		expect(await checkBucket(store, files, { run: 100 })).toEqual([]);
	});

	test("a stamp that fails fails the upload, saying the tree is in the bucket and its run is not recorded", async () => {
		const files = readTree(writeTree(TREE));
		await uploadTree(store, files, { run: 100 });
		standin.fault = (request) => (request.method === "PUT" && request.key === STAMP_KEY ? new Response("<Error><Code>InternalError</Code></Error>", { status: 500 }) : undefined);
		const stopped = await uploadTree(store, files, { run: 102 }).catch((error: unknown) => error);
		expect(stopped).toBeInstanceOf(NotStamped);
		expect(String(stopped)).toContain(`every file of the tree is in s3://${BUCKET}, but recording run 102 on ${STAMP_KEY} failed: PUT s3://${BUCKET}/${STAMP_KEY} answered 500, InternalError`);
		// The check, given the run, says so too.
		standin.fault = undefined;
		expect(await checkBucket(store, files, { run: 102 })).toEqual([`s3://${BUCKET}/${STAMP_KEY}: records run 100, not this run, 102, which uploaded the tree`]);
	});

	test("refuses, before it asks the bucket anything, a tree with no table of contents to record its run on", async () => {
		const files = readTree(writeTree(TREE)).filter((file) => file.key !== STAMP_KEY);
		await expect(uploadTree(store, files, RUN)).rejects.toThrow(`the tree has no ${STAMP_KEY}, on which every upload records its run`);
		expect(standin.requests).toEqual([]);
	});

	test("a preflight checks the bucket and says what would be written, and writes nothing", async () => {
		await uploadTree(store, readTree(writeTree(TREE)), RUN);
		const { tree, month, series } = nextRound();
		const writes = puts().length;
		const report = await uploadTree(store, readTree(writeTree(tree)), { run: RUN.run + 1, preflight: true });
		expect(puts().length).toBe(writes);
		expect(report.phases.flatMap((phase) => phase.wouldWrite)).toEqual([month, series]);
		expect(report.phases.flatMap((phase) => phase.written)).toEqual([]);
		// The table of contents did not change, so the upload would write it again to record its run; the preflight does not.
		expect(report.stamped).toBe(true);
		expect(objects().get(STAMP_KEY)?.metadata).toEqual({ [RUN_METADATA]: String(RUN.run) });
		await expect(uploadTree(store, readTree(writeTree(tree)), { run: RUN.run - 1, preflight: true })).rejects.toBeInstanceOf(OlderTree);
		standin.put(BUCKET, "stray.json", "{}", "application/json");
		await expect(uploadTree(store, readTree(writeTree(tree)), { run: RUN.run + 1, preflight: true })).rejects.toBeInstanceOf(UnexpectedKeys);
	});

	test("a run id is a positive whole number", () => {
		expect(parseRun("44844744565")).toBe(44_844_744_565);
		for (const bad of [null, undefined, "", "0", "-1", "1.5", "1e3", " 1", "12a", "9".repeat(20)]) expect(parseRun(bad)).toBeNull();
	});
});

describe("the check of the bucket, against a stand-in for S3", () => {
	let standin: S3Standin;
	let store: S3ApiStore;
	const objects = () => standin.buckets.get(BUCKET)?.objects ?? new Map();

	beforeEach(() => {
		standin = new S3Standin();
		standin.start();
		standin.bucket(BUCKET, { writers: [KEY_ID] });
		store = new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: KEY_ID, secretAccessKey: SECRET }) });
	});
	afterEach(() => standin.stop());

	test("finds nothing to say about a bucket the upload just filled", async () => {
		const files = readTree(writeTree(TREE));
		await uploadTree(store, files, RUN);
		expect(await checkBucket(store, files)).toEqual([]);
	});

	test("finds a file missing, a key the tree does not have, other bytes, another SHA-256 and other headers", async () => {
		const files = readTree(writeTree(TREE));
		await uploadTree(store, files, RUN);
		const [missing, resized, rehashed, recached, retyped] = files.map((file) => file.key);
		objects().delete(missing as string);
		standin.put(BUCKET, "v1/series/ffffffffffff.json", "{}", "application/json");
		const r = objects().get(resized as string);
		if (r !== undefined) r.bytes = new Uint8Array([...r.bytes, 32]);
		const h = objects().get(rehashed as string);
		if (h !== undefined) h.checksumSha256 = checksumHeader("0".repeat(64));
		const c = objects().get(recached as string);
		if (c !== undefined) c.cacheControl = "no-store";
		const t = objects().get(retyped as string);
		if (t !== undefined) t.contentType = "binary/octet-stream";
		const problems = await checkBucket(store, files);
		expect(problems).toContainEqual(`s3://${BUCKET}/${missing}: in the tree, not in the bucket`);
		expect(problems).toContainEqual(`s3://${BUCKET}/v1/series/ffffffffffff.json: in the bucket, not in the tree (the upload deletes nothing: a person decides whether it goes)`);
		expect(problems.some((problem) => problem.startsWith(`s3://${BUCKET}/${resized}:`) && problem.includes("bytes"))).toBe(true);
		expect(problems).toContainEqual(expect.stringContaining(`s3://${BUCKET}/${rehashed}: SHA-256 ${"0".repeat(64)}`));
		expect(problems).toContainEqual(`s3://${BUCKET}/${recached}: Cache-Control "no-store", not "public, max-age=300"`);
		expect(problems).toContainEqual(`s3://${BUCKET}/${retyped}: Content-Type "binary/octet-stream", not "application/json"`);
	});

	test("given the run that uploaded, finds a table of contents that records another run, and an object that records a later one", async () => {
		const files = readTree(writeTree(TREE));
		await uploadTree(store, files, { run: 100 });
		expect(await checkBucket(store, files, { run: 100 })).toEqual([]);
		// Without the run, the check compares bytes and headers only.
		expect(await checkBucket(store, files)).toEqual([]);
		expect(await checkBucket(store, files, { run: 102 })).toEqual([`s3://${BUCKET}/${STAMP_KEY}: records run 100, not this run, 102, which uploaded the tree`]);
		const month = files.find((file) => file.kind === "a month file")?.key as string;
		const object = objects().get(month);
		if (object === undefined) throw new Error("not uploaded");
		object.metadata = { [RUN_METADATA]: "103" };
		expect(await checkBucket(store, files, { run: 100 })).toEqual([`s3://${BUCKET}/${month}: records run 103, later than this run, 100`]);
	});

	test("lists the whole of v1/, page by page", async () => {
		const files = readTree(writeTree(TREE));
		standin.pageSize = 2;
		await uploadTree(store, files, RUN);
		expect((await store.list("v1/")).sort()).toEqual(files.map((file) => file.key));
		expect(await checkBucket(store, files)).toEqual([]);
	});
});

describe("the scripts", () => {
	let standin: S3Standin;
	beforeEach(() => {
		standin = new S3Standin();
		standin.start();
		standin.bucket(BUCKET, { writers: [KEY_ID] });
		standin.secrets.set(KEY_ID, SECRET);
	});
	afterEach(() => standin.stop());

	/** Runs a script as its own process, asynchronously, with the run id, as the publish job passes it to both: the stand-in answers from this one. */
	const run = async (script: string, tree: string, summary: string, extra: string[] = [], runId = RUN.run): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
		const child = Bun.spawn(["bun", join(ROOT, "scripts", script), "--tree", tree, "--bucket", BUCKET, "--endpoint", standin.url, "--run", String(runId), ...extra], {
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AWS_ACCESS_KEY_ID: KEY_ID, AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: "token", GITHUB_STEP_SUMMARY: summary },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { exitCode, stdout, stderr };
	};

	test("preflight, upload, then check, as the publish job runs them: each passes and says what it did in the step summary; the preflight writes nothing; a second upload writes nothing", async () => {
		const tree = writeTree(TREE);
		const summary = join(fresh("summary"), "summary.md");
		mkdirSync(dirname(summary), { recursive: true });
		writeFileSync(summary, "");
		const preflight = await run("upload-api.ts", tree, summary, ["--preflight"]);
		expect(preflight.stderr).toBe("");
		expect(preflight.exitCode).toBe(0);
		expect(preflight.stdout).toContain(`holds nothing the tree lacks, and no object of it says which run wrote it (this is run ${RUN.run}): ${TREE.size} of ${TREE.size} files to write, nothing written`);
		expect(standin.requests.filter((request) => request.method === "PUT")).toEqual([]);
		const uploaded = await run("upload-api.ts", tree, summary);
		expect(uploaded.stderr).toBe("");
		expect(uploaded.exitCode).toBe(0);
		expect(uploaded.stdout).toContain(`${TREE.size} files, ${TREE.size} written (${TREE.size} new) by run ${RUN.run}, nothing deleted`);
		const checked = await run("check-api-bucket.ts", tree, summary);
		expect(checked.stderr).toBe("");
		expect(checked.exitCode).toBe(0);
		expect(checked.stdout).toContain(`and v1/index.json records run ${RUN.run}, the latest any object records`);
		const again = await run("upload-api.ts", tree, summary);
		expect(again.stdout).toContain(`${TREE.size} files, 0 written by run ${RUN.run}, nothing deleted`);
		const text = readFileSync(summary, "utf8");
		expect(text).toContain("### The API bucket, checked before the upload");
		expect(text).toContain("### The data API's files to the API bucket");
		expect(text).toContain("### The API bucket against the tree");
		expect(text).toContain(`holds the data API's tree exactly: ${TREE.size} files, all under v1/ and nothing else`);
	});

	test("a later run that publishes the same tree says it wrote the table of contents again only to record its run, and its check holds it to that", async () => {
		const tree = writeTree(TREE);
		const summary = join(fresh("summary"), "summary.md");
		mkdirSync(dirname(summary), { recursive: true });
		writeFileSync(summary, "");
		expect((await run("upload-api.ts", tree, summary)).exitCode).toBe(0);
		const later = RUN.run + 2;
		const preflight = await run("upload-api.ts", tree, summary, ["--preflight"], later);
		expect(preflight.stdout).toContain(`0 of ${TREE.size} files to write, then v1/index.json again, unchanged, to record this run, nothing written`);
		// Before the later run uploads, its check finds the table of contents recording the earlier run.
		const early = await run("check-api-bucket.ts", tree, summary, [], later);
		expect(early.exitCode).toBe(1);
		expect(early.stderr).toContain(`v1/index.json: records run ${RUN.run}, not this run, ${later}, which uploaded the tree`);
		const uploaded = await run("upload-api.ts", tree, summary, [], later);
		expect(uploaded.exitCode).toBe(0);
		expect(uploaded.stdout).toContain(`${TREE.size} files, 0 written by run ${later}, and v1/index.json written again, unchanged, to record this run, nothing deleted`);
		expect((await run("check-api-bucket.ts", tree, summary, [], later)).exitCode).toBe(0);
		// The earlier run, run again, is refused.
		const retry = await run("upload-api.ts", tree, summary, [], RUN.run + 1);
		expect(retry.exitCode).toBe(1);
		expect(retry.stderr).toContain(`holds v1/index.json as written by run ${later}, later than this run, ${RUN.run + 1}`);
	});

	test("the check fails, naming the problem, when the bucket holds more than the tree, outside v1/ too", async () => {
		const tree = writeTree(TREE);
		const summary = join(fresh("summary"), "summary.md");
		mkdirSync(dirname(summary), { recursive: true });
		writeFileSync(summary, "");
		expect((await run("upload-api.ts", tree, summary)).exitCode).toBe(0);
		standin.put(BUCKET, "v1/series/ffffffffffff.json", "{}", "application/json");
		standin.put(BUCKET, "stray/notes.txt", "x", "text/plain");
		const checked = await run("check-api-bucket.ts", tree, summary);
		expect(checked.exitCode).toBe(1);
		expect(checked.stderr).toContain("v1/series/ffffffffffff.json: in the bucket, not in the tree");
		expect(checked.stderr).toContain("stray/notes.txt: in the bucket, not in the tree");
		expect(readFileSync(summary, "utf8")).toContain("does not hold the data API's tree exactly: 2 problems");
	});

	test("an unexpected key fails the upload step, writing nothing, and the summary lists each key and where the README says what to do", async () => {
		const tree = writeTree(TREE);
		const summary = join(fresh("summary"), "summary.md");
		mkdirSync(dirname(summary), { recursive: true });
		writeFileSync(summary, "");
		standin.put(BUCKET, "v1/prices/2026-01-01.json", "{}", "application/json");
		standin.put(BUCKET, "elsewhere/x.json", "{}", "application/json");
		const uploaded = await run("upload-api.ts", tree, summary);
		expect(uploaded.exitCode).toBe(1);
		expect(uploaded.stderr).toContain("holds 2 keys the tree does not have, so nothing was uploaded");
		expect(standin.requests.filter((request) => request.method === "PUT")).toEqual([]);
		const text = readFileSync(summary, "utf8");
		expect(text).toContain("**Not uploaded:");
		expect(text).toContain("- `elsewhere/x.json`");
		expect(text).toContain("- `v1/prices/2026-01-01.json`");
		expect(text).toContain('"The API bucket", "A key the tree does not have"');
	});

	test("a failed write fails the upload step, and the summary names the phase and the key, and says the next run repairs it", async () => {
		const tree = writeTree(TREE);
		const summary = join(fresh("summary"), "summary.md");
		mkdirSync(dirname(summary), { recursive: true });
		writeFileSync(summary, "");
		const list = "v1/series.json";
		standin.fault = (request) => (request.method === "PUT" && request.key === list ? new Response("<Error><Code>InternalError</Code></Error>", { status: 500 }) : undefined);
		const uploaded = await run("upload-api.ts", tree, summary);
		expect(uploaded.exitCode).toBe(1);
		expect(uploaded.stderr).toContain("stopped in phase 4 of 5, the list of Series: 1 write failed, the first v1/series.json");
		const text = readFileSync(summary, "utf8");
		expect(text).toContain("**The upload stopped in phase 4 of 5, the list of Series.** No later phase was started.");
		expect(text).toContain("- `v1/series.json`: PUT");
		expect(text).toContain("The next run's upload writes what is still missing and repairs it.");
		expect(standin.requests.some((request) => request.method === "PUT" && request.key === "v1/index.json")).toBe(false);
	});

	test("unexpectedKeys names what the bucket holds beyond the tree, in key order", () => {
		const files = readTree(writeTree(TREE));
		expect(unexpectedKeys([...files.map((file) => file.key), "z", "a/b"], files)).toEqual(["a/b", "z"]);
		expect(unexpectedKeys(files.map((file) => file.key), files)).toEqual([]);
	});

	test("each refuses to run without a tree and a bucket, and the upload without a run id", () => {
		for (const script of ["upload-api.ts", "check-api-bucket.ts"]) {
			const done = Bun.spawnSync(["bun", join(ROOT, "scripts", script), "--tree", "x"]);
			expect(done.exitCode).toBe(2);
			expect(done.stderr.toString()).toContain("usage:");
		}
		for (const runId of [[], ["--run", "0"], ["--run", "abc"], ["--run=-5"]]) {
			const done = Bun.spawnSync(["bun", join(ROOT, "scripts", "upload-api.ts"), "--tree", "x", "--bucket", BUCKET, ...runId]);
			expect(done.exitCode).toBe(2);
			expect(done.stderr.toString()).toContain("--run ID");
		}
		// The check takes no run, or a run id; never something else.
		for (const runId of [["--run", "0"], ["--run", "abc"], ["--run=-5"]]) {
			const done = Bun.spawnSync(["bun", join(ROOT, "scripts", "check-api-bucket.ts"), "--tree", "x", "--bucket", BUCKET, ...runId]);
			expect(done.exitCode).toBe(2);
			expect(done.stderr.toString()).toContain("[--run ID]");
		}
	});

	test("an older run's tree, uploaded after a newer run's, fails the step, writes nothing, and the summary says why", async () => {
		const tree = writeTree(TREE);
		const summary = join(fresh("summary"), "summary.md");
		mkdirSync(dirname(summary), { recursive: true });
		writeFileSync(summary, "");
		// A newer run, 44844744566, published first.
		const newer = new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: KEY_ID, secretAccessKey: SECRET }) });
		await uploadTree(newer, readTree(tree), { run: RUN.run + 1 });
		const writes = standin.requests.filter((request) => request.method === "PUT").length;
		const older = await run("upload-api.ts", tree, summary);
		expect(older.exitCode).toBe(1);
		expect(older.stderr).toContain(`as written by run ${RUN.run + 1}, later than this run, ${RUN.run}: this tree is older than what is published, so nothing was uploaded`);
		expect(standin.requests.filter((request) => request.method === "PUT").length).toBe(writes);
		expect(readFileSync(summary, "utf8")).toContain("**Not uploaded:");
	});

	test("a copy of the tree elsewhere uploads the same keys: a key is the file's path under the tree", () => {
		const tree = writeTree(TREE);
		const copy = fresh("copy");
		cpSync(tree, copy, { recursive: true });
		expect(readTree(copy).map((file) => file.key)).toEqual(readTree(tree).map((file) => file.key));
	});
});

/**
 * What the README states a run of the publish job asks S3 ("The API bucket",
 * "What it costs"): each of its three steps lists the whole bucket and sends
 * one HEAD per file of the tree. Held here, without AWS, so the passes cannot
 * quietly grow: a fourth pass, a second HEAD per file, or a listing per file
 * would change these counts.
 */
const HEADS_PER_FILE = 3;
const LISTINGS_PER_RUN = 3;

describe("the requests a run of the publish job makes, as the README states them", () => {
	let standin: S3Standin;
	beforeEach(() => {
		standin = new S3Standin();
		standin.start();
		standin.bucket(BUCKET, { writers: [KEY_ID] });
		standin.secrets.set(KEY_ID, SECRET);
	});
	afterEach(() => standin.stop());

	/** A tree of the build's kinds, its contents beside the point: the schemas, `series` Series files with a month file each, the list and the table of contents. */
	function treeOf(series: number, round = 1): Map<string, Uint8Array> {
		const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
		const tree = new Map<string, Uint8Array>();
		for (const { name } of API_SCHEMAS) tree.set(`v1/schemas/${name}.schema.json`, json({ name }));
		for (let i = 0; i < series; i++) {
			const id = i.toString(16).padStart(12, "0");
			tree.set(`v1/series/${id}.json`, json({ id, round: i === 0 ? round : 1 }));
			tree.set(`v1/series/${id}/2026-11.json`, json({ id, month: "2026-11", round: i === 0 ? round : 1 }));
		}
		tree.set("v1/series.json", json({ series, round }));
		tree.set("v1/index.json", json({ series, round }));
		return tree;
	}

	/** The publish job's own commands, from the workflow, each with this tree, bucket and run, and the stand-in's endpoint. */
	const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "runs.yml"), "utf8")) as { jobs: { publish: { steps: Array<{ run?: string }> } } };
	const commands = workflow.jobs.publish.steps.flatMap((step) => (step.run?.trim().startsWith("bun scripts/") ? [step.run.trim()] : []));
	const argv = (command: string, tree: string, run: number): string[] => {
		const words = command.split(/\s+/).map((word) => word.replace(/^"(.*)"$/, "$1"));
		return [
			...words.map((word, i) => (word === "$API_BUCKET" ? BUCKET : word === "$GITHUB_RUN_ID" ? String(run) : words[i - 1] === "--tree" ? tree : word.startsWith("scripts/") ? join(ROOT, word) : word)),
			"--endpoint",
			standin.url,
		];
	};

	/** One run of the publish job: its commands in order, each to succeed. The requests it made, by kind. */
	async function publishJob(tree: string, run: number): Promise<{ heads: number; listings: number; puts: number; other: number }> {
		const from = standin.requests.length;
		for (const command of commands) {
			const child = Bun.spawn(argv(command, tree, run), {
				env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AWS_ACCESS_KEY_ID: KEY_ID, AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: "token" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
			expect({ command, exitCode, stderr }).toEqual({ command, exitCode: 0, stderr: "" });
		}
		const made = standin.requests.slice(from);
		const heads = made.filter((request) => request.method === "HEAD").length;
		const listings = made.filter((request) => request.method === "GET" && request.key === "").length;
		const puts = made.filter((request) => request.method === "PUT").length;
		return { heads, listings, puts, other: made.length - heads - listings - puts };
	}

	test("the job runs three passes over the bucket: the preflight, the upload and the check", () => {
		expect(commands.map((command) => command.split(" ")[1])).toEqual(["scripts/upload-api.ts", "scripts/upload-api.ts", "scripts/check-api-bucket.ts"]);
	});

	test(`${HEADS_PER_FILE} HEADs per file of the tree and ${LISTINGS_PER_RUN} listings of the whole bucket a run, at any size: linear in the files, at most 8 requests at once`, async () => {
		const pages = (keys: number): number => Math.max(1, Math.ceil(keys / standin.pageSize));
		for (const series of [7, 30]) {
			const files = treeOf(series).size;
			const run = 44_852_356_733 + series * 10;
			// The first publish, to an empty bucket: every file new; the preflight and the upload list an empty bucket, the check a full one.
			expect(await publishJob(writeTree(treeOf(series)), run)).toEqual({ heads: HEADS_PER_FILE * files, listings: 2 * pages(0) + pages(files), puts: files, other: 0 });
			// A round that changed one Series: its file and month file, the list and the table of contents written.
			expect(await publishJob(writeTree(treeOf(series, 2)), run + 1)).toEqual({ heads: HEADS_PER_FILE * files, listings: LISTINGS_PER_RUN * pages(files), puts: 4, other: 0 });
			// A round that changed nothing: only the stamp. Slowed, to see the requests overlap, and never more than eight at once.
			standin.latencyMs = 20;
			standin.peakInFlight = 0;
			expect(await publishJob(writeTree(treeOf(series, 2)), run + 2)).toEqual({ heads: HEADS_PER_FILE * files, listings: LISTINGS_PER_RUN * pages(files), puts: 1, other: 0 });
			expect(standin.peakInFlight).toBeGreaterThan(1);
			expect(standin.peakInFlight).toBeLessThanOrEqual(8);
			standin.latencyMs = 0;
			standin.buckets.get(BUCKET)?.objects.clear();
		}
	});

	test("the README states the same counts", () => {
		const readme = readFileSync(join(ROOT, "README.md"), "utf8").replace(/\s+/g, " ");
		expect(readme).toContain(`${HEADS_PER_FILE} \`HEAD\`s per file of the tree and ${LISTINGS_PER_RUN} listings of the whole bucket`);
	});
});
