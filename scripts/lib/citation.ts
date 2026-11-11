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
 *   [lm:series/<id>/params/<key>]                 a parameter of the Series (they never change)
 *   [lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/<rate code>]          a price, in AWS's unit
 *   [lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/<rate code>/beginRange]   where its tier begins, in AWS's unit
 *   [lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/<rate code>/endRange]     where it ends ("Inf" cites nothing)
 *   [lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/attributes/<name>]    AWS's catalog words for a product
 *   [lm:benchmark/<name>]                         what a benchmark measures: words, which cite no number
 *   runs/<yyyy>/<mm>/<dd>/<run id>.json           a Run: the bare path, or its address in the Runs repository
 *   [assumption: <where it comes from>]           a number LedgerMath does not hold
 *
 * A citation belongs to the nearest number before it on its line.
 *
 * The moment is the Series' own newest Run, not the file's: boots of one
 * instance type never overlap and upload all their Runs at once, so no Run of
 * the Series that started by then can arrive later, while Runs of another
 * type's boot still running when the Derivations were made can.
 */

import type { ParamValue } from "../../methods/run";
import { percentile } from "../../methods/v1/numbers";
import type { Point, SeriesDerivation } from "../../methods/v1/output";
import { BENCHMARK_NOTES } from "./benchmark-notes";
import type { LedgerData } from "./ledger-data";
import { agrees, type Dims, multiply, parseUnit, type Quantity, quantities, sameUnit, type Unit } from "./quantity";

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

/** The start of the Series' newest Run, to the second: the moment its citations are of. */
export function seriesMoment(series: SeriesDerivation): string {
	let newest = "";
	for (const point of series.points) if (point.started_at > newest) newest = point.started_at;
	return momentOf(newest);
}

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
const PRICE = /^(prices\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/aws\.json)#([A-Z0-9]+)\/([A-Z0-9]+\.[A-Z0-9]+\.[A-Z0-9]+)(?:\/(beginRange|endRange))?$/;
const ATTRIBUTE = /^(prices\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/aws\.json)#([A-Z0-9]+)\/attributes\/([A-Za-z0-9_]+)$/;
const BENCHMARK = /^benchmark\/([a-z0-9_]+)$/;

/** A Run's path, wherever it is written. */
export const RUN_PATH = /runs\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/[0-9A-Za-z-]+\.json/g;

export type Resolved =
	| {
			ok: true;
			kind: "measured";
			series: SeriesDerivation;
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
	| { ok: true; kind: "param"; series: SeriesDerivation; key: string; value: ParamValue }
	| { ok: true; kind: "price"; path: string; date: string; sku: string; rateCode: string; usd: number; awsUnit: string; unit: Unit | null; description: string }
	| { ok: true; kind: "range"; path: string; date: string; sku: string; rateCode: string; end: "beginRange" | "endRange"; text: string; awsUnit: string; unit: Unit | null }
	| { ok: true; kind: "attribute"; path: string; date: string; sku: string; name: string; text: string }
	| { ok: true; kind: "benchmark"; name: string }
	| { ok: false; reason: string };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The counted Runs' values of a number, for one Series or group, among the Runs that started by a moment. */
function valuesBy(series: SeriesDerivation, number: NumberName, group: string | null, moment: string): number[] {
	const value = (point: Point): number | null => point[number];
	return series.points
		.filter((point) => momentOf(point.started_at) <= moment && (group === null || point.group === group) && point.counted && value(point) !== null)
		.map((point) => value(point) as number);
}

/**
 * A Series' statistic as it stood at a moment. Each Run's number depends on
 * that Run alone, so the population then is the Derivation's points that
 * started by then, and the percentile is Method series v1's own.
 */
export function statAt(series: SeriesDerivation, number: NumberName, stat: StatName, group: string | null, moment: string): { value: number; runs: number } | null {
	const values = valuesBy(series, number, group, moment);
	if (values.length === 0) return null;
	const value = stat === "count" ? values.length : percentile(values, stat === "p5" ? 5 : stat === "p50" ? 50 : 95);
	return { value, runs: values.length };
}

function resolveSeries(match: RegExpExecArray, data: LedgerData): Resolved {
	const [, id, group, number, stat, version, moment] = match as unknown as [string, string, string | undefined, NumberName, StatName, string, string];
	const series = data.derivations.derivations.find((d) => d.series.id === id);
	if (series === undefined) return { ok: false, reason: `no Series ${id} in ${data.derivationsFrom}` };
	if (Number(version) !== data.derivations.method.version) {
		return { ok: false, reason: `it cites Method series version ${version}; the data loaded are version ${data.derivations.method.version}` };
	}
	if (group !== undefined && !series.groups.some((g) => g.id === group)) return { ok: false, reason: `Series ${id} has no group ${group}` };
	const loaded = seriesMoment(series);
	if (moment > loaded) {
		return { ok: false, reason: `it cites Series ${id} as of ${moment}, but the data loaded hold its Runs only to ${loaded}: it is of data the checker does not have` };
	}
	const at = statAt(series, number, stat, group ?? null, moment);
	if (at === null) return { ok: false, reason: `Series ${id}${group === undefined ? "" : ` group ${group}`} has no ${number} from a counted Run that started by ${moment}` };
	if (moment === loaded) {
		const percentiles = group === undefined ? series.percentiles : (series.groups.find((g) => g.id === group)?.percentiles ?? null);
		const stored = percentiles?.[number] ?? null;
		if (stored !== null) {
			const value = stat === "count" ? stored.count : stored[stat];
			return { ok: true, kind: "measured", series, number, stat, group: group ?? null, value, moment, asOf: "current", runs: stored.count };
		}
	}
	return { ok: true, kind: "measured", series, number, stat, group: group ?? null, value: at.value, moment, asOf: moment === loaded ? "current" : "earlier", runs: at.runs };
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
			return { ok: true, kind: "range", path, date: prices.date, sku, rateCode, end: rest.end, text: String(dimension[rest.end]), awsUnit, unit: parseUnit(awsUnit) };
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
	m = PARAM.exec(inside);
	if (m !== null) {
		const [, id, key] = m as unknown as [string, string, string];
		const series = data.derivations.derivations.find((d) => d.series.id === id);
		if (series === undefined) return { ok: false, reason: `no Series ${id} in ${data.derivationsFrom}` };
		if (!(key in series.series.params)) return { ok: false, reason: `Series ${id} has no parameter ${key}` };
		return { ok: true, kind: "param", series, key, value: series.series.params[key] as ParamValue };
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
	return { ok: false, reason: "not a LedgerMath citation: expected series/…@v<version>,<moment>, series/…/params/<key>, prices/…#<sku>/<rate code>[/beginRange|/endRange], prices/…#<sku>/attributes/<name> or benchmark/<name>" };
}

/** Why a number does not match what its citation resolved to, or null when it does. */
export function citationMismatch(resolved: Resolved, q: Quantity): string | null {
	if (!resolved.ok) return resolved.reason;
	switch (resolved.kind) {
		case "measured": {
			if (resolved.stat === "count") return agrees(q, resolved.value, {}) ? null : `the citation is a count of ${resolved.value} Runs`;
			const { dims, toBase } = NUMBER_UNIT[resolved.number];
			if (q.unit.text === "") return `it has no unit; the citation is in ${NUMBER_UNIT[resolved.number].unit}`;
			return agrees(q, resolved.value * toBase, dims) ? null : `the citation is ${resolved.value} ${NUMBER_UNIT[resolved.number].unit}`;
		}
		case "param": {
			if (typeof resolved.value !== "number") return `the parameter ${resolved.key} is ${JSON.stringify(resolved.value)}, not a number`;
			const dims: Dims = resolved.key.endsWith("_bytes") ? { B: 1 } : {};
			return agrees(q, resolved.value, dims) ? null : `the parameter ${resolved.key} is ${resolved.value}${resolved.key.endsWith("_bytes") ? " bytes" : ""}`;
		}
		case "price": {
			if (resolved.unit === null) return `AWS's unit "${resolved.awsUnit}" is one the checker does not read`;
			const own: Unit = { dims: multiply({ USD: 1 }, resolved.unit.dims, -1), factor: 1 / resolved.unit.factor, text: "" };
			if (!sameUnit(q.unit, own)) return `a price is cited in AWS's own unit, USD per ${resolved.awsUnit}; rescaling it is a line of arithmetic`;
			return agrees(q, resolved.usd * own.factor, own.dims) ? null : `the price is ${resolved.usd} USD per ${resolved.awsUnit}`;
		}
		case "range": {
			if (resolved.unit === null) return `AWS's unit "${resolved.awsUnit}" is one the checker does not read`;
			const value = Number(resolved.text);
			if (resolved.text === "" || !Number.isFinite(value)) return `the tier's ${resolved.end} is "${resolved.text}", not a number`;
			return agrees(q, value * resolved.unit.factor, resolved.unit.dims) ? null : `the tier's ${resolved.end} is ${resolved.text} ${resolved.awsUnit}`;
		}
		case "attribute": {
			const value = quantities(resolved.text)[0];
			if (value === undefined) return `AWS's words "${resolved.text}" hold no number`;
			return agrees(q, value.value, value.unit.dims) ? null : `AWS's words are "${resolved.text}"`;
		}
		case "benchmark":
			return "a benchmark's description cites no number";
	}
}
