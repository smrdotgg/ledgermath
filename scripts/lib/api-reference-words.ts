/**
 * The hand-written words of the API reference (scripts/lib/api-reference.ts): each file page's
 * title, its first paragraph and where its file is, the overview at /docs/api/ and the opening
 * of the machines page. Everything a field means is the schema's, copied by the generator; the
 * API's contract paragraphs are quoted from their one source, the constants of scripts/lib/api.ts,
 * by the generator, at the places marked below. These words are Markdown as written: a path in
 * them is in a code span, so nothing in it needs escaping.
 *
 * A link to another documentation page is a path from scripts/lib/docs-addresses.ts; a link to
 * a file of the API is its full address.
 */

import type { SampleKind } from "../fetch-api-sample";

export interface FilePage {
	/** The page's file, under the directory the reference is written to. */
	file: string;
	/** The page's address on the site. */
	address: string;
	/** The schema the page is generated from, by its path in this repository. */
	schema: string;
	/** The kind of file of the fixed sample its example comes from. */
	sample: SampleKind;
	title: string;
	/** The first paragraph: what the file is, standing alone (an index of pages shows it as the page's description). */
	intro: string;
	/** Where the file is and how a reader reaches it, one list item each (the schema's own link is added after them). */
	where: string[];
	/** True for the API's own files of v1, whose schemas forbid no member they do not list. */
	v1: boolean;
}

export const FILE_PAGES: readonly FilePage[] = [
	{
		file: "docs/api/table-of-contents.md",
		address: "/docs/api/table-of-contents",
		schema: "schemas/api/v1/index.schema.json",
		sample: "index",
		title: "The table of contents",
		intro:
			"`v1/index.json` is where a reader of LedgerMath's data API starts: it gives the address of every other kind of file, the API's rules in words, each benchmark's list of Series with its counts, the price files, the schemas, and the newest rounds of boots.",
		where: [
			"Address: [https://api.ledgermath.com/v1/index.json](https://api.ledgermath.com/v1/index.json), the one address a reader needs to know.",
			"Reached from: every other file of version 1 but the price files names it (`index`).",
			"Links to: the list of every Series (`series.url`); each benchmark's list (`benchmarks.list[].url`, and `benchmarks.benchmark_file_url_template` for any benchmark by its name); any Series' file by its id (`series.series_file_url_template`); the price files (`prices.files[].url`, the newest at `prices.newest.url`); the schemas (`schemas[].url`); the summary of each boot of the newest rounds (`recent_rounds.rounds[].by_boot[].boot_summary`); and any blob by its hash (`evidence.blob_url_template`).",
			"Changes: with the data, at every update of the API.",
		],
		v1: true,
	},
	{
		file: "docs/api/series-list.md",
		address: "/docs/api/series-list",
		schema: "schemas/api/v1/series-list.schema.json",
		sample: "series-list",
		title: "The list of Series",
		intro:
			"`v1/series.json` lists every Series LedgerMath has measured, one row each with what the Series is, its counts, a summary of each Method's figures and the address of its own file, and gives each Method's own words for how its numbers are made.",
		where: [
			"Address: [https://api.ledgermath.com/v1/series.json](https://api.ledgermath.com/v1/series.json).",
			"Reached from: the table of contents (`series.url`).",
			"Links to: each Series' file (`series[].url`); the table of contents (`index`); each Run file a Method could not read (`methods.series_v1.unreadable[].evidence`, `methods.requests_v1.unreadable[].evidence`).",
			"Each benchmark's rows are also in a smaller file of their own, [a benchmark's list of Series](/docs/api/benchmark-list), so a reader looking for one Series need not fetch this whole list.",
		],
		v1: true,
	},
	{
		file: "docs/api/benchmark-list.md",
		address: "/docs/api/benchmark-list",
		schema: "schemas/api/v1/benchmark.schema.json",
		sample: "benchmark",
		title: "A benchmark's list of Series",
		intro:
			"`v1/benchmarks/<benchmark>.json` holds one benchmark's rows of the list of Series, so that a reader finds a Series, and its figures, in two small requests from the table of contents: this list, then the Series' file.",
		where: [
			"Address: `https://api.ledgermath.com/v1/benchmarks/<benchmark>.json`, with the benchmark's name.",
			"Reached from: the table of contents (`benchmarks.list[].url`), or its template `benchmarks.benchmark_file_url_template` with the benchmark's name, which every row and every Series' file gives (`benchmark`).",
			"Links to: each Series' file (`series[].url`); the table of contents (`index`).",
		],
		v1: true,
	},
	{
		file: "docs/api/series.md",
		address: "/docs/api/series",
		schema: "schemas/api/v1/series.schema.json",
		sample: "series",
		title: "A Series file",
		intro:
			"`v1/series/<id>.json` holds one Series: what it is, each Method's figures and definitions in full, the points of its newest Runs, and the list of its month files, each with the file's sha256 and size.",
		where: [
			"Address: `https://api.ledgermath.com/v1/series/<id>.json`, with the Series' id, 12 lower-case hex digits.",
			"Reached from: a row's `url`, in the list of Series or a benchmark's list; or the table of contents' template `series.series_file_url_template` with the Series' id.",
			"Links to: each of its month files (`months[].url`); the table of contents (`index`); the Run file and the boot summary of each of its newest points (`evidence`, `boot_summary`).",
		],
		v1: true,
	},
	{
		file: "docs/api/series-month.md",
		address: "/docs/api/series-month",
		schema: "schemas/api/v1/series-month.schema.json",
		sample: "series-month",
		title: "A month file",
		intro:
			"`v1/series/<id>/<yyyy-mm>.json` holds every point of the Runs of one Series that started in one month (UTC), each with the sha256 of its Run file and the addresses of its evidence.",
		where: [
			"Address: `https://api.ledgermath.com/v1/series/<id>/<yyyy-mm>.json`, with the Series' id and the month.",
			"Reached from: its Series' file (`months[].url`), which also gives the month file's `sha256` and size in `bytes`: a reader checks the file it fetched against them ([what to do when they differ](/docs/api/)).",
			"Links to: its Series' file (`series_url`); the table of contents (`index`); each point's Run file (`evidence`) and its boot's summary (`boot_summary`).",
		],
		v1: true,
	},
	{
		file: "docs/api/prices.md",
		address: "/docs/api/prices",
		schema: "schemas/prices.schema.json",
		sample: "prices",
		title: "A price file",
		intro:
			"`v1/prices/<yyyy-mm-dd>.json` is one day's copy of what AWS publicly charges for what LedgerMath measures: the records a versioned rule set selected from AWS's public price lists, kept verbatim.",
		where: [
			"Address: `https://api.ledgermath.com/v1/prices/<yyyy-mm-dd>.json`, with the UTC date it was fetched.",
			"Reached from: the table of contents (`prices.files[].url`; the newest, `prices.newest.url`).",
			"Links to: the versioned price list files of AWS it was cut from (`sources[].url`).",
			"A price is cited by the file's path, as the table of contents gives it (`prices.files[].path`), the SKU and the rate code: see [Prices](/docs/prices).",
		],
		v1: false,
	},
	{
		file: "docs/api/run.md",
		address: "/docs/api/run",
		schema: "schemas/run.schema.json",
		sample: "run",
		title: "A Run file",
		intro:
			"A Run file records one execution of one benchmark binary on one machine, whether it succeeded or failed: the evidence every number of the data API is derived from.",
		where: [
			"Address: `https://api.ledgermath.com/runs/<yyyy>/<mm>/<dd>/<id>.json`, with the UTC day the Run started and the Run's id.",
			"Reached from: each point's `evidence`, in a month file or among a Series file's newest points; and, for a Run file no Method could read, `methods.<method>_v<version>.unreadable[].evidence` in the list of Series.",
			"Links to: each blob it names by hash, `sha256:<hex>` (its binary, source archive, runner, stdout, stderr and dumps), at the table of contents' `evidence.blob_url_template` with `{hex}` replaced by the 64 hex digits.",
			"Not a file of version 1: a Run file is evidence, written once, on the machine that ran the binary, and never edited.",
		],
		v1: false,
	},
	{
		file: "docs/api/events.md",
		address: "/docs/api/events",
		schema: "schemas/events.schema.json",
		sample: "events",
		title: "An event: one line of a Run's stdout",
		intro:
			"A benchmark prints a stream of events to its stdout, one JSON object per line; the events schema gives the shape of each line, and a Method counts a Run only when every line of its stdout has that shape.",
		where: [
			"Address: the lines have no file of their own: they are the stdout blob a Run file names (`stdout`, `sha256:<hex>`), at `https://api.ledgermath.com/blobs/sha256/<hex>` (the table of contents' `evidence.blob_url_template`).",
			"Reached from: a Run file's `stdout`.",
			"The schema describes one line. The order of the lines is a rule of its own, which the schema states in words (below).",
		],
		v1: false,
	},
];

/** The overview, /docs/api/: its title and first paragraph. */
export const OVERVIEW = {
	file: "docs/api/index.md",
	address: "/docs/api/",
	title: "The data API",
	intro:
		"LedgerMath publishes every number it measures as a data API: small static JSON files at `https://api.ledgermath.com`, each kind described by a JSON schema, which a reader reaches by following links from one table of contents down to the evidence behind each number.",
} as const;

/**
 * The overview's words, with the API's own contract paragraphs quoted where `quote` puts them
 * (the generator passes the constants of scripts/lib/api.ts, never a copy) and the list of file
 * pages where `pages` puts it.
 */
export function overviewBody(parts: {
	quote: (text: string, source: string) => string;
	quotes: { about: string; versioning: string; figures: string; months: string; listUpdates: string; evidence: string };
	pages: string;
}): string[] {
	const { quote, quotes } = parts;
	return [
		"## What it is",
		"The table of contents describes LedgerMath and the API in its own words:",
		quote(quotes.about, "`about`, in the table of contents"),
		"There is no server: every file is a static file, written again when the data change, several times a day, and every address a reader needs is written in the files. A reader never builds an address from an id, but for three templates the table of contents gives: a blob's address from its hash, a Series' file from its id, and a benchmark's list from the benchmark's name.",
		"## How a reader walks it",
		[
			"1. **The table of contents**, [https://api.ledgermath.com/v1/index.json](https://api.ledgermath.com/v1/index.json) ([the page](/docs/api/table-of-contents)). It names each benchmark's list with its counts (`benchmarks.list`), the list of every Series (`series.url`), the price files (`prices`), the schemas (`schemas`) and the newest rounds of boots (`recent_rounds`).",
			"2. **A benchmark's list**, `https://api.ledgermath.com/v1/benchmarks/<benchmark>.json` ([the page](/docs/api/benchmark-list)), at the address `benchmarks.list[].url` gives, or `benchmarks.benchmark_file_url_template` with the benchmark's name. One row per Series: its parameters, build, instance type and zone, its counts, a summary of each Method's figures, and the address of the Series' file (`url`). A Series in no benchmark's list is in [the list of every Series](/docs/api/series-list), `https://api.ledgermath.com/v1/series.json`, which holds every row.",
			"3. **A Series' file**, `https://api.ledgermath.com/v1/series/<id>.json` ([the page](/docs/api/series)), at its row's `url`, or `series.series_file_url_template` with the Series' id. Each Method's figures and definitions in full, its groups, the points of its newest Runs, and `months`: each month a Run of the Series started in, with the month file's address, sha256 and size.",
			"4. **A month file**, `https://api.ledgermath.com/v1/series/<id>/<yyyy-mm>.json` ([the page](/docs/api/series-month)), at `months[].url`. Every point of the Runs that started that month. Check its sha256 against the one `months` lists before using it (below).",
			"5. **The evidence.** Each point links its Run file (`evidence`), `https://api.ledgermath.com/runs/<yyyy>/<mm>/<dd>/<id>.json` ([the page](/docs/api/run)), and its boot's summary (`boot_summary`), `https://api.ledgermath.com/boots/<yyyy>/<mm>/<dd>/<boot>.json` (below). A Run file names its binary, its stdout and stderr and its dumps by hash, `sha256:<hex>`; each is a blob at `https://api.ledgermath.com/blobs/sha256/<hex>`, the table of contents' `evidence.blob_url_template`. The stdout blob is the binary's events, one a line ([the page](/docs/api/events)).",
		].join("\n"),
		"The prices are beside the Series: one file a day, `https://api.ledgermath.com/v1/prices/<yyyy-mm-dd>.json` ([the page](/docs/api/prices)), listed in the table of contents (`prices.files`, the newest also as `prices.newest`); a price is cited by the file's path, the SKU and the rate code ([Prices](/docs/prices)). The machines LedgerMath measures are on [Machines](/docs/machines); the words it uses, such as Run, Series, boot and Method, in the [glossary](/docs/glossary); how each Method makes its numbers, on [Methods](/docs/methods).",
		"## When a month file does not match its Series file",
		"A month file changes in place, at its address, so a Series' file and a month file fetched one after the other can be of different updates: the update may have stopped between them, or a cache may hold one of them from before the other changed. That is why each entry of a Series file's `months` gives the month file's sha256 and size. The rule a reader follows:",
		[
			"1. Compute the sha256 of the month file's bytes as fetched, and compare it with the `sha256` its Series file lists for that month (and the size with `bytes`).",
			"2. If they differ, fetch the Series file again, then the month file, and compare again.",
			"3. While they still differ, use neither, and try again later.",
		].join("\n"),
		"LedgerMath's own reader of the API does exactly this, reading the Series file and the month file up to three times in all, two seconds apart, before it gives up and says to try again in a few minutes. A copy of a month file kept from earlier is current while its sha256 is the one the Series file lists now. The table of contents gives the contract in full, with when a month file changes:",
		quote(quotes.months, "`months`, in the table of contents"),
		"The same holds, in its own way, for the table of contents, a benchmark's list, the list of every Series and a Series' file:",
		quote(quotes.listUpdates, "from `benchmarks.about`, in the table of contents"),
		"## Versioning",
		quote(quotes.versioning, "`versioning`, in the table of contents"),
		"Beside that promise, the table of contents gives `layout`, a number that rises when LedgerMath changes how the files are written. A reader holding copies of month files made under another layout fetches them again ([the table of contents](/docs/api/table-of-contents)).",
		"## The figures",
		quote(quotes.figures, "`figures`, in the table of contents"),
		"## The evidence",
		quote(quotes.evidence, "`evidence.about`, in the table of contents"),
		"**The boot summary.** A boot is one fresh machine, booted to run the schedule ([Machines](/docs/machines)). At the end of each boot, the machine writes one file, its boot summary, at `https://api.ledgermath.com/boots/<yyyy>/<mm>/<dd>/<boot>.json`: the UTC day the boot started, and the boot's id, which each of its Runs gives as `boot`. It accounts for every execution the schedule named: `runs`, each Run the boot left, with its benchmark, build, parameters and how the binary exited; `not_run`, each execution it was to run and did not, with why (it was told to stop before starting it, or the inputs of the Service the benchmark measures could not be had); `build_failures`, each build that failed, or binary that could not be started, with the message; and `left_out`, each execution of an entry of the schedule for other instance types, with the types it is for. It also names the machine as the provider gives it, the commit and source archive the boot built from, the runner, and when the boot started and ended. A point links its boot's summary (`boot_summary`, null while LedgerMath holds none), and so does each boot of the newest rounds in the table of contents (`recent_rounds.rounds[].by_boot[].boot_summary`). The boot summary has no schema yet, so it has no page of its own here.",
		"## The files",
		parts.pages,
	];
}

/** The machines page, /docs/machines: its title, and its first paragraph for a schedule of `count` instance types. */
export const MACHINES = {
	file: "docs/machines.md",
	address: "/docs/machines",
	title: "Machines",
	intro: (count: number): string =>
		`LedgerMath runs its benchmarks on ${count} EC2 instance types, each booted fresh at fixed times of day in one Availability Zone: this page lists each type with its vCPUs, its zone and the times it boots.`,
	boot: "A boot is one fresh machine. The schedule launches one at each of a type's times; it builds the benchmarks from source, runs every execution the schedule names for its type, writing a Run for each, writes its boot summary, and shuts down ([glossary](/docs/glossary); the Runs and boot summaries it leaves are described in [the data API](/docs/api/)).",
	columns: "| Instance type | vCPUs | Zone | Boots at (UTC) |",
	after:
		"vCPUs are the type's default number of vCPUs, as AWS gives it. The zone is named as the schedule names it; each Run also records the zone's ID (`availability_zone_id`, in its provider facts), and the ID, not the name, is what a Series is keyed by, beside its benchmark, parameters, build and instance type.",
	someTypesHeading: "## Benchmarks for some types only",
	someTypes: "Every entry of the schedule runs on every type above, except these, each of which names the types it runs on:",
} as const;
