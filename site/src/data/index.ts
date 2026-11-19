/**
 * LedgerMath's figures for the home-page variations: one snapshot of the data
 * API (site/data/snapshot/), read at build time, the same for every design.
 *
 * RULES FOR EVERY PAGE THAT USES THIS MODULE
 *
 * 1. Every figure shown comes from here, exactly as the snapshot holds it.
 *    No design invents, estimates or computes a statistic: no averages across
 *    machines, no ratios (price per GB/s, "3.2× faster"), no rankings presented
 *    as findings, no trends, no "typical" values. The only arithmetic allowed
 *    is a change of unit (bytes to GB, nanoseconds to milliseconds, one
 *    repetition of mutex to one of its 10,000 critical sections), and the
 *    helpers in ./figures do it exactly, on the decimal text.
 * 2. Figures are exact. A helper's `short` form is rounded for scanning; when a
 *    page shows it, the page gives `full` too (a `title` attribute, a second
 *    line, a footnote). Nothing is rounded silently.
 * 3. "The home table" is the headline selection (./headline): one Series per
 *    benchmark and machine type, chosen by a written rule. A design may show
 *    more Series beside it, never other figures for its rows.
 * 4. Links go to the addresses the snapshot itself gives (`links`, each row's
 *    `url`). They are not served yet: link them, never fetch them.
 * 5. Import this module from a design's page components only (code that runs
 *    at build time). A design's optional client.ts runs in the browser and
 *    must not import it: it would ship the whole snapshot.
 */

import { HEADLINE_CHOICES, type HeadlineChoice, type Section } from "./headline";
import { apiIndex, PRICE_FILE_DATE, priceFile, seriesList, type SeriesRow } from "./snapshot";

export * from "./figures";
export { HEADLINE_CHOICES } from "./headline";
export type { HeadlineChoice, Section } from "./headline";
export type { Percentiles, RequestPhase, RequestsDerivation, SeriesDerivation, SeriesRow } from "./snapshot";

// ---------------------------------------------------------------- Series

/** Every Series in the snapshot (187), as v1/series.json lists them. */
export const series: readonly SeriesRow[] = seriesList.series;

/** True when the row's params include every one of `params`, with the same value. */
export function hasParams(row: SeriesRow, params: Record<string, unknown>): boolean {
	return Object.entries(params).every(([key, value]) => row.params[key] === value);
}

// ---------------------------------------------------------------- machines

export type Machine = {
	/** "m5.large" */
	instanceType: string;
	/** The facts AWS's price list gives for the type, as text, exactly as the price file holds them. */
	vcpu: string;
	memory: string;
	processor: string;
	clockSpeed: string;
	storage: string;
	network: string;
	family: string;
	/** The hourly On-Demand Linux price in us-east-2, from the newest price file. */
	price: {
		/** As the price file writes it: "0.0960000000" (US dollars per hour). See formatUsd. */
		usdPerHour: string;
		/** AWS's own words: "$0.096 per On Demand Linux m5.large Instance Hour". */
		description: string;
		unit: string;
		sku: string;
		rateCode: string;
		effectiveDate: string;
	};
	/** The region and the Availability Zone ID the Series ran in. */
	region: string;
	availabilityZoneIds: string[];
	/** Every Series measured on this type. */
	series: SeriesRow[];
};

function machine(instanceType: string): Machine {
	const source = priceFile.sources.find((s) =>
		s.selections.some((selection) => selection.rule === "ec2-instance-on-demand-linux" && selection.skus.some((sku) => s.products[sku]?.attributes.instanceType === instanceType)),
	);
	if (!source) throw new Error(`the price file has no On-Demand Linux product for ${instanceType}`);
	const products = Object.values(source.products).filter((p) => p.attributes.instanceType === instanceType && p.attributes.operatingSystem === "Linux");
	if (products.length !== 1) throw new Error(`the price file has ${products.length} Linux products for ${instanceType}, not one`);
	const product = products[0]!;
	const terms = Object.values(source.terms.OnDemand[product.sku] ?? {});
	const dimensions = terms.flatMap((term) => Object.values(term.priceDimensions).map((dimension) => ({ term, dimension })));
	if (dimensions.length !== 1) throw new Error(`${instanceType} has ${dimensions.length} On-Demand price dimensions, not one`);
	const { term, dimension } = dimensions[0]!;
	if (dimension.unit !== "Hrs") throw new Error(`${instanceType}'s On-Demand price is per ${dimension.unit}, not per hour`);
	const a = product.attributes;
	const rows = series.filter((row) => row.instance_type === instanceType);
	return {
		instanceType,
		vcpu: a.vcpu ?? "",
		memory: a.memory ?? "",
		processor: a.physicalProcessor ?? "",
		clockSpeed: a.clockSpeed ?? "",
		storage: a.storage ?? "",
		network: a.networkPerformance ?? "",
		family: a.instanceFamily ?? "",
		price: {
			usdPerHour: dimension.pricePerUnit.USD,
			description: dimension.description,
			unit: dimension.unit,
			sku: product.sku,
			rateCode: dimension.rateCode,
			effectiveDate: term.effectiveDate,
		},
		region: priceFile.measured.region,
		availabilityZoneIds: [...new Set(rows.map((row) => row.availability_zone_id))].sort(),
		series: rows,
	};
}

/**
 * The five machine types, cheapest first by their hourly price (an ordering, not a statistic).
 * The price file's `measured.instance_types` lists the types; each must have Series.
 */
export const machines: readonly Machine[] = priceFile.measured.instance_types
	.map(machine)
	.sort((a, b) => Number(a.price.usdPerHour) - Number(b.price.usdPerHour) || a.instanceType.localeCompare(b.instanceType));

for (const m of machines) if (m.series.length === 0) throw new Error(`no Series ran on ${m.instanceType}`);
for (const row of series) if (!machines.some((m) => m.instanceType === row.instance_type)) throw new Error(`Series ${row.id} ran on ${row.instance_type}, which the price file does not price`);

export function machineOf(instanceType: string): Machine {
	const found = machines.find((m) => m.instanceType === instanceType);
	if (!found) throw new Error(`no machine type ${instanceType}`);
	return found;
}

// ---------------------------------------------------------------- the headline rows

export type HeadlineRow = {
	choice: HeadlineChoice;
	/** One cell per machine type, in the order of `machines`. */
	cells: { machine: Machine; series: SeriesRow }[];
};

/** The home table: one row per benchmark (14), each with one Series per machine type (5). See ./headline for the rule. */
export const headline: readonly HeadlineRow[] = HEADLINE_CHOICES.map((choice) => ({
	choice,
	cells: machines.map((m) => {
		const found = series.filter((row) => row.benchmark === choice.benchmark && row.build === choice.build && row.instance_type === m.instanceType && hasParams(row, choice.params));
		if (found.length !== 1) throw new Error(`headline ${choice.benchmark} on ${m.instanceType}: ${found.length} Series match its settings, not exactly one`);
		return { machine: m, series: found[0]! };
	}),
}));

/** The headline Series as a flat list (70), row by row. */
export const headlineSeries: readonly SeriesRow[] = headline.flatMap((row) => row.cells.map((cell) => cell.series));

export function isHeadline(row: SeriesRow): boolean {
	return headlineSeries.includes(row);
}

// ---------------------------------------------------------------- benchmarks

export type Benchmark = {
	name: string;
	section: Section;
	/** The headline choice for this benchmark: its label, what it measures, what a repetition is. */
	headline: HeadlineChoice;
	/** Every Series of the benchmark, every setting and machine. */
	series: SeriesRow[];
	/** The distinct settings measured (params and build), each with its Series. */
	settings: { params: SeriesRow["params"]; build: string; series: SeriesRow[] }[];
	/** True when the snapshot gives bytes per second for the benchmark's Series. */
	hasRate: boolean;
};

/** The fourteen benchmarks, in the home table's order. */
export const benchmarks: readonly Benchmark[] = HEADLINE_CHOICES.map((choice) => {
	const rows = series.filter((row) => row.benchmark === choice.benchmark);
	const settings = new Map<string, Benchmark["settings"][number]>();
	for (const row of rows) {
		const key = `${JSON.stringify(row.params)} ${row.build}`;
		const setting = settings.get(key) ?? { params: row.params, build: row.build, series: [] };
		setting.series.push(row);
		settings.set(key, setting);
	}
	return {
		name: choice.benchmark,
		section: choice.section,
		headline: choice,
		series: rows,
		settings: [...settings.values()],
		hasRate: rows.some((row) => row.derivations.series_v1.percentiles.bytes_per_second !== null),
	};
});

{
	const named = new Set(benchmarks.map((b) => b.name));
	for (const row of series) if (!named.has(row.benchmark)) throw new Error(`benchmark ${row.benchmark} has no headline choice in src/data/headline.ts`);
}

/** The figure that leads a headline cell, as the rule in ./headline names it: the p50 rate, or the p50 time of one repetition. */
export function leadFigure(choice: HeadlineChoice, row: SeriesRow): { kind: "rate" | "time"; p5: number; p50: number; p95: number; count: number } {
	const p = row.derivations.series_v1.percentiles;
	const figure = choice.lead === "rate" ? p.bytes_per_second : p.time_per_repetition_ns;
	if (!figure) throw new Error(`Series ${row.id} has no ${choice.lead} figure`);
	return { kind: choice.lead, ...figure };
}

// ---------------------------------------------------------------- the snapshot itself

const sum = (pick: (row: SeriesRow) => number) => series.reduce((total, row) => total + pick(row), 0);
const oldest = series.map((row) => row.oldest_run_started_at).sort()[0]!;

export const snapshot = {
	/** When the newest Run in the snapshot started (UTC, to the nanosecond). */
	newestRunStartedAt: apiIndex.newest_run_started_at,
	/** When the oldest Run in the snapshot started. */
	oldestRunStartedAt: oldest,
	/** Series in the snapshot (187). */
	seriesCount: apiIndex.series.count,
	/** Runs across every Series (6,335): the sum of each row's `runs`. */
	runCount: sum((row) => row.runs),
	/** Runs Method `series` v1 counted, and the ones it did not (failed Runs are kept and shown, never dropped). */
	countedRuns: sum((row) => row.derivations.series_v1.counted_runs),
	failedRuns: sum((row) => row.derivations.series_v1.failed_runs),
	benchmarkCount: benchmarks.length,
	machineCount: machines.length,
	/** The newest price file's date, and when it was fetched from AWS. */
	priceDate: PRICE_FILE_DATE,
	pricesFetchedAt: priceFile.fetched_at,
	region: priceFile.measured.region,
	/** The API's own words: what LedgerMath is, how versioning works, what a figure is. */
	about: apiIndex.about,
	versioning: apiIndex.versioning,
	figures: apiIndex.figures,
	/** The Methods that made the figures, with their definitions (time_per_repetition, percentiles, counted…). */
	methods: Object.entries(seriesList.methods).map(([key, words]) => ({ key, name: words.method.name, version: words.method.version, definitions: words.definitions })),
} as const;

if (snapshot.seriesCount !== series.length) throw new Error(`index.json counts ${snapshot.seriesCount} Series, series.json lists ${series.length}`);

// ---------------------------------------------------------------- links

/** The addresses a page links to, every one taken from the snapshot's own fields. Not served yet: link, never fetch. */
export const links = {
	/** The API's table of contents. */
	index: apiIndex.url,
	/** Every Series in one file. */
	seriesList: apiIndex.series.url,
	/** The newest price file. */
	prices: apiIndex.prices.newest.url,
	/** The JSON schema of each kind of file. */
	schemas: apiIndex.schemas,
	/** The API's documentation. */
	docs: apiIndex.docs,
	/** One Series' own file (each row's `url`). */
	seriesFile: (row: SeriesRow) => row.url,
} as const;
