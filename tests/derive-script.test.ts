import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as requests from "../methods/requests/v1";
import { REQUESTS_RECORD_KEY } from "../methods/requests/v1/record";
import type { Run } from "../methods/run";
import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import * as series from "../methods/v1";
import type { DerivationsFile } from "../methods/v1/output";
import { renderPage } from "../scripts/build-page";
import { failurePath, type MethodFailure } from "../scripts/lib/method-failure";
import { RUNS_REPOSITORY_BLOB_URL } from "../scripts/lib/runs-repository";
import { HandMade, rampRequests, requestRun } from "./hand-made-requests";

// Each test runs the scripts as the workflow does, as processes; a loaded machine can take a while.
setDefaultTimeout(180_000);

const ROOT = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "derive-script-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(script: string, args: string[]): { code: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync(["bun", join(ROOT, "scripts", script), ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
	return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** A directory of Runs with their blobs: two http_get Runs and a memory_read Run. */
function directory(name: string): { dir: string; made: HandMade } {
	const made = new HandMade();
	requestRun(made, { startedAt: "2026-11-11T21:35:00Z", stream: { connection: "new", requests: rampRequests(20) } });
	requestRun(made, { startedAt: "2026-11-12T21:35:00Z", stream: { connection: "reused", requests: rampRequests(20) } });
	made.run({ startedAt: "2026-11-11T21:30:00Z" });
	const dir = join(scratch, name);
	made.writeTo(dir);
	return { dir, made };
}

describe("scripts/derive.ts", () => {
	test("a Run file that does not validate is listed as unreadable, and asked for no stream, records kept or not", () => {
		const { dir } = directory("unreadable");
		mkdirSync(join(dir, "runs", "2026", "11", "13"), { recursive: true });
		writeFileSync(join(dir, "runs", "2026", "11", "13", "01a1cc88-0000-7000-8000-000000000000.json"), `{"stdout":"sha256:${"a".repeat(64)}"}\n`);
		const kept = run("derive.ts", ["--runs", dir, "--blobs", join(dir, "blobs"), "--records", join(dir, "records"), "--out", join(dir, "kept.json"), "--requests-out", join(dir, "kept-requests.json")]);
		expect(kept.stderr).toBe("");
		expect(kept.code).toBe(0);
		const none = run("derive.ts", ["--runs", dir, "--blobs", join(dir, "blobs"), "--out", join(dir, "none.json"), "--requests-out", join(dir, "none-requests.json")]);
		expect(none.code).toBe(0);
		const v1 = JSON.parse(readFileSync(join(dir, "kept.json"), "utf8")) as DerivationsFile;
		const r = JSON.parse(readFileSync(join(dir, "kept-requests.json"), "utf8")) as RequestsFile;
		expect(v1.unreadable.map((u) => u.path)).toEqual(["runs/2026/11/13/01a1cc88-0000-7000-8000-000000000000.json"]);
		expect(r.unreadable.map((u) => u.path)).toEqual(["runs/2026/11/13/01a1cc88-0000-7000-8000-000000000000.json"]);
		expect(v1.derivations.length).toBe(3);
		expect(r.derivations.length).toBe(2);
		expect(readFileSync(join(dir, "kept.json"), "utf8")).toBe(readFileSync(join(dir, "none.json"), "utf8"));
		expect(readFileSync(join(dir, "kept-requests.json"), "utf8")).toBe(readFileSync(join(dir, "none-requests.json"), "utf8"));
	});

	test("when one Method fails, the other's Derivations are written, a note in place of the failed one's, and the exit is 1; the page says what is missing", () => {
		const { dir, made } = directory("one-fails");
		// A dump section only series v1 reads (packages) cannot be fetched: series v1 fails, requests v1 does not.
		const index = (made.files[0]?.record as Run).environment.before;
		const before = JSON.parse(new TextDecoder().decode(made.blobs.get(index) as Uint8Array)) as { sections: Record<string, string> };
		const packages = join(dir, "blobs", "sha256", (before.sections.packages as string).slice("sha256:".length));
		renameSync(packages, `${packages}.away`);
		const out = join(dir, "page", "derivations.json");
		const requestsOut = join(dir, "page", "requests-derivations.json");
		const first = run("derive.ts", ["--runs", dir, "--blobs", join(dir, "blobs"), "--records", join(dir, "records"), "--out", out, "--requests-out", requestsOut]);
		expect(first.code).toBe(1);
		expect(first.stderr).toContain("method series v1 failed, and wrote no Derivations: blob sha256:");
		expect(existsSync(out)).toBe(false);
		const note = JSON.parse(readFileSync(failurePath(out), "utf8")) as MethodFailure;
		expect(note).toEqual({ schema: "ledgermath.method-failure/1", method: { name: "series", version: 1 }, error: expect.stringContaining("cannot be fetched") });
		const r = JSON.parse(readFileSync(requestsOut, "utf8")) as RequestsFile;
		expect(r.derivations.length).toBe(2);

		const page = run("build-page.ts", [out, join(dir, "page", "index.html"), "--requests", requestsOut]);
		expect(page.code).toBe(0);
		const html = readFileSync(join(dir, "page", "index.html"), "utf8");
		expect(html).toContain("<b>This part is missing.</b> Method series v1 failed on this run and made no Derivations: blob sha256:");
		expect((html.match(/<section class="series requests"/g) ?? []).length).toBe(2);

		// Once the blob is back, the Method succeeds and its note goes.
		renameSync(`${packages}.away`, packages);
		const second = run("derive.ts", ["--runs", dir, "--blobs", join(dir, "blobs"), "--records", join(dir, "records"), "--out", out, "--requests-out", requestsOut]);
		expect(second.code).toBe(0);
		expect(existsSync(out)).toBe(true);
		expect(existsSync(failurePath(out))).toBe(false);
	});

	test("records made by other code for a Method asked for are removed; another Method's are left", () => {
		const { dir } = directory("other-code");
		const records = join(dir, "records");
		for (const name of ["requests-v1-r1", "requests-v1-0123456789abcdef", "series-v1-fedcba9876543210", "series-v2-0123456789abcdef"]) {
			mkdirSync(join(records, name), { recursive: true });
			writeFileSync(join(records, name, "x.json"), "{}\n");
		}
		const result = run("derive.ts", ["--runs", dir, "--blobs", join(dir, "blobs"), "--records", records, "--requests-out", join(dir, "r.json")]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("removed the records of other code, never read: requests-v1-0123456789abcdef, requests-v1-r1");
		expect(readdirSync(records).sort()).toEqual([REQUESTS_RECORD_KEY, "series-v1-fedcba9876543210", "series-v2-0123456789abcdef"].sort());
	});

	test("build-page refuses to build from a part that is neither Derivations nor a note", () => {
		const { dir } = directory("neither");
		const result = run("build-page.ts", [join(dir, "absent.json"), join(dir, "index.html")]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("neither");
	});
});

describe("the page with a Method's part missing", () => {
	test("says where the requests' part would be that it is missing and why, and version 1's part is otherwise the same", async () => {
		const { made } = directory("page-missing");
		const v1 = series.derive(made.files, await series.gather(made.files, made.fetch));
		const failure: MethodFailure = { schema: "ledgermath.method-failure/1", method: { name: "requests", version: 1 }, error: "a tally of 200 whose bins hold 201" };
		const alone = renderPage(v1, { runUrlBase: RUNS_REPOSITORY_BLOB_URL });
		const html = renderPage(v1, { runUrlBase: RUNS_REPOSITORY_BLOB_URL, requestsFailure: failure });
		expect(html).toContain('<p class="meta missing"><a href="#requests">Per request: missing</a>. Method requests v1 failed on this run and made no Derivations: a tally of 200 whose bins hold 201.</p>');
		expect(html).toContain('<section class="missing-part" id="requests">');
		expect(html).not.toContain('class="series requests"');
		const stripped = html.replace(/\n<p class="meta missing">[^\n]*<\/p>/, "").replace(/\n<section class="missing-part" id="requests">[\s\S]*<\/section>(?=\n<\/body>)/, "");
		expect(stripped).toBe(alone);
		// With the requests' Derivations, no notice.
		const r = requests.derive(made.files, await requests.gather(made.files, made.fetch));
		expect(renderPage(v1, { runUrlBase: RUNS_REPOSITORY_BLOB_URL, requests: r })).not.toContain("missing");
	});
});
