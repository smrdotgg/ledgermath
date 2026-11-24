/**
 * A data location for the lookup tool's and the answer checker's tests: Run
 * files from tests/hand-made-runs.ts, their Derivations from Method series v1
 * (and Method requests v1, which derives none of them), and the sample price
 * file (tests/samples/prices), laid out as the Runs repository, with the data
 * API's tree the generator writes from them beside runs/ (tests/tree-fixture.ts).
 * Nothing in it was measured.
 */

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as requests from "../methods/requests/v1";
import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import { derive, gather, serialize } from "../methods/v1";
import type { DerivationsFile, SeriesDerivation } from "../methods/v1/output";
import { HandMade } from "./hand-made-runs";
import { SAMPLE_FILE, SAMPLE_PATH } from "./prices-fixtures";
import { writeTree } from "./tree-fixture";

export const ALL_AVX2 = { size_bytes: 1073741824, threads: "all", path: "avx2" };
const GiB = 1073741824;

export interface Fixture {
	directory: string;
	derivations: DerivationsFile;
	/** memory_read, threads all, on c6i.8xlarge: four Runs, one failed. */
	c6i: SeriesDerivation;
	/** memory_read, threads all, on m5.large: five Runs on two processors, so two groups. */
	m5: SeriesDerivation;
	/** syscall getpid on c6i.8xlarge: one Run, no bytes. */
	syscall: SeriesDerivation;
	/** tcp_echo on c6i.8xlarge: two Runs. */
	tcp: SeriesDerivation;
}

/** Ten samples of `ns` each per repetition, at 100 repetitions a sample. */
const samples = (ns: number): number[] => Array.from({ length: 10 }, () => ns * 100);

export async function makeFixture(): Promise<Fixture> {
	const made = new HandMade();
	// c6i.8xlarge: 7, 8, 9 ms per GiB, and a Run that crashed.
	[7e6, 8e6, 9e6].forEach((ns, i) =>
		made.run({ startedAt: `2026-11-1${i + 2}T04:12:00Z`, params: ALL_AVX2, samplesNs: samples(ns), bytesPerRepetition: GiB }),
	);
	made.run({ startedAt: "2026-11-15T04:12:00Z", params: ALL_AVX2, samplesNs: samples(8e6), crashAfter: 3 });
	// m5.large: two processors.
	[
		["2026-11-12T04:22:00Z", "Intel(R) Xeon(R) Platinum 8175M", 70e6],
		["2026-11-13T04:22:00Z", "Intel(R) Xeon(R) Platinum 8259CL", 64e6],
		["2026-11-14T04:22:00Z", "Intel(R) Xeon(R) Platinum 8175M", 72e6],
		["2026-11-15T04:22:00Z", "Intel(R) Xeon(R) Platinum 8175M", 74e6],
		["2026-11-16T04:22:00Z", "Intel(R) Xeon(R) Platinum 8259CL", 66e6],
	].forEach(([startedAt, processor, ns]) =>
		made.run({
			startedAt: startedAt as string,
			instanceType: "m5.large",
			params: ALL_AVX2,
			processor: processor as string,
			samplesNs: samples(ns as number),
			bytesPerRepetition: GiB,
		}),
	);
	made.run({ startedAt: "2026-11-12T04:13:00Z", benchmark: "syscall", binary: "syscall", params: { call: "getpid" }, samplesNs: samples(94.7), bytesPerRepetition: null });
	[14e3, 15e3].forEach((ns, i) =>
		made.run({ startedAt: `2026-11-1${i + 2}T04:14:00Z`, benchmark: "tcp_echo", binary: "tcp_echo", params: { size_bytes: 32768 }, samplesNs: samples(ns), bytesPerRepetition: 32768 }),
	);

	// As a reader of the files would have them, not the objects the Methods returned.
	const derivations = JSON.parse(serialize(derive(made.files, await gather(made.files, made.fetch)))) as DerivationsFile;
	const none = JSON.parse(requests.serialize(requests.derive(made.files, await requests.gather(made.files, made.fetch)))) as RequestsFile;
	const directory = mkdtempSync(join(tmpdir(), "lookup-"));
	for (const file of made.files) {
		const path = join(directory, file.path);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(file.record, null, 2)}\n`);
	}
	mkdirSync(join(directory, dirname(SAMPLE_PATH)), { recursive: true });
	copyFileSync(SAMPLE_FILE, join(directory, SAMPLE_PATH));
	writeTree(directory, derivations, none);

	const find = (benchmark: string, type: string): SeriesDerivation => {
		const found = derivations.derivations.find((d) => d.series.benchmark === benchmark && d.series.instance_type === type);
		if (found === undefined) throw new Error(`no ${benchmark} Series on ${type}`);
		return found;
	};
	return {
		directory,
		derivations,
		c6i: find("memory_read", "c6i.8xlarge"),
		m5: find("memory_read", "m5.large"),
		syscall: find("syscall", "c6i.8xlarge"),
		tcp: find("tcp_echo", "c6i.8xlarge"),
	};
}

/** The c6i.8xlarge price in the sample file, and its citation. */
export const C6I_SKU = "NKB8DU47ZKKBXW65";
export const C6I_RATE = "NKB8DU47ZKKBXW65.JRTCKXETXF.6YS6EN2CT7";
export const C6I_PRICE_CITATION = `[lm:${SAMPLE_PATH}#${C6I_SKU}/${C6I_RATE}]`;
