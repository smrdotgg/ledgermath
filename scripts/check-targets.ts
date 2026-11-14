/**
 * Checks what schedule.json says about AWS against AWS itself, only reading:
 *
 *   - each target's vcpus against the type's DefaultVCpus
 *     (aws ec2 describe-instance-types), the vCPUs a box of it counts against
 *     the quota, which the schedule's quota rules rest on;
 *   - that each target's type is offered in its zone
 *     (aws ec2 describe-instance-type-offerings);
 *   - vcpu_quota.limit against the applied value of the quota it names,
 *     Running On-Demand Standard instances, L-1216C47A
 *     (aws service-quotas get-service-quota).
 *
 *     bun scripts/check-targets.ts --stage STAGE [--schedule FILE]
 *
 * It reads the account STAGE deploys to, with that account's profile
 * (infra/runs/stages.ts): production-runs the production account, any other
 * -runs stage the development account. Each account has its own quota, so
 * the check is made for the account the scheduled stage is in, and before a
 * stage becomes the scheduled one. The region is the targets' zone's. Needs
 * the aws CLI and read access, so it
 * is not part of `bun test` (CI has no AWS access); tests/check-targets.test.ts
 * tests the comparison with made-up answers. Exit status 0 when everything
 * matches, 1 when something does not or could not be read, 2 on bad usage.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { parseSchedule, type Schedule } from "../infra/runs/schedule";
import { stageProfile } from "../infra/runs/stages";

export const QUOTA_CODE = "L-1216C47A";

/** What AWS answered; undefined where it could not be read. */
export interface AwsFacts {
	/** DefaultVCpus by instance type. */
	vcpus: Record<string, number> | undefined;
	/** The instance types offered in the targets' zone. */
	offered: string[] | undefined;
	/** The applied value of QUOTA_CODE in the region. */
	quota: number | undefined;
}

/** One line per fact compared, and what did not match. */
export function compareWithAws(schedule: Schedule, facts: AwsFacts): { lines: string[]; problems: string[] } {
	const lines: string[] = [];
	const problems: string[] = [];
	for (const target of schedule.targets) {
		const actual = facts.vcpus?.[target.instance_type];
		const offered = facts.offered?.includes(target.instance_type);
		const vcpus =
			facts.vcpus === undefined ? "vcpus not read" : actual === target.vcpus ? `vcpus ${target.vcpus} = AWS ${actual}` : `vcpus ${target.vcpus} != AWS ${actual ?? "none"}`;
		const zone = facts.offered === undefined ? "offering not read" : offered ? `offered in ${target.zone}` : `NOT offered in ${target.zone}`;
		lines.push(`${target.instance_type.padEnd(14)} ${vcpus.padEnd(22)} ${zone}`);
		if (facts.vcpus !== undefined && actual !== target.vcpus) {
			problems.push(`${target.instance_type}: schedule.json says vcpus ${target.vcpus}; AWS's DefaultVCpus is ${actual ?? "not given"}`);
		}
		if (facts.offered !== undefined && !offered) problems.push(`${target.instance_type}: not offered in ${target.zone}`);
	}
	const limit = schedule.vcpu_quota.limit;
	if (facts.quota === undefined) {
		lines.push(`quota ${QUOTA_CODE}: not read`);
	} else {
		lines.push(`quota ${QUOTA_CODE}: limit ${limit} ${facts.quota === limit ? "=" : "!="} AWS ${facts.quota}`);
		if (facts.quota !== limit) problems.push(`vcpu_quota.limit is ${limit}; the applied quota ${QUOTA_CODE} is ${facts.quota}`);
	}
	const sum = schedule.targets.reduce((total, target) => total + target.vcpus, 0);
	lines.push(`targets ${sum} + reserved ${schedule.vcpu_quota.reserved_outside_schedule} = ${sum + schedule.vcpu_quota.reserved_outside_schedule} of ${limit}`);
	if (facts.vcpus === undefined) problems.push("could not read the instance types' vCPUs");
	if (facts.offered === undefined) problems.push("could not read the zone's offerings");
	if (facts.quota === undefined) problems.push(`could not read the quota ${QUOTA_CODE}`);
	return { lines, problems };
}

/**
 * The arguments every aws call is given for a stage: its account's profile,
 * which overrides AWS_PROFILE, and JSON output. Throws for a stage that is
 * not a -runs stage.
 */
export function awsArguments(stage: string): string[] {
	return ["--profile", stageProfile(stage), "--output", "json"];
}

/** Runs the aws CLI, read-only calls only, and parses its JSON; undefined, with the error printed, when it fails. */
function aws(args: string[], stage: string): unknown {
	const done = spawnSync("aws", [...args, ...awsArguments(stage)], { encoding: "utf8" });
	if (done.status !== 0) {
		console.error(`aws ${args.join(" ")} failed: ${(done.stderr || done.error?.message || "").trim()}`);
		return undefined;
	}
	return JSON.parse(done.stdout) as unknown;
}

function main(): void {
	const { values } = parseArgs({ options: { schedule: { type: "string" }, stage: { type: "string" } } });
	const stage = values.stage;
	if (stage === undefined || !stage.endsWith("-runs")) {
		console.error("usage: bun scripts/check-targets.ts --stage STAGE [--schedule FILE]   (STAGE: a -runs stage, such as production-runs)");
		process.exit(2);
	}
	const path = values.schedule ?? join(resolve(import.meta.dir, ".."), "schedule.json");
	const schedule = parseSchedule(JSON.parse(readFileSync(path, "utf8")), path);
	const zone = schedule.targets[0]?.zone as string;
	const region = zone.slice(0, -1);
	const types = schedule.targets.map((target) => target.instance_type);

	const described = aws(["ec2", "describe-instance-types", "--region", region, "--instance-types", ...types,
		"--query", "InstanceTypes[].[InstanceType,VCpuInfo.DefaultVCpus]"], stage) as Array<[string, number]> | undefined;
	const offered = aws(["ec2", "describe-instance-type-offerings", "--region", region, "--location-type", "availability-zone",
		"--filters", `Name=location,Values=${zone}`, `Name=instance-type,Values=${types.join(",")}`,
		"--query", "InstanceTypeOfferings[].InstanceType"], stage) as string[] | undefined;
	const quota = aws(["service-quotas", "get-service-quota", "--region", region, "--service-code", "ec2", "--quota-code", QUOTA_CODE,
		"--query", "Quota.Value"], stage) as number | undefined;

	const { lines, problems } = compareWithAws(schedule, {
		vcpus: described === undefined ? undefined : Object.fromEntries(described),
		offered,
		quota,
	});
	console.log(`${path}, against AWS in ${region}, in the account of ${stage} (profile ${stageProfile(stage)}):`);
	for (const line of lines) console.log(`  ${line}`);
	for (const problem of problems) console.error(`MISMATCH: ${problem}`);
	console.log(problems.length === 0 ? "everything matches" : `${problems.length} problem(s)`);
	process.exit(problems.length === 0 ? 0 : 1);
}

if (import.meta.main) main();
