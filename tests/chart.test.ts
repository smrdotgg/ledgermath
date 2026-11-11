import { describe, expect, test } from "bun:test";

import { derive, gather } from "../methods/v1";
import { renderPage } from "../scripts/build-page";
import { CHAR_WIDTH, FONT_SIZE, renderChart } from "../scripts/lib/chart";
import { RUNS_REPOSITORY_BLOB_URL } from "../scripts/lib/runs-repository";
import { HandMade, type HandMadeRun } from "./hand-made-runs";

/**
 * The widest a character of a label can be at the charts' 11 px: digits are
 * about 6.1 px in common sans-serif faces, G about 8.6, and labels are mostly
 * digits. Kept here apart from the chart's own figure, which may not exceed it.
 */
const WIDEST_CHARACTER = 7;

interface Label {
	x0: number;
	x1: number;
	y: number;
	content: string;
}

const unescape = (text: string): string =>
	text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");

/** Every text in an SVG, with how far it reaches either side. */
function labels(svg: string): Label[] {
	return [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((match) => {
		const attributes = match[1] as string;
		const content = unescape(match[2] as string);
		const x = Number(/\bx="([-\d.]+)"/.exec(attributes)?.[1]);
		const y = Number(/\by="([-\d.]+)"/.exec(attributes)?.[1]);
		const anchor = /text-anchor="(\w+)"/.exec(attributes)?.[1] ?? "start";
		const width = [...content].length * WIDEST_CHARACTER;
		const x0 = anchor === "end" ? x - width : anchor === "middle" ? x - width / 2 : x;
		return { x0, x1: x0 + width, y, content };
	});
}

function charts(html: string): string[] {
	return [...html.matchAll(/<svg class="chart"[\s\S]*?<\/svg>/g)].map((match) => match[0]);
}

function checkFits(svg: string): Label[] {
	const width = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)?.[1]);
	expect(width).toBeGreaterThan(0);
	const found = labels(svg);
	expect(found.length).toBeGreaterThan(0);
	for (const label of found) {
		if (label.x0 < 0 || label.x1 > width) throw new Error(`"${label.content}" reaches from ${label.x0} to ${label.x1}, outside 0 to ${width}`);
	}
	// The time labels along the bottom do not run into one another either.
	const bottom = Math.max(...found.map((label) => label.y));
	const times = found.filter((label) => label.y === bottom).sort((a, b) => a.x0 - b.x0);
	for (let i = 1; i < times.length; i++) {
		if ((times[i] as Label).x0 < (times[i - 1] as Label).x1) throw new Error(`"${times[i - 1]?.content}" runs into "${times[i]?.content}"`);
	}
	return found;
}

async function page(runs: HandMadeRun[]): Promise<string> {
	const made = new HandMade();
	for (const run of runs) made.run(run);
	return renderPage(derive(made.files, await gather(made.files, made.fetch)), { runUrlBase: RUNS_REPOSITORY_BLOB_URL });
}

describe("every label in a chart fits inside it", () => {
	test("the chart lays labels out with a character no wider than this test allows", () => {
		expect(CHAR_WIDTH).toBeGreaterThanOrEqual(WIDEST_CHARACTER);
		expect(FONT_SIZE).toBe(11);
	});

	test("one Run", async () => {
		const [svg] = charts(await page([{ startedAt: "2026-11-10T23:37:56Z" }]));
		checkFits(svg as string);
	});

	test("sixteen Runs over two boots either side of midnight, as in the real Runs", async () => {
		const runs: HandMadeRun[] = [];
		for (let i = 0; i < 8; i++) runs.push({ startedAt: new Date(Date.parse("2026-11-10T23:36:41Z") + i * 17_000).toISOString(), samplesNs: [1000 + i] });
		for (let i = 0; i < 8; i++) runs.push({ startedAt: new Date(Date.parse("2026-11-11T00:23:30Z") + i * 17_000).toISOString(), samplesNs: [1010 + i] });
		const html = await page(runs);
		const [svg] = charts(html);
		const found = checkFits(svg as string);
		// The label the verifier saw clipped is there, inside.
		expect(found.map((label) => label.content)).toContain("2026-11-11 12:00");
	});

	test("three hundred Runs over a hundred days", async () => {
		const runs: HandMadeRun[] = Array.from({ length: 300 }, (_, i) => ({
			startedAt: new Date(Date.parse("2026-01-01T22:15:00Z") + i * 8 * 3_600_000).toISOString(),
			samplesNs: [100_000 + (i % 7) * 100],
			exit: i % 50 === 49 ? { code: 1 } : { code: 0 },
		}));
		for (const svg of charts(await page(runs))) checkFits(svg);
	});

	test("long y labels widen the left margin rather than run off the edge", () => {
		const points = Array.from({ length: 20 }, (_, i) => ({
			x: Date.parse("2026-11-10T00:00:00Z") + i * 3_600_000,
			y: 123_456_789.123 + i * 0.001,
			group: 0,
			href: "#",
			title: "",
		}));
		checkFits(renderChart({ points, medians: [], unit: { name: "B/s", scale: 1 }, label: "long labels" }));
	});

	test("Runs years apart", () => {
		const points = [0, 1, 2, 3].map((i) => ({ x: Date.parse("2026-01-01T00:00:00Z") + i * 400 * 86_400_000, y: 1e9 + i, group: 0, href: "#", title: "" }));
		checkFits(renderChart({ points, medians: [], unit: { name: "GB/s", scale: 1e9 }, label: "years" }));
	});
});
