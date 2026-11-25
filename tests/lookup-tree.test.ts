/**
 * The lookup tool and the answer checker read the data API's tree
 * (scripts/lib/ledger-data.ts), built here by the generator from the fixture
 * the API's golden test uses (tests/api-fixtures.ts, `small`), so they are
 * tested against a tree the generator really writes: from a directory, and
 * from a web address through the injected fetch, which also counts the
 * requests each command makes and breaks the tree's contract on purpose. No
 * request reaches the network.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { checkAnswer } from "../scripts/lib/answer-check";
import { LAYOUT, monthPath, seriesPath } from "../scripts/lib/api";
import { CEILINGS } from "../scripts/lib/api-check";
import { requestStatCitation, resolveCitation, seriesMoment, statAt } from "../scripts/lib/citation";
import {
	ATTEMPTS,
	DEFAULT_LOCATION,
	type Fetch,
	type LedgerData,
	LedgerError,
	LIMITS,
	type LocationOptions,
	loadLedger,
	locationFrom,
	openLocation,
	RETRY_PAUSE_MS,
} from "../scripts/lib/ledger-data";
import { about, aboutText, findPrices, listSeries, pricesText, seriesListText, showSeries, showText, timeText } from "../scripts/lib/lookup";
import { type ApiFixture, EMPTY_BOOT, FIRST_BOOT, type LongFixture, makeApiFixture, makeLongFixture } from "./api-fixtures";
import { type Override, serve, stalled, writeTree } from "./tree-fixture";

setDefaultTimeout(120_000);

const ROOT = resolve(import.meta.dir, "..");
const GOLDEN = join(import.meta.dir, "api-golden");
const INDEX = "v1/index.json";
const LIST = "v1/series.json";

let fixture: ApiFixture;
let tree: Map<string, Uint8Array>;
let directory: LedgerData;
const made: string[] = [];

beforeAll(async () => {
	fixture = await makeApiFixture({ small: true });
	// The fixture copies one sample price file under two dates; the second is made the day's own, as a price file is
	// (fetched that day), so the tools' check of a price file holds. The tree lists price files by path, so its bytes do not change.
	const second = join(fixture.runs, "prices", "2026", "11", "12", "aws.json");
	writeFileSync(second, readFileSync(second, "utf8").replace('"fetched_at": "2026-11-11T', '"fetched_at": "2026-11-12T'));
	tree = writeTree(fixture.runs, fixture.series, fixture.requests);
	directory = await loadLedger(openLocation(fixture.runs));
});
afterAll(() => {
	for (const path of [fixture.runs, dirname(fixture.derivationsPath), ...made]) rmSync(path, { recursive: true, force: true });
});

/** The tree served at https://api.ledgermath.com through the injected fetch: each path asked for is pushed to `asked`, and each pause to `sleeps`. */
async function web(asked: string[] = [], overrides: ReadonlyMap<string, Override> = new Map(), options: LocationOptions & { sleeps?: number[] } = {}): Promise<LedgerData> {
	const recorded: string[] = [];
	const fetch = serve(fixture.runs, DEFAULT_LOCATION, recorded, overrides);
	const location = openLocation(DEFAULT_LOCATION, {
		...options,
		fetch: async (url, init) => {
			asked.push(url.slice(DEFAULT_LOCATION.length + 1));
			return fetch(url, init);
		},
		sleep: async (ms) => {
			options.sleeps?.push(ms);
		},
	});
	return loadLedger(location);
}

/** Every file under a directory, by its path from it with forward slashes. */
function filesUnder(root: string): string[] {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();
}

/** A copy of the fixture's location, with some files replaced by other bytes (a directory holding two builds, a file too large) or added, and those in `omit` left out. */
function copyWith(changes: Record<string, Uint8Array | string>, omit: readonly string[] = []): string {
	const copy = mkdtempSync(join(tmpdir(), "lookup-tree-copy-"));
	made.push(copy);
	for (const path of [...new Set([...filesUnder(fixture.runs), ...Object.keys(changes)])].filter((p) => !omit.includes(p))) {
		mkdirSync(dirname(join(copy, path)), { recursive: true });
		writeFileSync(join(copy, path), changes[path] ?? readFileSync(join(fixture.runs, path)));
	}
	return copy;
}

const bytesOf = (path: string): Uint8Array => tree.get(path) as Uint8Array;
/** Other bytes than the tree's: a space more before the final newline, which still parses. */
const stale = (path: string): Uint8Array => new TextEncoder().encode(`${new TextDecoder().decode(bytesOf(path)).trimEnd()} \n`);
const json = (value: unknown): string => JSON.stringify(value);

/** What an answer says once the location is named the same way: the directory's path and the web address both read LOCATION, and a link under the API's address its path. */
function normalized(value: unknown): string {
	return json(value).replaceAll(`${DEFAULT_LOCATION}/`, "").replaceAll(fixture.runs, "LOCATION").replaceAll(DEFAULT_LOCATION, "LOCATION");
}

async function expectLedgerError(promise: Promise<unknown>, ...parts: string[]): Promise<LedgerError> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(LedgerError);
	const error = caught as LedgerError;
	for (const part of parts) expect(error.message).toContain(part);
	return error;
}

describe("the fixture's tree", () => {
	test("is, byte for byte, the tree the API's golden test keeps", () => {
		const golden = filesUnder(GOLDEN);
		expect(golden.length).toBeGreaterThanOrEqual(4);
		for (const path of golden) expect(Buffer.from(bytesOf(path)).equals(readFileSync(join(GOLDEN, path))), path).toBe(true);
	});
});

describe("each command, from a directory and from a web address", () => {
	for (const kind of ["a directory", "a web address"] as const) {
		const open = (): Promise<LedgerData> => (kind === "a directory" ? Promise.resolve(directory) : web());

		test(`about, from ${kind}`, async () => {
			const a = await about(await open());
			// Method series v1 counts neither memory_read's crashed Run nor http_get's Run that exited 4 (Method requests v1 counts that one).
			expect([a.series, a.runs, a.counted_runs, a.failed_runs, a.request_series, a.layout]).toEqual([2, 8, 6, 2, 1, LAYOUT]);
			expect(a.price_files).toEqual(["prices/2026/11/11/aws.json", "prices/2026/11/12/aws.json"]);
			expect(a.price_file).toBe("prices/2026/11/12/aws.json");
			expect(a.runs_read).toBe(fixture.series.runs_read);
			expect(a.unreadable_runs).toBe(1);
			expect(aboutText(a)).toContain("Percentiles across requests (Method requests): 1 Series of requests");
		});

		test(`series, from ${kind}`, async () => {
			const data = await open();
			expect((await listSeries(data, [])).series.map((s) => s.id).sort()).toEqual([fixture.http, fixture.memory].sort());
			const http = await listSeries(data, ["http_get"]);
			expect(http.series.map((s) => [s.id, s.runs, s.counted, s.groups, s.requests])).toEqual([[fixture.http, 3, 2, 2, true]]);
			expect(seriesListText(http)).toContain(`${fixture.http}  c6i.8xlarge  use2-az3`);
			expect((await listSeries(data, ["memory_read"])).series.map((s) => [s.runs, s.counted, s.failed, s.groups, s.requests])).toEqual([[5, 4, 1, 2, false]]);
		});

		test(`show a plain Series, from ${kind}: the Series file's figures, each citation resolving to the number printed beside it`, async () => {
			const data = await open();
			const result = await showSeries(data, [fixture.memory], 10);
			if (result.found !== "one") throw new Error("expected one Series");
			const s = result.series;
			const derivation = fixture.series.derivations.find((d) => d.series.id === fixture.memory);
			expect(s.numbers.find((n) => n.number === "time_per_repetition_ns")?.p50.value).toBe(derivation?.percentiles.time_per_repetition_ns?.p50 as number);
			expect(s.group_details.map((g) => [g.id, g.numbers[0]?.count])).toEqual([
				["A", 3],
				["B", 1],
			]);
			expect(s.runs_list.map((run) => run.started_at.slice(0, 10))).toEqual(["2026-12-01", "2026-11-15", "2026-11-14", "2026-11-13", "2026-11-12"]);
			expect(s.runs_list[0]?.link).toBe(kind === "a directory" ? s.runs_list[0]?.path : `${DEFAULT_LOCATION}/${s.runs_list[0]?.path}`);
			expect(s.request_figures).toBeNull();
			for (const n of [...s.numbers, ...s.group_details.flatMap((g) => g.numbers)]) {
				for (const which of ["p5", "p50", "p95"] as const) {
					const resolved = await resolveCitation(n[which].citation.slice(4, -1), data);
					expect(resolved.ok && resolved.kind === "measured" ? resolved.value : null).toBe(n[which].value);
				}
			}
			expect(showText(result)).toContain(`Series ${fixture.memory}: memory_read on c6i.8xlarge`);
		});

		test(`show a Series of requests, from ${kind}: each phase's percentiles across requests, cited`, async () => {
			const data = await open();
			const result = await showSeries(data, [fixture.http], 10);
			if (result.found !== "one") throw new Error("expected one Series");
			const figures = result.series.request_figures;
			const derivation = fixture.requests.derivations.find((d) => d.series.id === fixture.http);
			expect(figures?.pool.runs.value).toBe(derivation?.pool.runs as number);
			const total = figures?.pool.phases.find((p) => p.phase === "total");
			expect(total?.percentiles.find((p) => p.name === "p50")?.value?.value).toBe(derivation?.pool.phases.total?.p50 as number);
			expect(figures?.groups.map((g) => g.id)).toEqual(["A", "B"]);
			for (const cited of [total?.min, total?.max, total?.percentiles.find((p) => p.name === "p90")?.value]) {
				const resolved = await resolveCitation((cited?.citation ?? "").slice(4, -1), data);
				expect(resolved.ok && resolved.kind === "requests" ? resolved.value : null).toBe(cited?.value as number);
			}
			expect(showText(result)).toContain("Percentiles across requests, Method requests version 1: 3 Runs (3 counted, 0 failed)");
		});

		test(`prices, from ${kind}: the newest price file, through the table of contents`, async () => {
			const data = await open();
			const result = await findPrices(data, ["c6i.8xlarge"]);
			expect(result.file).toBe("prices/2026/11/12/aws.json");
			expect(result.matches[0]?.citation).toBe("[lm:prices/2026/11/12/aws.json#NKB8DU47ZKKBXW65/NKB8DU47ZKKBXW65.JRTCKXETXF.6YS6EN2CT7]");
			expect(pricesText(result)).toContain("the price file of 2026-11-12");
		});
	}

	test("the two give the same answers, as JSON, but for where the files were read", async () => {
		const data = await web();
		for (const [name, ask] of [
			["about", (d: LedgerData) => about(d)],
			["series", (d: LedgerData) => listSeries(d, [])],
			["show plain", (d: LedgerData) => showSeries(d, [fixture.memory], "all")],
			["show requests", (d: LedgerData) => showSeries(d, [fixture.http], "all")],
			["prices", (d: LedgerData) => findPrices(d, ["transfer"])],
		] as const) {
			expect(normalized(await ask(data)), name).toBe(normalized(await ask(directory)));
		}
	});
});

describe("the script, from a directory, as text and as --json", () => {
	async function run(script: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		const child = Bun.spawn(["bun", join(ROOT, "scripts", script), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LEDGERMATH_DATA: "" } });
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { code, stdout, stderr };
	}

	test("about, series, show (a plain Series and a Series of requests) and prices print what the library answers", async () => {
		const cases: Array<[string[], () => Promise<{ json: unknown; text: string }>]> = [
			[["about"], async () => ({ json: await about(directory), text: aboutText(await about(directory)) })],
			[["series", "http_get"], async () => ({ json: await listSeries(directory, ["http_get"]), text: seriesListText(await listSeries(directory, ["http_get"])) })],
			[["show", fixture.memory], async () => ({ json: await showSeries(directory, [fixture.memory], 10), text: showText(await showSeries(directory, [fixture.memory], 10)) })],
			[["show", fixture.http], async () => ({ json: await showSeries(directory, [fixture.http], 10), text: showText(await showSeries(directory, [fixture.http], 10)) })],
			[["prices", "c6i.8xlarge"], async () => ({ json: await findPrices(directory, ["c6i.8xlarge"]), text: pricesText(await findPrices(directory, ["c6i.8xlarge"])) })],
		];
		for (const [args, expected] of cases) {
			const want = await expected();
			const text = await run("lookup.ts", "--data", fixture.runs, ...args);
			expect([text.code, text.stderr], args.join(" ")).toEqual([0, ""]);
			expect(text.stdout).toBe(want.text);
			const asJson = await run("lookup.ts", "--data", fixture.runs, "--json", ...args);
			expect(JSON.parse(asJson.stdout)).toEqual(JSON.parse(JSON.stringify(want.json)));
		}
	});

	test("a directory that is not the data API's says so, in words, and exits 2", async () => {
		const result = await run("lookup.ts", "--data", join(fixture.runs, "runs"), "about");
		expect(result.code).toBe(2);
		expect(result.stderr).toContain(`No LedgerMath data at ${join(fixture.runs, "runs")}: there is no v1/index.json there.`);
		expect(result.stderr).not.toContain("    at ");
	});
});

describe("each command reads only the files it needs", () => {
	const series = (id: string): string => seriesPath(id);

	test("about and series: the table of contents and the list", async () => {
		for (const ask of [(d: LedgerData) => about(d), (d: LedgerData) => listSeries(d, ["http_get"]), (d: LedgerData) => listSeries(d, [])]) {
			const asked: string[] = [];
			await ask(await web(asked));
			expect(asked).toEqual([INDEX, LIST]);
		}
	});

	test("show: those and the Series' file, when its newest points hold the Runs to list", async () => {
		for (const [id, runs] of [
			[fixture.memory, 10],
			[fixture.http, "all"],
		] as const) {
			const asked: string[] = [];
			await showSeries(await web(asked), [id], runs);
			expect(asked).toEqual([INDEX, LIST, series(id)]);
		}
	});

	test("prices: the table of contents and the one price file", async () => {
		const asked: string[] = [];
		await findPrices(await web(asked), ["gp3"]);
		expect(asked).toEqual([INDEX, "v1/prices/2026-11-12.json"]);
	});

	test("the checker: a Series file for a citation as of its newest Run, the month files up to an earlier one, and each Run file linked", async () => {
		const memory = fixture.series.derivations.find((d) => d.series.id === fixture.memory);
		if (memory === undefined) throw new Error("no memory Series");
		const now = seriesMoment(memory);
		const p50 = timeText(memory.percentiles.time_per_repetition_ns?.p50 as number);
		const newest = memory.points.at(-1)?.path as string;
		const asked: string[] = [];
		const data = await web(asked);
		const report = await checkAnswer(`p50: ${p50} [lm:series/${fixture.memory}/time_per_repetition_ns/p50@v1,${now}]\n${newest}`, data);
		expect(report.problems).toEqual([]);
		expect(report.pass).toBe(true);
		expect(asked).toEqual([INDEX, LIST, series(fixture.memory), newest]);

		// As of 2026-11-13: November's month file, and not December's.
		const earlier = [...asked];
		const resolved = await resolveCitation(`series/${fixture.memory}/time_per_repetition_ns/p50@v1,2026-11-13T04:12:00Z`, data);
		expect(resolved.ok && resolved.kind === "measured" && resolved.asOf).toBe("earlier");
		expect(asked.slice(earlier.length)).toEqual([monthPath(fixture.memory, "2026-11")]);
	});

	describe("with more Runs than a Series file holds", () => {
		let long: LongFixture;
		beforeAll(async () => {
			// 140 Runs of each Series, four a day from 2026-11-01: 120 in November, 20 in December.
			long = await makeLongFixture(140);
			made.push(long.runs);
			writeTree(long.runs, long.series, long.requests);
		});
		const open = (asked: string[]): Promise<LedgerData> =>
			loadLedger(
				openLocation(DEFAULT_LOCATION, {
					fetch: serve(long.runs, DEFAULT_LOCATION, asked),
				}),
			);

		test("show reads the newest month files only as far back as the Runs it lists", async () => {
			for (const [runs, months] of [
				[10, []],
				[15, ["2026-12"]],
				[30, ["2026-12", "2026-11"]],
				["all", ["2026-12", "2026-11"]],
			] as const) {
				const asked: string[] = [];
				const result = await showSeries(await open(asked), [long.syscall], runs);
				if (result.found !== "one") throw new Error("expected one Series");
				expect(result.series.runs_shown).toBe(runs === "all" ? 140 : runs);
				expect(asked.map((url) => url.slice(DEFAULT_LOCATION.length + 1))).toEqual([INDEX, LIST, seriesPath(long.syscall), ...months.map((m) => monthPath(long.syscall, m))]);
			}
		});
	});
});

describe("the contract the tree gives a reader", () => {
	const memoryMonth = (): string => monthPath(fixture.memory, "2026-11");
	/** A citation of memory_read as of 2026-11-13: it needs November's month file. */
	const earlier = (): string => `series/${fixture.memory}/time_per_repetition_ns/p50@v1,2026-11-13T04:12:00Z`;

	test("a month file whose bytes are not the sha256 its Series file lists is read again, the Series file first, and a second read that matches is used", async () => {
		const asked: string[] = [];
		const sleeps: number[] = [];
		const overrides = new Map<string, Override>([[memoryMonth(), (attempt) => new Response(attempt === 1 ? stale(memoryMonth()) : bytesOf(memoryMonth()))]]);
		const data = await web(asked, overrides, { sleeps });
		const resolved = await resolveCitation(earlier(), data);
		const points = fixture.series.derivations.find((d) => d.series.id === fixture.memory)?.points ?? [];
		expect(resolved.ok && resolved.kind === "measured" ? resolved.value : null).toBe(statAt(points, "time_per_repetition_ns", "p50", null, "2026-11-13T04:12:00Z")?.value as number);
		expect(asked).toEqual([INDEX, LIST, seriesPath(fixture.memory), memoryMonth(), seriesPath(fixture.memory), memoryMonth()]);
		expect(sleeps).toEqual([RETRY_PAUSE_MS]);
	});

	test("a Series file that lists an older month file is read again, and the second read that matches is used", async () => {
		const asked: string[] = [];
		const listed = new TextDecoder().decode(bytesOf(seriesPath(fixture.memory)));
		const entry = /"month":"2026-11"[^}]*"sha256":"([0-9a-f]{64})"/.exec(listed)?.[1] as string;
		const older = new TextEncoder().encode(listed.replace(entry, "0".repeat(64)));
		const overrides = new Map<string, Override>([[seriesPath(fixture.memory), (attempt) => new Response(attempt === 1 ? older : bytesOf(seriesPath(fixture.memory)))]]);
		const resolved = await resolveCitation(earlier(), await web(asked, overrides));
		expect(resolved.ok).toBe(true);
		expect(asked).toEqual([INDEX, LIST, seriesPath(fixture.memory), memoryMonth(), seriesPath(fixture.memory), memoryMonth()]);
	});

	test(`a mismatch that stays: read ${ATTEMPTS} times, neither file is used, and the agent is told in words to try again in a few minutes`, async () => {
		const asked: string[] = [];
		const sleeps: number[] = [];
		const data = await web(asked, new Map([[memoryMonth(), () => new Response(stale(memoryMonth()))]]), { sleeps });
		const error = await expectLedgerError(
			resolveCitation(earlier(), data),
			`${DEFAULT_LOCATION}/${memoryMonth()} does not have the sha256 and size Series ${fixture.memory}'s file lists for it`,
			"Neither file was used",
			"Try again in a few minutes.",
		);
		expect(error.message).not.toContain("    at ");
		expect(asked.filter((path) => path === seriesPath(fixture.memory)).length).toBe(ATTEMPTS);
		expect(asked.filter((path) => path === memoryMonth()).length).toBe(ATTEMPTS);
		expect(sleeps).toEqual(Array.from({ length: ATTEMPTS - 1 }, () => RETRY_PAUSE_MS));
		// The checker passes it on: no number is checked against either file.
		await expectLedgerError(checkAnswer(`p50: 7.5 ms [lm:${earlier()}]`, data), "Try again in a few minutes.");
	});

	test("in a directory, a mismatch says the directory holds two builds, and neither file is used", async () => {
		const data = await loadLedger(openLocation(copyWith({ [memoryMonth()]: stale(memoryMonth()) })));
		await expectLedgerError(resolveCitation(earlier(), data), "holds files of two different builds", "Neither file was used", "Put the directory together again from one build");
	});

	test("a month file that is missing (404, or 403 as S3 answers behind the API) is the same: read again, then try again in a few minutes", async () => {
		for (const status of [404, 403]) {
			const asked: string[] = [];
			const data = await web(asked, new Map([[memoryMonth(), new Response("", { status })]]));
			await expectLedgerError(resolveCitation(earlier(), data), `${DEFAULT_LOCATION}/${memoryMonth()} is not there, although Series ${fixture.memory}'s file lists it`, "Try again in a few minutes.");
			expect(asked.filter((path) => path === memoryMonth()).length).toBe(ATTEMPTS);
		}
	});

	test("a table of contents of another layout is read as any other: a layout changes how files are written, not what they mean; about says which", async () => {
		const asked: string[] = [];
		const other = new TextDecoder().decode(bytesOf(INDEX)).replace(`"layout": ${LAYOUT},`, `"layout": ${LAYOUT + 1},`);
		const data = await web(asked, new Map([[INDEX, new Response(other)]]));
		const a = await about(data);
		expect(a.layout).toBe(LAYOUT + 1);
		expect(aboutText(a)).toContain(`(the data API, version 1, layout ${LAYOUT + 1})`);
		const shown = await showSeries(data, [fixture.memory], 10);
		expect(shown.found).toBe("one");
		expect(asked).toEqual([INDEX, LIST, seriesPath(fixture.memory)]);
	});

	test("about says when the newest round of boots started and what it held, in one line, from the table of contents, and the summaries in no round; from a tree without the rounds, nothing of them", async () => {
		const a = await about(directory);
		const index = JSON.parse(new TextDecoder().decode(bytesOf(INDEX)));
		// The fixture's newest round: a boot that left no Run, its one build having failed. Its unknown.json is in no round: the API does not serve it.
		expect(a.newest_round).toEqual({ started_at: "2026-11-13T04:41:00.000000000Z", boots: 1, runs: 0, failed_runs: 0, runs_in_no_series: 0, build_failures: 1, not_run: 0, instance_types: ["c8a.2xlarge"] });
		expect(index.recent_rounds.rounds[0].started_at).toBe(a.newest_round?.started_at);
		const left = index.recent_rounds.left_out.summaries[0];
		expect(a.boot_summaries_left_out).toEqual({ count: 1, newest: left });
		expect(aboutText(a).split("\n").filter((line) => /\bround\b/.test(line))).toEqual([
			"Newest round of boots: started 2026-11-13T04:41:00Z, 1 boot (c8a.2xlarge), 0 Runs, 0 failed, 1 build failed.",
			`Boot summaries in no round: 1, the newest boots/2026/11/14/unknown.json: ${left.why}.`,
		]);
		// What did not run or count is named only when there is some; and with no summary left out, nothing of them.
		Object.assign(index.recent_rounds.rounds[0], { boots: 2, instance_types: ["c6i.8xlarge", null], runs: 2, failed_runs: 1, runs_in_no_series: 3, build_failures: 0, not_run: 2 });
		index.recent_rounds.left_out = { count: 0, summaries: [] };
		const busier = await about(await web([], new Map([[INDEX, new Response(JSON.stringify(index))]])));
		expect(aboutText(busier)).toContain("Newest round of boots: started 2026-11-13T04:41:00Z, 2 boots (c6i.8xlarge, (no instance type)), 2 Runs, 1 failed, 3 in no Series, 2 not run.\n");
		expect(busier.boot_summaries_left_out).toBeUndefined();
		expect(aboutText(busier)).not.toContain("in no round");
		// A tree built before the rounds were: about says nothing of them.
		delete index.recent_rounds;
		const older = await about(await web([], new Map([[INDEX, new Response(JSON.stringify(index))]])));
		expect([older.newest_round, older.boot_summaries_left_out]).toEqual([undefined, undefined]);
		expect(Object.keys(JSON.parse(JSON.stringify(older))).filter((key) => key.includes("round"))).toEqual([]);
		expect(aboutText(older)).not.toMatch(/\bround\b/);
		expect(aboutText(older)).toBe(aboutText(await about(await web())).replace(/^Newest round of boots: .*\n/m, "").replace(/^Boot summaries in no round: .*\n/m, ""));
	});

	test("a file larger than its limit is not read: by its Content-Length, by its body, and in a directory", async () => {
		const big = new Uint8Array(LIMITS.list + 1).fill(32);
		await expectLedgerError(
			web([], new Map([[LIST, new Response(big, { headers: { "content-length": String(big.length) } })]])).then((data) => data.list()),
			`${DEFAULT_LOCATION}/${LIST} is larger than ${LIMITS.list} bytes`,
		);
		// No Content-Length: the body is read until it passes the limit, and no further.
		let sent = 0;
		const endless = () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						sent += 65_536;
						controller.enqueue(new Uint8Array(65_536).fill(32));
					},
				}),
			);
		await expectLedgerError(web([], new Map([[LIST, endless]])).then((data) => data.list()), `is larger than ${LIMITS.list} bytes`);
		expect(sent).toBeLessThan(LIMITS.list + 4 * 65_536);
		const padded = `${new TextDecoder().decode(bytesOf(INDEX)).trimEnd()}${" ".repeat(LIMITS.index)}\n`;
		await expectLedgerError(loadLedger(openLocation(copyWith({ [INDEX]: padded }))), `is larger than ${LIMITS.index} bytes`);
	});

	test("a request that never answers, or whose body never ends, is given up after the time limit, in words", async () => {
		await expectLedgerError(web([], new Map([[LIST, stalled]]), { timeoutMs: 50 }).then((data) => data.list()), `${DEFAULT_LOCATION}/${LIST} did not answer within 50 ms`, "Try again in a few minutes.");
		const neverEnds = () => new Response(new ReadableStream({ pull: () => new Promise<void>(() => undefined) }));
		await expectLedgerError(web([], new Map([[LIST, neverEnds]]), { timeoutMs: 50 }).then((data) => data.list()), "did not answer within 50 ms");
	});

	test("a server error is said plainly, and not retried", async () => {
		const asked: string[] = [];
		await expectLedgerError(web(asked, new Map([[LIST, new Response("", { status: 500 })]])).then((data) => data.list()), `${DEFAULT_LOCATION}/${LIST} answered HTTP 500`, "Try again in a few minutes.");
		expect(asked).toEqual([INDEX, LIST]);
	});

	test("an earlier citation of a group of requests takes the Derivation's group_through, recovered by the tree's rule", async () => {
		const derivation = fixture.requests.derivations.find((d) => d.series.id === fixture.http);
		const point = derivation?.points[1];
		if (derivation === undefined || point === undefined) throw new Error("no requests Series");
		const moment = `${point.started_at.slice(0, 19)}Z`;
		const resolved = await resolveCitation(requestStatCitation(fixture.http, "total", "count", 1, moment, { group: "A" }).slice(4, -1), directory);
		expect(resolved.ok && resolved.kind === "requests" ? [resolved.value, resolved.asOf] : null).toEqual([point.group_through?.phases.total?.count as number, "earlier"]);
	});
});

describe("a retry that comes back with an older round of a Series", () => {
	// Two rounds of one tree: 20 Runs of each Series, then 24 (the same first 20, byte for byte), four a day from 2026-11-01.
	let older: LongFixture;
	let fresh: LongFixture;
	beforeAll(async () => {
		older = await makeLongFixture(20);
		fresh = await makeLongFixture(24);
		made.push(older.runs, fresh.runs);
		writeTree(older.runs, older.series, older.requests);
		writeTree(fresh.runs, fresh.series, fresh.requests);
	});
	const MIRROR = "https://mirror.invalid";
	/** The fresh round, but each Series file read after the first is the older round's, and November's month files are always the older round's. */
	function mixed(): Promise<LedgerData> {
		const reads = new Map<string, number>();
		const fetch: Fetch = async (url) => {
			const path = url.slice(MIRROR.length + 1);
			const n = (reads.get(path) ?? 0) + 1;
			reads.set(path, n);
			const stale = path.endsWith("/2026-11.json") || (/^v1\/series\/[0-9a-f]{12}\.json$/.test(path) && n > 1);
			return new Response(new Uint8Array(readFileSync(join(stale ? older.runs : fresh.runs, path))));
		};
		return loadLedger(openLocation(MIRROR, { fetch, sleep: async () => undefined }));
	}

	test("the citation is held to the Series that came back, and refused when it ends before the cited moment", async () => {
		const points = fresh.series.derivations.find((d) => d.series.id === fresh.syscall)?.points ?? [];
		const moment = `${points[21]?.started_at.slice(0, 19)}Z`;
		const count = `[lm:series/${fresh.syscall}/time_per_repetition_ns/count@v1,${moment}]`;
		const link = points[19]?.path as string;
		// Against one round, it is 22 Runs.
		const consistent = await loadLedger(openLocation(fresh.runs));
		expect((await checkAnswer(`22 Runs ${count}\n${link}`, consistent)).pass).toBe(true);
		// Against the mixed reads, the older round's 20 is not let through as the figure of that moment.
		const report = await checkAnswer(`20 Runs ${count}\n${link}`, await mixed());
		expect(report.pass).toBe(false);
		expect(report.problems.map((p) => p.message).join("\n")).toContain(
			`it cites Series ${fresh.syscall} as of ${moment}, but the data loaded hold its Runs only to ${points[19]?.started_at.slice(0, 19)}Z: it is of data the checker does not have (its Series file was read again, after a month file did not match it)`,
		);
		// The same for a citation of requests.
		const requests = await resolveCitation(`requests/${fresh.http}/runs@v1,${`${(fresh.requests.derivations[0]?.points[21]?.started_at ?? "").slice(0, 19)}Z`}`, await mixed());
		expect(requests.ok ? "resolved" : requests.reason).toContain("it is of data the checker does not have (its Series file was read again");
	});
});

describe("nothing outside the location is read", () => {
	const MIRROR = "https://mirror.invalid/data";
	const listCopy = (): Uint8Array => bytesOf(LIST);

	test("a link whose path a resolver would take out of the location, encoded or dotted, is refused before any request", async () => {
		for (const way of ["v1/%2e%2e/%2e%2e/secret.json", "v1/..%2f..%2fsecret.json", "v1\\..\\..\\secret.json", "v1/series.json?x=../../secret.json"]) {
			const asked: string[] = [];
			// A server as fetch would reach it: the address normalised first.
			const fetch: Fetch = async (url) => {
				const pathname = new URL(url).pathname;
				asked.push(pathname);
				if (pathname === "/secret.json") return new Response(listCopy());
				if (pathname === "/data/v1/index.json") return new Response(new TextDecoder().decode(bytesOf(INDEX)).replace(`"url": "${DEFAULT_LOCATION}/${LIST}"`, `"url": "${DEFAULT_LOCATION}/${way.replaceAll("\\", "\\\\")}"`));
				return new Response("", { status: 404 });
			};
			const data = await loadLedger(openLocation(MIRROR, { fetch }));
			await expectLedgerError(data.list(), "LedgerMath's data never lead outside the location they are read from");
			expect(asked.filter((pathname) => !pathname.startsWith("/data/")), way).toEqual([]);
		}
	});

	test("a redirect is refused, whether the fetch is the tools' own or injected", async () => {
		// A stand-in for fetch: it follows a redirect unless told not to, as fetch does.
		const fetch: Fetch = async (url, init) => {
			const path = url.slice(MIRROR.length + 1);
			if (path === LIST) {
				if (init.redirect !== "manual") return new Response(listCopy());
				return new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/series.json" } });
			}
			return new Response(path === INDEX ? bytesOf(INDEX) : "", { status: path === INDEX ? 200 : 404 });
		};
		await expectLedgerError((await loadLedger(openLocation(MIRROR, { fetch }))).list(), `${MIRROR}/${LIST} answered with a redirect (HTTP 302 to https://elsewhere.invalid/series.json)`, "follow no redirect");
		// The tools' own fetch, against a server on this machine: the table of contents redirects to another path that holds it.
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (request) => (new URL(request.url).pathname === "/elsewhere.json" ? new Response(bytesOf(INDEX)) : Response.redirect("/elsewhere.json", 302)),
		});
		try {
			await expectLedgerError(loadLedger(openLocation(`http://127.0.0.1:${server.port}`)), "answered with a redirect (HTTP 302", "follow no redirect");
		} finally {
			server.stop(true);
		}
	});

	test("in a directory, a symbolic link out of it is refused; one inside it is followed", async () => {
		const away = mkdtempSync(join(tmpdir(), "lookup-tree-away-"));
		made.push(away);
		writeFileSync(join(away, "series.json"), listCopy());
		const out = copyWith({}, [LIST]);
		symlinkSync(join(away, "series.json"), join(out, LIST));
		await expectLedgerError((await loadLedger(openLocation(out))).list(), `${join(out, LIST)} leads outside the directory ${out}`);
		// A directory linked from outside: the evidence beside v1/.
		const linkedRuns = copyWith({}, filesUnder(fixture.runs).filter((p) => p.startsWith("runs/")));
		symlinkSync(join(fixture.runs, "runs"), join(linkedRuns, "runs"));
		const memory = fixture.series.derivations.find((d) => d.series.id === fixture.memory);
		await expectLedgerError((await loadLedger(openLocation(linkedRuns))).readLinked(`${DEFAULT_LOCATION}/${memory?.points[0]?.path}`, LIMITS.run, "a Run file"), "leads outside the directory");
		const within = copyWith({ "v1/series-real.json": listCopy() }, [LIST]);
		symlinkSync("series-real.json", join(within, LIST));
		expect((await (await loadLedger(openLocation(within))).list()).count).toBe(2);
	});
});

describe("a Run link is read whole, and at its point's evidence link", () => {
	const answerWith = (link: string): string => {
		const memory = fixture.series.derivations.find((d) => d.series.id === fixture.memory);
		const p50 = timeText(memory?.percentiles.time_per_repetition_ns?.p50 as number);
		return `p50: ${p50} [lm:series/${fixture.memory}/time_per_repetition_ns/p50@v1,${seriesMoment(memory as { points: Array<{ started_at: string }> })}]\nSources: ${link}`;
	};
	const run = (): string => fixture.series.derivations.find((d) => d.series.id === fixture.memory)?.points.at(-1)?.path as string;

	test("a link that goes on after .json is no Run's address; a sentence's punctuation and Markdown around it are", async () => {
		for (const link of [`${run()}.`, `(${run()})`, `**${run()}**`, `${run()},`, `${run()};`, `[the Run](${DEFAULT_LOCATION}/${run()}).`, `<${DEFAULT_LOCATION}/${run()}>`, `\`${run()}\``]) {
			const report = await checkAnswer(answerWith(link), directory);
			expect(report.problems, link).toEqual([]);
		}
		for (const [link, after] of [
			[`${DEFAULT_LOCATION}/${run()}.bak`, ".bak"],
			[`${run()}.bak`, ".bak"],
			[`${run()}/x`, "/x"],
			[`${run()}?raw=1`, "?raw=1"],
			[`${run()}_x`, "_x"],
		] as const) {
			const report = await checkAnswer(answerWith(link), directory);
			expect(report.problems.map((p) => p.message), link).toContain(`Run link: ${link} is not a Run file's address: it goes on after ${run()} (${after})`);
		}
		// The destination of a Markdown link or an autolink is the link a reader follows, to its last character: a period in it is part of it.
		// Written bare in prose, a sentence's period after it is not.
		for (const written of [`[source](${DEFAULT_LOCATION}/${run()}.)`, `<${DEFAULT_LOCATION}/${run()}.>`, `[source](${run()}.)`]) {
			const destination = written.slice(written.indexOf(written.startsWith("<") ? "<" : "(") + 1, -1);
			const report = await checkAnswer(answerWith(written), directory);
			expect(report.problems.map((p) => p.message), written).toContain(`Run link: ${destination} is not a Run file's address: it goes on after ${run()} (.)`);
		}
		for (const written of [`(see ${run()}.)`, `${DEFAULT_LOCATION}/${run()}.`]) expect((await checkAnswer(answerWith(written), directory)).problems, written).toEqual([]);
	});

	test("the evidence link show prints is a link to its Run whatever its path looks like, at a web address and in a directory", async () => {
		// A tree whose evidence is served at evidence/<yyyy>/<mm>/<dd>/<id>.json: no runs/ in the address.
		const renamed = (path: string): string => path.replace(/^runs\//, "evidence/");
		const moved = (text: string): string => text.replaceAll(`${DEFAULT_LOCATION}/runs/`, `${DEFAULT_LOCATION}/evidence/`);
		const MIRROR = "https://mirror.invalid";
		const fetch: Fetch = async (url) => {
			const path = url.slice(MIRROR.length + 1);
			if (path.startsWith("runs/")) return new Response("", { status: 404 });
			if (path === seriesPath(fixture.memory)) return new Response(moved(new TextDecoder().decode(bytesOf(path))));
			return new Response(new Uint8Array(readFileSync(join(fixture.runs, path.replace(/^evidence\//, "runs/")))));
		};
		const evidence = (data: LedgerData) => showSeries(data, [fixture.memory], 1).then((shown) => (shown.found === "one" ? shown.series.runs_list[0] : undefined));
		const web = await loadLedger(openLocation(MIRROR, { fetch }));
		const printed = await evidence(web);
		expect(printed?.link).toBe(`${MIRROR}/${renamed(run())}`);
		for (const link of [printed?.link as string, `${DEFAULT_LOCATION}/${renamed(run())}`, `[the Run](${printed?.link}).`, run()]) {
			expect((await checkAnswer(answerWith(link), web)).problems, link).toEqual([]);
		}
		// In a directory, show prints the path, and the checker reads it as that Run, with no number in it.
		const local = await loadLedger(openLocation(copyWith({ [seriesPath(fixture.memory)]: moved(new TextDecoder().decode(bytesOf(seriesPath(fixture.memory)))), [renamed(run())]: readFileSync(join(fixture.runs, run())) })));
		const there = await evidence(local);
		expect(there?.link).toBe(renamed(run()));
		const report = await checkAnswer(answerWith(there?.link as string), local);
		expect(report.problems).toEqual([]);
		expect(report.run_links.map((l) => [l.link, l.path])).toEqual([[renamed(run()), run()]]);
	});

	test("when the tree moves a Run's evidence, show prints where it is, and the checker reads it there", async () => {
		const MIRROR = "https://mirror.invalid";
		const moved = (text: string): string => text.replaceAll(`${DEFAULT_LOCATION}/runs/`, `${DEFAULT_LOCATION}/archive/runs/`);
		const fetch: Fetch = async (url) => {
			const path = url.slice(MIRROR.length + 1);
			if (path.startsWith("runs/")) return new Response("", { status: 404 });
			if (path === seriesPath(fixture.memory)) return new Response(moved(new TextDecoder().decode(bytesOf(path))));
			return new Response(new Uint8Array(readFileSync(join(fixture.runs, path.replace(/^archive\//, "")))));
		};
		const data = await loadLedger(openLocation(MIRROR, { fetch }));
		const shown = await showSeries(data, [fixture.memory], 1);
		if (shown.found !== "one") throw new Error("expected one Series");
		expect(shown.series.runs_list[0]?.link).toBe(`${MIRROR}/archive/${run()}`);
		expect(shown.series.runs_list[0]?.evidence).toBe(`${DEFAULT_LOCATION}/archive/${run()}`);
		for (const link of [run(), `${MIRROR}/archive/${run()}`, `${DEFAULT_LOCATION}/archive/${run()}`]) {
			expect((await checkAnswer(answerWith(link), data)).problems, link).toEqual([]);
		}
		expect((await checkAnswer(answerWith(`${MIRROR}/${run()}`), data)).problems.map((p) => p.message).join("\n")).toContain(`its address in the data API (${DEFAULT_LOCATION}/archive/${run()}, or ${MIRROR}/archive/${run()} where these data were read)`);
	});
});

describe("a month file held from an earlier read", () => {
	test("is checked against the Series file read again, and read again when the entry differs", async () => {
		const novemberPath = monthPath(fixture.memory, "2026-11");
		const decemberPath = monthPath(fixture.memory, "2026-12");
		let seriesReads = 0;
		let novemberReads = 0;
		let decemberReads = 0;
		const overrides = new Map<string, Override>([
			[
				seriesPath(fixture.memory),
				() => {
					seriesReads++;
					if (seriesReads === 1) return new Response(bytesOf(seriesPath(fixture.memory)));
					const file = JSON.parse(new TextDecoder().decode(bytesOf(seriesPath(fixture.memory)))) as { months: Array<{ bytes: number }> };
					(file.months[0] as { bytes: number }).bytes += 1;
					return new Response(JSON.stringify(file));
				},
			],
			[novemberPath, () => (novemberReads++, new Response(bytesOf(novemberPath)))],
			[decemberPath, () => (++decemberReads === 1 ? new Response("", { status: 404 }) : new Response(bytesOf(decemberPath)))],
		]);
		const data = await web([], overrides);
		const memory = fixture.series.derivations.find((d) => d.series.id === fixture.memory);
		const before = `${(memory?.points.at(-1)?.started_at ?? "").slice(0, 10)}T00:00:00Z`;
		await expectLedgerError(resolveCitation(`series/${fixture.memory}/time_per_repetition_ns/count@v1,${before}`, data), "Try again in a few minutes.");
		expect(novemberReads).toBe(ATTEMPTS);
	});
});

describe("an error answer settles within the time limit", () => {
	test("a 404 or a 500 whose body's cancellation never settles", async () => {
		const MIRROR = "https://mirror.invalid";
		for (const status of [404, 500]) {
			const fetch: Fetch = async () => new Response(new ReadableStream({ cancel: () => new Promise<void>(() => undefined) }), { status });
			const read = openLocation(MIRROR, { fetch, timeoutMs: 20 })
				.read(INDEX, LIMITS.index, "the table of contents")
				.then(
					(bytes) => (bytes === null ? "not there" : "read"),
					(error: unknown) => (error instanceof LedgerError ? "refused" : "failed"),
				);
			// Far past the limit: only a read that never settles loses this race.
			const settled = await Promise.race([read, Bun.sleep(3000).then(() => "still pending")]);
			expect(settled, String(status)).toBe(status === 404 ? "not there" : "refused");
		}
	});
});

describe("a failure entry of requests", () => {
	test("is cited only as the data list it: an entry they do not list is refused, with what they list", async () => {
		const derivation = fixture.requests.derivations.find((d) => d.series.id === fixture.http);
		const moment = `${(derivation?.points.at(-1)?.started_at ?? "").slice(0, 19)}Z`;
		const listed = derivation?.pool.failures[0];
		if (listed === undefined) throw new Error("the fixture's Series of requests lists no failure");
		const held = await resolveCitation(`requests/${fixture.http}/failed/${listed.phase}/${listed.kind}@v1,${moment}`, directory);
		expect(held.ok && held.kind === "requests" ? held.value : null).toBe(listed.count);
		const invented = await resolveCitation(`requests/${fixture.http}/failed/imaginary/typo@v1,${moment}`, directory);
		expect(invented.ok ? "resolved" : invented.reason).toBe(
			`Series ${fixture.http} lists no failed requests of phase imaginary and kind typo as of ${moment}; it lists ${derivation?.pool.failures.map((f) => `failed/${f.phase}/${f.kind}`).join(", ")}`,
		);
		const report = await checkAnswer(`0 requests [lm:requests/${fixture.http}/failed/imaginary/typo@v1,${moment}]\n${derivation?.points.at(-1)?.path}`, directory);
		expect(report.pass).toBe(false);
	});
});

describe("the limits", () => {
	test("are the tree's own ceilings, kind for kind", () => {
		const samples: Array<[keyof typeof LIMITS, string]> = [
			["index", INDEX],
			["list", LIST],
			["series", "v1/series/0123456789ab.json"],
			["month", "v1/series/0123456789ab/2026-11.json"],
			["prices", "v1/prices/2026-11-12.json"],
		];
		for (const [kind, path] of samples) expect(CEILINGS.find((ceiling) => ceiling.path.test(path))?.bytes, kind).toBe(LIMITS[kind]);
	});
});

describe("the location", () => {
	test("is --data, then LEDGERMATH_DATA, then https://api.ledgermath.com", () => {
		expect(DEFAULT_LOCATION).toBe("https://api.ledgermath.com");
		expect(locationFrom(undefined, undefined)).toEqual({ base: DEFAULT_LOCATION, isDefault: true });
		expect(locationFrom(undefined, "")).toEqual({ base: DEFAULT_LOCATION, isDefault: true });
		expect(locationFrom(undefined, "/data")).toEqual({ base: "/data", isDefault: false });
		expect(locationFrom("/given", "/data")).toEqual({ base: "/given", isDefault: false });
	});

	test("when the default cannot be read, the error says how to give another", async () => {
		const location = openLocation(DEFAULT_LOCATION, {
			fetch: async () => {
				throw new Error("getaddrinfo ENOTFOUND api.ledgermath.com");
			},
		});
		await expectLedgerError(loadLedger(location, { isDefault: true }), "could not be read (getaddrinfo ENOTFOUND api.ledgermath.com)", "No location was given", "pass it with --data");
	});
});

describe("scripts/assemble-location.ts, the trial's data", () => {
	async function assemble(api: string, runs: string, out: string): Promise<{ code: number; stdout: string; stderr: string }> {
		const child = Bun.spawn(["bun", join(ROOT, "scripts", "assemble-location.ts"), "--api", api, "--runs", runs, "--out", out], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { code, stdout, stderr };
	}
	/** The artifact api as the workflow keeps it: the tree's files, v1/, and nothing else (but those in `omit`). */
	function artifact(omit: readonly string[] = []): string {
		const api = mkdtempSync(join(tmpdir(), "lookup-tree-api-"));
		made.push(api);
		for (const [path, bytes] of tree) {
			if (omit.includes(path)) continue;
			mkdirSync(dirname(join(api, path)), { recursive: true });
			writeFileSync(join(api, path), bytes);
		}
		return api;
	}

	test("puts together, from the artifact and a clone of the Runs repository, a directory the tools read as they read the tree", async () => {
		const out = join(mkdtempSync(join(tmpdir(), "lookup-tree-out-")), "location");
		made.push(dirname(out));
		const result = await assemble(artifact(), fixture.runs, out);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		const runFiles = filesUnder(join(fixture.runs, "runs"));
		expect(result.stdout).toContain(`v1/ (${tree.size} files, layout ${LAYOUT}, 2 Series`);
		// Both boot summaries the tree links: the first day's, which points and a round link, and that of the boot that left no Run, which only a
		// round links. Not unknown.json, which the tree lists as left out with no address.
		expect(result.stdout).toContain(`${runFiles.length} Run files and 2 boot summaries`);
		const linkedBoots = filesUnder(join(fixture.runs, "boots"))
			.map((p) => `boots/${p}`)
			.filter((p) => !p.endsWith("unknown.json"));
		expect(filesUnder(out)).toEqual([...linkedBoots, ...runFiles.map((p) => `runs/${p}`), ...[...tree.keys()]].sort());
		expect(filesUnder(out)).toContain(`boots/2026/11/13/${EMPTY_BOOT}.json`);
		const data = await loadLedger(openLocation(out));
		expect(normalized(await showSeries(data, [fixture.http], "all")).replaceAll(out, "LOCATION")).toBe(normalized(await showSeries(directory, [fixture.http], "all")));
	});

	test("copies the summary of a boot that left no Run, which only the table of contents links, and stops when the clone lacks it; from an older table of contents, only what the points link", async () => {
		const empty = `boots/2026/11/13/${EMPTY_BOOT}.json`;
		const clone = mkdtempSync(join(tmpdir(), "lookup-tree-clone-"));
		made.push(clone);
		for (const path of filesUnder(fixture.runs).filter((p) => p !== empty && (p.startsWith("runs/") || p.startsWith("boots/")))) {
			mkdirSync(dirname(join(clone, path)), { recursive: true });
			writeFileSync(join(clone, path), readFileSync(join(fixture.runs, path)));
		}
		const lacking = await assemble(artifact(), clone, join(clone, "location"));
		expect(lacking.code).toBe(2);
		expect(lacking.stderr).toContain(`${empty}: not in ${clone}`);
		// A table of contents written before the rounds were: the summaries the points link, and no other.
		const older = artifact();
		const index = JSON.parse(readFileSync(join(older, INDEX), "utf8"));
		delete index.recent_rounds;
		writeFileSync(join(older, INDEX), `${JSON.stringify(index, null, 2)}\n`);
		const out = join(mkdtempSync(join(tmpdir(), "lookup-tree-out-")), "location");
		made.push(dirname(out));
		const result = await assemble(older, clone, out);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		expect(filesUnder(out).filter((p) => p.startsWith("boots/"))).toEqual([`boots/2026/11/12/${FIRST_BOOT}.json`]);
	});

	test("writes nothing when a file the table of contents lists is missing or is not what it says, and names it", async () => {
		const cases: Array<{ name: string; omit: string[]; replace?: [string, Uint8Array]; expected: string }> = [
			{ name: "a price file missing", omit: ["v1/prices/2026-11-11.json"], expected: "v1/prices/2026-11-11.json, the price file of 2026-11-11 the table of contents lists, is not there" },
			{ name: "a schema missing", omit: ["v1/schemas/prices.schema.json"], expected: "the schema prices, which the table of contents lists, is not in" },
			{
				name: "a price file that is not that day's",
				omit: [],
				replace: ["v1/prices/2026-11-12.json", bytesOf("v1/prices/2026-11-11.json")],
				expected: "v1/prices/2026-11-12.json is not a valid price file: prices/2026/11/12/aws.json is not under the UTC date it was fetched",
			},
		];
		for (const { name, omit, replace, expected } of cases) {
			const api = artifact(omit);
			if (replace !== undefined) writeFileSync(join(api, replace[0]), replace[1]);
			const out = join(api, "location");
			const result = await assemble(api, fixture.runs, out);
			expect(result.code, name).toBe(2);
			expect(result.stderr, name).toContain("Nothing was written.");
			expect(result.stderr, name).toContain(expected);
			expect(filesUnder(api).some((p) => p.startsWith("location/")), name).toBe(false);
		}
	});

	test("writes nothing when the clone lacks a Run file the tree links, and names it", async () => {
		const missing = fixture.series.derivations[0]?.runs[0]?.path as string;
		const clone = mkdtempSync(join(tmpdir(), "lookup-tree-clone-"));
		made.push(clone);
		for (const path of filesUnder(fixture.runs).filter((p) => p !== missing && (p.startsWith("runs/") || p.startsWith("boots/")))) {
			mkdirSync(dirname(join(clone, path)), { recursive: true });
			writeFileSync(join(clone, path), readFileSync(join(fixture.runs, path)));
		}
		const out = join(clone, "location");
		const result = await assemble(artifact(), clone, out);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain(`Nothing was written.`);
		expect(result.stderr).toContain(`${missing}: not in ${clone}`);
		expect(filesUnder(clone).some((p) => p.startsWith("location/"))).toBe(false);
	});
});

describe("skills/ledgermath/SKILL.md", () => {
	test("says which citations cannot be checked once more Runs arrive, as the checker refuses them", async () => {
		const skill = readFileSync(join(ROOT, "skills", "ledgermath", "SKILL.md"), "utf8").replace(/\s+/g, " ");
		expect(skill).toContain("so it can be checked after more Runs arrive. The one exception is a figure of the requests with one value of a fact (`…/by/address_block/…`): it is held only as of the Series' newest Run");
		// And the checker says the same of such a citation of an earlier moment.
		const http = fixture.requests.derivations.find((d) => d.series.id === fixture.http);
		const earlier = `${(http?.points[0]?.started_at ?? "").slice(0, 19)}Z`;
		const resolved = await resolveCitation(`requests/${fixture.http}/by/address_block/52.219.0.0/16/total/count@v1,${earlier}`, directory);
		expect(resolved.ok ? "resolved" : resolved.reason).toContain(`is held only as of Series ${fixture.http}'s newest Run`);
	});

	test("every command line it shows runs against the fixture's tree", async () => {
		const skill = readFileSync(join(ROOT, "skills", "ledgermath", "SKILL.md"), "utf8");
		const spans = [...skill.matchAll(/`([^`\n]+)`/g), ...skill.matchAll(/^ {4}(\S.*)$/gm)].map((m) => (m[1] as string).trim());
		const work = mkdtempSync(join(tmpdir(), "lookup-skill-"));
		made.push(work);
		const shown = await showSeries(directory, [fixture.memory], 10);
		if (shown.found !== "one") throw new Error("expected one Series");
		const p50 = shown.series.numbers[0]?.p50 as { text: string; citation: string };
		writeFileSync(join(work, "question.md"), "How long does one repetition of memory_read take?\n");
		writeFileSync(join(work, "answer.md"), `One repetition: ${p50.text} ${p50.citation}\nSources: ${shown.series.runs_list[0]?.path}\n`);
		const commands = spans
			.map((span) => span.replace(/\\\|/g, "|"))
			// A command line: the tool or the checker run whole, or a command with its arguments; not a word naming one ("as `show` prints it").
			.filter((span) => /^(bun scripts\/(lookup|check-answer)\.ts(\s|$)|about$|(series|show|prices)\s+\S)/.test(span) && !span.includes("WORD"))
			.map((span) =>
				span
					.replace(/\s*\[[^\]]*\]/g, "")
					.replaceAll("<location>", fixture.runs)
					.replaceAll("<id>", fixture.memory)
					.replaceAll("<question file>", join(work, "question.md"))
					.replaceAll("<answer file>", join(work, "answer.md")),
			)
			.map((span) => (span.startsWith("bun ") ? span : `bun scripts/lookup.ts ${span}`));
		const used = new Set(commands.map((command) => (command.includes("check-answer") ? "check-answer" : (command.split(" ").find((word) => ["about", "series", "show", "prices"].includes(word)) ?? ""))));
		expect([...used].sort()).toEqual(["about", "check-answer", "prices", "series", "show"]);
		expect(commands.some((command) => command.includes("--data"))).toBe(true);
		for (const command of commands) {
			expect(command, command).not.toMatch(/[<>]/);
			const [bun, script, ...args] = command.split(/\s+/);
			const child = Bun.spawn([bun as string, join(ROOT, script as string), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LEDGERMATH_DATA: fixture.runs } });
			const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			expect({ command, code, stderr }).toEqual({ command, code: 0, stderr: "" });
			if (command.includes("check-answer")) expect(stdout).toContain("PASS");
		}
	});
});
