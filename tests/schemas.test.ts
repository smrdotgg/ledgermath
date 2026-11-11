import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	checkBucketDirectory,
	loadOmitted,
	loadValidators,
	type RunEvent,
	type RunRecord,
} from "../scripts/check-runs";
import { readStream } from "../methods/run";
import { findSecrets } from "../scripts/lib/secret-search";
import { allFields, EXAMPLE, identifyingProblems, sectionFields, shapedValues } from "./samples/identifying";

const SAMPLES = join(import.meta.dir, "samples");
const SAMPLE_DIRECTORIES = ["scheduled", "interrupted", "failures"];
const validators = loadValidators();

function samplesIn(directory: string): RunRecord[] {
	return readdirSync(join(SAMPLES, directory, "runs"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8")) as RunRecord);
}

function bootSummaryOf(directory: string): { stopped_by?: number; runs: unknown[]; not_run: unknown[] } {
	const [summary] = readdirSync(join(SAMPLES, directory, "boots"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8")));
	if (!summary) throw new Error(`no boot summary in ${directory}`);
	return summary;
}

/** A fresh copy of a sample Run that exited 0, to break in one place. */
function goodRun(): Record<string, unknown> {
	const run = samplesIn("scheduled")[0];
	if (!run) throw new Error("no sample Runs");
	return structuredClone(run) as Record<string, unknown>;
}

/** A sample Run's events: its stdout blob's lines, as every reader reads them. */
function eventsOf(directory: string, run: RunRecord): RunEvent[] {
	return readStream(readFileSync(join(SAMPLES, directory, "blobs", "sha256", run.stdout.replace("sha256:", "")))).events;
}

function eventOf(run: RunRecord, name: string): RunEvent {
	const event = eventsOf("scheduled", run).find((candidate) => candidate.event === name);
	if (!event) throw new Error(`no ${name} event`);
	return structuredClone(event);
}

/** Checking a sample directory runs check-events.py once per Run, and reads every blob: seconds, more on a loaded machine. */
const SAMPLE_TIMEOUT_MS = 120_000;

describe("the sample Runs", () => {
	for (const directory of SAMPLE_DIRECTORIES) {
		test(`${directory}: every Run and event validates, and every hash resolves`, () => {
			const result = checkBucketDirectory(join(SAMPLES, directory), {
				blobs: true,
				omitted: loadOmitted(join(SAMPLES, directory, "omitted-blobs.json")),
			});
			expect(result.problems).toEqual([]);
			expect(result.runs).toBeGreaterThan(0);
		}, SAMPLE_TIMEOUT_MS);
	}

	test("a scheduled boot left one Run per parameter set per build of memory_read, each exiting 0", () => {
		// The samples were recorded when memory_read was the whole schedule.
		const runs = samplesIn("scheduled");
		const schedule = JSON.parse(readFileSync(join(import.meta.dir, "..", "schedule.json"), "utf8")) as {
			benchmarks: Array<{ name: string; builds: string[]; params: unknown[] }>;
		};
		const memoryRead = schedule.benchmarks.find((b) => b.name === "memory_read");
		expect(runs.length).toBe((memoryRead?.builds.length ?? 0) * (memoryRead?.params.length ?? 0));
		for (const run of runs) expect(run.benchmark).toBe("memory_read");
		expect(new Set(runs.map((run) => run.boot)).size).toBe(1);
		for (const run of runs) expect(run.exit).toEqual({ code: 0 });
	});

	test("a failed execution still produces a Run: a timeout and a non-zero exit", () => {
		const exits = samplesIn("failures").map((run) => run.exit);
		expect(exits).toContainEqual({ signal: 9, timeout_seconds: 1 });
		expect(exits).toContainEqual({ code: 2 });
	});

	test("an execution the runner was told to stop in still produces a Run, and the boot says what it did not run", () => {
		const runs = samplesIn("interrupted");
		const stopped = runs.filter((run) => run.exit.runner_signal !== undefined);
		expect(stopped.length).toBe(1);
		expect(stopped[0]?.exit).toEqual({ signal: 9, runner_signal: 15 });
		const summary = bootSummaryOf("interrupted");
		expect(summary.stopped_by).toBe(15);
		expect(summary.runs.length).toBe(runs.length);
		expect(summary.not_run.length).toBeGreaterThan(0);
	});

	for (const directory of SAMPLE_DIRECTORIES) {
		test(`${directory}: every identifying field holds its example value (tests/samples/README.md)`, () => {
			expect(identifyingProblems(join(SAMPLES, directory))).toEqual([]);
			const names = new Set(allFields(join(SAMPLES, directory)).map((field) => field.name));
			// The fields that must be there for the check to mean anything.
			for (const name of [
				"provider.instance_id",
				"provider: identity document accountId",
				"provider: identity document privateIp",
				"kernel: uname -a nodename",
			]) {
				expect(names).toContain(name);
			}
		}, SAMPLE_TIMEOUT_MS);
	}
});

describe("the sample Runs of an entry that measures a Service", () => {
	// Made by tests/service-runs.py (tests/samples/README.md): a stand-in
	// benchmark, given the s3_fixtures Service's inputs by runner/run.py.
	const runs = (): RunRecord[] => samplesIn("service").sort((a, b) => a.started_at.localeCompare(b.started_at));

	test("validate, and every hash resolves", () => {
		const result = checkBucketDirectory(join(SAMPLES, "service"), { blobs: true });
		expect(result.problems).toEqual([]);
		expect(result.runs).toBe(3);
	}, SAMPLE_TIMEOUT_MS);

	test("say which Service inputs were delivered: those not secret by value, the keys by name", () => {
		const [plain, ...measured] = runs();
		expect(plain?.service).toBeUndefined();
		expect(measured.length).toBe(2);
		for (const run of measured) {
			expect(run.service).toEqual({
				name: "s3_fixtures",
				inputs: { endpoint: "https://ledgermath-test-fixtures.s3.us-east-2.amazonaws.com", region: "us-east-2" },
				secret_inputs: ["aws_access_key_id", "aws_secret_access_key", "aws_session_token"],
			});
		}
	});

	test("hold none of the stand-in keys, in any file", () => {
		const keys = {
			aws_access_key_id: "ASIAQSTANDINTESTKEY7",
			aws_secret_access_key: "stand+in/Secret/Access/Key/0123456789abcdefghijk",
			aws_session_token: "IQoJb3JpZ2luX2VjEStandIn//////////wEaCXVzLWVhc3QtMiJHMEUCIQStandInSessionToken+test==",
		};
		expect(findSecrets([join(SAMPLES, "service")], keys)).toEqual([]);
	});
});

describe("the Run schema's service", () => {
	const measured = (): Record<string, unknown> => {
		const run = samplesIn("service").find((candidate) => candidate.service !== undefined);
		if (!run) throw new Error("no sample Run with a service");
		return structuredClone(run) as Record<string, unknown>;
	};
	const withService = (service: unknown) => ({ ...measured(), service });

	test("is optional: a Run without one, as every Run before it, is valid", () => {
		const run = goodRun();
		expect(run.service).toBeUndefined();
		expect(validators.run(run)).toBe(true);
		expect(validators.run(measured())).toBe(true);
	});

	test("is closed: no field for a secret's value", () => {
		const service = measured().service as Record<string, unknown>;
		expect(validators.run(withService({ ...service, secrets: { aws_session_token: "x" } }))).toBe(false);
		expect(validators.run(withService({ ...service, secret_inputs: undefined }))).toBe(false);
	});

	test("holds inputs as strings, and each secret input's name once", () => {
		const service = measured().service as Record<string, unknown>;
		expect(validators.run(withService({ ...service, inputs: { port: 443 } }))).toBe(false);
		expect(validators.run(withService({ ...service, secret_inputs: ["aws_session_token", "aws_session_token"] }))).toBe(false);
		expect(validators.run(withService({ ...service, secret_inputs: ["LM_SERVICE_AWS_SESSION_TOKEN"] }))).toBe(false);
	});
});

describe("the two shapes of a Run", () => {
	// Runs written before the runner stopped copying stdout into the record
	// carry events; Runs written since carry stdout_bytes and stdout_lines, and
	// no events. Both are ledgermath.run/1, and both are read from stdout.
	const newer = (): Record<string, unknown> => structuredClone(samplesIn("stdout-only")[0]) as Record<string, unknown>;

	test("both validate: every older sample Run, and the newer samples", () => {
		for (const directory of [...SAMPLE_DIRECTORIES, "service"]) {
			for (const run of samplesIn(directory)) {
				expect(run.events).toBeDefined();
				expect(validators.run(run)).toBe(true);
			}
		}
		const runs = samplesIn("stdout-only");
		expect(runs.length).toBe(3);
		for (const run of runs) {
			expect(run.events).toBeUndefined();
			expect(typeof run.stdout_bytes).toBe("number");
			expect(validators.run(run)).toBe(true);
		}
	});

	test("the newer shape carries no events and no events_error", () => {
		expect(validators.run({ ...newer(), events: [] })).toBe(false);
		expect(validators.run({ ...newer(), events_error: { line: 1, message: "not JSON" } })).toBe(false);
	});

	test("stdout_bytes and stdout_lines come together", () => {
		const { stdout_lines: _lines, ...withoutLines } = newer();
		expect(validators.run(withoutLines)).toBe(false);
		const { stdout_bytes: _bytes, ...withoutBytes } = newer();
		expect(validators.run(withoutBytes)).toBe(false);
		expect(validators.run({ ...newer(), stdout_lines: -1 })).toBe(false);
	});

	test("a Run of neither shape, without events and without the stdout facts, is still a Run: its stdout is its events", () => {
		const { stdout_bytes: _bytes, stdout_lines: _lines, ...bare } = newer();
		expect(validators.run(bare)).toBe(true);
	});
});

describe("the Run schema rejects", () => {
	test("a good Run, as a control, is accepted", () => {
		expect(validators.run(goodRun())).toBe(true);
	});

	test("an unknown root key", () => {
		expect(validators.run({ ...goodRun(), verdict: "ok" })).toBe(false);
	});

	test("a missing field", () => {
		const run = goodRun();
		delete run.stderr;
		expect(validators.run(run)).toBe(false);
	});

	test("a bare hash without the sha256: prefix", () => {
		const run = goodRun();
		run.stdout = String(run.stdout).slice("sha256:".length);
		expect(validators.run(run)).toBe(false);
	});

	test("an exit with both a code and a signal", () => {
		expect(validators.run({ ...goodRun(), exit: { code: 0, signal: 9 } })).toBe(false);
	});

	test("an id that is not a version 7 UUID", () => {
		expect(validators.run({ ...goodRun(), id: "0b8e5d4a-1c2f-4e6a-9b3d-7f1e2a3c4d5e" })).toBe(false);
	});

	test("an event without its clock reading", () => {
		const run = goodRun() as unknown as RunRecord;
		const { t: _dropped, ...withoutT } = eventOf(run, "finished");
		run.events = [...eventsOf("scheduled", run).slice(0, -1), withoutT as RunEvent];
		expect(validators.run(run)).toBe(false);
	});
});

describe("the event schema rejects", () => {
	const run = goodRun() as unknown as RunRecord;

	test("good events, as a control, are accepted", () => {
		for (const event of eventsOf("scheduled", run)) expect(validators.event(event)).toBe(true);
	});

	test("a universal event with an extra field", () => {
		expect(validators.event({ ...eventOf(run, "sample_ended"), mean_ns: 12 })).toBe(false);
		expect(validators.event({ ...eventOf(run, "started"), benchmark: "memory_read" })).toBe(false);
	});

	test("a started event without its schema", () => {
		const { schema: _dropped, ...started } = eventOf(run, "started");
		expect(validators.event(started)).toBe(false);
	});

	test("a checksum that is not sixteen lowercase hex digits", () => {
		expect(validators.event({ ...eventOf(run, "verified"), checksum: "0xABC" })).toBe(false);
	});

	test("a benchmark's own event may carry its own fields", () => {
		expect(validators.event({ event: "connected", t: 5, address: "192.0.2.1" })).toBe(true);
	});
});

describe("the identifying-field check", () => {
	// Made-up values that are not the examples, standing for what a recording holds.
	const IMDS = "http://169.254.169.254/latest/";
	const unsanitized = (fields: Array<{ value: string; example: string }>): number =>
		fields.filter((field) => field.value !== field.example).length;

	test("catches every identifying field of the identity document", () => {
		const document = JSON.stringify({
			accountId: "111122223333",
			instanceId: "i-0aaaaaaaaaaaaaaaa",
			imageId: "ami-0bbbbbbbbbbbbbbbb",
			privateIp: "10.20.30.40",
			pendingTime: "2026-05-05T05:05:05Z",
			marketplaceProductCodes: ["abc"],
		});
		const fields = sectionFields("provider", { [`${IMDS}dynamic/instance-identity/document`]: document });
		expect(unsanitized(fields)).toBe(6);
	});

	test("catches device serials, the host name, command-line UUIDs and container IDs", () => {
		const lsblk = JSON.stringify({ blockdevices: [{ name: "nvme0n1", serial: "vol0ccccccccccccccccc", children: [] }] });
		const findmnt = JSON.stringify({ filesystems: [{ source: `/dev/root[/var/lib/docker/containers/${"e".repeat(64)}/hosts]` }] });
		const devices = sectionFields("devices", {
			"/sys/class/nvme/nvme1/serial": "AWS9999999999999999X  \n",
			"$ lsblk -J": { stdout: lsblk },
			"$ findmnt -J": { stdout: findmnt },
		});
		expect(unsanitized(devices)).toBe(3);
		const kernel = sectionFields("kernel", {
			"$ uname -a": { stdout: "Linux ip-10-20-30-40 6.1.0 #1 SMP x86_64 GNU/Linux\n" },
			"/proc/cmdline": "root=PARTUUID=deadbeef-1111-2222-3333-444444444444 ro\n",
		});
		expect(unsanitized(kernel)).toBe(2);
	});

	test("catches identifying values by their shape anywhere, and passes the examples", () => {
		expect(unsanitized(shapedValues("mac 0a:1b:2c:3d:4e:5f at 172.31.9.9 on ip-172-31-9-9"))).toBe(3);
		expect(unsanitized(shapedValues(`${EXAMPLE.mac} ${EXAMPLE.privateIp} ${EXAMPLE.hostname} ${EXAMPLE.volumeId}`))).toBe(0);
	});
});
