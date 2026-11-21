/**
 * Type-checks the -runs stage's wiring, which `bunx tsc --noEmit` leaves out
 * (tsconfig.json excludes infra/runs/stack.ts and infra/runs/public-blobs-stack.ts:
 * they use SST's globals, whose types are in .sst/platform):
 *
 *     bunx sst install                    # once: writes .sst/platform; asks AWS nothing
 *     bun scripts/check-stack-types.ts [--tsc PATH]
 *
 *   --tsc PATH  another compiler than node_modules/.bin/tsc: a stand-in, in the tests
 *
 * It runs the TypeScript compiler on tsconfig.stack.json, which extends
 * tsconfig.json, so the stack files are checked as strictly as the rest. SST's
 * own sources under .sst/ are part of that program and do not pass this
 * project's strict settings (noUncheckedIndexedAccess, noImplicitOverride),
 * so errors in them are counted and left aside. The check passes only when
 * the compiler ran and ended as judge() accepts: by itself (no signal); with
 * status 0 and no diagnostic, or with a non-zero status and at least one
 * diagnostic, every one of them in SST's sources; and with every line of its
 * output a diagnostic or a diagnostic's continuation. Anything else fails it:
 * an error in this project's files or tied to no file, a compiler that could
 * not start or was killed, a non-zero status with nothing to show for it,
 * output it cannot read, and a program that does not hold every file of
 * STACK_FILES (a check that checked nothing would pass).
 *
 * One run covers every state of the public API's switch: PUBLIC_API is
 * declared as PublicApiSetting, not as its literal value (a test holds it
 * so), so the compiler sees each state's branch whatever state is committed;
 * tests/public-api-graph.test.ts then builds each state's resources.
 *
 * .github/workflows/check.yml runs it after `bunx sst install`.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..");
const CONFIG = "tsconfig.stack.json";
/** The files the check is for: every one must be in the program. */
export const STACK_FILES = ["infra/runs/stack.ts", "infra/runs/public-blobs-stack.ts"] as const;

export interface Sorted {
	/** Errors in this project's files, or not tied to a file: each fails the check. */
	ours: string[];
	/** Errors in SST's own sources, under .sst/: counted, left aside. */
	sst: number;
	/** Lines that are neither a diagnostic nor a diagnostic's continuation: output the check cannot read. */
	unread: string[];
}

/** Sorts the compiler's output (--pretty false) into errors of this project, errors of SST's sources, and lines it cannot read. */
export function sortErrors(output: string, root: string): Sorted {
	const ours: string[] = [];
	const unread: string[] = [];
	let sst = 0;
	let inDiagnostic = false;
	for (const line of output.split("\n")) {
		const located = /^(.+?)\(\d+,\d+\): error TS\d+/.exec(line);
		if (located !== null) {
			const file = relative(root, resolve(root, located[1] as string));
			if (file === ".sst" || file.startsWith(".sst/")) sst++;
			else ours.push(line);
			inDiagnostic = true;
			continue;
		}
		if (/^error TS\d+/.test(line.trim())) {
			ours.push(line.trim());
			inDiagnostic = true;
			continue;
		}
		if (line.trim() === "") continue;
		// A diagnostic's message goes on, indented, on the lines after it.
		if (inDiagnostic && /^\s/.test(line)) continue;
		unread.push(line);
		inDiagnostic = false;
	}
	return { ours, sst, unread };
}

/** How the compiler ended. */
export interface Ended {
	/** The exit status, or null when it did not exit by itself. */
	status: number | null;
	/** The signal that ended it, or null. */
	signal: string | null;
	/** stdout and stderr, together. */
	output: string;
	/** Why it could not be started, if it could not. */
	error?: string;
}

export interface Judgement extends Sorted {
	/** Why the check fails; empty when it passes. */
	problems: string[];
}

/** Whether a compiler run passes the check, and why not. */
export function judge(ended: Ended, root: string): Judgement {
	const sorted = sortErrors(ended.output, root);
	const problems: string[] = [];
	if (ended.error !== undefined) problems.push(`the compiler could not be started: ${ended.error}`);
	else if (ended.signal !== null) problems.push(`the compiler was ended by ${ended.signal}, so its output cannot be trusted to be whole`);
	else if (ended.status === null) problems.push("the compiler gave no exit status");
	const diagnostics = sorted.ours.length + sorted.sst;
	if (ended.status === 0 && diagnostics > 0) problems.push(`the compiler exited 0 and printed ${diagnostics} error${diagnostics === 1 ? "" : "s"}`);
	if (ended.status !== null && ended.status !== 0 && diagnostics === 0) problems.push(`the compiler exited ${ended.status} with no diagnostic to account for it`);
	for (const line of sorted.ours) problems.push(line);
	for (const line of sorted.unread.slice(0, 20)) problems.push(`output that is no diagnostic: ${line}`);
	if (sorted.unread.length > 20) problems.push(`and ${sorted.unread.length - 20} more lines that are no diagnostic`);
	return { ...sorted, problems };
}

function run(tsc: string, args: string[]): Ended {
	const done = spawnSync(tsc, ["-p", CONFIG, "--pretty", "false", ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	return {
		status: done.status,
		signal: done.signal,
		output: `${done.stdout ?? ""}${done.stderr ?? ""}`,
		...(done.error === undefined ? {} : { error: done.error.message }),
	};
}

function main(): void {
	const { values } = parseArgs({ options: { tsc: { type: "string" } } });
	const tsc = values.tsc ?? join(ROOT, "node_modules", ".bin", "tsc");
	if (values.tsc === undefined && !existsSync(join(ROOT, ".sst", "platform", "config.d.ts"))) {
		console.error("SST's platform types are not in .sst/platform: run `bunx sst install` first (it installs SST's providers and asks AWS nothing)");
		process.exit(1);
	}
	const listing = run(tsc, ["--listFilesOnly"]);
	if (listing.error !== undefined || listing.signal !== null || listing.status !== 0) {
		console.error(`listing the program's files failed: ${listing.error ?? (listing.signal !== null ? `ended by ${listing.signal}` : `exit ${listing.status}`)}\n${listing.output.slice(0, 2000)}`);
		process.exit(1);
	}
	const listed = new Set(listing.output.split("\n").map((line) => relative(ROOT, line.trim())));
	const missing = STACK_FILES.filter((file) => !listed.has(file));
	if (missing.length > 0) {
		console.error(`${CONFIG} does not hold ${missing.join(", ")}: the check would check nothing of it`);
		process.exit(1);
	}
	const judgement = judge(run(tsc, []), ROOT);
	if (judgement.problems.length > 0) {
		for (const line of judgement.problems) console.error(line);
		console.error(`the -runs stage's wiring does not pass its type check: ${judgement.problems.length} problem${judgement.problems.length === 1 ? "" : "s"} (and ${judgement.sst} errors in SST's own sources, left aside)`);
		process.exit(1);
	}
	console.log(`the -runs stage's wiring type-checks: ${STACK_FILES.join(", ")} and what they import, against SST's platform types (${judgement.sst} errors in SST's own sources, left aside)`);
}

if (import.meta.main) main();
