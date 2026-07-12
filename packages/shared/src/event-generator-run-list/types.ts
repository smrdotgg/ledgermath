import { z } from "zod";
import { EventGeneratorRegistry } from "../event-generators";
import type { EventGeneratorCode } from "../event-generators/types";

export type EventGeneratorConfigBatchType = {
	cronString: string;
} & ({ batch: AnyEventGenBatchType } | { batches: AnyEventGenBatchType[] });

type EventGenBatchType<T extends EventGeneratorCode> = {
	prepEnv: () => Promise<z.infer<GeneratorForCode<T>["inputShape"]>>;
	code: T;
};
type GeneratorForCode<T extends EventGeneratorCode> = Extract<
	(typeof EventGeneratorRegistry)[keyof typeof EventGeneratorRegistry],
	{ code: T }
>;

export type AnyEventGenBatchType = {
	[T in EventGeneratorCode]: EventGenBatchType<T>;
}[EventGeneratorCode];
