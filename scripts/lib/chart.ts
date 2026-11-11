/**
 * One chart as inline SVG, drawn when the page is built: time across, one
 * number up, a point per Run that links to it, failed Runs as crosses in a
 * lane under the plot. No script, no external reference.
 */

export interface ChartPoint {
	/** Milliseconds since the epoch. */
	x: number;
	/** In base units (bytes per second, nanoseconds); null for a failed Run. */
	y: number | null;
	/** Its group's index: picks its colour and shape. */
	group: number;
	href: string;
	title: string;
}

export interface ChartMedian {
	group: number;
	/** The first and last counted Run of the group. */
	x0: number;
	x1: number;
	y: number;
	title: string;
}

export interface Unit {
	/** Such as "GB/s". */
	name: string;
	/** Base units per display unit. */
	scale: number;
}

/** Okabe and Ito's colours, which stay apart for the common kinds of colour blindness. */
export const COLOURS = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#000000"];
export const SHAPES = ["circle", "square", "triangle", "diamond", "down"] as const;
const FAILED = "#B00020";

export const esc = (text: string): string =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A number to four significant digits, without exponents. */
export function formatNumber(value: number): string {
	if (value === 0) return "0";
	const magnitude = Math.floor(Math.log10(Math.abs(value)));
	const decimals = Math.max(0, 3 - magnitude);
	return value.toFixed(Math.min(decimals, 12));
}

export function bytesPerSecondUnit(max: number): Unit {
	if (max >= 1e12) return { name: "TB/s", scale: 1e12 };
	if (max >= 1e9) return { name: "GB/s", scale: 1e9 };
	if (max >= 1e6) return { name: "MB/s", scale: 1e6 };
	if (max >= 1e3) return { name: "kB/s", scale: 1e3 };
	return { name: "B/s", scale: 1 };
}

export function nanosecondUnit(max: number): Unit {
	if (max >= 1e9) return { name: "s", scale: 1e9 };
	if (max >= 1e6) return { name: "ms", scale: 1e6 };
	if (max >= 1e3) return { name: "µs", scale: 1e3 };
	return { name: "ns", scale: 1 };
}

export function withUnit(value: number, unit: Unit): string {
	return `${formatNumber(value / unit.scale)} ${unit.name}`;
}

/** The colour and shape of group `index`; 35 groups before a pair repeats. */
export function marker(index: number, x: number, y: number, r: number): string {
	const colour = COLOURS[index % COLOURS.length];
	const shape = SHAPES[index % SHAPES.length];
	const paint = `fill="${colour}" stroke="#fff" stroke-width="0.75"`;
	const f = (n: number): string => n.toFixed(1);
	switch (shape) {
		case "circle":
			return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" ${paint}/>`;
		case "square":
			return `<rect x="${f(x - r * 0.9)}" y="${f(y - r * 0.9)}" width="${f(r * 1.8)}" height="${f(r * 1.8)}" ${paint}/>`;
		case "triangle":
			return `<path d="M${f(x)} ${f(y - r * 1.15)}L${f(x + r * 1.1)} ${f(y + r * 0.8)}L${f(x - r * 1.1)} ${f(y + r * 0.8)}Z" ${paint}/>`;
		case "diamond":
			return `<path d="M${f(x)} ${f(y - r * 1.25)}L${f(x + r * 1.1)} ${f(y)}L${f(x)} ${f(y + r * 1.25)}L${f(x - r * 1.1)} ${f(y)}Z" ${paint}/>`;
		default:
			return `<path d="M${f(x)} ${f(y + r * 1.15)}L${f(x + r * 1.1)} ${f(y - r * 0.8)}L${f(x - r * 1.1)} ${f(y - r * 0.8)}Z" ${paint}/>`;
	}
}

/** Evenly spaced round values covering [min, max]: steps of 1, 2 or 5 times a power of ten. */
export function niceTicks(min: number, max: number, wanted = 5): { ticks: number[]; step: number } {
	const raw = (max - min) / wanted;
	const power = 10 ** Math.floor(Math.log10(raw));
	const normal = raw / power;
	const step = (normal < 1.5 ? 1 : normal < 3 ? 2 : normal < 7 ? 5 : 10) * power;
	const ticks: number[] = [];
	for (let i = Math.ceil(min / step); i * step <= max + step * 1e-9; i++) ticks.push(i * step);
	return { ticks, step };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TIME_STEPS = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 28 * DAY, 91 * DAY, 182 * DAY, 364 * DAY];

/** Tick times at a round step, aligned to UTC midnight, at most about seven across. */
export function timeTicks(min: number, max: number): { ticks: number[]; step: number } {
	const step = TIME_STEPS.find((candidate) => (max - min) / candidate <= 7) ?? (TIME_STEPS.at(-1) as number);
	const ticks: number[] = [];
	for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(t);
	return { ticks, step };
}

export function utc(ms: number, withTime: boolean): string {
	const iso = new Date(ms).toISOString();
	return withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

export interface ChartInput {
	points: readonly ChartPoint[];
	medians: readonly ChartMedian[];
	unit: Unit;
	/** Says what the chart shows, for screen readers. */
	label: string;
}

const W = 760;
const H = 300;
const LEFT = 84;
const RIGHT = 16;
const TOP = 12;
const LANE = 22;
const BOTTOM = 30;

export function renderChart({ points, medians, unit, label }: ChartInput): string {
	const plotBottom = H - BOTTOM - LANE;
	const xs = points.map((point) => point.x);
	let x0 = Math.min(...xs);
	let x1 = Math.max(...xs);
	if (x1 - x0 < HOUR) {
		const middle = (x0 + x1) / 2;
		x0 = middle - 12 * HOUR;
		x1 = middle + 12 * HOUR;
	} else {
		const pad = (x1 - x0) * 0.04;
		x0 -= pad;
		x1 += pad;
	}
	const values = points.flatMap((point) => (point.y === null ? [] : [point.y / unit.scale]));
	let y0 = values.length ? Math.min(...values) : 0;
	let y1 = values.length ? Math.max(...values) : 1;
	if (y1 - y0 <= Math.abs(y1) * 1e-9) {
		const pad = Math.abs(y1) * 0.02 || 1;
		y0 -= pad;
		y1 += pad;
	} else {
		const pad = (y1 - y0) * 0.1;
		y0 -= pad;
		y1 += pad;
	}
	const sx = (x: number): number => LEFT + ((x - x0) / (x1 - x0)) * (W - LEFT - RIGHT);
	const sy = (y: number): number => plotBottom - ((y / unit.scale - y0) / (y1 - y0)) * (plotBottom - TOP);
	const f = (n: number): string => n.toFixed(1);

	const parts: string[] = [];
	parts.push(`<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">`);
	parts.push(`<rect x="${LEFT}" y="${TOP}" width="${W - LEFT - RIGHT}" height="${plotBottom - TOP}" fill="#fff" stroke="#888"/>`);
	parts.push(`<rect x="${LEFT}" y="${plotBottom + 3}" width="${W - LEFT - RIGHT}" height="${LANE - 6}" fill="#f2f2f2"/>`);
	parts.push(`<text x="${LEFT - 6}" y="${plotBottom + LANE / 2 + 4}" text-anchor="end" class="axis">failed</text>`);

	const yTicks = niceTicks(y0, y1);
	const decimals = Math.max(0, -Math.floor(Math.log10(yTicks.step)));
	for (const tick of yTicks.ticks) {
		const y = plotBottom - ((tick - y0) / (y1 - y0)) * (plotBottom - TOP);
		parts.push(`<line x1="${LEFT}" x2="${W - RIGHT}" y1="${f(y)}" y2="${f(y)}" stroke="#e4e4e4"/>`);
		parts.push(`<text x="${LEFT - 6}" y="${f(y + 4)}" text-anchor="end" class="axis">${esc(`${tick.toFixed(Math.min(decimals, 12))} ${unit.name}`)}</text>`);
	}
	const xTicks = timeTicks(x0, x1);
	for (const tick of xTicks.ticks) {
		const x = sx(tick);
		parts.push(`<line x1="${f(x)}" x2="${f(x)}" y1="${TOP}" y2="${plotBottom + LANE - 3}" stroke="#e4e4e4"/>`);
		parts.push(`<text x="${f(x)}" y="${H - 10}" text-anchor="middle" class="axis">${esc(utc(tick, xTicks.step < DAY))}</text>`);
	}

	for (const median of medians) {
		const y = sy(median.y);
		let a = sx(median.x0);
		let b = sx(median.x1);
		if (b - a < 16) {
			a -= 8;
			b += 8;
		}
		const colour = COLOURS[median.group % COLOURS.length];
		parts.push(
			`<g><title>${esc(median.title)}</title><line x1="${f(a)}" x2="${f(b)}" y1="${f(y)}" y2="${f(y)}" stroke="${colour}" stroke-width="2" stroke-dasharray="6 4"/></g>`,
		);
	}

	const r = points.length > 60 ? 3 : 4.5;
	for (const point of points) {
		const x = sx(point.x);
		const shape =
			point.y === null
				? (() => {
						const y = plotBottom + LANE / 2;
						return (
							`<rect x="${f(x - 6)}" y="${f(y - 6)}" width="12" height="12" fill="none" pointer-events="all"/>` +
							`<path d="M${f(x - 4)} ${f(y - 4)}L${f(x + 4)} ${f(y + 4)}M${f(x - 4)} ${f(y + 4)}L${f(x + 4)} ${f(y - 4)}" stroke="${FAILED}" stroke-width="2"/>`
						);
					})()
				: marker(point.group, x, sy(point.y), r);
		parts.push(`<a href="${esc(point.href)}"><title>${esc(point.title)}</title>${shape}</a>`);
	}
	parts.push("</svg>");
	return parts.join("\n");
}

/** A small swatch of a group's marker, for a legend. */
export function swatch(group: number): string {
	return `<svg class="swatch" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">${marker(group, 7, 7, 4.5)}</svg>`;
}
