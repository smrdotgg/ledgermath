/**
 * Numbers as people write them in an estimate, with their units: "30 million",
 * "1.5e9 GB", "$0.09", "140.28 GB/s", "12500 Megabit", "7.69 ms". Used by the
 * answer checker (scripts/check-answer.ts) to find the numbers in an answer
 * and to compare a number with the value its citation resolves to.
 *
 * A quantity is reduced to a dimension and a value in that dimension's base
 * unit: bytes (bits count as an eighth of a byte), seconds or US dollars. A
 * rate ("GB/s", "per hour") keeps only its numerator's dimension: the checker
 * compares magnitudes, not units of rates.
 */

export type Dimension = "bytes" | "seconds" | "usd" | "percent" | "none";

export interface Quantity {
	/** The text it was read from. */
	text: string;
	/** Where the text starts and ends in what was scanned. */
	start: number;
	end: number;
	/** The number as written, with scale words ("million") and exponents applied, before the unit. */
	written: number;
	/** Significant digits as written; trailing zeros of a whole number do not count. */
	digits: number;
	dimension: Dimension;
	/** In the dimension's base unit. */
	value: number;
}

const BYTE_PREFIX: Readonly<Record<string, number>> = { "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
const BINARY_PREFIX: Readonly<Record<string, number>> = { K: 2 ** 10, k: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40, P: 2 ** 50, E: 2 ** 60 };
const WORD_PREFIX: Readonly<Record<string, number>> = { "": 1, kilo: 1e3, mega: 1e6, giga: 1e9, tera: 1e12, peta: 1e15, exa: 1e18 };

const SECONDS: Readonly<Record<string, number>> = {
	ns: 1e-9,
	nanosecond: 1e-9,
	nanoseconds: 1e-9,
	"µs": 1e-6,
	"μs": 1e-6,
	us: 1e-6,
	microsecond: 1e-6,
	microseconds: 1e-6,
	ms: 1e-3,
	millisecond: 1e-3,
	milliseconds: 1e-3,
	s: 1,
	sec: 1,
	secs: 1,
	second: 1,
	seconds: 1,
	min: 60,
	mins: 60,
	minute: 60,
	minutes: 60,
	h: 3600,
	hr: 3600,
	hrs: 3600,
	hour: 3600,
	hours: 3600,
	day: 86400,
	days: 86400,
};

const SCALE_WORDS: Readonly<Record<string, number>> = {
	thousand: 1e3,
	k: 1e3,
	K: 1e3,
	million: 1e6,
	millions: 1e6,
	mn: 1e6,
	M: 1e6,
	billion: 1e9,
	billions: 1e9,
	bn: 1e9,
	trillion: 1e12,
};

const SUPERSCRIPT: Readonly<Record<string, string>> = {
	"⁰": "0",
	"¹": "1",
	"²": "2",
	"³": "3",
	"⁴": "4",
	"⁵": "5",
	"⁶": "6",
	"⁷": "7",
	"⁸": "8",
	"⁹": "9",
	"⁻": "-",
};

/** A unit word: its dimension and how many base units one of it is. */
export function unitOf(word: string): { dimension: Dimension; factor: number } | null {
	if (word === "%") return { dimension: "percent", factor: 1 };
	if (word === "USD" || word === "dollars" || word === "dollar") return { dimension: "usd", factor: 1 };
	const time = SECONDS[word];
	if (time !== undefined) return { dimension: "seconds", factor: time };
	let match = /^([kKMGTPE]?)B$/.exec(word);
	if (match) return { dimension: "bytes", factor: BYTE_PREFIX[match[1] as string] as number };
	match = /^([kKMGTPE])iB$/.exec(word);
	if (match) return { dimension: "bytes", factor: BINARY_PREFIX[match[1] as string] as number };
	match = /^([kKMGTPE]?)(?:b|bit|bits|bps)$/.exec(word);
	if (match) return { dimension: "bytes", factor: (BYTE_PREFIX[match[1] as string] as number) / 8 };
	match = /^(kilo|mega|giga|tera|peta|exa|)(byte|bytes)$/i.exec(word);
	if (match) return { dimension: "bytes", factor: WORD_PREFIX[(match[1] as string).toLowerCase()] as number };
	match = /^(kilo|mega|giga|tera|peta|exa)(bit|bits)$/i.exec(word);
	if (match) return { dimension: "bytes", factor: (WORD_PREFIX[(match[1] as string).toLowerCase()] as number) / 8 };
	return null;
}

/**
 * One number: an optional $, digits (with thousands commas), a fraction, an
 * exponent (e9, × 10^9, ×10⁹), then an optional scale word and unit.
 * It is not part of a word: not preceded by a letter, digit, _, /, #, : or ^,
 * nor by a letter or digit followed by . or - (c6i.8xlarge, use2-az3), nor
 * by a name and = (threads=1, a parameter).
 */
const NUMBER = new RegExp(
	String.raw`(?<![\p{L}\p{N}_/#:\\^])(?<![\p{L}\p{N}][.\-])(?<![\p{L}_]=)` +
		String.raw`(?<dollar>\$\s?)?(?<int>\d{1,3}(?:,\d{3})+|\d+)(?<frac>\.\d+)?` +
		String.raw`(?:[eE](?<e>[+\-]?\d+)|\s?[×x*·]\s?10(?:\^(?<pow>[+\-]?\d+)|(?<sup>[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)))?`,
	"gu",
);

/** After a number: an optional space, then a scale word, then an optional space and a unit. */
const AFTER = new RegExp(
	String.raw`^(?:\s?(?<scale>thousand|millions?|billions?|trillion|mn|bn|[kKM](?![a-zA-Z])))?` +
		String.raw`(?:\s?(?<unit>%|USD|dollars?|[kKMGTPE]iB|[kKMGTPE]?B|[kKMGTPE]?(?:bits?|bps|b)|(?:kilo|mega|giga|tera|peta|exa)?(?:bytes?|bits?)|nanoseconds?|microseconds?|milliseconds?|seconds?|minutes?|hours?|days?|ns|µs|μs|us|ms|secs?|mins?|hrs?|h|s|day)(?![\p{L}\p{N}])(?:\/(?:s|sec|h|hr|day|mo|month)(?![\p{L}\p{N}]))?)?`,
	"iu",
);

function significantDigits(int: string, frac: string | undefined): number {
	const digits = int.replace(/,/g, "");
	if (frac !== undefined) return Math.max(1, `${digits}${frac.slice(1)}`.replace(/^0+/, "").length);
	return Math.max(1, digits.replace(/^0+/, "").replace(/0+$/, "").length);
}

/** Every number in text, with its unit, in order. */
export function quantities(text: string): Quantity[] {
	const found: Quantity[] = [];
	for (const match of text.matchAll(NUMBER)) {
		const groups = match.groups as Record<string, string | undefined>;
		const start = match.index;
		let end = start + match[0].length;
		// An identifier that starts with digits (a hash, a SKU, an id) is not a number.
		const rest = /^[\p{L}\p{N}_]*/u.exec(text.slice(end))?.[0] ?? "";
		if (/[\p{N}_]/u.test(rest)) continue;
		const int = groups.int as string;
		let written = Number(`${int.replace(/,/g, "")}${groups.frac ?? ""}`);
		if (groups.e !== undefined) written *= 10 ** Number(groups.e);
		if (groups.pow !== undefined) written *= 10 ** Number(groups.pow);
		if (groups.sup !== undefined) written *= 10 ** Number([...groups.sup].map((c) => SUPERSCRIPT[c] ?? "").join(""));
		// A bare power, 10^9 or 2^30, is the number it raises to.
		const power = groups.frac === undefined && groups.e === undefined && groups.pow === undefined ? /^\^([+\-]?\d+)/.exec(text.slice(end)) : null;
		if (power !== null) {
			written **= Number(power[1]);
			end += power[0].length;
		}
		const after = AFTER.exec(text.slice(end));
		let dimension: Dimension = groups.dollar !== undefined ? "usd" : "none";
		let factor = 1;
		if (after !== null) {
			const scale = after.groups?.scale;
			const unitWord = after.groups?.unit;
			// A lone "M" or "k" right before a unit is that unit's prefix, which the unit pattern reads.
			if (scale !== undefined) written *= SCALE_WORDS[scale] ?? SCALE_WORDS[scale.toLowerCase()] ?? 1;
			if (unitWord !== undefined) {
				const unit = unitOf(unitWord) ?? unitOf(unitWord.toLowerCase());
				if (unit !== null && dimension === "none") {
					dimension = unit.dimension;
					factor = unit.factor;
				}
			}
			end += after[0].length;
		}
		found.push({
			text: text.slice(start, end),
			start,
			end,
			written,
			digits: significantDigits(int, groups.frac),
			dimension,
			value: written * factor,
		});
	}
	return found;
}

/** The first quantity in text, or null. */
export function firstQuantity(text: string): Quantity | null {
	return quantities(text)[0] ?? null;
}

/**
 * How far a written number may be from a value and still be that value
 * rounded: half its last digit, but never less than 0.5% nor more than 5%, so
 * "1" is not 1.36 and "4 s" is not 3.79 s.
 */
export function tolerance(quantity: Pick<Quantity, "written" | "digits">): number {
	const magnitude = Math.floor(Math.log10(Math.abs(quantity.written) || 1));
	const lastDigit = 10 ** (magnitude - quantity.digits + 1);
	return Math.min(0.05, Math.max(0.005, lastDigit / 2 / Math.abs(quantity.written || 1)));
}

function near(a: number, b: number, relative: number): boolean {
	if (a === b) return true;
	if (a === 0 || b === 0) return false;
	return Math.abs(a - b) <= relative * Math.abs(b) * (1 + 1e-9);
}

/** Scales a number without a unit may differ by from a value in base units: 10^3k and 2^10k. */
const UNITLESS_SCALES: readonly number[] = [0, 1, 2, 3, 4, -1, -2, -3, -4].flatMap((k) => (k === 0 ? [1] : [10 ** (3 * k), 2 ** (10 * k)]));

/**
 * Whether a written quantity is the value of another quantity, as people
 * write it: equal in base units when both have a dimension, and otherwise
 * equal as written, or up to a unit prefix (10^3k, 2^10k).
 */
export function sameQuantity(written: Quantity, other: Pick<Quantity, "written" | "dimension" | "value">): boolean {
	const relative = tolerance(written);
	if (written.dimension !== "none" && other.dimension !== "none") {
		return written.dimension === other.dimension && near(written.value, other.value, relative);
	}
	if (near(written.written, other.written, relative)) return true;
	return UNITLESS_SCALES.some((scale) => near(written.written, other.value * scale, relative));
}

/** Whether a written quantity is a value up to a power of ten, and of 1024: how a price per unit is quoted per 1,000, per million, per GiB. */
export function samePriceUpToScale(written: Quantity, price: number): boolean {
	const relative = tolerance(written);
	for (let k = -12; k <= 12; k++) {
		for (const binary of [1, 1024, 1 / 1024]) if (near(written.written, price * 10 ** k * binary, relative)) return true;
	}
	return false;
}
