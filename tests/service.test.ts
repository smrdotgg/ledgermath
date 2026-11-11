import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SERVICES } from "../infra/runs/schedule";
import { S3_FIXTURES } from "../infra/runs/fixtures";
import { readStream } from "../methods/run";
import { checkBucketDirectory, describeErrors, loadValidators, type RunRecord } from "../scripts/check-runs";
import { findSecrets, secretForms } from "../scripts/lib/secret-search";

// runner/run.py and a schedule entry that measures a Service: the keys it gets
// once per boot reach that entry's executions and nothing else, and when they
// cannot be had the entry is not run and the boot goes on. tests/service-runs.py
// sets up each case.

const HARNESS = join(import.meta.dir, "service-runs.py");
const RUN_PY = readFileSync(join(import.meta.dir, "..", "runner", "run.py"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "service-runs-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const validators = loadValidators();

// The stand-in keys tests/service-runs.py's aws stand-in hands out.
const SECRETS = {
	aws_access_key_id: "ASIAQSTANDINTESTKEY7",
	aws_secret_access_key: "stand+in/Secret/Access/Key/0123456789abcdefghijk",
	aws_session_token: "IQoJb3JpZ2luX2VjEStandIn//////////wEaCXVzLWVhc3QtMiJHMEUCIQStandInSessionToken+test==",
};
const ENDPOINT = "https://ledgermath-test-fixtures.s3.us-east-2.amazonaws.com";

interface Execution {
	benchmark: string;
	build: string;
	params: { n: number };
	reason?: string;
}

interface Outcome {
	directory: string;
	status: number;
	environHoldsAKey: boolean;
	argvHoldsAKey: boolean;
	runs: RunRecord[];
	boot: { runs: Execution[]; not_run: Execution[]; build_failures: unknown[]; services?: Record<string, Record<string, string>> };
	log: string;
	awsCalls: string[];
	/** What each execution's binary found in its environment, by n: LM_SERVICE_<NAME> to value. */
	received: Record<string, Record<string, string>>;
}

function jsonUnder<T>(directory: string): T[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8")) as T);
}

const cases = new Map<string, Outcome>();
function outcome(name: string): Outcome {
	const cached = cases.get(name);
	if (cached) return cached;
	const directory = join(scratch, name);
	const done = spawnSync("python3", [HARNESS, name, directory], { encoding: "utf8", timeout: SLOW - 10_000 });
	if (done.status !== 0) throw new Error(`service-runs.py ${name} failed:\n${done.stdout}${done.stderr}`);
	const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
	const [boot] = jsonUnder<Outcome["boot"]>(join(directory, "out", "boots"));
	if (!boot) throw new Error(`${name}: no boot summary`);
	const received: Outcome["received"] = {};
	const sink = join(directory, "sink");
	for (const n of existsSync(sink) ? readdirSync(sink) : []) {
		received[n] = Object.fromEntries(readdirSync(join(sink, n)).map((variable) => [variable, readFileSync(join(sink, n, variable), "utf8").trimEnd()]));
	}
	const calls = join(directory, "aws-calls.log");
	const found: Outcome = {
		directory,
		status: result.status,
		environHoldsAKey: result.environ_holds_a_key,
		argvHoldsAKey: result.argv_holds_a_key,
		runs: jsonUnder<RunRecord>(join(directory, "out", "runs")).sort((a, b) => a.started_at.localeCompare(b.started_at)),
		boot,
		log: readFileSync(join(directory, "log"), "utf8"),
		awsCalls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
		received,
	};
	cases.set(name, found);
	return found;
}

/** Everything a boot wrote: its output directory, its log, and every aws command line. */
function leaks(o: Outcome) {
	return findSecrets([join(o.directory, "out"), join(o.directory, "log"), join(o.directory, "aws-calls.log")], SECRETS);
}

const n = (run: RunRecord): number => (run.params as { n: number }).n;
const SLOW = 120_000;

describe("an entry that measures a Service, when the keys are had", () => {
	test(
		"its executions get the endpoint, the Region and the three keys, as LM_SERVICE_*, and the others get none",
		() => {
			const o = outcome("keys");
			expect(o.status).toBe(0);
			expect(o.runs.map(n)).toEqual([1, 2, 3]);
			const keys = {
				LM_SERVICE_AWS_ACCESS_KEY_ID: SECRETS.aws_access_key_id,
				LM_SERVICE_AWS_SECRET_ACCESS_KEY: SECRETS.aws_secret_access_key,
				LM_SERVICE_AWS_SESSION_TOKEN: SECRETS.aws_session_token,
				LM_SERVICE_ENDPOINT: ENDPOINT,
				LM_SERVICE_REGION: "us-east-2",
			};
			expect(o.received).toEqual({ "1": {}, "2": keys, "3": keys });
		},
		SLOW,
	);

	test(
		"its Runs say which Service inputs were delivered: the endpoint and Region by value, the keys by name, and the others say nothing",
		() => {
			const o = outcome("keys");
			for (const run of o.runs) expect(validators.run(run) ? "valid" : describeErrors(validators.run)).toBe("valid");
			const [plain, ...measured] = o.runs;
			expect(plain?.service).toBeUndefined();
			for (const run of measured) {
				expect(run.service).toEqual({
					name: "s3_fixtures",
					inputs: { endpoint: ENDPOINT, region: "us-east-2" },
					secret_inputs: ["aws_access_key_id", "aws_secret_access_key", "aws_session_token"],
				});
				// The binary's own account of what it got: the variables' names.
				const events = readStream(readFileSync(join(o.directory, "out", "blobs", "sha256", run.stdout.replace("sha256:", "")))).events;
				expect(events[1]?.values).toEqual({
					service_variables:
						"LM_SERVICE_AWS_ACCESS_KEY_ID LM_SERVICE_AWS_SECRET_ACCESS_KEY LM_SERVICE_AWS_SESSION_TOKEN LM_SERVICE_ENDPOINT LM_SERVICE_REGION ",
				});
			}
			// A Run without a Service is written as before: service comes nowhere in its file.
			expect(Object.keys(plain ?? {})).not.toContain("service");
			expect(checkBucketDirectory(join(o.directory, "out"), { blobs: true }).problems).toEqual([]);
		},
		SLOW,
	);

	test(
		"the role is assumed once per boot, for an hour, through the aws CLI, and the boot summary says until when",
		() => {
			const o = outcome("keys");
			expect(o.awsCalls.length).toBe(1);
			expect(o.awsCalls[0]).toMatch(
				/^sts assume-role --role-arn arn:aws:iam::123456789012:role\/ledgermath-test-fixtures --role-session-name ledgermath-[0-9a-f-]+ --duration-seconds 3600 --region us-east-2 --output json$/,
			);
			expect(o.boot.services?.s3_fixtures?.expires_at).toBe("2026-11-11T01:00:00+00:00");
			expect(Object.keys(o.boot.services?.s3_fixtures ?? {}).sort()).toEqual(["asked_at", "expires_at", "role_session_name"]);
		},
		SLOW,
	);

	test(
		"no key is in anything the boot wrote: a Run, a blob, a dump, the boot summary, the log, an aws command line, run.py's own environment",
		() => {
			const o = outcome("keys");
			expect(leaks(o)).toEqual([]);
			expect(o.environHoldsAKey).toBe(false);
			expect(o.argvHoldsAKey).toBe(false);
			// The search is not vacuous: the keys did reach the binary, and the search finds them where they are.
			expect(Object.values(o.received["2"] ?? {})).toContain(SECRETS.aws_session_token);
			expect(findSecrets([join(o.directory, "sink")], SECRETS).length).toBeGreaterThan(0);
		},
		SLOW,
	);
});

describe("an entry that measures a Service, when the keys cannot be had", () => {
	for (const [name, why] of [
		["refused", "aws sts assume-role exited 254: An error occurred (AccessDenied) when calling the AssumeRole operation"],
		["garbled", "printed no Credentials with AccessKeyId, SecretAccessKey, SessionToken and Expiration"],
		["unshaped", "printed Credentials that are not shaped as keys (not recorded)"],
		["no-values", "the stage gave this box no s3_fixtures values"],
	] as const) {
		test(
			`(${name}) is not run, the boot summary says why, and everything else runs`,
			() => {
				const o = outcome(name);
				expect(o.runs.map(n)).toEqual([1]);
				expect(o.received).toEqual({ "1": {} });
				expect(o.boot.not_run.map((execution) => execution.params.n)).toEqual([2, 3]);
				for (const execution of o.boot.not_run) {
					expect(execution.reason).toStartWith("s3_fixtures: ");
					expect(execution.reason).toContain(why);
				}
				expect(o.log).toContain("NOT RUN fake static");
				// A boot with an entry not run fails, as one with a build failure does.
				expect(o.status).toBe(1);
				expect(leaks(o)).toEqual([]);
				// Asked once, not once per execution; not at all without the stage's values.
				expect(o.awsCalls.length).toBe(name === "no-values" ? 0 : 1);
				if (name !== "no-values") expect(o.boot.services?.s3_fixtures?.failed).toBe(o.boot.not_run[0]?.reason?.slice("s3_fixtures: ".length));
			},
			SLOW,
		);
	}

	test(
		"(garbled) what assume-role printed, keys and all, is recorded nowhere",
		() => {
			const o = outcome("garbled");
			expect(o.boot.not_run[0]?.reason).toMatch(/\(\d+ bytes, not recorded\)$/);
			expect(leaks(o)).toEqual([]);
		},
		SLOW,
	);
});

describe("the secret search", () => {
	test("looks for each value as it is and encoded", () => {
		const forms = secretForms("ab/c+d=xyz0123");
		expect(forms).toContain("ab/c+d=xyz0123");
		expect(forms).toContain(Buffer.from("ab/c+d=xyz0123").toString("hex"));
		expect(forms).toContain("ab%2fc%2bd%3dxyz0123");
		expect(forms.some((form) => Buffer.from("xx ab/c+d=xyz0123 yy").toString("base64").toLowerCase().includes(form))).toBe(true);
		expect(forms.some((form) => Buffer.from("x ab/c+d=xyz0123 yy").toString("base64").toLowerCase().includes(form))).toBe(true);
		expect(forms.some((form) => Buffer.from("ab/c+d=xyz0123").toString("base64url").toLowerCase().includes(form))).toBe(true);
	});
});

describe("the Services", () => {
	test("the schedule accepts are the ones run.py knows and the stage makes", () => {
		expect(SERVICES).toEqual([S3_FIXTURES]);
		expect(RUN_PY).toContain(`S3_FIXTURES = "${S3_FIXTURES}"`);
	});

	test("s3_fixtures delivers exactly the Service inputs benchmarks/http_get/README.md says the binary reads", () => {
		const readme = readFileSync(join(import.meta.dir, "..", "benchmarks", "http_get", "README.md"), "utf8");
		const listed = [...readme.matchAll(/^\| `(LM_SERVICE_[A-Z_]+)` \|/gm)].map((match) => match[1]).sort();
		expect(listed).toEqual(Object.keys(outcome("keys").received["2"] ?? {}).sort());
	}, SLOW);
});
