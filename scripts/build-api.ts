/**
 * Builds the data API's tree of static files (scripts/lib/api.ts, ADR-0030)
 * from the two files of Derivations and a checkout of the Runs repository:
 *
 *     bun scripts/build-api.ts --derivations FILE --requests-derivations FILE --runs DIR --out DIR
 *                              [--base URL] [--docs URL]
 *
 *   --derivations FILE           Method series v1's Derivations (page/derivations.json)
 *   --requests-derivations FILE  Method requests v1's (page/requests-derivations.json)
 *   --runs DIR                   the Runs repository: its price files are copied into the
 *                                tree, and its boot summaries linked from each point
 *   --out DIR                    where the tree is written, laid out as it is served from
 *                                the host's root (DIR/v1/...); a new or empty directory
 *   --base URL                   the address the tree and the evidence are served from
 *                                (default https://api.ledgermath.com)
 *   --docs URL                   where the API is described in words (default: the
 *                                README's section "The data API")
 *
 * Writes nothing unless every file was made. scripts/check-api.ts checks the
 * tree it wrote. The same inputs give the same bytes, file for file. Refuses a
 * file of Derivations holding a number it could not write back with its value
 * (readDerivations).
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import type { DerivationsFile as SeriesFile } from "../methods/v1/output";
import { buildApi, DEFAULT_BASE, DEFAULT_DOCS, readApiSchemas, readBootSummaries, readDerivations, readPriceFiles } from "./lib/api";

const USAGE =
	"usage: bun scripts/build-api.ts --derivations FILE --requests-derivations FILE --runs DIR --out DIR [--base URL] [--docs URL]";

function main(): void {
	const { values } = parseArgs({
		options: {
			derivations: { type: "string" },
			"requests-derivations": { type: "string" },
			runs: { type: "string" },
			out: { type: "string" },
			base: { type: "string" },
			docs: { type: "string" },
		},
	});
	if (!values.derivations || !values["requests-derivations"] || !values.runs || !values.out) {
		console.error(USAGE);
		process.exit(2);
	}
	const out = values.out;
	if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty: the tree is written whole into a new or empty directory`);
	if (!existsSync(join(values.runs, "runs"))) throw new Error(`${values.runs} holds no runs/: it is not a checkout of the Runs repository`);

	const started = performance.now();
	const tree = buildApi({
		base: values.base ?? DEFAULT_BASE,
		docs: values.docs ?? DEFAULT_DOCS,
		series: readDerivations<SeriesFile>(values.derivations, "series"),
		requests: readDerivations<RequestsFile>(values["requests-derivations"], "requests"),
		prices: readPriceFiles(values.runs),
		boots: readBootSummaries(values.runs),
		schemas: readApiSchemas(),
	});
	let bytes = 0;
	for (const [path, content] of tree) {
		const full = join(out, ...path.split("/"));
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
		bytes += content.length;
	}
	const count = (pattern: RegExp) => [...tree.keys()].filter((path) => pattern.test(path)).length;
	console.log(
		`data API v1: ${tree.size} files, ${bytes} bytes: ${count(/^v1\/series\/[^/]+\.json$/)} Series, ${count(/^v1\/series\/[^/]+\/[^/]+\.json$/)} month files, ` +
			`${count(/^v1\/prices\//)} price files, ${count(/^v1\/schemas\//)} schemas, in ${Math.round(performance.now() - started)} ms -> ${out}`,
	);
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
