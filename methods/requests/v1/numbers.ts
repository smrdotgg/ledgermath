/**
 * Method requests, version 1: the arithmetic. Percentiles of a Run's own
 * requests, exactly; the rule for which percentiles a count supports; the
 * histogram every phase's times are tallied in, defined once, so that the
 * tallies of different Runs add; and percentiles read back from a tally.
 * Pure: no clock, no I/O.
 */

/** The percentiles reported, each as a whole number per mille. */
export const PERCENTILES = [
	{ name: "p50", perMille: 500 },
	{ name: "p90", perMille: 900 },
	{ name: "p95", perMille: 950 },
	{ name: "p99", perMille: 990 },
	{ name: "p99.9", perMille: 999 },
] as const;

export type PercentileName = (typeof PERCENTILES)[number]["name"];

/**
 * The support rule: the q-th per-mille percentile of n values is reported
 * only when n × (1000 − q) ≥ 1000, that is when at least one of the n values
 * is expected above it. So a median needs 2 values, a 90th 10, a 95th 20, a
 * 99th 100 and a 99.9th 1000.
 */
export function supports(count: number, perMille: number): boolean {
	return count * (1000 - perMille) >= 1000;
}

/** The fewest values that support the percentile. */
export function leastCount(perMille: number): number {
	return Math.ceil(1000 / (1000 - perMille));
}

/**
 * How many of n values are ranked at or above the q-th per-mille percentile:
 * with the values sorted as x[0..n-1] and h = (n − 1) × q / 1000, the
 * percentile lies between x[⌊h⌋] and x[⌈h⌉], and n − ⌈h⌉ values are ranked at
 * or above it. Ties are counted by rank, not by value. For a 99th percentile
 * of 200 requests that is 2.
 */
export function atOrAbove(count: number, perMille: number): number {
	const scaled = (count - 1) * perMille;
	return count - Math.floor((scaled + 999) / 1000);
}

/**
 * The q-th per-mille percentile of sorted values by linear interpolation
 * between closest ranks (R type 7, Method series v1's rule): h = (n − 1) × q
 * / 1000, and the percentile is x[⌊h⌋] + (h − ⌊h⌋) × (x[⌊h⌋+1] − x[⌊h⌋]).
 * (n − 1) × q is a whole number, so the rank's whole part is exact.
 */
export function percentileOfSorted(sorted: readonly number[], perMille: number): number {
	if (sorted.length === 0) throw new Error("a percentile of no values");
	const scaled = (sorted.length - 1) * perMille;
	const low = Math.floor(scaled / 1000);
	const rest = scaled - low * 1000;
	const lower = sorted[low] as number;
	if (rest === 0) return lower;
	return lower + (rest / 1000) * ((sorted[low + 1] as number) - lower);
}

/**
 * What is reported of one phase's times: their count, least and greatest,
 * each percentile the count supports (null otherwise), and for each one
 * reported how many times are ranked at or above it.
 */
export interface Stats {
	count: number;
	min: number;
	max: number;
	p50: number | null;
	p90: number | null;
	p95: number | null;
	p99: number | null;
	"p99.9": number | null;
	at_or_above: Partial<Record<PercentileName, number>>;
}

function statsFrom(count: number, min: number, max: number, at: (perMille: number) => number): Stats {
	const stats: Stats = { count, min, max, p50: null, p90: null, p95: null, p99: null, "p99.9": null, at_or_above: {} };
	for (const { name, perMille } of PERCENTILES) {
		if (!supports(count, perMille)) continue;
		stats[name] = at(perMille);
		stats.at_or_above[name] = atOrAbove(count, perMille);
	}
	return stats;
}

/** The statistics of a Run's own times, exactly. */
export function exactStats(values: readonly number[]): Stats {
	if (values.length === 0) throw new Error("the statistics of no values");
	const sorted = [...values].sort((a, b) => a - b);
	return statsFrom(sorted.length, sorted[0] as number, sorted[sorted.length - 1] as number, (perMille) => percentileOfSorted(sorted, perMille));
}

// ---------------------------------------------------------------- the histogram

/** Bins per doubling of time. */
export const SUB_BINS = 64;

/**
 * The bin a time of `ns` whole nanoseconds falls in. Below 128 ns every
 * nanosecond is its own bin (bin = ns). From 128 ns, with e = ⌊log2 ns⌋, each
 * doubling [2^e, 2^(e+1)) is cut into 64 bins of width 2^(e−6):
 * bin = 64 × (e − 5) + ⌊ns / 2^(e−6)⌋ − 64. Every power of two is exact in a
 * double, so the bin is computed exactly.
 */
export function binOf(ns: number): number {
	if (!Number.isInteger(ns) || ns < 0) throw new Error(`${ns} is not a whole number of nanoseconds`);
	if (ns < 2 * SUB_BINS) return ns;
	let e = 7;
	while (2 ** (e + 1) <= ns) e++;
	return SUB_BINS * (e - 5) + Math.floor(ns / 2 ** (e - 6)) - SUB_BINS;
}

/** The width of a bin in nanoseconds: 1 below bin 128, then 2^(⌊bin / 64⌋ − 1). */
export function binWidth(bin: number): number {
	return bin < 2 * SUB_BINS ? 1 : 2 ** (Math.floor(bin / SUB_BINS) - 1);
}

/** The least time in a bin. */
export function binLower(bin: number): number {
	if (bin < 2 * SUB_BINS) return bin;
	return (SUB_BINS + (bin % SUB_BINS)) * binWidth(bin);
}

/**
 * The time a bin stands for when a percentile is read from a tally: the time
 * itself for a bin of width 1, else its lower bound plus half its width. A
 * time in the bin is at most half a width from it, and a width is at most
 * 1/64 of the bin's lower bound, so the error is at most 1/128 of the time
 * (0.79%).
 */
export function binValue(bin: number): number {
	const width = binWidth(bin);
	return width === 1 ? binLower(bin) : binLower(bin) + width / 2;
}

/** The greatest relative error of a percentile read from a tally. */
export const TALLY_PRECISION = 1 / (2 * SUB_BINS);

/**
 * Times tallied: how many, the least and greatest exactly, and how many fell
 * in each bin, as [bin, count] pairs in bin order with no empty bin. Tallies
 * of different Runs add.
 */
export interface Tally {
	count: number;
	min: number;
	max: number;
	bins: Array<[number, number]>;
}

export function tallyOf(values: readonly number[]): Tally {
	if (values.length === 0) throw new Error("a tally of no values");
	const bins = new Map<number, number>();
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const value of values) {
		const bin = binOf(value);
		bins.set(bin, (bins.get(bin) ?? 0) + 1);
		if (value < min) min = value;
		if (value > max) max = value;
	}
	return { count: values.length, min, max, bins: [...bins].sort((a, b) => a[0] - b[0]) };
}

/** Tallies added up as they come: the sum of every tally given to add(). */
export class TallySum {
	private readonly counts = new Map<number, number>();
	count = 0;
	min = Number.POSITIVE_INFINITY;
	max = Number.NEGATIVE_INFINITY;

	add(tally: Tally): void {
		this.count += tally.count;
		if (tally.min < this.min) this.min = tally.min;
		if (tally.max > this.max) this.max = tally.max;
		for (const [bin, n] of tally.bins) this.counts.set(bin, (this.counts.get(bin) ?? 0) + n);
	}

	tally(): Tally | null {
		if (this.count === 0) return null;
		return { count: this.count, min: this.min, max: this.max, bins: [...this.counts].sort((a, b) => a[0] - b[0]) };
	}
}

/**
 * The statistics of tallied times: count, least and greatest exactly; each
 * supported percentile by the same rule as exactStats, with each order
 * statistic x[k] read as the value of the bin it falls in (binValue), held
 * within the least and greatest, and x[0] and x[n−1] exact. Each is within
 * TALLY_PRECISION of the exact percentile of the same times.
 */
export function tallyStats(tally: Tally): Stats {
	const { count, min, max, bins } = tally;
	// The cumulative count at the end of each bin, to find the bin of a rank.
	const ends: number[] = [];
	let total = 0;
	for (const [, n] of bins) ends.push((total += n));
	if (total !== count) throw new Error(`a tally of ${count} whose bins hold ${total}`);
	const orderStatistic = (rank: number): number => {
		if (rank === 0) return min;
		if (rank === count - 1) return max;
		let lo = 0;
		let hi = ends.length - 1;
		while (lo < hi) {
			const middle = (lo + hi) >> 1;
			if ((ends[middle] as number) > rank) hi = middle;
			else lo = middle + 1;
		}
		const value = binValue((bins[lo] as [number, number])[0]);
		return Math.min(max, Math.max(min, value));
	};
	return statsFrom(count, min, max, (perMille) => {
		const scaled = (count - 1) * perMille;
		const low = Math.floor(scaled / 1000);
		const rest = scaled - low * 1000;
		const lower = orderStatistic(low);
		if (rest === 0) return lower;
		return lower + (rest / 1000) * (orderStatistic(low + 1) - lower);
	});
}
