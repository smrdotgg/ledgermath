import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSchedule } from "../infra/runs/schedule";
import { checkPrices } from "../scripts/check-prices";
import { fetchPrices } from "../scripts/fetch-prices";
import { minifyJson, OfferFileError, parseVerbatim, scanOfferFile, type Span } from "../scripts/lib/offer-file";
import { checkPriceFile } from "../scripts/lib/price-file-check";
import { CURRENT_RULES, measuredFromSchedule, type Product, regionOfZone, RULE_SETS, type RuleSet } from "../scripts/lib/price-rules";
import {
	CutRefused,
	cutPrices,
	OFFER_INDEX_URL,
	type PriceFile,
	priceFilePath,
	PRICE_LIST_HOST,
	parseVersionedUrl,
	resolveSources,
	serializePriceFile,
	type SourceFile,
} from "../scripts/lib/prices";
import { FETCHED_AT, fakeFetch, MEASURED, regionIndex, SAMPLE_FILE, SAMPLE_PATH, SOURCES, sampleSources, sourceUrl, VERSIONS } from "./prices-fixtures";

const scratch = mkdtempSync(join(tmpdir(), "lm-prices-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = (name: string): string => {
	const directory = join(scratch, `${name}-${counter++}`);
	mkdirSync(directory, { recursive: true });
	return directory;
};

type Json = Record<string, unknown>;
/** An excerpt parsed whole: it is small. */
const offer = (offerCode: keyof typeof VERSIONS): { products: Record<string, Json>; terms: { OnDemand: Record<string, Json>; Reserved?: Record<string, Json> } } =>
	JSON.parse(readFileSync(join(SOURCES, `${offerCode}.json`), "utf8"));
const cutSample = (sources: SourceFile[] = sampleSources(), rules: RuleSet = CURRENT_RULES, measured = MEASURED): PriceFile =>
	cutPrices({ fetchedAt: FETCHED_AT, measured, rules, sources });
const sha256 = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A copy of the excerpts in a new directory, with one of them changed by edit. */
function editedSources(offerCode: keyof typeof VERSIONS, edit: (file: Json & ReturnType<typeof offer>) => void): SourceFile[] {
	const directory = fresh("sources");
	for (const source of sampleSources()) {
		const text = readFileSync(source.path, "utf8");
		if (source.offerCode !== offerCode) writeFileSync(join(directory, `${source.offerCode}.json`), text);
		else {
			const file = JSON.parse(text) as Json & ReturnType<typeof offer>;
			edit(file);
			writeFileSync(join(directory, `${source.offerCode}.json`), JSON.stringify(file, null, 2));
		}
	}
	return sampleSources(directory);
}

const refusal = (run: () => unknown): string[] => {
	try {
		run();
	} catch (error) {
		if (error instanceof CutRefused) return error.problems;
		throw error;
	}
	throw new Error("the cut did not refuse");
};

describe("reading an offer file", () => {
	const path = join(SOURCES, "AmazonEC2.json");
	const text = readFileSync(path, "utf8");
	const read = (chunkBytes?: number): { header: Span[]; products: Span[]; onDemand: Span[]; bytes: number } => {
		const found = { header: [] as Span[], products: [] as Span[], onDemand: [] as Span[], bytes: 0 };
		scanOfferFile(
			path,
			{
				header: (span) => found.header.push(span),
				product: (span) => found.products.push(span),
				onDemand: (span) => found.onDemand.push(span),
				bytes: (chunk) => {
					found.bytes += chunk.length;
				},
			},
			chunkBytes,
		);
		return found;
	};

	test("hands back the header, every product and every SKU's On-Demand terms as the file's own text, and skips Reserved terms", () => {
		const found = read();
		const parsed = offer("AmazonEC2");
		expect(found.header.map((span) => span.key)).toEqual(["formatVersion", "disclaimer", "offerCode", "version", "publicationDate", "attributesList"]);
		expect(found.products.map((span) => span.key)).toEqual(Object.keys(parsed.products));
		expect(found.onDemand.map((span) => span.key)).toEqual(Object.keys(parsed.terms.OnDemand));
		expect(Object.keys(parsed.terms.Reserved ?? {}).length).toBe(1);
		for (const span of [...found.products, ...found.onDemand]) expect(text.includes(span.text)).toBe(true);
		for (const span of found.products) expect(JSON.parse(span.text)).toEqual(parsed.products[span.key] as Json);
		expect(found.bytes).toBe(statSync(path).size);
	});

	test("gives the same, whatever the boundaries between the pieces it reads", () => {
		const whole = read();
		for (const chunkBytes of [1, 7, 64, 4096]) expect(read(chunkBytes)).toEqual(whole);
	});

	const bad = (name: string, content: string | Uint8Array): string => {
		const file = join(fresh("bad"), name);
		writeFileSync(file, content);
		return file;
	};

	test("refuses whatever a standard JSON parser refuses, saying what and where", () => {
		const cases: Array<[string, string, RegExp]> = [
			["ends early", text.slice(0, Math.floor(text.length / 2)), /ends inside/],
			["nothing", "", /holds no top-level object/],
			["only whitespace", " \n", /holds no top-level object/],
			["a byte-order mark", "﻿{}", /holds something other than one object/],
			["two objects", "{} {}", /holds something after its top-level object/],
			["something after", "{} x", /holds something after its top-level object/],
			["the wrong bracket", '{"products": {]}', /a \] where JSON does not allow one \(at byte 14\)/],
			["no colon", '{"products" {}}', /an object where JSON does not allow one/],
			["no comma", '{"a": "x" "b": "y"}', /a string where JSON does not allow one/],
			["a trailing comma", '{"a": "x",}', /a \} where JSON does not allow one/],
			["two commas", '{"a": ["x",,"y"]}', /a comma where JSON does not allow one/],
			["a key that is not a string", "{a: 1}", /the byte 0x61 where JSON does not allow it/],
			["a single quote", "{'a': 1}", /the byte 0x27 where JSON does not allow it/],
			["a misspelt literal", '{"a": tru}', /"tru" is not a JSON number, true, false or null/],
			["a leading zero", '{"a": 01}', /"01" is not a JSON number/],
			["a bare dot", '{"a": 1.}', /"1\." is not a JSON number/],
			["a plus sign", '{"a": +1}', /the byte 0x2b where JSON does not allow it/],
			["a raw newline in a string", '{"a": "x\ny"}', /a control character JSON requires escaped/],
			["an unknown escape", '{"a": "\\x"}', /an escape JSON does not have/],
			["a short \\u escape", '{"a": "\\u12G4"}', /four hex digits/],
		];
		const outcome = (content: string, message: RegExp): { reader: string; parser: string } => {
			const file = bad("grammar.json", content);
			let reader = "accepted";
			try {
				scanOfferFile(file, {});
			} catch (error) {
				reader = message.test(String(error)) ? "refused as expected" : String(error);
			}
			let parser = "accepted";
			try {
				JSON.parse(readFileSync(file, "utf8"));
			} catch {
				parser = "refused";
			}
			return { reader, parser };
		};
		for (const [what, content, message] of cases) {
			// The reference: JavaScript's own parser refuses each of these too.
			expect({ what, ...outcome(content, message) }).toEqual({ what, reader: "refused as expected", parser: "refused" });
		}
		// JSON, but not one object: not an offer file.
		for (const content of ["[1, 2]", '"abc"', "5"]) {
			expect({ content, ...outcome(content, /holds something other than one object/) }).toEqual({ content, reader: "refused as expected", parser: "accepted" });
		}
		// Bytes that are not UTF-8, inside a string: refused (a decoder that replaces them would hide them).
		for (const bytes of [[0xc3, 0x28], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xff]]) {
			const file = bad(`utf8-${bytes.join("-")}.json`, new Uint8Array([...new TextEncoder().encode('{"a": "'), ...bytes, ...new TextEncoder().encode('"}')]));
			expect(() => scanOfferFile(file, {})).toThrow(/a string is not UTF-8/);
		}
	});

	test("accepts what JSON allows, and hands back what a standard parser reads", () => {
		const valid = '{\t"formatVersion" :"v1.0" ,\r\n "n": -1.5e+3, "z": 0, "e": 2E-2, "t": true, "f": false, "nothing": null,'
			+ ' "esc": "a\\"b\\\\c\\/d\\b\\f\\n\\r\\t\\u00e9\\uD83D\\uDE00", "utf8": "é – 😀", "nested": [[], {}, [1, {"k": [null]}]],'
			+ ' "products": {"A": {"sku": "A", "attributes": {"x": "1"}}}, "terms": {"OnDemand": {"A": {"A.T": {}}}, "Reserved": {}}, "attributesList" : { } }';
		const header: Record<string, unknown> = {};
		const products: string[] = [];
		const onDemand: string[] = [];
		const file = bad("valid.json", valid);
		for (const chunkBytes of [1, 3, 4096]) {
			scanOfferFile(file, { header: (span) => (header[span.key] = JSON.parse(span.text)), product: (span) => products.push(span.text), onDemand: (span) => onDemand.push(span.text) }, chunkBytes);
		}
		const parsed = JSON.parse(valid) as Record<string, unknown>;
		const { products: _p, terms: _t, ...rest } = parsed;
		expect(header).toEqual(rest);
		expect(products.map((span) => JSON.parse(span))).toEqual(Array(3).fill((parsed.products as Record<string, unknown>).A));
		expect(onDemand.map((span) => JSON.parse(span))).toEqual(Array(3).fill(((parsed.terms as Record<string, Record<string, unknown>>).OnDemand as Record<string, unknown>).A));
	});

	test("refuses a product, a SKU's terms, products, terms or a kind of terms that is not an object", () => {
		const refuses = (content: string, message: RegExp): void => expect(() => scanOfferFile(bad("shape.json", content), {})).toThrow(message);
		refuses('{"products": {"A": "x"}, "terms": {}}', /products\.A is not an object/);
		refuses('{"products": {"A": []}, "terms": {}}', /products\.A is not an object/);
		refuses('{"products": {}, "terms": {"OnDemand": {"A": 5}}}', /terms\.OnDemand\.A is not an object/);
		refuses('{"products": [], "terms": {}}', /products is not an object/);
		refuses('{"products": {}, "terms": "none"}', /terms is not an object/);
		refuses('{"products": {}, "terms": {"OnDemand": []}}', /terms\.OnDemand is not an object/);
	});

	test("refuses a key a standard parser would keep only the last of: at the top level, under products or terms, or a SKU under a kind of terms", () => {
		const refuses = (content: string, message: string): void => {
			const file = bad("repeated.json", content);
			expect(() => scanOfferFile(file, {})).toThrow(`the key ${message}; a standard JSON parser would keep only the last`);
			expect(() => JSON.parse(content)).not.toThrow();
		};
		refuses('{"products": {"A": {}}, "terms": {}, "products": {}}', '"products" appears twice in the top level');
		refuses('{"version": "1", "version": "2", "products": {}, "terms": {}}', '"version" appears twice in the top level');
		refuses('{"products": {"A": {}, "B": {}, "A": {}}, "terms": {}}', '"A" appears twice in products');
		refuses('{"products": {}, "terms": {"OnDemand": {}, "OnDemand": {}}}', '"OnDemand" appears twice in terms');
		refuses('{"products": {}, "terms": {"OnDemand": {"A": {}, "A": {}}}}', '"A" appears twice in terms.OnDemand');
		refuses('{"products": {}, "terms": {"Reserved": {"A": {}, "A": {}}}}', '"A" appears twice in terms.Reserved');
		// The same key written two ways is the same key.
		refuses('{"products": {"A": {}, "\\u0041": {}}, "terms": {}}', '"A" appears twice in products');
		// A key may repeat in different objects.
		expect(() => scanOfferFile(bad("fine.json", '{"products": {"A": {}}, "terms": {"OnDemand": {"A": {}}, "Reserved": {"A": {}}}}'), {})).not.toThrow();
	});

	test("keeps a value only if it can be written back as the file has it", () => {
		const keep = (text: string): unknown => parseVerbatim({ key: "K", text }, "test");
		expect(keep('{ "a" : [ ], "b" : { }, "c" : "x y" }')).toEqual({ a: [], b: {}, c: "x y" });
		expect(minifyJson('{ "a b" : [ 1, 2 ] }')).toBe('{"a b":[1,2]}');
		// A key shaped like an array index moves to the front when parsed.
		expect(() => keep('{"b": "1", "2": "x"}')).toThrow(/cannot be kept verbatim/);
		// A number loses its written form.
		expect(() => keep('{"a": 1.50}')).toThrow(/cannot be kept verbatim/);
		// An escape is written back differently.
		expect(() => keep('{"a": "\\u0041"}')).toThrow(/cannot be kept verbatim/);
		expect(() => keep('{"a": ')).toThrow(/is not JSON/);
	});
});

describe("the rules", () => {
	const ec2 = offer("AmazonEC2").products;
	const s3 = offer("AmazonS3").products;
	const transfer = offer("AWSDataTransfer").products;
	const rule = (name: string) => {
		const found = CURRENT_RULES.rules.find((candidate) => candidate.name === name);
		if (found === undefined) throw new Error(`no rule ${name}`);
		return found;
	};
	const product = (from: Record<string, Json>, sku: string): Product => from[sku] as unknown as Product;
	const changed = (base: Product, change: Partial<Product> & { attributes?: Record<string, string> }): Product => ({
		...base,
		...change,
		attributes: { ...base.attributes, ...(change.attributes ?? {}) },
	});

	test("each one has a unique name, and every rule set a stored file may name is kept", () => {
		const names = CURRENT_RULES.rules.map((candidate) => candidate.name);
		expect(new Set(names).size).toBe(names.length);
		expect(RULE_SETS.get(CURRENT_RULES.version)).toBe(CURRENT_RULES);
		expect([...RULE_SETS.keys()]).toEqual([1]);
	});

	test("take what is measured from the schedule: its instance types, sorted, and the Region of its one zone", () => {
		const schedule = parseSchedule(JSON.parse(readFileSync(join(import.meta.dir, "..", "schedule.json"), "utf8")));
		const measured = measuredFromSchedule(schedule);
		expect(measured.instance_types).toEqual([...new Set(schedule.targets.map((target) => target.instance_type))].sort());
		expect(measured.region).toBe(regionOfZone(schedule.targets[0]?.zone as string));
		expect(regionOfZone("us-east-2c")).toBe("us-east-2");
		expect(() => regionOfZone("us-east-2")).toThrow();
		const twoRegions = structuredClone(schedule);
		(twoRegions.targets[0] as { zone: string }).zone = "us-west-2a";
		expect(() => measuredFromSchedule(twoRegions)).toThrow(/2 Regions/);
	});

	// Every condition of every rule, one at a time: the real record matches, and the record with that one thing changed does not.
	const cases: Array<[string, Product, Array<Partial<Product> & { attributes?: Record<string, string> }>]> = [
		[
			"ec2-instance-on-demand-linux",
			product(ec2, "8D49XP354UEYTHGM"),
			[
				{ productFamily: "Dedicated Host" },
				{ attributes: { instanceType: "c8i.2xlarge" } },
				{ attributes: { regionCode: "us-east-1" } },
				{ attributes: { locationType: "AWS Local Zone" } },
				{ attributes: { operatingSystem: "Windows" } },
				{ attributes: { tenancy: "Dedicated" } },
				{ attributes: { preInstalledSw: "SQL Web" } },
				{ attributes: { licenseModel: "Bring your own license" } },
				{ attributes: { capacitystatus: "UnusedCapacityReservation" } },
				{ attributes: { operation: "RunInstances:0002" } },
			],
		],
		[
			"ebs-gp3-storage",
			product(ec2, "M6UGCCQ3CDJQAA37"),
			[{ productFamily: "Storage Snapshot" }, { attributes: { volumeApiName: "gp2" } }, { attributes: { regionCode: "us-east-1" } }],
		],
		[
			"ebs-gp3-iops",
			product(ec2, "M7SNV383JPWT8MVX"),
			[
				{ productFamily: "Storage" },
				{ attributes: { volumeApiName: "io2" } },
				{ attributes: { group: "EBS IOPS Tier 2" } },
				{ attributes: { regionCode: "us-east-1" } },
			],
		],
		[
			"ebs-gp3-throughput",
			product(ec2, "KZJJ34U6VU5DJ9CM"),
			[{ productFamily: "Storage" }, { attributes: { volumeApiName: "st1" } }, { attributes: { group: "EBS IOPS" } }, { attributes: { regionCode: "us-east-1" } }],
		],
		[
			"s3-standard-storage",
			product(s3, "YPGKVRB2EKTVDJDT"),
			[
				{ productFamily: "API Request" },
				{ attributes: { storageClass: "Infrequent Access" } },
				{ attributes: { volumeType: "Annotations" } },
				{ attributes: { usagetype: "USE2-Annotation-TimedStorage-ByteHrs" } },
				{ attributes: { regionCode: "us-east-1" } },
			],
		],
		[
			"s3-standard-requests",
			product(s3, "GJKK9PMSTKPNGZS9"),
			[
				{ productFamily: "Storage" },
				{ attributes: { group: "S3-API-SIA-Tier1" } },
				{ attributes: { usagetype: "USE2-Requests-Annotation-Tier1" } },
				{ attributes: { usagetype: "USE2-Requests-Tier2" } },
				{ attributes: { regionCode: "us-east-1" } },
			],
		],
		[
			"data-transfer-out-to-internet",
			product(transfer, "36H7S3NU9B7S3UT5"),
			[
				{ productFamily: "Fee" },
				{ attributes: { transferType: "Inter Region Peering Data Transfer Outbound" } },
				{ attributes: { fromRegionCode: "us-east-1" } },
				{ attributes: { fromLocationType: "AWS Local Zone" } },
				{ attributes: { toLocation: "Amazon CloudFront" } },
				{ attributes: { usagetype: "USE2-DataTransfer-Out-ABytes" } },
			],
		],
		[
			"data-transfer-out-to-internet-global-free-tier",
			product(transfer, "PB257JUQ8U6E6UPM"),
			[
				{ productFamily: "Fee" },
				{ attributes: { transferType: "AWS Inbound" } },
				{ attributes: { fromLocation: "US East (Ohio)" } },
				{ attributes: { toLocation: "Amazon CloudFront" } },
				{ attributes: { usagetype: "USE2-DataTransfer-Out-Bytes" } },
			],
		],
	];
	for (const [name, base, changes] of cases) {
		test(`${name}: matches its real record, and not that record with any one of its conditions broken`, () => {
			expect(rule(name).matches(base, MEASURED)).toBe(true);
			for (const change of changes) expect({ change, matches: rule(name).matches(changed(base, change), MEASURED) }).toEqual({ change, matches: false });
		});
	}

	test("every rule is exercised above", () => {
		expect(cases.map(([name]) => name).sort()).toEqual(CURRENT_RULES.rules.map((candidate) => candidate.name).sort());
	});
});

describe("the cut of the hand-made sources", () => {
	const file = cutSample();
	const selected = Object.fromEntries(file.sources.flatMap((source) => source.selections.map((selection) => [selection.rule, selection.skus])));

	test("each rule selects exactly its records, in the file's order, and nothing else is kept", () => {
		expect(selected).toEqual({
			"ec2-instance-on-demand-linux": ["8ESS9QXCJT48TMPH", "8D49XP354UEYTHGM", "NKB8DU47ZKKBXW65"],
			"ebs-gp3-storage": ["M6UGCCQ3CDJQAA37"],
			"ebs-gp3-iops": ["M7SNV383JPWT8MVX"],
			"ebs-gp3-throughput": ["KZJJ34U6VU5DJ9CM"],
			"s3-standard-storage": ["YPGKVRB2EKTVDJDT"],
			"s3-standard-requests": ["GJKK9PMSTKPNGZS9", "DJEKB32FV4HNZJZY"],
			"data-transfer-out-to-internet": ["36H7S3NU9B7S3UT5"],
			"data-transfer-out-to-internet-global-free-tier": ["PB257JUQ8U6E6UPM"],
		});
		for (const source of file.sources) {
			const kept = new Set(source.selections.flatMap((selection) => selection.skus));
			// Products and terms in the offer file's order.
			const inFileOrder = Object.keys(offer(source.offer_code as keyof typeof VERSIONS).products).filter((sku) => kept.has(sku));
			expect(Object.keys(source.products)).toEqual(inFileOrder);
			expect(Object.keys(source.terms.OnDemand)).toEqual(inFileOrder);
		}
		expect(file.sources.map((source) => source.offer_code)).toEqual(["AmazonEC2", "AmazonS3", "AWSDataTransfer"]);
		expect(file.rules).toEqual({ name: "ledgermath.aws-price-rules", version: 1 });
		expect(file.measured).toEqual(MEASURED);
	});

	test("keeps each record verbatim: AWS's own product and On-Demand terms, keys in their order, and no Reserved terms", () => {
		for (const source of file.sources) {
			const original = offer(source.offer_code as keyof typeof VERSIONS);
			for (const sku of Object.keys(source.products)) {
				expect(JSON.stringify(source.products[sku])).toBe(JSON.stringify(original.products[sku]));
				expect(JSON.stringify(source.terms.OnDemand[sku])).toBe(JSON.stringify(original.terms.OnDemand[sku]));
			}
		}
		expect(serializePriceFile(file)).not.toContain("Reserved");
		expect(serializePriceFile(file)).not.toContain("NQ3QZPMQV9"); // an offer term code of the Reserved terms
	});

	test("names each source by its versioned URL, its own version and publication date, and the size and SHA-256 of its bytes", () => {
		for (const source of file.sources) {
			const path = join(SOURCES, `${source.offer_code}.json`);
			const bytes = readFileSync(path);
			const header = JSON.parse(bytes.toString("utf8")) as Json;
			expect(source.url).toBe(sourceUrl(source.offer_code as keyof typeof VERSIONS));
			expect(parseVersionedUrl(source.url)?.version).toBe(source.version);
			expect(source.version).toBe(header.version as string);
			expect(source.publication_date).toBe(header.publicationDate as string);
			expect(source.bytes).toBe(bytes.length);
			expect(source.sha256).toBe(sha256(bytes));
			expect(source.header).toEqual({
				formatVersion: header.formatVersion,
				disclaimer: header.disclaimer,
				offerCode: header.offerCode,
				version: header.version,
				publicationDate: header.publicationDate,
				attributesList: {},
			});
		}
	});

	test("is the sample price file, byte for byte, and the same bytes every time", () => {
		const text = serializePriceFile(file);
		expect(text).toBe(readFileSync(SAMPLE_FILE, "utf8"));
		expect(serializePriceFile(cutSample())).toBe(text);
		// Copied elsewhere, the same sources give the same file.
		const elsewhere = fresh("copies");
		for (const source of sampleSources()) writeFileSync(join(elsewhere, `${source.offerCode}.json`), readFileSync(source.path));
		expect(serializePriceFile(cutSample(sampleSources(elsewhere)))).toBe(text);
		// Only the fetch time is not an input that comes from the sources.
		const later = serializePriceFile(cutPrices({ fetchedAt: new Date("2026-11-12T00:00:00.000Z"), measured: MEASURED, rules: CURRENT_RULES, sources: sampleSources() }));
		expect(later.replace('"2026-11-12T00:00:00.000Z"', `"${FETCHED_AT.toISOString()}"`)).toBe(text);
		expect(checkPriceFile(file, SAMPLE_PATH)).toEqual([]);
	});

	test("stops, naming the rule, when a rule selects nothing", () => {
		const problems = refusal(() =>
			cutSample(
				editedSources("AmazonS3", (source) => {
					delete source.products.YPGKVRB2EKTVDJDT;
				}),
			),
		);
		expect(problems).toEqual([expect.stringContaining("rule s3-standard-storage selected 0 products, and must select exactly 1")]);
	});

	test("stops when a measured instance type has no record, or has two", () => {
		const missing = refusal(() => cutSample(sampleSources(), CURRENT_RULES, { ...MEASURED, instance_types: [...MEASURED.instance_types, "c8a.2xlarge"].sort() }));
		expect(missing).toEqual([expect.stringContaining("c8a.2xlarge: 0 products")]);
		const twice = refusal(() =>
			cutSample(
				editedSources("AmazonEC2", (source) => {
					const copy = structuredClone(source.products["8D49XP354UEYTHGM"]) as Json;
					copy.sku = "ZZZZZZZZZZZZZZZZ";
					source.products.ZZZZZZZZZZZZZZZZ = copy;
					source.terms.OnDemand.ZZZZZZZZZZZZZZZZ = structuredClone(source.terms.OnDemand["8D49XP354UEYTHGM"]) as Json;
				}),
			),
		);
		expect(twice).toEqual([expect.stringContaining("m5.large: 2 products")]);
	});

	test("stops when a rule selects more than it may", () => {
		const problems = refusal(() =>
			cutSample(
				editedSources("AWSDataTransfer", (source) => {
					const copy = structuredClone(source.products["36H7S3NU9B7S3UT5"]) as Json & { attributes: Json };
					copy.sku = "YYYYYYYYYYYYYYYY";
					source.products.YYYYYYYYYYYYYYYY = copy;
					source.terms.OnDemand.YYYYYYYYYYYYYYYY = structuredClone(source.terms.OnDemand["36H7S3NU9B7S3UT5"]) as Json;
				}),
			),
		);
		expect(problems).toEqual([expect.stringContaining("rule data-transfer-out-to-internet selected 2 products, and must select exactly 1")]);
	});

	test("stops when a selected product has no On-Demand terms", () => {
		const problems = refusal(() =>
			cutSample(
				editedSources("AmazonEC2", (source) => {
					delete source.terms.OnDemand.M7SNV383JPWT8MVX;
				}),
			),
		);
		expect(problems).toEqual([expect.stringContaining("products.M7SNV383JPWT8MVX was selected and has no On-Demand terms")]);
	});

	test("stops when a file is not what its URL says, listing every problem at once", () => {
		const sources = sampleSources().map((source) =>
			source.offerCode === "AmazonS3" ? { ...source, url: sourceUrl("AmazonS3", "20261001000000") } : source.offerCode === "AWSDataTransfer" ? { ...source, url: sourceUrl("AWSDataTransfer", undefined, "eu-west-1") } : source,
		);
		const problems = refusal(() => cutSample(sources));
		expect(problems).toContainEqual(expect.stringContaining('the file\'s version "20261109154310" is not its URL\'s 20261001000000'));
		expect(problems).toContainEqual(expect.stringContaining("its URL names the Region eu-west-1, not us-east-2"));
		const current = refusal(() =>
			cutSample(sampleSources().map((source) => (source.offerCode === "AmazonEC2" ? { ...source, url: `${PRICE_LIST_HOST}/offers/v1.0/aws/AmazonEC2/current/us-east-2/index.json` } : source))),
		);
		expect(current).toContainEqual(expect.stringContaining("its URL is not a versioned offer file's URL"));
		const swapped = refusal(() =>
			cutSample(sampleSources().map((source) => (source.offerCode === "AmazonS3" ? { ...source, path: join(SOURCES, "AWSDataTransfer.json") } : source))),
		);
		expect(swapped).toContainEqual(expect.stringContaining('the file\'s offerCode is "AWSDataTransfer"'));
		expect(refusal(() => cutSample(sampleSources().slice(0, 2)))).toEqual(["AWSDataTransfer: 0 source files given, and the rules read exactly one"]);
	});
});

describe("a source a standard JSON parser reads differently", () => {
	const ec2Text = readFileSync(join(SOURCES, "AmazonEC2.json"), "utf8");
	/** The excerpts, with the EC2 one's text changed by edit. */
	const ec2Edited = (edit: (text: string) => string): SourceFile[] => {
		const directory = fresh("sources");
		for (const source of sampleSources()) writeFileSync(join(directory, `${source.offerCode}.json`), readFileSync(source.path));
		const changed = edit(ec2Text);
		expect(changed).not.toBe(ec2Text);
		writeFileSync(join(directory, "AmazonEC2.json"), changed);
		return sampleSources(directory);
	};
	/** text with insert put just after the first occurrence of anchor at or after the first occurrence of after. */
	const insertAfter = (text: string, anchor: string, insert: string, after = ""): string => {
		const at = text.indexOf(anchor, text.indexOf(after));
		if (at < 0) throw new Error(`no ${anchor}`);
		return text.slice(0, at + anchor.length) + insert + text.slice(at + anchor.length);
	};
	/** The reviewer's case: products and terms again, empty, at the end. A standard parser sees no products. */
	const repeatedAtTheEnd = (text: string): string => `${text.trimEnd().slice(0, -1)},"products":{},"terms":{}}`;

	test("the reviewer's case: products and terms repeated at the end, which a standard parser reads as empty, stops the cut", () => {
		const sources = ec2Edited(repeatedAtTheEnd);
		expect(Object.keys((JSON.parse(readFileSync((sources[0] as SourceFile).path, "utf8")) as { products: object }).products)).toEqual([]);
		expect(refusal(() => cutSample(sources))).toEqual([
			expect.stringMatching(/^AmazonEC2 \(https:.*\): .*AmazonEC2\.json: the key "products" appears twice in the top level; a standard JSON parser would keep only the last \(at byte \d+\)$/),
		]);
	});

	const insideKept: Array<[string, (text: string) => string, string]> = [
		[
			"a SKU repeated under products",
			(text) => insertAfter(text, '"products" : {', '"W2MK87PHAESV3EZK" : {"sku":"W2MK87PHAESV3EZK","attributes":{}},'),
			'the key "W2MK87PHAESV3EZK" appears twice in products',
		],
		["a kind of terms repeated", (text) => insertAfter(text, '"terms" : {', '"OnDemand" : {},'), 'the key "OnDemand" appears twice in terms'],
		[
			"a SKU repeated under terms.OnDemand",
			(text) => insertAfter(text, '"OnDemand" : {', '"M7SNV383JPWT8MVX" : {},'),
			'the key "M7SNV383JPWT8MVX" appears twice in terms.OnDemand',
		],
		[
			"an offer term code repeated in a selected SKU's terms",
			(text) =>
				insertAfter(
					text,
					'"M7SNV383JPWT8MVX" : {',
					'"M7SNV383JPWT8MVX.JRTCKXETXF" : {"offerTermCode":"JRTCKXETXF","sku":"M7SNV383JPWT8MVX","effectiveDate":"2020-01-01T00:00:00Z","priceDimensions":{},"termAttributes":{}},',
					'"OnDemand" : {',
				),
			'the key "M7SNV383JPWT8MVX.JRTCKXETXF" appears twice in one object under "M7SNV383JPWT8MVX"',
		],
		[
			"a rate code repeated",
			(text) =>
				insertAfter(
					text,
					'"priceDimensions" : {',
					'"M7SNV383JPWT8MVX.JRTCKXETXF.6YS6EN2CT7" : {"rateCode":"M7SNV383JPWT8MVX.JRTCKXETXF.6YS6EN2CT7","unit":"IOPS-Mo","pricePerUnit":{"USD":"0.0010000000"}},',
					'"M7SNV383JPWT8MVX.JRTCKXETXF" : {',
				),
			'the key "M7SNV383JPWT8MVX.JRTCKXETXF.6YS6EN2CT7" appears twice in one object under "M7SNV383JPWT8MVX" > "M7SNV383JPWT8MVX.JRTCKXETXF" > "priceDimensions"',
		],
		[
			"an attribute repeated in a selected product",
			(text) => insertAfter(text, '"attributes" : {', '"volumeApiName" : "io2",', '"M7SNV383JPWT8MVX" : {'),
			'the key "volumeApiName" appears twice in one object under "M7SNV383JPWT8MVX" > "attributes"',
		],
	];
	for (const [what, edit, message] of insideKept) {
		test(`${what} stops the cut, though a standard parser would read it`, () => {
			const sources = ec2Edited(edit);
			expect(() => JSON.parse(readFileSync((sources[0] as SourceFile).path, "utf8"))).not.toThrow();
			const problems = refusal(() => cutSample(sources));
			expect(problems.length).toBe(1);
			expect(problems[0]).toContain(message);
		});
	}

	test("stops the fetch, which writes nothing, and fails the recompute check of a file certified from it", async () => {
		const tampered = (ec2Edited(repeatedAtTheEnd)[0] as SourceFile).path;
		const repository = fresh("repository");
		const work = fresh("work");
		const schedule = parseSchedule({
			vcpu_quota: { limit: 64, reserved_outside_schedule: 4 },
			targets: MEASURED.instance_types.map((type, i) => ({ instance_type: type, vcpus: 2, zone: "us-east-2c", boots_utc: [`0${i}:10`] })),
			benchmarks: [{ name: "syscall", builds: ["static"], samples: 10, timeout_seconds: 120, params: [{ call: "getpid" }] }],
		});
		const served = fakeFetch({ [sourceUrl("AmazonEC2")]: { file: tampered } });
		await expect(fetchPrices({ repository, work, schedule, now: FETCHED_AT, fetcher: served.fetch, log: () => {} })).rejects.toThrow(/the key "products" appears twice in the top level/);
		expect(readdirSync(repository)).toEqual([]);

		// A file certified from the tampered source before the reader refused it: its hash is that source's, and the check still refuses it.
		const stored = JSON.parse(readFileSync(SAMPLE_FILE, "utf8")) as PriceFile;
		const bytes = readFileSync(tampered);
		const ec2 = stored.sources[0] as PriceFile["sources"][number];
		ec2.bytes = bytes.length;
		ec2.sha256 = sha256(bytes);
		const directory = fresh("certified");
		writeFileSync(join(directory, "aws.json"), serializePriceFile(stored));
		const result = await checkPrices({ path: join(directory, "aws.json"), work: fresh("work"), fetcher: served.fetch, log: () => {} });
		expect(result.problems).toEqual([expect.stringMatching(/^the recut stopped: AmazonEC2 .*the key "products" appears twice in the top level/)]);
	});

	test("the recompute check refuses a price file that repeats a key itself", async () => {
		const text = readFileSync(SAMPLE_FILE, "utf8");
		const directory = fresh("repeated");
		writeFileSync(join(directory, "aws.json"), text.replace('"provider": "aws",', '"provider": "aws",\n  "provider": "aws",'));
		const result = await checkPrices({ path: join(directory, "aws.json"), work: fresh("work"), fetcher: fakeFetch().fetch, log: () => {} });
		expect(result.problems).toEqual(['the key "provider" appears twice in one object, under the top level']);
	});
});

describe("the fetch", () => {
	const schedule = parseSchedule({
		vcpu_quota: { limit: 64, reserved_outside_schedule: 4 },
		targets: MEASURED.instance_types.map((type, i) => ({ instance_type: type, vcpus: 2, zone: "us-east-2c", boots_utc: [`0${i}:10`] })),
		benchmarks: [{ name: "syscall", builds: ["static"], samples: 10, timeout_seconds: 120, params: [{ call: "getpid" }] }],
	});
	const quiet = (): void => {};

	test("follows the offer index and region indexes to the versioned files, and refuses a current URL", async () => {
		const fake = fakeFetch();
		expect(await resolveSources(fake.fetch, CURRENT_RULES, "us-east-2")).toEqual(sampleSources().map(({ offerCode, url }) => ({ offerCode, url })));
		expect(fake.requests[0]).toBe(OFFER_INDEX_URL);
		const current = fakeFetch({
			[`${PRICE_LIST_HOST}/offers/v1.0/aws/AmazonS3/current/region_index.json`]: {
				json: regionIndex("AmazonS3", { "us-east-2": "/offers/v1.0/aws/AmazonS3/current/us-east-2/index.json" }),
			},
		});
		await expect(resolveSources(current.fetch, CURRENT_RULES, "us-east-2")).rejects.toThrow(/not a versioned AmazonS3 file of us-east-2/);
		await expect(resolveSources(fakeFetch().fetch, CURRENT_RULES, "ap-south-2")).rejects.toThrow(/names no file for ap-south-2/);
	});

	test("adds the day's file once; run again that day, it downloads nothing and adds nothing", async () => {
		const repository = fresh("repository");
		const work = fresh("work");
		const fake = fakeFetch();
		const first = await fetchPrices({ repository, work, schedule, now: FETCHED_AT, fetcher: fake.fetch, log: quiet });
		expect(first.outcome).toBe("added");
		const path = join(repository, SAMPLE_PATH);
		expect(readFileSync(path, "utf8")).toBe(readFileSync(SAMPLE_FILE, "utf8"));
		expect(readdirSync(work)).toEqual([]); // the downloads are gone
		expect(lstatSync(path).isFile()).toBe(true);
		expect(readdirSync(join(repository, "prices", "2026", "11", "11"))).toEqual(["aws.json"]); // no temporary file left

		const before = statSync(path).mtimeMs;
		const again = fakeFetch();
		const second = await fetchPrices({ repository, work, schedule, now: new Date("2026-11-11T15:17:00.000Z"), fetcher: again.fetch, log: quiet });
		expect(second).toEqual({ outcome: "exists", path: SAMPLE_PATH });
		expect(again.requests).toEqual([]);
		expect(statSync(path).mtimeMs).toBe(before);

		const nextDay = await fetchPrices({ repository, work, schedule, now: new Date("2026-11-12T03:17:00.000Z"), fetcher: fakeFetch().fetch, log: quiet });
		expect(nextDay.outcome).toBe("added");
		expect(existsSync(join(repository, "prices/2026/11/12/aws.json"))).toBe(true);
	});

	test("never overwrites: a file already there stays as it is, whatever it holds", async () => {
		const repository = fresh("repository");
		mkdirSync(join(repository, "prices/2026/11/11"), { recursive: true });
		writeFileSync(join(repository, SAMPLE_PATH), "not a price file\n");
		const result = await fetchPrices({ repository, work: fresh("work"), schedule, now: FETCHED_AT, fetcher: fakeFetch().fetch, log: quiet });
		expect(result.outcome).toBe("exists");
		expect(readFileSync(join(repository, SAMPLE_PATH), "utf8")).toBe("not a price file\n");
	});

	test("never replaces a file that appears while it fetches", async () => {
		const repository = fresh("repository");
		const fake = fakeFetch({
			[sourceUrl("AWSDataTransfer")]: {
				respond: () => {
					mkdirSync(join(repository, "prices/2026/11/11"), { recursive: true });
					writeFileSync(join(repository, SAMPLE_PATH), "written meanwhile\n");
					const bytes = readFileSync(join(SOURCES, "AWSDataTransfer.json"));
					return new Response(bytes, { headers: { "Content-Length": String(bytes.length) } });
				},
			},
		});
		const result = await fetchPrices({ repository, work: fresh("work"), schedule, now: FETCHED_AT, fetcher: fake.fetch, log: quiet });
		expect(result.outcome).toBe("appeared");
		expect(readFileSync(join(repository, SAMPLE_PATH), "utf8")).toBe("written meanwhile\n");
	});

	test("refuses to write through a symbolic link", async () => {
		const repository = fresh("repository");
		const elsewhere = fresh("elsewhere");
		symlinkSync(elsewhere, join(repository, "prices"));
		await expect(fetchPrices({ repository, work: fresh("work"), schedule, now: FETCHED_AT, fetcher: fakeFetch().fetch, log: quiet })).rejects.toThrow(/prices is a symbolic link/);
		expect(readdirSync(elsewhere)).toEqual([]);
	});

	test("writes nothing when a rule selects nothing", async () => {
		const repository = fresh("repository");
		const work = fresh("work");
		const empty = editedSources("AmazonEC2", (source) => {
			delete source.products.KZJJ34U6VU5DJ9CM;
		});
		const fake = fakeFetch({ [sourceUrl("AmazonEC2")]: { file: (empty[0] as SourceFile).path } });
		await expect(fetchPrices({ repository, work, schedule, now: FETCHED_AT, fetcher: fake.fetch, log: quiet })).rejects.toThrow(/rule ebs-gp3-throughput selected 0 products/);
		expect(readdirSync(repository)).toEqual([]);
		expect(readdirSync(work)).toEqual([]);
	});

	test("refuses a download whose size is not what the response declared, or that failed", async () => {
		const short = fakeFetch({
			[sourceUrl("AmazonS3")]: {
				respond: () => new Response(readFileSync(join(SOURCES, "AmazonS3.json")).subarray(0, 100), { headers: { "Content-Length": "13038" } }),
			},
		});
		const repository = fresh("repository");
		await expect(fetchPrices({ repository, work: fresh("work"), schedule, now: FETCHED_AT, fetcher: short.fetch, log: quiet })).rejects.toThrow(
			/received 100 bytes, and Content-Length said 13038/,
		);
		const gone = fakeFetch({ [sourceUrl("AmazonS3")]: { respond: () => new Response("gone", { status: 404, statusText: "Not Found" }) } });
		await expect(fetchPrices({ repository, work: fresh("work"), schedule, now: FETCHED_AT, fetcher: gone.fetch, log: quiet })).rejects.toThrow(/404/);
		expect(readdirSync(repository)).toEqual([]);
	});

	test("names the file by the UTC date of the fetch", () => {
		expect(priceFilePath(new Date("2026-11-11T23:59:59.999Z"))).toBe("prices/2026/11/11/aws.json");
		expect(priceFilePath(new Date("2026-11-12T00:00:00.000+01:00"))).toBe("prices/2026/11/11/aws.json");
		expect(priceFilePath(new Date("2027-01-02T00:00:00.000Z"))).toBe("prices/2027/01/02/aws.json");
	});
});

describe("the recompute check", () => {
	const quiet = (): void => {};

	test("passes on the sample: every source hashes as recorded and the recut is the file, byte for byte", async () => {
		const fake = fakeFetch();
		const result = await checkPrices({ path: SAMPLE_FILE, work: fresh("work"), fetcher: fake.fetch, log: quiet });
		expect(result.problems).toEqual([]);
		expect(result.sources.map((source) => source.url)).toEqual(sampleSources().map((source) => source.url));
		// It downloaded each source at the URL the file names, and nothing else.
		expect(fake.requests).toEqual(sampleSources().map((source) => source.url));
	});

	test("with local copies of the sources, reads them instead of downloading, and checks them the same way", async () => {
		const fake = fakeFetch();
		const result = await checkPrices({ path: SAMPLE_FILE, work: fresh("work"), sources: SOURCES, fetcher: fake.fetch, log: quiet });
		expect(result.problems).toEqual([]);
		expect(fake.requests).toEqual([]);
	});

	test("fails when the bytes at a source's URL are no longer the ones recorded", async () => {
		const changed = editedSources("AmazonS3", (source) => {
			((((source.terms.OnDemand.GJKK9PMSTKPNGZS9 as Json)["GJKK9PMSTKPNGZS9.JRTCKXETXF"] as Json).priceDimensions as Json)["GJKK9PMSTKPNGZS9.JRTCKXETXF.6YS6EN2CT7"] as Json).pricePerUnit = {
				USD: "0.0000060000",
			};
		});
		const fake = fakeFetch({ [sourceUrl("AmazonS3")]: { file: (changed[1] as SourceFile).path } });
		const result = await checkPrices({ path: SAMPLE_FILE, work: fresh("work"), fetcher: fake.fetch, log: quiet });
		expect(result.problems).toContainEqual(expect.stringMatching(/^source AmazonS3: https:\/\/pricing\..* now gives \d+ bytes, sha256:[0-9a-f]{64}; the file says 13038 bytes/));
		expect(result.problems).toContain("source AmazonS3: terms.OnDemand.GJKK9PMSTKPNGZS9 differs");
	});

	test("fails when a record in the file is not what the source gives, or the file names rules this code does not hold", async () => {
		const stored = JSON.parse(readFileSync(SAMPLE_FILE, "utf8")) as PriceFile;
		const directory = fresh("edited");
		const edited = structuredClone(stored);
		const m5 = edited.sources[0]?.products["8D49XP354UEYTHGM"] as { attributes: Record<string, string> };
		m5.attributes.memory = "16 GiB";
		writeFileSync(join(directory, "aws.json"), serializePriceFile(edited));
		const result = await checkPrices({ path: join(directory, "aws.json"), work: fresh("work"), fetcher: fakeFetch().fetch, log: quiet });
		expect(result.problems).toEqual(["source AmazonEC2: products.8D49XP354UEYTHGM differs"]);

		const unknown = structuredClone(stored);
		unknown.rules.version = 99;
		writeFileSync(join(directory, "unknown.json"), serializePriceFile(unknown));
		const refused = await checkPrices({ path: join(directory, "unknown.json"), work: fresh("work"), fetcher: fakeFetch().fetch, log: quiet });
		expect(refused.problems).toEqual(["cut with ledgermath.aws-price-rules version 99, which scripts/lib/price-rules.ts does not hold"]);

		// Reformatted, the same records are still not the file that was stored.
		writeFileSync(join(directory, "compact.json"), JSON.stringify(stored));
		const compact = await checkPrices({ path: join(directory, "compact.json"), work: fresh("work"), fetcher: fakeFetch().fetch, log: quiet });
		expect(compact.problems).toEqual(["the recut has the same records and differs only in how the file is written"]);
	});

	test("fails a file stored under a date other than the one it was fetched on", async () => {
		const repository = fresh("repository");
		mkdirSync(join(repository, "prices/2026/11/12"), { recursive: true });
		writeFileSync(join(repository, "prices/2026/11/12/aws.json"), readFileSync(SAMPLE_FILE));
		const result = await checkPrices({ path: join(repository, "prices/2026/11/12/aws.json"), work: fresh("work"), fetcher: fakeFetch().fetch, log: quiet });
		expect(result.problems).toEqual(["prices/2026/11/12/aws.json is not under the UTC date it was fetched, 2026-11-11T03:17:42.123Z"]);
	});
});
