/**
 * What Method version 1 writes: one file of Derivations. Each Derivation is
 * one Series, names the Method and its version, and cites every Run it used
 * by id, path and the sha256 of the Run file. Every number in it is derived
 * from those Runs alone, and the page needs nothing else.
 */

import type { ParamValue } from "../run";
import type { Facts, LeftOut, SplitFact } from "./facts";
import type { SampleTime } from "./numbers";

export interface MethodName {
	name: "series";
	version: 1;
}

export interface CitedRun {
	id: string;
	/** From the root of the Runs repository: runs/<yyyy>/<mm>/<dd>/<id>.json. */
	path: string;
	/** The sha256 of the Run file's bytes, in hex. */
	sha256: string;
}

/** One Run on a Series' chart. */
export interface Point {
	run: string;
	path: string;
	started_at: string;
	boot: string;
	/** The group its split facts put it in. */
	group: string;
	/** False for a failed Run: shown, never in a percentile. */
	counted: boolean;
	/** Why it is not counted, or null. */
	failure: string | null;
	/** Its counted samples, in stream order; empty when it is not counted. */
	samples: SampleTime[];
	/** The median of the samples' ns_per_repetition. */
	time_per_repetition_ns: number | null;
	/** As the benchmark observed it, when it did and the Run counts. */
	bytes_per_repetition: number | null;
	/** bytes_per_repetition * 1e9 / time_per_repetition_ns. */
	bytes_per_second: number | null;
}

/** Percentiles of one number across Runs, and the Runs they come from. */
export interface Stat {
	count: number;
	runs: string[];
	p5: number;
	p50: number;
	p95: number;
}

export interface Percentiles {
	time_per_repetition_ns: Stat | null;
	bytes_per_second: Stat | null;
}

export interface Group {
	/** A, B, C… in the order each first appears in the Series. */
	id: string;
	facts: Facts;
	/** Every Run in the group, counted or not, in time order. */
	runs: string[];
	percentiles: Percentiles;
}

/**
 * What a changed section did to the split: "splits" when its split fact
 * differs, "left out" when it is split on but differs only in what LEFT_OUT
 * lists, "not split on" when no split fact is read from it.
 */
export type SectionEffect = "splits" | "left out" | "not split on";

/** What differed between two consecutive Runs of a Series. */
export interface Differed {
	from: string;
	to: string;
	/** Split facts whose values differ. */
	facts: string[];
	/** Sections of the before-dump whose hashes differ, split on or not. */
	sections: Array<{
		section: string;
		effect: SectionEffect;
		/** The section's top-level keys whose values differ; null when not read, or present on one side only. */
		keys: string[] | null;
	}>;
}

/** How often a dump section's hash changed. */
export interface SectionCounts {
	section: string;
	/** Runs whose dumps hold the section. */
	runs: number;
	/** Of those, the Runs whose before-dump and after-dump hold different hashes for it. */
	changed_within_run: number;
	/** Pairs of consecutive Runs in a Series. */
	pairs: number;
	/** Of those, the pairs whose before-dumps hold different hashes for it. */
	changed_between_runs: number;
	/** The split fact read from it, or null. */
	split_on: string | null;
}

/** How often a dump section's hash changed, over every Run read. */
export interface SectionEvidence {
	section: string;
	runs: number;
	/** Runs whose before-dump and after-dump hold different hashes for it. */
	changed_within_run: number;
	/** Pairs of consecutive Runs of one boot, whatever their Series. */
	boot_pairs: number;
	/** Of those, the pairs whose before-dumps hold different hashes for it. */
	changed_within_boot: number;
	/** Pairs of consecutive Runs of one Series, summed over every Series. */
	series_pairs: number;
	changed_between_runs: number;
	split_on: string | null;
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
	percentiles: Percentiles;
	groups: Group[];
	differed: Differed[];
	sections: SectionCounts[];
}

export interface DerivationsFile {
	schema: "ledgermath.derivations/1";
	method: MethodName;
	/** How each number is made, in words, for the page. */
	definitions: Record<string, string>;
	split_on: readonly SplitFact[];
	/** What is left out of a section before it is compared for the split, and why. */
	left_out: readonly LeftOut[];
	not_split_on: readonly SplitFact[];
	/** Run files read. */
	runs_read: number;
	/** Run files that do not validate against schemas/run.schema.json, and are in no Series. */
	unreadable: Array<CitedRun & { reason: string }>;
	/** How often each dump section changed, over every Run read: the evidence for the split facts. */
	sections: SectionEvidence[];
	derivations: SeriesDerivation[];
}
