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
 * To change the bytes on purpose, write the copies anew and review their diff:
 *     LEDGERMATH_WRITE_GOLDEN=1 bun test tests/api-golden.test.ts
 */

import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { API_SCHEMAS, buildApi, DEFAULT_BASE, priceDate, readApiSchemas, readBootSummaries, readPriceFiles } from "../scripts/lib/api";
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
	expect(listFiles(GOLDEN)).toEqual([...written.keys()].sort());
	for (const [path, bytes] of written) {
		// As text, so a difference shows as a diff; then as bytes, so nothing a text comparison could blur passes.
		const golden = readFileSync(join(GOLDEN, path));
		expect(`${path}:\n${new TextDecoder().decode(bytes)}`).toBe(`${path}:\n${golden.toString("utf8")}`);
		expect(Buffer.from(bytes).equals(golden)).toBe(true);
	}
	expect(written.size).toBeGreaterThanOrEqual(4);
});
