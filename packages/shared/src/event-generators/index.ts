import { fetchSingleByteFromS3 } from "./all/fetch-single-byte-from-s3";
import type { EventGenerator } from "./types";

export const EventGeneratorRegistry = {
	fetchSingleByteFromS3: fetchSingleByteFromS3,
} satisfies Record<string, EventGenerator>;
