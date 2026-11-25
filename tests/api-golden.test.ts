/**
 * The bytes of the data API's files, kept: every file the build writes from
 * the small fixture (tests/api-fixtures.ts, `small`) is compared, byte for
 * byte, with its copy in tests/api-golden/. The order of a file's known
 * fields follows the order of its schema's properties (apiJson), so a
 * reordered schema, like any other change to what the build writes, changes
 * the bytes of every file and empties every cache: here it shows in review as
 * a diff of the copies. The schemas and the price files, which the build
 * copies, are compared with what it copies them from.
 *
 * To change the bytes on purpose, raise LAYOUT in scripts/lib/api.ts when
 * the build now writes the files otherwise (not when only the fixture's data
 * changed, nor when only v1/index.json gains a field or words: it changes
 * with the data at every update, and no promise covers its bytes), write the
 * copies anew and review their diff:
 *     LEDGERMATH_WRITE_GOLDEN=1 bun test tests/api-golden.test.ts
 * The test's failure says the same.
 */

import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { API_SCHEMAS, buildApi, DEFAULT_BASE, LAYOUT, MONTH_FILES_WRITTEN_SO_SINCE_LAYOUT, priceDate, readApiSchemas, readBootFiles, readBootSummaries, readPriceFiles } from "../scripts/lib/api";
import { makeApiFixture } from "./api-fixtures";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const GOLDEN = join(import.meta.dir, "api-golden");

/** Every file under directory, by its path from it with forward slashes. */
function listFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => !entry.isDirectory())
		.map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();
}

test("every file the build writes from the small fixture is, byte for byte, its copy in tests/api-golden/", async () => {
	const fixture = await makeApiFixture({ small: true });
	const prices = readPriceFiles(fixture.runs);
	const tree = buildApi({
		base: DEFAULT_BASE,
		docs: "https://example.test/docs",
		series: fixture.series,
		requests: fixture.requests,
		prices,
		boots: readBootSummaries(fixture.runs),
		bootFiles: readBootFiles(fixture.runs),
		schemas: readApiSchemas(),
	});

	// What the build copies, compared with where it copies it from.
	const copied = new Map<string, Uint8Array>([
		...API_SCHEMAS.map(({ name, source }) => [`v1/schemas/${name}.schema.json`, readFileSync(join(ROOT, source))] as [string, Uint8Array]),
		...prices.map((price) => [`v1/prices/${priceDate(price.path)}.json`, readFileSync(join(fixture.runs, price.path))] as [string, Uint8Array]),
	]);
	const written = new Map([...tree].filter(([path]) => !copied.has(path)));
	for (const [path, bytes] of copied) expect(Buffer.from(tree.get(path) ?? []).equals(Buffer.from(bytes))).toBe(true);
	expect([...tree.keys()].sort()).toEqual([...copied.keys(), ...written.keys()].sort());

	if (process.env.LEDGERMATH_WRITE_GOLDEN === "1") {
		rmSync(GOLDEN, { recursive: true, force: true });
		for (const [path, bytes] of written) {
			mkdirSync(dirname(join(GOLDEN, path)), { recursive: true });
			writeFileSync(join(GOLDEN, path), bytes);
		}
	}
	const kept = listFiles(GOLDEN);
	const differing = [...written].filter(([path, bytes]) => !kept.includes(path) || !Buffer.from(bytes).equals(readFileSync(join(GOLDEN, path))));
	const stale = kept.filter((path) => !written.has(path));
	if (differing.length > 0 || stale.length > 0) {
		// As text, so the first difference shows as a diff.
		let diff = "";
		const first = differing[0];
		if (first !== undefined) {
			try {
				expect(`${first[0]}:\n${new TextDecoder().decode(first[1])}`).toBe(`${first[0]}:\n${kept.includes(first[0]) ? readFileSync(join(GOLDEN, first[0]), "utf8") : "(no copy)"}`);
			} catch (error) {
				diff = error instanceof Error ? error.message : String(error);
			}
		}
		throw new Error(
			[
				`The build no longer writes the bytes kept in tests/api-golden/: ${[...differing.map(([path]) => path), ...stale.map((path) => `${path} (no longer written)`)].join(", ")}.`,
				CHOICE,
				diff === "" ? "" : `The first difference:\n${diff}`,
			].join("\n\n"),
		);
	}
	expect(written.size).toBeGreaterThanOrEqual(4);
});

test("while MONTH_FILES_WRITTEN_SO_SINCE_LAYOUT says month files are written as at a layout, the build writes a real month file of that layout byte for byte", async () => {
	// tests/api-layout-1/ holds a month file as the build wrote it at layout 1 (main's tests/api-golden/ before layout 2), from the small fixture.
	// Should a change write month files otherwise and leave the constant as it is, the gate, under a new baseline, would hold every month file of a
	// layout-1 tree to the four causes and refuse them all: this fails first, saying to raise the constant with the change.
	const kept = "v1/series/0cacb5fd6fae/2026-12.json";
	const layout1 = readFileSync(join(import.meta.dir, "api-layout-1", kept));
	const fixture = await makeApiFixture({ small: true });
	const tree = buildApi({
		base: DEFAULT_BASE,
		docs: "https://example.test/docs",
		series: fixture.series,
		requests: fixture.requests,
		prices: readPriceFiles(fixture.runs),
		boots: readBootSummaries(fixture.runs),
		bootFiles: readBootFiles(fixture.runs),
		schemas: readApiSchemas(),
	});
	if (MONTH_FILES_WRITTEN_SO_SINCE_LAYOUT <= 1) {
		expect([kept, Buffer.from(tree.get(kept) ?? []).equals(layout1), "a month file written otherwise than at layout 1: set MONTH_FILES_WRITTEN_SO_SINCE_LAYOUT to LAYOUT"]).toEqual([
			kept,
			true,
			"a month file written otherwise than at layout 1: set MONTH_FILES_WRITTEN_SO_SINCE_LAYOUT to LAYOUT",
		]);
	}
});

/** What a developer whose change made the golden test fail must choose between. */
const CHOICE = [
	"Choose one:",
	`- The build now writes the files otherwise on purpose (a schema's properties reordered, a field every file of a kind gains, other white space or spelling): raise LAYOUT in scripts/lib/api.ts by one (it is ${LAYOUT}), so that no reader or check takes the new bytes for one of the four causes a month file changes for; then write the copies anew and review their diff. The runs workflow then compares the next tree with nothing until the maintainer starts it by hand with the input new_baseline.`,
	"- Only the fixture's data changed (tests/api-fixtures.ts, or what a Method derives from it), not how the build writes them: write the copies anew without raising LAYOUT, and review their diff.",
	"- Only v1/index.json changed, by a field it alone gains or by its words: write the copies anew without raising LAYOUT, and review their diff. The table of contents changes with the data at every update, no promise covers its bytes (the four causes are a month file's), and no other file's bytes changed.",
	"- Neither: the change to the bytes is a mistake.",
	"Write the copies anew with: LEDGERMATH_WRITE_GOLDEN=1 bun test tests/api-golden.test.ts",
].join("\n");
