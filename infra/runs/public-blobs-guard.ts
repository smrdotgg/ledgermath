/**
 * What is deployed, read back from AWS, and what a deploy may do from there.
 * The deploy (public-blobs-stack.ts) and the watch (plan-watch.ts) both use
 * it, so they agree on what "covered by a plan" means.
 *
 * What the stage last deployed is recorded in the distribution's comment
 * (distributionComment in public-blobs.ts), which `aws cloudfront
 * list-distributions` returns beside Enabled and Status: one read-only call
 * says whether a distribution exists, whether it is enabled or still
 * deploying, and the state and plan attachment it was last deployed with.
 *
 * The rule (judgeTransition): a distribution is made only disabled ("dark");
 * from an enabled one, or one still deploying, the only way out is "dark";
 * "off", removal, and a change of PUBLIC_BLOBS.plan are made only from "dark"
 * once the distribution reports disabled; "closed" and "on" only from what
 * the stage itself left (so not after the watch, or a person, disabled it
 * behind the stage's back); and "on" only when an ACTIVE plan covers it.
 *
 * Plain data: no SST global, no AWS client.
 */

import { CLOSED_GRACE_MINUTES, DEPLOYED_STATES, type DeployedState, PLAN_ATTACHMENTS, type PlanAttachment, type PublicBlobsState, WATCH_INTERVAL_MINUTES } from "./public-blobs";

export interface RecordedDeploy {
	state: DeployedState;
	plan: PlanAttachment;
}

/** The state and plan attachment a distribution's comment records, for `stage`; null when it records none for it. */
export function parseComment(comment: string, stage: string): RecordedDeploy | null {
	const match = /^LedgerMath (\S+) public blobs \(blobs\/sha256\/\* only\): state=([a-z]+) plan=([a-z]+)$/.exec(comment);
	if (match === null || match[1] !== stage) return null;
	const state = DEPLOYED_STATES.find((s) => s === match[2]);
	const plan = PLAN_ATTACHMENTS.find((p) => p === match[3]);
	return state === undefined || plan === undefined ? null : { state, plan };
}

/**
 * Whether a comment is one of this stage's public-blobs distributions,
 * recorded state or not (an edited comment is then "unknown", not "absent").
 * The stage is followed by " public blobs", so no other stage's matches.
 */
export function isStageComment(comment: string, stage: string): boolean {
	return comment.startsWith(`LedgerMath ${stage} public blobs`);
}

export interface DistributionSummary {
	id: string;
	arn: string;
	comment: string;
	enabled: boolean;
	/** "Deployed" once every edge has the configuration; "InProgress" until then. */
	status: string;
}

/** One page of `aws cloudfront list-distributions --no-paginate [--marker M]`, and the marker of the next, or null. */
export function distributionsPage(output: unknown): { items: DistributionSummary[]; nextMarker: string | null } {
	const list = (output as { DistributionList?: unknown }).DistributionList as
		| { IsTruncated?: unknown; NextMarker?: unknown; Items?: unknown; Quantity?: unknown }
		| undefined;
	if (list === undefined || typeof list.IsTruncated !== "boolean" || typeof list.Quantity !== "number") {
		throw new Error("aws cloudfront list-distributions: no DistributionList with IsTruncated and Quantity in its output");
	}
	const raw = list.Items === undefined ? [] : list.Items;
	if (!Array.isArray(raw) || raw.length !== list.Quantity) throw new Error("aws cloudfront list-distributions: Items does not hold Quantity distributions");
	const items = raw.map((entry, index) => {
		const d = entry as Record<string, unknown>;
		if (typeof d.Id !== "string" || typeof d.ARN !== "string" || typeof d.Comment !== "string" || typeof d.Enabled !== "boolean" || typeof d.Status !== "string") {
			throw new Error(`aws cloudfront list-distributions: distribution ${index} lacks Id, ARN, Comment, Enabled or Status`);
		}
		return { id: d.Id, arn: d.ARN, comment: d.Comment, enabled: d.Enabled, status: d.Status };
	});
	if (list.IsTruncated && (typeof list.NextMarker !== "string" || list.NextMarker === "")) {
		throw new Error("aws cloudfront list-distributions: truncated, with no NextMarker");
	}
	return { items, nextMarker: list.IsTruncated ? (list.NextMarker as string) : null };
}

export type Deployed =
	| { kind: "absent" }
	| ({ kind: "present"; recorded: RecordedDeploy } & DistributionSummary)
	| { kind: "unknown"; reason: string };

/** This stage's distribution among every distribution of the account. */
export function findDeployed(distributions: readonly DistributionSummary[], stage: string): Deployed {
	const ours = distributions.filter((d) => isStageComment(d.comment, stage));
	if (ours.length === 0) return { kind: "absent" };
	if (ours.length > 1) return { kind: "unknown", reason: `${ours.length} distributions say they are ${stage}'s public blobs (${ours.map((d) => d.id).join(", ")})` };
	const only = ours[0] as DistributionSummary;
	const recorded = parseComment(only.comment, stage);
	if (recorded === null) return { kind: "unknown", reason: `the comment of distribution ${only.id} does not record a state and a plan: ${JSON.stringify(only.comment)}` };
	return { kind: "present", recorded, ...only };
}

/** Disabled, and every edge knows it. */
export function isQuiet(d: { enabled: boolean; status: string }): boolean {
	return !d.enabled && d.status === "Deployed";
}

export interface ScheduledChange {
	changeType: string;
	/** ISO 8601; absent until AWS's billing system confirms the change. */
	effectiveDate: string | null;
	planTier: string | null;
}

/** A subscription as `aws pricing-plan-manager list-subscriptions` lists it. */
export interface SubscriptionSummary {
	arn: string;
	planFamily: string;
	planTier: string;
	status: string;
	resourceArns: string[];
	scheduledChange: ScheduledChange | null;
}

function scheduledChangeFrom(value: unknown): ScheduledChange | null {
	if (value === undefined || value === null) return null;
	const c = value as Record<string, unknown>;
	if (typeof c.changeType !== "string") throw new Error("a scheduledChange has no changeType");
	const date = c.effectiveDate;
	return {
		changeType: c.changeType,
		effectiveDate: date === undefined || date === null ? null : date instanceof Date ? date.toISOString() : String(date),
		planTier: typeof c.planTier === "string" ? c.planTier : null,
	};
}

/** One page of ListSubscriptions (the CLI's JSON or the SDK's output), and the token of the next, or null. */
export function subscriptionsPage(output: unknown): { subscriptions: SubscriptionSummary[]; nextToken: string | null } {
	const page = output as { subscriptionSummaries?: unknown[]; nextToken?: unknown };
	if (!Array.isArray(page.subscriptionSummaries)) throw new Error("ListSubscriptions: no subscriptionSummaries in its output");
	const subscriptions = page.subscriptionSummaries.map((entry, index) => {
		const s = entry as Record<string, unknown>;
		if (typeof s.arn !== "string" || typeof s.planFamily !== "string" || typeof s.planTier !== "string" || typeof s.status !== "string" || !Array.isArray(s.resourceArns)) {
			throw new Error(`ListSubscriptions: subscription ${index} lacks arn, planFamily, planTier, status or resourceArns`);
		}
		return {
			arn: s.arn,
			planFamily: s.planFamily,
			planTier: s.planTier,
			status: s.status,
			resourceArns: s.resourceArns.map(String),
			scheduledChange: scheduledChangeFrom(s.scheduledChange),
		};
	});
	const token = page.nextToken;
	return { subscriptions, nextToken: typeof token === "string" && token !== "" ? token : null };
}

export interface PlanVerdict {
	/** An ACTIVE CloudFront plan lists the distribution among its resources. */
	active: boolean;
	reason: string;
	subscriptionArn: string | null;
	tier: string | null;
	/** A scheduled cancellation or downgrade of the plan, with its date. */
	warnings: string[];
}

/** Whether an ACTIVE plan covers the distribution, from every subscription of the account. Any tier will do. */
export function coverage(distributionArn: string, subscriptions: readonly SubscriptionSummary[]): PlanVerdict {
	const covering = subscriptions.filter((s) => s.planFamily === "CloudFront" && s.resourceArns.includes(distributionArn));
	const warnings = covering.flatMap((s) => {
		if (s.scheduledChange === null) return [];
		const when = s.scheduledChange.effectiveDate === null ? "on a date AWS has not set yet" : `on ${s.scheduledChange.effectiveDate}`;
		const what = s.scheduledChange.changeType === "DOWNGRADE" && s.scheduledChange.planTier !== null ? `DOWNGRADE to ${s.scheduledChange.planTier}` : s.scheduledChange.changeType;
		const then =
			s.scheduledChange.changeType === "CANCELLATION"
				? "; from then no plan covers the distribution, and the watch disables it"
				: "";
		return [`the ${s.planTier} plan ${s.arn} has a scheduled ${what}, effective ${when}${then}`];
	});
	const active = covering.find((s) => s.status === "ACTIVE");
	if (active !== undefined) return { active: true, reason: `the ${active.planTier} plan ${active.arn} is ACTIVE`, subscriptionArn: active.arn, tier: active.planTier, warnings };
	const first = covering[0];
	if (first !== undefined) return { active: false, reason: `the plan ${first.arn} is ${first.status}, not ACTIVE`, subscriptionArn: first.arn, tier: first.planTier, warnings };
	return { active: false, reason: "no plan lists the distribution", subscriptionArn: null, tier: null, warnings };
}

export type Target = { kind: "deploy"; state: PublicBlobsState; plan: PlanAttachment } | { kind: "remove" };

export interface Judgement {
	allowed: boolean;
	reason: string;
	warnings: string[];
}

const DARK_FIRST =
	'Deploy with PUBLIC_BLOBS.state "dark" (infra/runs/public-blobs.ts) first, and wait until the distribution reports disabled ' +
	"(Enabled false, Status Deployed: aws cloudfront list-distributions)";

/** Whether `target` may be deployed over what is deployed. `verdict` is the plan check, needed for "on"; null when AWS could not be asked. */
export function judgeTransition(deployed: Deployed, target: Target, verdict: PlanVerdict | null): Judgement {
	const warnings = verdict?.warnings ?? [];
	const allow = (reason: string): Judgement => ({ allowed: true, reason, warnings });
	const refuse = (reason: string): Judgement => ({ allowed: false, reason, warnings });
	if (deployed.kind === "unknown") return refuse(`what is deployed cannot be told: ${deployed.reason}`);

	const leaving = target.kind === "remove" || target.state === "off";
	const what = target.kind === "remove" ? "removing the stage" : `"${target.state}"`;
	if (deployed.kind === "absent") {
		if (leaving || (target.kind === "deploy" && target.state === "dark")) return allow("no distribution is deployed");
		return refuse(`no distribution is deployed, and ${what} would make one enabled. A distribution is made only disabled: deploy "dark" first.`);
	}

	const { recorded } = deployed;
	const quiet = isQuiet(deployed);
	const now = `distribution ${deployed.id} (last deployed "${recorded.state}", plan "${recorded.plan}") is ${deployed.enabled ? "enabled" : "disabled"}, ${deployed.status}`;
	if (leaving) {
		if (quiet && recorded.state === "dark") return allow(`${now}: nothing is served, and nothing will be`);
		if (!quiet) return refuse(`${now}. ${what} would cancel its plan while it may still serve. ${DARK_FIRST}, then ${what}.`);
		return refuse(`${now}, but the stage last deployed it "${recorded.state}" (the watch, or a person, disabled it). ${DARK_FIRST}, then ${what}.`);
	}
	if (target.kind !== "deploy") return refuse("unreachable");
	if (target.plan !== recorded.plan) {
		if (target.state === "dark" && quiet && recorded.state === "dark") return allow(`${now}: the plan attachment may change`);
		return refuse(
			`${now}. Changing PUBLIC_BLOBS.plan from "${recorded.plan}" to "${target.plan}" may add or cancel the subscription, so it is done only ` +
				`in a deploy to "dark" from "dark". ${DARK_FIRST} with plan "${recorded.plan}", then change the plan.`,
		);
	}
	if (target.state === "dark") return allow(`${now}: "dark" disables it, and keeps its plan`);
	if (recorded.state !== "dark" && !deployed.enabled) {
		return refuse(
			`${now}, although the stage last deployed it "${recorded.state}": the watch, or a person, disabled it, and a deploy would not ` +
				`enable it again (the stage still records it enabled). ${DARK_FIRST}; then check the plan, and deploy "${target.state}" again.`,
		);
	}
	if (target.state === "closed") return allow(`${now}: "closed" serves nothing; the plan can be attached`);
	if (verdict === null) return refuse(`${now}, and AWS could not be asked whether an ACTIVE plan covers it, so "on" is not deployed.`);
	if (!verdict.active) {
		return refuse(
			`${now}, and no ACTIVE plan covers it (${verdict.reason}). Serving would be on pay-as-you-go pricing, so "on" is not deployed. ` +
				(deployed.enabled
					? `It is enabled now: the watch disables it within ${WATCH_INTERVAL_MINUTES} minutes of the plan lapsing (${2 * WATCH_INTERVAL_MINUTES} if AWS cannot be asked); to disable it at once, deploy "dark".`
					: 'Attach the Free plan (or deploy "closed" first if AWS will not subscribe a disabled distribution), check it is ACTIVE, then deploy "on".'),
		);
	}
	return allow(`${now}, and ${verdict.reason}`);
}

/** The watch's leeway for a closed distribution, in milliseconds. */
export const CLOSED_GRACE_MS = CLOSED_GRACE_MINUTES * 60_000;

/** One read-only AWS CLI call with the stage's profile: its arguments, its parsed JSON output. */
export type AwsCli = (args: string[]) => unknown;

const MAX_PAGES = 100;

/**
 * This stage's distribution, read with `aws cloudfront list-distributions`,
 * paged by hand: the CLI's own paging prints nothing at all for an account
 * with no distribution (seen with aws-cli 2.39.7), which would read as no
 * answer. A failed call or an unreadable answer is "unknown", never "absent".
 */
export function readDeployed(cli: AwsCli, stage: string): Deployed {
	try {
		const all: DistributionSummary[] = [];
		let marker: string | null = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			const { items, nextMarker } = distributionsPage(cli(["cloudfront", "list-distributions", "--no-paginate", ...(marker === null ? [] : ["--marker", marker])]));
			all.push(...items);
			if (nextMarker === null) return findDeployed(all, stage);
			marker = nextMarker;
		}
		return { kind: "unknown", reason: `aws cloudfront list-distributions: more than ${MAX_PAGES} pages` };
	} catch (error) {
		return { kind: "unknown", reason: error instanceof Error ? error.message.split("\n").slice(0, 3).join(" ") : String(error) };
	}
}

/** Every plan subscription of the account, with `aws pricing-plan-manager list-subscriptions`, paged by hand. Throws when it cannot tell. */
export function readSubscriptions(cli: AwsCli): SubscriptionSummary[] {
	const all: SubscriptionSummary[] = [];
	let token: string | null = null;
	for (let page = 0; page < MAX_PAGES; page++) {
		const { subscriptions, nextToken } = subscriptionsPage(cli(["pricing-plan-manager", "list-subscriptions", "--no-paginate", ...(token === null ? [] : ["--next-token", token])]));
		all.push(...subscriptions);
		if (nextToken === null) return all;
		token = nextToken;
	}
	throw new Error(`aws pricing-plan-manager list-subscriptions: more than ${MAX_PAGES} pages`);
}
