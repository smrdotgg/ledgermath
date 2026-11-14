/**
 * What is deployed, read back from AWS, and what a deploy may do from there.
 * The deploy (public-blobs-stack.ts) and the watch (plan-watch.ts) both use
 * it, so they agree on what "covered by a plan" means.
 *
 * Which distribution is the stage's comes from the stage's own state: the
 * copy of Pulumi's checkpoint that SST pulls before every command and gives
 * Pulumi as its backend (managedDistribution, readManaged). That copy is what
 * this deploy updates from, so the distribution it records, by ID, is the one
 * the deploy will update; when it records none, the deploy will create one.
 * What the stage last deployed is recorded in that distribution's comment
 * (distributionComment in public-blobs.ts), which `aws cloudfront
 * list-distributions` returns beside Enabled and Status. The listing must
 * agree with the state: the recorded ID listed, with the comment the state
 * last saw, and no other distribution of the account carrying this stage's
 * comment (findDeployed). Anything else is "unknown", and refuses.
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

import { join } from "node:path";

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
 * Whether a comment says it is one of this stage's public-blobs
 * distributions, recorded state or not. The stage is followed by " public
 * blobs", so no other stage's matches.
 */
export function isStageComment(comment: string, stage: string): boolean {
	return comment.startsWith(`LedgerMath ${stage} public blobs`);
}

/** The distribution's Pulumi type, and its name in the stage (public-blobs-stack.ts makes it under this name). */
export const DISTRIBUTION_TYPE = "aws:cloudfront/distribution:Distribution";
export const DISTRIBUTION_NAME = "PublicBlobsDistribution";

/** The distribution the stage's state records: none (a deploy would create one), one by ID, or unknown. */
export type Managed = { kind: "none" } | { kind: "one"; id: string; arn: string; comment: string } | { kind: "unknown"; reason: string };

function isManagedDistribution(resource: unknown): boolean {
	const r = (resource ?? {}) as { type?: unknown; urn?: unknown };
	return r.type === DISTRIBUTION_TYPE && typeof r.urn === "string" && r.urn.endsWith(`::${DISTRIBUTION_NAME}`);
}

/**
 * The distribution a stage's state file records (Pulumi's checkpoint, version
 * 3: { version, checkpoint: { latest: { resources, pending_operations } } }).
 * A stage never deployed has no resources, or no `latest`: none. Unknown when
 * the file is not such a checkpoint, when the state holds the distribution
 * more than once or as awaiting deletion, when an operation on it did not
 * finish (Pulumi records those as pending), or when the record lacks its ID,
 * ARN or comment.
 */
export function managedDistribution(file: unknown): Managed {
	const unknown = (reason: string): Managed => ({ kind: "unknown", reason });
	const versioned = (file ?? {}) as { version?: unknown; checkpoint?: unknown };
	if (versioned.version !== 3 || typeof versioned.checkpoint !== "object" || versioned.checkpoint === null) {
		return unknown(`the stage's state is not a Pulumi checkpoint of version 3 (version ${JSON.stringify(versioned.version)})`);
	}
	const latest = (versioned.checkpoint as { latest?: unknown }).latest as { resources?: unknown; pending_operations?: unknown } | null | undefined;
	if (latest === undefined || latest === null) return { kind: "none" };
	const resources = latest.resources ?? [];
	const pending = latest.pending_operations ?? [];
	if (!Array.isArray(resources) || !Array.isArray(pending)) return unknown("the stage's state has resources or pending_operations that are not lists");
	const unfinished = pending.filter((operation) => isManagedDistribution((operation as { resource?: unknown }).resource));
	if (unfinished.length > 0) {
		const kinds = unfinished.map((operation) => String((operation as { type?: unknown }).type)).join(", ");
		return unknown(`an operation on ${DISTRIBUTION_NAME} did not finish (${kinds}), so the state may not say which distribution it is`);
	}
	const records = resources.filter(isManagedDistribution) as Array<{ id?: unknown; delete?: unknown; outputs?: { arn?: unknown; comment?: unknown } }>;
	if (records.length === 0) return { kind: "none" };
	if (records.length > 1 || records.some((record) => record.delete === true)) {
		return unknown(`the stage's state records ${records.length} ${DISTRIBUTION_NAME}${records.length === 1 ? "" : "s"}, ${records.filter((record) => record.delete === true).length} of them awaiting deletion`);
	}
	const record = records[0] as { id?: unknown; outputs?: { arn?: unknown; comment?: unknown } };
	const arn = record.outputs?.arn;
	const comment = record.outputs?.comment;
	if (typeof record.id !== "string" || record.id === "" || typeof arn !== "string" || typeof comment !== "string") {
		return unknown(`the stage's state records ${DISTRIBUTION_NAME} without an ID, an ARN or a comment`);
	}
	return { kind: "one", id: record.id, arn, comment };
}

/**
 * Where SST put this run's copy of the stage's state. Before every command
 * SST 4.17 pulls the stage's state into a work directory and runs Pulumi with
 * PULUMI_BACKEND_URL=file://<that directory>, which the program inherits; the
 * state is <directory>/.pulumi/stacks/<app>/<stage>.json (SST's
 * pkg/project/run.go and pkg/project/workdir.go, v4.17.0). For a stage never
 * deployed, SST makes an empty one first (`pulumi stack init`).
 */
export function stateFilePath(backendUrl: string | undefined, app: string, stage: string): string {
	if (backendUrl === undefined || !backendUrl.startsWith("file://")) {
		throw new Error(`PULUMI_BACKEND_URL is ${backendUrl === undefined ? "not set" : JSON.stringify(backendUrl)}, not the file:// copy of the stage's state that SST gives a run`);
	}
	return join(backendUrl.slice("file://".length), ".pulumi", "stacks", app, `${stage}.json`);
}

function firstLines(error: unknown): string {
	return error instanceof Error ? error.message.split("\n").slice(0, 3).join(" ") : String(error);
}

/** The distribution the stage's state records, read from this run's copy; unknown when it cannot be read. */
export function readManaged(readFile: (path: string) => string, backendUrl: string | undefined, app: string, stage: string): Managed {
	try {
		return managedDistribution(JSON.parse(readFile(stateFilePath(backendUrl, app, stage))));
	} catch (error) {
		return { kind: "unknown", reason: `the stage's state could not be read: ${firstLines(error)}` };
	}
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

/**
 * This stage's distribution among every distribution of the account: the one
 * the stage's state records (`managed`), checked against the listing. It is
 * "present" only when the state records one distribution, AWS lists it under
 * the same ID and ARN, its comment is the one the state last saw and records
 * a state and a plan, and no other distribution carries this stage's comment.
 * "absent" only when the state records none and no distribution carries the
 * comment. Everything else is "unknown": two distributions with the comment;
 * one with the comment that the state does not record (a deploy would make a
 * second, and its coverage says nothing about that one); the recorded one
 * missing from the listing, or with its comment gone or edited.
 */
export function findDeployed(distributions: readonly DistributionSummary[], stage: string, managed: Managed): Deployed {
	const unknown = (reason: string): Deployed => ({ kind: "unknown", reason });
	if (managed.kind === "unknown") return unknown(managed.reason);
	const ours = distributions.filter((d) => isStageComment(d.comment, stage));
	if (ours.length > 1) return unknown(`${ours.length} distributions say they are ${stage}'s public blobs (${ours.map((d) => d.id).join(", ")})`);
	const claimant = ours[0];
	if (managed.kind === "none") {
		if (claimant === undefined) return { kind: "absent" };
		return unknown(
			`distribution ${claimant.id} says it is ${stage}'s public blobs, but the stage's state records no distribution: it was made outside the stage's deploys, ` +
				"or by one whose record was lost, and a deploy would make another beside it",
		);
	}
	const listed = distributions.find((d) => d.id === managed.id);
	if (listed === undefined) return unknown(`the stage's state records distribution ${managed.id}, which AWS does not list (deleted outside the stage? \`sst refresh\` updates the state)`);
	if (listed.arn !== managed.arn) return unknown(`distribution ${managed.id} has the ARN ${listed.arn}, not the ${managed.arn} the stage's state records`);
	if (claimant === undefined) return unknown(`the stage's distribution ${listed.id} no longer carries the stage's comment: ${JSON.stringify(listed.comment)}`);
	if (claimant.id !== listed.id) return unknown(`distribution ${claimant.id} says it is ${stage}'s public blobs, but the stage's state records ${listed.id}, whose comment is ${JSON.stringify(listed.comment)}`);
	if (listed.comment !== managed.comment) {
		return unknown(`the comment of distribution ${listed.id} is ${JSON.stringify(listed.comment)}, not the ${JSON.stringify(managed.comment)} the stage last deployed: it was edited outside the stage`);
	}
	const recorded = parseComment(listed.comment, stage);
	if (recorded === null) return unknown(`the comment of distribution ${listed.id} does not record a state and a plan: ${JSON.stringify(listed.comment)}`);
	return { kind: "present", recorded, ...listed };
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
 * This stage's distribution: the one its state records (`managed`, from
 * readManaged), checked against `aws cloudfront list-distributions`, paged by
 * hand: the CLI's own paging prints nothing at all for an account with no
 * distribution (seen with aws-cli 2.39.7), which would read as no answer. A
 * failed call or an unreadable answer is "unknown", never "absent".
 */
export function readDeployed(cli: AwsCli, stage: string, managed: Managed): Deployed {
	try {
		const all: DistributionSummary[] = [];
		let marker: string | null = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			const { items, nextMarker } = distributionsPage(cli(["cloudfront", "list-distributions", "--no-paginate", ...(marker === null ? [] : ["--marker", marker])]));
			all.push(...items);
			if (nextMarker === null) return findDeployed(all, stage, managed);
			marker = nextMarker;
		}
		return { kind: "unknown", reason: `aws cloudfront list-distributions: more than ${MAX_PAGES} pages` };
	} catch (error) {
		return { kind: "unknown", reason: firstLines(error) };
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
