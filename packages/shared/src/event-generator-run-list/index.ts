import type {
	AnyEventGenBatchType,
	EventGeneratorConfigBatchType,
} from "./types";

export const cronBenchmarkConfig = {
	"0 6 * * *": {
		prepEnv: async () => ({ runnerInputs: { method: "GET", getUrl: "" } }),
		code: "fetch_tool",
	},
} satisfies Record<string, AnyEventGenBatchType | AnyEventGenBatchType[]>;
