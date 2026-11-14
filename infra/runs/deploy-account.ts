/**
 * Keeps SST on the account infra/runs/stages.ts names for a -runs stage, or
 * stops it.
 *
 * stages.ts names the account by a profile of the AWS CLI, which app()
 * returns to SST. SST 4.17.0 does not always use it. What it does, read in
 * its source (pkg/project/provider/aws.go, pkg/project/project.go,
 * pkg/project/run.go, pkg/js/js.go, cmd/sst/cli/cli.go and
 * cmd/sst/cli/project.go) and in the SDKs it uses (the AWS SDK for
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
 *   - SST loads the .env of the directory it runs in (godotenv.Load() in
 *     cmd/sst/cli/cli.go) and .env.<stage> beside the config it selected
 *     (godotenv.Overload, in Stage()) before it calls app(), so both are in
 *     the environment app() sees; and the .env beside that config after
 *     app(), before its first request (godotenv.Load, in InitProject in
 *     cmd/sst/cli/project.go), which sets only the variables not already set,
 *     empty or not.
 *   - The config it selected is the --config path, made absolute, or else the
 *     first sst.config.ts upwards from the directory it runs in (Discover, in
 *     project.go). SST evaluates app() by bundling that config into
 *     <the config's directory>/.sst/platform/sst.config.<milliseconds>.mjs
 *     (js.Build in pkg/js/js.go, given that directory by New in
 *     pkg/project/project.go) and running `node --no-warnings <that file>`.
 *     So app()'s process.argv[1] is that path, as SST made it (node makes a
 *     path absolute and leaves links in it as they are), and the directory
 *     three levels up is the one whose .env SST loads after app(), wherever
 *     SST runs and whether or not it was given --config.
 *
 * Two layers:
 *
 *   1. refuseForeignCredentials(), which sst.config.ts's app() runs for every
 *      -runs stage and every command (deploy, diff, dev, remove and the
 *      rest), before SST makes any request: it refuses an AWS_PROFILE other
 *      than the stage's profile, SST_AWS_NO_PROFILE, keys or a web identity
 *      in the environment, and the same in the .env beside the config SST
 *      selected, found from process.argv[1] as above. When app() is evaluated
 *      from anything else (another version of SST, or a program importing
 *      sst.config.ts), which .env SST will load cannot be told, and it
 *      refuses. A .env line is refused even when the shell already sets the
 *      variable, so that SST would keep the shell's value: the same checkout,
 *      from a shell without it, would take the file's.
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
import { join } from "node:path";

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

/** The .env SST loads beside the config it selected, and its text. */
export interface DotEnv {
	path: string;
	text: string;
}

/** The file SST 4.17.0 evaluates app() in, and the directory of the config it selected. */
const SST_EVALUATES_IN = /^(\/.+)\/\.sst\/platform\/sst\.config\.\d+\.mjs$/;

/**
 * The directory of the config SST selected, from the path of the file it
 * evaluates app() in (process.argv[1]):
 * <that directory>/.sst/platform/sst.config.<milliseconds>.mjs. Null for any
 * other path, or none.
 */
export function sstProjectRoot(evaluatedIn: string | undefined): string | null {
	return (evaluatedIn === undefined ? null : SST_EVALUATES_IN.exec(evaluatedIn)?.[1]) ?? null;
}

/** The .env in the directory of the config SST selected, which SST loads after app(). Null when there is none. */
export function projectDotEnv(root: string): DotEnv | null {
	const path = join(root, ".env");
	return existsSync(path) ? { path, text: readFileSync(path, "utf8") } : null;
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

/** Why a variable set to this value would send SST, or the provider, to another account than the stage's; null when it would not. */
function whyForeign(stage: string, name: string, value: string): string | null {
	if (value === "") return null;
	if (name === "AWS_PROFILE") return value === stageProfile(stage) ? null : "SST uses it in place of the stage's profile";
	return FOREIGN_CREDENTIALS[name] ?? null;
}

/** A variable as a refusal shows it: AWS_PROFILE with its value, any other without. */
function shown(name: string, value: string): string {
	return name === "AWS_PROFILE" ? `AWS_PROFILE=${value}` : `${name} (its value not shown)`;
}

const READ = ["AWS_PROFILE", ...Object.keys(FOREIGN_CREDENTIALS)];

/**
 * Every reason, in an environment and the .env SST loads after app(), that
 * SST could act on another account than the one stages.ts names for the
 * stage. An AWS_PROFILE that is the stage's own profile is no reason.
 *
 * A line of the .env is a reason even when the environment already sets the
 * variable, to the stage's profile or to nothing: SST then keeps the
 * environment's value (godotenv.Load replaces no variable already set), and
 * this one command would go to the right account. It is refused on purpose:
 * the same checkout, run from a shell without the variable, would take the
 * file's value, so the file is the hazard, and the refusal says so.
 */
export function foreignCredentials(stage: string, environment: Environment, dotEnv: DotEnv | null): ForeignCredential[] {
	const found: ForeignCredential[] = [];
	for (const name of READ) {
		const value = environment[name];
		const why = value === undefined ? null : whyForeign(stage, name, value);
		if (why !== null) found.push({ name, where: "environment", problem: `${shown(name, value as string)}: ${why}` });
	}
	if (dotEnv === null) return found;
	const lines = dotEnvVariables(dotEnv.text);
	for (const name of READ) {
		const value = lines.get(name);
		const why = value === undefined ? null : whyForeign(stage, name, value);
		if (why === null) continue;
		const shell = environment[name];
		const thisTime =
			shell === undefined
				? ""
				: `. This time the shell's ${shell === "" ? `${name}, set and empty,` : shown(name, shell)} wins, as SST lets the file replace no variable already set;` +
					" from a shell without it, the same checkout would take the file's. The file is the hazard, and is refused all the same";
		found.push({ name, where: dotEnv.path, problem: `${dotEnv.path} sets ${shown(name, value as string)}: SST loads that file into its environment after app(); ${why}${thisTime}` });
	}
	return found;
}

/**
 * SST shows an error thrown by app() only in its log (the one it starts each
 * command with, /tmp/sst-<date>-<time>.log, as seen with `sst diff`: app()
 * comes before the command has a .sst/log/sst.log; or on the terminal with
 * --print-logs); otherwise it prints "Unexpected error
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
 * anything, saying what to unset, or when the .env SST will load after app()
 * cannot be found because app() is not being evaluated where SST 4.17.0
 * evaluates it (`evaluatedIn`, process.argv[1]). sst.config.ts's app() calls
 * it for every -runs stage.
 */
export function refuseForeignCredentials(
	stage: string,
	environment: Environment = process.env,
	evaluatedIn: string | undefined = process.argv[1],
	tell: (message: string) => void = tellTerminal,
): void {
	const opening = `SST stops here, before any request to AWS. The stage ${stage} deploys to the ${stageAccount(stage)} account, with the profile ${stageProfile(stage)} (infra/runs/stages.ts)`;
	const root = sstProjectRoot(evaluatedIn);
	if (root === null) {
		const message = [
			`${opening}, and after app() SST loads the .env beside the config it selected, which could name another account.`,
			`Which file that is cannot be told: SST 4.17.0 evaluates app() in <the config's directory>/.sst/platform/sst.config.<n>.mjs, and this app() runs in ${evaluatedIn || "no file"}.`,
			"Run SST 4.17.0 itself (bunx sst, as package.json pins it), from the checkout or with --config.",
		].join("\n");
		tell(message);
		throw new Error(message);
	}
	const dotEnv = projectDotEnv(root);
	const found = foreignCredentials(stage, environment, dotEnv);
	if (found.length === 0) return;
	const inEnvironment = found.filter((item) => item.where === "environment").map((item) => item.name);
	const inDotEnv = found.filter((item) => item.where !== "environment").map((item) => item.name);
	const remedies = [
		...(inEnvironment.length === 0 ? [] : [`unset ${inEnvironment.join(" ")}`]),
		...(inDotEnv.length === 0 ? [] : [`take the line${inDotEnv.length === 1 ? "" : "s"} setting ${inDotEnv.join(", ")} out of ${dotEnv?.path}`]),
	];
	const message = [
		`${opening}, and this would send SST, or the provider that makes the stage's resources, to another:`,
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
