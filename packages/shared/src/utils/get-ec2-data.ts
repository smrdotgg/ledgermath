import { z } from "zod";

export const relevantEc2DataSchema = z.object({
	accountId: z.string(),
	architecture: z.string(),
	availabilityZone: z.string(),
	imageId: z.string(),
	instanceId: z.string(),
	instanceType: z.string(),
	pendingTime: z.string(),
	privateIp: z.string(),
	region: z.string(),
	version: z.string(),
});

export type RelevantEc2Data = z.infer<typeof relevantEc2DataSchema>;

const IMDS_BASE = "http://169.254.169.254";

export async function getEc2Data(): Promise<RelevantEc2Data> {
	const tokenResponse = await fetch(`${IMDS_BASE}/latest/api/token`, {
		method: "PUT",
		headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
		signal: AbortSignal.timeout(2000),
	});
	if (!tokenResponse.ok) {
		throw new Error(`IMDS token request failed: ${tokenResponse.status}`);
	}
	const token = await tokenResponse.text();

	const documentResponse = await fetch(
		`${IMDS_BASE}/latest/dynamic/instance-identity/document`,
		{
			headers: { "X-aws-ec2-metadata-token": token },
			signal: AbortSignal.timeout(2000),
		},
	);
	if (!documentResponse.ok) {
		throw new Error(
			`IMDS instance-identity request failed: ${documentResponse.status}`,
		);
	}

	return relevantEc2DataSchema.parse(documentResponse.json());
}
