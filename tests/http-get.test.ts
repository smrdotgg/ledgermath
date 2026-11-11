import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { streamProblems } from "../methods/v1/stream";
import { describeErrors, loadValidators } from "../scripts/check-runs";

// benchmarks/http_get end to end, offline. The binary and a test driver
// (benchmarks/http_get/test_driver.c, which calls the DNS, HTTP, SigV4 and
// event-line code directly) are built with this machine's compiler, linking
// AWS-LC built from its source archive, whose path is AWS_LC_ARCHIVE (the
// library is built once into benchmarks/http_get/build/aws-lc and reused).
// The binary then runs against tests/http-get/standin.py, a local stand-in
// for S3 and the resolver, with a throwaway CA, and every stream it prints
// must pass scripts/check-events.py, methods/v1/stream.ts and the event
// schema, and hold none of the test credentials or the signatures it sent.
//
// Without CMake or the archive (and no library built before), these tests
// are skipped with a message, unless LM_HTTP_GET_REQUIRED=1, as CI sets it.

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const DIR = join(ROOT, "benchmarks", "http_get");
const BINARY = join(DIR, "build", "static", "http_get");
const DRIVER = join(DIR, "build", "test", "http_get_test");
const ARCHIVE = process.env.AWS_LC_ARCHIVE ?? "";
const REQUIRED = process.env.LM_HTTP_GET_REQUIRED === "1";
const HAS_CMAKE = spawnSync("cmake", ["--version"]).status === 0;
const LIBRARY_BUILT = existsSync(join(DIR, "build", "aws-lc", "built"));
const AVAILABLE = HAS_CMAKE && ((ARCHIVE !== "" && existsSync(ARCHIVE)) || LIBRARY_BUILT);
if (!AVAILABLE) {
	const why = !HAS_CMAKE ? "cmake is not on PATH" : "AWS_LC_ARCHIVE does not name AWS-LC's source archive";
	if (REQUIRED) throw new Error(`http_get's tests cannot run: ${why}`);
	console.warn(`skipping http_get's tests: ${why} (see benchmarks/harness/c/vendor/aws-lc.lock)`);
}

/** The AWS-LC build, on a loaded machine, takes minutes. */
const BUILD_TIMEOUT_MS = 30 * 60_000;
const RUN_TIMEOUT_MS = 60_000;

// The test credentials. Nothing here is a real credential; each must still
// never reach a stream or stderr.
const KEY_ID = "ASIAQLEDGERMATHTEST1";
const SECRET = "lmTestSecret/abcdefghijklmnopqrstuvwxyz+0123";
const TOKEN = "IQoJb3JpZ2luX2VjEPT//////////wEaCXVzLWVhc3QtMiJHMEUCIQLEDGERMATHTESTTOKEN+abc/def==";

const scratch = mkdtempSync(join(tmpdir(), "http-get-test-"));
const validators = loadValidators();
let standin: ChildProcess | null = null;
let ports = { dns_port: 0, https_port: 0, ca_file: "", requests: "" };
const resolvConf = join(scratch, "resolv.conf");
/** Every stdout and stderr a test produced, for the closing scan. */
const outputs: Array<{ label: string; text: string }> = [];

afterAll(() => {
	standin?.kill("SIGTERM");
	rmSync(scratch, { recursive: true, force: true });
});

const make = (...args: string[]) =>
	spawnSync("make", ["--no-print-directory", "-C", DIR, ...args], {
		encoding: "utf8",
		env: { ...process.env, AWS_LC_ARCHIVE: ARCHIVE },
	});

beforeAll(async () => {
	if (!AVAILABLE) return;
	for (const target of [["BUILD=static"], ["test-driver"]]) {
		const built = make(...target);
		if (built.status !== 0) throw new Error(`make ${target.join(" ")} failed:\n${built.stdout}${built.stderr}`);
	}
	standin = spawn("python3", ["-I", join(import.meta.dir, "http-get", "standin.py"), join(scratch, "standin")], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const line = await new Promise<string>((resolve, reject) => {
		let text = "";
		let errors = "";
		standin?.stderr?.on("data", (chunk: Buffer) => {
			errors += chunk.toString();
		});
		standin?.stdout?.on("data", (chunk: Buffer) => {
			text += chunk.toString();
			if (text.includes("\n")) resolve(text.split("\n")[0] as string);
		});
		standin?.on("exit", (code) => reject(new Error(`the stand-in exited ${code}:\n${errors}`)));
	});
	ports = JSON.parse(line);
	writeFileSync(resolvConf, `# the stand-in's resolver; the port is http_get's own extension\nnameserver 127.0.0.1:${ports.dns_port}\n`);
}, BUILD_TIMEOUT_MS);

// ---- running the binary ----

type Event = Record<string, unknown> & { event: string; t: number };
type Run = { status: number | null; stdout: string; stderr: string; events: Event[]; label: string };

type Options = {
	samples?: number;
	connection?: "new" | "reused";
	objectBytes?: number;
	gapMs?: number;
	budgetSeconds?: number;
	timeoutMs?: number;
	auth?: "sigv4" | "none";
	env?: Record<string, string | undefined>;
};

function environment(scenario: string, o: Options = {}): Record<string, string> {
	const objectBytes = o.objectBytes ?? 4096;
	const env: Record<string, string | undefined> = {
		LM_SAMPLES: String(o.samples ?? 2),
		LM_PARAM_OBJECT_BYTES: String(objectBytes),
		LM_PARAM_KEY: `http_get/v1/${objectBytes}`,
		LM_PARAM_CONNECTION: o.connection ?? "new",
		LM_PARAM_GAP_MEAN_MS: String(o.gapMs ?? 2),
		LM_PARAM_BUDGET_SECONDS: String(o.budgetSeconds ?? 60),
		LM_PARAM_TIMEOUT_MS: String(o.timeoutMs ?? 5000),
		LM_PARAM_CA_FILE: ports.ca_file,
		LM_PARAM_RESOLV_CONF: resolvConf,
		LM_PARAM_AUTH: o.auth ?? "sigv4",
		LM_SERVICE_ENDPOINT: `https://${scenario}.s3.lm.test:${ports.https_port}`,
		LM_SERVICE_REGION: "us-east-2",
		LM_SERVICE_AWS_ACCESS_KEY_ID: KEY_ID,
		LM_SERVICE_AWS_SECRET_ACCESS_KEY: SECRET,
		LM_SERVICE_AWS_SESSION_TOKEN: TOKEN,
		...o.env,
	};
	return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string>;
}

function run(scenario: string, o: Options = {}): Run {
	const done = spawnSync(BINARY, [], { encoding: "utf8", env: environment(scenario, o), timeout: RUN_TIMEOUT_MS });
	const label = `${scenario} ${JSON.stringify(o)}`;
	outputs.push({ label: `${label} stdout`, text: done.stdout }, { label: `${label} stderr`, text: done.stderr });
	const events = done.stdout
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Event);
	return { status: done.status, stdout: done.stdout, stderr: done.stderr, events, label };
}

/** The exit code, or a failure that shows why it differs: stderr and the failure events. */
function expectExit(r: Run, code: number): void {
	if (r.status === code) return;
	const failures = r.events.filter((event) => event.event === "request_failed" || event.event === "connection_failed" || (event.event === "response_ended" && event.fixture !== "match"));
	throw new Error(`${r.label}: exit ${r.status}, not ${code}\n${r.stderr}${failures.map((event) => JSON.stringify(event)).join("\n")}`);
}

/** The checks every stream must pass: the contract's order (both checkers), the schema, no secret. */
function checkStream(r: Run, expectSamples: number | null): void {
	expect(r.stdout.endsWith("\n")).toBe(true);
	const args = [join(ROOT, "scripts", "check-events.py")];
	if (expectSamples !== null) args.push("--samples", String(expectSamples));
	const checked = spawnSync("python3", args, { input: r.stdout, encoding: "utf8" });
	expect(`${checked.stdout}${checked.stderr}`).toStartWith("ok:");
	expect(streamProblems(r.events, expectSamples)).toEqual([]);
	for (const event of r.events) {
		const name = event.event;
		if (!validators.event(event)) throw new Error(`${name} breaks the schema: ${describeErrors(validators.event)}`);
	}
	expect(secretsIn(r.stdout + r.stderr)).toEqual([]);
}

/** Every signature the stand-in has received so far, from its log. */
function signaturesReceived(): string[] {
	return standinLog()
		.map((request) => header(request, "authorization"))
		.filter((value): value is string => value !== undefined)
		.map((value) => value.replace(/^.*Signature=/, ""));
}

type Logged = { method: string; target: string; headers: Array<[string, string]>; scenario: string; number: number };
const standinLog = (): Logged[] =>
	readFileSync(ports.requests, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Logged);
const header = (request: Logged, name: string): string | undefined =>
	request.headers.find(([key]) => key.toLowerCase() === name)?.[1];

/** The secrets found in `text`, ignoring case: the credentials and every signature sent. */
function secretsIn(text: string): string[] {
	const lower = text.toLowerCase();
	return [KEY_ID, SECRET, TOKEN, ...signaturesReceived()].filter((secret) => lower.includes(secret.toLowerCase()));
}

const of = (r: Run, name: string): Event[] => r.events.filter((event) => event.event === name);
const one = (r: Run, name: string): Event => {
	const found = of(r, name);
	if (found.length !== 1) throw new Error(`${r.label}: ${found.length} ${name} events`);
	return found[0] as Event;
};
const closing = (r: Run): Record<string, unknown> =>
	(of(r, "observed").find((event) => "requests_made" in (event.values as object)) as Event).values as Record<string, unknown>;
const opening = (r: Run): Record<string, unknown> => (of(r, "observed")[0] as Event).values as Record<string, unknown>;

/** The events of one request's sample, from sample_started to sample_ended. */
function sampleEvents(r: Run, sample: number): Event[] {
	const start = r.events.findIndex((event) => event.event === "sample_started" && event.sample === sample);
	const end = r.events.findIndex((event) => event.event === "sample_ended" && event.sample === sample);
	return r.events.slice(start, end + 1);
}

// ---- the test driver ----

const driver = (args: string[], input: string | Buffer = "") => spawnSync(DRIVER, args, { input, encoding: "utf8" });
function driverJson(args: string[], input: string | Buffer = ""): Record<string, unknown> {
	const done = driver(args, input);
	if (done.status !== 0) throw new Error(`http_get_test ${args.join(" ")} exited ${done.status}: ${done.stderr}`);
	return JSON.parse(done.stdout) as Record<string, unknown>;
}

// ---- SigV4 computed independently, with node:crypto ----

const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

function independentSignature(o: {
	method: string;
	uri: string;
	query: string;
	headers: Array<[string, string]>;
	payload: string;
	date: string;
	region: string;
	service: string;
	secret: string;
}): { canonical: string; stringToSign: string; signature: string } {
	const byName = new Map<string, string[]>();
	for (const [name, value] of o.headers) {
		const key = name.toLowerCase();
		byName.set(key, [...(byName.get(key) ?? []), value.trim().replace(/\s+/g, " ")]);
	}
	const names = [...byName.keys()].sort();
	const canonical = [
		o.method,
		o.uri,
		o.query,
		...names.map((name) => `${name}:${(byName.get(name) as string[]).join(",")}`),
		"",
		names.join(";"),
		o.payload,
	].join("\n");
	const day = o.date.slice(0, 8);
	const stringToSign = ["AWS4-HMAC-SHA256", o.date, `${day}/${o.region}/${o.service}/aws4_request`, sha256Hex(canonical)].join("\n");
	const key = hmac(hmac(hmac(hmac(`AWS4${o.secret}`, day), o.region), o.service), "aws4_request");
	return { canonical, stringToSign, signature: createHmac("sha256", key).update(stringToSign).digest("hex") };
}

function signWithDriver(o: {
	method: string;
	uri: string;
	query: string;
	headers: Array<[string, string]>;
	payload: string;
	date: string;
	region: string;
	service: string;
	keyId: string;
	secret: string;
}): Record<string, string> {
	const spec = [
		`method ${o.method}`,
		`uri ${o.uri}`,
		`query ${o.query}`,
		`payload ${o.payload}`,
		`date ${o.date}`,
		`region ${o.region}`,
		`service ${o.service}`,
		`key_id ${o.keyId}`,
		`secret ${o.secret}`,
		...o.headers.map(([name, value]) => `header ${name}:${value}`),
	].join("\n");
	return driverJson(["sigv4"], `${spec}\n`) as Record<string, string>;
}

describe.skipIf(!AVAILABLE)("SigV4 (benchmarks/harness/c/lm_sigv4.c)", () => {
	// tests/http-get/sigv4/ holds cases of AWS's SigV4 test suite as aws-c-auth
	// publishes it (Apache-2.0): those whose path S3 would encode the same way,
	// once and unnormalized. A case's query is taken from its expected
	// canonical request: the binary never sends one, so lm_sigv4.c takes a
	// canonical query as given.
	const VECTORS = join(import.meta.dir, "http-get", "sigv4");
	const cases = readdirSync(VECTORS).sort();

	test("there are AWS test-suite cases to check", () => {
		expect(cases.length).toBeGreaterThanOrEqual(15);
	});

	for (const name of cases) {
		test(`AWS's test suite: ${name}`, () => {
			const read = (file: string) => readFileSync(join(VECTORS, name, file), "utf8");
			const context = JSON.parse(read("context.json")) as {
				credentials: { access_key_id: string; secret_access_key: string; token?: string };
				region: string;
				service: string;
				sign_body: boolean;
				timestamp: string;
			};
			const [head, body = ""] = read("request.txt").split(/\n\n/);
			const [requestLine, ...headerLines] = (head as string).split("\n");
			// The path may hold a space: the target is everything between the method and the version.
			const method = (requestLine as string).slice(0, (requestLine as string).indexOf(" "));
			const target = (requestLine as string).slice(method.length + 1, (requestLine as string).lastIndexOf(" HTTP/"));
			const path = target.split("?")[0] as string;
			const headers: Array<[string, string]> = headerLines.filter((line) => line !== "").map((line) => {
				const colon = line.indexOf(":");
				return [line.slice(0, colon), line.slice(colon + 1)];
			});
			const date = context.timestamp.replace(/[-:]/g, "");
			headers.push(["X-Amz-Date", date]);
			if (context.credentials.token) headers.push(["X-Amz-Security-Token", context.credentials.token]);
			const payload = sha256Hex(body);
			if (context.sign_body) headers.push(["X-Amz-Content-Sha256", payload]);
			const expected = read("header-canonical-request.txt");
			const encoded = driverJson(["encode-path", path]).path as string;
			const result = signWithDriver({
				method,
				uri: encoded,
				query: expected.split("\n")[2] as string,
				headers,
				payload,
				date,
				region: context.region,
				service: context.service,
				keyId: context.credentials.access_key_id,
				secret: context.credentials.secret_access_key,
			});
			expect(result.canonical_request).toBe(expected);
			expect(result.string_to_sign).toBe(read("header-string-to-sign.txt"));
			expect(result.signature).toBe(read("header-signature.txt").trim());
		});
	}

	test("the S3 User Guide's examples: GET Object (Range signed) and GET Bucket (a query)", () => {
		// "Signature Calculations for the Authorization Header: Transferring
		// Payload in a Single Chunk", Examples: Signature Calculations.
		const common = {
			method: "GET",
			payload: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			date: "20130524T000000Z",
			region: "us-east-1",
			service: "s3",
			keyId: "AKIAIOSFODNN7EXAMPLE",
			secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		};
		const object = signWithDriver({
			...common,
			uri: "/test.txt",
			query: "",
			headers: [
				["Host", "examplebucket.s3.amazonaws.com"],
				["Range", "bytes=0-9"],
				["x-amz-content-sha256", common.payload],
				["x-amz-date", common.date],
			],
		});
		expect(object.string_to_sign).toBe(
			"AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
		);
		expect(object.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
		expect(object.authorization).toBe(
			"AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
		);
		const bucket = signWithDriver({
			...common,
			uri: "/",
			query: "max-keys=2&prefix=J",
			headers: [
				["Host", "examplebucket.s3.amazonaws.com"],
				["x-amz-content-sha256", common.payload],
				["x-amz-date", common.date],
			],
		});
		expect(bucket.signature).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
	});

	test("agrees with a signature computed here with node:crypto, for the headers http_get signs", () => {
		for (const [index, token] of ["", TOKEN, "short", "a b  c"].entries()) {
			const headers: Array<[string, string]> = [
				["host", `bucket-${index}.s3.us-east-2.amazonaws.com`],
				["x-amz-checksum-mode", "ENABLED"],
				["x-amz-content-sha256", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
				["x-amz-date", `2026111${index}T09070${index}Z`],
			];
			if (token !== "") headers.push(["x-amz-security-token", token]);
			const o = {
				method: "GET",
				uri: `/http_get/v1/${4096 << index}`,
				query: "",
				headers,
				payload: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
				date: headers[3]?.[1] as string,
				region: "us-east-2",
				service: "s3",
			};
			const mine = signWithDriver({ ...o, keyId: KEY_ID, secret: SECRET });
			const theirs = independentSignature({ ...o, secret: SECRET });
			expect(mine.canonical_request).toBe(theirs.canonical);
			expect(mine.string_to_sign).toBe(theirs.stringToSign);
			expect(mine.signature).toBe(theirs.signature);
		}
	});

	test("encodes a path as S3 wants it: once, every byte but the unreserved ones and /", () => {
		expect(driverJson(["encode-path", "/http_get/v1/4096"]).path).toBe("/http_get/v1/4096");
		expect(driverJson(["encode-path", "/a b+c=d&e%f/ሴ~._-"]).path).toBe("/a%20b%2Bc%3Dd%26e%25f/%E1%88%B4~._-");
	});
});

// ---- DNS ----

function name(text: string): number[] {
	return [...text.split(".").flatMap((label) => [label.length, ...Buffer.from(label)]), 0];
}
const u16 = (value: number) => [value >> 8, value & 255];
const u32 = (value: number) => [...u16(value >>> 16), ...u16(value & 0xffff)];
const hex = (bytes: number[]) => Buffer.from(bytes).toString("hex");

/** A reply: header, the question for `qname`, then the records given. */
function reply(o: { id?: number; flags?: number; qname: string; answers?: number[][]; authority?: number[][] }): number[] {
	const answers = o.answers ?? [];
	const authority = o.authority ?? [];
	return [
		...u16(o.id ?? 0x1234),
		...u16(o.flags ?? 0x8180),
		...u16(1),
		...u16(answers.length),
		...u16(authority.length),
		...u16(0),
		...name(o.qname),
		...u16(1),
		...u16(1),
		...answers.flat(),
		...authority.flat(),
	];
}
const record = (owner: number[], type: number, ttl: number, data: number[]) => [...owner, ...u16(type), ...u16(1), ...u32(ttl), ...u16(data.length), ...data];
const pointer = (offset: number) => [0xc0 | (offset >> 8), offset & 255];

describe.skipIf(!AVAILABLE)("DNS (benchmarks/harness/c/lm_dns.c)", () => {
	test("builds a query for A records, RD set, no EDNS", () => {
		const q = driverJson(["dns-query", "example.com", String(0x1234)]);
		expect(q.hex).toBe(hex([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...name("example.com"), 0, 1, 0, 1]));
		expect(driverJson(["dns-query", "example.com.", "1"]).bytes).toBe(29);
		expect(driverJson(["dns-query", "a..b", "1"]).bytes).toBe(0);
		expect(driverJson(["dns-query", `${"x".repeat(64)}.com`, "1"]).bytes).toBe(0);
	});

	test("reads a reply as S3's resolver gives one: a CNAME, then A records, compressed", () => {
		const qname = "bucket.s3.us-east-2.amazonaws.com";
		const target = name("s3-r-w.us-east-2.amazonaws.com");
		const cnameAt = 12 + name(qname).length + 4;
		const targetAt = cnameAt + 12;
		const bytes = reply({
			qname,
			answers: [
				record(pointer(12), 5, 300, target),
				record(pointer(targetAt), 1, 5, [3, 5, 132, 183]),
				record(pointer(targetAt), 1, 5, [52, 219, 176, 82]),
			],
		});
		const r = driverJson(["dns-parse"], hex(bytes));
		expect(r.error).toBeUndefined();
		expect(r.rcode).toBe(0);
		expect(r.tc).toBe(false);
		expect((r.answers as Array<{ text: string }>).map((a) => a.text)).toEqual([
			"bucket.s3.us-east-2.amazonaws.com. 300 CNAME s3-r-w.us-east-2.amazonaws.com.",
			"s3-r-w.us-east-2.amazonaws.com. 5 A 3.5.132.183",
			"s3-r-w.us-east-2.amazonaws.com. 5 A 52.219.176.82",
		]);
		expect(r.chain).toBe(1);
		expect(r.canonical).toBe("s3-r-w.us-east-2.amazonaws.com.");
		expect(r.address).toBe("3.5.132.183");
	});

	test("follows a CNAME chain whose records come out of order, and takes the A record of its end", () => {
		const bytes = reply({
			qname: "a.test",
			answers: [
				record(name("other.test"), 1, 9, [9, 9, 9, 9]),
				record(name("c.test"), 1, 60, [10, 0, 0, 3]),
				record(name("b.test"), 5, 60, name("c.test")),
				record(name("a.test"), 5, 60, name("b.test")),
			],
		});
		const r = driverJson(["dns-parse"], hex(bytes));
		expect(r.chain).toBe(2);
		expect(r.canonical).toBe("c.test.");
		expect(r.address).toBe("10.0.0.3");
	});

	test("finds no address when the chain's end has no A record, and stops a CNAME loop", () => {
		const none = driverJson(["dns-parse"], hex(reply({ qname: "a.test", answers: [record(name("a.test"), 5, 60, name("b.test")), record(name("x.test"), 1, 60, [1, 2, 3, 4])] })));
		expect(none.has_address).toBe(false);
		const loop = driverJson(["dns-parse"], hex(reply({ qname: "a.test", answers: [record(name("a.test"), 5, 60, name("b.test")), record(name("b.test"), 5, 60, name("a.test"))] })));
		expect(loop.error).toBeUndefined();
		expect(loop.has_address).toBe(false);
	});

	test("a reply with TC set is read as it is, and says so", () => {
		const r = driverJson(["dns-parse"], hex(reply({ qname: "a.test", flags: 0x8380 })));
		expect(r.error).toBeUndefined();
		expect(r.tc).toBe(true);
		expect(r.answers).toEqual([]);
	});

	test("a reply cut short is refused, wherever it is cut", () => {
		const whole = reply({ qname: "a.test", answers: [record(name("a.test"), 1, 60, [1, 2, 3, 4])] });
		for (const length of [5, 13, 20, whole.length - 3, whole.length - 1]) {
			const r = driverJson(["dns-parse"], hex(whole.slice(0, length)));
			expect(typeof r.error).toBe("string");
		}
		expect(driverJson(["dns-parse"], hex(whole)).address).toBe("1.2.3.4");
	});

	test("refuses a compression pointer that points forwards or at itself", () => {
		const qAt = 12 + name("a.test").length + 4;
		const forward = reply({ qname: "a.test", answers: [record(pointer(qAt + 40), 1, 60, [1, 2, 3, 4])] });
		expect(driverJson(["dns-parse"], hex(forward)).error).toBe("a compression pointer does not point backwards");
		const self = reply({ qname: "a.test", answers: [record(pointer(qAt), 1, 60, [1, 2, 3, 4])] });
		expect(driverJson(["dns-parse"], hex(self)).error).toBe("a compression pointer does not point backwards");
	});

	test("an NXDOMAIN keeps its rcode and its authority section, an SOA in presentation form", () => {
		const soa = [...name("ns.test"), ...name("host.test"), ...u32(1), ...u32(2), ...u32(3), ...u32(4), ...u32(5)];
		const r = driverJson(["dns-parse"], hex(reply({ qname: "gone.test", flags: 0x8183, authority: [record(name("test"), 6, 60, soa)] })));
		expect(r.rcode).toBe(3);
		expect(r.has_address).toBe(false);
		const authority = r.authority as Array<{ text: string }>;
		expect(authority[0]?.text).toBe("test. 60 SOA ns.test. host.test. 1 2 3 4 5");
	});
});

// ---- HTTP ----

function parse(bytes: string | Buffer, step: number, ...flags: string[]): Record<string, unknown> {
	return driverJson(["http-parse", String(step), ...flags], bytes);
}

describe.skipIf(!AVAILABLE)("the HTTP/1.1 response parser (benchmarks/harness/c/lm_http.c)", () => {
	const ok = "HTTP/1.1 200 OK\r\nx-amz-request-id: ABC\r\nContent-Length: 5\r\n\r\nhello";

	test("Content-Length: the status line and headers verbatim, the body, fed whole or a byte at a time", () => {
		for (const step of [1, 7, 4096]) {
			const r = parse(ok, step);
			expect(r).toMatchObject({ state: "done", status: 200, status_line: "HTTP/1.1 200 OK", framing: "length", content_length: 5, keep_alive: true, body_bytes: 5, wire_bytes: 5, left_over: 0 });
			expect(r.headers).toEqual([["x-amz-request-id", "ABC"], ["Content-Length", "5"]]);
			expect(Buffer.from(r.body_base64 as string, "base64").toString()).toBe("hello");
		}
		expect(parse(ok, 3, "--direct")).toMatchObject({ state: "done", body_bytes: 5 });
		expect(parse(`${ok}EXTRA`, 4096)).toMatchObject({ state: "done", left_over: 5 });
	});

	test("chunked: extensions ignored, trailers read, the body de-chunked, the framing counted", () => {
		const wire = "4;name=value\r\nWiki\r\n5\r\npedia\r\nE\r\n in\r\n\r\nchunks.\r\n0\r\nx-trailer: 1\r\n\r\n";
		const head = "HTTP/1.1 403 Forbidden\r\nTransfer-Encoding: chunked\r\nContent-Length: 999\r\n\r\n";
		for (const step of [1, 4096]) {
			const r = parse(head + wire, step);
			expect(r).toMatchObject({ state: "done", status: 403, framing: "chunked", body_bytes: 23, wire_bytes: wire.length });
			expect(Buffer.from(r.body_base64 as string, "base64").toString()).toBe("Wikipedia in\r\n\r\nchunks.");
		}
	});

	test("refuses obsolete line folding, a bare LF or CR, and whitespace before a colon", () => {
		expect(parse("HTTP/1.1 200 OK\r\nx-a: one\r\n two\r\nContent-Length: 0\r\n\r\n", 4096)).toMatchObject({ state: "error", error: "obsolete line folding (a header line starting with whitespace)" });
		expect(parse("HTTP/1.1 200 OK\nContent-Length: 0\n\n", 4096)).toMatchObject({ state: "error", error: "a bare LF in the header block" });
		expect(parse("HTTP/1.1 200 OK\r\nx-a: o\rne\r\n\r\n", 4096)).toMatchObject({ state: "error", error: "a bare CR in the header block" });
		expect(parse("HTTP/1.1 200 OK\r\nContent-Length : 0\r\n\r\n", 4096)).toMatchObject({ state: "error", error: "whitespace in or after a header's name" });
	});

	test("refuses a header block over its limit, without reading past it", () => {
		const big = `HTTP/1.1 200 OK\r\nContent-Length: 0\r\n${"x-pad: 0123456789\r\n".repeat(100)}\r\n`;
		expect(parse(big, 4096, "--max-head", "256")).toMatchObject({ state: "error", error: "a header block larger than the limit", head_bytes: 256 });
		expect(parse(big, 4096)).toMatchObject({ state: "done" });
	});

	test("Content-Length: equal repeats are one value, unequal ones and non-numbers an error", () => {
		expect(parse("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2, 2\r\n\r\nhi", 4096)).toMatchObject({ state: "done", body_bytes: 2 });
		expect(parse("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nhi", 4096)).toMatchObject({ state: "error", error: "Content-Length values that disagree" });
		expect(parse("HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n", 4096)).toMatchObject({ state: "error", error: "a Content-Length that is not a whole number" });
	});

	test("refuses a transfer coding other than chunked, and an interim response", () => {
		expect(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n", 4096)).toMatchObject({ state: "error", error: "a transfer coding other than chunked" });
		expect(parse("HTTP/1.1 100 Continue\r\n\r\n", 4096)).toMatchObject({ state: "error", error: "an interim (1xx) response" });
		expect(parse("HTTP/2 200\r\n\r\n", 4096)).toMatchObject({ state: "error", error: "a status line that is not HTTP/1.x with a three-digit status" });
	});

	test("a body framed by the connection's end ends at the end, and an early end is an error", () => {
		const close = "HTTP/1.1 200 OK\r\nx-a: b\r\n\r\nsome body";
		expect(parse(close, 4096)).toMatchObject({ state: "body", framing: "close", keep_alive: false });
		expect(parse(close, 4096, "--eof")).toMatchObject({ state: "done", body_bytes: 9 });
		expect(parse("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort", 4096, "--eof")).toMatchObject({ state: "error", error: "the connection ended before the body was complete", body_bytes: 5 });
		expect(parse("HTTP/1.1 200 OK\r\nContent-", 4096, "--eof")).toMatchObject({ state: "error", error: "the connection ended inside the header block" });
	});

	test("204 has no body; HTTP/1.0 and Connection: close end the connection; a body over the buffer is an error", () => {
		expect(parse("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n", 4096)).toMatchObject({ state: "done", framing: "none" });
		expect(parse("HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n", 4096)).toMatchObject({ keep_alive: false, version_minor: 0 });
		expect(parse("HTTP/1.1 200 OK\r\nConnection: keep-alive, close\r\nContent-Length: 0\r\n\r\n", 4096)).toMatchObject({ keep_alive: false });
		expect(parse("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789", 4096, "--body-cap", "4")).toMatchObject({ state: "error", error: "a body larger than the buffer for it" });
		expect(parse("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789", 4096, "--body-cap", "4", "--direct")).toMatchObject({ state: "error" });
	});
});

describe.skipIf(!AVAILABLE)("event lines (benchmarks/harness/c/lm_lines.c)", () => {
	test("received bytes are a JSON string when they are UTF-8 without NUL, and base64 otherwise", () => {
		const value = (bytes: Buffer) => driverJson(["bytes"], bytes).value;
		expect(value(Buffer.from('café "q" \\ \u{1f600}\n'))).toBe('café "q" \\ \u{1f600}\n');
		for (const bad of [[0xff], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xf5, 0x80, 0x80, 0x80], [0x61, 0x00, 0x62], [0x00]]) {
			expect(value(Buffer.from(bad))).toEqual({ base64: Buffer.from(bad).toString("base64") });
		}
	});

	/** The stream the driver printed, parsed. */
	const lines = (text: string) => text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);

	test("received bytes holding a registered secret become a marker; the line and the stream go on", () => {
		const done = driver(["received", "SeCrEt-Value-1234"], "prefix secret-value-1234 suffix");
		expect(done.status).toBe(0);
		expect(done.stdout.toLowerCase()).not.toContain("secret-value-1234");
		expect(lines(done.stdout).map((line) => line.event)).toEqual(["before", "received", "after"]);
		expect(lines(done.stdout)[1]).toEqual({ event: "received", t: 2, kept: "before", value: { withheld_bytes: 31 }, also: "after" });
	});

	test("the decision is made on the text written: a LF written as \\u000a, base64 of non-UTF-8 bytes", () => {
		// Neither input holds the secret; the text written for each would.
		const lf = driver(["received", "ASIAQLEDGERMATHTEST1"], Buffer.from("key:\nSIAQLEDGERMATHTEST1"));
		expect(lines(lf.stdout)[1]?.value).toEqual({ withheld_bytes: 24 });
		const blob = Buffer.concat([Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from("AAAAASIAQLEDGERMATHTEST1AAAA", "base64")]);
		const b64 = driver(["received", "ASIAQLEDGERMATHTEST1"], blob);
		expect(lines(b64.stdout)[1]?.value).toEqual({ withheld_bytes: blob.length });
		for (const done of [lf, b64]) {
			expect(done.status).toBe(0);
			expect(done.stdout.toLowerCase()).not.toContain("asiaqledgermathtest1");
		}
	});

	test("the guard replaces a line that still holds a secret with a fixed event, says nothing of it, and goes on", () => {
		const done = driver(["guard", "SeCrEt-Value-1234"], "prefix secret-value-1234 suffix");
		expect(done.status).toBe(0);
		expect(done.stderr).toBe("");
		expect(done.stdout.toLowerCase()).not.toContain("secret-value-1234");
		expect(lines(done.stdout)).toEqual([
			{ event: "before", t: 1 },
			{ event: "line_withheld", t: 2, withheld_event: "guarded", withheld_bytes: 99 },
			{ event: "after", t: 3, fields_withheld: 0, lines_withheld: 0 },
		]);
		expect(lines(driver(["guard", "SeCrEt-Value-1234"], "nothing of it").stdout)[1]).toMatchObject({ event: "guarded", value: "nothing of it" });
	});

	test("a secret is searched for in its common encodings too", () => {
		const secret = "lmTestSecret/abcdefghijklmnopqrstuvwxyz+0123";
		const bytes = Buffer.from(secret);
		const hex = bytes.toString("hex");
		const forms = [
			secret.toUpperCase(),
			encodeURIComponent(secret),
			[...bytes].map((b) => `%${b.toString(16).padStart(2, "0")}`).join(""),
			...[0, 1, 2].map((k) => Buffer.concat([Buffer.alloc(k, 0x41), bytes, Buffer.from("tail")]).toString("base64")),
			...[0, 1, 2].map((k) => Buffer.concat([Buffer.alloc(k, 0x41), bytes]).toString("base64url")),
			hex,
			hex.toUpperCase(),
			hex.replace(/(..)(?!$)/g, "$1 "),
			hex.replace(/(..)(?!$)/g, "$1:"),
			hex.replace(/(..)(?!$)/g, "$1-"),
		];
		for (const form of forms) expect([form, driverJson(["found", secret], `before ${form} after`).found]).toEqual([form, true]);
		expect(driverJson(["found", secret], "lmTestSecret/abcdefghijklmnopqrstuvwxyz 0123").found).toBe(false);
	});

	test("a secret that could be read inside the stream's own sample or verified lines is refused", () => {
		for (const refused of ["1234567890123456", "0,\"sample\":12345", "0123456789abcdef"]) expect(driverJson(["secret", refused]).accepted).toBe(false);
		for (const accepted of [KEY_ID, SECRET, TOKEN, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"]) {
			expect(driverJson(["secret", accepted]).accepted).toBe(true);
		}
	});
});

// ---- end to end, against the stand-in ----

describe.skipIf(!AVAILABLE)("http_get against the stand-in", () => {
	test("new connections: every phase an event, in order, each body verified, exit 0", () => {
		const r = run("ok", { samples: 3 });
		expect(r.stderr).toBe("");
		expectExit(r, 0);
		checkStream(r, 3);
		const order = sampleEvents(r, 1).map((event) => event.event);
		expect(order).toEqual(["sample_started", "name_resolved", "connection_opened", "connection_secured", "request_sent", "first_byte", "response_headers", "response_ended", "sample_ended"]);
		expect(of(r, "certificate").length).toBe(2);
		expect(of(r, "connection_closed").map((event) => event.reason)).toEqual(["done", "done", "done", "done"]);
		const ended = of(r, "response_ended");
		expect(ended.every((event) => event.fixture === "match" && event.s3_checksum === "match" && event.bytes === 4096)).toBe(true);
		expect(closing(r)).toMatchObject({ requests_made: 4, requests_not_made: 0, ended_early: null, responses_2xx_verified: 4, body_bytes: 4096, body_mismatch: false, statuses: { "200": 4 }, failures: {} });
		const first = opening(r);
		expect(first).toMatchObject({ tls_library: "AWS-LC 5.14.0", ca_certificates_loaded: 1, ca_certificates_rejected: 0, resolver: `127.0.0.1:${ports.dns_port}` });
		const hello = first.client_hello as Record<string, unknown>;
		expect(hello.supported_groups).toEqual(["X25519MLKEM768", "SecP256r1MLKEM768", "SecP384r1MLKEM1024", "X25519", "P-256", "P-384"]);
		expect((hello.cipher_suites as string[]).slice(0, 3)).toEqual(["TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256"]);
		expect(hello.alpn).toEqual(["http/1.1"]);
		expect(hello.supported_versions).toEqual(["TLSv1.3", "TLSv1.2"]);
		expect(hello.extensions).not.toContain("status_request");
		expect(hello.extensions).not.toContain("signed_certificate_timestamp");
		const sent = of(r, "request_sent")[0] as Event;
		expect(sent.headers).toEqual([
			["Host", `ok.s3.lm.test:${ports.https_port}`],
			["User-Agent", "ledgermath-http_get/1"],
			["x-amz-checksum-mode", "ENABLED"],
			["x-amz-content-sha256", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
			["x-amz-date", expect.stringMatching(/^\d{8}T\d{6}Z$/)],
			["x-amz-security-token", "<withheld>"],
			["Authorization", "<withheld>"],
		]);
		expect(sent.signing).toMatchObject({ algorithm: "AWS4-HMAC-SHA256", signed_headers: "host;x-amz-checksum-mode;x-amz-content-sha256;x-amz-date;x-amz-security-token" });
		// Twelve digits between hex letters are not an account ID: the ETag is printed as received.
		const response = of(r, "response_headers")[0] as Event;
		expect(response.headers).toContainEqual(["ETag", '"f123456789012a0123456789abcdef01"']);
		// The two edges of each sample are the first and last phase boundaries.
		const sample = sampleEvents(r, 2);
		expect((sample.at(-1) as Event).t).toBe((sample.at(-2) as Event).t);
	}, RUN_TIMEOUT_MS);

	test("what the stand-in received was signed correctly: the signature agrees with one computed here", () => {
		const before = standinLog().length;
		run("ok", { samples: 1 });
		const received = standinLog().slice(before);
		expect(received.length).toBe(2);
		for (const request of received) {
			const authorization = header(request, "authorization") as string;
			const signed = (authorization.match(/SignedHeaders=([^,]+)/) as RegExpMatchArray)[1] as string;
			const headers = signed.split(";").map((nameOf) => [nameOf, header(request, nameOf) as string] as [string, string]);
			const theirs = independentSignature({
				method: request.method,
				uri: request.target,
				query: "",
				headers,
				payload: header(request, "x-amz-content-sha256") as string,
				date: header(request, "x-amz-date") as string,
				region: "us-east-2",
				service: "s3",
				secret: SECRET,
			});
			expect(authorization).toBe(
				`AWS4-HMAC-SHA256 Credential=${KEY_ID}/${(header(request, "x-amz-date") as string).slice(0, 8)}/us-east-2/s3/aws4_request, SignedHeaders=${signed}, Signature=${theirs.signature}`,
			);
			expect(header(request, "x-amz-security-token")).toBe(TOKEN);
		}
	}, RUN_TIMEOUT_MS);

	test("a reused connection: opened once, before sample 0 and outside it; each sample is one request on it", () => {
		const r = run("ok", { samples: 5, connection: "reused" });
		expectExit(r, 0);
		checkStream(r, 5);
		const opened = one(r, "connection_opened");
		expect(opened.request).toBeUndefined();
		const firstSample = r.events.findIndex((event) => event.event === "sample_started");
		expect(r.events.indexOf(opened)).toBeLessThan(firstSample);
		expect(sampleEvents(r, 3).map((event) => event.event)).toEqual(["sample_started", "request_sent", "first_byte", "response_headers", "response_ended", "sample_ended"]);
		expect(one(r, "connection_closed")).toMatchObject({ reason: "end_of_run", requests: 6 });
		expect(closing(r)).toMatchObject({ connections_opened: 1, responses_2xx_verified: 6 });
	}, RUN_TIMEOUT_MS);

	test("128 KiB, and a chunked 2xx, verify too", () => {
		const big = run("ok", { samples: 2, objectBytes: 131072 });
		expectExit(big, 0);
		checkStream(big, 2);
		expect(of(big, "response_ended").every((event) => event.bytes === 131072 && event.fixture === "match")).toBe(true);
		const chunked = run("chunked", { samples: 1 });
		expectExit(chunked, 0);
		checkStream(chunked, 1);
		expect(of(chunked, "response_ended").every((event) => event.framing === "chunked" && event.fixture === "match")).toBe(true);
	}, RUN_TIMEOUT_MS);

	test("errors are events and the Run goes on: 403, 503, a reset, a short body and a stall in one Run, exit 4", () => {
		const r = run("mixed-one", { samples: 11, timeoutMs: 2000 });
		expectExit(r, 4);
		checkStream(r, 11);
		expect(closing(r)).toMatchObject({ requests_made: 12, responses: 9, responses_2xx_verified: 7, requests_failed: 3, statuses: { "200": 7, "403": 1, "503": 1 }, failures: { reset: 1, eof: 1, timeout: 1 }, body_mismatch: false });
		const failed = of(r, "request_failed");
		expect(failed.map((event) => [event.request, event.error])).toEqual([[6, "reset"], [8, "eof"], [10, "timeout"]]);
		// A reset can overtake the half body the stand-in sent before it: Linux drops what was not read yet.
		const [reset, short, stall] = failed as [Event, Event, Event];
		expect(["first_byte", "headers", "body"]).toContain(reset.phase as string);
		expect(reset.body_bytes_received ?? 0).toBeLessThanOrEqual(2048);
		for (const event of [short, stall]) expect(event).toMatchObject({ phase: "body", content_length: 4096, body_bytes_received: 2048 });
		const ended = of(r, "response_ended");
		const forbidden = ended.find((event) => event.request === 2) as Event;
		expect(forbidden.body).toContain("<Code>AccessDenied</Code>");
		expect(forbidden.error_fields).toEqual({ Code: "AccessDenied", Message: "Access Denied", RequestId: "STANDIN000000002", HostId: "c3RhbmQtaW4gaG9zdCBpZA==" });
		expect((ended.find((event) => event.request === 4) as Event).error_fields).toMatchObject({ Code: "SlowDown" });
		const response403 = of(r, "response_headers").find((event) => event.request === 2) as Event;
		expect(response403).toMatchObject({ status: 403, status_line: "HTTP/1.1 403 Forbidden" });
		expect(of(r, "connection_closed").filter((event) => event.reason === "failed").length).toBe(3);
	}, RUN_TIMEOUT_MS);

	test("a stall ends at timeout_ms, in the body phase, with what had arrived", () => {
		const r = run("stall", { samples: 1, timeoutMs: 500 });
		expectExit(r, 4);
		checkStream(r, 1);
		for (const failed of of(r, "request_failed")) {
			const firstByte = of(r, "first_byte").find((event) => event.request === failed.request) as Event;
			expect(failed).toMatchObject({ phase: "body", error: "timeout", bytes_received: expect.any(Number), body_bytes_received: 2048 });
			expect(failed.t - firstByte.t).toBeGreaterThanOrEqual(450e6);
		}
	}, RUN_TIMEOUT_MS);

	test("a short body ended by close_notify, and one ended by TCP alone, are each an eof", () => {
		const short = run("short", { samples: 1 });
		const fin = run("shortfin", { samples: 1 });
		for (const r of [short, fin]) {
			expectExit(r, 4);
			checkStream(r, 1);
			expect(of(r, "request_failed").every((event) => event.phase === "body" && event.error === "eof")).toBe(true);
		}
		expect(of(short, "request_failed")[0]?.detail).toStartWith("close_notify");
		// AWS-LC queues its own error for a TCP end without close_notify; the detail is its words.
		expect(of(fin, "request_failed")[0]?.detail).toContain("UNEXPECTED_EOF");
	}, RUN_TIMEOUT_MS);

	test("a body that fails its checks exits 1, every event kept: a wrong checksum, none, other bytes", () => {
		const expectations: Array<[string, string, string]> = [
			["badsum", "match", "mismatch"],
			["nosum", "match", "absent"],
			["wrongbody", "mismatch", "match"],
		];
		for (const [scenario, fixture, s3] of expectations) {
			const r = run(scenario, { samples: 1 });
			expectExit(r, 1);
			checkStream(r, 1);
			expect(of(r, "response_ended").every((event) => event.fixture === fixture && event.s3_checksum === s3)).toBe(true);
			expect(closing(r)).toMatchObject({ body_mismatch: true, responses_2xx_verified: 0, body_bytes: null });
		}
	}, RUN_TIMEOUT_MS);

	test("a slow first byte shows in the time to first byte, and is not an error", () => {
		const r = run("slow", { samples: 1 });
		expectExit(r, 0);
		checkStream(r, 1);
		for (const sent of of(r, "request_sent")) {
			const first = of(r, "first_byte").find((event) => event.request === sent.request) as Event;
			expect(first.t - sent.t).toBeGreaterThanOrEqual(290e6);
		}
	}, RUN_TIMEOUT_MS);

	test("a header block over 64 KiB, and obsolete line folding, are protocol errors", () => {
		const big = run("bigheaders", { samples: 1 });
		expectExit(big, 4);
		checkStream(big, 1);
		expect(of(big, "request_failed")[0]).toMatchObject({ phase: "headers", error: "protocol", detail: "a header block larger than the limit", head_received: { withheld_bytes: 65536 } });
		const folded = run("folded", { samples: 1 });
		expectExit(folded, 4);
		checkStream(folded, 1);
		const failed = of(folded, "request_failed")[0] as Event;
		expect(failed).toMatchObject({ phase: "headers", error: "protocol", detail: "obsolete line folding (a header line starting with whitespace)" });
		expect(failed.head_received).toContain("x-folded: one\r\n two");
	}, RUN_TIMEOUT_MS);

	test("a certificate from another CA, and one for another name, fail the TLS phase with the reason", () => {
		const bad = run("badcert", { samples: 1 });
		expectExit(bad, 4);
		checkStream(bad, 1);
		expect(of(bad, "connection_secured")).toEqual([]);
		expect(of(bad, "request_failed").every((event) => event.phase === "tls" && event.error === "verify")).toBe(true);
		// The stand-in sends the other CA after its leaf, so the library meets a root it does not trust.
		expect(of(bad, "request_failed")[0]?.detail).toBe("self signed certificate in certificate chain");
		const wrong = run("wrongname", { samples: 1 });
		expectExit(wrong, 4);
		checkStream(wrong, 1);
		expect(of(wrong, "request_failed").every((event) => event.phase === "tls" && event.error === "verify")).toBe(true);
		expect(of(wrong, "request_failed")[0]?.detail).toBe("Hostname mismatch");
	}, RUN_TIMEOUT_MS);

	test("DNS: NXDOMAIN and a truncated reply are recorded as received; no reply is a timeout", () => {
		const nx = run("nxdomain", { samples: 1 });
		expectExit(nx, 4);
		checkStream(nx, 1);
		const resolved = of(nx, "name_resolved")[0] as Event;
		expect(resolved).toMatchObject({ rcode: 3, truncated: false, answers: [] });
		expect(resolved.authority).toEqual(["lm.test. 60 SOA ns.lm.test. hostmaster.lm.test. 1 7200 900 1209600 60"]);
		expect(resolved.address).toBeUndefined();
		expect(of(nx, "request_failed")[0]).toMatchObject({ phase: "dns", error: "dns", detail: "the reply's rcode is not NOERROR" });
		expect(of(nx, "connection_opened")).toEqual([]);

		const truncated = run("truncated", { samples: 1 });
		checkStream(truncated, 1);
		expect(of(truncated, "name_resolved")[0]).toMatchObject({ truncated: true });
		expect(of(truncated, "request_failed")[0]).toMatchObject({ phase: "dns", detail: "the reply was truncated (TC set)" });

		const drop = run("dnsdrop", { samples: 1, timeoutMs: 300 });
		checkStream(drop, 1);
		expect(of(drop, "name_resolved")).toEqual([]);
		expect(of(drop, "request_failed")[0]).toMatchObject({ phase: "dns", error: "timeout" });
	}, RUN_TIMEOUT_MS);

	test("a refused connection is recorded with the address it went to", () => {
		const r = run("refused", { samples: 1 });
		expectExit(r, 4);
		checkStream(r, 1);
		expect(of(r, "connection_opened")[0]).toMatchObject({ address: "127.0.0.2" });
		expect(of(r, "request_failed")[0]).toMatchObject({ phase: "connect", error: "refused" });
	}, RUN_TIMEOUT_MS);

	test("ten requests in a row that reach no server end the Run early, and say so", () => {
		const r = run("nxdomain", { samples: 20 });
		expectExit(r, 4);
		checkStream(r, null);
		expect(of(r, "sample_started").length).toBe(10);
		expect(closing(r)).toMatchObject({ requests_made: 10, requests_not_made: 11, ended_early: "unreachable" });
		expect(streamProblems(r.events, 20)).toEqual(["expected 20 counted samples, found 9"]);
	}, RUN_TIMEOUT_MS);

	test("the budget ends the Run before a request it cannot start in time", () => {
		const r = run("ok", { samples: 50, gapMs: 400, budgetSeconds: 1 });
		expectExit(r, 4);
		checkStream(r, null);
		const values = closing(r);
		expect(values.ended_early).toBe("budget");
		expect((values.requests_not_made as number) + (values.requests_made as number)).toBe(51);
		expect(values.requests_made as number).toBeLessThan(10);
	}, RUN_TIMEOUT_MS);

	test("a reused connection the server closes is reopened outside the next sample", () => {
		const close = run("close", { samples: 3, connection: "reused" });
		expectExit(close, 0);
		checkStream(close, 3);
		expect(of(close, "connection_closed").map((event) => event.reason)).toEqual(["server_requested", "server_requested", "server_requested", "server_requested"]);
		expect(of(close, "connection_opened").every((event) => event.request === undefined)).toBe(true);
		expect(of(close, "connection_opened").length).toBe(4);

		const idle = run("idleclose", { samples: 2, connection: "reused", gapMs: 300 });
		expectExit(idle, 0);
		checkStream(idle, 2);
		const reasons = of(idle, "connection_closed").map((event) => event.reason);
		expect(reasons.slice(0, -1).every((reason) => reason === "close_notify_while_idle" || reason === "eof_while_idle")).toBe(true);
	}, RUN_TIMEOUT_MS);

	test("an error body that echoes the credentials and the signature is withheld, its safe fields kept", () => {
		const before = standinLog().length;
		const r = run("echo", { samples: 1 });
		expectExit(r, 4);
		checkStream(r, 1);
		// The stand-in did echo them: its responses were built from what it received.
		expect(standinLog().slice(before).every((request) => header(request, "x-amz-security-token") === TOKEN)).toBe(true);
		for (const ended of of(r, "response_ended")) {
			expect(ended.body).toEqual({ withheld_bytes: expect.any(Number) });
			expect(ended.error_fields).toMatchObject({ Code: "SignatureDoesNotMatch", RequestId: expect.stringMatching(/^STANDIN/) });
			expect((ended.error_fields as Record<string, unknown>).Message).toContain("does not match");
		}
	}, RUN_TIMEOUT_MS);

	test("an error body that names an account is withheld, and so is the field that names it", () => {
		const r = run("accountid", { samples: 1 });
		expectExit(r, 4);
		checkStream(r, 1);
		expect(r.stdout).not.toContain("123456789012");
		for (const ended of of(r, "response_ended")) {
			expect(ended.body).toEqual({ withheld_bytes: expect.any(Number) });
			expect(ended.error_fields).toMatchObject({ Code: "AccessDenied", Message: { withheld_bytes: expect.any(Number) } });
		}
	}, RUN_TIMEOUT_MS);

	test("where a check of the bytes and a check of the text written would disagree, the field is withheld and the Run goes on", () => {
		const cases: Array<[string, (r: Run) => unknown]> = [
			["guardlf", (r) => (of(r, "response_ended")[0]?.error_fields as Record<string, unknown>).Message],
			["guardb64", (r) => (of(r, "response_ended")[0]?.error_fields as Record<string, unknown>).Code],
			["guardlfhead", (r) => of(r, "request_failed")[0]?.head_received],
			["guardb64head", (r) => of(r, "request_failed")[0]?.head_received],
		];
		for (const [scenario, field] of cases) {
			const r = run(scenario, { samples: 1 });
			expectExit(r, 4);
			checkStream(r, 1);
			expect([scenario, field(r)]).toEqual([scenario, { withheld_bytes: expect.any(Number) }]);
		}
	});

	test("bytes holding a NUL are written as base64, not as \\u0000", () => {
		const r = run("nulhead", { samples: 1 });
		expectExit(r, 4);
		checkStream(r, 1);
		const head = of(r, "request_failed")[0]?.head_received as { base64: string };
		expect(Buffer.from(head.base64, "base64").toString("latin1")).toContain("x-a: b\u0000c");
		expect(r.stdout).not.toContain("\\u0000");
	});

	test("no core file, and no other process may read the binary's memory, from before the credentials are read", async () => {
		const child = spawn(BINARY, [], { env: environment("stall", { samples: 1, timeoutMs: 20_000 }), stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		await new Promise<void>((resolve, reject) => {
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
				if (stdout.includes("\n")) resolve();
			});
			child.on("exit", (code) => reject(new Error(`exited ${code} before its first line: ${stderr}`)));
		});
		const pid = child.pid as number;
		const limits = readFileSync(`/proc/${pid}/limits`, "utf8");
		expect(limits).toMatch(/^Max core file size\s+0\s+0\s+bytes\s*$/m);
		// A process that is not dumpable has its /proc files owned by root.
		expect(statSync(`/proc/${pid}/environ`).uid).toBe(0);
		const exited = new Promise((resolve) => child.on("exit", resolve));
		child.kill("SIGTERM");
		await exited;
		outputs.push({ label: "core stdout", text: stdout }, { label: "core stderr", text: stderr });
	});

	test("auth none sends no signing headers and reads no credentials", () => {
		const before = standinLog().length;
		const r = run("ok", { samples: 1, auth: "none", env: { LM_SERVICE_AWS_ACCESS_KEY_ID: undefined, LM_SERVICE_AWS_SECRET_ACCESS_KEY: undefined, LM_SERVICE_AWS_SESSION_TOKEN: undefined, LM_SERVICE_REGION: undefined } });
		expectExit(r, 0);
		checkStream(r, 1);
		expect((of(r, "request_sent")[0] as Event).headers).toEqual([["Host", `ok.s3.lm.test:${ports.https_port}`], ["User-Agent", "ledgermath-http_get/1"], ["x-amz-checksum-mode", "ENABLED"]]);
		expect(of(r, "request_sent")[0]?.signing).toBeUndefined();
		expect(standinLog().slice(before).every((request) => header(request, "authorization") === undefined)).toBe(true);
	}, RUN_TIMEOUT_MS);

	test("a missing input or a malformed credential is a usage error, after `started` alone, echoing nothing", () => {
		const missing = run("ok", { env: { LM_SERVICE_ENDPOINT: undefined } });
		expectExit(missing, 2);
		expect(missing.events.map((event) => event.event)).toEqual(["started"]);
		expect(missing.stderr).toBe("usage error: LM_SERVICE_ENDPOINT is not set\n");
		const badKey = run("ok", { env: { LM_SERVICE_AWS_ACCESS_KEY_ID: "asia-not-a-key-id-but-secret" } });
		expectExit(badKey, 2);
		expect(badKey.stderr).toBe("usage error: LM_SERVICE_AWS_ACCESS_KEY_ID is not an access key ID (16 to 128 capital letters and digits)\n");
		expect(badKey.stdout + badKey.stderr).not.toContain("asia-not-a-key-id-but-secret");
		const http = run("ok", { env: { LM_SERVICE_ENDPOINT: "http://ok.s3.lm.test" } });
		expectExit(http, 2);
		// A secret this short could turn up by chance in what is printed, and the guard would refuse it there.
		const short = run("ok", { env: { LM_SERVICE_AWS_SECRET_ACCESS_KEY: "x/y" } });
		expectExit(short, 2);
		expect(short.stderr).toBe("usage error: LM_SERVICE_AWS_SECRET_ACCESS_KEY is shorter than any secret key (16 characters)\n");
	}, RUN_TIMEOUT_MS);
});

describe.skipIf(!AVAILABLE)("what should be deterministic is", () => {
	test("two Runs of the same set: the same events in the same order, the same offer, the same guard", () => {
		const a = run("ok", { samples: 3 });
		const b = run("ok", { samples: 3 });
		expect(a.events.map((event) => event.event)).toEqual(b.events.map((event) => event.event));
		expect(opening(a).client_hello).toEqual(opening(b).client_hello);
		expect(opening(a).fixture_sha256).toBe(opening(b).fixture_sha256);
		expect(one(a, "verified").checksum).toBe(one(b, "verified").checksum);
		expect(of(a, "request_sent").map((event) => event.request_bytes)).toEqual(of(b, "request_sent").map((event) => event.request_bytes));
		// The Fixture's digest is the stand-in's body's, computed apart from the binary.
		expect(opening(a).fixture_sha256).toBe("72f840c3ae501f19c3083101c1e79c84b13fae0289077549d73b4647c253ef8c");
	}, RUN_TIMEOUT_MS);

	test("the gaps between requests follow the fixed seed, outside every sample", () => {
		const meanMs = 40;
		const r = run("ok", { samples: 6, connection: "reused", gapMs: meanMs });
		expectExit(r, 0);
		// The gaps, computed apart: SplitMix64 from the seed "ledgerma", exponential with the mean.
		const mask = (1n << 64n) - 1n;
		const mix = (value: bigint) => {
			let x = value & mask;
			x ^= x >> 30n;
			x = (x * 0xbf58476d1ce4e5b9n) & mask;
			x ^= x >> 27n;
			x = (x * 0x94d049bb133111ebn) & mask;
			return x ^ (x >> 31n);
		};
		let state = 0x6c65646765726d61n;
		const gaps = Array.from({ length: 6 }, () => {
			state = (state + 0x9e3779b97f4a7c15n) & mask;
			const u = Number(mix(state) >> 11n) / 2 ** 53;
			return -meanMs * 1e6 * Math.log1p(-u);
		});
		const starts = of(r, "sample_started").map((event) => event.t);
		const ends = of(r, "sample_ended").map((event) => event.t);
		for (let i = 0; i + 1 < starts.length; i++) {
			expect((starts[i + 1] as number) - (ends[i] as number)).toBeGreaterThanOrEqual((gaps[i] as number) * 0.999);
		}
	}, RUN_TIMEOUT_MS);

	test("two builds give the same bytes", () => {
		const hashOf = () => createHash("sha256").update(readFileSync(BINARY)).digest("hex");
		const first = hashOf();
		const again = make("-B", "BUILD=static");
		if (again.status !== 0) throw new Error(`make -B exited ${again.status}:\n${again.stdout}${again.stderr}`);
		const second = hashOf();
		if (second !== first) throw new Error(`the rebuild hashes ${second}, the first build ${first}:\n${again.stdout}${again.stderr}`);
		expect(again.stdout).toContain("aws-lc: AWS-LC 5.14.0 is already built");
	}, BUILD_TIMEOUT_MS);
});

describe.skipIf(!AVAILABLE)("no secret reaches any output", () => {
	test("the scan finds the credentials where they are: in what the stand-in received", () => {
		expect(secretsIn(readFileSync(ports.requests, "utf8")).sort()).toEqual([KEY_ID, TOKEN, ...signaturesReceived()].sort());
	});

	test("no stream and no stderr of these tests holds a key ID, the secret, the token or a signature", () => {
		expect(outputs.length).toBeGreaterThan(40);
		const found = outputs.filter((output) => secretsIn(output.text).length > 0).map((output) => output.label);
		expect(found).toEqual([]);
	});
});
