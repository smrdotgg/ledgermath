import type {
	AnyEventGenBatchType,
	EventGeneratorConfigBatchType,
} from "./types";

export const cronBenchmarkConfig = {
	"0 6 * * *": {
		prepEnv: async () => {
			return { getUrl: "" };
		},
		code: "fetch_file_from_s3",
	},
} satisfies Record<string, AnyEventGenBatchType | AnyEventGenBatchType[]>;
