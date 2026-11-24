/**
 * The citation syntax the skill prescribes (skills/ledgermath/SKILL.md), which
 * the lookup tool prints beside every number and the answer checker resolves:
 *
 *   [lm:series/<id>/<number>/<stat>@v<version>,<moment>]            a Series' percentile across its Runs
 *   [lm:series/<id>/group/<G>/<number>/<stat>@v<version>,<moment>]  one group's, when the Series is split
 *       <number>   time_per_repetition_ns | bytes_per_second
 *       <stat>     p5 | p50 | p95 | count (the number of counted Runs)
 *       <version>  the version of Method series, which "series/" names
 *       <moment>   yyyy-mm-ddThh:mm:ssZ, the start of the Series' newest Run, to the second:
 *                  the citation is of the Series as it stood then
 *   [lm:requests/<id>/<phase>/<stat>@v<version>,<moment>]           a percentile across a Series' requests (Method requests)
 *   [lm:requests/<id>/<phase>/<pct>/at_or_above@v<version>,<moment>] how many requests are ranked at or above it
 *   [lm:requests/<id>/runs@v<version>,<moment>]                      how many counted Runs the requests are from
 *   [lm:requests/<id>/failed[/<phase>/<kind>]@v<version>,<moment>]   how many counted requests failed (of a phase and kind)
 *       each after requests/<id>/ may be scoped to one group, group/<G>/, and (all but failed) to the
 *       requests that had one value of a request fact, by/<fact>/<value>/ (held only as of the newest Run)
 *       <phase>    dns | connect | tls | send | first_byte | headers | body | total
 *       <stat>     count (requests) | min | p50 | p90 | p95 | p99 | p99.9 | max, in ns but count
 *       <version>  the version of Method requests, which "requests/" names
 *   [lm:series/<id>/params/<key>]                 a parameter of the Series (they never change)
 *   [lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/<rate code>]          a price, in AWS's unit
 *   [lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/<rate code>/beginRange]   where its tier begins, in AWS's unit
 *   [lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/<rate code>/endRange]     where it ends ("Inf" cites nothing)
 *   [lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/attributes/<name>]    AWS's catalog words for a product
 *   [lm:benchmark/<name>]                         what a benchmark measures: words, which cite no number
 *   runs/<yyyy>/<mm>/<dd>/<run id>.json           a Run: the bare path, or its address (the data API's, or the Runs repository's)
 *   [assumption: <where it comes from>]           a number LedgerMath does not hold
 *
 * A citation belongs to the nearest number before it on its line.
 *
 * Each resolves in the data API's tree (scripts/lib/ledger-data.ts): a Series
 * citation in its Series file (v1/series/<id>.json) under the Method's key,
 * series_v1 or requests_v1, as of the Series' newest Run, and, when it is of
 * an earlier moment, in the month files up to that moment; a price citation in
 * the price file the table of contents lists under that path.
 *
 * The moment is the Series' own newest Run, not the file's: boots of one
 * instance type never overlap and upload all their Runs at once, so no Run of
 * the Series that started by then can arrive later, while Runs of another
 * type's boot still running when the Derivations were made can.
 */

import type { Stats } from "../../methods/requests/v1/numbers";
import type { PoolSummary } from "../../methods/requests/v1/output";
import { PHASES, type Phase, REQUEST_FACTS, type RequestFact } from "../../methods/requests/v1/requests";
import type { ParamValue } from "../../methods/run";
import { percentile } from "../../methods/v1/numbers";
import { BENCHMARK_NOTES } from "./benchmark-notes";
import { type LedgerData, type MonthEntry, requestPoints, seriesPoints, type TreeRequestsPoint, type TreeSeries, type TreeSeriesPoint } from "./ledger-data";
import { agrees, type Dims, dimsWords, multiply, parseUnit, type Quantity, quantities, readable, sameDims, sameUnit, type Unit, unitAtom } from "./quantity";

export const NUMBERS = ["time_per_repetition_ns", "bytes_per_second"] as const;
export type NumberName = (typeof NUMBERS)[number];
export const STATS = ["p5", "p50", "p95", "count"] as const;
export type StatName = (typeof STATS)[number];

/** Each number's dimensions in base units, and the unit it is stored in. */
export const NUMBER_UNIT: Readonly<Record<NumberName, { dims: Dims; toBase: number; unit: string }>> = {
	time_per_repetition_ns: { dims: { s: 1 }, toBase: 1e-9, unit: "ns" },
	bytes_per_second: { dims: { B: 1, s: -1 }, toBase: 1, unit: "B/s" },
};

/** A Run's start to the second, as a citation writes it. */
export const momentOf = (startedAt: string): string => `${startedAt.slice(0, 19)}Z`;

/**
 * The start of the Series' newest Run, to the second: the moment its
 * citations are of. Of a Series file (or a row), its newest_run_started_at;
 * of points, the latest start among them.
 */
export function seriesMoment(series: { newest_run_started_at: string } | { points: ReadonlyArray<{ started_at: string }> }): string {
	if ("newest_run_started_at" in series) return momentOf(series.newest_run_started_at);
	let newest = "";
	for (const point of series.points) if (point.started_at > newest) newest = point.started_at;
	return momentOf(newest);
}

/** The statistics of one phase a citation of Method requests may name. */
export const REQUEST_STATS = ["count", "min", "p50", "p90", "p95", "p99", "p99.9", "max"] as const;
export type RequestStat = (typeof REQUEST_STATS)[number];
export const REQUEST_PERCENTILES = ["p50", "p90", "p95", "p99", "p99.9"] as const;
export type RequestPercentile = (typeof REQUEST_PERCENTILES)[number];

/** A citation of Method requests is of the Series' requests, of one group's, or of those with one value of a request fact. */
export type RequestScope = null | { group: string } | { fact: RequestFact; value: string };

const scopePath = (scope: RequestScope): string => (scope === null ? "" : "group" in scope ? `group/${scope.group}/` : `by/${scope.fact}/${scope.value}/`);

export const requestStatCitation = (id: string, phase: Phase, stat: RequestStat, version: number, moment: string, scope: RequestScope = null): string =>
	`[lm:requests/${id}/${scopePath(scope)}${phase}/${stat}@v${version},${moment}]`;
export const requestTailCitation = (id: string, phase: Phase, stat: RequestPercentile, version: number, moment: string, scope: RequestScope = null): string =>
	`[lm:requests/${id}/${scopePath(scope)}${phase}/${stat}/at_or_above@v${version},${moment}]`;
export const requestRunsCitation = (id: string, version: number, moment: string, scope: RequestScope = null): string => `[lm:requests/${id}/${scopePath(scope)}runs@v${version},${moment}]`;
export const requestFailedCitation = (id: string, version: number, moment: string, group: string | null = null, failure: { phase: string; kind: string } | null = null): string =>
	`[lm:requests/${id}/${group === null ? "" : `group/${group}/`}failed${failure === null ? "" : `/${failure.phase}/${failure.kind}`}@v${version},${moment}]`;

export const seriesCitation = (id: string, number: NumberName, stat: StatName, version: number, moment: string, group?: string): string =>
	`[lm:series/${id}/${group === undefined ? "" : `group/${group}/`}${number}/${stat}@v${version},${moment}]`;
export const paramCitation = (id: string, key: string): string => `[lm:series/${id}/params/${key}]`;
export const priceCitation = (path: string, sku: string, rateCode: string): string => `[lm:${path}#${sku}/${rateCode}]`;
export const rangeCitation = (path: string, sku: string, rateCode: string, end: "beginRange" | "endRange"): string => `[lm:${path}#${sku}/${rateCode}/${end}]`;
export const attributeCitation = (path: string, sku: string, name: string): string => `[lm:${path}#${sku}/attributes/${name}]`;
export const benchmarkCitation = (name: string): string => `[lm:benchmark/${name}]`;

const MOMENT = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z`;
const SERIES = new RegExp(String.raw`^series/([0-9a-f]{12})/(?:group/([A-Z]+)/)?(time_per_repetition_ns|bytes_per_second)/(p5|p50|p95|count)@v(\d+),(${MOMENT})$`);
const SERIES_WITHOUT_MOMENT = /^series\/[0-9a-f]{12}\/(?:group\/[A-Z]+\/)?(?:time_per_repetition_ns|bytes_per_second)\/(?:p5|p50|p95|count)$/;
const PARAM = /^series\/([0-9a-f]{12})\/params\/([A-Za-z0-9_]+)$/;
const REQUESTS = new RegExp(
	String.raw`^requests/([0-9a-f]{12})/(?:group/([A-Z]+)/|by/(${REQUEST_FACTS.join("|")})/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/\d{1,2}|[A-Za-z0-9_.:-]+)/)?` +
		String.raw`(?:(${PHASES.join("|")})/(count|min|max|p50|p90|p95|p99|p99\.9)(/at_or_above)?|(runs)|(failed)(?:/([a-z][a-z0-9_]*)/([a-z][a-z0-9_]*))?)@v(\d+),(${MOMENT})$`,
);
const REQUESTS_WITHOUT_MOMENT = /^requests\/[0-9a-f]{12}\/[^@]*$/;
const PRICE = /^(prices\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/aws\.json)#([A-Z0-9]+)\/([A-Z0-9]+\.[A-Z0-9]+\.[A-Z0-9]+)(?:\/(beginRange|endRange))?$/;
const ATTRIBUTE = /^(prices\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/aws\.json)#([A-Z0-9]+)\/attributes\/([A-Za-z0-9_]+)$/;
const BENCHMARK = /^benchmark\/([a-z0-9_]+)$/;

/** A Run's path, wherever it is written. */
export const RUN_PATH = /runs\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/[0-9A-Za-z-]+\.json/g;

export type Resolved =
	| {
			ok: true;
			kind: "measured";
			series: TreeSeries;
			number: NumberName;
			stat: StatName;
			group: string | null;
			/** As stored: ns, B/s, or a count. */
			value: number;
			moment: string;
			/** "current" when the data loaded end at the cited moment; "earlier" when recomputed from the Runs that started by it. */
			asOf: "current" | "earlier";
			/** The counted Runs the value is taken over. */
			runs: number;
	  }
	| {
			ok: true;
			kind: "requests";
			series: TreeSeries;
			group: string | null;
			by: { fact: RequestFact; value: string } | null;
			/** The phase, or null for runs and failed. */
			phase: Phase | null;
			/** count | min | p50 … max, p99/at_or_above and the like, runs, failed, failed/<phase>/<kind>. */
			stat: string;
			/** "ns" for a time; "count" for requests or Runs. */
			unit: "ns" | "count";
			/** A count of Runs: only it accounts for a number of Runs. */
			countsRuns: boolean;
			value: number;
			moment: string;
			asOf: "current" | "earlier";
			/** The counted Runs the figure is pooled from. */
			runs: number;
	  }
	| { ok: true; kind: "param"; series: TreeSeries; key: string; value: ParamValue }
	| { ok: true; kind: "price"; path: string; date: string; sku: string; rateCode: string; usd: number; awsUnit: string; unit: Unit | null; description: string }
	| { ok: true; kind: "range"; path: string; date: string; sku: string; rateCode: string; end: "beginRange" | "endRange"; text: string; awsUnit: string; unit: Unit | null; description: string }
	| { ok: true; kind: "attribute"; path: string; date: string; sku: string; name: string; text: string }
	| { ok: true; kind: "benchmark"; name: string }
	| { ok: false; reason: string };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The counted Runs' values of a number, for one Series or group, among the Runs that started by a moment. */
function valuesBy(points: readonly TreeSeriesPoint[], number: NumberName, group: string | null, moment: string): number[] {
	const value = (point: TreeSeriesPoint): number | null => point[number];
	return points
		.filter((point) => momentOf(point.started_at) <= moment && (group === null || point.group === group) && point.counted && value(point) !== null)
		.map((point) => value(point) as number);
}

/**
 * A Series' statistic as it stood at a moment, from its points (Method series
 * v1's, as the month files hold them). Each Run's number depends on that Run
 * alone, so the population then is the points that started by then, and the
 * percentile is Method series v1's own.
 */
export function statAt(
	points: readonly TreeSeriesPoint[] | readonly Pick<TreeSeriesPoint, "started_at" | "group" | "counted" | NumberName>[],
	number: NumberName,
	stat: StatName,
	group: string | null,
	moment: string,
): { value: number; runs: number } | null {
	const values = valuesBy(points as readonly TreeSeriesPoint[], number, group, moment);
	if (values.length === 0) return null;
	const value = stat === "count" ? values.length : percentile(values, stat === "p5" ? 5 : stat === "p50" ? 50 : 95);
	return { value, runs: values.length };
}

/** The month files that hold every Run started by a moment (yyyy-mm-ddThh:mm:ssZ). */
const monthsBy = (moment: string) => (series: TreeSeries): MonthEntry[] => series.months.filter((entry) => entry.month <= moment.slice(0, 7));

async function resolveSeries(match: RegExpExecArray, data: LedgerData): Promise<Resolved> {
	const [, id, group, number, stat, version, moment] = match as unknown as [string, string, string | undefined, NumberName, StatName, string, string];
	const series = await data.series(id);
	if (series === null) return { ok: false, reason: `no Series ${id} in ${data.location.link("v1/series.json")}` };
	const v1 = series.derivations.series_v1;
	if (v1 === undefined) return { ok: false, reason: `Series ${id} has no figures of Method series version 1` };
	if (Number(version) !== v1.method.version) return { ok: false, reason: `it cites Method series version ${version}; the data loaded are version ${v1.method.version}` };
	if (group !== undefined && !v1.groups.some((g) => g.id === group)) return { ok: false, reason: `Series ${id} has no group ${group}` };
	const loaded = seriesMoment(series);
	if (moment > loaded) {
		return { ok: false, reason: `it cites Series ${id} as of ${moment}, but the data loaded hold its Runs only to ${loaded}: it is of data the checker does not have` };
	}
	const none: Resolved = { ok: false, reason: `Series ${id}${group === undefined ? "" : ` group ${group}`} has no ${number} from a counted Run that started by ${moment}` };
	if (moment === loaded) {
		// As of the Series' newest Run: its Series file's own figures.
		const percentiles = group === undefined ? v1.percentiles : (v1.groups.find((g) => g.id === group)?.percentiles ?? null);
		const stored = percentiles?.[number] ?? null;
		if (stored === null) return none;
		const value = stat === "count" ? stored.count : stored[stat];
		if (value === null) return { ok: false, reason: `Series ${id}${group === undefined ? "" : ` group ${group}`}'s ${stat} of ${number} is infinite (the Method writes it as null): no number states it` };
		return { ok: true, kind: "measured", series, number, stat, group: group ?? null, value, moment, asOf: "current", runs: stored.count };
	}
	// As of an earlier moment: recomputed from the points of the Runs that started by then.
	const read = await data.seriesWithMonths(id, monthsBy(moment));
	if (read === null) return { ok: false, reason: `no Series ${id} in ${data.location.link("v1/series.json")}` };
	const at = statAt(seriesPoints(read.months), number, stat, group ?? null, moment);
	if (at === null) return none;
	return { ok: true, kind: "measured", series: read.series, number, stat, group: group ?? null, value: at.value, moment, asOf: moment === loaded ? "current" : "earlier", runs: at.runs };
}

const PCT_WORDS: Record<RequestPercentile, { words: string; perMille: number }> = {
	p50: { words: "50th", perMille: 500 },
	p90: { words: "90th", perMille: 900 },
	p95: { words: "95th", perMille: 950 },
	p99: { words: "99th", perMille: 990 },
	"p99.9": { words: "99.9th", perMille: 999 },
};

/** The fewest requests that support a percentile (Method requests v1's rule, n × (1000 − q) ≥ 1000). */
export const leastRequests = (stat: RequestPercentile): number => Math.ceil(1000 / (1000 - PCT_WORDS[stat].perMille));

/** Why a phase's figure is not held, in words. */
export function requestStatMissing(stats: Stats | undefined, phase: Phase, stat: string): string | null {
	if (stats === undefined) return `there is no ${phase} phase among these requests${["dns", "connect", "tls"].includes(phase) ? " (over a reused connection a request has no name lookup, connect or TLS phase)" : " (no succeeded request)"}`;
	if ((REQUEST_PERCENTILES as readonly string[]).includes(stat) && stats[stat as RequestPercentile] === null) {
		const pct = stat as RequestPercentile;
		return `its ${PCT_WORDS[pct].words} percentile is not reported: ${stats.count} requests, and it needs at least ${leastRequests(pct)}`;
	}
	return null;
}

/**
 * The Derivation's group_through of each point, from the tree's
 * group_through_as_of_run, by the tree's own rule (ADR-0030, rule 9): in a
 * Series of more than one group, a point before the first point whose group
 * differs from the first point's takes its through; every other point takes
 * group_through_as_of_run as it is. `points` are every point from the
 * Series' first, in order, at least to the last one asked about.
 */
function groupThrough(points: readonly TreeRequestsPoint[], groups: number, i: number): PoolSummary | null {
	const point = points[i] as TreeRequestsPoint;
	if (groups < 2) return point.group_through_as_of_run;
	const first = points.findIndex((p) => p.group !== points[0]?.group);
	return first < 0 || i < first ? point.through : point.group_through_as_of_run;
}

async function resolveRequests(match: RegExpExecArray, data: LedgerData): Promise<Resolved> {
	const [, id, group, fact, factValue, phase, stat, tail, runsWord, failedWord, failedPhase, failedKind, version, moment] = match as unknown as Array<string | undefined>;
	const file = await data.series(id as string);
	if (file === null) return { ok: false, reason: `no Series ${id} in ${data.location.link("v1/series.json")}` };
	const requests = file.derivations.requests_v1;
	if (requests === undefined) return { ok: false, reason: `Series ${id} has no figures of Method requests: the data loaded hold none of it (it is not a Series of requests)` };
	if (Number(version) !== requests.method.version) {
		return { ok: false, reason: `it cites Method requests version ${version}; the data loaded are version ${requests.method.version}` };
	}
	const series = file;
	if (group !== undefined && !requests.groups.some((g) => g.id === group)) return { ok: false, reason: `Series ${id} has no group ${group}` };
	if (fact !== undefined && failedWord !== undefined) return { ok: false, reason: "failed requests are counted per Series and per group, not by what a request recorded of its connection" };
	if (tail !== undefined && !(REQUEST_PERCENTILES as readonly string[]).includes(stat as string)) return { ok: false, reason: "at_or_above follows a percentile: p50, p90, p95, p99 or p99.9" };
	const loaded = seriesMoment(series);
	const at = moment as string;
	if (at > loaded) return { ok: false, reason: `it cites Series ${id} as of ${at}, but the data loaded hold its Runs only to ${loaded}: it is of data the checker does not have` };
	const asOf = at === loaded ? "current" : "earlier";

	// The figures as they stood at the moment.
	let summary: { runs: number; requests: number; failed: number; phases: Partial<Record<Phase, Stats>>; failures: PoolSummary["failures"] } | null;
	let by: { fact: RequestFact; value: string } | null = null;
	if (fact !== undefined) {
		by = { fact: fact as RequestFact, value: factValue as string };
		if (asOf === "earlier") {
			return { ok: false, reason: `the breakdown by ${fact} is held only as of Series ${id}'s newest Run (${loaded}); this citation is of ${at}: check it against the Derivations of that moment` };
		}
		const pool = group === undefined ? requests.pool : (requests.groups.find((g) => g.id === group) as (typeof requests.groups)[number]).pool;
		const value = pool.by.find((b) => b.fact === fact)?.values.find((v) => v.value === factValue);
		if (value === undefined) {
			const values = pool.by.find((b) => b.fact === fact)?.values.map((v) => v.value) ?? [];
			return { ok: false, reason: values.length === 0 ? `the requests of Series ${id}${group === undefined ? "" : ` group ${group}`} had one ${fact} only: there is no breakdown by it` : `no ${fact} ${factValue} among the requests of Series ${id}${group === undefined ? "" : ` group ${group}`} (${values.join(", ")})` };
		}
		summary = { runs: value.runs, requests: value.requests, failed: 0, phases: value.phases, failures: [] };
	} else if (asOf === "current") {
		const pool = group === undefined ? requests.pool : (requests.groups.find((g) => g.id === group) as (typeof requests.groups)[number]).pool;
		summary = pool.runs === 0 ? null : pool;
	} else {
		// The figures each point holds as they stood through its Run, from the month files up to the moment.
		const read = await data.seriesWithMonths(id as string, monthsBy(at));
		if (read === null) return { ok: false, reason: `no Series ${id} in ${data.location.link("v1/series.json")}` };
		const points = requestPoints(read.months);
		const groups = read.series.derivations.requests_v1?.groups.length ?? 0;
		let last = -1;
		points.forEach((point, i) => {
			if (momentOf(point.started_at) <= at && (group === undefined || point.group === group)) last = i;
		});
		summary = last < 0 ? null : group === undefined || groups < 2 ? (points[last] as TreeRequestsPoint).through : groupThrough(points, groups, last);
	}
	if (summary === null) return { ok: false, reason: `Series ${id}${group === undefined ? "" : ` group ${group}`} has no counted Run that started by ${at}` };
	const base = { ok: true as const, kind: "requests" as const, series, group: group ?? null, by, moment: at, asOf: asOf as "current" | "earlier", runs: summary.runs };
	if (runsWord !== undefined) return { ...base, phase: null, stat: "runs", unit: "count", countsRuns: true, value: summary.runs };
	if (failedWord !== undefined) {
		if (failedPhase === undefined) return { ...base, phase: null, stat: "failed", unit: "count", countsRuns: false, value: summary.failed };
		const count = summary.failures.find((f) => f.phase === failedPhase && f.kind === failedKind)?.count ?? 0;
		return { ...base, phase: null, stat: `failed/${failedPhase}/${failedKind}`, unit: "count", countsRuns: false, value: count };
	}
	const stats = summary.phases[phase as Phase];
	const missing = requestStatMissing(stats, phase as Phase, stat as string);
	if (missing !== null) return { ok: false, reason: `Series ${id}${group === undefined ? "" : ` group ${group}`}${by === null ? "" : ` ${by.fact} ${by.value}`}: ${missing}` };
	const held = stats as Stats;
	if (tail !== undefined) {
		return { ...base, phase: phase as Phase, stat: `${stat}/at_or_above`, unit: "count", countsRuns: false, value: held.at_or_above[stat as RequestPercentile] as number };
	}
	if (stat === "count") return { ...base, phase: phase as Phase, stat: "count", unit: "count", countsRuns: false, value: held.count };
	return { ...base, phase: phase as Phase, stat: stat as string, unit: "ns", countsRuns: false, value: held[stat as "min" | "max" | RequestPercentile] as number };
}

async function resolvePrice(path: string, sku: string, rest: { rateCode?: string; attribute?: string; end?: "beginRange" | "endRange" }, data: LedgerData): Promise<Resolved> {
	const prices = await data.readPrices(path);
	if (prices === null) return { ok: false, reason: `no price file ${path} at ${data.location.base}` };
	const source = prices.file.sources.find((s) => isObject(s.products) && sku in s.products);
	if (source === undefined) return { ok: false, reason: `${path} holds no SKU ${sku}` };
	const product = source.products[sku];
	if (rest.attribute !== undefined) {
		const attributes = isObject(product) && isObject(product.attributes) ? product.attributes : {};
		const text = attributes[rest.attribute];
		if (typeof text !== "string") return { ok: false, reason: `${path} SKU ${sku} has no attribute ${rest.attribute}` };
		return { ok: true, kind: "attribute", path, date: prices.date, sku, name: rest.attribute, text };
	}
	const rateCode = rest.rateCode as string;
	const terms = source.terms.OnDemand[sku];
	for (const term of isObject(terms) ? Object.values(terms) : []) {
		const dimension = isObject(term) && isObject(term.priceDimensions) ? term.priceDimensions[rateCode] : undefined;
		if (!isObject(dimension)) continue;
		const usd = isObject(dimension.pricePerUnit) ? dimension.pricePerUnit.USD : undefined;
		const awsUnit = String(dimension.unit);
		if (rest.end !== undefined) {
			return { ok: true, kind: "range", path, date: prices.date, sku, rateCode, end: rest.end, text: String(dimension[rest.end]), awsUnit, unit: parseUnit(awsUnit), description: String(dimension.description) };
		}
		return { ok: true, kind: "price", path, date: prices.date, sku, rateCode, usd: Number(usd), awsUnit, unit: parseUnit(awsUnit), description: String(dimension.description) };
	}
	return { ok: false, reason: `${path} SKU ${sku} has no rate code ${rateCode}` };
}

/** What a citation (the text inside [lm:...]) resolves to in the data, or why it does not. */
export async function resolveCitation(inside: string, data: LedgerData): Promise<Resolved> {
	let m = SERIES.exec(inside);
	if (m !== null) return resolveSeries(m, data);
	if (SERIES_WITHOUT_MOMENT.test(inside)) {
		return { ok: false, reason: "a Series citation must say which data it was read from, @v<version>,<moment> at its end, as the tool prints it" };
	}
	m = REQUESTS.exec(inside);
	if (m !== null) return resolveRequests(m, data);
	if (REQUESTS_WITHOUT_MOMENT.test(inside)) {
		return {
			ok: false,
			reason:
				"a citation of Method requests is requests/<id>[/group/<G>|/by/<fact>/<value>]/<phase>/<count|min|p50|p90|p95|p99|p99.9|max>[/at_or_above], /runs or /failed[/<phase>/<kind>], with @v<version>,<moment> at its end, as the tool prints it",
		};
	}
	m = PARAM.exec(inside);
	if (m !== null) {
		const [, id, key] = m as unknown as [string, string, string];
		const series = await data.series(id);
		if (series === null) return { ok: false, reason: `no Series ${id} in ${data.location.link("v1/series.json")}` };
		if (!(key in series.params)) return { ok: false, reason: `Series ${id} has no parameter ${key}` };
		return { ok: true, kind: "param", series, key, value: series.params[key] as ParamValue };
	}
	m = PRICE.exec(inside);
	if (m !== null) return resolvePrice(m[1] as string, m[2] as string, { rateCode: m[3] as string, end: m[4] as "beginRange" | "endRange" | undefined }, data);
	m = ATTRIBUTE.exec(inside);
	if (m !== null) return resolvePrice(m[1] as string, m[2] as string, { attribute: m[3] as string }, data);
	m = BENCHMARK.exec(inside);
	if (m !== null) {
		const name = m[1] as string;
		return name in BENCHMARK_NOTES ? { ok: true, kind: "benchmark", name } : { ok: false, reason: `no benchmark ${name}` };
	}
	return {
		ok: false,
		reason:
			"not a LedgerMath citation: expected series/…@v<version>,<moment>, requests/…@v<version>,<moment>, series/…/params/<key>, prices/…#<sku>/<rate code>[/beginRange|/endRange], prices/…#<sku>/attributes/<name> or benchmark/<name>",
	};
}

/**
 * The unit a parameter's key names at its end: gap_mean_ms in milliseconds,
 * budget_seconds in seconds, object_bytes in bytes (and bytes_per_sample, which
 * names bytes first); none for a key that names none.
 */
export function parameterUnit(key: string): { dims: Dims; factor: number; name: string } | null {
	const parts = key.split("_");
	const last = parts[parts.length - 1] as string;
	const atom = parts.length > 1 ? unitAtom(last) : null;
	if (atom !== null && (atom.dims.s !== undefined || atom.dims.B !== undefined) && Object.keys(atom.dims).length === 1) return { ...atom, name: last };
	if (parts.includes("bytes")) return { dims: { B: 1 }, factor: 1, name: "bytes" };
	return null;
}

/** A value in base units as a person would read it beside q: in q's own unit when the dimensions agree. */
function expectedBeside(q: Quantity, base: number, dims: Dims, inItsUnit: string): string {
	if (sameDims(q.unit.dims, dims) && q.unit.text !== "") return `${readable(base / q.unit.factor)} ${q.unit.text.replace(/^\$/, "$ ").trim()} (${inItsUnit})`;
	return inItsUnit;
}

/** What a number was found to be, in words: its value, and what its unit measures when that is not what was expected. */
function found(q: Quantity, dims: Dims): string {
	const text = q.text.trim();
	if (sameDims(q.unit.dims, dims)) return `found ${text}`;
	if (q.unit.text === "") return `found ${text} with no unit`;
	return `found ${text}, which is ${dimsWords(q.unit.dims)}, not ${dimsWords(dims)}`;
}

/**
 * Why a number does not match what its citation resolved to, as "expected …;
 * found …", or null when it does.
 */
export function citationMismatch(resolved: Resolved, q: Quantity): string | null {
	if (!resolved.ok) return resolved.reason;
	switch (resolved.kind) {
		case "measured": {
			if (resolved.stat === "count") return agrees(q, resolved.value, {}) ? null : `expected ${resolved.value}, the number of counted Runs cited; ${found(q, {})}`;
			const { dims, toBase, unit } = NUMBER_UNIT[resolved.number];
			if (agrees(q, resolved.value * toBase, dims)) return null;
			return `expected ${expectedBeside(q, resolved.value * toBase, dims, `the cited value is ${readable(resolved.value)} ${unit}`)}; ${found(q, dims)}`;
		}
		case "requests": {
			if (resolved.unit === "count") {
				// A count of requests may be written bare or with its noun ("2 requests"); a count of Runs is read bare.
				if (agrees(q, resolved.value, {}) || agrees(q, resolved.value, { req: 1 })) return null;
				return `expected ${resolved.value}, the count cited; ${found(q, {})}`;
			}
			if (agrees(q, resolved.value * 1e-9, { s: 1 })) return null;
			return `expected ${expectedBeside(q, resolved.value * 1e-9, { s: 1 }, `the cited value is ${readable(resolved.value)} ns`)}; ${found(q, { s: 1 })}`;
		}
		case "param": {
			if (typeof resolved.value !== "number") return `the parameter ${resolved.key} is ${JSON.stringify(resolved.value)}, not a number`;
			// The value as the tool prints it (gap_mean_ms 200), or written in the unit its key names (200 ms, 0.2 s).
			const unit = parameterUnit(resolved.key);
			const dims: Dims = unit?.dims ?? {};
			const base = resolved.value * (unit?.factor ?? 1);
			if (agrees(q, base, dims) || (q.unit.text === "" && agrees(q, resolved.value, {}))) return null;
			return `expected ${resolved.value}${unit === null ? "" : ` ${unit.name}`}, the parameter ${resolved.key}${unit === null ? "" : `, or the same in another unit of ${dimsWords(dims)}`}; ${found(q, dims)}`;
		}
		case "price": {
			if (resolved.unit === null) return `AWS's unit "${resolved.awsUnit}" is one the checker does not read`;
			const own: Unit = { dims: multiply({ USD: 1 }, resolved.unit.dims, -1), factor: 1 / resolved.unit.factor, text: "" };
			if (!sameUnit(q.unit, own)) {
				return `expected the price in AWS's own unit, ${resolved.usd} USD per ${resolved.awsUnit}; found ${q.text.trim()}. A price in another unit (per 1000000 requests, per month) is a line of arithmetic from the cited one`;
			}
			return agrees(q, resolved.usd * own.factor, own.dims) ? null : `expected ${resolved.usd} USD per ${resolved.awsUnit}, the cited price; found ${q.text.trim()}`;
		}
		case "range": {
			if (resolved.unit === null) return `AWS's unit "${resolved.awsUnit}" is one the checker does not read`;
			const value = Number(resolved.text);
			if (resolved.text === "" || !Number.isFinite(value)) return `the tier's ${resolved.end} is AWS's word "${resolved.text}", which states no number; found ${q.text.trim()}. Cite "${resolved.text}" with no number before it`;
			if (agrees(q, value * resolved.unit.factor, resolved.unit.dims)) return null;
			return `expected ${resolved.text} ${resolved.awsUnit}, the tier's ${resolved.end}; ${found(q, resolved.unit.dims)}`;
		}
		case "attribute": {
			const value = quantities(resolved.text)[0];
			if (value === undefined) return `AWS's words "${resolved.text}" hold no number; found ${q.text.trim()}. Quote the words with their citation, and state any reading of them as an assumption`;
			return agrees(q, value.value, value.unit.dims) ? null : `expected "${resolved.text}", AWS's words; ${found(q, value.unit.dims)}`;
		}
		case "benchmark":
			return "a benchmark's description cites no number";
	}
}
