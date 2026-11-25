import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { SeriesDerivation } from "../methods/v1/output";
import { checkAnswer, type CheckReport, type NumberStatus } from "../scripts/lib/answer-check";
import { citationMismatch, NUMBERS, parameterUnit, seriesMoment, statAt } from "../scripts/lib/citation";
import { type LedgerData, loadLedger, openLocation, type TreeSeries } from "../scripts/lib/ledger-data";
import { findPrices, type PriceMatch } from "../scripts/lib/lookup";
import { agrees, parseUnit, type Quantity, quantities, quantityWords } from "../scripts/lib/quantity";
import { type Fixture, makeFixture } from "./lookup-fixtures";

setDefaultTimeout(60_000);

const ROOT = resolve(import.meta.dir, "..");
let fixture: Fixture;
let data: LedgerData;
/** The prices each word finds, read once. */
const prices: Record<string, PriceMatch[]> = {};
/** The memory_read Series on c6i.8xlarge, as its Series file holds it. */
let memoryFile: TreeSeries;

beforeAll(async () => {
	fixture = await makeFixture();
	data = await loadLedger(openLocation(fixture.directory));
	for (const word of ["data-transfer-out-to-internet", "m5.large", "ebs-gp3-throughput", "GET"]) prices[word] = (await findPrices(data, [word])).matches;
	memoryFile = (await data.series(fixture.c6i.series.id)) as TreeSeries;
});
afterAll(() => rmSync(fixture.directory, { recursive: true, force: true }));

describe("reading numbers", () => {
	const one = (text: string): { written: number; half: number; dims: object; value: number } => {
		const [q] = quantities(text);
		if (q === undefined) throw new Error(`no number in ${text}`);
		return { written: q.written, half: q.half, dims: q.unit.dims, value: q.value };
	};

	test("with signs, leading decimal points, scale words, exponents and whole units", () => {
		expect(one("30 million players")).toEqual({ written: 3e7, half: 5e5, dims: {}, value: 3e7 });
		expect(one("30,000,000")).toEqual({ written: 3e7, half: 0.5, dims: {}, value: 3e7 });
		expect(one("3.7e7 requests per second")).toEqual({ written: 3.7e7, half: 5e5, dims: { req: 1, s: -1 }, value: 3.7e7 });
		expect(one(".57 µs").written).toBe(0.57);
		expect(one("$.096 per hour")).toEqual({ written: 0.096, half: 0.0005, dims: { USD: 1, s: -1 }, value: 0.096 / 3600 });
		expect(one("-$0.096 per hour").written).toBe(-0.096);
		expect(one("−112.2 MB/s")).toEqual({ written: -112.2, half: 0.05, dims: { B: 1, s: -1 }, value: -112.2e6 });
		expect(one("112.27 MB/h").value).toBeCloseTo(112.27e6 / 3600, 6);
		expect(one("112.27 MB")).toEqual({ written: 112.27, half: 0.005, dims: { B: 1 }, value: 112.27e6 });
		expect(one("0.1 GiB/s").value).toBe(0.1 * 2 ** 30);
		expect(one("12500 Megabit")).toEqual({ written: 12500, half: 0.5, dims: { B: 1 }, value: 12500e6 / 8 });
		expect(one("10000 Mbps").dims).toEqual({ B: 1, s: -1 });
		expect(one("$0.08 per GB-month").dims).toEqual({ USD: 1, B: -1, s: -1 });
		expect(one("$0.40 per 1000000 requests").value).toBeCloseTo(4e-7, 15);
		expect(one("64-byte messages")).toEqual({ written: 64, half: 0.5, dims: { B: 1 }, value: 64 });
		expect(one("77%")).toEqual({ written: 77, half: 0.5, dims: {}, value: 0.77 });
		expect(one("10^9").written).toBe(1e9);
		expect(one("1.5 × 10^15 bytes").value).toBe(1.5e15);
		expect(one('{"egress_gbps":777}').written).toBe(777);
		expect(one("bandwidth=777").written).toBe(777);
		expect(quantities("77-99 GB/s").map((q) => q.written)).toEqual([77, 99]);
	});

	test("never inside a name", () => {
		expect(quantities("c6i.8xlarge in use2-az3 and us-east-2, p50 and p95, S3 and gp3 on x86_64, AVX-512, HTTP/2, Xeon 8375C, SKU 8D49XP354UEYTHGM, the 5th")).toEqual([]);
	});

	test("AWS's units", () => {
		expect(parseUnit("Hrs")).toEqual({ dims: { s: 1 }, factor: 3600, text: "Hrs" });
		expect(parseUnit("GB-Mo")?.dims).toEqual({ B: 1, s: 1 });
		expect(parseUnit("GiBps-mo")?.factor).toBe(2 ** 30 * 730 * 3600);
		expect(parseUnit("IOPS-Mo")?.dims).toEqual({ io: 1 });
		expect(parseUnit("Requests")?.dims).toEqual({ req: 1 });
	});

	test("a written number is every value that rounds to it at its last digit, and no value exactly halfway", () => {
		const [rounded] = quantities("112 MB/s");
		const [cents] = quantities("$0.10 per hour");
		const [tier] = quantities("$0.09 per GB");
		expect(agrees(rounded as never, 112268969, { B: 1, s: -1 })).toBe(true);
		expect(agrees(rounded as never, 112268969, { B: 1 })).toBe(false);
		expect(agrees(cents as never, 0.096 / 3600, { USD: 1, s: -1 })).toBe(true);
		expect(agrees(tier as never, 0.085 / 1e9, { USD: 1, B: -1 })).toBe(false);
	});

	test("number words state a quantity only with a magnitude word or a unit after them", () => {
		const phrases = (text: string): string[] => quantityWords(text).map((w) => w.phrase);
		expect(phrases("thirty million requests per second")).toEqual(["thirty million"]);
		expect(phrases("two GB per player, five seconds, ten percent, a thousand machines")).toEqual(["two", "five", "ten", "thousand"]);
		expect(phrases("one hundred and twenty players, thirty-two GiB")).toEqual(["one hundred and twenty", "thirty-two"]);
		expect(phrases("Two limits apply to two machines and two c6i.8xlarge instances; thousands of players, two us-east-2 boxes")).toEqual([]);
	});
});

interface Context {
	tcp: SeriesDerivation;
	memory: SeriesDerivation;
	rate: number;
	time: number;
	rateCitation: string;
	timeCitation: string;
	countCitation: string;
	links: string;
	price: PriceMatch;
	egress: PriceMatch;
	secondTier: PriceMatch;
	gp3: PriceMatch;
	get: PriceMatch;
}

function context(): Context {
	const tcp = fixture.tcp;
	const memory = fixture.c6i;
	const at = seriesMoment(tcp);
	const transfer = prices["data-transfer-out-to-internet"] as PriceMatch[];
	return {
		tcp,
		memory,
		rate: tcp.percentiles.bytes_per_second?.p50 as number,
		time: tcp.percentiles.time_per_repetition_ns?.p50 as number,
		rateCitation: `[lm:series/${tcp.series.id}/bytes_per_second/p50@v1,${at}]`,
		timeCitation: `[lm:series/${tcp.series.id}/time_per_repetition_ns/p50@v1,${at}]`,
		countCitation: `[lm:series/${tcp.series.id}/bytes_per_second/count@v1,${at}]`,
		links: tcp.runs.map((r) => r.path).join("\n"),
		price: prices["m5.large"]?.[0] as PriceMatch,
		egress: transfer.find((p) => p.begin_range === "0" && p.end_range === "10240") as PriceMatch,
		secondTier: transfer.find((p) => p.begin_range === "10240") as PriceMatch,
		gp3: prices["ebs-gp3-throughput"]?.[0] as PriceMatch,
		get: prices.GET?.[0] as PriceMatch,
	};
}

const memoryCitation = (c: Context, stat: "p5" | "p95"): string => `[lm:series/${c.memory.series.id}/bytes_per_second/${stat}@v1,${seriesMoment(c.memory)}]`;
const memoryRate = (c: Context, stat: "p5" | "p95"): number => (c.memory.percentiles.bytes_per_second?.[stat] as number) / 1e9;
const date = ", price file of 2026-11-11";

/**
 * The reviewer's cases of 2026-11-11 (review7/answers), on this fixture's data:
 * the tcp_echo Series stands for the SHA-256 one, memory_read on c6i.8xlarge for
 * the memory one; the prices are the same SKUs. Each gives the verdict the one
 * rule gives.
 */
const CASES: Array<{ name: string; answer: (c: Context) => string; question?: string; pass: boolean }> = [
	{ name: "unresolved-citation", answer: () => "Bandwidth is 777 GB/s [lm:series/000000000000/bytes_per_second/p50@v1,2026-11-11T00:00:00Z].", pass: false },
	{ name: "p99-citation", answer: (c) => `${c.rate / 1e6} MB/s [lm:series/${c.tcp.series.id}/bytes_per_second/p99@v1,${seriesMoment(c.tcp)}]\n${c.links}`, pass: false },
	{ name: "missing-run-link", answer: (c) => `${c.rate / 1e6} MB/s ${c.rateCitation}`, pass: false },
	{ name: "json-code-number", answer: () => '```json\n{"egress_gbps":777}\n```', pass: false },
	{ name: "assignment-code-number", answer: () => "```sh\nbandwidth=777\n```", pass: false },
	{ name: "reused-unitless-into-physical-claim", answer: () => "Workers: 1 [assumption: chosen layout].\nMemory bandwidth is 1 PB/s.", pass: false },
	{ name: "correct-rounded-price-6pct", answer: (c) => `$0.10176 per hour ${c.price.citation}${date}.`, pass: false },
	{ name: "param-count-used-as-bandwidth", answer: (c) => `Throughput is 32768 GB/s [lm:series/${c.tcp.series.id}/params/size_bytes]\n${c.links}`, pass: false },
	{ name: "benchmark-words-used-as-bandwidth", answer: () => "Hash throughput is 64 GB/s [lm:benchmark/hash].", pass: false },
	{ name: "bad-url-with-real-run-path", answer: (c) => `${c.rate / 1e6} MB/s ${c.rateCitation}\nhttps://does-not-exist.invalid/${c.tcp.runs[0]?.path}`, pass: false },
	{ name: "unmatched-spaced-citation", answer: () => "Bandwidth = 777 GB/s [lm:series/unknown/bytes_per_second/p50 broken]", pass: false },
	{ name: "correct-price-leading-decimal", answer: (c) => `Price is $.096 per hour ${c.price.citation}${date}.`, pass: true },
	{ name: "wrong-negative-price", answer: (c) => `Price is -$0.096 per hour ${c.price.citation}${date}.`, pass: false },
	{ name: "rate-word-denominator", answer: (c) => `Throughput is ${c.rate / 1e6} MB per minute ${c.rateCitation}\n${c.links}`, pass: false },
	{ name: "question-time-scale-reused", answer: () => "Capacity is 1000 TB/s.", question: "What does 1 TB/s cost?", pass: false },
	{ name: "question-number-unit-reused", answer: () => "The fleet costs $1 per hour.", question: "What does 1 TB/s cost?", pass: false },
	{ name: "measured-plus-4pct-precise", answer: (c) => `${(c.rate * 1.04) / 1e6} MB/s ${c.rateCitation}\n${c.links}`, pass: false },
	{ name: "price-plus-4pct-rounded", answer: (c) => `Price is $0.10 per hour ${c.price.citation}${date}.`, pass: true },
	{ name: "measured-plus-6pct", answer: (c) => `${(c.rate * 1.06) / 1e6} MB/s ${c.rateCitation}\n${c.links}`, pass: false },
	{ name: "rate-times-1000-units", answer: (c) => `Throughput is ${c.rate / 1e6} GB/s ${c.rateCitation}\n${c.links}`, pass: false },
	{ name: "time-times-1000-units", answer: (c) => `Latency is ${c.time / 1e3} ms ${c.timeCitation}\n${c.links}`, pass: false },
	{ name: "binary-vs-decimal", answer: (c) => `Throughput is ${c.rate / 1e6} MiB/s ${c.rateCitation}\n${c.links}`, pass: false },
	{ name: "binary-vs-decimal-coarse", answer: (c) => `Throughput is 2 GiB/s ${c.rateCitation}\n${c.links}`, pass: true },
	{ name: "rate-unit-hour", answer: (c) => `Throughput is ${c.rate / 1e6} MB/h ${c.rateCitation}\n${c.links}`, pass: false },
	{ name: "rate-omitted-denominator", answer: (c) => `Total bytes processed is ${c.rate / 1e6} MB ${c.rateCitation}\n${c.links}`, pass: false },
	{ name: "price-times-1000", answer: (c) => `Price is $96 per hour ${c.price.citation}${date}.`, pass: false },
	{ name: "price-times-1024", answer: (c) => `Price is $${Number(c.price.price_per_unit) * 1024} per hour ${c.price.citation}${date}.`, pass: false },
	{ name: "price-binary-vs-decimal-plain", answer: (c) => `gp3 throughput costs $40 per GiBps-month ${c.gp3.citation}${date}.`, pass: false },
	{ name: "price-wrong-time-unit", answer: (c) => `Price is $0.096 per second ${c.price.citation}${date}.`, pass: false },
	{ name: "price-wrong-denominator", answer: (c) => `Egress costs $0.09 per TB ${c.egress.citation}${date}.`, pass: false },
	{ name: "right-sku-wrong-tier-value", answer: (c) => `First-tier egress is $0.09 per GB ${c.secondTier.citation}${date}.`, pass: false },
	// The checker reads numbers, not meaning: the cited tier's price, called the first tier's, passes.
	{ name: "right-price-wrong-tier-context", answer: (c) => `First-tier egress is $0.085 per GB ${c.secondTier.citation}${date}.`, pass: true },
	{ name: "different-series", answer: (c) => `Throughput is ${memoryRate(c, "p95")} GB/s ${c.rateCitation}\n${c.links}`, pass: false },
	// The same: the right number, said of another instance type, passes.
	{ name: "different-series-context", answer: (c) => `c8i.2xlarge throughput is ${c.rate / 1e6} MB/s ${c.rateCitation}\n${c.links}`, pass: true },
	{ name: "moved-citation-nearest", answer: (c) => `Actual rate ${c.rate / 1e6} MB/s; claimed rate 999999 MB/s ${c.rateCitation}\n${c.links}`, pass: false },
	{ name: "moved-citation-derived", answer: (c) => `Actual rate ${c.rate / 1e6} MB/s; throughput = 999999 MB/s ${c.rateCitation}\n${c.links}`, pass: false },
	{ name: "table-number", answer: () => "| Limit | Value |\n|---|---|\n| Egress | 777 GB/s |", pass: false },
	{ name: "code-number", answer: () => "```\nEgress capacity 777 GB/s\n```", pass: false },
	{ name: "words-number", answer: () => "The server handles thirty million requests per second.", pass: false },
	{ name: "separated-number", answer: () => "The server handles 37,000,000 requests per second.", pass: false },
	{ name: "scientific-number", answer: () => "The server handles 3.7e7 requests per second.", pass: false },
	{ name: "percentage-number", answer: () => "CPU utilization is 77%.", pass: false },
	{ name: "range-number", answer: () => "Capacity is 77 to 99 GB/s.", pass: false },
	{ name: "empty-assumption", answer: () => "Capacity is 77 GB/s [assumption:].", pass: false },
	{ name: "nonsense-assumption", answer: () => "Capacity is 77 GB/s [assumption: ???].", pass: false },
	{ name: "assignment-pretends-arithmetic", answer: () => "Egress capacity = 777 GB/s.", pass: false },
	{ name: "wrong-inputs-arithmetic", answer: () => "Capacity: 777 GB/s × 999 = 776223 GB/s.", pass: false },
	{ name: "constant-inputs-arithmetic", answer: () => "Machines = 1000000000000000000 × 730 = 730000000000000000000\nWe need 730000000000000000000 machines.", pass: false },
	{ name: "per-number", answer: () => "The cluster delivers one update per 777 seconds.", pass: false },
	{ name: "fake-run-count", answer: () => "Measurements cover 999999999 Runs and 999999999 boots.", pass: false },
	{ name: "fake-box-count", answer: () => "We need 999999999 boxes.", pass: false },
	// A repeat of a cited number with the same unit passes, whatever it is said of.
	{ name: "reused-value-other-context", answer: (c) => `Throughput is ${c.rate / 1e6} MB/s ${c.rateCitation}.\n${c.links}\nWAN throughput is ${c.rate / 1e6} MB/s.`, pass: true },
	{ name: "unitless-scale-value", answer: (c) => `Bandwidth is ${c.rate / 1e3} ${c.rateCitation}\n${c.links}`, pass: false },
	{ name: "negative-value", answer: (c) => `Throughput is -${c.rate / 1e6} MB/s ${c.rateCitation}\n${c.links}`, pass: false },
	{ name: "correct-rounding", answer: (c) => `Throughput is ${Math.round(c.rate / 1e6)} MB/s ${c.rateCitation}\n${c.links}`, pass: true },
	{ name: "correct-binary-conversion", answer: (c) => `Throughput is ${c.rate / 2 ** 20} MiB/s ${c.rateCitation}\n${c.links}`, pass: true },
	{ name: "correct-time-conversion", answer: (c) => `Latency is ${c.time / 1000} µs ${c.timeCitation}\n${c.links}`, pass: true },
	{
		name: "correct-p5-p95-range",
		answer: (c) => `Range is ${memoryRate(c, "p5")} GB/s ${memoryCitation(c, "p5")} to ${memoryRate(c, "p95")} GB/s ${memoryCitation(c, "p95")}\n${c.memory.runs[0]?.path}`,
		pass: true,
	},
	{
		name: "correct-shared-unit-range",
		answer: (c) => `Range is ${memoryRate(c, "p5")} ${memoryCitation(c, "p5")} to ${memoryRate(c, "p95")} GB/s ${memoryCitation(c, "p95")}\n${c.memory.runs[0]?.path}`,
		pass: true,
	},
	// Rescaling a price is a line of arithmetic; written with the citation, it is not AWS's unit.
	{ name: "correct-request-scaling", answer: (c) => `GET costs $0.40 per 1000000 requests ${c.get.citation}${date}.`, pass: false },
	{ name: "correct-nanoseconds-leading-decimal", answer: (c) => `Latency is .${String(c.time / 1e6).split(".")[1]} ms ${c.timeCitation}\n${c.links}`, pass: true },
	{
		name: "correct-range-only-last-unit",
		answer: (c) => `Range is ${memoryRate(c, "p5")}–${memoryRate(c, "p95")} GB/s ${memoryCitation(c, "p95")}\n${c.memory.runs[0]?.path}`,
		pass: false,
	},
];

describe("the reviewer's cases", () => {
	test("all 62 are here, once each", () => {
		expect(new Set(CASES.map((c) => c.name)).size).toBe(62);
	});
	for (const c of CASES) {
		test(`${c.name}: ${c.pass ? "passes" : "fails"}`, async () => {
			const report = await checkAnswer(c.answer(context()), data, c.question ?? "");
			expect(report.pass, JSON.stringify(report.problems)).toBe(c.pass);
		});
	}
});

const statusOf = (report: CheckReport, text: string): NumberStatus[] => report.numbers.filter((n) => n.text === text).map((n) => n.status);

describe("an answer written as the skill says", () => {
	const QUESTION = "How long does one c6i.8xlarge take to read 48 GiB held in memory once, and what does that cost?";
	const answer = (c: Context): string => {
		const memory = c.memory;
		const at = seriesMoment(memory);
		return [
			"**Inputs**",
			`- Data: 48 GiB, from the question; it fits in the box's 64 GiB [lm:prices/2026/11/11/aws.json#NKB8DU47ZKKBXW65/attributes/memory].`,
			`- Read bandwidth: p5 ${memoryRate(c, "p5").toFixed(2)} GB/s ${memoryCitation(c, "p5")}, p50 134.22 GB/s [lm:series/${memory.series.id}/bytes_per_second/p50@v1,${at}], p95 ${memoryRate(c, "p95").toFixed(2)} GB/s ${memoryCitation(c, "p95")}, from 3 Runs [lm:series/${memory.series.id}/bytes_per_second/count@v1,${at}].`,
			`- Price: $1.36 per hour [lm:prices/2026/11/11/aws.json#NKB8DU47ZKKBXW65/NKB8DU47ZKKBXW65.JRTCKXETXF.6YS6EN2CT7]${date}.`,
			"- Share of the bandwidth a real program keeps: 80% [assumption: a guess for a scan that does little per byte].",
			"",
			"**Arithmetic**",
			"- 48 GiB = 51.54 GB",
			"- Usable bandwidth: 134.22 GB/s × 80% = 107.38 GB/s",
			"- Central: 51.54 GB ÷ 107.38 GB/s = 0.48 s",
			"- Cost: 0.48 s × $1.36 per hour = $0.00018",
			"- Per day of such reads: 0.48 s ÷ 3600 × 24 = 0.0032 → 0.004",
			"",
			"**Answer**: about 0.48 s, $0.00018; 3 Runs, so the spread is that of 3 boxes.",
			"",
			`**Sources**: ${memory.runs[0]?.path}, https://github.com/smrdotgg/ledgermath-runs/blob/main/${memory.runs[1]?.path}`,
		].join("\n");
	};

	test("passes, every number accounted for in one of the five ways", async () => {
		const report = await checkAnswer(answer(context()), data, QUESTION);
		expect(report.problems).toEqual([]);
		expect(statusOf(report, "48 GiB")).toEqual(["question", "question"]);
		expect(statusOf(report, "64 GiB")).toEqual(["cited"]);
		expect(statusOf(report, "134.22 GB/s")).toEqual(["cited", "repeat"]);
		expect(statusOf(report, "3")).toEqual(["cited", "repeat", "repeat"]);
		expect(statusOf(report, "80%")).toEqual(["assumption", "repeat"]);
		expect(statusOf(report, "51.54 GB")).toEqual(["question", "question"]);
		expect(statusOf(report, "107.38 GB/s")).toEqual(["derived", "repeat"]);
		expect(statusOf(report, "0.48 s")).toEqual(["derived", "repeat", "repeat", "repeat"]);
		expect(statusOf(report, "$0.00018")).toEqual(["derived", "repeat"]);
		expect(statusOf(report, "3600")).toEqual(["constant"]);
		expect(statusOf(report, "0.004")).toEqual(["derived"]);
	});

	test("fails when arithmetic is wrong, drops a unit, or uses an operand nobody accounted for", async () => {
		const c = context();
		const wrong = await checkAnswer(answer(c).replace("= 0.48 s", "= 0.52 s"), data, QUESTION);
		expect(wrong.problems.some((p) => p.message.startsWith('"0.52 s" does not follow from the arithmetic on its line'))).toBe(true);
		const dropped = await checkAnswer(answer(c).replace("0.48 s × $1.36 per hour = $0.00018", "0.48 s × $1.36 = $0.00018"), data, QUESTION);
		expect(dropped.problems.some((p) => p.message.startsWith('"$1.36" is not accounted for'))).toBe(true);
		const result = await checkAnswer(answer(c).replace("× $1.36 per hour = $0.00018", "× $1.36 per hour = $0.00018 per hour"), data, QUESTION);
		expect(result.problems.some((p) => p.message.includes("does not follow from the arithmetic on its line") && p.message.includes("where the result is written in US dollars per second"))).toBe(true);
		const invented = await checkAnswer(answer(c).replace("× 80% =", "× 90% ="), data, QUESTION);
		expect(invented.problems.some((p) => p.message.startsWith('"90%" is not accounted for'))).toBe(true);
	});
});

describe("a citation of the Series as of a moment", () => {
	test("recomputed at the Series' own moment, every statistic is the Derivation's", () => {
		for (const series of fixture.derivations.derivations) {
			const moment = seriesMoment(series);
			for (const number of NUMBERS) {
				for (const group of [null, ...series.groups.map((g) => g.id)]) {
					const stored = group === null ? series.percentiles[number] : series.groups.find((g) => g.id === group)?.percentiles[number];
					if (stored === null || stored === undefined) continue;
					for (const stat of ["p5", "p50", "p95", "count"] as const) {
						expect(statAt(series.points, number, stat, group, moment)?.value).toBe(stat === "count" ? stored.count : stored[stat]);
					}
				}
			}
		}
	});

	test("of an earlier moment: checked against the Runs that had started by then, with a note", async () => {
		const series = fixture.c6i; // counted Runs on 11-12, 11-13 and 11-14 (7, 8 and 9 ms), a failed one on 11-15
		const earlier = `[lm:series/${series.series.id}/time_per_repetition_ns/p50@v1,2026-11-13T04:12:00Z]`;
		const link = series.runs[0]?.path;
		const ok = await checkAnswer(`p50 7.5 ms ${earlier}\n${link}`, data);
		expect(ok.pass).toBe(true);
		expect(ok.notes[0]?.message).toContain("so it was checked against the 2 counted Runs that started by 2026-11-13T04:12:00Z");
		const now = await checkAnswer(`p50 8 ms ${earlier}\n${link}`, data);
		expect(now.problems[0]?.message).toContain("expected 7.5 ms (the cited value is 7500000 ns); found 8 ms");
	});

	test("of a later moment than the data loaded, or another Method version: a problem", async () => {
		const series = fixture.c6i;
		const link = series.runs[0]?.path;
		const later = await checkAnswer(`p50 8 ms [lm:series/${series.series.id}/time_per_repetition_ns/p50@v1,2026-11-20T00:00:00Z]\n${link}`, data);
		expect(later.problems[0]?.message).toContain("hold its Runs only to 2026-11-15T04:12:00Z: it is of data the checker does not have");
		const version = await checkAnswer(`p50 8 ms [lm:series/${series.series.id}/time_per_repetition_ns/p50@v2,2026-11-15T04:12:00Z]\n${link}`, data);
		expect(version.problems[0]?.message).toContain("Method series version 2");
		const bare = await checkAnswer(`p50 8 ms [lm:series/${series.series.id}/time_per_repetition_ns/p50]\n${link}`, data);
		expect(bare.problems[0]?.message).toContain("must say which data it was read from");
	});
});

describe("a tier's range", () => {
	test("is cited in AWS's unit; Inf cites nothing", async () => {
		const c = context();
		const end = c.egress.end_range_citation as string;
		expect((await checkAnswer(`The first tier ends at 10240 GB ${end}.`, data)).pass).toBe(true);
		// 10 TB stands for 9.5 to 10.5 TB, which holds 10240 GB; 10000 GB does not.
		expect((await checkAnswer(`The first tier ends at 10 TB ${end}.`, data)).pass).toBe(true);
		expect((await checkAnswer(`The first tier ends at 10000 GB ${end}.`, data)).problems[0]?.message).toContain("expected 10240 GB, the tier's endRange; found 10000 GB");
		// The last tier's end is AWS's word "Inf": cited as it is, it accounts for no number, and a number before it does not match.
		const last = (await findPrices(data, ["data-transfer-out-to-internet"])).matches.find((p) => p.end_range === "Inf") as PriceMatch;
		expect(last.end_range_citation).toBe(`[lm:${last.file}#${last.sku}/${last.rate_code}/endRange]`);
		const inf = await checkAnswer(`The last tier has no end: Inf ${last.end_range_citation}.`, data);
		expect(inf.pass).toBe(true);
		expect(inf.notes).toEqual([]);
		const number = await checkAnswer(`It ends at 999 GB ${last.end_range_citation}.`, data);
		expect(number.problems[0]?.message).toContain('the tier\'s endRange is AWS\'s word "Inf", which states no number; found 999 GB');
	});
});

/**
 * What careful writers wrote in the trial of 2026-11-11 that the checker
 * rejected: each harmless form passes, and its nearest harmful neighbour
 * still fails.
 */
describe("what a careful writer writes", () => {
	const fails = async (answer: string, question = ""): Promise<string[]> => (await checkAnswer(answer, data, question)).problems.map((p) => p.message);

	test("number words: prose and the question's own words pass; a quantity in words fails", async () => {
		expect(await fails("Two limits apply: we need two machines.")).toEqual([]);
		expect(await fails("The two c6i.8xlarge instances share a zone.", "What is the latency between two c6i.8xlarge instances?")).toEqual([]);
		expect(await fails("The server handles thirty million requests per second.")).toEqual(['"thirty million" states a quantity in words; write it in digits, so it can be checked']);
		expect(await fails("Each player downloads two GB.")).toEqual(['"two" states a quantity in words; write it in digits, so it can be checked']);
		expect(await fails("Each player downloads five GB.", "What do two c6i.8xlarge instances cost?")).toHaveLength(1);
	});

	test("dates with a month's name and a price file's path pass; a number beside them still counts", async () => {
		expect(await fails("Prices of November 11, 2026 (11 November 2026, Nov. 11 2026, November 2026), from prices/2026/11/11/aws.json and kit/data/prices/2026/11/11/aws.json.")).toEqual([]);
		expect(await fails("In November 2026 we need 11 machines.")).toEqual([
			'"11" is not accounted for: nothing cites it, marks it as an assumption or computes it, and the same value and unit is neither in the question nor stated by a number accounted for. To fix, put a citation or [assumption: <source>] right after it, or show the arithmetic that gives it.',
		]);
		expect(await fails("November 30 instances are needed.")).toHaveLength(1);
		expect(await fails("prices/2026/11/11/aws.json lists 777 GB.")).toHaveLength(1);
	});

	test("a Run linked by a relative path passes; one under a host does not", async () => {
		const c = context();
		const path = c.tcp.runs[0]?.path as string;
		const base = `${c.time} ns ${c.timeCitation}\n`;
		for (const link of [`../../kit/data/${path}`, `kit/data/${path}`, `[the Run](../data/${path})`]) expect(await fails(base + link), link).toEqual([]);
		for (const link of [`example.com/${path}`, `//example.com/${path}`, `/srv/data/${path}`, `https://example.com/${path}`]) {
			expect((await fails(base + link)).some((m) => m.startsWith(`Run link: ${link} is neither`)), link).toBe(true);
		}
	});

	test("a range writes its unit once; an end with a unit of its own keeps it", async () => {
		const c = context();
		const inputs = `p5 ${memoryRate(c, "p5").toFixed(2)} GB/s ${memoryCitation(c, "p5")}\np95 ${memoryRate(c, "p95").toFixed(2)} GB/s ${memoryCitation(c, "p95")}\n${c.memory.runs[0]?.path}\n`;
		expect(await fails(`${inputs}Range: ${memoryRate(c, "p5").toFixed(2)} to ${memoryRate(c, "p95").toFixed(2)} GB/s.`)).toEqual([]);
		expect(await fails(`${inputs}Range: ${memoryRate(c, "p5").toFixed(2)} GB to ${memoryRate(c, "p95").toFixed(2)} GB/s.`)).toHaveLength(1);
		const prices = `m5.large: $0.096 per hour ${c.price.citation}\nc6i.8xlarge: $1.36 per hour [lm:prices/2026/11/11/aws.json#NKB8DU47ZKKBXW65/NKB8DU47ZKKBXW65.JRTCKXETXF.6YS6EN2CT7]\n`;
		expect(await fails(`${prices}From $0.096 to $1.36 per hour.`)).toEqual([]);
		expect(await fails(`${prices}From $0.096 per month to $1.36 per hour.`)).toHaveLength(1);
	});

	test("AWS's words quoted verbatim beside their citation pass; an altered quote, or one away from it, does not", async () => {
		const c = context();
		expect(await fails(`GET costs $0.0000004 per request ${c.get.citation}, in AWS's words "${c.get.description}".`)).toEqual([]);
		expect(await fails(`GET costs $0.0000004 per request ${c.get.citation}, in AWS's words \u201c${c.get.description}\u201d.`)).toEqual([]);
		expect(await fails(`GET costs $0.0000004 per request ${c.get.citation}, in AWS's words "$0.004 per 1,000 GET and all other requests".`)).not.toEqual([]);
		expect(await fails(`GET costs $0.0000004 per request ${c.get.citation}.\nIn AWS's words: "${c.get.description}".`)).not.toEqual([]);
	});

	test("a whole number right after a label word is a label; a quantity there is not", async () => {
		const c = context();
		expect(await fails(`Tier 1 price: $0.096 per hour ${c.price.citation}\nStep 2, Scenario 3, Option 4, Case 5, Phase 6, Line 7, Table 8, Figure 9 and Section 10 hold nothing.`)).toEqual([]);
		expect(await fails("Case 777 GB/s is the worst.")).toHaveLength(1);
		expect(await fails("Tier 1 needs 777 machines.")).toHaveLength(1);
	});

	test("a marker wrapped onto the next line is read to its bracket; one never closed is a problem", async () => {
		expect(await fails("Update size: 20 GB [assumption: my guess for a\n  large game's patch].")).toEqual([]);
		const wrapped = "Price: $1.36 per hour [lm:prices/2026/11/11/aws.json#NKB8DU47ZKKBXW65/\nNKB8DU47ZKKBXW65.JRTCKXETXF.6YS6EN2CT7].";
		expect(await fails(wrapped)).toEqual([]);
		const open = await fails("Update size: 20 GB [assumption: my guess\n\nNext paragraph.");
		expect(open.some((m) => m.includes("it has no closing ]"))).toBe(true);
	});

	test("key=value of a cited Series is its parameter text; any other is a number", async () => {
		const c = context();
		const cited = `tcp_echo, \`size_bytes=32768\`: ${c.time / 1000} µs ${c.timeCitation}\n${c.links}`;
		expect(await fails(cited)).toEqual([]);
		expect(await fails(cited.replace("size_bytes=32768", "size_bytes=65536"))).toHaveLength(1);
		expect(await fails("tcp_echo was run with `size_bytes=32768`.")).toHaveLength(1);
	});

	test("two numbers without dimensions repeat each other only in the same unit", async () => {
		expect(await fails("Conversion: 1000 GB per TB [assumption: decimal prefixes].\nWe need 1 machine.")).toHaveLength(1);
		expect(await fails("Share kept: 50% [assumption: a guess].\nThat is 50% of the bandwidth.")).toEqual([]);
	});
});

/**
 * What the second trial (2026-11-12) showed: honest lines of arithmetic
 * rejected for how their units were worded, one mistake reported dozens of
 * times, messages nobody could act on, a benchmark citation taking a number,
 * a parameter with its unit in its name. Each passes now; its nearest wrong
 * neighbour still fails.
 */
describe("the second trial's lines", () => {
	const QUESTION = "A service reads 10 million 4 KiB objects a day. How many durable writes per second can one thread make?";
	const fails = async (answer: string, question = QUESTION): Promise<string[]> => (await checkAnswer(answer, data, question)).problems.map((p) => p.message);
	const time = (): string => `Time per write: 14.5 µs ${context().timeCitation}\n${context().links}`;

	test("a line passes when its result follows as plain numbers, even if its units are worded loosely", async () => {
		expect(await fails("Month: 30 days [assumption: a 30-day month]\nMonthly: 10000000 per day × 30 days = 300000000")).toEqual([]);
		expect(await fails("Monthly: 10000000 per day × 30 days [assumption: a 30-day month] = 300000000 GETs per month")).toEqual([]);
		expect(await fails("Reads: 10000000 GETs per day, from the question.")).toEqual([]);
		expect(await fails(`${time()}\nHalf of them: 10000000 GETs per day × 50% [assumption: the median's half] = 5000000 GETs per day\nSerial time: 5000000 GETs per day × 14.5 µs per GET = 72500000 µs per day`)).toEqual([]);
	});

	test("its nearest wrong neighbours fail: a result that follows neither way, an operand nobody accounted for", async () => {
		const wrong = await fails("Month: 30 days [assumption: a 30-day month]\nMonthly: 10000000 per day × 30 days = 3000000000");
		expect(wrong).toHaveLength(1);
		expect(wrong[0]).toContain(
			'"3000000000" does not follow from the arithmetic on its line: expected about 300000000 (294999985 to 305000015, given how its operands are rounded), from the numbers as written and with their units',
		);
		expect(wrong[0]).toContain("found 3000000000. To fix, write the result its operands give, or correct the operand that is wrong.");
		const unaccounted = await fails("Monthly: 10000000 per day × 31 days = 310000000");
		expect(unaccounted[0]).toContain('"31 days" is not accounted for');
		expect(unaccounted[0]).toContain("1 other number depends on it and is not reported separately (line 1)");
	});

	test("a rate from a time: things per second is 1 ÷ seconds per thing, or a unit conversion ÷ the time", async () => {
		expect(await fails(`${time()}\nRate: 1 ÷ 14.5 µs per write = 68965.5 writes per second`)).toEqual([]);
		expect(await fails(`${time()}\nRate: 1000000 µs per second ÷ 14.5 µs per write = 68965.5 writes/s`)).toEqual([]);
		expect(await fails(`${time()}\nRate: 1 ÷ 14.5 µs per write = 68965.5 writes per hour`)).toHaveLength(1);
	});

	test("a rounding with an arrow, and a figure repeated in prose, may have fewer digits; a wrong one may not", async () => {
		const rate = `${time()}\nRate: 1 ÷ 14.5 µs per write = 68965.5 writes per second → 69000 writes per second`;
		expect(await fails(`${rate}\nAbout 69000 writes/s, or 68970 writes per second.`)).toEqual([]);
		expect(await fails(`${time()}\nRate: 1 ÷ 14.5 µs per write = 68965.5 writes per second → 67000 writes per second`)).toHaveLength(1);
		expect(await fails(`${rate}\nAbout 60000 writes per second.`)).toHaveLength(1);
	});

	test("one mistake is reported once, with the numbers that depend on it counted", async () => {
		const answer = [
			time(),
			"Rate: 1 ÷ 14.5 µs per write = 60000 writes per second",
			"Per hour: 60000 writes per second × 3600 = 216000000 writes per hour",
			"Per day: 216000000 writes per hour × 24 = 5184000000",
			"So about 60000 writes per second, 216000000 an hour.",
		].join("\n");
		const problems = await fails(answer);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('"60000 writes per second" does not follow from the arithmetic on its line: expected about 0.0689663');
		expect(problems[0]).toContain("or about 68966.3 (68728.5 to 69204.2, given how its operands are rounded) writes per second with their units; found 60000 writes per second.");
		expect(problems[0]).toContain("8 other numbers depend on it and are not reported separately (lines 5, 6, 7)");
	});

	test("a benchmark citation describes: it takes no number, and a number before it is judged by the other rules", async () => {
		expect(await fails("Each write is 8 KiB [lm:benchmark/disk_write], as the question says.", "How many 8 KiB writes per second?")).toEqual([]);
		expect(await fails("Each write is 8 KiB [lm:benchmark/disk_write].", "How many writes per second?")).toEqual([
			'"8 KiB" is not accounted for: nothing cites it, marks it as an assumption or computes it, and the same value and unit is neither in the question nor stated by a number accounted for. To fix, put a citation or [assumption: <source>] right after it, or show the arithmetic that gives it.',
		]);
	});

	test("a parameter whose key ends in a unit matches its value bare or in that unit, never in another", () => {
		const resolved = { ok: true as const, kind: "param" as const, series: memoryFile, key: "gap_mean_ms", value: 200 };
		const one = (text: string) => quantities(text)[0] as Quantity;
		expect(citationMismatch(resolved, one("200 ms"))).toBeNull();
		expect(citationMismatch(resolved, one("0.2 s"))).toBeNull();
		expect(citationMismatch(resolved, one("200"))).toBeNull();
		expect(citationMismatch(resolved, one("200 µs"))).toBe("expected 200 ms, the parameter gap_mean_ms, or the same in another unit of seconds; found 200 µs");
		expect(citationMismatch(resolved, one("200 MB"))).toContain("which is bytes, not seconds");
		expect(citationMismatch({ ...resolved, key: "object_bytes", value: 4096 }, one("4 KiB"))).toBeNull();
		expect(parameterUnit("budget_seconds")).toEqual({ dims: { s: 1 }, factor: 1, name: "seconds" });
		expect(parameterUnit("threads")).toBeNull();
	});
});

describe("links, markers and what is not a number", () => {
	test("a Run link is the bare path, its address in the data API or in the Runs repository; it is a Run of a cited Series; the bytes must be the Derivation's", async () => {
		const c = context();
		const path = c.tcp.runs[0]?.path as string;
		const base = `${c.time} ns ${c.timeCitation}\n`;
		for (const link of [
			path,
			`https://api.ledgermath.com/${path}`,
			`https://github.com/smrdotgg/ledgermath-runs/blob/main/${path}`,
			`https://raw.githubusercontent.com/smrdotgg/ledgermath-runs/main/${path}`,
			`[the Run](${path})`,
		]) {
			expect((await checkAnswer(base + link, data)).pass, link).toBe(true);
		}
		for (const link of [`https://example.com/${path}`, `https://github.com/someone/else/blob/main/${path}`]) {
			const report = await checkAnswer(base + link, data);
			expect(report.problems.map((p) => p.message), link).toContain(
				`Run link: ${link} is neither the bare path ${path}, a relative path ending with it, its address in the data API (https://api.ledgermath.com/${path}) nor its address in the Runs repository (https://github.com/smrdotgg/ledgermath-runs/blob/main/${path})`,
			);
		}
		// A Run of a Series the answer does not cite, beside one of the Series it cites.
		const other = c.memory.runs[0]?.path as string;
		expect((await checkAnswer(`${base}${path}\n${other}`, data)).problems.map((p) => p.message)).toEqual([`Run link: ${other} is not a Run of any Series the answer cites (${c.tcp.series.id})`]);
		const full = join(fixture.directory, path);
		const original = readFileSync(full, "utf8");
		try {
			writeFileSync(full, `${original} `);
			expect((await checkAnswer(base + path, data)).problems.map((p) => p.message)).toContain(`Run link: ${path} is not the file the Derivation cites (sha256 differs)`);
		} finally {
			writeFileSync(full, original);
		}
	});

	test("a count of Runs is cited with the count citation, not by repeating another number", async () => {
		const c = context();
		expect((await checkAnswer(`From 2 Runs ${c.countCitation}.\n${c.links}`, data)).pass).toBe(true);
		expect((await checkAnswer(`From 3 Runs ${c.countCitation}.\n${c.links}`, data)).pass).toBe(false);
		const borrowed = await checkAnswer(`Workers: 2 [assumption: a layout].\nFrom 2 Runs.`, data);
		expect(borrowed.problems.map((p) => p.message)).toEqual([
			'"2" counts Runs or boots: expected a Series\' count citation right after it, or the same count cited elsewhere; found neither. To fix, cite it with the count citation the tool prints.',
		]);
	});

	test("a marker belongs to the nearest number before it, and to no other", async () => {
		const report = await checkAnswer("LedgerMath says 140 GB/s and I assume 20 GB [assumption: a guess].", data);
		expect(statusOf(report, "140 GB/s")).toEqual(["unaccounted"]);
		expect(statusOf(report, "20 GB")).toEqual(["assumption"]);
	});

	test("dates, times, ids, hashes, list and footnote marks are not numbers", async () => {
		const answer = [
			"1. On 2026-11-11 at 04:10 UTC the 5th and 95th percentiles (p5, p95) of c6i.8xlarge in use2-az3 [1]",
			`2. Series ${fixture.c6i.series.id}, Run ${fixture.c6i.points[0]?.run}, SKU NKB8DU47ZKKBXW65, as of 2026-11-15T04:12:00Z`,
		].join("\n");
		const report = await checkAnswer(answer, data);
		expect(report.numbers).toEqual([]);
		expect(report.pass).toBe(true);
	});
});

describe("the script", () => {
	async function check(...args: string[]): Promise<{ code: number; stdout: string }> {
		const child = Bun.spawn(["bun", join(ROOT, "scripts", "check-answer.ts"), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LEDGERMATH_DATA: "" } });
		const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		return { code, stdout };
	}

	test("exits 0 on a pass, 1 on a problem, 2 on a usage error", async () => {
		const c = context();
		const good = join(fixture.directory, "good.md");
		const bad = join(fixture.directory, "bad.md");
		const question = join(fixture.directory, "question.md");
		writeFileSync(good, `tcp_echo takes ${c.time / 1000} µs ${c.timeCitation}, ${c.tcp.runs[0]?.path}\n`);
		writeFileSync(bad, "tcp_echo takes 15 µs.\n");
		writeFileSync(question, "What does a loopback round trip cost?\n");
		const passed = await check("--data", fixture.directory, "--question", question, good);
		expect(passed.code).toBe(0);
		expect(passed.stdout).toContain("PASS");
		const failed = await check("--data", fixture.directory, "--verbose", bad);
		expect(failed.code).toBe(1);
		expect(failed.stdout).toContain('line 1: "15 µs" is not accounted for');
		expect(failed.stdout).toContain("Every number:");
		const json = await check("--data", fixture.directory, "--json", bad);
		expect(JSON.parse(json.stdout).pass).toBe(false);
		// Usage errors, given a location that needs no network, so the default address is never asked.
		for (const usage of [[], [bad, good], ["--frobnicate", bad]]) {
			const wrong = await check("--data", fixture.directory, ...usage);
			expect(wrong.code, usage.join(" ")).toBe(2);
		}
		expect((await check("--data", fixture.directory, join(fixture.directory, "nowhere.md"))).code).toBe(2);
	});
});
