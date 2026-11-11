/**
 * Made the three small offer files in sources/ from AWS's real ones, which
 * are too big to commit (the EC2 file for us-east-2 is over 400 MB):
 *
 *     bun tests/samples/prices/make-sources.ts EC2_FILE S3_FILE DATA_TRANSFER_FILE
 *
 * Each output is an excerpt of the real file, in its own layout: the real
 * header, and the real text of each product and its On-Demand terms named
 * below, byte for byte, plus one product's Reserved terms (which a cut must
 * skip). Run on 2026-11-11 with the files at
 *
 *     https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/20261110173852/us-east-2/index.json
 *     https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/20261109154310/us-east-2/index.json
 *     https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/20261110232936/us-east-2/index.json
 *
 * The excerpts are not those files, so their hashes are not; the tests serve
 * them under those URLs from a fake fetch, and only the tests read them.
 */

import { createReadStream, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { scanOfferFile, type Span } from "../../../scripts/lib/offer-file";

/** What each excerpt keeps: the products the rules must select, and the decoys they must not. */
const KEEP: Record<string, { selected: string[]; decoys: string[]; reserved?: string }> = {
	AmazonEC2: {
		selected: [
			"8D49XP354UEYTHGM", // m5.large, Linux, shared tenancy
			"NKB8DU47ZKKBXW65", // c6i.8xlarge, Linux, shared tenancy
			"8ESS9QXCJT48TMPH", // i4i.2xlarge, Linux, shared tenancy
			"M6UGCCQ3CDJQAA37", // gp3 storage
			"M7SNV383JPWT8MVX", // gp3 IOPS
			"KZJJ34U6VU5DJ9CM", // gp3 throughput
		],
		decoys: [
			"AWAUVC8BN4PM4V42", // c8i.2xlarge: Linux, shared tenancy, a type the tests do not measure
			"D4NUSS37ZFG8846A", // c6i.4xlarge: Linux, shared tenancy, a type nothing measures
			"W8UFMFG6W5VDXXBD", // m5.large, dedicated tenancy
			"3DKMGSR5RK2KKZUK", // c6i.8xlarge, host tenancy
			"A6AXYHP3ZRMWXV6Y", // m5.large, Windows
			"4V7VZYCKFER6GP8C", // m5.large, RHEL
			"EXQZQ63GWAD5R26D", // m5.large, Linux with SQL Web
			"3AGQU3KVKCGPJJ8U", // m5.large, an unused capacity reservation
			"BKE6RQRK6C48M64A", // a c6i Dedicated Host
			"SCM63QZA8NKUYACF", // gp2 storage
			"RTRGQ58T6YAMVZ5F", // io2 IOPS
			"W2MK87PHAESV3EZK", // a product with no productFamily (EBS volume clones)
		],
		reserved: "8D49XP354UEYTHGM",
	},
	AmazonS3: {
		selected: [
			"YPGKVRB2EKTVDJDT", // Standard storage
			"GJKK9PMSTKPNGZS9", // Tier1 requests
			"DJEKB32FV4HNZJZY", // Tier2 requests
		],
		decoys: [
			"8ZFQ57FZ52W4PZV7", // annotation storage, also storageClass General Purpose
			"FNWV6QQJ34ZTYY9U", // Standard-Infrequent Access storage
			"EFXDCZB26CN5C7RA", // Tier1 annotation requests, also group S3-API-Tier1
			"HKJHVMYUM2FST5JF", // Tier2 annotation requests, also group S3-API-Tier2
			"VHQYNB4HK92W7HCD", // Standard-Infrequent Access Tier1 requests
			"TTZBKMDSBCKEXHU2", // replication time control transfer, no productFamily
		],
	},
	AWSDataTransfer: {
		selected: [
			"36H7S3NU9B7S3UT5", // us-east-2 to the internet
			"PB257JUQ8U6E6UPM", // the global free tier to the internet
		],
		decoys: [
			"QGCDJV4FY5CE3SV9", // inter-Region peering outbound, also toLocation External
			"SS2T6PKCQV6JUTFM", // accelerated outbound to the internet
			"5CHDB6K4USP8QXF3", // inbound from the internet
			"2K2HTT68FEQ8VPRY", // out to CloudFront
			"43SVRH2NZVAKYEXT", // out to us-east-1
			"GBSWCG32FV9G4PVY", // us-east-1 to us-east-2
		],
	},
};

/** terms.Reserved.<sku> as the file writes it, read line by line: the file's layout puts it on lines of its own. */
async function reservedText(path: string, sku: string): Promise<string> {
	const lines = createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY });
	let inReserved = false;
	let captured: string[] | null = null;
	for await (const line of lines) {
		if (line === '    "Reserved" : {') inReserved = true;
		else if (inReserved && captured === null && line === `      "${sku}" : {`) captured = ["{"];
		else if (captured !== null) {
			if (line === "      }" || line === "      },") {
				captured.push("      }");
				lines.close();
				return captured.join("\n");
			}
			captured.push(line);
		}
	}
	throw new Error(`${path}: no terms.Reserved.${sku}`);
}

async function excerpt(path: string, offerCode: string, out: string): Promise<void> {
	const keep = KEEP[offerCode];
	if (keep === undefined) throw new Error(`nothing to keep of ${offerCode}`);
	const wanted = new Set([...keep.selected, ...keep.decoys]);
	const header: Span[] = [];
	const products = new Map<string, string>();
	const onDemand = new Map<string, string>();
	scanOfferFile(path, {
		header: (span) => header.push(span),
		product: (span) => {
			if (wanted.has(span.key)) products.set(span.key, span.text);
		},
		onDemand: (span) => {
			if (wanted.has(span.key)) onDemand.set(span.key, span.text);
		},
	});
	const code = header.find((span) => span.key === "offerCode")?.text;
	if (code !== JSON.stringify(offerCode)) throw new Error(`${path} is the offer ${code}, not ${offerCode}`);
	for (const sku of wanted) if (!products.has(sku)) throw new Error(`${path}: no product ${sku}`);
	// The file's order, so the excerpt reads like the file.
	const order = [...products.keys()];
	const member = (key: string, text: string, indent: string): string => `${indent}${JSON.stringify(key)} : ${text}`;
	const before = header.filter((span) => span.key !== "attributesList");
	const after = header.filter((span) => span.key === "attributesList");
	const termsParts = [
		`    "OnDemand" : {\n${order
			.filter((sku) => onDemand.has(sku))
			.map((sku) => member(sku, onDemand.get(sku) as string, "      "))
			.join(",\n")}\n    }`,
	];
	if (keep.reserved !== undefined) {
		termsParts.push(`    "Reserved" : {\n${member(keep.reserved, await reservedText(path, keep.reserved), "      ")}\n    }`);
	}
	const text = [
		"{",
		[
			...before.map((span) => member(span.key, span.text, "  ")),
			`  "products" : {\n${order.map((sku) => member(sku, products.get(sku) as string, "    ")).join(",\n")}\n  }`,
			`  "terms" : {\n${termsParts.join(",\n")}\n  }`,
			...after.map((span) => member(span.key, span.text, "  ")),
		].join(",\n"),
		"}",
	].join("\n");
	writeFileSync(out, text);
	console.log(`${out}: ${products.size} products, ${onDemand.size} with On-Demand terms, ${text.length} bytes`);
}

const [ec2, s3, dataTransfer] = process.argv.slice(2);
if (!ec2 || !s3 || !dataTransfer) {
	console.error("usage: bun tests/samples/prices/make-sources.ts EC2_FILE S3_FILE DATA_TRANSFER_FILE");
	process.exit(2);
}
const out = join(import.meta.dir, "sources");
await excerpt(ec2, "AmazonEC2", join(out, "AmazonEC2.json"));
await excerpt(s3, "AmazonS3", join(out, "AmazonS3.json"));
await excerpt(dataTransfer, "AWSDataTransfer", join(out, "AWSDataTransfer.json"));
