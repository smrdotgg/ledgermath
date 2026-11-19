/**
 * The snapshot of the data API (site/data/snapshot/), imported as JSON at build
 * time, with types for the parts the pages read. The types describe the
 * files; they are not a second copy of the schemas, which are the API's
 * (`index.schema.json`, `series-list.schema.json`, `prices.schema.json`).
 *
 * Pages import from "../../data" (index.ts), not from here.
 */

import indexJson from "../../data/snapshot/v1/index.json";
// The newest price file, named in index.json at prices.newest. When the
// snapshot is replaced, change this date with it; a test checks the two agree.
import pricesJson from "../../data/snapshot/v1/prices/2026-11-19.json";
import seriesJson from "../../data/snapshot/v1/series.json";
// One Series' own file, kept as a sample of what v1/series/<id>.json holds, and the
// schema that describes it (its words are the ones the module quotes).
import seriesFileJson from "../../data/snapshot/v1/series/c2d748916b19.json";
import seriesSchemaJson from "../../data/snapshot/v1/schemas/series.schema.json";

/** Percentiles of one number across a Series' counted Runs (Method `series` v1). */
export type Percentiles = { count: number; p5: number; p50: number; p95: number };

/** Method `series` v1's summary of one Series. */
export type SeriesDerivation = {
	method: { name: "series"; version: 1 };
	counted_runs: number;
	failed_runs: number;
	groups: number;
	percentiles: {
		/** Nanoseconds of one repetition. What a repetition is depends on the benchmark. */
		time_per_repetition_ns: Percentiles | null;
		/** Bytes per second, where the benchmark observes bytes per repetition; null otherwise. */
		bytes_per_second: Percentiles | null;
	};
};

/** One phase of an HTTP request across a pool of requests (Method `requests` v1), in nanoseconds. */
export type RequestPhase = {
	count: number;
	min: number;
	max: number;
	p50: number;
	p90: number;
	p95: number;
	p99: number;
	"p99.9": number;
	at_or_above: Record<string, number>;
};

/** Method `requests` v1's summary of one http_get Series. */
export type RequestsDerivation = {
	method: { name: "requests"; version: 1 };
	counted_runs: number;
	failed_runs: number;
	groups: number;
	pool: {
		runs: number;
		requests: number;
		failed: number;
		phases: Record<"dns" | "connect" | "tls" | "send" | "first_byte" | "headers" | "body" | "total", RequestPhase>;
	};
};

/** One row of v1/series.json: one Series. */
export type SeriesRow = {
	id: string;
	/** The address of this Series' own file in the API. */
	url: string;
	benchmark: string;
	params: Record<string, string | number | boolean>;
	build: string;
	instance_type: string;
	availability_zone_id: string;
	runs: number;
	oldest_run_started_at: string;
	newest_run_started_at: string;
	derivations: { series_v1: SeriesDerivation; requests_v1?: RequestsDerivation };
};

export type MethodWords = {
	method: { name: string; version: number };
	definitions: Record<string, string>;
	[more: string]: unknown;
};

export type SeriesList = {
	schema: string;
	schema_url: string;
	index: string;
	url: string;
	count: number;
	newest_run_started_at: string;
	methods: Record<string, MethodWords>;
	series: SeriesRow[];
};

export type ApiIndex = {
	schema: string;
	schema_url: string;
	url: string;
	about: string;
	versioning: string;
	figures: string;
	docs: string;
	newest_run_started_at: string;
	series: { url: string; schema_url: string; count: number; series_file_schema_url: string };
	prices: {
		schema_url: string;
		newest: { date: string; path: string; url: string };
		files: { date: string; path: string; url: string }[];
	};
	schemas: { name: string; describes: string; url: string }[];
	evidence: { about: string; blob_url_template: string; [more: string]: unknown };
	[more: string]: unknown;
};

export type PriceTerm = {
	offerTermCode: string;
	sku: string;
	effectiveDate: string;
	priceDimensions: Record<
		string,
		{ rateCode: string; description: string; unit: string; pricePerUnit: { USD: string }; beginRange: string; endRange: string }
	>;
};

export type PriceFile = {
	schema: string;
	provider: string;
	fetched_at: string;
	measured: { region: string; instance_types: string[] };
	rules: { name: string; version: number };
	sources: {
		offer_code: string;
		url: string;
		version: string;
		publication_date: string;
		sha256: string;
		selections: { rule: string; selects: string; skus: string[] }[];
		products: Record<string, { sku: string; productFamily: string; attributes: Record<string, string> }>;
		terms: { OnDemand: Record<string, Record<string, PriceTerm>> };
	}[];
};

/** One Run on a Series' chart, in v1/series/<id>.json at derivations.series_v1.points (Method `series` v1). */
export type SeriesPoint = {
	run: string;
	path: string;
	sha256: string;
	evidence: string;
	boot_summary: string | null;
	started_at: string;
	boot: string;
	group: string;
	counted: boolean;
	failure: unknown;
	samples: { sample: number; ns: number; repetitions: number; ns_per_repetition: number }[];
	time_per_repetition_ns: number | null;
	bytes_per_repetition: number | null;
	bytes_per_second: number | null;
};

/** v1/series/<id>.json: one Series in full. Only the parts the module reads are typed. */
export type SeriesFile = {
	[part: string]: unknown;
	id: string;
	url: string;
	benchmark: string;
	instance_type: string;
	runs: number;
	derivations: { [key: string]: Record<string, unknown> | undefined; series_v1: Record<string, unknown> & { points: SeriesPoint[] } };
};

/** A JSON schema, as far as the module reads one: descriptions, properties and $refs. */
export type JsonSchemaNode = {
	description?: string;
	$ref?: string;
	properties?: Record<string, JsonSchemaNode>;
	[more: string]: unknown;
};
export type JsonSchema = JsonSchemaNode & { $defs: Record<string, JsonSchemaNode> };

export const seriesFileSample = seriesFileJson as unknown as SeriesFile;
export const seriesSchema = seriesSchemaJson as unknown as JsonSchema;
/** The sample Series file's id, as its file name gives it. */
export const SERIES_FILE_SAMPLE_ID = "c2d748916b19";

export const apiIndex = indexJson as unknown as ApiIndex;
export const seriesList = seriesJson as unknown as SeriesList;
export const priceFile = pricesJson as unknown as PriceFile;
/** The date of the price file imported above, as its file name gives it. */
export const PRICE_FILE_DATE = "2026-11-19";
