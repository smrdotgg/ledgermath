import { fetchTool } from "../tools/fetch";
import type { EventGenerator } from "./types";

export const EventGeneratorRegistry = {
	fetchTool,
} satisfies Record<string, EventGenerator>;
