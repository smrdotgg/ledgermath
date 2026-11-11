import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Run, RunFile } from "../methods/run";
import { derive, gather, groupLetter, serialize } from "../methods/v1";
import { median, percentile } from "../methods/v1/numbers";
import type { DerivationsFile, SeriesDerivation } from "../methods/v1/output";
import { blobsFromDirectories } from "../scripts/lib/blobs";
import { readRunFiles } from "../scripts/lib/run-files";
import { HandMade } from "./hand-made-runs";

const SAMPLES = join(import.meta.dir, "samples");
const SAMPLE_DIRECTORIES = ["scheduled", "interrupted", "failures"];

/** Every sample directory's Runs in one directory, as a Runs repository would hold them. */
async function deriveSamples(): Promise<{ file: DerivationsFile; runs: RunFile[] }> {
	const directory = mkdtempSync(join(tmpdir(), "method-samples-"));
	try {
		for (const sample of SAMPLE_DIRECTORIES) cpSync(join(SAMPLES, sample, "runs"), join(directory, "runs"), { recursive: true });
		const runs = readRunFiles(directory);
		const fetch = blobsFromDirectories(SAMPLE_DIRECTORIES.map((sample) => join(SAMPLES, sample, "blobs")));
		return { file: derive(runs, await gather(runs, fetch)), runs };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

async function deriveHandMade(made: HandMade): Promise<DerivationsFile> {
	return derive(made.files, await gather(made.files, made.fetch));
}

function onlySeries(file: DerivationsFile): SeriesDerivation {
	expect(file.derivations.length).toBe(1);
	return file.derivations[0] as SeriesDerivation;
}

/** The time per repetition of a Run, worked out here from its events, apart from the Method's code. */
function byHand(run: Run): number {
	const perRepetition: number[] = [];
	for (const start of run.events) {
		if (start.event !== "sample_started" || start.warmup !== false) continue;
		const end = run.events.find((event) => event.event === "sample_ended" && event.sample === start.sample);
		perRepetition.push(((end?.t as number) - start.t) / (start.repetitions as number));
	}
	perRepetition.sort((a, b) => a - b);
	const half = perRepetition.length / 2;
	return perRepetition.length % 2 ? (perRepetition[Math.floor(half)] as number) : ((perRepetition[half - 1] as number) + (perRepetition[half] as number)) / 2;
}

describe("the numbers", () => {
	test("the median of an odd and an even count", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(median([7])).toBe(7);
	});

	test("percentiles interpolate between closest ranks (R type 7)", () => {
		const values = [500, 100, 400, 200, 300];
		expect(percentile(values, 5)).toBeCloseTo(120, 9); // h = 0.2
		expect(percentile(values, 50)).toBe(300);
		expect(percentile(values, 95)).toBeCloseTo(480, 9); // h = 3.8
		expect(percentile([42], 5)).toBe(42);
		expect(percentile([42], 95)).toBe(42);
		expect(percentile([10, 20], 50)).toBe(15);
	});

	test("groups are lettered A to Z, then AA", () => {
		expect([0, 1, 25, 26, 27, 51, 52].map(groupLetter)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA"]);
	});
});

describe("Method version 1 on the sample Runs", () => {
	test("one Series per benchmark, params, build, instance type and zone ID; failed Runs shown and not counted", async () => {
		const { file, runs } = await deriveSamples();
		expect(file.runs_read).toBe(12);
		expect(file.unreadable).toEqual([]);
		expect(file.derivations.length).toBe(9);
		const points = file.derivations.flatMap((derivation) => derivation.points);
		expect(points.length).toBe(12);
		expect(points.filter((point) => point.counted).length).toBe(9);

		const failed = points.filter((point) => !point.counted).map((point) => point.failure);
		expect(failed).toContainEqual(expect.stringContaining("killed by signal 9 (the runner's 1 s timeout)"));
		expect(failed).toContainEqual(expect.stringContaining("exit code 2"));
		expect(failed).toContainEqual(expect.stringContaining("the runner was told to stop by signal 15"));

		for (const derivation of file.derivations) {
			expect(derivation.method).toEqual({ name: "series", version: 1 });
			expect(derivation.runs.map((run) => run.id)).toEqual(derivation.points.map((point) => point.run));
			for (const cited of derivation.runs) {
				expect(runs.find((run) => run.path === cited.path)?.sha256).toBe(cited.sha256);
			}
			const counted = derivation.points.filter((point) => point.counted);
			expect(derivation.percentiles.time_per_repetition_ns?.count ?? 0).toBe(counted.length);
			expect(derivation.percentiles.time_per_repetition_ns?.runs ?? []).toEqual(counted.map((point) => point.run));
		}
	});

	test("each counted Run's number is the median of its counted samples' time per repetition", async () => {
		const { file, runs } = await deriveSamples();
		for (const point of file.derivations.flatMap((derivation) => derivation.points)) {
			if (!point.counted) continue;
			const run = runs.find((candidate) => candidate.path === point.path)?.record as Run;
			expect(point.time_per_repetition_ns).toBe(byHand(run));
			expect(point.samples.length).toBe(run.samples);
			expect(point.bytes_per_repetition).toBe(1073741824);
			expect(point.bytes_per_second).toBe((1073741824 * 1e9) / byHand(run));
		}
		// One fixed by hand: scheduled 01a1c7a6-0108…, 1 thread, scalar, static.
		const one = file.derivations.flatMap((d) => d.points).find((point) => point.run === "01a1c7a6-0108-7db1-8ec4-3d1f9390b22b");
		expect(one?.time_per_repetition_ns).toBe(110664400.65625);
	});

	test("a Series with several Runs: the samples' 1-thread scalar static Runs, one failed", async () => {
		const { file } = await deriveSamples();
		const series = file.derivations.find(
			(d) => d.series.build === "static" && d.series.params.path === "scalar" && d.series.params.threads === 1,
		) as SeriesDerivation;
		expect(series.points.map((point) => point.counted)).toEqual([true, true, false]);
		expect(series.groups.map((group) => group.id)).toEqual(["A"]);
		expect(series.percentiles.time_per_repetition_ns?.count).toBe(2);
		expect(series.differed.length).toBe(2);
		// cpuinfo and memory change on every read; the containers' mounts differ.
		expect(series.differed[0]?.sections.map((s) => s.section)).toEqual(["cpuinfo", "devices", "memory"]);
		expect(series.differed[0]?.facts).toEqual([]);
	});
});

describe("Method version 1 on hand-made Runs", () => {
	test("percentiles across Runs, with the count behind them", async () => {
		const made = new HandMade();
		// Time per repetition 100 to 500 ns: each sample is 100 repetitions.
		[300, 100, 500, 200, 400].forEach((ns, day) => {
			made.run({ startedAt: `2026-11-1${day}T22:15:00Z`, samplesNs: [ns * 100, ns * 100, ns * 100] });
		});
		const series = onlySeries(await deriveHandMade(made));
		expect(series.points.map((point) => point.time_per_repetition_ns)).toEqual([300, 100, 500, 200, 400]);
		const time = series.percentiles.time_per_repetition_ns;
		expect(time?.count).toBe(5);
		expect(time?.p5).toBeCloseTo(120, 6);
		expect(time?.p50).toBe(300);
		expect(time?.p95).toBeCloseTo(480, 6);
		expect(series.percentiles.bytes_per_second?.count).toBe(5);
		expect(series.percentiles.bytes_per_second?.p50).toBe((1073741824 * 1e9) / 300);
	});

	test("groups that interleave in time, each with its own percentiles", async () => {
		const made = new HandMade();
		const processors = ["Xeon 8375C", "Xeon 8259CL", "Xeon 8375C", "Xeon 8259CL", "Xeon 8375C"];
		processors.forEach((processor, day) => {
			const ns = processor === "Xeon 8375C" ? 100 + day : 200 + day;
			made.run({ startedAt: `2026-11-1${day}T22:15:00Z`, processor, samplesNs: [ns * 100] });
		});
		const series = onlySeries(await deriveHandMade(made));
		expect(series.points.map((point) => point.group)).toEqual(["A", "B", "A", "B", "A"]);
		const [a, b] = series.groups;
		expect(a?.runs.length).toBe(3);
		expect(b?.runs.length).toBe(2);
		expect(a?.percentiles.time_per_repetition_ns?.p50).toBe(102);
		expect(b?.percentiles.time_per_repetition_ns?.p50).toBe(202);
		expect(series.percentiles.time_per_repetition_ns?.count).toBe(5);
		// Each switch shows the processor's sections and facts, and every boot's own.
		const first = series.differed[0];
		expect(first?.facts).toEqual(["cpuid", "lscpu", "sys_cpu"]);
		expect(first?.sections.map((s) => s.section)).toEqual(["cpuid", "cpuinfo", "devices", "kernel", "lscpu", "memory", "provider", "sys_cpu"]);
		expect(first?.sections.find((s) => s.section === "kernel")?.keys).toEqual(["$ uname -a"]);
		expect(first?.sections.find((s) => s.section === "cpuinfo")?.keys).toBeNull();
	});

	test("a new boot's host name alone does not split: the kernel fact leaves out uname -a", async () => {
		const made = new HandMade();
		made.run({ startedAt: "2026-11-11T22:15:00Z" });
		made.run({ startedAt: "2026-11-12T22:15:00Z" });
		made.run({ startedAt: "2026-11-13T22:15:00Z", kernel: "6.1.999" });
		const series = onlySeries(await deriveHandMade(made));
		expect(series.points.map((point) => point.group)).toEqual(["A", "A", "B"]);
		expect(series.differed[0]?.facts).toEqual([]);
		expect(series.differed[1]?.facts).toEqual(["kernel"]);
		expect(series.differed[1]?.sections.find((s) => s.section === "kernel")?.keys).toEqual(["$ uname -a", "/proc/version"]);
	});

	test("a failed Run is shown, in its group, and in no percentile", async () => {
		const made = new HandMade();
		made.run({ startedAt: "2026-11-11T22:15:00Z", samplesNs: [10_000] });
		made.run({ startedAt: "2026-11-12T22:15:00Z", exit: { code: 2 }, samplesNs: [], samples: 1 });
		made.run({ startedAt: "2026-11-13T22:15:00Z", exit: { signal: 11 }, samplesNs: [20_000], crashAfter: 0 });
		made.run({ startedAt: "2026-11-14T22:15:00Z", samplesNs: [30_000] });
		const series = onlySeries(await deriveHandMade(made));
		expect(series.points.map((point) => point.counted)).toEqual([true, false, false, true]);
		expect(series.points[1]?.failure).toContain("exit code 2");
		expect(series.points[2]?.failure).toContain("killed by signal 11");
		expect(series.points[2]?.failure).toContain("no finished event");
		expect(series.points[1]?.time_per_repetition_ns).toBeNull();
		expect(series.groups[0]?.runs.length).toBe(4);
		const time = series.percentiles.time_per_repetition_ns;
		expect(time?.count).toBe(2);
		expect(time?.p50).toBe(200);
		expect(series.groups[0]?.percentiles.time_per_repetition_ns?.count).toBe(2);
	});

	test("a Series with one Run: its value is every percentile, and nothing differed", async () => {
		const made = new HandMade();
		made.run({ startedAt: "2026-11-11T22:15:00Z", samplesNs: [1000, 3000, 2000], repetitions: 10 });
		const series = onlySeries(await deriveHandMade(made));
		const time = series.percentiles.time_per_repetition_ns;
		expect(time).toEqual({ count: 1, runs: [series.points[0]?.run as string], p5: 200, p50: 200, p95: 200 });
		expect(series.differed).toEqual([]);
	});

	test("which Runs count", async () => {
		const made = new HandMade();
		made.run({ startedAt: "2026-11-11T22:15:00Z", exit: { code: 0, runner_signal: 15 } }); // finished before the stop
		made.run({ startedAt: "2026-11-12T22:15:00Z", quick: true });
		made.run({ startedAt: "2026-11-13T22:15:00Z", samples: 11 }); // ten samples of eleven asked for
		made.run({ startedAt: "2026-11-14T22:15:00Z", bytesPerRepetition: null });
		const series = onlySeries(await deriveHandMade(made));
		expect(series.points.map((point) => point.counted)).toEqual([true, false, false, true]);
		expect(series.points[1]?.failure).toBe("a --quick stream");
		expect(series.points[2]?.failure).toBe("10 counted samples of the 11 asked for");
		expect(series.points[3]?.bytes_per_second).toBeNull();
		expect(series.percentiles.bytes_per_second?.count).toBe(1);
		expect(series.percentiles.time_per_repetition_ns?.count).toBe(2);
	});

	test("Series are apart by benchmark, params, build, instance type and zone ID, and not by params' order", async () => {
		const made = new HandMade();
		made.run({ startedAt: "2026-11-11T22:15:00Z", params: { size_bytes: 1, threads: 1, path: "avx2" } });
		made.run({ startedAt: "2026-11-12T22:15:00Z", params: { path: "avx2", threads: 1, size_bytes: 1 } });
		made.run({ startedAt: "2026-11-12T22:16:00Z", params: { path: "avx2", threads: 1, size_bytes: 1 }, build: "dynamic" });
		made.run({ startedAt: "2026-11-12T22:17:00Z", params: { path: "avx2", threads: 1, size_bytes: 1 }, zoneId: "use2-az1" });
		made.run({ startedAt: "2026-11-12T22:18:00Z", params: { path: "avx2", threads: 1, size_bytes: 1 }, instanceType: "c6i.large" });
		made.run({ startedAt: "2026-11-12T22:19:00Z", params: { path: "avx2", threads: 1, size_bytes: 1 }, benchmark: "other" });
		const file = await deriveHandMade(made);
		expect(file.derivations.map((d) => d.points.length).sort()).toEqual([1, 1, 1, 1, 2]);
	});

	test("a Run file that does not validate is listed, and in no Series", async () => {
		const made = new HandMade();
		made.run({ startedAt: "2026-11-11T22:15:00Z" });
		const broken: RunFile = { path: "runs/2026/11/12/broken.json", sha256: "0".repeat(64), record: { schema: "ledgermath.run/1" } };
		const file = derive([...made.files, broken], await gather(made.files, made.fetch));
		expect(file.runs_read).toBe(2);
		expect(file.unreadable.map((run) => run.path)).toEqual(["runs/2026/11/12/broken.json"]);
		expect(file.derivations.flatMap((d) => d.points).length).toBe(1);
	});

	test("a blob that cannot be fetched stops the Method", async () => {
		const made = new HandMade();
		made.run({ startedAt: "2026-11-11T22:15:00Z" });
		expect(gather(made.files, async () => null)).rejects.toThrow("cannot be fetched");
	});
});

describe("determinism", () => {
	test("the same Runs give the same bytes, in any order, from any blob source", async () => {
		const made = new HandMade();
		const processors = ["A", "B", "A", "A", "B", "B", "A"];
		processors.forEach((processor, i) => {
			made.run({ startedAt: `2026-11-${11 + i}T22:15:00Z`, processor, samplesNs: [1000 + i * 7, 1003, 999 + i] });
			made.run({ startedAt: `2026-11-${11 + i}T22:16:00Z`, build: "dynamic", processor, samplesNs: [2000 + i, 2001] });
		});
		made.run({ startedAt: "2026-11-20T22:15:00Z", exit: { code: 3 } });
		const first = serialize(derive(made.files, await gather(made.files, made.fetch)));

		const shuffled = [...made.files].reverse();
		expect(serialize(derive(shuffled, await gather(shuffled, made.fetch)))).toBe(first);

		const directory = mkdtempSync(join(tmpdir(), "method-determinism-"));
		try {
			made.writeTo(directory);
			const files = readRunFiles(directory);
			const again = serialize(derive(files, await gather(files, blobsFromDirectories([join(directory, "blobs")]))));
			expect(again).toBe(first);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("the samples give the same bytes twice", async () => {
		expect(serialize((await deriveSamples()).file)).toBe(serialize((await deriveSamples()).file));
	});
});
