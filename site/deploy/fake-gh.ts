// A stand-in for the GitHub CLI, for deploy/published.test.ts: it answers from a world of runs as
// GitHub's API and `gh api` do (lists in pages, newest run first; an artifact's record and its zip
// archive), and asks nothing of the network. Not a test file.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Gh, GhResult } from "./published";

export const REPOSITORY = "owner/ledgermath";
export const PUBLISH_STARTED = "2026-11-25T00:16:10Z";
export const API_MADE = "2026-11-25T00:16:03Z";

export type Job = { name: string; conclusion: string | null; run_attempt?: number; started_at?: string | null };
/** An artifact as GitHub keeps it; `files` are what its archive holds, `zip` what gh says when asked for the archive. */
export type Artifact = { id: number; name?: string; created_at?: string; expired?: boolean; run?: number; files?: Record<string, string>; digest?: string | null; zip?: GhResult };
/**
 * A run as GitHub keeps it: its jobs (or what gh says when asked for them), its artifacts, and,
 * by page, answers that replace what the stand-in would give for its jobs.
 */
export type Run = { id: number; head_branch?: string; jobs?: Job[] | GhResult; jobPages?: Record<number, GhResult>; artifacts?: Artifact[] };
/** The runs of runs.yml; `listPages`, by page, answers that replace what the stand-in would give for the list. */
export type World = { runs: Run[]; listPages?: Record<number, GhResult> };

export const ok = (value: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const isResult = (value: unknown): value is GhResult => typeof value === "object" && value !== null && "code" in value;
export const runUrl = (id: number) => `https://github.com/${REPOSITORY}/actions/runs/${id}`;

/** A zip archive holding FILES, stored without compression, as unzip reads it. */
export function zipStored(files: Record<string, string>): Uint8Array {
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	const header = (size: number, write: (view: DataView) => void) => {
		const bytes = new Uint8Array(size);
		write(new DataView(bytes.buffer));
		return bytes;
	};
	for (const [name, text] of Object.entries(files)) {
		const nameBytes = new TextEncoder().encode(name);
		const data = new TextEncoder().encode(text);
		const crc = Bun.hash.crc32(data);
		const local = header(30, (v) => {
			v.setUint32(0, 0x04034b50, true);
			v.setUint16(4, 20, true);
			v.setUint16(6, 0x0800, true);
			v.setUint16(12, 0x21, true);
			v.setUint32(14, crc, true);
			v.setUint32(18, data.length, true);
			v.setUint32(22, data.length, true);
			v.setUint16(26, nameBytes.length, true);
		});
		central.push(
			header(46, (v) => {
				v.setUint32(0, 0x02014b50, true);
				v.setUint16(4, 20, true);
				v.setUint16(6, 20, true);
				v.setUint16(8, 0x0800, true);
				v.setUint16(14, 0x21, true);
				v.setUint32(16, crc, true);
				v.setUint32(20, data.length, true);
				v.setUint32(24, data.length, true);
				v.setUint16(28, nameBytes.length, true);
				v.setUint32(42, offset, true);
			}),
			nameBytes,
		);
		parts.push(local, nameBytes, data);
		offset += local.length + nameBytes.length + data.length;
	}
	const centralSize = central.reduce((sum, part) => sum + part.length, 0);
	const count = Object.keys(files).length;
	const end = header(22, (v) => {
		v.setUint32(0, 0x06054b50, true);
		v.setUint16(8, count, true);
		v.setUint16(10, count, true);
		v.setUint32(12, centralSize, true);
		v.setUint32(16, offset, true);
	});
	const all = [...parts, ...central, end];
	const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of all) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

const DEFAULT_FILES = { "v1/index.json": '{"schema":"ledgermath.api.index/1"}' };
const zipOf = (artifact: Artifact) => zipStored(artifact.files ?? DEFAULT_FILES);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** One page of ENTRIES, as GitHub gives it for the page and per_page ARGS ask for. */
function page(args: string[], key: string, entries: unknown[], total = entries.length): GhResult {
	const field = (name: string, fallback: number) => Number(args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback);
	const perPage = field("per_page", 30);
	const number = field("page", 1);
	return ok({ total_count: total, [key]: entries.slice((number - 1) * perPage, number * perPage) });
}
const pageNumber = (args: string[]) => Number(args.find((arg) => arg.startsWith("page="))?.slice(5) ?? 1);

/** A gh that answers from WORLD, as GitHub does, and records what it was asked in ASKED. */
export function fakeGh(world: World, asked: string[][] = []): Gh {
	const artifactsOf = (run: Run) => (run.artifacts ?? []).map((artifact) => ({ ...artifact, run: artifact.run ?? run.id }));
	const allArtifacts = () => world.runs.flatMap(artifactsOf);
	return (args) => {
		asked.push(args);
		const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
		if (args[0] !== "api") return { code: 1, stdout: "", stderr: `the stand-in does not know: gh ${args.join(" ")}` };
		if (path === `repos/${REPOSITORY}/actions/workflows/runs.yml/runs`) {
			const replaced = world.listPages?.[pageNumber(args)];
			if (replaced) return replaced;
			const latest = [...world.runs].sort((a, b) => b.id - a.id);
			return page(args, "workflow_runs", latest.map((run) => ({ id: run.id, head_branch: run.head_branch ?? "main", html_url: runUrl(run.id), status: "completed" })));
		}
		const of = new RegExp(`^repos/${REPOSITORY}/actions/runs/(\\d+)/(jobs|artifacts)$`).exec(path);
		if (of) {
			const run = world.runs.find((each) => each.id === Number(of[1]));
			if (of[2] === "jobs") {
				const replaced = run?.jobPages?.[pageNumber(args)];
				if (replaced) return replaced;
				if (isResult(run?.jobs)) return run.jobs;
				return page(args, "jobs", (run?.jobs ?? []).map((job) => ({ run_attempt: 1, started_at: PUBLISH_STARTED, ...job })));
			}
			const name = args.find((arg) => arg.startsWith("name="))?.slice(5);
			const artifacts = run === undefined ? [] : artifactsOf(run).filter((artifact) => name === undefined || (artifact.name ?? "api") === name);
			return page(args, "artifacts", artifacts.map((artifact) => ({ id: artifact.id, name: artifact.name ?? "api", created_at: artifact.created_at ?? API_MADE, expired: artifact.expired ?? false })));
		}
		const one = new RegExp(`^repos/${REPOSITORY}/actions/artifacts/(\\d+)(/zip)?$`).exec(path);
		if (one) {
			const artifact = allArtifacts().find((each) => each.id === Number(one[1]));
			if (!artifact) return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
			if (one[2]) {
				if (artifact.zip) return artifact.zip;
				const bytes = zipOf(artifact);
				return { code: 0, stdout: new TextDecoder().decode(bytes), stderr: "", bytes };
			}
			const digest = artifact.digest === undefined ? `sha256:${sha256(zipOf(artifact))}` : artifact.digest;
			return ok({ id: artifact.id, name: artifact.name ?? "api", expired: artifact.expired ?? false, created_at: artifact.created_at ?? API_MADE, digest, workflow_run: { id: artifact.run } });
		}
		return { code: 1, stdout: "", stderr: `the stand-in does not know: gh ${args.join(" ")}` };
	};
}

/** What the stand-in executable answers to ARGS, with its world read from the JSON file at STATE. */
export function fakeGhForScript(state: string, args: string[]): GhResult {
	return fakeGh(JSON.parse(readFileSync(state, "utf8")) as World)(args);
}
