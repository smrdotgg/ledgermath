import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The disk Fixture: runner/fixture.c writes it at boot, and the disk benchmarks
// check what they read against the same pattern (benchmarks/harness/c/lm_fixture.h).
// Here the pattern is computed a second time, in BigInt arithmetic, from its
// definition: the 64-bit little-endian word at byte offset o is
// mix64(o ^ 0x8d6d2f9d5f9d1b37), mix64 being SplitMix64's finalizer.

const ROOT = join(import.meta.dir, "..");
const HARNESS = join(ROOT, "benchmarks", "harness", "c");
const MASK = (1n << 64n) - 1n;
const SEED = 0x8d6d2f9d5f9d1b37n;
const MIB = 1 << 20;

function mix64(value: bigint): bigint {
	let x = value & MASK;
	x ^= x >> 30n;
	x = (x * 0xbf58476d1ce4e5b9n) & MASK;
	x ^= x >> 27n;
	x = (x * 0x94d049bb133111ebn) & MASK;
	x ^= x >> 31n;
	return x;
}
const word = (offset: number): bigint => mix64(BigInt(offset) ^ SEED);

const scratch = mkdtempSync(join(tmpdir(), "fixture-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const tool = join(scratch, "fixture");
const sh = (command: string[], env?: Record<string, string>) =>
	spawnSync(command[0] as string, command.slice(1), { encoding: "utf8", env: env ?? process.env });

// Builds take seconds, and longer on a loaded machine: far more than bun's
// default five-second limit for a hook.
const BUILD_TIMEOUT_MS = 120_000;
/** A test that runs a binary or two under --quick. */
const RUN_TIMEOUT_MS = 60_000;

beforeAll(() => {
	const built = sh(["cc", "-O2", "-Wall", "-Wextra", "-Werror", "-I", HARNESS, "-o", tool, join(ROOT, "runner", "fixture.c")]);
	if (built.status !== 0) throw new Error(`runner/fixture.c did not build:\n${built.stderr}`);
}, BUILD_TIMEOUT_MS);

describe("runner/fixture.c", () => {
	test("writes the pattern, every word of it, and says what it did", () => {
		const path = join(scratch, "two-mib");
		const done = sh([tool, path, String(2 * MIB)]);
		expect(done.stderr).toBe("");
		expect(done.status).toBe(0);
		const said = JSON.parse(done.stdout) as Record<string, unknown>;
		expect(said).toMatchObject({ path, bytes: 2 * MIB, write_bytes: MIB, writes: 2, o_direct: true, pattern: "mix64(offset ^ 0x8d6d2f9d5f9d1b37)" });
		for (const key of ["seconds_writing", "seconds_fdatasync", "bytes_per_second_writing", "fiemap", "resident_pages", "device"]) expect(said).toHaveProperty(key);
		const bytes = readFileSync(path);
		expect(bytes.length).toBe(2 * MIB);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		for (let offset = 0; offset < bytes.length; offset += 8) {
			if (view.getBigUint64(offset, true) !== word(offset)) throw new Error(`word at ${offset} differs from the pattern`);
		}
		// Spot values, so the pattern itself cannot drift unnoticed.
		expect(view.getBigUint64(0, true)).toBe(mix64(SEED));
		expect(`0x${view.getBigUint64(8, true).toString(16).padStart(16, "0")}`).toBe(`0x${word(8).toString(16).padStart(16, "0")}`);
	}, RUN_TIMEOUT_MS);

	test("is July's io_uring pattern", () => {
		const july = readFileSync(join(ROOT, "benchmarks", "c", "bench_disk_read_io_uring.c"), "utf8");
		const header = readFileSync(join(HARNESS, "lm_fixture.h"), "utf8");
		expect(july).toContain("#define PATTERN_SEED        0x8d6d2f9d5f9d1b37ULL");
		expect(header).toContain("#define LM_FIXTURE_SEED 0x8d6d2f9d5f9d1b37ULL");
		for (const constant of ["0xbf58476d1ce4e5b9ULL", "0x94d049bb133111ebULL"]) {
			expect(july).toContain(constant);
			expect(header).toContain(constant);
		}
	}, RUN_TIMEOUT_MS);

	test("never overwrites a file, takes whole MiB only, and leaves nothing behind when it fails", () => {
		const path = join(scratch, "exists");
		expect(sh([tool, path, String(MIB)]).status).toBe(0);
		const again = sh([tool, path, String(MIB)]);
		expect(again.status).toBe(1);
		expect(again.stderr).toContain("cannot create");
		expect(sh([tool, join(scratch, "odd"), "1000"]).status).toBe(2);
		expect(sh([tool, join(scratch, "zero"), "0"]).status).toBe(2);
		expect(existsSync(join(scratch, "odd"))).toBe(false);
	}, RUN_TIMEOUT_MS);
});

describe("a disk benchmark checks the Fixture outside its measured interval", () => {
	const binary = join(ROOT, "benchmarks", "disk_read_random", "build", "dynamic", "disk_read_random");
	beforeAll(() => {
		const built = sh(["make", "--no-print-directory", "-s", "-C", join(ROOT, "benchmarks", "disk_read_random"), "-B", "BUILD=dynamic"]);
		if (built.status !== 0) throw new Error(`disk_read_random did not build:\n${built.stdout}${built.stderr}`);
	}, BUILD_TIMEOUT_MS);
	const run = (dir: string, span: number) =>
		sh([binary, "--quick"], { LM_PARAM_DIR: dir, LM_PARAM_REQUEST_BYTES: "8192", LM_PARAM_SPAN_BYTES: String(span) });
	const fixtureIn = (name: string, bytes: number): string => {
		const dir = join(scratch, name);
		spawnSync("mkdir", ["-p", dir]);
		const made = sh([tool, join(dir, "ledgermath-fixture-v1"), String(bytes)]);
		if (made.status !== 0) throw new Error(made.stderr);
		return dir;
	};
	const corrupt = (dir: string, offset: number): void => {
		const fd = openSync(join(dir, "ledgermath-fixture-v1"), "r+");
		writeSync(fd, Buffer.alloc(8), 0, 8, offset);
		closeSync(fd);
	};

	test("reads a good one, and its stream says which file and device it found", () => {
		const done = run(fixtureIn("good", 4 * MIB), 4 * MIB);
		expect(done.status).toBe(0);
		const observed = done.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.event === "observed");
		expect(observed.values.file_path).toBe(join(scratch, "good", "ledgermath-fixture-v1"));
		expect(observed.values.span_bytes).toBe(4 * MIB);
		expect(observed.values.o_direct).toBe(true);
		expect(observed.values).toHaveProperty("device_found");
		const check = spawnSync("python3", [join(ROOT, "scripts", "check-events.py"), "--quick"], { input: done.stdout, encoding: "utf8" });
		expect(check.status).toBe(0);
	}, RUN_TIMEOUT_MS);

	test("exits 1 when there is none, saying where it comes from", () => {
		const done = run(join(scratch, "empty-dir"), 4 * MIB);
		expect(done.status).toBe(1);
		expect(done.stderr).toContain("cannot open the Fixture");
		expect(done.stderr).toContain("runner/provision.py");
		expect(done.stdout).not.toContain('"event":"observed"');
	}, RUN_TIMEOUT_MS);

	test("exits 1 when it is shorter than the span", () => {
		const done = run(fixtureIn("short", 2 * MIB), 4 * MIB);
		expect(done.status).toBe(1);
		expect(done.stderr).toContain("fewer than the span");
	}, RUN_TIMEOUT_MS);

	test("exits 1, before measuring, when a block it checks is not the pattern", () => {
		const dir = fixtureIn("bad-middle", 4 * MIB);
		corrupt(dir, 2 * MIB + 64); // inside the middle block of the span
		const done = run(dir, 4 * MIB);
		expect(done.status).toBe(1);
		expect(done.stderr).toContain("not the pattern's");
		expect(done.stdout).not.toContain("sample_started");
	}, RUN_TIMEOUT_MS);

	test("exits 1, after measuring, when a block it read held something else: the checksum is the elision guard", () => {
		// A span of 128 blocks, so the warmup alone reads every block whatever the disk.
		const dir = fixtureIn("bad-elsewhere", MIB);
		corrupt(dir, 8192 * 7); // the first word of block 7, which the checks before measuring do not read
		const done = run(dir, MIB);
		expect(done.status).toBe(1);
		expect(done.stderr).toContain("the Fixture's pattern at those offsets sums to");
		expect(done.stdout).toContain('"event":"verified"');
		expect(done.stdout).not.toContain('"event":"finished"');
	}, RUN_TIMEOUT_MS);
});
