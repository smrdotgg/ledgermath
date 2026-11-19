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
 *   --previous DIR               the tree before this one, which readers were last served. Of this
 *                                layout (v1/index.json's layout) and base, it must be whole, and every
 *                                month file of it must be in this tree, byte for byte or changed only
 *                                for the four causes ADR-0030 gives (checkStability). One that is
 *                                missing, empty, of another layout or built for another base is a problem
 *   --allow-no-previous          a human's declaration of a new baseline: for the first build of a new
 *                                layout, or once the last tree kept has expired. Nothing automatic may
 *                                pass it (the runs workflow passes it only from its input new_baseline).
 *                                A previous tree of this layout is compared all the same; one of another
 *                                layout is not, but every Series and Run it published must still be here
 *
 * Prints every problem and exits 1 when there is any; 0 when there is none.
 * With --previous, it also lists each month file that changed, by cause, and
 * what the comparison cannot establish, and writes the same to the step's
 * summary ($GITHUB_STEP_SUMMARY) when there is one.
 */

import { appendFileSync } from "node:fs";
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
		stability = checkStability(values.previous, values.tree, { newBaseline: values["allow-no-previous"] === true });
		result.problems.push(...stability.problems);
		const lines = describeStability(stability, values.previous);
		for (const line of lines) console.log(line);
		if (process.env.GITHUB_STEP_SUMMARY) {
			const problems = stability.problems.length === 0 ? "" : `\n${stability.problems.length} problem${stability.problems.length === 1 ? "" : "s"} with the tree before, the first: ${stability.problems[0]}\n`;
			appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### The data API against the tree before\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n${problems}`);
		}
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
			`${stability === undefined ? "" : stability.compared ? `no past month changed since ${values.previous} but for a cause, ` : "past months not compared (a new baseline, declared by --allow-no-previous), no published Series or Run missing, "}no problem (${took} ms)`,
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
