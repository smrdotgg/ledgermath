import {
	CloudFrontClient,
	GetDistributionCommand,
	GetDistributionConfigCommand,
	ListTagsForResourceCommand,
	TagResourceCommand,
	UntagResourceCommand,
	UpdateDistributionCommand,
} from "@aws-sdk/client-cloudfront";
import { ListSubscriptionsCommand, PricingPlanManagerClient } from "@aws-sdk/client-pricing-plan-manager";

import { disableDistribution, UNKNOWN_MARKER_TAG, type WatchClients, type WatchResult, watchOnce } from "./plan-watch";
import { GLOBAL_REGION } from "./public-blobs";
import { type SubscriptionSummary, subscriptionsPage } from "./public-blobs-guard";

/**
 * The watch's Lambda (infra/runs/plan-watch.ts says what it decides). Its
 * role may list the account's plan subscriptions, and read, update and tag
 * this one distribution; nothing else (infra/runs/public-blobs-stack.ts).
 */

const cloudfront = new CloudFrontClient({ region: GLOBAL_REGION });
const plans = new PricingPlanManagerClient({ region: GLOBAL_REGION });

function realClients(id: string, arn: string): WatchClients {
	const readMarker = async (): Promise<string | null> => {
		const out = await cloudfront.send(new ListTagsForResourceCommand({ Resource: arn }));
		return out.Tags?.Items?.find((tag) => tag.Key === UNKNOWN_MARKER_TAG)?.Value ?? null;
	};
	return {
		async getDistribution() {
			const out = await cloudfront.send(new GetDistributionCommand({ Id: id }));
			const d = out.Distribution;
			if (d?.DistributionConfig === undefined || d.Status === undefined || d.LastModifiedTime === undefined) {
				throw new Error(`GetDistribution ${id}: no configuration, status or modification time`);
			}
			return { enabled: d.DistributionConfig.Enabled === true, status: d.Status, comment: d.DistributionConfig.Comment ?? "", lastModified: d.LastModifiedTime };
		},
		async listSubscriptions() {
			const all: SubscriptionSummary[] = [];
			let nextToken: string | undefined;
			do {
				const page = subscriptionsPage(await plans.send(new ListSubscriptionsCommand({ nextToken })));
				all.push(...page.subscriptions);
				nextToken = page.nextToken ?? undefined;
			} while (nextToken !== undefined);
			return all;
		},
		disable() {
			// The whole configuration as returned, with Enabled false, under its ETag;
			// read again and retried when the configuration changed in between.
			return disableDistribution({
				async read() {
					const out = await cloudfront.send(new GetDistributionConfigCommand({ Id: id }));
					if (out.DistributionConfig === undefined || out.ETag === undefined) throw new Error(`GetDistributionConfig ${id}: no configuration or ETag`);
					return { config: out.DistributionConfig, enabled: out.DistributionConfig.Enabled !== false, eTag: out.ETag };
				},
				async writeDisabled(config, eTag) {
					await cloudfront.send(new UpdateDistributionCommand({ Id: id, IfMatch: eTag, DistributionConfig: { ...config, Enabled: false } }));
				},
			});
		},
		readMarker,
		async writeMarker(value) {
			await cloudfront.send(new TagResourceCommand({ Resource: arn, Tags: { Items: [{ Key: UNKNOWN_MARKER_TAG, Value: value }] } }));
		},
		async clearMarker() {
			await cloudfront.send(new UntagResourceCommand({ Resource: arn, TagKeys: { Items: [UNKNOWN_MARKER_TAG] } }));
		},
	};
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

export async function handler(): Promise<WatchResult> {
	const stage = required("LEDGERMATH_STAGE");
	const id = required("LEDGERMATH_DISTRIBUTION_ID");
	const arn = required("LEDGERMATH_DISTRIBUTION_ARN");
	try {
		const result = await watchOnce(realClients(id, arn), { stage, distributionArn: arn }, new Date());
		const log = { message: `public blobs watch: ${result.action}`, stage, distribution: id, reason: result.reason, warnings: result.warnings };
		if (result.action === "disabled") console.error(JSON.stringify({ ...log, message: "public blobs watch: DISABLED the distribution" }));
		else if (result.warnings.length > 0 || result.action === "marked") console.warn(JSON.stringify(log));
		else console.log(JSON.stringify(log));
		return result;
	} catch (error) {
		// Thrown so the invocation counts as an error: the distribution had to
		// be disabled and could not be.
		console.error(JSON.stringify({ message: "public blobs watch FAILED", stage, distribution: id, error: error instanceof Error ? error.message : String(error) }));
		throw error;
	}
}
