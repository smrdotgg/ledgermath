/**
 * What a box's instance role may do. infra/runs/stack.ts makes the role from
 * this document; tests/runs-stage.test.ts checks it; scripts/box-in-container/aws
 * allows the same and refuses the rest.
 *
 * In the stage's bucket, a box reads its source archive, lists blobs/ (so it
 * uploads only the blobs the bucket lacks), and writes runs/, blobs/, boots/
 * and logs/. Of EC2 it may call four read-only actions, once per boot:
 * runner/provision.py reads the instance type's catalog record (how many
 * instance-store disks it has), and runner/run.py dumps the catalog record,
 * the volumes attached to the box and their status, and the instance's own
 * record. None of the four supports resource-level permissions, so their
 * resource is "*".
 *
 * Plain data: no SST global is used.
 */

import type { PolicyDocument } from "./github-role";

/** The prefixes a box writes under, in the stage's bucket. */
export const BOX_WRITES = ["runs/", "blobs/", "boots/", "logs/"] as const;

/** The EC2 actions a box calls, all read-only. */
export const BOX_EC2_READS = ["ec2:DescribeInstanceTypes", "ec2:DescribeVolumes", "ec2:DescribeVolumeStatus", "ec2:DescribeInstances"] as const;

export function boxPolicy(bucketArn: string, sourceKey: string): PolicyDocument {
	return {
		Version: "2012-10-17",
		Statement: [
			{ Effect: "Allow", Action: ["s3:GetObject"], Resource: [`${bucketArn}/${sourceKey}`] },
			{
				Effect: "Allow",
				Action: ["s3:ListBucket"],
				Resource: [bucketArn],
				Condition: { StringLike: { "s3:prefix": ["blobs/", "blobs/*"] } },
			},
			{ Effect: "Allow", Action: ["s3:PutObject"], Resource: BOX_WRITES.map((prefix) => `${bucketArn}/${prefix}*`) },
			{ Effect: "Allow", Action: [...BOX_EC2_READS], Resource: ["*"] },
		],
	};
}
