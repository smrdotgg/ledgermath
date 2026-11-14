import { describe, expect, test } from "bun:test";

import { distributionComment, type PlanAttachment, type PublicBlobsState } from "../infra/runs/public-blobs";
import {
	type AwsCli,
	coverage,
	type Deployed,
	distributionsPage,
	findDeployed,
	isQuiet,
	judgeTransition,
	type PlanVerdict,
	parseComment,
	readDeployed,
	readSubscriptions,
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
		expect(readDeployed(() => EMPTY_ACCOUNT, STAGE)).toEqual({ kind: "absent" });
	});

	test("pages by hand, with --no-paginate and --marker, and finds this stage's distribution among others", () => {
		const calls: string[][] = [];
		const cli: AwsCli = (args) => {
			calls.push(args);
			if (!args.includes("--marker")) return page([summary("E1", "someone else's site", true)], "M2");
			return page([summary("E2", distributionComment("smr-runs", "on", "code"), true), summary("E3", distributionComment(STAGE, "dark", "code"), false)]);
		};
		const deployed = readDeployed(cli, STAGE);
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
		expect(readDeployed(failing, STAGE)).toEqual({ kind: "unknown", reason: "aws: error: the SSO session has expired more" });
		// What the CLI's own paging prints for an empty account is no output at all; JSON.parse("") throws.
		expect(readDeployed(() => JSON.parse(""), STAGE).kind).toBe("unknown");
		expect(readDeployed(() => ({}), STAGE).kind).toBe("unknown");
		expect(readDeployed(() => ({ DistributionList: { IsTruncated: true, Quantity: 0 } }), STAGE)).toMatchObject({ kind: "unknown", reason: expect.stringContaining("no NextMarker") });
		expect(readDeployed(() => ({ DistributionList: { IsTruncated: false, Quantity: 2, Items: [] } }), STAGE).kind).toBe("unknown");
		const two = [summary("E1", distributionComment(STAGE, "on", "code"), true), summary("E2", distributionComment(STAGE, "dark", "code"), false)];
		expect(readDeployed(() => page(two), STAGE)).toMatchObject({ kind: "unknown", reason: expect.stringContaining("2 distributions") });
		const odd = [summary("E1", "LedgerMath production-runs public blobs, hand-edited", true)];
		expect(findDeployed(distributionsPage(page(odd)).items, STAGE)).toMatchObject({ kind: "unknown", reason: expect.stringContaining("does not record") });
	});

	test("counts as disabled only once every edge has it", () => {
		expect(isQuiet({ enabled: false, status: "Deployed" })).toBe(true);
		expect(isQuiet({ enabled: false, status: "InProgress" })).toBe(false);
		expect(isQuiet({ enabled: true, status: "Deployed" })).toBe(false);
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
	const deploy = (state: PublicBlobsState, plan: PlanAttachment = "code"): Target => ({ kind: "deploy", state, plan });
	const REMOVE: Target = { kind: "remove" };

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
		remove: REMOVE,
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
		"nothing":                       [Y, Y, Y, N, N, Y, N, N],
		"dark, disabled":                [Y, Y, Y, Y, Y, Y, N, N],
		"dark, disabling":               [N, N, Y, Y, Y, N, N, N],
		"dark, enabled by hand":         [N, N, Y, Y, Y, N, N, N],
		"closed, enabled":               [N, N, Y, Y, Y, N, N, N],
		"on, enabled":                   [N, N, Y, Y, Y, N, N, N],
		"on, disabled by the watch":     [N, N, Y, N, N, N, N, N],
		"closed, disabled by the watch": [N, N, Y, N, N, N, N, N],
		"cannot tell":                   [N, N, N, N, N, N, N, N],
	};

	test("allow exactly the table: from an enabled distribution only dark (or staying closed/on); off, removal and a plan change only from dark, disabled", () => {
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
		expect(judgeTransition(present("on", true), REMOVE, ACTIVE).reason).toContain("removing the stage would cancel its plan while it may still serve");
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

	test("carry a scheduled cancellation through as a warning", () => {
		const verdict = coverage(ARN, [sub("ACTIVE", { scheduledChange: { changeType: "CANCELLATION", effectiveDate: "2026-12-01T00:00:00Z", planTier: null } })]);
		const judgement = judgeTransition(present("on", true), deploy("on"), verdict);
		expect(judgement.allowed).toBe(true);
		expect(judgement.warnings[0]).toContain("CANCELLATION, effective on 2026-12-01T00:00:00Z");
	});
});
