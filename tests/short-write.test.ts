import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { copyRuns } from "../scripts/copy-runs";
import { DirectoryBucket } from "../scripts/lib/bucket";
import { CURRENT_RULES, type OfferCode } from "../scripts/lib/price-rules";
import { cutPrices, type PriceFile, serializePriceFile } from "../scripts/lib/prices";
import { addFile, ShortWrite, type Write } from "../scripts/lib/runs-repository";
import { FETCHED_AT, MEASURED, SAMPLE_FILE, SAMPLE_PATH, SOURCES, sampleSources, VERSIONS } from "./prices-fixtures";

// Each test starts a bun child process, which takes longer on a loaded machine.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "lm-short-write-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = (name: string): string => {
	const directory = join(scratch, `${name}-${counter++}`);
	mkdirSync(directory, { recursive: true });
	return directory;
};

/** Every file under root, as paths relative to it, sorted. */
const filesUnder = (root: string): string[] =>
	readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();

/** Runs tests/short-write-child.ts with the file-size limit at blocks of 1024 bytes, and returns what it printed. */
function underLimit(blocks: number, args: string[]): { result?: unknown; error?: string } {
	const child = Bun.spawnSync(["bash", "-c", `ulimit -f ${blocks} && exec "$0" "$@"`, process.execPath, join(ROOT, "tests", "short-write-child.ts"), ...args], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = child.stdout.toString().trim();
	if (child.exitCode !== 0 || out === "") throw new Error(`the child exited ${child.exitCode}: ${out}\n${child.stderr.toString()}`);
	return JSON.parse(out.split("\n").at(-1) as string) as { result?: unknown; error?: string };
}

/**
 * The excerpts cut down to the products the rules select, and written without
 * whitespace (AWS's tokens, verbatim), so each is far smaller than the price
 * file they give: under a limit between the two, only the price file's write
 * comes up short.
 */
function smallSources(): string {
	const directory = fresh("sources");
	const sample = JSON.parse(readFileSync(SAMPLE_FILE, "utf8")) as PriceFile;
	for (const code of Object.keys(VERSIONS) as OfferCode[]) {
		const keep = new Set(sample.sources.find((source) => source.offer_code === code)?.selections.flatMap((selection) => selection.skus));
		const offer = JSON.parse(readFileSync(join(SOURCES, `${code}.json`), "utf8")) as {
			products: Record<string, unknown>;
			terms: { OnDemand: Record<string, unknown>; Reserved?: unknown };
		};
		offer.products = Object.fromEntries(Object.entries(offer.products).filter(([sku]) => keep.has(sku)));
		offer.terms = { OnDemand: Object.fromEntries(Object.entries(offer.terms.OnDemand).filter(([sku]) => keep.has(sku))) };
		writeFileSync(join(directory, `${code}.json`), JSON.stringify(offer));
	}
	return directory;
}

describe("a write that comes up short adds nothing", () => {
	test("the price fetch: with the price file's write cut off at 16 KiB, it fails, says so, and leaves no file; then it adds the whole file", () => {
		const sources = smallSources();
		for (const code of Object.keys(VERSIONS)) expect(readFileSync(join(sources, `${code}.json`)).length).toBeLessThan(16 * 1024);
		const expected = serializePriceFile(cutPrices({ fetchedAt: FETCHED_AT, measured: MEASURED, rules: CURRENT_RULES, sources: sampleSources(sources) }));
		expect(expected.length).toBeGreaterThan(16 * 1024);

		const repository = fresh("repository");
		const work = fresh("work");
		const cut = underLimit(16, ["prices", repository, work, sources]);
		expect(cut.error).toBe(`${SAMPLE_PATH}: writing stopped after 16384 of ${expected.length} bytes: EFBIG: file too large, write; nothing was added`);
		expect(filesUnder(repository)).toEqual([]);
		expect(filesUnder(work)).toEqual([]);

		// The day's file was not added, so the next fetch adds it, whole.
		const again = underLimit(1024, ["prices", repository, work, sources]);
		expect(again).toEqual({ result: { outcome: "added", path: SAMPLE_PATH } });
		expect(filesUnder(repository)).toEqual([SAMPLE_PATH]);
		expect(readFileSync(join(repository, SAMPLE_PATH), "utf8")).toBe(expected);
	});

	test("the copy job: with a Run file's write cut off at 4 KiB, it stops, adds no part of it, and the next copy adds the whole file", async () => {
		const bucket = fresh("bucket");
		cpSync(join(ROOT, "tests", "samples", "scheduled"), bucket, { recursive: true });
		const repository = fresh("repository");
		const cut = underLimit(4, ["copy", bucket, repository]);
		expect(cut.error).toMatch(/^the copy job stopped and had added \d+ files? \(.*\) and overwrote nothing: 1 problem\n {2}runs\/2026\/11\/10\/[0-9a-f-]+\.json: writing stopped after 4096 of \d+ bytes: EFBIG: file too large, write; nothing was added$/);
		// Whatever it added is whole: each file the bucket's, byte for byte, and no temporary file.
		const added = filesUnder(repository);
		for (const key of added) expect(readFileSync(join(repository, key)).equals(readFileSync(join(bucket, key)))).toBe(true);
		expect(added.every((key) => !key.split("/").at(-1)?.startsWith("."))).toBe(true);

		const again = (await copyRuns(new DirectoryBucket(bucket), repository)) as { added: string[]; same: number };
		expect(again.same).toBe(added.length);
		const all = filesUnder(repository);
		expect(all).toEqual(filesUnder(bucket).filter((key) => key.startsWith("runs/") || key.startsWith("boots/")));
		for (const key of all) expect(readFileSync(join(repository, key)).equals(readFileSync(join(bucket, key)))).toBe(true);
	});
});

describe("addFile", () => {
	const bytes = new TextEncoder().encode(`${"0123456789abcdef".repeat(1000)}\n`);
	const key = "prices/2026/11/11/aws.json";

	test("writes every byte when each write takes only part of them", () => {
		const repository = fresh("repository");
		let calls = 0;
		const inPieces: Write = (descriptor, data, offset) => {
			calls++;
			return writeSync(descriptor, data, offset, Math.min(1000, data.length - offset));
		};
		expect(addFile(repository, key, bytes, inPieces)).toBe("added");
		expect(calls).toBe(Math.ceil(bytes.length / 1000));
		expect(readFileSync(join(repository, key)).equals(bytes)).toBe(true);
		expect(filesUnder(repository)).toEqual([key]);
	});

	test("adds nothing when the file read back is not what was written, even though every write said it wrote it all", () => {
		const repository = fresh("repository");
		// Claims each write took everything, and writes only half.
		const lying: Write = (descriptor, data, offset) => {
			writeSync(descriptor, data, offset, Math.floor((data.length - offset) / 2));
			return data.length - offset;
		};
		expect(() => addFile(repository, key, bytes, lying)).toThrow(ShortWrite);
		expect(() => addFile(repository, key, bytes, lying)).toThrow(`${key}: wrote ${bytes.length} bytes, and the file holds ${Math.floor(bytes.length / 2)}; nothing was added`);
		expect(filesUnder(repository)).toEqual([]);
		expect(existsSync(join(repository, key))).toBe(false);
	});

	test("adds nothing when the bytes read back differ, at the same length", () => {
		const repository = fresh("repository");
		const garbling: Write = (descriptor, data, offset) => {
			const wrong = Buffer.from(data.subarray(offset));
			wrong[0] = (wrong[0] as number) ^ 0xff;
			return writeSync(descriptor, wrong);
		};
		expect(() => addFile(repository, key, bytes, garbling)).toThrow(`${key}: read back, the file is not the ${bytes.length} bytes written (${bytes.length} bytes, different); nothing was added`);
		expect(filesUnder(repository)).toEqual([]);
	});

	test("adds nothing when a write writes nothing, or fails", () => {
		const repository = fresh("repository");
		expect(() => addFile(repository, key, bytes, () => 0)).toThrow(`${key}: a write of the remaining ${bytes.length} bytes wrote 0; nothing was added`);
		expect(() =>
			addFile(repository, key, bytes, () => {
				throw new Error("ENOSPC: no space left on device, write");
			}),
		).toThrow(`${key}: writing stopped after 0 of ${bytes.length} bytes: ENOSPC: no space left on device, write; nothing was added`);
		expect(filesUnder(repository)).toEqual([]);
	});
});
