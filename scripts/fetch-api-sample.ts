/**
 * Takes the fixed sample the API reference's examples come from (scripts/lib/api-reference.ts):
 * real files of the data API, fetched once and kept in the repository, so that a page of the
 * reference does not change every six hours with the live files.
 *
 *     bun scripts/fetch-api-sample.ts --series ID --out DIR [--base https://api.ledgermath.com]
 *
 * One Series is followed through every kind of file, by the links the files give and the
 * templates the table of contents gives, never by an address built from the layout: the table
 * of contents (v1/index.json), the list of every Series (v1/series.json), the Series'
 * benchmark's list (benchmarks.list[].url), the Series' file (its row's url), its newest month
 * file (months[].url), the Run file of its newest point (evidence), that Run's stdout blob
 * (evidence.blob_url_template with the Run's stdout hash: one event a line), and the newest
 * price file (prices.newest.url). Each is written byte for byte as served, under DIR at the
 * path of its address below the base, and DIR/sample.json lists them: when they were taken,
 * from where, and each file's kind, path, address, size and sha256.
 *
 * The files must agree, being of one update of the API: the month file's size and sha256 are
 * the ones its Series file lists, the Run file's sha256 the one its point gives, the stdout
 * blob's the one its Run file names, the Series' row the same line in the benchmark's list as
 * in the list of every Series, and the table of contents' count of Series and newest Run those
 * of the list. Otherwise nothing is written, and it says to run again later (the API's own
 * rule for files of different updates).
 *
 * DIR must not exist or be empty: a sample is written whole, never mixed with an older one. To
 * take a new sample, move the old one away first. Exit 0 when written, 1 when not (with why),
 * 2 on a bad command line.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SAMPLE_MANIFEST = "sample.json";
const TIMEOUT_MS = 30_000;

/** The kinds of file the sample holds, one each: the name of the schema each is checked against (events: each line of the blob). */
export const SAMPLE_KINDS = ["index", "series-list", "benchmark", "series", "series-month", "prices", "run", "events"] as const;
export type SampleKind = (typeof SAMPLE_KINDS)[number];

export interface SampleFile {
	kind: SampleKind;
	/** Its path under the sample's directory: its address below the base. */
	path: string;
	url: string;
	bytes: number;
	sha256: string;
}

export interface SampleManifest {
	taken_at: string;
	base: string;
	series: string;
	files: SampleFile[];
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function get(url: string): Promise<Uint8Array> {
	const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

const parse = (bytes: Uint8Array): any => JSON.parse(new TextDecoder().decode(bytes));

/** The line of a file that holds the row of Series ID: rows are written one to a line, the last without a comma after it. */
function rowLine(bytes: Uint8Array, id: string): string | undefined {
	const line = new TextDecoder().decode(bytes).split("\n").find((text) => text.includes(`"id":"${id}"`));
	return line?.trim().replace(/,$/, "");
}

/** Fetches the sample of Series ID from the API at BASE; throws, saying why, when the files do not agree. */
export async function takeSample(base: string, id: string): Promise<{ manifest: SampleManifest; contents: Map<string, Uint8Array> }> {
	const files: SampleFile[] = [];
	const contents = new Map<string, Uint8Array>();
	const keep = async (kind: SampleKind, url: string): Promise<Uint8Array> => {
		if (!url.startsWith(`${base}/`)) throw new Error(`${url} is not under ${base}`);
		const bytes = await get(url);
		const path = url.slice(base.length + 1);
		files.push({ kind, path, url, bytes: bytes.length, sha256: sha256(bytes) });
		contents.set(path, bytes);
		return bytes;
	};

	const indexBytes = await keep("index", `${base}/v1/index.json`);
	const index = parse(indexBytes);
	const listBytes = await keep("series-list", index.series.url);
	const list = parse(listBytes);
	const row = (list.series as any[]).find((candidate) => candidate.id === id);
	if (row === undefined) throw new Error(`no Series ${id} in ${index.series.url}`);
	const entry = (index.benchmarks?.list as any[] | undefined)?.find((candidate) => candidate.name === row.benchmark);
	const benchmarkUrl = entry?.url ?? String(index.benchmarks.benchmark_file_url_template).replace("{benchmark}", row.benchmark);
	const benchmarkBytes = await keep("benchmark", benchmarkUrl);
	const seriesBytes = await keep("series", row.url);
	const series = parse(seriesBytes);
	const month = series.months[series.months.length - 1];
	const monthBytes = await keep("series-month", month.url);
	const points = series.derivations.series_v1.newest_points as any[];
	const point = points[points.length - 1];
	const runBytes = await keep("run", point.evidence);
	const run = parse(runBytes);
	const stdoutBytes = await keep("events", String(index.evidence.blob_url_template).replace("{hex}", String(run.stdout).replace(/^sha256:/, "")));
	await keep("prices", index.prices.newest.url);

	const disagreements: string[] = [];
	if (monthBytes.length !== month.bytes || sha256(monthBytes) !== month.sha256) disagreements.push(`the month file ${month.url} is not the size and sha256 its Series file lists`);
	if (sha256(runBytes) !== point.sha256) disagreements.push(`the Run file ${point.evidence} is not the sha256 its point gives`);
	if (`sha256:${sha256(stdoutBytes)}` !== run.stdout) disagreements.push(`the stdout blob is not the sha256 its Run file names`);
	if (rowLine(benchmarkBytes, id) !== rowLine(listBytes, id)) disagreements.push(`the Series' row in ${benchmarkUrl} is not its row in ${index.series.url}`);
	if (row.runs !== series.runs) disagreements.push(`the Series' row counts ${row.runs} Runs and its file ${series.runs}`);
	if (index.series.count !== list.count || index.newest_run_started_at !== list.newest_run_started_at) disagreements.push("the table of contents and the list of every Series are of different updates");
	if (disagreements.length > 0) throw new Error(`the files are of different updates of the API; run again later:\n${disagreements.join("\n")}`);

	files.sort((a, b) => SAMPLE_KINDS.indexOf(a.kind) - SAMPLE_KINDS.indexOf(b.kind));
	return { manifest: { taken_at: new Date().toISOString(), base, series: id, files }, contents };
}

function option(argv: readonly string[], name: string): string | undefined {
	const at = argv.indexOf(`--${name}`);
	return at === -1 ? undefined : argv[at + 1];
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const id = option(argv, "series");
	const out = option(argv, "out");
	const base = (option(argv, "base") ?? "https://api.ledgermath.com").replace(/\/+$/, "");
	if (id === undefined || out === undefined) {
		console.error("usage: bun scripts/fetch-api-sample.ts --series ID --out DIR [--base URL]");
		process.exit(2);
	}
	if (existsSync(out) && readdirSync(out).length > 0) {
		console.error(`${out} exists and is not empty: a sample is written whole into a new or empty directory`);
		process.exit(1);
	}
	try {
		const { manifest, contents } = await takeSample(base, id);
		for (const [path, bytes] of contents) {
			const file = join(out, ...path.split("/"));
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, bytes);
		}
		writeFileSync(join(out, SAMPLE_MANIFEST), `${JSON.stringify(manifest, null, "\t")}\n`);
		for (const file of manifest.files) console.log(`${file.kind}\t${file.bytes}\t${file.path}`);
		console.log(`${manifest.files.reduce((sum, file) => sum + file.bytes, 0)} bytes in ${manifest.files.length} files, taken ${manifest.taken_at} from ${base}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
