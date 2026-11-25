/**
 * The lookup tool's answers (scripts/lookup.ts), as data and as text. Every
 * number comes with its citation in the same object and on the same line,
 * so an agent cannot easily take one without the other. Nothing here reads a
 * clock: the same data give the same output.
 *
 * It reports what the data hold, and when asked for something they do not
 * hold, it says so and lists what they do hold. It derives no new numbers:
 * the percentiles across Runs are Method series version 1's, those across
 * requests Method requests version 1's, the prices AWS's, verbatim.
 *
 * It reads the data API's tree (scripts/lib/ledger-data.ts), and only the
 * files each answer needs: about and series, the table of contents and the
 * list of Series; show, those and one Series file, and month files only for
 * Runs older than the Series file's newest points; prices, the table of
 * contents and one price file.
 */

import type { Stats } from "../../methods/requests/v1/numbers";
import type { Pool, PoolSummary, Recorded } from "../../methods/requests/v1/output";
import { PHASES, type Phase } from "../../methods/requests/v1/requests";
import { compareText, type ParamValue } from "../../methods/run";
import { BENCHMARK_NOTES, variantNotes } from "./benchmark-notes";
import {
	attributeCitation,
	benchmarkCitation,
	leastRequests,
	momentOf,
	NUMBER_UNIT,
	NUMBERS,
	type NumberName,
	paramCitation,
	priceCitation,
	REQUEST_PERCENTILES,
	type RequestPercentile,
	type RequestScope,
	rangeCitation,
	requestFailedCitation,
	requestRunsCitation,
	requestStatCitation,
	requestTailCitation,
	seriesCitation,
} from "./citation";
import { type LedgerData, LedgerError, type LoadedPrices, type MonthEntry, seriesPoints, type StatSummary, type TreeLeftOut, type TreeRoundFigures, type TreeRow, type TreeSeries, type TreeSeriesPoint } from "./ledger-data";
import type { PriceSource } from "./prices";
import { agrees, type Dims, quantities } from "./quantity";

// ---------------------------------------------------------------- words

/** Whether a search word starts a word of the text, ignoring case: "get" finds "GET and all other requests". */
export function wordMatches(word: string, text: string): boolean {
	const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^a-z0-9])${escaped}`).test(text.toLowerCase());
}

const paramsText = (params: Record<string, ParamValue>): string =>
	Object.keys(params)
		.sort(compareText)
		.map((key) => `${key}=${String(params[key])}`)
		.join(" ");

// ---------------------------------------------------------------- numbers as text

/** A number to six significant digits (or `digits`), without an exponent or trailing zeros. */
export function sig(value: number, digits = 6): string {
	if (value === 0) return "0";
	const magnitude = Math.floor(Math.log10(Math.abs(value)));
	const decimals = Math.min(15, Math.max(0, digits - 1 - magnitude));
	const text = value.toFixed(decimals);
	return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/**
 * A value written as the answer checker reads it back: six significant
 * digits, or as many more as it takes for the checker (agrees, the rule every
 * cited number is held to) to find the written number standing for the value.
 * It refuses a value exactly halfway between two numbers at the last written
 * digit (1,014,475 ns is no more 1.01448 ms than 1.01447 ms), and the value it
 * compares is the stored one in base units, divided by the written unit's
 * factor, with the rounding of that arithmetic; so a value on, or a hair off,
 * such a boundary is written with a digit more (1.014475 ms).
 */
function checkedText(base: number, dims: Dims, scaled: number, unit: string): string {
	for (let digits = 6; digits <= 15; digits++) {
		const text = `${sig(scaled, digits)} ${unit}`;
		const q = quantities(text)[0];
		if (q !== undefined && agrees(q, base, dims)) return text;
	}
	return `${sig(scaled, 15)} ${unit}`;
}

/** A time in nanoseconds, in the unit that reads best, as the checker reads it back. */
export function timeText(ns: number): string {
	const [scale, unit] = ns >= 1e9 ? [1e9, "s"] : ns >= 1e6 ? [1e6, "ms"] : ns >= 1e3 ? [1e3, "µs"] : [1, "ns"];
	return checkedText(ns * 1e-9, { s: 1 }, ns / scale, unit);
}

/** Bytes per second, decimal, with the binary unit beside it, each as the checker reads it back. */
export function rateText(bytesPerSecond: number): string {
	const decimal: Array<[number, string]> = [
		[1e12, "TB/s"],
		[1e9, "GB/s"],
		[1e6, "MB/s"],
		[1e3, "kB/s"],
	];
	const binary: Array<[number, string]> = [
		[2 ** 40, "TiB/s"],
		[2 ** 30, "GiB/s"],
		[2 ** 20, "MiB/s"],
		[2 ** 10, "KiB/s"],
	];
	const [ds, du] = decimal.find(([scale]) => bytesPerSecond >= scale) ?? [1, "B/s"];
	const [bs, bu] = binary.find(([scale]) => bytesPerSecond >= scale) ?? [1, "B/s"];
	const dims: Dims = { B: 1, s: -1 };
	return `${checkedText(bytesPerSecond, dims, bytesPerSecond / ds, du)} (${checkedText(bytesPerSecond, dims, bytesPerSecond / bs, bu)})`;
}

/** A Derivation's value as text; null is how the Method writes an infinite one. */
const numberText = (name: NumberName, value: number | null): string =>
	value === null ? "infinite (the Method writes it as null)" : name === "time_per_repetition_ns" ? timeText(value) : rateText(value);

/** A Run's start, to the second. */
const atSecond = (iso: string): string => `${iso.slice(0, 19)}Z`;

// ---------------------------------------------------------------- Series

export interface CitedValue {
	/** Null when the Method's value is infinite, which it writes as null. */
	value: number | null;
	unit: string;
	text: string;
	citation: string;
}

export interface NumberStats {
	number: NumberName;
	unit: string;
	count: number;
	count_citation: string;
	p5: CitedValue;
	p50: CitedValue;
	p95: CitedValue;
}

export interface SeriesSummary {
	id: string;
	/** The address of its Series file, as the list of Series gives it. */
	url: string;
	benchmark: string;
	params: Record<string, ParamValue>;
	params_citations: Record<string, string>;
	build: string;
	instance_type: string | null;
	availability_zone_id: string | null;
	measures: string | null;
	measures_citation: string;
	variant: string[];
	repetition: string | null;
	bytes: string | null;
	caveat: string | null;
	runs: number;
	counted: number;
	failed: number;
	first_run_at: string | null;
	newest_run_at: string | null;
	/** The start of the newest Run, to the second: the moment the Series' citations are of. */
	data_through: string;
	groups: number;
	/** Whether Method requests holds percentiles across this Series' requests. */
	requests: boolean;
}

/** What a row of the list of Series, or a Series file, says of its Series. */
interface Head {
	id: string;
	url: string;
	benchmark: string;
	params: Record<string, ParamValue>;
	build: string;
	instance_type: string | null;
	availability_zone_id: string | null;
	runs: number;
	oldest_run_started_at: string;
	newest_run_started_at: string;
}

function summary(head: Head, counts: { counted: number; failed: number; groups: number; requests: boolean }): SeriesSummary {
	const { id, benchmark, params, build } = head;
	const note = BENCHMARK_NOTES[benchmark];
	return {
		id,
		url: head.url,
		benchmark,
		params,
		params_citations: Object.fromEntries(Object.keys(params).sort(compareText).map((key) => [key, paramCitation(id, key)])),
		build,
		instance_type: head.instance_type,
		availability_zone_id: head.availability_zone_id,
		measures: note?.measures ?? null,
		measures_citation: benchmarkCitation(benchmark),
		variant: note === undefined ? [] : variantNotes(note, params),
		repetition: note?.repetition ?? null,
		bytes: note?.bytes ?? null,
		caveat: note?.caveat ?? null,
		runs: head.runs,
		counted: counts.counted,
		failed: counts.failed,
		first_run_at: head.oldest_run_started_at,
		newest_run_at: head.newest_run_started_at,
		data_through: momentOf(head.newest_run_started_at),
		groups: counts.groups,
		requests: counts.requests,
	};
}

const rowSummary = (row: TreeRow): SeriesSummary =>
	summary(row, {
		counted: row.derivations.series_v1?.counted_runs ?? 0,
		failed: row.derivations.series_v1?.failed_runs ?? 0,
		groups: row.derivations.series_v1?.groups ?? 0,
		requests: row.derivations.requests_v1 !== undefined,
	});

/** What names a Series: its id, benchmark, params, build, instance type and zone ID. */
function fieldText(s: SeriesSummary): string {
	return [s.id, s.benchmark, paramsText(s.params), `build=${s.build}`, s.build, s.instance_type ?? "", s.availability_zone_id ?? ""].join(" ");
}

/** Its fields, and the words describing what it measures. */
function searchText(s: SeriesSummary): string {
	return [fieldText(s), s.measures ?? "", ...s.variant, s.caveat ?? ""].join(" ");
}

/**
 * The Series matching every word. A word that names a field of some Series
 * ("avx2", "static", "threads=1", "m5.large") is matched against fields only;
 * any other word ("network", "latency") against the description too.
 */
function matchingSeries(all: SeriesSummary[], words: string[]): SeriesSummary[] {
	const tests = words.map((word) => (all.some((s) => wordMatches(word, fieldText(s))) ? (s: SeriesSummary) => wordMatches(word, fieldText(s)) : (s: SeriesSummary) => wordMatches(word, searchText(s))));
	return all.filter((s) => tests.every((matches) => matches(s)));
}

/** A number's percentiles, each with a citation of the Series as of `moment` under Method version `version`. */
function numberStats(id: string, name: NumberName, stat: StatSummary | null, version: number, moment: string, group?: string): NumberStats | null {
	if (stat === null) return null;
	const { unit } = NUMBER_UNIT[name];
	const cited = (which: "p5" | "p50" | "p95"): CitedValue => ({
		value: stat[which],
		unit,
		text: numberText(name, stat[which]),
		citation: seriesCitation(id, name, which, version, moment, group),
	});
	return {
		number: name,
		unit,
		count: stat.count,
		count_citation: seriesCitation(id, name, "count", version, moment, group),
		p5: cited("p5"),
		p50: cited("p50"),
		p95: cited("p95"),
	};
}

export interface NotHeld {
	asked: string[];
	/** Plain sentences saying what is not held, and what is. */
	lines: string[];
}

export interface SeriesList {
	words: string[];
	series: SeriesSummary[];
	not_held: NotHeld | null;
}

async function sortedSummaries(data: LedgerData): Promise<SeriesSummary[]> {
	return (await data.list()).series.map(rowSummary).sort(
		(a, b) =>
			compareText(a.benchmark, b.benchmark) ||
			compareText(a.instance_type ?? "", b.instance_type ?? "") ||
			compareText(paramsText(a.params), paramsText(b.params)) ||
			compareText(a.build, b.build) ||
			compareText(a.availability_zone_id ?? "", b.availability_zone_id ?? ""),
	);
}

const countBy = (values: string[]): Map<string, number> => {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return new Map([...counts].sort(([a], [b]) => compareText(a, b)));
};

/** "memory_read (8 Series), sort (5 Series)". */
const listed = (counts: Map<string, number>): string => (counts.size === 0 ? "none" : [...counts].map(([name, n]) => `${name} (${n} Series)`).join(", "));

function seriesNotHeld(words: string[], all: SeriesSummary[]): NotHeld {
	const lines: string[] = [`LedgerMath holds no Series matching all of: ${words.join(" ")}.`];
	const benchmarks = countBy(all.map((s) => s.benchmark));
	const types = countBy(all.map((s) => s.instance_type ?? "(no instance type)"));
	for (const word of words) {
		const matching = matchingSeries(all, [word]);
		if (matching.length > 0) {
			lines.push(`"${word}" alone matches ${matching.length} Series (${[...countBy(matching.map((s) => `${s.benchmark} on ${s.instance_type}`)).keys()].join(", ")}).`);
			continue;
		}
		if (word in BENCHMARK_NOTES) lines.push(`"${word}" is a LedgerMath benchmark, but this data holds no Series of it yet.`);
		else lines.push(`"${word}" matches no Series.`);
	}
	lines.push(`Benchmarks with Series: ${listed(benchmarks)}.`);
	lines.push(`Instance types with Series: ${listed(types)}.`);
	lines.push("Whether LedgerMath holds a price for something: prices <word>.");
	lines.push("A number LedgerMath does not hold is not measured here; do not stand one in for it without saying so.");
	return { asked: words, lines };
}

export async function listSeries(data: LedgerData, words: string[]): Promise<SeriesList> {
	const all = await sortedSummaries(data);
	const series = matchingSeries(all, words);
	return { words, series, not_held: series.length === 0 ? seriesNotHeld(words, all) : null };
}

export interface RunLink {
	path: string;
	/** Where to read it at the location: its path in a directory, its address under a web address. */
	link: string;
	/** Its address in the data API, as the tree writes it. */
	evidence: string;
	started_at: string;
	group: string;
	counted: boolean;
	failure: string | null;
}

export interface GroupDetail {
	id: string;
	/** The split facts whose values differ from group A's, with what each is. */
	differs_from_first: Array<{ fact: string; what: string }>;
	numbers: NumberStats[];
}

export interface SeriesDetail extends SeriesSummary {
	method: string;
	/** Where its figures were read: its Series file. */
	derivations: string;
	numbers: NumberStats[];
	group_details: GroupDetail[];
	runs_list: RunLink[];
	runs_shown: number;
	notes: string[];
	/** Percentiles across the Series' requests (Method requests), when it is a Series of requests. */
	request_figures: RequestDetail | null;
}

// ---------------------------------------------------------------- requests

export interface CitedCount {
	value: number;
	citation: string;
}

export interface RequestPercentileFigure {
	name: RequestPercentile;
	/** Null when the count does not support it. */
	value: CitedValue | null;
	/** How many requests are ranked at or above it. */
	at_or_above: CitedCount | null;
	/** Why it is not reported, or null. */
	not_reported: string | null;
}

export interface RequestPhaseFigures {
	phase: Phase;
	name: string;
	count: CitedCount;
	min: CitedValue;
	max: CitedValue;
	percentiles: RequestPercentileFigure[];
}

export interface RequestPoolFigures {
	runs: CitedCount;
	requests: number;
	failed: CitedCount | null;
	failures: Array<{ phase: string; kind: string; count: CitedCount }>;
	phases: RequestPhaseFigures[];
}

export interface RequestDetail {
	method: string;
	derivations: string;
	data_through: string;
	runs: number;
	counted: number;
	failed_runs: number;
	pool: RequestPoolFigures;
	groups: Array<{ id: string; pool: RequestPoolFigures }>;
	by: Array<{ fact: string; what: string; values: Array<{ value: string; pool: RequestPoolFigures }> }>;
	notes: string[];
}

const PCT_NAMES: Record<RequestPercentile, string> = { p50: "50th", p90: "90th", p95: "95th", p99: "99th", "p99.9": "99.9th" };

function phaseFigures(id: string, phase: Phase, name: string, stats: Stats, version: number, moment: string, scope: RequestScope): RequestPhaseFigures {
	const timed = (value: number, stat: "min" | "max" | RequestPercentile): CitedValue => ({ value, unit: "ns", text: timeText(value), citation: requestStatCitation(id, phase, stat, version, moment, scope) });
	return {
		phase,
		name,
		count: { value: stats.count, citation: requestStatCitation(id, phase, "count", version, moment, scope) },
		min: timed(stats.min, "min"),
		max: timed(stats.max, "max"),
		percentiles: REQUEST_PERCENTILES.map((pct) => {
			const value = stats[pct];
			if (value === null) return { name: pct, value: null, at_or_above: null, not_reported: `not reported: ${stats.count} requests, and a ${PCT_NAMES[pct]} percentile needs at least ${leastRequests(pct)}` };
			return {
				name: pct,
				value: timed(value, pct),
				at_or_above: { value: stats.at_or_above[pct] as number, citation: requestTailCitation(id, phase, pct, version, moment, scope) },
				not_reported: null,
			};
		}),
	};
}

function poolFigures(
	id: string,
	pool: Pick<Pool, "runs" | "requests"> & Partial<Pick<PoolSummary, "failed" | "failures">> & { phases: Partial<Record<Phase, Stats>> },
	phases: readonly Phase[],
	names: (phase: Phase) => string,
	version: number,
	moment: string,
	scope: RequestScope,
): RequestPoolFigures {
	const group = scope !== null && "group" in scope ? scope.group : null;
	const counts = scope === null || "group" in scope;
	return {
		runs: { value: pool.runs, citation: requestRunsCitation(id, version, moment, scope) },
		requests: pool.requests,
		failed: counts ? { value: pool.failed ?? 0, citation: requestFailedCitation(id, version, moment, group) } : null,
		failures: counts ? (pool.failures ?? []).map((f) => ({ phase: f.phase, kind: f.kind, count: { value: f.count, citation: requestFailedCitation(id, version, moment, group, f) } })) : [],
		phases: phases.flatMap((phase) => {
			const stats = pool.phases[phase];
			return stats === undefined ? [] : [phaseFigures(id, phase, names(phase), stats, version, moment, scope)];
		}),
	};
}

/** The values, in words: "a", or "a and b", or "a, b and c". No count: those are figures, cited where they are shown. */
function valuesText(values: ReadonlyArray<string | null>): string {
	const words = values.map((value) => value ?? "(none)");
	return words.length <= 1 ? (words[0] ?? "(none)") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * What the Series' Runs and requests record of what was measured, and
 * nothing they do not record: the params as given, the Service and its inputs
 * as delivered, the box's Region as its provider names it, and what the
 * requests' own events show (method and target, signing, whether each opened
 * its own connection, TLS, address blocks). The path between box and server
 * is not stated: the Runs' dumps record it.
 */
export function describeRequests(series: { params: Record<string, ParamValue>; pool: Pool; recorded: Recorded }): string[] {
	const facts = new Map(series.pool.facts.map((f) => [f.fact as string, f.values.map(({ value }) => value)]));
	const seen = (fact: string): string | null => {
		const values = facts.get(fact);
		return values === undefined ? null : `${valuesText(values)}${values.length > 1 ? ` (${values.length > 2 ? "all" : "both"} among them)` : ""}`;
	};
	const { recorded } = series;
	const lines: string[] = [];
	const asked = [seen("method"), seen("target")].filter((part) => part !== null).join(" ");
	const service =
		recorded.services.length === 0
			? "the Runs name no Service"
			: recorded.services
					.map((one) => `the Service ${one.name}, with the inputs ${Object.keys(one.inputs).sort(compareText).map((key) => `${key}=${one.inputs[key]}`).join(" ") || "(none)"} as delivered to the binary`)
					.join("; ") + (recorded.without_service > 0 ? "; some Runs name no Service" : "");
	const region = valuesText(recorded.regions.map(({ value }) => value));
	lines.push(
		`What the Runs record: params ${paramsText(series.params)}; ${service}; the box in Region ${region}, as its provider names it.` +
			(series.pool.requests === 0 ? " No request succeeded, so the requests show nothing more." : ""),
	);
	if (series.pool.requests > 0) {
		const shown: string[] = [];
		if (asked !== "") shown.push(`requests sent as ${asked}`);
		const signing = seen("signing");
		if (signing !== null) shown.push(`signing ${signing}`);
		shown.push(series.pool.phases.dns !== undefined ? "each opened a connection of its own (a name lookup, connect and TLS handshake in its time)" : "each went over a connection kept open from before it (no name lookup, connect or TLS in its time)");
		for (const [fact, words] of [["tls_version", "TLS version"], ["cipher", "cipher"], ["tls_group", "key-exchange group"], ["address_block", "server address block"]] as const) {
			const value = seen(fact);
			if (value !== null) shown.push(`${words} ${value}`);
		}
		lines.push(`What the succeeded requests' own events show: ${shown.join("; ")}.`);
	}
	lines.push(
		"The path between the box and the server is not stated here: each Run's dumps record it (sections network, ec2_route_tables and ec2_vpc_endpoints). Failed requests are counted, never timed.",
	);
	return lines;
}

function requestDetail(file: TreeSeries, from: string): RequestDetail | null {
	const requests = file.derivations.requests_v1;
	if (requests === undefined) return null;
	const id = file.id;
	const version = requests.method.version;
	const moment = momentOf(file.newest_run_started_at);
	const names = (phase: Phase): string => requests.phases.find((p) => p.phase === phase)?.name ?? phase;
	const counted = requests.counted_runs;
	const notes: string[] = [
		"Percentiles here are across requests, each request one sample, pooled across the counted Runs; a percentile is given only when the requests support it (a 99th needs 100, a 99.9th 1000), with how many requests are ranked at or above it.",
		`Pooled percentiles are read from histograms of ${requests.histogram.bins_per_doubling} bins per doubling of time: within ${(requests.histogram.precision * 100).toFixed(2)}% of the exact figure.`,
		...describeRequests({ params: file.params, pool: requests.pool, recorded: requests.recorded }),
	];
	if (counted === 1) notes.push("One counted Run: the requests are those of one box at one time; the spread across boxes is not known yet.");
	if (requests.groups.length > 1) notes.push(`Split into ${requests.groups.length} groups by Method series v1's split facts; the Series-wide figures mix them.`);
	if (requests.pool.by.length > 0) notes.push(`The requests differed in ${requests.pool.by.map((b) => b.fact).join(" and ")}: the figures by each value are below; the Series-wide figures mix them.`);
	return {
		method: `${requests.method.name} version ${version}`,
		derivations: from,
		data_through: moment,
		runs: file.runs,
		counted,
		failed_runs: requests.failed_runs,
		pool: poolFigures(id, requests.pool, PHASES, names, version, moment, null),
		groups: requests.groups.length < 2 ? [] : requests.groups.map((group) => ({ id: group.id, pool: poolFigures(id, group.pool, ["total", "first_byte"], names, version, moment, { group: group.id }) })),
		by: requests.pool.by.map((breakdown) => ({
			fact: breakdown.fact,
			what: requests.request_facts.find((f) => f.fact === breakdown.fact)?.what ?? "",
			values: breakdown.values.map((value) => ({
				value: value.value,
				pool: poolFigures(id, value, ["total", "first_byte", "connect", "tls"], names, version, moment, { fact: breakdown.fact, value: value.value }),
			})),
		})),
		notes,
	};
}

export type ShowResult =
	| { found: "one"; series: SeriesDetail }
	| { found: "many"; words: string[]; series: SeriesSummary[] }
	| { found: "none"; not_held: NotHeld };

/** A Run as show lists it: its path, which names it in a citation, and its evidence link, followed as every link of the data is. */
function runLink(data: LedgerData, point: TreeSeriesPoint): RunLink {
	const at = data.pathOf(point.evidence);
	if (at === null) {
		throw new LedgerError(`${point.evidence}, the evidence of Run ${point.path}, is not a plain path under the address the tree was built for, ${data.treeBase}, so it was not followed.`);
	}
	return {
		path: point.path,
		link: data.location.link(at),
		evidence: point.evidence,
		started_at: point.started_at,
		group: point.group,
		counted: point.counted,
		failure: point.failure,
	};
}

const newestFirst = (a: TreeSeriesPoint, b: TreeSeriesPoint): number => compareText(b.started_at, a.started_at) || compareText(a.path, b.path);

/**
 * The month files to read to list a Series' newest `runs` Runs: none when its
 * Series file's newest points hold them; otherwise its months, newest first,
 * until they hold that many.
 */
function monthsFor(runs: number | "all") {
	return (file: TreeSeries): MonthEntry[] => {
		const held = file.derivations.series_v1?.newest_points.length ?? 0;
		if (held >= file.runs || (runs !== "all" && runs <= held)) return [];
		const months = [...file.months].sort((a, b) => compareText(b.month, a.month));
		if (runs === "all") return months;
		const wanted: MonthEntry[] = [];
		let total = 0;
		for (const month of months) {
			if (total >= runs) break;
			wanted.push(month);
			total += month.runs;
		}
		return wanted;
	};
}

function detail(data: LedgerData, file: TreeSeries, points: TreeSeriesPoint[], runs: number | "all", from: string): SeriesDetail {
	const v1 = file.derivations.series_v1;
	const base = summary(file, { counted: v1?.counted_runs ?? 0, failed: v1?.failed_runs ?? 0, groups: v1?.groups.length ?? 0, requests: file.derivations.requests_v1 !== undefined });
	const id = file.id;
	const version = v1?.method.version ?? 1;
	const whatOf = new Map((v1?.split_on ?? []).map((fact) => [fact.fact, fact.what]));
	const groups = v1?.groups ?? [];
	const first = groups[0];
	const groupDetails: GroupDetail[] =
		groups.length < 2
			? []
			: groups.map((group) => {
					const differs =
						first === undefined || group.id === first.id
							? []
							: Object.keys({ ...first.facts, ...group.facts })
									.filter((fact) => JSON.stringify(first.facts[fact] ?? null) !== JSON.stringify(group.facts[fact] ?? null))
									.sort(compareText)
									.map((fact) => ({ fact, what: whatOf.get(fact) ?? "" }));
					return {
						id: group.id,
						differs_from_first: differs,
						numbers: NUMBERS.flatMap((name) => numberStats(id, name, group.percentiles[name], version, base.data_through, group.id) ?? []),
					};
				});
	const sorted = [...points].sort(newestFirst);
	const shown = runs === "all" ? sorted : sorted.slice(0, runs);
	const notes: string[] = [];
	if (base.counted === 1) notes.push("One counted Run: its 5th, 50th and 95th percentiles are the same value, and no spread is known.");
	else if (base.counted > 1 && base.counted < 21) {
		notes.push(
			`${base.counted} counted Runs: the 5th and 95th percentiles lie between the two lowest and the two highest Runs, so the spread is that of ${base.counted} boxes, not yet a distribution.`,
		);
	}
	if (groups.length > 1) {
		notes.push(
			`Split into ${groups.length} groups: a recorded fact Method series v1 splits on differs between them. The Series-wide percentiles mix the groups; say which one an estimate uses, or use the Series-wide spread as the range.`,
		);
	}
	if (base.caveat !== null) notes.push(base.caveat);
	const requestFigures = requestDetail(file, from);
	notes.push(
		requestFigures === null
			? "LedgerMath holds no 99th percentile of this Series: its percentiles are across Runs (5th, 50th, 95th). Only Series of requests (Method requests) have percentiles across requests, up to the 99th and 99.9th."
			: "Its percentiles across Runs above stop at the 95th; its percentiles across requests (Method requests, below) go to the 99th and 99.9th where the requests support them.",
	);
	return {
		...base,
		method: `series version ${version}`,
		derivations: from,
		numbers: v1 === undefined ? [] : NUMBERS.flatMap((name) => numberStats(id, name, v1.percentiles[name], version, base.data_through) ?? []),
		group_details: groupDetails,
		runs_list: shown.map((point) => runLink(data, point)),
		runs_shown: shown.length,
		notes,
		request_figures: requestFigures,
	};
}

/** One Series by its id, or the Series matching every word; for one, its Series file and the month files the Runs to list need. */
export async function showSeries(data: LedgerData, words: string[], runs: number | "all"): Promise<ShowResult> {
	const all = await sortedSummaries(data);
	const exact = words.length === 1 ? all.find((s) => s.id === words[0]) : undefined;
	let id = exact?.id;
	if (id === undefined) {
		const matching = matchingSeries(all, words);
		if (matching.length === 0) return { found: "none", not_held: seriesNotHeld(words, all) };
		if (matching.length > 1) return { found: "many", words, series: matching };
		id = (matching[0] as SeriesSummary).id;
	}
	const read = await data.seriesWithMonths(id, monthsFor(runs));
	if (read === null) return { found: "none", not_held: seriesNotHeld(words, all) };
	const newest = read.series.derivations.series_v1?.newest_points ?? [];
	const points = read.months.length === 0 ? newest : seriesPoints(read.months);
	const path = data.pathOf(read.series.url);
	return { found: "one", series: detail(data, read.series, points, runs, path === null ? read.series.url : data.location.link(path)) };
}

// ---------------------------------------------------------------- prices

export interface PriceAttribute {
	name: string;
	value: string;
	citation: string;
}

export interface PriceMatch {
	price_per_unit: string;
	currency: "USD";
	unit: string;
	description: string;
	begin_range: string;
	end_range: string;
	/** Where the tier begins and ends, in AWS's unit; AWS writes the last tier's end as the word "Inf", and its citation is of that word. */
	begin_range_citation: string;
	end_range_citation: string;
	effective_date: string;
	citation: string;
	file: string;
	file_date: string;
	fetched_at: string;
	region: string;
	sku: string;
	rate_code: string;
	product_family: string;
	rule: string;
	offer: string;
	offer_version: string;
	offer_published: string;
	attributes: PriceAttribute[];
}

export interface PriceResult {
	words: string[];
	file: string | null;
	matches: PriceMatch[];
	not_held: NotHeld | null;
}

/** The attributes the text output shows, in this order, when a product has them; --json shows them all. */
export const SHOWN_ATTRIBUTES = [
	"instanceType",
	"vcpu",
	"memory",
	"physicalProcessor",
	"clockSpeed",
	"networkPerformance",
	"storage",
	"dedicatedEbsThroughput",
	"volumeApiName",
	"maxIopsvolume",
	"maxThroughputvolume",
	"storageClass",
	"group",
	"groupDescription",
	"transferType",
	"fromLocation",
	"toLocation",
	"usagetype",
];

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function priceDimensions(source: PriceSource, sku: string): Array<{ term: Json; dimension: Json }> {
	const terms = source.terms.OnDemand[sku];
	const found: Array<{ term: Json; dimension: Json }> = [];
	for (const term of isObject(terms) ? Object.values(terms) : []) {
		if (!isObject(term) || !isObject(term.priceDimensions)) continue;
		for (const dimension of Object.values(term.priceDimensions)) if (isObject(dimension)) found.push({ term, dimension });
	}
	return found.sort((a, b) => Number(a.dimension.beginRange) - Number(b.dimension.beginRange) || compareText(String(a.dimension.rateCode), String(b.dimension.rateCode)));
}

/** Every price dimension in a price file, with its product and the rule that selected it, in the file's order. */
export function allPrices(prices: LoadedPrices): PriceMatch[] {
	const matches: PriceMatch[] = [];
	for (const source of prices.file.sources) {
		for (const selection of source.selections) {
			for (const sku of selection.skus) {
				const product = source.products[sku];
				const attributes = isObject(product) && isObject(product.attributes) ? product.attributes : {};
				for (const { term, dimension } of priceDimensions(source, sku)) {
					const usd = isObject(dimension.pricePerUnit) ? String(dimension.pricePerUnit.USD) : "";
					matches.push({
						price_per_unit: usd,
						currency: "USD",
						unit: String(dimension.unit),
						description: String(dimension.description),
						begin_range: String(dimension.beginRange),
						end_range: String(dimension.endRange),
						begin_range_citation: rangeCitation(prices.path, sku, String(dimension.rateCode), "beginRange"),
						end_range_citation: rangeCitation(prices.path, sku, String(dimension.rateCode), "endRange"),
						effective_date: String(term.effectiveDate),
						citation: priceCitation(prices.path, sku, String(dimension.rateCode)),
						file: prices.path,
						file_date: prices.date,
						fetched_at: prices.file.fetched_at,
						region: prices.file.measured.region,
						sku,
						rate_code: String(dimension.rateCode),
						product_family: isObject(product) ? String(product.productFamily ?? "") : "",
						rule: selection.rule,
						offer: source.offer_code,
						offer_version: source.version,
						offer_published: source.publication_date,
						attributes: Object.entries(attributes)
							.filter((entry): entry is [string, string] => typeof entry[1] === "string")
							.map(([name, value]) => ({ name, value, citation: attributeCitation(prices.path, sku, name) })),
					});
				}
			}
		}
	}
	return matches;
}

/** What a price is searched by: its own words, never its rule's description, which speaks for every SKU the rule selects. */
function priceSearchText(match: PriceMatch): string {
	return [match.sku, match.rate_code, match.product_family, match.rule, match.description, match.unit, match.offer, ...match.attributes.map((a) => a.value)].join(" ");
}

/** What a price file holds, one line per rule. */
export function priceFileHolds(prices: LoadedPrices): string[] {
	const lines: string[] = [];
	for (const source of prices.file.sources) {
		for (const selection of source.selections) {
			const names = selection.skus.map((sku) => {
				const product = source.products[sku];
				const attributes = isObject(product) && isObject(product.attributes) ? product.attributes : {};
				return String(attributes.instanceType ?? attributes.usagetype ?? sku);
			});
			lines.push(`${selection.rule} (${source.offer_code}): ${names.join(", ")}`);
		}
	}
	return lines;
}

export async function findPrices(data: LedgerData, words: string[]): Promise<PriceResult> {
	const prices = await data.prices();
	if (prices === null) {
		return {
			words,
			file: null,
			matches: [],
			not_held: { asked: words, lines: [`The data at ${data.location.base} hold no price file, so LedgerMath holds no price here.`] },
		};
	}
	const matches = allPrices(prices).filter((match) => words.every((word) => wordMatches(word, priceSearchText(match))));
	if (matches.length > 0) return { words, file: prices.path, matches, not_held: null };
	return {
		words,
		file: prices.path,
		matches,
		not_held: {
			asked: words,
			lines: [
				`No price in ${prices.path} matches all of: ${words.join(" ")}.`,
				`That file holds only what rule set ${prices.file.rules.version} selects, in ${prices.file.measured.region}:`,
				...priceFileHolds(prices).map((line) => `  ${line}`),
				"A price not in the file is not held by LedgerMath, whatever AWS charges for it.",
			],
		},
	};
}

// ---------------------------------------------------------------- about

export interface About {
	location: string;
	/** The list of Series it was read from. */
	derivations: string;
	method: string;
	layout: number;
	runs_read: number;
	series: number;
	runs: number;
	counted_runs: number;
	failed_runs: number;
	unreadable_runs: number;
	first_run_at: string | null;
	newest_run_at: string | null;
	benchmarks: Record<string, number>;
	benchmarks_without_series: string[];
	instance_types: Record<string, number>;
	/** How many Series have percentiles across their requests (Method requests). */
	request_series: number;
	price_files: string[];
	price_file: string | null;
	price_file_date: string | null;
	/** The newest round of boots, as the table of contents gives it; absent when it gives none (a tree built before 2026-11-24, or no boot summary in a round). */
	newest_round?: TreeRoundFigures;
	/** How many boot summaries are in no round, and the newest of them; absent when the table of contents gives no rounds, or leaves none out. */
	boot_summaries_left_out?: { count: number; newest: TreeLeftOut };
}

/** The newest round of boots the table of contents gives, its figures in all; undefined when it gives none. */
function newestRound(data: LedgerData): TreeRoundFigures | undefined {
	const round = data.index.recent_rounds?.rounds?.[0];
	if (round === undefined) return undefined;
	const { started_at, boots, runs, failed_runs, runs_in_no_series, build_failures, not_run, instance_types } = round;
	return { started_at, boots, runs, failed_runs, runs_in_no_series, build_failures, not_run, instance_types };
}

/** How many boot summaries the table of contents leaves out of its rounds, and the newest; undefined when it leaves none out or gives no rounds. */
function leftOut(data: LedgerData): About["boot_summaries_left_out"] {
	const left = data.index.recent_rounds?.left_out;
	const newest = left?.summaries?.[0];
	return left === undefined || newest === undefined || left.count === 0 ? undefined : { count: left.count, newest };
}

export async function about(data: LedgerData): Promise<About> {
	const list = await data.list();
	const all = await sortedSummaries(data);
	const firsts = all.map((s) => s.first_run_at as string).sort(compareText);
	const newests = all.map((s) => s.newest_run_at as string).sort(compareText);
	const benchmarks = countBy(all.map((s) => s.benchmark));
	const v1 = list.methods.series_v1;
	const inUse = data.index.prices.files.find((entry) => entry.path === data.pricesPath) ?? null;
	const listPath = data.pathOf(list.url);
	return {
		location: data.location.base,
		derivations: listPath === null ? list.url : data.location.link(listPath),
		method: `${v1?.method.name ?? "series"} version ${v1?.method.version ?? 1}`,
		layout: data.index.layout,
		runs_read: v1?.runs_read ?? 0,
		series: all.length,
		runs: all.reduce((sum, s) => sum + s.runs, 0),
		counted_runs: all.reduce((sum, s) => sum + s.counted, 0),
		failed_runs: all.reduce((sum, s) => sum + s.failed, 0),
		unreadable_runs: v1?.unreadable.length ?? 0,
		first_run_at: firsts[0] ?? null,
		newest_run_at: newests.at(-1) ?? null,
		benchmarks: Object.fromEntries(benchmarks),
		benchmarks_without_series: Object.keys(BENCHMARK_NOTES)
			.filter((name) => !benchmarks.has(name))
			.sort(compareText),
		instance_types: Object.fromEntries(countBy(all.map((s) => s.instance_type ?? "(no instance type)"))),
		request_series: all.filter((s) => s.requests).length,
		price_files: data.priceFiles,
		price_file: inUse?.path ?? null,
		price_file_date: inUse?.date ?? null,
		newest_round: newestRound(data),
		boot_summaries_left_out: leftOut(data),
	};
}

// ---------------------------------------------------------------- text

/** The newest round of boots on one line: when it started, its boots and their instance types, its Runs, and whatever did not run or count. */
function roundText(round: TreeRoundFigures): string {
	const types = round.instance_types.map((type) => type ?? "(no instance type)").join(", ");
	const others = [
		round.runs_in_no_series > 0 ? `${round.runs_in_no_series} in no Series` : "",
		round.build_failures > 0 ? `${round.build_failures} build${round.build_failures === 1 ? "" : "s"} failed` : "",
		round.not_run > 0 ? `${round.not_run} not run` : "",
	].filter((part) => part !== "");
	return `Newest round of boots: started ${atSecond(round.started_at)}, ${round.boots} boot${round.boots === 1 ? "" : "s"} (${types}), ${round.runs} Runs, ${round.failed_runs} failed${others.map((part) => `, ${part}`).join("")}.`;
}

export function aboutText(a: About): string {
	const lines = [
		`LedgerMath data at ${a.location} (the data API, version 1, layout ${a.layout})`,
		`Series: ${a.derivations}, Method ${a.method}: ${a.runs_read} Run files read, ${a.series} Series, ${a.counted_runs} counted Runs, ${a.failed_runs} failed, ${a.unreadable_runs} unreadable.`,
		`Runs started from ${a.first_run_at === null ? "-" : atSecond(a.first_run_at)} to ${a.newest_run_at === null ? "-" : atSecond(a.newest_run_at)}.`,
		...(a.newest_round === undefined ? [] : [roundText(a.newest_round)]),
		...(a.boot_summaries_left_out === undefined
			? []
			: [`Boot summaries in no round: ${a.boot_summaries_left_out.count}, the newest ${a.boot_summaries_left_out.newest.path}: ${a.boot_summaries_left_out.newest.why}.`]),
		`Benchmarks with Series: ${listed(new Map(Object.entries(a.benchmarks)))}.`,
		`Benchmarks with no Series in this data: ${a.benchmarks_without_series.length === 0 ? "none" : a.benchmarks_without_series.join(", ")}.`,
		`Instance types with Series: ${listed(new Map(Object.entries(a.instance_types)))}.`,
		"Percentiles across Runs: the 5th, 50th and 95th of every Series (Method series); no 99th percentile across Runs.",
		a.request_series === 0
			? "Percentiles across requests: none in this data, so no 99th percentile at all."
			: `Percentiles across requests (Method requests): ${a.request_series} Series of requests, each phase of an HTTPS GET to S3 up to the 99th and 99.9th percentile where the requests support them.`,
	];
	if (a.price_file === null) lines.push("Price files: none.");
	else {
		lines.push(
			`Price files: ${a.price_files.length}, from ${a.price_files[0]} to ${a.price_files.at(-1)}; in use ${a.price_file}, the price file of ${a.price_file_date}.`,
			"What it holds, AWS's On-Demand prices in AWS's words: prices <word> finds them, and lists everything the file holds when no price matches.",
		);
	}
	lines.push("Anything not listed here is not held. LedgerMath holds measurements and prices; it does not estimate.");
	return `${lines.join("\n")}\n`;
}

/** Series grouped by benchmark: what the benchmark measures once, then one line per Series. */
function seriesLines(series: SeriesSummary[]): string[] {
	const lines: string[] = [];
	let benchmark: string | null = null;
	for (const s of series) {
		if (s.benchmark !== benchmark) {
			benchmark = s.benchmark;
			if (lines.length > 0) lines.push("");
			lines.push(`${s.benchmark}: ${s.measures ?? "(no description kept for this benchmark)"} ${s.measures_citation}`);
			if (s.caveat !== null) lines.push(`  ${s.caveat}`);
		}
		lines.push(
			`  ${s.id}  ${s.instance_type ?? "(no instance type)"}  ${s.availability_zone_id ?? "-"}  ${paramsText(s.params)}  build ${s.build}  ` +
				`${s.counted} counted of ${s.runs} Runs, newest ${s.newest_run_at === null ? "-" : atSecond(s.newest_run_at)}` +
				`${s.groups > 1 ? `, split into ${s.groups} groups` : ""}${s.requests ? ", percentiles across requests: show it" : ""}`,
		);
		for (const note of s.variant) lines.push(`      this set: ${note}`);
	}
	return lines;
}

export function seriesListText(list: SeriesList): string {
	const lines: string[] = [];
	if (list.not_held !== null) lines.push(...list.not_held.lines);
	else {
		lines.push(
			`${list.series.length} Series${list.words.length > 0 ? ` matching ${list.words.join(" ")}` : ""}: id, instance type, zone ID, params, build, Runs. Show one with: show <id>`,
			"",
			...seriesLines(list.series),
		);
	}
	return `${lines.join("\n")}\n`;
}

function numberLines(stats: NumberStats, indent: string): string[] {
	const label = stats.number === "time_per_repetition_ns" ? "time per repetition" : "bytes per second";
	const rows = (["p5", "p50", "p95"] as const).map((which) => {
		const cited = stats[which];
		return `${indent}  ${which.padEnd(4)} ${cited.text.padEnd(28)} ${cited.citation}`;
	});
	return [`${indent}${label}, across ${stats.count} counted Runs ${stats.count_citation}:`, ...rows];
}

export function showText(result: ShowResult): string {
	const lines: string[] = [];
	if (result.found === "none") lines.push(...result.not_held.lines);
	else if (result.found === "many") {
		lines.push(`${result.series.length} Series match ${result.words.join(" ")}; show one by its id, or add words:`, "", ...seriesLines(result.series));
	} else {
		const s = result.series;
		lines.push(
			`Series ${s.id}: ${s.benchmark} on ${s.instance_type ?? "(no instance type)"}, zone ID ${s.availability_zone_id ?? "-"}, build ${s.build}`,
			`  params: ${Object.keys(s.params)
				.sort(compareText)
				.map((key) => `${key}=${String(s.params[key])} ${s.params_citations[key]}`)
				.join(", ")}`,
		);
		if (s.measures !== null) lines.push(`  measures: ${s.measures} ${s.measures_citation}`);
		for (const note of s.variant) lines.push(`  this set: ${note}`);
		if (s.repetition !== null) lines.push(`  one repetition: ${s.repetition}`);
		if (s.bytes !== null) lines.push(`  bytes per second counts: ${s.bytes}`);
		lines.push(
			`  Runs: ${s.runs} (${s.counted} counted, ${s.failed} failed), ${s.first_run_at === null ? "-" : atSecond(s.first_run_at)} to ${s.newest_run_at === null ? "-" : atSecond(s.newest_run_at)}`,
			`  data through ${s.data_through}, the newest Run's start: each citation below is of the Series as it stood then, under Method ${s.method}`,
			"",
		);
		if (s.numbers.length === 0) lines.push("No counted Run: this Series has no number.", "");
		for (const stats of s.numbers) lines.push(...numberLines(stats, ""), "");
		for (const note of s.notes) lines.push(`Note: ${note}`);
		if (s.notes.length > 0) lines.push("");
		for (const group of s.group_details) {
			const differs = group.differs_from_first.length === 0 ? "" : `: differs from group A in: ${group.differs_from_first.map((d) => `${d.fact} (${d.what})`).join("; ")}`;
			lines.push(`Group ${group.id}${differs}`);
			if (group.numbers.length === 0) lines.push("  no counted Run: no number.");
			for (const stats of group.numbers) lines.push(...numberLines(stats, "  "));
			lines.push("");
		}
		if (s.request_figures !== null) lines.push(...requestLines(s.request_figures), "");
		lines.push(`Runs behind these numbers (${s.runs_shown} of ${s.runs}, newest first${s.runs_shown < s.runs ? "; --runs all lists every one" : ""}):`);
		for (const run of s.runs_list) {
			lines.push(`  ${run.link}  ${atSecond(run.started_at)}  group ${run.group}  ${run.counted ? "counted" : `failed: ${run.failure}`}`);
		}
		lines.push("", "Cite a number with the citation printed beside it, and link at least one of these Runs in the answer.", `Method ${s.method}, from ${s.derivations}.`);
	}
	return `${lines.join("\n")}\n`;
}

function phaseLines(figures: RequestPhaseFigures, indent: string): string[] {
	const lines = [`${indent}${figures.phase}, ${figures.name}, over ${figures.count.value} requests ${figures.count.citation}:`];
	lines.push(`${indent}  min   ${figures.min.text.padEnd(14)} ${figures.min.citation}`);
	for (const pct of figures.percentiles) {
		if (pct.value === null) lines.push(`${indent}  ${pct.name.padEnd(5)} ${pct.not_reported}`);
		else {
			const tail = pct.name === "p50" || pct.at_or_above === null ? "" : `, ${pct.at_or_above.value} ${pct.at_or_above.value === 1 ? "request" : "requests"} at or above it ${pct.at_or_above.citation}`;
			lines.push(`${indent}  ${pct.name.padEnd(5)} ${pct.value.text.padEnd(14)} ${pct.value.citation}${tail}`);
		}
	}
	lines.push(`${indent}  max   ${figures.max.text.padEnd(14)} ${figures.max.citation}`);
	return lines;
}

function poolLines(pool: RequestPoolFigures, indent: string): string[] {
	const lines = [`${indent}from ${pool.runs.value} counted Runs ${pool.runs.citation}`];
	if (pool.failed !== null) {
		lines.push(`${indent}failed requests, in no time: ${pool.failed.value} ${pool.failed.citation}`);
		for (const f of pool.failures) lines.push(`${indent}  ${f.phase} ${f.kind}: ${f.count.value} ${f.count.citation}`);
	}
	for (const phase of pool.phases) lines.push(...phaseLines(phase, indent));
	return lines;
}

function requestLines(r: RequestDetail): string[] {
	const lines = [
		`Percentiles across requests, Method ${r.method}: ${r.runs} Runs (${r.counted} counted, ${r.failed_runs} failed), data through ${r.data_through}:`,
		...poolLines(r.pool, "  "),
	];
	for (const note of r.notes) lines.push(`Note: ${note}`);
	for (const group of r.groups) lines.push("", `Group ${group.id}, its requests:`, ...poolLines(group.pool, "  "));
	for (const breakdown of r.by) {
		for (const value of breakdown.values) lines.push("", `Requests with ${breakdown.fact} ${value.value} (${breakdown.what}):`, ...poolLines(value.pool, "  "));
	}
	return lines;
}

export function pricesText(result: PriceResult): string {
	const lines: string[] = [];
	if (result.not_held !== null) lines.push(...result.not_held.lines);
	else {
		const first = result.matches[0] as PriceMatch;
		lines.push(
			`${result.matches.length} price${result.matches.length === 1 ? "" : "s"} matching ${result.words.join(" ")} in ${first.file}, the price file of ${first.file_date} (fetched ${first.fetched_at}), Region ${first.region}, On-Demand:`,
			"",
		);
		for (const match of result.matches) {
			lines.push(
				`${match.price_per_unit} ${match.currency} per ${match.unit}   ${match.citation}`,
				`  AWS's description: "${match.description}"`,
				`  tier from ${match.begin_range} ${match.unit} ${match.begin_range_citation} to ${Number.isFinite(Number(match.end_range)) ? `${match.end_range} ${match.unit}` : match.end_range} ${match.end_range_citation}`,
				`  effective ${match.effective_date}; price file of ${match.file_date}`,
				`  ${match.product_family}, SKU ${match.sku}, rate code ${match.rate_code}, selected by rule ${match.rule}; ${match.offer} offer file version ${match.offer_version}, published ${match.offer_published}`,
			);
			const shown = SHOWN_ATTRIBUTES.flatMap((name) => match.attributes.filter((a) => a.name === name));
			if (shown.length > 0) {
				lines.push("  AWS's catalog words for the product (--json lists every attribute):");
				for (const attribute of shown) lines.push(`    ${attribute.name.padEnd(22)} ${attribute.value.padEnd(30)} ${attribute.citation}`);
			}
			lines.push("");
		}
		lines.push(`Quote a price with its citation and the price file's date (${first.file_date}).`);
	}
	return `${lines.join("\n")}\n`;
}
