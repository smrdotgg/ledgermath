/**
 * The role .github/workflows/runs.yml assumes through GitHub's OIDC provider,
 * so no AWS key is stored anywhere: only workflows of this repository running
 * on main may assume it, and it may list the stage's bucket and read Runs,
 * boot summaries and blobs, nothing else. infra/runs/stack.ts creates the
 * provider and the role from these documents; tests/runs-stage.test.ts checks
 * them.
 *
 * Plain data: no SST global is used.
 */

export const GITHUB_OIDC_URL = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";
/** The audience aws-actions/configure-aws-credentials asks GitHub for. */
export const GITHUB_OIDC_AUDIENCE = "sts.amazonaws.com";
export const GITHUB_REPOSITORY = "smrdotgg/ledgermath";
export const GITHUB_REF = "refs/heads/main";
/** What the role may read, under the bucket. */
export const READABLE_PREFIXES = ["runs/", "boots/", "blobs/"] as const;

export interface PolicyStatement {
	Effect: "Allow" | "Deny";
	Action: string[];
	Principal?: { Federated: string };
	Resource?: string[];
	Condition?: Record<string, Record<string, string | string[]>>;
}

export interface PolicyDocument {
	Version: "2012-10-17";
	Statement: PolicyStatement[];
}

/**
 * Who may assume the role: a GitHub Actions job of GITHUB_REPOSITORY on
 * GITHUB_REF, as the OIDC token's `sub` claim says (repo:<owner>/<repo>:ref:<ref>,
 * GitHub's default, for a scheduled or dispatched run of a workflow on main).
 * A pull request, another branch, a tag or a job with an environment has
 * another `sub` and is refused.
 */
export function trustPolicy(providerArn: string): PolicyDocument {
	return {
		Version: "2012-10-17",
		Statement: [
			{
				Effect: "Allow",
				Principal: { Federated: providerArn },
				Action: ["sts:AssumeRoleWithWebIdentity"],
				Condition: {
					StringEquals: {
						[`${GITHUB_OIDC_HOST}:aud`]: GITHUB_OIDC_AUDIENCE,
						[`${GITHUB_OIDC_HOST}:sub`]: `repo:${GITHUB_REPOSITORY}:ref:${GITHUB_REF}`,
					},
				},
			},
		],
	};
}

/** What the role may do: list the bucket, and read objects under READABLE_PREFIXES. */
export function readPolicy(bucketArn: string): PolicyDocument {
	return {
		Version: "2012-10-17",
		Statement: [
			{ Effect: "Allow", Action: ["s3:ListBucket"], Resource: [bucketArn] },
			{ Effect: "Allow", Action: ["s3:GetObject"], Resource: READABLE_PREFIXES.map((prefix) => `${bucketArn}/${prefix}*`) },
		],
	};
}
