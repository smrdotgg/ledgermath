/**
 * The s3_fixtures Service: the private bucket http_get reads, the objects in
 * it, and the role whose short-lived keys may read them and nothing else.
 * infra/runs/stack.ts makes them from this file; tests/fixtures-stage.test.ts
 * checks it.
 *
 * The objects are the first N bytes of the Fixture pattern of
 * benchmarks/harness/c/lm_fixture.h (the 64-bit little-endian word at byte
 * offset o is mix64(o ^ 0x8d6d2f9d5f9d1b37)), the pattern runner/fixture.c
 * writes to disk. http_get checks every body it receives against the same
 * pattern and against the x-amz-checksum-sha256 S3 returns, so each object
 * must have a full-object SHA-256 checksum. A deploy gives it one in two
 * steps: the bytes go to the Runs bucket as a content-addressed blob
 * (blobs/sha256/<hex>), then S3 copies that blob into the fixtures bucket with
 * CopyObject and the SHA256 checksum algorithm. A copy is one object in a
 * single part whatever the source was, and its checksum is computed over the
 * whole object. Uploading straight into the fixtures bucket would not do: the
 * provider uploads anything over 5 MiB in parts, and a SHA-256 checksum of a
 * multipart object is a checksum of the parts' checksums.
 *
 * Plain data and node: built-ins only, so tests and the launch Lambda can
 * import it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PolicyDocument } from "./github-role";

/** The name a schedule entry gives this Service: "service": "s3_fixtures". */
export const S3_FIXTURES = "s3_fixtures";

export interface Fixture {
	/** The object's key in the fixtures bucket. */
	key: string;
	bytes: number;
	/** The SHA-256 of its bytes, in hex: the digests benchmarks/http_get/README.md lists. */
	sha256: string;
}

/**
 * The objects http_get's parameter sets name (LM_PARAM_KEY). A new pattern or
 * size gets a new key; an object is never overwritten with other bytes.
 */
export const HTTP_GET_FIXTURES: readonly Fixture[] = [
	{ key: "http_get/v1/4096", bytes: 4096, sha256: "72f840c3ae501f19c3083101c1e79c84b13fae0289077549d73b4647c253ef8c" },
	{ key: "http_get/v1/131072", bytes: 131072, sha256: "e9266ae7ba4f7463ec9b3f791b16bce95986f77566d995298bae7be5cf22fa38" },
	{ key: "http_get/v1/16777216", bytes: 16777216, sha256: "59ab84d1e9ac682e4d54c3b0cb8c06bf3a8b56734fa8178d70751210d5e61de3" },
];

const MASK = (1n << 64n) - 1n;
const SEED = 0x8d6d2f9d5f9d1b37n;

function mix64(value: bigint): bigint {
	let x = value;
	x ^= x >> 30n;
	x = (x * 0xbf58476d1ce4e5b9n) & MASK;
	x ^= x >> 27n;
	x = (x * 0x94d049bb133111ebn) & MASK;
	x ^= x >> 31n;
	return x;
}

/** The first `size` bytes of the Fixture pattern. */
export function fixtureBytes(size: number): Uint8Array {
	const words = Math.ceil(size / 8);
	const buffer = new ArrayBuffer(words * 8);
	const view = new DataView(buffer);
	for (let word = 0; word < words; word++) {
		const offset = word * 8;
		view.setBigUint64(offset, mix64(BigInt(offset) ^ SEED), true);
	}
	return new Uint8Array(buffer, 0, size);
}

/** The digest as S3 returns it in x-amz-checksum-sha256: base64. */
export function s3Checksum(sha256Hex: string): string {
	return Buffer.from(sha256Hex, "hex").toString("base64");
}

export interface FixtureFile extends Fixture {
	/** A local file holding the bytes, for the deploy to upload. */
	path: string;
	/** Where the bytes are kept in the Runs bucket, by their hash. */
	blobKey: string;
}

/**
 * Writes each Fixture's bytes to DIRECTORY/<sha256>, unless a file of that
 * name already holds them, and returns where. Throws if the bytes made here
 * do not have the digest the list gives: the deploy then stops before
 * anything is uploaded.
 */
export function writeFixtureFiles(directory: string, fixtures: readonly Fixture[] = HTTP_GET_FIXTURES): FixtureFile[] {
	mkdirSync(directory, { recursive: true });
	return fixtures.map((fixture) => {
		const path = join(directory, fixture.sha256);
		const held = existsSync(path) ? createHash("sha256").update(new Uint8Array(readFileSync(path))).digest("hex") : null;
		if (held !== fixture.sha256) {
			const bytes = fixtureBytes(fixture.bytes);
			const made = createHash("sha256").update(bytes).digest("hex");
			if (made !== fixture.sha256) {
				throw new Error(`the Fixture ${fixture.key} made here has sha256 ${made}; ${fixture.sha256} was expected`);
			}
			writeFileSync(`${path}.partial`, bytes);
			renameSync(`${path}.partial`, path);
		}
		return { ...fixture, path, blobKey: `blobs/sha256/${fixture.sha256}` };
	});
}

/**
 * The endpoint http_get is given as LM_SERVICE_ENDPOINT: virtual-hosted
 * style, so the bucket is the host's first label. S3's certificate,
 * *.s3.<region>.amazonaws.com, covers one label, so a name with a dot would
 * fail verification.
 */
export function fixturesEndpoint(bucket: string, region: string): string {
	if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
		throw new Error(`the fixtures bucket's name must be one DNS label without dots, got ${JSON.stringify(bucket)}`);
	}
	if (!/^[a-z]{2}(-[a-z]+)+-[0-9]$/.test(region)) throw new Error(`not a Region: ${JSON.stringify(region)}`);
	return `https://${bucket}.s3.${region}.amazonaws.com`;
}

/** Who may assume the fixtures reader role: the box's instance role, and nothing else. */
export function fixturesReaderTrustPolicy(boxRoleArn: string): PolicyDocument {
	return {
		Version: "2012-10-17",
		Statement: [{ Effect: "Allow", Principal: { AWS: boxRoleArn }, Action: ["sts:AssumeRole"] }],
	};
}

/**
 * What the fixtures reader role may do: s3:GetObject on the Fixture objects,
 * each named, and nothing else. Without s3:ListBucket a missing object is a
 * 403, not a 404; either is an event in the Run. SSE-S3 needs no KMS action.
 */
export function fixturesReaderPolicy(fixturesBucketArn: string, fixtures: readonly Fixture[] = HTTP_GET_FIXTURES): PolicyDocument {
	return {
		Version: "2012-10-17",
		Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: fixtures.map((fixture) => `${fixturesBucketArn}/${fixture.key}`) }],
	};
}
