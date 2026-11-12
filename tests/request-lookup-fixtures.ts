/**
 * A data location holding Series of requests, for the lookup tool's and the
 * answer checker's tests: hand-made http_get Runs (tests/hand-made-requests.ts)
 * and a memory_read Run, their Derivations from Method series v1
 * (derivations.json) and Method requests v1 (requests-derivations.json), and
 * the sample price file, laid out as the Runs repository. Nothing in it was
 * measured.
 */

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as requests from "../methods/requests/v1";
import type { DerivationsFile as RequestsFile, SeriesDerivation as RequestsSeries } from "../methods/requests/v1/output";
import * as series from "../methods/v1";
import type { DerivationsFile } from "../methods/v1/output";
import { HandMade, rampRequests, requestRun } from "./hand-made-requests";
import { SAMPLE_FILE, SAMPLE_PATH } from "./prices-fixtures";

export interface RequestFixture {
	directory: string;
	derivations: DerivationsFile;
	requests: RequestsFile;
	/** 4 KiB over new connections on c6i.8xlarge: two Runs of 200 requests (the second exited 4: 1 timed out), two address blocks. */
	small: RequestsSeries;
	/** 16 MiB over new connections: one Run of 40 requests. */
	big: RequestsSeries;
	/** The memory_read Series' id: no requests. */
	memory: string;
	/** 4 KiB on m5.large: times on six-digit rounding boundaries. */
	boundary: RequestsSeries;
}

export async function makeRequestFixture(options: { withoutRequests?: boolean } = {}): Promise<RequestFixture> {
	const made = new HandMade();
	const near = (i: number) => ({ address: "52.219.176.66", phases: { connect: 150_000, first_byte: 20_000_000 + i * 50_000 } });
	const far = (i: number) => ({ address: "3.5.133.225", phases: { connect: 800_000, first_byte: 22_000_000 + i * 60_000 } });
	requestRun(made, {
		startedAt: "2026-11-12T22:20:00Z",
		instanceType: "c6i.8xlarge",
		stream: { connection: "new", requests: Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? near(i) : far(i))) },
	});
	requestRun(made, {
		startedAt: "2026-11-13T04:20:00Z",
		instanceType: "c6i.8xlarge",
		exit: { code: 4 },
		stream: { connection: "new", requests: [...Array.from({ length: 199 }, (_, i) => (i % 5 === 0 ? near(i + 3) : far(i + 7))), { fail: { phase: "first_byte", error: "timeout" } }] },
	});
	requestRun(made, { startedAt: "2026-11-12T22:22:00Z", instanceType: "c6i.8xlarge", objectBytes: 16777216, stream: { connection: "new", requests: rampRequests(40, 170_000_000, 300_000) } });
	// m5.large: times on the real data's rounding boundaries at six significant digits (1,014,475 ns is 1.01447|5 ms).
	requestRun(made, {
		startedAt: "2026-11-12T22:30:00Z",
		instanceType: "m5.large",
		stream: {
			connection: "new",
			requests: Array.from({ length: 120 }, (_, k) => ({
				phases: { connect: [1_014_475, 1_437_655, 1_745_605][k % 3] as number, tls: 1_480_865, send: 5_031_355, first_byte: 20_000_005 + k * 1_000_010, headers: 1_351_735, body: 1_210_485 },
			})),
		},
	});
	made.run({ startedAt: "2026-11-12T22:10:00Z" });

	const derivations = series.derive(made.files, await series.gather(made.files, made.fetch));
	const requestsFile = requests.derive(made.files, await requests.gather(made.files, made.fetch));
	const directory = mkdtempSync(join(tmpdir(), "request-lookup-"));
	writeFileSync(join(directory, "derivations.json"), series.serialize(derivations));
	if (!options.withoutRequests) writeFileSync(join(directory, "requests-derivations.json"), requests.serialize(requestsFile));
	for (const file of made.files) {
		const path = join(directory, file.path);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(file.record, null, 2)}\n`);
	}
	mkdirSync(join(directory, dirname(SAMPLE_PATH)), { recursive: true });
	copyFileSync(SAMPLE_FILE, join(directory, SAMPLE_PATH));
	const find = (bytes: number): RequestsSeries => {
		const found = requestsFile.derivations.find((d) => d.series.params.object_bytes === bytes && d.series.instance_type === "c6i.8xlarge");
		if (found === undefined) throw new Error(`no Series of requests of ${bytes} bytes`);
		return found;
	};
	const memory = derivations.derivations.find((d) => d.series.benchmark === "memory_read")?.series.id as string;
	const boundary = requestsFile.derivations.find((d) => d.series.instance_type === "m5.large") as RequestsSeries;
	return { directory, derivations, requests: requestsFile, small: find(4096), big: find(16777216), memory, boundary };
}
