/**
 * The selection rules: which of AWS's price records a price file keeps. They
 * live here and nowhere else. A price file names the rule set it was cut
 * with, by name and version, and lists each rule's name and what it selects,
 * so "not in this file" means "no rule of that version selects it".
 *
 * A rule set, once a price file cut with it is in the Runs repository, is
 * never edited: a change is a new version beside it in RULE_SETS, and
 * CURRENT_RULES moves to it. scripts/check-prices.ts re-cuts a price file
 * with the version the file names, so every version a stored file names must
 * stay here.
 *
 * What is measured comes from schedule.json: its instance types and the
 * Region of its zone (measuredFromSchedule). The rest is the fixed list of
 * issue #45: gp3 storage, IOPS and throughput; S3 Standard storage and
 * requests; data transfer out of the Region to the internet.
 *
 * Every rule says how many products it must select. A rule that selects none,
 * or more than it should, stops the cut: a price file that is silently empty,
 * or silently holds the wrong record, is the failure guarded against.
 */

import type { Schedule } from "../../infra/runs/schedule";

/** The offers the rules read: AWS's own offer codes. */
export const OFFER_CODES = ["AmazonEC2", "AmazonS3", "AWSDataTransfer"] as const;
export type OfferCode = (typeof OFFER_CODES)[number];

/** What is measured, as the price file records it: the inputs to the cut that come from schedule.json. */
export interface Measured {
	/** The Region of the schedule's zone, such as us-east-2. */
	region: string;
	/** The schedule's instance types, sorted. */
	instance_types: string[];
}

/** A product of an offer file, as AWS writes it. Only what the rules read is typed. */
export interface Product {
	sku: string;
	productFamily?: string;
	attributes: Record<string, string>;
}

export interface PriceRule {
	/** Unique within its rule set; written into the price file beside the SKUs it selected. */
	name: string;
	offerCode: OfferCode;
	/** What it selects, in words; written into the price file. */
	selects: string;
	matches(product: Product, measured: Measured): boolean;
	/** Why the products it matched are not the set it must select, or null when they are. */
	implausible(matched: readonly Product[], measured: Measured): string | null;
}

export interface RuleSet {
	name: string;
	version: number;
	rules: readonly PriceRule[];
}

export const RULE_SET_NAME = "ledgermath.aws-price-rules";

const exactly = (count: number) => (matched: readonly Product[]): string | null =>
	matched.length === count ? null : `selected ${matched.length} products, and must select exactly ${count}`;

/** A zone such as us-east-2c, and its Region us-east-2. */
const ZONE = /^([a-z]{2}-[a-z]+-[0-9])[a-z]$/;

export function regionOfZone(zone: string): string {
	const match = ZONE.exec(zone);
	if (match === null) throw new Error(`${zone} is not an availability zone of the form us-east-2c`);
	return match[1] as string;
}

/** What schedule.json says is measured: its instance types, sorted, and the Region of its one zone. */
export function measuredFromSchedule(schedule: Schedule): Measured {
	const regions = [...new Set(schedule.targets.map((target) => regionOfZone(target.zone)))];
	if (regions.length !== 1) throw new Error(`the schedule's targets are in ${regions.length} Regions (${regions.join(", ")}); the price rules read one`);
	const types = [...new Set(schedule.targets.map((target) => target.instance_type))].sort();
	if (types.length === 0) throw new Error("the schedule has no targets, so nothing is measured");
	return { region: regions[0] as string, instance_types: types };
}

const inRegion = (product: Product, measured: Measured): boolean =>
	product.attributes.regionCode === measured.region && product.attributes.locationType === "AWS Region";

/** Version 1, 2026-11-11. */
const RULES_V1: RuleSet = {
	name: RULE_SET_NAME,
	version: 1,
	rules: [
		{
			// The instance types the schedule boots, as a box of the stage runs: On-Demand, Linux, default (shared) tenancy, no pre-installed software, no capacity reservation.
			name: "ec2-instance-on-demand-linux",
			offerCode: "AmazonEC2",
			selects:
				"Each instance type in measured.instance_types, in measured.region: productFamily \"Compute Instance\" or \"Compute Instance (bare metal)\", " +
				"operatingSystem \"Linux\", tenancy \"Shared\", preInstalledSw \"NA\", licenseModel \"No License required\", capacitystatus \"Used\", " +
				"operation \"RunInstances\". Exactly one product per instance type. Not other tenancies, operating systems, licences, pre-installed software or capacity reservations.",
			matches: (product, measured) =>
				(product.productFamily === "Compute Instance" || product.productFamily === "Compute Instance (bare metal)") &&
				inRegion(product, measured) &&
				measured.instance_types.includes(product.attributes.instanceType ?? "") &&
				product.attributes.operatingSystem === "Linux" &&
				product.attributes.tenancy === "Shared" &&
				product.attributes.preInstalledSw === "NA" &&
				product.attributes.licenseModel === "No License required" &&
				product.attributes.capacitystatus === "Used" &&
				product.attributes.operation === "RunInstances",
			implausible: (matched, measured) => {
				const problems: string[] = [];
				for (const type of measured.instance_types) {
					const count = matched.filter((product) => product.attributes.instanceType === type).length;
					if (count !== 1) problems.push(`${type}: ${count} products`);
				}
				return problems.length === 0 ? null : `must select exactly one product per instance type, and found ${problems.join("; ")}`;
			},
		},
		{
			// The root volume's kind of disk: gp3 storage per GB-month.
			name: "ebs-gp3-storage",
			offerCode: "AmazonEC2",
			selects: "EBS gp3 storage in measured.region: productFamily \"Storage\", volumeApiName \"gp3\". Exactly one product.",
			matches: (product, measured) => product.productFamily === "Storage" && product.attributes.volumeApiName === "gp3" && inRegion(product, measured),
			implausible: exactly(1),
		},
		{
			// gp3 IOPS bought beyond the volume's included baseline.
			name: "ebs-gp3-iops",
			offerCode: "AmazonEC2",
			selects: "EBS gp3 provisioned IOPS in measured.region: productFamily \"System Operation\", volumeApiName \"gp3\", group \"EBS IOPS\". Exactly one product.",
			matches: (product, measured) =>
				product.productFamily === "System Operation" &&
				product.attributes.volumeApiName === "gp3" &&
				product.attributes.group === "EBS IOPS" &&
				inRegion(product, measured),
			implausible: exactly(1),
		},
		{
			// gp3 throughput bought beyond the volume's included baseline.
			name: "ebs-gp3-throughput",
			offerCode: "AmazonEC2",
			selects:
				"EBS gp3 provisioned throughput in measured.region: productFamily \"Provisioned Throughput\", volumeApiName \"gp3\", group \"EBS Throughput\". Exactly one product.",
			matches: (product, measured) =>
				product.productFamily === "Provisioned Throughput" &&
				product.attributes.volumeApiName === "gp3" &&
				product.attributes.group === "EBS Throughput" &&
				inRegion(product, measured),
			implausible: exactly(1),
		},
		{
			// S3 Standard storage per GB-month, in its tiers.
			name: "s3-standard-storage",
			offerCode: "AmazonS3",
			selects:
				"S3 Standard storage in measured.region: productFamily \"Storage\", storageClass \"General Purpose\", volumeType \"Standard\", usagetype ending \"-TimedStorage-ByteHrs\". Exactly one product.",
			matches: (product, measured) =>
				product.productFamily === "Storage" &&
				product.attributes.storageClass === "General Purpose" &&
				product.attributes.volumeType === "Standard" &&
				/^[A-Z0-9]+-TimedStorage-ByteHrs$/.test(product.attributes.usagetype ?? "") &&
				inRegion(product, measured),
			implausible: exactly(1),
		},
		{
			// S3 Standard requests: Tier1 (PUT, COPY, POST, LIST) and Tier2 (GET and all others). Not the other storage classes' requests, nor annotation requests, which share the groups.
			name: "s3-standard-requests",
			offerCode: "AmazonS3",
			selects:
				"S3 Standard requests in measured.region: productFamily \"API Request\", group \"S3-API-Tier1\" with usagetype \"<prefix>-Requests-Tier1\" (PUT, COPY, POST, LIST) " +
				"and group \"S3-API-Tier2\" with usagetype \"<prefix>-Requests-Tier2\" (GET and all other requests). Exactly one product of each.",
			matches: (product, measured) =>
				product.productFamily === "API Request" &&
				((product.attributes.group === "S3-API-Tier1" && /^[A-Z0-9]+-Requests-Tier1$/.test(product.attributes.usagetype ?? "")) ||
					(product.attributes.group === "S3-API-Tier2" && /^[A-Z0-9]+-Requests-Tier2$/.test(product.attributes.usagetype ?? ""))) &&
				inRegion(product, measured),
			implausible: (matched) => {
				const groups = matched.map((product) => product.attributes.group).sort();
				return groups.length === 2 && groups[0] === "S3-API-Tier1" && groups[1] === "S3-API-Tier2"
					? null
					: `must select exactly one product of S3-API-Tier1 and one of S3-API-Tier2, and found ${matched.length} (${groups.join(", ") || "none"})`;
			},
		},
		{
			// Data out of the Region to the internet, in its tiers: what a download costs. Not accelerated transfer, nor to other Regions, CloudFront, Local or Wavelength Zones.
			name: "data-transfer-out-to-internet",
			offerCode: "AWSDataTransfer",
			selects:
				"Data transfer out of measured.region to the internet: productFamily \"Data Transfer\", transferType \"AWS Outbound\", fromRegionCode measured.region, " +
				"toLocation \"External\", usagetype ending \"-DataTransfer-Out-Bytes\". Exactly one product.",
			matches: (product, measured) =>
				product.productFamily === "Data Transfer" &&
				product.attributes.transferType === "AWS Outbound" &&
				product.attributes.fromRegionCode === measured.region &&
				product.attributes.fromLocationType === "AWS Region" &&
				product.attributes.toLocation === "External" &&
				/^[A-Z0-9]+-DataTransfer-Out-Bytes$/.test(product.attributes.usagetype ?? ""),
			implausible: exactly(1),
		},
		{
			// The free allowance the Region's first tier is "beyond": data out to the internet, aggregated across Regions, each month. The Region's file carries it.
			name: "data-transfer-out-to-internet-global-free-tier",
			offerCode: "AWSDataTransfer",
			selects:
				"The global free tier of data transfer out to the internet, which the Region's first tier is beyond: productFamily \"Data Transfer\", transferType \"AWS Outbound\", " +
				"fromLocation \"Global\", toLocation \"External\", usagetype \"Global-DataTransfer-Out-Bytes\". Exactly one product.",
			matches: (product) =>
				product.productFamily === "Data Transfer" &&
				product.attributes.transferType === "AWS Outbound" &&
				product.attributes.fromLocation === "Global" &&
				product.attributes.toLocation === "External" &&
				product.attributes.usagetype === "Global-DataTransfer-Out-Bytes",
			implausible: exactly(1),
		},
	],
};

/** Every rule set a stored price file may name, by version. */
export const RULE_SETS: ReadonlyMap<number, RuleSet> = new Map([[RULES_V1.version, RULES_V1]]);

/** The rule set new price files are cut with. */
export const CURRENT_RULES: RuleSet = RULES_V1;

/** The offers a rule set reads, in OFFER_CODES order. */
export function offersOf(rules: RuleSet): OfferCode[] {
	return OFFER_CODES.filter((code) => rules.rules.some((rule) => rule.offerCode === code));
}
