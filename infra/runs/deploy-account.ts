/**
 * Keeps SST on the account infra/runs/stages.ts names for a -runs stage, or
 * stops it.
 *
 * stages.ts names the account by a profile of the AWS CLI, which app()
 * returns to SST. SST 4.17.0 does not always use it. What it does, read in
 * its source (pkg/project/provider/aws.go, pkg/project/run.go,
 * cmd/sst/cli/cli.go and project.go) and in the SDKs it uses (the AWS SDK for
 * Go v2, config 1.27.11, in SST itself and, through aws-sdk-go-base
 * v2.0.0-beta.70, in Pulumi's AWS provider 7.20.0):
 *
 *   - SST's own requests (its bootstrap, its state, the stage's passphrase)
 *     use the profile app() returns, unless AWS_PROFILE is set and not empty,
 *     which takes its place, or SST_AWS_NO_PROFILE is set, which drops it and
 *     leaves AWS_PROFILE, keys in the environment, or whatever the SDK finds
 *     next. Given a profile, the SDK ignores keys in the environment.
 *   - The provider that makes the stage's resources, a process of its own,
 *     is given no profile in its configuration: SST takes it out, and puts
 *     AWS_PROFILE, set to its own profile, in the provider's environment,
 *     beside everything else in SST's. With no profile configured, the
 *     provider's SDK takes keys from the environment first (AWS_ACCESS_KEY_ID
 *     or AWS_ACCESS_KEY, with AWS_SECRET_ACCESS_KEY or AWS_SECRET_KEY), then
 *     a web identity (AWS_WEB_IDENTITY_TOKEN_FILE), and AWS_PROFILE only after
 *     them. So keys left in a shell, as `eval "$(aws configure
 *     export-credentials ...)"` leaves them, send the resources to their
 *     account while SST keeps the stage's state in the profile's.
 *   - SST reads the .env of the directory it runs in, and .env.<stage> beside
 *     sst.config.ts, into its environment before it calls app(); and the .env
 *     beside sst.config.ts after app(), before its first request (the same
 *     file, unless SST runs in a subdirectory).
 *
 * Two layers:
 *
 *   1. refuseForeignCredentials(), which sst.config.ts's app() runs for every
 *      -runs stage and every command (deploy, diff, dev, remove and the
 *      rest), before SST makes any request: it refuses an AWS_PROFILE other
 *      than the stage's profile, SST_AWS_NO_PROFILE, keys or a web identity
 *      in the environment, and the same in the .env beside sst.config.ts
 *      (found as SST finds sst.config.ts without --config: upwards from the
 *      directory it runs in).
 *   2. confirmDeployAccount(), which runsStack() runs before it declares
 *      anything: the account the provider acts in (aws.getCallerIdentity) must
 *      be the account the AWS CLI reaches with the stage's profile (`aws sts
 *      get-caller-identity --profile`, which no environment variable
 *      overrides). It catches what the first layer misses, but only for the
 *      commands that run the program (deploy, diff, dev, refresh; not
 *      remove), and only after SST's own requests.
 *
 * Neither writes an account ID anywhere: both are read when SST runs.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stageAccount, stageProfile } from "./stages";

export type Environment = Record<string, string | undefined>;

const KEYS_FIRST = "keys in the environment come before any profile for the provider that makes the stage's resources";

/** Variables that, set and not empty, send SST or the provider to an account of their own choosing; and why. */
export const FOREIGN_CREDENTIALS: Readonly<Record<string, string>> = {
	SST_AWS_NO_PROFILE: "SST drops the stage's profile",
	AWS_ACCESS_KEY_ID: KEYS_FIRST,
	AWS_ACCESS_KEY: KEYS_FIRST,
	AWS_SECRET_ACCESS_KEY: KEYS_FIRST,
	AWS_SECRET_KEY: KEYS_FIRST,
	AWS_SESSION_TOKEN: KEYS_FIRST,
	AWS_WEB_IDENTITY_TOKEN_FILE: "a web identity comes before any profile for the provider that makes the stage's resources",
};

/** The .env SST loads beside sst.config.ts, and its text. */
export interface DotEnv {
	path: string;
	text: string;
}

/**
 * The .env beside sst.config.ts, found as SST finds sst.config.ts: in the
 * first directory, from `from` upwards, that holds one. Null when there is
 * no such file.
 */
export function projectDotEnv(from: string): DotEnv | null {
	for (let directory = from; ; directory = dirname(directory)) {
		if (existsSync(join(directory, "sst.config.ts"))) {
			const path = join(directory, ".env");
			return existsSync(path) ? { path, text: readFileSync(path, "utf8") } : null;
		}
		if (dirname(directory) === directory) return null;
	}
}

/**
 * The variables a .env file sets, read as SST's loader (godotenv) reads the
 * lines that matter here: NAME=value or NAME: value, after an optional
 * `export`; a value in quotes is what is between them, any other value ends
 * at " #".
 */
export function dotEnvVariables(text: string): Map<string, string> {
	const variables = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*[=:]\s*(.*)$/.exec(line);
		if (match === null) continue;
		const [, name, raw] = match as unknown as [string, string, string];
		const quote = raw[0];
		let value: string;
		if (quote === '"' || quote === "'") {
			const end = raw.indexOf(quote, 1);
			value = end === -1 ? raw.slice(1) : raw.slice(1, end);
		} else {
			value = raw.replace(/\s+#.*$/, "").trim();
		}
		variables.set(name, value);
	}
	return variables;
}

/** A variable that would send SST, or the provider that makes the stage's resources, to another account than the stage's. */
export interface ForeignCredential {
	name: string;
	/** The environment, or the path of the .env that sets it. */
	where: "environment" | string;
	problem: string;
}

function problemsIn(stage: string, variables: Map<string, string>, where: "environment" | string): ForeignCredential[] {
	const profile = stageProfile(stage);
	const prefix = where === "environment" ? "" : `${where} sets `;
	const found: ForeignCredential[] = [];
	const awsProfile = variables.get("AWS_PROFILE");
	if (awsProfile !== undefined && awsProfile !== "" && awsProfile !== profile) {
		found.push({ name: "AWS_PROFILE", where, problem: `${prefix}AWS_PROFILE=${awsProfile}: SST uses it in place of the stage's profile` });
	}
	for (const [name, why] of Object.entries(FOREIGN_CREDENTIALS)) {
		const value = variables.get(name);
		if (value !== undefined && value !== "") found.push({ name, where, problem: `${prefix}${name} (its value not shown): ${why}` });
	}
	return found;
}

/**
 * Every reason, in an environment and the .env beside sst.config.ts, that SST
 * could act on another account than the one stages.ts names for the stage.
 * An AWS_PROFILE that is the stage's own profile is no reason.
 */
export function foreignCredentials(stage: string, environment: Environment, dotEnv: DotEnv | null): ForeignCredential[] {
	const present = new Map(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
	return [...problemsIn(stage, present, "environment"), ...(dotEnv === null ? [] : problemsIn(stage, dotEnvVariables(dotEnv.text), dotEnv.path))];
}

/**
 * SST shows an error thrown by app() only in its log (.sst/log/sst.log, or
 * on the terminal with --print-logs); otherwise it prints "Unexpected error
 * occurred". So the refusal is also written to the terminal itself, when
 * there is one and the process's own stderr is not it, as under SST, which
 * captures app()'s output.
 */
export function tellTerminal(message: string): void {
	if (process.stderr.isTTY) return;
	try {
		writeFileSync("/dev/tty", `\n${message}\n\n`);
	} catch {
		// No terminal: the log has it.
	}
}

/**
 * Stops SST, before its first request to AWS, when foreignCredentials finds
 * anything, saying what to unset. sst.config.ts's app() calls it for every
 * -runs stage.
 */
export function refuseForeignCredentials(
	stage: string,
	environment: Environment = process.env,
	from: string = process.cwd(),
	tell: (message: string) => void = tellTerminal,
): void {
	const dotEnv = projectDotEnv(from);
	const found = foreignCredentials(stage, environment, dotEnv);
	if (found.length === 0) return;
	const inEnvironment = found.filter((item) => item.where === "environment").map((item) => item.name);
	const inDotEnv = found.filter((item) => item.where !== "environment").map((item) => item.name);
	const remedies = [
		...(inEnvironment.length === 0 ? [] : [`unset ${inEnvironment.join(" ")}`]),
		...(inDotEnv.length === 0 ? [] : [`take ${inDotEnv.join(", ")} out of ${dotEnv?.path}`]),
	];
	const message = [
		`SST stops here, before any request to AWS. The stage ${stage} deploys to the ${stageAccount(stage)} account, with the profile ${stageProfile(stage)} (infra/runs/stages.ts), and this would send SST, or the provider that makes the stage's resources, to another:`,
		...found.map((item) => `  ${item.problem}`),
		`Then ${remedies.join(", and ")}, and run the command again. The README's recipes name the profile on each command and export nothing.`,
	].join("\n");
	tell(message);
	throw new Error(message);
}

/** The account a profile reaches. */
export type ProfileAccount = (profile: string) => string;

/** The account the AWS CLI reaches with a profile: `aws sts get-caller-identity --profile`, which no environment variable overrides. */
export const profileAccountWithAwsCli: ProfileAccount = (profile) => {
	const done = spawnSync("aws", ["sts", "get-caller-identity", "--profile", profile, "--query", "Account", "--output", "text"], {
		encoding: "utf8",
		env: { ...process.env, AWS_PAGER: "" },
		timeout: 60_000,
	});
	if (done.status !== 0) {
		throw new Error(
			`aws sts get-caller-identity --profile ${profile} exited ${done.status ?? "without a status"}: ${(done.stderr || done.error?.message || "").trim() || "(no error output)"}` +
				` (if the login has expired: aws sso login --profile ${profile})`,
		);
	}
	const account = (done.stdout ?? "").trim();
	if (!/^\d{12}$/.test(account)) throw new Error(`aws sts get-caller-identity --profile ${profile} printed ${JSON.stringify(account)}, not an account ID`);
	return account;
};

/**
 * Stops the program, before it declares anything, unless the provider acts
 * in the account the stage's profile reaches. runsStack() calls it with
 * aws.getCallerIdentity()'s account.
 */
export function confirmDeployAccount(stage: string, providerAccount: string, profileAccount: ProfileAccount = profileAccountWithAwsCli): void {
	const profile = stageProfile(stage);
	const expected = profileAccount(profile);
	if (providerAccount === expected) return;
	throw new Error(
		[
			`The provider that makes the resources of ${stage} acts in the AWS account ${providerAccount}, and the stage's profile, ${profile} (infra/runs/stages.ts), reaches the account ${expected}.`,
			"Something in the environment chose the provider's credentials before the profile: keys (AWS_ACCESS_KEY_ID), a web identity (AWS_WEB_IDENTITY_TOKEN_FILE), or another source the provider's SDK reads. Unset it and run the command again.",
			"Nothing was declared, so the provider made and changed nothing.",
		].join("\n"),
	);
}
