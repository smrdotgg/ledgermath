import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	benchmarks,
	formatBytes,
	formatCount,
	formatDuration,
	formatMoment,
	formatRate,
	formatUsd,
	group,
	halve,
	headline,
	headlineSeries,
	leadFigure,
	links,
	machines,
	plain,
	roundPlaces,
	roundSignificant,
	series,
	shift,
	snapshot,
} from ".";
import { apiIndex, PRICE_FILE_DATE } from "./snapshot";

const SNAPSHOT = join(import.meta.dir, "..", "..", "data", "snapshot", "v1");

describe("the snapshot", () => {
	test("every row of series.json reads back byte for byte, so String(n) is the figure as written", () => {
		const raw = readFileSync(join(SNAPSHOT, "series.json"), "utf8");
		for (const row of series) expect(raw.includes(JSON.stringify(row))).toBe(true);
	});

	test("the price file imported is the one index.json calls newest", () => {
		expect(apiIndex.prices.newest.date).toBe(PRICE_FILE_DATE);
	});

	test("counts", () => {
		expect(snapshot.seriesCount).toBe(187);
		expect(series.length).toBe(187);
		expect(snapshot.runCount).toBe(6335);
		expect(snapshot.countedRuns + snapshot.failedRuns).toBe(snapshot.runCount);
		expect(snapshot.newestRunStartedAt).toBe("2026-11-19T17:07:23.182448102Z");
		expect(snapshot.benchmarkCount).toBe(14);
		expect(snapshot.machineCount).toBe(5);
	});

	test("links are the snapshot's own addresses", () => {
		expect(links.index).toBe("https://api.ledgermath.com/v1/index.json");
		expect(links.seriesList).toBe("https://api.ledgermath.com/v1/series.json");
		expect(links.prices).toBe("https://api.ledgermath.com/v1/prices/2026-11-19.json");
		for (const row of series) expect(links.seriesFile(row)).toBe(`https://api.ledgermath.com/v1/series/${row.id}.json`);
	});
});

describe("machines", () => {
	test("five, cheapest first, each with its On-Demand Linux price as the price file writes it", () => {
		expect(machines.map((m) => m.instanceType)).toEqual(["m5.large", "c8i.2xlarge", "c8a.2xlarge", "i4i.2xlarge", "c6i.8xlarge"]);
		const m5 = machines[0]!;
		expect(m5.price.usdPerHour).toBe("0.0960000000");
		expect(m5.price.description).toBe("$0.096 per On Demand Linux m5.large Instance Hour");
		expect(m5.vcpu).toBe("2");
		for (const m of machines) {
			expect(m.price.unit).toBe("Hrs");
			expect(m.series.length).toBeGreaterThan(0);
			expect(m.region).toBe("us-east-2");
		}
	});
});

describe("the headline selection", () => {
	test("14 rows × 5 machine types = 70 Series, all distinct", () => {
		expect(headline.length).toBe(14);
		expect(headlineSeries.length).toBe(70);
		expect(new Set(headlineSeries.map((row) => row.id)).size).toBe(70);
		for (const row of headline) expect(row.cells.map((c) => c.machine.instanceType)).toEqual(machines.map((m) => m.instanceType));
	});

	test("rule steps 1 to 3: static build, the root volume, one thread", () => {
		for (const row of headlineSeries) {
			expect(row.build).toBe("static");
			if ("disk" in row.params) expect(row.params.disk).toBe("root_volume");
			if ("threads" in row.params) expect(row.params.threads).toBe(1);
		}
	});

	test("every benchmark has a row, and every row's lead figure exists", () => {
		expect(benchmarks.map((b) => b.name).sort()).toEqual([...new Set(series.map((row) => row.benchmark))].sort());
		for (const row of headline) for (const cell of row.cells) expect(Number.isFinite(leadFigure(row.choice, cell.series).p50)).toBe(true);
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
		expect(group("19868635157.971607", " ", " ")).toBe("19 868 635 157.971 607");
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

	test("moments keep their nanoseconds", () => {
		const m = formatMoment("2026-11-19T17:07:23.182448102Z");
		expect(m.full).toBe("2026-11-19 17:07:23.182448102 UTC");
		expect(m.date).toBe("2026-11-19");
		expect(m.minute).toBe("17:07");
		expect(m.longDate).toBe("19 November 2026");
	});
});
