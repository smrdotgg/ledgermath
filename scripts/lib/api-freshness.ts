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
 * What should be there: a publish after each scheduled run. A scheduled run
 * is missed when v1/index.json was last written before its scheduled time
 * and PUBLISH_GRACE_MS has passed since that time. The alarm raises once
 * MISSED_TO_RAISE runs are missed: the scheduled runs after the last publish
 * are consecutive, so that is two in a row, each late by an hour or more, or
 * failed. Counted by the schedule rather than by hours, because its gaps are
 * uneven (4 h 40 min from 18:00 to 22:40, 1 h 20 min from 22:40 to 00:00,
 * 6 h elsewhere): one failed run can leave the tree 12 hours old by the
 * time an alarm looks (the 06:00 run failing, seen by the 12:00 run's), and
 * two in a row can leave it no older (the 22:40 and 00:00 runs failing, seen
 * by the 06:00 run's), so no number of hours tells one from the other.
 *
 * The alarm runs before its own run's publish job, so it judges the runs
 * before: the grace keeps a run's own scheduled time from counting against
 * it unless the run started an hour late, and keeps a publish still going
 * from counting as missed.
 */

import { S3Refused, STAMP_KEY, type WrittenAt } from "./api-upload";

/**
 * The runs workflow's scheduled starts, UTC, as hh:mm: its crons
 * "40 22 * * *" and "0 *\/6 * * *" (tests/runs-workflow.test.ts holds the
 * two equal).
 */
export const RUNS_SCHEDULE_UTC: readonly string[] = ["00:00", "06:00", "12:00", "18:00", "22:40"];

/**
 * How long after its scheduled time a run's publish may take before the run
 * counts as missed. The runs of 2026-11-11 to 2026-11-21 started 2 to 5
 * minutes late and took about a minute, publish job included (run
 * 44852356733); an hour is ten times that and more, and short enough that
 * the 22:40 run, if it published nothing, counts at the 00:00 run's alarm.
 */
export const PUBLISH_GRACE_MS = 60 * 60_000;

/** Missed scheduled runs, in a row, that raise the alarm: one late or failed run raises nothing. */
export const MISSED_TO_RAISE = 2;

/** How often the GET is sent, in all, while it gets no answer or a 5xx, before the bucket is said to be unreadable. */
export const READ_ATTEMPTS = 3;

const DAY_MS = 86_400_000;

/** The bucket's side, as S3ApiStore gives it. */
export interface PublishedReader {
	readonly name: string;
	/** Null when there is no such key; throws S3Refused for any answer but the object or NoSuchKey. */
	lastWritten(key: string): Promise<WrittenAt | null>;
}

/** What the check found. */
export type ApiBucketCheck =
	/** API_BUCKET is unset: nothing to read, and the publish job is skipped. */
	| { kind: "unset" }
	/** v1/index.json was last written at lastModified; missed are the scheduled runs since that have had their hour (ISO times, oldest first). */
	| { kind: "published"; bucket: string; lastModified: string; run: number | null; missed: string[] }
	/** The bucket holds no v1/index.json: no publish has ever finished there. */
	| { kind: "empty"; bucket: string }
	/** It could not be read: code is the status and S3's code, or NoAnswer or NoCredentials; reason what was answered. */
	| { kind: "unreadable"; bucket: string; code: string; reason: string; attempts: number };

/** Every scheduled start s of the runs workflow with after < s <= through, oldest first. */
export function scheduledStarts(after: Date, through: Date): Date[] {
	const starts: Date[] = [];
	if (through.getTime() <= after.getTime()) return starts;
	const minutes = RUNS_SCHEDULE_UTC.map((time) => {
		const [hours, mins] = time.split(":").map(Number) as [number, number];
		return hours * 60 + mins;
	});
	for (let day = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate()); day <= through.getTime(); day += DAY_MS) {
		for (const minute of minutes) {
			const start = day + minute * 60_000;
			if (start > after.getTime() && start <= through.getTime()) starts.push(new Date(start));
		}
	}
	return starts;
}

/** The scheduled runs since lastWritten whose hour is up at now: none published, or the table of contents would be newer. */
export function missedRuns(lastWritten: Date, now: Date): Date[] {
	return scheduledStarts(lastWritten, new Date(now.getTime() - PUBLISH_GRACE_MS));
}

/** Whether a published bucket has missed enough scheduled runs in a row to raise the alarm. */
export function isStale(check: ApiBucketCheck): boolean {
	return check.kind === "published" && check.missed.length >= MISSED_TO_RAISE;
}

const transient = (error: S3Refused): boolean => error.code === "NoAnswer" || (error.status !== null && error.status >= 500);

/**
 * What the API bucket holds, judged at now: one GET of v1/index.json, tried
 * again after no answer or a 5xx, up to READ_ATTEMPTS in all. Never throws:
 * a bucket that cannot be read is a finding, kind "unreadable", so the job
 * that asks never fails because of the bucket. A null reader is API_BUCKET
 * unset.
 */
export async function checkApiBucket(
	reader: PublishedReader | null,
	now: Date,
	options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ApiBucketCheck> {
	if (reader === null) return { kind: "unset" };
	const attempts = options.attempts ?? READ_ATTEMPTS;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	for (let attempt = 1; ; attempt++) {
		try {
			const written = await reader.lastWritten(STAMP_KEY);
			if (written === null) return { kind: "empty", bucket: reader.name };
			return {
				kind: "published",
				bucket: reader.name,
				lastModified: written.lastModified.toISOString(),
				run: written.run,
				missed: missedRuns(written.lastModified, now).map((start) => start.toISOString()),
			};
		} catch (error) {
			const refused = error instanceof S3Refused ? error : new S3Refused(null, "Error", error instanceof Error ? error.message : String(error));
			if (transient(refused) && attempt < attempts) {
				await sleep(1_000 * 2 ** attempt);
				continue;
			}
			return { kind: "unreadable", bucket: reader.name, code: refused.status === null ? refused.code : `${refused.status} ${refused.code}`, reason: refused.message, attempts: attempt };
		}
	}
}
