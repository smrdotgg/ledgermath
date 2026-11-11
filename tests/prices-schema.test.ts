import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";

import { checkPriceFile, pricesValidator } from "../scripts/lib/price-file-check";
import type { PriceFile, PriceSource } from "../scripts/lib/prices";
import { SAMPLE_FILE, SAMPLE_PATH } from "./prices-fixtures";

// They compile the schema and read files; on a loaded machine that can take far longer than bun's five-second default.
setDefaultTimeout(60_000);

const validate = pricesValidator();

/** A fresh copy of the sample price file, to break in one place. */
const good = (): PriceFile => JSON.parse(readFileSync(SAMPLE_FILE, "utf8")) as PriceFile;
const ec2 = (file: PriceFile): PriceSource => file.sources[0] as PriceSource;
type Json = Record<string, unknown>;
/** The m5.large price dimension of the sample, to break. */
const m5Dimension = (file: PriceFile): Json =>
	(((ec2(file).terms.OnDemand["8D49XP354UEYTHGM"] as Json)["8D49XP354UEYTHGM.JRTCKXETXF"] as Json).priceDimensions as Json)[
		"8D49XP354UEYTHGM.JRTCKXETXF.6YS6EN2CT7"
	] as Json;

describe("the sample price file", () => {
	test("validates, and holds together", () => {
		const file = good();
		expect(validate(file)).toBe(true);
		expect(checkPriceFile(file, SAMPLE_PATH)).toEqual([]);
	});

	test("finds one price by its citation: the file, the SKU and the rate code", () => {
		const file = good();
		const sku = "8D49XP354UEYTHGM";
		const rateCode = "8D49XP354UEYTHGM.JRTCKXETXF.6YS6EN2CT7";
		const found = file.sources.flatMap((source) =>
			Object.values((source.terms.OnDemand[sku] ?? {}) as Record<string, { priceDimensions: Record<string, Json> }>).flatMap((term) =>
				term.priceDimensions[rateCode] === undefined ? [] : [{ product: source.products[sku] as { attributes: Record<string, string> }, dimension: term.priceDimensions[rateCode] }],
			),
		);
		expect(found.length).toBe(1);
		expect(found[0]?.product.attributes.instanceType).toBe("m5.large");
		expect(found[0]?.dimension).toEqual({
			rateCode,
			description: "$0.096 per On Demand Linux m5.large Instance Hour",
			beginRange: "0",
			endRange: "Inf",
			unit: "Hrs",
			pricePerUnit: { USD: "0.0960000000" },
			appliesTo: [],
		});
	});
});

describe("the price file schema rejects", () => {
	const rejects = (change: (file: PriceFile & Json) => void): void => {
		const file = good() as PriceFile & Json;
		change(file);
		expect(validate(file)).toBe(false);
		expect(checkPriceFile(file).length).toBeGreaterThan(0);
	};

	test("an unknown root key", () => rejects((file) => (file.prices = [])));
	test("a missing field", () => rejects((file) => delete (file as Partial<PriceFile>).fetched_at));
	test("another provider", () => rejects((file) => ((file as Json).provider = "gcp")));
	test("a fetch time without its milliseconds, or not in UTC", () => {
		rejects((file) => (file.fetched_at = "2026-11-11T03:17:42Z"));
		rejects((file) => (file.fetched_at = "2026-11-11T03:17:42.123+01:00"));
	});
	test("no instance types, or a Region that is a zone", () => {
		rejects((file) => (file.measured.instance_types = []));
		rejects((file) => (file.measured.region = "us-east-2c"));
	});
	test("another rule set's name, or no version", () => {
		rejects((file) => ((file.rules as Json).name = "my-rules"));
		rejects((file) => delete (file.rules as Partial<PriceFile["rules"]>).version);
	});
	test("no sources", () => rejects((file) => (file.sources = [])));
	test("a current URL, never a versioned one", () => rejects((file) => (ec2(file).url = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-2/index.json")));
	test("a version that is not 14 digits", () => rejects((file) => (ec2(file).version = "2026-11-10")));
	test("a bare hash without the sha256: prefix", () => rejects((file) => (ec2(file).sha256 = ec2(file).sha256.slice("sha256:".length))));
	test("a size of nothing", () => rejects((file) => (ec2(file).bytes = 0)));
	test("a header without AWS's version", () => rejects((file) => delete ec2(file).header.version));
	test("an unknown key in a source", () => rejects((file) => ((ec2(file) as unknown as Json).reserved = {})));
	test("a selection that selected nothing", () => rejects((file) => ((ec2(file).selections[0] as { skus: string[] }).skus = [])));
	test("no products, or no On-Demand terms", () => {
		rejects((file) => (ec2(file).products = {}));
		rejects((file) => (ec2(file).terms.OnDemand = {}));
		rejects((file) => ((ec2(file).terms as Json).Reserved = {}));
	});
	test("a product without its attributes, or with an attribute that is not a string", () => {
		rejects((file) => delete (ec2(file).products["8D49XP354UEYTHGM"] as Json).attributes);
		rejects((file) => (((ec2(file).products["8D49XP354UEYTHGM"] as Json).attributes as Json).vcpu = 2));
	});
	test("a term without price dimensions", () => rejects((file) => (((ec2(file).terms.OnDemand["8D49XP354UEYTHGM"] as Json)["8D49XP354UEYTHGM.JRTCKXETXF"] as Json).priceDimensions = {})));
	test("a price written as a number, not as AWS writes it", () => rejects((file) => (m5Dimension(file).pricePerUnit = { USD: 0.096 })));
	test("a price dimension without its unit", () => rejects((file) => delete m5Dimension(file).unit));
});

describe("a price file that validates still does not hold together when", () => {
	const problems = (change: (file: PriceFile) => void, path?: string): string[] => {
		const file = good();
		change(file);
		expect(validate(file)).toBe(true);
		return checkPriceFile(file, path);
	};

	test("a selection names a SKU that is not among the products", () => {
		expect(problems((file) => (ec2(file).selections[1] as { skus: string[] }).skus.push("ZZZZZZZZZZZZZZZZ"))).toEqual([
			"source AmazonEC2: rule ebs-gp3-storage selected ZZZZZZZZZZZZZZZZ, which is not among the products",
		]);
	});

	test("a product was selected by no rule, or has no On-Demand terms", () => {
		expect(problems((file) => delete ec2(file).terms.OnDemand.M6UGCCQ3CDJQAA37)).toEqual(["source AmazonEC2: products.M6UGCCQ3CDJQAA37 has no On-Demand terms"]);
		expect(
			problems((file) => {
				const selection = ec2(file).selections[1] as { rule: string; selects: string; skus: string[] };
				ec2(file).selections.splice(1, 1, { ...selection, rule: "ebs-gp3-storage", skus: ["M7SNV383JPWT8MVX"] });
			}),
		).toContainEqual("source AmazonEC2: products.M6UGCCQ3CDJQAA37 was selected by no rule");
	});

	test("a rate code is filed under another key, so a citation would not find it", () => {
		expect(
			problems((file) => {
				const dimensions = ((ec2(file).terms.OnDemand["8D49XP354UEYTHGM"] as Json)["8D49XP354UEYTHGM.JRTCKXETXF"] as Json).priceDimensions as Json;
				dimensions["8D49XP354UEYTHGM.JRTCKXETXF.OTHER"] = dimensions["8D49XP354UEYTHGM.JRTCKXETXF.6YS6EN2CT7"];
				delete dimensions["8D49XP354UEYTHGM.JRTCKXETXF.6YS6EN2CT7"];
			}),
		).toEqual([
			"source AmazonEC2: the price dimension 8D49XP354UEYTHGM.JRTCKXETXF.OTHER is not filed under its own rate code, <sku>.<offerTermCode>.<code>",
		]);
	});

	test("the header disagrees with the source, or the URL with the version", () => {
		expect(problems((file) => (ec2(file).header.publicationDate = "2026-11-09T00:00:00Z"))).toEqual([
			'source AmazonEC2: its header\'s publicationDate is "2026-11-09T00:00:00Z"',
		]);
		expect(problems((file) => (ec2(file).version = "20261029175634"))).toEqual([
			"source AmazonEC2: its URL is of version 20261110173852, not 20261029175634",
			'source AmazonEC2: its header\'s version is "20261110173852"',
		]);
	});

	test("it is not under the UTC date it was fetched", () => {
		expect(problems(() => {}, "prices/2026/11/12/aws.json")).toEqual(["prices/2026/11/12/aws.json is not under the UTC date it was fetched, 2026-11-11T03:17:42.123Z"]);
		expect(problems(() => {}, "prices/2026/11/11/gcp.json")).toEqual(["prices/2026/11/11/gcp.json is not shaped prices/<yyyy>/<mm>/<dd>/aws.json"]);
	});

	test("its instance types are not sorted", () => {
		expect(problems((file) => file.measured.instance_types.reverse())).toEqual(["measured.instance_types is not sorted and unique"]);
	});
});
