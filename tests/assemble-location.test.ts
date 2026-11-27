/**
 * scripts/assemble-location.ts and how it reads the data API's tree from a
 * directory (scripts/lib/ledger-data.ts). The tree is built here by the
 * generator from the fixture the API's golden test uses (tests/api-fixtures.ts,
 * `small`), into the directory that holds the fixture's Runs repository
 * checkout, so both are tested against a tree the generator really writes.
 * Nothing in it was measured.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import type { DerivationsFile as SeriesFile } from "../methods/v1/output";
import { buildApi, DEFAULT_BASE, LAYOUT, monthPath, readApiSchemas, readBootFiles, readBootSummaries, readPriceFiles } from "../scripts/lib/api";
import { CEILINGS } from "../scripts/lib/api-check";
import { LedgerError, LIMITS, loadLedger, openLocation } from "../scripts/lib/ledger-data";
import { type ApiFixture, EMPTY_BOOT, FIRST_BOOT, makeApiFixture } from "./api-fixtures";

setDefaultTimeout(120_000);

const ROOT = resolve(import.meta.dir, "..");
const INDEX = "v1/index.json";
const LIST = "v1/series.json";

let fixture: ApiFixture;
let tree: Map<string, Uint8Array>;
const made: string[] = [];

/** Builds the tree for these Derivations, with the price files and boot summaries the directory holds, and writes it under directory/v1/. Returns its files by path. */
function writeTree(directory: string, series: SeriesFile, requests: RequestsFile): Map<string, Uint8Array> {
	const built = buildApi({
		base: DEFAULT_BASE,
		docs: "https://example.test/docs",
		series,
		requests,
		prices: readPriceFiles(directory),
		boots: readBootSummaries(directory),
		bootFiles: readBootFiles(directory),
		schemas: readApiSchemas(),
	});
	for (const [path, bytes] of built) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), bytes);
	}
	return built;
}

beforeAll(async () => {
	fixture = await makeApiFixture({ small: true });
	// The fixture copies one sample price file under two dates; the second is made the day's own, as a price file is
	// (fetched that day), so the check of a price file holds. The tree lists price files by path, so its bytes do not change.
	const second = join(fixture.runs, "prices", "2026", "11", "12", "aws.json");
	writeFileSync(second, readFileSync(second, "utf8").replace('"fetched_at": "2026-11-11T', '"fetched_at": "2026-11-12T'));
	tree = writeTree(fixture.runs, fixture.series, fixture.requests);
});
afterAll(() => {
	for (const path of [fixture.runs, dirname(fixture.derivationsPath), ...made]) rmSync(path, { recursive: true, force: true });
});

/** Every file under a directory, by its path from it with forward slashes. */
function filesUnder(root: string): string[] {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();
}

/** A copy of the fixture's directory, with some files replaced by other bytes (a directory holding two builds, a file too large) or added, and those in `omit` left out. */
function copyWith(changes: Record<string, Uint8Array | string>, omit: readonly string[] = []): string {
	const copy = mkdtempSync(join(tmpdir(), "assemble-location-copy-"));
	made.push(copy);
	for (const path of [...new Set([...filesUnder(fixture.runs), ...Object.keys(changes)])].filter((p) => !omit.includes(p))) {
		mkdirSync(dirname(join(copy, path)), { recursive: true });
		writeFileSync(join(copy, path), changes[path] ?? readFileSync(join(fixture.runs, path)));
	}
	return copy;
}

const bytesOf = (path: string): Uint8Array => tree.get(path) as Uint8Array;
/** Other bytes than the tree's: a space more before the final newline, which still parses. */
const stale = (path: string): Uint8Array => new TextEncoder().encode(`${new TextDecoder().decode(bytesOf(path)).trimEnd()} \n`);

async function expectLedgerError(promise: Promise<unknown>, ...parts: string[]): Promise<LedgerError> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(LedgerError);
	const error = caught as LedgerError;
	for (const part of parts) expect(error.message).toContain(part);
	return error;
}

describe("the tree, read from a directory", () => {
	const memoryMonth = (): string => monthPath(fixture.memory, "2026-11");

	test("a month file whose bytes are not the sha256 its Series file lists, or that is missing, says the directory holds two builds, and neither file is used", async () => {
		const whole = await loadLedger(openLocation(fixture.runs));
		expect((await whole.seriesWithMonths(fixture.memory, (series) => series.months))?.months.length).toBeGreaterThan(0);
		const mismatched = await loadLedger(openLocation(copyWith({ [memoryMonth()]: stale(memoryMonth()) })));
		await expectLedgerError(
			mismatched.seriesWithMonths(fixture.memory, (series) => series.months),
			"holds files of two different builds",
			`${memoryMonth()} does not have the sha256 and size Series ${fixture.memory}'s file lists for it`,
			"Neither file was used",
		);
		const missing = await loadLedger(openLocation(copyWith({}, [memoryMonth()])));
		await expectLedgerError(missing.seriesWithMonths(fixture.memory, (series) => series.months), "holds files of two different builds", `${memoryMonth()} is not there, although Series ${fixture.memory}'s file lists it`);
	});

	test("a table of contents of another layout is read as any other: a layout changes how files are written, not what they mean", async () => {
		const other = new TextDecoder().decode(bytesOf(INDEX)).replace(`"layout": ${LAYOUT},`, `"layout": ${LAYOUT + 1},`);
		const data = await loadLedger(openLocation(copyWith({ [INDEX]: other })));
		expect(data.index.layout).toBe(LAYOUT + 1);
		expect((await data.seriesWithMonths(fixture.memory, (series) => series.months))?.series.id).toBe(fixture.memory);
	});

	test("a file larger than its limit is not read", async () => {
		const padded = `${new TextDecoder().decode(bytesOf(INDEX)).trimEnd()}${" ".repeat(LIMITS.index)}\n`;
		await expectLedgerError(loadLedger(openLocation(copyWith({ [INDEX]: padded }))), `is larger than ${LIMITS.index} bytes`);
	});

	test("a link whose path a resolver would take out of the directory, encoded or dotted, is refused", async () => {
		for (const way of ["v1/%2e%2e/%2e%2e/secret.json", "v1/..%2f..%2fsecret.json", "v1\\..\\..\\secret.json", "v1/series.json?x=../../secret.json", "v1/../../secret.json"]) {
			const index = new TextDecoder().decode(bytesOf(INDEX)).replace(`"url": "${DEFAULT_BASE}/${LIST}"`, `"url": "${DEFAULT_BASE}/${way.replaceAll("\\", "\\\\")}"`);
			const data = await loadLedger(openLocation(copyWith({ [INDEX]: index })));
			await expectLedgerError(data.list(), "LedgerMath's data never lead outside the location they are read from");
		}
	});

	test("a symbolic link out of the directory is refused; one inside it is followed", async () => {
		const away = mkdtempSync(join(tmpdir(), "assemble-location-away-"));
		made.push(away);
		writeFileSync(join(away, "series.json"), bytesOf(LIST));
		const out = copyWith({}, [LIST]);
		symlinkSync(join(away, "series.json"), join(out, LIST));
		await expectLedgerError((await loadLedger(openLocation(out))).list(), `${join(out, LIST)} leads outside the directory ${out}`);
		// A directory linked from outside: the schemas.
		const linked = copyWith({}, filesUnder(fixture.runs).filter((p) => p.startsWith("v1/schemas/")));
		symlinkSync(join(fixture.runs, "v1", "schemas"), join(linked, "v1", "schemas"));
		const data = await loadLedger(openLocation(linked));
		await expectLedgerError(data.readLinked(data.index.schemas[0]?.url as string, LIMITS.schema, "a schema"), "leads outside the directory");
		const within = copyWith({ "v1/series-real.json": bytesOf(LIST) }, [LIST]);
		symlinkSync("series-real.json", join(within, LIST));
		expect((await (await loadLedger(openLocation(within))).list()).count).toBe(2);
	});

	test("the limits are the tree's own ceilings, kind for kind", () => {
		const samples: Array<[keyof typeof LIMITS, string]> = [
			["index", INDEX],
			["list", LIST],
			["series", "v1/series/0123456789ab.json"],
			["month", "v1/series/0123456789ab/2026-11.json"],
			["prices", "v1/prices/2026-11-12.json"],
		];
		for (const [kind, path] of samples) expect(CEILINGS.find((ceiling) => ceiling.path.test(path))?.bytes, kind).toBe(LIMITS[kind]);
	});
});

describe("scripts/assemble-location.ts", () => {
	async function assemble(api: string, runs: string, out: string): Promise<{ code: number; stdout: string; stderr: string }> {
		const child = Bun.spawn(["bun", join(ROOT, "scripts", "assemble-location.ts"), "--api", api, "--runs", runs, "--out", out], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { code, stdout, stderr };
	}
	/** The artifact api as the workflow keeps it: the tree's files, v1/, and nothing else (but those in `omit`). */
	function artifact(omit: readonly string[] = []): string {
		const api = mkdtempSync(join(tmpdir(), "assemble-location-api-"));
		made.push(api);
		for (const [path, bytes] of tree) {
			if (omit.includes(path)) continue;
			mkdirSync(dirname(join(api, path)), { recursive: true });
			writeFileSync(join(api, path), bytes);
		}
		return api;
	}

	test("puts together, from the artifact and a clone of the Runs repository, the tree and the files it links, byte for byte, and says where to start", async () => {
		const out = join(mkdtempSync(join(tmpdir(), "assemble-location-out-")), "location");
		made.push(dirname(out));
		const result = await assemble(artifact(), fixture.runs, out);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		const runFiles = filesUnder(join(fixture.runs, "runs"));
		expect(result.stdout).toContain(`v1/ (${tree.size} files, layout ${LAYOUT}, 2 Series`);
		// Both boot summaries the tree links: the first day's, which points and a round link, and that of the boot that left no Run, which only a
		// round links. Not unknown.json, which the tree lists as left out with no address.
		expect(result.stdout).toContain(`${runFiles.length} Run files and 2 boot summaries`);
		expect(result.stdout).toContain(`Start at ${join(out, "v1", "index.json")}; a link in the tree is to the file at its path under ${DEFAULT_BASE}.`);
		const linkedBoots = filesUnder(join(fixture.runs, "boots"))
			.map((p) => `boots/${p}`)
			.filter((p) => !p.endsWith("unknown.json"));
		expect(filesUnder(out)).toEqual([...linkedBoots, ...runFiles.map((p) => `runs/${p}`), ...[...tree.keys()]].sort());
		expect(filesUnder(out)).toContain(`boots/2026/11/13/${EMPTY_BOOT}.json`);
		for (const [path, bytes] of tree) expect(Buffer.from(readFileSync(join(out, path))).equals(Buffer.from(bytes)), path).toBe(true);
		for (const path of [...linkedBoots, ...runFiles.map((p) => `runs/${p}`)]) expect(readFileSync(join(out, path)).equals(readFileSync(join(fixture.runs, path))), path).toBe(true);
	});

	test("copies the summary of a boot that left no Run, which only the table of contents links, and stops when the clone lacks it; from an older table of contents, only what the points link", async () => {
		const empty = `boots/2026/11/13/${EMPTY_BOOT}.json`;
		const clone = mkdtempSync(join(tmpdir(), "assemble-location-clone-"));
		made.push(clone);
		for (const path of filesUnder(fixture.runs).filter((p) => p !== empty && (p.startsWith("runs/") || p.startsWith("boots/")))) {
			mkdirSync(dirname(join(clone, path)), { recursive: true });
			writeFileSync(join(clone, path), readFileSync(join(fixture.runs, path)));
		}
		const lacking = await assemble(artifact(), clone, join(clone, "location"));
		expect(lacking.code).toBe(2);
		expect(lacking.stderr).toContain(`${empty}: not in ${clone}`);
		// A table of contents written before the rounds were: the summaries the points link, and no other.
		const older = artifact();
		const index = JSON.parse(readFileSync(join(older, INDEX), "utf8"));
		delete index.recent_rounds;
		writeFileSync(join(older, INDEX), `${JSON.stringify(index, null, 2)}\n`);
		const out = join(mkdtempSync(join(tmpdir(), "assemble-location-out-")), "location");
		made.push(dirname(out));
		const result = await assemble(older, clone, out);
		expect([result.code, result.stderr]).toEqual([0, ""]);
		expect(filesUnder(out).filter((p) => p.startsWith("boots/"))).toEqual([`boots/2026/11/12/${FIRST_BOOT}.json`]);
	});

	test("writes nothing when a file the table of contents lists is missing or is not what it says, and names it", async () => {
		const cases: Array<{ name: string; omit: string[]; replace?: [string, Uint8Array]; expected: string }> = [
			{ name: "a price file missing", omit: ["v1/prices/2026-11-11.json"], expected: "v1/prices/2026-11-11.json, the price file of 2026-11-11 the table of contents lists, is not there" },
			{ name: "a schema missing", omit: ["v1/schemas/prices.schema.json"], expected: "the schema prices, which the table of contents lists, is not in" },
			{
				name: "a price file that is not that day's",
				omit: [],
				replace: ["v1/prices/2026-11-12.json", bytesOf("v1/prices/2026-11-11.json")],
				expected: "v1/prices/2026-11-12.json is not a valid price file: prices/2026/11/12/aws.json is not under the UTC date it was fetched",
			},
		];
		for (const { name, omit, replace, expected } of cases) {
			const api = artifact(omit);
			if (replace !== undefined) writeFileSync(join(api, replace[0]), replace[1]);
			const out = join(api, "location");
			const result = await assemble(api, fixture.runs, out);
			expect(result.code, name).toBe(2);
			expect(result.stderr, name).toContain("Nothing was written.");
			expect(result.stderr, name).toContain(expected);
			expect(filesUnder(api).some((p) => p.startsWith("location/")), name).toBe(false);
		}
	});

	test("writes nothing when the clone lacks a Run file the tree links, and names it", async () => {
		const missing = fixture.series.derivations[0]?.runs[0]?.path as string;
		const clone = mkdtempSync(join(tmpdir(), "assemble-location-clone-"));
		made.push(clone);
		for (const path of filesUnder(fixture.runs).filter((p) => p !== missing && (p.startsWith("runs/") || p.startsWith("boots/")))) {
			mkdirSync(dirname(join(clone, path)), { recursive: true });
			writeFileSync(join(clone, path), readFileSync(join(fixture.runs, path)));
		}
		const out = join(clone, "location");
		const result = await assemble(artifact(), clone, out);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain(`Nothing was written.`);
		expect(result.stderr).toContain(`${missing}: not in ${clone}`);
		expect(filesUnder(clone).some((p) => p.startsWith("location/"))).toBe(false);
	});
});
