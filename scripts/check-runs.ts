/**
 * Checks a directory laid out like a -runs stage's bucket:
 *
 *     runs/<yyyy>/<mm>/<dd>/<id>.json    blobs/sha256/<hex>    boots/<yyyy>/<mm>/<dd>/<boot>.json
 *
 *     bun scripts/check-runs.ts DIR                   everything below
 *     bun scripts/check-runs.ts --no-blobs DIR        the Run files alone
 *     bun scripts/check-runs.ts --omitted FILE DIR    blobs listed in FILE may be absent
 *
 * FILE is a JSON array of {"blob": "sha256:<hex>", ...}, as tests/samples has.
 *
 * For every Run file:
 *   - it validates against schemas/run.schema.json, and each of its events
 *     against schemas/events.schema.json;
 *   - its name is its id, under the date it started;
 *   - every sha256:<hex> it holds, and every section a dump index names,
 *     resolves to blobs/sha256/<hex>, whose bytes hash to <hex>;
 *   - its `runner` manifest lists exactly the files under runner/ in its
 *     `source` archive, with their hashes, when that archive is in blobs/
 *     (the output says how many manifests could not be checked);
 *   - its stdout blob holds exactly its events, line for line;
 *   - when the binary exited 0, its stream passes scripts/check-events.py.
 * For every boot summary: every Run it lists is there.
 *
 * Interprets nothing about the numbers. Exit status 0 when all holds, 1 when not.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

const ROOT = resolve(import.meta.dir, "..");
const HASH = /^sha256:([0-9a-f]{64})$/;
const DUMP_SCHEMA = "ledgermath.dump/1";

export interface RunEvent {
	event: string;
	t: number;
	[key: string]: unknown;
}

export interface RunRecord {
	id: string;
	started_at: string;
	source: string;
	runner: string;
	samples: number;
	environment: { before: string; after: string };
	exit: { code: number; runner_signal?: number } | { signal: number; timeout_seconds?: number; runner_signal?: number };
	events: RunEvent[];
	events_error?: { line: number; message: string };
	stdout: string;
	[key: string]: unknown;
}

export interface Validators {
	run: ValidateFunction<RunRecord>;
	event: ValidateFunction<RunEvent>;
}

export function loadValidators(): Validators {
	const ajv = new Ajv2020({ strict: true, allErrors: true });
	const read = (name: string): object =>
		JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as object;
	return {
		run: ajv.compile<RunRecord>(read("run.schema.json")),
		event: ajv.compile<RunEvent>(read("events.schema.json")),
	};
}

export function describeErrors(validate: ValidateFunction): string {
	return (validate.errors ?? [])
		.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
		.join("; ");
}

function filesUnder(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
}

/** Every string in `value` that looks like sha256:<hex>, depth first. */
function hashesIn(value: unknown, found: string[] = []): string[] {
	if (typeof value === "string") {
		if (HASH.test(value)) found.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) hashesIn(item, found);
	} else if (typeof value === "object" && value !== null) {
		for (const item of Object.values(value)) hashesIn(item, found);
	}
	return found;
}

function isDumpIndex(value: unknown): value is { schema: string; sections: Record<string, string> } {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { schema?: unknown }).schema === DUMP_SCHEMA &&
		typeof (value as { sections?: unknown }).sections === "object"
	);
}

export interface CheckResult {
	runs: number;
	events: number;
	blobs: number;
	/** Runs whose runner manifest was checked against their source archive, and Runs whose was not. */
	manifests: { checked: number; unchecked: number };
	problems: string[];
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The regular files of a tar.gz, by path. Reads what git archive writes:
 * POSIX ustar entries, with pax headers for long paths.
 */
export function readTarGz(archive: Buffer): Map<string, Buffer> {
	const tar = gunzipSync(archive);
	const files = new Map<string, Buffer>();
	const text = (block: Buffer, start: number, length: number): string =>
		block.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
	let longPath: string | undefined;
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const size = Number.parseInt(text(header, 124, 12).trim() || "0", 8);
		const type = text(header, 156, 1) || "0";
		const prefix = text(header, 257, 6) === "ustar" ? text(header, 345, 155) : "";
		const name = longPath ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
		const body = tar.subarray(offset + 512, offset + 512 + size);
		if (type === "x") {
			// pax records: "<length> <key>=<value>\n"
			for (const record of body.toString("utf8").split("\n")) {
				const match = /^\d+ path=(.*)$/s.exec(record);
				if (match) longPath = match[1];
			}
		} else if (type !== "g") {
			if (type === "0") files.set(name, Buffer.from(body));
			longPath = undefined;
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return files;
}

/**
 * What differs between a runner manifest (`<sha256>  <path>` per line, as
 * runner/run.py writes it) and the files under runner/ in a source archive.
 * run.py leaves out build/ and __pycache__/ directories, and so does this.
 */
export function runnerManifestProblems(manifest: string, archive: Map<string, Buffer>): string[] {
	const problems: string[] = [];
	const listed = new Map<string, string>();
	for (const line of manifest.split("\n")) {
		if (line === "") continue;
		const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
		if (match?.[1] && match[2]) listed.set(match[2], match[1]);
		else problems.push(`unreadable line ${JSON.stringify(line)}`);
	}
	const held = new Map<string, string>();
	for (const [path, bytes] of archive) {
		if (!path.startsWith("runner/")) continue;
		const inside = path.slice("runner/".length);
		if (inside.split("/").some((part) => part === "build" || part === "__pycache__")) continue;
		held.set(inside, sha256(bytes));
	}
	for (const [path, hash] of listed) {
		const actual = held.get(path);
		if (actual === undefined) problems.push(`lists ${path}, which the source archive's runner/ does not hold`);
		else if (actual !== hash) problems.push(`${path}: listed as ${hash}, but the source archive's is ${actual}`);
	}
	for (const path of held.keys()) {
		if (!listed.has(path)) problems.push(`does not list runner/${path}, which the source archive holds`);
	}
	return problems;
}

export interface CheckOptions {
	/** Check that every hash resolves; false checks the Run files alone. */
	blobs: boolean;
	/** Hashes whose blobs were left out on purpose and may be absent. */
	omitted?: ReadonlySet<string>;
}

export function checkBucketDirectory(directory: string, options: CheckOptions): CheckResult {
	const validators = loadValidators();
	const problems: string[] = [];
	const checkedBlobs = new Map<string, Buffer | null>();
	const archives = new Map<string, Map<string, Buffer>>();
	const manifests = { checked: 0, unchecked: 0 };
	let eventCount = 0;

	const blob = (hash: string): Buffer | null => {
		const cached = checkedBlobs.get(hash);
		if (cached !== undefined) return cached;
		const hex = HASH.exec(hash)?.[1] ?? "";
		const path = join(directory, "blobs", "sha256", hex);
		let bytes: Buffer | null = null;
		if (existsSync(path)) {
			bytes = readFileSync(path);
			if (createHash("sha256").update(bytes).digest("hex") !== hex) {
				problems.push(`blobs/sha256/${hex}: its bytes do not hash to its name`);
			}
		}
		checkedBlobs.set(hash, bytes);
		return bytes;
	};

	const runFiles = filesUnder(join(directory, "runs"));
	const runIds = new Set<string>();
	for (const file of runFiles) {
		const where = relative(directory, file);
		let record: unknown;
		try {
			record = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			problems.push(`${where}: not JSON: ${String(error)}`);
			continue;
		}
		if (!validators.run(record)) {
			problems.push(`${where}: ${describeErrors(validators.run)}`);
			continue;
		}
		const run = record;
		runIds.add(run.id);

		const day = run.started_at.slice(0, 10).replaceAll("-", "/");
		const expected = join("runs", day, `${run.id}.json`);
		if (where !== expected) problems.push(`${where}: should be at ${expected}`);

		run.events.forEach((event, index) => {
			if (!validators.event(event)) {
				problems.push(`${where}: event ${index + 1}: ${describeErrors(validators.event)}`);
			}
		});
		eventCount += run.events.length;

		if (!options.blobs) continue;

		for (const hash of hashesIn(run)) {
			const bytes = blob(hash);
			if (bytes === null) {
				if (!options.omitted?.has(hash)) problems.push(`${where}: ${hash} has no blob`);
				continue;
			}
			if (hash !== run.environment.before && hash !== run.environment.after) continue;
			let index: unknown;
			try {
				index = JSON.parse(bytes.toString("utf8"));
			} catch {
				index = null;
			}
			if (!isDumpIndex(index)) {
				problems.push(`${where}: ${hash} is not a ${DUMP_SCHEMA} index`);
				continue;
			}
			for (const [section, sectionHash] of Object.entries(index.sections)) {
				if (!HASH.test(sectionHash) || blob(sectionHash) === null) {
					problems.push(`${where}: dump ${hash} section ${section}: ${sectionHash} has no blob`);
				}
			}
		}

		const manifest = blob(run.runner);
		const source = blob(run.source);
		if (manifest !== null && source !== null) {
			let archive = archives.get(run.source);
			if (archive === undefined) {
				try {
					archive = readTarGz(source);
				} catch (error) {
					problems.push(`${where}: its source archive cannot be read: ${String(error)}`);
					archive = new Map();
				}
				archives.set(run.source, archive);
			}
			for (const problem of runnerManifestProblems(manifest.toString("utf8"), archive)) {
				problems.push(`${where}: runner manifest: ${problem}`);
			}
			manifests.checked++;
		} else {
			manifests.unchecked++;
		}

		const stdout = blob(run.stdout);
		if (stdout === null) continue;
		const text = stdout.toString("utf8");
		const lines = text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		const parsed = lines.slice(0, run.events_error ? run.events_error.line - 1 : lines.length);
		const matches =
			parsed.length === run.events.length &&
			parsed.every((line, index) => JSON.stringify(JSON.parse(line)) === JSON.stringify(run.events[index]));
		if (!matches) problems.push(`${where}: its events are not its stdout, line for line`);

		if ("code" in run.exit && run.exit.code === 0) {
			const quick = run.events[0]?.quick === true;
			const args = [join(ROOT, "scripts", "check-events.py"), "--samples", String(run.samples)];
			if (quick) args.push("--quick");
			const checked = spawnSync("python3", args, { input: stdout, encoding: "utf8" });
			if (checked.status !== 0) {
				problems.push(`${where}: check-events.py: ${(checked.stderr || checked.error?.message || "").trim()}`);
			}
		}
	}

	for (const file of filesUnder(join(directory, "boots"))) {
		const where = relative(directory, file);
		const summary = JSON.parse(readFileSync(file, "utf8")) as { runs?: Array<{ id?: unknown }> };
		for (const listed of summary.runs ?? []) {
			if (typeof listed.id !== "string" || !runIds.has(listed.id)) {
				problems.push(`${where}: lists run ${String(listed.id)}, which is not under runs/`);
			}
		}
	}

	const resolved = [...checkedBlobs.values()].filter((bytes) => bytes !== null).length;
	return { runs: runFiles.length, events: eventCount, blobs: resolved, manifests, problems };
}

export function loadOmitted(file: string): Set<string> {
	const list = JSON.parse(readFileSync(file, "utf8")) as Array<{ blob?: unknown }>;
	return new Set(list.map((entry) => String(entry.blob)));
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	let blobs = true;
	let omitted: Set<string> | undefined;
	const directories: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "--no-blobs") blobs = false;
		else if (arg === "--omitted" && args[i + 1]) omitted = loadOmitted(args[++i] ?? "");
		else directories.push(arg);
	}
	if (directories.length !== 1 || !directories[0]) {
		console.error("usage: bun scripts/check-runs.ts [--no-blobs] [--omitted FILE] DIR");
		process.exit(2);
	}
	const directory = resolve(directories[0]);
	const result = checkBucketDirectory(directory, { blobs, omitted });
	for (const problem of result.problems) console.error(problem);
	if (result.runs === 0) {
		console.error(`no Run files under ${join(basename(dirname(directory)), basename(directory))}/runs`);
		process.exit(1);
	}
	if (result.problems.length > 0) process.exit(1);
	console.log(
		`ok: ${result.runs} runs, ${result.events} events${blobs ? `, ${result.blobs} blobs resolved and hashed` : ""}`,
	);
	if (blobs) {
		const { checked, unchecked } = result.manifests;
		if (checked > 0) console.log(`runner manifests: ${checked} checked against their source archive`);
		if (unchecked > 0) {
			console.log(`runner manifests: ${unchecked} NOT checked: their source archive or manifest is not in blobs/`);
		}
	} else {
		console.log("blobs, and with them the runner manifests, were not checked (--no-blobs)");
	}
}
