import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { BENCHMARK_NOTES } from "../scripts/lib/benchmark-notes";
import { quantities } from "../scripts/lib/quantity";
import { resolveCitation } from "../scripts/lib/citation";
import { type LedgerData, loadLedger, openLocation } from "../scripts/lib/ledger-data";
import {
	about,
	aboutText,
	findPrices,
	listSeries,
	pricesText,
	rateText,
	seriesListText,
	showSeries,
	showText,
	sig,
	timeText,
	wordMatches,
} from "../scripts/lib/lookup";
import { C6I_PRICE_CITATION, type Fixture, makeFixture } from "./lookup-fixtures";
import { SAMPLE_PATH } from "./prices-fixtures";
import { serve } from "./tree-fixture";

setDefaultTimeout(60_000);

const ROOT = resolve(import.meta.dir, "..");
let fixture: Fixture;
let data: LedgerData;

beforeAll(async () => {
	fixture = await makeFixture();
	data = await loadLedger(openLocation(fixture.directory));
});
afterAll(() => rmSync(fixture.directory, { recursive: true, force: true }));

describe("the benchmark notes", () => {
	test("every benchmark schedule.json runs has one, from a file that exists", () => {
		const schedule = JSON.parse(readFileSync(join(ROOT, "schedule.json"), "utf8")) as { benchmarks: Array<{ name: string; params: Array<Record<string, string | number>> }> };
		for (const entry of schedule.benchmarks) {
			const note = BENCHMARK_NOTES[entry.name];
			expect(note, entry.name).toBeDefined();
			expect(existsSync(join(ROOT, note?.source ?? "")), note?.source).toBe(true);
		}
		expect(Object.keys(BENCHMARK_NOTES).sort()).toEqual([...new Set(schedule.benchmarks.map((entry) => entry.name))].sort());
	});

	test("no quantity is written by hand: the checker's own reader finds no number in any line the tool prints", () => {
		for (const [name, note] of Object.entries(BENCHMARK_NOTES)) {
			for (const text of [note.measures, note.repetition, note.bytes ?? "", note.caveat ?? "", ...(note.variants ?? []).map((v) => v.note)]) {
				expect(quantities(text).map((q) => q.text), `${name}: ${text}`).toEqual([]);
			}
		}
		// A size or limit is named by the dump section that records it.
		expect(BENCHMARK_NOTES.disk_write?.variants?.find((v) => v.match.disk === "root_volume")?.note).toContain("dump section ec2_volumes");
		expect(BENCHMARK_NOTES.compressed_memory_read?.measures).toContain("dump sections lscpu and sys_cpu");
	});

	test("every benchmark whose binary runs on one thread says so", () => {
		const threaded = new Set(["memory_read", "mutex", "tcp_echo"]);
		for (const [name, note] of Object.entries(BENCHMARK_NOTES)) {
			if (!threaded.has(name)) expect(note.measures, name).toMatch(/\bone thread\b/);
		}
	});
});

describe("numbers as text", () => {
	test("six significant digits, in the unit that reads best", () => {
		expect(sig(140281717414.91382 / 1e9)).toBe("140.282");
		expect(sig(94.7)).toBe("94.7");
		expect(sig(0.0000004)).toBe("0.0000004");
		expect(timeText(7688617.515625)).toBe("7.68862 ms");
		expect(timeText(94.7)).toBe("94.7 ns");
		expect(timeText(582_600)).toBe("582.6 µs");
		expect(rateText(140281717414.91382)).toBe("140.282 GB/s (130.648 GiB/s)");
		expect(rateText(125 * 2 ** 20)).toBe("131.072 MB/s (125 MiB/s)");
	});

	test("a word matches the start of a word, ignoring case", () => {
		expect(wordMatches("GET", "$0.004 per 10,000 GET and all other requests")).toBe(true);
		expect(wordMatches("get", "target")).toBe(false);
		expect(wordMatches("c6i.8xlarge", "USE2-BoxUsage:c6i.8xlarge")).toBe(true);
		expect(wordMatches("threads=all", "path=avx2 threads=all")).toBe(true);
		expect(wordMatches("read", "memory_read")).toBe(true);
	});
});

describe("about", () => {
	test("says what the data hold, and which benchmarks have no Series", async () => {
		const a = await about(data);
		expect(a.series).toBe(4);
		expect(a.runs_read).toBe(12);
		expect(a.runs).toBe(12);
		expect(a.counted_runs).toBe(11);
		expect(a.failed_runs).toBe(1);
		expect(a.layout).toBe(1);
		expect(a.benchmarks).toEqual({ memory_read: 2, syscall: 1, tcp_echo: 1 });
		expect(a.instance_types).toEqual({ "c6i.8xlarge": 3, "m5.large": 1 });
		expect(a.benchmarks_without_series).toContain("sort");
		expect(a.price_files).toEqual([SAMPLE_PATH]);
		expect(a.price_file).toBe(SAMPLE_PATH);
		expect(a.price_file_date).toBe("2026-11-11");
		expect(a.derivations).toBe("v1/series.json");
		const text = aboutText(a);
		expect(text).toContain("Benchmarks with Series: memory_read (2 Series), syscall (1 Series), tcp_echo (1 Series).");
		expect(text).toContain(`Price files: 1, from ${SAMPLE_PATH} to ${SAMPLE_PATH}; in use ${SAMPLE_PATH}, the price file of 2026-11-11.`);
		expect(text).toContain("prices <word> finds them");
	});
});

describe("series", () => {
	test("lists every Series, or those matching every word", async () => {
		expect((await listSeries(data, [])).series.map((s) => s.id).sort()).toEqual(fixture.derivations.derivations.map((d) => d.series.id).sort());
		const memory = await listSeries(data, ["memory_read"]);
		expect(memory.series.map((s) => s.instance_type)).toEqual(["c6i.8xlarge", "m5.large"]);
		expect((await listSeries(data, ["memory", "m5.large"])).series.map((s) => s.id)).toEqual([fixture.m5.series.id]);
		// A word naming a field is matched against fields only: memory_read's description mentions avx2, syscall's params do not.
		expect((await listSeries(data, ["avx2"])).series.map((s) => s.benchmark)).toEqual(["memory_read", "memory_read"]);
		// Any other word, against the descriptions too, with their caveats.
		const network = await listSeries(data, ["network"]);
		expect(network.series.map((s) => s.benchmark)).toEqual(["tcp_echo"]);
		expect(seriesListText(network)).toContain("Loopback: no network is involved.");
		const text = seriesListText(memory);
		expect(text).toContain("[lm:benchmark/memory_read]");
		expect(text).toContain(`${fixture.m5.series.id}  m5.large  use2-az3  path=avx2 size_bytes=1073741824 threads=all  build static  5 counted of 5 Runs, newest 2026-11-16T04:22:00Z`);
		expect(text).toContain("split into 2 groups");
	});

	test("says plainly what is not held, and what is", async () => {
		const list = await listSeries(data, ["sort", "m5.large"]);
		expect(list.series).toEqual([]);
		expect(list.not_held?.lines).toContain('"sort" is a LedgerMath benchmark, but this data holds no Series of it yet.');
		expect(list.not_held?.lines.some((line) => line.startsWith('"m5.large" alone matches 1 Series'))).toBe(true);
		expect((await listSeries(data, ["c7g.xlarge"])).not_held?.lines).toContain('"c7g.xlarge" matches no Series.');
		expect(seriesListText(list)).toContain("Instance types with Series: c6i.8xlarge (3 Series), m5.large (1 Series).");
		expect(seriesListText(list)).toContain("Whether LedgerMath holds a price for something: prices <word>.");
	});
});

describe("show", () => {
	test("the percentiles are the Derivation's, each with its citation, and the Runs newest first", async () => {
		const result = await showSeries(data, [fixture.c6i.series.id], 10);
		if (result.found !== "one") throw new Error("expected one Series");
		const s = result.series;
		const time = s.numbers.find((n) => n.number === "time_per_repetition_ns");
		const bytes = fixture.c6i.percentiles.time_per_repetition_ns;
		expect(time?.count).toBe(3);
		expect(time?.p50.value).toBe(bytes?.p50 as number);
		expect(time?.p50.text).toBe("8 ms");
		// The Series as of its newest Run's start, the failed Run of 2026-11-15.
		expect(s.data_through).toBe("2026-11-15T04:12:00Z");
		expect(time?.p5.citation).toBe(`[lm:series/${s.id}/time_per_repetition_ns/p5@v1,2026-11-15T04:12:00Z]`);
		expect(s.numbers.find((n) => n.number === "bytes_per_second")?.p95.citation).toBe(`[lm:series/${s.id}/bytes_per_second/p95@v1,2026-11-15T04:12:00Z]`);
		expect(time?.count_citation).toBe(`[lm:series/${s.id}/time_per_repetition_ns/count@v1,2026-11-15T04:12:00Z]`);
		expect(s.runs).toBe(4);
		expect(s.failed).toBe(1);
		expect(s.runs_list.map((run) => run.started_at.slice(0, 10))).toEqual(["2026-11-15", "2026-11-14", "2026-11-13", "2026-11-12"]);
		expect(s.runs_list[0]?.counted).toBe(false);
		expect(s.runs_list[0]?.evidence).toBe(`https://api.ledgermath.com/${s.runs_list[0]?.path}`);
		expect(s.notes[0]).toContain("3 counted Runs");
		expect(s.derivations).toBe(`v1/series/${s.id}.json`);
		const text = showText(result);
		expect(text).toContain(`  p50  8 ms                         [lm:series/${s.id}/time_per_repetition_ns/p50@v1,2026-11-15T04:12:00Z]`);
		expect(text).toContain("  data through 2026-11-15T04:12:00Z, the newest Run's start: each citation below is of the Series as it stood then, under Method series version 1");
		expect(text).toContain(`params: path=avx2 [lm:series/${s.id}/params/path]`);
		expect(text).toContain(`  ${fixture.c6i.runs[0]?.path}  2026-11-12T04:12:00Z  group A  counted`);
		expect(text).toMatch(/failed: .*no "verified" event/);
		expect(text).toContain(`Method series version 1, from v1/series/${s.id}.json.`);
	});

	test("lists the newest N with a count, or every Run", async () => {
		const two = await showSeries(data, [fixture.c6i.series.id], 2);
		if (two.found !== "one") throw new Error("expected one Series");
		expect(two.series.runs_shown).toBe(2);
		expect(showText(two)).toContain("Runs behind these numbers (2 of 4, newest first; --runs all lists every one):");
		const all = await showSeries(data, [fixture.c6i.series.id], "all");
		if (all.found !== "one") throw new Error("expected one Series");
		expect(all.series.runs_shown).toBe(4);
	});

	test("a split Series shows each group, why it is split, and each group's citations", async () => {
		const result = await showSeries(data, ["memory_read", "m5.large"], 10);
		if (result.found !== "one") throw new Error("expected one Series");
		const groups = result.series.group_details;
		expect(groups.map((g) => [g.id, g.numbers[0]?.count])).toEqual([
			["A", 3],
			["B", 2],
		]);
		expect(groups[1]?.differs_from_first.map((d) => d.fact)).toEqual(["cpuid", "lscpu", "sys_cpu"]);
		expect(groups[1]?.numbers[0]?.p50.citation).toBe(`[lm:series/${fixture.m5.series.id}/group/B/time_per_repetition_ns/p50@v1,2026-11-16T04:22:00Z]`);
		expect(result.series.notes.some((note) => note.startsWith("Split into 2 groups"))).toBe(true);
		const text = showText(result);
		expect(text).toContain("Group B: differs from group A in: cpuid (dump section cpuid");
		expect(text).toContain(`  time per repetition, across 2 counted Runs [lm:series/${fixture.m5.series.id}/group/B/time_per_repetition_ns/count@v1,2026-11-16T04:22:00Z]:`);
	});

	test("a Series with one Run, without bytes, and with a caveat", async () => {
		const syscall = await showSeries(data, ["syscall"], 10);
		if (syscall.found !== "one") throw new Error("expected one Series");
		expect(syscall.series.numbers.map((n) => n.number)).toEqual(["time_per_repetition_ns"]);
		expect(syscall.series.notes[0]).toContain("One counted Run");
		const tcp = await showSeries(data, ["tcp_echo"], 10);
		if (tcp.found !== "one") throw new Error("expected one Series");
		expect(showText(tcp)).toContain("Note: Loopback: no network is involved. It is not a number for traffic between two machines.");
	});

	test("words matching several Series list them; words matching none say what is not held", async () => {
		const many = await showSeries(data, ["memory_read"], 10);
		expect(many.found).toBe("many");
		const none = await showSeries(data, ["mutex"], 10);
		expect(none.found).toBe("none");
		expect(showText(none)).toContain('"mutex" is a LedgerMath benchmark, but this data holds no Series of it yet.');
	});
});

describe("prices", () => {
	test("an instance type: its price in AWS's words, the file's date, and citations for the price and the catalog words", async () => {
		const result = await findPrices(data, ["c6i.8xlarge"]);
		expect(result.matches.length).toBe(1);
		const match = result.matches[0];
		expect(match?.price_per_unit).toBe("1.3600000000");
		expect(match?.unit).toBe("Hrs");
		expect(match?.description).toBe("$1.36 per On Demand Linux c6i.8xlarge Instance Hour");
		expect(match?.citation).toBe(C6I_PRICE_CITATION);
		expect(match?.file_date).toBe("2026-11-11");
		expect(match?.attributes.find((a) => a.name === "memory")).toEqual({
			name: "memory",
			value: "64 GiB",
			citation: `[lm:${SAMPLE_PATH}#NKB8DU47ZKKBXW65/attributes/memory]`,
		});
		const text = pricesText(result);
		expect(text).toContain(`1.3600000000 USD per Hrs   ${C6I_PRICE_CITATION}`);
		expect(text).toContain("the price file of 2026-11-11");
		expect(text).toContain('AWS\'s description: "$1.36 per On Demand Linux c6i.8xlarge Instance Hour"');
	});

	test("tiers come in order of their range; GET finds the Tier2 requests; gp3 finds storage, IOPS and throughput", async () => {
		const transfer = (await findPrices(data, ["transfer", "out"])).matches.filter((m) => m.rule === "data-transfer-out-to-internet");
		expect(transfer.map((m) => m.begin_range)).toEqual(["0", "10240", "51200", "153600"]);
		expect((await findPrices(data, ["GET"])).matches.map((m) => m.description)).toEqual(["$0.004 per 10,000 GET and all other requests"]);
		expect((await findPrices(data, ["gp3"])).matches.map((m) => m.rule)).toEqual(["ebs-gp3-storage", "ebs-gp3-iops", "ebs-gp3-throughput"]);
	});

	test("a price the file does not hold: says so, and lists what it holds", async () => {
		const result = await findPrices(data, ["cloudfront"]);
		expect(result.matches).toEqual([]);
		expect(result.not_held?.lines[0]).toBe(`No price in ${SAMPLE_PATH} matches all of: cloudfront.`);
		expect(result.not_held?.lines).toContain("  ec2-instance-on-demand-linux (AmazonEC2): i4i.2xlarge, m5.large, c6i.8xlarge");
		expect((await findPrices(data, ["c8i.2xlarge"])).matches).toEqual([]);
	});
});

describe("citations", () => {
	test("every citation the tool prints resolves to the number printed beside it", async () => {
		for (const series of fixture.derivations.derivations) {
			const result = await showSeries(data, [series.series.id], "all");
			if (result.found !== "one") throw new Error("expected one Series");
			const stats = [...result.series.numbers, ...result.series.group_details.flatMap((g) => g.numbers)];
			for (const n of stats) {
				for (const which of ["p5", "p50", "p95"] as const) {
					const resolved = await resolveCitation(n[which].citation.slice(4, -1), data);
					expect(resolved.ok && resolved.kind === "measured" && resolved.value).toBe(n[which].value as number);
				}
				const count = await resolveCitation(n.count_citation.slice(4, -1), data);
				expect(count.ok && count.kind === "measured" && count.value).toBe(n.count);
			}
			for (const [key, citation] of Object.entries(result.series.params_citations)) {
				const resolved = await resolveCitation(citation.slice(4, -1), data);
				expect(resolved.ok && resolved.kind === "param" && resolved.value).toBe(series.series.params[key] as string | number);
			}
		}
		for (const match of (await findPrices(data, ["us"])).matches.concat((await findPrices(data, ["requests"])).matches)) {
			const resolved = await resolveCitation(match.citation.slice(4, -1), data);
			expect(resolved.ok && resolved.kind === "price" && resolved.usd).toBe(Number(match.price_per_unit));
			for (const attribute of match.attributes) {
				const value = await resolveCitation(attribute.citation.slice(4, -1), data);
				expect(value.ok && value.kind === "attribute" && value.text).toBe(attribute.value);
			}
			for (const [citation, text] of [
				[match.begin_range_citation, match.begin_range],
				[match.end_range_citation, match.end_range],
			] as const) {
				const range = await resolveCitation(citation.slice(4, -1), data);
				expect(range.ok && range.kind === "range" && range.text).toBe(text);
			}
		}
	});

	test("one that names nothing says what it does not find", async () => {
		const cases: Array<[string, string]> = [
			["series/000000000000/bytes_per_second/p50@v1,2026-11-15T04:12:00Z", "no Series 000000000000"],
			[`series/${fixture.c6i.series.id}/bytes_per_second/p50`, "must say which data it was read from"],
			[`series/${fixture.c6i.series.id}/bytes_per_second/p99@v1,2026-11-15T04:12:00Z`, "not a LedgerMath citation"],
			[`series/${fixture.c6i.series.id}/group/B/bytes_per_second/p50@v1,2026-11-15T04:12:00Z`, "has no group B"],
			[`series/${fixture.syscall.series.id}/bytes_per_second/p50@v1,2026-11-12T04:13:00Z`, "has no bytes_per_second from a counted Run"],
			[`series/${fixture.c6i.series.id}/bytes_per_second/p50@v2,2026-11-15T04:12:00Z`, "Method series version 2"],
			[`series/${fixture.c6i.series.id}/bytes_per_second/p50@v1,2026-11-16T00:00:00Z`, "data the checker does not have"],
			[`series/${fixture.c6i.series.id}/bytes_per_second/p50@v1,2026-11-11T00:00:00Z`, "no bytes_per_second from a counted Run that started by"],
			[`series/${fixture.c6i.series.id}/params/blocks`, "has no parameter blocks"],
			["prices/2026/11/12/aws.json#NKB8DU47ZKKBXW65/NKB8DU47ZKKBXW65.JRTCKXETXF.6YS6EN2CT7", "no price file prices/2026/11/12/aws.json"],
			[`${SAMPLE_PATH}#AAAAAAAAAAAAAAAA/AAAAAAAAAAAAAAAA.JRTCKXETXF.6YS6EN2CT7`, "holds no SKU AAAAAAAAAAAAAAAA"],
			[`${SAMPLE_PATH}#NKB8DU47ZKKBXW65/NKB8DU47ZKKBXW65.JRTCKXETXF.XXXXXXXXXX`, "has no rate code"],
			[`${SAMPLE_PATH}#NKB8DU47ZKKBXW65/attributes/colour`, "has no attribute colour"],
			["benchmark/fortnite", "no benchmark fortnite"],
			["the internet", "not a LedgerMath citation"],
		];
		for (const [inside, reason] of cases) {
			const resolved = await resolveCitation(inside, data);
			expect(resolved.ok, inside).toBe(false);
			if (!resolved.ok) expect(resolved.reason).toContain(reason);
		}
	});
});

describe("a web address", () => {
	const BASE = "https://example.test/data";

	test("gives the same answers, following the tree's links from another address, with full addresses for the Runs", async () => {
		const asked: string[] = [];
		const web = await loadLedger(openLocation(BASE, { fetch: serve(fixture.directory, BASE, asked) }));
		expect(web.pricesPath).toBe(SAMPLE_PATH);
		expect(asked).toEqual([`${BASE}/v1/index.json`]);
		const result = await showSeries(web, [fixture.c6i.series.id], 1);
		if (result.found !== "one") throw new Error("expected one Series");
		expect(result.series.runs_list[0]?.link).toBe(`${BASE}/${result.series.runs_list[0]?.path}`);
		expect(asked).toEqual([`${BASE}/v1/index.json`, `${BASE}/v1/series.json`, `${BASE}/v1/series/${fixture.c6i.series.id}.json`]);
		expect(showText(result).replaceAll(`${BASE}/`, "")).toBe(showText(await showSeries(data, [fixture.c6i.series.id], 1)));
		expect((await findPrices(web, ["c6i.8xlarge"])).matches[0]?.citation).toBe(C6I_PRICE_CITATION);
		expect(asked.at(-1)).toBe(`${BASE}/v1/prices/2026-11-11.json`);
	});
});

describe("the script", () => {
	async function lookup(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		const child = Bun.spawn(["bun", join(ROOT, "scripts", "lookup.ts"), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LEDGERMATH_DATA: "" } });
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { code, stdout, stderr };
	}

	test("prints the same text twice, and the same answer as JSON", async () => {
		const first = await lookup("--data", fixture.directory, "show", fixture.c6i.series.id);
		const second = await lookup("--data", fixture.directory, "show", fixture.c6i.series.id);
		expect(first.code).toBe(0);
		expect(first.stdout).toBe(second.stdout);
		expect(first.stdout).toBe(showText(await showSeries(data, [fixture.c6i.series.id], 10)));
		const json = await lookup("--data", fixture.directory, "--json", "prices", "c6i.8xlarge");
		expect(JSON.parse(json.stdout)).toEqual(await findPrices(data, ["c6i.8xlarge"]));
	});

	test("a usage or data error exits 2 and says why, in words", async () => {
		expect((await lookup("frobnicate")).code).toBe(2);
		expect((await lookup("--data", fixture.directory, "show")).code).toBe(2);
		const missing = await lookup("--data", join(fixture.directory, "nowhere"), "about");
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain("No LedgerMath data at");
		expect(missing.stderr).not.toContain("    at ");
		expect((await lookup("--data", fixture.directory, "--runs", "0", "show", "x")).code).toBe(2);
		expect((await lookup("--data", fixture.directory, "--prices-date", "2026-11-12", "about")).stderr).toContain("no price file for 2026-11-12");
	});
});
