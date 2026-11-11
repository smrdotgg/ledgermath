/**
 * Whether a price file is well formed: it validates against
 * schemas/prices.schema.json, and it holds together in the ways a schema
 * cannot say. Used by the fetch before it writes (scripts/fetch-prices.ts),
 * by the recompute check (scripts/check-prices.ts) and by the tests.
 *
 * Holding together means: the file is under the date it was fetched; each
 * source's URL is a versioned URL of the measured Region whose offer and
 * version are the source's, and the header the file copied agrees; every SKU
 * a selection lists is a product, every product was selected, and every
 * product has its On-Demand terms and nothing else does; each term is filed
 * under <sku>.<offerTermCode> and each price dimension under its rate code,
 * <sku>.<offerTermCode>.<code>. That is what makes "the file, the SKU and
 * the rate code" a citation that finds exactly one price.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

import { PRICE_FILE_PATH, type PriceFile, parseVersionedUrl, priceFilePath } from "./prices";

const ROOT = resolve(import.meta.dir, "..", "..");

let validator: ValidateFunction<PriceFile> | null = null;

/** schemas/prices.schema.json, compiled once. */
export function pricesValidator(): ValidateFunction<PriceFile> {
	if (validator === null) {
		const ajv = new Ajv2020({ strict: true, allErrors: true });
		validator = ajv.compile<PriceFile>(JSON.parse(readFileSync(join(ROOT, "schemas", "prices.schema.json"), "utf8")) as object);
	}
	return validator;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every way file fails the schema or does not hold together; empty when it is
 * well formed. path, when given, is the file's path in the Runs repository.
 */
export function checkPriceFile(file: unknown, path?: string): string[] {
	const validate = pricesValidator();
	if (!validate(file)) {
		return (validate.errors ?? []).map((error) => `schema: ${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
	}
	const problems: string[] = [];
	if (path !== undefined) {
		if (!PRICE_FILE_PATH.test(path)) problems.push(`${path} is not shaped prices/<yyyy>/<mm>/<dd>/aws.json`);
		else if (priceFilePath(new Date(file.fetched_at)) !== path) problems.push(`${path} is not under the UTC date it was fetched, ${file.fetched_at}`);
	}
	const types = file.measured.instance_types;
	if (types.some((type, i) => i > 0 && (types[i - 1] as string) >= type)) problems.push("measured.instance_types is not sorted and unique");

	const offers = new Set<string>();
	const rules = new Set<string>();
	for (const source of file.sources) {
		const where = `source ${source.offer_code}`;
		if (offers.has(source.offer_code)) problems.push(`${where} appears twice`);
		offers.add(source.offer_code);
		const url = parseVersionedUrl(source.url);
		if (url === null) problems.push(`${where}: ${source.url} is not a versioned offer file's URL`);
		else {
			if (url.offerCode !== source.offer_code) problems.push(`${where}: its URL is of the offer ${url.offerCode}`);
			if (url.version !== source.version) problems.push(`${where}: its URL is of version ${url.version}, not ${source.version}`);
			if (url.region !== file.measured.region) problems.push(`${where}: its URL is of the Region ${url.region}, not ${file.measured.region}`);
		}
		if (source.header.offerCode !== source.offer_code) problems.push(`${where}: its header's offerCode is ${JSON.stringify(source.header.offerCode)}`);
		if (source.header.version !== source.version) problems.push(`${where}: its header's version is ${JSON.stringify(source.header.version)}`);
		if (source.header.publicationDate !== source.publication_date) {
			problems.push(`${where}: its header's publicationDate is ${JSON.stringify(source.header.publicationDate)}`);
		}

		const selected = new Set<string>();
		for (const selection of source.selections) {
			if (rules.has(selection.rule)) problems.push(`${where}: rule ${selection.rule} appears twice`);
			rules.add(selection.rule);
			for (const sku of selection.skus) {
				selected.add(sku);
				if (!Object.hasOwn(source.products, sku)) problems.push(`${where}: rule ${selection.rule} selected ${sku}, which is not among the products`);
			}
		}
		for (const [sku, product] of Object.entries(source.products)) {
			if (!selected.has(sku)) problems.push(`${where}: products.${sku} was selected by no rule`);
			if (!isObject(product) || product.sku !== sku) problems.push(`${where}: products.${sku} has another sku`);
			if (!Object.hasOwn(source.terms.OnDemand, sku)) problems.push(`${where}: products.${sku} has no On-Demand terms`);
		}
		for (const [sku, terms] of Object.entries(source.terms.OnDemand)) {
			if (!Object.hasOwn(source.products, sku)) problems.push(`${where}: terms.OnDemand.${sku} belongs to no product in the file`);
			if (!isObject(terms)) continue;
			for (const [key, term] of Object.entries(terms)) {
				if (!isObject(term)) continue;
				if (term.sku !== sku || key !== `${sku}.${String(term.offerTermCode)}`) {
					problems.push(`${where}: terms.OnDemand.${sku}.${key} is not filed under <sku>.<offerTermCode> of its own sku`);
				}
				const dimensions = isObject(term.priceDimensions) ? term.priceDimensions : {};
				for (const [rateCode, dimension] of Object.entries(dimensions)) {
					if (!isObject(dimension) || dimension.rateCode !== rateCode || !rateCode.startsWith(`${key}.`)) {
						problems.push(`${where}: the price dimension ${rateCode} is not filed under its own rate code, <sku>.<offerTermCode>.<code>`);
					}
				}
			}
		}
	}
	return problems;
}
