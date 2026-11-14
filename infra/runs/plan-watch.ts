/**
 * The public-blobs watch: every WATCH_SCHEDULE, whether anyone deploys or
 * not, it asks AWS whether an ACTIVE plan covers the stage's distribution,
 * and disables the distribution if not. It fails closed: when it cannot tell,
 * it records that on the distribution (a tag), and when it cannot tell and
 * finds that tag already there (left by an earlier run that could not tell
 * either, not necessarily the last run), it disables it. It does nothing to a
 * disabled distribution; while PUBLIC_BLOBS.state is "off", or on any stage
 * but PUBLIC_BLOBS.stage, it does not exist.
 *
 * It polls, so it cannot make uncovered delivery impossible. From the moment
 * a plan stops covering the distribution to the moment no edge serves it,
 * the time is the wait for the next run, plus the run, plus CloudFront's
 * propagation of the disabled configuration, during which edges that do not
 * have it yet keep serving with the old one (HowToUpdateDistribution.html);
 * a run longer when the plans cannot be listed; and no end at all while
 * CloudFront refuses the watch's calls.
 *
 * When the distribution itself cannot be read, the watch cannot tell whether
 * it is enabled, or a closed one within its grace, so it takes it to be
 * enabled and past its grace: it goes on to the plans, and disables it on
 * the same terms as any other, through GetDistributionConfig and
 * UpdateDistribution, which may answer when GetDistribution did not. If
 * CloudFront answers none of them, the run fails, and the distribution goes
 * on as it is.
 *
 * A "closed" distribution (enabled, answering 404 to everything, before its
 * plan is attached) is left alone for CLOSED_GRACE_MINUTES after its last
 * change, so that the plan can be attached; after that it is disabled too if
 * still no plan covers it.
 *
 * A plan with a scheduled cancellation or downgrade is reported, with its
 * date, as a warning; it is acted on only once it stops being ACTIVE. Every
 * status but ACTIVE counts as no plan, SYNC_IN_PROGRESS included, which a
 * subscription reports while AWS applies a change to it. That is deliberate:
 * the watch cannot tell a covered distribution whose plan is being changed
 * from one whose plan is going away, so it fails closed, and disables a
 * covered distribution during a routine change to its plan. Plans are
 * changed only with the distribution dark (README, "Changing or cancelling
 * the plan").
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
	/** Throws when CloudFront cannot be asked, or answers something unreadable. */
	getDistribution(): Promise<WatchedDistribution>;
	/** Every subscription of the account; throws when AWS cannot be asked or answers something unreadable. */
	listSubscriptions(): Promise<SubscriptionSummary[]>;
	/** Sets Enabled to false (disableDistribution): true when it did, false when the distribution was disabled already. */
	disable(): Promise<boolean>;
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

/** How many times disabling reads the configuration and writes it back, when the write meets a configuration changed since the read. */
export const DISABLE_ATTEMPTS = 3;

/** What disabling needs from CloudFront: the configuration and its ETag (GetDistributionConfig), and an update under that ETag (UpdateDistribution). */
export interface DistributionConfigApi<C> {
	read(): Promise<{ config: C; enabled: boolean; eTag: string }>;
	/** Writes `config` back with Enabled false, if the distribution's ETag is still `eTag`. */
	writeDisabled(config: C, eTag: string): Promise<void>;
}

/** CloudFront's refusal of an update whose ETag is no longer the configuration's: it changed after it was read (HTTP 412). */
export function isConfigConflict(error: unknown): boolean {
	return error instanceof Error && error.name === "PreconditionFailed";
}

/**
 * Sets Enabled to false, keeping the rest of the configuration as AWS
 * returned it. When the configuration changes between the read and the write
 * (a deploy, a person), CloudFront refuses the write; then it reads again and
 * tries again, DISABLE_ATTEMPTS times in all, and throws the last refusal if
 * none succeeds. Any other error is thrown at once. True when it disabled the
 * distribution, false when it found it disabled already.
 */
export async function disableDistribution<C>(api: DistributionConfigApi<C>, attempts: number = DISABLE_ATTEMPTS): Promise<boolean> {
	for (let attempt = 1; ; attempt++) {
		const { config, enabled, eTag } = await api.read();
		if (!enabled) return false;
		try {
			await api.writeDisabled(config, eTag);
			return true;
		} catch (error) {
			if (!isConfigConflict(error) || attempt >= attempts) throw error;
		}
	}
}

/** One run of the watch. Throws only when the distribution must be disabled and cannot be. */
export async function watchOnce(clients: WatchClients, config: WatchConfig, now: Date): Promise<WatchResult> {
	let distribution: WatchedDistribution | null = null;
	let unreadable = "";
	try {
		distribution = await clients.getDistribution();
	} catch (error) {
		unreadable = message(error);
	}
	if (distribution !== null && !distribution.enabled) return { action: "none", reason: `the distribution is disabled (${distribution.status})`, warnings: [] };
	// A comment that records no state is treated like "on": the plan must cover it.
	const recorded = distribution === null ? null : parseComment(distribution.comment, config.stage);
	const warnings: string[] =
		distribution === null ? [`the distribution could not be read (${unreadable}), so it is taken to be enabled, and not a closed one within its grace`] : [];
	const disable = async (reason: string): Promise<WatchResult> => {
		if (await clients.disable()) return { action: "disabled", reason, warnings };
		return { action: "none", reason: `${reason}; it was disabled already`, warnings };
	};

	let verdict: PlanVerdict | null = null;
	let failure = "";
	try {
		verdict = coverage(config.distributionArn, await clients.listSubscriptions());
	} catch (error) {
		failure = message(error);
	}
	warnings.push(...(verdict?.warnings ?? []));

	if (distribution !== null && recorded?.state === "closed" && verdict?.active !== true) {
		const age = now.getTime() - distribution.lastModified.getTime();
		if (age < CLOSED_GRACE_MS) {
			const left = Math.ceil((CLOSED_GRACE_MS - age) / 60_000);
			const why = verdict === null ? `AWS could not be asked (${failure})` : verdict.reason;
			return { action: "none", reason: `closed, serving no blob, and not yet covered: ${why}; left alone ${left} more minutes, then disabled by the next run unless a plan covers it`, warnings };
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
		return disable(`no ACTIVE plan covers the distribution: ${verdict.reason}`);
	}

	let since: string | null;
	try {
		since = await clients.readMarker();
	} catch (error) {
		return disable(`AWS could not be asked (${failure}), and the marker tag could not be read (${message(error)})`);
	}
	// Any value counts: the marker is set by a run that could not tell, and
	// cleared by the next that could (if clearing worked).
	if (since !== null) return disable(`AWS could not be asked now (${failure}), and the marker tag says it could not be at ${since} either`);
	try {
		await clients.writeMarker(now.toISOString());
	} catch (error) {
		return disable(`AWS could not be asked (${failure}), and the marker tag could not be written (${message(error)})`);
	}
	return { action: "marked", reason: `AWS could not be asked (${failure}); disabled next time if it still cannot be`, warnings };
}
