/**
 * Keys for one AWS CLI profile, for a script that needs two accounts at once
 * (scripts/copy-bucket.ts reads the development account's bucket and writes
 * the production account's), so the environment's one set of keys will not
 * do. They come from
 *
 *     aws configure export-credentials --profile <name> --format process
 *
 * and are held in memory only: never written to a file, an environment, a
 * command line, a log line or an error message. What the command printed is
 * never shown, whatever its shape; a failure is reported by the command's own
 * error output, which holds no key, or by the length of what it printed.
 */

import { spawnSync } from "node:child_process";

import type { S3Credentials } from "./bucket";

/** Keys and when they expire, if they do. */
export interface ExportedCredentials extends S3Credentials {
	expiration: Date | null;
}

/** What running `aws configure export-credentials` gave. */
export interface CommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export type ExportCommand = (profile: string) => CommandResult;

/** Runs the aws CLI itself. */
export const exportWithAwsCli: ExportCommand = (profile) => {
	const done = spawnSync("aws", ["configure", "export-credentials", "--profile", profile, "--format", "process"], {
		encoding: "utf8",
		env: { ...process.env, AWS_PAGER: "" },
		timeout: 60_000,
	});
	return { status: done.status, stdout: done.stdout ?? "", stderr: done.stderr || done.error?.message || "" };
};

/** Reads the process-format JSON the command printed; throws, without showing it, when it is not keys. */
export function parseExportedCredentials(text: string, profile: string): ExportedCredentials {
	const refuse = (why: string): never => {
		throw new Error(
			`aws configure export-credentials --profile ${profile} printed ${Buffer.byteLength(text)} bytes that are not usable keys (${why}; not shown)`,
		);
	};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return refuse("not JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return refuse("not an object");
	const fields = value as Record<string, unknown>;
	const { AccessKeyId: accessKeyId, SecretAccessKey: secretAccessKey, SessionToken: sessionToken, Expiration: expiration } = fields;
	if (typeof accessKeyId !== "string" || accessKeyId === "") return refuse("no AccessKeyId");
	if (typeof secretAccessKey !== "string" || secretAccessKey === "") return refuse("no SecretAccessKey");
	if (sessionToken !== undefined && (typeof sessionToken !== "string" || sessionToken === "")) return refuse("a SessionToken that is not a string");
	let expires: Date | null = null;
	if (expiration !== undefined && expiration !== null) {
		expires = typeof expiration === "string" ? new Date(expiration) : new Date(Number.NaN);
		if (Number.isNaN(expires.getTime())) return refuse("an Expiration that is not a time");
	}
	return { accessKeyId, secretAccessKey, ...(sessionToken === undefined ? {} : { sessionToken }), expiration: expires };
}

export interface ProfileCredentialsOptions {
	/** How the keys are exported; the aws CLI by default. */
	exportCommand?: ExportCommand;
	/** Keys that expire sooner than this are exported again. */
	renewBeforeMs?: number;
	now?: () => number;
}

/**
 * A provider of a profile's keys: exported when first asked for, and again
 * whenever the keys held expire within renewBeforeMs (ten minutes). The
 * same object is returned until then, so a client made from it is reused.
 */
export function profileCredentials(profile: string, options: ProfileCredentialsOptions = {}): () => ExportedCredentials {
	const run = options.exportCommand ?? exportWithAwsCli;
	const renewBeforeMs = options.renewBeforeMs ?? 10 * 60 * 1000;
	const now = options.now ?? Date.now;
	let held: ExportedCredentials | undefined;
	let exportedAt = Number.NEGATIVE_INFINITY;
	return () => {
		const at = now();
		if (held !== undefined) {
			const left = held.expiration === null ? Number.POSITIVE_INFINITY : held.expiration.getTime() - at;
			// Not again within a minute of the last export while the keys still work: the
			// CLI may hand back the same keys until its own login is renewed.
			if (left > renewBeforeMs || (left > 0 && at - exportedAt < 60_000)) return held;
		}
		exportedAt = at;
		const done = run(profile);
		if (done.status !== 0) {
			throw new Error(
				`aws configure export-credentials --profile ${profile} exited ${done.status ?? "without a status"}: ${done.stderr.trim() || "(no error output)"}` +
					` (if the login has expired: aws sso login --profile ${profile})`,
			);
		}
		held = parseExportedCredentials(done.stdout, profile);
		return held;
	};
}
