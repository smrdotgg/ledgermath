/**
 * The lookup tool for agents: what LedgerMath holds, read from the Method's
 * output (derivations.json) and the price files (prices/), with a citation
 * beside every number. skills/ledgermath/SKILL.md says how an agent uses it.
 *
 *     bun scripts/lookup.ts [--data LOCATION] [--derivations FILE] [--requests-derivations FILE] [--prices-date YYYY-MM-DD] [--json] COMMAND [ARGS]
 *
 *   about                       what the data hold: Series, benchmarks, instance types, price files
 *   series [WORD...]            the Series, or those matching every word
 *   show ID|WORD... [--runs N|all]
 *                               one Series: percentiles with citations, groups, the Runs behind them
 *                               (newest 10 by default); for a Series of requests, also the
 *                               percentiles of each phase across its requests (Method requests)
 *   prices WORD...              the prices matching every word, with AWS's words and citations
 *
 *   --data LOCATION    a directory holding derivations.json, runs/ and prices/ (a clone of the
 *                      Runs repository with a derivations file), or a base web address serving
 *                      them; default $LEDGERMATH_DATA
 *   --derivations FILE read the derivations from this file instead of LOCATION/derivations.json
 *   --requests-derivations FILE
 *                      read Method requests' Derivations from this file instead of
 *                      LOCATION/requests-derivations.json (which may be absent: then no
 *                      percentile across requests is held)
 *   --prices-date D    use the price file of that date instead of the newest
 *   --json             the same answer as JSON
 *
 * A word matches the start of any word of a Series (benchmark, params, build, instance type,
 * zone ID, what the benchmark measures) or of a price (SKU, AWS's description and catalog
 * attributes, the rule that selected it), ignoring case. When nothing matches, the answer
 * says what is not held and lists what is. Exit 0 either way; 2 on a usage or data error.
 */

import { parseArgs } from "node:util";

import { loadLedger, openLocation } from "./lib/ledger-data";
import { about, aboutText, findPrices, listSeries, pricesText, seriesListText, showSeries, showText } from "./lib/lookup";

const USAGE =
	"usage: bun scripts/lookup.ts [--data LOCATION] [--derivations FILE] [--requests-derivations FILE] [--prices-date YYYY-MM-DD] [--json] " +
	"(about | series [WORD...] | show ID|WORD... [--runs N|all] | prices WORD...)";

function fail(message: string): never {
	console.error(message);
	process.exit(2);
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			data: { type: "string" },
			derivations: { type: "string" },
			"requests-derivations": { type: "string" },
			"prices-date": { type: "string" },
			runs: { type: "string" },
			json: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		console.log(USAGE);
		return;
	}
	const [command, ...words] = positionals;
	const base = values.data ?? process.env.LEDGERMATH_DATA;
	if (command === undefined || base === undefined || base === "") fail(USAGE);
	if (values["prices-date"] !== undefined && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(values["prices-date"])) fail("--prices-date is YYYY-MM-DD");
	let runs: number | "all" = 10;
	if (values.runs !== undefined) {
		if (values.runs === "all") runs = "all";
		else if (/^[0-9]+$/.test(values.runs) && Number(values.runs) > 0) runs = Number(values.runs);
		else fail("--runs is a positive whole number or all");
	}

	const data = await loadLedger(openLocation(base), { derivations: values.derivations, requestsDerivations: values["requests-derivations"], pricesDate: values["prices-date"] });
	const out = (json: unknown, text: string): void => {
		process.stdout.write(values.json ? `${JSON.stringify(json, null, 2)}\n` : text);
	};
	const synthetic = data.derivations.synthetic === undefined ? {} : { synthetic: data.derivations.synthetic };
	switch (command) {
		case "about": {
			const answer = about(data);
			out(answer, aboutText(data, answer));
			break;
		}
		case "series": {
			const answer = listSeries(data, words);
			out({ ...synthetic, ...answer }, seriesListText(data, answer));
			break;
		}
		case "show": {
			if (words.length === 0) fail("show needs a Series id, or words that match one Series");
			const answer = showSeries(data, words, runs);
			out({ ...synthetic, ...answer }, showText(data, answer));
			break;
		}
		case "prices": {
			if (words.length === 0) fail("prices needs at least one word, such as an instance type, gp3, GET or transfer");
			const answer = findPrices(data, words);
			out({ ...synthetic, ...answer }, pricesText(data, answer));
			break;
		}
		default:
			fail(USAGE);
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	});
}
