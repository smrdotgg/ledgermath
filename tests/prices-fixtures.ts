/**
 * What the price tests share: the hand-made offer files in
 * tests/samples/prices/sources (tests/samples/prices/make-sources.ts says
 * what they hold), the URLs they stand for, and a fake fetch that serves them
 * with the offer index and region indexes that lead to them. No test needs
 * the network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Measured, OfferCode } from "../scripts/lib/price-rules";
import { type Fetch, OFFER_INDEX_URL, PRICE_LIST_HOST, type SourceFile } from "../scripts/lib/prices";

export const PRICE_SAMPLES = join(import.meta.dir, "samples", "prices");
export const SOURCES = join(PRICE_SAMPLES, "sources");
/** The sample price file, where the Runs repository would hold it. */
export const SAMPLE_PATH = "prices/2026/11/11/aws.json";
export const SAMPLE_REPOSITORY = join(PRICE_SAMPLES, "repository");
export const SAMPLE_FILE = join(SAMPLE_REPOSITORY, SAMPLE_PATH);

/** What the tests measure: three of the excerpts' instance types, so c8i.2xlarge is one nothing measures. */
export const MEASURED: Measured = { region: "us-east-2", instance_types: ["c6i.8xlarge", "i4i.2xlarge", "m5.large"] };
export const FETCHED_AT = new Date("2026-11-11T03:17:42.123Z");

export const VERSIONS: Record<OfferCode, string> = {
	AmazonEC2: "20261110173852",
	AmazonS3: "20261109154310",
	AWSDataTransfer: "20261110232936",
};

export const sourceUrl = (offerCode: OfferCode, version = VERSIONS[offerCode], region = MEASURED.region): string =>
	`${PRICE_LIST_HOST}/offers/v1.0/aws/${offerCode}/${version}/${region}/index.json`;

/** The excerpts as local copies, the way the fetch leaves its downloads. */
export function sampleSources(directory = SOURCES): SourceFile[] {
	return (Object.keys(VERSIONS) as OfferCode[]).map((offerCode) => ({ offerCode, url: sourceUrl(offerCode), path: join(directory, `${offerCode}.json`) }));
}

/** The offer index, as AWS writes it, cut down to the three offers. */
export function offerIndex(): unknown {
	return {
		formatVersion: "v1.0",
		publicationDate: "2026-11-11T03:09:48Z",
		offers: Object.fromEntries(
			(Object.keys(VERSIONS) as OfferCode[]).map((offerCode) => [
				offerCode,
				{
					offerCode,
					versionIndexUrl: `/offers/v1.0/aws/${offerCode}/index.json`,
					currentVersionUrl: `/offers/v1.0/aws/${offerCode}/current/index.json`,
					currentRegionIndexUrl: `/offers/v1.0/aws/${offerCode}/current/region_index.json`,
				},
			]),
		),
	};
}

/** One offer's region index, naming the versioned file for each Region given. */
export function regionIndex(offerCode: OfferCode, regions: Record<string, string>): unknown {
	return {
		formatVersion: "v1.0",
		publicationDate: "2026-11-10T17:38:52Z",
		regions: Object.fromEntries(Object.entries(regions).map(([region, path]) => [region, { regionCode: region, currentVersionUrl: path }])),
	};
}

export interface FakeFetch {
	fetch: Fetch;
	/** Every URL asked for, in order. */
	requests: string[];
}

/**
 * A fetch that answers from `routes`: a URL maps to a file to stream, to text
 * or JSON, or to a function that makes the response. Anything else is a 404.
 * The default routes lead from the offer index to the excerpts.
 */
export function fakeFetch(overrides: Record<string, Route> = {}): FakeFetch {
	const routes: Record<string, Route> = { [OFFER_INDEX_URL]: { json: offerIndex() } };
	for (const offerCode of Object.keys(VERSIONS) as OfferCode[]) {
		const versioned = sourceUrl(offerCode).slice(PRICE_LIST_HOST.length);
		routes[`${PRICE_LIST_HOST}/offers/v1.0/aws/${offerCode}/current/region_index.json`] = {
			json: regionIndex(offerCode, { [MEASURED.region]: versioned, "eu-west-1": versioned.replace(MEASURED.region, "eu-west-1") }),
		};
		routes[sourceUrl(offerCode)] = { file: join(SOURCES, `${offerCode}.json`) };
	}
	Object.assign(routes, overrides);
	const requests: string[] = [];
	const fetcher: Fetch = async (url: string) => {
		requests.push(url);
		const route = routes[url];
		if (route === undefined) return new Response("not found", { status: 404, statusText: "Not Found" });
		if ("respond" in route) return route.respond();
		const bytes = "file" in route ? readFileSync(route.file) : new TextEncoder().encode("text" in route ? route.text : JSON.stringify(route.json));
		return new Response(bytes, { status: 200, headers: { "Content-Length": String(bytes.length) } });
	};
	return { fetch: fetcher, requests };
}

export type Route = { file: string } | { text: string } | { json: unknown } | { respond: () => Response | Promise<Response> };
