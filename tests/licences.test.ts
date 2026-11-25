import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { AWS_LC_LOCK, readLock } from "../infra/runs/tls-archive";
import { blobKey, readSourcesLock, SOURCES_LOCK } from "../scripts/publish-third-party-source";

// The licence files say what they should, and the notices keep up with what
// they describe: a new AWS-LC pin, a new image or a new glibc fails here
// until THIRD-PARTY-NOTICES.md and third-party/sources.lock.json are brought
// up to date with it.

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path));
const sha256 = (path: string) => createHash("sha256").update(read(path)).digest("hex");

/** https://www.apache.org/licenses/LICENSE-2.0.txt, fetched 2026-11-14 (11,358 bytes). */
const APACHE_2_0_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
/** https://creativecommons.org/licenses/by/4.0/legalcode.txt, fetched 2026-11-14 (18,657 bytes). */
const CC_BY_4_0_SHA256 = "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411";
/** COPYING.LIB and LICENSES of glibc 2.34: the same in glibc's git at tag glibc-2.34 and in GNU's glibc-2.34.tar.xz. */
const GLIBC_2_34_COPYING_LIB_SHA256 = "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551";
const GLIBC_2_34_LICENSES_SHA256 = "b33d0bd9f685b46853548814893a6135e74430d12f6d94ab3eba42fc591f83bc";

/** Every package.json git tracks. */
function packageFiles(): string[] {
	const listed = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
	if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
	return listed.stdout.split("\0").filter((path) => basename(path) === "package.json");
}

describe("licences", () => {
	test("LICENSE is the Apache License 2.0, byte for byte", () => {
		expect(sha256("LICENSE")).toBe(APACHE_2_0_SHA256);
	});

	test("the Runs repository's LICENSE is the CC BY 4.0 legal code, byte for byte", () => {
		expect(sha256("docs/runs-repository/LICENSE")).toBe(CC_BY_4_0_SHA256);
	});

	// Both files are copied into the public Runs repository as they are here, so
	// neither may still wait on a decision.
	test("the Runs repository's README and LICENSE hold no placeholder and nothing 'not decided yet'", () => {
		for (const path of ["docs/runs-repository/README.md", "docs/runs-repository/LICENSE"]) {
			const text = read(path).toString("utf8");
			expect({ path, placeholder: /placeholder/i.test(text) }).toEqual({ path, placeholder: false });
			expect({ path, undecided: /not\s+decided\s+yet/i.test(text) }).toEqual({ path, undecided: false });
		}
	});

	test("glibc's COPYING.LIB and LICENSES are glibc 2.34's, byte for byte", () => {
		expect(sha256("third-party/glibc-2.34/COPYING.LIB")).toBe(GLIBC_2_34_COPYING_LIB_SHA256);
		expect(sha256("third-party/glibc-2.34/LICENSES")).toBe(GLIBC_2_34_LICENSES_SHA256);
	});

	test("every package.json says Apache-2.0, the root's among them", () => {
		const files = packageFiles();
		expect(files).toContain("package.json");
		for (const path of files) {
			const pkg = JSON.parse(read(path).toString("utf8")) as { license?: unknown };
			expect({ path, license: pkg.license }).toEqual({ path, license: "Apache-2.0" });
		}
	});

	test("NOTICE names the project and points to the third-party notices", () => {
		const notice = read("NOTICE").toString("utf8");
		expect(notice.startsWith("LedgerMath\nCopyright 2026 The LedgerMath Authors\n")).toBe(true);
		expect(notice).toContain("THIRD-PARTY-NOTICES.md");
	});
});

describe("THIRD-PARTY-NOTICES.md", () => {
	const notices = read("THIRD-PARTY-NOTICES.md").toString("utf8");
	const image = /^const IMAGE_ID = "(ami-[0-9a-f]+)";$/m.exec(read("infra/runs/stack.ts").toString("utf8"))?.[1];
	const lock = readSourcesLock(read(SOURCES_LOCK).toString("utf8"));

	test("names the AWS-LC version, archive and hash that aws-lc.lock pins", () => {
		const pins = readLock(read(AWS_LC_LOCK).toString("utf8"));
		const { AWS_LC_VERSION: version, AWS_LC_URL: url, AWS_LC_SHA256: hash } = pins;
		expect(version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
		expect(url).toStartWith("https://");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(notices).toContain(`AWS-LC ${version},`);
		expect(notices).toContain(`aws-lc-${version}/LICENSE`);
		expect(notices).toContain(`<${url}>`);
		expect(notices).toContain(`\`${hash}\``);
	});

	test("names the image infra/runs/stack.ts pins, whose packages its glibc and GCC versions are", () => {
		expect(image).toBeDefined();
		expect(notices).toContain(`\`${image}\``);
	});

	test(`${SOURCES_LOCK} is for the image infra/runs/stack.ts pins, and the release the container test uses`, () => {
		expect(lock.image.id).toBe(image as string);
		expect(read("scripts/box-in-container/run.sh").toString("utf8")).toContain(`IMAGE=amazonlinux:${lock.image.release} `);
		expect(notices).toContain(lock.image.release);
	});

	test(`names every source package of ${SOURCES_LOCK}: its package, file, address, hash and blob`, () => {
		for (const entry of lock.sources) {
			expect(notices).toContain(`\`${entry.binary_package}\``);
			expect(notices).toContain(`\`${entry.file}\``);
			expect(notices).toContain(`<${entry.url}>`);
			expect(notices).toContain(`\`${entry.sha256}\``);
			expect(notices).toContain(`\`${blobKey(entry.sha256)}\``);
		}
	});

	test("names every font the website serves, with its sha256, and the site's own notices carry it", () => {
		const listed = spawnSync("git", ["ls-files", "-z", "site/src", "site/public"], { cwd: ROOT, encoding: "utf8" });
		if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
		const fonts = listed.stdout.split("\0").filter((path) => /\.(woff2?|ttf|otf|eot)$/i.test(path));
		expect(fonts.length).toBeGreaterThan(0);
		const siteNotices = read("site/public/third-party-notices.txt").toString("utf8");
		for (const font of fonts) {
			expect(notices).toContain(`\`${font}\``);
			expect(notices).toContain(`\`${sha256(font)}\``);
			expect(siteNotices).toContain(basename(font));
		}
	});

	test("the sample Runs, recorded at the pinned release, list the binary package each source package is for", () => {
		const dumps: string[] = [];
		for (const sample of readdirSync(join(ROOT, "tests", "samples"), { withFileTypes: true })) {
			if (!sample.isDirectory()) continue;
			const blobs = join(ROOT, "tests", "samples", sample.name, "blobs", "sha256");
			let names: string[] = [];
			try {
				names = readdirSync(blobs);
			} catch {
				continue;
			}
			for (const name of names) dumps.push(readFileSync(join(blobs, name), "latin1"));
		}
		for (const entry of lock.sources) {
			expect(dumps.some((dump) => dump.includes(`${entry.binary_package}\\n`) || dump.includes(`${entry.binary_package}\n`))).toBe(true);
		}
	});
});
