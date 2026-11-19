// Drawing helpers for the instruments: which unit a chart is drawn in, the figures moved into
// that unit (exactly, by the data module's helpers), and the scale each chart is drawn to.
// Placing a mark on a scale is drawing a figure; nothing here computes a statistic.
import {
	DURATION_UNITS,
	durationUnit,
	formatDuration,
	formatRate,
	group,
	type HeadlineRow,
	leadFigure,
	plain,
	roundSignificant,
	shift,
	type ByteUnit,
	type DurationUnit,
} from "../../data";

/** A figure as a chart shows it: `short` beside the mark, `full` (every digit) on hover and in the table. */
export type Fig = { full: string; short: string; unit: string; source: string; value: number };

export type Mark = {
	instanceType: string;
	url: string;
	runs: number;
	p5: Fig;
	p50: Fig;
	p95: Fig;
};

export type Scale = {
	lo: number;
	hi: number;
	ticks: { value: number; label: string }[];
	/** True when the scale does not start at zero. */
	zoomed: boolean;
};

export type Instrument = {
	row: HeadlineRow;
	/** The unit every figure of the chart is in, e.g. "GB/s", "ns". */
	unit: string;
	/** What the figure is, in words: "median rate", "median time per repetition", "median time per critical section". */
	quantity: string;
	marks: Mark[];
	/** The scale from zero, always drawn: on its own, or as the context strip of a zoomed chart. */
	zero: Scale;
	/** A scale that starts above zero, drawn when the marks crowd into a sliver of the scale from zero. */
	zoom: Scale | null;
};

/** A count the benchmark fixes per repetition, when it is a power of ten (the decimal point moves). */
function perPlaces(row: HeadlineRow): number | null {
	const per = row.choice.per;
	if (!per) return null;
	const places = Math.log10(per.count);
	return Number.isInteger(places) ? places : null;
}

function niceStep(span: number, target: number): number {
	const raw = span / target;
	const power = 10 ** Math.floor(Math.log10(raw));
	for (const m of [1, 2, 5, 10]) if (m * power >= raw - 1e-12 * power) return m * power;
	return 10 * power;
}

function decimals(step: number): number {
	const text = plain(Number(step.toPrecision(12)));
	return text.includes(".") ? text.split(".")[1]!.length : 0;
}

/** Room for tick labels on the narrowest chart, in characters of the axis font (gaps included). */
const AXIS_CHARS = 20;

function ticks(lo: number, hi: number, step: number): Scale["ticks"] {
	const out: Scale["ticks"] = [];
	const count = Math.round((hi - lo) / step);
	const places = decimals(step);
	for (let i = 0; i <= count; i++) {
		const value = Number((lo + i * step).toPrecision(12));
		out.push({ value, label: value === 0 ? "0" : group(value.toFixed(places)) });
	}
	// When the labels would collide, label every other tick; the gridlines stay.
	const chars = out.reduce((n, t) => n + t.label.length + 2, 0);
	if (chars > AXIS_CHARS) for (let i = 1; i < out.length; i += 2) out[i]!.label = "";
	return out;
}

/** The scale from zero to the first round value at or above every mark. */
export function zeroScale(max: number, target = 4): Scale {
	const step = niceStep(max, target);
	const hi = Number((Math.ceil(max / step - 1e-9) * step).toPrecision(12));
	return { lo: 0, hi, ticks: ticks(0, hi, step), zoomed: false };
}

function zoomScale(min: number, max: number): Scale {
	const step = niceStep(max - min, 4);
	let lo = Number((Math.floor(min / step + 1e-9) * step).toPrecision(12));
	let hi = Number((Math.ceil(max / step - 1e-9) * step).toPrecision(12));
	if (lo === min) lo = Number((lo - step).toPrecision(12));
	if (hi === max) hi = Number((hi + step).toPrecision(12));
	return { lo, hi, ticks: ticks(lo, hi, step), zoomed: true };
}

/** A mark's position on a scale, as a percentage of its width, for an SVG attribute. */
export function at(scale: Scale, value: number): string {
	const p = ((value - scale.lo) / (scale.hi - scale.lo)) * 100;
	return `${Number(p.toFixed(4))}%`;
}

export function width(scale: Scale, from: number, to: number): string {
	const p = ((to - from) / (scale.hi - scale.lo)) * 100;
	return `${Number(p.toFixed(4))}%`;
}

/** The marks crowd when all of them, bars included, fit in a tenth of the scale from zero. */
const CROWDED = 0.1;

export function instrument(row: HeadlineRow): Instrument {
	const raw = row.cells.map((cell) => ({ cell, f: leadFigure(row.choice, cell.series) }));
	const places = perPlaces(row);
	const isRate = row.choice.lead === "rate";
	const smallest = Math.min(...raw.map((r) => r.f.p50));

	let fig: (value: number, significant: number) => Fig;
	let unit: string;
	let quantity: string;
	if (isRate) {
		const u = formatRate(smallest).unit.replace("/s", "") as ByteUnit;
		unit = `${u}/s`;
		quantity = "Median rate";
		fig = (value, significant) => formatRate(value, { unit: u, significant });
	} else if (places !== null) {
		const per = row.choice.per!;
		const u: DurationUnit = durationUnit(smallest / per.count);
		unit = u;
		quantity = `Median time per ${per.of}`;
		fig = (value, significant) => {
			const ns = shift(plain(value), -places);
			const full = shift(ns, DURATION_UNITS[u]);
			return { full, short: roundSignificant(full, significant), unit: u, source: `${plain(value)} ns per repetition (${group(String(per.count))} ${per.of}s)`, value: Number(full) };
		};
	} else {
		const u = durationUnit(smallest);
		unit = u;
		quantity = "Median time per repetition";
		fig = (value, significant) => formatDuration(value, { unit: u, significant });
	}

	const draft = raw.map((r) => ({ p5: fig(r.f.p5, 4), p50: fig(r.f.p50, 4), p95: fig(r.f.p95, 4) }));
	const shownValue = (f: Fig) => Number(f.full);
	const min = Math.min(...draft.map((d) => shownValue(d.p5)));
	const max = Math.max(...draft.map((d) => shownValue(d.p95)));
	const zero = zeroScale(max);
	const crowded = (max - min) / zero.hi < CROWDED;
	const zoom = crowded ? zoomScale(min, max) : null;

	// Every digit first; then one count of decimals for the whole chart, so its figures line up on the point.
	const marks: Mark[] = raw.map((r) => ({
		instanceType: r.cell.machine.instanceType,
		url: r.cell.series.url,
		runs: r.f.count,
		p5: fig(r.f.p5, EVERY),
		p50: fig(r.f.p50, EVERY),
		p95: fig(r.f.p95, EVERY),
	}));
	const decimalsShown = placesFor(
		marks.map((m) => m.p50.full),
		crowded ? 6 : 4,
	);
	for (const m of marks)
		for (const f of [m.p5, m.p50, m.p95]) {
			f.short = roundSignificant(f.full, significantFor(f.full, decimalsShown));
			f.value = Number(f.full);
		}
	return { row, unit, quantity, marks, zero, zoom };
}

/** More significant digits than any figure holds: `short` is `full`. */
const EVERY = 40;

/** Digits before the point, or minus the zeros that open the fraction when there are none ("0.0175" gives -1). */
function magnitude(full: string): number {
	const [whole = "", fraction = ""] = full.replace(/^-/, "").split(".");
	const digits = whole.replace(/^0+/, "").length;
	return digits > 0 ? digits : -(fraction.match(/^0*/)?.[0].length ?? 0);
}

/** The significant digits that leave `full` with `places` decimals (never fewer than one). */
function significantFor(full: string, places: number): number {
	return Math.max(1, magnitude(full) + places);
}

/**
 * One count of decimals for a chart: enough for its largest median to show `significant` digits, and
 * up to two more while two medians that differ would print the same.
 */
function placesFor(fulls: string[], significant: number): number {
	const largest = Math.max(...fulls.map(magnitude));
	const base = Math.max(0, significant - largest);
	for (let places = base; places < base + 2; places++) {
		const shown = fulls.map((f) => roundSignificant(f, significantFor(f, places)));
		const clash = shown.some((s, i) => shown.some((t, j) => j > i && s === t && fulls[i] !== fulls[j]));
		if (!clash) return places;
	}
	return base + 2;
}
