/**
 * The lookup tool for agents: what LedgerMath holds, read from its data API
 * (the Methods' output and the price files, as a tree of small JSON files),
 * with a citation beside every number. skills/ledgermath/SKILL.md says how an
 * agent uses it.
 *
 *     bun scripts/lookup.ts [--data LOCATION] [--prices-date YYYY-MM-DD] [--json] COMMAND [ARGS]
 *
 *   about                       what the data hold: Series, benchmarks, instance types, price files
 *   series [WORD...]            the Series, or those matching every word
 *   show ID|WORD... [--runs N|all]
 *                               one Series: percentiles with citations, groups, the Runs behind them
 *                               (newest 10 by default); for a Series of requests, also the
 *                               percentiles of each phase across its requests (Method requests)
 *   prices WORD...              the prices matching every word, with AWS's words and citations
 *
 *   --data LOCATION    the data API's address, or a directory laid out the same way (v1/, with
 *                      runs/ and boots/ beside it); default $LEDGERMATH_DATA, then
 *                      https://api.ledgermath.com
 *   --prices-date D    use the price file of that date instead of the newest
 *   --json             the same answer as JSON
 *
 * Each command reads only the files it needs (scripts/lib/ledger-data.ts): about and series,
 * the table of contents and the list of Series; show, those and the Series' own file, and its
 * month files only for Runs older than the newest it holds; prices, the table of contents and
 * the price file.
 *
 * A word matches the start of any word of a Series (benchmark, params, build, instance type,
 * zone ID, what the benchmark measures) or of a price (SKU, AWS's description and catalog
 * attributes, the rule that selected it), ignoring case. When nothing matches, the answer
 * says what is not held and lists what is. Exit 0 either way; 2 on a usage or data error,
 * with what went wrong in words (for data being updated: try again in a few minutes).
 */

import { parseArgs } from "node:util";

import { LedgerError, loadLedger, locationFrom, openLocation } from "./lib/ledger-data";
import { about, aboutText, findPrices, listSeries, pricesText, seriesListText, showSeries, showText } from "./lib/lookup";

const USAGE = "usage: bun scripts/lookup.ts [--data LOCATION] [--prices-date YYYY-MM-DD] [--json] (about | series [WORD...] | show ID|WORD... [--runs N|all] | prices WORD...)";

function fail(message: string): never {
	console.error(message);
	process.exit(2);
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			data: { type: "string" },
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
	if (command === undefined || !["about", "series", "show", "prices"].includes(command)) fail(USAGE);
	if (command === "show" && words.length === 0) fail("show needs a Series id, or words that match one Series");
	if (command === "prices" && words.length === 0) fail("prices needs at least one word, such as an instance type, gp3, GET or transfer");
	if (values["prices-date"] !== undefined && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(values["prices-date"])) fail("--prices-date is YYYY-MM-DD");
	let runs: number | "all" = 10;
	if (values.runs !== undefined) {
		if (values.runs === "all") runs = "all";
		else if (/^[0-9]+$/.test(values.runs) && Number(values.runs) > 0) runs = Number(values.runs);
		else fail("--runs is a positive whole number or all");
	}

	const { base, isDefault } = locationFrom(values.data, process.env.LEDGERMATH_DATA);
	const data = await loadLedger(openLocation(base), { pricesDate: values["prices-date"], isDefault });
	const out = (json: unknown, text: string): void => {
		process.stdout.write(values.json ? `${JSON.stringify(json, null, 2)}\n` : text);
	};
	switch (command) {
		case "about": {
			const answer = await about(data);
			out(answer, aboutText(answer));
			break;
		}
		case "series": {
			const answer = await listSeries(data, words);
			out(answer, seriesListText(answer));
			break;
		}
		case "show": {
			const answer = await showSeries(data, words, runs);
			out(answer, showText(answer));
			break;
		}
		case "prices": {
			const answer = await findPrices(data, words);
			out(answer, pricesText(answer));
			break;
		}
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof LedgerError ? error.message : error instanceof Error ? `${error.message}` : String(error));
		process.exit(2);
	});
}
