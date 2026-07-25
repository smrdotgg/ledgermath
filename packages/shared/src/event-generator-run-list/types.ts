import { z } from "zod";
import { EventGeneratorRegistry } from "../event-generators";
import type { EventGeneratorCode } from "../event-generators/types";
import type { Ec2InstanceType } from "../utils/aws-ec2-instance-types";
import type { AwsRegion } from "../utils/aws-regions";
import type { AwsZone } from "../utils/aws-zones";

export type EventGeneratorConfigBatchType = {
	cronString: string;
} & ({ batch: AnyEventGenBatchType } | { batches: AnyEventGenBatchType[] });

export type PromiseOr<T> = T | Promise<T>;
export type FunctionOr<
	T,
	Mode extends "async_only" | "sync_only" | "both" = "both",
> =
	| T
	| (() => Mode extends "async_only"
			? Promise<T>
			: Mode extends "sync_only"
				? T
				: PromiseOr<T>);

type EventGenBatchType<T extends EventGeneratorCode> = {
	prepCompute: FunctionOr<{
		mainRunner: AwsResourceSpec;
		otherResources: Record<string, AwsResourceSpec>;
	}>;
	prepEnv: FunctionOr<{
		runnerInputs: z.infer<GeneratorForCode<T>["inputShape"]>;
	}>;
	code: T;
};
type GeneratorForCode<T extends EventGeneratorCode> = Extract<
	(typeof EventGeneratorRegistry)[keyof typeof EventGeneratorRegistry],
	{ code: T }
>;

export type AnyEventGenBatchType = {
	[T in EventGeneratorCode]: EventGenBatchType<T>;
}[EventGeneratorCode];

type AwsResourceSpec = { awsZone: AwsZone } & (
	| { kind: "ec2"; instanceType: Ec2InstanceType }
	| { kind: "s3Bucket" }
);
