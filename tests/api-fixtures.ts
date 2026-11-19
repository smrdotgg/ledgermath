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
	syscall: string;
	http: string;
	/** The unreadable Run file's path. */
	unreadable: string;
}

const samples = (ns: number): number[] => Array.from({ length: 10 }, (_, i) => ns + i * 1000);

export async function makeApiFixture(options: { extraSyscallRun?: boolean } = {}): Promise<ApiFixture> {
	const made = new HandMade();
	made.run({ startedAt: "2026-11-12T04:12:00Z", samplesNs: samples(7e6) });
	made.run({ startedAt: "2026-11-13T04:12:00Z", samplesNs: samples(8e6) });
	made.run({ startedAt: "2026-11-14T04:12:00Z", samplesNs: samples(9e6), processor: "Intel(R) Xeon(R) Platinum 8259CL" });
	made.run({ startedAt: "2026-11-15T04:12:00Z", samplesNs: samples(8e6), crashAfter: 3 });
	made.run({ startedAt: "2026-11-12T04:13:00Z", benchmark: "syscall", binary: "syscall", params: { call: "getpid" }, samplesNs: samples(94.7), bytesPerRepetition: null });
	requestRun(made, { startedAt: "2026-11-12T22:20:00Z", stream: { connection: "new", requests: rampRequests(40, 20_000_000, 50_000) } });
	requestRun(made, {
		startedAt: "2026-11-13T04:20:00Z",
		exit: { code: 4 },
		stream: { connection: "new", requests: [...rampRequests(39, 21_000_000, 40_000), { fail: { phase: "first_byte", error: "timeout" } }] },
	});
	if (options.extraSyscallRun) {
		made.run({ startedAt: "2026-11-16T04:13:00Z", benchmark: "syscall", binary: "syscall", params: { call: "getpid" }, samplesNs: samples(95.1), bytesPerRepetition: null });
	}

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
		syscall: id("syscall"),
		http: id("http_get"),
		unreadable: unreadablePath,
	};
}
