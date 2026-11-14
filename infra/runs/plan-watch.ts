/**
 * The public-blobs watch: every WATCH_SCHEDULE, whether anyone deploys or
 * not, it asks AWS whether an ACTIVE plan covers the stage's distribution,
 * and disables the distribution if not. It fails closed: when it cannot tell,
 * it records that on the distribution (a tag), and the next time it cannot
 * tell either, it disables it. It does nothing to a disabled distribution;
 * while PUBLIC_BLOBS.state is "off", or on any stage but PUBLIC_BLOBS.stage,
 * it does not exist.
 *
 * A "closed" distribution (enabled, answering 404 to everything, before its
 * plan is attached) is left alone for CLOSED_GRACE_MINUTES after its last
 * change, so that the plan can be attached; after that it is disabled too if
 * still no plan covers it.
 *
 * A plan with a scheduled cancellation or downgrade is reported, with its
 * date, as a warning; it is acted on only once it stops being ACTIVE.
 *
 * The decisions are here, with the AWS calls behind WatchClients, so tests
 * can stand them in; plan-watch-handler.ts gives the real ones.
 */

import { CLOSED_GRACE_MS, coverage, type PlanVerdict, parseComment, type SubscriptionSummary } from "./public-blobs-guard";

/** The tag that says the watch could not tell, and since when. */
export const UNKNOWN_MARKER_TAG = "ledgermath-plan-watch-unknown-since";

export interface WatchedDistribution {
	enabled: boolean;
	status: string;
	comment: string;
	lastModified: Date;
}

export interface WatchClients {
	getDistribution(): Promise<WatchedDistribution>;
	/** Every subscription of the account; throws when AWS cannot be asked or answers something unreadable. */
	listSubscriptions(): Promise<SubscriptionSummary[]>;
	/** Sets Enabled to false. */
	disable(): Promise<void>;
	readMarker(): Promise<string | null>;
	writeMarker(value: string): Promise<void>;
	clearMarker(): Promise<void>;
}

export interface WatchConfig {
	stage: string;
	distributionArn: string;
}

export interface WatchResult {
	action: "none" | "disabled" | "marked";
	reason: string;
	warnings: string[];
}

/** The IAM actions the watch's role may take on this one distribution. */
export const WATCH_DISTRIBUTION_ACTIONS = [
	"cloudfront:GetDistribution",
	"cloudfront:GetDistributionConfig",
	"cloudfront:UpdateDistribution",
	"cloudfront:ListTagsForResource",
	"cloudfront:TagResource",
	"cloudfront:UntagResource",
] as const;

/**
 * The watch's permissions (SST adds only the Lambda basic execution policy,
 * for its own logs): list the account's plan subscriptions (Pricing Plan
 * Manager defines no resource type, so "*"), and read, update and tag this
 * one distribution, nothing else.
 */
export function watchPermissions(distributionArn: string): Array<{ actions: string[]; resources: string[] }> {
	return [
		{ actions: ["pricingplanmanager:ListSubscriptions"], resources: ["*"] },
		{ actions: [...WATCH_DISTRIBUTION_ACTIONS], resources: [distributionArn] },
	];
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One run of the watch. Throws only when the distribution cannot be read, or cannot be disabled when it must be. */
export async function watchOnce(clients: WatchClients, config: WatchConfig, now: Date): Promise<WatchResult> {
	const distribution = await clients.getDistribution();
	if (!distribution.enabled) return { action: "none", reason: `the distribution is disabled (${distribution.status})`, warnings: [] };
	// A comment that records no state is treated like "on": the plan must cover it.
	const recorded = parseComment(distribution.comment, config.stage);
	const disable = async (reason: string, warnings: string[]): Promise<WatchResult> => {
		await clients.disable();
		return { action: "disabled", reason, warnings };
	};

	let verdict: PlanVerdict | null = null;
	let failure = "";
	try {
		verdict = coverage(config.distributionArn, await clients.listSubscriptions());
	} catch (error) {
		failure = message(error);
	}
	const warnings = [...(verdict?.warnings ?? [])];

	if (recorded?.state === "closed" && verdict?.active !== true) {
		const age = now.getTime() - distribution.lastModified.getTime();
		if (age < CLOSED_GRACE_MS) {
			const left = Math.ceil((CLOSED_GRACE_MS - age) / 60_000);
			const why = verdict === null ? `AWS could not be asked (${failure})` : verdict.reason;
			return { action: "none", reason: `closed, serving nothing, and not yet covered: ${why}; disabled in ${left} minutes unless a plan covers it`, warnings };
		}
	}

	if (verdict !== null) {
		if (verdict.active) {
			try {
				if ((await clients.readMarker()) !== null) await clients.clearMarker();
			} catch (error) {
				warnings.push(`could not clear the marker tag ${UNKNOWN_MARKER_TAG}: ${message(error)}`);
			}
			return { action: "none", reason: verdict.reason, warnings };
		}
		return disable(`no ACTIVE plan covers the distribution: ${verdict.reason}`, warnings);
	}

	let since: string | null;
	try {
		since = await clients.readMarker();
	} catch (error) {
		return disable(`AWS could not be asked (${failure}), and the marker tag could not be read (${message(error)})`, warnings);
	}
	if (since !== null) return disable(`AWS could not be asked twice in a row (first at ${since}, now: ${failure})`, warnings);
	try {
		await clients.writeMarker(now.toISOString());
	} catch (error) {
		return disable(`AWS could not be asked (${failure}), and the marker tag could not be written (${message(error)})`, warnings);
	}
	return { action: "marked", reason: `AWS could not be asked (${failure}); disabled next time if it still cannot be`, warnings };
}
