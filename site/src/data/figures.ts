/**
 * Showing a figure without losing it.
 *
 * Every helper here works on the decimal text of a number, never on floating
 * point, so moving a figure into another unit is exact: 19868635157.971607 B/s
 * becomes 19.868635157971607 GB/s, every digit kept. A helper that also offers
 * a shorter form (`short`, rounded to a number of significant digits) always
 * returns the full form beside it (`full`), and says whether the short one
 * dropped anything (`rounded`). A page that shows `short` must give `full`
 * too, in a `title` attribute, a secondary line or a footnote: a figure is
 * never rounded silently.
 *
 * The only arithmetic is a change of unit: a power of ten (ns to ms, B/s to
 * GB/s), a power of two (bytes to GiB), or a count the benchmark fixes (one
 * repetition of mutex is 10,000 critical sections). Nothing here computes a
 * new statistic.
 *
 * A number's text is JavaScript's shortest round-trip form, String(n), which
 * is the text the API's generator wrote (it writes with JSON.stringify); a
 * test in src/data/data.test.ts checks that every row of the snapshot reads
 * back byte for byte. Exponent forms (1e-7) are written out in full.
 */

/** What every formatter returns. */
export type Shown = {
	/** Every digit, in `unit`: the decimal point moved, nothing dropped. Trailing zeros after the point are not kept. */
	full: string;
	/** `full` rounded (half away from zero) to the significant digits asked for; equal to `full` when nothing was dropped. */
	short: string;
	/** The unit both `full` and `short` are in, e.g. "GB/s". Empty for a plain count. */
	unit: string;
	/** True when `short` dropped digits that `full` has. */
	rounded: boolean;
	/** The figure as the snapshot holds it, in the snapshot's own unit, e.g. "19868635157.971607 B/s". */
	source: string;
	/** The snapshot's number, for sorting and drawing (a bar's length, a dot's position); not for printing. */
	value: number;
};

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** A number written out as a plain decimal, digits exactly as String(n) gives them. Throws on NaN and infinities. */
export function plain(value: number): string {
	if (!Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
	const text = String(value);
	if (!/e/i.test(text)) return text;
	const [mantissa = "", exponent = "0"] = text.toLowerCase().split("e");
	return shift(mantissa, Number(exponent));
}

function parts(decimal: string): { negative: boolean; int: string; frac: string } {
	if (!DECIMAL.test(decimal)) throw new Error(`not a plain decimal: ${JSON.stringify(decimal)}`);
	const negative = decimal.startsWith("-");
	const [int = "0", frac = ""] = (negative ? decimal.slice(1) : decimal).split(".");
	return { negative, int, frac };
}

function join(negative: boolean, int: string, frac: string): string {
	const i = int.replace(/^0+(?=\d)/, "") || "0";
	const f = frac.replace(/0+$/, "");
	const text = f ? `${i}.${f}` : i;
	return negative && /[1-9]/.test(text) ? `-${text}` : text;
}

/** The decimal times 10^places, exactly: shift("19868635157.971607", -9) is "19.868635157971607". */
export function shift(decimal: string, places: number): string {
	const { negative, int, frac } = parts(decimal);
	let digits = int + frac;
	let point = int.length + places;
	if (point < 0) {
		digits = "0".repeat(-point) + digits;
		point = 0;
	}
	if (point > digits.length) digits += "0".repeat(point - digits.length);
	return join(negative, digits.slice(0, point), digits.slice(point));
}

/** The decimal divided by 2^n, exactly (x / 2^n = x × 5^n / 10^n, so the result always ends). */
export function halve(decimal: string, n: number): string {
	const { negative, int, frac } = parts(decimal);
	const product = BigInt(int + frac) * 5n ** BigInt(n);
	return shift((negative ? "-" : "") + product.toString(), -(frac.length + n));
}

/** Whole and fraction digits put back together, keeping the fraction's trailing zeros (they are significant after rounding). */
function joinKeepingZeros(negative: boolean, int: string, frac: string): string {
	const i = int.replace(/^0+(?=\d)/, "") || "0";
	const text = frac ? `${i}.${frac}` : i;
	return negative && /[1-9]/.test(text) ? `-${text}` : text;
}

/**
 * The decimal rounded half away from zero to `significant` significant digits, unchanged when it
 * has no more than that. A rounded result keeps its significant trailing zeros: 10.0012 to four
 * digits is "10.00", not "10".
 */
export function roundSignificant(decimal: string, significant: number): string {
	if (!Number.isInteger(significant) || significant < 1) throw new Error(`significant digits must be a whole number from 1: ${significant}`);
	const { negative, int, frac } = parts(decimal);
	const digits = int + frac;
	const first = digits.search(/[1-9]/);
	if (first < 0) return "0";
	const keep = first + significant;
	if (keep >= digits.length || /^0*$/.test(digits.slice(keep))) return join(negative, int, frac);
	let head = digits.slice(0, keep);
	let point = int.length;
	if ((digits[keep] ?? "0") >= "5") {
		let bumped = (BigInt(head) + 1n).toString().padStart(head.length, "0");
		// A carry that adds a digit in front (999 to 1000, 0.0999 to 0.100) adds one too many at the end.
		if (bumped.length > head.length) {
			point += 1;
			bumped = bumped.slice(0, -1);
		} else if (bumped.search(/[1-9]/) < first) {
			bumped = bumped.slice(0, -1);
		}
		head = bumped;
	}
	if (head.length <= point) return joinKeepingZeros(negative, head.padEnd(point, "0"), "");
	return joinKeepingZeros(negative, head.slice(0, point), head.slice(point));
}

/** The decimal rounded half away from zero to `places` places after the point, keeping trailing zeros; unchanged when it has no more places. */
export function roundPlaces(decimal: string, places: number): string {
	if (!Number.isInteger(places) || places < 0) throw new Error(`places must be a whole number from 0: ${places}`);
	const { frac } = parts(decimal);
	if (frac.replace(/0+$/, "").length <= places) return shift(decimal, 0);
	const scaled = shift(decimal, places);
	const { negative, int, frac: rest } = parts(scaled.includes(".") ? scaled : `${scaled}.0`);
	const up = ((rest[0] ?? "0") >= "5" ? BigInt(int) + 1n : BigInt(int)).toString().padStart(places + 1, "0");
	return joinKeepingZeros(negative, up.slice(0, up.length - places), up.slice(up.length - places));
}

/**
 * The decimal with its whole part in groups of three: group("6335") is "6,335". The
 * fraction is left as it is unless `fraction` is given, which groups it the same way
 * from the point (a thin space reads well there). Grouping changes no digit.
 */
export function group(decimal: string, separator = ",", fraction?: string): string {
	const { negative, int, frac } = parts(decimal);
	const whole = int.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
	const part = fraction === undefined ? frac : (frac.match(/\d{1,3}/g) ?? []).join(fraction);
	return (negative ? "-" : "") + whole + (frac ? `.${part}` : "");
}

/** Strips the trailing zeros of a decimal written as text (a price, "0.6860000000"): the same value, fewer characters. */
export function trim(decimal: string): string {
	return shift(decimal, 0);
}

function shown(full: string, unit: string, significant: number | undefined, source: string, value: number): Shown {
	const short = significant === undefined ? full : roundSignificant(full, significant);
	return { full, short, unit, rounded: short !== full, source, value };
}

// ---------------------------------------------------------------- durations

export const DURATION_UNITS = { ns: 0, "µs": -3, ms: -6, s: -9 } as const;
export type DurationUnit = keyof typeof DURATION_UNITS;

/** The largest of ns, µs, ms and s in which the figure is at least 1. */
export function durationUnit(nanoseconds: number): DurationUnit {
	const n = Math.abs(nanoseconds);
	return n >= 1e9 ? "s" : n >= 1e6 ? "ms" : n >= 1e3 ? "µs" : "ns";
}

/**
 * A duration the snapshot gives in nanoseconds, in ns, µs, ms or s (chosen by size unless
 * `unit` is given). `significant` sets the digits of `short` (default 4).
 */
export function formatDuration(nanoseconds: number, options: { unit?: DurationUnit; significant?: number } = {}): Shown {
	const unit = options.unit ?? durationUnit(nanoseconds);
	const text = plain(nanoseconds);
	return shown(shift(text, DURATION_UNITS[unit]), unit, options.significant ?? 4, `${text} ns`, nanoseconds);
}

// ---------------------------------------------------------------- bytes and rates

export const SI_BYTES = { B: 0, kB: 3, MB: 6, GB: 9, TB: 12 } as const;
export const IEC_BYTES = { B: 0, KiB: 10, MiB: 20, GiB: 30, TiB: 40 } as const;
export type ByteUnit = keyof typeof SI_BYTES | keyof typeof IEC_BYTES;

function byteUnit(bytes: number, system: "si" | "iec"): ByteUnit {
	const n = Math.abs(bytes);
	if (system === "si") return n >= 1e12 ? "TB" : n >= 1e9 ? "GB" : n >= 1e6 ? "MB" : n >= 1e3 ? "kB" : "B";
	return n >= 2 ** 40 ? "TiB" : n >= 2 ** 30 ? "GiB" : n >= 2 ** 20 ? "MiB" : n >= 2 ** 10 ? "KiB" : "B";
}

function inBytes(text: string, unit: ByteUnit): string {
	if (unit in SI_BYTES) return shift(text, -SI_BYTES[unit as keyof typeof SI_BYTES]);
	return halve(text, IEC_BYTES[unit as keyof typeof IEC_BYTES]);
}

/**
 * A count of bytes (a parameter such as size_bytes) in B, kB, MB, GB, TB (system "si", powers
 * of 1000) or B, KiB, MiB, GiB, TiB ("iec", powers of 1024, the default: the benchmarks' sizes are
 * powers of two, so 1073741824 is exactly 1 GiB). `significant` defaults to none: `short` is `full`.
 */
export function formatBytes(bytes: number, options: { system?: "si" | "iec"; unit?: ByteUnit; significant?: number } = {}): Shown {
	const unit = options.unit ?? byteUnit(bytes, options.system ?? "iec");
	const text = plain(bytes);
	return shown(inBytes(text, unit), unit, options.significant, `${text} B`, bytes);
}

/**
 * A rate the snapshot gives in bytes per second, in kB/s, MB/s, GB/s… ("si", the default) or
 * KiB/s, MiB/s, GiB/s… ("iec"; AWS states EBS throughput in MiB/s). `significant` defaults to 4.
 */
export function formatRate(bytesPerSecond: number, options: { system?: "si" | "iec"; unit?: ByteUnit; significant?: number } = {}): Shown {
	const unit = options.unit ?? byteUnit(bytesPerSecond, options.system ?? "si");
	const text = plain(bytesPerSecond);
	return shown(inBytes(text, unit), `${unit}/s`, options.significant ?? 4, `${text} B/s`, bytesPerSecond);
}

// ---------------------------------------------------------------- counts, money, moments

/** A whole count (Runs, Series, requests), grouped in threes; never rounded. */
export function formatCount(count: number, separator = ","): Shown {
	const text = plain(count);
	const full = group(text, separator);
	return { full, short: full, unit: "", rounded: false, source: text, value: count };
}

/**
 * A price the price file writes as text in US dollars ("0.6860000000"): `full` is the same
 * value without its trailing zeros ("0.686"); `significant` rounds `short` (default none).
 */
export function formatUsd(usd: string, options: { per?: string; significant?: number } = {}): Shown {
	const unit = options.per ? `USD/${options.per}` : "USD";
	return shown(trim(usd), unit, options.significant, `${usd} ${unit}`, Number(usd));
}

/** A moment as the API writes it (UTC, to the nanosecond), taken apart without losing the nanoseconds. */
export type Moment = {
	/** As the snapshot holds it: "2026-11-19T17:07:23.182448102Z". */
	iso: string;
	/** "2026-11-19 17:07:23.182448102 UTC": every digit. */
	full: string;
	/** "2026-11-19" */
	date: string;
	/** "17:07" (the seconds dropped; give `full` beside it). */
	minute: string;
	/** "17:07:23" */
	second: string;
	/** "19 November 2026" */
	longDate: string;
	/** The moment as a Date, to the millisecond, for sorting and drawing; not for printing. */
	value: Date;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function formatMoment(iso: string): Moment {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/.exec(iso);
	if (!match) throw new Error(`not a UTC moment: ${JSON.stringify(iso)}`);
	const [, year, month, day, hour, minute, second, fraction = ""] = match;
	return {
		iso,
		full: `${year}-${month}-${day} ${hour}:${minute}:${second}${fraction} UTC`,
		date: `${year}-${month}-${day}`,
		minute: `${hour}:${minute}`,
		second: `${hour}:${minute}:${second}`,
		longDate: `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`,
		value: new Date(iso),
	};
}
