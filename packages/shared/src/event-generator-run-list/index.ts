import { checkIfEc2 } from "../utils/check-if-ec2";
import { getEc2Data } from "../utils/get-ec2-data";
import type {
	AnyEventGenBatchType,
	EventGeneratorConfigBatchType,
} from "./types";

export const cronBenchmarkConfig = {
	"0 6 * * *": {
		prepCompute: async () => {
			return {
				mainRunner: {
					kind: "ec2",
					instanceType: "m5.metal",
					awsZone: "us-west-1a",
				},
				otherResources: {
					main_bucket: {
						kind: "s3Bucket",
						awsZone: "us-west-1a",
					},
				},
			};
		},
		prepEnv: async () => {
			const isEc2 = await checkIfEc2();
			if (!isEc2) {
				throw new Error("...");
			}
			const data = await getEc2Data();

			return { runnerInputs: { method: "GET", getUrl: "" } };
		},
		code: "fetch_tool",
	},
} satisfies Record<string, AnyEventGenBatchType | AnyEventGenBatchType[]>;
