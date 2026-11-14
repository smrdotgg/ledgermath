import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	confirmDeployAccount,
	dotEnvVariables,
	FOREIGN_CREDENTIALS,
	foreignCredentials,
	profileAccountWithAwsCli,
	projectDotEnv,
	refuseForeignCredentials,
} from "../infra/runs/deploy-account";

// infra/runs/deploy-account.ts: what stops SST from acting on another account
// than infra/runs/stages.ts names for a -runs stage. No AWS: the environments
// are made up, and `aws` is a stand-in on PATH.

const ROOT = join(import.meta.dir, "..");
const CONFIG = readFileSync(join(ROOT, "sst.config.ts"), "utf8");
const STACK = readFileSync(join(ROOT, "infra", "runs", "stack.ts"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "deploy-account-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;
const fresh = (name: string): string => join(scratch, `${made++}-${name}`);

/** Every variable the first layer reads, so a test's environment is only what it says. */
const READ = ["AWS_PROFILE", ...Object.keys(FOREIGN_CREDENTIALS)];

/**
 * sst.config.ts's app(), as SST calls it, in an environment holding exactly
 * `environment` of the variables the check reads (the rest of process.env
 * as it is), from `cwd`.
 */
async function appOf(stage: string, environment: Record<string, string> = {}, cwd = ROOT): Promise<unknown> {
	const globals = globalThis as unknown as { $config?: (config: unknown) => unknown };
	globals.$config = (config: unknown) => config;
	const path = join(ROOT, "sst.config.ts");
	const config = (await import(path)).default as { app: (input: { stage?: string }) => unknown };
	const saved = Object.fromEntries(READ.map((name) => [name, process.env[name]]));
	const directory = process.cwd();
	for (const name of READ) delete process.env[name];
	Object.assign(process.env, environment);
	process.chdir(cwd);
	try {
		return await config.app({ stage });
	} finally {
		process.chdir(directory);
		for (const name of READ) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	}
}

describe("before SST makes any request: the environment", () => {
	test("an AWS_PROFILE naming another profile is refused; the stage's own, or none, or an empty one, is not", () => {
		expect(foreignCredentials("smr-runs", { AWS_PROFILE: "tabot-production" }, null).map((item) => item.problem)).toEqual([
			"AWS_PROFILE=tabot-production: SST uses it in place of the stage's profile",
		]);
		expect(foreignCredentials("production-runs", { AWS_PROFILE: "tabot-dev" }, null).map((item) => item.name)).toEqual(["AWS_PROFILE"]);
		expect(foreignCredentials("production-runs", { AWS_PROFILE: "tabot-production" }, null)).toEqual([]);
		expect(foreignCredentials("smr-runs", { AWS_PROFILE: "tabot-dev" }, null)).toEqual([]);
		expect(foreignCredentials("smr-runs", { AWS_PROFILE: "" }, null)).toEqual([]);
		expect(foreignCredentials("smr-runs", {}, null)).toEqual([]);
	});

	test("keys, a web identity and SST_AWS_NO_PROFILE are refused whatever AWS_PROFILE says, and no value is shown", () => {
		const environment = {
			AWS_PROFILE: "tabot-dev",
			AWS_ACCESS_KEY_ID: "AKIAEXAMPLEKEYID0000",
			AWS_SECRET_ACCESS_KEY: "a-secret-value",
			AWS_SESSION_TOKEN: "a-session-token",
			AWS_ACCESS_KEY: "AKIAEXAMPLEOLDNAME00",
			AWS_SECRET_KEY: "an-old-secret",
			AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/token",
			SST_AWS_NO_PROFILE: "1",
		};
		const found = foreignCredentials("smr-runs", environment, null);
		expect(found.map((item) => item.name).sort()).toEqual(
			["AWS_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SECRET_KEY", "AWS_SESSION_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE", "SST_AWS_NO_PROFILE"].sort(),
		);
		const text = found.map((item) => item.problem).join("\n");
		for (const value of Object.values(environment)) if (value !== "tabot-dev") expect(text).not.toContain(value);
		expect(text).toContain("AWS_ACCESS_KEY_ID (its value not shown): keys in the environment come before any profile for the provider that makes the stage's resources");
		expect(text).toContain("SST_AWS_NO_PROFILE (its value not shown): SST drops the stage's profile");
		// Set but empty is not set, for SST and for the SDK.
		expect(foreignCredentials("smr-runs", { AWS_ACCESS_KEY_ID: "", SST_AWS_NO_PROFILE: "" }, null)).toEqual([]);
	});

	test("the refusal says which account the stage is for, what each variable does, and what to unset", () => {
		let message = "";
		const told: string[] = [];
		try {
			refuseForeignCredentials(
				"smr-runs",
				{ AWS_PROFILE: "tabot-production", AWS_ACCESS_KEY_ID: "AKIAEXAMPLEKEYID0000", AWS_SECRET_ACCESS_KEY: "a-secret-value" },
				fresh("nowhere"),
				(text) => told.push(text),
			);
		} catch (error) {
			message = (error as Error).message;
		}
		// SST shows app()'s error only in its log, so the same words go to the terminal.
		expect(told).toEqual([message]);
		expect(message).toStartWith(
			"SST stops here, before any request to AWS. The stage smr-runs deploys to the development account, with the profile tabot-dev (infra/runs/stages.ts)",
		);
		expect(message).toContain("  AWS_PROFILE=tabot-production: SST uses it in place of the stage's profile\n");
		expect(message).toContain("Then unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY, and run the command again.");
		expect(message).not.toContain("AKIAEXAMPLEKEYID0000");
		expect(message).not.toContain("a-secret-value");
	});

	test("the .env beside sst.config.ts, which SST loads after app() when it runs in a subdirectory, is read too", () => {
		const project = fresh("project");
		mkdirSync(join(project, "infra", "runs"), { recursive: true });
		writeFileSync(join(project, "sst.config.ts"), "");
		writeFileSync(join(project, ".env"), ["# a comment", "export AWS_PROFILE='tabot-production'", "AWS_SECRET_ACCESS_KEY: x # trailing", "OTHER=1", ""].join("\n"));
		const found = projectDotEnv(join(project, "infra", "runs"));
		expect(found?.path).toBe(join(project, ".env"));
		expect(foreignCredentials("smr-runs", {}, found).map((item) => item.problem)).toEqual([
			`${join(project, ".env")} sets AWS_PROFILE=tabot-production: SST uses it in place of the stage's profile`,
			`${join(project, ".env")} sets AWS_SECRET_ACCESS_KEY (its value not shown): keys in the environment come before any profile for the provider that makes the stage's resources`,
		]);
		const quiet = (): void => {};
		expect(() => refuseForeignCredentials("smr-runs", {}, join(project, "infra"), quiet)).toThrow(`take AWS_PROFILE, AWS_SECRET_ACCESS_KEY out of ${join(project, ".env")}`);
		expect(() => refuseForeignCredentials("production-runs", {}, join(project, "infra"), quiet)).toThrow(`take AWS_SECRET_ACCESS_KEY out of ${join(project, ".env")}`);
		// No .env beside sst.config.ts, or no sst.config.ts at all: nothing to read.
		const bare = fresh("bare");
		mkdirSync(join(bare, "sub"), { recursive: true });
		writeFileSync(join(bare, "sst.config.ts"), "");
		expect(projectDotEnv(join(bare, "sub"))).toBeNull();
		expect(projectDotEnv("/")).toBeNull();
	});

	test("reads a .env as SST's loader does for these lines", () => {
		expect([...dotEnvVariables(['AWS_PROFILE="tabot-dev" # quoted', "  export  SST_AWS_NO_PROFILE=1", "AWS_SESSION_TOKEN=", "not a line", "#AWS_ACCESS_KEY_ID=x"].join("\n"))]).toEqual([
			["AWS_PROFILE", "tabot-dev"],
			["SST_AWS_NO_PROFILE", "1"],
			["AWS_SESSION_TOKEN", ""],
		]);
	});

	test("sst.config.ts's app() refuses a -runs stage in such an environment, from the root or a subdirectory, and leaves July's stages alone", async () => {
		await expect(appOf("smr-runs", { AWS_PROFILE: "tabot-production" })).rejects.toThrow("SST stops here, before any request to AWS. The stage smr-runs");
		await expect(appOf("production-runs", { AWS_PROFILE: "tabot-dev" })).rejects.toThrow("The stage production-runs deploys to the production account");
		await expect(appOf("production-runs", { AWS_ACCESS_KEY_ID: "AKIAEXAMPLEKEYID0000", AWS_SECRET_ACCESS_KEY: "s" }, join(ROOT, "infra", "runs"))).rejects.toThrow(
			"unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY",
		);
		expect(await appOf("production-runs", { AWS_PROFILE: "tabot-production" })).toMatchObject({ providers: { aws: { profile: "tabot-production" } } });
		expect(await appOf("smr-runs")).toMatchObject({ providers: { aws: { profile: "tabot-dev" } } });
		// July's branch is unchanged, and checks nothing.
		expect(await appOf("smr", { AWS_PROFILE: "tabot-production", AWS_ACCESS_KEY_ID: "AKIAEXAMPLEKEYID0000" })).toMatchObject({ providers: { aws: { profile: "tabot-dev" } } });
		const runsBranch = CONFIG.slice(CONFIG.indexOf('if (input?.stage?.endsWith("-runs")) {'), CONFIG.indexOf("return {"));
		expect(runsBranch).toContain("refuseForeignCredentials(input.stage);\n\t\t\treturn runsStageApp(input.stage);");
	});
});

describe("before the stack declares anything: the account the provider acts in", () => {
	test("must be the account the stage's profile reaches", () => {
		const asked: string[] = [];
		const reaches = (profile: string): string => {
			asked.push(profile);
			return profile === "tabot-production" ? "222222222222" : "111111111111";
		};
		expect(() => confirmDeployAccount("production-runs", "222222222222", reaches)).not.toThrow();
		expect(() => confirmDeployAccount("smr-runs", "111111111111", reaches)).not.toThrow();
		expect(() => confirmDeployAccount("smr-runs", "222222222222", reaches)).toThrow(
			"The provider that makes the resources of smr-runs acts in the AWS account 222222222222, and the stage's profile, tabot-dev (infra/runs/stages.ts), reaches the account 111111111111.",
		);
		expect(asked).toEqual(["tabot-production", "tabot-dev", "tabot-dev"]);
	});

	test("the profile's account comes from `aws sts get-caller-identity --profile`, whatever the environment says", () => {
		const bin = fresh("bin");
		mkdirSync(bin);
		const calls = join(bin, "calls");
		writeFileSync(
			join(bin, "aws"),
			[
				"#!/bin/sh",
				`echo "$*" >> '${calls}'`,
				'case "$*" in',
				'  "sts get-caller-identity --profile tabot-production --query Account --output text") echo 222222222222 ;;',
				'  *) echo "The config profile (missing) could not be found" >&2; exit 255 ;;',
				"esac",
				"",
			].join("\n"),
		);
		chmodSync(join(bin, "aws"), 0o755);
		const path = process.env.PATH;
		const profile = process.env.AWS_PROFILE;
		process.env.PATH = `${bin}:${path}`;
		process.env.AWS_PROFILE = "tabot-dev";
		try {
			expect(profileAccountWithAwsCli("tabot-production")).toBe("222222222222");
			expect(() => profileAccountWithAwsCli("missing")).toThrow(
				"aws sts get-caller-identity --profile missing exited 255: The config profile (missing) could not be found (if the login has expired: aws sso login --profile missing)",
			);
		} finally {
			process.env.PATH = path;
			if (profile === undefined) delete process.env.AWS_PROFILE;
			else process.env.AWS_PROFILE = profile;
		}
		expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
			"sts get-caller-identity --profile tabot-production --query Account --output text",
			"sts get-caller-identity --profile missing --query Account --output text",
		]);
	});

	test("is confirmed first thing in runsStack(), before any resource is declared", () => {
		expect(STACK).toContain('import { confirmDeployAccount } from "./deploy-account";');
		const body = STACK.slice(STACK.indexOf("export async function runsStack() {"));
		expect(body.indexOf("confirmDeployAccount($app.stage, (await aws.getCallerIdentity({})).accountId);")).toBeGreaterThan(0);
		expect(body.indexOf("confirmDeployAccount(")).toBeLessThan(body.indexOf("new "));
		expect(body.indexOf("confirmDeployAccount(")).toBeLessThan(body.indexOf("sourceArchive()"));
	});
});
