import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	fixtureBytes,
	fixturesEndpoint,
	fixturesReaderPolicy,
	fixturesReaderTrustPolicy,
	HTTP_GET_FIXTURES,
	s3Checksum,
	writeFixtureFiles,
} from "../infra/runs/fixtures";
import { AWS_LC_LOCK, readLock, tlsArchive } from "../infra/runs/tls-archive";

// The stage's side of the s3_fixtures Service (infra/runs/fixtures.ts) and of
// AWS-LC's source archive (infra/runs/tls-archive.ts).

const ROOT = join(import.meta.dir, "..");
const STACK = readFileSync(join(ROOT, "infra", "runs", "stack.ts"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "fixtures-stage-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Building runner/fixture.c and writing 16 MiB with O_DIRECT: seconds, more on a loaded machine. */
const C_TIMEOUT_MS = 120_000;

describe("the Fixture objects", () => {
	test("are the keys, sizes and digests benchmarks/http_get/README.md lists, and S3's base64 of each digest", () => {
		expect(HTTP_GET_FIXTURES.map(({ key, bytes }) => [key, bytes])).toEqual([
			["http_get/v1/4096", 4096],
			["http_get/v1/131072", 131072],
			["http_get/v1/16777216", 16777216],
		]);
		// The README's table, "As S3 returns it".
		expect(HTTP_GET_FIXTURES.map((fixture) => s3Checksum(fixture.sha256))).toEqual([
			"cvhAw65QHxnDCDEBweechLE/rgKJB3VJ1ztGR8JT74w=",
			"6SZq57pPdGPsmz95Gxa86VmG93Vm2ZUpi6575c8i+jg=",
			"WauE0emsaC5NVMOwy4wGvzqLVnNPqBeNcHUSENXmHeM=",
		]);
	});

	test("are what benchmarks/http_get/README.md says the binary expects: key, SHA-256, and S3's base64 of it", () => {
		const readme = readFileSync(join(ROOT, "benchmarks", "http_get", "README.md"), "utf8");
		const rows = [...readme.matchAll(/^ *\| `(\d+)` \| `([0-9a-f]{64})` \| `([A-Za-z0-9+/=]+)` \|$/gm)].map((match) => match.slice(1, 4));
		expect(rows).toEqual(HTTP_GET_FIXTURES.map((fixture) => [String(fixture.bytes), fixture.sha256, s3Checksum(fixture.sha256)]));
		for (const fixture of HTTP_GET_FIXTURES) expect(readme).toContain(`\`${fixture.key}\``);
	});

	test("made in TypeScript, have those digests, and each is the start of the largest", () => {
		const largest = fixtureBytes(16777216);
		for (const fixture of HTTP_GET_FIXTURES) {
			const bytes = fixtureBytes(fixture.bytes);
			expect(bytes.length).toBe(fixture.bytes);
			expect(sha256(bytes)).toBe(fixture.sha256);
			expect(Buffer.from(bytes).equals(Buffer.from(largest.subarray(0, fixture.bytes)))).toBe(true);
		}
		// Lengths that are not a whole number of words end mid-word.
		expect(Buffer.from(fixtureBytes(13)).equals(Buffer.from(largest.subarray(0, 13)))).toBe(true);
	});

	test(
		"are byte for byte what runner/fixture.c writes with lm_fixture.h's pattern",
		() => {
			const tool = join(scratch, "fixture");
			const built = spawnSync("cc", ["-O2", "-I", join(ROOT, "benchmarks", "harness", "c"), "-o", tool, join(ROOT, "runner", "fixture.c")], {
				encoding: "utf8",
			});
			expect(built.stderr).toBe("");
			expect(built.status).toBe(0);
			// fixture.c writes whole MiBs with O_DIRECT, which /tmp's file system must allow.
			const path = join(scratch, "sixteen-mib");
			const written = spawnSync(tool, [path, String(16 << 20)], { encoding: "utf8" });
			expect(written.stderr).toBe("");
			expect(written.status).toBe(0);
			const fromC = readFileSync(path);
			expect(Buffer.from(fixtureBytes(16 << 20)).equals(fromC)).toBe(true);
			for (const fixture of HTTP_GET_FIXTURES) expect(sha256(fromC.subarray(0, fixture.bytes))).toBe(fixture.sha256);
		},
		C_TIMEOUT_MS,
	);

	test("are written once to files named by their hash, and a list whose digest is wrong stops the deploy", () => {
		const directory = join(scratch, "files");
		const files = writeFixtureFiles(directory);
		expect(files.map((file) => [file.path, file.blobKey])).toEqual(
			HTTP_GET_FIXTURES.map((fixture) => [join(directory, fixture.sha256), `blobs/sha256/${fixture.sha256}`]),
		);
		for (const file of files) expect(sha256(readFileSync(file.path))).toBe(file.sha256);
		const before = statSync(files[2]?.path as string).mtimeMs;
		writeFixtureFiles(directory);
		expect(statSync(files[2]?.path as string).mtimeMs).toBe(before);
		// A file that holds other bytes under a Fixture's name is made again.
		writeFileSync(files[0]?.path as string, "other bytes");
		writeFixtureFiles(directory);
		expect(sha256(readFileSync(files[0]?.path as string))).toBe(HTTP_GET_FIXTURES[0]?.sha256 as string);
		expect(() => writeFixtureFiles(join(scratch, "wrong"), [{ key: "http_get/v1/4096", bytes: 4096, sha256: "0".repeat(64) }])).toThrow(
			"the Fixture http_get/v1/4096 made here has sha256 72f840c3",
		);
	});

	test("are copied by S3 from their blob in the Runs bucket, with a SHA-256 over the whole object, into a bucket of their own", () => {
		expect(STACK).toContain('const fixturesBucket = new sst.aws.Bucket("FixturesBucket", { cors: false });');
		expect(STACK).toContain("const fixtureFiles = writeFixtureFiles(join($cli.paths.root, \".sst\", \"ledgermath-fixtures\"));");
		expect(STACK).toMatch(
			/new aws\.s3\.BucketObjectv2\(`FixtureBlob\$\{fixture\.bytes\}`, \{\n\t\t\tbucket: bucket\.name,\n\t\t\tkey: fixture\.blobKey,\n\t\t\tsource: \$asset\(fixture\.path\),/,
		);
		const start = STACK.indexOf("new aws.s3.ObjectCopy(`Fixture${fixture.bytes}`, {");
		expect(start).toBeGreaterThan(0);
		const copy = STACK.slice(start, STACK.indexOf("\t\t});", start));
		for (const line of [
			"bucket: fixturesBucket.name,",
			"key: fixture.key,",
			"source: $interpolate`${bucket.name}/${blob.key}`,",
			'checksumAlgorithm: "SHA256",',
			'storageClass: "STANDARD",',
			'serverSideEncryption: "AES256",',
		]) {
			expect(copy).toContain(line);
		}
		// Not versioned: no versioning argument at all, and nothing uploaded into it but by copy.
		expect(STACK).not.toMatch(/FixturesBucket", \{[^}]*versioning/);
		expect(STACK.match(/bucket: fixturesBucket\.name/g)?.length).toBe(1);
	});
});

describe("the fixtures endpoint", () => {
	test("is virtual-hosted, the bucket as the host's first label, as http_get's LM_SERVICE_ENDPOINT", () => {
		expect(fixturesEndpoint("ledgermath-smr-runs-fixturesbucketbucket-abcdefgh", "us-east-2")).toBe(
			"https://ledgermath-smr-runs-fixturesbucketbucket-abcdefgh.s3.us-east-2.amazonaws.com",
		);
	});

	test("refuses a bucket name with a dot, which S3's one-label certificate would not cover", () => {
		expect(() => fixturesEndpoint("ledgermath.fixtures", "us-east-2")).toThrow("one DNS label without dots");
		expect(() => fixturesEndpoint("Upper", "us-east-2")).toThrow();
		expect(() => fixturesEndpoint("ledgermath-fixtures", "us-east-2; reboot")).toThrow("not a Region");
	});

	test("is built by the launch from the stage's bucket and the function's own Region", () => {
		const launch = readFileSync(join(ROOT, "infra", "runs", "launch-box.ts"), "utf8");
		expect(launch).toContain('endpoint: fixturesEndpoint(required("LEDGERMATH_FIXTURES_BUCKET"), region),');
		expect(launch).toContain('role: required("LEDGERMATH_FIXTURES_ROLE"),');
		expect(STACK).toContain("LEDGERMATH_FIXTURES_BUCKET: fixturesBucket.name,");
		expect(STACK).toContain("LEDGERMATH_FIXTURES_ROLE: fixturesRole.arn,");
	});
});

describe("the fixtures reader role", () => {
	const boxRole = "arn:aws:iam::123456789012:role/BoxRole-0123456";
	const bucketArn = "arn:aws:s3:::ledgermath-smr-runs-fixturesbucketbucket-abcdefgh";

	test("may be assumed by the box's role alone", () => {
		expect(fixturesReaderTrustPolicy(boxRole)).toEqual({
			Version: "2012-10-17",
			Statement: [{ Effect: "Allow", Principal: { AWS: boxRole }, Action: ["sts:AssumeRole"] }],
		});
		expect(JSON.stringify(fixturesReaderTrustPolicy(boxRole))).not.toContain("*");
	});

	test("may do one thing: s3:GetObject on each Fixture object, named", () => {
		expect(fixturesReaderPolicy(bucketArn)).toEqual({
			Version: "2012-10-17",
			Statement: [
				{
					Effect: "Allow",
					Action: ["s3:GetObject"],
					Resource: [`${bucketArn}/http_get/v1/4096`, `${bucketArn}/http_get/v1/131072`, `${bucketArn}/http_get/v1/16777216`],
				},
			],
		});
		expect(JSON.stringify(fixturesReaderPolicy(bucketArn))).not.toContain("*");
	});

	test("is the stack's: trusted by the box role, sessions of an hour at most", () => {
		expect(STACK).toContain('const fixturesRole = new aws.iam.Role("FixturesReaderRole", {');
		expect(STACK).toContain("assumeRolePolicy: boxRole.arn.apply((arn) => JSON.stringify(fixturesReaderTrustPolicy(arn))),");
		expect(STACK).toContain("maxSessionDuration: 3600,");
		expect(STACK).toContain("policy: fixturesBucket.arn.apply((arn) => JSON.stringify(fixturesReaderPolicy(arn))),");
	});
});

describe("AWS-LC's source archive", () => {
	/** A tree holding a lock that pins `archive`'s bytes, and the lock's values. */
	function tree(name: string, archiveBytes = "a stand-in archive\n"): { root: string; sha256: string } {
		const root = join(scratch, name);
		mkdirSync(join(root, "benchmarks", "harness", "c", "vendor"), { recursive: true });
		const digest = sha256(Buffer.from(archiveBytes));
		writeFileSync(
			join(root, AWS_LC_LOCK),
			[
				"# a comment line := not a value",
				"AWS_LC_VERSION := 5.14.0",
				"AWS_LC_URL := https://github.com/aws/aws-lc/archive/refs/tags/v5.14.0.tar.gz",
				`AWS_LC_SHA256 := ${digest}`,
				"AWS_LC_ARCHIVE_ROOT := aws-lc-5.14.0",
				"",
			].join("\n"),
		);
		return { root, sha256: digest };
	}

	test("is read from the lock's KEY := value lines and nothing else", () => {
		expect(readLock("# AWS_LC_VERSION := 1\nAWS_LC_VERSION := 5.14.0\nAWS_LC_FLAGS := -DA=1 -DB=2\n")).toEqual({
			AWS_LC_VERSION: "5.14.0",
			AWS_LC_FLAGS: "-DA=1 -DB=2",
		});
	});

	test("is found at AWS_LC_ARCHIVE, or in .sst/ledgermath-vendor, and kept as a blob named by its hash", () => {
		const { root, sha256: digest } = tree("archive-ok");
		const given = join(scratch, "given.tar.gz");
		writeFileSync(given, "a stand-in archive\n");
		expect(tlsArchive(root, { AWS_LC_ARCHIVE: given })).toEqual({ version: "5.14.0", sha256: digest, path: given, key: `blobs/sha256/${digest}` });
		const fallback = join(root, ".sst", "ledgermath-vendor", "aws-lc-5.14.0.tar.gz");
		mkdirSync(join(root, ".sst", "ledgermath-vendor"), { recursive: true });
		writeFileSync(fallback, "a stand-in archive\n");
		expect(tlsArchive(root, {}).path).toBe(fallback);
	});

	test("stops the deploy when it is missing, saying how to fetch it", () => {
		const { root } = tree("archive-missing");
		expect(() => tlsArchive(root, {})).toThrow(
			"AWS-LC 5.14.0's source archive is not at .sst/ledgermath-vendor/aws-lc-5.14.0.tar.gz. Fetch it from https://github.com/aws/aws-lc/archive/refs/tags/v5.14.0.tar.gz with: benchmarks/harness/c/vendor/fetch-aws-lc.sh .sst/ledgermath-vendor/aws-lc-5.14.0.tar.gz (or set AWS_LC_ARCHIVE to the path of a copy)",
		);
		expect(() => tlsArchive(root, { AWS_LC_ARCHIVE: join(scratch, "nowhere.tar.gz") })).toThrow(
			`with: benchmarks/harness/c/vendor/fetch-aws-lc.sh ${join(scratch, "nowhere.tar.gz")}`,
		);
	});

	test("stops the deploy when its hash is not the lock's", () => {
		const { root, sha256: digest } = tree("archive-wrong");
		const given = join(scratch, "wrong.tar.gz");
		writeFileSync(given, "other bytes\n");
		expect(() => tlsArchive(root, { AWS_LC_ARCHIVE: given })).toThrow(
			`${given} has sha256 ${sha256(Buffer.from("other bytes\n"))}, and ${AWS_LC_LOCK} pins ${digest}. Fetch it again with:`,
		);
	});

	test("stops the deploy when the tree has no lock: http_get's source is not in it", () => {
		const root = join(scratch, "no-lock");
		mkdirSync(root, { recursive: true });
		expect(() => tlsArchive(root, {})).toThrow(`${AWS_LC_LOCK} is missing: http_get's source is not in this tree`);
	});

	test("is checked by the stack before anything is made, uploaded as a blob, and readable by the box", () => {
		expect(STACK).toContain("const tls = tlsArchive($cli.paths.root);");
		expect(STACK.indexOf("const tls = tlsArchive($cli.paths.root);")).toBeLessThan(STACK.indexOf("new sst.aws.Bucket"));
		expect(STACK).toMatch(/new aws\.s3\.BucketObjectv2\("TlsArchive", \{\n\t\tbucket: bucket\.name,\n\t\tkey: tls\.key,\n\t\tsource: \$asset\(tls\.path\),/);
	});

	test("this tree's lock pins a release, a URL and a 64-digit SHA-256, and the stack reads it", () => {
		const lock = readLock(readFileSync(join(ROOT, AWS_LC_LOCK), "utf8"));
		expect(lock.AWS_LC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		expect(lock.AWS_LC_URL).toStartWith("https://");
		expect(lock.AWS_LC_SHA256).toMatch(/^[0-9a-f]{64}$/);
		// Without a local copy the deploy stops, naming this lock's release.
		expect(() => tlsArchive(ROOT, { AWS_LC_ARCHIVE: join(scratch, "absent.tar.gz") })).toThrow(`AWS-LC ${lock.AWS_LC_VERSION}'s source archive is not at`);
	});
});
