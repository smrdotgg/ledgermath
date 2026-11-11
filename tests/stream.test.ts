import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import type { RunEvent } from "../methods/run";
import { derive, gather } from "../methods/v1";
import { streamProblems } from "../methods/v1/stream";
import { HandMade } from "./hand-made-runs";

/** Each stream is also given to check-events.py, a process of its own: quick, but never held to bun's five seconds. */
const SUBPROCESS_TIMEOUT_MS = 60_000;

const CHECK_EVENTS = join(import.meta.dir, "..", "scripts", "check-events.py");
const SAMPLES = 3;

type Event = Record<string, unknown>;

/** A stream that obeys the contract: two warmup samples, then SAMPLES counted ones of 100 repetitions. */
function goodStream(): Event[] {
	const events: Event[] = [
		{ event: "started", t: 1000, schema: "ledgermath.events/1", wall_utc: "2026-11-11T22:15:00.000000000Z", clock: "CLOCK_MONOTONIC_RAW", clock_read_ns: 20, quick: false },
		{ event: "observed", t: 2000, values: { bytes_per_repetition: 1073741824, threads_used: 1, path_taken: "scalar" } },
	];
	let t = 3000;
	for (let sample = 0; sample < 2 + SAMPLES; sample++) {
		events.push({ event: "sample_started", t: (t += 10), sample, warmup: sample < 2, repetitions: sample < 2 ? 1 : 100 });
		events.push({ event: "sample_ended", t: (t += 10_000), sample });
	}
	events.push({ event: "verified", t: (t += 10), checksum: "0x0000000000000001" });
	events.push({ event: "finished", t: t + 10 });
	return events;
}

const at = (events: Event[], match: (event: Event) => boolean): number => {
	const index = events.findIndex(match);
	if (index < 0) throw new Error("no such event");
	return index;
};
const startOf = (sample: number) => (event: Event) => event.event === "sample_started" && event.sample === sample;
const endOf = (sample: number) => (event: Event) => event.event === "sample_ended" && event.sample === sample;
const lines = (events: Event[]): string => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;

/** Each stream as text, and whether the contract holds for it. */
const STREAMS: Array<{ name: string; text: string; ok: boolean }> = [];
const add = (name: string, ok: boolean, change: (events: Event[]) => Event[] | string): void => {
	const changed = change(goodStream());
	STREAMS.push({ name, ok, text: typeof changed === "string" ? changed : lines(changed) });
};

add("a good stream", true, (e) => e);
add("a benchmark's own event between started and finished", true, (e) => {
	e.splice(3, 0, { event: "connected", t: 2500, peer: "a" });
	return e;
});
add("a second sample_ended for a counted sample", false, (e) => {
	e.splice(e.length - 2, 0, { event: "sample_ended", t: 1_000_010_000, sample: 2 });
	return e;
});
add("an unclosed warmup sample", false, (e) => e.filter((event) => !endOf(0)(event)));
add("a duplicated counted sample_started", false, (e) => {
	const i = at(e, startOf(3));
	e.splice(i, 0, { ...(e[i] as Event) });
	return e;
});
add("a sample_ended before its sample_started", false, (e) => {
	const i = at(e, startOf(2));
	[e[i], e[i + 1]] = [e[i + 1] as Event, e[i] as Event];
	return e;
});
add("a sample that ends before it starts", false, (e) => {
	const end = e[at(e, endOf(2))] as Event;
	end.t = (e[at(e, startOf(2))] as Event).t as number - 1;
	return e;
});
add("a sample that starts before the previous one ended", false, (e) => {
	(e[at(e, startOf(3))] as Event).t = (e[at(e, endOf(2))] as Event).t as number - 1;
	return e;
});
add("no verified event", false, (e) => e.filter((event) => event.event !== "verified"));
add("two verified events", false, (e) => {
	const i = at(e, (event) => event.event === "verified");
	e.splice(i, 0, { ...(e[i] as Event) });
	return e;
});
add("a bad checksum", false, (e) => {
	(e[at(e, (event) => event.event === "verified")] as Event).checksum = "0x1";
	return e;
});
add("started not first", false, (e) => {
	[e[0], e[1]] = [e[1] as Event, e[0] as Event];
	return e;
});
add("started twice", false, (e) => {
	e.splice(1, 0, { ...(e[0] as Event) });
	return e;
});
add("no finished event", false, (e) => e.slice(0, -1));
add("an event after finished", false, (e) => [...e, { event: "connected", t: 999_999_999 }]);
add("finished twice", false, (e) => [...e, { ...(e.at(-1) as Event) }]);
add("samples not numbered from 0", false, (e) => e.map((event) => ("sample" in event ? { ...event, sample: (event.sample as number) + 1 } : event)));
add("an observed key emitted twice", false, (e) => {
	e.splice(2, 0, { event: "observed", t: 2100, values: { threads_used: 1 } });
	return e;
});
add("fewer counted samples than asked for", false, (e) => {
	const i = at(e, startOf(4));
	e.splice(i, 2);
	return e;
});
add("no counted sample", false, (e) => e.map((event) => (event.event === "sample_started" ? { ...event, warmup: true } : event)));
add("a --quick stream", false, (e) => {
	(e[0] as Event).quick = true;
	return e;
});
add("a wall_utc without nanoseconds", false, (e) => {
	(e[0] as Event).wall_utc = "2026-11-11T22:15:00Z";
	return e;
});
add("repetitions of 0", false, (e) => {
	(e[at(e, startOf(3))] as Event).repetitions = 0;
	return e;
});
add("a warmup sample after the counted ones", true, (e) => {
	const i = at(e, (event) => event.event === "verified");
	const last = (e[i - 1] as Event).t as number;
	e.splice(i, 0, { event: "sample_started", t: last + 10, sample: 5, warmup: true, repetitions: 1 }, { event: "sample_ended", t: last + 20, sample: 5 });
	return e;
});
add("a line that is not JSON", false, (e) => lines(e).replace('{"event":"verified"', 'oops\n{"event":"verified"'));
add("a blank line", false, (e) => lines(e).replace('{"event":"verified"', '\n{"event":"verified"'));
add("a line that is an array", false, (e) => lines(e).replace('{"event":"verified"', '[1, 2]\n{"event":"verified"'));
add("an event without t", false, (e) => {
	delete (e[at(e, (event) => event.event === "verified")] as Event).t;
	return e;
});

/** As runner/run.py parses stdout: line by line, stopping at the first line that is not a JSON object. */
function parseLikeTheRunner(text: string): { events: Event[]; error?: { line: number; message: string } } {
	const parts = text.split("\n");
	if (parts.at(-1) === "") parts.pop();
	const events: Event[] = [];
	for (const [index, line] of parts.entries()) {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			return { events, error: { line: index + 1, message: `not JSON: ${String(error)}` } };
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) return { events, error: { line: index + 1, message: "not a JSON object" } };
		events.push(value as Event);
	}
	return { events };
}

function checkEventsAccepts(text: string): boolean {
	const result = spawnSync("python3", [CHECK_EVENTS, "--samples", String(SAMPLES)], { input: text, encoding: "utf8" });
	if (result.status !== 0 && result.status !== 1) throw new Error(`check-events.py: ${result.stderr || result.error?.message}`);
	return result.status === 0;
}

/** Whether Method version 1 counts a Run that exited 0 with this stdout. */
async function methodCounts(text: string): Promise<{ counted: boolean; failure: string | null; time: number | null }> {
	const made = new HandMade();
	const run = made.run({ startedAt: "2026-11-11T22:15:00Z", samples: SAMPLES });
	const parsed = parseLikeTheRunner(text);
	run.events = parsed.events as RunEvent[];
	if (parsed.error) run.events_error = parsed.error;
	const file = derive(made.files, await gather(made.files, made.fetch));
	if (file.unreadable.length > 0) return { counted: false, failure: file.unreadable[0]?.reason ?? "", time: null };
	const point = file.derivations[0]?.points[0];
	return { counted: point?.counted ?? false, failure: point?.failure ?? null, time: point?.time_per_repetition_ns ?? null };
}

describe("a Run counts only when its stream obeys scripts/check-events.py", () => {
	for (const stream of STREAMS) {
		test(`${stream.name}: ${stream.ok ? "counted" : "failed"}, and check-events.py agrees`, async () => {
			const python = checkEventsAccepts(stream.text);
			const method = await methodCounts(stream.text);
			expect(python).toBe(stream.ok);
			expect(method.counted).toBe(python);
			if (!method.counted) {
				expect(method.failure).not.toBeNull();
				expect(method.time).toBeNull();
			}
			// The port alone, where every line parsed, agrees too.
			const parsed = parseLikeTheRunner(stream.text);
			if (parsed.error === undefined) expect(streamProblems(parsed.events, SAMPLES).length === 0).toBe(python);
		}, SUBPROCESS_TIMEOUT_MS);
	}
});

describe("the verifier's streams", () => {
	const find = (name: string): string => (STREAMS.find((stream) => stream.name === name) as { text: string }).text;

	test("a second sample_ended cannot stand in for a sample's end: the Run is failed, with no number", async () => {
		const result = await methodCounts(find("a second sample_ended for a counted sample"));
		expect(result).toMatchObject({ counted: false, time: null });
		expect(result.failure).toContain("sample_ended with no sample open");
	}, SUBPROCESS_TIMEOUT_MS);

	test("an unclosed warmup, a duplicated start, a reversed start and end, and no verified are each failed, saying why", async () => {
		const cases: Array<[string, string]> = [
			["an unclosed warmup sample", "sample 1 started before sample 0 ended"],
			["a duplicated counted sample_started", "sample 3 started before sample 3 ended"],
			["a sample_ended before its sample_started", "sample_ended with no sample open"],
			["a sample that ends before it starts", "sample 2 ends before it starts"],
			["no verified event", 'no "verified" event'],
			["two verified events", '"verified" appears more than once'],
		];
		for (const [name, reason] of cases) {
			const result = await methodCounts(find(name));
			expect(result.counted).toBe(false);
			expect(result.failure).toContain(reason);
		}
	}, SUBPROCESS_TIMEOUT_MS);
});
