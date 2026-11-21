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
import {
	checkBucket,
	checksumHeader,
	checksumHex,
	inParallel,
	readTree,
	S3ApiStore,
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
		const same = { size: 1, sha256: file.sha256, contentType: file.contentType, cacheControl: file.cacheControl };
		expect(writeReason(file, null)).toBe("new");
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
		const report = await uploadTree(store, files, { concurrency: 4 });
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
		await uploadTree(store, files);
		const before = puts().length;
		const report = await uploadTree(store, files);
		expect(puts().length).toBe(before);
		expect(report.reasons.size).toBe(0);
		expect(report.phases.map((phase) => phase.written.length)).toEqual([0, 0, 0, 0, 0]);
		for (const object of objects().values()) expect(object.writes).toBe(1);
	});

	test("writes only the files whose content changed, still in phase order", async () => {
		await uploadTree(store, readTree(writeTree(TREE)));
		const month = [...TREE.keys()].find((path) => treeObject(path).kind === "a month file") as string;
		const series = [...TREE.keys()].find((path) => treeObject(path).kind === "a Series file") as string;
		const changed = new Map(TREE);
		for (const path of [month, series, "v1/series.json", "v1/index.json"]) changed.set(path, new TextEncoder().encode(`${new TextDecoder().decode(TREE.get(path))} `));
		const already = puts().length;
		const report = await uploadTree(store, readTree(writeTree(changed)));
		const written = puts().slice(already);
		expect(written).toEqual([month, series, "v1/series.json", "v1/index.json"]);
		expect(new Set(report.reasons.values())).toEqual(new Set(["content changed"]));
		expect(objects().get(month)?.writes).toBe(2);
		const untouched = [...TREE.keys()].filter((path) => ![month, series, "v1/series.json", "v1/index.json"].includes(path));
		for (const path of untouched) expect(objects().get(path)?.writes).toBe(1);
	});

	test("rewrites a file whose headers, or stored SHA-256, are not what they should be, even with the same bytes", async () => {
		await uploadTree(store, readTree(writeTree(TREE)));
		const [first, second] = [...TREE.keys()];
		const object = objects().get(first as string);
		if (object === undefined) throw new Error("not uploaded");
		object.cacheControl = "public, max-age=31536000, immutable";
		standin.put(BUCKET, second as string, TREE.get(second as string) as Uint8Array, "application/json");
		const report = await uploadTree(store, readTree(writeTree(TREE)));
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
			const refused = await uploadTree(store, readTree(writeTree(TREE))).catch((error: unknown) => error);
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
		await uploadTree(store, readTree(writeTree(TREE)));
		const price = [...TREE.keys()].find((path) => treeObject(path).kind === "a price file") as string;
		const before = { index: objects().get("v1/index.json")?.bytes, list: objects().get("v1/series.json")?.bytes };
		// The next tree: the price file gone (a person took it out of the Runs repository), and the table of contents no longer listing it.
		const next = new Map(TREE);
		next.delete(price);
		next.set("v1/index.json", new TextEncoder().encode(`${new TextDecoder().decode(TREE.get("v1/index.json"))} `));
		const writes = puts().length;
		await expect(uploadTree(store, readTree(writeTree(next)))).rejects.toThrow(`${price}`);
		expect(puts().length).toBe(writes);
		expect(objects().get("v1/index.json")?.bytes).toEqual(before.index);
		expect(objects().get("v1/series.json")?.bytes).toEqual(before.list);
		// The bucket still equals the tree last published, so its check of that tree passes: nothing is half-published.
		expect(await checkBucket(store, readTree(writeTree(TREE)))).toEqual([]);
		// The person deletes the key by hand (README, "A key the tree does not have"); the next run uploads, and the bucket is the tree.
		objects().delete(price);
		await uploadTree(store, readTree(writeTree(next)));
		expect(await checkBucket(store, readTree(writeTree(next)))).toEqual([]);
	});

	test("stops at a failed write, naming the phase and the key: no later phase is started, so nothing readable links down to what is not there", async () => {
		const files = readTree(writeTree(TREE));
		const failing = files.find((file) => file.phase === 0) as TreeFile;
		standin.fault = (request) => (request.method === "PUT" && request.key === failing.key ? new Response("<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>", { status: 500 }) : undefined);
		const stopped = await uploadTree(store, files).catch((error: unknown) => error);
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
		await uploadTree(store, readTree(writeTree(TREE)));
		expect(monthsAgainstSeries()).toEqual([]);
		const { tree, month, series } = nextRound();
		standin.fault = (request) => (request.method === "PUT" && treeObject(request.key).kind === "a Series file" ? new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 }) : undefined);
		const stopped = await uploadTree(store, readTree(writeTree(tree))).catch((error: unknown) => error);
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
		await uploadTree(store, readTree(writeTree(TREE)));
		const { tree, month, series } = nextRound();
		standin.fault = (request) => (request.method === "PUT" && treeObject(request.key).kind === "a Series file" ? new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 }) : undefined);
		await uploadTree(store, readTree(writeTree(tree))).catch(() => undefined);
		standin.fault = undefined;
		const already = puts().length;
		const report = await uploadTree(store, readTree(writeTree(tree)));
		// The month was written by the failed run; only the Series file is still to write.
		expect(puts().slice(already)).toEqual([series]);
		expect(objects().get(month)?.writes).toBe(2);
		expect(report.reasons.get(series)).toBe("content changed");
		expect(monthsAgainstSeries()).toEqual([]);
		expect(await checkBucket(store, readTree(writeTree(tree)))).toEqual([]);
	});

	test("says a refused HEAD is a refusal, not a missing file", async () => {
		standin.fault = (request) => (request.method === "HEAD" ? new Response(null, { status: 403 }) : undefined);
		await expect(uploadTree(store, readTree(writeTree(TREE)))).rejects.toThrow("answered 403 (the role may not read it");
		expect(puts()).toEqual([]);
	});

	test("S3 refuses bytes that are not the ones hashed", async () => {
		const [file] = readTree(writeTree(TREE));
		if (file === undefined) throw new Error("no file");
		await expect(store.put({ ...file, sha256: "0".repeat(64) })).rejects.toThrow("answered 400");
		expect(objects().has(file.key)).toBe(false);
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
		await uploadTree(store, files);
		expect(await checkBucket(store, files)).toEqual([]);
	});

	test("finds a file missing, a key the tree does not have, other bytes, another SHA-256 and other headers", async () => {
		const files = readTree(writeTree(TREE));
		await uploadTree(store, files);
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

	test("lists the whole of v1/, page by page", async () => {
		const files = readTree(writeTree(TREE));
		standin.pageSize = 2;
		await uploadTree(store, files);
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

	/** Runs a script as its own process, asynchronously: the stand-in answers from this one. */
	const run = async (script: string, tree: string, summary: string): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
		const child = Bun.spawn(["bun", join(ROOT, "scripts", script), "--tree", tree, "--bucket", BUCKET, "--endpoint", standin.url], {
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AWS_ACCESS_KEY_ID: KEY_ID, AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: "token", GITHUB_STEP_SUMMARY: summary },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { exitCode, stdout, stderr };
	};

	test("upload, then check: both pass and say what they did in the step summary; a second upload writes nothing", async () => {
		const tree = writeTree(TREE);
		const summary = join(fresh("summary"), "summary.md");
		mkdirSync(dirname(summary), { recursive: true });
		writeFileSync(summary, "");
		const uploaded = await run("upload-api.ts", tree, summary);
		expect(uploaded.stderr).toBe("");
		expect(uploaded.exitCode).toBe(0);
		expect(uploaded.stdout).toContain(`${TREE.size} files, ${TREE.size} written (${TREE.size} new), nothing deleted`);
		const checked = await run("check-api-bucket.ts", tree, summary);
		expect(checked.stderr).toBe("");
		expect(checked.exitCode).toBe(0);
		const again = await run("upload-api.ts", tree, summary);
		expect(again.stdout).toContain(`${TREE.size} files, 0 written, nothing deleted`);
		const text = readFileSync(summary, "utf8");
		expect(text).toContain("### The data API's files to the API bucket");
		expect(text).toContain("### The API bucket against the tree");
		expect(text).toContain(`holds the data API's tree exactly: ${TREE.size} files, all under v1/ and nothing else`);
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

	test("each refuses to run without a tree and a bucket", () => {
		for (const script of ["upload-api.ts", "check-api-bucket.ts"]) {
			const done = Bun.spawnSync(["bun", join(ROOT, "scripts", script), "--tree", "x"]);
			expect(done.exitCode).toBe(2);
			expect(done.stderr.toString()).toContain("usage:");
		}
	});

	test("a copy of the tree elsewhere uploads the same keys: a key is the file's path under the tree", () => {
		const tree = writeTree(TREE);
		const copy = fresh("copy");
		cpSync(tree, copy, { recursive: true });
		expect(readTree(copy).map((file) => file.key)).toEqual(readTree(tree).map((file) => file.key));
	});
});
