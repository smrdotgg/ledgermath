/**
 * Checks an answer written with the LedgerMath skill: every number is cited
 * or marked as an assumption (or comes from the question, or from arithmetic
 * shown on its line), and every citation resolves in the data.
 * scripts/lib/answer-check.ts says exactly what it checks; the citation
 * syntax is in scripts/lib/citation.ts and skills/ledgermath/SKILL.md.
 *
 *     bun scripts/check-answer.ts [--data LOCATION] [--derivations FILE] [--requests-derivations FILE] [--question FILE] [--verbose] [--json] ANSWER
 *
 *   --data LOCATION   the data the answer was written from, as for scripts/lookup.ts; default $LEDGERMATH_DATA
 *   --question FILE   the question; its numbers count as given
 *   --verbose         list every number and citation, and how each was accounted for
 *
 * Exit 0 when there is no problem, 1 when there is, 2 on a usage or data error.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { checkAnswer, reportText } from "./lib/answer-check";
import { loadLedger, openLocation } from "./lib/ledger-data";

const USAGE = "usage: bun scripts/check-answer.ts [--data LOCATION] [--derivations FILE] [--requests-derivations FILE] [--question FILE] [--verbose] [--json] ANSWER";

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			data: { type: "string" },
			derivations: { type: "string" },
			"requests-derivations": { type: "string" },
			question: { type: "string" },
			verbose: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
		},
	});
	const base = values.data ?? process.env.LEDGERMATH_DATA;
	const [answerPath] = positionals;
	if (answerPath === undefined || positionals.length !== 1 || base === undefined || base === "") {
		console.error(USAGE);
		return 2;
	}
	for (const path of [answerPath, values.question]) {
		if (path !== undefined && !existsSync(path)) {
			console.error(`no file ${path}`);
			return 2;
		}
	}
	const data = await loadLedger(openLocation(base), { derivations: values.derivations, requestsDerivations: values["requests-derivations"] });
	const report = await checkAnswer(readFileSync(answerPath, "utf8"), data, values.question === undefined ? "" : readFileSync(values.question, "utf8"));
	process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : reportText(report, { answer: answerPath, data: base, verbose: values.verbose }));
	return report.pass ? 0 : 1;
}

if (import.meta.main) {
	main()
		.then((code) => process.exit(code))
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(2);
		});
}
