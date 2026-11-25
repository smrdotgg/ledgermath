/**
 * The data API's gate, held to the ways a tree it should refuse could pass
 * (pull request #69, second review): a file that is not the build's own
 * writing of its values; a late Run excusing more than a late Run can change;
 * a previous tree that is not whole, or whose layout is guessed from its
 * schemas' bytes. Each test is a reproduction of a tree that passed, and each
 * is refused now.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import type { DerivationsFile as SeriesFile } from "../methods/v1/output";
import { type ApiSources, apiJson, buildApi, DEFAULT_BASE, LAYOUT, MONTH_FILES_WRITTEN_SO_SINCE_LAYOUT, monthPath, readApiSchemas, readBootFiles, readBootSummaries, readPriceFiles, seriesPath } from "../scripts/lib/api";
import { checkApi, checkStability, describeStability } from "../scripts/lib/api-check";
import { type ApiFixture, makeApiFixture } from "./api-fixtures";

setDefaultTimeout(120_000);

const ROOT = join(import.meta.dir, "..");

type Json = Record<string, any>;

function sourcesOf(fixture: { series: SeriesFile; requests: RequestsFile; runs: string }): ApiSources {
	return {
		base: DEFAULT_BASE,
		docs: "https://example.test/docs",
		series: structuredClone(fixture.series),
		requests: structuredClone(fixture.requests),
		prices: readPriceFiles(fixture.runs),
		boots: readBootSummaries(fixture.runs),
		bootFiles: readBootFiles(fixture.runs),
		schemas: readApiSchemas(),
	};
}

function writeTree(tree: Map<string, Uint8Array>, only: (path: string) => boolean = () => true): string {
	const directory = mkdtempSync(join(tmpdir(), "api-gate-tree-"));
	for (const [path, bytes] of tree) {
		if (!only(path)) continue;
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), bytes);
	}
	return directory;
}

const copyOf = (from: string): string => {
	const copy = mkdtempSync(join(tmpdir(), "api-gate-copy-"));
	cpSync(from, copy, { recursive: true });
	return copy;
};
const readJson = (directory: string, path: string): Json => JSON.parse(readFileSync(join(directory, path), "utf8"));

/** A file's text as the build writes it: apiJson with the schema of its kind, as this repository keeps it. */
function written(path: string, value: unknown): string {
	const name = path === "v1/index.json" ? "index" : path === "v1/series.json" ? "series-list" : /^v1\/series\/[^/]+\.json$/.test(path) ? "series" : "series-month";
	return apiJson(value, JSON.parse(readFileSync(join(ROOT, "schemas", "api", "v1", `${name}.schema.json`), "utf8")));
}

/** A value written one member per line, in the order it holds them: the build's white space, but not its order of members. */
function heldOrder(value: unknown): string {
	const write = (item: unknown, indent: string): string => {
		if (Array.isArray(item)) {
			if (item.length > 0 && item.every((one) => typeof one === "object" && one !== null && !Array.isArray(one))) return `[\n${item.map((one) => `${indent}  ${JSON.stringify(one)}`).join(",\n")}\n${indent}]`;
			return JSON.stringify(item);
		}
		if (typeof item === "object" && item !== null) {
			const keys = Object.keys(item);
			if (keys.length === 0) return "{}";
			return `{\n${keys.map((key) => `${indent}  ${JSON.stringify(key)}: ${write((item as Json)[key], `${indent}  `)}`).join(",\n")}\n${indent}}`;
		}
		return JSON.stringify(item);
	};
	return `${write(value, "")}\n`;
}

/** The entry of a changed month file in its Series file made to give its new sha256 and size: what a tamperer would do. */
function keepEntry(directory: string, path: string): void {
	const [, id, month] = /^v1\/series\/([^/]+)\/([^/]+)\.json$/.exec(path) as RegExpExecArray;
	const series = readJson(directory, seriesPath(id as string));
	const entry = (series.months as Json[]).find((one) => one.month === month) as Json;
	const bytes = readFileSync(join(directory, path));
	entry.sha256 = createHash("sha256").update(bytes).digest("hex");
	entry.bytes = bytes.length;
	writeFileSync(join(directory, seriesPath(id as string)), written(seriesPath(id as string), series));
}

const reversed = (value: Json): Json => Object.fromEntries(Object.entries(value).reverse());

let fixture: ApiFixture;
/** The tree before: two months, December's http_get Run in a second group. */
let directory: string;
let tree: Map<string, Uint8Array>;
/** And after a late Run of requests that neither Method counts, in November. */
let lateFailed: ApiFixture;
let lateFailedTree: string;
/** And after a late Run of requests that both count, in November, on a third processor. */
let lateCounted: ApiFixture;

beforeAll(async () => {
	fixture = await makeApiFixture({ nextMonth: true });
	tree = buildApi(sourcesOf(fixture));
	directory = writeTree(tree);
	lateFailed = await makeApiFixture({ nextMonth: true, lateFailedRequestsRun: true });
	lateFailedTree = writeTree(buildApi(sourcesOf(lateFailed)));
	lateCounted = await makeApiFixture({ nextMonth: true, lateRequestsRun: true });
});

describe("1. every file the build writes is exactly its writing of its own values", () => {
	test("the reproduction: a failed late Run in November, December's through with its members reversed by hand and the Series' digest updated, passes neither the check nor the comparison", () => {
		const dec = monthPath(fixture.http, "2026-12");
		const tampered = copyOf(lateFailedTree);
		const value = readJson(tampered, dec);
		const point = value.derivations.requests_v1.points[0];
		point.through = reversed(point.through);
		writeFileSync(join(tampered, dec), heldOrder(value));
		keepEntry(tampered, dec);
		// The same values: only the order of through's members differs.
		expect(readJson(tampered, dec)).toEqual(readJson(lateFailedTree, dec));
		const problems = checkApi({ tree: tampered, runs: lateFailed.runs, base: DEFAULT_BASE, series: lateFailed.series, requests: lateFailed.requests }).problems;
		expect(problems).toEqual([expect.stringMatching(new RegExp(`^${dec} is not what the build writes for its own values`))]);
		const compared = checkStability(directory, tampered).problems;
		expect(compared.length).toBeGreaterThan(0);
		expect(compared.join("\n")).toContain(`${dec} changed since the previous tree in a way none of the four causes explains: this file is not what the build writes for its own values`);
		// Untouched, the same late Run passes both, December changed for (c) by its pair entry alone.
		expect(checkApi({ tree: lateFailedTree, runs: lateFailed.runs, base: DEFAULT_BASE, series: lateFailed.series, requests: lateFailed.requests }).problems).toEqual([]);
		const clean = checkStability(directory, lateFailedTree);
		expect(clean.problems).toEqual([]);
		expect(clean.explained.find((file) => file.path === dec)?.causes).toEqual([{ cause: "c", detail: expect.stringMatching(/^the pair entry of Run .+, now from Run .+, added late$/) }]);
	});

	test("a reordered object, a space or a respelt number in any file the build writes fails the check, though every value is the same", () => {
		const check = (change: (copy: string) => void): string[] => {
			const copy = copyOf(directory);
			change(copy);
			return checkApi({ tree: copy, runs: fixture.runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems;
		};
		const off = (path: string) => expect.stringMatching(new RegExp(`^${path.replaceAll(".", "\\.")} is not what the build writes for its own values`));
		const rewrite = (path: string, change: (text: string) => string) => (copy: string) => writeFileSync(join(copy, path), change(readFileSync(join(copy, path), "utf8")));
		// The table of contents: a space before a value.
		expect(check(rewrite("v1/index.json", (text) => text.replace('"layout": ', '"layout":  ').replace('"months": "', '"months":  "')))).toEqual([off("v1/index.json")]);
		// The list: a row's members in another order.
		expect(
			check((copy) => {
				const list = readJson(copy, "v1/series.json");
				list.series[0] = reversed(list.series[0]);
				writeFileSync(join(copy, "v1/series.json"), heldOrder(list));
			}),
		).toEqual([off("v1/series.json")]);
		// A Series file: its head's members in another order.
		const syscall = seriesPath(fixture.syscall);
		expect(
			check((copy) => {
				const file = readJson(copy, syscall);
				writeFileSync(join(copy, syscall), heldOrder({ id: file.id, schema: file.schema, ...file }));
			}),
		).toEqual([off(syscall)]);
		// A month file: a number written otherwise, with the same value, and its digest updated.
		const nov = monthPath(fixture.memory, "2026-11");
		expect(
			check((copy) => {
				expect(readFileSync(join(copy, nov), "utf8")).toContain('"sample":1,');
				rewrite(nov, (text) => text.replace('"sample":1,', '"sample":1.0,'))(copy);
				keepEntry(copy, nov);
			}),
		).toEqual([off(nov)]);
		// A final newline missing.
		expect(check(rewrite(nov, (text) => text.trimEnd()))).toContainEqual(off(nov));
	});
});

describe("2. a late Run excuses only what a late Run can change", () => {
	const dec = (): string => monthPath(fixture.http, "2026-12");

	test("the reproduction: after a counted late Run in November, December's through.runs at 999 in the Derivations passes the check against them, and fails the comparison", () => {
		const requests = structuredClone(lateCounted.requests);
		const point = (requests.derivations.find((d) => d.series.id === lateCounted.http) as RequestsFile["derivations"][number]).points.at(-1) as Json;
		expect(point.started_at.startsWith("2026-12-01")).toBe(true);
		const runs = point.through.runs;
		point.through.runs = 999;
		const after = writeTree(buildApi({ ...sourcesOf(lateCounted), requests }));
		// The tree is the Derivations': the check against them cannot see it.
		expect(checkApi({ tree: after, runs: lateCounted.runs, base: DEFAULT_BASE, series: lateCounted.series, requests }).problems).toEqual([]);
		const problems = checkStability(directory, after).problems;
		expect(problems).toEqual([
			expect.stringContaining(`${dec()} changed since the previous tree in a way none of the four causes explains: /derivations/requests_v1: the point of Run ${point.run}, after a Run added late: through.runs is 999, not ${runs}`),
		]);
		// As the Method made it, it passes: its counts rose by the late Run's.
		expect(checkStability(directory, writeTree(buildApi(sourcesOf(lateCounted)))).problems).toEqual([]);
	});

	test("after late Runs none of which is counted, a later point's through must not change at all", () => {
		const requests = structuredClone(lateFailed.requests);
		const point = (requests.derivations.find((d) => d.series.id === lateFailed.http) as RequestsFile["derivations"][number]).points.at(-1) as Json;
		point.through.requests += 1;
		const after = writeTree(buildApi({ ...sourcesOf(lateFailed), requests }));
		expect(checkStability(directory, after).problems).toEqual([
			expect.stringMatching(
				new RegExp(`^${dec()} changed since the previous tree in a way none of the four causes explains: /derivations/requests_v1: the point of Run ${point.run}, after a Run added late: through is .*, but no Run added before it is counted`),
			),
		]);
	});

	test("a month file that did not change, though a counted Run added late before it should have changed its through, fails", () => {
		const after = writeTree(buildApi(sourcesOf(lateCounted)));
		// December's file as it was before the late Run, its digest in the Series file updated.
		writeFileSync(join(after, dec()), tree.get(dec()) as Uint8Array);
		keepEntry(after, dec());
		const runs = readJson(directory, dec()).derivations.requests_v1.points[0].through.runs as number;
		const problems = checkStability(directory, after).problems;
		const unchanged = `^${dec()} did not change since the previous tree, but a Run added late before it should have changed it: /derivations/`;
		expect(problems).toEqual([
			expect.stringMatching(new RegExp(`${unchanged}requests_v1: the point of Run .+: through\\.runs is ${runs}, not ${runs + 1}`)),
			expect.stringMatching(new RegExp(`${unchanged}series_v1: the pair entry to .+ is from .+, but the Run right before it is now .+, added late$`)),
		]);
	});

	test("after a late Run, a later point's field that does not depend on earlier Runs fails, as the list in the code says", () => {
		const requests = structuredClone(lateCounted.requests);
		const point = (requests.derivations.find((d) => d.series.id === lateCounted.http) as RequestsFile["derivations"][number]).points.at(-1) as Json;
		point.counted_requests += 1;
		const after = writeTree(buildApi({ ...sourcesOf(lateCounted), requests }));
		expect(checkStability(directory, after).problems).toEqual([
			`${dec()} changed since the previous tree in a way none of the four causes explains: /derivations/requests_v1: the point of Run ${point.run}: counted_requests is ${point.counted_requests}, where it was ${point.counted_requests - 1}`,
		]);
	});
});

describe("3. the previous tree is whole, and its history is honoured across a change of layout", () => {
	/** The tree built without the syscall Series: one that lost a Series. */
	let lost: string;
	beforeAll(() => {
		const sources = sourcesOf(fixture);
		sources.series.derivations = sources.series.derivations.filter((d) => d.series.id !== fixture.syscall);
		lost = writeTree(buildApi(sources));
	});

	test("the reproduction: a previous tree with its index, schemas and Series files but no month file is no baseline", () => {
		const noMonths = writeTree(tree, (path) => !/^v1\/series\/[^/]+\/[^/]+\.json$/.test(path));
		const result = checkStability(noMonths, lost);
		expect(result.compared).toBe(false);
		expect(result.problems).toContain(`the previous tree ${noMonths} is not whole, so it is no baseline: ${monthPath(fixture.syscall, "2026-11")} is missing, though ${seriesPath(fixture.syscall)} lists it`);
	});

	test("the reproduction: a newline added to the previous tree's price schema changes nothing: of the same layout, it is compared, and the Series this tree lost is found missing", () => {
		const schema = copyOf(directory);
		writeFileSync(join(schema, "v1/schemas/prices.schema.json"), `${readFileSync(join(schema, "v1/schemas/prices.schema.json"), "utf8")}\n`);
		for (const options of [{}, { newBaseline: true }]) {
			const result = checkStability(schema, lost, options);
			expect(result.compared).toBe(true);
			expect(result.problems).toContain(`Series ${fixture.syscall} was published in the previous tree and is not in this one: a published Series never disappears`);
			expect(result.problems).toContain(`${monthPath(fixture.syscall, "2026-11")} was in the previous tree and is not in this one: a month file, once written, stays`);
		}
	});

	test("a previous tree that is missing, of another layout or of none fails unless a new baseline is declared; declared, nothing it published may be missing, read in this layout or in the one before the split", () => {
		const missing = join(tmpdir(), "api-gate-no-such-tree");
		const refused = checkStability(missing, directory);
		expect([refused.compared, refused.problems]).toEqual([false, [expect.stringContaining(`no previous tree of this layout to compare this one with: ${missing} does not exist. Only a human may declare a new baseline`)]]);
		expect(checkStability(missing, directory, { newBaseline: true }).problems).toEqual([]);
		// A tree of a later layout.
		const later = copyOf(directory);
		writeFileSync(join(later, "v1/index.json"), written("v1/index.json", { ...readJson(later, "v1/index.json"), layout: LAYOUT + 1 }));
		expect(checkStability(later, directory).problems).toEqual([expect.stringContaining(`${later} is a tree of layout ${LAYOUT + 1}, this tree of layout ${LAYOUT}`)]);
		// A tree of the layout before, as the first run after a raise of layout finds the tree the run before kept: refused, unless declared;
		// declared, its Series and Runs are all still here.
		const earlier = copyOf(directory);
		writeFileSync(join(earlier, "v1/index.json"), written("v1/index.json", { ...readJson(earlier, "v1/index.json"), layout: LAYOUT - 1 }));
		expect(checkStability(earlier, directory).problems).toEqual([expect.stringContaining(`${earlier} is a tree of layout ${LAYOUT - 1}, this tree of layout ${LAYOUT}`)]);
		const raised = checkStability(earlier, directory, { newBaseline: true });
		expect([raised.compared, raised.problems, raised.published]).toEqual([true, [], { series: 3, runs: 9, monthFiles: 5, seriesFilesWithPoints: 0, unread: 0 }]);
		// The layout on main before the split: no layout in the index, every point in the Series file, no month file.
		const before = writeTree(tree, (path) => !/^v1\/series\//.test(path));
		const index = readJson(before, "v1/index.json");
		delete index.layout;
		writeFileSync(join(before, "v1/index.json"), heldOrder(index));
		for (const id of [fixture.memory, fixture.http, fixture.syscall]) {
			const file = readJson(directory, seriesPath(id));
			const months = (file.months as Json[]).map((entry) => readJson(directory, monthPath(id, entry.month)));
			for (const key of Object.keys(file.derivations)) file.derivations[key].points = months.flatMap((month) => month.derivations[key].points);
			delete file.months;
			mkdirSync(join(before, "v1", "series"), { recursive: true });
			writeFileSync(join(before, seriesPath(id)), heldOrder(file));
		}
		expect(checkStability(before, directory).problems).toEqual([expect.stringContaining(`${before} is a tree of layout none (it was written before layout was), this tree of layout ${LAYOUT}`)]);
		const declared = checkStability(before, directory, { newBaseline: true });
		expect([declared.compared, declared.problems, declared.published]).toEqual([false, [], { series: 3, runs: 9, monthFiles: 0, seriesFilesWithPoints: 3, unread: 0 }]);
		const lostSeries = checkStability(before, lost, { newBaseline: true });
		expect(lostSeries.problems).toEqual([`Series ${fixture.syscall} was published in the previous tree ${before} and is not in this one: a published Series never disappears, a new baseline or not`]);
		// A Run it published that this tree lacks.
		const ghost = readJson(before, seriesPath(fixture.memory));
		ghost.derivations.series_v1.points.push({ ...ghost.derivations.series_v1.points[0], run: "ghost-run" });
		writeFileSync(join(before, seriesPath(fixture.memory)), heldOrder(ghost));
		expect(checkStability(before, directory, { newBaseline: true }).problems).toEqual([
			`Series ${fixture.memory}: 1 Run published in the previous tree ${before} is in no month file of this one (ghost-run): a published Run never disappears, a new baseline or not`,
		]);
		// And the same, read in this layout: a tree of a later layout, declared, still holds this one to its Runs.
		const laterLost = checkStability(later, lost, { newBaseline: true });
		expect(laterLost.problems).toEqual([`Series ${fixture.syscall} was published in the previous tree ${later} and is not in this one: a published Series never disappears, a new baseline or not`]);
		expect(laterLost.published).toEqual({ series: 3, runs: 9, monthFiles: 5, seriesFilesWithPoints: 0, unread: 0 });
	});

	test("a previous tree of the same layout is compared strictly, a new baseline declared or not", () => {
		const nov = monthPath(fixture.syscall, "2026-11");
		const edited = copyOf(directory);
		const value = readJson(edited, nov);
		value.derivations.series_v1.points[0].time_per_repetition_ns += 1;
		writeFileSync(join(edited, nov), written(nov, value));
		keepEntry(edited, nov);
		for (const options of [{}, { newBaseline: true }]) {
			const result = checkStability(directory, edited, options);
			expect(result.compared).toBe(true);
			expect(result.problems).toEqual([expect.stringContaining(`${nov} changed since the previous tree in a way none of the four causes explains: /derivations/series_v1: the point of Run`)]);
		}
		// And a month file whose bytes are not what its Series file lists makes the previous tree no baseline.
		const unlisted = copyOf(directory);
		writeFileSync(join(unlisted, nov), written(nov, value));
		const notWhole = checkStability(unlisted, directory, { newBaseline: true });
		expect(notWhole.compared).toBe(false);
		expect(notWhole.problems).toContainEqual(
			expect.stringMatching(new RegExp(`^the previous tree ${unlisted} is not whole, so it is no baseline: ${nov} has sha256 [0-9a-f]{64}, not "[0-9a-f]{64}" as ${seriesPath(fixture.syscall).replaceAll(".", "\\.")} lists it$`)),
		);
	});

	test("a previous tree of an earlier layout that writes month files alike, with a new baseline declared: every month file is still compared by the four causes, and only the rest of the tree may change", () => {
		expect(MONTH_FILES_WRITTEN_SO_SINCE_LAYOUT).toBeLessThan(LAYOUT);
		const nov = monthPath(fixture.syscall, "2026-11");
		const asLayout = (from: string, layout: number): string => {
			const copy = copyOf(from);
			writeFileSync(join(copy, "v1/index.json"), written("v1/index.json", { ...readJson(copy, "v1/index.json"), layout }));
			return copy;
		};
		// The tree before the raise, its month files the same: compared, every one the same byte for byte.
		const earlier = asLayout(directory, LAYOUT - 1);
		const raised = checkStability(earlier, directory, { newBaseline: true });
		expect([raised.compared, raised.acrossLayouts, raised.problems, raised.inBoth, raised.unchanged]).toEqual([true, true, [], 5, 5]);
		expect(describeStability(raised, earlier).join("\n")).toContain("every month file was held to the four causes");
		// Without the declaration, a change of layout is refused as ever.
		expect(checkStability(earlier, directory).problems).toEqual([expect.stringContaining(`${earlier} is a tree of layout ${LAYOUT - 1}, this tree of layout ${LAYOUT}`)]);
		// A month file the tree before held otherwise, with no cause: refused, the new baseline notwithstanding.
		const edited = copyOf(directory);
		const value = readJson(edited, nov);
		value.derivations.series_v1.points[0].time_per_repetition_ns += 1;
		writeFileSync(join(edited, nov), written(nov, value));
		keepEntry(edited, nov);
		const changed = checkStability(asLayout(edited, LAYOUT - 1), directory, { newBaseline: true });
		expect(changed.compared).toBe(true);
		expect(changed.problems).toEqual([expect.stringContaining(`${nov} changed since the previous tree in a way none of the four causes explains: /derivations/series_v1: the point of Run`)]);
		// A tree before of a layout older than the month files' writing (0 reads as none): not compared, as a new baseline lets it be.
		const older = checkStability(asLayout(directory, MONTH_FILES_WRITTEN_SO_SINCE_LAYOUT - 1), directory, { newBaseline: true });
		expect([older.compared, older.problems]).toEqual([false, []]);
		// And one that is not whole is a new baseline as before: nothing compared, nothing published missing.
		const unlisted = copyOf(directory);
		writeFileSync(join(unlisted, nov), written(nov, value));
		const notWhole = checkStability(asLayout(unlisted, LAYOUT - 1), directory, { newBaseline: true });
		expect([notWhole.compared, notWhole.problems]).toEqual([false, []]);

		// A month the tree before holds whose bytes are what its Series file lists, but are no JSON: a plain new baseline, not a refusal.
		const unparsable = asLayout(directory, LAYOUT - 1);
		writeFileSync(join(unparsable, nov), "not JSON\n");
		keepEntry(unparsable, nov);
		const ofUnparsable = checkStability(unparsable, directory, { newBaseline: true });
		expect([ofUnparsable.compared, ofUnparsable.acrossLayouts, ofUnparsable.problems, ofUnparsable.published?.unread]).toEqual([false, undefined, [], 1]);
		expect(checkStability(unparsable, directory).problems).toEqual([expect.stringContaining(`${unparsable} is a tree of layout ${LAYOUT - 1}, this tree of layout ${LAYOUT}`)]);

		// A month the tree before holds that cannot be read at all: a plain new baseline, and the gate does not throw. (Root reads it anyway.)
		if (process.getuid?.() !== 0) {
			const unreadable = asLayout(directory, LAYOUT - 1);
			chmodSync(join(unreadable, nov), 0);
			try {
				const ofUnreadable = checkStability(unreadable, directory, { newBaseline: true });
				expect([ofUnreadable.compared, ofUnreadable.problems, ofUnreadable.published?.unread]).toEqual([false, [], 1]);
				expect(checkStability(unreadable, directory).problems).toEqual([expect.stringContaining(`${unreadable} is a tree of layout ${LAYOUT - 1}, this tree of layout ${LAYOUT}`)]);
			} finally {
				chmodSync(join(unreadable, nov), 0o644);
			}
		}
	});
});
