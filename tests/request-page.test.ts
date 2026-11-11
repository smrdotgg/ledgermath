import { describe, expect, setDefaultTimeout, test } from "bun:test";

import * as requests from "../methods/requests/v1";
import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import * as series from "../methods/v1";
import type { DerivationsFile } from "../methods/v1/output";
import { renderPage, seriesLabel } from "../scripts/build-page";
import { CHAR_WIDTH } from "../scripts/lib/chart";
import { curvePoints, logTicks, renderDistributionChart, renderTimeChart } from "../scripts/lib/request-charts";
import { RUNS_REPOSITORY_BLOB_URL } from "../scripts/lib/runs-repository";
import { HandMade, rampRequests, requestRun } from "./hand-made-requests";

setDefaultTimeout(180_000);

const BASE = RUNS_REPOSITORY_BLOB_URL;

async function both(made: HandMade): Promise<{ v1: DerivationsFile; requests: RequestsFile }> {
	return {
		v1: series.derive(made.files, await series.gather(made.files, made.fetch)),
		requests: requests.derive(made.files, await requests.gather(made.files, made.fetch)),
	};
}

function sample(): HandMade {
	const made = new HandMade();
	requestRun(made, { startedAt: "2026-11-11T21:35:00Z", stream: { connection: "new", requests: rampRequests(200, 20_000_000, 50_000) } });
	requestRun(made, {
		startedAt: "2026-11-12T03:35:00Z",
		exit: { code: 4 },
		stream: { connection: "new", requests: [...rampRequests(197, 21_000_000, 50_000), { status: 503 }, { status: 503 }, { fail: { phase: "first_byte", error: "timeout" } }] },
	});
	requestRun(made, { startedAt: "2026-11-12T09:35:00Z", exit: { code: 4 }, stream: { connection: "new", requests: rampRequests(200), endedEarlyAfter: 50 } });
	requestRun(made, { startedAt: "2026-11-11T21:36:00Z", objectBytes: 16777216, stream: { connection: "new", requests: rampRequests(40, 170_000_000, 100_000) } });
	made.run({ startedAt: "2026-11-11T21:30:00Z" });
	return made;
}

/** The request part's Series sections, by Series id. */
function sections(html: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const match of html.matchAll(/<section class="series requests" id="r-([0-9a-f]+)">([\s\S]*?)<\/section>/g)) found.set(match[1] as string, match[2] as string);
	return found;
}

const svgs = (html: string): string[] => [...html.matchAll(/<svg class="chart"[\s\S]*?<\/svg>/g)].map((match) => match[0]);
const links = (svg: string): string[] => [...svg.matchAll(/<a href="([^"]*)">/g)].map((match) => (match[1] as string).replaceAll("&amp;", "&"));

function checkNoExternalReference(html: string, files: Array<{ derivations: Array<{ points: Array<{ path: string }> }> }>): void {
	const runLinks = new Set(files.flatMap((file) => file.derivations.flatMap((d) => d.points.map((point) => BASE + point.path))));
	for (const match of html.matchAll(/\b(?:href|src|xlink:href|action|srcset|poster|data)\s*=\s*"([^"]*)"/gi)) {
		const target = (match[1] as string).replaceAll("&amp;", "&");
		if (!target.startsWith("#")) expect(runLinks.has(target)).toBe(true);
	}
	expect(html).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|@import|url\(|src=/i);
	const tagsAndStyle = [...html.matchAll(/<[^>]*>/g)].map((match) => match[0]).join("\n");
	for (const address of tagsAndStyle.matchAll(/(?:https?:)?\/\/[^\s"'<>)]+/g)) expect(address[0].startsWith(BASE)).toBe(true);
}

/** Every label in an SVG lies inside it, at the widest a character can be. */
function checkLabelsFit(svg: string): void {
	const width = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)?.[1]);
	for (const match of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
		const attributes = match[1] as string;
		const content = (match[2] as string).replaceAll("&amp;", "&");
		const x = Number(/\bx="([-\d.]+)"/.exec(attributes)?.[1]);
		const anchor = /text-anchor="(\w+)"/.exec(attributes)?.[1] ?? "start";
		const w = [...content].length * CHAR_WIDTH;
		const x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
		if (x0 < 0 || x0 + w > width) throw new Error(`"${content}" reaches from ${x0} to ${x0 + w}, outside 0 to ${width}`);
	}
}

describe("the page's part for Series of requests", () => {
	test("each Series has a chart of the whole request and of the first byte over time, every Run once a link to its Run file, and a distribution", async () => {
		const { v1, requests: file } = await both(sample());
		const html = renderPage(v1, { runUrlBase: BASE, requests: file });
		const bySeries = sections(html);
		expect(bySeries.size).toBe(file.derivations.length);
		for (const derivation of file.derivations) {
			const section = bySeries.get(derivation.series.id) as string;
			expect(section).toContain(`<h2>${seriesLabel(derivation.series).replaceAll("&", "&amp;")}: per request</h2>`);
			const charts = svgs(section);
			expect(charts.length).toBe(3);
			const expected = derivation.points.map((point) => BASE + point.path);
			expect(links(charts[0] as string)).toEqual(expected);
			expect(links(charts[1] as string)).toEqual(expected);
			expect(links(charts[2] as string)).toEqual([]);
			expect(section).toContain(`href="#s-${derivation.series.id}"`);
			for (const chart of charts) checkLabelsFit(chart);
		}
		expect(html).toContain('<section class="requests-part" id="requests">');
		expect(html).toContain("Method requests, version 1");
	});

	test("says how many requests stand at or above the tail, and shows no percentile the count cannot support", async () => {
		const { v1, requests: file } = await both(sample());
		const html = renderPage(v1, { runUrlBase: BASE, requests: file });
		const big = file.derivations.find((d) => d.series.params.object_bytes === 16777216);
		const small = file.derivations.find((d) => d.series.params.object_bytes === 4096);
		const bigSection = sections(html).get(big?.series.id as string) as string;
		expect(bigSection).toContain("Of the 40 whole requests, the 99th percentile is not reported (it needs 100 requests)");
		expect(bigSection).toContain("not reported: 40 requests; a 99th percentile needs at least 100");
		const smallSection = sections(html).get(small?.series.id as string) as string;
		expect(small?.pool.phases.total?.count).toBe(397);
		expect(smallSection).toContain("Of the 397 whole requests, 4 requests are ranked at or above the 99th percentile");
	});

	test("shows failed requests as counts, a counted Run that exited 4 as counted, and a Run cut short as failed, with why", async () => {
		const { v1, requests: file } = await both(sample());
		const html = renderPage(v1, { runUrlBase: BASE, requests: file });
		const small = file.derivations.find((d) => d.series.params.object_bytes === 4096);
		const section = sections(html).get(small?.series.id as string) as string;
		expect(section).toContain("3 counted requests failed in the 2 counted Runs, in no time; 397 requests succeeded.");
		expect(section).toContain("<tr><td>first_byte</td><td>timeout</td><td class=\"n\">1</td></tr>");
		expect(section).toContain("<tr><td>response</td><td>status_503</td><td class=\"n\">2</td></tr>");
		expect(section).toContain("counted (exit 4)");
		expect(section).toContain("expected 200 counted samples, found 50: the Run was cut short");
		// The time chart's lane: the Run with 3 failed requests says 3.
		expect(svgs(section)[0]).toMatch(/fill="#B00020">3<\/text>/);
	});

	test("version 1's part is the same bytes with the requests' part as without it", async () => {
		const { v1, requests: file } = await both(sample());
		const alone = renderPage(v1, { runUrlBase: BASE });
		const withRequests = renderPage(v1, { runUrlBase: BASE, requests: file });
		const stripped = withRequests
			.replace(/\n<p class="meta"><a href="#requests">[^\n]*<\/p>/, "")
			.replace(/\n<section class="requests-part" id="requests">[\s\S]*<\/section>(?=\n<\/body>)/, "");
		expect(stripped).toBe(alone);
		expect(withRequests.length).toBeGreaterThan(alone.length);
	});

	test("opens from disk: no script, stylesheet, image or address but the Runs'", async () => {
		const { v1, requests: file } = await both(sample());
		checkNoExternalReference(renderPage(v1, { runUrlBase: BASE, requests: file }), [v1, file]);
	});

	test("the same Derivations give the same bytes", async () => {
		const { v1, requests: file } = await both(sample());
		expect(renderPage(v1, { runUrlBase: BASE, requests: file })).toBe(renderPage(structuredClone(v1), { runUrlBase: BASE, requests: structuredClone(file) }));
	});

	test("refuses Derivations of a Method it does not know", async () => {
		const { v1, requests: file } = await both(sample());
		const other = { ...file, method: { name: "requests", version: 2 } } as unknown as RequestsFile;
		expect(() => renderPage(v1, { runUrlBase: BASE, requests: other })).toThrow("Method requests version 1");
	});
});

describe("the request charts stay legible", () => {
	test("with one Run", async () => {
		const made = new HandMade();
		requestRun(made, { startedAt: "2026-11-11T21:35:00Z", stream: { connection: "reused", requests: rampRequests(30) } });
		const { v1, requests: file } = await both(made);
		const html = renderPage(v1, { runUrlBase: BASE, requests: file });
		const charts = svgs(html.slice(html.indexOf('id="requests"')));
		expect(charts.length).toBe(3);
		for (const chart of charts) checkLabelsFit(chart);
	});

	test("with three thousand Runs over two years: one link per Run, small markers, labels inside", () => {
		const runs = Array.from({ length: 3000 }, (_, i) => ({
			x: Date.parse("2026-11-11T22:10:00Z") + i * 6 * 3_600_000,
			values: [25e6 + (i % 13) * 1e5, 33e6 + (i % 7) * 1e5, i % 50 === 0 ? 2.5e9 : 47e6],
			failed: i % 97 === 0,
			failedRequests: i % 31 === 0 ? 2 : 0,
			href: `${BASE}runs/x/${i}.json`,
			title: `Run ${i}`,
		}));
		const svg = renderTimeChart({ runs, stats: ["p50", "p95", "p99"], label: "many" });
		expect(links(svg).length).toBe(3000);
		expect(svg).toContain('r="2.2"');
		checkLabelsFit(svg);
		// Two orders of magnitude on one axis, from 25 ms to 2.5 s.
		expect(svg).toContain(">30 ms</text>");
		expect(svg).toContain(">1 s</text>");
	});

	test("a distribution reaches each phase's slowest request and never a share of 1", () => {
		const curve = { name: "whole request", colour: "#0072B2", count: 200, min: 20_000_000, max: 60_000_000, bins: [[1000, 100], [1010, 98], [1100, 2]] as Array<[number, number]> };
		const points = curvePoints(curve);
		expect(points[0]?.ns).toBe(20_000_000);
		expect(points.at(-1)?.ns).toBe(60_000_000);
		expect(points.at(-1)?.height).toBeCloseTo(-Math.log10(1 - 199 / 200), 10);
		const svg = renderDistributionChart({ curves: [curve, { ...curve, name: "send", min: 3_000, max: 9_000, bins: [[400, 200]] }], label: "two" });
		checkLabelsFit(svg);
		expect(svg).toContain(">99%</text>");
		expect(logTicks(3_000, 60_000_000, 10).length).toBeLessThanOrEqual(10);
	});
});
