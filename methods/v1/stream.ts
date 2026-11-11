/**
 * Method version 1: whether a Run's stream obeys the event contract's order.
 *
 * A line-for-line port of check() in scripts/check-events.py, which checks
 * what schemas/events.schema.json cannot: started first and once, finished
 * last and once, samples numbered from 0 in order, each closed by its own
 * sample_ended before the next starts and never ending before it starts,
 * observed keys emitted once, exactly one verified, and the number of counted
 * samples asked for. tests/stream.test.ts feeds the same streams to both and
 * asserts they agree, so the two cannot drift apart.
 *
 * It reads the Run's parsed events, which are the stream's lines 1 to n:
 * runner/run.py stops parsing at the first line that is not a JSON object and
 * records that line as events_error, which keeps a Run out by itself. What
 * this cannot see, and check-events.py can: whether stdout ended with a
 * newline, and a whole number written as 1.0 (JSON.parse reads it as 1).
 */

const SCHEMA = "ledgermath.events/1";
const UNIVERSAL = ["started", "observed", "sample_started", "sample_ended", "verified", "finished"];
const WALL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/;
const CHECKSUM = /^0x[0-9a-f]{16}$/;

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const repr = (value: unknown): string => (value === undefined ? "None" : JSON.stringify(value));

/** Every way the stream breaks the contract's order, with line numbers; empty when it holds. */
export function streamProblems(lines: readonly unknown[], expectSamples: number | null, expectQuick = false): string[] {
	const problems: string[] = [];
	const bad = (number: number, message: string): void => {
		problems.push(`line ${number}: ${message}`);
	};

	const events: Array<[number, Record<string, unknown> & { event: string; t: number }]> = [];
	lines.forEach((event, index) => {
		const number = index + 1;
		if (!isObject(event)) return bad(number, "not a JSON object");
		if (typeof event.event !== "string") return bad(number, '"event" must be a string');
		if (!isInt(event.t) || event.t < 0) return bad(number, '"t" must be a whole number of nanoseconds');
		events.push([number, event as Record<string, unknown> & { event: string; t: number }]);
	});
	if (events.length === 0) return [...problems, "no events"];

	const [firstNumber, first] = events[0] as (typeof events)[number];
	if (first.event !== "started") bad(firstNumber, `the first event must be "started", got "${first.event}"`);
	const [lastNumber, last] = events[events.length - 1] as (typeof events)[number];
	if (last.event !== "finished") bad(lastNumber, `the last event must be "finished", got "${last.event}"`);

	const observedKeys = new Map<string, number>();
	let openSample: [unknown, number] | null = null;
	let nextSample = 0;
	let lastSampleEnd: number | null = null;
	let counted = 0;
	const seen = new Map(UNIVERSAL.map((name) => [name, 0]));

	for (const [number, event] of events) {
		const name = event.event;
		if (seen.has(name)) seen.set(name, (seen.get(name) as number) + 1);

		if (name === "started") {
			if ((seen.get("started") as number) > 1) bad(number, '"started" appears more than once');
			if (event.schema !== SCHEMA) bad(number, `"schema" must be "${SCHEMA}"`);
			if (typeof event.wall_utc !== "string" || !WALL_UTC.test(event.wall_utc)) {
				bad(number, '"wall_utc" must look like 2026-01-02T03:04:05.123456789Z');
			}
			if (typeof event.clock !== "string" || event.clock === "") bad(number, '"clock" must name the clock');
			if (!isNumber(event.clock_read_ns) || event.clock_read_ns < 0) bad(number, '"clock_read_ns" must be a non-negative number');
			const quick = event.quick ?? false;
			if (typeof quick !== "boolean") bad(number, '"quick" must be true or false');
			else if (quick && !expectQuick) bad(number, "this is a --quick stream; pass --quick if that is intended");
			else if (!quick && expectQuick) bad(number, "expected a --quick stream");
		} else if (name === "observed") {
			const values = event.values;
			if (!isObject(values)) bad(number, '"values" must be an object');
			else {
				for (const key of Object.keys(values)) {
					const before = observedKeys.get(key);
					if (before !== undefined) bad(number, `observed key "${key}" was already emitted on line ${before}`);
					observedKeys.set(key, number);
				}
			}
		} else if (name === "sample_started") {
			const sample = event.sample;
			if (openSample !== null) bad(number, `sample ${repr(sample)} started before sample ${repr(openSample[0])} ended`);
			if (!isInt(sample) || sample !== nextSample) bad(number, `"sample" must be ${nextSample}, got ${repr(sample)}`);
			if (typeof event.warmup !== "boolean") bad(number, '"warmup" must be true or false');
			else if (!event.warmup) counted++;
			if (!isInt(event.repetitions) || event.repetitions < 1) bad(number, '"repetitions" must be a whole number of at least 1');
			if (lastSampleEnd !== null && event.t < lastSampleEnd) bad(number, `sample ${repr(sample)} starts before the previous sample ended`);
			openSample = [sample, event.t];
			nextSample++;
		} else if (name === "sample_ended") {
			const sample = event.sample;
			if (openSample === null) bad(number, "sample_ended with no sample open");
			else {
				if (sample !== openSample[0]) bad(number, `"sample" must be ${repr(openSample[0])}, got ${repr(sample)}`);
				if (event.t < openSample[1]) bad(number, `sample ${repr(sample)} ends before it starts`);
				lastSampleEnd = event.t;
				openSample = null;
			}
		} else if (name === "verified") {
			if ((seen.get("verified") as number) > 1) bad(number, '"verified" appears more than once');
			if (typeof event.checksum !== "string" || !CHECKSUM.test(event.checksum)) {
				bad(number, '"checksum" must be 0x and sixteen lowercase hex digits');
			}
		} else if (name === "finished") {
			if ((seen.get("finished") as number) > 1) bad(number, '"finished" appears more than once');
		}
	}

	if (openSample !== null) problems.push(`sample ${repr(openSample[0])} never ended`);
	if (seen.get("verified") === 0) problems.push('no "verified" event');
	if (counted === 0) problems.push("no counted sample (warmup false)");
	if (expectSamples !== null && counted !== expectSamples) {
		problems.push(`expected ${expectSamples} counted samples, found ${counted}`);
	}
	return problems;
}
