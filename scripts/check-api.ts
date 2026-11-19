/**
 * Checks the data API's tree that scripts/build-api.ts wrote, against the
 * Derivations, the Runs repository checkout and this repository's schemas
 * (scripts/lib/api-check.ts says what a passing check establishes):
 *
 *     bun scripts/check-api.ts --tree DIR --derivations FILE --requests-derivations FILE --runs DIR [--base URL]
 *                              [--previous DIR [--allow-no-previous]]
 *
 *   --tree DIR                   the tree, as written: it holds v1/
 *   --derivations FILE           Method series v1's Derivations it was cut from
 *   --requests-derivations FILE  Method requests v1's
 *   --runs DIR                   the Runs repository checkout whose evidence it links
 *   --base URL                   the address it was built for (default https://api.ledgermath.com)
 *   --previous DIR               the tree before this one, which readers were last served: every month
 *                                file of it must be in this tree, byte for byte or changed only for
 *                                the four causes ADR-0030 gives (checkStability). One that is missing,
 *                                empty or of another layout (other schemas, another base) is a problem
 *   --allow-no-previous          says there may be no previous tree of this layout: for the first
 *                                build of a layout only. The output then says plainly that past months
 *                                were not compared, and a tree that passes the rest exits 0
 *
 * Prints every problem and exits 1 when there is any; 0 when there is none.
 * With --previous, it also lists each month file that changed, by cause.
 */

import { parseArgs } from "node:util";

import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import type { DerivationsFile as SeriesFile } from "../methods/v1/output";
import { DEFAULT_BASE, readDerivations } from "./lib/api";
import { checkApi, checkStability, describeStability, type StabilityResult } from "./lib/api-check";

const USAGE =
	"usage: bun scripts/check-api.ts --tree DIR --derivations FILE --requests-derivations FILE --runs DIR [--base URL] [--previous DIR [--allow-no-previous]]";

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
			previous: { type: "string" },
			"allow-no-previous": { type: "boolean" },
		},
	});
	if (!values.tree || !values.derivations || !values["requests-derivations"] || !values.runs || (values["allow-no-previous"] === true && values.previous === undefined)) {
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
	let stability: StabilityResult | undefined;
	if (values.previous !== undefined) {
		stability = checkStability(values.previous, values.tree, { mayBeNone: values["allow-no-previous"] === true });
		result.problems.push(...stability.problems);
		for (const line of describeStability(stability, values.previous)) console.log(line);
	}
	const took = Math.round(performance.now() - started);
	if (result.problems.length > 0) {
		for (const problem of result.problems.slice(0, SHOWN)) console.error(problem);
		if (result.problems.length > SHOWN) console.error(`and ${result.problems.length - SHOWN} more`);
		console.error(`data API v1: ${result.problems.length} problems in ${values.tree} (${took} ms)`);
		process.exit(1);
	}
	console.log(
		`data API v1: ${result.files} files checked, ${result.series} Series in ${result.months} month files, ${result.runFiles} Run files cited and found with their id, boot, start and sha256, ` +
			`${stability === undefined ? "" : stability.compared ? `no past month changed since ${values.previous} but for a cause, ` : "past months not compared (no previous tree of this layout, which --allow-no-previous allowed), "}no problem (${took} ms)`,
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
