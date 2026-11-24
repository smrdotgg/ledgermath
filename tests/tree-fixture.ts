/**
 * The data API's tree for the lookup tool's and the answer checker's tests,
 * written by the generator itself (buildApi, scripts/lib/api.ts) from a
 * fixture's two files of Derivations, into the directory that already holds
 * the fixture's Runs repository checkout (runs/, boots/, prices/). The
 * directory is then a location as the tools read one: v1/, with runs/ and
 * boots/ beside it. Nothing in it was measured.
 *
 * serve() stands in for a web server holding the same directory, for the
 * tools' injected fetch: it records every address asked for and may answer
 * otherwise for chosen paths, so a test can count requests or break the
 * contract (a stale month file, a missing one, a stalled request).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import type { DerivationsFile as SeriesFile } from "../methods/v1/output";
import { buildApi, DEFAULT_BASE, readApiSchemas, readBootSummaries, readPriceFiles } from "../scripts/lib/api";
import type { Fetch } from "../scripts/lib/ledger-data";

/** The docs' address the fixtures' trees give. */
export const FIXTURE_DOCS = "https://example.test/docs";

/** Builds the tree for these Derivations, with the price files and boot summaries the directory holds, and writes it under directory/v1/. Returns its files by path. */
export function writeTree(directory: string, series: SeriesFile, requests: RequestsFile, options: { base?: string } = {}): Map<string, Uint8Array> {
	const tree = buildApi({
		base: options.base ?? DEFAULT_BASE,
		docs: FIXTURE_DOCS,
		series,
		requests,
		prices: readPriceFiles(directory),
		boots: readBootSummaries(directory),
		schemas: readApiSchemas(),
	});
	for (const [path, bytes] of tree) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), bytes);
	}
	return tree;
}

/** What a stand-in server answers for one path instead of the file: a Response, or a function of the attempt (1 for the first request of that path). */
export type Override = Response | ((attempt: number, init: { signal: AbortSignal }) => Response | Promise<Response>);

/**
 * A fetch serving `directory` at `base` (no final slash), recording each
 * address asked for in `asked`. A path in `overrides` is answered by it;
 * every other path by the file, with its Content-Length, or 404.
 */
export function serve(directory: string, base: string, asked: string[], overrides: ReadonlyMap<string, Override> = new Map()): Fetch {
	const attempts = new Map<string, number>();
	return async (url, init): Promise<Response> => {
		asked.push(url);
		if (!url.startsWith(`${base}/`)) return new Response("not this server", { status: 404 });
		const path = url.slice(base.length + 1);
		const attempt = (attempts.get(path) ?? 0) + 1;
		attempts.set(path, attempt);
		const override = overrides.get(path);
		// Bun's types give clone() the Response of undici's types, which is the same object.
		if (override !== undefined) return typeof override === "function" ? override(attempt, init) : (override.clone() as Response);
		const full = join(directory, path);
		if (path.length === 0 || !existsSync(full) || !statSync(full).isFile()) return new Response("not found", { status: 404 });
		const bytes = new Uint8Array(readFileSync(full));
		return new Response(bytes, { headers: { "content-type": "application/json", "content-length": String(bytes.length) } });
	};
}

/** A request that never answers: it waits until its signal aborts, as a stalled server would. */
export const stalled = (_attempt: number, init: { signal: AbortSignal }): Promise<Response> =>
	new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
