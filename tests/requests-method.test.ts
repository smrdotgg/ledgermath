import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { memoryRecords } from "../methods/records";
import * as requests from "../methods/requests/v1";
import {
	atOrAbove,
	binLower,
	binOf,
	binValue,
	binWidth,
	exactStats,
	leastCount,
	percentileOfSorted,
	supports,
	TALLY_PRECISION,
	TallySum,
	tallyOf,
	tallyStats,
} from "../methods/requests/v1/numbers";
import type { DerivationsFile, SeriesDerivation } from "../methods/requests/v1/output";
import { REQUESTS_RECORD, REQUESTS_RECORD_KEY, reduceRequests } from "../methods/requests/v1/record";
import { addressBlock, readRequests } from "../methods/requests/v1/requests";
import { readStream, type RunFile } from "../methods/run";
import * as series from "../methods/v1";
import { percentile } from "../methods/v1/numbers";
import { SERIES_RECORD_KEY } from "../methods/v1/record";
import { DEFAULT_PHASES, HandMade, rampRequests, requestRun, requestStream } from "./hand-made-requests";

// Each test derives a few hundred hand-made requests; a loaded machine can take longer than bun's five-second default.
setDefaultTimeout(120_000);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const events = (text: string) => readStream(bytes(text)).events;

async function derived(made: HandMade): Promise<DerivationsFile> {
	return requests.derive(made.files, await requests.gather(made.files, made.fetch));
}

function only(file: DerivationsFile): SeriesDerivation {
	expect(file.derivations.length).toBe(1);
	return file.derivations[0] as SeriesDerivation;
}

/** A tiny deterministic generator, so "random" times are the same on every machine. */
function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

describe("one request's phases, from the event timestamps", () => {
	test("over a new connection: each of the eight phases is the difference of the two clock reads the binary's README names", () => {
		const phases = { dns: 211_111, connect: 1_266_409, tls: 2_191_250, send: 7_864, first_byte: 28_477_054, headers: 6_237, body: 9_819 };
		const read = readRequests(events(requestStream({ connection: "new", requests: [{ phases, address: "3.5.92.92" }] })));
		expect(read.problems).toEqual([]);
		expect(read.succeeded.length).toBe(1);
		const total = Object.values(phases).reduce((a, b) => a + b, 0);
		expect(read.succeeded[0]?.phases).toEqual({ ...phases, total });
		expect(read.succeeded[0]?.facts).toEqual({ address_block: "3.5.0.0/16", cipher: "TLS_AES_128_GCM_SHA256", tls_version: "TLSv1.3", tls_group: "X25519MLKEM768" });
	});

	test("the README's real exchange gives its own table: 0.21, 1.27, 2.19, 0.01, 28.48, 0.01 and 32.17 ms", () => {
		// benchmarks/http_get/README.md, "A real exchange": the one counted request's events, its fields trimmed.
		const text = [
			{ event: "started", t: 327318500000000, schema: "ledgermath.events/1", wall_utc: "2026-11-11T11:53:12.000000000Z", clock: "CLOCK_MONOTONIC_RAW", clock_read_ns: 20 },
			{ event: "sample_started", t: 327318522624393, sample: 0, warmup: false, repetitions: 1 },
			{ event: "name_resolved", t: 327318522831979, request: 1, address: "3.5.92.92" },
			{ event: "connection_opened", t: 327318524098388, connection: 1, request: 1, address: "3.5.92.92", port: 443 },
			{ event: "connection_secured", t: 327318526289638, connection: 1, tls: "TLSv1.3", cipher: "TLS_AES_128_GCM_SHA256", group: "X25519MLKEM768" },
			{ event: "request_sent", t: 327318526297502, request: 1, connection: 1 },
			{ event: "first_byte", t: 327318554774556, request: 1 },
			{ event: "response_headers", t: 327318554780793, request: 1, status: 200 },
			{ event: "response_ended", t: 327318554790612, request: 1, bytes: 5545, fixture: "match", s3_checksum: "match" },
			{ event: "sample_ended", t: 327318554790612, sample: 0 },
			{ event: "connection_closed", t: 327318554850258, connection: 1, reason: "done" },
			{ event: "verified", t: 327318554900000, checksum: "0x0000000000000001" },
			{ event: "finished", t: 327318554910000 },
		]
			.map((event) => JSON.stringify(event))
			.join("\n");
		const read = readRequests(events(text));
		expect(read.problems).toEqual([]);
		const ms = (ns: number | undefined): string => ((ns as number) / 1e6).toFixed(2);
		const p = read.succeeded[0]?.phases ?? {};
		expect([p.dns, p.connect, p.tls, p.send, p.first_byte, p.body, p.total].map(ms)).toEqual(["0.21", "1.27", "2.19", "0.01", "28.48", "0.01", "32.17"]);
		expect(p.headers).toBe(6_237);
	});

	test("over a reused connection: only send (from sample_started), first byte, headers, body and total; the connection opened before the sample gives the facts", () => {
		const phases = { send: 52_000, first_byte: 21_800_000, headers: 6_000, body: 17_000 };
		const stream = requestStream({
			connection: "reused",
			requests: Array.from({ length: 5 }, () => ({ phases })),
			requestsPerConnection: 3,
			reusedAddresses: ["16.12.64.242", "3.5.111.20"],
		});
		const read = readRequests(events(stream));
		expect(read.problems).toEqual([]);
		expect(read.succeeded.length).toBe(5);
		for (const request of read.succeeded) expect(request.phases).toEqual({ ...phases, total: 52_000 + 21_800_000 + 6_000 + 17_000 });
		// The warmup and the first two counted requests went over the first connection; S3 closes after 3.
		expect(read.succeeded.map((request) => request.facts.address_block)).toEqual(["16.12.0.0/16", "16.12.0.0/16", "3.5.0.0/16", "3.5.0.0/16", "3.5.0.0/16"]);
	});

	test("a 2xx request whose events are out of their order, or whose sample_ended is not its last clock read, breaks the contract", () => {
		const good = events(requestStream({ connection: "new", requests: [{}] }));
		const swapped = good.map((event) => ({ ...event }));
		const firstByte = swapped.findIndex((event) => event.event === "first_byte" && event.request === 1);
		const headers = swapped.findIndex((event) => event.event === "response_headers" && event.request === 1);
		[swapped[firstByte], swapped[headers]] = [swapped[headers] as (typeof swapped)[number], swapped[firstByte] as (typeof swapped)[number]];
		expect(readRequests(swapped).problems.join()).toContain("sample 1: a 2xx response whose events are");
		const late = good.map((event) => (event.event === "sample_ended" && event.sample === 1 ? { ...event, t: event.t + 1 } : event));
		expect(readRequests(late).problems).toEqual(["sample 1: sample_ended is not at response_ended's t"]);
	});

	test("the address block is the /16 of an IPv4 address; anything else is kept whole", () => {
		expect(addressBlock("52.219.176.66")).toBe("52.219.0.0/16");
		expect(addressBlock("2600:1f16::1")).toBe("2600:1f16::1");
	});
});

describe("percentiles, and the rule for which a count supports", () => {
	const ramp = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

	test("a percentile is reported only when n × (1000 − q) ≥ 1000", () => {
		expect([500, 900, 950, 990, 999].map(leastCount)).toEqual([2, 10, 20, 100, 1000]);
		expect(supports(99, 990)).toBe(false);
		expect(supports(100, 990)).toBe(true);
		expect(supports(999, 999)).toBe(false);
		expect(supports(1000, 999)).toBe(true);
		const forty = exactStats(ramp(40));
		expect(forty.p95).not.toBeNull();
		expect(forty.p99).toBeNull();
		expect(forty["p99.9"]).toBeNull();
		expect(forty.at_or_above.p99).toBeUndefined();
		const one = exactStats([5]);
		expect([one.count, one.min, one.max, one.p50]).toEqual([1, 5, 5, null]);
	});

	test("200 requests: the 99th percentile is R type 7's, and rests on the 2 requests ranked at or above it", () => {
		const stats = exactStats([...ramp(200)].reverse());
		// h = 199 × 0.99 = 197.01: x[197] + 0.01 × (x[198] − x[197]) = 198.01.
		expect(stats.p99).toBeCloseTo(198.01, 10);
		expect(stats.at_or_above.p99).toBe(2);
		expect(stats.p50).toBe(100.5);
		expect(stats.at_or_above.p50).toBe(100);
		expect(stats["p99.9"]).toBeNull();
		expect(atOrAbove(100, 990)).toBe(1);
		expect(atOrAbove(1000, 999)).toBe(1);
		expect(atOrAbove(101, 990)).toBe(2);
		// The same rule as Method series v1's percentile for whole percents.
		expect(percentileOfSorted(ramp(11), 950)).toBe(percentile(ramp(11), 95));
	});
});

describe("the histogram", () => {
	test("every time falls in exactly one bin, bins are contiguous, and no bin is wider than 1/64 of its least time", () => {
		let previousEnd = 0;
		for (let bin = 0; bin < 64 * 40; bin++) {
			expect(binLower(bin)).toBe(previousEnd);
			previousEnd = binLower(bin) + binWidth(bin);
			if (bin >= 128) expect(binWidth(bin) * 64).toBeLessThanOrEqual(binLower(bin));
			expect(binOf(binLower(bin))).toBe(bin);
			expect(binOf(binLower(bin) + binWidth(bin) - 1)).toBe(bin);
			expect(Math.abs(binValue(bin) - binLower(bin)) / Math.max(1, binLower(bin))).toBeLessThanOrEqual(TALLY_PRECISION);
		}
		expect(binOf(127)).toBe(127);
		expect(binOf(128)).toBe(128);
		expect(binOf(129)).toBe(128);
		expect(binOf(10_000_000_000)).toBe(binOf(10_000_000_000 + 1));
	});

	test("tallies of different Runs add: the sum is the tally of every time together", () => {
		const next = lcg(7);
		const runs = Array.from({ length: 5 }, () => Array.from({ length: 200 }, () => Math.floor(20_000_000 * (1 + 2 * next() ** 4))));
		const sum = new TallySum();
		for (const values of runs) sum.add(tallyOf(values));
		expect(sum.tally()).toEqual(tallyOf(runs.flat()));
	});

	test("a percentile read from a tally is within 0.78% of the exact one", () => {
		const next = lcg(11);
		for (const n of [2, 10, 37, 200, 1000, 5000]) {
			const values = Array.from({ length: n }, () => Math.floor(150_000 + 60_000_000 * next() ** 6));
			const exact = exactStats(values);
			const read = tallyStats(tallyOf(values));
			expect([read.count, read.min, read.max]).toEqual([exact.count, exact.min, exact.max]);
			expect(read.at_or_above).toEqual(exact.at_or_above);
			for (const name of ["p50", "p90", "p95", "p99", "p99.9"] as const) {
				if (exact[name] === null) {
					expect(read[name]).toBeNull();
					continue;
				}
				expect(Math.abs((read[name] as number) - (exact[name] as number)) / (exact[name] as number)).toBeLessThanOrEqual(TALLY_PRECISION);
			}
		}
	});
});

describe("Method requests v1 over Runs", () => {
	test("a Series of requests: each Run's statistics exactly, pooled across Runs from the tallies, every Run cited", async () => {
		const made = new HandMade();
		requestRun(made, { startedAt: "2026-11-11T21:35:00Z", stream: { connection: "new", requests: rampRequests(200, 20_000_000, 100_000) } });
		requestRun(made, { startedAt: "2026-11-12T03:35:00Z", stream: { connection: "new", requests: rampRequests(200, 21_000_000, 100_000) } });
		made.run({ startedAt: "2026-11-11T21:30:00Z" }); // memory_read: not a Series of requests
		const file = await derived(made);
		const s = only(file);
		expect(file.method).toEqual({ name: "requests", version: 1 });
		expect(s.series.benchmark).toBe("http_get");
		expect(s.runs.map((run) => run.path)).toEqual(s.points.map((point) => point.path));
		expect(s.runs.every((run) => /^[0-9a-f]{64}$/.test(run.sha256))).toBe(true);
		const [first, second] = s.points;
		expect(first?.counted).toBe(true);
		expect(first?.phases.total?.min).toBe(20_000_000);
		expect(first?.phases.total?.max).toBe(20_000_000 + 199 * 100_000);
		expect(first?.phases.total?.p50).toBe(20_000_000 + 99.5 * 100_000);
		expect(first?.phases.total?.p99).toBeCloseTo(20_000_000 + 197.01 * 100_000, 3);
		expect(first?.phases.dns?.count).toBe(200);
		expect(second?.phases.total?.min).toBe(21_000_000);
		const pooled = s.pool.phases.total;
		expect(pooled?.count).toBe(400);
		expect(pooled?.min).toBe(20_000_000);
		expect(pooled?.max).toBe(21_000_000 + 199 * 100_000);
		const exact = exactStats([...rampRequests(200, 20_000_000, 100_000), ...rampRequests(200, 21_000_000, 100_000)].map((_, i) => (i < 200 ? 20_000_000 + i * 100_000 : 21_000_000 + (i - 200) * 100_000)));
		for (const name of ["p50", "p90", "p95", "p99"] as const) expect(Math.abs((pooled?.[name] as number) / (exact[name] as number) - 1)).toBeLessThanOrEqual(TALLY_PRECISION);
		expect(pooled?.["p99.9"]).toBeNull();
		expect(pooled?.histogram.reduce((sum, [, n]) => sum + n, 0)).toBe(400);
		// The figures as they stood at each Run: the first Run's own pool, then everything.
		expect(first?.through?.runs).toBe(1);
		expect(first?.through?.phases.total).toEqual(tallyStats(tallyOf(Array.from({ length: 200 }, (_, i) => 20_000_000 + i * 100_000))));
		const { histogram: _histogram, ...withoutHistogram } = pooled as NonNullable<typeof pooled>;
		expect(second?.through?.phases.total).toEqual(withoutHistogram);
		expect(second?.group_through).toBeNull();
	});

	test("a reused connection's Series has no name lookup, connect or TLS phase", async () => {
		const made = new HandMade();
		requestRun(made, { startedAt: "2026-11-11T21:36:00Z", stream: { connection: "reused", requests: Array.from({ length: 30 }, () => ({})), requestsPerConnection: 100 } });
		const s = only(await derived(made));
		expect(Object.keys(s.pool.phases)).toEqual(["send", "first_byte", "headers", "body", "total"]);
		expect(s.pool.phases.first_byte?.min).toBe(DEFAULT_PHASES.first_byte);
	});

	test("a Run that exited 4 counts: its failed requests are counted by phase and kind and in no time, its succeeded requests are in the figures", async () => {
		const made = new HandMade();
		const stream = {
			connection: "new" as const,
			requests: [
				...rampRequests(17),
				{ fail: { phase: "first_byte" as const, error: "timeout" } },
				{ status: 503 },
				{ fail: { phase: "connect" as const, error: "refused" } },
			],
			warmup: { status: 403 },
		};
		requestRun(made, { startedAt: "2026-11-11T21:35:00Z", exit: { code: 4 }, stream });
		const s = only(await derived(made));
		const [point] = s.points;
		expect(point?.counted).toBe(true);
		expect(point?.exit_code).toBe(4);
		expect([point?.counted_requests, point?.succeeded, point?.failed]).toEqual([20, 17, 3]);
		expect(point?.failures).toEqual([
			{ phase: "connect", kind: "refused", count: 1 },
			{ phase: "first_byte", kind: "timeout", count: 1 },
			{ phase: "response", kind: "status_503", count: 1 },
		]);
		expect(point?.warmup_failure).toEqual({ phase: "response", kind: "status_403" });
		expect(point?.phases.total?.count).toBe(17);
		expect(point?.phases.total?.max).toBe(10_000_000 + 16 * 1_000_000);
		expect(s.pool.failed).toBe(3);
		expect(s.pool.failures.map((f) => f.count)).toEqual([1, 1, 1]);
		// Method series v1 keeps the same Run out: it counts only exit 0.
		const v1 = series.derive(made.files, await series.gather(made.files, made.fetch));
		expect(v1.derivations[0]?.points[0]?.failure).toBe("exit code 4");
	});

	test("a reused connection whose setup failed outside any sample counts the setup apart", async () => {
		const made = new HandMade();
		requestRun(made, { startedAt: "2026-11-11T21:36:00Z", exit: { code: 4 }, stream: { connection: "reused", requests: [{}, {}, {}], setupFailure: { phase: "tls", error: "reset" } } });
		const [point] = only(await derived(made)).points;
		expect(point?.counted).toBe(true);
		expect(point?.setups_failed).toEqual([{ phase: "tls", kind: "reset", count: 1 }]);
		expect(point?.failed).toBe(0);
	});

	test("a Run cut short, one killed, one whose stream stops, and an exit 0 with a failed request are shown, with why, in no figure", async () => {
		const made = new HandMade();
		requestRun(made, { startedAt: "2026-11-11T21:35:00Z", exit: { code: 4 }, stream: { connection: "new", requests: rampRequests(20), endedEarlyAfter: 12 } });
		requestRun(made, { startedAt: "2026-11-12T21:35:00Z", exit: { signal: 9, timeout_seconds: 300 }, stream: { connection: "new", requests: rampRequests(20), crashAfter: 7 } });
		requestRun(made, { startedAt: "2026-11-13T21:35:00Z", exit: { code: 0 }, stream: { connection: "new", requests: [...rampRequests(19), { fail: { phase: "body", error: "eof" } }] } });
		requestRun(made, { startedAt: "2026-11-14T21:35:00Z", exit: { code: 1 }, stream: { connection: "new", requests: [...rampRequests(19), { mismatch: true }] } });
		requestRun(made, { startedAt: "2026-11-15T21:35:00Z", stream: { connection: "new", requests: rampRequests(20) } });
		const s = only(await derived(made));
		const [short, killed, lying, mismatched, good] = s.points;
		expect(short?.counted).toBe(false);
		expect(short?.failure).toBe("expected 20 counted samples, found 12: the Run was cut short");
		expect(killed?.counted).toBe(false);
		expect(killed?.failure).toContain("killed by signal 9 (the runner's 300 s timeout)");
		expect(killed?.failure).toContain('the last event must be "finished"');
		expect(lying?.failure).toBe("exit code 0, which says every request succeeded, but 1 counted request failed");
		expect(mismatched?.failure).toContain("exit code 1");
		expect(mismatched?.failure).toContain("sample 20: a 200 response whose body did not match");
		expect(good?.counted).toBe(true);
		expect(s.pool.runs).toBe(1);
		expect(s.pool.phases.total?.count).toBe(20);
		for (const point of [short, killed, lying, mismatched]) expect([point?.succeeded, point?.failed, Object.keys(point?.phases ?? {}).length]).toEqual([0, 0, 0]);
		expect(short?.through).toBeNull();
		expect(good?.through?.runs).toBe(1);
	});

	test("the pooled figures are broken down by the server's address block and the cipher, where more than one occurs", async () => {
		const made = new HandMade();
		const near = { address: "52.219.176.66", phases: { connect: 150_000, first_byte: 20_000_000 } };
		const far = { address: "3.5.133.225", phases: { connect: 800_000, first_byte: 24_000_000 } };
		const chacha = { ...far, cipher: "TLS_CHACHA20_POLY1305_SHA256" };
		requestRun(made, { startedAt: "2026-11-11T21:35:00Z", stream: { connection: "new", requests: [...Array(30).fill(near), ...Array(60).fill(far)] } });
		requestRun(made, { startedAt: "2026-11-12T21:35:00Z", stream: { connection: "new", requests: [...Array(10).fill(chacha), ...Array(80).fill(far)] } });
		const s = only(await derived(made));
		expect(s.pool.by.map((b) => b.fact)).toEqual(["address_block", "cipher"]);
		const [blocks, ciphers] = s.pool.by;
		expect(blocks?.values.map((v) => [v.value, v.runs, v.requests])).toEqual([
			["3.5.0.0/16", 2, 150],
			["52.219.0.0/16", 1, 30],
		]);
		expect(blocks?.values[1]?.phases.connect?.max).toBe(150_000);
		expect(blocks?.values[0]?.phases.connect?.min).toBe(800_000);
		expect(blocks?.values[1]?.phases.first_byte?.p50).toBe(20_000_000);
		expect(ciphers?.values.map((v) => [v.value, v.runs, v.requests])).toEqual([
			["TLS_AES_128_GCM_SHA256", 2, 170],
			["TLS_CHACHA20_POLY1305_SHA256", 1, 10],
		]);
		// One value only: no breakdown.
		expect(s.pool.by.some((b) => b.fact === "tls_version")).toBe(false);
	});

	test("groups are series v1's, with the same letters, and each has its pool and its own figures through each Run", async () => {
		const made = new HandMade();
		["Xeon 8259CL", "Xeon 8375C", "Xeon 8259CL"].forEach((processor, i) =>
			requestRun(made, { startedAt: `2026-11-1${i + 1}T21:35:00Z`, processor, stream: { connection: "new", requests: rampRequests(20, 10_000_000 + i * 1_000_000) } }),
		);
		const s = only(await derived(made));
		const v1 = series.derive(made.files, await series.gather(made.files, made.fetch));
		expect(s.points.map((point) => point.group)).toEqual(v1.derivations[0]?.points.map((point) => point.group) as string[]);
		expect(s.groups.map((group) => [group.id, group.runs.length, group.pool.runs])).toEqual([
			["A", 2, 2],
			["B", 1, 1],
		]);
		expect(s.points[2]?.group_through?.runs).toBe(2);
		expect(s.points[2]?.through?.runs).toBe(3);
		expect(s.points[1]?.group_through?.phases.total?.min).toBe(11_000_000);
	});

	test("a Series is the Method's from its streams alone: a broken stream beside request Runs is shown failed; alone it is not a Series of requests", async () => {
		const made = new HandMade();
		requestRun(made, { startedAt: "2026-11-11T21:35:00Z", stream: { connection: "new", requests: rampRequests(5) } });
		made.run({ startedAt: "2026-11-12T21:35:00Z", benchmark: "http_get", binary: "http_get", params: requestRunParams(), samples: 5, stdout: "not json\n" });
		made.run({ startedAt: "2026-11-12T21:36:00Z", benchmark: "http_get", binary: "http_get", params: { ...requestRunParams(), object_bytes: 7 }, samples: 5, stdout: "not json\n" });
		// A benchmark of another name whose samples are requests is one too: no list of names.
		requestRun(made, { startedAt: "2026-11-11T21:37:00Z", benchmark: "https_get_elsewhere", stream: { connection: "new", requests: rampRequests(5) } });
		const file = await derived(made);
		expect(file.derivations.map((d) => [d.series.benchmark, d.points.length])).toEqual([
			["http_get", 2],
			["https_get_elsewhere", 1],
		]);
		expect(file.derivations[0]?.points[1]?.failure).toBe("stdout line 1 is not an event: not JSON; no events");
	});

	test("the same Runs give the same bytes, whatever order the files come in", async () => {
		const made = new HandMade();
		for (let i = 0; i < 6; i++) requestRun(made, { startedAt: `2026-11-1${i}T21:35:00Z`, stream: { connection: i % 2 === 0 ? "new" : "reused", requests: rampRequests(25, 10_000_000 + i * 10_000) } });
		const first = requests.serialize(await derived(made));
		const shuffled: RunFile[] = [...made.files].reverse();
		expect(requests.serialize(requests.derive(shuffled, await requests.gather(shuffled, made.fetch)))).toBe(first);
		expect(first.endsWith("}\n")).toBe(true);
		expect(JSON.parse(first)).toEqual(JSON.parse(JSON.stringify(await derived(made))));
	});
});

describe("the reduced record of a Run, kept between runs", () => {
	async function made(): Promise<HandMade> {
		const m = new HandMade();
		requestRun(m, { startedAt: "2026-11-11T21:35:00Z", exit: { code: 4 }, stream: { connection: "new", requests: [...rampRequests(30), { status: 500 }], warmup: { fail: { phase: "dns", error: "timeout" } } } });
		requestRun(m, { startedAt: "2026-11-11T21:36:00Z", stream: { connection: "reused", requests: rampRequests(30), requestsPerConnection: 7, reusedAddresses: ["16.12.64.242", "3.5.111.20"] } });
		requestRun(m, { startedAt: "2026-11-12T21:35:00Z", exit: { code: 4 }, stream: { connection: "new", requests: rampRequests(30), endedEarlyAfter: 4 } });
		m.run({ startedAt: "2026-11-11T21:30:00Z" });
		m.run({ startedAt: "2026-11-11T21:31:00Z", samplesNs: [1, 2, 3], crashAfter: 1, exit: { signal: 9 } });
		return m;
	}

	test("both Methods give the same bytes with no records, while making them, and from them alone, fetching no stream", async () => {
		const m = await made();
		const stdouts = new Set(m.files.map((file) => (file.record as { stdout: string }).stdout));
		const without = {
			requests: requests.serialize(requests.derive(m.files, await requests.gather(m.files, m.fetch))),
			series: series.serialize(series.derive(m.files, await series.gather(m.files, m.fetch))),
		};
		const store = memoryRecords();
		const making = {
			requests: requests.serialize(requests.derive(m.files, await requests.gather(m.files, m.fetch, { records: store }))),
			series: series.serialize(series.derive(m.files, await series.gather(m.files, m.fetch, { records: store }))),
		};
		expect(store.texts.size).toBe(2 * stdouts.size);
		const noStream = async (hash: string): Promise<Uint8Array | null> => {
			if (stdouts.has(hash)) throw new Error(`fetched stream ${hash}`);
			return m.fetch(hash);
		};
		const requestsGathered = await requests.gather(m.files, noStream, { records: store });
		const seriesGathered = await series.gather(m.files, noStream, { records: store });
		expect(requestsGathered.counts).toEqual({ fetched: 0, kept: stdouts.size });
		expect(seriesGathered.counts).toEqual({ fetched: 0, kept: stdouts.size });
		const kept = { requests: requests.serialize(requests.derive(m.files, requestsGathered)), series: series.serialize(series.derive(m.files, seriesGathered)) };
		expect(making).toEqual(without);
		expect(kept).toEqual(without);
	});

	test("a record is keyed by the stdout blob's hash and its reducer, Method name, version and revision", async () => {
		const m = await made();
		const store = memoryRecords();
		await requests.gather(m.files, m.fetch, { records: store });
		await series.gather(m.files, m.fetch, { records: store });
		expect(REQUESTS_RECORD_KEY).toBe("requests-v1-r1");
		expect(SERIES_RECORD_KEY).toBe("series-v1-r1");
		for (const key of store.texts.keys()) expect(key).toMatch(/^(requests-v1-r1|series-v1-r1)\/sha256:[0-9a-f]{64}$/);
	});

	test("a damaged record, or one of another blob or reducer, is ignored and the stream read again", async () => {
		const m = await made();
		const store = memoryRecords();
		const expected = requests.serialize(requests.derive(m.files, await requests.gather(m.files, m.fetch, { records: store })));
		const keys = [...store.texts.keys()].filter((key) => key.startsWith("requests-"));
		const [a, b, c] = keys as [string, string, string];
		store.texts.set(a, JSON.stringify({ ...JSON.parse(store.texts.get(a) as string), record: { holds_requests: "yes" } }));
		store.texts.set(b, store.texts.get(c) as string); // another blob's record under this blob's key
		const gathered = await requests.gather(m.files, m.fetch, { records: store });
		expect(gathered.counts.fetched).toBe(2);
		expect(requests.serialize(requests.derive(m.files, gathered))).toBe(expected);
	});

	test("a record holds no time of any single request: its size grows with the bins, not the requests", () => {
		const few = reduceRequests(bytes(requestStream({ connection: "new", requests: rampRequests(200, 20_000_000, 1_000) })));
		const many = reduceRequests(bytes(requestStream({ connection: "new", requests: Array.from({ length: 2000 }, (_, i) => ({ phases: { first_byte: 20_000_000 + (i % 200) * 1_000 } })) })));
		const size = (record: unknown): number => JSON.stringify(REQUESTS_RECORD.toJson(record as never)).length;
		expect(many.succeeded).toBe(2000);
		expect(size(many)).toBeLessThan(size(few) * 1.2);
	});
});

/** The params of the 4 KiB new-connection set. */
function requestRunParams(): Record<string, string | number> {
	return { object_bytes: 4096, key: "http_get/v1/4096", connection: "new", budget_seconds: 240, gap_mean_ms: 200, timeout_ms: 10000, ca_file: "/etc/pki/tls/certs/ca-bundle.crt", resolv_conf: "/etc/resolv.conf", auth: "sigv4" };
}
