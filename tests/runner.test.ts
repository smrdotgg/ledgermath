import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeErrors, loadValidators, type RunRecord } from "../scripts/check-runs";

// runner/run.py driven through races a box can hit, and through a schedule
// naming instance types; tests/runner-races.py sets each one up.

const HARNESS = join(import.meta.dir, "runner-races.py");
const validators = loadValidators();
const scratch = mkdtempSync(join(tmpdir(), "runner-races-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Execution {
	benchmark: string;
	build: string;
	params: Record<string, unknown>;
}

interface BootSummary {
	stopped_by?: number;
	provider: { name: string; instance_type?: string | null };
	runs: Array<Execution & { id: string }>;
	not_run: Execution[];
	build_failures: unknown[];
	left_out: Array<Execution & { instance_types: string[] }>;
}

interface Outcome {
	status: number;
	runs: RunRecord[];
	boot: BootSummary;
	/** Every `make -B` run.py ran, as [directory, BUILD=...]. */
	builds: string[][];
}

function jsonUnder<T>(directory: string): T[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8")) as T);
}

function race(name: string): Outcome {
	const out = join(scratch, name);
	const done = spawnSync("python3", [HARNESS, name, out], { encoding: "utf8" });
	if (done.status !== 0) throw new Error(`runner-races.py ${name} failed:\n${done.stdout}${done.stderr}`);
	const runs = jsonUnder<RunRecord>(join(out, "runs")).sort((a, b) => a.started_at.localeCompare(b.started_at));
	const [boot] = jsonUnder<BootSummary>(join(out, "boots"));
	if (!boot) throw new Error(`${name}: no boot summary`);
	return {
		status: Number(readFileSync(join(out, "status"), "utf8")),
		runs,
		boot,
		builds: JSON.parse(readFileSync(join(out, "builds.json"), "utf8")) as string[][],
	};
}

function expectValid(runs: RunRecord[]): void {
	for (const run of runs) {
		const valid = validators.run(run);
		expect(valid ? "valid" : describeErrors(validators.run)).toBe("valid");
	}
}

const SLOW = 30_000;

describe("the runner's timeout", () => {
	test(
		"kills a binary that runs too long, and its Run says so",
		() => {
			const { status, runs } = race("timeout-kills");
			expectValid(runs);
			expect(runs.map((run) => run.exit)).toEqual([
				{ signal: 9, timeout_seconds: 1 },
				{ signal: 9, timeout_seconds: 1 },
			]);
			expect(status).toBe(0);
		},
		SLOW,
	);

	test(
		"leaves a binary that ended by itself its own exit, even when the alarm fires before it is cancelled",
		() => {
			const { runs } = race("alarm-after-exit");
			expectValid(runs);
			expect(runs.map((run) => run.exit)).toEqual([{ code: 0 }, { code: 0 }]);
		},
		SLOW,
	);
});

describe("a stop signal", () => {
	test(
		"while the binary runs kills it; its Run says why, and nothing more starts",
		() => {
			const { status, runs, boot } = race("stop-while-running");
			expectValid(runs);
			expect(runs.map((run) => run.exit)).toEqual([{ signal: 9, runner_signal: 15 }]);
			expect(boot.stopped_by).toBe(15);
			expect(boot.not_run.length).toBe(1);
			expect(status).toBe(143);
		},
		SLOW,
	);

	for (const [name, when] of [
		["stop-after-exit", "just after the binary was reaped"],
		["stop-in-after-dump", "during the dump after the binary ended"],
	]) {
		test(
			`${when} leaves that Run complete, without runner_signal, and still stops the boot`,
			() => {
				const { status, runs, boot } = race(name ?? "");
				expectValid(runs);
				expect(runs.map((run) => run.exit)).toEqual([{ code: 0 }]);
				expect(boot.stopped_by).toBe(15);
				expect(boot.not_run.length).toBe(1);
				expect(status).toBe(143);
			},
			SLOW,
		);
	}
});

describe("a schedule naming instance types", () => {
	test(
		"on an m5.large, runs the entries for every type and for m5.large, builds each benchmark once, and lists the rest as left out",
		() => {
			const { status, runs, boot, builds } = race("instance-types");
			expectValid(runs);
			expect(status).toBe(0);
			expect(boot.provider.instance_type).toBe("m5.large");
			expect(runs.map((run) => run.params)).toEqual([
				{ mode: "quick", n: 1 },
				{ mode: "quick", n: 2 },
			]);
			expect(boot.runs.map((run) => run.params)).toEqual([
				{ mode: "quick", n: 1 },
				{ mode: "quick", n: 2 },
			]);
			// Two entries of fake ran here; its one build served both. absent, for
			// another type only, was never built (its directory does not exist).
			expect(builds).toEqual([["benchmarks/fake", "BUILD=static"]]);
			expect(boot.build_failures).toEqual([]);
			expect(boot.not_run).toEqual([]);
			expect(boot.left_out).toEqual([
				{ benchmark: "fake", build: "static", params: { mode: "quick", n: 3 }, instance_types: ["c6i.8xlarge"] },
				{ benchmark: "absent", build: "static", params: { n: 4 }, instance_types: ["c8a.2xlarge"] },
				{ benchmark: "absent", build: "dynamic", params: { n: 4 }, instance_types: ["c8a.2xlarge"] },
				{ benchmark: "absent", build: "static", params: { n: 5 }, instance_types: ["c8a.2xlarge"] },
				{ benchmark: "absent", build: "dynamic", params: { n: 5 }, instance_types: ["c8a.2xlarge"] },
			]);
			// The summary accounts for every execution the schedule names.
			expect(boot.runs.length + boot.not_run.length + boot.left_out.length).toBe(7);
		},
		SLOW,
	);

	test(
		"on a box whose type is unknown, runs only the entries for every type",
		() => {
			const { status, runs, boot } = race("no-instance-type");
			expectValid(runs);
			expect(status).toBe(0);
			expect(boot.provider).toEqual({ name: "unknown" });
			expect(runs.map((run) => run.params)).toEqual([{ mode: "quick", n: 1 }]);
			expect(boot.left_out.map((execution) => execution.params.n)).toEqual([2, 3, 4, 4, 5, 5]);
		},
		SLOW,
	);
});
