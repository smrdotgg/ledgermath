/**
 * Numbers as an answer writes them, with their units, for the answer checker
 * (scripts/check-answer.ts): "30,000,000", "30 million players", "1.5e9 GB",
 * "-$0.096 per hour", ".57 µs", "112.269 MB/s", "$0.08 per GB-month",
 * "12500 Megabit", "77%".
 *
 * A quantity keeps its sign, the number as written, the precision its written
 * digits imply (half the place of its last digit), and its whole unit: the
 * dimensions and the factor to base units (bytes, seconds, US dollars,
 * requests, I/O operations), denominator included, so 112.27 MB/s, 112.27
 * MB/h and 112.27 MB are three different things. Bits are an eighth of a
 * byte; decimal and binary prefixes keep their own factors; a month is 730
 * hours and a year 8760, as AWS bills them. A noun that is none of these
 * units ("players", "machines") is a label and adds no dimension.
 */

export type Dimension = "B" | "s" | "USD" | "req" | "io";
export type Dims = Partial<Record<Dimension, number>>;

export interface Unit {
	dims: Dims;
	/** Base units in one of this unit. */
	factor: number;
	/** As written, empty for none. */
	text: string;
}

export interface Quantity {
	/** The text read, sign and unit included. */
	text: string;
	start: number;
	end: number;
	/** The number as written, signed, with scale words and exponents applied, in its written unit. */
	written: number;
	/** Half the place of the last written digit, in the same terms as written: 0.0005 for 112.269, 0.5 for 30,000,000. */
	half: number;
	/** The same with a whole number's trailing zeros not significant: 50 for 33300, 0.0005 for 112.269. How a figure rounded to fewer digits is read. */
	looseHalf: number;
	unit: Unit;
	/** written × unit.factor: in base units. */
	value: number;
	/** Whether it is a bare power (10^9, 2^30), which is exact. */
	power: boolean;
	/**
	 * Its unit read with the time after it in prose ("216000000 an hour",
	 * "$11571.20 a month", "10000000 each day"), which a repeat may be matched
	 * by as well as by its unit; null when no such time follows.
	 */
	alt: Unit | null;
}

const DIMENSIONS: readonly Dimension[] = ["B", "s", "USD", "req", "io"];
const HOUR = 3600;
const MONTH = 730 * HOUR;
const YEAR = 8760 * HOUR;

export function multiply(a: Dims, b: Dims, power = 1): Dims {
	const out: Dims = {};
	for (const d of DIMENSIONS) {
		const e = (a[d] ?? 0) + power * (b[d] ?? 0);
		if (e !== 0) out[d] = e;
	}
	return out;
}

export function sameDims(a: Dims, b: Dims): boolean {
	return DIMENSIONS.every((d) => (a[d] ?? 0) === (b[d] ?? 0));
}

const DIMENSION_WORDS: Readonly<Record<Dimension, [string, string]>> = {
	B: ["byte", "bytes"],
	s: ["second", "seconds"],
	USD: ["US dollar", "US dollars"],
	req: ["request", "requests"],
	io: ["I/O operation", "I/O operations"],
};

/** Dimensions in words, for a person: "bytes per second", "US dollars per request", "no unit". */
export function dimsWords(dims: Dims): string {
	const up = DIMENSIONS.filter((d) => (dims[d] ?? 0) > 0).map((d) => `${DIMENSION_WORDS[d][1]}${(dims[d] as number) > 1 ? ` to the power ${dims[d]}` : ""}`);
	const down = DIMENSIONS.filter((d) => (dims[d] ?? 0) < 0).map((d) => DIMENSION_WORDS[d][0]);
	if (up.length === 0 && down.length === 0) return "no unit";
	return `${up.join(" × ") || "1"}${down.length === 0 ? "" : ` per ${down.join(" per ")}`}`;
}

/** A number for a person: six significant digits, no exponent below 10^15. */
export function readable(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	if (value === 0) return "0";
	const magnitude = Math.floor(Math.log10(Math.abs(value)));
	if (magnitude >= 15 || magnitude < -12) return value.toPrecision(6);
	const text = value.toFixed(Math.max(0, 5 - magnitude));
	return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** "B/s", "USD/s", "USD/(B s)", "" for none. */
export function dimsText(dims: Dims): string {
	const up = DIMENSIONS.filter((d) => (dims[d] ?? 0) > 0).map((d) => ((dims[d] as number) === 1 ? d : `${d}^${dims[d]}`));
	const down = DIMENSIONS.filter((d) => (dims[d] ?? 0) < 0).map((d) => ((dims[d] as number) === -1 ? d : `${d}^${-(dims[d] as number)}`));
	if (down.length === 0) return up.join(" ") || "no unit";
	return `${up.join(" ") || "1"}/${down.length === 1 ? down[0] : `(${down.join(" ")})`}`;
}

const DECIMAL: Readonly<Record<string, number>> = { "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
const BINARY: Readonly<Record<string, number>> = { K: 2 ** 10, k: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40, P: 2 ** 50, E: 2 ** 60 };
const WORD_PREFIX: Readonly<Record<string, number>> = { "": 1, kilo: 1e3, mega: 1e6, giga: 1e9, tera: 1e12, peta: 1e15, exa: 1e18 };

const TIME: Readonly<Record<string, number>> = {
	ns: 1e-9,
	"µs": 1e-6,
	"μs": 1e-6,
	us: 1e-6,
	ms: 1e-3,
	s: 1,
	sec: 1,
	secs: 1,
	second: 1,
	seconds: 1,
	min: 60,
	mins: 60,
	minute: 60,
	minutes: 60,
	h: HOUR,
	hr: HOUR,
	hrs: HOUR,
	hour: HOUR,
	hours: HOUR,
	day: 86400,
	days: 86400,
	week: 7 * 86400,
	weeks: 7 * 86400,
	mo: MONTH,
	month: MONTH,
	months: MONTH,
	year: YEAR,
	years: YEAR,
};

/** One unit word, with no denominator: its dimensions and factor, or null when it is not a unit. */
export function unitAtom(word: string): { dims: Dims; factor: number } | null {
	let m = /^([kKMGTPE]?)B$/.exec(word);
	if (m) return { dims: { B: 1 }, factor: DECIMAL[m[1] as string] as number };
	m = /^([kKMGTPE])iB$/.exec(word);
	if (m) return { dims: { B: 1 }, factor: BINARY[m[1] as string] as number };
	m = /^([kKMGTPE]?)(i?)Bps$/.exec(word);
	if (m) return { dims: { B: 1, s: -1 }, factor: (m[2] === "i" && m[1] !== "" ? BINARY : DECIMAL)[m[1] as string] as number };
	m = /^([kKMGTP]?)bps$/.exec(word);
	if (m) return { dims: { B: 1, s: -1 }, factor: (DECIMAL[m[1] as string] as number) / 8 };
	m = /^([kKMGTP])(?:b|bit|bits)$/.exec(word);
	if (m) return { dims: { B: 1 }, factor: (DECIMAL[m[1] as string] as number) / 8 };
	const lower = word.toLowerCase();
	if (lower === "bit" || lower === "bits") return { dims: { B: 1 }, factor: 1 / 8 };
	m = /^(kilo|mega|giga|tera|peta|exa|)(bytes?)$/.exec(lower);
	if (m) return { dims: { B: 1 }, factor: WORD_PREFIX[m[1] as string] as number };
	m = /^(kilo|mega|giga|tera|peta)(bits?)$/.exec(lower);
	if (m) return { dims: { B: 1 }, factor: (WORD_PREFIX[m[1] as string] as number) / 8 };
	if (word === "USD" || lower === "dollar" || lower === "dollars") return { dims: { USD: 1 }, factor: 1 };
	if (lower === "request" || lower === "requests" || lower === "req") return { dims: { req: 1 }, factor: 1 };
	if (word === "IOPS") return { dims: { io: 1, s: -1 }, factor: 1 };
	// Case matters for the short time units (ms, not MS), not for the words (Hours, Hrs, Mo).
	const time = TIME[word] ?? (word.length > 2 ? TIME[lower] : undefined) ?? (word === "Mo" ? MONTH : undefined);
	if (time !== undefined) return { dims: { s: 1 }, factor: time };
	return null;
}

/** A unit word, optionally with a -month suffix (GB-Mo, IOPS-month, GiBps-mo). */
const ATOM = /^(?:[A-Za-zµμ]+)(?:-(?:months|month|Mo|mo)(?![A-Za-z]))?/;

function readAtom(text: string): { dims: Dims; factor: number; length: number } | null {
	const m = ATOM.exec(text);
	if (m === null) return null;
	const [word, suffix] = m[0].split("-") as [string, string | undefined];
	const atom = unitAtom(word);
	if (atom === null) return null;
	if (suffix === undefined) return { ...atom, length: word.length };
	return { dims: multiply(atom.dims, { s: 1 }), factor: atom.factor * MONTH, length: m[0].length };
}

const SCALE: Readonly<Record<string, number>> = {
	thousand: 1e3,
	million: 1e6,
	millions: 1e6,
	billion: 1e9,
	billions: 1e9,
	trillion: 1e12,
	trillions: 1e12,
	bn: 1e9,
	mn: 1e6,
	k: 1e3,
	K: 1e3,
	M: 1e6,
};

/** Words that are never the thing a rate counts: "per the README", "a day of". */
const NOT_A_THING = new Set(
	"the a an each every per of in on at to for and or nor is are was were be been with from that this these those its their our his her one than as by into over under more less about up down so it we you they if then which who what when where not no".split(
		" ",
	),
);
/** A noun: the thing counted in "10000000 GETs per day", or counted by "30.06 µs per write". */
const NOUN = /^[A-Za-z]+(?:-[A-Za-z]+)*/;
/** What joins a unit to its denominator: "/s", " per hour". */
const DENOMINATOR = /^(?:\/| per )/;

function noun(text: string): string | null {
	const word = NOUN.exec(text)?.[0];
	if (word === undefined || NOT_A_THING.has(word.toLowerCase()) || /[A-Za-z0-9_]/.test(text.charAt(word.length))) return null;
	return word;
}

/** A denominator at the start of text: its unit, how many of it ("per 1,000 requests"), and its length; a noun counts as no unit. */
function readDenominator(text: string, nouns: boolean): { dims: Dims; factor: number; length: number } | null {
	const sep = DENOMINATOR.exec(text);
	if (sep === null) return null;
	const timeOnly = false;
	let j = sep[0].length;
	let count = 1;
	const n = /^(\d{1,3}(?:,\d{3})+|\d+) /.exec(text.slice(j));
	if (n !== null && !timeOnly && sep[0] !== "/") {
		count = Number((n[1] as string).replace(/,/g, ""));
		j += n[0].length;
	}
	const den = readAtom(text.slice(j));
	if (den !== null && !/[A-Za-z0-9_]/.test(text.charAt(j + den.length))) {
		if (timeOnly && !sameDims(den.dims, { s: 1 })) return null;
		return { dims: den.dims, factor: den.factor * count, length: j + den.length };
	}
	if (!nouns || timeOnly || count !== 1) return null;
	const word = noun(text.slice(j));
	return word === null ? null : { dims: {}, factor: 1, length: j + word.length };
}

/**
 * The scale word and the unit after a number: "million", "GB/s", " per hour",
 * "-byte", "USD per Hrs", "per 1,000 requests". A count of things per unit of
 * time carries as a rate, and a unit per thing as that unit: the noun is
 * read and adds no dimension ("10000000 GETs per day" is a rate per day,
 * "33269.9 writes/s" one per second, "30.06 µs per write" a time), except
 * requests, which are a dimension of their own because AWS prices them.
 */
function readUnit(text: string, dollar: boolean): { scale: number; unit: Unit; length: number } {
	let i = 0;
	let scale = 1;
	const scaleMatch = /^ ?(thousand|millions?|billions?|trillions?|bn|mn|[kKM])(?![A-Za-z0-9])/.exec(text);
	if (scaleMatch !== null) {
		scale = SCALE[scaleMatch[1] as string] as number;
		i = scaleMatch[0].length;
	}
	let dims: Dims = dollar ? { USD: 1 } : {};
	let factor = 1;
	let unitStart = -1;
	// The numerator: " GB", "GB", "-byte", " USD".
	const numerator = /^(?: |-)?/.exec(text.slice(i))?.[0] ?? "";
	const atom = readAtom(text.slice(i + numerator.length));
	if (atom !== null && !(numerator === "-" && atom.dims.USD !== undefined)) {
		const after = text.charAt(i + numerator.length + atom.length);
		if (!/[A-Za-z0-9_]/.test(after) && !(dollar && atom.dims.USD !== undefined)) {
			unitStart = i + numerator.length;
			dims = multiply(dims, atom.dims);
			factor *= atom.factor;
			i += numerator.length + atom.length;
		}
	}
	// Or the thing a rate counts: " GETs" before " per day" or "/s"; before "/s", up to two words may describe it ("durable writes/s").
	if (unitStart < 0 && !dollar && text.charAt(i) === " ") {
		let j = i;
		for (let words = 0; words < 3 && text.charAt(j) === " "; words++) {
			const word = noun(text.slice(j + 1));
			if (word === null) break;
			j += 1 + word.length;
			const den = readDenominator(text.slice(j), false);
			const tight = text.charAt(j) === "/";
			if (den !== null && sameDims(den.dims, { s: 1 }) && (words === 0 || tight)) {
				unitStart = i + 1;
				i = j;
				break;
			}
		}
	}
	// Denominators: "/s", " per hour", " per GB-month", " per 1,000 requests", " per write", " a day".
	for (;;) {
		const den = readDenominator(text.slice(i), true);
		if (den === null) break;
		if (unitStart < 0) unitStart = i;
		dims = multiply(dims, den.dims, -1);
		factor /= den.factor;
		i += den.length;
	}
	const unitText = unitStart < 0 ? (dollar ? "$" : "") : `${dollar ? "$" : ""}${text.slice(unitStart, i).replace(/^[ -]/, "")}`;
	return { scale, unit: { dims, factor, text: unitText }, length: i };
}

/** A unit written alone, such as AWS's "Hrs", "GB-Mo", "GiBps-mo" or "Requests". */
export function parseUnit(text: string): Unit | null {
	const atom = readAtom(text);
	if (atom === null || atom.length !== text.length) return null;
	return { dims: atom.dims, factor: atom.factor, text };
}

const SUPERSCRIPT: Readonly<Record<string, string>> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-" };

/** The digits of a number: thousands-grouped, plain, or a leading decimal point. */
const CORE = /(\d{1,3}(?:,\d{3})+(?!\d)|\d+)(\.\d+)?|\.\d+/g;
const LETTER = /[\p{L}]/u;
const ALNUM = /[\p{L}\p{N}]/u;

/** Half the place of the last digit of a written number: 0.0005 for "112.269", 0.5 for "30,000,000". */
function halfOfLastDigit(digits: string): number {
	const dot = digits.indexOf(".");
	return dot < 0 ? 0.5 : 0.5 * 10 ** -(digits.length - dot - 1);
}

/**
 * Every number in text, in order, with its sign and unit. A number is not
 * read inside a word: after a letter, digit or underscore (gp3, x86_64, p50),
 * after a letter or digit and a dot (c6i.8xlarge), after a letter and a hyphen
 * (us-east-2, AVX-512), after a word and a slash (HTTP/2), or followed by
 * letters that are no unit or by digits (8375C, 8D49XP354UEYTHGM). A hyphen
 * or minus right before a number, not after a letter or digit, is its sign.
 */
export function quantities(text: string): Quantity[] {
	const found: Quantity[] = [];
	let read = 0;
	for (const match of text.matchAll(CORE)) {
		// Digits inside the quantity just read ("per 1,000 requests") are part of its unit.
		if (match.index < read) continue;
		let start = match.index;
		const digits = match[0];
		const before = text.charAt(start - 1);
		const before2 = text.charAt(start - 2);
		if (/[\p{L}\p{N}_#\\^@]/u.test(before)) continue;
		if (before === "." && ALNUM.test(before2)) continue;
		if (before === "/" && /[\p{L}_.]/u.test(before2)) continue;
		let end = start + digits.length;
		const exponent = /^(?:[eE]([+-]?\d+)(?![\p{L}\p{N}])|\s?[×x*·]\s?10(?:\^([+-]?\d+)|([⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)))/u.exec(text.slice(end));
		const restWord = /^[\p{L}\p{N}_]*/u.exec(text.slice(end + (exponent?.[0].length ?? 0)))?.[0] ?? "";
		if (/[\p{N}_]/u.test(restWord)) continue;

		let dollar = false;
		let sign = 1;
		let signAt = start;
		if (text.charAt(start - 1) === "$") {
			dollar = true;
			signAt = start - 1;
		}
		const s = text.charAt(signAt - 1);
		const s2 = text.charAt(signAt - 2);
		if (s === "-" || s === "−") {
			if (LETTER.test(s2)) continue;
			if (!/[\p{N})]/u.test(s2)) {
				sign = -1;
				signAt -= 1;
			}
		}
		start = signAt;

		let written = Number(digits.replace(/,/g, ""));
		let half = halfOfLastDigit(digits);
		// A whole number's trailing zeros, which a figure rounded to fewer digits leaves.
		const zeros = digits.includes(".") ? 0 : (/0*$/.exec(digits.replace(/,/g, ""))?.[0].length ?? 0);
		let power = false;
		const bare = /^\^([+-]?\d+)/.exec(text.slice(end));
		if (exponent !== null) {
			const e = Number(exponent[1] ?? exponent[2] ?? [...(exponent[3] ?? "")].map((c) => SUPERSCRIPT[c] ?? "").join(""));
			written *= 10 ** e;
			half *= 10 ** e;
			end += exponent[0].length;
		} else if (bare !== null && !digits.includes(".")) {
			written **= Number(bare[1]);
			half = 0;
			power = true;
			end += bare[0].length;
		}

		if (text.charAt(end) === "%") {
			const looseHalf = power || exponent !== null ? half : half * 10 ** Math.min(zeros, digits.replace(/,/g, "").length - 1);
			found.push({ text: text.slice(start, end + 1), start, end: end + 1, written: sign * written, half, looseHalf, unit: { dims: {}, factor: 0.01, text: "%" }, value: sign * written * 0.01, power, alt: null });
			read = end + 1;
			continue;
		}
		const unit = readUnit(text.slice(end), dollar);
		// Letters stuck to the number that are no unit make it part of a name (8375C), except "x" (3x).
		const stuck = /^[\p{L}]+/u.exec(text.slice(end))?.[0];
		if (stuck !== undefined && unit.length === 0 && stuck !== "x") continue;
		written *= unit.scale;
		half *= unit.scale;
		end += unit.length;
		const looseHalf = (power || exponent !== null ? half : half * 10 ** Math.min(zeros, digits.replace(/,/g, "").length - 1));
		const article = /^ (?:a|an|each|every) ([A-Za-z]+)(?![A-Za-z0-9])/.exec(text.slice(end));
		const time = article === null ? null : unitAtom(article[1] as string);
		const alt = time !== null && sameDims(time.dims, { s: 1 }) ? { dims: multiply(unit.unit.dims, time.dims, -1), factor: unit.unit.factor / time.factor, text: `${unit.unit.text}${article?.[0]}` } : null;
		found.push({ text: text.slice(start, end), start, end, written: sign * written, half, looseHalf, unit: unit.unit, value: sign * written * unit.unit.factor, power, alt });
		read = end;
	}
	return found;
}

const SMALL_WORDS = new Set(
	"zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety dozen".split(" "),
);
const MAGNITUDE_WORDS = new Set(["hundred", "thousand", "million", "billion", "trillion"]);
const PLURAL_MAGNITUDES = new Set(["hundreds", "thousands", "millions", "billions", "trillions", "dozens"]);

/**
 * Number words that state a quantity, which the checker reports, since the
 * skill asks for digits: a run of number words ("thirty", "thirty-two",
 * "one hundred and twenty") that holds a magnitude word (hundred, thousand,
 * million, billion, trillion), or that is followed by a unit the checker
 * knows ("two GB", "five seconds", "ten percent"). Other
 * number words in prose ("two machines", "two limits apply") are words, and
 * so are vague plurals ("thousands of players").
 */
export function quantityWords(text: string): Array<{ phrase: string; words: string[]; start: number }> {
	const found: Array<{ phrase: string; words: string[]; start: number }> = [];
	const words = [...text.matchAll(/[A-Za-z]+/g)];
	let k = 0;
	while (k < words.length) {
		const first = words[k] as RegExpMatchArray;
		if (!SMALL_WORDS.has(first[0].toLowerCase()) && !MAGNITUDE_WORDS.has(first[0].toLowerCase())) {
			k++;
			continue;
		}
		const group = [first];
		let j = k + 1;
		for (; j < words.length; j++) {
			const w = words[j] as RegExpMatchArray;
			const lower = w[0].toLowerCase();
			const prev = group[group.length - 1] as RegExpMatchArray;
			const between = text.slice((prev.index as number) + prev[0].length, w.index);
			if (lower === "and" && /^\s+$/.test(between)) {
				const after = words[j + 1];
				if (after !== undefined && (SMALL_WORDS.has(after[0].toLowerCase()) || MAGNITUDE_WORDS.has(after[0].toLowerCase()))) continue;
				break;
			}
			if (!/^[\s-]+$/.test(between) && !(between.trim() === "and")) break;
			if (!SMALL_WORDS.has(lower) && !MAGNITUDE_WORDS.has(lower)) break;
			group.push(w);
		}
		const last = group[group.length - 1] as RegExpMatchArray;
		const end = (last.index as number) + last[0].length;
		// The next word, whole: not the start of us-east-2 or c6i.8xlarge, though a full stop may end it.
		const next = /^[\s-]+([A-Za-zµμ%]+)(?![A-Za-z0-9]|[.-][A-Za-z0-9])/.exec(text.slice(end))?.[1];
		const magnitude = group.some((w) => MAGNITUDE_WORDS.has(w[0].toLowerCase()));
		const unit =
			next !== undefined &&
			!PLURAL_MAGNITUDES.has(next.toLowerCase()) &&
			(unitAtom(next) !== null || /^percent$/i.test(next));
		if (magnitude || unit) {
			const start = first.index as number;
			found.push({ phrase: text.slice(start, end), words: group.map((w) => w[0].toLowerCase()), start });
		}
		k = j;
	}
	return found;
}

export function sameUnit(a: Pick<Unit, "dims" | "factor">, b: Pick<Unit, "dims" | "factor">): boolean {
	return sameDims(a.dims, b.dims) && Math.abs(a.factor - b.factor) <= 1e-12 * Math.max(Math.abs(a.factor), Math.abs(b.factor));
}

/**
 * Whether a value is within a written number's rounding: strictly less than
 * half its last digit away (a value exactly halfway rounds either way, so the
 * digits do not imply it), or equal but for floating-point noise.
 */
export function withinRounding(written: number, half: number, value: number): boolean {
	const diff = Math.abs(value - written);
	return diff < half * (1 - 1e-9) || diff <= 1e-12 * Math.max(Math.abs(value), Math.abs(written));
}

/**
 * Whether a written quantity is a value with these dimensions, as its digits
 * round it: the value, in the written unit, rounds to the written number at
 * its last digit.
 */
export function agrees(q: Quantity, value: number, dims: Dims): boolean {
	return sameDims(q.unit.dims, dims) && withinRounding(q.written, q.half, value / q.unit.factor);
}

