/**
 * The alarm: lists every watched Series whose newest Run started more than 48
 * hours before "now", and opens one GitHub issue listing them, or comments on
 * the alarm issue already open instead of opening a second.
 *
 *     bun scripts/alarm.ts --runs DIR --copy succeeded|failed --schedule-changed-at ISO-8601
 *         [--prices-since ISO-8601] [--api-bucket NAME] [--drill yes|no] [--now 2026-11-12T22:40:00Z]
 *         [--schedule FILE] [--dry-run] [--api-endpoint URL]
 *
 * A watched Series is one schedule.json runs (benchmark, params, build) on one
 * of its targets (instance type and zone), where the entry's instance_types,
 * if it has any, include the target's. The stage launches exactly those
 * targets (infra/runs/placement.ts reads them from the same file). A Series
 * from a one-off launch elsewhere is not watched, and one taken out of the
 * schedule is not watched any more. Any Run counts as the Series getting a
 * Run, failed or not.
 *
 * A watched Series that has never had a Run is stale only once the schedule
 * has been unchanged for 48 hours, so a Series is not reported the moment it
 * is added. --schedule-changed-at is when schedule.json last changed, which
 * the workflow takes from git: the commit time of the last commit on main's
 * first-parent line that changed it.
 *
 * --copy says whether this pass's copy job succeeded. When it failed, the Runs
 * repository may be behind the bucket, and every issue or comment says so at
 * the top. The alarm writes only when something changed since its last post:
 * the set of stale Series, or whether the copy is failing. Each post carries
 * that state in a hidden marker, which the next pass compares with. When every
 * Series has a Run again, it says so once on the open issue.
 *
 * It also watches the price files (issue #45): when the newest one in the
 * Runs repository, prices/<yyyy>/<mm>/<dd>/aws.json, was fetched more than 48
 * hours before "now", it says so in the same issue, by the same rule of
 * writing only when something changed. With no price file at all, it stays
 * quiet until 48 hours after the prices workflow first existed, the same idea
 * as for a Series that has never had a Run: --prices-since is when that was,
 * which the workflow takes from git (the commit time of the first commit on
 * main's first-parent line that touched .github/workflows/prices.yml). Without
 * --prices-since, or with it empty, an absence of price files is not reported.
 *
 * And it watches the data API's publishing (ADR-0032,
 * scripts/lib/api-freshness.ts): with --api-bucket naming the API bucket (the
 * workflow passes API_BUCKET), it says in the same issue, by the same rule,
 * when the bucket's table of contents, v1/index.json, was last written more
 * than 14 hours before now, by S3's own clock; also when the bucket holds no
 * table of contents, or cannot be read. With --api-bucket empty or absent
 * (API_BUCKET unset) the bucket is not read, and nothing is raised for it
 * while PUBLIC_API is "off"; in any other state the alarm is raised, since
 * serving is then on and a missing bucket name means publishing has stopped.
 * That check runs whole in a child process (scripts/check-api-publishing.ts),
 * started before the Runs repository is read, with only CHILD_ENVIRONMENT,
 * in a process group the alarm kills after CHECK_BUDGET_MS. It reports a
 * result from a closed set, which the alarm validates and renders in fixed
 * words; a kill, a failure or output that is not a result is "the check of
 * the API bucket failed", for a reason from a closed set, and what the alarm
 * says of the Series and the price files is what it would say without the
 * check. What the child or S3 said goes to the log, never to the issue. The
 * child writes its own line to the step's summary; the alarm writes nothing
 * on its behalf. Credentials come from the environment, as
 * aws-actions/configure-aws-credentials sets them; --api-endpoint is a
 * stand-in for S3, for the tests.
 *
 * Every body it posts is under MAX_BODY_CHARS, below GitHub's limit: when the
 * stale Series do not all fit, as many as fit are listed and one line says
 * how many more; the log lists every one, and the step's summary as many as
 * its size limit holds (staleList). The
 * state marker carries their number and a hash of the set, not the list.
 *
 * --drill yes (the workflow's input alarm_drill): after its ordinary pass, the
 * alarm posts one comment on its issue, or, with none open, opens the issue
 * with the drill's words and no comment: one notification. It reads nothing
 * and carries no state marker, so nothing the alarm reads back changes, and a
 * drill that cannot post does not change the alarm's exit code.
 *
 * GitHub is reached through IssueTracker, so tests use a fake. The real one
 * reads GITHUB_REPOSITORY and GITHUB_TOKEN, as a workflow sets them.
 * --dry-run prints what would be posted and posts nothing.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { PUBLIC_API } from "../infra/runs/public-blobs";
import { appliesTo, parseSchedule, type Schedule } from "../infra/runs/schedule";
import { canonicalJson, compareText, type ParamValue, type RunFile } from "../methods/run";
import { ACTIONS_RUN_URL, type ApiReport, apiReport, type CheckFailure, type CheckResult, checkFailed, parseResult } from "./lib/api-freshness";
import { boundedText, clipText } from "./lib/api-upload";
import { PRICE_FILE_PATH } from "./lib/prices";
import { readRunFiles } from "./lib/run-files";
import { RUNS_REPOSITORY_BLOB_URL } from "./lib/runs-repository";

export const MAX_AGE_MS = 48 * 3_600_000;
/** Marks the alarm issue's body, so a later pass finds it without a label. */
export const ALARM_MARKER = "<!-- ledgermath-alarm: stale-series -->";
/** Begins the hidden marker each alarm post ends with: the state it reported. */
export const STATE_MARKER = "<!-- ledgermath-alarm-state: ";
export const ALARM_TITLE = "Stale: no Run or price file for 48 hours, or the data API not published";

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

/** Every Series the schedule runs: each entry's parameter sets and builds, on every target the entry is for. */
export function watchedSeries(schedule: Schedule): WatchedSeries[] {
	const watched: WatchedSeries[] = [];
	for (const target of schedule.targets) {
		for (const benchmark of schedule.benchmarks) {
			if (!appliesTo(benchmark, target.instance_type)) continue;
			for (const params of benchmark.params) {
				for (const build of benchmark.builds) {
					watched.push({ benchmark: benchmark.name, params, build, instanceType: target.instance_type, zone: target.zone });
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

/**
 * The watched Series whose newest Run started more than maxAgeMs before now,
 * and those that have never had a Run once the schedule has been unchanged
 * for more than maxAgeMs.
 */
export function staleSeries(
	watched: readonly WatchedSeries[],
	files: readonly RunFile[],
	now: Date,
	scheduleChangedAt: Date,
	maxAgeMs = MAX_AGE_MS,
): StaleSeries[] {
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
		if (found === undefined && now.getTime() - scheduleChangedAt.getTime() <= maxAgeMs) continue;
		stale.push({ ...series, newest: found === undefined ? null : { id: found.id, path: found.path, startedAt: found.startedAt } });
	}
	return stale;
}

/** The newest price file of the Runs repository: its path there, and when it was fetched. */
export interface NewestPriceFile {
	path: string;
	fetchedAt: string;
}

/**
 * The price file under prices/ with the latest fetched_at, or null when there
 * is none. A file whose path is not shaped like a price file's, or whose
 * fetched_at is not a time, is passed over, as a malformed Run file is.
 */
export function newestPriceFile(repository: string): NewestPriceFile | null {
	const directory = join(repository, "prices");
	if (!existsSync(directory)) return null;
	let newest: NewestPriceFile | null = null;
	for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = relative(repository, join(entry.parentPath, entry.name)).split(sep).join("/");
		if (!PRICE_FILE_PATH.test(path)) continue;
		let fetchedAt: unknown;
		try {
			fetchedAt = (JSON.parse(readFileSync(join(repository, path), "utf8")) as { fetched_at?: unknown }).fetched_at;
		} catch {
			continue;
		}
		if (typeof fetchedAt !== "string" || Number.isNaN(Date.parse(fetchedAt))) continue;
		if (newest === null || Date.parse(fetchedAt) > Date.parse(newest.fetchedAt)) newest = { path, fetchedAt };
	}
	return newest;
}

/** The price files are stale: the newest is too old, or there is none (newest null). */
export interface StalePrices {
	newest: NewestPriceFile | null;
	/** When the prices workflow first existed, when there is no price file. */
	since: string | null;
}

/**
 * Whether the price files are stale: the newest was fetched more than maxAgeMs
 * before now, or there is none and the prices workflow has existed for more
 * than maxAgeMs. pricesSince null means it is not known to exist, and then
 * no price file is not stale.
 */
export function stalePrices(newest: NewestPriceFile | null, now: Date, pricesSince: Date | null, maxAgeMs = MAX_AGE_MS): StalePrices | null {
	if (newest !== null) return now.getTime() - Date.parse(newest.fetchedAt) > maxAgeMs ? { newest, since: null } : null;
	if (pricesSince === null || now.getTime() - pricesSince.getTime() <= maxAgeMs) return null;
	return { newest: null, since: pricesSince.toISOString() };
}

export function describeSeries(series: WatchedSeries): string {
	const params = Object.entries(series.params)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(" ");
	return `${series.benchmark} · ${params} · ${series.build} · ${series.instanceType} · ${series.zone}`;
}

/**
 * What an alarm post reported: compared with the next pass's to decide
 * whether to write. The stale Series are carried as their number and a hash
 * of the whole sorted set, not listed, so the marker stays a few hundred
 * characters however many there are: any change to the set, shown in the
 * post or not, changes the hash, and the same set gives the same hash.
 */
export interface AlarmState {
	/** How many watched Series are stale. */
	stale_count: number;
	/** staleHash() of their describeSeries(), sorted. */
	stale_hash: string;
	copy_failed: boolean;
	/** Present only when the price files are stale: the newest one's path, or "none". Posts from before prices were watched lack it. */
	stale_prices?: string;
	/** Present only when the API bucket is raised: apiAlarmState(). Posts from before the bucket was watched lack it. */
	stale_api?: string;
}

/** The first 16 hex digits of the SHA-256 of the JSON of the sorted descriptions: unambiguous, whatever a description holds. */
export function staleHash(descriptions: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify([...descriptions].sort(compareText))).digest("hex").slice(0, 16);
}

export function alarmState(stale: readonly StaleSeries[], copyFailed: boolean, prices: StalePrices | null = null, api: string | null = null): AlarmState {
	const state: AlarmState = { stale_count: stale.length, stale_hash: staleHash(stale.map(describeSeries)), copy_failed: copyFailed };
	if (prices !== null) state.stale_prices = prices.newest?.path ?? "none";
	if (api !== null) state.stale_api = api;
	return state;
}

/**
 * The state the newest alarm post carries, or null when it carries none.
 * Reads posts written before the count and hash, which listed the stale
 * Series, as the same state.
 */
export function stateOf(post: string): AlarmState | null {
	const at = post.lastIndexOf(STATE_MARKER);
	if (at < 0) return null;
	const end = post.indexOf(" -->", at);
	try {
		const state = JSON.parse(post.slice(at + STATE_MARKER.length, end)) as Partial<AlarmState> & { stale?: unknown };
		if (typeof state.copy_failed !== "boolean") return null;
		let parsed: AlarmState;
		if (Array.isArray(state.stale)) {
			const listed = state.stale.map(String);
			parsed = { stale_count: listed.length, stale_hash: staleHash(listed), copy_failed: state.copy_failed };
		} else if (Number.isSafeInteger(state.stale_count) && typeof state.stale_hash === "string") {
			parsed = { stale_count: state.stale_count as number, stale_hash: state.stale_hash, copy_failed: state.copy_failed };
		} else return null;
		if (typeof state.stale_prices === "string") parsed.stale_prices = state.stale_prices;
		if (typeof state.stale_api === "string") parsed.stale_api = state.stale_api;
		return parsed;
	} catch {
		return null;
	}
}

const COPY_FAILED =
	"**The copy job failed on this pass.** The Runs repository may be behind the bucket, so what follows may be out of " +
	"date, and a Series listed may in fact be getting Runs. Look at the copy job first.";

/** The whole check of the API bucket, in its child, is killed after this: well under a minute, so the alarm's own verdict, which comes after it, is never held up long. */
export const CHECK_BUDGET_MS = 20_000;

/** The most of the child's output read: a result is under a hundred bytes. */
const CHILD_OUTPUT_BYTES = 4_096;

/**
 * The child's whole environment: the AWS keys aws-actions/configure-aws-
 * credentials sets, and where the step's summary is. Nothing else: not
 * GITHUB_TOKEN, not PATH or HOME, which Bun does not need to run it. The
 * bucket, the time and PUBLIC_API.state go as arguments; the Region is
 * RUNS_REGION, in the code.
 */
export const CHILD_ENVIRONMENT = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GITHUB_STEP_SUMMARY"] as const;

/** What the check came to: a result from the child, or why there is none. */
export type ChildOutcome = { result: CheckResult } | { failure: CheckFailure };

/** Kills a process group, the child and anything it started; already gone is no error. */
function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

/**
 * The check of the API bucket, run as the child process `command`
 * (scripts/check-api-publishing.ts) with only CHILD_ENVIRONMENT, taken from
 * `env` (process.env unless given), in a process group of its own, which is
 * killed with SIGKILL, the child and anything it started, if it has not
 * finished within budgetMs, and in any case once it has. Its result is the
 * one line of JSON it prints, validated against the closed set
 * (parseResult). A kill, a non-zero exit, output that is not a result, or a
 * child that cannot be started is a failure from a closed set. What the
 * child printed goes to `log` (the job's log), never into the result. Never
 * throws, and writes nothing to the step's summary: the child writes its own
 * line, and if that blocks, the kill ends it.
 */
export async function checkInChild(
	command: string[],
	options: { budgetMs?: number; env?: Record<string, string | undefined>; log?: (line: string) => void } = {},
): Promise<ChildOutcome> {
	const budget = options.budgetMs ?? CHECK_BUDGET_MS;
	const log = options.log ?? ((line: string) => console.error(line));
	const source = options.env ?? process.env;
	const env: Record<string, string> = {};
	for (const name of CHILD_ENVIRONMENT) if (source[name] !== undefined) env[name] = source[name] as string;
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, detached: true } as Parameters<typeof Bun.spawn>[1]);
	} catch (error) {
		log(`the check of the API bucket could not be started: ${error instanceof Error ? error.message : String(error)}`);
		return { failure: { reason: "start" } };
	}
	let killed = false;
	const timer = setTimeout(() => {
		killed = true;
		killGroup(child.pid);
	}, budget);
	// The pipes close when the child dies; two seconds' grace past the kill, and nothing is waited for longer. Both timers are cleared, so neither keeps the alarm alive.
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	const grace = new Promise<null>((resolve) => {
		graceTimer = setTimeout(() => resolve(null), budget + 2_000);
	});
	// The moment the child exits, the rest of its group goes too, so nothing it started can hold the pipes open.
	const exited = child.exited.then((code) => {
		killGroup(child.pid);
		return code;
	});
	const ended = await Promise.race([
		Promise.all([
			boundedText(child.stdout as ReadableStream<Uint8Array>, CHILD_OUTPUT_BYTES, budget + 1_000),
			boundedText(child.stderr as ReadableStream<Uint8Array>, 4_096, budget + 1_000),
			exited,
		]),
		grace,
	]);
	clearTimeout(timer);
	clearTimeout(graceTimer);
	// Whatever the child started dies with it.
	killGroup(child.pid);
	if (ended !== null && ended[1].trim() !== "") log(`the check of the API bucket said (log only): ${clipText(ended[1], 2_000)}`);
	if (killed || ended === null) {
		log(`the check of the API bucket gave no result within ${budget} ms and was killed`);
		return { failure: { reason: "killed", budgetMs: budget } };
	}
	const [stdout, , exitCode] = ended;
	if (exitCode !== 0) return { failure: { reason: "exited", code: exitCode } };
	const result = parseResult(stdout);
	if (result === null) {
		log(`the check of the API bucket printed what is not a result (log only): ${clipText(stdout, 2_000)}`);
		return { failure: { reason: "output" } };
	}
	return { result };
}

/** The alarm's words for what the check came to. */
export function reportOf(outcome: ChildOutcome, bucket: string, now: Date, publicApiState: string): ApiReport {
	return "result" in outcome ? apiReport(outcome.result, bucket, now, publicApiState) : checkFailed(outcome.failure);
}

/** The words of a drill: one post, which says so and that nothing is wrong, and carries no state, so it changes nothing the alarm reads back. */
export function drillText(runUrl: string | null): string {
	return [
		`**This is a drill**, started by hand with the input \`alarm_drill\`${runUrl === null ? "" : ` in [this run](${runUrl})`}, to show that this issue's notifications reach the maintainer.`,
		"Nothing is wrong because of it: the drill read nothing and changed nothing, and what this issue reports, if anything, is in its other posts. If this issue was opened only by a drill, close it.",
	].join("\n\n");
}

/**
 * A drill: exactly one notification. On the open alarm issue, one comment;
 * with none open, the issue opened with the drill's words as its body and no
 * comment (a second post would be a second notification). It carries no
 * state marker, so the alarm's next pass reads the same last post as before
 * and writes as it would have.
 */
export async function postDrill(tracker: IssueTracker, runUrl: string | null): Promise<number> {
	const posting = guarded(tracker);
	const open = await posting.findOpen(ALARM_MARKER);
	if (open === null) return posting.open(ALARM_TITLE, `${ALARM_MARKER}\n${drillText(runUrl)}`);
	await posting.comment(open.number, drillText(runUrl));
	return open.number;
}

/**
 * Appends to the step's summary when there is one: best-effort, given two
 * seconds, then abandoned with a warning, so a summary that cannot be
 * written (or opened: a pipe nobody reads) never holds the alarm. The alarm
 * exits explicitly afterwards, so a write left waiting cannot keep it alive.
 */
export async function toStepSummary(text: string, path = process.env.GITHUB_STEP_SUMMARY): Promise<void> {
	if (!path) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const waited = new Promise<string>((resolve) => {
		timer = setTimeout(() => resolve("not written within 2 s"), 2_000);
	});
	const outcome = await Promise.race([appendFile(path, text).then(() => "", (error: unknown) => (error instanceof Error ? error.message : String(error))), waited]);
	clearTimeout(timer);
	if (outcome !== "") console.warn(`could not write to the step's summary (${outcome}); carrying on`);
}

/**
 * The drill, after the alarm's own verdict, never failing the job: a drill
 * that cannot post says so in the log and the step summary and returns
 * null, and the alarm exits with the code its verdict earned (the publish
 * job runs only when the first job succeeded).
 */
export async function drillSafely(
	tracker: IssueTracker,
	runUrl: string | null,
	log: (line: string) => void = (line) => console.error(line),
	summary: (text: string) => Promise<void> | void = (text) => toStepSummary(text),
): Promise<number | null> {
	try {
		return await postDrill(tracker, runUrl);
	} catch (error) {
		const words = clipText(error instanceof Error ? error.message : String(error), 500);
		log(`the drill's comment could not be posted: ${words}`);
		await summary(`### The alarm's drill\n\nThe drill's comment could not be posted: ${words}\n`);
		return null;
	}
}

export interface AlarmTextOptions {
	stale: readonly StaleSeries[];
	now: Date;
	copyFailed: boolean;
	runUrlBase?: string;
	prices?: StalePrices | null;
	pricesWatched?: boolean;
	/** Whether the last post said the price files were stale. */
	pricesWereStale?: boolean;
	/** What the check of the API bucket reported (checkInChild); null or absent when it was not asked. */
	api?: ApiReport | null;
	/** Whether the last post raised the API bucket. */
	apiWasRaised?: boolean;
	/** The most characters the text may have: MAX_BODY_CHARS less the issue's marker line, unless given. */
	budget?: number;
	/** The run whose log lists every stale Series, said when the list is cut; null: not known. */
	fullListAt?: string | null;
}

/**
 * GitHub refuses an issue or comment body over 65,536 characters, and the
 * whole post with it. Every body the alarm posts is built under this, the
 * hidden state marker included (alarmText, and the drill's few lines).
 */
export const MAX_BODY_CHARS = 60_000;
/** What alarmText may take: the issue's body is the marker line and the text. */
export const TEXT_BUDGET = MAX_BODY_CHARS - ALARM_MARKER.length - 1;

/**
 * The text posted: the summary, the stale Series, each with its newest Run
 * and how old it is, the price files if stale, the API bucket if raised, and
 * the state marker. Under its budget: when the Series lines do not all fit,
 * as many as fit are listed, in their sorted order, then one line saying how
 * many more there are, that the run's log lists them all and its step
 * summary as many as its size limit holds.
 * Everything else is always there.
 */
export function alarmText(options: AlarmTextOptions): string {
	const { stale, now, copyFailed } = options;
	const runUrlBase = options.runUrlBase ?? RUNS_REPOSITORY_BLOB_URL;
	const prices = options.prices ?? null;
	const pricesWatched = options.pricesWatched ?? false;
	const pricesWereStale = options.pricesWereStale ?? false;
	const api = options.api ?? null;
	const apiWasRaised = options.apiWasRaised ?? false;
	const apiState = api?.state ?? null;
	// Said only once the bucket is read, or when it was raised before and no longer is.
	const apiWatched = api !== null && (api.watched || apiWasRaised);
	const hours = (startedAt: string): string => ((now.getTime() - Date.parse(startedAt)) / 3_600_000).toFixed(1);
	const lines = stale
		.slice()
		.sort((a, b) => compareText(describeSeries(a), describeSeries(b)))
		.map((series) =>
			series.newest === null
				? `- \`${describeSeries(series)}\`: no Run at all`
				: `- \`${describeSeries(series)}\`: newest Run [${series.newest.id}](${runUrlBase}${series.newest.path}) started ${series.newest.startedAt}, ${hours(series.newest.startedAt)} hours ago`,
		);
	const well = ["every watched Series has had a Run in the last 48 hours again"];
	if (pricesWatched) well.push("the newest price file is no more than 48 hours old");
	if (apiWatched && api !== null) well.push(api.well);
	const summary =
		stale.length > 0
			? `Checked at ${now.toISOString()}: ${stale.length} watched Series ${stale.length === 1 ? "has" : "have"} had no Run for more than 48 hours.`
			: prices !== null || apiState !== null
				? `Checked at ${now.toISOString()}: every watched Series has had a Run in the last 48 hours.`
				: `Checked at ${now.toISOString()}: ${well.length === 1 ? well[0] : `${well.slice(0, -1).join(", ")}, and ${well.at(-1)}`}.`;
	const pricesLine =
		prices === null
			? pricesWereStale && (stale.length > 0 || apiState !== null)
				? ["", "The newest price file is no more than 48 hours old again."]
				: []
			: prices.newest === null
				? [
						"",
						`**No price file.** The Runs repository holds no price file at all, and the prices workflow has existed since ${prices.since}, more than 48 hours. Look at the prices workflow.`,
					]
				: [
						"",
						`**No new price file for more than 48 hours.** The newest, [${prices.newest.path}](${runUrlBase}${prices.newest.path}), was fetched at ${prices.newest.fetchedAt}, ${hours(prices.newest.fetchedAt)} hours ago. Look at the prices workflow.`,
					];
	const apiLine = api !== null && apiState !== null ? ["", api.raised] : apiWasRaised && api !== null && (stale.length > 0 || prices !== null) ? ["", api.again] : [];
	const head = [...(copyFailed ? [COPY_FAILED, ""] : []), summary];
	const tail = [
		...pricesLine,
		...apiLine,
		"",
		"A watched Series is one `schedule.json` runs on one of its targets, the instance types and zone the stage launches. Written by `scripts/alarm.ts`, which writes again only when the stale Series, whether the copy job is failing, whether the price files are stale, or what it raises of the API bucket, change.",
		`${STATE_MARKER}${JSON.stringify(alarmState(stale, copyFailed, prices, apiState))} -->`,
	];
	const where = options.fullListAt ? `[the run that wrote this](${options.fullListAt})` : "the run that wrote this";
	const more = (count: number): string =>
		`- … and ${count} more watched Series not shown, to keep this post under GitHub's limit: the log of ${where} lists every one, and its step summary lists them up to its size limit.`;
	const assemble = (shown: readonly string[], hidden: number): string => [...head, ...(shown.length + hidden > 0 ? ["", ...shown, ...(hidden > 0 ? [more(hidden)] : [])] : []), ...tail].join("\n");
	const budget = options.budget ?? TEXT_BUDGET;
	const whole = assemble(lines, 0);
	if (whole.length <= budget) return whole;
	// As many lines as fit beside the line saying how many more; that line, written for all of them, is the longest it can be.
	let size = assemble([], lines.length).length;
	let shown = 0;
	while (shown < lines.length && size + (lines[shown] as string).length + 1 <= budget) size += (lines[shown++] as string).length + 1;
	return assemble(lines.slice(0, shown), lines.length - shown);
}

/** The complete list of stale Series, for the step summary, under its own limit of 1 MiB (cut, with a count, at STEP_SUMMARY_LIST_BYTES). */
export const STEP_SUMMARY_LIST_BYTES = 900_000;
export function staleList(stale: readonly StaleSeries[], now: Date, runUrlBase = RUNS_REPOSITORY_BLOB_URL): string {
	const lines = stale
		.map((series) => `- \`${describeSeries(series)}\`: ${series.newest === null ? "no Run at all" : `newest Run [${series.newest.id}](${runUrlBase}${series.newest.path}) started ${series.newest.startedAt}, ${((now.getTime() - Date.parse(series.newest.startedAt)) / 3_600_000).toFixed(1)} hours ago`}`)
		.sort(compareText);
	const out = [`### Stale watched Series (${stale.length})`, ""];
	let bytes = Buffer.byteLength(out.join("\n"));
	for (const [index, line] of lines.entries()) {
		if (bytes + Buffer.byteLength(line) + 200 > STEP_SUMMARY_LIST_BYTES) {
			out.push(`- … and ${lines.length - index} more: the log lists every one.`);
			break;
		}
		out.push(line);
		bytes += Buffer.byteLength(line) + 1;
	}
	return `${out.join("\n")}\n`;
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

/** What a pass found: the stale Series, the price files if stale, and what it raised of the API bucket (apiAlarmState), or null. */
interface Found {
	stale: StaleSeries[];
	prices: StalePrices | null;
	api: string | null;
}

export type AlarmOutcome =
	| ({ action: "none" } & Found)
	| ({ action: "opened"; issue: number } & Found)
	| ({ action: "commented"; issue: number } & Found)
	| ({ action: "unchanged"; issue: number } & Found);

const sameState = (a: AlarmState, b: AlarmState): boolean =>
	a.copy_failed === b.copy_failed &&
	(a.stale_prices ?? null) === (b.stale_prices ?? null) &&
	(a.stale_api ?? null) === (b.stale_api ?? null) &&
	a.stale_count === b.stale_count &&
	a.stale_hash === b.stale_hash;

/** Posts through `tracker`, refusing a body GitHub would refuse: by construction none is, so this is a loud failure, never a cut. */
function guarded(tracker: IssueTracker): IssueTracker {
	const check = (body: string): void => {
		if (body.length > MAX_BODY_CHARS) throw new Error(`an alarm post of ${body.length} characters, over MAX_BODY_CHARS (${MAX_BODY_CHARS}): not posted`);
	};
	return {
		findOpen: (marker) => tracker.findOpen(marker),
		open: (title, body) => {
			check(body);
			return tracker.open(title, body);
		},
		comment: (issue, body) => {
			check(body);
			return tracker.comment(issue, body);
		},
	};
}

/** One pass of the alarm. */
export async function runAlarm(options: {
	schedule: Schedule;
	runs: readonly RunFile[];
	now: Date;
	/** When the schedule last changed: a Series that has never had a Run is not stale until 48 hours after. */
	scheduleChangedAt: Date;
	/** Whether this pass's copy job failed, so the Runs repository may be behind the bucket. */
	copyFailed: boolean;
	tracker: IssueTracker;
	runUrlBase?: string;
	/** The newest price file of the Runs repository, or null when it has none. */
	newestPrices?: NewestPriceFile | null;
	/** When the prices workflow first existed: no price file is not stale until 48 hours after. Null or absent: not known to exist. */
	pricesSince?: Date | null;
	/** What the check of the API bucket reported (checkInChild): strings only. Null or absent when it was not asked, and then nothing is said of it. */
	api?: ApiReport | null;
	/** The run whose log lists every stale Series, linked when the post cannot list them all. */
	fullListAt?: string | null;
}): Promise<AlarmOutcome> {
	const tracker = guarded(options.tracker);
	const stale = staleSeries(watchedSeries(options.schedule), options.runs, options.now, options.scheduleChangedAt);
	const newestPrices = options.newestPrices ?? null;
	const pricesSince = options.pricesSince ?? null;
	const prices = stalePrices(newestPrices, options.now, pricesSince);
	const pricesWatched = newestPrices !== null || pricesSince !== null;
	const api = options.api ?? null;
	const apiState = api?.state ?? null;
	const found: Found = { stale, prices, api: apiState };
	const open = await tracker.findOpen(ALARM_MARKER);
	const last = open === null ? null : stateOf(open.lastPost);
	const text = alarmText({
		stale,
		now: options.now,
		copyFailed: options.copyFailed,
		runUrlBase: options.runUrlBase,
		prices,
		pricesWatched,
		pricesWereStale: last?.stale_prices !== undefined,
		api,
		apiWasRaised: last?.stale_api !== undefined,
		fullListAt: options.fullListAt ?? null,
	});
	const allWell = stale.length === 0 && prices === null && apiState === null;
	if (open === null) {
		if (allWell) return { action: "none", ...found };
		const issue = await tracker.open(ALARM_TITLE, `${ALARM_MARKER}\n${text}`);
		return { action: "opened", issue, ...found };
	}
	if (last !== null && sameState(last, alarmState(stale, options.copyFailed, prices, apiState))) return { action: "unchanged", issue: open.number, ...found };
	// Nothing to say on an issue whose last word was already that all is well, if only the copy changed.
	if (last === null && allWell) return { action: "unchanged", issue: open.number, ...found };
	await tracker.comment(open.number, text);
	return { action: "commented", issue: open.number, ...found };
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * GitHub's REST API, with a token that may write issues, at GITHUB_API_URL
 * (which Actions sets) or api.github.com. A call GitHub refuses (a 422 for a
 * body too long, say) throws, naming the answer; nothing is sent again.
 */
export class GitHubIssues implements IssueTracker {
	constructor(
		private readonly repository: string,
		private readonly token: string,
		private readonly fetcher: Fetch = fetch,
		private readonly apiBase: string = process.env.GITHUB_API_URL || "https://api.github.com",
	) {}

	private async call(method: string, path: string, body?: unknown): Promise<unknown> {
		const response = await this.fetcher(`${this.apiBase}/repos/${this.repository}${path}`, {
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
			"schedule-changed-at": { type: "string" },
			copy: { type: "string" },
			"prices-since": { type: "string" },
			"api-bucket": { type: "string" },
			drill: { type: "string" },
			"api-endpoint": { type: "string" },
			"dry-run": { type: "boolean" },
		},
	});
	if (!values.runs || (values.copy !== "succeeded" && values.copy !== "failed") || values["schedule-changed-at"] === undefined) {
		console.error(
			"usage: bun scripts/alarm.ts --runs DIR --copy succeeded|failed --schedule-changed-at ISO-8601 [--prices-since ISO-8601] [--api-bucket NAME]\n" +
				"         [--drill yes|no] [--now ISO-8601] [--schedule FILE] [--dry-run] [--api-endpoint URL]\n" +
				'  --schedule-changed-at: when the schedule last changed, such as "$(git log -1 --first-parent --format=%cI -- schedule.json)"\n' +
				'  --prices-since: when the prices workflow first existed, such as "$(git log --first-parent --reverse --format=%cI -- .github/workflows/prices.yml | sed -n 1p)"\n' +
				"  --api-bucket: the API bucket, as API_BUCKET names it; empty or absent, it is not read\n" +
				"  --drill yes: after the alarm's pass, post one drill comment on the alarm issue",
		);
		process.exit(2);
	}
	const now = values.now === undefined ? new Date() : new Date(values.now);
	if (Number.isNaN(now.getTime())) throw new Error(`--now ${values.now} is not a time`);
	const scheduleChangedAt = new Date(values["schedule-changed-at"]);
	if (values["schedule-changed-at"] === "" || Number.isNaN(scheduleChangedAt.getTime())) {
		throw new Error(`--schedule-changed-at ${JSON.stringify(values["schedule-changed-at"])} is not a time`);
	}
	// Empty when git finds no commit of the prices workflow: then it is not known to exist.
	const pricesSince = values["prices-since"] === undefined || values["prices-since"] === "" ? null : new Date(values["prices-since"]);
	if (pricesSince !== null && Number.isNaN(pricesSince.getTime())) throw new Error(`--prices-since ${JSON.stringify(values["prices-since"])} is not a time`);
	const schedulePath = values.schedule ?? join(resolve(import.meta.dir, ".."), "schedule.json");
	const schedule = parseSchedule(JSON.parse(readFileSync(schedulePath, "utf8")), schedulePath);

	let tracker: IssueTracker;
	if (values["dry-run"]) tracker = new DryRun();
	else {
		const repository = process.env.GITHUB_REPOSITORY;
		const token = process.env.GITHUB_TOKEN;
		if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN must be set, or pass --dry-run");
		tracker = new GitHubIssues(repository, token);
	}
	// The check of the API bucket, whole, in a child killed after CHECK_BUDGET_MS: started before the Runs repository
	// is read, so the wait overlaps that work, and awaited before anything is posted. It never throws.
	const endpoint = values["api-endpoint"];
	const bucket = values["api-bucket"] ?? "";
	const checking = checkInChild([
		process.execPath,
		join(import.meta.dir, "check-api-publishing.ts"),
		"--bucket",
		bucket,
		"--now",
		now.toISOString(),
		"--public-api-state",
		PUBLIC_API.state,
		...(endpoint === undefined ? [] : ["--endpoint", endpoint]),
	]);
	const runs = readRunFiles(values.runs);
	const copyFailed = values.copy === "failed";
	const newestPrices = newestPriceFile(values.runs);
	const api = reportOf(await checking, bucket, now, PUBLIC_API.state);
	console.log(`the API bucket: ${api.summary}`);
	// This run's page: the repository's fixed address and the run id, which must be a number; nothing else from the environment.
	const runId = process.env.GITHUB_RUN_ID ?? "";
	const runUrl = /^[1-9][0-9]{0,19}$/.test(runId) ? `${ACTIONS_RUN_URL}${runId}` : null;
	const outcome = await runAlarm({ schedule, runs, now, scheduleChangedAt, copyFailed, tracker, newestPrices, pricesSince, api, fullListAt: runUrl });
	const watched = watchedSeries(schedule);
	// Those with no Run at all, whatever the schedule's age.
	const neverRun = staleSeries(watched, runs, now, new Date(0)).filter((series) => series.newest === null).length;
	if (copyFailed) console.log("the copy job failed on this pass: the Runs repository may be behind the bucket");
	// Every stale Series, in the log and the step summary, which the issue points to when it cannot list them all.
	for (const series of outcome.stale) console.log(`stale: ${describeSeries(series)} (newest ${series.newest?.startedAt ?? "none"})`);
	if (outcome.stale.length > 0) await toStepSummary(staleList(outcome.stale, now));
	if (values.drill === "yes") {
		const issue = await drillSafely(tracker, runUrl);
		if (issue !== null && !values["dry-run"]) console.log(`drill: posted on issue #${issue}`);
	}
	if (neverRun > 0 && now.getTime() - scheduleChangedAt.getTime() <= MAX_AGE_MS) {
		console.log(
			`${neverRun} watched Series have never had a Run; schedule.json changed at ${scheduleChangedAt.toISOString()}, so they are stale only after ${new Date(scheduleChangedAt.getTime() + MAX_AGE_MS).toISOString()}`,
		);
	}
	console.log(`${now.toISOString()}: ${outcome.stale.length} of ${watched.length} watched Series stale`);
	if (newestPrices !== null) console.log(`newest price file: ${newestPrices.path}, fetched at ${newestPrices.fetchedAt}${outcome.prices === null ? "" : ", stale"}`);
	else if (pricesSince === null) console.log("no price file, and the prices workflow is not known to exist: not watched");
	else console.log(`no price file; the prices workflow has existed since ${pricesSince.toISOString()}${outcome.prices === null ? ", so it is not stale yet" : ", stale"}`);
	if (outcome.action !== "none" && !values["dry-run"]) {
		console.log(outcome.action === "unchanged" ? `nothing changed since the last post on issue #${outcome.issue}` : `${outcome.action} issue #${outcome.issue}`);
	}
}

if (import.meta.main) {
	// Exits explicitly with the verdict's code: a write to the step summary left waiting (toStepSummary) cannot keep the alarm alive.
	main().then(
		() => process.exit(0),
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		},
	);
}
