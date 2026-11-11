import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// runner/provision.py, run for real with fixture tools that misbehave
// (tests/provision-stops.py): whatever happens, its record says truthfully what
// every step did, the step in progress included, and no process it started is
// left running.

interface Step {
	step: string;
	state: string;
	exit?: number | null;
	stdout?: string;
	stopped_by?: string;
	timed_out_by?: string;
	killed?: { signals: string[]; survivors: unknown[] };
	leftovers?: { signals: string[]; survivors: unknown[] };
	note?: string;
}

interface ProvisionRecord {
	schema: string;
	state: string;
	stopped_by?: string;
	exit?: number;
	steps: Step[];
	root_volume?: { state: string };
	supervisor?: {
		child_exit: number | null;
		child_signal: string | null;
		stopped_by: string | null;
		session_left: Array<{ comm: string }>;
		session_survivors: unknown[];
		undone: Array<{ what: string; command: string[]; exit: number | null }>;
	};
}

interface Case {
	status: number;
	sent: string | null;
	record: ProvisionRecord | null;
	known_processes: string[];
	survivors: Record<string, number>;
	root_volume_dir_exists: boolean;
	fixture_exists: boolean;
	record_temporary_left: boolean;
}

const scratch = mkdtempSync(join(tmpdir(), "provision-stops-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const done = spawnSync("python3", [join(import.meta.dir, "provision-stops.py"), join(scratch, "out")], { encoding: "utf8", timeout: 300_000 });
if (done.status !== 0) throw new Error(`provision-stops.py failed:\n${done.stdout}${done.stderr}`);
const cases = JSON.parse(done.stdout) as { [name: string]: Case };

const get = (name: string): Case => {
	const found = cases[name];
	if (!found) throw new Error(`no case ${name}`);
	return found;
};
const fixtureStep = (c: Case): Step | undefined => c.record?.steps.find((step) => step.step === "fixture root_volume");

function leavesNothingRunning(c: Case, roles: string[]): void {
	expect(c.known_processes).toEqual([...roles].sort());
	expect(c.survivors).toEqual({});
}

function leavesNoHalfDoneRootVolume(c: Case): void {
	expect(c.fixture_exists).toBe(false);
	expect(c.root_volume_dir_exists).toBe(false);
	expect(c.record_temporary_left).toBe(false);
}

describe("a step that runs past its time", () => {
	test("is ended with its whole process group; the record keeps what it printed", () => {
		const c = get("hangs");
		expect(c.status).toBe(1);
		expect(c.record?.state).toBe("failed");
		const step = fixtureStep(c);
		expect(step?.state).toBe("timed out");
		expect(step?.stdout).toMatch(/^writing .*ledgermath-fixture-v1\n$/);
		expect(step?.killed).toEqual({ signals: ["SIGTERM"], survivors: [] });
		expect(c.record?.root_volume?.state).toBe("failed");
		leavesNothingRunning(c, ["tool"]);
		leavesNoHalfDoneRootVolume(c);
	});

	test("that ignores SIGTERM is killed after the grace", () => {
		const c = get("ignores-term");
		expect(fixtureStep(c)?.killed).toEqual({ signals: ["SIGTERM", "SIGKILL"], survivors: [] });
		leavesNothingRunning(c, ["tool"]);
		leavesNoHalfDoneRootVolume(c);
	});

	test("takes its grandchildren with it, even one that ignores SIGTERM", () => {
		const c = get("grandchild");
		expect(fixtureStep(c)?.state).toBe("timed out");
		expect(fixtureStep(c)?.killed?.signals).toEqual(["SIGTERM", "SIGKILL"]);
		leavesNothingRunning(c, ["grandchild", "tool"]);
	});
});

describe("a step that exits", () => {
	test("leaving a process behind: it is killed, and the record says so", () => {
		const c = get("leftover");
		expect(c.status).toBe(0);
		expect(fixtureStep(c)).toMatchObject({ state: "ended", exit: 0, leftovers: { signals: ["SIGTERM", "SIGKILL"], survivors: [] } });
		leavesNothingRunning(c, ["grandchild", "tool"]);
	});
});

describe("provisioning told to stop, or out of time", () => {
	test("on SIGTERM mid-step: stops the step's group, records what stopped it and the output so far, undoes the half-done, exits 143", () => {
		const c = get("sigterm");
		expect(c.sent).toBe("SIGTERM to provision.py");
		expect(c.status).toBe(143);
		expect(c.record).toMatchObject({ state: "stopped", stopped_by: "told to stop by SIGTERM", exit: 143 });
		expect(fixtureStep(c)).toMatchObject({ state: "stopped", stopped_by: "SIGTERM", stdout: "started\n" });
		expect(fixtureStep(c)?.killed?.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(c.record?.root_volume?.state).toBe("stopped");
		leavesNothingRunning(c, ["tool"]);
		leavesNoHalfDoneRootVolume(c);
	});

	test("at its own deadline: the same, said as the deadline, exit 124", () => {
		const c = get("deadline");
		expect(c.status).toBe(124);
		expect(c.record).toMatchObject({ state: "stopped", stopped_by: "its own deadline of 2.0 seconds" });
		expect(fixtureStep(c)).toMatchObject({ state: "timed out", timed_out_by: "provisioning's deadline", stdout: "started\n" });
		leavesNothingRunning(c, ["tool"]);
		leavesNoHalfDoneRootVolume(c);
	});
});

describe("the supervisor, box.sh's outer limit", () => {
	test("at its limit, stops provisioning, which records it; nothing is left in its session", () => {
		const c = get("supervised-limit");
		expect(c.status).toBe(124);
		expect(c.record?.state).toBe("stopped");
		expect(c.record?.supervisor).toMatchObject({ stopped_by: "the outer limit of 2.0 seconds", child_exit: 143, session_left: [], session_survivors: [] });
		expect(fixtureStep(c)?.state).toBe("stopped");
		leavesNothingRunning(c, ["tool"]);
		leavesNoHalfDoneRootVolume(c);
	});

	test("when provisioning is killed outright: kills what it left, records the step it was in from its output, and undoes the half-done", () => {
		const c = get("supervised-killed");
		expect(c.sent).toMatch(/^SIGKILL to provision.py's working child/);
		expect(c.status).toBe(137);
		expect(c.record?.state).toBe("ended without recording its end");
		expect(fixtureStep(c)).toMatchObject({ state: "unfinished", stdout: "started\n" });
		expect(c.record?.supervisor?.child_signal).toBe("SIGKILL");
		expect(c.record?.supervisor?.session_left.map((process) => process.comm).sort()).toEqual(["fixture-tool", "sleep"]);
		expect(c.record?.supervisor?.session_survivors).toEqual([]);
		expect(c.record?.supervisor?.undone).toEqual([
			{ what: "remove the partial Fixture root_volume", command: expect.any(Array), exit: 0 },
			{ what: "remove the root volume's directory", command: expect.any(Array), exit: 0 },
		]);
		leavesNothingRunning(c, ["grandchild", "tool"]);
		leavesNoHalfDoneRootVolume(c);
	});
});

test("every record is the current schema and was always replaced whole", () => {
	for (const c of Object.values(cases)) {
		expect(c.record?.schema).toBe("ledgermath.provision/2");
		expect(c.record_temporary_left).toBe(false);
	}
});
