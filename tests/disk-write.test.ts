import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// disk_write creates its scratch file exclusively, never through a symbolic
// link, and touches nothing when the name exists in any form. It runs as root
// on the box, so a link planted at its name must not let it overwrite another
// file.

const ROOT = join(import.meta.dir, "..");
const NAME = "ledgermath-disk_write.scratch";
const binary = join(ROOT, "benchmarks", "disk_write", "build", "dynamic", "disk_write");
/** Builds, and runs of the binary under --quick, take seconds; longer on a loaded machine. */
const RUN_TIMEOUT_MS = 60_000;
const scratch = mkdtempSync(join(tmpdir(), "disk-write-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

beforeAll(() => {
	const built = spawnSync("make", ["--no-print-directory", "-s", "-C", join(ROOT, "benchmarks", "disk_write"), "-B", "BUILD=dynamic"], { encoding: "utf8" });
	if (built.status !== 0) throw new Error(`disk_write did not build:\n${built.stdout}${built.stderr}`);
}, 2 * RUN_TIMEOUT_MS);

let cases = 0;
function directory(): string {
	const dir = join(scratch, `case-${cases++}`);
	mkdirSync(dir);
	return dir;
}
const run = (dir: string) => spawnSync(binary, ["--quick"], { encoding: "utf8", env: { LM_PARAM_DIR: dir } });

describe("disk_write's scratch file", () => {
	test("is made, written and removed when nothing has its name", () => {
		const dir = directory();
		const done = run(dir);
		expect(done.status).toBe(0);
		expect(done.stdout).toContain('"event":"finished"');
		expect(readdirSync(dir)).toEqual([]);
	}, RUN_TIMEOUT_MS);

	test("is never made through a symbolic link: the file it points to is untouched, and so is the link", () => {
		const dir = directory();
		const sentinel = join(scratch, `sentinel-${cases}`);
		writeFileSync(sentinel, "sentinel: do not overwrite\n");
		symlinkSync(sentinel, join(dir, NAME));
		const done = run(dir);
		expect(done.status).toBe(1);
		expect(done.stderr).toContain("exists already");
		expect(done.stdout).not.toContain("sample_started");
		expect(readFileSync(sentinel, "utf8")).toBe("sentinel: do not overwrite\n");
		expect(lstatSync(join(dir, NAME)).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(dir, NAME))).toBe(sentinel);
	}, RUN_TIMEOUT_MS);

	test("is never made through a dangling symbolic link: nothing appears where it points", () => {
		const dir = directory();
		const target = join(scratch, `nowhere-${cases}`);
		symlinkSync(target, join(dir, NAME));
		expect(run(dir).status).toBe(1);
		expect(existsSync(target)).toBe(false);
		expect(lstatSync(join(dir, NAME)).isSymbolicLink()).toBe(true);
	}, RUN_TIMEOUT_MS);

	test("refuses a file already there, a leftover included, and leaves it as it is", () => {
		const dir = directory();
		writeFileSync(join(dir, NAME), "leftover\n");
		expect(run(dir).status).toBe(1);
		expect(readFileSync(join(dir, NAME), "utf8")).toBe("leftover\n");
	}, RUN_TIMEOUT_MS);

	test("refuses a directory of that name, and leaves it", () => {
		const dir = directory();
		mkdirSync(join(dir, NAME));
		writeFileSync(join(dir, NAME, "inside"), "x");
		expect(run(dir).status).toBe(1);
		expect(readdirSync(join(dir, NAME))).toEqual(["inside"]);
	}, RUN_TIMEOUT_MS);

	test("says so when its directory does not exist, and makes nothing", () => {
		const dir = join(scratch, "no-such-directory");
		const done = run(dir);
		expect(done.status).toBe(1);
		expect(done.stderr).toContain("cannot open the directory");
		expect(existsSync(dir)).toBe(false);
	}, RUN_TIMEOUT_MS);
});
