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
 *    is a change of unit (bytes to GB, nanoseconds to milliseconds), and the
 *    helpers in ./figures do it exactly, on the decimal text. One division is
 *    allowed, because it is a change of unit too: a figure of one repetition
 *    divided by a headline choice's `per.count` when that is a power of ten
 *    (one repetition of mutex is 10,000 critical sections), with `perUnit` or
 *    `formatDurationPerUnit`. No other division, by anything.
 * 2. Figures are exact. A helper's `short` form is rounded for scanning; when a
 *    page shows it, the page gives `full` too (a `title` attribute, a second
 *    line, a footnote). Nothing is rounded silently.
 * 3. "The home table" is the headline selection (./headline): one Series per
 *    benchmark and machine type, chosen by a written rule. A design may show
 *    more Series beside it, never other figures for its rows.
 * 4. Links go to the addresses in `links`: the API's, which the snapshot itself
 *    gives (each row's `url` too), and the documentation's, which are planned
 *    public addresses under https://ledgermath.com/docs/ (`links.docs`, each
 *    headline choice's `readme`). None of them answers yet: link them, never
 *    fetch them. No page links to or names the source repository.
 * 5. Import this module from a design's page components only (code that runs
 *    at build time). A design's optional client.ts runs in the browser and
 *    must not import it: it would ship the whole snapshot.
 */

import { benchmarkDocsUrl, DOCS_URL, HEADLINE_CHOICES, type HeadlineChoice, type Section } from "./headline";
import {
	apiIndex,
	type JsonSchemaNode,
	PRICE_FILE_DATE,
	priceFile,
	SERIES_FILE_SAMPLE_ID,
	type SeriesPoint,
	seriesFileSample,
	seriesList,
	seriesSchema,
	type SeriesRow,
} from "./snapshot";

export * from "./figures";
export { HEADLINE_CHOICES } from "./headline";
export type { HeadlineChoice, Section } from "./headline";
export type { Percentiles, RequestPhase, RequestsDerivation, SeriesDerivation, SeriesPoint, SeriesRow } from "./snapshot";

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
		/** Where `usdPerHour` is in the price file (`links.prices`): the path the module itself reads it at, to cite. */
		path: PricePath;
	};
	/** The region and the Availability Zone ID the Series ran in. */
	region: string;
	availabilityZoneIds: string[];
	/** Every Series measured on this type. */
	series: SeriesRow[];
};

/**
 * The place of a machine's hourly price inside the day's price file: the path the module reads
 * it at. `pointer` is the same path as a JSON Pointer (RFC 6901), ready to cite beside
 * `links.prices`: "/sources/0/terms/OnDemand/<sku>/<term>/priceDimensions/<rate code>/pricePerUnit/USD".
 */
export type PricePath = {
	/** The price file's address (`links.prices`). */
	file: string;
	/** Which source of the file, by its place in `sources` and its offer code ("AmazonEC2"). */
	source: number;
	offerCode: string;
	/** The product's SKU: its key under `products` and under `terms.OnDemand`. */
	sku: string;
	/** The On-Demand term's key under `terms.OnDemand[sku]` ("<sku>.<offer term code>"). */
	term: string;
	/** The price dimension's rate code: its key under the term's `priceDimensions`. */
	rateCode: string;
	/** The field inside the price dimension that holds the price. */
	field: "pricePerUnit.USD";
	/** The whole path as a JSON Pointer. */
	pointer: string;
	/** The product's own entry, where the machine's facts (vCPU, memory…) are, as a JSON Pointer. */
	productPointer: string;
};

const pointer = (...keys: (string | number)[]) => keys.map((key) => `/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

function machine(instanceType: string): Machine {
	const source = priceFile.sources.find((s) =>
		s.selections.some((selection) => selection.rule === "ec2-instance-on-demand-linux" && selection.skus.some((sku) => s.products[sku]?.attributes.instanceType === instanceType)),
	);
	if (!source) throw new Error(`the price file has no On-Demand Linux product for ${instanceType}`);
	const products = Object.values(source.products).filter((p) => p.attributes.instanceType === instanceType && p.attributes.operatingSystem === "Linux");
	if (products.length !== 1) throw new Error(`the price file has ${products.length} Linux products for ${instanceType}, not one`);
	const product = products[0]!;
	const terms = Object.entries(source.terms.OnDemand[product.sku] ?? {});
	const dimensions = terms.flatMap(([termKey, term]) => Object.entries(term.priceDimensions).map(([dimensionKey, dimension]) => ({ termKey, term, dimensionKey, dimension })));
	if (dimensions.length !== 1) throw new Error(`${instanceType} has ${dimensions.length} On-Demand price dimensions, not one`);
	const { termKey, term, dimensionKey, dimension } = dimensions[0]!;
	if (dimensionKey !== dimension.rateCode) throw new Error(`${instanceType}'s price dimension is keyed ${dimensionKey}, not by its rate code ${dimension.rateCode}`);
	const sourceIndex = priceFile.sources.indexOf(source);
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
			path: {
				file: apiIndex.prices.newest.url,
				source: sourceIndex,
				offerCode: source.offer_code,
				sku: product.sku,
				term: termKey,
				rateCode: dimensionKey,
				field: "pricePerUnit.USD",
				pointer: pointer("sources", sourceIndex, "terms", "OnDemand", product.sku, termKey, "priceDimensions", dimensionKey, "pricePerUnit", "USD"),
				productPointer: pointer("sources", sourceIndex, "products", product.sku),
			},
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

/** The API's base address, "https://api.ledgermath.com/": index.json's own address without "v1/index.json". */
const API_BASE = (() => {
	const suffix = "v1/index.json";
	if (!apiIndex.url.endsWith(suffix)) throw new Error(`index.json's address ${apiIndex.url} does not end in ${suffix}`);
	return apiIndex.url.slice(0, -suffix.length);
})();

function schemaUrl(name: string, expected: string): string {
	const found = apiIndex.schemas.filter((s) => s.name === name);
	if (found.length !== 1) throw new Error(`index.json lists ${found.length} schemas named ${name}, not one`);
	if (found[0]!.url !== expected) throw new Error(`index.json gives schema ${name} two addresses: ${found[0]!.url} and ${expected}`);
	return found[0]!.url;
}

function describes(name: string): string {
	const found = apiIndex.schemas.find((s) => s.name === name);
	if (!found) throw new Error(`index.json lists no schema named ${name}`);
	return found.describes;
}

/** A Series file's address with "<id>" for the id, for showing as text: "https://api.ledgermath.com/v1/series/<id>.json". */
const SERIES_FILE_PATTERN = API_BASE + describes("series");
for (const row of series) if (row.url !== SERIES_FILE_PATTERN.replace("<id>", row.id)) throw new Error(`Series ${row.id}'s address ${row.url} does not follow ${SERIES_FILE_PATTERN}`);

/** A price file's address with "<yyyy-mm-dd>" for the date: "https://api.ledgermath.com/v1/prices/<yyyy-mm-dd>.json". */
const PRICE_FILE_PATTERN = API_BASE + describes("prices");

const BLOB_URL_TEMPLATE = apiIndex.evidence.blob_url_template;
if (!BLOB_URL_TEMPLATE.includes("{hex}")) throw new Error(`the evidence's blob address template ${BLOB_URL_TEMPLATE} has no {hex}`);

/**
 * The documentation's address. The snapshot's index.json gives the README on GitHub (`docs`),
 * an address in a private repository that no page may link to or name; the snapshot stays as the
 * generator wrote it, and the module gives the planned public address instead. When a newer
 * snapshot gives a docs address that is not on GitHub, the module uses that one.
 */
const DOCS = /^https:\/\/github\.com\//.test(apiIndex.docs) ? DOCS_URL : apiIndex.docs;

/** One daily price file the index lists. */
export type PriceFileLink = {
	/** The day the prices were fetched: "2026-11-19". */
	date: string;
	/** The file's address. */
	url: string;
	/** True for the newest, the one the module reads (`links.prices`). */
	newest: boolean;
};

/**
 * The addresses a page links to. The API's are the snapshot's own fields; the documentation's
 * are planned public addresses. None answers yet: link them, never fetch them.
 */
export const links = {
	/** The API's table of contents. */
	index: apiIndex.url,
	/** Every Series in one file. */
	seriesList: apiIndex.series.url,
	/** The newest price file. */
	prices: apiIndex.prices.newest.url,
	/** Every daily price file the index lists, oldest first as the index lists them; the newest is marked. */
	priceFiles: apiIndex.prices.files.map((file): PriceFileLink => ({ date: file.date, url: file.url, newest: file.date === apiIndex.prices.newest.date })),
	/** A price file's address with "<yyyy-mm-dd>" for its date, for showing as text. */
	priceFilePattern: PRICE_FILE_PATTERN,
	/** The JSON schema of each kind of file, as index.json lists them (name, the file it describes, address). */
	schemas: apiIndex.schemas,
	/** Each schema's address by name. */
	schema: {
		/** Of v1/index.json. */
		index: schemaUrl("index", apiIndex.schema_url),
		/** Of v1/series.json, the Series list. */
		seriesList: schemaUrl("series-list", apiIndex.series.schema_url),
		/** Of v1/series/<id>.json, one Series' own file. */
		series: schemaUrl("series", apiIndex.series.series_file_schema_url),
		/** Of v1/prices/<yyyy-mm-dd>.json, a day's price file. */
		prices: schemaUrl("prices", apiIndex.prices.schema_url),
	},
	/** LedgerMath's documentation: https://ledgermath.com/docs/ (planned; see DOCS above for why not the snapshot's own field). */
	docs: DOCS,
	/** A benchmark's page in the documentation: https://ledgermath.com/docs/benchmarks/<benchmark> (planned). Each headline choice's `readme` is the same. */
	benchmarkDocs: benchmarkDocsUrl,
	/** One Series' own file (each row's `url`). */
	seriesFile: (row: SeriesRow) => row.url,
	/** A Series file's address with "<id>" for the id, for showing as text. */
	seriesFilePattern: SERIES_FILE_PATTERN,
	/**
	 * The address template of an evidence blob, as index.json gives it: "{hex}" stands for the 64
	 * hex digits of a sha256. A Run file names its binary, streams and dumps as sha256:<hex>.
	 */
	evidenceBlobTemplate: BLOB_URL_TEMPLATE,
	/** An evidence blob's address, for a sha256 given as 64 hex digits or as "sha256:<hex>". */
	evidenceBlob: (sha256: string) => {
		const hex = sha256.replace(/^sha256:/, "");
		if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a sha256 in hex: ${JSON.stringify(sha256)}`);
		return BLOB_URL_TEMPLATE.replace("{hex}", hex);
	},
	/** What index.json says about the evidence and where it is served, in its own words. */
	evidenceAbout: apiIndex.evidence.about,
} as const;

{
	const newest = links.priceFiles.filter((file) => file.newest);
	if (newest.length !== 1 || newest[0]!.url !== links.prices) throw new Error("index.json's list of price files does not hold its newest file exactly once");
}

// ---------------------------------------------------------------- what a Series' own file holds

/** A part of a file, and the words for it: the schema's own, or (where the schema gives none) the module's. */
export type FilePart = { name: string; what: string; from: "schema" | "module" };

function resolve(node: JsonSchemaNode | undefined): JsonSchemaNode {
	if (!node) return {};
	if (!node.$ref) return node;
	const name = node.$ref.replace(/^#\/\$defs\//, "");
	const target = seriesSchema.$defs[name];
	if (!target) throw new Error(`series.schema.json has no $defs/${name}`);
	return { ...resolve(target), ...(node.description ? { description: node.description } : {}) };
}

/** The parts of `object`, in the file's own order, each with the description its schema node gives (resolving $refs). */
function partsOf(object: Record<string, unknown>, schema: JsonSchemaNode, fallback: Record<string, string> = {}): FilePart[] {
	const properties = resolve(schema).properties ?? {};
	return Object.keys(object).map((name) => {
		if (!(name in properties)) throw new Error(`series.schema.json does not describe the Series file's part ${name}`);
		const node = resolve(properties[name]);
		// An array's words may be on its items (a group: "The Runs whose split facts are all equal…").
		const schemaWords = node.description ?? resolve(node.items as JsonSchemaNode | undefined).description;
		if (schemaWords) return { name, what: schemaWords, from: "schema" as const };
		const what = fallback[name];
		if (!what) throw new Error(`series.schema.json gives no words for the Series file's part ${name}, and the module has none`);
		return { name, what, from: "module" as const };
	});
}

const sampleRow = series.find((row) => row.id === SERIES_FILE_SAMPLE_ID);
if (!sampleRow || seriesFileSample.id !== SERIES_FILE_SAMPLE_ID || seriesFileSample.url !== sampleRow.url) throw new Error(`the sample Series file is not the file of Series ${SERIES_FILE_SAMPLE_ID} in series.json`);
const samplePoints = seriesFileSample.derivations.series_v1.points;
const examplePoint = samplePoints[0];
if (!examplePoint) throw new Error("the sample Series file has no point");
const pointSchema = seriesSchema.$defs.series_point ?? {};

/**
 * What v1/series/<id>.json holds, built from the one Series file the snapshot keeps as a sample
 * (data/snapshot/v1/series/) and from the words of its schema (series.schema.json). Every name
 * here is a name in the file, and every `what` is the schema's own description, except the two
 * parts the schema gives no words for (`benchmark`, and a Derivation's `method`), whose `from`
 * is "module".
 *
 * The file's layout will change: it is to be split by month. A page describes it in general
 * terms ("each Run's figure and a link to its evidence"), never promising a layout.
 */
export const seriesFileContents = {
	/** The address pattern, "https://api.ledgermath.com/v1/series/<id>.json". */
	pattern: SERIES_FILE_PATTERN,
	/** The address of its schema. */
	schemaUrl: links.schema.series,
	/** The schema's description of the whole file. */
	about: seriesSchema.description ?? "",
	/** Its top-level parts, in the file's order. */
	parts: partsOf(seriesFileSample, seriesSchema, { benchmark: "The benchmark's name." }),
	/**
	 * Under `derivations`, one Derivation per Method, keyed <method name>_v<version>. Every Series
	 * has `series_v1`; http_get's also have `requests_v1`. Each with its parts, in the sample's order
	 * (the sample has series_v1 only).
	 */
	derivations: Object.entries(seriesFileSample.derivations).map(([key, derivation]) => ({
		key,
		what: resolve(seriesSchema.properties?.derivations?.properties?.[key]).description ?? "",
		parts: partsOf(derivation ?? {}, seriesSchema.properties?.derivations?.properties?.[key] ?? {}, {
			method: "The Method and its version.",
		}),
	})),
	/** What one point (one Run, at derivations.series_v1.points) carries. */
	point: {
		/** The schema's description of a point. */
		what: pointSchema.description ?? "",
		/** Every field of a point, in the file's order, with the schema's words. */
		fields: partsOf(examplePoint, pointSchema),
		/**
		 * The fields a page is most likely to name, in this order: the Run's id, when it started, its
		 * group, whether it is counted, its figure (time of one repetition; bytes per second where the
		 * benchmark observes bytes), and the addresses of its Run file and its boot's summary.
		 */
		key: ["run", "started_at", "group", "counted", "time_per_repetition_ns", "bytes_per_second", "evidence", "boot_summary"] as const,
		/** One real point: the first Run of the sample Series, exactly as the file holds it. */
		example: examplePoint as SeriesPoint,
	},
	/** The sample itself: which Series it is, and how many points its file holds. */
	sample: {
		id: seriesFileSample.id,
		url: seriesFileSample.url,
		benchmark: seriesFileSample.benchmark,
		instanceType: seriesFileSample.instance_type,
		runs: seriesFileSample.runs,
		points: samplePoints.length,
	},
} as const;

for (const name of seriesFileContents.point.key) if (!(name in examplePoint)) throw new Error(`a Series file's point has no field ${name}`);
