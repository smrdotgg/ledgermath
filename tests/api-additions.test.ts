/**
 * Nothing that can be added to the Runs data stops a publish or changes what
 * is already published. The Runs repository only ever gains files, and every
 * update reads all of it again, so a file added once is read by every later
 * update: if it could stop the build or the check, or change a published
 * link, it would do so for good.
 *
 * From the rounds fixture (tests/rounds-fixture.ts) and the tree built from
 * it, each awkward thing below is added to a copy of the checkout, alone and
 * in pairs, and after each the test asserts what a publish needs:
 *
 * - the build makes the tree, and the check passes it against the checkout;
 * - the gate against the tree from before the addition passes, comparing
 *   every month file strictly, with no new baseline;
 * - every link of a point that was not null before is the same, evidence and
 *   boot_summary alike, and every boot summary address the tree gives is of
 *   a shape the API serves;
 * - the table of contents is under its ceiling.
 *
 * It imports only what the data API's code has exported since the rounds
 * were added, so it can be run against an earlier commit to show what that
 * commit let through. The one addition that does change a link, a second
 * summary of a boot at its own path claiming an earlier start, cannot be told
 * from the first without the files' history: tests/api-rounds.test.ts shows
 * that it is listed as left out and that the gate refuses it, out loud.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { isServedKey } from "../infra/runs/public-blobs";
import type { Run } from "../methods/run";
import { buildApi, DEFAULT_BASE, INDEX_PATH, readApiSchemas, readBootFiles, readBootSummaries, readPriceFiles } from "../scripts/lib/api";
import { CEILINGS, checkApi, checkStability } from "../scripts/lib/api-check";
import { bootSummaryPath, bootSummaryText, type HandMadeBoot } from "./hand-made-runs";
import { idOf, makeRoundsFixture, NOT_A_UUID, type RoundsFixture } from "./rounds-fixture";

setDefaultTimeout(600_000);

type Json = Record<string, any>;

let fixture: RoundsFixture;
let before: string;
/** Each point's links in the tree from before any addition, by its Run id and Method. */
let links: Map<string, { evidence: string; boot_summary: string | null }>;

/** Every file under a directory, by its path from it. */
function filesUnder(directory: string): string[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

function build(runs: string): string {
	const tree = buildApi({
		base: DEFAULT_BASE,
		docs: "https://example.test/docs",
		series: structuredClone(fixture.series),
		requests: structuredClone(fixture.requests),
		prices: readPriceFiles(runs),
		boots: readBootSummaries(runs),
		bootFiles: readBootFiles(runs),
		schemas: readApiSchemas(),
	});
	const directory = mkdtempSync(join(tmpdir(), "api-additions-tree-"));
	for (const [path, bytes] of tree) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), bytes);
	}
	return directory;
}

/** Every point's links in a tree, by Run id and Method, from its month files. */
function pointLinks(tree: string): Map<string, { evidence: string; boot_summary: string | null }> {
	const out = new Map<string, { evidence: string; boot_summary: string | null }>();
	for (const path of filesUnder(join(tree, "v1", "series")).filter((name) => name.includes("/"))) {
		const month = JSON.parse(readFileSync(join(tree, "v1", "series", path), "utf8"));
		for (const [key, block] of Object.entries(month.derivations as Record<string, Json>)) {
			for (const point of block.points as Json[]) out.set(`${key} ${point.run}`, { evidence: point.evidence, boot_summary: point.boot_summary });
		}
	}
	return out;
}

/** Every boot_summary address a tree gives, wherever it is. */
function bootSummaryAddresses(tree: string): string[] {
	const found: string[] = [];
	const walk = (node: unknown, key: string): void => {
		if (typeof node === "string" && key === "boot_summary") found.push(node);
		else if (Array.isArray(node)) for (const item of node) walk(item, key);
		else if (typeof node === "object" && node !== null) for (const [name, value] of Object.entries(node)) walk(value, name);
	};
	for (const path of filesUnder(tree).filter((name) => name.endsWith(".json") && !name.startsWith("v1/schemas/"))) walk(JSON.parse(readFileSync(join(tree, path), "utf8")), "");
	return found;
}

const put = (runs: string, path: string, text: string): void => {
	mkdirSync(dirname(join(runs, path)), { recursive: true });
	writeFileSync(join(runs, path), text);
};
/** A file whose name is these bytes, whatever text they decode to, in a directory of the checkout. */
const putRaw = (runs: string, directory: string, name: number[], text: string): void => {
	mkdirSync(join(runs, directory), { recursive: true });
	writeFileSync(Buffer.concat([Buffer.from(`${join(runs, directory)}/`), Buffer.from(name)]), text);
};
/** A boot that left no Run, as a box writes its summary, named after `name`, started at `startedAt`, with `change` made to it. */
const newBoot = (name: string, startedAt: string, change: (summary: Json) => void = () => {}): { path: string; text: string } => {
	const made: HandMadeBoot = { boot: idOf(name), startedAt, runs: [] };
	const summary = JSON.parse(bootSummaryText(made));
	change(summary);
	return { path: bootSummaryPath(made), text: JSON.stringify(summary) };
};
const day = "2026-11-25T04:11:00.000000000Z";
const hand = (): HandMadeBoot => fixture.boots["hand-m5"] as HandMadeBoot;
const run = (id: string): Run => ({ id, benchmark: "syscall", params: {}, binary: { build: "static" }, exit: { code: 0 } }) as unknown as Run;

/** Each awkward thing that can be added to the Runs data, by what it is. */
const ADDITIONS: Record<string, (runs: string) => void> = {
	"a copy of a summary at an earlier path": (runs) => {
		mkdirSync(join(runs, "boots/2025/06/01"), { recursive: true });
		copyFileSync(join(runs, bootSummaryPath(hand())), join(runs, `boots/2025/06/01/${hand().boot}.json`));
	},
	"a copy of a summary at a later path": (runs) => {
		mkdirSync(join(runs, "boots/2027/01/01"), { recursive: true });
		copyFileSync(join(runs, bootSummaryPath(hand())), join(runs, `boots/2027/01/01/${hand().boot}.json`));
	},
	"a second summary of a boot, of other contents, not at its own path": (runs) => put(runs, `boots/2026/11/22/${hand().boot}.json`, bootSummaryText({ ...hand(), instanceType: "m5.xlarge" })),
	"a second summary of a boot at its own path, started later": (runs) => put(runs, `boots/2026/11/22/${hand().boot}.json`, bootSummaryText({ ...hand(), startedAt: "2026-11-22T13:44:05.000000000Z" })),
	"two summaries of a new boot, of the same contents": (runs) => {
		const one = newBoot("twin", day);
		put(runs, one.path, one.text);
		put(runs, one.path.replace("/25/", "/26/"), one.text);
	},
	"two summaries of a new boot, of other contents, each at its own path": (runs) => {
		const one = newBoot("pair", day);
		put(runs, one.path, one.text);
		const other = newBoot("pair", "2026-11-26T04:11:00.000000000Z");
		put(runs, other.path, other.text);
	},
	"a symbolic link to a summary": (runs) => symlinkSync(`${hand().boot}.json`, join(runs, `boots/2026/11/20/${idOf("link-to-summary")}.json`)),
	"a symbolic link to a directory": (runs) => symlinkSync("../21", join(runs, `boots/2026/11/20/${idOf("link-to-directory")}.json`)),
	"a symbolic link to nothing": (runs) => symlinkSync("nowhere.json", join(runs, `boots/2026/11/20/${idOf("link-to-nothing")}.json`)),
	"a directory named like a summary": (runs) => put(runs, `boots/2026/11/25/${idOf("directory")}.json/inside.json`, newBoot("inside", day).text),
	"an empty file": (runs) => put(runs, newBoot("empty", day).path, ""),
	"a file that is not JSON": (runs) => put(runs, newBoot("brace", day).path, "{"),
	"a file of four million spaces and a brace": (runs) => put(runs, newBoot("spaces", day).path, `${" ".repeat(4_000_000)}{`),
	...Object.fromEntries(
		["schema", "boot", "started_at", "provider", "runs", "build_failures", "not_run"].flatMap((field) => [
			[
				`a summary without ${field}`,
				(runs: string) => {
					const one = newBoot(`no-${field}`, day, (summary) => delete summary[field]);
					put(runs, one.path, one.text);
				},
			],
			[
				`a summary whose ${field} is of the wrong type`,
				(runs: string) => {
					const one = newBoot(`typed-${field}`, day, (summary) => (summary[field] = field === "runs" || field === "provider" ? 7 : { not: "this" }));
					put(runs, one.path, one.text);
				},
			],
		]),
	),
	"an instance type 100,000 characters long": (runs) => {
		const one = newBoot("long-type", day, (summary) => (summary.provider.instance_type = "a".repeat(100_000)));
		put(runs, one.path, one.text);
	},
	"a boot 100,000 characters long": (runs) => {
		const one = newBoot("long-boot", day, (summary) => (summary.boot = "b".repeat(100_000)));
		put(runs, one.path, one.text);
	},
	"a start 100,000 characters long": (runs) => {
		const one = newBoot("long-start", day, (summary) => (summary.started_at = `${day}${"9".repeat(100_000)}`));
		put(runs, one.path, one.text);
	},
	"a list of 100,000 Runs that do not exist": (runs) => {
		const one = newBoot("many-runs", day, (summary) => (summary.runs = Array.from({ length: 100_000 }, (_, i) => run(`019aa3c4-0000-7000-8000-${String(i).padStart(12, "0")}`))));
		put(runs, one.path, one.text);
	},
	"a name of 200 characters": (runs) => put(runs, `boots/2026/11/25/${"n".repeat(200)}.json`, "{}"),
	"a name that is not UTF-8": (runs) => putRaw(runs, "boots", [0x72, 0xe9, 0x73, 0x75, 0x6d, 0xe9, 0x2e, 0x74, 0x78, 0x74], "notes"),
	"two names of other bytes that decode to the same text": (runs) => {
		putRaw(runs, "boots/2026/11/25", [0x72, 0xe9, 0x2e, 0x6a, 0x73, 0x6f, 0x6e], "{}");
		putRaw(runs, "boots/2026/11/25", [0x72, 0xe8, 0x2e, 0x6a, 0x73, 0x6f, 0x6e], "{}");
	},
	"a name with a double quote, a backslash and a percent sign": (runs) => put(runs, 'boots/2026/11/25/a"b\\c%d.json', "{}"),
	"eight names that differ only after their 117th character": (runs) => {
		for (let i = 0; i < 8; i++) put(runs, `boots/${"z".repeat(150)}${i}.json`, "{}");
	},
	"an instance type of characters JSON writes as six bytes each": (runs) => {
		const one = newBoot("nul-type", day, (summary) => (summary.provider.instance_type = "\u0000".repeat(64)));
		put(runs, one.path, one.text);
	},
	"a name with a space": (runs) => put(runs, "boots/2026/11/25/odd name.json", newBoot("odd", day).text),
	"a file directly under boots/": (runs) => put(runs, "boots/readme.json", "{}"),
	"a summary named by a boot id that is not a UUID, of a boot that left a Run": (runs) =>
		put(runs, `boots/2026/11/21/${NOT_A_UUID}.json`, bootSummaryText({ boot: NOT_A_UUID, startedAt: "2026-11-21T03:30:00.000000000Z", instanceType: "m5.large", runs: [fixture.notUuidRun] })),
	"another day's unknown.json": (runs) => put(runs, "boots/2026/11/25/unknown.json", newBoot("x", day, (summary) => (summary.boot = "")).text),
	"a path whose date is no date": (runs) => put(runs, `boots/2026/99/35/${idOf("no-date")}.json`, newBoot("no-date", day).text),
	"a start that is no date": (runs) => {
		const one = newBoot("feb-30", "2026-02-28T04:11:00.000000000Z", (summary) => (summary.started_at = "2026-02-30T04:11:00.000000000Z"));
		put(runs, `boots/2026/02/30/${idOf("feb-30")}.json`, one.text);
	},
	"a summary listing Runs that do not exist": (runs) => {
		const one = newBoot("ghosts", day, (summary) => (summary.runs = [run("019aa3c5-0000-7000-8000-000000000001")]));
		put(runs, one.path, one.text);
	},
	"a summary listing another boot's Run": (runs) => {
		const evening = fixture.boots["evening-m5"] as HandMadeBoot;
		const one = newBoot("thief", day, (summary) => (summary.runs = [run((evening.runs[0] as Run).id)]));
		put(runs, one.path, one.text);
	},
	"a summary listing a Run another summary lists, of no Run file": (runs) => {
		const one = newBoot("echo", day, (summary) => (summary.runs = [run(fixture.missing)]));
		put(runs, one.path, one.text);
	},
};

/** The additions paired with every other of them: those that touch the same summaries, links or names. */
const PAIRED = [
	"a copy of a summary at an earlier path",
	"a copy of a summary at a later path",
	"a second summary of a boot at its own path, started later",
	"a symbolic link to a summary",
	"a symbolic link to a directory",
	"an empty file",
	"a file that is not JSON",
	"an instance type 100,000 characters long",
	"a summary named by a boot id that is not a UUID, of a boot that left a Run",
	"a summary listing another boot's Run",
	"a summary listing a Run another summary lists, of no Run file",
	"a name of 200 characters",
	"a name that is not UTF-8",
	"eight names that differ only after their 117th character",
];

/** What a publish needs, after `names` are added to a copy of the fixture's checkout. */
function holds(names: readonly string[]): void {
	const runs = mkdtempSync(join(tmpdir(), "api-additions-runs-"));
	cpSync(fixture.runs, runs, { recursive: true });
	for (const name of names) (ADDITIONS[name] as (runs: string) => void)(runs);
	const tree = build(runs);
	expect(checkApi({ tree, runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems).toEqual([]);
	const gate = checkStability(before, tree);
	expect([gate.compared, gate.problems]).toEqual([true, []]);
	const after = pointLinks(tree);
	for (const [point, was] of links) {
		const now = after.get(point);
		expect(now?.evidence).toBe(was.evidence);
		if (was.boot_summary !== null) expect([point, now?.boot_summary]).toEqual([point, was.boot_summary]);
	}
	expect(bootSummaryAddresses(tree).filter((url) => !isServedKey(url.slice(DEFAULT_BASE.length + 1)))).toEqual([]);
	const ceiling = (CEILINGS.find((one) => one.path.test(INDEX_PATH)) as (typeof CEILINGS)[number]).bytes;
	expect(readFileSync(join(tree, INDEX_PATH)).length).toBeLessThan(ceiling);
	// Each file listed as left out can be told from the others, and its path is at most 120 bytes as written.
	const listed = (JSON.parse(readFileSync(join(tree, INDEX_PATH), "utf8")).recent_rounds.left_out.summaries as Json[]).map((one) => one.path as string);
	expect(new Set(listed).size).toBe(listed.length);
	expect(listed.filter((path) => new TextEncoder().encode(JSON.stringify(path)).length - 2 > 120)).toEqual([]);
}

beforeAll(async () => {
	fixture = await makeRoundsFixture();
	before = build(fixture.runs);
	links = pointLinks(before);
	expect([...links.values()].filter((link) => link.boot_summary !== null).length).toBeGreaterThan(20);
});

describe("nothing added to the Runs data stops a publish or changes what is published", () => {
	for (const name of Object.keys(ADDITIONS)) test(`alone: ${name}`, () => holds([name]));
	for (let i = 0; i < PAIRED.length; i++) {
		for (let j = i + 1; j < PAIRED.length; j++) test(`with each other: ${PAIRED[i]}; ${PAIRED[j]}`, () => holds([PAIRED[i] as string, PAIRED[j] as string]));
	}
	test("every addition of the pairs is one of the additions", () => {
		for (const name of PAIRED) expect(Object.keys(ADDITIONS)).toContain(name);
	});
});
