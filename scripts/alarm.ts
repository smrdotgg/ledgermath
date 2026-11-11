/**
 * The alarm: lists every watched Series whose newest Run started more than 48
 * hours before "now", and opens one GitHub issue listing them, or comments on
 * the alarm issue already open instead of opening a second.
 *
 *     bun scripts/alarm.ts --runs DIR --copy succeeded|failed [--now 2026-11-12T22:40:00Z] [--dry-run]
 *
 * A watched Series is one schedule.json lists (benchmark, params, build) at a
 * placement the stage launches (infra/runs/placement.ts: instance type and
 * zone). A Series from a one-off launch elsewhere is not watched, and one
 * taken out of the schedule is not watched any more. Any Run counts as the
 * Series getting a Run, failed or not. A watched Series with no Run at all is
 * listed too.
 *
 * --copy says whether this pass's copy job succeeded. When it failed, the Runs
 * repository may be behind the bucket, and every issue or comment says so at
 * the top. The alarm writes only when something changed since its last post:
 * the set of stale Series, or whether the copy is failing. Each post carries
 * that state in a hidden marker, which the next pass compares with. When every
 * Series has a Run again, it says so once on the open issue.
 *
 * GitHub is reached through IssueTracker, so tests use a fake. The real one
 * reads GITHUB_REPOSITORY and GITHUB_TOKEN, as a workflow sets them.
 * --dry-run prints what would be posted and posts nothing.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { PLACEMENTS, type Placement } from "../infra/runs/placement";
import { canonicalJson, compareText, type ParamValue, type RunFile } from "../methods/run";
import { readRunFiles } from "./lib/run-files";
import { RUNS_REPOSITORY_BLOB_URL } from "./lib/runs-repository";

export const MAX_AGE_MS = 48 * 3_600_000;
/** Marks the alarm issue's body, so a later pass finds it without a label. */
export const ALARM_MARKER = "<!-- ledgermath-alarm: stale-series -->";
/** Begins the hidden marker each alarm post ends with: the state it reported. */
export const STATE_MARKER = "<!-- ledgermath-alarm-state: ";
export const ALARM_TITLE = "Stale Series: no Run for 48 hours";

export interface Schedule {
	benchmarks: Array<{ name: string; builds: string[]; params: Array<Record<string, ParamValue>> }>;
}

export interface WatchedSeries {
	benchmark: string;
	params: Record<string, ParamValue>;
	build: string;
	instanceType: string;
	zone: string;
}

export interface NewestRun {
	id: string;
	path: string;
	startedAt: string;
}

export interface StaleSeries extends WatchedSeries {
	/** The newest Run of the Series, or null when it has none. */
	newest: NewestRun | null;
}

/** Every Series the schedule lists, at every placement. */
export function watchedSeries(schedule: Schedule, placements: readonly Placement[]): WatchedSeries[] {
	const watched: WatchedSeries[] = [];
	for (const placement of placements) {
		for (const benchmark of schedule.benchmarks) {
			for (const params of benchmark.params) {
				for (const build of benchmark.builds) {
					watched.push({ benchmark: benchmark.name, params, build, instanceType: placement.instanceType, zone: placement.zone });
				}
			}
		}
	}
	return watched;
}

interface RunFacts {
	id: string;
	path: string;
	startedAt: string;
	key: string;
}

const watchKey = (benchmark: string, params: unknown, build: string, instanceType: unknown, zone: unknown): string =>
	canonicalJson([benchmark, params, build, instanceType, zone]);

/** What the alarm reads of a Run file: nothing the schema does not require, and no blob. */
function runFacts(file: RunFile): RunFacts | null {
	const run = file.record as {
		id?: unknown;
		started_at?: unknown;
		benchmark?: unknown;
		params?: unknown;
		binary?: { build?: unknown };
		provider?: { instance_type?: unknown; availability_zone?: unknown };
	} | null;
	if (
		typeof run?.id !== "string" ||
		typeof run.started_at !== "string" ||
		typeof run.benchmark !== "string" ||
		typeof run.binary?.build !== "string" ||
		Number.isNaN(Date.parse(run.started_at))
	) {
		return null;
	}
	return {
		id: run.id,
		path: file.path,
		startedAt: run.started_at,
		key: watchKey(run.benchmark, run.params, run.binary.build, run.provider?.instance_type ?? null, run.provider?.availability_zone ?? null),
	};
}

/** The watched Series whose newest Run started more than maxAgeMs before now, or that have no Run. */
export function staleSeries(watched: readonly WatchedSeries[], files: readonly RunFile[], now: Date, maxAgeMs = MAX_AGE_MS): StaleSeries[] {
	const newest = new Map<string, RunFacts>();
	for (const file of files) {
		const facts = runFacts(file);
		if (facts === null) continue;
		const held = newest.get(facts.key);
		if (held === undefined || facts.startedAt > held.startedAt) newest.set(facts.key, facts);
	}
	const stale: StaleSeries[] = [];
	for (const series of watched) {
		const found = newest.get(watchKey(series.benchmark, series.params, series.build, series.instanceType, series.zone));
		if (found !== undefined && now.getTime() - Date.parse(found.startedAt) <= maxAgeMs) continue;
		stale.push({ ...series, newest: found === undefined ? null : { id: found.id, path: found.path, startedAt: found.startedAt } });
	}
	return stale;
}

export function describeSeries(series: WatchedSeries): string {
	const params = Object.entries(series.params)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(" ");
	return `${series.benchmark} · ${params} · ${series.build} · ${series.instanceType} · ${series.zone}`;
}

/** What an alarm post reported: compared with the next pass's to decide whether to write. */
export interface AlarmState {
	/** describeSeries() of each stale Series, sorted. */
	stale: string[];
	copy_failed: boolean;
}

export function alarmState(stale: readonly StaleSeries[], copyFailed: boolean): AlarmState {
	return { stale: stale.map(describeSeries).sort(compareText), copy_failed: copyFailed };
}

/** The state the newest alarm post carries, or null when it carries none. */
export function stateOf(post: string): AlarmState | null {
	const at = post.lastIndexOf(STATE_MARKER);
	if (at < 0) return null;
	const end = post.indexOf(" -->", at);
	try {
		const state = JSON.parse(post.slice(at + STATE_MARKER.length, end)) as Partial<AlarmState>;
		if (!Array.isArray(state.stale) || typeof state.copy_failed !== "boolean") return null;
		return { stale: state.stale.map(String), copy_failed: state.copy_failed };
	} catch {
		return null;
	}
}

const COPY_FAILED =
	"**The copy job failed on this pass.** The Runs repository may be behind the bucket, so what follows may be out of " +
	"date, and a Series listed may in fact be getting Runs. Look at the copy job first.";

/** The text posted: the stale Series, each with its newest Run and how old it is, and the state marker. */
export function alarmText(stale: readonly StaleSeries[], now: Date, copyFailed: boolean, runUrlBase = RUNS_REPOSITORY_BLOB_URL): string {
	const hours = (startedAt: string): string => ((now.getTime() - Date.parse(startedAt)) / 3_600_000).toFixed(1);
	const lines = stale
		.slice()
		.sort((a, b) => compareText(describeSeries(a), describeSeries(b)))
		.map((series) =>
			series.newest === null
				? `- \`${describeSeries(series)}\`: no Run at all`
				: `- \`${describeSeries(series)}\`: newest Run [${series.newest.id}](${runUrlBase}${series.newest.path}) started ${series.newest.startedAt}, ${hours(series.newest.startedAt)} hours ago`,
		);
	const summary =
		stale.length === 0
			? `Checked at ${now.toISOString()}: every watched Series has had a Run in the last 48 hours again.`
			: `Checked at ${now.toISOString()}: ${stale.length} watched Series ${stale.length === 1 ? "has" : "have"} had no Run for more than 48 hours.`;
	return [
		...(copyFailed ? [COPY_FAILED, ""] : []),
		summary,
		...(lines.length ? ["", ...lines] : []),
		"",
		"A watched Series is one `schedule.json` lists, at the instance type and zone the stage launches (`infra/runs/placement.ts`). Written by `scripts/alarm.ts`, which writes again only when the stale Series, or whether the copy job is failing, change.",
		`${STATE_MARKER}${JSON.stringify(alarmState(stale, copyFailed))} -->`,
	].join("\n");
}

/** The open alarm issue, and its newest alarm post: the body, or the newest comment carrying a state marker. */
export interface OpenAlarm {
	number: number;
	lastPost: string;
}

export interface IssueTracker {
	/** The open issue whose body holds marker, or null. */
	findOpen(marker: string): Promise<OpenAlarm | null>;
	/** Opens an issue and returns its number. */
	open(title: string, body: string): Promise<number>;
	comment(issue: number, body: string): Promise<void>;
}

export type AlarmOutcome =
	| { action: "none"; stale: StaleSeries[] }
	| { action: "opened"; issue: number; stale: StaleSeries[] }
	| { action: "commented"; issue: number; stale: StaleSeries[] }
	| { action: "unchanged"; issue: number; stale: StaleSeries[] };

const sameState = (a: AlarmState, b: AlarmState): boolean =>
	a.copy_failed === b.copy_failed && a.stale.length === b.stale.length && a.stale.every((series, i) => series === b.stale[i]);

/** One pass of the alarm. */
export async function runAlarm(options: {
	schedule: Schedule;
	placements: readonly Placement[];
	runs: readonly RunFile[];
	now: Date;
	/** Whether this pass's copy job failed, so the Runs repository may be behind the bucket. */
	copyFailed: boolean;
	tracker: IssueTracker;
	runUrlBase?: string;
}): Promise<AlarmOutcome> {
	const stale = staleSeries(watchedSeries(options.schedule, options.placements), options.runs, options.now);
	const open = await options.tracker.findOpen(ALARM_MARKER);
	const text = alarmText(stale, options.now, options.copyFailed, options.runUrlBase);
	if (open === null) {
		if (stale.length === 0) return { action: "none", stale };
		const issue = await options.tracker.open(ALARM_TITLE, `${ALARM_MARKER}\n${text}`);
		return { action: "opened", issue, stale };
	}
	const last = stateOf(open.lastPost);
	if (last !== null && sameState(last, alarmState(stale, options.copyFailed))) return { action: "unchanged", issue: open.number, stale };
	// Nothing to say on an issue whose last word was already that all is well, if only the copy changed.
	if (last === null && stale.length === 0) return { action: "unchanged", issue: open.number, stale };
	await options.tracker.comment(open.number, text);
	return { action: "commented", issue: open.number, stale };
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** GitHub's REST API, with a token that may write issues. */
export class GitHubIssues implements IssueTracker {
	constructor(
		private readonly repository: string,
		private readonly token: string,
		private readonly fetcher: Fetch = fetch,
	) {}

	private async call(method: string, path: string, body?: unknown): Promise<unknown> {
		const response = await this.fetcher(`https://api.github.com/repos/${this.repository}${path}`, {
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${this.token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "ledgermath-alarm",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
		return response.json();
	}

	async findOpen(marker: string): Promise<OpenAlarm | null> {
		for (let page = 1; ; page++) {
			const issues = (await this.call("GET", `/issues?state=open&per_page=100&page=${page}`)) as Array<{
				number: number;
				body?: string | null;
				pull_request?: unknown;
			}>;
			const found = issues.find((issue) => issue.pull_request === undefined && (issue.body ?? "").includes(marker));
			if (found !== undefined) return { number: found.number, lastPost: await this.lastPost(found.number, found.body ?? "") };
			if (issues.length < 100) return null;
		}
	}

	/** The newest comment carrying a state marker, or the issue's body when none does. */
	private async lastPost(issue: number, body: string): Promise<string> {
		let last = body;
		for (let page = 1; ; page++) {
			const comments = (await this.call("GET", `/issues/${issue}/comments?per_page=100&page=${page}`)) as Array<{ body?: string | null }>;
			for (const comment of comments) if ((comment.body ?? "").includes(STATE_MARKER)) last = comment.body ?? "";
			if (comments.length < 100) return last;
		}
	}

	async open(title: string, body: string): Promise<number> {
		const issue = (await this.call("POST", "/issues", { title, body })) as { number: number };
		return issue.number;
	}

	async comment(issue: number, body: string): Promise<void> {
		await this.call("POST", `/issues/${issue}/comments`, { body });
	}
}

/** Posts nothing; prints what would be posted. */
class DryRun implements IssueTracker {
	async findOpen(): Promise<OpenAlarm | null> {
		return null;
	}
	async open(title: string, body: string): Promise<number> {
		console.log(`--dry-run: would open "${title}", or comment on the open alarm issue:\n\n${body}`);
		return 0;
	}
	async comment(): Promise<void> {}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			runs: { type: "string" },
			now: { type: "string" },
			schedule: { type: "string" },
			copy: { type: "string" },
			"dry-run": { type: "boolean" },
		},
	});
	if (!values.runs || (values.copy !== "succeeded" && values.copy !== "failed")) {
		console.error("usage: bun scripts/alarm.ts --runs DIR --copy succeeded|failed [--now ISO-8601] [--schedule FILE] [--dry-run]");
		process.exit(2);
	}
	const now = values.now === undefined ? new Date() : new Date(values.now);
	if (Number.isNaN(now.getTime())) throw new Error(`--now ${values.now} is not a time`);
	const schedulePath = values.schedule ?? join(resolve(import.meta.dir, ".."), "schedule.json");
	const schedule = JSON.parse(readFileSync(schedulePath, "utf8")) as Schedule;

	let tracker: IssueTracker;
	if (values["dry-run"]) tracker = new DryRun();
	else {
		const repository = process.env.GITHUB_REPOSITORY;
		const token = process.env.GITHUB_TOKEN;
		if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN must be set, or pass --dry-run");
		tracker = new GitHubIssues(repository, token);
	}
	const runs = readRunFiles(values.runs);
	const copyFailed = values.copy === "failed";
	const outcome = await runAlarm({ schedule, placements: PLACEMENTS, runs, now, copyFailed, tracker });
	const watched = watchedSeries(schedule, PLACEMENTS).length;
	if (copyFailed) console.log("the copy job failed on this pass: the Runs repository may be behind the bucket");
	for (const series of outcome.stale) console.log(`stale: ${describeSeries(series)} (newest ${series.newest?.startedAt ?? "none"})`);
	console.log(`${now.toISOString()}: ${outcome.stale.length} of ${watched} watched Series stale`);
	if (outcome.action !== "none" && !values["dry-run"]) {
		console.log(outcome.action === "unchanged" ? `nothing changed since the last post on issue #${outcome.issue}` : `${outcome.action} issue #${outcome.issue}`);
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
