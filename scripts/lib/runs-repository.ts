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
import { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, type Stats, unlinkSync, writeSync } from "node:fs";
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

/** Writes from bytes at offset into a descriptor, as writeSync does: returns how many bytes it wrote, which may be fewer. */
export type Write = (descriptor: number, bytes: Uint8Array, offset: number) => number;

const writeAt: Write = (descriptor, bytes, offset) => writeSync(descriptor, bytes, offset, bytes.length - offset);

/** Thrown when the temporary file does not hold exactly the bytes meant for it; nothing was added. */
export class ShortWrite extends Error {
	constructor(key: string, detail: string) {
		super(`${key}: ${detail}; nothing was added`);
		this.name = "ShortWrite";
	}
}

/**
 * Creates repository/key holding bytes, and never replaces anything: the
 * directories on the way must be plain directories, the bytes go to a fresh
 * temporary file opened with O_EXCL under a random name, and link() gives it
 * its name, failing if a file of that name appeared meanwhile.
 *
 * A file in the Runs repository is never edited, so one added short would stay
 * short. So the bytes are written until every one is written (a write that
 * fails, or writes nothing, stops it), flushed to disk, then read back through
 * the same descriptor and compared with what was meant, length and bytes, all
 * before the file gets its name. Any difference throws ShortWrite, and the
 * temporary file is removed. `write` is for tests.
 */
export function addFile(repository: string, key: string, bytes: Uint8Array, write: Write = writeAt): "added" | "appeared" {
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
	// Read and write, so the bytes can be read back through the descriptor that wrote them.
	const descriptor = openSync(temporary, "wx+", 0o644);
	try {
		try {
			let written = 0;
			while (written < bytes.length) {
				let count: number;
				try {
					count = write(descriptor, bytes, written);
				} catch (error) {
					throw new ShortWrite(key, `writing stopped after ${written} of ${bytes.length} bytes: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (!Number.isInteger(count) || count <= 0) throw new ShortWrite(key, `a write of the remaining ${bytes.length - written} bytes wrote ${count}`);
				written += count;
			}
			fsyncSync(descriptor);
			const size = fstatSync(descriptor).size;
			if (size !== bytes.length) throw new ShortWrite(key, `wrote ${bytes.length} bytes, and the file holds ${size}`);
			// One byte more than meant, to see any excess.
			const back = Buffer.alloc(bytes.length + 1);
			let read = 0;
			for (;;) {
				const count = readSync(descriptor, back, read, back.length - read, read);
				if (count === 0) break;
				read += count;
				if (read === back.length) break;
			}
			if (read !== bytes.length || !back.subarray(0, read).equals(bytes)) {
				throw new ShortWrite(key, `read back, the file is not the ${bytes.length} bytes written (${read} bytes${read === bytes.length ? ", different" : ""})`);
			}
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
