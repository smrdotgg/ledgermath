import { z } from "zod";
import { EventGeneratorRegistry } from "../event-generators";
import type { EventGeneratorCode } from "../event-generators/types";

export type EventGeneratorConfigBatchType = {
	cronString: string;
} & ({ batch: AnyEventGenBatchType } | { batches: AnyEventGenBatchType[] });

export type PromiseOr<T> = T | Promise<T>;
export type FunctionOr<
	T,
	Mode extends "async_only" | "sync_only" | "both" = "both",
> = T | (() => Mode extends "async_only"
	? Promise<T>
	: Mode extends "sync_only"
		? T
		: PromiseOr<T>);

type EventGenBatchType<T extends EventGeneratorCode> = {
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
