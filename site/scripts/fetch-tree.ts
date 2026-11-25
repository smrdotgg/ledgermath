/**
 * Fetches from the data API the files the site is built from, into a new directory laid out as
 * the API serves them: a tree for `bun run build --tree DIR`.
 *
 *     bun run fetch-tree DIR [--index URL]     (URL defaults to https://api.ledgermath.com/v1/index.json)
 *
 * It fetches the table of contents at URL, the one address it is given, and after that only the
 * addresses the table of contents gives for the files the site reads (treeFiles in
 * src/data/tree.ts): the Series list and the newest price file. It never builds an address,
 * and refuses a link that is not under the table of contents' own base. Every request has a
 * time limit (TIMEOUT_MS) and a size limit (LIMITS, by file), and follows no redirect. A file
 * that does not parse as JSON, does not say it is what it should be (the table of contents of
 * the API's version 1, `ledgermath.api.index/1`; the Series list, `ledgermath.api.series-list/1`;
 * a price file, `ledgermath.prices/1`), or lacks a part the site reads, is refused. Whatever is
 * refused, nothing is written.
 *
 * DIR must not exist, or be empty: a tree is written whole or not at all, never mixed with an
 * older one. The files are written, byte for byte as served, once all three are fetched and
 * checked: into a directory beside DIR, which then takes DIR's name.
 *
 * Exit 0 when the tree is written, 1 when it is not (with why), 2 on a bad command line.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { INDEX_PATH, parseIndex, parsePrices, parseSeriesList, treeFiles } from "../src/data/tree";

export const INDEX_URL = "https://api.ledgermath.com/v1/index.json";
/** How long one request may take, answer and body together. */
export const TIMEOUT_MS = 30_000;
/**
 * The most bytes each file may hold, as served (decompressed). Ten times the ceilings the API's
 * own check holds its files to (scripts/lib/api-check.ts), so the API's check, not this, is
 * what a growing file meets first.
 */
export const LIMITS = { index: 1_000_000, seriesList: 10_000_000, prices: 10_000_000 } as const;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type FetchOptions = { index?: string; get?: Fetch; timeoutMs?: number; limits?: { index: number; seriesList: number; prices: number } };

export type FetchedTree = { dir: string; files: { path: string; url: string; bytes: number }[]; newestRunStartedAt: string; hasRecentRounds: boolean };

/** The body at URL, at most LIMIT bytes, within TIMEOUT ms; throws, saying why, on anything else. */
async function fetchBytes(url: string, limit: number, timeout: number, get: Fetch): Promise<Uint8Array> {
	const signal = AbortSignal.timeout(timeout);
	let response: Response;
	try {
		response = await get(url, { redirect: "manual", cache: "no-store", signal, headers: { accept: "application/json" } });
	} catch (error) {
		throw new Error(`${url}: ${signal.aborted ? `no answer within ${timeout} ms` : error instanceof Error ? error.message : String(error)}`);
	}
	if (response.status !== 200) {
		const location = response.headers.get("location");
		throw new Error(`${url} answered ${response.status}${location ? ` (Location: ${location})` : ""}, not 200`);
	}
	const declared = Number(response.headers.get("content-length") ?? NaN);
	if (Number.isFinite(declared) && declared > limit && !response.headers.get("content-encoding")) {
		throw new Error(`${url} is ${declared} bytes, over the limit of ${limit}`);
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel().catch(() => {});
				throw new Error(`${url} is over the limit of ${limit} bytes`);
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof Error && error.message.includes("over the limit")) throw error;
		throw new Error(`${url}: reading the body: ${signal.aborted ? `not read within ${timeout} ms` : error instanceof Error ? error.message : String(error)}`);
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return bytes;
}

function parseJson(bytes: Uint8Array, url: string): unknown {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`${url} is not UTF-8 text`);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${url} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Fetches the tree the site reads into DIR; see the comment at the top. */
export async function fetchTree(dir: string, options: FetchOptions = {}): Promise<FetchedTree> {
	const out = resolve(dir);
	if (existsSync(out) && (!statSync(out).isDirectory() || readdirSync(out).length > 0)) {
		throw new Error(`${dir} exists and is not an empty directory: a tree is written into a new one`);
	}
	const get = options.get ?? fetch;
	const timeout = options.timeoutMs ?? TIMEOUT_MS;
	const limits = options.limits ?? LIMITS;
	const indexUrl = options.index ?? INDEX_URL;

	const indexBytes = await fetchBytes(indexUrl, limits.index, timeout, get);
	const index = parseIndex(parseJson(indexBytes, indexUrl), indexUrl);
	if (index.url !== indexUrl) throw new Error(`${indexUrl} gives its own address as ${index.url}: fetch the table of contents from where it says it is`);
	const files = [{ path: INDEX_PATH, url: indexUrl, bytes: indexBytes }];
	for (const file of treeFiles(index, indexUrl)) {
		const bytes = await fetchBytes(file.url, limits[file.kind], timeout, get);
		const json = parseJson(bytes, file.url);
		if (file.kind === "seriesList") {
			const list = parseSeriesList(json, file.url);
			if (list.series.length !== index.series.count) throw new Error(`${indexUrl} counts ${index.series.count} Series, ${file.url} lists ${list.series.length}`);
		} else {
			parsePrices(json, file.url);
		}
		files.push({ path: file.path, url: file.url, bytes });
	}

	const work = `${out}.fetching-${process.pid}`;
	rmSync(work, { recursive: true, force: true });
	try {
		for (const file of files) {
			mkdirSync(dirname(join(work, file.path)), { recursive: true });
			writeFileSync(join(work, file.path), file.bytes);
		}
		mkdirSync(dirname(out), { recursive: true });
		renameSync(work, out);
	} catch (error) {
		rmSync(work, { recursive: true, force: true });
		throw error;
	}
	return {
		dir: out,
		files: files.map((file) => ({ path: file.path, url: file.url, bytes: file.bytes.byteLength })),
		newestRunStartedAt: index.newest_run_started_at,
		hasRecentRounds: index.recent_rounds !== undefined,
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	let index: string | undefined;
	const words: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--index") index = args[++i];
		else if (arg.startsWith("--index=")) index = arg.slice("--index=".length);
		else words.push(arg);
	}
	if (words.length !== 1 || (index !== undefined && !/^https:\/\//.test(index))) {
		console.error("usage: bun run fetch-tree DIR [--index https://…/v1/index.json]");
		process.exit(2);
	}
	try {
		const tree = await fetchTree(words[0]!, { index });
		for (const file of tree.files) console.log(`${file.path}  ${file.bytes.toLocaleString("en")} bytes  from ${file.url}`);
		console.log(
			`wrote the tree to ${tree.dir}: newest Run ${tree.newestRunStartedAt}; ${tree.hasRecentRounds ? "the table of contents gives recent_rounds" : "the table of contents gives no recent_rounds, so the page will be built without \"Latest runs\""}`,
		);
	} catch (error) {
		console.error(`no tree written: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
