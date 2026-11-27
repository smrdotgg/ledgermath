/**
 * The data API's own words name nothing a reader of the API alone cannot
 * fetch (ADR-0030, rule 5). Its first readers are agents that read the API and
 * nothing else: no repository, no README. So no word the tree publishes may
 * send them to a file of this repository, a document section, an issue, a pull
 * request, an ADR, a function of the code or a program's option.
 *
 * The tree is built as the golden test builds it (tests/api-golden.test.ts),
 * but with the docs address the workflow publishes (DEFAULT_DOCS), and every
 * string of every file is scanned, except what is data. What is prose and what
 * is data:
 *
 * - **Data** is what the Runs recorded, or what a Method derived from them for
 *   one Series or one Run: the Series' identity and params, each Run's point
 *   (its failure reasons included) and each pair's entry, the Run files no
 *   Method could read with the validator's reasons, each group's facts, the
 *   dump sections, what the requests recorded and their pooled figures, the
 *   months; and in a price file, what AWS published, verbatim (the offer
 *   file's header, products and terms), with the identifiers of where it came
 *   from and what the schedule said was measured. Its words are the Runs',
 *   AWS's, or a Method's verdict on one Run, and change only with them or a new
 *   Method version; they are listed, by place, in DATA.
 * - **Prose** is everything else a file of the tree holds: the table of
 *   contents' words, each Method's definitions and words for what it splits
 *   on, leaves out, phases and facts, each price rule's words for what it
 *   selects, and in a schema every title, description and $comment. It is the
 *   same whatever Runs the tree is cut from. A place not listed as data is
 *   scanned, so a new field is prose until it is shown to be data.
 *
 * What the scan finds is in REFERENCES (scripts/lib/published-words.ts, the
 * one set of rules for every word LedgerMath publishes); ALLOWED lists, by file, place and
 * text, the only exception, with why.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

import { API_SCHEMAS, buildApi, DEFAULT_BASE, DEFAULT_DOCS, LEFT_OUT_WHY, readApiSchemas, readBootFiles, readBootSummaries, readPriceFiles, writtenSchemaOf, type WrittenSchema } from "../scripts/lib/api";
import { isDocsAddress } from "../scripts/lib/docs-addresses";
import { RULE_SETS } from "../scripts/lib/price-rules";
import { wordRules } from "../scripts/lib/published-words";
import { makeApiFixture } from "./api-fixtures";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");

/** The kinds of file of the tree whose strings are scanned: the four the build writes, and the price files it copies. */
type Kind = WrittenSchema | "prices";

/** The kind of a file of the tree, from its path; undefined for a schema, whose words are found by keyword instead. */
function kindOf(path: string): Kind | undefined {
	return writtenSchemaOf(path) ?? (path.startsWith("v1/prices/") ? "prices" : undefined);
}

/**
 * The places in each kind of file that hold data, as JSON Pointers; `*`
 * stands for one member of any name (a Method's key, an index). Everything
 * under one of them is data.
 */
const DATA: Readonly<Record<Kind, readonly string[]>> = {
	// Each price file held: its date, its path in the Runs repository and its address; each of the newest rounds of boots: what the boot
	// summaries recorded (each boot's start and instance type, its summary's address) and counts of what they and the points hold; and each
	// summary left out of them, by its path and address. The words (about, and why each summary is left out) are scanned.
	// And each benchmark's list: the benchmark's name, as the Runs give it, its address and counts.
	index: ["/prices/newest", "/prices/files", "/recent_rounds/rounds", "/recent_rounds/left_out/summaries/*/path", "/recent_rounds/left_out/summaries/*/boot_summary", "/benchmarks/list"],
	"series-list": [
		// One row per Series: its identity and params; the rest of a row is counts, figures, links and the Methods' names.
		"/series/*/id",
		"/series/*/benchmark",
		"/series/*/params",
		"/series/*/build",
		"/series/*/instance_type",
		"/series/*/availability_zone_id",
		// Run files no Method could read: their paths, ids, sha256 and the validator's reasons.
		"/methods/*/unreadable",
		// The dump sections the Runs hold, by name, and how often each changed.
		"/methods/*/sections",
	],
	benchmark: [
		// The benchmark's name, as its Runs give it; and each row's identity and params, as in the list.
		"/benchmark",
		"/series/*/id",
		"/series/*/benchmark",
		"/series/*/params",
		"/series/*/build",
		"/series/*/instance_type",
		"/series/*/availability_zone_id",
	],
	series: [
		"/id",
		"/benchmark",
		"/params",
		"/build",
		"/instance_type",
		"/availability_zone_id",
		"/months",
		// Each group's facts, read from the Runs, and its pooled figures; its letter and its percentiles are scanned.
		"/derivations/*/groups/*/facts",
		"/derivations/*/groups/*/pool",
		"/derivations/*/sections",
		// The Region and the Service's inputs, as the Runs recorded them.
		"/derivations/*/recorded",
		// Pooled figures, broken down by the values the requests recorded.
		"/derivations/*/pool",
		// Each Run's point: what the Method derived from that Run, its reasons for not counting it included.
		"/derivations/*/newest_points",
	],
	"series-month": [
		"/id",
		"/month",
		"/benchmark",
		"/params",
		"/build",
		"/instance_type",
		"/availability_zone_id",
		"/derivations/*/points",
		// The facts and dump sections that changed between two Runs, by name.
		"/derivations/*/differed",
	],
	prices: [
		// What the schedule said was measured.
		"/measured",
		// Where each offer file came from, as AWS names it.
		"/sources/*/offer_code",
		"/sources/*/url",
		"/sources/*/version",
		"/sources/*/publication_date",
		"/sources/*/sha256",
		// AWS's words, verbatim: the offer file's header, the products selected and their terms.
		"/sources/*/header",
		"/sources/*/products",
		"/sources/*/terms",
		// The SKUs each rule selected, as AWS names them.
		"/sources/*/selections/*/skus",
	],
};

/** The words of a schema, by keyword: what JSON Schema gives people to read. */
const SCHEMA_WORDS = new Set(["title", "description", "$comment"]);

/** Each kind of reference a reader of the API cannot follow, with a pattern that finds it, for this checkout's top-level directories and files. */
const { references: REFERENCES, otherSchemas, referencesIn } = wordRules(ROOT);

/**
 * The only words the tree publishes that point outside the tree (to the
 * repository, a document or a section of one), each with why it stays. Every
 * entry must still be found: one that is not fails the test, so the list never
 * outlives its reason. None is left: the docs' address, the README's section on
 * GitHub until the documentation had pages of its own, is now its reference to
 * the API on the site (DEFAULT_DOCS, ADR-0037), which names nothing of the
 * repository.
 */
const ALLOWED: ReadonlyArray<{ file: string; pointer: string; text: string; why: string }> = [];

interface Finding {
	file: string;
	pointer: string;
	kind: string;
	text: string;
}

const pointerOf = (segments: readonly string[]): string => segments.map((segment) => `/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

function isData(kind: Kind, segments: readonly string[]): boolean {
	return DATA[kind].some((place) => {
		const parts = place.split("/").slice(1);
		return parts.length <= segments.length && parts.every((part, i) => part === "*" || part === segments[i]);
	});
}

/** Every string a file holds, with its place, that is prose. */
function proseOf(path: string, value: unknown): Array<{ pointer: string; text: string }> {
	const out: Array<{ pointer: string; text: string }> = [];
	const kind = kindOf(path);
	const isSchema = path.startsWith("v1/schemas/");
	const walk = (node: unknown, segments: string[]): void => {
		if (kind !== undefined && isData(kind, segments)) return;
		if (typeof node === "string") {
			if (!isSchema || SCHEMA_WORDS.has(segments[segments.length - 1] as string)) out.push({ pointer: pointerOf(segments), text: node });
			return;
		}
		if (Array.isArray(node)) node.forEach((item, i) => walk(item, [...segments, String(i)]));
		else if (typeof node === "object" && node !== null) for (const [key, item] of Object.entries(node)) walk(item, [...segments, key]);
	};
	walk(value, []);
	return out;
}

/** Every reference the prose of a tree makes that a reader of the API cannot follow, and the prose scanned. */
function scanWords(tree: ReadonlyMap<string, Uint8Array>): { findings: Finding[]; scanned: Map<string, Set<string>> } {
	const findings: Finding[] = [];
	const scanned = new Map<string, Set<string>>();
	for (const [path, bytes] of tree) {
		const places = new Set<string>();
		scanned.set(path, places);
		for (const { pointer, text } of proseOf(path, JSON.parse(new TextDecoder().decode(bytes)))) {
			places.add(pointer);
			for (const found of referencesIn(text)) findings.push({ file: path, pointer, ...found });
		}
	}
	return { findings, scanned };
}

const describeFinding = (finding: Finding): string => `${finding.file} ${finding.pointer}: ${finding.kind}, ${JSON.stringify(finding.text)}`;

let tree: Map<string, Uint8Array>;

beforeAll(async () => {
	const fixture = await makeApiFixture({ small: true });
	tree = buildApi({
		base: DEFAULT_BASE,
		docs: DEFAULT_DOCS,
		series: fixture.series,
		requests: fixture.requests,
		prices: readPriceFiles(fixture.runs),
		boots: readBootSummaries(fixture.runs),
		bootFiles: readBootFiles(fixture.runs),
		schemas: readApiSchemas(),
	});
});

describe("the words the data API publishes", () => {
	test("give the docs' address as the documentation's reference to the API, on the site", () => {
		expect(DEFAULT_DOCS).toBe("https://ledgermath.com/docs/api/");
		expect(isDocsAddress(new URL(DEFAULT_DOCS).pathname)).toBe(true);
		expect(JSON.parse(new TextDecoder().decode(tree.get("v1/index.json"))).docs).toBe(DEFAULT_DOCS);
	});

	test("name no file, document, issue, pull request, ADR, function or option a reader of the API alone cannot fetch", () => {
		const { findings } = scanWords(tree);
		const allowed = (finding: Finding) => ALLOWED.find((entry) => entry.file === finding.file && entry.pointer === finding.pointer && finding.text.length > 0 && entry.text.includes(finding.text));
		const unexplained = findings.filter((finding) => allowed(finding) === undefined);
		expect(unexplained.map(describeFinding)).toEqual([]);
		// Every exception is still needed.
		for (const entry of ALLOWED) expect([entry.file, entry.pointer, findings.some((finding) => allowed(finding) === entry)]).toEqual([entry.file, entry.pointer, true]);
	});

	test("include each price rule's words for what it selects, as the next price file will carry them", () => {
		const rules = [...RULE_SETS.values()].flatMap((set) => set.rules);
		expect(rules.length).toBeGreaterThan(0);
		for (const rule of rules) expect([rule.name, referencesIn(rule.selects)]).toEqual([rule.name, []]);
	});

	test("are scanned where they are: the table of contents, both Methods' words, the price rules' words and every schema's descriptions", () => {
		const { scanned } = scanWords(tree);
		const at = (file: string): Set<string> => scanned.get(file) ?? new Set();
		for (const pointer of ["/about", "/versioning", "/figures", "/months", "/recent_rounds/about", "/recent_rounds/left_out/summaries/0/why", "/series/about", "/benchmarks/about", "/evidence/about", "/schemas/0/describes"]) {
			expect([pointer, at("v1/index.json").has(pointer)]).toEqual([pointer, true]);
		}
		// Each benchmark's name and entry are data, not scanned; nor is a benchmark's list's name or rows.
		expect([...at("v1/index.json")].filter((pointer) => pointer.startsWith("/benchmarks/list"))).toEqual([]);
		const benchmarkLists = [...scanned.keys()].filter((path) => writtenSchemaOf(path) === "benchmark");
		expect(benchmarkLists.length).toBeGreaterThan(0);
		for (const path of benchmarkLists) expect([path, [...at(path)].filter((pointer) => pointer === "/benchmark" || /^\/series\/\d+\/(?:id|benchmark|params|build)/.test(pointer))]).toEqual([path, []]);
		// Every sentence a summary can be left out for is held to the same scan, not only the one the fixture shows.
		for (const [kind, why] of Object.entries(LEFT_OUT_WHY)) expect([kind, referencesIn(why)]).toEqual([kind, []]);
		// A round's instance types and its boots' addresses are data, not scanned.
		expect([...at("v1/index.json")].filter((pointer) => pointer.startsWith("/recent_rounds/rounds"))).toEqual([]);
		for (const pointer of [
			"/methods/series_v1/definitions/counted",
			"/methods/series_v1/split_on/1/what",
			"/methods/series_v1/left_out/0/why",
			"/methods/series_v1/not_split_on/0/what",
			"/methods/requests_v1/definitions/counted",
			"/methods/requests_v1/phases/0/interval",
			"/methods/requests_v1/request_facts/0/what",
			"/methods/requests_v1/histogram/definition",
		]) {
			expect([pointer, at("v1/series.json").has(pointer)]).toEqual([pointer, true]);
		}
		const seriesFiles = [...scanned.keys()].filter((path) => writtenSchemaOf(path) === "series");
		expect(seriesFiles.length).toBeGreaterThan(0);
		for (const path of seriesFiles) expect([path, at(path).has("/derivations/series_v1/definitions/counted")]).toEqual([path, true]);
		for (const { name } of API_SCHEMAS) expect([name, at(`v1/schemas/${name}.schema.json`).has("/description")]).toEqual([name, true]);
		const prices = [...scanned.keys()].filter((path) => path.startsWith("v1/prices/"));
		expect(prices.length).toBeGreaterThan(0);
		for (const path of prices) expect([path, at(path).has("/sources/0/selections/0/selects")]).toEqual([path, true]);
		// What is data is not scanned: a point, a Run file no Method could read, a row's identity, AWS's products and terms.
		const month = [...scanned.keys()].find((path) => writtenSchemaOf(path) === "series-month") as string;
		expect([...at(month)].some((pointer) => pointer.startsWith("/derivations/series_v1/points"))).toBe(false);
		expect([...at("v1/series.json")].some((pointer) => pointer.includes("/unreadable") || /^\/series\/\d+\/(?:id|benchmark|params|build)/.test(pointer))).toBe(false);
		for (const path of prices) expect([...at(path)].filter((pointer) => /^\/sources\/\d+\/(?:header|products|terms)\//.test(pointer))).toEqual([]);
	});

	test("are told apart from data: a reference planted in prose is found, one in a point's failure or AWS's words is not", () => {
		const encoder = new TextEncoder();
		const planted = new Map(tree);
		const edit = (path: string, change: (value: any) => void): void => {
			const value = JSON.parse(new TextDecoder().decode(planted.get(path)));
			change(value);
			planted.set(path, encoder.encode(JSON.stringify(value)));
		};
		const month = [...tree.keys()].find((path) => writtenSchemaOf(path) === "series-month") as string;
		edit("v1/series.json", (value) => {
			value.methods.series_v1.definitions.series += " See methods/README.md.";
		});
		edit(month, (value) => {
			value.derivations.series_v1.points[0].failure = "event 3 does not match schemas/events.schema.json";
		});
		edit("v1/schemas/series.schema.json", (value) => {
			value.properties.months.description += " (ADR-0031, item 8)";
		});
		edit("v1/index.json", (value) => {
			value.about += " See ./schedule.json.";
			value.recent_rounds.about += " As infra/runs/schedule.ts says.";
			value.recent_rounds.rounds[0].instance_types[0] = "runner/box.sh";
		});
		// A field a row of the list does not have today is prose until it is shown to be data; the row's identity is data.
		edit("v1/series.json", (value) => {
			value.series[0].note = "See scripts/check-events.py.";
			value.series[0].benchmark = "scripts/check-events.py";
		});
		const price = [...tree.keys()].find((path) => path.startsWith("v1/prices/")) as string;
		edit(price, (value) => {
			value.sources[0].selections[0].selects += " As docs/prices.md says.";
			const [sku] = Object.keys(value.sources[0].products);
			value.sources[0].products[sku as string].attributes.note = "See scripts/fetch-prices.ts.";
		});
		const found = scanWords(planted).findings.filter((finding) => ALLOWED.every((entry) => entry.pointer !== finding.pointer));
		expect(found.map(describeFinding).sort()).toEqual(
			[
				`v1/series.json /methods/series_v1/definitions/series: a path in the repository, "methods/"`,
				`v1/series.json /methods/series_v1/definitions/series: a source or document file, "methods/README.md"`,
				`v1/series.json /methods/series_v1/definitions/series: a README, "README"`,
				`v1/series.json /series/0/note: a path in the repository, "scripts/"`,
				`v1/series.json /series/0/note: a source or document file, "scripts/check-events.py"`,
				`v1/schemas/series.schema.json /properties/months/description: an ADR, "ADR-0031"`,
				`v1/index.json /about: a relative path to a file of the repository, "./schedule.json"`,
				`v1/index.json /recent_rounds/about: a path in the repository, "infra/"`,
				`v1/index.json /recent_rounds/about: a source or document file, "infra/runs/schedule.ts"`,
				`${price} /sources/0/selections/0/selects: a path in the repository, "docs/"`,
				`${price} /sources/0/selections/0/selects: a source or document file, "docs/prices.md"`,
			].sort(),
		);
	});

	test("each kind of reference is found, and the tree's own addresses are not", () => {
		const kinds = (text: string): string[] => [...REFERENCES.filter(({ pattern }) => [...text.matchAll(pattern)].length > 0).map(({ kind }) => kind), ...otherSchemas(text).map(() => "a schema the tree does not serve")];
		const cases: Array<[string, string[]]> = [
			["every order rule scripts/check-events.py checks", ["a path in the repository", "a source or document file"]],
			["runner: the manifest of runner/ that launched the binary", ["a path in the repository"]],
			["as the binary's README says", ["a README"]],
			["The contract in prose is docs/dev-log.md section 2.", ["a path in the repository", "a source or document file", "a numbered section of a document", "the dev log"]],
			["as ADR-0031 records", ["an ADR"]],
			["decided on #64", ["an issue or pull request"]],
			["merged in pull request 72", ["an issue or pull request"]],
			["held to it by recoverable()", ["a function of the code"]],
			["not a --quick stream", ["a program's command-line option"]],
			["see https://github.com/smrdotgg/ledgermath", ["the repository on GitHub"]],
			["checked against schedule.json", ["a file at the repository's root"]],
			["See ./schedule.json.", ["a relative path to a file of the repository"]],
			["as ../docs/dev-log.md says", ["a relative path to a file of the repository", "a source or document file", "the dev log"]],
			["the files of /runner/", ["a relative path to a file of the repository"]],
			["matches run.schema.json", ["a schema the tree does not serve"]],
			// The tree's own addresses and words.
			["For a given layout (the layout of v1/index.json), a month file's bytes change", []],
			["each point links its Run file (evidence), at runs/<yyyy>/<mm>/<dd>/<id>.json", []],
			["https://api.ledgermath.com/v1/schemas/series-month.schema.json", []],
			["follows its own schema, ledgermath.prices/1, as v1/schemas/prices.schema.json gives it", []],
			["changes on every read (each block device's I/O counters, /sys/block/*/stat)", []],
			["the 5th, 50th and 95th percentiles, by linear interpolation between closest ranks (R type 7)", []],
			["dump section cpuid: the raw cpuid leaves of every CPU", []],
			["c6i.8xlarge, i4i.2xlarge and m5.large", []],
		];
		for (const [text, expected] of cases) expect([text, kinds(text)]).toEqual([text, expected]);
	});
});
