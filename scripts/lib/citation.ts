/**
 * The citation syntax the skill prescribes (skills/ledgermath/SKILL.md), which
 * the lookup tool prints beside every number and the answer checker resolves:
 *
 *   [lm:series/<id>/<number>/<stat>]              a Series' percentile across its Runs
 *   [lm:series/<id>/group/<G>/<number>/<stat>]    one group's, when the Series is split
 *       <number>  time_per_repetition_ns | bytes_per_second
 *       <stat>    p5 | p50 | p95 | count
 *   [lm:series/<id>/params/<key>]                 a parameter of the Series
 *   [lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/<rate code>]          a price
 *   [lm:prices/<yyyy>/<mm>/<dd>/aws.json#<sku>/attributes/<name>]    AWS's catalog words for a product
 *   [lm:benchmark/<name>]                         what the benchmark measures and what one repetition is
 *   runs/<yyyy>/<mm>/<dd>/<run id>.json           a Run, as a path or the end of an address
 *   [assumption: <where it comes from>]           a number LedgerMath does not hold
 *
 * A citation follows the number it cites, on the same line. A Series is the
 * Runs the Derivation names: an answer that cites a Series also links at
 * least one of those Runs.
 */

import type { ParamValue } from "../../methods/run";
import type { Group, SeriesDerivation, Stat } from "../../methods/v1/output";
import { BENCHMARK_NOTES, variantNotes } from "./benchmark-notes";
import type { LedgerData } from "./ledger-data";
import { type Dimension, firstQuantity, type Quantity, quantities, samePriceUpToScale, sameQuantity } from "./quantity";

export const NUMBERS = ["time_per_repetition_ns", "bytes_per_second"] as const;
export type NumberName = (typeof NUMBERS)[number];
export const STATS = ["p5", "p50", "p95", "count"] as const;
export type StatName = (typeof STATS)[number];

export const NUMBER_UNIT: Readonly<Record<NumberName, { dimension: Dimension; unit: string }>> = {
	time_per_repetition_ns: { dimension: "seconds", unit: "ns" },
	bytes_per_second: { dimension: "bytes", unit: "B/s" },
};

export const seriesCitation = (id: string, number: NumberName, stat: StatName, group?: string): string =>
	group === undefined ? `[lm:series/${id}/${number}/${stat}]` : `[lm:series/${id}/group/${group}/${number}/${stat}]`;
export const paramCitation = (id: string, key: string): string => `[lm:series/${id}/params/${key}]`;
export const priceCitation = (path: string, sku: string, rateCode: string): string => `[lm:${path}#${sku}/${rateCode}]`;
export const attributeCitation = (path: string, sku: string, name: string): string => `[lm:${path}#${sku}/attributes/${name}]`;
export const benchmarkCitation = (name: string): string => `[lm:benchmark/${name}]`;

/** Finds [lm:...] citations; group 1 is what is inside. */
export const CITATION = /\[lm:([^\]\s]*)\]/g;
/** Finds [assumption: ...] markers; group 1 is the source given. */
export const ASSUMPTION = /\[assumption(?::([^\]]*))?\]/gi;
/** Finds Run links; group 1 is the Run's path. */
export const RUN_LINK = /(runs\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/[0-9A-Za-z-]+\.json)/g;

export type Resolved =
	| { ok: true; kind: "measured"; series: SeriesDerivation; number: NumberName; stat: StatName; group: string | null; value: number }
	| { ok: true; kind: "param"; series: SeriesDerivation; key: string; value: ParamValue }
	| { ok: true; kind: "price"; path: string; date: string; sku: string; rateCode: string; usd: number; unit: string; description: string }
	| { ok: true; kind: "attribute"; path: string; date: string; sku: string; name: string; text: string }
	| { ok: true; kind: "benchmark"; name: string; text: string }
	| { ok: false; reason: string };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function statValue(stat: Stat | null, name: StatName): number | null {
	if (stat === null) return null;
	return name === "count" ? stat.count : stat[name];
}

function resolveSeries(parts: string[], data: LedgerData): Resolved {
	const [id, ...rest] = parts;
	const series = data.derivations.derivations.find((d) => d.series.id === id);
	if (series === undefined) return { ok: false, reason: `no Series ${id} in ${data.derivationsFrom}` };
	if (rest[0] === "params" && rest.length === 2) {
		const key = rest[1] as string;
		if (!(key in series.series.params)) return { ok: false, reason: `Series ${id} has no parameter ${key}` };
		return { ok: true, kind: "param", series, key, value: series.series.params[key] as ParamValue };
	}
	let group: Group | null = null;
	let tail = rest;
	if (rest[0] === "group") {
		group = series.groups.find((g) => g.id === rest[1]) ?? null;
		if (group === null) return { ok: false, reason: `Series ${id} has no group ${rest[1]}` };
		tail = rest.slice(2);
	}
	const [number, stat] = tail;
	if (tail.length !== 2 || !(NUMBERS as readonly string[]).includes(number as string) || !(STATS as readonly string[]).includes(stat as string)) {
		return { ok: false, reason: `not a Series citation: expected <number>/<stat> with <number> one of ${NUMBERS.join(", ")} and <stat> one of ${STATS.join(", ")}` };
	}
	const percentiles = group === null ? series.percentiles : group.percentiles;
	const value = statValue(percentiles[number as NumberName], stat as StatName);
	if (value === null) return { ok: false, reason: `Series ${id}${group === null ? "" : ` group ${group.id}`} has no ${number}` };
	return { ok: true, kind: "measured", series, number: number as NumberName, stat: stat as StatName, group: group?.id ?? null, value };
}

async function resolvePrice(path: string, fragment: string, data: LedgerData): Promise<Resolved> {
	const prices = await data.readPrices(path);
	if (prices === null) return { ok: false, reason: `no price file ${path} at ${data.location.base}` };
	const [sku, ...rest] = fragment.split("/");
	const source = prices.file.sources.find((s) => isObject(s.products) && sku !== undefined && sku in s.products);
	if (source === undefined || sku === undefined) return { ok: false, reason: `${path} holds no SKU ${sku}` };
	const product = source.products[sku];
	if (rest[0] === "attributes" && rest.length === 2) {
		const attributes = isObject(product) && isObject(product.attributes) ? product.attributes : {};
		const text = attributes[rest[1] as string];
		if (typeof text !== "string") return { ok: false, reason: `${path} SKU ${sku} has no attribute ${rest[1]}` };
		return { ok: true, kind: "attribute", path, date: prices.date, sku, name: rest[1] as string, text };
	}
	if (rest.length !== 1) return { ok: false, reason: `not a price citation: expected #<sku>/<rate code> or #<sku>/attributes/<name>` };
	const rateCode = rest[0] as string;
	const terms = source.terms.OnDemand[sku];
	for (const term of isObject(terms) ? Object.values(terms) : []) {
		const dimension = isObject(term) && isObject(term.priceDimensions) ? term.priceDimensions[rateCode] : undefined;
		if (!isObject(dimension)) continue;
		const usd = isObject(dimension.pricePerUnit) ? dimension.pricePerUnit.USD : undefined;
		return {
			ok: true,
			kind: "price",
			path,
			date: prices.date,
			sku,
			rateCode,
			usd: Number(usd),
			unit: String(dimension.unit),
			description: String(dimension.description),
		};
	}
	return { ok: false, reason: `${path} SKU ${sku} has no rate code ${rateCode}` };
}

/** The words of a benchmark's note, every number in which [lm:benchmark/<name>] may cite. */
export function benchmarkText(name: string): string | null {
	const note = BENCHMARK_NOTES[name];
	if (note === undefined) return null;
	return [note.measures, note.repetition, note.bytes, note.caveat, ...(note.variants ?? []).map((v) => v.note)].filter(Boolean).join(" ");
}

/** What a citation (the text inside [lm:...]) resolves to in the data, or why it does not. */
export async function resolveCitation(inside: string, data: LedgerData): Promise<Resolved> {
	if (inside.startsWith("series/")) return resolveSeries(inside.slice("series/".length).split("/"), data);
	if (inside.startsWith("benchmark/")) {
		const name = inside.slice("benchmark/".length);
		const text = benchmarkText(name);
		return text === null ? { ok: false, reason: `no benchmark ${name}` } : { ok: true, kind: "benchmark", name, text };
	}
	const hash = inside.indexOf("#");
	if (inside.startsWith("prices/") && hash > 0) return resolvePrice(inside.slice(0, hash), inside.slice(hash + 1), data);
	return { ok: false, reason: "not a citation LedgerMath knows: expected series/…, prices/…#…, or benchmark/…" };
}

/** Whether a number as written is the value its citation resolved to, as people round and scale it. */
export function citedValueMatches(resolved: Resolved, written: Quantity): boolean {
	if (!resolved.ok) return false;
	switch (resolved.kind) {
		case "measured": {
			if (resolved.stat === "count") return sameQuantity(written, { written: resolved.value, dimension: "none", value: resolved.value });
			const { dimension } = NUMBER_UNIT[resolved.number];
			const value = dimension === "seconds" ? resolved.value * 1e-9 : resolved.value;
			return sameQuantity(written, { written: resolved.value, dimension, value });
		}
		case "param": {
			if (typeof resolved.value !== "number") return false;
			const dimension: Dimension = resolved.key.endsWith("_bytes") ? "bytes" : "none";
			return sameQuantity(written, { written: resolved.value, dimension, value: resolved.value });
		}
		case "price":
			return samePriceUpToScale(written, resolved.usd);
		case "attribute": {
			const value = firstQuantity(resolved.text);
			return value !== null && sameQuantity(written, value);
		}
		case "benchmark":
			return quantities(resolved.text).some((value) => sameQuantity(written, value));
	}
}

/** Variant notes for a Series, for the tool's text. */
export function seriesNotes(series: SeriesDerivation): string[] {
	const note = BENCHMARK_NOTES[series.series.benchmark];
	return note === undefined ? [] : variantNotes(note, series.series.params);
}
