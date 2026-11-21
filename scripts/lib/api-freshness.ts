/**
 * Whether the data API is still being published: what the API bucket holds,
 * against what the runs workflow's schedule says it should hold by now. The
 * alarm (scripts/alarm.ts) asks, in the runs workflow's first job, with that
 * job's role, which may list the bucket and read its v1/* and is given
 * nothing more for this (infra/runs/api-bucket.ts, apiUploadPolicy).
 *
 * Judged by the bucket, never by any job's conclusion, so that every way
 * publishing can stop shows the same: the publish job failed, was skipped
 * (the first job failed, or API_BUCKET was unset) or cancelled, never ran,
 * or its preflight refused the bucket. In each, the table of contents,
 * v1/index.json, is not written again.
 *
 * The evidence is that object's Last-Modified. S3 sets it, from its own
 * clock, as the object is written, and no writer can set it; and an upload
 * writes v1/index.json only as its last act, after every phase (in phase 5
 * when it changed, otherwise as the stamp), so it moves on every upload of a
 * new run that succeeded and on nothing else the workflow does. The two
 * other things there could lie: the run its metadata records
 * (x-amz-meta-ledgermath-run) is whatever the uploader passed, which can be
 * wrong (README, "A run recorded too high"), and turning it into a time
 * would take a call to GitHub; the tree's own newest_run_started_at says
 * when the newest Run started, which stands still when the boxes do, however
 * well publishing works. The run is said in the alarm's words, as a lead,
 * and decides nothing. Last-Modified moves without the workflow only when a
 * person writes the object with their own credentials (an upload by hand,
 * the copy-object of "A run recorded too high").
 *
 * What is counted: the scheduled slots (RUNS_SCHEDULE_UTC) that have elapsed
 * since the bucket was last written, among those the judging job may judge.
 * A job judges only slots whose publish should have finished before it
 * started (PUBLISH_GRACE_MS after the slot), and never its own slot, nor any
 * after it: its own publish comes after its alarm. MISSED_TO_RAISE such
 * slots raise the alarm. Any publish, a run started by hand included, is the
 * bucket being written, so the count starts again from it. Counted in slots
 * rather than hours, because the schedule's gaps are uneven (4 h 40 min from
 * 18:00 to 22:40, 1 h 20 min from 22:40 to 00:00, 6 h elsewhere): one failed
 * run can leave the tree 12 hours old by the time an alarm looks (the 06:00
 * run failing, seen by the 12:00 run's), and two in a row can leave it no
 * older (the 22:40 and 00:00 runs failing, seen by the 06:00 run's).
 *
 * The read is bounded: READ_BUDGET_MS in all, each try ATTEMPT_MS, the
 * alarm's own verdict coming after it.
 */

import { S3Refused, STAMP_KEY, type WrittenAt } from "./api-upload";

/**
 * The runs workflow's scheduled starts, UTC, as hh:mm: its crons
 * "40 22 * * *" and "0 *\/6 * * *" (tests/runs-workflow.test.ts holds the
 * two equal).
 */
export const RUNS_SCHEDULE_UTC: readonly string[] = ["00:00", "06:00", "12:00", "18:00", "22:40"];

/**
 * How long after its scheduled time a run's publish may take before a later
 * job counts the slot. The runs of 2026-11-11 to 2026-11-21 started 2 to 5
 * minutes late and took about a minute, publish job included (run
 * 44852356733); an hour is ten times that and more, and short enough that
 * the 22:40 slot is judged by the 00:00 run's job.
 */
export const PUBLISH_GRACE_MS = 60 * 60_000;

/** Elapsed slots since the bucket was last written that raise the alarm: one late or failed run raises nothing. */
export const MISSED_TO_RAISE = 2;

/**
 * The whole read of the bucket, waits included: well under a minute, so the
 * alarm's own verdict, which comes after it, is never held up long. A GET of
 * the table of contents takes a tenth of a second or so.
 */
export const READ_BUDGET_MS = 20_000;
/** One try of the read: fifty times what it takes. */
export const ATTEMPT_MS = 5_000;
/** The waits before the second and third tries, after a 5xx, no answer, or a try that ran out of time. Three tries take at most 5 + 1 + 5 + 2 + 5 = 18 s. */
export const RETRY_WAITS_MS: readonly number[] = [1_000, 2_000];

const DAY_MS = 86_400_000;

/** The bucket's side, as S3ApiStore gives it. */
export interface PublishedReader {
	readonly name: string;
	/** Null when there is no such key; throws S3Refused for any answer but the object or NoSuchKey. Gives up when `signal` aborts. */
	lastWritten(key: string, signal?: AbortSignal): Promise<WrittenAt | null>;
}

/** What the check found. */
export type ApiBucketCheck =
	/** API_BUCKET is unset: nothing to read, and the publish job is skipped. */
	| { kind: "unset" }
	/** v1/index.json was last written at lastModified; missed are the slots since that the job may judge (ISO times, oldest first). */
	| { kind: "published"; bucket: string; lastModified: string; run: number | null; missed: string[] }
	/** The bucket holds no v1/index.json: no publish has ever finished there. */
	| { kind: "empty"; bucket: string }
	/** It could not be read: code is the status and S3's code, or NoAnswer, Timeout or NoCredentials; reason what was answered. */
	| { kind: "unreadable"; bucket: string; code: string; reason: string; attempts: number };

/** The hh:mm a cron of the form the workflow uses gives, every day: minute and hour each N, N,M, * or *\/N; the other fields *. Throws for any other. */
export function cronTimes(cron: string): string[] {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5 || fields.slice(2).some((field) => field !== "*")) throw new Error(`${JSON.stringify(cron)}: not a daily cron of minute and hour`);
	const values = (field: string, max: number): number[] => {
		const every = /^\*(?:\/([1-9][0-9]*))?$/.exec(field);
		if (every !== null) return Array.from({ length: max + 1 }, (_, value) => value).filter((value) => value % Number(every[1] ?? 1) === 0);
		if (!/^[0-9]+(,[0-9]+)*$/.test(field)) throw new Error(`${JSON.stringify(cron)}: a field of no form this reads: ${field}`);
		const listed = field.split(",").map(Number);
		if (listed.some((value) => value > max)) throw new Error(`${JSON.stringify(cron)}: ${field} is out of range`);
		return listed;
	};
	const [minute, hour] = fields as [string, string];
	return values(hour, 23)
		.flatMap((h) => values(minute, 59).map((m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`))
		.sort();
}

const minutesOf = (time: string): number => {
	const [hours, minutes] = time.split(":").map(Number) as [number, number];
	return hours * 60 + minutes;
};

/** Every scheduled start s of the runs workflow with after < s <= through, oldest first. */
export function scheduledStarts(after: Date, through: Date): Date[] {
	const starts: Date[] = [];
	if (through.getTime() <= after.getTime()) return starts;
	const minutes = RUNS_SCHEDULE_UTC.map(minutesOf);
	for (let day = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate()); day <= through.getTime(); day += DAY_MS) {
		for (const minute of minutes) {
			const start = day + minute * 60_000;
			if (start > after.getTime() && start <= through.getTime()) starts.push(new Date(start));
		}
	}
	return starts;
}

/**
 * The slot a scheduled run belongs to: the latest time its cron gives at or
 * before its job started. Null for a run not started by the schedule (cron
 * empty: started by hand).
 */
export function ownSlot(cron: string, jobStartedAt: Date): Date | null {
	if (cron.trim() === "") return null;
	const times = cronTimes(cron).map(minutesOf);
	const today = Date.UTC(jobStartedAt.getUTCFullYear(), jobStartedAt.getUTCMonth(), jobStartedAt.getUTCDate());
	let own: number | null = null;
	for (const day of [today - DAY_MS, today]) {
		for (const minute of times) {
			const start = day + minute * 60_000;
			if (start <= jobStartedAt.getTime() && (own === null || start > own)) own = start;
		}
	}
	return own === null ? null : new Date(own);
}

/**
 * The latest slot a job may judge: one whose publish should have finished
 * before the job started (PUBLISH_GRACE_MS after it), and before the job's
 * own slot, whose publish comes after the job's alarm.
 */
export function judgedThrough(jobStartedAt: Date, own: Date | null): Date {
	const byGrace = jobStartedAt.getTime() - PUBLISH_GRACE_MS;
	return new Date(own === null ? byGrace : Math.min(byGrace, own.getTime() - 1));
}

/** The slots since lastWritten, up to `through` (judgedThrough): elapsed with no publish after them. */
export function missedRuns(lastWritten: Date, through: Date): Date[] {
	return scheduledStarts(lastWritten, through);
}

/** Whether a published bucket has missed enough slots to raise the alarm. */
export function isStale(check: ApiBucketCheck): boolean {
	return check.kind === "published" && check.missed.length >= MISSED_TO_RAISE;
}

const transient = (error: S3Refused): boolean => error.code === "NoAnswer" || error.code === "Timeout" || (error.status !== null && error.status >= 500);

export interface ReadOptions {
	/** READ_BUDGET_MS, ATTEMPT_MS and RETRY_WAITS_MS unless given (tests give smaller). */
	budgetMs?: number;
	attemptMs?: number;
	waitsMs?: readonly number[];
	sleep?: (ms: number) => Promise<void>;
}

/** One try, given up after `ms` whether or not the reader heeds the signal. */
async function attempt(reader: PublishedReader, ms: number): Promise<WrittenAt | null> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new S3Refused(null, "Timeout", `GET ${reader.name}/${STAMP_KEY}: no answer within ${ms} ms`));
		}, ms);
	});
	try {
		return await Promise.race([reader.lastWritten(STAMP_KEY, controller.signal), timedOut]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * What the API bucket holds, judged through `through` (judgedThrough): one
 * GET of v1/index.json, tried again after a 5xx, no answer, or a try that ran
 * out of time, within the budget. Never throws: a bucket that cannot be read
 * is a finding, kind "unreadable". A null reader is API_BUCKET unset.
 */
export async function checkApiBucket(reader: PublishedReader | null, through: Date, options: ReadOptions = {}): Promise<ApiBucketCheck> {
	if (reader === null) return { kind: "unset" };
	const budget = options.budgetMs ?? READ_BUDGET_MS;
	const tryMs = options.attemptMs ?? ATTEMPT_MS;
	const waits = options.waitsMs ?? RETRY_WAITS_MS;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	const deadline = Date.now() + budget;
	for (let tries = 1; ; tries++) {
		try {
			const written = await attempt(reader, Math.max(1, Math.min(tryMs, deadline - Date.now())));
			if (written === null) return { kind: "empty", bucket: reader.name };
			return {
				kind: "published",
				bucket: reader.name,
				lastModified: written.lastModified.toISOString(),
				run: written.run,
				missed: missedRuns(written.lastModified, through).map((start) => start.toISOString()),
			};
		} catch (error) {
			const refused = error instanceof S3Refused ? error : new S3Refused(null, "Error", error instanceof Error ? error.message : String(error));
			const wait = waits[tries - 1];
			// Another try only when it is worth one and there is time for it: its wait, and a tenth of a try.
			if (transient(refused) && wait !== undefined && deadline - Date.now() > wait + tryMs / 10) {
				await sleep(wait);
				continue;
			}
			return { kind: "unreadable", bucket: reader.name, code: refused.status === null ? refused.code : `${refused.status} ${refused.code}`, reason: refused.message, attempts: tries };
		}
	}
}
