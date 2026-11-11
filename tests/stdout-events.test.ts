import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readStream } from "../methods/run";
import { derive, gather, serialize } from "../methods/v1";
import { checkBucketDirectory, type RunRecord } from "../scripts/check-runs";
import { blobsFromDirectories } from "../scripts/lib/blobs";
import { readRunFiles } from "../scripts/lib/run-files";
import { HandMade } from "./hand-made-runs";

// The stdout blob is every Run's events. runner/run.py copies none of them
// into the Run: it names the blob, with its size and lines. Every reader reads
// the blob, for every Run, the Runs written before this change included,
// which still carry events (and, had one failed to parse, events_error).

const SAMPLES = join(import.meta.dir, "samples");
/** The sample directories recorded before the change: their Runs carry events. */
const OLDER = ["scheduled", "interrupted", "failures", "service"];
const scratch = mkdtempSync(join(tmpdir(), "stdout-events-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const SLOW = 120_000;

interface RunFileText {
	path: string;
	text: string;
	run: RunRecord;
}
function runFiles(root: string): RunFileText[] {
	return readdirSync(join(root, "runs"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => {
			const path = join(entry.parentPath, entry.name);
			const text = readFileSync(path, "utf8");
			return { path, text, run: JSON.parse(text) as RunRecord };
		})
		.sort((a, b) => a.run.started_at.localeCompare(b.run.started_at));
}
const blobOf = (root: string, hash: string): Buffer => readFileSync(join(root, "blobs", "sha256", hash.replace("sha256:", "")));

/** tests/service-runs.py run in a case: its output directory. */
function harness(name: string): string {
	const directory = join(scratch, name);
	const done = spawnSync("python3", [join(import.meta.dir, "service-runs.py"), name, directory], { encoding: "utf8", timeout: SLOW });
	if (done.status !== 0) throw new Error(`service-runs.py ${name} failed:\n${done.stdout}${done.stderr}`);
	return join(directory, "out");
}

describe("runner/run.py", () => {
	test("copies no event into a Run: it names the stdout blob, with the blob's bytes and lines", () => {
		const out = harness("keys");
		for (const { run } of runFiles(out)) {
			expect(run.events).toBeUndefined();
			expect(run.events_error).toBeUndefined();
			const stdout = blobOf(out, run.stdout);
			expect(run.stdout_bytes).toBe(stdout.length);
			expect(run.stdout_lines).toBe(readStream(stdout).lines);
			expect(readStream(stdout).events.length).toBe(6);
		}
	}, SLOW);

	test("keeps the record's order: the two facts follow stdout where events stood before it", () => {
		const [now] = runFiles(join(SAMPLES, "stdout-only"));
		const [before] = runFiles(join(SAMPLES, "scheduled"));
		const order = Object.keys(before?.run ?? {}).filter((key) => key !== "events");
		order.splice(order.indexOf("stdout") + 1, 0, "stdout_bytes", "stdout_lines");
		expect(Object.keys(now?.run ?? {}).filter((key) => key !== "service")).toEqual(order);
	});

	test("writes a Run whose stdout holds a line that is not JSON whole, and leaves the finding to its readers", () => {
		const out = harness("text");
		const [plain, text] = runFiles(out) as [RunFileText, RunFileText];
		expect(plain.run.stdout_lines).toBe(6);
		expect(text.run.stdout_lines).toBe(7);
		expect(text.run.events_error).toBeUndefined();
		expect(readStream(blobOf(out, text.run.stdout)).error).toEqual({ line: 5, message: "not JSON" });
		// The checker finds it: the binary exited 0 with a stream that is not one.
		const problems = checkBucketDirectory(out, { blobs: true }).problems;
		expect(problems.length).toBe(1);
		expect(problems[0]).toContain("check-events.py: line 5: not JSON");
	}, SLOW);
});

describe("the Run checker reads every Run's stream from its stdout blob", () => {
	test("Runs of both shapes check out, the older ones' events equal to their blobs", () => {
		for (const directory of [...OLDER.slice(0, 1), "stdout-only"]) {
			const result = checkBucketDirectory(join(SAMPLES, directory), { blobs: true, omitted: omitted(directory) });
			expect(result.problems).toEqual([]);
			expect(result.events).toBeGreaterThan(0);
		}
	}, SLOW);

	/** A copy of a sample directory with one Run file rewritten, and what the checker says of it. */
	function problemsAfter(directory: string, name: string, change: (run: RunRecord, root: string) => RunRecord): string[] {
		const root = join(scratch, name);
		cpSync(join(SAMPLES, directory), root, { recursive: true });
		const [first] = runFiles(root);
		if (!first) throw new Error(`no Run in ${directory}`);
		writeFileSync(first.path, JSON.stringify(change(first.run, root)));
		return checkBucketDirectory(root, { blobs: true, omitted: omitted(directory) }).problems;
	}

	test("an older Run whose events are not its blob's is a problem", () => {
		const problems = problemsAfter("scheduled", "older-differs", (run) => ({ ...run, events: (run.events ?? []).slice(0, -1) }));
		expect(problems.some((problem) => problem.includes("its events are not its stdout's, line for line"))).toBe(true);
	}, SLOW);

	test("an older Run whose events_error names another line than the blob stops at is a problem", () => {
		const problems = problemsAfter("scheduled", "older-error", (run) => ({ ...run, events_error: { line: 3, message: "not JSON" } }));
		expect(problems.some((problem) => problem.includes("its events_error names line 3; its stdout stops parsing at no line"))).toBe(true);
	}, SLOW);

	test("a Run whose stdout_bytes or stdout_lines is not its blob's is a problem", () => {
		const problems = problemsAfter("stdout-only", "wrong-lines", (run) => ({ ...run, stdout_lines: (run.stdout_lines ?? 0) + 1 }));
		expect(problems.some((problem) => problem.includes("says its stdout is"))).toBe(true);
	}, SLOW);

	test("an event in a stdout blob that breaks the events schema is a problem", () => {
		const problems = problemsAfter("stdout-only", "bad-event", (run, root) => {
			const text = blobOf(root, run.stdout).toString("utf8").replace('"warmup":false', '"warmup":"no"');
			const hash = createHash("sha256").update(text).digest("hex");
			writeFileSync(join(root, "blobs", "sha256", hash), text);
			return { ...run, stdout: `sha256:${hash}`, stdout_bytes: Buffer.byteLength(text) };
		});
		expect(problems.some((problem) => problem.includes("stdout line 3: /warmup must be boolean"))).toBe(true);
	}, SLOW);
});

function omitted(directory: string): Set<string> {
	try {
		return new Set((JSON.parse(readFileSync(join(SAMPLES, directory, "omitted-blobs.json"), "utf8")) as Array<{ blob: string }>).map((entry) => entry.blob));
	} catch {
		return new Set();
	}
}

describe("Method version 1 reads every Run's events from its stdout blob", () => {
	test("and gives, byte for byte, what it gave when it read the older sample Runs' events from their records", async () => {
		// tests/samples/older-shape-derivations.json is version 1's output for these
		// Runs, made by its code before this change, which read run.events.
		const directory = join(scratch, "older-samples");
		for (const sample of OLDER) cpSync(join(SAMPLES, sample, "runs"), join(directory, "runs"), { recursive: true });
		const runs = readRunFiles(directory);
		const blobs = await gather(runs, blobsFromDirectories(OLDER.map((sample) => join(SAMPLES, sample, "blobs"))));
		expect(runs.length).toBe(15);
		expect(serialize(derive(runs, blobs))).toBe(readFileSync(join(SAMPLES, "older-shape-derivations.json"), "utf8"));
	}, SLOW);

	test("and counts a Run of the new shape exactly as the same Run of the older shape", async () => {
		const older = new HandMade();
		const newer = new HandMade();
		const options = { startedAt: "2026-11-11T22:15:00Z", samplesNs: [5, 3, 4, 9, 1].map((n) => n * 1_000_000), boot: "one" };
		const a = older.run({ ...options, eventsInside: true });
		const b = newer.run(options);
		expect(a.events?.length).toBeGreaterThan(0);
		expect(b.events).toBeUndefined();
		const points = async (made: HandMade) => derive(made.files, await gather(made.files, made.fetch)).derivations[0]?.points;
		const [x, y] = await Promise.all([points(older), points(newer)]);
		expect(x?.[0]?.counted).toBe(true);
		expect({ ...y?.[0], path: "", run: "" }).toEqual({ ...x?.[0], path: "", run: "" });
	});

	test("and fetches each Run's stdout, the one blob per Run it did not fetch before", async () => {
		const made = new HandMade();
		const run = made.run({ startedAt: "2026-11-11T22:15:00Z" });
		const asked = new Set<string>();
		await gather(made.files, async (hash) => (asked.add(hash), made.fetch(hash)));
		expect(asked.has(run.stdout)).toBe(true);
		expect(asked.has(run.environment.before) && asked.has(run.environment.after)).toBe(true);
	});

	test("and keeps no stdout in memory: each is read, summarised and let go, a few at a time", async () => {
		const made = new HandMade();
		const runs = Array.from({ length: 12 }, (_, i) => made.run({ startedAt: `2026-11-11T22:${String(10 + i).padStart(2, "0")}:00Z` }));
		const stdouts = new Set(runs.map((run) => run.stdout));
		let inFlight = 0;
		let most = 0;
		const gathered = await gather(
			made.files,
			async (hash) => {
				if (!stdouts.has(hash)) return made.fetch(hash);
				most = Math.max(most, ++inFlight);
				// Let the other workers run before this fetch completes, as a slow fetch would.
				for (let turn = 0; turn < 20; turn++) await Promise.resolve();
				inFlight--;
				return made.fetch(hash);
			},
			3,
		);
		for (const hash of stdouts) {
			expect(gathered.blobs.has(hash)).toBe(false);
			expect(gathered.streams.get(hash)?.problems).toEqual([]);
		}
		expect(most).toBe(3);
		expect(derive(made.files, gathered).derivations[0]?.points.every((point) => point.counted)).toBe(true);
	});

	test("and fails a Run whose stdout holds a line that is not JSON, saying which, in words that do not depend on the machine", async () => {
		const made = new HandMade();
		const stdout = '{"event":"started","t":1,"schema":"ledgermath.events/1","wall_utc":"2026-11-11T22:15:00.000000000Z","clock":"CLOCK_MONOTONIC_RAW","clock_read_ns":20}\nnot json\n';
		made.run({ startedAt: "2026-11-11T22:15:00Z", stdout });
		const point = derive(made.files, await gather(made.files, made.fetch)).derivations[0]?.points[0];
		expect(point?.counted).toBe(false);
		expect(point?.failure).toContain("stdout line 2 is not an event: not JSON");
	});
});
