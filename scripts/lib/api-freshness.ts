/**
 * Whether the data API is still being published (ADR-0032): the age of the
 * API bucket's table of contents, v1/index.json, and nothing else. The alarm
 * (scripts/alarm.ts) asks, in the runs workflow's first job, through a child
 * process (scripts/check-api-publishing.ts) that it kills after
 * CHECK_BUDGET_MS, with that job's role, which may list the bucket and read
 * its v1/* and is given nothing more for this.
 *
 * The evidence is that object's Last-Modified. S3 sets it, from its own
 * clock, as the object is written, and no writer can; an upload writes
 * v1/index.json only as its last act, after every phase (in its last phase
 * when it changed, otherwise as the stamp), so it moves on every upload of a
 * new run that succeeds and on nothing else the workflow does. The run its
 * metadata records is named in the alarm's words as a lead and decides
 * nothing: an upload by hand can record any number.
 *
 * The rule: raised when v1/index.json was last written more than
 * MAX_PUBLISH_AGE_MS before the check runs, clear otherwise. Its inputs are
 * Last-Modified and the current time, so a re-run, a run started by hand
 * and a late run all judge alike. Scheduled runs are at most 6 hours apart,
 * so after one failed publish the bucket is at most 12 hours old when the
 * next run's alarm looks, plus that run's lateness; 14 hours leaves two hours
 * for lateness. Publishing that has stopped is raised by the first alarm that
 * runs once the bucket is 14 hours old: at most about 20 hours after the last
 * publish. Not promised: two failed runs either side of the short gap from
 * 22:40 to 00:00 can pass unnoticed when the next publish succeeds, since by
 * then publishing has recovered.
 */

import { clipText, S3Refused, STAMP_KEY, type WrittenAt } from "./api-upload";

/** The age of v1/index.json past which the alarm is raised: 14 hours (README, "The alarm", "The data API's publishing"). */
export const MAX_PUBLISH_AGE_MS = 14 * 3_600_000;

/** One try of the read; the whole check, in its child, is killed after CHECK_BUDGET_MS (scripts/alarm.ts). */
export const ATTEMPT_MS = 4_000;
/** The waits before the second and third tries, after a 5xx, no answer, or a try that ran out of time: three tries take at most 4 + 1 + 4 + 2 + 4 = 15 s. */
export const RETRY_WAITS_MS: readonly number[] = [1_000, 2_000];

/** The bucket's side, as S3ApiStore gives it. */
export interface PublishedReader {
	readonly name: string;
	/** Null when there is no such key; throws S3Refused for any answer but the object or NoSuchKey. Gives up when `signal` aborts. */
	lastWritten(key: string, signal?: AbortSignal): Promise<WrittenAt | null>;
}

/** What the read found. */
export type ApiBucketCheck =
	/** API_BUCKET is unset: nothing to read, and the publish job is skipped. */
	| { kind: "unset" }
	/** v1/index.json was last written at lastModified, recording run. */
	| { kind: "published"; bucket: string; lastModified: string; run: number | null }
	/** The bucket holds no v1/index.json: no publish has ever finished there. */
	| { kind: "empty"; bucket: string }
	/** It could not be read: code is the status and S3's code, or NoAnswer, Timeout or NoCredentials; reason what was answered. */
	| { kind: "unreadable"; bucket: string; code: string; reason: string; attempts: number };

export interface ReadOptions {
	/** ATTEMPT_MS and RETRY_WAITS_MS unless given (tests give smaller). */
	attemptMs?: number;
	waitsMs?: readonly number[];
	sleep?: (ms: number) => Promise<void>;
}

const transient = (error: S3Refused): boolean => error.code === "NoAnswer" || error.code === "Timeout" || (error.status !== null && error.status >= 500);

/**
 * One GET of v1/index.json, tried again after a 5xx, no answer, or a try
 * that ran out of time. Never throws: a bucket that cannot be read is a
 * finding. A null reader is API_BUCKET unset.
 */
export async function checkApiBucket(reader: PublishedReader | null, options: ReadOptions = {}): Promise<ApiBucketCheck> {
	if (reader === null) return { kind: "unset" };
	const waits = options.waitsMs ?? RETRY_WAITS_MS;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	for (let tries = 1; ; tries++) {
		try {
			const written = await reader.lastWritten(STAMP_KEY, AbortSignal.timeout(options.attemptMs ?? ATTEMPT_MS));
			if (written === null) return { kind: "empty", bucket: reader.name };
			return { kind: "published", bucket: reader.name, lastModified: written.lastModified.toISOString(), run: written.run };
		} catch (error) {
			const refused = error instanceof S3Refused ? error : new S3Refused(null, "Error", error instanceof Error ? error.message : String(error));
			const wait = waits[tries - 1];
			if (transient(refused) && wait !== undefined) {
				await sleep(wait);
				continue;
			}
			return { kind: "unreadable", bucket: reader.name, code: refused.status === null ? refused.code : `${refused.status} ${refused.code}`, reason: refused.message, attempts: tries };
		}
	}
}

/** How old v1/index.json is at now, in milliseconds. */
const ageMs = (lastModified: string, now: Date): number => now.getTime() - Date.parse(lastModified);
const hoursOld = (lastModified: string, now: Date): string => (ageMs(lastModified, now) / 3_600_000).toFixed(1);
const MAX_HOURS = MAX_PUBLISH_AGE_MS / 3_600_000;

/**
 * What the alarm raises of the API bucket, as the state its posts carry, or
 * null when nothing: older than MAX_PUBLISH_AGE_MS, with no table of
 * contents, unreadable, or unset while PUBLIC_API is not "off". A stale
 * bucket is named by when it was last written, so the state does not change
 * while it only grows older.
 */
export function apiAlarmState(check: ApiBucketCheck, now: Date, publicApiState: string): string | null {
	switch (check.kind) {
		case "unset":
			return publicApiState === "off" ? null : `unset while PUBLIC_API is ${publicApiState}`;
		case "published":
			return ageMs(check.lastModified, now) > MAX_PUBLISH_AGE_MS ? `stale since ${check.lastModified}` : null;
		case "empty":
			return "empty";
		case "unreadable":
			return `unreadable: ${check.code}`;
	}
}

/** Everything the alarm says of the API bucket: plain strings, so nothing in the post can throw because of it. */
export interface ApiReport {
	/** The state its posts carry (stale_api), or null when nothing is raised. */
	state: string | null;
	/** The paragraph raising it (empty when nothing is raised). */
	raised: string;
	/** The clause of an all-well summary: when it was last published, or that it is not watched. */
	well: string;
	/** The line said once, when it was raised and no longer is, while something else still is. */
	again: string;
	/** Whether the bucket was read (API_BUCKET set). */
	watched: boolean;
	/** The line for the log and the step's summary. */
	summary: string;
}

/** Where a run of this repository's workflows is shown: a run id the API bucket records is linked here. */
export const ACTIONS_RUN_URL = "https://github.com/smrdotgg/ledgermath/actions/runs/";
const byRun = (run: number | null): string => (run === null ? "" : `, by run [${run}](${ACTIONS_RUN_URL}${run})`);

/** The alarm's words for what the read found, at now. */
export function apiReport(check: ApiBucketCheck, now: Date, publicApiState: string): ApiReport {
	const state = apiAlarmState(check, now, publicApiState);
	const raisedNote = state === null ? "not raised" : "raised";
	switch (check.kind) {
		case "unset":
			return {
				state,
				raised: `**\`API_BUCKET\` is unset while \`PUBLIC_API\` is \`${publicApiState}\`.** The \`publish\` job is skipped, so nothing is published and readers are served the tree last published, and the API bucket is not watched. Set it again to the scheduled stage's \`apiBucket\` output (README, "The API bucket", "Setting it up").`,
				well: "`API_BUCKET` is unset, so the API bucket is not watched",
				again: "`API_BUCKET` is unset now, so the API bucket is no longer watched.",
				watched: false,
				summary:
					state === null
						? "API_BUCKET is unset: the API bucket is not read and nothing is raised for it (the publish job is skipped too)"
						: `API_BUCKET is unset while PUBLIC_API is ${publicApiState}: nothing is published, and that is raised`,
			};
		case "published": {
			const hours = hoursOld(check.lastModified, now);
			return {
				state,
				raised:
					`**The data API has not been published for ${hours} hours.** In \`${check.bucket}\`, \`${STAMP_KEY}\` was last written at ${check.lastModified}${byRun(check.run)}, more than ${MAX_HOURS} hours before this check, so the runs since have not published. ` +
					`Look at the \`publish\` job of the latest runs (Actions, \`runs\`): failed, skipped (its first job failed, or \`API_BUCKET\` was unset), cancelled, or not there at all. ` +
					`(Raised when the table of contents is more than ${MAX_HOURS} hours old: README, "The alarm".)`,
				well: `the data API was last published at ${check.lastModified}${byRun(check.run)}`,
				again: `The data API is published again: it was last published at ${check.lastModified}${byRun(check.run)}.`,
				watched: true,
				summary: `${check.bucket}: ${STAMP_KEY} last written at ${check.lastModified} (${hours} hours ago)${check.run === null ? ", which records no run" : `, by run ${check.run}`}; raised past ${MAX_HOURS} hours: ${raisedNote}`,
			};
		}
		case "empty":
			return {
				state,
				raised: `**The API bucket holds no table of contents.** \`API_BUCKET\` names \`${check.bucket}\`, which holds no \`${STAMP_KEY}\`, so no publish has ever finished there. If \`API_BUCKET\` was set since the last run, this is expected: this run's own \`publish\` job comes after this check, and the next run says here whether it published. Otherwise look at the latest runs' \`publish\` jobs, and at whether \`API_BUCKET\` is the scheduled stage's \`apiBucket\` output.`,
				well: "",
				again: "",
				watched: true,
				summary: `${check.bucket} holds no ${STAMP_KEY}: no publish has finished there; raised`,
			};
		case "unreadable":
			return {
				state,
				raised: `**The API bucket could not be read**, so whether the data API is being published cannot be told. ${clipText(check.reason)}${check.attempts > 1 ? ` (tried ${check.attempts} times)` : ""}. The \`publish\` job reads it with the same role and the same \`API_BUCKET\`. Look at whether \`API_BUCKET\` is the scheduled stage's \`apiBucket\` output, and at the role's \`RunsApiUploadPolicy\`.`,
				well: "",
				again: "",
				watched: true,
				summary: `${check.bucket} could not be read (${check.attempts} tr${check.attempts === 1 ? "y" : "ies"}): ${clipText(check.reason)}; raised`,
			};
	}
}

/** What the alarm says when the check gave no report: raised, like a bucket that cannot be read; the rest of the post does not depend on it. */
export function checkFailed(reason: string): ApiReport {
	const words = clipText(reason);
	return {
		state: "check failed",
		raised: `**The check of the API bucket failed**, so whether the data API is being published cannot be told: ${words}. This is a fault of the check, not a finding about the bucket; the rest of this post does not depend on it.`,
		well: "",
		again: "",
		watched: true,
		summary: `the check of the API bucket failed: ${words}; raised`,
	};
}

/** A report as the child prints it, one line of JSON; null when it is not one. Its texts are cut to a size an issue can take. */
export function parseReport(text: string): ApiReport | null {
	let value: unknown;
	try {
		value = JSON.parse(text.trim());
	} catch {
		return null;
	}
	const report = value as Partial<Record<keyof ApiReport, unknown>> | null;
	if (typeof report !== "object" || report === null) return null;
	const strings = ["raised", "well", "again", "summary"] as const;
	if (!(report.state === null || typeof report.state === "string") || typeof report.watched !== "boolean" || strings.some((key) => typeof report[key] !== "string")) return null;
	const cut = (text: string): string => (text.length <= 4_000 ? text : `${text.slice(0, 3_999)}…`);
	return {
		state: report.state === null ? null : clipText(report.state as string, 200),
		raised: cut(report.raised as string),
		well: cut(report.well as string),
		again: cut(report.again as string),
		watched: report.watched,
		summary: cut(report.summary as string),
	};
}
