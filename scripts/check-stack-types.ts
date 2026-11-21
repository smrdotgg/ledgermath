/**
 * Type-checks the -runs stage's wiring, which `bunx tsc --noEmit` leaves out
 * (tsconfig.json excludes infra/runs/stack.ts and infra/runs/public-blobs-stack.ts:
 * they use SST's globals, whose types are in .sst/platform):
 *
 *     bunx sst install                    # once: writes .sst/platform; asks AWS nothing
 *     bun scripts/check-stack-types.ts
 *
 * It runs the TypeScript compiler on tsconfig.stack.json, which extends
 * tsconfig.json, so the stack files are checked as strictly as the rest. SST's
 * own sources under .sst/ are part of that program and do not pass this
 * project's strict settings (noUncheckedIndexedAccess, noImplicitOverride),
 * so errors in them are counted and left aside; any other error fails the
 * check, as does a program that does not hold every file of STACK_FILES (a
 * check that checked nothing would pass).
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

const ROOT = join(import.meta.dir, "..");
const CONFIG = "tsconfig.stack.json";
/** The files the check is for: every one must be in the program. */
export const STACK_FILES = ["infra/runs/stack.ts", "infra/runs/public-blobs-stack.ts"] as const;

export interface Sorted {
	/** Errors in this project's files, or not tied to a file: each fails the check. */
	ours: string[];
	/** Errors in SST's own sources, under .sst/: counted, left aside. */
	sst: number;
}

/** Sorts the compiler's output (--pretty false) into errors of this project and errors of SST's sources. */
export function sortErrors(output: string, root: string): Sorted {
	const ours: string[] = [];
	let sst = 0;
	for (const line of output.split("\n")) {
		const located = /^(.+?)\(\d+,\d+\): error TS\d+/.exec(line);
		if (located !== null) {
			const file = relative(root, resolve(root, located[1] as string));
			if (file === ".sst" || file.startsWith(".sst/")) sst++;
			else ours.push(line);
			continue;
		}
		if (/^error TS\d+/.test(line.trim())) ours.push(line.trim());
	}
	return { ours, sst };
}

function tsc(...args: string[]): { status: number | null; stdout: string } {
	const done = spawnSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", CONFIG, "--pretty", "false", ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	if (done.error !== undefined) throw done.error;
	return { status: done.status, stdout: `${done.stdout}${done.stderr}` };
}

function main(): void {
	if (!existsSync(join(ROOT, ".sst", "platform", "config.d.ts"))) {
		console.error("SST's platform types are not in .sst/platform: run `bunx sst install` first (it installs SST's providers and asks AWS nothing)");
		process.exit(1);
	}
	const listed = new Set(
		tsc("--listFilesOnly")
			.stdout.split("\n")
			.map((line) => relative(ROOT, line.trim())),
	);
	const missing = STACK_FILES.filter((file) => !listed.has(file));
	if (missing.length > 0) {
		console.error(`${CONFIG} does not hold ${missing.join(", ")}: the check would check nothing of it`);
		process.exit(1);
	}
	const sorted = sortErrors(tsc().stdout, ROOT);
	if (sorted.ours.length > 0) {
		for (const line of sorted.ours) console.error(line);
		console.error(`the -runs stage's wiring does not type-check: ${sorted.ours.length} error${sorted.ours.length === 1 ? "" : "s"} (and ${sorted.sst} in SST's own sources, left aside)`);
		process.exit(1);
	}
	console.log(`the -runs stage's wiring type-checks: ${STACK_FILES.join(", ")} and what they import, against SST's platform types (${sorted.sst} errors in SST's own sources, left aside)`);
}

if (import.meta.main) main();
