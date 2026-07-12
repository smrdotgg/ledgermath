import type {
	AnyEventGenBatchType,
	EventGeneratorConfigBatchType,
} from "./types";

export const cronBenchmarkConfig = {
	"0 6 * * *": {
		prepEnv: async () => {
			// This would be where the parameters are collected or maybe even generated. This would also allow a single event generator to serve multiple purposes. For example, if we have a single event generator for fetching files from S3, we could use it to suggest bandwidth by fetching larger files. We could also use it to suggest latency by fetching incredibly small files.
			// This also separates the concept of it also separates the actual event generating code from the inferred difference in utility that comes from simple changes to the parameters.
			return { getUrl: "" };
		},
		code: "fetch_file_from_s3",
	},
} satisfies Record<string, AnyEventGenBatchType | AnyEventGenBatchType[]>;
