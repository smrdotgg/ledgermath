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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { checkAnswer } from "../scripts/lib/answer-check";
import { LAYOUT, monthPath, seriesPath } from "../scripts/lib/api";
import { CEILINGS } from "../scripts/lib/api-check";
import { requestStatCitation, resolveCitation, seriesMoment, statAt } from "../scripts/lib/citation";
import {
	ATTEMPTS,
	DEFAULT_LOCATION,
	KNOWN_LAYOUTS,
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
import { type ApiFixture, type LongFixture, makeApiFixture, makeLongFixture } from "./api-fixtures";
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

/** A copy of the fixture's location, with some files replaced by other bytes: a directory holding two builds, or a file too large. */
function copyWith(changes: Record<string, Uint8Array | string>): string {
	const copy = mkdtempSync(join(tmpdir(), "lookup-tree-copy-"));
	made.push(copy);
	for (const path of filesUnder(fixture.runs)) {
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
			`${DEFAULT_LOCATION}/${memoryMonth()} does not have the sha256 Series ${fixture.memory}'s file lists for it`,
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

	test("a table of contents of a layout this tool does not know: said plainly, and nothing more is read", async () => {
		expect(KNOWN_LAYOUTS).toContain(LAYOUT);
		const asked: string[] = [];
		const unknown = new TextDecoder().decode(bytesOf(INDEX)).replace(`"layout": ${LAYOUT},`, `"layout": ${LAYOUT + 1},`);
		await expectLedgerError(web(asked, new Map([[INDEX, new Response(unknown)]])), `written in layout ${LAYOUT + 1}, which this tool does not know: it reads layout ${KNOWN_LAYOUTS.join(" or ")}. Nothing more was read.`, "git pull");
		expect(asked).toEqual([INDEX]);
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
	/** The artifact api as the workflow keeps it: the tree's files, v1/, and nothing else. */
	function artifact(): string {
		const api = mkdtempSync(join(tmpdir(), "lookup-tree-api-"));
		made.push(api);
		for (const [path, bytes] of tree) {
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
		expect(result.stdout).toContain(`${runFiles.length} Run files and 1 boot summaries`);
		expect(filesUnder(out)).toEqual([...filesUnder(join(fixture.runs, "boots")).map((p) => `boots/${p}`), ...runFiles.map((p) => `runs/${p}`), ...[...tree.keys()]].sort());
		const data = await loadLedger(openLocation(out));
		expect(normalized(await showSeries(data, [fixture.http], "all")).replaceAll(out, "LOCATION")).toBe(normalized(await showSeries(directory, [fixture.http], "all")));
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
