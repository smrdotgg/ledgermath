import { describe, expect, setDefaultTimeout, test } from "bun:test";

import type { Run } from "../methods/run";
import * as requests from "../methods/requests/v1";
import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import { derive, gather } from "../methods/v1";
import { NOT_SPLIT_ON, SPLIT_FACTS, seriesId, seriesKey } from "../methods/v1/facts";
import type { DerivationsFile, SeriesDerivation } from "../methods/v1/output";
import { rampRequests, requestRun } from "./hand-made-requests";
import { HandMade, type HandMadeAccount } from "./hand-made-runs";

// Deriving a few hundred hand-made requests can take longer than bun's five-second default on a loaded machine.
setDefaultTimeout(120_000);

/**
 * Will a Series get a new group because the schedule moves from the
 * development account to the production account? Two boots of one target,
 * one in each account, made as the two accounts' boxes would make them: the
 * same image, instance type, zone ID, runner and binaries (nothing a box
 * runs changes with the move), and everything that names the account or its
 * VPC different. The VPCs were compared, read-only, on 2026-11-14: both
 * default VPCs are 172.31.0.0/16 with the same DNS settings and DHCP options
 * (AmazonProvidedDNS, us-east-2.compute.internal); both default subnets in
 * use2-az3 are 172.31.32.0/20, map a public address on launch and use the
 * main route table, 0.0.0.0/0 to an internet gateway; neither VPC has an
 * endpoint. So the network section is the same in both, and what differs is
 * the account ID and the IDs of the VPC's parts. The account IDs here are
 * AWS's documentation examples.
 */
const DEVELOPMENT: HandMadeAccount = {
	id: "123456789012",
	vpc: "vpc-0dddddddddddddddd",
	subnet: "subnet-0dddddddddddddddd",
	routeTable: "rtb-0dddddddddddddddd",
	internetGateway: "igw-0dddddddddddddddd",
	securityGroup: "sg-0dddddddddddddddd",
	instanceProfile: "BoxProfile-ddddddd",
};
const PRODUCTION: HandMadeAccount = {
	id: "111122223333",
	vpc: "vpc-0eeeeeeeeeeeeeeee",
	subnet: "subnet-0eeeeeeeeeeeeeeee",
	routeTable: "rtb-0eeeeeeeeeeeeeeee",
	internetGateway: "igw-0eeeeeeeeeeeeeeee",
	securityGroup: "sg-0eeeeeeeeeeeeeeee",
	instanceProfile: "BoxProfile-eeeeeee",
};

/** The Service each stage's boxes are given: its own fixtures bucket. */
const fixtures = (bucket: string): NonNullable<Run["service"]> => ({
	name: "s3_fixtures",
	inputs: { endpoint: `https://${bucket}.s3.us-east-2.amazonaws.com`, region: "us-east-2" },
	secret_inputs: ["aws_access_key_id", "aws_secret_access_key", "aws_session_token"],
});
const DEVELOPMENT_FIXTURES = fixtures("ledgermath-smr-runs-fixturesbucketbucket-abcdefgh");
const PRODUCTION_FIXTURES = fixtures("ledgermath-production-runs-fixturesbucketbucket-ijklmnop");

async function series(made: HandMade): Promise<DerivationsFile> {
	return derive(made.files, await gather(made.files, made.fetch));
}

function only(file: DerivationsFile): SeriesDerivation {
	expect(file.derivations.length).toBe(1);
	return file.derivations[0] as SeriesDerivation;
}

describe("a Series across the move to the production account", () => {
	test("stays one Series in one group: what differs names the account and its VPC, and no split fact reads it", async () => {
		const made = new HandMade();
		const before = made.run({ startedAt: "2026-11-15T04:12:00Z", boot: "last-development-boot", account: DEVELOPMENT, diskSections: {} });
		const after = made.run({ startedAt: "2026-11-15T10:12:00Z", boot: "first-production-boot", account: PRODUCTION, diskSections: {} });
		expect(seriesKey(after)).toEqual(seriesKey(before));
		expect(seriesId(seriesKey(after))).toBe(seriesId(seriesKey(before)));

		const derivation = only(await series(made));
		expect(derivation.points.map((point) => point.group)).toEqual(["A", "A"]);
		expect(derivation.groups.map((group) => group.id)).toEqual(["A"]);
		expect(derivation.percentiles.time_per_repetition_ns?.count).toBe(2);
		const [move] = derivation.differed;
		expect(move?.facts).toEqual([]);
		const effects = Object.fromEntries((move?.sections ?? []).map((section) => [section.section, section.effect]));
		// The account and the VPC: provider (the identity document), ec2_instance, ec2_route_tables, and
		// ec2_vpc_endpoints, whose command line names the VPC though both answers are empty; besides
		// what is new on every boot. network is the same in both accounts.
		expect(effects).toEqual({
			cpuinfo: "not split on",
			devices: "not split on",
			ec2_instance: "not split on",
			ec2_route_tables: "not split on",
			ec2_volumes: "not split on",
			ec2_vpc_endpoints: "not split on",
			kernel: "left out",
			memory: "not split on",
			block_stat: "not split on",
			nvme_stats: "not split on",
			provider: "not split on",
			provision: "not split on",
		});
		expect(effects.network).toBeUndefined();
		// Each section that names the account is one version 1 says it does not split on, and why.
		const notSplitOn = NOT_SPLIT_ON.flatMap((entry) => entry.fact.split(", "));
		for (const section of ["provider", "ec2_instance", "ec2_route_tables", "network", "ec2_vpc_endpoints"]) {
			expect(notSplitOn).toContain(section);
			expect(SPLIT_FACTS.map((fact) => fact.section)).not.toContain(section);
		}
	});

	test("an http_get Series too, whose Runs name each stage's own fixtures bucket: one Series and one group in both Methods; requests v1 lists both endpoints", async () => {
		const made = new HandMade();
		requestRun(made, { startedAt: "2026-11-15T04:15:00Z", boot: "last-development-boot", account: DEVELOPMENT, service: DEVELOPMENT_FIXTURES, stream: { connection: "new", requests: rampRequests(20) } });
		requestRun(made, { startedAt: "2026-11-15T10:15:00Z", boot: "first-production-boot", account: PRODUCTION, service: PRODUCTION_FIXTURES, stream: { connection: "new", requests: rampRequests(20) } });

		const derivation = only(await series(made));
		expect(derivation.points.map((point) => point.group)).toEqual(["A", "A"]);
		expect(derivation.differed[0]?.facts).toEqual([]);

		const file: RequestsFile = requests.derive(made.files, await requests.gather(made.files, made.fetch));
		expect(file.derivations.length).toBe(1);
		const ofRequests = file.derivations[0];
		expect(ofRequests?.points.map((point) => point.group)).toEqual(["A", "A"]);
		expect(ofRequests?.recorded.services).toEqual([
			{ name: "s3_fixtures", inputs: PRODUCTION_FIXTURES.inputs, runs: 1 },
			{ name: "s3_fixtures", inputs: DEVELOPMENT_FIXTURES.inputs, runs: 1 },
		]);
		expect(ofRequests?.recorded.regions).toEqual([{ value: "us-east-2", runs: 2 }]);
	});

	test("would split if the move changed what a box runs, such as its kernel: the check above can tell", async () => {
		const made = new HandMade();
		made.run({ startedAt: "2026-11-15T04:12:00Z", boot: "last-development-boot", account: DEVELOPMENT });
		made.run({ startedAt: "2026-11-15T10:12:00Z", boot: "first-production-boot", account: PRODUCTION, kernel: "6.1.999-1.amzn2023.x86_64" });
		const derivation = only(await series(made));
		expect(derivation.points.map((point) => point.group)).toEqual(["A", "B"]);
		expect(derivation.differed[0]?.facts).toEqual(["kernel"]);
	});
});
