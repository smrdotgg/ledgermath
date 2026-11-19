/**
 * Checks the data API's tree that scripts/build-api.ts wrote
 * (scripts/lib/api-check.ts says what is checked):
 *
 *     bun scripts/check-api.ts --tree DIR --derivations FILE --requests-derivations FILE --runs DIR [--base URL]
 *
 *   --tree DIR                   the tree, as written: it holds v1/
 *   --derivations FILE           Method series v1's Derivations it was cut from
 *   --requests-derivations FILE  Method requests v1's
 *   --runs DIR                   the Runs repository checkout whose evidence it links
 *   --base URL                   the address it was built for (default https://api.ledgermath.com)
 *
 * Prints every problem and exits 1 when there is any; 0 when there is none.
 */

import { parseArgs } from "node:util";

import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import type { DerivationsFile as SeriesFile } from "../methods/v1/output";
import { DEFAULT_BASE, readDerivations } from "./lib/api";
import { checkApi } from "./lib/api-check";

const USAGE = "usage: bun scripts/check-api.ts --tree DIR --derivations FILE --requests-derivations FILE --runs DIR [--base URL]";

/** At most this many problems are printed, then how many more there are. */
const SHOWN = 200;

function main(): void {
	const { values } = parseArgs({
		options: {
			tree: { type: "string" },
			derivations: { type: "string" },
			"requests-derivations": { type: "string" },
			runs: { type: "string" },
			base: { type: "string" },
		},
	});
	if (!values.tree || !values.derivations || !values["requests-derivations"] || !values.runs) {
		console.error(USAGE);
		process.exit(2);
	}
	const started = performance.now();
	const result = checkApi({
		tree: values.tree,
		runs: values.runs,
		base: values.base ?? DEFAULT_BASE,
		series: readDerivations<SeriesFile>(values.derivations, "series"),
		requests: readDerivations<RequestsFile>(values["requests-derivations"], "requests"),
	});
	const took = Math.round(performance.now() - started);
	if (result.problems.length > 0) {
		for (const problem of result.problems.slice(0, SHOWN)) console.error(problem);
		if (result.problems.length > SHOWN) console.error(`and ${result.problems.length - SHOWN} more`);
		console.error(`data API v1: ${result.problems.length} problems in ${values.tree} (${took} ms)`);
		process.exit(1);
	}
	console.log(
		`data API v1: ${result.files} files checked, ${result.series} Series, ${result.runFiles} Run files cited and found with their sha256, no problem (${took} ms)`,
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
