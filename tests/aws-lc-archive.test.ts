import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// runner/aws-lc-archive.sh: the box fetches AWS-LC's source archive from the
// stage's bucket and checks it against the lock, and every way that fails
// leaves http_get without an archive, and nothing else.

const SCRIPT = join(import.meta.dir, "..", "runner", "aws-lc-archive.sh");
const BOX_SH = readFileSync(join(import.meta.dir, "..", "runner", "box.sh"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "aws-lc-archive-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ARCHIVE = "a stand-in for AWS-LC's source archive\n";
const SHA256 = createHash("sha256").update(ARCHIVE).digest("hex");

// A stand-in aws CLI: `aws s3 cp s3://<bucket>/<key> <file>` copies BUCKETS/<bucket>/<key>.
const AWS = `#!/bin/sh
echo "$*" >> "$STUB_LOG"
[ "$1 $2" = "s3 cp" ] || exit 2
key=\${4#s3://}
[ -f "$STUB_BUCKETS/$key" ] || { echo "fatal error: An error occurred (403) when calling the HeadObject operation: Forbidden" >&2; exit 1; }
cp "$STUB_BUCKETS/$key" "$5"
`;

interface Fetch {
	status: number | null;
	stdout: string;
	stderr: string;
	calls: string[];
	work: string[];
}

function fetch(name: string, setup: { lock?: string | null; blob?: string | null }): Fetch {
	const root = join(scratch, name);
	const src = join(root, "src");
	const work = join(root, "work");
	const buckets = join(root, "buckets");
	mkdirSync(join(src, "benchmarks", "harness", "c", "vendor"), { recursive: true });
	mkdirSync(work, { recursive: true });
	mkdirSync(join(buckets, "runs-bucket", "blobs", "sha256"), { recursive: true });
	mkdirSync(join(root, "bin"), { recursive: true });
	writeFileSync(join(root, "bin", "aws"), AWS);
	chmodSync(join(root, "bin", "aws"), 0o755);
	const lock = setup.lock === undefined ? `AWS_LC_VERSION := 5.14.0\nAWS_LC_SHA256 := ${SHA256}\n` : setup.lock;
	if (lock !== null) writeFileSync(join(src, "benchmarks", "harness", "c", "vendor", "aws-lc.lock"), lock);
	const blob = setup.blob === undefined ? ARCHIVE : setup.blob;
	if (blob !== null) writeFileSync(join(buckets, "runs-bucket", "blobs", "sha256", SHA256), blob);
	const log = join(root, "calls.log");
	const done = spawnSync("sh", [SCRIPT, src, work], {
		encoding: "utf8",
		env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, LEDGERMATH_BUCKET: "runs-bucket", STUB_BUCKETS: buckets, STUB_LOG: log },
	});
	return {
		status: done.status,
		stdout: done.stdout,
		stderr: done.stderr,
		calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
		work: readdirSync(work),
	};
}

describe("AWS-LC's source archive on the box", () => {
	test("is fetched from the bucket's blob of the lock's hash, checked, and its path printed", () => {
		const done = fetch("ok", {});
		expect(done.status).toBe(0);
		expect(done.calls).toEqual([`s3 cp --only-show-errors s3://runs-bucket/blobs/sha256/${SHA256} ${join(scratch, "ok", "work", `aws-lc-${SHA256}.tar.gz`)}.partial`]);
		expect(done.stdout).toBe(`${join(scratch, "ok", "work", `aws-lc-${SHA256}.tar.gz`)}\n`);
		expect(readFileSync(done.stdout.trim(), "utf8")).toBe(ARCHIVE);
		expect(done.stderr).toContain(`with the pinned sha256 ${SHA256}`);
	});

	for (const [name, setup, said] of [
		["missing", { blob: null }, `could not fetch AWS-LC's source archive, s3://runs-bucket/blobs/sha256/${SHA256}; http_get will not build`],
		["wrong", { blob: "other bytes\n" }, `has sha256 ${createHash("sha256").update("other bytes\n").digest("hex")}, and aws-lc.lock pins ${SHA256}; http_get will not build`],
		["no-lock", { lock: null }, "the source has no benchmarks/harness/c/vendor/aws-lc.lock, so no TLS library archive is fetched"],
		["bad-lock", { lock: "AWS_LC_SHA256 := 1234\n" }, "aws-lc.lock pins no 64-digit AWS_LC_SHA256; http_get will not build"],
	] as const) {
		test(`(${name}) gives no path, says why, and leaves no file behind`, () => {
			const done = fetch(name, setup);
			expect(done.status).toBe(1);
			expect(done.stdout).toBe("");
			expect(done.stderr).toContain(said);
			expect(done.work).toEqual([]);
		});
	}

	test("is what box.sh exports as AWS_LC_ARCHIVE for the builds, only when the fetch worked, with as many build jobs as CPUs", () => {
		expect(BOX_SH).toContain('if AWS_LC_ARCHIVE="$(sh "$SRC/runner/aws-lc-archive.sh" "$SRC" "$WORK")"; then export AWS_LC_ARCHIVE; fi');
		expect(BOX_SH).toContain('export AWS_LC_JOBS="$(nproc)"');
		// After the source is unpacked and checked, before run.py builds anything.
		const at = BOX_SH.indexOf("aws-lc-archive.sh");
		expect(at).toBeGreaterThan(BOX_SH.indexOf('tar -xzf "$ARCHIVE" -C "$SRC"'));
		expect(at).toBeLessThan(BOX_SH.indexOf('python3 "$SRC/runner/run.py"'));
	});

	test("is built with the packages box.sh installs: cmake and g++, and ethtool for the dump", () => {
		const install = /^dnf install -y (.*)$/m.exec(BOX_SH)?.[1]?.split(" ") ?? [];
		for (const name of ["gcc", "gcc-c++", "cmake", "make", "glibc-static", "ethtool"]) expect(install).toContain(name);
	});
});
