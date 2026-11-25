/**
 * Before the publish job uploads a tree: does the public edge serve every
 * kind of file the tree holds? The edge answers 404 to every key of no served
 * shape (infra/runs/public-blobs.ts, SERVED), and learns a new shape only from
 * a deploy of production-runs made by hand; the code of this checkout knows
 * the new shape already, so the build, the check and the tests all pass while
 * the deployed edge would refuse the files. A tree that linked them would send
 * readers to 404s. So, for each kind of file in the tree (TREE_KINDS), one
 * file of that kind (the first by path) is asked for at its public address,
 * and every schema (the edge serves schemas by a list of their names, so a
 * new schema is a shape of its own); and only the edge's own refusal stops
 * the upload: a 404 whose body begins
 * with the words the edge's functions answer with (EDGE_NOT_FOUND_OPENING),
 * which S3 never sends (it answers a missing key of a served shape with its
 * 403 AccessDenied, in XML).
 *
 * Any other answer lets the upload go on: 200; S3's 403 for a file not yet
 * written (the first publish of a kind); any other status; a 5xx; a timeout;
 * a network error. The public address being down, slow or unreachable from
 * GitHub's runner must never stop a publish: the bucket is what the job
 * writes, and the edge serves it whenever it is up.
 *
 * The public address is the tree's own: its table of contents' url, less
 * v1/index.json. Nothing is asked of a tree that is not served publicly: one
 * built for another host than the public API's (API_DOMAIN), or while the
 * public API's committed switch is not "on" (PUBLIC_API.state, which the
 * release gate holds to the state deployed); nor of a directory with no table
 * of contents giving its address, which the upload's own preflight refuses.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { TREE_KINDS } from "../../infra/runs/api-bucket";
import { API_DOMAIN, EDGE_NOT_FOUND_OPENING, PUBLIC_API, type PublicApiState } from "../../infra/runs/public-blobs";

/** How long one question to the edge may take, answer and body together. */
export const EDGE_TIMEOUT_MS = 10_000;
/** The most bytes of a 404's body read to tell the edge's refusal: its words are about 150 bytes. */
const BODY_BYTES = 4096;

export type EdgeVerdict =
	/** The edge's own 404: it does not serve this kind of file. */
	| "refused"
	/** Any answer that is not that: 200, S3's 403, another status. */
	| "answered"
	/** No answer to go by: a timeout, a network error, a 5xx. */
	| "unknown";

export interface EdgeAnswer {
	kind: string;
	path: string;
	url: string;
	verdict: EdgeVerdict;
	/** What came back, in words: the status, or why there was none. */
	detail: string;
}

export interface EdgeProbe {
	/** Whether the edge was asked at all; when not, why not. */
	asked: boolean;
	why?: string;
	answers: EdgeAnswer[];
	/** The kinds the edge refuses: the upload must not go on. */
	refused: EdgeAnswer[];
}

export interface EdgeOptions {
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	timeoutMs?: number;
	/** The public API's switch; defaults to the committed one. */
	state?: PublicApiState;
	/** Ask at this address instead of the tree's own (a stand-in for the edge, in tests); the tree must still be one the public API serves. */
	edge?: string;
}

/** Every file under directory, by its path from it with forward slashes, in path order. */
function listFiles(directory: string): string[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The base a tree was built for, from its table of contents; a sentence saying why not when there is none to read. */
function baseOf(tree: string): string | { why: string } {
	const at = join(tree, "v1", "index.json");
	if (!existsSync(at)) return { why: `${tree} holds no v1/index.json, so no public address to ask` };
	let index: unknown;
	try {
		index = JSON.parse(readFileSync(at, "utf8"));
	} catch {
		return { why: `${tree}'s v1/index.json is not JSON, so no public address to ask` };
	}
	const url = typeof index === "object" && index !== null ? (index as { url?: unknown }).url : undefined;
	if (typeof url !== "string" || !url.endsWith("/v1/index.json") || !URL.canParse(url)) return { why: `${tree}'s v1/index.json gives no address of its own, so no public address to ask` };
	return url.slice(0, -"/v1/index.json".length);
}

/** At most `limit` bytes of a body, as text; what could be read when the body fails or ends early. */
async function opening(response: Response, limit: number): Promise<string> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.byteLength;
		}
	} catch {
		// What was read is what there is.
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(Math.min(total, limit));
	let at = 0;
	for (const chunk of chunks) {
		const part = chunk.subarray(0, bytes.length - at);
		bytes.set(part, at);
		at += part.length;
		if (at >= bytes.length) break;
	}
	return new TextDecoder().decode(bytes);
}

/** Whether a response is the edge's own refusal of an address of no served shape: a 404 whose body begins with its functions' words. */
export async function isEdgeRefusal(response: Response): Promise<boolean> {
	if (response.status !== 404) return false;
	return (await opening(response, BODY_BYTES)).startsWith(EDGE_NOT_FOUND_OPENING);
}

/** Asks the edge for one file of each kind of file in the tree, and says which kinds it refuses (see the comment at the top). */
export async function probeEdge(tree: string, options: EdgeOptions = {}): Promise<EdgeProbe> {
	const base = baseOf(tree);
	if (typeof base !== "string") return { asked: false, why: base.why, answers: [], refused: [] };
	const state = options.state ?? PUBLIC_API.state;
	const host = new URL(base).host;
	if (state !== "on") return { asked: false, why: `the public API is not on (its switch is ${state}), so nothing of the tree is served publicly`, answers: [], refused: [] };
	if (host !== API_DOMAIN.name || !base.startsWith("https://")) {
		return { asked: false, why: `the tree was built for ${base}, not https://${API_DOMAIN.name}, so the public API does not serve it`, answers: [], refused: [] };
	}
	const ask = (options.edge ?? base).replace(/\/+$/, "");
	const get = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
	const timeout = options.timeoutMs ?? EDGE_TIMEOUT_MS;
	const files = listFiles(tree);
	// One file of each kind; but every schema, whose names the edge holds as a list, so that a new schema is a new shape of its own.
	const asked: Array<{ kind: string; path: string }> = [];
	for (const { kind, path: shape } of TREE_KINDS) {
		const ofKind = files.filter((file) => shape.test(file));
		for (const path of ofKind[0]?.startsWith("v1/schemas/") === true ? ofKind : ofKind.slice(0, 1)) asked.push({ kind, path });
	}
	const answers: EdgeAnswer[] = [];
	for (const { kind, path } of asked) {
		const url = `${ask}/${path}`;
		const signal = AbortSignal.timeout(timeout);
		let answer: EdgeAnswer;
		try {
			const response = await get(url, { method: "GET", redirect: "manual", signal, headers: { accept: "application/json" } });
			if (await isEdgeRefusal(response)) answer = { kind, path, url, verdict: "refused", detail: "404 from the edge itself: no served shape" };
			else if (response.status >= 500) answer = { kind, path, url, verdict: "unknown", detail: `${response.status}: no answer to go by` };
			else answer = { kind, path, url, verdict: "answered", detail: String(response.status) };
			await response.body?.cancel().catch(() => {});
		} catch (error) {
			answer = { kind, path, url, verdict: "unknown", detail: signal.aborted ? `no answer within ${timeout} ms` : `no answer: ${error instanceof Error ? error.message : String(error)}` };
		}
		answers.push(answer);
	}
	return { asked: true, answers, refused: answers.filter((answer) => answer.verdict === "refused") };
}
