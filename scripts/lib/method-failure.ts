/**
 * What scripts/derive.ts writes in place of a Method's Derivations when that
 * Method fails, so that the other Method's Derivations and the page are still
 * made, and the page can say which part is missing and why.
 *
 * For an output path such as page/requests-derivations.json the note is
 * page/requests-derivations.failed.json. derive.ts removes a stale note when
 * the Method succeeds, and a stale output when it fails.
 */

import { existsSync, readFileSync } from "node:fs";

export interface MethodFailure {
	schema: "ledgermath.method-failure/1";
	method: { name: string; version: number };
	/** The error, in the Method's or the fetch's own words. */
	error: string;
}

/** Where the note for an output path goes. */
export const failurePath = (out: string): string => `${out.replace(/\.json$/, "")}.failed.json`;

export function methodFailure(method: { name: string; version: number }, error: unknown): MethodFailure {
	return { schema: "ledgermath.method-failure/1", method: { name: method.name, version: method.version }, error: error instanceof Error ? error.message : String(error) };
}

/** A part of the page's input: the Method's Derivations, or the note saying why there are none. Throws when there is neither. */
export function readPart<T>(path: string): { file: T; failure: null } | { file: null; failure: MethodFailure } {
	if (existsSync(path)) return { file: JSON.parse(readFileSync(path, "utf8")) as T, failure: null };
	const note = failurePath(path);
	if (existsSync(note)) {
		const failure = JSON.parse(readFileSync(note, "utf8")) as Partial<MethodFailure>;
		if (failure.schema !== "ledgermath.method-failure/1" || typeof failure.error !== "string" || typeof failure.method?.name !== "string") {
			throw new Error(`${note} is not a ledgermath.method-failure/1 note`);
		}
		return { file: null, failure: failure as MethodFailure };
	}
	throw new Error(`neither ${path} nor ${note}: run scripts/derive.ts first`);
}
