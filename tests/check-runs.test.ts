import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkBucketDirectory, readTarGz } from "../scripts/check-runs";

/** Checking runs check-events.py once per Run, and git or tar runs as processes: seconds, more on a loaded machine. */
const SUBPROCESS_TIMEOUT_MS = 60_000;

const ROOT = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "check-runs-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

describe("reading a source archive", () => {
	test("gives back every file of runner/ in a git archive, byte for byte", () => {
		const archive = execFileSync("git", ["archive", "--format=tar.gz", "HEAD", "runner"], { cwd: ROOT });
		const files = readTarGz(archive);
		const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "runner"], { cwd: ROOT, encoding: "utf8" })
			.split("\n")
			.filter(Boolean);
		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) {
			const committed = execFileSync("git", ["show", `HEAD:${path}`], { cwd: ROOT });
			expect(files.get(path)?.equals(committed)).toBe(true);
		}
	}, SUBPROCESS_TIMEOUT_MS);
});

/** A bucket directory holding one Run whose runner manifest is `manifest`. */
function bucketWithOneRun(name: string, manifest: (files: Map<string, string>) => string, keepSource = true) {
	const directory = join(scratch, name);
	const source = join(directory, "source-tree");
	mkdirSync(join(source, "runner"), { recursive: true });
	const runnerFiles = new Map([
		["run.py", "print('a runner')\n"],
		["box.sh", "#!/bin/sh\necho a box\n"],
	]);
	for (const [path, text] of runnerFiles) writeFileSync(join(source, "runner", path), text);
	const archive = execFileSync("tar", ["--format=pax", "-czf", "-", "-C", source, "runner"]);

	const blobDirectory = join(directory, "blobs", "sha256");
	mkdirSync(blobDirectory, { recursive: true });
	const put = (bytes: Buffer | string): string => {
		const hex = sha256(bytes);
		writeFileSync(join(blobDirectory, hex), bytes);
		return `sha256:${hex}`;
	};
	const sourceHash = keepSource ? put(archive) : `sha256:${sha256(archive)}`;
	const dump = put(`${JSON.stringify({ schema: "ledgermath.dump/1", taken_at: "2026-11-10T21:00:00.000000000Z", sections: {} })}\n`);
	const empty = put("");
	const run = {
		schema: "ledgermath.run/1",
		id: "01a1c756-eab7-7222-be66-991b66fa0336",
		boot: "a-boot",
		started_at: "2026-11-10T21:00:00.000000000Z",
		ended_at: "2026-11-10T21:00:01.000000000Z",
		benchmark: "memory_read",
		params: {},
		samples: 1,
		source_commit: "0".repeat(40),
		source: sourceHash,
		binary: { blob: put("a binary"), build: "static", compiler: "cc", command: "cc", resolved_flags: empty },
		provider: { name: "aws" },
		environment: { before: dump, after: dump },
		runner: put(manifest(new Map([...runnerFiles].map(([path, text]) => [path, sha256(text)])))),
		exit: { code: 2 },
		events: [],
		stdout: empty,
		stderr: empty,
	};
	mkdirSync(join(directory, "runs", "2026", "11", "10"), { recursive: true });
	writeFileSync(join(directory, "runs", "2026", "11", "10", `${run.id}.json`), JSON.stringify(run));
	return { directory, sourceHash };
}

const listing = (files: Map<string, string>): string =>
	[...files]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([path, hash]) => `${hash}  ${path}\n`)
		.join("");

describe("the runner manifest", () => {
	test("is checked against the source archive when the archive is there", () => {
		const { directory } = bucketWithOneRun("good", listing);
		const result = checkBucketDirectory(directory, { blobs: true });
		expect(result.problems).toEqual([]);
		expect(result.manifests).toEqual({ checked: 1, unchecked: 0 });
	}, SUBPROCESS_TIMEOUT_MS);

	test("that names a wrong hash, or misses a file, is a problem", () => {
		// Lists run.py with a hash that is not its own, and leaves box.sh out.
		const { directory } = bucketWithOneRun("wrong", () => `${"f".repeat(64)}  run.py\n`);
		const problems = checkBucketDirectory(directory, { blobs: true }).problems.join("\n");
		expect(problems).toContain("run.py: listed as");
		expect(problems).toContain("does not list runner/box.sh");
	}, SUBPROCESS_TIMEOUT_MS);

	test("is counted as not checked when the source archive was left out", () => {
		const { directory, sourceHash } = bucketWithOneRun("omitted", listing, false);
		const result = checkBucketDirectory(directory, { blobs: true, omitted: new Set([sourceHash]) });
		expect(result.problems).toEqual([]);
		expect(result.manifests).toEqual({ checked: 0, unchecked: 1 });
	}, SUBPROCESS_TIMEOUT_MS);
});
