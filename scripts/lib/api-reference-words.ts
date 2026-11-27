/**
 * The hand-written words of the API reference (scripts/lib/api-reference.ts): each file page's
 * title, its first paragraph and where its file is, the overview at /docs/api/ and the opening
 * of the machines page. Everything a field means is the schema's, copied by the generator; the
 * API's contract paragraphs are quoted from their one source, the constants of scripts/lib/api.ts,
 * by the generator, at the places marked below. These words are Markdown as written: a path in
 * them is in a code span, so nothing in it needs escaping.
 *
 * Every sentence here is read, and acted on, by agents: each says only what holds always, or
 * gives its exception. Where these words cover the same ground as the glossary
 * (site/content/docs/glossary.md: a boot and what it leaves, a benchmark's list and what it may
 * leave out, a Series' id), they say what it says.
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
	/** What the fields below leave out on purpose, said at the head of the fields: members a schema leaves open. */
	fieldsNote?: string;
}

/** A benchmark's list, and what it may leave out, as the glossary says it. */
const NO_LIST =
	"a benchmark whose name is not 1 to 64 characters, a lower-case letter, then lower-case letters, digits and underscores, has no list";

export const FILE_PAGES: readonly FilePage[] = [
	{
		file: "docs/api/table-of-contents.md",
		address: "/docs/api/table-of-contents",
		schema: "schemas/api/v1/index.schema.json",
		sample: "index",
		title: "The table of contents",
		intro:
			"`v1/index.json` is where a reader of LedgerMath's data API starts. It gives the API's rules in words; the addresses of the list of every Series, of the price files and of the schemas; benchmarks' lists of Series with their counts, as many as fit its budget; templates for the address of a benchmark's list, of a Series file and of a blob; and the newest rounds of boots.",
		where: [
			"Address: [https://api.ledgermath.com/v1/index.json](https://api.ledgermath.com/v1/index.json), the one address a reader needs to know.",
			"Reached from: the list of every Series, each benchmark's list, each Series file and each month file name it (`index`).",
			"Links to: the list of every Series (`series.url`); the benchmarks' lists it names (`benchmarks.list[].url`), as many as fit its budget, `benchmarks.unlisted` saying how many lists it does not name; the list of any benchmark that has one, by the benchmark's name (`benchmarks.benchmark_file_url_template`); any Series' file, by the Series' id (`series.series_file_url_template`); the price files (`prices.files[].url`, the newest also at `prices.newest.url`); the schemas (`schemas[].url`, and the `schema_url` of each kind); the summaries of the first 12 boots of each of the newest rounds (`recent_rounds.rounds[].by_boot[].boot_summary`; a round's figures count all its boots), and of the newest 8 boot summaries left out of every round, when the API serves them (`recent_rounds.left_out.summaries[].boot_summary`); and any blob, by its hash (`evidence.blob_url_template`).",
			"Changes: with the data; no promise covers its bytes.",
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
			"`v1/series.json` lists every Series, one row each with what the Series is, its counts, a summary of each Method's figures and the address of its own file, and gives each Method's own words for how its numbers are made, with the Run files the Method could not read.",
		where: [
			"Address: [https://api.ledgermath.com/v1/series.json](https://api.ledgermath.com/v1/series.json).",
			"Reached from: the table of contents (`series.url`).",
			"Links to: each Series' file (`series[].url`); the table of contents (`index`); its schema (`schema_url`); each Run file a Method could not read (`methods.series_v1.unreadable[].evidence`, `methods.requests_v1.unreadable[].evidence`).",
			`A benchmark's rows are also in its own, smaller file, [a benchmark's list of Series](/docs/api/benchmark-list), the same byte for byte when both files are of one update. A benchmark's list may leave rows out, and says how many (\`left_out\`), and ${NO_LIST}: this file is the complete list.`,
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
			"`v1/benchmarks/<benchmark>.json` holds one benchmark's rows of the list of every Series, the same byte for byte when both files are of one update, so that a reader can find the benchmark's Series and their figures without fetching the whole list; it may leave rows out, and says how many (`left_out`).",
		where: [
			`Address: \`https://api.ledgermath.com/v1/benchmarks/<benchmark>.json\`, with the benchmark's name; ${NO_LIST}.`,
			"Reached from: the table of contents (`benchmarks.list[].url`, for the benchmarks it names, as many as fit its budget), or its template `benchmarks.benchmark_file_url_template` with the benchmark's name, which every row and every Series' file gives (`benchmark`).",
			"Links to: each listed Series' file (`series[].url`); the table of contents (`index`); its schema (`schema_url`).",
			"A Series the list leaves out is in [the list of every Series](/docs/api/series-list), `v1/series.json`, the complete list.",
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
			"`v1/series/<id>.json` holds one Series: what it is, each Method's summary figures and definitions, the points of its newest Runs, and the list of its month files, each with the file's sha256 and size.",
		where: [
			"Address: `https://api.ledgermath.com/v1/series/<id>.json`, with the Series' id, 12 lower-case hex digits.",
			"Reached from: a row's `url`, in the list of every Series or a benchmark's list; or the table of contents' template `series.series_file_url_template` with the Series' id.",
			"Links to: each of its month files (`months[].url`); the table of contents (`index`); its schema (`schema_url`); and, for each of its newest points, its Run file (`evidence`) and its boot's summary (`boot_summary`, null when LedgerMath holds none).",
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
			"`v1/series/<id>/<yyyy-mm>.json` holds every point of the Runs of one Series that started in one month (UTC), each with its Run file's sha256 and address, and its boot summary's address when LedgerMath holds one; and Method `series` v1's entries of what differed between consecutive Runs.",
		where: [
			"Address: `https://api.ledgermath.com/v1/series/<id>/<yyyy-mm>.json`, with the Series' id and the month.",
			"Reached from: its Series' file (`months[].url`), which also gives the month file's `sha256` and size in `bytes`: a reader checks the file it fetched against them ([what to do when they differ](/docs/api/)).",
			"Links to: its Series' file (`series_url`); the table of contents (`index`); its schema (`schema_url`); each point's Run file (`evidence`) and its boot's summary (`boot_summary`, null when LedgerMath holds none).",
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
			"`v1/prices/<yyyy-mm-dd>.json` is one day's copy of AWS's public On-Demand prices for what LedgerMath measures: the records a versioned rule set selected from AWS's price lists, kept verbatim, added once and never edited.",
		where: [
			"Address: `https://api.ledgermath.com/v1/prices/<yyyy-mm-dd>.json`, with the UTC date its fetch started; at most one for each day.",
			"Reached from: the table of contents (`prices.files[].url`; the newest, `prices.newest.url`).",
			"Links to: the versioned price list files of AWS it was cut from (`sources[].url`).",
			"A price is cited by the file's path, as the table of contents gives it (`prices.files[].path`), the SKU and the rate code: see [Prices](/docs/prices).",
		],
		v1: false,
		fieldsNote:
			"The file and LedgerMath's own objects in it hold no member but those listed. AWS's objects (a source's `header`, each product, each term and its `termAttributes`, and each price dimension) are copied as AWS gives them, and may hold members this page does not list.",
	},
	{
		file: "docs/api/run.md",
		address: "/docs/api/run",
		schema: "schemas/run.schema.json",
		sample: "run",
		title: "A Run file",
		intro:
			"A Run file records one execution of one benchmark binary, with one parameter set, on one box, whether it succeeded or failed: the evidence each Method's figures rest on.",
		where: [
			"Address: `https://api.ledgermath.com/runs/<yyyy>/<mm>/<dd>/<id>.json`, with the UTC day the Run started and the Run's id.",
			"Reached from: each point's `evidence`, in a month file or among a Series file's newest points; and, for a Run file no Method could read, `methods.<method>_v<version>.unreadable[].evidence` in the list of every Series.",
			"Links to: each blob it names by hash, `sha256:<hex>` (its binary, its source archive, its runner, its resolved compiler flags, its stdout, its stderr and its dumps), at the table of contents' `evidence.blob_url_template` with `{hex}` replaced by the 64 hex digits.",
			"Not a file of version 1: a Run file is evidence, written once, on the box that ran the binary, and never edited.",
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
		fieldsNote:
			"A benchmark may also print events of its own, under any name but the six below, with members this page does not list; and the keys of an `observed` event's `values` are the benchmark's own. The benchmark's page documents both: for example [http_get](/docs/benchmarks/http_get).",
	},
];

/** The overview, /docs/api/: its title and first paragraph. */
export const OVERVIEW = {
	file: "docs/api/index.md",
	address: "/docs/api/",
	title: "The data API",
	intro:
		"LedgerMath's data API, at `https://api.ledgermath.com`, is a tree of static JSON files: the table of contents, the list of every Series, the benchmarks' lists, a file per Series and per month of it, and the price files, at most one a day, each kind with a JSON schema, which a reader reaches by following links from the table of contents; and, linked from them, the evidence behind the numbers: Run files, boot summaries and blobs.",
} as const;

/** The boot, as the glossary says it. */
const BOOT =
	"A boot is one fresh launch of an EC2 instance of one instance type. The box builds the benchmarks it is to run and runs each execution LedgerMath's schedule names for its instance type, then shuts down, which terminates the instance. An execution that ran to its end leaves a Run, whatever its binary did, unless writing the Run failed (a full disk, say), which stops the boot with that error. An execution that never started has no Run: its build failed, its binary could not be started, its Service's inputs could not be had, or the boot was told to stop, stopped on an error or was cut off before it. A boot cut off may leave neither a Run for the execution in flight nor a boot summary, and nothing leaves the machine until the end of the boot, so a machine lost before then leaves no Run at all.";

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
		"There is no server: every file is a static file. LedgerMath is scheduled to update the files several times a day. An update changes the bytes only of the files whose data changed, unless LedgerMath changed how the files are written (`layout`, below); a Run file, a boot summary, a blob and a price file are each written once and never changed. Every address a reader needs is written in the files: a reader never builds one from an id, but for three templates the table of contents gives, the address of a blob from its hash, of a Series' file from its id, and of a benchmark's list from the benchmark's name.",
		"## How a reader walks it",
		[
			"1. **The table of contents**, [https://api.ledgermath.com/v1/index.json](https://api.ledgermath.com/v1/index.json) ([the page](/docs/api/table-of-contents)). It links the list of every Series (`series.url`), the price files (`prices`) and the schemas (`schemas`); it names benchmarks' lists with their counts, as many as fit its budget (`benchmarks.list`; `benchmarks.unlisted` counts the lists it does not name); and it gives the newest rounds of boots (`recent_rounds`).",
			`2. **A benchmark's list**, \`https://api.ledgermath.com/v1/benchmarks/<benchmark>.json\` ([the page](/docs/api/benchmark-list)), at the address \`benchmarks.list[].url\` gives, or at \`benchmarks.benchmark_file_url_template\` with the benchmark's name. One row per Series it lists: its parameters, build, instance type and zone ID, its counts, a summary of each Method's figures, and the address of the Series' file (\`url\`). A list may leave rows out, and says how many (\`left_out\`), and ${NO_LIST}; [the list of every Series](/docs/api/series-list), \`https://api.ledgermath.com/v1/series.json\`, is the complete list.`,
			"3. **A Series' file**, `https://api.ledgermath.com/v1/series/<id>.json` ([the page](/docs/api/series)), at its row's `url`, or at `series.series_file_url_template` with the Series' id. Each Method's summary figures and definitions, its groups, the points of its newest Runs, and `months`: each month a Run of the Series started in, with the month file's address, sha256 and size.",
			"4. **A month file**, `https://api.ledgermath.com/v1/series/<id>/<yyyy-mm>.json` ([the page](/docs/api/series-month)), at `months[].url`. Every point of the Runs that started that month. Check its sha256 against the one `months` lists before using it (below).",
			"5. **The evidence.** Each point links its Run file (`evidence`), `https://api.ledgermath.com/runs/<yyyy>/<mm>/<dd>/<id>.json` ([the page](/docs/api/run)), and its boot's summary (`boot_summary`), `https://api.ledgermath.com/boots/<yyyy>/<mm>/<dd>/<boot>.json` (below), which is null when LedgerMath holds no summary of the boot. A Run file names by hash, `sha256:<hex>`, its binary, its source archive, its runner, its resolved compiler flags, its stdout, its stderr and its dumps; each is a blob at `https://api.ledgermath.com/blobs/sha256/<hex>`, the table of contents' `evidence.blob_url_template`. The stdout blob is what the binary printed, each line meant to be one event ([the page](/docs/api/events)).",
		].join("\n"),
		"The prices are beside the Series: at most one file a day, `https://api.ledgermath.com/v1/prices/<yyyy-mm-dd>.json` ([the page](/docs/api/prices)), listed in the table of contents (`prices.files`, the newest also as `prices.newest`); a price is cited by the file's path, the SKU and the rate code ([Prices](/docs/prices)). The machines LedgerMath measures are on [Machines](/docs/machines); the words it uses, such as Run, Series, boot and Method, in the [glossary](/docs/glossary); how each Method makes its numbers, on [Methods](/docs/methods).",
		"## When a month file does not match its Series file",
		"A month file changes in place, at its address, so a Series' file and a month file fetched one after the other can be of different updates: the update may have stopped between them, or a cache may hold one of them from before the other changed. That is why each entry of a Series file's `months` gives the month file's sha256 and size. The rule a reader follows:",
		[
			"1. Compute the sha256 of the month file's bytes as fetched, and compare it with the `sha256` its Series file lists for that month (and the size with `bytes`).",
			"2. If they differ, fetch the Series file again, then the month file, and compare again.",
			"3. While they still differ, use neither, and try again later.",
		].join("\n"),
		"LedgerMath's own lookup tool follows it at a web address: it reads the Series file and the month file up to three times in all, two seconds apart, and while they still differ uses neither and says to try again in a few minutes. A copy of a month file kept from earlier is current while its sha256 is the one the Series file lists now. The table of contents gives the contract in full, with when a month file changes:",
		quote(quotes.months, "`months`, in the table of contents"),
		"The table of contents, a benchmark's list, the list of every Series and a Series' file can be of different updates too, and the table of contents says what a reader does then:",
		quote(quotes.listUpdates, "from `benchmarks.about`, in the table of contents"),
		"## Versioning",
		quote(quotes.versioning, "`versioning`, in the table of contents"),
		"Beside that promise, the table of contents gives `layout`, a number that rises when LedgerMath changes how the files are written. A reader holding copies of month files made under another layout fetches them again ([the table of contents](/docs/api/table-of-contents)).",
		"## The figures",
		quote(quotes.figures, "`figures`, in the table of contents"),
		"## The evidence",
		quote(quotes.evidence, "`evidence.about`, in the table of contents"),
		`**The boot summary.** ${BOOT} The boot summary is the file a boot writes as it ends, at \`https://api.ledgermath.com/boots/<yyyy>/<mm>/<dd>/<boot>.json\`, dated by the boot's start (UTC) and named by the boot's id, the kernel's boot id, which each Run of the boot gives as \`boot\` (\`unknown\` when the box could not read it). It names the instance, the source commit and the runner, and lists every Run the boot made with how its binary exited (\`runs\`), every build that failed or binary that could not be started (\`build_failures\`), every execution that was not run with why (\`not_run\`), and every execution left out because it runs on other instance types (\`left_out\`). A build that failed is listed once, for its benchmark and build, not for each of the executions it would have run. A boot that stopped on an unexpected error writes its summary with that error (\`error\`), listing only what it reached. A point links its boot's summary as \`boot_summary\`, null when none is held, and the table of contents links the summaries of the first 12 boots of each of its newest rounds. The boot summary has no schema yet, so it has no page of its own here.`,
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
		`LedgerMath's schedule runs its benchmarks on ${count} EC2 instance types, each booted fresh at fixed times of day in one Availability Zone: this page lists each type with its vCPUs, its zone and the times the schedule boots it. A boot started by hand may be at another time, or of another type.`,
	boot: `${BOOT} See the [glossary](/docs/glossary); the Runs and boot summaries a boot leaves are described in [the data API](/docs/api/).`,
	columns: "| Instance type | vCPUs | Zone | Scheduled boots (UTC) |",
	after:
		"vCPUs is the type's default number of vCPUs, as the schedule declares it. The zone is named as the schedule names it. A Series is keyed by the zone's ID, not its name; a Run records both, as the box reads them from the instance metadata service (`provider.availability_zone_id`, `provider.availability_zone`).",
	someTypesHeading: "## Benchmarks for some types only",
	someTypes: "Every entry of the schedule is for every type above, except these, each of which names the types it is for:",
} as const;
