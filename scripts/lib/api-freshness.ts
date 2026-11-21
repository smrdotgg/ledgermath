/**
 * Whether the data API is still being published (ADR-0032): the age of the
 * API bucket's table of contents, v1/index.json, and nothing else. The alarm
 * (scripts/alarm.ts) asks through a child process
 * (scripts/check-api-publishing.ts) that it kills after CHECK_BUDGET_MS,
 * with the first job's role, which may list the bucket and read its v1/*.
 *
 * The evidence is that object's Last-Modified. S3 sets it, from its own
 * clock, as the object is written, and no writer can; an upload writes
 * v1/index.json only as its last act, after every phase (in its last phase
 * when it changed, otherwise as the stamp), so it moves on every upload of a
 * new run that succeeds and on nothing else the workflow does.
 *
 * The rule: raised by the first check made more than MAX_PUBLISH_AGE_MS
 * after v1/index.json was last written, clear otherwise. Its inputs are
 * Last-Modified and the time of the check, so a re-run, a run started by
 * hand and a late run all judge alike. What that means for the schedule is
 * the README's ("The alarm", "The data API's publishing") and ADR-0032's.
 *
 * The child reports what it read as one of a closed set of results
 * (CheckResult), validated by parseResult, and the alarm renders fixed
 * sentences from it (apiReport): nothing the child or S3 says in words
 * reaches the issue. Their words go to the job's log.
 */

import { S3Refused, STAMP_KEY, type WrittenAt } from "./api-upload";

/** The age of v1/index.json past which a check raises the alarm: 14 hours. */
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

/**
 * What the child read, from a closed set: data only, never words. Its JSON
 * is what the child prints and parseResult accepts, field for field.
 */
export type CheckResult =
	/** API_BUCKET is unset: nothing was read. */
	| { kind: "unset" }
	/** v1/index.json was last written at last_modified (ISO 8601, as toISOString writes it), recording run. */
	| { kind: "published"; last_modified: string; run: number | null }
	/** The bucket holds no v1/index.json. */
	| { kind: "empty" }
	/** S3 refused the read: an answer of 300 to 499 other than NoSuchKey (403 refused, 404 no such bucket, 301 another Region). */
	| { kind: "refused"; status: number; attempts: number }
	/** No AWS credentials in the child's environment. */
	| { kind: "no-credentials" }
	/** S3 answered 500 to 599 on every try. */
	| { kind: "server-error"; status: number; attempts: number }
	/** No answer came, or not in time, on every try. */
	| { kind: "no-answer"; attempts: number }
	/** S3 answered 200 with no Last-Modified that is a date. */
	| { kind: "no-date" };

export interface ReadOptions {
	/** ATTEMPT_MS and RETRY_WAITS_MS unless given (tests give smaller). */
	attemptMs?: number;
	waitsMs?: readonly number[];
	sleep?: (ms: number) => Promise<void>;
	/** Told of what S3 said in words, for the job's log; never for the issue. */
	log?: (line: string) => void;
}

const transient = (error: S3Refused): boolean => error.code === "NoAnswer" || error.code === "Timeout" || (error.status !== null && error.status >= 500);

/** What an S3Refused is, as a result. */
function refusal(error: S3Refused, attempts: number): CheckResult {
	if (error.code === "NoCredentials") return { kind: "no-credentials" };
	if (error.code === "NoLastModified") return { kind: "no-date" };
	if (error.status === null) return { kind: "no-answer", attempts };
	if (error.status >= 500) return { kind: "server-error", status: error.status, attempts };
	return { kind: "refused", status: error.status, attempts };
}

/**
 * One GET of v1/index.json, tried again after a 5xx, no answer, or a try
 * that ran out of time. Never throws: a bucket that cannot be read is a
 * result. A null reader is API_BUCKET unset.
 */
export async function checkApiBucket(reader: PublishedReader | null, options: ReadOptions = {}): Promise<CheckResult> {
	if (reader === null) return { kind: "unset" };
	const waits = options.waitsMs ?? RETRY_WAITS_MS;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	for (let tries = 1; ; tries++) {
		try {
			const written = await reader.lastWritten(STAMP_KEY, AbortSignal.timeout(options.attemptMs ?? ATTEMPT_MS));
			if (written === null) return { kind: "empty" };
			return { kind: "published", last_modified: written.lastModified.toISOString(), run: written.run };
		} catch (error) {
			const refused = error instanceof S3Refused ? error : new S3Refused(null, "NoAnswer", error instanceof Error ? error.message : String(error));
			options.log?.(`try ${tries}: ${refused.message}`);
			const wait = waits[tries - 1];
			if (transient(refused) && wait !== undefined) {
				await sleep(wait);
				continue;
			}
			return refusal(refused, tries);
		}
	}
}

const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const isInteger = (value: unknown, low: number, high: number): value is number => Number.isSafeInteger(value) && (value as number) >= low && (value as number) <= high;

/**
 * A result as the child prints it, one line of JSON; null for anything else.
 * Every field is checked against its kind's closed form: a date as
 * toISOString writes it, a run a positive whole number, a status in its
 * range, and no field the kind does not have.
 */
export function parseResult(text: string): CheckResult | null {
	let value: unknown;
	try {
		value = JSON.parse(text.trim());
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const result = value as Record<string, unknown>;
	const only = (...keys: string[]): boolean => Object.keys(result).every((key) => key === "kind" || keys.includes(key)) && keys.every((key) => key in result);
	switch (result.kind) {
		case "unset":
		case "empty":
		case "no-credentials":
		case "no-date":
			return only() ? { kind: result.kind } : null;
		case "published": {
			const date = result.last_modified;
			const run = result.run;
			if (!only("last_modified", "run") || typeof date !== "string" || !ISO.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString() !== date) return null;
			if (run !== null && !isInteger(run, 1, Number.MAX_SAFE_INTEGER)) return null;
			return { kind: "published", last_modified: date, run };
		}
		case "refused":
			return only("status", "attempts") && isInteger(result.status, 300, 499) && isInteger(result.attempts, 1, 10) ? { kind: "refused", status: result.status, attempts: result.attempts } : null;
		case "server-error":
			return only("status", "attempts") && isInteger(result.status, 500, 599) && isInteger(result.attempts, 1, 10) ? { kind: "server-error", status: result.status, attempts: result.attempts } : null;
		case "no-answer":
			return only("attempts") && isInteger(result.attempts, 1, 10) ? { kind: "no-answer", attempts: result.attempts } : null;
		default:
			return null;
	}
}

/** Why the check gave no result, from a closed set. */
export type CheckFailure = { reason: "killed"; budgetMs: number } | { reason: "exited"; code: number } | { reason: "output" } | { reason: "start" };

/** Everything the alarm says of the API bucket: fixed sentences, rendered from data. */
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
const MAX_HOURS = MAX_PUBLISH_AGE_MS / 3_600_000;
const tries = (attempts: number): string => (attempts === 1 ? "" : `, on each of ${attempts} tries`);

/** What the alarm raises of the API bucket, as the state its posts carry, or null when nothing. A stale bucket is named by when it was last written, so the state stays the same while it only grows older. */
export function apiAlarmState(result: CheckResult, now: Date, publicApiState: string): string | null {
	switch (result.kind) {
		case "unset":
			return publicApiState === "off" ? null : `unset while PUBLIC_API is ${publicApiState}`;
		case "published":
			return now.getTime() - Date.parse(result.last_modified) > MAX_PUBLISH_AGE_MS ? `stale since ${result.last_modified}` : null;
		case "empty":
			return "empty";
		case "refused":
			return `unreadable: refused ${result.status}`;
		case "no-credentials":
			return "unreadable: no credentials";
		case "server-error":
			return `unreadable: server error ${result.status}`;
		case "no-answer":
			return "unreadable: no answer";
		case "no-date":
			return "unreadable: no date";
	}
}

/** The fixed sentence for a bucket that could not be read. */
function unreadableWords(result: Extract<CheckResult, { kind: "refused" | "no-credentials" | "server-error" | "no-answer" | "no-date" }>): string {
	switch (result.kind) {
		case "refused":
			return `S3 refused the read (HTTP ${result.status}${tries(result.attempts)})`;
		case "no-credentials":
			return "the job had no AWS credentials to read it with";
		case "server-error":
			return `S3 answered with a server error (HTTP ${result.status}${tries(result.attempts)})`;
		case "no-answer":
			return `S3 gave no answer in time${tries(result.attempts)}`;
		case "no-date":
			return "S3 answered without a date to judge by";
	}
}

/**
 * The alarm's words for a result, at now: fixed sentences, with nothing in
 * them but the bucket's name (API_BUCKET, which the alarm itself passed), a
 * date and numbers the result was validated to hold.
 */
export function apiReport(result: CheckResult, bucket: string, now: Date, publicApiState: string): ApiReport {
	const state = apiAlarmState(result, now, publicApiState);
	const where = `s3://${bucket}`;
	switch (result.kind) {
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
			const hours = ((now.getTime() - Date.parse(result.last_modified)) / 3_600_000).toFixed(1);
			return {
				state,
				raised:
					`**The data API has not been published for ${hours} hours.** In \`${where}\`, \`${STAMP_KEY}\` was last written at ${result.last_modified}${byRun(result.run)}, more than ${MAX_HOURS} hours before this check, so the runs since have not published. ` +
					`Look at the \`publish\` job of the latest runs (Actions, \`runs\`): failed, skipped (its first job failed, or \`API_BUCKET\` was unset), cancelled, or not there at all. ` +
					`(Raised by a check made more than ${MAX_HOURS} hours after the last publish: README, "The alarm".)`,
				well: `the data API was last published at ${result.last_modified}${byRun(result.run)}`,
				again: `The data API is published again: it was last published at ${result.last_modified}${byRun(result.run)}.`,
				watched: true,
				summary: `${where}: ${STAMP_KEY} last written at ${result.last_modified} (${hours} hours ago)${result.run === null ? ", which records no run" : `, by run ${result.run}`}; raised past ${MAX_HOURS} hours: ${state === null ? "not raised" : "raised"}`,
			};
		}
		case "empty":
			return {
				state,
				raised: `**The API bucket holds no table of contents.** \`API_BUCKET\` names \`${where}\`, which holds no \`${STAMP_KEY}\`, so no publish has ever finished there. If \`API_BUCKET\` was set since the last run, this is expected: this run's own \`publish\` job comes after this check, and the next run says here whether it published. Otherwise look at the latest runs' \`publish\` jobs, and at whether \`API_BUCKET\` is the scheduled stage's \`apiBucket\` output.`,
				well: "",
				again: "",
				watched: true,
				summary: `${where} holds no ${STAMP_KEY}: no publish has finished there; raised`,
			};
		default: {
			const words = unreadableWords(result);
			return {
				state,
				raised: `**The API bucket could not be read**: ${words}, so whether the data API is being published cannot be told. The \`publish\` job reads it with the same role and the same \`API_BUCKET\`. Look at whether \`API_BUCKET\` is the scheduled stage's \`apiBucket\` output, and at the role's \`RunsApiUploadPolicy\`; the run's log has what S3 said.`,
				well: "",
				again: "",
				watched: true,
				summary: `${where} could not be read: ${words}; raised`,
			};
		}
	}
}

/** What the alarm says when the check gave no result: raised, like a bucket that cannot be read; fixed words for each closed reason. */
export function checkFailed(failure: CheckFailure): ApiReport {
	const words =
		failure.reason === "killed"
			? `it gave no result within ${failure.budgetMs / 1_000} s and was stopped`
			: failure.reason === "exited"
				? `it exited with code ${failure.code}`
				: failure.reason === "output"
					? "its output was not understood"
					: "it could not be started";
	return {
		state: "check failed",
		raised: `**The check of the API bucket failed**: ${words}, so whether the data API is being published cannot be told. This is a fault of the check, not a finding about the bucket; the run's log has the details, and the rest of this post does not depend on it.`,
		well: "",
		again: "",
		watched: true,
		summary: `the check of the API bucket failed: ${words}; raised`,
	};
}
