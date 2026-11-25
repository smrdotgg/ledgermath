/**
 * The runs workflow's scheduled starts, read from its crons, for the tests
 * that hold the alarm's 14 hours (MAX_PUBLISH_AGE_MS, ADR-0032) to the
 * schedule it assumes; and the rounds of boots schedule.json makes, for the
 * test that holds those starts to once after each round (ADR-0035). Not a
 * test file; the alarm itself never reads it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW = join(import.meta.dir, "..", ".github", "workflows", "runs.yml");
const SCHEDULE = join(import.meta.dir, "..", "schedule.json");

/**
 * The rounds of boots schedule.json makes each day, as minutes of the day (UTC): a boot less than
 * an hour after the one before is in its round. A round may run past midnight.
 */
export function bootRounds(): Array<{ first: number; last: number }> {
	const schedule = JSON.parse(readFileSync(SCHEDULE, "utf8")) as { targets: Array<{ boots_utc: string[] }> };
	const boots = [
		...new Set(
			schedule.targets.flatMap((target) =>
				target.boots_utc.map((time) => {
					const [hour, minute] = time.split(":").map(Number) as [number, number];
					return hour * 60 + minute;
				}),
			),
		),
	].sort((a, b) => a - b);
	const rounds: Array<{ first: number; last: number }> = [];
	for (const boot of boots) {
		const round = rounds.at(-1);
		if (round !== undefined && boot - round.last < 60) round.last = boot;
		else rounds.push({ first: boot, last: boot });
	}
	// The day's last round and its first are one when they meet across midnight.
	const [head, tail] = [rounds[0], rounds.at(-1)];
	if (rounds.length > 1 && head !== undefined && tail !== undefined && head.first + 1_440 - tail.last < 60) {
		rounds.shift();
		tail.last = head.last + 1_440;
	}
	return rounds;
}

/** The values one field of a cron takes: N, a list of them, or * or *\/N over 0 to max. */
function field(text: string, max: number): number[] {
	const every = /^\*(?:\/(\d+))?$/.exec(text);
	if (every !== null) return Array.from({ length: max + 1 }, (_, value) => value).filter((value) => value % Number(every[1] ?? 1) === 0);
	if (!/^\d+(,\d+)*$/.test(text)) throw new Error(`a cron field these tests do not read: ${text}`);
	return text.split(",").map(Number);
}

/** The minutes of the day (UTC) the workflow is scheduled at, sorted. Throws for a cron that is not daily. */
export function scheduledMinutes(): number[] {
	const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as { on: { schedule: Array<{ cron: string }> } };
	const minutes = workflow.on.schedule.flatMap(({ cron }) => {
		const [minute, hour, day, month, weekday] = cron.split(" ") as [string, string, string, string, string];
		if ([day, month, weekday].some((value) => value !== "*")) throw new Error(`${cron}: not a daily cron`);
		return field(hour, 23).flatMap((h) => field(minute, 59).map((m) => h * 60 + m));
	});
	return [...new Set(minutes)].sort((a, b) => a - b);
}

/** Every scheduled start with from <= start < to, oldest first. */
export function scheduledStarts(from: Date, to: Date): Date[] {
	const minutes = scheduledMinutes();
	const starts: Date[] = [];
	for (let day = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); day < to.getTime(); day += 86_400_000) {
		for (const minute of minutes) {
			const start = day + minute * 60_000;
			if (start >= from.getTime() && start < to.getTime()) starts.push(new Date(start));
		}
	}
	return starts;
}
