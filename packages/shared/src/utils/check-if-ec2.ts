const IMDS_BASE = "http://169.254.169.254";

/**
 * Returns true if running on an EC2 instance, false otherwise.
 *
 * Probes IMDSv2: requests a token from the link-local metadata endpoint.
 * On non-EC2 hosts the address is unroutable, so the request times out or
 * errors; we treat any failure as "not EC2".
 */
export async function checkIfEc2(): Promise<boolean> {
	try {
		const response = await fetch(`${IMDS_BASE}/latest/api/token`, {
			method: "PUT",
			headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
			signal: AbortSignal.timeout(1000),
		});
		return response.ok;
	} catch {
		return false;
	}
}
