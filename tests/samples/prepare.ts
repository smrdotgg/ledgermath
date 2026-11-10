/**
 * Turns a recorded bucket directory into a sample directory under tests/samples.
 *
 *     bun tests/samples/prepare.ts <recorded bucket dir> <sample dir>
 *
 * Copies runs/, boots/ and blobs/, then:
 *
 *   - Replaces every identifying field (tests/samples/identifying.ts, listed in
 *     tests/samples/README.md) with its example value, wherever its value
 *     appears. Every blob whose bytes change is renamed to its new hash, and
 *     the new hash replaces the old one wherever it is cited, up through the
 *     dump indexes to the Runs, so every hash still resolves.
 *   - Leaves out the blobs a Run cites as `binary.blob` and `source`, the
 *     benchmark binaries and the source archive, and lists them in
 *     omitted-blobs.json with their sizes.
 *   - Fails if any identifying field is left holding anything but its example.
 *
 * The real values are read from the recording and never printed.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { allFields, asText, EXAMPLE, identifyingProblems } from "./identifying";

interface RecordedRun {
	binary: { blob: string; build: string };
	source: string;
}

interface OmittedBlob {
	blob: string;
	bytes: number;
	what: string;
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

function jsonFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => join(entry.parentPath, entry.name));
}

/** Replaces each value where it stands as a whole word, never inside a longer run of letters and digits. */
function replaceWhole(text: string, replacements: Array<[string, string]>): string {
	let result = text;
	for (const [from, to] of replacements) {
		const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		result = result.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g"), to);
	}
	return result;
}

function main(): void {
	const [recorded, target] = process.argv.slice(2);
	if (!recorded || !target) {
		console.error("usage: bun tests/samples/prepare.ts <recorded bucket dir> <sample dir>");
		process.exit(2);
	}
	for (const part of ["runs", "boots", "blobs"]) {
		rmSync(join(target, part), { recursive: true, force: true });
		cpSync(join(recorded, part), join(target, part), { recursive: true });
	}
	const blobDirectory = join(target, "blobs", "sha256");
	const recordFiles = [...jsonFiles(join(target, "runs")), ...jsonFiles(join(target, "boots"))];

	// What to replace: every identifying value found, and the EC2 host name
	// each private address implies.
	const replacements = new Map<string, string>();
	const fieldNames = new Set<string>();
	for (const field of allFields(target)) {
		if (field.value === field.example) continue;
		if (field.example === "null") {
			throw new Error(`${field.file}: ${field.name} is set, and there is no example value to put in its place`);
		}
		replacements.set(field.value, field.example);
		fieldNames.add(field.name);
	}
	for (const [value, example] of [...replacements]) {
		if (example === EXAMPLE.privateIp) replacements.set(`ip-${value.replaceAll(".", "-")}`, EXAMPLE.hostname);
	}
	console.log(`replacing ${replacements.size} identifying values, found as: ${[...fieldNames].sort().join("; ")}`);

	// Rewrite blobs until none changes: a changed blob's new hash replaces its
	// old one in the blobs that cite it, which then change in turn.
	const hashes = new Map<string, string>();
	const order = (): Array<[string, string]> =>
		[...replacements, ...hashes].sort(([a], [b]) => b.length - a.length);
	for (let changed = true; changed; ) {
		changed = false;
		const pairs = order();
		for (const name of readdirSync(blobDirectory)) {
			const path = join(blobDirectory, name);
			const text = asText(readFileSync(path));
			if (text === null) continue;
			const rewritten = replaceWhole(text, pairs);
			if (rewritten === text) continue;
			const hex = sha256(rewritten);
			writeFileSync(path, rewritten);
			renameSync(path, join(blobDirectory, hex));
			hashes.set(name, hex);
			changed = true;
		}
	}
	for (const path of recordFiles) {
		writeFileSync(path, replaceWhole(readFileSync(path, "utf8"), order()));
	}

	const omitted = new Map<string, OmittedBlob>();
	for (const path of jsonFiles(join(target, "runs"))) {
		const run = JSON.parse(readFileSync(path, "utf8")) as RecordedRun;
		const cited: Array<[string, string]> = [
			[run.binary.blob, `the ${run.binary.build} benchmark binary`],
			[run.source, "the source archive (git archive of source_commit)"],
		];
		for (const [blob, what] of cited) {
			const file = join(blobDirectory, blob.slice("sha256:".length));
			if (existsSync(file)) {
				omitted.set(blob, { blob, bytes: statSync(file).size, what });
				rmSync(file);
			}
		}
	}
	const list = [...omitted.values()].sort((a, b) => a.blob.localeCompare(b.blob));
	writeFileSync(join(target, "omitted-blobs.json"), `${JSON.stringify(list, null, 2)}\n`);

	const left = identifyingProblems(target);
	if (left.length > 0) throw new Error(`identifying values are left:\n${left.join("\n")}`);
	console.log(`${jsonFiles(join(target, "runs")).length} runs; omitted ${list.length} blobs; no identifying value left`);
}

main();
