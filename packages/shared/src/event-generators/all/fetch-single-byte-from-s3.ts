import { EventGeneratorCodes, type EventGenerator } from "../types";
import { z } from "zod";

export const fetchSingleByteFromS3 = {
	code: EventGeneratorCodes.fetch_file_from_s3,
	description: "Fetch file from s3",
	inputShape: z.object({
		getUrl: z
			.string()
			.describe(
				"The URL of a file in an S3 bucket that is exactly one byte big.",
			),
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
	}),
	explanation:
		"An HTTP GET request is sent to the file. The response is saved to memory.",
};
