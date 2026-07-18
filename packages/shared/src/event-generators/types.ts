import type { ZodObject } from "zod";

export enum DataType {
	String = "string",
	Number = "number",
}

export const EventGeneratorCodes = {
	fetch_tool: "fetch_tool",
} as const;
export type EventGeneratorCode = keyof typeof EventGeneratorCodes;

export interface Parameter {
	key: string;
	description: string;
	type: DataType;
}

export interface EventGenerator {
	code: EventGeneratorCode;
	inputShape: ZodObject;
	outputShape: ZodObject;
	description: string;
	explanation: string;
}
