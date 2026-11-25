import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	formatBytes,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	group,
	halve,
	HEADLINE_CHOICES,
	leadFigure,
	perUnit,
	plain,
	plannedBenchmarkDocsUrl,
	powerOfTen,
	roundPlaces,
	roundSignificant,
	shift,
	siteData,
	type SiteData,
} from ".";
import { compareMoments, readTree, type Tree } from "./tree";

const FIXTURE = join(import.meta.dir, "..", "..", "fixtures", "tree");
const tree = readTree(FIXTURE);
const data = siteData(tree);
const headlineSeries = data.headline.flatMap((row) => row.cells.flatMap((cell) => (cell.series ? [cell.series] : [])));

/** A copy of the fixture tree, changed by CHANGE, to read in memory. */
function variant(change: (tree: Tree) => void): Tree {
	const copy = structuredClone(tree);
	change(copy);
	return copy;
}

/** Writes the fixture tree's three files into a new directory, each as CHANGE returns it, and reads it back. */
function onDisk(change: (path: string, json: Record<string, unknown>) => unknown = (_, json) => json): string {
	const dir = mkdtempSync(join(tmpdir(), "site-tree-"));
	for (const path of Object.values(tree.paths)) {
		const json = JSON.parse(readFileSync(join(FIXTURE, path), "utf8")) as Record<string, unknown>;
		const changed = change(path, json);
		if (changed === undefined) continue;
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), typeof changed === "string" ? changed : JSON.stringify(changed));
	}
	return dir;
}

describe("the fixture tree", () => {
	test("is read from its three files, at the places the table of contents' links give", () => {
		expect(tree.base).toBe("https://api.ledgermath.com/");
		expect(tree.paths).toEqual({ index: "v1/index.json", seriesList: "v1/series.json", prices: "v1/prices/2026-11-19.json" });
	});

	test("every row of series.json reads back byte for byte, so String(n) is the figure as written", () => {
		const raw = readFileSync(join(FIXTURE, "v1", "series.json"), "utf8");
		for (const row of data.series) expect(raw.includes(JSON.stringify(row))).toBe(true);
	});

	test("counts", () => {
		expect(data.series.length).toBe(187);
		expect(data.series.reduce((sum, row) => sum + row.runs, 0)).toBe(6335);
		expect(data.series.reduce((sum, row) => sum + row.derivations.series_v1.failed_runs, 0)).toBe(0);
		expect(data.newestRunStartedAt).toBe("2026-11-19T17:07:23.182448102Z");
		expect(data.priceDate).toBe("2026-11-19");
		expect(data.region).toBe("us-east-2");
		expect(data.headline.length).toBe(14);
		expect(data.machines.length).toBe(5);
	});

	test("the latest rounds, newest first, as recent_rounds gives them", () => {
		expect(data.rounds).toEqual([
			{ startedAt: "2026-11-19T16:11:43.513987246Z", boots: 5, runs: 187, failedRuns: 0 },
			{ startedAt: "2026-11-19T10:11:03.050566699Z", boots: 5, runs: 187, failedRuns: 0 },
			{ startedAt: "2026-11-19T04:11:03.680646285Z", boots: 5, runs: 187, failedRuns: 0 },
		]);
	});

	test("lacks nothing the page shows, so the build has nothing to say", () => {
		expect(data.notes).toEqual([]);
	});
});

describe("links", () => {
	test("the API's are the tree's own addresses", () => {
		expect(data.links.index).toBe("https://api.ledgermath.com/v1/index.json");
		expect(data.links.seriesList).toBe("https://api.ledgermath.com/v1/series.json");
		expect(data.links.prices).toBe("https://api.ledgermath.com/v1/prices/2026-11-19.json");
		for (const row of data.series) expect(data.links.seriesFile(row)).toBe(`https://api.ledgermath.com/v1/series/${row.id}.json`);
	});

	test("the site's own are inside the site: the home page, its table, the notices", () => {
		expect(data.links.home).toBe("/");
		expect(data.links.numbers).toBe("/#numbers");
		expect(data.links.licences).toBe("/third-party-notices.txt");
	});

	test("every documentation link goes to the placeholder at /docs/ for now; each benchmark's planned page is one line away", () => {
		expect(data.links.docs).toBe("/docs/");
		for (const choice of HEADLINE_CHOICES) {
			expect(choice.readme).toBe("/docs/");
			expect(data.links.benchmarkDocs(choice.benchmark)).toBe("/docs/");
		}
		expect(plannedBenchmarkDocsUrl("mutex")).toBe("/docs/benchmarks/mutex");
	});

	test("no link goes to GitHub, though the tree's own docs field does", () => {
		expect(tree.index.docs).toStartWith("https://github.com/"); // the fixture is as the generator wrote it
		const links = { ...data.links, benchmarkDocs: HEADLINE_CHOICES.map((c) => data.links.benchmarkDocs(c.benchmark)) };
		expect(JSON.stringify({ links, choices: HEADLINE_CHOICES })).not.toContain("github");
	});

	test("the module's output names no other project: nothing says napkin", () => {
		const everything = JSON.stringify({ data: { ...data, links: null }, choices: HEADLINE_CHOICES });
		expect(everything.length).toBeGreaterThan(0);
		expect(everything.toLowerCase()).not.toContain("napkin");
	});
});

describe("machines", () => {
	test("five, cheapest first, each with its On-Demand Linux price as the price file writes it", () => {
		expect(data.machines.map((m) => m.instanceType)).toEqual(["m5.large", "c8i.2xlarge", "c8a.2xlarge", "i4i.2xlarge", "c6i.8xlarge"]);
		const m5 = data.machines[0]!;
		expect(m5.price.usdPerHour).toBe("0.0960000000");
		expect(m5.price.description).toBe("$0.096 per On Demand Linux m5.large Instance Hour");
		expect(m5.vcpu).toBe("2");
		for (const m of data.machines) {
			expect(m.price.unit).toBe("Hrs");
			expect(m.series.length).toBeGreaterThan(0);
		}
	});
});

describe("the headline selection", () => {
	test("14 rows × 5 machine types = 70 Series, all distinct, every cell with its figure", () => {
		expect(headlineSeries.length).toBe(70);
		expect(new Set(headlineSeries.map((row) => row.id)).size).toBe(70);
		for (const row of data.headline) {
			expect(row.cells.map((c) => c.machine.instanceType)).toEqual(data.machines.map((m) => m.instanceType));
			for (const cell of row.cells) {
				expect(cell.series?.instance_type).toBe(cell.machine.instanceType);
				expect(cell.figure).toEqual(leadFigure(row.choice, cell.series!));
				expect(Number.isFinite(cell.figure!.p50)).toBe(true);
			}
		}
	});

	test("rule steps 1 to 3: static build, the root volume, one thread", () => {
		for (const row of headlineSeries) {
			expect(row.build).toBe("static");
			if ("disk" in row.params) expect(row.params.disk).toBe("root_volume");
			if ("threads" in row.params) expect(row.params.threads).toBe(1);
		}
	});

	test("every benchmark of the tree has a row", () => {
		expect(HEADLINE_CHOICES.map((c) => c.benchmark).sort()).toEqual([...new Set(data.series.map((row) => row.benchmark))].sort());
	});
});

describe("what a tree lacks, the page leaves out, and the build says so", () => {
	const m5 = (d: SiteData) => d.headline.find((row) => row.choice.benchmark === "hash")!.cells.find((cell) => cell.machine.instanceType === "m5.large")!;
	const hashOnM5 = m5(data).series!;

	test("no recent_rounds: no rounds, and one line saying \"Latest runs\" is left out", () => {
		const d = siteData(variant((t) => delete t.index.recent_rounds));
		expect(d.rounds).toBeNull();
		expect(d.notes).toEqual(['v1/index.json has no recent_rounds: the page is built without "Latest runs"']);
	});

	test("recent_rounds with no round: the same", () => {
		const d = siteData(variant((t) => (t.index.recent_rounds!.rounds = [])));
		expect(d.rounds).toBeNull();
		expect(d.notes).toEqual(['v1/index.json lists no round in recent_rounds: the page is built without "Latest runs"']);
	});

	test("a round's failed Runs are given as the tree counts them, never as 0 unless it says 0", () => {
		const d = siteData(variant((t) => (t.index.recent_rounds!.rounds[0]!.failed_runs = 3)));
		expect(d.rounds![0]!.failedRuns).toBe(3);
	});

	test("a headline Series the tree lacks: its cell has no Series and no figure, and the build goes on", () => {
		const d = siteData(variant((t) => (t.seriesList.series = t.seriesList.series.filter((row) => row.id !== hashOnM5.id))));
		expect(m5(d)).toMatchObject({ series: null, figure: null });
		expect(d.notes).toEqual(["no Series for hash on m5.large: its cell shows no figure"]);
		expect(d.headline.flatMap((row) => row.cells).filter((cell) => !cell.figure)).toHaveLength(1);
	});

	test("a headline Series with no figure (no counted Run): its cell has no figure", () => {
		const d = siteData(
			variant((t) => {
				const row = t.seriesList.series.find((r) => r.id === hashOnM5.id)!;
				row.derivations.series_v1.percentiles.time_per_repetition_ns = null;
			}),
		);
		expect(m5(d).series?.id).toBe(hashOnM5.id);
		expect(m5(d).figure).toBeNull();
		expect(m5(d).absent).toBe("no Run of this Series counts yet");
		expect(d.notes).toEqual([`Series ${hashOnM5.id} (hash on m5.large) has no time median (no Run of this Series counts yet): its cell shows none`]);
	});

	test("a headline Series whose median the tree gives as null, as the schema allows: no figure, and why", () => {
		const d = siteData(variant((t) => (t.seriesList.series.find((r) => r.id === hashOnM5.id)!.derivations.series_v1.percentiles.time_per_repetition_ns!.p50 = null)));
		expect(m5(d)).toMatchObject({ figure: null, absent: "the data give this Series' median as null: infinite or undefined" });
		expect(d.notes).toEqual([`Series ${hashOnM5.id} (hash on m5.large) has no time median (the data give this Series' median as null: infinite or undefined): its cell shows none`]);
	});

	test("a headline Series with a percentile given as null: the figure stands, the percentile is null, and the build says so", () => {
		const d = siteData(variant((t) => (t.seriesList.series.find((r) => r.id === hashOnM5.id)!.derivations.series_v1.percentiles.time_per_repetition_ns!.p95 = null)));
		expect(m5(d).figure).toMatchObject({ p95: null });
		expect(m5(d).figure!.p50).toBe(hashOnM5.derivations.series_v1.percentiles.time_per_repetition_ns!.p50!);
		expect(d.notes).toEqual([`Series ${hashOnM5.id} (hash on m5.large) has a percentile given as null: its title says so`]);
	});

	test("a Series that names no instance type, as the schema allows: it stands under no machine type, and the build says so", () => {
		const d = siteData(
			variant((t) => t.seriesList.series.push({ ...structuredClone(hashOnM5), id: "222222222222", url: "https://api.ledgermath.com/v1/series/222222222222.json", instance_type: null })),
		);
		expect(d.notes).toEqual(["1 Series name no instance type (222222222222): they stand under no machine type, and the table leaves them out"]);
		expect(m5(d).series?.id).toBe(hashOnM5.id);
	});

	test("two Series a choice matches on one machine type: the build fails, since the rule no longer says which to show", () => {
		const t = variant((t) => t.seriesList.series.push({ ...structuredClone(hashOnM5), id: "000000000000", url: "https://api.ledgermath.com/v1/series/000000000000.json" }));
		expect(() => siteData(t)).toThrow("headline hash on m5.large: 2 Series match its settings (");
	});

	test("a machine type with no Series, Series on a type with no price, a benchmark with no choice: each said, and left out", () => {
		const d = siteData(
			variant((t) => {
				t.seriesList.series = t.seriesList.series.filter((row) => row.instance_type !== "c6i.8xlarge").map((row) => (row.benchmark === "sort" ? { ...row, benchmark: "sort2" } : row));
				t.seriesList.series.push({ ...structuredClone(hashOnM5), id: "111111111111", url: "https://api.ledgermath.com/v1/series/111111111111.json", instance_type: "x9.large" });
			}),
		);
		expect(d.notes).toContain("no Series ran on c6i.8xlarge: its column shows a dash in every cell");
		expect(d.notes).toContain("Series ran on x9.large, which the newest price file does not price: the table leaves them out");
		expect(d.notes).toContain("no headline choice in src/data/headline.ts for sort2: the table leaves them out");
		expect(d.machines.map((m) => m.instanceType)).toContain("c6i.8xlarge");
	});

	test("a Series whose address is not under the tree's base: the build fails", () => {
		const t = variant((t) => (t.seriesList.series[0]!.url = "https://example.com/v1/series/x.json"));
		expect(() => siteData(t)).toThrow("is not under the tree's base https://api.ledgermath.com/");
	});
});

describe("readTree", () => {
	test("refuses what is not a tree the site can be built from, saying what is wrong", () => {
		expect(() => readTree(join(FIXTURE, "nothing-here"))).toThrow("is not a directory");
		expect(() => readTree(onDisk((path, json) => (path === "v1/series.json" ? undefined : json)))).toThrow("v1/series.json is missing from the tree");
		expect(() => readTree(onDisk((path, json) => (path === "v1/index.json" ? "{not json" : json)))).toThrow("v1/index.json in the tree at");
		expect(() => readTree(onDisk((path, json) => (path === "v1/index.json" ? { ...json, schema: "ledgermath.api.index/2" } : json)))).toThrow(
			'v1/index.json: schema is "ledgermath.api.index/2", not "ledgermath.api.index/1"',
		);
		expect(() =>
			readTree(onDisk((path, json) => (path === "v1/index.json" ? { ...json, series: { ...(json.series as object), url: "https://elsewhere.example/v1/series.json" } } : json))),
		).toThrow("v1/index.json: series.url is \"https://elsewhere.example/v1/series.json\", which is not under the tree's base https://api.ledgermath.com/");
		expect(() =>
			readTree(onDisk((path, json) => (path === "v1/index.json" ? { ...json, series: { ...(json.series as object), url: "https://api.ledgermath.com/v1/../secret.json" } } : json))),
		).toThrow("whose path is not a plain path to a JSON file under v1/");
		expect(() => readTree(onDisk((path, json) => (path === "v1/series.json" ? { ...json, count: 186 } : json)))).toThrow("v1/series.json: count is 186, but the file lists 187 Series");
	});

	test("refuses recent_rounds that are not newest first, or count more failed Runs than Runs", () => {
		const rounds = (list: unknown[]) => onDisk((path, json) => (path === "v1/index.json" ? { ...json, recent_rounds: { rounds: list } } : json));
		const r = (started_at: string, failed_runs = 0) => ({ started_at, boots: 5, runs: 187, failed_runs });
		expect(() => readTree(rounds([r("2026-11-19T04:11:03Z"), r("2026-11-19T10:11:03Z")]))).toThrow("recent_rounds.rounds[1].started_at is later than the round before it");
		expect(() => readTree(rounds([r("2026-11-19T04:11:03Z", 188)]))).toThrow("recent_rounds.rounds[0].failed_runs is 188, more than the round's 187 Runs");
		expect(() => readTree(rounds([{ ...r("2026-11-19T04:11:03Z"), boots: -1 }]))).toThrow("recent_rounds.rounds[0].boots is not a whole number from 0");
		expect(readTree(rounds([r("2026-11-19T10:11:03.5Z", 2), r("2026-11-19T10:11:03.499999999Z")])).index.recent_rounds!.rounds[0]!.failed_runs).toBe(2);
	});

	test("takes every null the Series list's schema allows, in any Series, used by the page or not", () => {
		const t = readTree(
			onDisk((path, json) => {
				if (path !== "v1/series.json") return json;
				const rows = json.series as any[];
				rows[0].derivations.series_v1.percentiles.bytes_per_second.p95 = null;
				rows[1].derivations.series_v1.percentiles.bytes_per_second.p50 = null;
				rows[2].derivations.series_v1.percentiles.time_per_repetition_ns = { ...rows[2].derivations.series_v1.percentiles.time_per_repetition_ns, p5: null, p50: null, p95: null };
				rows[3].instance_type = null;
				rows[4].availability_zone_id = null;
				return json;
			}),
		);
		expect(t.seriesList.series[1]!.derivations.series_v1.percentiles.bytes_per_second!.p50).toBeNull();
		expect(t.seriesList.series[3]!.instance_type).toBeNull();
		expect(() => siteData(t)).not.toThrow();
	});

	test("refuses a tree whose files are of two publications, saying so", () => {
		// The verifier's case: one day's table of contents with an earlier day's Series list, both of 187 Series.
		const newer = (json: Record<string, unknown>) => ({ ...json, newest_run_started_at: "2026-11-24T22:36:16.314088296Z" });
		expect(() => readTree(onDisk((path, json) => (path === "v1/index.json" ? newer(json) : json)))).toThrow(
			/holds files of two publications of the API, and the site is never built from such a tree \(fetch a new one\): the newest Run's start, in the table of contents and in the Series list: "2026-11-24T22:36:16\.314088296Z" and "2026-11-19T17:07:23\.182448102Z"$/,
		);
		expect(() => readTree(onDisk((path, json) => (path === "v1/series.json" ? { ...json, index: "https://mirror.example/v1/index.json" } : json)))).toThrow(
			"the table of contents' address, as itself and as the Series list gives it",
		);
		expect(() => readTree(onDisk((path, json) => (path === "v1/prices/2026-11-19.json" ? { ...json, fetched_at: "2026-11-18T03:23:19.099Z" } : json)))).toThrow(
			"the newest price file's date, in the table of contents and as the file's fetch time gives it",
		);
		expect(() =>
			readTree(
				onDisk((path, json) => {
					if (path === "v1/series.json") return { ...json, count: 186, series: (json.series as unknown[]).slice(1) };
					return json;
				}),
			),
		).toThrow('the count of Series, in the table of contents and in the Series list: 187 and 186');
	});

	test("refuses a table of contents that names no price file, saying why", () => {
		expect(() => readTree(onDisk((path, json) => (path === "v1/index.json" ? { ...json, prices: { ...(json.prices as object), newest: null } } : json)))).toThrow(
			"v1/index.json: prices.newest is null: the API holds no price file, and the page's machine types and prices come from the newest one",
		);
	});

	test("takes a member it does not know as version 1 allows, and reads a tree from before recent_rounds", () => {
		const t = readTree(onDisk((path, json) => (path === "v1/index.json" ? { ...json, recent_rounds: undefined, something_new: [1, 2, 3] } : json)));
		expect(t.index.recent_rounds).toBeUndefined();
		expect(t.index.something_new).toEqual([1, 2, 3]);
	});

	test("compares moments to the nanosecond, whatever the fraction's length", () => {
		expect(compareMoments("2026-11-19T10:11:03.5Z", "2026-11-19T10:11:03.499999999Z")).toBe(1);
		expect(compareMoments("2026-11-19T10:11:03Z", "2026-11-19T10:11:03.000Z")).toBe(0);
		expect(compareMoments("2026-11-18T23:59:59.9Z", "2026-11-19T00:00:00Z")).toBe(-1);
	});
});

describe("exact figures", () => {
	test("plain writes exponents out", () => {
		expect(plain(1.5e-7)).toBe("0.00000015");
		expect(plain(2e21)).toBe("2000000000000000000000");
		expect(plain(19868635157.971607)).toBe("19868635157.971607");
		expect(plain(-0.5)).toBe("-0.5");
	});

	test("shift moves the point and drops nothing", () => {
		expect(shift("19868635157.971607", -9)).toBe("19.868635157971607");
		expect(shift("51.53851746022701", -3)).toBe("0.05153851746022701");
		expect(shift("172640713.75", -6)).toBe("172.64071375");
		expect(shift("0.096", 3)).toBe("96");
		expect(shift("-12.5", -1)).toBe("-1.25");
		expect(shift("0", -9)).toBe("0");
	});

	test("halve divides by a power of two exactly", () => {
		expect(halve("1073741824", 30)).toBe("1");
		expect(halve("131072", 10)).toBe("128");
		expect(halve("1", 1)).toBe("0.5");
		expect(halve("125829120.5", 20)).toBe("120.0000004768371582031250".replace(/0+$/, ""));
	});

	test("rounding, half away from zero", () => {
		expect(roundSignificant("19.868635157971607", 4)).toBe("19.87");
		expect(roundSignificant("999.96", 4)).toBe("1000");
		expect(roundSignificant("0.0999", 2)).toBe("0.10");
		expect(roundSignificant("10.0012", 4)).toBe("10.00");
		expect(roundSignificant("9.996", 3)).toBe("10.0");
		expect(roundSignificant("12.5000", 3)).toBe("12.5");
		expect(roundSignificant("19868635157.971607", 4)).toBe("19870000000");
		expect(roundSignificant("-2.345", 3)).toBe("-2.35");
		expect(roundSignificant("12", 4)).toBe("12");
		expect(roundPlaces("1.2345", 2)).toBe("1.23");
		expect(roundPlaces("-1.235", 2)).toBe("-1.24");
		expect(roundPlaces("1.2", 3)).toBe("1.2");
		expect(roundPlaces("1.2001", 2)).toBe("1.20");
		expect(roundPlaces("0.004", 2)).toBe("0.00");
		expect(roundPlaces("9.996", 2)).toBe("10.00");
		expect(roundPlaces("0.5", 0)).toBe("1");
	});

	test("group", () => {
		expect(group("6335")).toBe("6,335");
		expect(group("19868635157.971607", ",")).toBe("19,868,635,157.971607");
		expect(group("19868635157.971607", " ", " ")).toBe("19 868 635 157.971 607");
		expect(group("-1000")).toBe("-1,000");
	});

	test("formatters keep the full figure beside the short one", () => {
		const rate = formatRate(19868635157.971607);
		expect(rate).toMatchObject({ full: "19.868635157971607", short: "19.87", unit: "GB/s", rounded: true, source: "19868635157.971607 B/s" });
		expect(formatRate(131072000, { system: "iec" })).toMatchObject({ full: "125", unit: "MiB/s", rounded: false });
		const time = formatDuration(172640713.75);
		expect(time).toMatchObject({ full: "172.64071375", short: "172.6", unit: "ms", source: "172640713.75 ns" });
		expect(formatDuration(51.53851746022701, { unit: "ns", significant: 20 })).toMatchObject({ full: "51.53851746022701", rounded: false });
		expect(formatBytes(1073741824)).toMatchObject({ full: "1", unit: "GiB", rounded: false });
		expect(formatBytes(1073741824, { system: "si" })).toMatchObject({ full: "1.073741824", unit: "GB" });
		expect(formatCount(6335)).toMatchObject({ full: "6,335", rounded: false });
		expect(formatUsd("0.6860000000", { per: "hour" })).toMatchObject({ full: "0.686", unit: "USD/hour", source: "0.6860000000 USD/hour", rounded: false });
	});

	test("a figure per one of a repetition's parts: an exact division by a power of ten, nothing else", () => {
		expect(powerOfTen(1)).toBe(0);
		expect(powerOfTen(10000)).toBe(4);
		expect(() => powerOfTen(2048)).toThrow();
		expect(() => powerOfTen(0)).toThrow();
		expect(() => powerOfTen(10.5)).toThrow();
		expect(perUnit(175035.7981262207, 10000)).toBe("17.50357981262207");
		expect(perUnit("765134.14", 10000)).toBe("76.513414");
		expect(perUnit(3, 1000)).toBe("0.003");
		expect(() => perUnit(100, 3)).toThrow();
		const each = formatDurationPerUnit(175035.7981262207, { count: 10000, of: "critical section" });
		expect(each).toMatchObject({ full: "17.50357981262207", short: "17.50", unit: "ns", rounded: true, source: "175035.7981262207 ns", per: { count: 10000, of: "critical section" } });
		expect(formatDurationPerUnit(25000000, { count: 1000, of: "x" })).toMatchObject({ full: "25", unit: "µs", rounded: false });
		expect(formatDurationPerUnit(175035.7981262207, { count: 10000, of: "critical section" }, { unit: "µs", significant: 3 })).toMatchObject({ full: "0.01750357981262207", short: "0.0175" });
		// Every headline choice with a `per` divides exactly.
		for (const row of data.headline) {
			const per = row.choice.per;
			if (!per) continue;
			for (const cell of row.cells) {
				const p50 = cell.figure!.p50;
				expect(formatDurationPerUnit(p50, per).full).toBe(shift(shift(plain(p50), -powerOfTen(per.count)), 0));
			}
		}
	});

	test("moments keep their nanoseconds", () => {
		const m = formatMoment("2026-11-19T17:07:23.182448102Z");
		expect(m.full).toBe("2026-11-19 17:07:23.182448102 UTC");
		expect(m.date).toBe("2026-11-19");
		expect(m.minute).toBe("17:07");
		expect(m.longDate).toBe("19 November 2026");
	});
});
