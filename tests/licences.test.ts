import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AWS_LC_LOCK, readLock } from "../infra/runs/tls-archive";

// The licence files say what they should, and the notices keep up with what
// they describe: a new AWS-LC pin or a new image fails here until
// THIRD-PARTY-NOTICES.md is brought up to date with it.

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path));
const sha256 = (path: string) => createHash("sha256").update(read(path)).digest("hex");

/** https://www.apache.org/licenses/LICENSE-2.0.txt, fetched 2026-11-14 (11,358 bytes). */
const APACHE_2_0_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
/** https://creativecommons.org/licenses/by/4.0/legalcode.txt, fetched 2026-11-14 (18,657 bytes). */
const CC_BY_4_0_SHA256 = "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411";

describe("licences", () => {
	test("LICENSE is the Apache License 2.0, byte for byte", () => {
		expect(sha256("LICENSE")).toBe(APACHE_2_0_SHA256);
	});

	test("the Runs repository's LICENSE is the CC BY 4.0 legal code, byte for byte", () => {
		expect(sha256("docs/runs-repository/LICENSE")).toBe(CC_BY_4_0_SHA256);
	});

	for (const path of ["package.json", "packages/shared/package.json"]) {
		test(`${path} says Apache-2.0`, () => {
			const pkg = JSON.parse(read(path).toString("utf8")) as { license?: unknown };
			expect(pkg.license).toBe("Apache-2.0");
		});
	}

	test("NOTICE names the project and points to the third-party notices", () => {
		const notice = read("NOTICE").toString("utf8");
		expect(notice.startsWith("LedgerMath\nCopyright 2026 The LedgerMath Authors\n")).toBe(true);
		expect(notice).toContain("THIRD-PARTY-NOTICES.md");
	});
});

describe("THIRD-PARTY-NOTICES.md", () => {
	const notices = read("THIRD-PARTY-NOTICES.md").toString("utf8");

	test("names the AWS-LC version, archive and hash that aws-lc.lock pins", () => {
		const lock = readLock(read(AWS_LC_LOCK).toString("utf8"));
		const { AWS_LC_VERSION: version, AWS_LC_URL: url, AWS_LC_SHA256: hash } = lock;
		expect(version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
		expect(url).toStartWith("https://");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(notices).toContain(`AWS-LC ${version},`);
		expect(notices).toContain(`aws-lc-${version}/LICENSE`);
		expect(notices).toContain(`<${url}>`);
		expect(notices).toContain(`\`${hash}\``);
	});

	test("names the image infra/runs/stack.ts pins, whose packages its glibc and GCC versions are", () => {
		const image = /^const IMAGE_ID = "(ami-[0-9a-f]+)";$/m.exec(read("infra/runs/stack.ts").toString("utf8"))?.[1];
		expect(image).toBeDefined();
		expect(notices).toContain(`\`${image}\``);
	});
});
