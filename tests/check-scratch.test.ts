import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/check-scratch.py reports a parameter set this machine cannot provide
// as skipped only when the binary refuses it in its own words.
// tests/check-scratch-cases.py runs a stub binary for each case and asks the
// script's skip_problem() about its exit, stream and stderr.

const scratch = mkdtempSync(join(tmpdir(), "check-scratch-cases-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const done = spawnSync("python3", [join(import.meta.dir, "check-scratch-cases.py"), join(scratch, "out")], { encoding: "utf8" });
if (done.status !== 0) throw new Error(`check-scratch-cases.py failed:\n${done.stdout}${done.stderr}`);
const cases = JSON.parse(done.stdout) as Record<string, string | null>;

const problem = (name: string): string | null => {
	if (!(name in cases)) throw new Error(`no case ${name}`);
	return cases[name] as string | null;
};

describe("a skip is accepted", () => {
	test("when mutex exits 2 after `started` alone, refusing exactly that placement", () => {
		expect(problem("mutex refuses its placement")).toBeNull();
	});

	test("when disk_read_io_uring exits 2 after `started` alone, saying io_uring is not available", () => {
		expect(problem("io_uring refused")).toBeNull();
	});
});

describe("a skip is refused, so the check fails", () => {
	test("for a stub that exits 2 for an unrelated reason", () => {
		expect(problem("mutex exits 2 for another reason")).toBe(
			"its stderr has no line starting 'error: placement distinct_cores is impossible here: '",
		);
		expect(problem("io_uring exits 2 for another reason")).toBe("its stderr has no line starting 'error: io_uring is not available here: '");
		expect(problem("a stub that says nothing and exits 2")).toBe(
			"its stream is not `started` alone (0 lines); its stderr has no line starting 'error: placement distinct_cores is impossible here: '",
		);
	});

	test("for the right words in the wrong place: after other events, for another placement, with no stream, or a stream that is not JSON", () => {
		expect(problem("the refusal, but after more events")).toBe("its stream is not `started` alone (2 lines)");
		expect(problem("the refusal of another placement")).toBe("its stderr has no line starting 'error: placement smt_siblings is impossible here: '");
		expect(problem("the refusal, with no stream")).toBe("its stream is not `started` alone (0 lines)");
		expect(problem("a stream that is not JSON")).toBe("its stream is not `started` alone (1 line)");
	});

	test("for any exit but 2, and for a benchmark that never refuses a set", () => {
		expect(problem("the refusal, with exit 1")).toBe("it exited 1, not 2");
		expect(problem("a benchmark that never refuses")).toBe("syscall never refuses a parameter set");
	});
});
