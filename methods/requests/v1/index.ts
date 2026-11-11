/**
 * Method requests, version 1: Runs whose samples are requests in, latency
 * distributions out.
 *
 *     const gathered = await gather(files, fetchBlob, { records });   // the only I/O
 *     const derivations = derive(files, gathered);                     // pure
 *     writeFileSync(out, serialize(derivations));
 *
 * Which Runs: a Series (Method series v1's: benchmark, params, build,
 * instance type and zone ID) is this Method's when any of its Runs' streams
 * holds a request, a response_ended or request_failed carrying `request`
 * (requests.ts). Then every Run of the Series is in it, counted or not. No
 * list of benchmark names is kept.
 *
 * Per request: each phase from the event timestamps, as the binary's README
 * defines it (requests.ts). Per Run: each phase's count, least, greatest and
 * supported percentiles over its succeeded counted requests, exactly. Pooled,
 * across the counted Runs of the Series and of each group (series v1's split
 * facts): the same statistics read from the sum of the Runs' tallies, within
 * 0.78% (numbers.ts), and each phase's histogram; broken down by what each
 * request recorded of its connection, where that took more than one value;
 * failures counted by phase and kind, never in a time.
 *
 * Memory: each stream is read once, reduced to its record (record.ts), and
 * let go; with a store of records it is not read again. Nothing proportional
 * to the number of requests ever made is held: a record's tallies have at
 * most 64 bins per doubling of time.
 *
 * Same Run files and blobs in, same bytes out, records kept or not.
 */

import { type RecordStore, type ReduceCounts, reduceStreams, type StreamReducer } from "../../records";
import { canonicalJson, compareText, type FetchBlob, parseDumpIndex, type Run, type RunExit, type RunFile } from "../../run";
import { countProblem } from "../../v1/stream";
import {
	type BlobMap,
	type Facts,
	LEFT_OUT,
	SPLIT_FACTS,
	seriesId,
	seriesKey,
	seriesKeyText,
	splitFacts,
} from "../../v1/facts";
import { groupLetter, readRuns } from "../../v1/index";
import type { CitedRun } from "../../v1/output";
import { leastCount, PERCENTILES, SUB_BINS, type Stats, TALLY_PRECISION, type Tally, TallySum, tallyStats } from "./numbers";
import type { Breakdown, DerivationsFile, FactValues, Group, MethodName, Point, Pool, PooledPhase, PoolSummary, Recorded, SeriesDerivation } from "./output";
import { type FailureCount, REQUESTS_RECORD, type RequestsRecord } from "./record";
import { PHASE_WORDS, PHASES, type Phase, REQUEST_FACT_WORDS, REQUEST_FACTS, type RequestFact } from "./requests";

export const METHOD: MethodName = { name: "requests", version: 1 };

const pct = (perMille: number): string => `${perMille / 10}th`;

export const DEFINITIONS: Record<string, string> = {
	series:
		"Method series v1's Series: the Runs that share a benchmark, params, build, instance type and zone ID. A Series is " +
		"this Method's when any of its Runs' streams holds a request (a response_ended or request_failed event carrying " +
		"`request`); every Run of it is then shown, counted or not.",
	request:
		"One counted sample of the stream (warmup false): the events from its sample_started to its sample_ended. Its " +
		"phases are differences of event timestamps, in nanoseconds of the Run's clock (see phases). A request over a " +
		"reused connection has only send, first_byte, headers, body and total.",
	succeeded:
		"A request whose response status (response_headers.status) is 2xx and whose body matched the Fixture and S3's " +
		"checksum (response_ended.fixture and .s3_checksum both \"match\"). Only succeeded requests are in a time.",
	failed:
		"A counted request that holds a request_failed (counted by its phase and error) or whose status is not 2xx " +
		"(phase response, kind status_<code>), or one of whose lines the binary withheld (phase record, kind " +
		"line_withheld_<event>). Counted per Run and pooled; never in a time. The warmup request's failure and failed " +
		"reused-connection setups (connection_failed, outside any sample) are counted apart.",
	per_run:
		"For each phase of a counted Run: the count of its succeeded requests, the least and greatest time, and each " +
		"percentile the count supports, exactly, by linear interpolation between closest ranks (R type 7): with n times " +
		"sorted and h = (n − 1) × q / 1000 for the q-th per mille, x[⌊h⌋] + (h − ⌊h⌋) × (x[⌊h⌋+1] − x[⌊h⌋]).",
	support:
		"The q-th per-mille percentile of n requests is reported only when n × (1000 − q) ≥ 1000: at least one request is " +
		`expected above it. So the ${PERCENTILES.map(({ perMille }) => `${pct(perMille)} needs ${leastCount(perMille)}`).join(", ")} ` +
		"requests. Beside each percentile reported, at_or_above is how many requests are ranked at or above it: n − ⌈h⌉ " +
		"(ties counted by rank). For a 99th percentile of 200 requests that is 2.",
	histogram:
		`Each phase's times are tallied in fixed bins, the same for every Run, so tallies add: below ${2 * SUB_BINS} ns every ` +
		`nanosecond is a bin of its own; from ${2 * SUB_BINS} ns each doubling [2^e, 2^(e+1)) is cut into ${SUB_BINS} bins of ` +
		`width 2^(e−6): bin = ${SUB_BINS} × (e − 5) + ⌊ns / 2^(e−6)⌋ − ${SUB_BINS}, with e = ⌊log2 ns⌋. A bin is at most 1/${SUB_BINS} ` +
		"as wide as the least time in it.",
	pooled:
		"Across the counted Runs of a Series, and of each group: the Runs' tallies summed. The count, least and greatest " +
		"time are exact; each percentile is read from the sum by the same rule as per Run, with each ranked time taken as " +
		"the middle of its bin (the time itself in a bin of width 1), held between the least and greatest, so it is within " +
		`${(TALLY_PRECISION * 100).toFixed(2)}% of the exact percentile of the same requests. A Series with one Run therefore ` +
		"pools to figures within that of the Run's own.",
	through:
		"On each Run of a Series, the pooled figures (without histograms) of the counted Runs that started at or before it, " +
		"in the Series' time order; and of its group's, when the Series has more than one group. A citation of the Series " +
		"as of a Run's start is checked against these.",
	breakdown:
		"The pooled figures again for the requests that had each value of a fact each request records of its connection " +
		"or of itself (see request_facts), for every fact that took more than one value among the pool's succeeded requests.",
	recorded:
		"What a Series' Runs record beside their requests, for a reader: the box's Region (provider.region), the Service " +
		"each Run names and its inputs that are not secret, as delivered (Run.service), and in each pool every value each " +
		"request fact took. Words, not figures, and nothing about the path between the box and the server, which each " +
		"Run's environment dumps record (network, ec2_route_tables, ec2_vpc_endpoints).",
	groups:
		"Method series v1's groups: within a Series, the Runs whose split facts are all equal, lettered in the order each " +
		"first appears; the same letters series v1 gives the same Runs.",
	counted:
		"A Run counts when its binary exited 0 or 4 (4: the Run completed and holds at least one failed request), every " +
		"stdout line is an event that matches the events schema and the stream obeys every order rule of " +
		"scripts/check-events.py, the stream has as many counted samples as the Run asked for (fewer: the Run was cut " +
		"short), every timestamp is a whole number a JavaScript number holds exactly (at most 2^53 − 1), every request " +
		"in it reads as the binary's README says (every event naming a request names its sample's; a complete response's " +
		"events in their order on one open connection, each phase at least 0, sample_ended at the clock read that ended " +
		"the request; a failed request's events, before its request_failed, the start of that order up to where its " +
		"phase says it got), and an exit 0 has no failed request, no failed warmup request and no failed setup of a kept " +
		"connection. Any other Run is failed: shown, with the reasons, and in no figure. A counted Run's failed requests " +
		"are counted; its succeeded requests are in the figures.",
};

// ---------------------------------------------------------------- gather

/** What derive() reads: the dump blobs of the Runs in this Method's Series, and every stream's record by its hash. */
export interface Gathered {
	blobs: BlobMap;
	records: ReadonlyMap<string, RequestsRecord>;
	counts: ReduceCounts;
}

export interface GatherOptions {
	/** Where each stream's record is kept between runs (methods/records.ts), keyed by REQUESTS_RECORD_KEY. */
	records?: RecordStore | null;
	/** Fetches stdout blobs, when they come from elsewhere than the dumps. */
	fetchStream?: FetchBlob;
	concurrency?: number;
}

/** The before-dump sections a split fact is read from, beyond the hash: those LEFT_OUT names. */
const READ_SECTIONS: ReadonlySet<string> = new Set(LEFT_OUT.map(({ section }) => section));

/**
 * Reads every Run's stream into its record (or reads the kept record), then
 * fetches, for the Runs of this Method's Series only, the before-dump index
 * and the sections whose contents a split fact reads. Throws if a Run names
 * a blob that cannot be fetched.
 */
export async function gather(files: readonly RunFile[], fetchBlob: FetchBlob, options: GatherOptions = {}): Promise<Gathered> {
	const concurrency = options.concurrency ?? 16;
	const { runs } = readRuns(files);
	const counts: ReduceCounts = { fetched: 0, kept: 0 };
	const [found] = await reduceStreams(
		runs.map(({ run }) => run.stdout),
		[REQUESTS_RECORD as StreamReducer<unknown>],
		options.fetchStream ?? fetchBlob,
		options.records ?? null,
		concurrency,
		counts,
	);
	const records = found as Map<string, RequestsRecord>;
	const ours = requestSeriesKeys(runs.map(({ run }) => run), records);
	const mine = runs.filter(({ run }) => ours.has(seriesKeyText(seriesKey(run))));

	const blobs = new Map<string, Uint8Array>();
	const fetchAll = async (hashes: Iterable<string>): Promise<void> => {
		const wanted = [...new Set(hashes)].filter((hash) => !blobs.has(hash)).sort(compareText);
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < wanted.length) {
				const hash = wanted[next++] as string;
				const bytes = await fetchBlob(hash);
				if (bytes === null) throw new Error(`blob ${hash} cannot be fetched`);
				blobs.set(hash, bytes);
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
	};
	await fetchAll(mine.map(({ run }) => run.environment.before));
	const sections: string[] = [];
	for (const { run } of mine) {
		const index = parseDumpIndex(run.environment.before, blobs.get(run.environment.before) as Uint8Array);
		for (const [name, hash] of Object.entries(index.sections)) if (READ_SECTIONS.has(name)) sections.push(hash);
	}
	await fetchAll(sections);
	return { blobs, records, counts };
}

/** The Series keys (seriesKeyText) any of whose Runs' streams hold requests. */
function requestSeriesKeys(runs: readonly Run[], records: ReadonlyMap<string, RequestsRecord>): Set<string> {
	const keys = new Set<string>();
	for (const run of runs) if (records.get(run.stdout)?.holds_requests === true) keys.add(seriesKeyText(seriesKey(run)));
	return keys;
}

// ---------------------------------------------------------------- derive

function describeExit(exit: RunExit): string | null {
	if ("code" in exit) return exit.code === 0 || exit.code === 4 ? null : `exit code ${exit.code}`;
	const timeout = exit.timeout_seconds === undefined ? "" : ` (the runner's ${exit.timeout_seconds} s timeout)`;
	return `killed by signal ${exit.signal}${timeout}`;
}

/** Why a Run is in no figure; empty when it counts. */
export function failures(run: Run, record: RequestsRecord): string[] {
	const reasons: string[] = [];
	const exit = describeExit(run.exit);
	if (exit !== null) reasons.push(exit);
	if (run.exit.runner_signal !== undefined && exit !== null) reasons.push(`the runner was told to stop by signal ${run.exit.runner_signal}`);
	reasons.push(...record.problems);
	if (record.problems.length === 0 && !record.holds_requests) reasons.push("its stream holds no request (no response_ended or request_failed carrying request)");
	const count = countProblem(record.counted, run.samples);
	if (count.length > 0) reasons.push(record.counted !== null && record.counted < run.samples ? `${count[0]}: the Run was cut short` : (count[0] as string));
	if ("code" in run.exit && run.exit.code === 0) {
		// The binary's README: any failed request, the warmup's included, or failed setup of a kept connection, is exit 4.
		const contrary = [
			...(record.failed > 0 ? [`${record.failed} counted request${record.failed === 1 ? "" : "s"} failed`] : []),
			...(record.warmup_failure !== null ? [`the warmup request failed (${record.warmup_failure.phase} ${record.warmup_failure.kind})`] : []),
			...(record.setups_failed.length > 0
				? [`${record.setups_failed.reduce((sum, f) => sum + f.count, 0)} setup${record.setups_failed.reduce((sum, f) => sum + f.count, 0) === 1 ? "" : "s"} of a kept connection failed`]
				: []),
		];
		if (contrary.length > 0) reasons.push(`exit code 0, which says every request succeeded, but ${contrary.join(", and ")}`);
	}
	return reasons;
}

interface Analysed {
	file: RunFile;
	run: Run;
	record: RequestsRecord;
	facts: Facts;
	factsText: string;
	reasons: string[];
}

function sumFailures(lists: ReadonlyArray<readonly FailureCount[]>): FailureCount[] {
	const counts = new Map<string, FailureCount>();
	for (const list of lists) {
		for (const { phase, kind, count } of list) {
			const key = `${phase}\u0000${kind}`;
			const found = counts.get(key);
			if (found === undefined) counts.set(key, { phase, kind, count });
			else found.count += count;
		}
	}
	return [...counts.values()].sort((a, b) => compareText(a.phase, b.phase) || compareText(a.kind, b.kind));
}

/** The tallies of each phase of the counted Runs given, added as they come. */
class PhaseSums {
	private readonly sums = new Map<Phase, TallySum>();
	runs = 0;
	requests = 0;
	failed = 0;
	private readonly failureLists: FailureCount[][] = [];
	private readonly setupLists: FailureCount[][] = [];

	add(record: RequestsRecord): void {
		this.runs++;
		this.requests += record.succeeded;
		this.failed += record.failed;
		this.failureLists.push(record.failures);
		this.setupLists.push(record.setups_failed);
		for (const phase of PHASES) {
			const tally = record.phases[phase]?.tally;
			if (tally === undefined) continue;
			let sum = this.sums.get(phase);
			if (sum === undefined) {
				sum = new TallySum();
				this.sums.set(phase, sum);
			}
			sum.add(tally);
		}
	}

	tallies(): Partial<Record<Phase, Tally>> {
		const out: Partial<Record<Phase, Tally>> = {};
		for (const phase of PHASES) {
			const tally = this.sums.get(phase)?.tally() ?? null;
			if (tally !== null) out[phase] = tally;
		}
		return out;
	}

	summary(): PoolSummary {
		const phases: Partial<Record<Phase, Stats>> = {};
		for (const [phase, tally] of Object.entries(this.tallies()) as Array<[Phase, Tally]>) phases[phase] = tallyStats(tally);
		return { runs: this.runs, requests: this.requests, failed: this.failed, phases, failures: sumFailures(this.failureLists) };
	}

	failures(): FailureCount[] {
		return sumFailures(this.failureLists);
	}

	setupsFailed(): FailureCount[] {
		return sumFailures(this.setupLists);
	}
}

function breakdowns(records: readonly RequestsRecord[]): Breakdown[] {
	const found: Breakdown[] = [];
	for (const fact of REQUEST_FACTS) {
		const values = new Map<string, { runs: number; requests: number; sums: Map<Phase, TallySum> }>();
		for (const record of records) {
			for (const item of record.by[fact] ?? []) {
				let entry = values.get(item.value);
				if (entry === undefined) {
					entry = { runs: 0, requests: 0, sums: new Map() };
					values.set(item.value, entry);
				}
				entry.runs++;
				entry.requests += item.requests;
				const tallies: Partial<Record<Phase, Tally>> =
					item.phases ?? Object.fromEntries(Object.entries(record.phases).map(([phase, runPhase]) => [phase, runPhase.tally]));
				for (const phase of PHASES) {
					const tally = tallies[phase];
					if (tally === undefined) continue;
					let sum = entry.sums.get(phase);
					if (sum === undefined) {
						sum = new TallySum();
						entry.sums.set(phase, sum);
					}
					sum.add(tally);
				}
			}
		}
		if (values.size < 2) continue;
		found.push({
			fact,
			values: [...values]
				.sort(([a], [b]) => compareText(a, b))
				.map(([value, entry]) => {
					const phases: Partial<Record<Phase, Stats>> = {};
					for (const phase of PHASES) {
						const tally = entry.sums.get(phase)?.tally() ?? null;
						if (tally !== null) phases[phase] = tallyStats(tally);
					}
					return { value, runs: entry.runs, requests: entry.requests, phases };
				}),
		});
	}
	return found;
}

/** Every value each request fact took among these records' succeeded requests. */
function factValues(records: readonly RequestsRecord[]): FactValues[] {
	return REQUEST_FACTS.flatMap((fact) => {
		const counts = new Map<string, number>();
		for (const record of records) for (const item of record.by[fact] ?? []) counts.set(item.value, (counts.get(item.value) ?? 0) + item.requests);
		if (counts.size === 0) return [];
		return [{ fact, values: [...counts].sort(([a], [b]) => compareText(a, b)).map(([value, requests]) => ({ value, requests })) }];
	});
}

/** What the Runs record of where they ran and what they asked. */
function recorded(runs: readonly Run[]): Recorded {
	const regions = new Map<string, { value: string | null; runs: number }>();
	const services = new Map<string, { name: string; inputs: Record<string, string>; runs: number }>();
	let withoutService = 0;
	for (const run of runs) {
		const region = run.provider.region ?? null;
		const key = JSON.stringify(region);
		regions.set(key, { value: region, runs: (regions.get(key)?.runs ?? 0) + 1 });
		if (run.service === undefined) {
			withoutService++;
			continue;
		}
		const text = canonicalJson({ name: run.service.name, inputs: run.service.inputs });
		const found = services.get(text);
		if (found === undefined) services.set(text, { name: run.service.name, inputs: run.service.inputs, runs: 1 });
		else found.runs++;
	}
	return {
		regions: [...regions].sort(([a], [b]) => compareText(a, b)).map(([, value]) => value),
		services: [...services].sort(([a], [b]) => compareText(a, b)).map(([, value]) => value),
		without_service: withoutService,
	};
}

function pool(records: readonly RequestsRecord[]): Pool {
	const sums = new PhaseSums();
	for (const record of records) sums.add(record);
	const phases: Partial<Record<Phase, PooledPhase>> = {};
	for (const [phase, tally] of Object.entries(sums.tallies()) as Array<[Phase, Tally]>) phases[phase] = { ...tallyStats(tally), histogram: tally.bins };
	return {
		runs: sums.runs,
		requests: sums.requests,
		failed: sums.failed,
		phases,
		failures: sums.failures(),
		setups_failed: sums.setupsFailed(),
		by: breakdowns(records),
		facts: factValues(records),
	};
}

function deriveSeries(list: Analysed[]): SeriesDerivation {
	list.sort((a, b) => compareText(a.run.started_at, b.run.started_at) || compareText(a.run.id, b.run.id));
	const letters = new Map<string, string>();
	for (const one of list) if (!letters.has(one.factsText)) letters.set(one.factsText, groupLetter(letters.size));
	const split = letters.size > 1;

	const seriesSums = new PhaseSums();
	const groupSums = new Map<string, PhaseSums>();
	const points: Point[] = list.map(({ file, run, record, factsText, reasons }) => {
		const group = letters.get(factsText) as string;
		const counted = reasons.length === 0;
		if (counted) {
			seriesSums.add(record);
			let sums = groupSums.get(group);
			if (sums === undefined) {
				sums = new PhaseSums();
				groupSums.set(group, sums);
			}
			sums.add(record);
		}
		const phases: Partial<Record<Phase, Stats>> = {};
		if (counted) for (const [phase, runPhase] of Object.entries(record.phases) as Array<[Phase, { stats: Stats }]>) phases[phase] = runPhase.stats;
		return {
			run: run.id,
			path: file.path,
			started_at: run.started_at,
			boot: run.boot,
			group,
			counted,
			failure: counted ? null : reasons.join("; "),
			exit_code: "code" in run.exit ? run.exit.code : null,
			counted_requests: record.counted,
			succeeded: counted ? record.succeeded : 0,
			failed: counted ? record.failed : 0,
			phases,
			failures: counted ? record.failures : [],
			setups_failed: counted ? record.setups_failed : [],
			warmup_failure: counted ? record.warmup_failure : null,
			through: seriesSums.runs === 0 ? null : seriesSums.summary(),
			group_through: !split || (groupSums.get(group)?.runs ?? 0) === 0 ? null : (groupSums.get(group) as PhaseSums).summary(),
		};
	});
	const countedRecords = (members: readonly Analysed[]): RequestsRecord[] => members.filter((one) => one.reasons.length === 0).map((one) => one.record);
	const groups: Group[] = [...letters].map(([factsText, id]) => {
		const members = list.filter((one) => one.factsText === factsText);
		return { id, facts: (members[0] as Analysed).facts, runs: members.map((one) => one.run.id), pool: pool(countedRecords(members)) };
	});
	const key = seriesKey((list[0] as Analysed).run);
	const cited: CitedRun[] = list.map(({ run, file }) => ({ id: run.id, path: file.path, sha256: file.sha256 }));
	return {
		method: METHOD,
		series: {
			id: seriesId(key),
			benchmark: key.benchmark,
			params: key.params,
			build: key.build,
			instance_type: key.instance_type,
			availability_zone_id: key.availability_zone_id,
		},
		runs: cited,
		recorded: recorded(list.map(({ run }) => run)),
		points,
		pool: pool(countedRecords(list)),
		groups,
	};
}

/** The order Series are listed in: benchmark, instance type, zone ID, params, build (series v1's). */
function seriesOrder(a: SeriesDerivation, b: SeriesDerivation): number {
	const tuple = (d: SeriesDerivation): string[] => [d.series.benchmark, d.series.instance_type ?? "", d.series.availability_zone_id ?? "", canonicalJson(d.series.params), d.series.build];
	const x = tuple(a);
	const y = tuple(b);
	for (let i = 0; i < x.length; i++) {
		const order = compareText(x[i] as string, y[i] as string);
		if (order !== 0) return order;
	}
	return 0;
}

/**
 * The Derivations of Method requests v1 for these Run files, reading only
 * what gather() gathered for them. Pure: the same files and records give the
 * same result, whatever order the files come in.
 */
export function derive(files: readonly RunFile[], gathered: Gathered): DerivationsFile {
	const { runs, unreadable } = readRuns(files);
	const recordOf = (run: Run): RequestsRecord => {
		const record = gathered.records.get(run.stdout);
		if (record === undefined) throw new Error(`stdout ${run.stdout} of run ${run.id} was not gathered`);
		return record;
	};
	const ours = requestSeriesKeys(
		runs.map(({ run }) => run),
		new Map(runs.map(({ run }) => [run.stdout, recordOf(run)])),
	);
	const bySeries = new Map<string, Analysed[]>();
	for (const { file, run } of runs) {
		const keyText = seriesKeyText(seriesKey(run));
		if (!ours.has(keyText)) continue;
		const index = gathered.blobs.get(run.environment.before);
		if (index === undefined) throw new Error(`dump index ${run.environment.before} was not fetched`);
		const facts = splitFacts(run, parseDumpIndex(run.environment.before, index).sections, gathered.blobs);
		const record = recordOf(run);
		const list = bySeries.get(keyText) ?? [];
		list.push({ file, run, record, facts, factsText: JSON.stringify(SPLIT_FACTS.map(({ fact }) => facts[fact] ?? null)), reasons: failures(run, record) });
		bySeries.set(keyText, list);
	}
	return {
		schema: "ledgermath.derivations/1",
		method: METHOD,
		definitions: DEFINITIONS,
		phases: PHASES.map((phase) => ({ phase, ...PHASE_WORDS[phase] })),
		percentiles: PERCENTILES.map(({ name, perMille }) => ({ name, per_mille: perMille, least_requests: leastCount(perMille) })),
		histogram: {
			bins_per_doubling: SUB_BINS,
			exact_below_ns: 2 * SUB_BINS,
			precision: TALLY_PRECISION,
			definition: DEFINITIONS.histogram as string,
		},
		request_facts: REQUEST_FACTS.map((fact: RequestFact) => ({ fact, what: REQUEST_FACT_WORDS[fact] })),
		split_on: SPLIT_FACTS,
		left_out: LEFT_OUT,
		runs_read: files.length,
		unreadable,
		derivations: [...bySeries.values()].map(deriveSeries).sort(seriesOrder),
	};
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const LONG = 120;
const isPrimitive = (value: unknown): boolean => value === null || (typeof value !== "object" && !(typeof value === "string" && value.length > LONG));
/**
 * A value written on one line: a primitive, an array of primitives or of
 * arrays of them, an object of such values; no string in it longer than 120
 * characters (definitions stay one to a line).
 */
function isFlat(value: unknown, depth = 0): boolean {
	if (typeof value === "string") return value.length <= LONG;
	if (isPrimitive(value)) return true;
	if (depth >= 2) return false;
	if (Array.isArray(value)) return value.every((item) => isPrimitive(item) || (Array.isArray(item) && item.every(isPrimitive)));
	return Object.values(value as Record<string, unknown>).every((item) => isFlat(item, depth + 1));
}

function write(value: JsonValue, indent: string): string {
	if (isFlat(value) || typeof value === "string") return JSON.stringify(value);
	const inner = `${indent}  `;
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		return `[\n${value.map((item) => `${inner}${write(item, inner)}`).join(",\n")}\n${indent}]`;
	}
	const entries = Object.entries(value as { [key: string]: JsonValue });
	if (entries.length === 0) return "{}";
	return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${write(item, inner)}`).join(",\n")}\n${indent}}`;
}

/**
 * The file's bytes: JSON with a final newline, two-space indented, except
 * that a value whose members are all primitives, arrays of primitives (a
 * histogram's [bin, count] pairs) or objects of those (one phase's
 * statistics), with no string longer than 120 characters, is written on one
 * line, as JSON.stringify writes it.
 */
export function serialize(file: DerivationsFile): string {
	return `${write(JSON.parse(JSON.stringify(file)) as JsonValue, "")}\n`;
}
