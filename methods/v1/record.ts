/**
 * Method version 1's reduced record of a stream (methods/records.ts): its
 * StreamSummary (facts.ts), kept as JSON. Each counted sample is kept as
 * [sample, ns, repetitions]; ns_per_repetition is ns / repetitions again
 * when it is read back, the same division countedSamples makes, so the
 * same double.
 */

import { reducerKey, type StreamReducer } from "../records";
import { readStream } from "../run";
import { type StreamSummary, summarizeStream } from "./facts";
import type { SampleTime } from "./numbers";

/** series-v1-<digest of this module's code and what it imports> (methods/records.ts). */
export const SERIES_RECORD_KEY = reducerKey("series", 1, import.meta.path);

interface SeriesRecordJson {
	problems: string[];
	counted: number | null;
	samples: Array<[number, number, number]> | { error: string };
	bytes_per_repetition: number | null;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function fromJson(value: unknown): StreamSummary | null {
	const json = value as Partial<SeriesRecordJson> | null;
	if (typeof json !== "object" || json === null) return null;
	const { problems, counted, samples, bytes_per_repetition: bytes } = json;
	if (!Array.isArray(problems) || !problems.every((problem) => typeof problem === "string")) return null;
	if (counted !== null && !isNumber(counted)) return null;
	if (bytes !== null && (!isNumber(bytes) || bytes <= 0)) return null;
	let read: SampleTime[] | Error;
	if (Array.isArray(samples)) {
		if (!samples.every((sample) => Array.isArray(sample) && sample.length === 3 && sample.every(isNumber))) return null;
		// It holds together: whole numbers, samples in stream order, times at least 0, repetitions at least 1,
		// and as many samples as the stream counted when it had no problem (none are kept when it had one).
		const whole = samples.every(([sample, ns, repetitions], i) => Number.isInteger(sample) && Number.isInteger(ns) && ns >= 0 && Number.isInteger(repetitions) && repetitions >= 1 && (i === 0 || sample > (samples[i - 1] as [number, number, number])[0]));
		if (!whole) return null;
		if (problems.length > 0 ? samples.length !== 0 : samples.length !== counted) return null;
		read = samples.map(([sample, ns, repetitions]) => ({ sample, ns, repetitions, ns_per_repetition: ns / repetitions }));
	} else if (typeof samples === "object" && samples !== null && typeof samples.error === "string") {
		read = new Error(samples.error);
	} else return null;
	return { problems, counted: counted ?? null, samples: read, bytesPerRepetition: bytes ?? null };
}

export const SERIES_RECORD: StreamReducer<StreamSummary> = {
	key: SERIES_RECORD_KEY,
	reduce: (stdout) => summarizeStream(readStream(stdout)),
	toJson: (summary): SeriesRecordJson => ({
		problems: summary.problems,
		counted: summary.counted,
		samples:
			summary.samples instanceof Error
				? { error: summary.samples.message }
				: summary.samples.map((sample) => [sample.sample, sample.ns, sample.repetitions]),
		bytes_per_repetition: summary.bytesPerRepetition,
	}),
	fromJson,
};
