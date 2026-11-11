/**
 * Method requests, version 1: the reduced record of one stream
 * (methods/records.ts). Everything the Method takes from a stream, and
 * nothing proportional to the number of requests beyond the histogram's bins:
 * whether the stream's samples are requests, the problems that keep its Run
 * out of every figure, the number of counted samples, and of its counted
 * requests each phase's exact statistics and tally, the tallies broken down
 * by what each request recorded of its connection, and the failures counted
 * by phase and kind. Pooled figures are made from these records alone.
 */

import type { StreamReducer } from "../../records";
import { readStream } from "../../run";
import { summarizeStream } from "../../v1/facts";
import { exactStats, type Stats, type Tally, tallyOf } from "./numbers";
import { type Failure, holdsRequests, PHASES, type Phase, REQUEST_FACTS, type RequestFact, readRequests } from "./requests";

/** Revision 1: the first form. */
export const REQUESTS_RECORD_KEY = "requests-v1-r1";

export interface FailureCount extends Failure {
	count: number;
}

/** One phase of a Run's requests: its statistics, exactly, and its tally, for pooling. */
export interface RunPhase {
	stats: Stats;
	tally: Tally;
}

/**
 * One value of a request fact in a Run, and the tallies of the requests that
 * had it. Null tallies mean every succeeded request of the Run had this
 * value: its tallies are the Run's own.
 */
export interface ByValue {
	value: string;
	requests: number;
	phases: Partial<Record<Phase, Tally>> | null;
}

export interface RequestsRecord {
	/** Whether the stream's samples are requests (requests.ts, holdsRequests). */
	holds_requests: boolean;
	/** Why the Run is in no figure, as far as its stream alone says; empty when nothing does. */
	problems: string[];
	/** Counted samples in the stream; null when it had no event to count. */
	counted: number | null;
	/** Counted requests that succeeded and that failed; 0 when there are problems. */
	succeeded: number;
	failed: number;
	phases: Partial<Record<Phase, RunPhase>>;
	by: Partial<Record<RequestFact, ByValue[]>>;
	failures: FailureCount[];
	warmup_failure: Failure | null;
	setups_failed: FailureCount[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function countFailures(failures: readonly Failure[]): FailureCount[] {
	const counts = new Map<string, FailureCount>();
	for (const { phase, kind } of failures) {
		const key = `${phase}\u0000${kind}`;
		const found = counts.get(key);
		if (found === undefined) counts.set(key, { phase, kind, count: 1 });
		else found.count++;
	}
	return [...counts.values()].sort((a, b) => compare(a.phase, b.phase) || compare(a.kind, b.kind));
}

/** The record of one stdout blob. */
export function reduceRequests(stdout: Uint8Array): RequestsRecord {
	const stream = readStream(stdout);
	const summary = summarizeStream(stream);
	const record: RequestsRecord = {
		holds_requests: holdsRequests(stream.events),
		problems: [...summary.problems],
		counted: summary.counted,
		succeeded: 0,
		failed: 0,
		phases: {},
		by: {},
		failures: [],
		warmup_failure: null,
		setups_failed: [],
	};
	if (!record.holds_requests || record.problems.length > 0) return record;
	const read = readRequests(stream.events);
	if (read.problems.length > 0) {
		record.problems.push(...read.problems);
		return record;
	}
	record.succeeded = read.succeeded.length;
	record.failed = read.failed.length;
	record.failures = countFailures(read.failed);
	record.warmup_failure = read.warmupFailure;
	record.setups_failed = countFailures(read.setupsFailed);
	const tallies = (requests: typeof read.succeeded): Partial<Record<Phase, Tally>> => {
		const out: Partial<Record<Phase, Tally>> = {};
		for (const phase of PHASES) {
			const values = requests.flatMap((request) => (request.phases[phase] === undefined ? [] : [request.phases[phase] as number]));
			if (values.length > 0) out[phase] = tallyOf(values);
		}
		return out;
	};
	for (const phase of PHASES) {
		const values = read.succeeded.flatMap((request) => (request.phases[phase] === undefined ? [] : [request.phases[phase] as number]));
		if (values.length > 0) record.phases[phase] = { stats: exactStats(values), tally: tallyOf(values) };
	}
	if (read.succeeded.length > 0) {
		for (const fact of REQUEST_FACTS) {
			const byValue = new Map<string, typeof read.succeeded>();
			for (const request of read.succeeded) {
				const list = byValue.get(request.facts[fact]) ?? [];
				list.push(request);
				byValue.set(request.facts[fact], list);
			}
			record.by[fact] = [...byValue]
				.sort(([a], [b]) => compare(a, b))
				.map(([value, requests]) => ({ value, requests: requests.length, phases: byValue.size === 1 ? null : tallies(requests) }));
		}
	}
	return record;
}

// ---------------------------------------------------------------- the kept form

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isTally = (value: unknown): value is Tally =>
	isObject(value) &&
	isNumber(value.count) &&
	isNumber(value.min) &&
	isNumber(value.max) &&
	Array.isArray(value.bins) &&
	value.bins.every((bin) => Array.isArray(bin) && bin.length === 2 && isNumber(bin[0]) && isNumber(bin[1]));
const isStats = (value: unknown): value is Stats =>
	isObject(value) && isNumber(value.count) && isNumber(value.min) && isNumber(value.max) && isObject(value.at_or_above);
const isFailure = (value: unknown): value is Failure => isObject(value) && typeof value.phase === "string" && typeof value.kind === "string";
const isFailureCount = (value: unknown): value is FailureCount => isObject(value) && isFailure(value) && isNumber(value.count);
const phasesOf = <T>(value: unknown, item: (v: unknown) => v is T): value is Partial<Record<Phase, T>> =>
	isObject(value) && Object.entries(value).every(([phase, v]) => (PHASES as readonly string[]).includes(phase) && item(v));

function fromJson(value: unknown): RequestsRecord | null {
	if (!isObject(value)) return null;
	const v = value;
	if (typeof v.holds_requests !== "boolean") return null;
	if (!Array.isArray(v.problems) || !v.problems.every((problem) => typeof problem === "string")) return null;
	if (v.counted !== null && !isNumber(v.counted)) return null;
	if (!isNumber(v.succeeded) || !isNumber(v.failed)) return null;
	if (!phasesOf(v.phases, (p): p is RunPhase => isObject(p) && isStats(p.stats) && isTally(p.tally))) return null;
	if (!isObject(v.by)) return null;
	for (const [fact, values] of Object.entries(v.by)) {
		if (!(REQUEST_FACTS as readonly string[]).includes(fact) || !Array.isArray(values)) return null;
		for (const item of values) {
			if (!isObject(item) || typeof item.value !== "string" || !isNumber(item.requests)) return null;
			if (item.phases !== null && !phasesOf(item.phases, isTally)) return null;
		}
	}
	if (!Array.isArray(v.failures) || !v.failures.every(isFailureCount)) return null;
	if (v.warmup_failure !== null && !isFailure(v.warmup_failure)) return null;
	if (!Array.isArray(v.setups_failed) || !v.setups_failed.every(isFailureCount)) return null;
	return value as unknown as RequestsRecord;
}

export const REQUESTS_RECORD: StreamReducer<RequestsRecord> = {
	key: REQUESTS_RECORD_KEY,
	reduce: reduceRequests,
	toJson: (record) => record,
	fromJson,
};
