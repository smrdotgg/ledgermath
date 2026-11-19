/**
 * A Runs repository checkout and its two files of Derivations, for the data
 * API's tests: hand-made Runs (tests/hand-made-runs.ts,
 * tests/hand-made-requests.ts) derived by Method series v1 and Method
 * requests v1, a boot summary, two price files and a Run file that does not
 * validate. Nothing in it was measured.
 *
 * - memory_read on c6i.8xlarge: four Runs. The third landed on another
 *   processor, so the Series has two groups and a differed entry that splits;
 *   the fourth crashed, so its point is not counted.
 * - syscall on c6i.8xlarge: one Run, with no bytes per repetition; with
 *   `extraSyscallRun`, a second one, newer than every other Run.
 * - http_get on c6i.8xlarge: two Runs of requests, the second exited 4 with a
 *   failed request: a Series of both Methods.
 * - runs/2026/11/14/not-a-run.json: a Run file each Method lists as unreadable.
 * - boots/2026/11/12/boot-2026-11-12.json: the summary of the first day's boot
 *   only, so some points link a boot summary and the others none.
 *
 * With `nextMonth`, a Run more of memory_read and of http_get, each on
 * 2026-12-01 and made after every other Run (so no other Run's id changes):
 * both Series then have two months. The http_get Run landed on another
 * processor, so that Series gains a second group in December, and requests
 * v1's Derivation gives its November points a group_through.
 *
 * With `lateRun`, after those, a Run more of memory_read that started on
 * 2026-11-20, before December's: a Run that arrives after a later Run of its
 * Series, which changes December's pair entry.
 *
 * With `small`, no syscall Series, and the other Runs with three counted
 * samples each where they had ten, and four requests and three where they had
 * forty and thirty-nine: the tree tests/api-golden.test.ts keeps a copy of,
 * small enough to read in review, with every kind of object of both Methods.
 * It has `nextMonth`'s Runs too, so the copy shows a Series of two months.
 *
 * With `edges`, three Series more, each of what a Method can emit and today's
 * data do not show:
 * - memory_write: one Run whose one counted sample took 0 ns, with bytes per
 *   repetition. It counts, its time per repetition is 0, and its bytes per
 *   second is infinite, which the Derivation writes as null, in its point and
 *   in every percentile of bytes per second.
 * - tcp_echo: one Run whose parameter destination is a string under the API's
 *   own address, which is data, not a link.
 * - memory_copy: one Run of two counted samples of one repetition each, with
 *   clock intervals [0, x] and [x, Number.MAX_VALUE], x = 1.5 × 2^971. The
 *   Run's time per repetition is the mean of the two, whose sum overflows: it
 *   is infinite, which the Derivation writes as null, in its point and in
 *   every percentile of time per repetition; its bytes per second is 0.
 */

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as requests from "../methods/requests/v1";
import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import type { RunFile } from "../methods/run";
import * as series from "../methods/v1";
import type { DerivationsFile as SeriesFile } from "../methods/v1/output";
import { HandMade, rampRequests, requestRun } from "./hand-made-requests";
import { SAMPLE_FILE } from "./prices-fixtures";

export interface ApiFixture {
	/** The Runs repository checkout: runs/, boots/, prices/. */
	runs: string;
	derivationsPath: string;
	requestsPath: string;
	series: SeriesFile;
	requests: RequestsFile;
	memory: string;
	/** The syscall Series; empty with `small`, which has none. */
	syscall: string;
	http: string;
	/** The unreadable Run file's path. */
	unreadable: string;
	/** With `edges`: the Series with a Run of 0 ns per repetition, the one whose parameter is an address, and the one whose Run's time per repetition overflows. */
	zeroTime?: string;
	addressParam?: string;
	overflowTime?: string;
}

/** The parameter of the tcp_echo Series made with `edges`: an address under the API's own base, that names no file. */
export const ADDRESS_PARAM = "https://api.ledgermath.com/connection-test";

/** x of the memory_copy edge: its two samples are [0, x] and [x, Number.MAX_VALUE] on the Run's clock. */
export const OVERFLOW_X = 1.5 * 2 ** 971;

/** The memory_copy edge's stream: the clock starts at 0 and ends at the largest double, which is a whole number. */
function overflowStream(): string {
	const events = [
		{ event: "started", t: 0, schema: "ledgermath.events/1", wall_utc: "2026-11-13T04:16:00.000000000Z", clock: "CLOCK_MONOTONIC_RAW", clock_read_ns: 20, quick: false },
		{ event: "observed", t: 0, values: { bytes_per_repetition: 4096, threads_used: 1, path_taken: "scalar" } },
		{ event: "sample_started", t: 0, sample: 0, warmup: false, repetitions: 1 },
		{ event: "sample_ended", t: OVERFLOW_X, sample: 0 },
		{ event: "sample_started", t: OVERFLOW_X, sample: 1, warmup: false, repetitions: 1 },
		{ event: "sample_ended", t: Number.MAX_VALUE, sample: 1 },
		{ event: "verified", t: Number.MAX_VALUE, checksum: "0x0000000000000001" },
		{ event: "finished", t: Number.MAX_VALUE },
	];
	return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export async function makeApiFixture(options: { extraSyscallRun?: boolean; edges?: boolean; small?: boolean; nextMonth?: boolean; lateRun?: boolean } = {}): Promise<ApiFixture> {
	const samples = (ns: number): number[] => Array.from({ length: options.small ? 3 : 10 }, (_, i) => ns + i * 1000);
	const requestsOf = (n: number): number => (options.small ? n - 36 : n);
	const made = new HandMade();
	made.run({ startedAt: "2026-11-12T04:12:00Z", samplesNs: samples(7e6) });
	made.run({ startedAt: "2026-11-13T04:12:00Z", samplesNs: samples(8e6) });
	made.run({ startedAt: "2026-11-14T04:12:00Z", samplesNs: samples(9e6), processor: "Intel(R) Xeon(R) Platinum 8259CL" });
	made.run({ startedAt: "2026-11-15T04:12:00Z", samplesNs: samples(8e6), crashAfter: 3 });
	if (!options.small) made.run({ startedAt: "2026-11-12T04:13:00Z", benchmark: "syscall", binary: "syscall", params: { call: "getpid" }, samplesNs: samples(94.7), bytesPerRepetition: null });
	requestRun(made, { startedAt: "2026-11-12T22:20:00Z", stream: { connection: "new", requests: rampRequests(requestsOf(40), 20_000_000, 50_000) } });
	requestRun(made, {
		startedAt: "2026-11-13T04:20:00Z",
		exit: { code: 4 },
		stream: { connection: "new", requests: [...rampRequests(requestsOf(39), 21_000_000, 40_000), { fail: { phase: "first_byte", error: "timeout" } }] },
	});
	if (options.edges) {
		made.run({ startedAt: "2026-11-13T04:14:00Z", benchmark: "memory_write", binary: "memory_write", params: { size_bytes: 4096 }, samplesNs: [0], repetitions: 1, bytesPerRepetition: 4096 });
		made.run({ startedAt: "2026-11-13T04:15:00Z", benchmark: "tcp_echo", binary: "tcp_echo", params: { destination: ADDRESS_PARAM }, samplesNs: samples(5e4), bytesPerRepetition: null });
		made.run({
			startedAt: "2026-11-13T04:16:00Z",
			benchmark: "memory_copy",
			binary: "memory_copy",
			params: { size_bytes: 4096 },
			samplesNs: [OVERFLOW_X, Number.MAX_VALUE - OVERFLOW_X],
			repetitions: 1,
			bytesPerRepetition: 4096,
			stdout: overflowStream(),
		});
	}
	if (options.extraSyscallRun) {
		made.run({ startedAt: "2026-11-16T04:13:00Z", benchmark: "syscall", binary: "syscall", params: { call: "getpid" }, samplesNs: samples(95.1), bytesPerRepetition: null });
	}
	if (options.nextMonth || options.small) {
		made.run({ startedAt: "2026-12-01T04:12:00Z", samplesNs: samples(7.5e6) });
		requestRun(made, { startedAt: "2026-12-01T22:20:00Z", processor: "Intel(R) Xeon(R) Platinum 8259CL", stream: { connection: "new", requests: rampRequests(requestsOf(40), 19_000_000, 60_000) } });
	}
	if (options.lateRun) made.run({ startedAt: "2026-11-20T04:12:00Z", samplesNs: samples(7.2e6) });

	const unreadablePath = "runs/2026/11/14/not-a-run.json";
	const unreadableBytes = `${JSON.stringify({ schema: "ledgermath.run/1", id: "not-a-run" }, null, 2)}\n`;
	const unreadable: RunFile = { path: unreadablePath, sha256: createHash("sha256").update(unreadableBytes).digest("hex"), record: JSON.parse(unreadableBytes) };
	const files = [...made.files, unreadable].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	const seriesFile = series.derive(files, await series.gather(files, made.fetch));
	const requestsFile = requests.derive(files, await requests.gather(files, made.fetch));

	const runs = mkdtempSync(join(tmpdir(), "api-runs-"));
	const put = (path: string, text: string | Uint8Array): void => {
		mkdirSync(dirname(join(runs, path)), { recursive: true });
		writeFileSync(join(runs, path), text);
	};
	for (const file of made.files) put(file.path, `${JSON.stringify(file.record, null, 2)}\n`);
	put(unreadablePath, unreadableBytes);
	put("boots/2026/11/12/boot-2026-11-12.json", `${JSON.stringify({ schema: "ledgermath.boot/1", boot: "boot-2026-11-12" }, null, 2)}\n`);
	for (const day of ["11", "12"]) {
		mkdirSync(join(runs, "prices", "2026", "11", day), { recursive: true });
		copyFileSync(SAMPLE_FILE, join(runs, "prices", "2026", "11", day, "aws.json"));
	}

	const derived = mkdtempSync(join(tmpdir(), "api-derivations-"));
	const derivationsPath = join(derived, "derivations.json");
	const requestsPath = join(derived, "requests-derivations.json");
	writeFileSync(derivationsPath, series.serialize(seriesFile));
	writeFileSync(requestsPath, requests.serialize(requestsFile));

	const id = (benchmark: string): string => {
		const found = seriesFile.derivations.find((d) => d.series.benchmark === benchmark);
		if (found === undefined) throw new Error(`no ${benchmark} Series`);
		return found.series.id;
	};
	return {
		runs,
		derivationsPath,
		requestsPath,
		// As a reader of the files would have them, not the objects the Methods returned.
		series: JSON.parse(series.serialize(seriesFile)) as SeriesFile,
		requests: JSON.parse(requests.serialize(requestsFile)) as RequestsFile,
		memory: id("memory_read"),
		syscall: options.small ? "" : id("syscall"),
		http: id("http_get"),
		unreadable: unreadablePath,
		...(options.edges ? { zeroTime: id("memory_write"), addressParam: id("tcp_echo"), overflowTime: id("memory_copy") } : {}),
	};
}

export interface LongFixture {
	runs: string;
	series: SeriesFile;
	requests: RequestsFile;
	/** The syscall Series and the http_get Series, of both Methods. */
	syscall: string;
	http: string;
}

/**
 * A Runs repository checkout of `count` Runs of each of two Series, four a
 * day from 2026-11-01 (00:13, 06:13, 12:13 and 18:13 UTC; the http_get Run
 * seven minutes later), every Run of a Series the same but for its time and
 * boot: syscall with three samples and no bytes per repetition, and http_get
 * with a hundred requests, so a Series' figures and the size of each point do
 * not change with how many Runs there are. A hundred requests a Run, and 24
 * Runs or more, bring every pooled figure of the Series, and every newest
 * point's through, to the 1,000 requests a 99.9th percentile needs: below
 * that a pooled percentile is null and its at_or_above lacks it, a change of
 * shape, though one that happens at most once per percentile. Nothing in it
 * was measured.
 */
export async function makeLongFixture(count: number): Promise<LongFixture> {
	const made = new HandMade();
	for (let i = 0; i < count; i++) {
		const at = new Date(Date.UTC(2026, 10, 1) + Math.floor(i / 4) * 86_400_000 + (i % 4) * 6 * 3_600_000 + 13 * 60_000);
		const startedAt = at.toISOString().replace(".000Z", "Z");
		made.run({ startedAt, benchmark: "syscall", binary: "syscall", params: { call: "getpid" }, samplesNs: [94, 95, 96], bytesPerRepetition: null });
		requestRun(made, { startedAt: startedAt.replace(":13:", ":20:"), stream: { connection: "new", requests: rampRequests(100, 20_000_000, 50_000) } });
	}
	const files = [...made.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const seriesFile = series.derive(files, await series.gather(files, made.fetch));
	const requestsFile = requests.derive(files, await requests.gather(files, made.fetch));
	const runs = mkdtempSync(join(tmpdir(), "api-long-runs-"));
	for (const file of made.files) {
		mkdirSync(dirname(join(runs, file.path)), { recursive: true });
		writeFileSync(join(runs, file.path), `${JSON.stringify(file.record, null, 2)}\n`);
	}
	const id = (benchmark: string): string => (seriesFile.derivations.find((d) => d.series.benchmark === benchmark) as SeriesFile["derivations"][number]).series.id;
	return {
		runs,
		series: JSON.parse(series.serialize(seriesFile)) as SeriesFile,
		requests: JSON.parse(requests.serialize(requestsFile)) as RequestsFile,
		syscall: id("syscall"),
		http: id("http_get"),
	};
}
