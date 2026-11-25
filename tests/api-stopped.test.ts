/**
 * An upload that stops leaves no link hanging that a reader can reach. The
 * upload writes the tree a phase at a time (infra/runs/api-bucket.ts,
 * UPLOAD_PHASES), and a failed write stops it in its phase; until a later
 * upload succeeds, readers are served what it wrote. So whatever phase an
 * upload stops in, and whichever write of it fails, every link reachable from
 * the table of contents must name a file the bucket holds: the links in the
 * files, and the list of each benchmark a reachable row names, at the address
 * the table of contents' template gives. Held on the move from layout 1 to
 * layout 2 and on an ordinary publish that brings a benchmark never seen
 * before (found by the verification: a Series file's link to its benchmark's
 * list, since taken out, was left hanging by both).
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";

import { treeObject, UPLOAD_PHASES } from "../infra/runs/api-bucket";
import { buildApi, DEFAULT_BASE, readApiSchemas } from "../scripts/lib/api";
import { type ApiStore, type StoredObject, type TreeFile, uploadTree } from "../scripts/lib/api-upload";
import { makeManyFixture } from "./api-fixtures";

setDefaultTimeout(120_000);

type Json = Record<string, any>;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** A bucket in memory: what each write left, and a rule for the writes that fail. */
class MemoryStore implements ApiStore {
	readonly name = "memory";
	readonly objects = new Map<string, { file: TreeFile; run: number }>();
	failing: (key: string) => boolean = () => false;
	async head(key: string): Promise<StoredObject | null> {
		const object = this.objects.get(key);
		return object === undefined ? null : { size: object.file.bytes.length, sha256: object.file.sha256, contentType: object.file.contentType, cacheControl: object.file.cacheControl, run: object.run };
	}
	async put(file: TreeFile, run: number): Promise<void> {
		if (this.failing(file.key)) throw new Error(`refused ${file.key}`);
		this.objects.set(file.key, { file, run });
	}
	async list(prefix: string): Promise<string[]> {
		return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
	}
	copy(): MemoryStore {
		const out = new MemoryStore();
		for (const [key, object] of this.objects) out.objects.set(key, object);
		return out;
	}
}

const filesOf = (tree: ReadonlyMap<string, Uint8Array>): TreeFile[] =>
	[...tree].map(([key, bytes]) => ({ key, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), ...treeObject(key) })).sort((a, b) => (a.key < b.key ? -1 : 1));

/** The links reachable from the table of contents that name a file the bucket does not hold, each as "from -> to". */
function hanging(store: MemoryStore): string[] {
	const read = (key: string): unknown => JSON.parse(decoder.decode((store.objects.get(key) as { file: TreeFile }).file.bytes));
	const prefix = `${DEFAULT_BASE}/`;
	const index = read("v1/index.json") as Json;
	const template: unknown = index.benchmarks?.benchmark_file_url_template;
	const reached = new Set(["v1/index.json"]);
	const queue = ["v1/index.json"];
	const out: string[] = [];
	while (queue.length > 0) {
		const key = queue.pop() as string;
		const value = read(key);
		const targets = new Set<string>();
		const walk = (node: unknown): void => {
			if (typeof node === "string") {
				if (node.startsWith(`${prefix}v1/`) && !node.includes("{")) targets.add(node.slice(prefix.length));
			} else if (Array.isArray(node)) node.forEach(walk);
			else if (typeof node === "object" && node !== null) Object.values(node).forEach(walk);
		};
		walk(value);
		// The list of each benchmark a row names, at the template's address.
		if (typeof template === "string" && (key === "v1/series.json" || key.startsWith("v1/benchmarks/"))) {
			for (const row of ((value as Json).series ?? []) as Json[]) targets.add(template.replace("{benchmark}", row.benchmark).slice(prefix.length));
		}
		for (const target of targets) {
			if (!store.objects.has(target)) out.push(`${key} -> ${target}`);
			else if (!reached.has(target)) {
				reached.add(target);
				queue.push(target);
			}
		}
	}
	return out.sort();
}

/** The same tree as layout 1 wrote it: no benchmark's list nor its schema, and none of what layout 2 added to the other files. */
function asLayout1(tree: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
	const out = new Map<string, Uint8Array>();
	for (const [key, bytes] of tree) {
		if (key.startsWith("v1/benchmarks/") || key === "v1/schemas/benchmark.schema.json") continue;
		if (!/^v1\/(index|series)\.json$|^v1\/series\/[0-9a-f]{12}\.json$/.test(key)) {
			out.set(key, bytes);
			continue;
		}
		const value = JSON.parse(decoder.decode(bytes)) as Json;
		if (key === "v1/index.json") {
			delete value.benchmarks;
			delete value.series.series_file_url_template;
			delete value.series.about;
			value.layout = 1;
			value.schemas = value.schemas.filter((schema: Json) => schema.name !== "benchmark");
		} else if (key === "v1/series.json") for (const row of value.series) delete row.boots;
		else {
			delete value.boots;
			for (const block of Object.values(value.derivations) as Json[]) for (const group of block.groups) for (const field of ["counted_runs", "failed_runs", "oldest_run_started_at", "newest_run_started_at"]) delete group[field];
		}
		out.set(key, encoder.encode(`${JSON.stringify(value, null, 2)}\n`));
	}
	return out;
}

async function treeOf(benchmarks: readonly string[]): Promise<Map<string, Uint8Array>> {
	const fixture = await makeManyFixture(benchmarks.flatMap((benchmark) => [0, 1].map((n) => ({ benchmark, params: { n } }))));
	return buildApi({ base: DEFAULT_BASE, docs: "https://example.test/docs", series: fixture.series, requests: fixture.requests, prices: [], boots: new Map(), bootFiles: [], schemas: readApiSchemas() });
}

/**
 * From a bucket holding `before`, an upload of `after` stopped every way it can be: each phase failing whole, and each write it makes failing
 * alone; and the upload that does not stop. After each, no link reachable from the table of contents hangs.
 */
async function everyStop(before: ReadonlyMap<string, Uint8Array>, after: ReadonlyMap<string, Uint8Array>): Promise<number> {
	const start = new MemoryStore();
	await uploadTree(start, filesOf(before), { run: 1 });
	expect(hanging(start)).toEqual([]);
	const files = filesOf(after);
	const written = files.filter((file) => {
		const held = start.objects.get(file.key);
		return held === undefined || held.file.sha256 !== file.sha256;
	});
	const ways: Array<[string, (key: string) => boolean]> = [
		...UPLOAD_PHASES.map((phase, i): [string, (key: string) => boolean] => [`phase ${i + 1}, ${phase}, failing whole`, (key) => treeObject(key).phase === i]),
		...written.map((file): [string, (key: string) => boolean] => [`the write of ${file.key} failing alone`, (key) => key === file.key]),
		["no write failing", () => false],
	];
	for (const [way, failing] of ways) {
		const store = start.copy();
		store.failing = failing;
		try {
			await uploadTree(store, files, { run: 2 });
		} catch {
			// Stopped: what it wrote is what readers are served until a later upload succeeds.
		}
		expect([way, hanging(store)]).toEqual([way, []]);
	}
	return ways.length;
}

describe("an upload stopped in any phase, or by any one write, leaves no reachable link hanging", () => {
	test("on the move from layout 1 to layout 2", async () => {
		const tree = await treeOf(["alpha", "beta"]);
		const ways = await everyStop(asLayout1(tree), tree);
		expect(ways).toBeGreaterThan(UPLOAD_PHASES.length + 5);
	});

	test("on an ordinary publish that brings a benchmark never seen before", async () => {
		const ways = await everyStop(await treeOf(["alpha", "beta"]), await treeOf(["alpha", "beta", "gamma"]));
		expect(ways).toBeGreaterThan(UPLOAD_PHASES.length + 5);
	});

	test("and the walk sees a hanging link: a list of the template's that is not there", async () => {
		const store = new MemoryStore();
		await uploadTree(store, filesOf(await treeOf(["alpha"])), { run: 1 });
		store.objects.delete("v1/benchmarks/alpha.json");
		expect(hanging(store)).toEqual(["v1/index.json -> v1/benchmarks/alpha.json", "v1/series.json -> v1/benchmarks/alpha.json"]);
	});
});
