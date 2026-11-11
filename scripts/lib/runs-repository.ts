/**
 * The Runs repository: every Run file and boot summary, byte for byte as the
 * box uploaded them, under the paths they have in the bucket, and one price
 * file a day under prices/. Private until step 7 of the plan (#36).
 *
 * Files are only ever added to it, never changed: addFile() creates a file
 * exclusively and refuses to go through a symbolic link. The copy job
 * (scripts/copy-runs.ts) and the price fetch (scripts/fetch-prices.ts) both
 * write through it.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, type Stats, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const RUNS_REPOSITORY = "smrdotgg/ledgermath-runs";

/** Where a file of the Runs repository is shown, by its path in the repository. */
export const RUNS_REPOSITORY_BLOB_URL = `https://github.com/${RUNS_REPOSITORY}/blob/main/`;

/** The region of the -runs stage's bucket (sst.config.ts). */
export const RUNS_BUCKET_REGION = "us-east-2";

export function lstatOrNull(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** The first of the repository directory and the components of key under it that is a symbolic link, or null. */
export function symlinkOnPath(repository: string, key: string): string | null {
	if (lstatOrNull(repository)?.isSymbolicLink()) return repository;
	let path = repository;
	let shown = "";
	for (const part of key.split("/")) {
		path = join(path, part);
		shown = shown === "" ? part : `${shown}/${part}`;
		const stat = lstatOrNull(path);
		if (stat === null) return null; // nothing below a missing component exists
		if (stat.isSymbolicLink()) return shown;
	}
	return null;
}

/**
 * Creates repository/key holding bytes, and never replaces anything: the
 * directories on the way must be plain directories, the bytes go to a fresh
 * temporary file opened with O_EXCL under a random name, and link() gives it
 * its name, failing if a file of that name appeared meanwhile.
 */
export function addFile(repository: string, key: string, bytes: Uint8Array): "added" | "appeared" {
	const parts = key.split("/");
	const name = parts.pop() as string;
	let directory = repository;
	let shown = "";
	for (const part of parts) {
		directory = join(directory, part);
		shown = shown === "" ? part : `${shown}/${part}`;
		try {
			mkdirSync(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (!lstatSync(directory).isDirectory()) throw new Error(`${key}: ${shown} is not a plain directory`);
	}
	const temporary = join(directory, `.${name}.${randomBytes(12).toString("hex")}.partial`);
	const descriptor = openSync(temporary, "wx", 0o644);
	try {
		try {
			writeSync(descriptor, bytes);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		linkSync(temporary, join(directory, name));
		return "added";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return "appeared";
		throw error;
	} finally {
		unlinkSync(temporary);
	}
}
