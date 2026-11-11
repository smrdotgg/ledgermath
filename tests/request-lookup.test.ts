import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";

import { checkAnswer } from "../scripts/lib/answer-check";
import { requestFailedCitation, requestRunsCitation, requestStatCitation, requestTailCitation, resolveCitation, seriesMoment } from "../scripts/lib/citation";
import { type LedgerData, loadLedger, openLocation } from "../scripts/lib/ledger-data";
import { about, aboutText, listSeries, seriesListText, showSeries, showText } from "../scripts/lib/lookup";
import * as requests from "../methods/requests/v1";
import * as series from "../methods/v1";
import { HandMade, rampRequests, requestRun } from "./hand-made-requests";
import { makeRequestFixture, type RequestFixture } from "./request-lookup-fixtures";

setDefaultTimeout(120_000);

let fixture: RequestFixture;
let data: LedgerData;
let bare: RequestFixture;
let bareData: LedgerData;

beforeAll(async () => {
	fixture = await makeRequestFixture();
	data = await loadLedger(openLocation(fixture.directory));
	bare = await makeRequestFixture({ withoutRequests: true });
	bareData = await loadLedger(openLocation(bare.directory));
});
afterAll(() => {
	rmSync(fixture.directory, { recursive: true, force: true });
	rmSync(bare.directory, { recursive: true, force: true });
});

const inside = (citation: string): string => citation.slice("[lm:".length, -1);
/** Four significant digits of a time in ms, as an answer would write it. */
const ms = (ns: number): string => `${Number((ns / 1e6).toPrecision(4))} ms`;

/** Every { value, citation } the answer holds, at any depth. */
function cited(value: unknown, found: Array<{ value: number; citation: string }> = []): Array<{ value: number; citation: string }> {
	if (Array.isArray(value)) for (const item of value) cited(item, found);
	else if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		if (typeof record.citation === "string" && typeof record.value === "number") found.push({ value: record.value, citation: record.citation });
		for (const item of Object.values(record)) cited(item, found);
	}
	return found;
}

describe("the lookup tool and Series of requests", () => {
	test("about says what percentiles it holds: across Runs to the 95th, across requests to the 99th and 99.9th", () => {
		const text = aboutText(data, about(data));
		expect(text).toContain("Percentiles across Runs: the 5th, 50th and 95th of every Series (Method series); no 99th percentile across Runs.");
		expect(text).toContain("Percentiles across requests (Method requests): 2 Series of requests");
		const without = aboutText(bareData, about(bareData));
		expect(without).toContain("Percentiles across requests: none in this data (no requests-derivations.json), so no 99th percentile at all.");
	});

	test("series marks the Series that have percentiles across requests", () => {
		const text = seriesListText(data, listSeries(data, ["http_get"]));
		expect(text.match(/percentiles across requests: show it/g)?.length).toBe(2);
		expect(seriesListText(data, listSeries(data, ["memory_read"]))).not.toContain("percentiles across requests");
	});

	test("show gives each phase's percentiles across requests, how many requests stand at or above each tail figure, and every citation resolves to the number beside it", async () => {
		const answer = showSeries(data, [fixture.small.series.id], 10);
		if (answer.found !== "one") throw new Error("expected one Series");
		const figures = answer.series.request_figures;
		expect(figures).not.toBeNull();
		const total = figures?.pool.phases.find((phase) => phase.phase === "total");
		const p99 = total?.percentiles.find((pct) => pct.name === "p99");
		expect(p99?.value?.value).toBe(fixture.small.pool.phases.total?.p99 as number);
		expect(p99?.at_or_above?.value).toBe(fixture.small.pool.phases.total?.at_or_above.p99 as number);
		expect(total?.count.value).toBe(399);
		expect(figures?.pool.failed?.value).toBe(1);
		expect(figures?.by.map((b) => [b.fact, b.values.map((v) => v.value)])).toEqual([["address_block", ["3.5.0.0/16", "52.219.0.0/16"]]]);
		const all = cited(figures);
		expect(all.length).toBeGreaterThan(100);
		for (const { value, citation } of all) {
			const resolved = await resolveCitation(inside(citation), data);
			if (!resolved.ok) throw new Error(`${citation}: ${resolved.reason}`);
			expect(resolved.kind === "requests" ? resolved.value : Number.NaN).toBe(value);
		}
		const text = showText(data, answer);
		expect(text).toContain("Percentiles across requests, Method requests version 1");
		expect(text).toContain(`p99   ${(p99?.value?.text ?? "").padEnd(14)} ${p99?.value?.citation}, 4 requests at or above it ${p99?.at_or_above?.citation}`);
		expect(text).toContain(
			"Note: What the Runs record: params auth=sigv4 budget_seconds=240 ca_file=/etc/pki/tls/certs/ca-bundle.crt connection=new gap_mean_ms=200 key=http_get/v1/4096 object_bytes=4096 resolv_conf=/etc/resolv.conf timeout_ms=10000; the Service s3_fixtures, with the inputs endpoint=https://fixtures.s3.us-east-2.amazonaws.com region=us-east-2 as delivered to the binary; the box in Region us-east-2, as its provider names it.",
		);
		expect(text).toContain(
			"Note: What the succeeded requests' own events show: requests sent as GET /http_get/v1/4096; signing AWS4-HMAC-SHA256; each opened a connection of its own (a name lookup, connect and TLS handshake in its time); TLS version TLSv1.3; cipher TLS_AES_128_GCM_SHA256; key-exchange group X25519MLKEM768; server address block 3.5.0.0/16 and 52.219.0.0/16 (both among them).",
		);
		expect(text).toContain("Note: The path between the box and the server is not stated here: each Run's dumps record it (sections network, ec2_route_tables and ec2_vpc_endpoints).");
		expect(text).not.toMatch(/internet gateway|same Region|SigV4/);
	});

	test("a percentile the requests cannot support is not given, and says why", () => {
		const answer = showSeries(data, [fixture.big.series.id], 10);
		if (answer.found !== "one") throw new Error("expected one Series");
		const total = answer.series.request_figures?.pool.phases.find((phase) => phase.phase === "total");
		expect(total?.percentiles.find((pct) => pct.name === "p99")?.not_reported).toBe("not reported: 40 requests, and a 99th percentile needs at least 100");
		expect(showText(data, answer)).toContain("p99   not reported: 40 requests, and a 99th percentile needs at least 100");
	});

	test("a Series without requests says it holds no 99th percentile, which is true", () => {
		const answer = showSeries(data, [fixture.memory], 10);
		if (answer.found !== "one") throw new Error("expected one Series");
		expect(answer.series.request_figures).toBeNull();
		expect(showText(data, answer)).toContain("LedgerMath holds no 99th percentile of this Series: its percentiles are across Runs (5th, 50th, 95th).");
	});
});

describe("what the tool says a Series of requests measured", () => {
	async function notesOf(build: (made: HandMade) => void): Promise<string> {
		const made = new HandMade();
		build(made);
		const v1 = series.derive(made.files, await series.gather(made.files, made.fetch));
		const r = requests.derive(made.files, await requests.gather(made.files, made.fetch));
		const loaded = { ...data, derivations: v1, requests: r, requestsFrom: "made by hand" } as LedgerData;
		const answer = showSeries(loaded, [r.derivations[0]?.series.id as string], 1);
		if (answer.found !== "one") throw new Error("expected one Series");
		return (answer.series.request_figures?.notes ?? []).join("\n");
	}

	test("unsigned requests are said to be unsigned, from their own events, and nothing is said of the path", async () => {
		const notes = await notesOf((made) => requestRun(made, { startedAt: "2026-11-11T21:35:00Z", stream: { connection: "new", auth: "none", requests: rampRequests(100) } }));
		expect(notes).toContain("params auth=none ");
		expect(notes).toContain("signing unsigned;");
		expect(notes).not.toMatch(/SigV4|AWS4-HMAC|internet gateway|same Region/);
	});

	test("a benchmark of another name whose stream qualifies is described by what its Runs record: no Service, kept connections, no S3", async () => {
		const notes = await notesOf((made) =>
			requestRun(made, { startedAt: "2026-11-11T21:35:00Z", benchmark: "https_get_elsewhere", service: null, stream: { connection: "reused", requests: rampRequests(30) } }),
		);
		expect(notes).toContain("the Runs name no Service; the box in Region us-east-2, as its provider names it.");
		expect(notes).toContain("each went over a connection kept open from before it (no name lookup, connect or TLS in its time)");
		expect(notes).not.toMatch(/S3|s3_fixtures|internet gateway|same Region|SigV4/);
	});
});

describe("citations of Method requests", () => {
	test("resolve as of the Series' newest Run, and as of an earlier Run from the figures as they stood then", async () => {
		const id = fixture.small.series.id;
		const moment = seriesMoment(fixture.small);
		const now = await resolveCitation(inside(requestStatCitation(id, "first_byte", "p99", 1, moment)), data);
		expect(now.ok && now.kind === "requests" ? [now.value, now.asOf, now.runs] : null).toEqual([fixture.small.pool.phases.first_byte?.p99 as number, "current", 2]);
		const first = fixture.small.points[0];
		const then = await resolveCitation(inside(requestStatCitation(id, "first_byte", "p99", 1, "2026-11-12T22:20:00Z")), data);
		expect(then.ok && then.kind === "requests" ? [then.value, then.asOf, then.runs] : null).toEqual([first?.through?.phases.first_byte?.p99 as number, "earlier", 1]);
		const runs = await resolveCitation(inside(requestRunsCitation(id, 1, moment)), data);
		expect(runs.ok && runs.kind === "requests" ? [runs.value, runs.countsRuns] : null).toEqual([2, true]);
		const failed = await resolveCitation(inside(requestFailedCitation(id, 1, moment, null, { phase: "first_byte", kind: "timeout" })), data);
		expect(failed.ok && failed.kind === "requests" ? failed.value : null).toBe(1);
		const block = await resolveCitation(inside(requestStatCitation(id, "connect", "max", 1, moment, { fact: "address_block", value: "52.219.0.0/16" })), data);
		expect(block.ok && block.kind === "requests" ? block.value : null).toBe(150_000);
	});

	test("say why when they do not resolve", async () => {
		const id = fixture.small.series.id;
		const moment = seriesMoment(fixture.small);
		const reason = async (citation: string): Promise<string> => {
			const resolved = await resolveCitation(citation.startsWith("[lm:") ? inside(citation) : citation, data);
			return resolved.ok ? "resolved" : resolved.reason;
		};
		expect(await reason(requestStatCitation(fixture.big.series.id, "total", "p99", 1, seriesMoment(fixture.big)))).toContain("its 99th percentile is not reported: 40 requests, and it needs at least 100");
		expect(await reason(requestStatCitation(id, "total", "p99.9", 1, moment))).toContain("its 99.9th percentile is not reported: 399 requests, and it needs at least 1000");
		expect(await reason(requestStatCitation(id, "total", "p99", 2, moment))).toContain("it cites Method requests version 2");
		expect(await reason(requestStatCitation(id, "total", "p99", 1, "2026-11-14T00:00:00Z"))).toContain("data the checker does not have");
		expect(await reason(requestStatCitation(id, "connect", "p50", 1, "2026-11-12T22:20:00Z", { fact: "address_block", value: "3.5.0.0/16" }))).toContain("held only as of Series");
		expect(await reason(requestStatCitation(id, "connect", "p50", 1, moment, { fact: "cipher", value: "TLS_AES_128_GCM_SHA256" }))).toContain("had one cipher only");
		expect(await reason(`requests/${id}/total/p99`)).toContain("with @v<version>,<moment> at its end");
		expect(await reason(`requests/${id}/total/max/at_or_above@v1,${moment}`)).toContain("at_or_above follows a percentile");
		const missing = await resolveCitation(inside(requestStatCitation(id, "total", "p99", 1, moment)), bareData);
		expect(missing.ok ? "" : missing.reason).toContain("the data loaded hold no Derivations of Method requests");
		// Method series v1 still holds no 99th percentile.
		expect(await reason(`series/${id}/time_per_repetition_ns/p99@v1,${moment}`)).toContain("not a LedgerMath citation");
	});
});

describe("the answer checker and figures of requests", () => {
	function answer(lines: (c: { id: string; moment: string; total: NonNullable<RequestFixture["small"]["pool"]["phases"]["total"]>; run: string }) => string[]): string {
		const s = fixture.small;
		const total = s.pool.phases.total as NonNullable<typeof s.pool.phases.total>;
		return lines({ id: s.series.id, moment: seriesMoment(s), total, run: s.points[0]?.path as string }).join("\n");
	}

	const good = (): string => answer(({ id, moment, total, run }) => [
		"The 99th percentile of a GET of the small object over a new connection:",
		`- 99th percentile of the whole request: ${ms(total.p99 as number)} ${requestStatCitation(id, "total", "p99", 1, moment)}`,
		`- it rests on ${total.at_or_above.p99} requests ranked at or above it ${requestTailCitation(id, "total", "p99", 1, moment)}`,
		`- out of ${total.count} requests ${requestStatCitation(id, "total", "count", 1, moment)}, from 2 Runs ${requestRunsCitation(id, 1, moment)}`,
		`- 1 request failed ${requestFailedCitation(id, 1, moment)}, and is in no time`,
		`- the median: ${ms(total.p50 as number)} ${requestStatCitation(id, "total", "p50", 1, moment)}; the requests to 52.219.0.0/16 connected faster than those to 3.5.0.0/16`,
		`Sources: ${run}`,
	]);

	test("a figure written with its citation, in its unit, with a Run of its Series linked, passes", async () => {
		const report = await checkAnswer(good(), data, "What is the 99th-percentile time of a 4 KiB GET from S3 over a new connection?");
		expect(report.problems).toEqual([]);
		expect(report.pass).toBe(true);
		expect(report.numbers.filter((n) => n.status === "cited").length).toBe(6);
	});

	test("a wrong value, a wrong unit, a wrong percentile, a count of Runs cited as requests, and no Run linked, each fail", async () => {
		const s = fixture.small;
		const total = s.pool.phases.total as NonNullable<typeof s.pool.phases.total>;
		const p99 = requestStatCitation(s.series.id, "total", "p99", 1, seriesMoment(s));
		const p95 = requestStatCitation(s.series.id, "total", "p95", 1, seriesMoment(s));
		const link = s.points[0]?.path as string;
		const cases: Array<[string, string]> = [
			[`${ms((total.p99 as number) * 1.05)} ${p99}\n${link}`, "is not what its citation"],
			[`${Number(((total.p99 as number) / 1e6).toPrecision(4))} µs ${p99}\n${link}`, "is not what its citation"],
			[`${Number(((total.p99 as number) / 1e6).toPrecision(4))} ${p99}\n${link}`, "it has no unit; the citation is in ns"],
			[`${ms(total.p99 as number)} ${p95}\n${link}`, "is not what its citation"],
			[`${ms(total.p95 as number)} ${p99}\n${link}`, "is not what its citation"],
			[`from 399 Runs ${requestStatCitation(s.series.id, "total", "count", 1, seriesMoment(s))}\n${link}`, "a count of Runs or boots is cited with the Series' count citation"],
			[`${ms(total.p99 as number)} ${p99}`, "the answer links none of its Runs"],
			[`${ms(1e6)} ${requestStatCitation(fixture.big.series.id, "total", "p99", 1, seriesMoment(fixture.big))}\n${fixture.big.points[0]?.path}`, "is not reported"],
		];
		for (const [text, problem] of cases) {
			const report = await checkAnswer(text, data);
			expect(report.pass).toBe(false);
			expect(report.problems.map((p) => p.message).join("\n")).toContain(problem);
		}
	});

	test("a citation of an earlier moment is checked against the figures as they stood then, with a note", async () => {
		const s = fixture.small;
		const first = s.points[0]?.through?.phases.total;
		const text = `${ms(first?.p99 as number)} ${requestStatCitation(s.series.id, "total", "p99", 1, "2026-11-12T22:20:00Z")}\n${s.points[0]?.path}`;
		const report = await checkAnswer(text, data);
		expect(report.problems).toEqual([]);
		expect(report.notes.map((n) => n.message).join("\n")).toContain("checked against the 1 counted Runs that started by 2026-11-12T22:20:00Z");
	});
});
