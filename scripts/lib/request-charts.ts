/**
 * The charts of Method requests v1's part of the page, as inline SVG drawn
 * when the page is built. No script, no external reference.
 *
 * - renderTimeChart: time across, a time up on a logarithmic axis; for each
 *   Run, one link to its Run file holding a marker per statistic (its median,
 *   95th and 99th percentile, say), joined by a thin line per statistic;
 *   failed Runs as crosses in a lane under the plot, and each Run's failed
 *   requests as a count in a second lane. A value of 0, which a logarithmic
 *   axis cannot place, is a hollow triangle on the plot's bottom edge, which
 *   is labelled "0 ns ▽" then.
 * - renderDistributionChart: the pooled distribution of each phase, from its
 *   histogram, as its cumulative share: time across on a logarithmic axis;
 *   at each bin's upper edge, up, the share of requests that took at most
 *   that long, 0% at the fastest request and 100% at the slowest. Below 100%
 *   the height is −log10 of the share still above (1 − share), so 90%, 99%
 *   and 99.9% are evenly spaced and the tail is as legible as the middle;
 *   that scale cannot reach 100%, so it stops a little below the top edge,
 *   which is 100%.
 */

import { binLower, binWidth } from "../../methods/requests/v1/numbers";
import { COLOURS, esc, FONT_SIZE, labelWidth, timeTicks, utc } from "./chart";

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
const W = 760;
const EDGE = 2;
const FAILED = "#B00020";
const f = (n: number): string => n.toFixed(1);
const text = (x: number, y: number, anchor: "start" | "middle" | "end", content: string, fill = "#333"): string =>
	`<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" class="axis" fill="${fill}">${esc(content)}</text>`;

/** A time in nanoseconds in the unit that reads best, to three significant digits at most. */
export function shortTime(ns: number): string {
	const [scale, unit] = ns >= 1e9 ? [1e9, "s"] : ns >= 1e6 ? [1e6, "ms"] : ns >= 1e3 ? [1e3, "µs"] : [1, "ns"];
	const value = ns / scale;
	const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
	return `${Number(value.toFixed(digits))} ${unit}`;
}

const STEPS: readonly number[][] = [[1], [1, 3], [1, 2, 5], [1, 1.5, 2, 3, 5, 7], [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9]];

/** Round times between min and max for a logarithmic axis: the finest set of 1-2-5 steps that gives at most `most` ticks. */
export function logTicks(min: number, max: number, most = 9): number[] {
	let best: number[] = [];
	for (const multipliers of STEPS) {
		const ticks: number[] = [];
		for (let power = Math.floor(Math.log10(min)) - 1; power <= Math.ceil(Math.log10(max)); power++) {
			for (const m of multipliers) {
				const tick = Number((m * 10 ** power).toPrecision(6));
				if (tick >= min && tick <= max) ticks.push(tick);
			}
		}
		if (ticks.length > most) break;
		best = ticks;
		if (ticks.length >= 4) break;
	}
	return best.length > 0 ? best : [min];
}

export interface TimeRun {
	/** Milliseconds since the epoch. */
	x: number;
	/** One value per statistic, in nanoseconds; null where the Run has none (a percentile its count does not support). */
	values: Array<number | null>;
	/** A failed Run: shown as a cross, with no values. */
	failed: boolean;
	/** Its failed requests. */
	failedRequests: number;
	href: string;
	title: string;
}

export interface TimeChartInput {
	runs: readonly TimeRun[];
	/** The statistics' names, in the order of TimeRun.values. */
	stats: readonly string[];
	label: string;
}

/** The colour of the statistic at an index. */
export const statColour = (index: number): string => COLOURS[index % COLOURS.length] as string;

export function renderTimeChart({ runs, stats, label }: TimeChartInput): string {
	const H = 330;
	const TOP = 12;
	const LANE = 18;
	const BOTTOM = 30;
	const plotBottom = H - BOTTOM - 2 * LANE;
	const xs = runs.map((run) => run.x);
	let x0 = Math.min(...xs);
	let x1 = Math.max(...xs);
	const HOUR = 3_600_000;
	if (x1 - x0 < HOUR) {
		const middle = (x0 + x1) / 2;
		x0 = middle - 12 * HOUR;
		x1 = middle + 12 * HOUR;
	} else {
		const pad = (x1 - x0) * 0.04;
		x0 -= pad;
		x1 += pad;
	}
	const values = runs.flatMap((run) => run.values.filter((value): value is number => value !== null && value > 0));
	let lo = values.length ? Math.min(...values) : 1e6;
	let hi = values.length ? Math.max(...values) : 1e7;
	if (hi / lo < 1.5) {
		const middle = Math.sqrt(hi * lo);
		lo = middle / 1.3;
		hi = middle * 1.3;
	} else {
		lo /= 1.08;
		hi *= 1.08;
	}
	const ticks = logTicks(lo, hi, 8);
	const labels = ticks.map((tick) => ({ tick, content: shortTime(tick) }));
	const LEFT = Math.max(96, Math.ceil(Math.max(labelWidth("failed Run"), labelWidth("failed req."), ...labels.map(({ content }) => labelWidth(content))) + 6 + EDGE + 4));
	const RIGHT = 16;
	const sx = (x: number): number => LEFT + ((x - x0) / (x1 - x0)) * (W - LEFT - RIGHT);
	// A value of 0 (or less, which no phase is) has no place on a logarithmic axis: it is drawn on the bottom edge.
	const sy = (ns: number): number => (ns > 0 ? plotBottom - ((Math.log(ns) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (plotBottom - TOP) : plotBottom);
	const anyZero = runs.some((run) => !run.failed && run.values.some((value) => value !== null && value <= 0));
	const parts: string[] = [];
	parts.push(`<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-size="${FONT_SIZE}" font-family="${FONT}" role="img" aria-label="${esc(label)}">`);
	parts.push(`<rect x="${LEFT}" y="${TOP}" width="${W - LEFT - RIGHT}" height="${plotBottom - TOP}" fill="#fff" stroke="#888"/>`);
	parts.push(`<rect x="${LEFT}" y="${plotBottom + 3}" width="${W - LEFT - RIGHT}" height="${LANE - 5}" fill="#f2f2f2"/>`);
	parts.push(`<rect x="${LEFT}" y="${plotBottom + LANE + 3}" width="${W - LEFT - RIGHT}" height="${LANE - 5}" fill="#f7f0f0"/>`);
	parts.push(text(LEFT - 6, plotBottom + LANE / 2 + 4, "end", "failed Run"));
	if (anyZero) parts.push(text(LEFT - 6, plotBottom - 2, "end", "0 ns ▽"));
	parts.push(text(LEFT - 6, plotBottom + LANE + LANE / 2 + 4, "end", "failed req."));
	for (const { tick, content } of labels) {
		const y = sy(tick);
		parts.push(`<line x1="${LEFT}" x2="${W - RIGHT}" y1="${f(y)}" y2="${f(y)}" stroke="#e4e4e4"/>`);
		parts.push(text(LEFT - 6, y + 4, "end", content));
	}
	const xTicks = timeTicks(x0, x1, W - LEFT - RIGHT);
	const DAY = 86_400_000;
	for (const tick of xTicks.ticks) {
		const x = sx(tick);
		const content = utc(tick, xTicks.step < DAY);
		const half = labelWidth(content) / 2;
		const centre = Math.min(Math.max(x, half + EDGE), W - half - EDGE);
		parts.push(`<line x1="${f(x)}" x2="${f(x)}" y1="${TOP}" y2="${plotBottom + 2 * LANE - 3}" stroke="#e4e4e4"/>`);
		parts.push(text(centre, H - 10, "middle", content));
	}
	// A thin line per statistic through the Runs that have it, in time order.
	const ordered = [...runs].sort((a, b) => a.x - b.x);
	stats.forEach((_, index) => {
		const points = ordered.filter((run) => !run.failed && run.values[index] != null).map((run) => `${f(sx(run.x))},${f(sy(run.values[index] as number))}`);
		if (points.length > 1) parts.push(`<polyline points="${points.join(" ")}" fill="none" stroke="${statColour(index)}" stroke-width="1" stroke-opacity="0.45"/>`);
	});
	const r = runs.length > 60 ? 2.2 : 3.6;
	for (const run of runs) {
		const x = sx(run.x);
		const shapes: string[] = [];
		if (run.failed) {
			const y = plotBottom + LANE / 2;
			shapes.push(`<rect x="${f(x - 6)}" y="${f(y - 6)}" width="12" height="12" fill="none" pointer-events="all"/>`);
			shapes.push(`<path d="M${f(x - 4)} ${f(y - 4)}L${f(x + 4)} ${f(y + 4)}M${f(x - 4)} ${f(y + 4)}L${f(x + 4)} ${f(y - 4)}" stroke="${FAILED}" stroke-width="2"/>`);
		} else {
			run.values.forEach((value, index) => {
				if (value === null) return;
				if (value <= 0) {
					const y = plotBottom;
					shapes.push(`<path d="M${f(x - r)} ${f(y - r * 1.6)}L${f(x + r)} ${f(y - r * 1.6)}L${f(x)} ${f(y)}Z" fill="none" stroke="${statColour(index)}" stroke-width="1.2"/>`);
					return;
				}
				shapes.push(`<circle cx="${f(x)}" cy="${f(sy(value))}" r="${f(r)}" fill="${statColour(index)}" stroke="#fff" stroke-width="0.6"/>`);
			});
		}
		if (run.failedRequests > 0) {
			const y = plotBottom + LANE + LANE / 2 + 4;
			shapes.push(text(x, y, "middle", String(run.failedRequests), FAILED));
		}
		if (shapes.length === 0) {
			// A counted Run with no value (every request failed): still a link, in the lane.
			const y = plotBottom + LANE + LANE / 2;
			shapes.push(`<rect x="${f(x - 4)}" y="${f(y - 4)}" width="8" height="8" fill="none" stroke="${FAILED}" pointer-events="all"/>`);
		}
		parts.push(`<a href="${esc(run.href)}"><title>${esc(run.title)}</title>${shapes.join("")}</a>`);
	}
	parts.push("</svg>");
	return parts.join("\n");
}

/**
 * Each phase's colour, the same in every Series: Okabe and Ito's eight, which
 * stay apart for the common kinds of colour blindness; the whole request is
 * drawn thicker.
 */
export const PHASE_COLOURS: Readonly<Record<string, string>> = {
	dns: "#56B4E9",
	connect: "#009E73",
	tls: "#E69F00",
	send: "#CC79A7",
	first_byte: "#D55E00",
	headers: "#999999",
	body: "#000000",
	total: "#0072B2",
};

export interface Curve {
	name: string;
	colour: string;
	/** Drawn thicker: the whole request. */
	bold?: boolean;
	count: number;
	min: number;
	max: number;
	/** [bin, count] pairs in bin order (methods/requests/v1/numbers.ts). */
	bins: ReadonlyArray<readonly [number, number]>;
}

/** The share axis's marks below 100%: their share, and their height −log10(1 − share). */
const SHARES = [
	{ label: "0%", y: 0 },
	{ label: "50%", y: Math.log10(2) },
	{ label: "90%", y: 1 },
	{ label: "99%", y: 2 },
	{ label: "99.9%", y: 3 },
	{ label: "99.99%", y: 4 },
	{ label: "99.999%", y: 5 },
];

/**
 * The points of a cumulative curve: the least time with a share of 0, then
 * for each bin the greatest whole nanosecond in it (its upper edge less one,
 * held within the least and greatest time) with the share of requests at or
 * below it, (count up to and through the bin) / count. Every time is a whole
 * number of nanoseconds, so that share is exact; the last point is the
 * greatest time, with a share of 1.
 */
export function curvePoints(curve: Curve): Array<{ ns: number; share: number }> {
	const points: Array<{ ns: number; share: number }> = [{ ns: curve.min, share: 0 }];
	let through = 0;
	for (const [bin, n] of curve.bins) {
		through += n;
		const upper = binLower(bin) + binWidth(bin) - 1;
		points.push({ ns: Math.min(curve.max, Math.max(curve.min, upper)), share: through / curve.count });
	}
	const last = points[points.length - 1] as { ns: number; share: number };
	last.ns = curve.max;
	last.share = 1;
	return points;
}

export function renderDistributionChart({ curves, label }: { curves: readonly Curve[]; label: string }): string {
	const H = 300;
	const TOP = 14;
	/** The room between the top of the −log10 scale and the top edge, which is 100%. */
	const BREAK = 22;
	const BOTTOM = 30;
	const RIGHT = 16;
	const plotBottom = H - BOTTOM;
	const all = curves.map((curve) => ({ curve, points: curvePoints(curve) }));
	const lo = Math.max(1, Math.min(...curves.map((curve) => curve.min))) / 1.15;
	const hi = Math.max(lo * 1.5, Math.max(...curves.map((curve) => curve.max)) * 1.15);
	const height = (share: number): number => -Math.log10(1 - share);
	const highest = Math.max(1, ...all.flatMap(({ points }) => points.filter((point) => point.share < 1).map((point) => height(point.share))));
	const marks = SHARES.filter((mark) => mark.y <= highest + 1e-9);
	const LEFT = Math.max(60, Math.ceil(Math.max(labelWidth("100%"), ...marks.map((mark) => labelWidth(mark.label))) + 6 + EDGE + 4));
	const sx = (ns: number): number => LEFT + ((Math.log(Math.max(ns, lo)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (W - LEFT - RIGHT);
	const scaleTop = TOP + BREAK;
	const sy = (share: number): number => (share >= 1 ? TOP : plotBottom - (height(share) / highest) * (plotBottom - scaleTop));
	const parts: string[] = [];
	parts.push(`<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-size="${FONT_SIZE}" font-family="${FONT}" role="img" aria-label="${esc(label)}">`);
	parts.push(`<rect x="${LEFT}" y="${TOP}" width="${W - LEFT - RIGHT}" height="${plotBottom - TOP}" fill="#fff" stroke="#888"/>`);
	for (const mark of marks) {
		const y = sy(1 - 10 ** -mark.y);
		parts.push(`<line x1="${LEFT}" x2="${W - RIGHT}" y1="${f(y)}" y2="${f(y)}" stroke="#e4e4e4"/>`);
		parts.push(text(LEFT - 6, y + 4, "end", mark.label));
	}
	// The −log10 scale stops at its highest point; above it, the top edge is 100%.
	parts.push(`<line x1="${LEFT}" x2="${W - RIGHT}" y1="${f(scaleTop - BREAK / 2)}" y2="${f(scaleTop - BREAK / 2)}" stroke="#bbb" stroke-dasharray="2 3"/>`);
	parts.push(text(LEFT - 6, TOP + 4, "end", "100%"));
	const ticks = logTicks(lo, hi, 10);
	let lastEnd = Number.NEGATIVE_INFINITY;
	for (const tick of ticks) {
		const x = sx(tick);
		const content = shortTime(tick);
		const half = labelWidth(content) / 2;
		const centre = Math.min(Math.max(x, half + EDGE), W - half - EDGE);
		parts.push(`<line x1="${f(x)}" x2="${f(x)}" y1="${TOP}" y2="${plotBottom}" stroke="#e4e4e4"/>`);
		if (centre - half >= lastEnd + 4) {
			parts.push(text(centre, H - 10, "middle", content));
			lastEnd = centre + half;
		}
	}
	for (const { curve, points } of all) {
		const path = points.map((point) => `${f(sx(point.ns))},${f(sy(point.share))}`).join(" ");
		const last = points[points.length - 1] as { ns: number; share: number };
		parts.push(
			`<g><title>${esc(`${curve.name}: ${curve.count} requests, ${shortTime(curve.min)} to ${shortTime(curve.max)}`)}</title>` +
				`<polyline points="${path}" fill="none" stroke="${curve.colour}" stroke-width="${curve.bold ? 3 : 1.6}"/>` +
				`<circle cx="${f(sx(last.ns))}" cy="${f(sy(last.share))}" r="3" fill="${curve.colour}"/>` +
				"</g>",
		);
	}
	parts.push("</svg>");
	return parts.join("\n");
}

/** A small swatch of a colour, for a legend. */
export function colourSwatch(colour: string): string {
	return `<svg class="swatch" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="${colour}"/></svg>`;
}
