import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { copyRuns, CopyRefused } from "../scripts/copy-runs";
import { type Bucket, type BucketObject, DirectoryBucket, etagHex } from "../scripts/lib/bucket";

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

	test("compares the bytes themselves when the bucket's ETag has no MD5's shape", async () => {
		const { bucketDirectory, repository } = setUp();
		const directory = new DirectoryBucket(bucketDirectory);
		const noEtag: Bucket = {
			name: "no-etag",
			list: async (prefix: string): Promise<BucketObject[]> => (await directory.list(prefix)).map((o) => ({ ...o, etag: null })),
			get: (key: string) => directory.get(key),
		};
		await copyRuns(noEtag, repository);
		expect((await copyRuns(noEtag, repository)).same).toBe(9);
		const [changed] = filesUnder(repository, "runs");
		const text = readFileSync(join(repository, changed as string), "utf8");
		writeFileSync(join(repository, changed as string), text.replace("memory_read", "memory_reaD"));
		expect(copyRuns(noEtag, repository)).rejects.toThrow("differs from the bucket's");
	});

	test("an ETag shaped like an MD5 that is not one (SSE-KMS) does not make identical bytes differ", async () => {
		const { bucketDirectory, repository } = setUp();
		const directory = new DirectoryBucket(bucketDirectory);
		let downloads = 0;
		const kms: Bucket = {
			name: "sse-kms",
			list: async (prefix: string): Promise<BucketObject[]> =>
				(await directory.list(prefix)).map((o) => ({ ...o, etag: createHash("md5").update(`not the bytes of ${o.key}`).digest("hex") })),
			get: async (key: string) => {
				downloads++;
				return directory.get(key);
			},
		};
		expect((await copyRuns(kms, repository)).added.length).toBe(9);
		downloads = 0;
		const again = await copyRuns(kms, repository);
		expect(again).toEqual({ added: [], same: 9 });
		expect(downloads).toBe(9); // each mismatch was settled by comparing the bytes
		const [changed] = filesUnder(repository, "boots");
		const text = readFileSync(join(repository, changed as string), "utf8");
		writeFileSync(join(repository, changed as string), text.replace('"runs"', '"rUns"'));
		expect(copyRuns(kms, repository)).rejects.toThrow(`${changed}: the repository's file differs from the bucket's`);
	});

	test("an ETag that matches the file's MD5 is enough: nothing is downloaded to compare", async () => {
		const { bucketDirectory, repository } = setUp();
		const directory = new DirectoryBucket(bucketDirectory);
		let downloads = 0;
		const counting: Bucket = { name: "counting", list: (prefix) => directory.list(prefix), get: async (key) => (downloads++, directory.get(key)) };
		await copyRuns(counting, repository);
		downloads = 0;
		expect((await copyRuns(counting, repository)).same).toBe(9);
		expect(downloads).toBe(0);
	});

	test("reads an ETag's hex only when it has an MD5's shape", () => {
		expect(etagHex('"e02223596ada0ea79059ff000233649c"')).toBe("e02223596ada0ea79059ff000233649c");
		expect(etagHex('"e02223596ada0ea79059ff000233649c-2"')).toBeNull(); // multipart
		expect(etagHex(undefined)).toBeNull();
	});
});

describe("the copy job on the filesystem", () => {
	test("refuses a symlinked directory in the repository, loudly, before writing anything anywhere", async () => {
		const { bucketDirectory, repository } = setUp();
		const outside = join(scratch, `outside-${made}`);
		mkdirSync(outside);
		symlinkSync(outside, join(repository, "runs"));
		const refused = await copyRuns(new DirectoryBucket(bucketDirectory), repository).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(CopyRefused);
		expect((refused as CopyRefused).problems.length).toBe(8);
		expect((refused as CopyRefused).problems[0]).toContain("runs is a symbolic link");
		expect((refused as Error).message).toContain("wrote nothing");
		expect(readdirSync(outside)).toEqual([]);
		expect(existsSync(join(repository, "boots"))).toBe(false);
	});

	test("refuses a Run file that is a symbolic link, without reading through it", async () => {
		const { bucketDirectory, repository } = setUp();
		const [key] = filesUnder(bucketDirectory, "runs");
		const victim = join(scratch, `victim-read-${made}`);
		writeFileSync(victim, readFileSync(join(bucketDirectory, key as string)));
		mkdirSync(join(repository, "runs/2026/11/10"), { recursive: true });
		symlinkSync(victim, join(repository, key as string));
		expect(copyRuns(new DirectoryBucket(bucketDirectory), repository)).rejects.toThrow(`${key} is a symbolic link`);
		expect(existsSync(join(repository, "boots"))).toBe(false);
	});

	test("never writes through a predictable temporary name: a <destination>.tmp link is left alone", async () => {
		const { bucketDirectory, repository } = setUp();
		const keys = filesUnder(bucketDirectory, "runs");
		const victim = join(scratch, `victim-tmp-${made}`);
		writeFileSync(victim, "an unrelated file\n");
		mkdirSync(join(repository, "runs/2026/11/10"), { recursive: true });
		for (const key of keys) symlinkSync(victim, join(repository, `${key}.tmp`));
		const result = await copyRuns(new DirectoryBucket(bucketDirectory), repository);
		expect(result.added.length).toBe(9);
		expect(readFileSync(victim, "utf8")).toBe("an unrelated file\n");
		for (const key of keys) {
			expect(readFileSync(join(repository, key)).equals(readFileSync(join(bucketDirectory, key)))).toBe(true);
			expect(lstatSync(join(repository, key)).isSymbolicLink()).toBe(false);
		}
		// Nothing of its own left behind.
		expect(readdirSync(join(repository, "runs/2026/11/10")).filter((name) => name.endsWith(".partial"))).toEqual([]);
	});

	test("fails, and does not overwrite, when a destination appears while the copy downloads", async () => {
		const { bucketDirectory, repository } = setUp();
		const directory = new DirectoryBucket(bucketDirectory);
		const [first, second] = filesUnder(bucketDirectory, "runs");
		const racing: Bucket = {
			name: "racing",
			list: (prefix) => directory.list(prefix),
			get: async (key) => {
				if (key === second) {
					mkdirSync(join(repository, "runs/2026/11/10"), { recursive: true });
					writeFileSync(join(repository, key), "written by someone else\n");
				}
				return directory.get(key);
			},
		};
		const refused = await copyRuns(racing, repository).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(CopyRefused);
		expect((refused as CopyRefused).problems).toEqual([`${second}: a file of that name appeared in the repository while the copy ran; it was left as it is`]);
		expect(readFileSync(join(repository, second as string), "utf8")).toBe("written by someone else\n");
		// Files before it in key order were added, and the message says which.
		expect((refused as CopyRefused).added).toContain(first as string);
		expect((refused as Error).message).toContain("overwrote nothing");
	});
});
