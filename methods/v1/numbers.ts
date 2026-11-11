/**
 * Method version 1: the number a Run gives, and percentiles across Runs.
 * Pure arithmetic on numbers already in the Run; nothing here reads a blob.
 */

import type { RunEvent } from "../run";

/** One counted sample: its two event timestamps' difference, and that per repetition. */
export interface SampleTime {
	/** The sample's number in the stream. */
	sample: number;
	/** sample_ended.t minus sample_started.t, in nanoseconds of the Run's clock. */
	ns: number;
	repetitions: number;
	/** ns / repetitions. */
	ns_per_repetition: number;
}

/** The median: the middle value, or the mean of the two middle values. */
export function median(values: readonly number[]): number {
	if (values.length === 0) throw new Error("the median of no values");
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[middle] as number;
	return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * The p-th percentile (p a whole number from 0 to 100) by linear interpolation
 * between the closest ranks, R's type 7 and numpy's default: with the values
 * sorted as x[0..n-1], h = (n - 1) * p / 100, and the percentile is
 * x[floor(h)] + (h - floor(h)) * (x[floor(h) + 1] - x[floor(h)]).
 * With one value, every percentile is that value.
 */
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) throw new Error("a percentile of no values");
	if (!Number.isInteger(p) || p < 0 || p > 100) throw new Error(`percentile ${p} is not a whole number from 0 to 100`);
	const sorted = [...values].sort((a, b) => a - b);
	// (n - 1) * p is an exact integer, so the rank's whole part is exact too.
	const scaled = (sorted.length - 1) * p;
	const low = Math.floor(scaled / 100);
	const fraction = (scaled - low * 100) / 100;
	const lower = sorted[low] as number;
	if (fraction === 0) return lower;
	const upper = sorted[low + 1] as number;
	return lower + fraction * (upper - lower);
}

/**
 * The counted samples of a stream that obeys the contract's order
 * (stream.ts): each sample_started with warmup false, paired with the
 * sample_ended that follows it. Warmup samples are left out. Walks the stream
 * in order and pairs nothing it cannot: on any other stream it throws.
 */
export function countedSamples(events: readonly RunEvent[]): SampleTime[] {
	const samples: SampleTime[] = [];
	let open: RunEvent | null = null;
	for (const event of events) {
		if (event.event === "sample_started") {
			if (open !== null) throw new Error(`sample ${String(event.sample)} started inside sample ${String(open.sample)}`);
			open = event;
		} else if (event.event === "sample_ended") {
			if (open === null || event.sample !== open.sample) throw new Error(`sample_ended ${String(event.sample)} closes no open sample`);
			if (open.warmup === false) {
				const ns = event.t - open.t;
				const repetitions = open.repetitions as number;
				samples.push({ sample: open.sample as number, ns, repetitions, ns_per_repetition: ns / repetitions });
			}
			open = null;
		}
	}
	if (open !== null) throw new Error(`sample ${String(open.sample)} never ended`);
	return samples;
}

/** What the benchmark observed as bytes_per_repetition, if it did, as a positive number. */
export function observedBytesPerRepetition(events: readonly RunEvent[]): number | null {
	for (const event of events) {
		if (event.event !== "observed") continue;
		const values = event.values as Record<string, unknown>;
		const bytes = values.bytes_per_repetition;
		if (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0) return bytes;
	}
	return null;
}
