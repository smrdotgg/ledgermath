/**
 * What Method requests, version 1, writes: one file of Derivations, one per
 * Series whose samples are requests. Each names the Method and its version
 * and cites every Run it used by id, path and the sha256 of the Run file.
 * Every number in it is derived from those Runs alone, and the page and the
 * lookup tool need nothing else.
 */

import type { ParamValue } from "../../run";
import type { Facts, LeftOut, SplitFact } from "../../v1/facts";
import type { CitedRun } from "../../v1/output";
import type { PercentileName, Stats } from "./numbers";
import type { FailureCount } from "./record";
import type { Failure, Phase, RequestFact } from "./requests";

export type { CitedRun, FailureCount, Stats };

export interface MethodName {
	name: "requests";
	version: 1;
}

/**
 * The pooled figures as they stood at one Run: the counted Runs of the
 * Series (or of its group) that started at or before it, their succeeded
 * requests' statistics per phase, and their failures. What a citation of an
 * earlier moment is checked against.
 */
export interface PoolSummary {
	runs: number;
	requests: number;
	failed: number;
	phases: Partial<Record<Phase, Stats>>;
	failures: FailureCount[];
}

/** One phase pooled: its statistics, read from the summed tally, and the tally's bins. */
export interface PooledPhase extends Stats {
	/** [bin, count] in bin order, no empty bin (numbers.ts, binOf). */
	histogram: Array<[number, number]>;
}

/** The pooled figures for the requests that had one value of a request fact. */
export interface BreakdownValue {
	value: string;
	/** Counted Runs with at least one succeeded request of this value. */
	runs: number;
	requests: number;
	phases: Partial<Record<Phase, Stats>>;
}

/** A request fact that took more than one value among a pool's requests. */
export interface Breakdown {
	fact: RequestFact;
	values: BreakdownValue[];
}

/** Every succeeded request of a set of counted Runs, pooled. */
export interface Pool {
	runs: number;
	requests: number;
	failed: number;
	phases: Partial<Record<Phase, PooledPhase>>;
	failures: FailureCount[];
	setups_failed: FailureCount[];
	/** Each request fact with more than one value in the pool; none when every request had the same. */
	by: Breakdown[];
}

/** One Run of a Series. */
export interface Point {
	run: string;
	path: string;
	started_at: string;
	boot: string;
	/** The group its split facts put it in: version 1's split facts, so the same letters as series v1. */
	group: string;
	/** False for a failed Run: shown, in no figure. */
	counted: boolean;
	failure: string | null;
	/** The binary's exit code, or null when a signal ended it. */
	exit_code: number | null;
	/** Counted samples in its stream (counted requests); null when there was none to count. */
	counted_requests: number | null;
	/** Of the counted requests, those that succeeded and those that failed; 0 for a failed Run. */
	succeeded: number;
	failed: number;
	/** Its own requests' statistics per phase, exactly; empty for a failed Run or one whose every request failed. */
	phases: Partial<Record<Phase, Stats>>;
	failures: FailureCount[];
	setups_failed: FailureCount[];
	warmup_failure: Failure | null;
	/** The Series' pooled figures through this Run; null before its first counted Run. */
	through: PoolSummary | null;
	/** Its group's pooled figures through this Run, when the Series has more than one group. */
	group_through: PoolSummary | null;
}

export interface Group {
	/** A, B, C… in the order each first appears in the Series. */
	id: string;
	facts: Facts;
	/** Every Run in the group, counted or not, in time order. */
	runs: string[];
	pool: Pool;
}

export interface SeriesDerivation {
	method: MethodName;
	series: {
		id: string;
		benchmark: string;
		params: Record<string, ParamValue>;
		build: string;
		instance_type: string | null;
		availability_zone_id: string | null;
	};
	/** Every Run this Derivation used, in time order. */
	runs: CitedRun[];
	points: Point[];
	/** Across every counted Run of the Series, whatever its group. */
	pool: Pool;
	groups: Group[];
}

export interface DerivationsFile {
	schema: "ledgermath.derivations/1";
	method: MethodName;
	/** How each number is made, in words. */
	definitions: Record<string, string>;
	phases: Array<{ phase: Phase; name: string; interval: string }>;
	/** The percentiles reported, and the fewest requests that support each. */
	percentiles: Array<{ name: PercentileName; per_mille: number; least_requests: number }>;
	histogram: { bins_per_doubling: number; exact_below_ns: number; precision: number; definition: string };
	request_facts: Array<{ fact: RequestFact; what: string }>;
	split_on: readonly SplitFact[];
	left_out: readonly LeftOut[];
	/** Run files read, of every kind. */
	runs_read: number;
	/** Run files that do not validate against schemas/run.schema.json, and are in no Series. */
	unreadable: Array<CitedRun & { reason: string }>;
	derivations: SeriesDerivation[];
}
