/**
 * Reading a directory of Runs: a checkout of the Runs repository, or a copy
 * of the bucket. Every file under runs/ that ends in .json, in path order.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { RunFile } from "../../methods/run";

export function readRunFiles(root: string): RunFile[] {
	const directory = join(root, "runs");
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort()
		.map((path) => {
			const bytes = readFileSync(join(root, path));
			let record: unknown;
			try {
				record = JSON.parse(bytes.toString("utf8"));
			} catch {
				record = null; // not JSON: the Method lists it as unreadable
			}
			return { path, sha256: createHash("sha256").update(bytes).digest("hex"), record };
		});
}
