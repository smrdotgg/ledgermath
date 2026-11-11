import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { type CheckReport, checkAnswer, type NumberStatus } from "../scripts/lib/answer-check";
import { type LedgerData, loadLedger, openLocation } from "../scripts/lib/ledger-data";
import { quantities, sameQuantity, samePriceUpToScale } from "../scripts/lib/quantity";
import { C6I_PRICE_CITATION, type Fixture, makeFixture } from "./lookup-fixtures";
import { SAMPLE_PATH } from "./prices-fixtures";

setDefaultTimeout(60_000);

const ROOT = resolve(import.meta.dir, "..");
let fixture: Fixture;
let data: LedgerData;

beforeAll(async () => {
	fixture = await makeFixture();
	data = await loadLedger(openLocation(fixture.directory));
});
afterAll(() => rmSync(fixture.directory, { recursive: true, force: true }));

describe("reading numbers", () => {
	const one = (text: string): { written: number; dimension: string; value: number } => {
		const [q] = quantities(text);
		if (q === undefined) throw new Error(`no number in ${text}`);
		return { written: q.written, dimension: q.dimension, value: q.value };
	};

	test("as people write them, with scale words, exponents and units", () => {
		expect(one("30 million players")).toEqual({ written: 3e7, dimension: "none", value: 3e7 });
		expect(one("30M players")).toEqual({ written: 3e7, dimension: "none", value: 3e7 });
		expect(one("30,000,000")).toEqual({ written: 3e7, dimension: "none", value: 3e7 });
		expect(one("$0.09/GB")).toEqual({ written: 0.09, dimension: "usd", value: 0.09 });
		expect(one("$75M")).toEqual({ written: 75e6, dimension: "usd", value: 75e6 });
		expect(one("1.5e9 GB").value).toBeCloseTo(1.5e18, -3);
		expect(one("1.5 × 10^15 bytes").value).toBeCloseTo(1.5e15, -3);
		expect(one("2×10⁹").written).toBe(2e9);
		expect(one("10^9").written).toBe(1e9);
		expect(one("2^30 bytes").value).toBe(2 ** 30);
		expect(one("64 GiB")).toEqual({ written: 64, dimension: "bytes", value: 64 * 2 ** 30 });
		expect(one("12500 Megabit")).toEqual({ written: 12500, dimension: "bytes", value: 12500e6 / 8 });
		expect(one("12.5 Gbit/s").value).toBe(12.5e9 / 8);
		expect(one("140.282 GB/s").value).toBeCloseTo(140.282e9, 0);
		expect(one("7.68862 ms").value).toBeCloseTo(7.68862e-3, 12);
		expect(one("582.6 µs").value).toBeCloseTo(582.6e-6, 12);
		expect(one("1.36 USD per Hrs")).toEqual({ written: 1.36, dimension: "usd", value: 1.36 });
		expect(one("12%")).toEqual({ written: 12, dimension: "percent", value: 12 });
	});

	test("never inside a name: instance types, zone IDs, percentiles, services, SKUs", () => {
		const text = "c6i.8xlarge in use2-az3, p50 and p95, S3 and gp3 on x86_64, SKU 8D49XP354UEYTHGM, AVX-512";
		expect(quantities(text)).toEqual([]);
	});

	test("a written number is a value rounded, in any unit of the same dimension", () => {
		const [gib] = quantities("130.65 GiB/s");
		const [gb] = quantities("140 GB/s");
		const [bad] = quantities("150 GB/s");
		const value = { written: 140281717414.91382, dimension: "bytes" as const, value: 140281717414.91382 };
		expect(sameQuantity(gib as never, value)).toBe(true);
		expect(sameQuantity(gb as never, value)).toBe(true);
		expect(sameQuantity(bad as never, value)).toBe(false);
		const [price] = quantities("$0.40 per million");
		const [per10k] = quantities("$0.004");
		const [wrong] = quantities("$0.005");
		expect(samePriceUpToScale(price as never, 0.0000004)).toBe(true);
		expect(samePriceUpToScale(per10k as never, 0.0000004)).toBe(true);
		expect(samePriceUpToScale(wrong as never, 0.0000004)).toBe(false);
	});
});

const QUESTION = "How many instances scan 1 TB of memory per second?";

const statusOf = (report: CheckReport, text: string): NumberStatus[] => report.numbers.filter((n) => n.text === text).map((n) => n.status);

describe("an answer", () => {
	const goodAnswer = (): string => {
		const c6i = fixture.c6i;
		const runs = c6i.runs.map((run) => run.path);
		return [
			"## Inputs",
			`- Read bandwidth of one c6i.8xlarge: p50 134.218 GB/s [lm:series/${c6i.series.id}/bytes_per_second/p50] from 3 Runs, and 120 GB/s [assumption: rounded down from the p50, to be safe].`,
			`- Price: $1.36 per hour ${C6I_PRICE_CITATION}, price file of 2026-11-11; memory 64 GiB [lm:${SAMPLE_PATH}#NKB8DU47ZKKBXW65/attributes/memory].`,
			"- Share of the bandwidth a real scan keeps: 50 to 80% [assumption: a guess for a columnar scan].",
			"",
			"## Arithmetic",
			"Instances = 1 TB/s ÷ 134.218 GB/s = 7.45 → 8",
			"Cost = 8 × $1.36 = $10.88 per hour; per day 10.88 × 24 = $261.12",
			"",
			"## Result",
			"About 8 instances, $10.88 per hour.",
			"",
			"## Sources",
			`- ${runs[0]}`,
			`- https://github.com/smrdotgg/ledgermath-runs/blob/main/${runs[1]}`,
		].join("\n");
	};

	test("passes when every number is cited, assumed, given, derived, reused or a constant", async () => {
		const report = await checkAnswer(goodAnswer(), data, QUESTION);
		expect(report.problems).toEqual([]);
		expect(report.pass).toBe(true);
		expect(statusOf(report, "134.218 GB/s")).toEqual(["cited", "reused"]);
		expect(statusOf(report, "3")).toEqual(["count"]);
		expect(statusOf(report, "120 GB/s")).toEqual(["assumption"]);
		expect(statusOf(report, "50")).toEqual(["assumption"]);
		expect(statusOf(report, "80%")).toEqual(["assumption"]);
		expect(statusOf(report, "$1.36")).toEqual(["cited", "reused"]);
		expect(statusOf(report, "64 GiB")).toEqual(["cited"]);
		expect(statusOf(report, "1 TB/s")).toEqual(["given"]);
		expect(statusOf(report, "7.45")).toEqual(["derived"]);
		expect(statusOf(report, "8")).toEqual(["derived", "reused", "reused"]);
		expect(statusOf(report, "24")).toEqual(["constant"]);
		expect(statusOf(report, "$261.12")).toEqual(["derived"]);
		expect(report.run_links.map((link) => link.problem)).toEqual([null, null]);
	});

	test("reports a number with no citation, no marker and no arithmetic", async () => {
		const report = await checkAnswer(`${goodAnswer()}\nA c6i.8xlarge also reads 2 GB/s from its disk.`, data);
		expect(report.pass).toBe(false);
		expect(report.problems.map((p) => p.message)).toContain(
			'"2 GB/s" is not accounted for: no citation, no [assumption: …] marker; not in the question, not a result of arithmetic on its line, not a number used elsewhere',
		);
		// Without the question, its 1 TB is not given either.
		expect(statusOf(report, "1 TB/s")).toEqual(["unaccounted"]);
	});

	test("reports a cited number that is not its citation's value", async () => {
		const report = await checkAnswer(`${goodAnswer()}\nThe p50 is 2 GB/s [lm:series/${fixture.c6i.series.id}/bytes_per_second/p50].`, data, QUESTION);
		expect(report.problems.map((p) => p.message)).toEqual([
			`"2 GB/s" is not the value its citation [lm:series/${fixture.c6i.series.id}/bytes_per_second/p50] resolves to: p50 of bytes_per_second of Series ${fixture.c6i.series.id} (memory_read on c6i.8xlarge): 134217728000 B/s`,
		]);
	});

	test("reports citations that do not resolve, Run links that name no Run, and a cited Series with no Run linked", async () => {
		const answer = [
			`m5.large reads 15 GB/s [lm:series/${fixture.m5.series.id}/group/C/bytes_per_second/p50].`,
			`tcp_echo: 14.5 µs [lm:series/${fixture.tcp.series.id}/time_per_repetition_ns/p50].`,
			"CloudFront: $0.085 per GB [lm:prices/2026/11/11/aws.json#CLOUDFRONT/CLOUDFRONT.X.Y].",
			"See runs/2026/11/12/01a00000-0000-7000-8000-000000000000.json.",
		].join("\n");
		const report = await checkAnswer(answer, data);
		const messages = report.problems.map((p) => `${p.line}: ${p.message}`);
		expect(messages).toContain(`1: [lm:series/${fixture.m5.series.id}/group/C/bytes_per_second/p50] does not resolve: Series ${fixture.m5.series.id} has no group C`);
		expect(messages).toContain(`2: Series ${fixture.tcp.series.id} is cited, but the answer links none of its Runs (runs/<yyyy>/<mm>/<dd>/<id>.json)`);
		expect(messages).toContain(`3: [lm:prices/2026/11/11/aws.json#CLOUDFRONT/CLOUDFRONT.X.Y] does not resolve: ${SAMPLE_PATH} holds no SKU CLOUDFRONT`);
		expect(messages).toContain(`4: Run link: no Run file runs/2026/11/12/01a00000-0000-7000-8000-000000000000.json at ${fixture.directory}`);
	});

	test("reports a Run file whose bytes differ from the ones the Derivation cites", async () => {
		const path = fixture.syscall.runs[0]?.path as string;
		const full = join(fixture.directory, path);
		const original = await Bun.file(full).text();
		try {
			writeFileSync(full, `${original} `);
			const report = await checkAnswer(`getpid: 94.7 ns [lm:series/${fixture.syscall.series.id}/time_per_repetition_ns/p50]\n${path}`, data);
			expect(report.problems.map((p) => p.message)).toEqual([`Run link: ${path} is not the file the Derivation cites (sha256 differs)`]);
		} finally {
			writeFileSync(full, original);
		}
	});

	test("reports an assumption that does not say where it comes from", async () => {
		const report = await checkAnswer("Each player downloads 20 GB [assumption].", data);
		expect(report.problems.map((p) => p.message)).toEqual(["an [assumption] marker that does not say where the number comes from: [assumption]"]);
		expect(statusOf(report, "20 GB")).toEqual(["assumption"]);
	});

	test("a marker covers the number just before it, not an earlier one", async () => {
		const report = await checkAnswer("LedgerMath says 140 GB/s and I assume 20 GB [assumption: a guess].", data);
		expect(statusOf(report, "140 GB/s")).toEqual(["unaccounted"]);
		expect(statusOf(report, "20 GB")).toEqual(["assumption"]);
	});

	test("the numbers in names, dates, ids and list marks are not numbers of the answer", async () => {
		const answer = [
			"1. On 2026-11-11 at 04:10 UTC the 5th and 95th percentiles (p5, p95) of c6i.8xlarge in use2-az3 [1]",
			`2. Series ${fixture.c6i.series.id}, Run ${fixture.c6i.points[0]?.run}, SKU NKB8DU47ZKKBXW65`,
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
		const good = join(fixture.directory, "good.md");
		const bad = join(fixture.directory, "bad.md");
		const question = join(fixture.directory, "question.md");
		writeFileSync(good, `getpid costs 94.7 ns [lm:series/${fixture.syscall.series.id}/time_per_repetition_ns/p50], ${fixture.syscall.runs[0]?.path}\n`);
		writeFileSync(bad, "getpid costs 95 ns.\n");
		writeFileSync(question, "What does getpid cost?\n");
		const passed = await check("--data", fixture.directory, "--question", question, good);
		expect(passed.code).toBe(0);
		expect(passed.stdout).toContain("PASS");
		const failed = await check("--data", fixture.directory, "--verbose", bad);
		expect(failed.code).toBe(1);
		expect(failed.stdout).toContain('line 1: "95 ns" is not accounted for');
		expect(failed.stdout).toContain("Every number:");
		const json = await check("--data", fixture.directory, "--json", bad);
		expect(JSON.parse(json.stdout).pass).toBe(false);
		expect((await check(bad)).code).toBe(2);
		expect((await check("--data", fixture.directory, join(fixture.directory, "nowhere.md"))).code).toBe(2);
	});
});
