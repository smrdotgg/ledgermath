import { DataType, type EventGenerator, EventGeneratorCode } from "../types";

const fetchSingleByteFromS3: EventGenerator = {
	code: EventGeneratorCode.FetchSingleByteFromS3,
	requiredParameters: [
		{
			key: "getUrl",
			description:
				"The URL of a file in an S3 bucket that is exactly one byte big.",
			type: DataType.String,
		},
	],
	outputs: [
		{
			key: "TTFB",
			description:
				"The time until the first response is received, measured in nanoseconds.",
			type: DataType.Number,
		},
		{
			key: "TTLB",
			description:
				"The time until the last response is received, measured in nanoseconds.",
			type: DataType.Number,
		},
	],
	description: "Fetches a single byte from an S3-compatible bucket.",
	explanation:
		"An HTTP GET request is sent to the getUrl. The response is saved in memory, and is not written to disk.",
};
