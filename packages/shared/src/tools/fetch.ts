import { z } from "zod";
import { EventGeneratorCodes } from "../event-generators/types";

export const fetchTool = {
	code: EventGeneratorCodes.fetch_tool,
	description: "Make an HTTP request.",
	inputShape: z.object({
		method: z
			.enum(["GET", "POST", "PUT", "DELETE", "HEAD"])
			.describe("The method of the HTTP request."),
		getUrl: z.string().describe("The URL to fetch"),
	}),
	outputShape: z.object({
		ttfb: z
			.number()
			.describe(
				"The time until the first response is received, measured in nanoseconds.",
			),
		ttlb: z
			.number()
			.describe(
				"The time until the last response is received, measured in nanoseconds.",
			),
		responseMetadata: z.object({
			// we'd need to have this be way more extensive
			headers: z.object({
				size: z.number().describe(""),
				entryCount: z.number().describe(""),
			}),
			response: z.object({
				size: z.number().describe(""),
				magicBytes: z.number().describe(""),
			}),
		}),
	}),
	explanation:
		"An HTTP request is sent to the file. The response is saved to memory.",
};
