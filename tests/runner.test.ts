import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeErrors, loadValidators, type RunRecord } from "../scripts/check-runs";

// runner/run.py driven through races a box can hit; tests/runner-races.py
// sets each one up and forces it.

const HARNESS = join(import.meta.dir, "runner-races.py");
const validators = loadValidators();
const scratch = mkdtempSync(join(tmpdir(), "runner-races-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface BootSummary {
	stopped_by?: number;
	runs: unknown[];
	not_run: unknown[];
}

interface Outcome {
	status: number;
	runs: RunRecord[];
	boot: BootSummary;
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
	return { status: Number(readFileSync(join(out, "status"), "utf8")), runs, boot };
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
