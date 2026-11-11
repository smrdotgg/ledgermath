/**
 * The source archive of AWS-LC, the TLS library http_get links statically.
 * It is not in git (155 MB): benchmarks/harness/c/vendor/aws-lc.lock pins its
 * release, URL and SHA-256. A deploy uploads it from a local copy to the Runs
 * bucket as a content-addressed blob, blobs/sha256/<hash>, and the box fetches
 * it from there each boot (runner/aws-lc-archive.sh), so no box depends on
 * GitHub, and a Run's binary can always be rebuilt from bytes the bucket keeps.
 *
 * The local copy is $AWS_LC_ARCHIVE, the variable http_get's Makefile reads,
 * or else .sst/ledgermath-vendor/aws-lc-<version>.tar.gz under the
 * repository. A deploy stops, saying how to fetch it, when the lock is
 * missing, or the copy is, or the copy's hash is not the lock's.
 *
 * node: built-ins only: no SST global, so tests can import it.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { join, relative } from "node:path";

export const AWS_LC_LOCK = "benchmarks/harness/c/vendor/aws-lc.lock";
const FETCH = "benchmarks/harness/c/vendor/fetch-aws-lc.sh";

export interface TlsArchive {
	version: string;
	sha256: string;
	/** The local copy to upload. */
	path: string;
	/** Its key in the Runs bucket. */
	key: string;
}

/** The lock's KEY := value lines. */
export function readLock(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const match = /^([A-Z0-9_]+) := (.*)$/.exec(line);
		if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2];
	}
	return values;
}

/** The SHA-256 of a file, in hex, read in pieces. */
export function fileSha256(path: string): string {
	const hash = createHash("sha256");
	const buffer = new Uint8Array(1 << 20);
	const fd = openSync(path, "r");
	try {
		for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) hash.update(buffer.subarray(0, read));
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

/** The archive the lock under `root` pins, found and checked; throws saying what to do when it cannot be. */
export function tlsArchive(root: string, environment: Record<string, string | undefined> = process.env): TlsArchive {
	const lockPath = join(root, AWS_LC_LOCK);
	if (!existsSync(lockPath)) {
		throw new Error(`${AWS_LC_LOCK} is missing: http_get's source is not in this tree, so the box could not build it`);
	}
	const lock = readLock(readFileSync(lockPath, "utf8"));
	const { AWS_LC_VERSION: version, AWS_LC_SHA256: sha256, AWS_LC_URL: url } = lock;
	if (!version || !url || !sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
		throw new Error(`${AWS_LC_LOCK} has no AWS_LC_VERSION, AWS_LC_URL or 64-digit AWS_LC_SHA256`);
	}
	const fallback = join(root, ".sst", "ledgermath-vendor", `aws-lc-${version}.tar.gz`);
	const path = environment.AWS_LC_ARCHIVE || fallback;
	const shown = path === fallback ? relative(root, fallback) : path;
	const fetch = `${FETCH} ${shown}` + (path === fallback ? " (or set AWS_LC_ARCHIVE to the path of a copy)" : "");
	if (!existsSync(path)) {
		throw new Error(`AWS-LC ${version}'s source archive is not at ${shown}. Fetch it from ${url} with: ${fetch}`);
	}
	const actual = fileSha256(path);
	if (actual !== sha256) {
		throw new Error(`${shown} has sha256 ${actual}, and ${AWS_LC_LOCK} pins ${sha256}. Fetch it again with: ${fetch}`);
	}
	return { version, sha256, path, key: `blobs/sha256/${sha256}` };
}
