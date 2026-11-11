import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { copyRuns, CopyRefused } from "../scripts/copy-runs";
import { type Bucket, type BucketObject, DirectoryBucket, etagMd5 } from "../scripts/lib/bucket";

const SAMPLE = join(import.meta.dir, "samples", "scheduled");
const scratch = mkdtempSync(join(tmpdir(), "copy-runs-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let made = 0;
/** A copy of the scheduled sample, laid out like the bucket, and an empty git repository. */
function setUp(): { bucketDirectory: string; repository: string } {
	const here = join(scratch, String(made++));
	const bucketDirectory = join(here, "bucket");
	cpSync(SAMPLE, bucketDirectory, { recursive: true });
	const repository = join(here, "ledgermath-runs");
	mkdirSync(repository, { recursive: true });
	execFileSync("git", ["init", "-q", repository]);
	writeFileSync(join(repository, "README.md"), "The Runs.\n");
	return { bucketDirectory, repository };
}

function filesUnder(root: string, part: string): string[] {
	const directory = join(root, part);
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();
}

describe("the copy job", () => {
	test("adds every Run file and boot summary, byte for byte, under the bucket's paths, and no blob", async () => {
		const { bucketDirectory, repository } = setUp();
		const result = await copyRuns(new DirectoryBucket(bucketDirectory), repository);
		const expected = [...filesUnder(bucketDirectory, "boots"), ...filesUnder(bucketDirectory, "runs")].sort();
		expect(expected.length).toBe(9);
		expect(result.added).toEqual(expected);
		expect(result.same).toBe(0);
		for (const key of expected) {
			expect(readFileSync(join(repository, key)).equals(readFileSync(join(bucketDirectory, key)))).toBe(true);
		}
		expect(existsSync(join(repository, "blobs"))).toBe(false);
		expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("The Runs.\n");
	});

	test("run twice, adds nothing the second time", async () => {
		const { bucketDirectory, repository } = setUp();
		const bucket = new DirectoryBucket(bucketDirectory);
		await copyRuns(bucket, repository);
		const again = await copyRuns(bucket, repository);
		expect(again.added).toEqual([]);
		expect(again.same).toBe(9);
	});

	test("adds only what is new", async () => {
		const { bucketDirectory, repository } = setUp();
		const bucket = new DirectoryBucket(bucketDirectory);
		await copyRuns(bucket, repository);
		const key = "runs/2026/11/11/01a1c7aa-0000-7000-8000-000000000000.json";
		mkdirSync(join(bucketDirectory, "runs/2026/11/11"), { recursive: true });
		writeFileSync(join(bucketDirectory, key), '{"a": "new Run file"}\n');
		const result = await copyRuns(bucket, repository);
		expect(result.added).toEqual([key]);
		expect(result.same).toBe(9);
	});

	test("refuses a file that differs from the bucket's, loudly, and writes nothing", async () => {
		const { bucketDirectory, repository } = setUp();
		const bucket = new DirectoryBucket(bucketDirectory);
		await copyRuns(bucket, repository);
		const [changed] = filesUnder(repository, "runs");
		writeFileSync(join(repository, changed as string), `${readFileSync(join(repository, changed as string), "utf8")} `);
		const newKey = "boots/2026/11/11/a-new-boot.json";
		mkdirSync(join(bucketDirectory, "boots/2026/11/11"), { recursive: true });
		writeFileSync(join(bucketDirectory, newKey), "{}\n");
		const before = filesUnder(repository, "runs").length + filesUnder(repository, "boots").length;

		const refused = await copyRuns(bucket, repository).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(CopyRefused);
		expect((refused as CopyRefused).problems).toEqual([`${changed}: the repository's file differs from the bucket's`]);
		expect((refused as Error).message).toContain("wrote nothing");
		expect(existsSync(join(repository, newKey))).toBe(false);
		expect(filesUnder(repository, "runs").length + filesUnder(repository, "boots").length).toBe(before);
	});

	test("refuses a same-sized file with other bytes", async () => {
		const { bucketDirectory, repository } = setUp();
		const bucket = new DirectoryBucket(bucketDirectory);
		await copyRuns(bucket, repository);
		const [changed] = filesUnder(repository, "boots");
		const text = readFileSync(join(repository, changed as string), "utf8");
		writeFileSync(join(repository, changed as string), text.replace('"runs"', '"rUns"'));
		expect(copyRuns(bucket, repository)).rejects.toThrow("differs from the bucket's");
	});

	test("refuses a key under runs/ or boots/ that is not shaped like one", async () => {
		const { bucketDirectory, repository } = setUp();
		writeFileSync(join(bucketDirectory, "runs", "../runs/stray.txt"), "?");
		expect(copyRuns(new DirectoryBucket(bucketDirectory), repository)).rejects.toThrow("runs/stray.txt: not shaped like");
		expect(filesUnder(repository, "runs")).toEqual([]);
	});

	test("compares the bytes themselves when the bucket's ETag is not an MD5", async () => {
		const { bucketDirectory, repository } = setUp();
		const directory = new DirectoryBucket(bucketDirectory);
		const noMd5: Bucket = {
			name: "no-md5",
			list: async (prefix: string): Promise<BucketObject[]> => (await directory.list(prefix)).map((o) => ({ ...o, md5: null })),
			get: (key: string) => directory.get(key),
		};
		await copyRuns(noMd5, repository);
		expect((await copyRuns(noMd5, repository)).same).toBe(9);
		const [changed] = filesUnder(repository, "runs");
		const text = readFileSync(join(repository, changed as string), "utf8");
		writeFileSync(join(repository, changed as string), text.replace("memory_read", "memory_reaD"));
		expect(copyRuns(noMd5, repository)).rejects.toThrow("differs from the bucket's");
	});

	test("reads an ETag as an MD5 only when it is one", () => {
		expect(etagMd5('"e02223596ada0ea79059ff000233649c"')).toBe("e02223596ada0ea79059ff000233649c");
		expect(etagMd5('"e02223596ada0ea79059ff000233649c-2"')).toBeNull(); // multipart
		expect(etagMd5(undefined)).toBeNull();
	});
});
