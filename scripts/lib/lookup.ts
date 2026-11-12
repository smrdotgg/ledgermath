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
 */

import type { Stats } from "../../methods/requests/v1/numbers";
import type { Pool, PoolSummary, SeriesDerivation as RequestsSeries } from "../../methods/requests/v1/output";
import { PHASES, type Phase } from "../../methods/requests/v1/requests";
import { compareText, type ParamValue } from "../../methods/run";
import type { Point, SeriesDerivation, Stat } from "../../methods/v1/output";
import { BENCHMARK_NOTES, variantNotes } from "./benchmark-notes";
import {
	attributeCitation,
	benchmarkCitation,
	NUMBER_UNIT,
	NUMBERS,
	type NumberName,
	leastRequests,
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
	seriesMoment,
} from "./citation";
import type { LedgerData, LoadedPrices } from "./ledger-data";
import { agrees, type Dims, quantities } from "./quantity";
import type { PriceSource } from "./prices";

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

const numberText = (name: NumberName, value: number): string => (name === "time_per_repetition_ns" ? timeText(value) : rateText(value));

/** A Run's start, to the second. */
const atSecond = (iso: string): string => `${iso.slice(0, 19)}Z`;

// ---------------------------------------------------------------- Series

export interface CitedValue {
	value: number;
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
	boots: number;
	first_run_at: string | null;
	newest_run_at: string | null;
	/** The start of the newest Run, to the second: the moment the Series' citations are of. */
	data_through: string;
	groups: number;
	/** Whether Method requests holds percentiles across this Series' requests. */
	requests: boolean;
}

function summary(series: SeriesDerivation, data?: LedgerData): SeriesSummary {
	const { id, benchmark, params, build } = series.series;
	const note = BENCHMARK_NOTES[benchmark];
	const times = series.points.map((point) => point.started_at).sort(compareText);
	const counted = series.points.filter((point) => point.counted).length;
	return {
		id,
		benchmark,
		params,
		params_citations: Object.fromEntries(Object.keys(params).sort(compareText).map((key) => [key, paramCitation(id, key)])),
		build,
		instance_type: series.series.instance_type,
		availability_zone_id: series.series.availability_zone_id,
		measures: note?.measures ?? null,
		measures_citation: benchmarkCitation(benchmark),
		variant: note === undefined ? [] : variantNotes(note, params),
		repetition: note?.repetition ?? null,
		bytes: note?.bytes ?? null,
		caveat: note?.caveat ?? null,
		runs: series.points.length,
		counted,
		failed: series.points.length - counted,
		boots: new Set(series.points.map((point) => point.boot)).size,
		first_run_at: times[0] ?? null,
		newest_run_at: times[times.length - 1] ?? null,
		data_through: seriesMoment(series),
		groups: series.groups.length,
		requests: data?.requests?.derivations.some((d) => d.series.id === id) ?? false,
	};
}

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
function numberStats(id: string, name: NumberName, stat: Stat | null, version: number, moment: string, group?: string): NumberStats | null {
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

function sortedSummaries(data: LedgerData): SeriesSummary[] {
	return data.derivations.derivations.map((series) => summary(series, data)).sort(
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

function seriesNotHeld(data: LedgerData, words: string[], all: SeriesSummary[]): NotHeld {
	const lines: string[] = [`LedgerMath holds no Series matching all of: ${words.join(" ")}.`];
	const benchmarks = countBy(all.map((s) => s.benchmark));
	const types = countBy(all.map((s) => s.instance_type ?? "(no instance type)"));
	const priced = new Set(data.prices?.file.measured.instance_types ?? []);
	for (const word of words) {
		const matching = matchingSeries(all, [word]);
		if (matching.length > 0) {
			lines.push(`"${word}" alone matches ${matching.length} Series (${[...countBy(matching.map((s) => `${s.benchmark} on ${s.instance_type}`)).keys()].join(", ")}).`);
			continue;
		}
		if (word in BENCHMARK_NOTES) lines.push(`"${word}" is a LedgerMath benchmark, but this data holds no Series of it yet.`);
		else if (priced.has(word)) lines.push(`"${word}" is an instance type LedgerMath prices (${data.prices?.path}), but this data holds no Series of it yet.`);
		else lines.push(`"${word}" matches no Series.`);
	}
	lines.push(`Benchmarks with Series: ${listed(benchmarks)}.`);
	lines.push(`Instance types with Series: ${listed(types)}.`);
	lines.push("A number LedgerMath does not hold is not measured here; do not stand one in for it without saying so.");
	return { asked: words, lines };
}

export function listSeries(data: LedgerData, words: string[]): SeriesList {
	const all = sortedSummaries(data);
	const series = matchingSeries(all, words);
	return { words, series, not_held: series.length === 0 ? seriesNotHeld(data, words, all) : null };
}

export interface RunLink {
	path: string;
	link: string;
	started_at: string;
	group: string;
	counted: boolean;
	failure: string | null;
}

export interface GroupDetail {
	id: string;
	runs: number;
	counted: number;
	first_run_at: string | null;
	newest_run_at: string | null;
	/** The split facts whose values differ from group A's, with what each is. */
	differs_from_first: Array<{ fact: string; what: string }>;
	numbers: NumberStats[];
}

export interface SeriesDetail extends SeriesSummary {
	method: string;
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
export function describeRequests(series: RequestsSeries): string[] {
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
		`What the Runs record: params ${paramsText(series.series.params)}; ${service}; the box in Region ${region}, as its provider names it.` +
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

function requestDetail(data: LedgerData, series: RequestsSeries): RequestDetail {
	const requests = data.requests as NonNullable<LedgerData["requests"]>;
	const id = series.series.id;
	const version = requests.method.version;
	const moment = seriesMoment(series);
	const names = (phase: Phase): string => requests.phases.find((p) => p.phase === phase)?.name ?? phase;
	const counted = series.points.filter((point) => point.counted).length;
	const notes: string[] = [
		"Percentiles here are across requests, each request one sample, pooled across the counted Runs; a percentile is given only when the requests support it (a 99th needs 100, a 99.9th 1000), with how many requests are ranked at or above it.",
		`Pooled percentiles are read from histograms of ${requests.histogram.bins_per_doubling} bins per doubling of time: within ${(requests.histogram.precision * 100).toFixed(2)}% of the exact figure.`,
		...describeRequests(series),
	];
	if (counted === 1) notes.push("One counted Run: the requests are those of one box at one time; the spread across boxes is not known yet.");
	if (series.groups.length > 1) notes.push(`Split into ${series.groups.length} groups by Method series v1's split facts; the Series-wide figures mix them.`);
	if (series.pool.by.length > 0) notes.push(`The requests differed in ${series.pool.by.map((b) => b.fact).join(" and ")}: the figures by each value are below; the Series-wide figures mix them.`);
	return {
		method: `${requests.method.name} version ${version}`,
		derivations: data.requestsFrom ?? "",
		data_through: moment,
		runs: series.points.length,
		counted,
		failed_runs: series.points.length - counted,
		pool: poolFigures(id, series.pool, PHASES, names, version, moment, null),
		groups: series.groups.length < 2 ? [] : series.groups.map((group) => ({ id: group.id, pool: poolFigures(id, group.pool, ["total", "first_byte"], names, version, moment, { group: group.id }) })),
		by: series.pool.by.map((breakdown) => ({
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

function runLink(data: LedgerData, point: Point): RunLink {
	return {
		path: point.path,
		link: data.location.link(point.path),
		started_at: point.started_at,
		group: point.group,
		counted: point.counted,
		failure: point.failure,
	};
}

function detail(data: LedgerData, series: SeriesDerivation, runs: number | "all"): SeriesDetail {
	const base = summary(series);
	const id = series.series.id;
	const version = data.derivations.method.version;
	const whatOf = new Map(data.derivations.split_on.map((fact) => [fact.fact, fact.what]));
	const first = series.groups[0];
	const groupDetails: GroupDetail[] =
		series.groups.length < 2
			? []
			: series.groups.map((group) => {
					const points = series.points.filter((point) => point.group === group.id);
					const times = points.map((point) => point.started_at).sort(compareText);
					const differs =
						first === undefined || group.id === first.id
							? []
							: Object.keys({ ...first.facts, ...group.facts })
									.filter((fact) => JSON.stringify(first.facts[fact] ?? null) !== JSON.stringify(group.facts[fact] ?? null))
									.sort(compareText)
									.map((fact) => ({ fact, what: whatOf.get(fact) ?? "" }));
					return {
						id: group.id,
						runs: points.length,
						counted: points.filter((point) => point.counted).length,
						first_run_at: times[0] ?? null,
						newest_run_at: times[times.length - 1] ?? null,
						differs_from_first: differs,
						numbers: NUMBERS.flatMap((name) => numberStats(id, name, group.percentiles[name], version, base.data_through, group.id) ?? []),
					};
				});
	const newestFirst = [...series.points].sort((a, b) => compareText(b.started_at, a.started_at) || compareText(a.path, b.path));
	const shown = runs === "all" ? newestFirst : newestFirst.slice(0, runs);
	const notes: string[] = [];
	if (base.counted === 1) notes.push("One counted Run: its 5th, 50th and 95th percentiles are the same value, and no spread is known.");
	else if (base.counted > 1 && base.counted < 21) {
		notes.push(
			`${base.counted} counted Runs: the 5th and 95th percentiles lie between the two lowest and the two highest Runs, so the spread is that of ${base.counted} boxes, not yet a distribution.`,
		);
	}
	if (series.groups.length > 1) {
		notes.push(
			`Split into ${series.groups.length} groups: a recorded fact Method series v1 splits on differs between them. The Series-wide percentiles mix the groups; say which one an estimate uses, or use the Series-wide spread as the range.`,
		);
	}
	if (base.caveat !== null) notes.push(base.caveat);
	const requestSeries = data.requests?.derivations.find((d) => d.series.id === id) ?? null;
	notes.push(
		requestSeries === null
			? "LedgerMath holds no 99th percentile of this Series: its percentiles are across Runs (5th, 50th, 95th). Only Series of requests (Method requests) have percentiles across requests, up to the 99th and 99.9th."
			: "Its percentiles across Runs above stop at the 95th; its percentiles across requests (Method requests, below) go to the 99th and 99.9th where the requests support them.",
	);
	return {
		...base,
		method: `${data.derivations.method.name} version ${data.derivations.method.version}`,
		derivations: data.derivationsFrom,
		numbers: NUMBERS.flatMap((name) => numberStats(id, name, series.percentiles[name], version, base.data_through) ?? []),
		group_details: groupDetails,
		runs_list: shown.map((point) => runLink(data, point)),
		runs_shown: shown.length,
		notes,
		request_figures: requestSeries === null ? null : requestDetail(data, requestSeries),
	};
}

export function showSeries(data: LedgerData, words: string[], runs: number | "all"): ShowResult {
	const exact = words.length === 1 ? data.derivations.derivations.find((d) => d.series.id === words[0]) : undefined;
	if (exact !== undefined) return { found: "one", series: detail(data, exact, runs) };
	const list = listSeries(data, words);
	if (list.not_held !== null) return { found: "none", not_held: list.not_held };
	if (list.series.length > 1) return { found: "many", words, series: list.series };
	const only = data.derivations.derivations.find((d) => d.series.id === list.series[0]?.id) as SeriesDerivation;
	return { found: "one", series: detail(data, only, runs) };
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
	/** Where the tier begins and ends, in AWS's unit; null for "Inf", which cites nothing. */
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

export function findPrices(data: LedgerData, words: string[]): PriceResult {
	const prices = data.prices;
	if (prices === null) {
		return {
			words,
			file: null,
			matches: [],
			not_held: { asked: words, lines: [`There is no price file at ${data.location.base}, so LedgerMath holds no price here.`] },
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
	synthetic: string | null;
	derivations: string;
	method: string;
	runs_read: number;
	series: number;
	counted_runs: number;
	failed_runs: number;
	unreadable_runs: number;
	first_run_at: string | null;
	newest_run_at: string | null;
	benchmarks: Record<string, number>;
	benchmarks_without_series: string[];
	instance_types: Record<string, number>;
	/** Method requests' Derivations: where from, and how many Series of requests. */
	requests_derivations: string | null;
	request_series: number;
	price_files: string[];
	price_file: string | null;
	price_file_fetched_at: string | null;
	price_region: string | null;
	price_file_holds: string[];
}

export function about(data: LedgerData): About {
	const all = sortedSummaries(data);
	const times = data.derivations.derivations.flatMap((d) => d.points.map((p) => p.started_at)).sort(compareText);
	const counted = all.reduce((sum, s) => sum + s.counted, 0);
	const failed = all.reduce((sum, s) => sum + s.failed, 0);
	const benchmarks = countBy(all.map((s) => s.benchmark));
	return {
		location: data.location.base,
		synthetic: data.derivations.synthetic ?? null,
		derivations: data.derivationsFrom,
		method: `${data.derivations.method.name} version ${data.derivations.method.version}`,
		runs_read: data.derivations.runs_read,
		series: all.length,
		counted_runs: counted,
		failed_runs: failed,
		unreadable_runs: data.derivations.unreadable.length,
		first_run_at: times[0] ?? null,
		newest_run_at: times[times.length - 1] ?? null,
		benchmarks: Object.fromEntries(benchmarks),
		benchmarks_without_series: Object.keys(BENCHMARK_NOTES)
			.filter((name) => !benchmarks.has(name))
			.sort(compareText),
		instance_types: Object.fromEntries(countBy(all.map((s) => s.instance_type ?? "(no instance type)"))),
		requests_derivations: data.requestsFrom,
		request_series: data.requests?.derivations.length ?? 0,
		price_files: data.priceFiles,
		price_file: data.prices?.path ?? null,
		price_file_fetched_at: data.prices?.file.fetched_at ?? null,
		price_region: data.prices?.file.measured.region ?? null,
		price_file_holds: data.prices === null ? [] : priceFileHolds(data.prices),
	};
}

// ---------------------------------------------------------------- text

const SYNTHETIC = (why: string): string[] => [`SYNTHETIC DATA, NOT MEASURED: ${why}`, ""];

function banner(data: LedgerData): string[] {
	return data.derivations.synthetic === undefined ? [] : SYNTHETIC(data.derivations.synthetic);
}

export function aboutText(data: LedgerData, a: About): string {
	const lines = [
		...banner(data),
		`LedgerMath data at ${a.location}`,
		`Derivations: ${a.derivations}, Method ${a.method}: ${a.runs_read} Run files read, ${a.series} Series, ${a.counted_runs} counted Runs, ${a.failed_runs} failed, ${a.unreadable_runs} unreadable.`,
		`Runs started from ${a.first_run_at === null ? "-" : atSecond(a.first_run_at)} to ${a.newest_run_at === null ? "-" : atSecond(a.newest_run_at)}.`,
		`Benchmarks with Series: ${listed(new Map(Object.entries(a.benchmarks)))}.`,
		`Benchmarks with no Series in this data: ${a.benchmarks_without_series.length === 0 ? "none" : a.benchmarks_without_series.join(", ")}.`,
		`Instance types with Series: ${listed(new Map(Object.entries(a.instance_types)))}.`,
		"Percentiles across Runs: the 5th, 50th and 95th of every Series (Method series); no 99th percentile across Runs.",
		a.requests_derivations === null
			? "Percentiles across requests: none in this data (no requests-derivations.json), so no 99th percentile at all."
			: `Percentiles across requests (Method requests): ${a.request_series} Series of requests, each phase of an HTTPS GET to S3 up to the 99th and 99.9th percentile where the requests support them, from ${a.requests_derivations}.`,
	];
	if (a.price_file === null) lines.push("Price files: none.");
	else {
		lines.push(
			`Price files: ${a.price_files.length}; in use ${a.price_file} (fetched ${a.price_file_fetched_at}, Region ${a.price_region}). It holds:`,
			...a.price_file_holds.map((line) => `  ${line}`),
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
				`${s.counted} counted of ${s.runs} Runs, ${s.boots} boots, newest ${s.newest_run_at === null ? "-" : atSecond(s.newest_run_at)}` +
				`${s.groups > 1 ? `, split into ${s.groups} groups` : ""}${s.requests ? ", percentiles across requests: show it" : ""}`,
		);
		for (const note of s.variant) lines.push(`      this set: ${note}`);
	}
	return lines;
}

export function seriesListText(data: LedgerData, list: SeriesList): string {
	const lines = [...banner(data)];
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

export function showText(data: LedgerData, result: ShowResult): string {
	const lines = [...banner(data)];
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
			`  Runs: ${s.runs} (${s.counted} counted, ${s.failed} failed) from ${s.boots} boots, ${s.first_run_at === null ? "-" : atSecond(s.first_run_at)} to ${s.newest_run_at === null ? "-" : atSecond(s.newest_run_at)}`,
			`  data through ${s.data_through}, the newest Run's start: each citation below is of the Series as it stood then, under Method ${s.method}`,
			"",
		);
		if (s.numbers.length === 0) lines.push("No counted Run: this Series has no number.", "");
		for (const stats of s.numbers) lines.push(...numberLines(stats, ""), "");
		for (const note of s.notes) lines.push(`Note: ${note}`);
		if (s.notes.length > 0) lines.push("");
		for (const group of s.group_details) {
			const differs = group.differs_from_first.length === 0 ? "" : `; differs from group A in: ${group.differs_from_first.map((d) => `${d.fact} (${d.what})`).join("; ")}`;
			lines.push(`Group ${group.id}: ${group.runs} Runs (${group.counted} counted), ${group.first_run_at === null ? "-" : atSecond(group.first_run_at)} to ${group.newest_run_at === null ? "-" : atSecond(group.newest_run_at)}${differs}`);
			for (const stats of group.numbers) lines.push(...numberLines(stats, "  "));
			lines.push("");
		}
		if (s.request_figures !== null) lines.push(...requestLines(s.request_figures), "");
		lines.push(`Runs behind these numbers (${s.runs_shown} of ${s.runs}, newest first${s.runs_shown < s.runs ? "; --runs all lists every one" : ""}):`);
		for (const run of s.runs_list) {
			lines.push(`  ${run.link}  ${atSecond(run.started_at)}  group ${run.group}  ${run.counted ? "counted" : `failed: ${run.failure}`}`);
		}
		lines.push(
			"",
			"Cite a number with the citation printed beside it, and link at least one of these Runs in the answer.",
			`Method ${s.method}, from ${s.derivations}.`,
		);
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

export function pricesText(data: LedgerData, result: PriceResult): string {
	const lines = [...banner(data)];
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
