/**
 * What the picker page shows, read at build time from the file build-all.ts writes
 * (dist/.variations/picker-input.json, named by LM_PICKER_INPUT). Built without it
 * (`bun run build:variation picker`), the picker reads each design's meta.json itself and
 * says it does not know whether the designs build.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WordCount } from "../../scripts/variations/words";

export type { WordCount };

export type Slot = "v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7" | "v8" | "v9";
export const SLOTS: readonly Slot[] = ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9"];

export type DesignStatus = {
	slot: Slot;
	name: string;
	idea: string;
	metaProblem: string | null;
	/** null when the picker was built on its own and does not know. */
	builds: boolean | null;
	error: string | null;
	ms: number;
	/** Its words (scripts/variations/words.ts), when it built. */
	words: WordCount | null;
};

export type Checkpoint = { design: Slot; level: string; path: string; words: WordCount | null };

/** A form: the design with a different amount of text, tagged home/v<n>/form-<name> and built from that commit (scripts/variations/frozen.ts). */
export type Form = { design: Slot; name: string; tag: string; commit: string; path: string; builds: boolean; error: string | null; words: WordCount | null };

export type PickerInput = {
	commit: string | null;
	designs: DesignStatus[];
	scores: unknown;
	scoresProblem: string | null;
	checkpoints: Checkpoint[];
	forms: Form[];
	/** Tags that look like forms but cannot be one, with why. */
	formsIgnored: string[];
};

/** site/variations/scores.json, as the publish script writes it (scripts/variations-scores.schema.json). */
export type ScoresFile = {
	schema: string;
	categories: { key: string; name: string }[];
	levels: number[];
	rounds: {
		round: number;
		judges: string[];
		judgements: Record<string, Record<string, { scores: Record<string, number>; notes: string }>>;
		merged: Record<string, string | null>;
		new_checkpoints: { design: string; level: number }[];
	}[];
	checkpoints: { design: string; level: number; round: number; commit: string; tag: string; path: string }[];
};

export function readInput(): PickerInput {
	const path = process.env.LM_PICKER_INPUT;
	if (path && existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as PickerInput;
	const site = resolve(process.cwd());
	const designs = SLOTS.map((slot): DesignStatus => {
		try {
			const meta = JSON.parse(readFileSync(join(site, "src", "variations", slot, "meta.json"), "utf8")) as { name: string; idea: string };
			return { slot, name: meta.name, idea: meta.idea, metaProblem: null, builds: null, error: null, ms: 0, words: null };
		} catch {
			return { slot, name: slot, idea: "", metaProblem: "meta.json does not read", builds: null, error: null, ms: 0, words: null };
		}
	});
	return { commit: null, designs, scores: { rounds: [] }, scoresProblem: null, checkpoints: [], forms: [], formsIgnored: [] };
}

/** The scores file if it has the shape the picker reads, else null. */
export function asScores(value: unknown): ScoresFile | null {
	const s = value as ScoresFile;
	if (!s || typeof s !== "object" || !Array.isArray(s.rounds) || !Array.isArray(s.categories ?? [])) return null;
	return { schema: s.schema, categories: s.categories ?? [], levels: s.levels ?? [], rounds: s.rounds, checkpoints: s.checkpoints ?? [] };
}
