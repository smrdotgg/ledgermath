/**
 * Puts together a directory laid out as https://api.ledgermath.com serves the
 * same files, from the data API's tree as the runs workflow keeps it (the
 * artifact api) and a clone of the Runs repository: the data of one run,
 * pinned (README, "Data from one run").
 *
 *     bun scripts/assemble-location.ts --api DIR --runs DIR --out DIR
 *
 *   --api DIR    the artifact api of a run of the runs workflow, downloaded
 *                (gh run download <run id> --name api --dir DIR): it holds v1/
 *   --runs DIR   a clone of smrdotgg/ledgermath-runs, at or after that run
 *   --out DIR    a new or empty directory
 *
 * OUT gets v1/ byte for byte, and beside it every Run file and boot summary
 * the tree links (from its points, and from its table of contents' newest
 * rounds of boots), copied from the clone. The tree is read first
 * (scripts/lib/ledger-data.ts): every file the table of contents lists must
 * be there (each price file read as prices reads it, each schema JSON), every
 * month file must have the sha256 its Series file lists, and every Run file
 * the sha256 its point gives; anything else stops it before it writes,
 * naming the file. The same inputs give the same directory. It writes only
 * inside OUT.
 *
 * Exit 0 when OUT is whole; 2 when it stopped.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { LedgerError, LIMITS, loadLedger, openLocation, seriesPoints } from "./lib/ledger-data";

const USAGE = "usage: bun scripts/assemble-location.ts --api DIR --runs DIR --out DIR";

function fail(message: string): never {
	console.error(message);
	process.exit(2);
}

/** Every file under a directory, by its path from it with forward slashes, in order. */
function files(directory: string): string[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();
}

function copy(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(from, to);
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { api: { type: "string" }, runs: { type: "string" }, out: { type: "string" } } });
	if (values.api === undefined || values.runs === undefined || values.out === undefined) fail(USAGE);
	const api = resolve(values.api);
	const runs = resolve(values.runs);
	const out = resolve(values.out);
	if (!existsSync(join(api, "v1", "index.json"))) fail(`${api} holds no v1/index.json: it is not the artifact api, downloaded`);
	if (!existsSync(join(runs, "runs"))) fail(`${runs} holds no runs/: it is not a clone of the Runs repository`);
	if (existsSync(out) && (!statSync(out).isDirectory() || readdirSync(out).length > 0)) fail(`${out} is not a new or empty directory`);

	// Read the tree: its layout, its list, every Series file and every month file, each checked against its sha256.
	const data = await loadLedger(openLocation(api));
	const list = await data.list();
	const evidence = new Map<string, string | null>();
	const boots = new Set<string>();
	const linked = (url: string): string => {
		const path = data.pathOf(url);
		if (path === null) throw new LedgerError(`${url}, a link in the tree, is not under ${data.treeBase}`);
		return path;
	};
	for (const row of list.series) {
		const read = await data.seriesWithMonths(row.id, (series) => series.months);
		if (read === null) throw new LedgerError(`Series ${row.id} is in the list but has no file`);
		for (const point of seriesPoints(read.months)) {
			evidence.set(linked(point.evidence), point.sha256);
			if (point.boot_summary !== null) boots.add(linked(point.boot_summary));
		}
	}
	for (const method of [list.methods.series_v1, list.methods.requests_v1]) {
		for (const run of method?.unreadable ?? []) if (!evidence.has(linked(run.evidence))) evidence.set(linked(run.evidence), run.sha256);
	}
	// The boot summaries the table of contents links: each boot of its newest rounds (a boot that left no Run included) and each summary it lists as
	// in no round with an address. A table of contents written before the rounds were links none.
	const rounds = data.index.recent_rounds;
	for (const round of rounds?.rounds ?? []) for (const boot of round.by_boot) boots.add(linked(boot.boot_summary));
	for (const left of rounds?.left_out?.summaries ?? []) if (left.boot_summary !== null) boots.add(linked(left.boot_summary));

	const problems: string[] = [];
	// Every other file the table of contents lists: each price file, read as prices reads it, and each schema.
	for (const path of data.priceFiles) {
		try {
			if ((await data.readPrices(path)) === null) problems.push(`the price file ${path}: the table of contents lists it, and it cannot be found`);
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	}
	for (const schema of data.index.schemas ?? []) {
		try {
			const { path, bytes } = await data.readLinked(schema.url, LIMITS.schema, "a schema");
			if (bytes === null) problems.push(`${path}: the schema ${schema.name}, which the table of contents lists, is not in ${api}`);
			else JSON.parse(new TextDecoder().decode(bytes));
		} catch (error) {
			problems.push(`the schema ${schema.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (problems.length > 0) fail(`Nothing was written. The tree in ${api} is not whole:\n  ${problems.join("\n  ")}`);

	for (const [path, sha256] of evidence) {
		const from = join(runs, path);
		if (!existsSync(from)) problems.push(`${path}: not in ${runs}`);
		else if (sha256 !== null && createHash("sha256").update(readFileSync(from)).digest("hex") !== sha256) problems.push(`${path}: its bytes are not the sha256 the tree gives`);
	}
	for (const path of boots) if (!existsSync(join(runs, path))) problems.push(`${path}: not in ${runs}`);
	if (problems.length > 0) fail(`Nothing was written. The clone does not hold the Run files the tree links (clone it again, or pull):\n  ${problems.join("\n  ")}`);

	const tree = files(join(api, "v1"));
	for (const path of tree) copy(join(api, "v1", path), join(out, "v1", path));
	for (const path of [...evidence.keys(), ...boots].sort()) copy(join(runs, path), join(out, path));
	console.log(
		`${out}: v1/ (${tree.length} files, layout ${data.index.layout}, ${list.series.length} Series, data through ${data.index.newest_run_started_at}), ${evidence.size} Run files and ${boots.size} boot summaries. ` +
			`Every month file has its listed sha256 and every Run file its point's.\nStart at ${join(out, "v1", "index.json")}; a link in the tree is to the file at its path under ${data.treeBase}.`,
	);
}

if (import.meta.main) {
	main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
}
