/**
 * The publish job's question to the public edge, before anything is uploaded
 * (scripts/lib/api-edge.ts, scripts/check-api-edge.ts): one file of each kind
 * the tree holds, and every schema, asked for at the tree's own address; only
 * the edge's own 404 stops the upload, and the edge being down, slow or
 * unreachable never does. The stand-ins for the edge run the request
 * function's own code (infra/runs/public-blobs.ts) and, behind it, answer as
 * S3 does: the file, or a 403 for a key it does not hold.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { TREE_KINDS } from "../infra/runs/api-bucket";
import { API_DOMAIN, EDGE_NOT_FOUND_OPENING, REQUEST_FUNCTION_CODE } from "../infra/runs/public-blobs";
import { buildApi, DEFAULT_BASE, readApiSchemas, readBootFiles, readBootSummaries, readPriceFiles } from "../scripts/lib/api";
import { isEdgeRefusal, probeEdge } from "../scripts/lib/api-edge";
import { makeApiFixture } from "./api-fixtures";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");

type Handler = (event: { context: { eventType: string }; request: { method: string; uri: string; headers: Record<string, { value: string }> } }) => unknown;
/** The request function, as CloudFront Functions loads it. */
const handler = new Function(`${REQUEST_FUNCTION_CODE}\nreturn handler;`)() as Handler;
type FunctionResponse = { statusCode: number; headers: Record<string, { value: string }>; body?: { data: string } };
const isFunctionResponse = (value: unknown): value is FunctionResponse => typeof value === "object" && value !== null && "statusCode" in value;

/** What the request function itself answers for a path: its response, or null when it lets the request on to the bucket. */
function functionAnswer(path: string): Response | null {
	const out = handler({ context: { eventType: "viewer-request" }, request: { method: "GET", uri: path, headers: { host: { value: API_DOMAIN.name } } } });
	if (!isFunctionResponse(out)) return null;
	return new Response(out.body?.data ?? "", { status: out.statusCode, headers: Object.fromEntries(Object.entries(out.headers).map(([name, { value }]) => [name, value])) });
}

/** The edge's own refusal, as the request function writes it for an address of no served shape. */
const refusal = (): Response => functionAnswer("/v1/notes.md") as Response;
/** S3 behind the edge, for a key it does not hold. */
const accessDenied = (): Response => new Response('<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { status: 403, headers: { "content-type": "application/xml" } });

/**
 * A stand-in for the edge in front of a bucket holding `held`: the request function's own answer where it gives one, else the file or S3's 403.
 * `refuses` makes it refuse more paths with the function's own 404, as an edge deployed before a shape was added does.
 */
function edge(held: ReadonlySet<string>, refuses: (path: string) => boolean = () => false) {
	const asked: string[] = [];
	const get = async (url: string): Promise<Response> => {
		const path = new URL(url).pathname;
		asked.push(path.slice(1));
		if (refuses(path.slice(1))) return refusal();
		const own = functionAnswer(path);
		if (own !== null) return own;
		return held.has(path.slice(1)) ? new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) : accessDenied();
	};
	return { get, asked };
}

let tree: Map<string, Uint8Array>;
let directory: string;

function writeTree(files: ReadonlyMap<string, Uint8Array>): string {
	const out = mkdtempSync(join(tmpdir(), "api-edge-tree-"));
	for (const [path, bytes] of files) {
		mkdirSync(dirname(join(out, path)), { recursive: true });
		writeFileSync(join(out, path), bytes);
	}
	return out;
}

beforeAll(async () => {
	const fixture = await makeApiFixture({ small: true });
	tree = buildApi({
		base: DEFAULT_BASE,
		docs: "https://example.test/docs",
		series: fixture.series,
		requests: fixture.requests,
		prices: readPriceFiles(fixture.runs),
		boots: readBootSummaries(fixture.runs),
		bootFiles: readBootFiles(fixture.runs),
		schemas: readApiSchemas(),
	});
	directory = writeTree(tree);
});

/** Each kind of file the fixture's tree holds, in TREE_KINDS' order. */
const kindsHeld = (): string[] => TREE_KINDS.filter((kind) => [...tree.keys()].some((path) => kind.path.test(path))).map((kind) => kind.kind);
const schemas = (): string[] => [...tree.keys()].filter((path) => path.startsWith("v1/schemas/")).sort();

describe("the edge's own refusal", () => {
	test("is the request function's 404, told by its words; S3's 403, another 404 and a 200 are not", async () => {
		const own = refusal();
		expect(own.status).toBe(404);
		expect(await isEdgeRefusal(refusal())).toBe(true);
		expect((await own.text()).startsWith(EDGE_NOT_FOUND_OPENING)).toBe(true);
		expect(await isEdgeRefusal(accessDenied())).toBe(false);
		expect(await isEdgeRefusal(new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }))).toBe(false);
		expect(await isEdgeRefusal(new Response(EDGE_NOT_FOUND_OPENING, { status: 200 }))).toBe(false);
		expect(await isEdgeRefusal(new Response(null, { status: 404 }))).toBe(false);
	});
});

describe("asking the edge before an upload", () => {
	test("an edge that serves every kind: one file of each kind and every schema asked, at the tree's own address, none refused", async () => {
		const stand = edge(new Set(tree.keys()));
		const probe = await probeEdge(directory, { fetch: stand.get });
		expect(probe.asked).toBe(true);
		expect(probe.refused).toEqual([]);
		expect([...new Set(probe.answers.map((answer) => answer.kind))]).toEqual(kindsHeld());
		expect(kindsHeld()).toEqual(TREE_KINDS.map((kind) => kind.kind));
		for (const path of schemas()) expect(stand.asked).toContain(path);
		expect(stand.asked.length).toBe(TREE_KINDS.length - 1 + schemas().length);
		for (const answer of probe.answers) expect([answer.url.startsWith(`${DEFAULT_BASE}/v1/`), answer.verdict, answer.detail]).toEqual([true, "answered", "200"]);
		// The first publish of a kind: the bucket does not hold its files yet, and S3's 403 is no refusal.
		const empty = await probeEdge(directory, { fetch: edge(new Set()).get });
		expect(empty.refused).toEqual([]);
		for (const answer of empty.answers) expect([answer.verdict, answer.detail]).toEqual(["answered", "403"]);
	});

	test("an edge deployed before each benchmark's list was served refuses both new shapes, the list and its schema, and the upload stops", async () => {
		const before = (path: string): boolean => path.startsWith("v1/benchmarks/") || path === "v1/schemas/benchmark.schema.json";
		const probe = await probeEdge(directory, { fetch: edge(new Set(tree.keys()), before).get });
		expect(probe.refused.map((answer) => [answer.kind, answer.path])).toEqual([
			["a schema", "v1/schemas/benchmark.schema.json"],
			["a benchmark's list of Series", probe.refused[1]?.path as string],
		]);
		expect(probe.refused[1]?.path.startsWith("v1/benchmarks/")).toBe(true);
	});

	test("each kind refused alone is found, and only it", async () => {
		for (const kind of TREE_KINDS) {
			const probe = await probeEdge(directory, { fetch: edge(new Set(tree.keys()), (path) => kind.path.test(path)).get });
			expect([kind.kind, [...new Set(probe.refused.map((answer) => answer.kind))]]).toEqual([kind.kind, [kind.kind]]);
		}
		// A new schema among the others is asked for, wherever its name sorts.
		for (const path of schemas()) {
			const probe = await probeEdge(directory, { fetch: edge(new Set(tree.keys()), (asked) => asked === path).get });
			expect(probe.refused.map((answer) => answer.path)).toEqual([path]);
		}
	});

	test("no answer to go by never stops the upload: a network error, a timeout, a 5xx; nor does any answer that is not the edge's own 404", async () => {
		const cases: Array<[string, (url: string, init: RequestInit) => Promise<Response>]> = [
			["a network error", async () => Promise.reject(new TypeError("fetch failed: connection refused"))],
			["a timeout", (_url, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))],
			["500", async () => new Response("Internal Server Error", { status: 500 })],
			["502", async () => new Response("Bad Gateway", { status: 502 })],
			["503", async () => new Response("Service Unavailable", { status: 503 })],
			["504", async () => new Response("Gateway Timeout", { status: 504 })],
			["a 404 of other words", async () => new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })],
			["a redirect", async () => new Response(null, { status: 301, headers: { location: "https://example.test/" } })],
			["WAF's 403", async () => new Response("<html>Request blocked.</html>", { status: 403 })],
		];
		for (const [what, get] of cases) {
			const probe = await probeEdge(directory, { fetch: get, timeoutMs: 50 });
			expect([what, probe.asked, probe.refused]).toEqual([what, true, []]);
			expect(probe.answers.length).toBe(TREE_KINDS.length - 1 + schemas().length);
		}
		const timedOut = await probeEdge(directory, { fetch: cases[1]?.[1], timeoutMs: 50 });
		expect(timedOut.answers.every((answer) => answer.verdict === "unknown" && answer.detail === "no answer within 50 ms")).toBe(true);
	});

	test("asks nothing of a tree the public API does not serve: the switch not on, another host, no table of contents giving its address", async () => {
		let asked = 0;
		const counting = async (): Promise<Response> => {
			asked++;
			return refusal();
		};
		for (const state of ["off", "dark", "closed"] as const) {
			const probe = await probeEdge(directory, { fetch: counting, state });
			expect([state, probe.asked, probe.why]).toEqual([state, false, `the public API is not on (its switch is ${state}), so nothing of the tree is served publicly`]);
		}
		const other = new Map(tree);
		const index = JSON.parse(new TextDecoder().decode(tree.get("v1/index.json")));
		other.set("v1/index.json", new TextEncoder().encode(JSON.stringify({ ...index, url: "http://localhost:8080/private/v1/index.json" })));
		expect((await probeEdge(writeTree(other), { fetch: counting })).why).toBe("the tree was built for http://localhost:8080/private, not https://api.ledgermath.com, so the public API does not serve it");
		const none = new Map([...tree].filter(([path]) => path !== "v1/index.json"));
		expect((await probeEdge(writeTree(none), { fetch: counting })).asked).toBe(false);
		expect(asked).toBe(0);
	});
});

describe("the command", () => {
	/** A stand-in for the edge on this machine, as `edge` above. */
	function serve(refuses: (path: string) => boolean): { url: string; stop: () => void } {
		const stand = edge(new Set(tree.keys()), refuses);
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => stand.get(request.url) });
		return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
	}
	/** The command, run while this process's stand-in answers it. */
	async function run(edgeUrl: string, summary: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const child = Bun.spawn([process.execPath, join(ROOT, "scripts", "check-api-edge.ts"), "--tree", directory, "--edge", edgeUrl], { env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { exitCode, stdout, stderr };
	}

	test("exits 1 and says to deploy first when the edge refuses a kind; 0 when it serves every kind, or cannot be reached", async () => {
		const out = mkdtempSync(join(tmpdir(), "api-edge-summary-"));
		const refusing = serve((path) => path.startsWith("v1/benchmarks/"));
		const refused = await run(refusing.url, join(out, "refused.md"));
		refusing.stop();
		expect(refused.exitCode).toBe(1);
		expect(refused.stderr).toContain("Not uploaded: the public edge refuses a benchmark's list of Series with its own 404");
		expect(refused.stderr).toContain("Deploy production-runs from main first");
		expect(readFileSync(join(out, "refused.md"), "utf8")).toContain("### The public edge against the tree's kinds of file");

		const serving = serve(() => false);
		const served = await run(serving.url, join(out, "served.md"));
		serving.stop();
		expect([served.exitCode, served.stderr]).toEqual([0, ""]);
		expect(served.stdout).toContain("The public edge serves every kind of file in the tree");

		// Nothing listens there any more: no answer, and the upload goes on.
		const gone = await run(serving.url, join(out, "gone.md"));
		expect(gone.exitCode).toBe(0);
		expect(gone.stdout).toContain("the upload goes on: an edge that is down or slow never stops a publish");
	});
});
