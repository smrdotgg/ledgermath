// scripts/fetch-tree.ts against a stand-in for the API that serves the fixture tree, no
// network. Run with `bun test` inside site/.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTree } from "../src/data/tree";
import { fetchTree, INDEX_URL } from "./fetch-tree";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "tree");
const BASE = "https://api.ledgermath.com/";
const PATHS = ["v1/index.json", "v1/series.json", "v1/prices/2026-11-19.json"];
type Files = Map<string, Uint8Array<ArrayBuffer> | string>;
const served = (): Files => new Map(PATHS.map((path) => [BASE + path, new Uint8Array(readFileSync(join(FIXTURE, path)))]));

const work = mkdtempSync(join(tmpdir(), "site-fetch-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(work, `tree-${++n}`);

/** A stand-in fetch serving FILES (address -> bytes), recording each address asked for. */
function api(files: Files = served(), asked: string[] = []) {
	return async (url: string, init: RequestInit) => {
		asked.push(url);
		expect(init.redirect).toBe("manual");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		const body = files.get(url);
		if (body === undefined) return new Response("Not found", { status: 404 });
		return new Response(body, { headers: { "content-type": "application/json" } });
	};
}

/** The fixture's table of contents, changed by CHANGE. */
function index(change: (json: Record<string, any>) => void): string {
	const json = JSON.parse(readFileSync(join(FIXTURE, "v1", "index.json"), "utf8"));
	change(json);
	return JSON.stringify(json);
}

describe("fetchTree writes", () => {
	test("the three files the site reads, at their places, byte for byte, asking only for the addresses the table of contents gives", async () => {
		const asked: string[] = [];
		const dir = fresh();
		const tree = await fetchTree(dir, { get: api(served(), asked) });
		expect(asked).toEqual([INDEX_URL, `${BASE}v1/series.json`, `${BASE}v1/prices/2026-11-19.json`]);
		for (const path of PATHS) expect(readFileSync(join(dir, path)).equals(readFileSync(join(FIXTURE, path)))).toBe(true);
		expect(tree.files.map((f) => f.path)).toEqual(PATHS);
		expect(tree.newestRunStartedAt).toBe("2026-11-19T17:07:23.182448102Z");
		expect(tree.hasRecentRounds).toBe(true);
		expect(readTree(dir).seriesList.series.length).toBe(187);
	});

	test("into an empty directory that exists", async () => {
		const dir = fresh();
		mkdirSync(dir);
		await fetchTree(dir, { get: api() });
		expect(existsSync(join(dir, "v1", "index.json"))).toBe(true);
	});

	test("the price file the table of contents calls newest, wherever it says it is", async () => {
		const files = served();
		files.set(INDEX_URL, index((json) => (json.prices.newest.url = `${BASE}v1/prices/elsewhere.json`)));
		files.set(`${BASE}v1/prices/elsewhere.json`, new Uint8Array(readFileSync(join(FIXTURE, "v1", "prices", "2026-11-19.json"))));
		const dir = fresh();
		await fetchTree(dir, { get: api(files) });
		expect(existsSync(join(dir, "v1", "prices", "elsewhere.json"))).toBe(true);
	});
});

describe("fetchTree refuses, and writes nothing", () => {
	async function refused(options: Parameters<typeof fetchTree>[1], message: string | RegExp, dir = fresh()) {
		await expect(fetchTree(dir, options)).rejects.toThrow(message);
		expect(existsSync(dir)).toBe(false);
	}

	test("an answer that is not 200", async () => {
		const files = served();
		files.delete(`${BASE}v1/series.json`);
		await refused({ get: api(files) }, `${BASE}v1/series.json answered 404, not 200`);
	});

	test("a redirect, which it does not follow", async () => {
		await refused({ get: async () => new Response("", { status: 301, headers: { location: "https://elsewhere.example/" } }) }, "answered 301 (Location: https://elsewhere.example/), not 200");
	});

	test("a file that is not JSON", async () => {
		const files = served();
		files.set(`${BASE}v1/series.json`, "<html>an error page</html>");
		await refused({ get: api(files) }, `${BASE}v1/series.json is not JSON`);
	});

	test("a table of contents that does not say it is version 1's", async () => {
		const files = served();
		files.set(INDEX_URL, index((json) => (json.schema = "ledgermath.api.index/2")));
		await refused({ get: api(files) }, 'schema is "ledgermath.api.index/2", not "ledgermath.api.index/1"');
		files.set(INDEX_URL, index((json) => delete json.schema));
		await refused({ get: api(files) }, "schema is undefined");
	});

	test("a Series list or price file that does not say what it is", async () => {
		const files = served();
		files.set(`${BASE}v1/series.json`, JSON.stringify({ ...JSON.parse(readFileSync(join(FIXTURE, "v1", "series.json"), "utf8")), schema: "something else" }));
		await refused({ get: api(files) }, 'schema is "something else", not "ledgermath.api.series-list/1"');
		const prices = served();
		prices.set(`${BASE}v1/prices/2026-11-19.json`, "{}");
		await refused({ get: api(prices) }, 'schema is undefined, not "ledgermath.prices/1"');
	});

	test("a link outside the table of contents' base, or a path that is not plain", async () => {
		const files = served();
		files.set(INDEX_URL, index((json) => (json.series.url = "https://elsewhere.example/v1/series.json")));
		await refused({ get: api(files) }, "which is not under the tree's base https://api.ledgermath.com/");
		files.set(INDEX_URL, index((json) => (json.prices.newest.url = `${BASE}v1/prices/../../etc/passwd.json`)));
		await refused({ get: api(files) }, "whose path is not a plain path to a JSON file under v1/");
	});

	test("a table of contents that gives another address as its own", async () => {
		const files = served();
		files.set(INDEX_URL, index((json) => (json.url = "https://mirror.example/v1/index.json")));
		await refused({ get: api(files) }, "gives its own address as https://mirror.example/v1/index.json");
	});

	test("a file over its size limit", async () => {
		await refused({ get: api(), limits: { index: 1_000_000, seriesList: 1_000, prices: 1_000_000 } }, `${BASE}v1/series.json is over the limit of 1000 bytes`);
	});

	test("an answer that does not come within the time limit", async () => {
		const never = (_: string, init: RequestInit) =>
			new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
		await refused({ get: never, timeoutMs: 50 }, "no answer within 50 ms");
	});

	test("a directory that already holds something", async () => {
		const dir = fresh();
		mkdirSync(dir);
		writeFileSync(join(dir, "old.json"), "{}");
		await expect(fetchTree(dir, { get: api() })).rejects.toThrow("exists and is not an empty directory");
		expect(existsSync(join(dir, "v1"))).toBe(false);
	});
});
