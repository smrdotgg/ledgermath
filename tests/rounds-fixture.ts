/**
 * A Runs repository checkout of rounds of boots, for the tests of the data
 * API's newest rounds (tests/api-rounds.test.ts) and of what can be added to
 * the Runs data (tests/api-additions.test.ts): six rounds on 2026-11-20 and 21,
 * each boot with its summary (named, as a box names it, by a UUID: the
 * kernel's boot id) and a syscall Run, on the five instance types the
 * schedule boots ten minutes apart. Nothing in it was measured.
 *
 * - 04:11, a full round: five boots.
 * - 10:11, a round missing c8i.2xlarge (refused for capacity: no boot), whose
 *   c8a.2xlarge boot started 8.5 minutes late: 27.6 minutes after the boot
 *   before it, still the same round.
 * - 13:44, a boot of m5.large started by hand between two rounds: a round of
 *   its own.
 * - 16:11, a round whose c8i.2xlarge boot started 8.5 minutes late; its
 *   m5.large boot also left a Run that crashed (failed), a build that failed
 *   and a parameter set not run.
 * - 22:11, three boots before midnight UTC; its c6i.8xlarge boot also left two
 *   Runs of a Series of requests: one that exited 4, a request having failed
 *   (Method requests v1 counts it, Method series v1 does not), and one that
 *   exited 1 (neither counts it).
 * - 23:55, three boots on either side of midnight UTC (their summaries under
 *   two days), 64 minutes after the round before: one round; its c8i.2xlarge
 *   boot's summary also lists a Run whose Run file is not in the checkout.
 * - 02:31 on 2026-11-21, a boot whose id could not be read: its Run's boot is
 *   empty and its summary is boots/2026/11/21/unknown.json, as the runner
 *   writes them. The API does not serve that address, so the summary is in no
 *   round, and no point links it.
 * - 03:31 on 2026-11-21, a Run of a boot whose id is not a UUID (NOT_A_UUID),
 *   and no summary of it: what a summary named so would claim.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as requestsMethod from "../methods/requests/v1";
import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import type { Run } from "../methods/run";
import * as seriesMethod from "../methods/v1";
import type { DerivationsFile as SeriesFile } from "../methods/v1/output";
import { HandMade, rampRequests, requestRun } from "./hand-made-requests";
import { bootSummaryPath, bootSummaryText, type HandMadeBoot } from "./hand-made-runs";

export const C6I = "c6i.8xlarge";
export const M5 = "m5.large";
export const C8I = "c8i.2xlarge";
export const C8A = "c8a.2xlarge";
export const I4I = "i4i.2xlarge";

/** A boot's id as a box gives it, the kernel's boot id, a UUID in lowercase hex: here made from a name, so a test can name its boots. */
export function idOf(name: string): string {
	const hex = createHash("sha256").update(`boot ${name}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The summary of the fixture's boot whose id could not be read, where the runner writes it. */
export const UNKNOWN = "boots/2026/11/21/unknown.json";
/** The boot of the fixture's Run whose boot id is not a UUID; the fixture holds no summary of it. */
export const NOT_A_UUID = "boot-by-another-name";

export interface RoundsFixture {
	/** The checkout: runs/ and boots/. */
	runs: string;
	series: SeriesFile;
	requests: RequestsFile;
	/** Each boot of a round, by the name the test gives it. */
	boots: Record<string, HandMadeBoot>;
	/** The Series of requests, and the ids of its Run that exited 4 and its Run that exited 1. */
	http: string;
	exitedFour: string;
	exitedOne: string;
	/** The Run the 23:55 round's c8i.2xlarge boot lists that has no Run file. */
	missing: string;
	/** The Run of the boot whose id could not be read. */
	unknownRun: string;
	/** The Run of the boot whose id is not a UUID, with its start. */
	notUuidRun: Run;
}

/** The whole second of a boot's start, plus `minutes`, as a hand-made Run's start. */
export const after = (startedAt: string, minutes: number): string => new Date(Date.parse(`${startedAt.slice(0, 19)}Z`) + minutes * 60_000).toISOString().replace(".000Z", "Z");

export async function makeRoundsFixture(): Promise<RoundsFixture> {
	const made = new HandMade();
	const boots: Record<string, HandMadeBoot> = {};
	const syscall = (boot: string, type: string, startedAt: string): Run =>
		made.run({ startedAt: after(startedAt, 1), benchmark: "syscall", binary: "syscall", params: { call: "getpid" }, samplesNs: [94, 95, 96], bytesPerRepetition: null, instanceType: type, boot });
	const add = (name: string, type: string, startedAt: string, more: Partial<HandMadeBoot> = {}, extra: Run[] = []): void => {
		const boot = idOf(name);
		boots[name] = { boot, startedAt, endedAt: after(startedAt, 13).replace("Z", ".000000000Z"), instanceType: type, ...more, runs: [syscall(boot, type, startedAt), ...extra] };
	};

	add("full-c6i", C6I, "2026-11-20T04:11:43.100000001Z");
	add("full-m5", M5, "2026-11-20T04:21:53.200000002Z");
	add("full-c8i", C8I, "2026-11-20T04:31:52.300000003Z");
	add("full-c8a", C8A, "2026-11-20T04:41:51.400000004Z");
	add("full-i4i", I4I, "2026-11-20T04:51:50.500000005Z");

	add("gap-c6i", C6I, "2026-11-20T10:11:43.000000000Z");
	add("gap-m5", M5, "2026-11-20T10:21:53.000000000Z");
	add("gap-c8a", C8A, "2026-11-20T10:49:30.000000000Z");
	add("gap-i4i", I4I, "2026-11-20T10:51:50.000000000Z");

	add("hand-m5", M5, "2026-11-20T13:44:05.000000000Z");

	const lateM5 = "2026-11-20T16:21:53.000000000Z";
	add("late-c6i", C6I, "2026-11-20T16:11:43.000000000Z");
	add(
		"late-m5",
		M5,
		lateM5,
		{ buildFailures: [{ benchmark: "memory_write", build: "static" }], notRun: [{ benchmark: "memory_copy", build: "static", params: { size_bytes: 4096 } }] },
		[made.run({ startedAt: after(lateM5, 2), instanceType: M5, boot: idOf("late-m5"), samplesNs: [7e6, 7e6, 7e6], crashAfter: 1 })],
	);
	add("late-c8i", C8I, "2026-11-20T16:39:30.000000000Z");
	add("late-c8a", C8A, "2026-11-20T16:41:51.000000000Z");
	add("late-i4i", I4I, "2026-11-20T16:51:50.000000000Z");

	const evening = "2026-11-20T22:11:44.000000000Z";
	const failedRequest = { connection: "new" as const, requests: [...rampRequests(3, 21_000_000, 40_000), { fail: { phase: "first_byte" as const, error: "timeout" } }] };
	const four = requestRun(made, { startedAt: after(evening, 2), boot: idOf("evening-c6i"), exit: { code: 4 }, stream: failedRequest });
	const one = requestRun(made, { startedAt: after(evening, 3), boot: idOf("evening-c6i"), exit: { code: 1 }, stream: failedRequest });
	add("evening-c6i", C6I, evening, {}, [four, one]);
	add("evening-m5", M5, "2026-11-20T22:21:53.000000000Z");
	add("evening-c8i", C8I, "2026-11-20T22:31:52.000000000Z");

	const missing = "019aa3c0-0000-7000-8000-000000000001";
	const noFile = { id: missing, benchmark: "syscall", params: { call: "getpid" }, binary: { build: "static" }, exit: { code: 0 } } as unknown as Run;
	add("midnight-c6i", C6I, "2026-11-20T23:55:00.500000000Z");
	add("midnight-m5", M5, "2026-11-21T00:05:10.000000000Z");
	add("midnight-c8i", C8I, "2026-11-21T00:15:20.000000000Z", {}, [noFile]);

	// A boot whose id could not be read: the runner writes its Runs with an empty boot and its summary as unknown.json.
	const unknownAt = "2026-11-21T02:31:00.000000000Z";
	const unknownRun = syscall("", M5, unknownAt);
	// A Run of a boot whose id is not a UUID, and no summary of it.
	const notUuidRun = syscall(NOT_A_UUID, M5, "2026-11-21T03:31:00.000000000Z");

	const files = [...made.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const series = seriesMethod.derive(files, await seriesMethod.gather(files, made.fetch));
	const requests = requestsMethod.derive(files, await requestsMethod.gather(files, made.fetch));
	const runs = mkdtempSync(join(tmpdir(), "api-rounds-runs-"));
	const put = (path: string, text: string): void => {
		mkdirSync(dirname(join(runs, path)), { recursive: true });
		writeFileSync(join(runs, path), text);
	};
	for (const file of made.files) put(file.path, `${JSON.stringify(file.record, null, 2)}\n`);
	for (const boot of Object.values(boots)) put(bootSummaryPath(boot), bootSummaryText(boot));
	put(UNKNOWN, bootSummaryText({ boot: "", startedAt: unknownAt, instanceType: M5, runs: [unknownRun] }));
	const http = (series.derivations.find((d) => d.series.benchmark === "http_get") as SeriesFile["derivations"][number]).series.id;
	return {
		runs,
		series: JSON.parse(seriesMethod.serialize(series)) as SeriesFile,
		requests: JSON.parse(requestsMethod.serialize(requests)) as RequestsFile,
		boots,
		http,
		exitedFour: four.id,
		exitedOne: one.id,
		missing,
		unknownRun: unknownRun.id,
		notUuidRun,
	};
}
