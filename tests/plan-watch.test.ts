import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { UNKNOWN_MARKER_TAG, WATCH_DISTRIBUTION_ACTIONS, type WatchClients, type WatchedDistribution, watchOnce, watchPermissions } from "../infra/runs/plan-watch";
import { CLOSED_GRACE_MINUTES, distributionComment, WATCH_SCHEDULE } from "../infra/runs/public-blobs";
import type { SubscriptionSummary } from "../infra/runs/public-blobs-guard";

const STAGE = "production-runs";
const ARN = "arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE";
const CONFIG = { stage: STAGE, distributionArn: ARN };
const NOW = new Date("2026-11-14T12:00:00Z");
const RESOURCES = readFileSync(join(import.meta.dir, "..", "infra", "runs", "public-blobs-stack.ts"), "utf8");

function sub(status: string, extra: Partial<SubscriptionSummary> = {}): SubscriptionSummary {
	return { arn: "arn:aws:pricingplanmanager::123456789012:subscription:sub_EXAMPLE", planFamily: "CloudFront", planTier: "FREE", status, resourceArns: [ARN], scheduledChange: null, ...extra };
}

interface StandIn {
	clients: WatchClients;
	calls: string[];
	marker: { value: string | null };
}

/** Stand-in clients: the distribution as given, the listing as given (or a throw), a marker tag kept in memory; every call recorded. */
function standIn(options: {
	distribution?: Partial<WatchedDistribution>;
	subscriptions?: SubscriptionSummary[] | Error;
	marker?: string | null;
	markerFails?: "read" | "write";
	disableFails?: boolean;
}): StandIn {
	const calls: string[] = [];
	const marker = { value: options.marker ?? null };
	const distribution: WatchedDistribution = {
		enabled: true,
		status: "Deployed",
		comment: distributionComment(STAGE, "on", "code"),
		lastModified: new Date("2026-11-01T00:00:00Z"),
		...options.distribution,
	};
	const clients: WatchClients = {
		async getDistribution() {
			calls.push("getDistribution");
			return distribution;
		},
		async listSubscriptions() {
			calls.push("listSubscriptions");
			if (options.subscriptions instanceof Error) throw options.subscriptions;
			return options.subscriptions ?? [];
		},
		async disable() {
			calls.push("disable");
			if (options.disableFails) throw new Error("AccessDenied: cloudfront:UpdateDistribution");
		},
		async readMarker() {
			calls.push("readMarker");
			if (options.markerFails === "read") throw new Error("ThrottlingException");
			return marker.value;
		},
		async writeMarker(value) {
			calls.push(`writeMarker ${value}`);
			if (options.markerFails === "write") throw new Error("ThrottlingException");
			marker.value = value;
		},
		async clearMarker() {
			calls.push("clearMarker");
			marker.value = null;
		},
	};
	return { clients, calls, marker };
}

const UNREACHABLE = new Error("connect ETIMEDOUT pricingplanmanager.us-east-1.amazonaws.com");

describe("the watch", () => {
	test("covered: does nothing, and clears a marker left by a run that could not tell", async () => {
		const plain = standIn({ subscriptions: [sub("ACTIVE")] });
		expect(await watchOnce(plain.clients, CONFIG, NOW)).toMatchObject({ action: "none", reason: expect.stringContaining("is ACTIVE"), warnings: [] });
		expect(plain.calls).toEqual(["getDistribution", "listSubscriptions", "readMarker"]);
		const marked = standIn({ subscriptions: [sub("ACTIVE")], marker: "2026-11-14T11:55:00.000Z" });
		expect((await watchOnce(marked.clients, CONFIG, NOW)).action).toBe("none");
		expect(marked.calls).toEqual(["getDistribution", "listSubscriptions", "readMarker", "clearMarker"]);
		expect(marked.marker.value).toBeNull();
	});

	test("not covered: disables the distribution and says why", async () => {
		for (const subscriptions of [[], [sub("FAILED")], [sub("PENDING_APPROVAL")], [sub("ACTIVE", { resourceArns: ["arn:aws:cloudfront::123456789012:distribution/OTHER"] })]]) {
			const s = standIn({ subscriptions });
			const result = await watchOnce(s.clients, CONFIG, NOW);
			expect(result.action).toBe("disabled");
			expect(result.reason).toStartWith("no ACTIVE plan covers the distribution: ");
			expect(s.calls).toEqual(["getDistribution", "listSubscriptions", "disable"]);
		}
	});

	test("cannot tell once: leaves the distribution enabled and records the moment on it", async () => {
		const s = standIn({ subscriptions: UNREACHABLE });
		const result = await watchOnce(s.clients, CONFIG, NOW);
		expect(result).toMatchObject({ action: "marked", reason: expect.stringContaining("ETIMEDOUT") });
		expect(s.calls).toEqual(["getDistribution", "listSubscriptions", "readMarker", "writeMarker 2026-11-14T12:00:00.000Z"]);
		expect(s.marker.value).toBe("2026-11-14T12:00:00.000Z");
		expect(s.calls).not.toContain("disable");
	});

	test("cannot tell twice in a row: disables the distribution", async () => {
		const s = standIn({ subscriptions: UNREACHABLE, marker: "2026-11-14T11:55:00.000Z" });
		const result = await watchOnce(s.clients, CONFIG, NOW);
		expect(result).toMatchObject({ action: "disabled", reason: expect.stringContaining("twice in a row (first at 2026-11-14T11:55:00.000Z") });
		expect(s.calls).toEqual(["getDistribution", "listSubscriptions", "readMarker", "disable"]);
	});

	test("cannot tell once, two runs apart: marks, then disables", async () => {
		const s = standIn({ subscriptions: UNREACHABLE });
		expect((await watchOnce(s.clients, CONFIG, NOW)).action).toBe("marked");
		expect((await watchOnce(s.clients, CONFIG, new Date(NOW.getTime() + 5 * 60_000))).action).toBe("disabled");
	});

	test("an unreadable listing counts as cannot tell", async () => {
		const s = standIn({ subscriptions: new Error("ListSubscriptions: no subscriptionSummaries in its output") });
		expect((await watchOnce(s.clients, CONFIG, NOW)).action).toBe("marked");
	});

	test("cannot tell, and cannot keep the marker either: disables at once (fails closed)", async () => {
		for (const markerFails of ["read", "write"] as const) {
			const s = standIn({ subscriptions: UNREACHABLE, markerFails });
			const result = await watchOnce(s.clients, CONFIG, NOW);
			expect(result.action).toBe("disabled");
			expect(result.reason).toContain(`could not be ${markerFails === "read" ? "read" : "written"}`);
		}
	});

	test("already disabled: does nothing at all, and asks nothing else", async () => {
		for (const status of ["Deployed", "InProgress"]) {
			const s = standIn({ distribution: { enabled: false, status }, subscriptions: UNREACHABLE, marker: "2026-11-14T11:55:00.000Z" });
			expect(await watchOnce(s.clients, CONFIG, NOW)).toEqual({ action: "none", reason: `the distribution is disabled (${status})`, warnings: [] });
			expect(s.calls).toEqual(["getDistribution"]);
		}
	});

	test("reports a scheduled cancellation with its date, and leaves a covered distribution enabled", async () => {
		const s = standIn({ subscriptions: [sub("ACTIVE", { planTier: "PRO", scheduledChange: { changeType: "CANCELLATION", effectiveDate: "2026-12-01T00:00:00Z", planTier: null } })] });
		const result = await watchOnce(s.clients, CONFIG, NOW);
		expect(result.action).toBe("none");
		expect(result.warnings).toEqual([expect.stringContaining("scheduled CANCELLATION, effective on 2026-12-01T00:00:00Z")]);
		expect(s.calls).not.toContain("disable");
	});

	test("leaves a closed distribution alone for the grace after its last change, then disables it if still uncovered", async () => {
		const closed = distributionComment(STAGE, "closed", "console");
		const fresh = standIn({ distribution: { comment: closed, lastModified: new Date(NOW.getTime() - 10 * 60_000) }, subscriptions: [] });
		const waiting = await watchOnce(fresh.clients, CONFIG, NOW);
		expect(waiting).toMatchObject({ action: "none", reason: expect.stringContaining(`disabled in ${CLOSED_GRACE_MINUTES - 10} minutes unless a plan covers it`) });
		expect(fresh.calls).not.toContain("disable");
		const unreachable = standIn({ distribution: { comment: closed, lastModified: new Date(NOW.getTime() - 10 * 60_000) }, subscriptions: UNREACHABLE });
		expect((await watchOnce(unreachable.clients, CONFIG, NOW)).action).toBe("none");
		const stale = standIn({ distribution: { comment: closed, lastModified: new Date(NOW.getTime() - (CLOSED_GRACE_MINUTES + 1) * 60_000) }, subscriptions: [] });
		expect((await watchOnce(stale.clients, CONFIG, NOW)).action).toBe("disabled");
		const covered = standIn({ distribution: { comment: closed, lastModified: new Date(NOW.getTime() - 10 * 60_000) }, subscriptions: [sub("ACTIVE")] });
		expect(await watchOnce(covered.clients, CONFIG, NOW)).toMatchObject({ action: "none", reason: expect.stringContaining("is ACTIVE") });
	});

	test("treats a distribution whose comment records no state like on: an uncovered one is disabled", async () => {
		for (const comment of ["edited by hand", distributionComment(STAGE, "dark", "code")]) {
			const s = standIn({ distribution: { comment }, subscriptions: [] });
			expect((await watchOnce(s.clients, CONFIG, NOW)).action).toBe("disabled");
		}
	});

	test("fails loudly when it must disable and cannot", async () => {
		const s = standIn({ subscriptions: [], disableFails: true });
		await expect(watchOnce(s.clients, CONFIG, NOW)).rejects.toThrow("AccessDenied");
	});
});

describe("the watch's permissions", () => {
	test("are listing the plans, and reading, updating and tagging this one distribution; nothing else", () => {
		expect(watchPermissions(ARN)).toEqual([
			{ actions: ["pricingplanmanager:ListSubscriptions"], resources: ["*"] },
			{
				actions: [
					"cloudfront:GetDistribution",
					"cloudfront:GetDistributionConfig",
					"cloudfront:UpdateDistribution",
					"cloudfront:ListTagsForResource",
					"cloudfront:TagResource",
					"cloudfront:UntagResource",
				],
				resources: [ARN],
			},
		]);
		for (const action of WATCH_DISTRIBUTION_ACTIONS) expect(action).not.toMatch(/\*|Delete|Create/);
		expect(UNKNOWN_MARKER_TAG).toMatch(/^[\w.:/=+\-@]{1,128}$/);
	});

	test("are what the stage gives it, every 5 minutes, with the distribution's id and ARN, as a real function even under sst dev", () => {
		expect(WATCH_SCHEDULE).toBe("rate(5 minutes)");
		expect(RESOURCES).toContain('new sst.aws.CronV2("PublicBlobsWatch", {');
		expect(RESOURCES).toContain('handler: "infra/runs/plan-watch-handler.handler",\n\t\t\tdev: false,');
		expect(RESOURCES).toContain("permissions: distribution.arn.apply((arn) => watchPermissions(arn)),");
		expect(RESOURCES).toContain("LEDGERMATH_DISTRIBUTION_ID: distribution.id,");
		expect(RESOURCES).toContain("LEDGERMATH_DISTRIBUTION_ARN: distribution.arn,");
	});
});
