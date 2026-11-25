/**
 * No total of the Runs may stop a publish (ADR-0030, rule 13). The check
 * refuses a tree with a file over its kind's ceiling, and the Runs repository
 * is never edited, so a tree of the same Runs would be refused at every later
 * run: the build must keep every file under its ceiling whatever the Runs
 * hold. Three inputs of valid Runs that put a benchmark's list or the table
 * of contents over its ceiling as first built (found by the verification of
 * the change), each built here, checked, and found publishable with the right
 * counts: 18 Series of one benchmark with a param of 14,500 characters each;
 * 1,100 Series of one benchmark; 501 benchmarks of names of 64 characters.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { BENCHMARKS_LISTED_BYTES, benchmarkPath, buildApi, DEFAULT_BASE, LIST_BYTES, listedBytes, readApiSchemas, ROW_BYTES, seriesPath } from "../scripts/lib/api";
import { CEILINGS, checkApi } from "../scripts/lib/api-check";
import { makeManyFixture } from "./api-fixtures";

// Deriving a thousand Runs and checking the tree they make takes a while on a loaded machine.
setDefaultTimeout(300_000);

type Json = Record<string, any>;

/** The tree the build makes of a fixture's Runs, written out; what the check says of it; and the same build again, byte for byte. */
async function publish(entries: ReadonlyArray<{ benchmark: string; params: Record<string, string | number | boolean> }>) {
	const fixture = await makeManyFixture(entries);
	const sources = { base: DEFAULT_BASE, docs: "https://example.test/docs", series: fixture.series, requests: fixture.requests, prices: [], boots: new Map(), bootFiles: [], schemas: readApiSchemas() };
	const tree = buildApi(sources);
	const again = buildApi(sources);
	for (const [path, bytes] of tree) expect([path, Buffer.from(again.get(path) as Uint8Array).equals(Buffer.from(bytes))]).toEqual([path, true]);
	const directory = mkdtempSync(join(tmpdir(), "api-bounds-tree-"));
	for (const [path, bytes] of tree) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), bytes);
	}
	const problems = checkApi({ tree: directory, runs: fixture.runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems;
	const json = (path: string): Json => JSON.parse(new TextDecoder().decode(tree.get(path)));
	// Every file under its kind's ceiling.
	for (const [path, bytes] of tree) {
		const ceiling = CEILINGS.find((one) => one.path.test(path));
		expect([path, bytes.length <= (ceiling?.bytes ?? 0)]).toEqual([path, true]);
	}
	return { tree, problems, json };
}

describe("no total of the Runs can stop a publish", () => {
	test("18 Series of one benchmark, each with a param of 14,500 characters: its list holds as many as fit, in its order, and counts the rest, each still in the list of every Series and in its own file", async () => {
		const { tree, problems, json } = await publish(Array.from({ length: 18 }, (_, i) => ({ benchmark: "memory_read", params: { n: i, p: "x".repeat(14_500) } })));
		expect(problems).toEqual([]);
		const list = json(benchmarkPath("memory_read"));
		const all = json("v1/series.json").series as Json[];
		const rows = all.filter((row) => row.benchmark === "memory_read");
		expect(rows.length).toBe(18);
		// Each row is under ROW_BYTES; together they are not under LIST_BYTES: the list is a prefix of them, as many as fit.
		for (const row of rows) expect(listedBytes(row) - 6).toBeLessThanOrEqual(ROW_BYTES);
		let fit = 0;
		let used = 0;
		for (const row of rows) {
			if (used + listedBytes(row) > LIST_BYTES) break;
			used += listedBytes(row);
			fit++;
		}
		expect(fit).toBeLessThan(18);
		expect([list.count, list.left_out]).toEqual([fit, 18 - fit]);
		expect(list.series).toEqual(rows.slice(0, fit));
		expect((tree.get(benchmarkPath("memory_read")) as Uint8Array).length).toBeLessThanOrEqual(256_000);
		const index = json("v1/index.json");
		expect([index.benchmarks.left_out, index.benchmarks.list]).toEqual([18 - fit, [{ name: "memory_read", url: `${DEFAULT_BASE}/${benchmarkPath("memory_read")}`, series: fit, runs: fit, newest_run_started_at: "2026-11-01T01:02:03.000000000Z" }]]);
		// A Series left out of the list is in the list of every Series and has its own file.
		for (const row of rows.slice(fit)) {
			expect(all.some((one) => one.id === row.id)).toBe(true);
			expect(tree.has(seriesPath(row.id))).toBe(true);
		}
	});

	test("1,100 Series of one benchmark: its list holds as many as fit and counts the rest; the list of every Series holds them all", async () => {
		const { problems, json } = await publish(Array.from({ length: 1_100 }, (_, i) => ({ benchmark: "memory_read", params: { n: i } })));
		expect(problems).toEqual([]);
		const list = json(benchmarkPath("memory_read"));
		expect(list.count + list.left_out).toBe(1_100);
		expect(list.left_out).toBeGreaterThan(0);
		expect((list.series as Json[]).reduce((total, row) => total + listedBytes(row), 0)).toBeLessThanOrEqual(LIST_BYTES);
		expect(json("v1/series.json").count).toBe(1_100);
		expect(json("v1/index.json").benchmarks.left_out).toBe(list.left_out);
	});

	test("501 benchmarks of names of 64 characters: every one has its list, reached by its name at the template's address; the table of contents names as many as fit, and counts the rest", async () => {
		const names = Array.from({ length: 501 }, (_, i) => `n${String(i).padStart(63, "0")}`);
		const { tree, problems, json } = await publish(names.map((name) => ({ benchmark: name, params: {} })));
		// The check finds every list reached by following links from the table of contents, those it does not name included.
		expect(problems).toEqual([]);
		const index = json("v1/index.json");
		expect((tree.get("v1/index.json") as Uint8Array).length).toBeLessThanOrEqual(100_000);
		expect(index.benchmarks.count).toBe(501);
		const listed = index.benchmarks.list as Json[];
		expect(listed.length + index.benchmarks.unlisted).toBe(501);
		expect(index.benchmarks.unlisted).toBeGreaterThan(0);
		expect(listed.map((entry) => entry.name)).toEqual(names.slice(0, listed.length));
		expect(listed.reduce((total, entry) => total + listedBytes(entry), 0)).toBeLessThanOrEqual(BENCHMARKS_LISTED_BYTES);
		expect(index.benchmarks.left_out).toBe(0);
		// Each row of the list of every Series names its benchmark, whose list is at the template's address.
		const rows = json("v1/series.json").series as Json[];
		expect(new Set(rows.map((row) => row.benchmark))).toEqual(new Set(names));
		for (const name of names) {
			expect(tree.has(benchmarkPath(name))).toBe(true);
			expect(index.benchmarks.benchmark_file_url_template.replace("{benchmark}", name)).toBe(`${DEFAULT_BASE}/${benchmarkPath(name)}`);
		}
	});
});
