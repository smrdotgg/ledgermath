import { describe, expect, test } from "bun:test";

import { distributionComment, type PlanAttachment, type PublicBlobsState } from "../infra/runs/public-blobs";
import {
	type AwsCli,
	coverage,
	type Deployed,
	DISTRIBUTION_NAME,
	DISTRIBUTION_TYPE,
	distributionsPage,
	findDeployed,
	isQuiet,
	judgeTransition,
	type Managed,
	managedDistribution,
	type PlanVerdict,
	parseComment,
	readDeployed,
	readManaged,
	readSubscriptions,
	stageRefusals,
	stateFilePath,
	type SubscriptionSummary,
	subscriptionsPage,
	type Target,
} from "../infra/runs/public-blobs-guard";

const STAGE = "production-runs";
const ARN = "arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE";
const WEB_ACL = "arn:aws:wafv2:us-east-1:123456789012:global/webacl/ledgermath-production-runs-public-blobs/a1b2";

/** What `aws cloudfront list-distributions --no-paginate` printed for an account with no distribution (aws-cli 2.39.7, 2026-11-14). */
const EMPTY_ACCOUNT = { DistributionList: { Marker: "", MaxItems: 100, IsTruncated: false, Quantity: 0 } };

function summary(id: string, comment: string, enabled: boolean, status = "Deployed"): Record<string, unknown> {
	return { Id: id, ARN: `arn:aws:cloudfront::123456789012:distribution/${id}`, Comment: comment, Enabled: enabled, Status: status, DomainName: `${id.toLowerCase()}.cloudfront.net` };
}

function page(items: Array<Record<string, unknown>>, next: string | null = null): unknown {
	return { DistributionList: { Marker: "", MaxItems: 100, IsTruncated: next !== null, ...(next === null ? {} : { NextMarker: next }), Quantity: items.length, Items: items } };
}

function present(state: "dark" | "closed" | "on", enabled: boolean, status = "Deployed", plan: PlanAttachment = "code"): Deployed {
	return { kind: "present", id: "EDFDVBD6EXAMPLE", arn: ARN, comment: distributionComment(STAGE, state, plan), enabled, status, recorded: { state, plan } };
}

function sub(status: string, extra: Partial<SubscriptionSummary> = {}): SubscriptionSummary {
	return { arn: "arn:aws:pricingplanmanager::123456789012:subscription:sub_EXAMPLE", planFamily: "CloudFront", planTier: "FREE", status, resourceArns: [ARN, WEB_ACL], scheduledChange: null, ...extra };
}

const NOTHING: Managed = { kind: "none" };

/** What the stage's state records when it last deployed distribution `id` with `comment`. */
function managedOne(id: string, comment: string): Managed {
	return { kind: "one", id, arn: `arn:aws:cloudfront::123456789012:distribution/${id}`, comment };
}

/** A resource of the stage's state as Pulumi records it (keys as in SST 4.17's state of smr-runs). */
function record(type: string, name: string, id: string, outputs: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { urn: `urn:pulumi:${STAGE}::ledgermath::${type}::${name}`, custom: true, id, type, inputs: {}, outputs, ...extra };
}

function distributionRecord(id: string, comment: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return record(DISTRIBUTION_TYPE, DISTRIBUTION_NAME, id, { arn: `arn:aws:cloudfront::123456789012:distribution/${id}`, comment, enabled: false, domainName: `${id.toLowerCase()}.cloudfront.net` }, extra);
}

/** A version 3 checkpoint, as Pulumi 3.215 writes it to the file SST pulls. */
function checkpoint(resources: unknown[] | null, pending: unknown[] = []): unknown {
	const latest = { manifest: { version: "v3.215.0" }, secrets_providers: { type: "passphrase", state: {} }, ...(resources === null ? {} : { resources }), ...(pending.length > 0 ? { pending_operations: pending } : {}), metadata: {} };
	return { version: 3, checkpoint: { stack: `organization/ledgermath/${STAGE}`, latest } };
}

const STACK_RESOURCE = { urn: `urn:pulumi:${STAGE}::ledgermath::pulumi:pulumi:Stack::ledgermath-${STAGE}`, custom: false, type: "pulumi:pulumi:Stack" };
const BUCKET_RESOURCE = record("sst:aws:Bucket$aws:s3/bucket:Bucket", "RunsBucketBucket", "ledgermath-production-runs-runsbucketbucket-abcdefgh", { arn: "arn:aws:s3:::ledgermath-production-runs-runsbucketbucket-abcdefgh" });

const ACTIVE: PlanVerdict = coverage(ARN, [sub("ACTIVE")]);
const NONE: PlanVerdict = coverage(ARN, []);

describe("the record of what is deployed", () => {
	test("is the distribution's comment, read back for its own stage only", () => {
		for (const state of ["dark", "closed", "on"] as const) {
			for (const plan of ["code", "console"] as const) expect(parseComment(distributionComment(STAGE, state, plan), STAGE)).toEqual({ state, plan });
		}
		expect(parseComment(distributionComment(STAGE, "on", "code"), "smr-runs")).toBeNull();
		expect(parseComment(distributionComment("production-runs2", "on", "code"), STAGE)).toBeNull();
		expect(parseComment("LedgerMath production-runs public blobs (blobs/sha256/* only): state=off plan=code", STAGE)).toBeNull();
		expect(parseComment("LedgerMath production-runs: public blobs (blobs/sha256/* only)", STAGE)).toBeNull();
	});

	test("reads an account with no distribution, as the CLI prints it, as nothing deployed", () => {
		expect(distributionsPage(EMPTY_ACCOUNT)).toEqual({ items: [], nextMarker: null });
		expect(readDeployed(() => EMPTY_ACCOUNT, STAGE, NOTHING)).toEqual({ kind: "absent" });
	});

	test("pages by hand, with --no-paginate and --marker, and finds this stage's distribution among others", () => {
		const calls: string[][] = [];
		const cli: AwsCli = (args) => {
			calls.push(args);
			if (!args.includes("--marker")) return page([summary("E1", "someone else's site", true)], "M2");
			return page([summary("E2", distributionComment("smr-runs", "on", "code"), true), summary("E3", distributionComment(STAGE, "dark", "code"), false)]);
		};
		const deployed = readDeployed(cli, STAGE, managedOne("E3", distributionComment(STAGE, "dark", "code")));
		expect(deployed).toMatchObject({ kind: "present", id: "E3", enabled: false, status: "Deployed", recorded: { state: "dark", plan: "code" } });
		expect(calls).toEqual([
			["cloudfront", "list-distributions", "--no-paginate"],
			["cloudfront", "list-distributions", "--no-paginate", "--marker", "M2"],
		]);
	});

	test("is unknown, never absent, when it cannot be read or does not add up", () => {
		const failing: AwsCli = () => {
			throw new Error("aws: error: the SSO session has expired\nmore");
		};
		expect(readDeployed(failing, STAGE, NOTHING)).toEqual({ kind: "unknown", reason: "aws: error: the SSO session has expired more" });
		// What the CLI's own paging prints for an empty account is no output at all; JSON.parse("") throws.
		expect(readDeployed(() => JSON.parse(""), STAGE, NOTHING).kind).toBe("unknown");
		expect(readDeployed(() => ({}), STAGE, NOTHING).kind).toBe("unknown");
		expect(readDeployed(() => ({ DistributionList: { IsTruncated: true, Quantity: 0 } }), STAGE, NOTHING)).toMatchObject({ kind: "unknown", reason: expect.stringContaining("no NextMarker") });
		expect(readDeployed(() => ({ DistributionList: { IsTruncated: false, Quantity: 2, Items: [] } }), STAGE, NOTHING).kind).toBe("unknown");
		const two = [summary("E1", distributionComment(STAGE, "on", "code"), true), summary("E2", distributionComment(STAGE, "dark", "code"), false)];
		expect(readDeployed(() => page(two), STAGE, NOTHING)).toMatchObject({ kind: "unknown", reason: expect.stringContaining("2 distributions") });
		const odd = "LedgerMath production-runs public blobs, hand-edited";
		expect(findDeployed(distributionsPage(page([summary("E1", odd, true)])).items, STAGE, managedOne("E1", odd))).toMatchObject({ kind: "unknown", reason: expect.stringContaining("does not record") });
		// When the stage's state cannot be read, the listing does not matter.
		expect(readDeployed(() => EMPTY_ACCOUNT, STAGE, { kind: "unknown", reason: "the stage's state could not be read: ENOENT" })).toEqual({ kind: "unknown", reason: "the stage's state could not be read: ENOENT" });
	});

	test("counts as disabled only once every edge has it", () => {
		expect(isQuiet({ enabled: false, status: "Deployed" })).toBe(true);
		expect(isQuiet({ enabled: false, status: "InProgress" })).toBe(false);
		expect(isQuiet({ enabled: true, status: "Deployed" })).toBe(false);
	});
});

describe("which distribution is the stage's", () => {
	const ON = distributionComment(STAGE, "on", "code");
	const DARK = distributionComment(STAGE, "dark", "code");

	test("is the one the stage's state records, by ID; a stage never deployed records none", () => {
		expect(managedDistribution(checkpoint(null))).toEqual({ kind: "none" });
		expect(managedDistribution(checkpoint([STACK_RESOURCE, BUCKET_RESOURCE]))).toEqual({ kind: "none" });
		expect(managedDistribution({ version: 3, checkpoint: { stack: `organization/ledgermath/${STAGE}`, latest: null } })).toEqual({ kind: "none" });
		expect(managedDistribution(checkpoint([STACK_RESOURCE, BUCKET_RESOURCE, distributionRecord("E3", DARK)]))).toEqual({
			kind: "one",
			id: "E3",
			arn: "arn:aws:cloudfront::123456789012:distribution/E3",
			comment: DARK,
		});
		// Only the distribution of that name counts.
		const other = record(DISTRIBUTION_TYPE, "SomeOtherDistribution", "E7", { arn: "arn:aws:cloudfront::123456789012:distribution/E7", comment: DARK });
		expect(managedDistribution(checkpoint([STACK_RESOURCE, other]))).toEqual({ kind: "none" });
		// A pending operation on another resource does not matter.
		expect(managedDistribution(checkpoint([distributionRecord("E3", DARK)], [{ resource: BUCKET_RESOURCE, type: "updating" }])).kind).toBe("one");
	});

	test("is unknown when the state cannot say which distribution it is", () => {
		for (const file of [null, "text", {}, { version: 4, checkpoint: { latest: null } }, { version: 3 }, { version: 3, checkpoint: { latest: { resources: {} } } }]) {
			expect(managedDistribution(file).kind).toBe("unknown");
		}
		expect(managedDistribution(checkpoint([distributionRecord("E3", DARK), distributionRecord("E4", DARK)]))).toMatchObject({ kind: "unknown", reason: expect.stringContaining("records 2") });
		expect(managedDistribution(checkpoint([distributionRecord("E3", DARK, { delete: true }), distributionRecord("E4", DARK)]))).toMatchObject({ kind: "unknown", reason: expect.stringContaining("1 of them awaiting deletion") });
		expect(managedDistribution(checkpoint([distributionRecord("E3", DARK, { delete: true })])).kind).toBe("unknown");
		// A deploy interrupted while creating it: AWS may hold a distribution the state does not record.
		const creating = { resource: { urn: `urn:pulumi:${STAGE}::ledgermath::${DISTRIBUTION_TYPE}::${DISTRIBUTION_NAME}`, custom: true, type: DISTRIBUTION_TYPE }, type: "creating" };
		expect(managedDistribution(checkpoint([STACK_RESOURCE], [creating]))).toMatchObject({ kind: "unknown", reason: expect.stringContaining("did not finish (creating)") });
		expect(managedDistribution(checkpoint([record(DISTRIBUTION_TYPE, DISTRIBUTION_NAME, "E3", { comment: DARK })])).kind).toBe("unknown");
		expect(managedDistribution(checkpoint([record(DISTRIBUTION_TYPE, DISTRIBUTION_NAME, "", { arn: ARN, comment: DARK })])).kind).toBe("unknown");
	});

	test("is read from the copy of the state SST pulled for this run, named by PULUMI_BACKEND_URL", () => {
		const work = "file:///home/someone/ledgermath/.sst/pulumi/01JZ0000000000000000000000";
		expect(stateFilePath(work, "ledgermath", STAGE)).toBe("/home/someone/ledgermath/.sst/pulumi/01JZ0000000000000000000000/.pulumi/stacks/ledgermath/production-runs.json");
		expect(() => stateFilePath(undefined, "ledgermath", STAGE)).toThrow("PULUMI_BACKEND_URL is not set");
		expect(() => stateFilePath("s3://some-bucket", "ledgermath", STAGE)).toThrow("not the file:// copy");
		const read: string[] = [];
		const file = JSON.stringify(checkpoint([distributionRecord("E3", DARK)]));
		expect(
			readManaged(
				(path) => {
					read.push(path);
					return file;
				},
				work,
				"ledgermath",
				STAGE,
			),
		).toMatchObject({ kind: "one", id: "E3" });
		expect(read).toEqual([stateFilePath(work, "ledgermath", STAGE)]);
		const missing = readManaged(
			() => {
				throw new Error("ENOENT: no such file or directory");
			},
			work,
			"ledgermath",
			STAGE,
		);
		expect(missing).toEqual({ kind: "unknown", reason: "the stage's state could not be read: ENOENT: no such file or directory" });
		expect(readManaged(() => "{", work, "ledgermath", STAGE).kind).toBe("unknown");
		expect(readManaged(() => file, undefined, "ledgermath", STAGE)).toMatchObject({ kind: "unknown", reason: expect.stringContaining("PULUMI_BACKEND_URL is not set") });
	});

	test("is present only when the listing agrees with the state: same ID and ARN, the comment the state last saw, no other claimant", () => {
		const listing = [summary("E1", "someone else's site", true), summary("E3", DARK, false)];
		expect(findDeployed(distributionsPage(page(listing)).items, STAGE, managedOne("E3", DARK))).toMatchObject({ kind: "present", id: "E3", recorded: { state: "dark", plan: "code" } });
		expect(findDeployed(distributionsPage(page(listing)).items, STAGE, { kind: "one", id: "E3", arn: "arn:aws:cloudfront::999999999999:distribution/E3", comment: DARK })).toMatchObject({
			kind: "unknown",
			reason: expect.stringContaining("not the arn:aws:cloudfront::999999999999:distribution/E3 the stage's state records"),
		});
	});

	test("two distributions carrying the comment: unknown, whichever the state records", () => {
		const items = distributionsPage(page([summary("E3", DARK, false), summary("E9", ON, true)])).items;
		for (const managed of [NOTHING, managedOne("E3", DARK), managedOne("E9", ON)]) {
			expect(findDeployed(items, STAGE, managed)).toMatchObject({ kind: "unknown", reason: expect.stringContaining("2 distributions say they are production-runs's public blobs (E3, E9)") });
		}
	});

	test("the stage's distribution with its comment gone, or edited: unknown, not absent", () => {
		for (const comment of ["", "edited by hand", "LedgerMath smr-runs public blobs (blobs/sha256/* only): state=on plan=code"]) {
			const deployed = findDeployed(distributionsPage(page([summary("E3", comment, true)])).items, STAGE, managedOne("E3", ON));
			expect(deployed).toMatchObject({ kind: "unknown", reason: expect.stringContaining("the stage's distribution E3 no longer carries the stage's comment") });
		}
		// Edited to another state's comment: not what the stage last deployed.
		const edited = findDeployed(distributionsPage(page([summary("E3", DARK, true)])).items, STAGE, managedOne("E3", ON));
		expect(edited).toMatchObject({ kind: "unknown", reason: expect.stringContaining("it was edited outside the stage") });
		// Deleted outside the stage.
		expect(findDeployed([], STAGE, managedOne("E3", ON))).toMatchObject({ kind: "unknown", reason: expect.stringContaining("which AWS does not list") });
		for (const target of ["off", "dark", "closed", "on"] as const) {
			expect(judgeTransition(edited, { state: target, plan: "code" }, ACTIVE).allowed).toBe(false);
		}
	});

	test("a look-alike carrying the comment, with an ACTIVE plan, while the stage's own has none: unknown, and on is refused", () => {
		const LOOKALIKE_ARN = "arn:aws:cloudfront::123456789012:distribution/E9";
		const lookalikeCovered = coverage(LOOKALIKE_ARN, [sub("ACTIVE", { resourceArns: [LOOKALIKE_ARN, WEB_ACL] })]);
		expect(lookalikeCovered.active).toBe(true);
		const cases: Array<[string, Array<Record<string, unknown>>, Managed, string]> = [
			["the state records none: a deploy would make a second distribution", [summary("E9", ON, true)], NOTHING, "the stage's state records no distribution"],
			["the stage's own is gone", [summary("E9", ON, true)], managedOne("E3", ON), "which AWS does not list"],
			["the stage's own lost its comment", [summary("E3", "edited by hand", true), summary("E9", ON, true)], managedOne("E3", ON), "distribution E9 says it is production-runs's public blobs, but the stage's state records E3"],
		];
		for (const [name, listing, managed, reason] of cases) {
			const deployed = readDeployed(() => page(listing), STAGE, managed);
			expect([name, deployed]).toEqual([name, { kind: "unknown", reason: expect.stringContaining(reason) }]);
			// Even handed the look-alike's coverage, nothing is allowed.
			for (const target of ["off", "dark", "closed", "on"] as const) expect([name, target, judgeTransition(deployed, { state: target, plan: "code" }, lookalikeCovered).allowed]).toEqual([name, target, false]);
		}
	});
});

describe("whether a plan covers the distribution", () => {
	test("reads the listing, scheduled changes included, paging by hand with --no-paginate and --next-token", () => {
		const calls: string[][] = [];
		const cli: AwsCli = (args) => {
			calls.push(args);
			if (!args.includes("--next-token")) return { subscriptionSummaries: [], nextToken: "T2" };
			return {
				subscriptionSummaries: [
					{
						...sub("ACTIVE", { planTier: "PRO" }),
						scheduledChange: { changeType: "CANCELLATION", effectiveDate: "2026-12-01T00:00:00Z" },
						createdAt: "2026-11-14T10:00:00Z",
						updatedAt: "2026-11-14T10:00:00Z",
						eTag: "v1",
					},
				],
			};
		};
		const all = readSubscriptions(cli);
		expect(calls).toEqual([
			["pricing-plan-manager", "list-subscriptions", "--no-paginate"],
			["pricing-plan-manager", "list-subscriptions", "--no-paginate", "--next-token", "T2"],
		]);
		expect(all).toEqual([{ ...sub("ACTIVE", { planTier: "PRO" }), scheduledChange: { changeType: "CANCELLATION", effectiveDate: "2026-12-01T00:00:00Z", planTier: null } }]);
		expect(subscriptionsPage({ subscriptionSummaries: [] })).toEqual({ subscriptions: [], nextToken: null });
		expect(() => subscriptionsPage({})).toThrow("no subscriptionSummaries");
		expect(() => subscriptionsPage({ subscriptionSummaries: [{ arn: "x" }] })).toThrow("lacks");
	});

	test("is yes only for an ACTIVE CloudFront plan that lists the distribution; any tier", () => {
		expect(ACTIVE).toMatchObject({ active: true, tier: "FREE", warnings: [] });
		expect(coverage(ARN, [sub("ACTIVE", { planTier: "PRO" })])).toMatchObject({ active: true, tier: "PRO" });
		for (const status of ["SYNC_IN_PROGRESS", "PENDING_APPROVAL", "FAILED"]) {
			const verdict = coverage(ARN, [sub(status)]);
			expect(verdict.active).toBe(false);
			expect(verdict.reason).toContain(status);
		}
		expect(coverage(ARN, [sub("ACTIVE", { resourceArns: ["arn:aws:cloudfront::123456789012:distribution/OTHER", WEB_ACL] })])).toMatchObject({ active: false, reason: "no plan lists the distribution" });
		expect(coverage(ARN, [sub("ACTIVE", { planFamily: "Other" })]).active).toBe(false);
		expect(NONE.active).toBe(false);
	});

	test("reports a scheduled cancellation or downgrade, with its date, and stays yes until it takes effect", () => {
		const cancelling = coverage(ARN, [sub("ACTIVE", { planTier: "PRO", scheduledChange: { changeType: "CANCELLATION", effectiveDate: "2026-12-01T00:00:00Z", planTier: null } })]);
		expect(cancelling.active).toBe(true);
		expect(cancelling.warnings).toEqual([
			"the PRO plan arn:aws:pricingplanmanager::123456789012:subscription:sub_EXAMPLE has a scheduled CANCELLATION, effective on 2026-12-01T00:00:00Z; from then no plan covers the distribution, and the watch disables it",
		]);
		const undated = coverage(ARN, [sub("ACTIVE", { scheduledChange: { changeType: "CANCELLATION", effectiveDate: null, planTier: null } })]);
		expect(undated.warnings[0]).toContain("effective on a date AWS has not set yet");
		const downgrade = coverage(ARN, [sub("ACTIVE", { planTier: "PRO", scheduledChange: { changeType: "DOWNGRADE", effectiveDate: "2026-12-01T00:00:00Z", planTier: "FREE" } })]);
		expect(downgrade.warnings[0]).toContain("scheduled DOWNGRADE to FREE, effective on 2026-12-01T00:00:00Z");
	});
});

describe("the transitions", () => {
	const deploy = (state: PublicBlobsState, plan: PlanAttachment = "code"): Target => ({ state, plan });

	// [what is deployed, the target, the plan check, allowed]
	const situations: Record<string, Deployed> = {
		"nothing": { kind: "absent" },
		"dark, disabled": present("dark", false),
		"dark, disabling": present("dark", false, "InProgress"),
		"dark, enabled by hand": present("dark", true),
		"closed, enabled": present("closed", true),
		"on, enabled": present("on", true),
		"on, disabled by the watch": present("on", false),
		"closed, disabled by the watch": present("closed", false),
		"cannot tell": { kind: "unknown", reason: "aws: the SSO session has expired" },
	};
	const targets: Record<string, Target> = {
		off: deploy("off"),
		dark: deploy("dark"),
		closed: deploy("closed"),
		"on (plan ACTIVE)": deploy("on"),
		"dark, plan changed": deploy("dark", "console"),
		"closed, plan changed": deploy("closed", "console"),
		"on, plan changed": deploy("on", "console"),
	};
	const Y = true;
	const N = false;
	// Columns in the order of `targets`.
	const expected: Record<string, boolean[]> = {
		"nothing":                       [Y, Y, N, N, Y, N, N],
		"dark, disabled":                [Y, Y, Y, Y, Y, N, N],
		"dark, disabling":               [N, Y, Y, Y, N, N, N],
		"dark, enabled by hand":         [N, Y, Y, Y, N, N, N],
		"closed, enabled":               [N, Y, Y, Y, N, N, N],
		"on, enabled":                   [N, Y, Y, Y, N, N, N],
		"on, disabled by the watch":     [N, Y, N, N, N, N, N],
		"closed, disabled by the watch": [N, Y, N, N, N, N, N],
		"cannot tell":                   [N, N, N, N, N, N, N],
	};

	test("allow exactly the table: from an enabled distribution only dark (or staying closed/on); off and a plan change only from dark, disabled", () => {
		const got: Record<string, boolean[]> = {};
		for (const [name, deployed] of Object.entries(situations)) {
			got[name] = Object.values(targets).map((target) => judgeTransition(deployed, target, ACTIVE).allowed);
		}
		expect(got).toEqual(expected);
	});

	test("never allow on without an ACTIVE plan, nor when AWS cannot say", () => {
		for (const [name, deployed] of Object.entries(situations)) {
			expect([name, judgeTransition(deployed, deploy("on"), NONE).allowed]).toEqual([name, false]);
			expect([name, judgeTransition(deployed, deploy("on"), null).allowed]).toEqual([name, false]);
			expect([name, judgeTransition(deployed, deploy("on"), coverage(ARN, [sub("SYNC_IN_PROGRESS")])).allowed]).toEqual([name, false]);
		}
	});

	test("closed needs no plan: it is how a plan gets attached when a disabled distribution cannot take one", () => {
		expect(judgeTransition(present("dark", false), deploy("closed"), NONE).allowed).toBe(true);
		expect(judgeTransition(present("dark", false), deploy("closed"), null).allowed).toBe(true);
	});

	test("say why, and what to do", () => {
		const enabledOff = judgeTransition(present("on", true), deploy("off"), ACTIVE);
		expect(enabledOff.reason).toContain("is enabled, Deployed");
		expect(enabledOff.reason).toContain('Deploy with PUBLIC_BLOBS.state "dark"');
		expect(enabledOff.reason).toContain("wait until the distribution reports disabled (Enabled false, Status Deployed");
		expect(enabledOff.reason).toContain('"off" would cancel its plan while it may still serve');
		const lapsed = judgeTransition(present("on", true), deploy("on"), NONE);
		expect(lapsed.reason).toContain("no ACTIVE plan covers it (no plan lists the distribution)");
		expect(lapsed.reason).toContain("the watch disables it within 5 minutes of the plan lapsing (10 if AWS cannot be asked); to disable it at once, deploy \"dark\"");
		const fromDark = judgeTransition(present("dark", false), deploy("on"), NONE);
		expect(fromDark.reason).toContain('deploy "closed" first if AWS will not subscribe a disabled distribution');
		const watched = judgeTransition(present("on", false), deploy("on"), ACTIVE);
		expect(watched.reason).toContain("the watch, or a person, disabled it, and a deploy would not enable it again");
		expect(judgeTransition(present("on", true), deploy("on", "console"), ACTIVE).reason).toContain('Changing PUBLIC_BLOBS.plan from "code" to "console"');
		expect(judgeTransition({ kind: "absent" }, deploy("on"), ACTIVE).reason).toContain('A distribution is made only disabled: deploy "dark" first.');
		expect(judgeTransition({ kind: "unknown", reason: "x" }, deploy("off"), null).reason).toBe("what is deployed cannot be told: x");
	});

	test("need a protected stage for anything but off: sst remove runs no check, and only SST's protection stops it", () => {
		for (const state of ["dark", "closed", "on"] as const) {
			expect(stageRefusals(state, { protect: true })).toEqual([]);
			const refusals = stageRefusals(state, { protect: false });
			expect(refusals.length).toBe(1);
			expect(refusals[0]).toContain("the stage is not protected");
			expect(refusals[0]).toContain("sst remove does not run this program");
			expect(refusals[0]).toContain("protect: true");
		}
		// off makes nothing, and takes down only what the table lets it.
		expect(stageRefusals("off", { protect: false })).toEqual([]);
	});

	test("carry a scheduled cancellation through as a warning", () => {
		const verdict = coverage(ARN, [sub("ACTIVE", { scheduledChange: { changeType: "CANCELLATION", effectiveDate: "2026-12-01T00:00:00Z", planTier: null } })]);
		const judgement = judgeTransition(present("on", true), deploy("on"), verdict);
		expect(judgement.allowed).toBe(true);
		expect(judgement.warnings[0]).toContain("CANCELLATION, effective on 2026-12-01T00:00:00Z");
	});
});
