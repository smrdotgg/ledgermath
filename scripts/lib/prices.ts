/**
 * Price files: a daily copy of what AWS publicly charges for what is measured
 * (issue #45). One file a day, prices/<yyyy>/<mm>/<dd>/aws.json in the Runs
 * repository, added once and never edited, shaped by schemas/prices.schema.json.
 *
 * Where the prices come from: AWS's Price List bulk files, which need no
 * account. The offer index (OFFER_INDEX_URL) names each offer's current
 * region index; the region index names, for each Region, the versioned URL of
 * the offer file, such as
 *
 *     https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/20261110173852/us-east-2/index.json
 *
 * The 14 digits are the file's version, its own "version" member, the moment
 * of its publicationDate. A price file records and cites only that versioned
 * URL, never a "current" one, whose bytes change.
 *
 * The cut keeps, from each offer file, the products the rules select
 * (scripts/lib/price-rules.ts) and their On-Demand terms, verbatim: each is
 * AWS's own object, parsed and written back with nothing changed but the
 * whitespace between tokens (parseVerbatim proves it, record by record). The
 * file names each source's URL, version, publication date, size and SHA-256,
 * and the rule set it was cut with. The same sources, measured inputs, rules
 * and fetch time give the same bytes.
 */

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, writeSync } from "node:fs";

import { scanOfferFile, parseVerbatim, type Span } from "./offer-file";
import { type Measured, type OfferCode, offersOf, type Product, type RuleSet } from "./price-rules";

export const PRICES_SCHEMA = "ledgermath.prices/1";
export const PRICE_LIST_HOST = "https://pricing.us-east-1.amazonaws.com";
export const OFFER_INDEX_URL = `${PRICE_LIST_HOST}/offers/v1.0/aws/index.json`;

/** A versioned offer file of one Region: offer code, version, Region. */
const VERSIONED_URL = /^https:\/\/pricing\.us-east-1\.amazonaws\.com\/offers\/v1\.0\/aws\/([A-Za-z0-9]+)\/([0-9]{14})\/([a-z0-9-]+)\/index\.json$/;

export interface VersionedUrl {
	offerCode: string;
	version: string;
	region: string;
}

/** The parts of a versioned offer file URL, or null when the URL is not one (a "current" URL is not). */
export function parseVersionedUrl(url: string): VersionedUrl | null {
	const match = VERSIONED_URL.exec(url);
	if (match === null) return null;
	return { offerCode: match[1] as string, version: match[2] as string, region: match[3] as string };
}

/** One selection of the price file: a rule, what it selects, and the SKUs it selected, in the file's order. */
export interface Selection {
	rule: string;
	selects: string;
	skus: string[];
}

export interface PriceSource {
	offer_code: string;
	/** The versioned URL the bytes were downloaded from. */
	url: string;
	/** The file's own "version". */
	version: string;
	/** The file's own "publicationDate". */
	publication_date: string;
	bytes: number;
	/** sha256:<hex> of the bytes. */
	sha256: string;
	/** Every top-level member of the file other than products and terms, verbatim. */
	header: Record<string, unknown>;
	selections: Selection[];
	/** The selected products, verbatim, under the keys the file files them under, in the file's order. */
	products: Record<string, unknown>;
	/** Each selected product's On-Demand terms, verbatim: terms.OnDemand.<sku> of the file. */
	terms: { OnDemand: Record<string, unknown> };
}

export interface PriceFile {
	schema: typeof PRICES_SCHEMA;
	provider: "aws";
	/** When the fetch started; its UTC date names the file. */
	fetched_at: string;
	measured: Measured;
	rules: { name: string; version: number };
	sources: PriceSource[];
}

/** The path of the price file for the UTC date of `at`, in the Runs repository. */
export function priceFilePath(at: Date): string {
	const iso = at.toISOString();
	return `prices/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/aws.json`;
}

/** The only shape a price file's path may have. */
export const PRICE_FILE_PATH = /^prices\/([0-9]{4})\/([0-9]{2})\/([0-9]{2})\/aws\.json$/;

/** The bytes a price file is stored as. */
export function serializePriceFile(file: PriceFile): string {
	return `${JSON.stringify(file, null, 2)}\n`;
}

/** A local copy of one offer file, and the versioned URL it was downloaded from. */
export interface SourceFile {
	offerCode: OfferCode;
	url: string;
	path: string;
}

export class CutRefused extends Error {
	constructor(readonly problems: string[]) {
		super(
			[`the cut stopped and wrote nothing: ${problems.length} problem${problems.length === 1 ? "" : "s"}`, ...problems.map((problem) => `  ${problem}`)].join(
				"\n",
			),
		);
		this.name = "CutRefused";
	}
}

/** Reads one offer file once: its hash and size, its header, and the products the offer's rules select with their On-Demand terms. */
function cutSource(source: SourceFile, rules: RuleSet, measured: Measured, problems: string[]): PriceSource | null {
	const where = `${source.offerCode} (${source.url})`;
	const offerRules = rules.rules.filter((rule) => rule.offerCode === source.offerCode);
	const hash = createHash("sha256");
	let size = 0;
	const header: Record<string, unknown> = {};
	/** Matched products by rule, and every selected product's span by SKU, in the file's order. */
	const matched = new Map<string, Product[]>(offerRules.map((rule) => [rule.name, []]));
	const selected = new Map<string, Span>();
	const onDemand = new Map<string, Span>();
	let productsSeen = 0;
	const local: string[] = [];

	// The reader refuses a file a standard JSON parser would read differently: one that breaks
	// JSON's grammar, or repeats a top-level member, a key under products or terms, or a SKU
	// under a kind of terms. parseVerbatim refuses a repeated key inside a record it keeps.
	try {
		scanOfferFile(source.path, {
			bytes: (chunk) => {
				hash.update(chunk);
				size += chunk.length;
			},
			header: (member) => {
				header[member.key] = parseVerbatim(member, "the header");
			},
			product: (span) => {
				productsSeen++;
				const product = JSON.parse(span.text) as Partial<Product> | null;
				if (product === null || typeof product !== "object" || product.sku !== span.key) {
					local.push(`products.${span.key} is not a product whose sku is its key`);
					return;
				}
				const attributes = typeof product.attributes === "object" && product.attributes !== null ? product.attributes : {};
				const shaped: Product = { sku: product.sku, productFamily: product.productFamily, attributes };
				for (const rule of offerRules) {
					if (!rule.matches(shaped, measured)) continue;
					(matched.get(rule.name) as Product[]).push(shaped);
					selected.set(span.key, span);
				}
			},
			onDemand: (span) => {
				if (selected.has(span.key)) onDemand.set(span.key, span);
			},
		});
	} catch (error) {
		problems.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}

	const url = parseVersionedUrl(source.url);
	if (url === null) local.push("its URL is not a versioned offer file's URL");
	else {
		if (url.offerCode !== source.offerCode) local.push(`its URL names the offer ${url.offerCode}`);
		if (url.region !== measured.region) local.push(`its URL names the Region ${url.region}, not ${measured.region}`);
		if (header.version !== url.version) local.push(`the file's version ${JSON.stringify(header.version)} is not its URL's ${url.version}`);
	}
	if (header.offerCode !== source.offerCode) local.push(`the file's offerCode is ${JSON.stringify(header.offerCode)}`);
	if (typeof header.publicationDate !== "string") local.push("the file has no publicationDate");
	if (productsSeen === 0) local.push("the file holds no products");

	const selections: Selection[] = [];
	for (const rule of offerRules) {
		const products = matched.get(rule.name) as Product[];
		const implausible = rule.implausible(products, measured);
		if (implausible !== null) local.push(`rule ${rule.name} ${implausible}`);
		selections.push({ rule: rule.name, selects: rule.selects, skus: products.map((product) => product.sku) });
	}

	const products: Record<string, unknown> = {};
	const terms: Record<string, unknown> = {};
	/** parseVerbatim, with a record that cannot be kept verbatim listed as a problem. */
	const keep = (span: Span, part: string): unknown => {
		try {
			return parseVerbatim(span, part);
		} catch (error) {
			local.push(error instanceof Error ? error.message : String(error));
			return undefined;
		}
	};
	for (const [sku, span] of selected) {
		products[sku] = keep(span, "products");
		const term = onDemand.get(sku);
		if (term === undefined) {
			local.push(`products.${sku} was selected and has no On-Demand terms`);
			continue;
		}
		const parsed = keep(term, "terms.OnDemand");
		if (parsed === undefined) continue;
		if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).length === 0) local.push(`terms.OnDemand.${sku} is empty`);
		terms[sku] = parsed;
	}

	problems.push(...local.map((problem) => `${where}: ${problem}`));
	if (local.length > 0) return null;
	return {
		offer_code: source.offerCode,
		url: source.url,
		version: header.version as string,
		publication_date: header.publicationDate as string,
		bytes: size,
		sha256: `sha256:${hash.digest("hex")}`,
		header,
		selections,
		products,
		terms: { OnDemand: terms },
	};
}

/**
 * The price file cut from local copies of the offer files: one source per
 * offer the rules read, in the rules' order. Throws CutRefused, listing every
 * problem, when an offer is missing, a file is not what its URL says, or a
 * rule selects an implausible set; then nothing is to be written.
 */
export function cutPrices(options: { fetchedAt: Date; measured: Measured; rules: RuleSet; sources: readonly SourceFile[] }): PriceFile {
	const problems: string[] = [];
	const sources: PriceSource[] = [];
	for (const offerCode of offersOf(options.rules)) {
		const files = options.sources.filter((source) => source.offerCode === offerCode);
		if (files.length !== 1) {
			problems.push(`${offerCode}: ${files.length} source files given, and the rules read exactly one`);
			continue;
		}
		const cut = cutSource(files[0] as SourceFile, options.rules, options.measured, problems);
		if (cut !== null) sources.push(cut);
	}
	for (const source of options.sources) {
		if (!offersOf(options.rules).includes(source.offerCode)) problems.push(`${source.offerCode}: given, and no rule reads it`);
	}
	if (problems.length > 0) throw new CutRefused(problems);
	return {
		schema: PRICES_SCHEMA,
		provider: "aws",
		fetched_at: options.fetchedAt.toISOString(),
		measured: { region: options.measured.region, instance_types: [...options.measured.instance_types] },
		rules: { name: options.rules.name, version: options.rules.version },
		sources,
	};
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const REQUEST: RequestInit = {
	// The bytes as stored, so their hash is the one anyone downloading the URL gets.
	headers: { "Accept-Encoding": "identity", "User-Agent": "ledgermath-prices" },
};

async function fetchJson(fetcher: Fetch, url: string): Promise<unknown> {
	const response = await fetcher(url, REQUEST);
	if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
	return response.json();
}

/**
 * The versioned URL of each offer file the rules read, for the Region:
 * offer index, then the offer's current region index, then the Region's
 * currentVersionUrl, which must be a versioned URL.
 */
export async function resolveSources(fetcher: Fetch, rules: RuleSet, region: string): Promise<Array<{ offerCode: OfferCode; url: string }>> {
	const index = (await fetchJson(fetcher, OFFER_INDEX_URL)) as { offers?: Record<string, { currentRegionIndexUrl?: unknown }> };
	const resolved: Array<{ offerCode: OfferCode; url: string }> = [];
	for (const offerCode of offersOf(rules)) {
		const regionIndexPath = index.offers?.[offerCode]?.currentRegionIndexUrl;
		if (typeof regionIndexPath !== "string" || !regionIndexPath.startsWith("/")) {
			throw new Error(`the offer index ${OFFER_INDEX_URL} names no region index for ${offerCode}`);
		}
		const regionIndexUrl = `${PRICE_LIST_HOST}${regionIndexPath}`;
		const regionIndex = (await fetchJson(fetcher, regionIndexUrl)) as { regions?: Record<string, { currentVersionUrl?: unknown }> };
		const versionPath = regionIndex.regions?.[region]?.currentVersionUrl;
		if (typeof versionPath !== "string") throw new Error(`${regionIndexUrl} names no file for ${region}`);
		const url = `${PRICE_LIST_HOST}${versionPath}`;
		const parts = parseVersionedUrl(url);
		if (parts === null || parts.offerCode !== offerCode || parts.region !== region) {
			throw new Error(`${regionIndexUrl} gives ${versionPath} for ${region}, which is not a versioned ${offerCode} file of ${region}`);
		}
		resolved.push({ offerCode, url });
	}
	return resolved;
}

/**
 * Streams url to a new file at path, never holding it whole in memory, and
 * returns its size. Refuses an existing path, a failed response, and a body
 * whose size is not the Content-Length the response gave.
 */
export async function download(fetcher: Fetch, url: string, path: string): Promise<number> {
	const response = await fetcher(url, REQUEST);
	if (!response.ok || response.body === null) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
	const encoding = response.headers.get("content-encoding");
	if (encoding !== null && encoding !== "identity") throw new Error(`GET ${url}: came with Content-Encoding ${encoding}, not the bytes as stored`);
	const declared = response.headers.get("content-length");
	const descriptor = openSync(path, "wx", 0o644);
	let size = 0;
	try {
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			let at = 0;
			while (at < value.length) {
				const count = writeSync(descriptor, value, at, value.length - at);
				if (count <= 0) throw new Error(`GET ${url}: a write to ${path} wrote nothing`);
				at += count;
			}
			size += value.length;
		}
		const held = fstatSync(descriptor).size;
		if (held !== size) throw new Error(`GET ${url}: received ${size} bytes, and ${path} holds ${held}`);
	} finally {
		closeSync(descriptor);
	}
	if (declared !== null && Number(declared) !== size) throw new Error(`GET ${url}: received ${size} bytes, and Content-Length said ${declared}`);
	return size;
}
