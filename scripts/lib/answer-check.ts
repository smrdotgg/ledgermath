/**
 * The answer checker (scripts/check-answer.ts). One rule: every number in an
 * answer, code blocks and tables included, is exactly one of
 *
 * - from the question: the same value and unit as a number in the question;
 * - cited: the nearest citation after it on its line resolves, and the number
 *   is the cited value, in the cited unit (a measured number may be written
 *   with another prefix or time unit of the same dimensions; a price only in
 *   AWS's own unit; a parameter whose key ends in a unit, bare or in that
 *   unit). A benchmark citation ([lm:benchmark/…]) describes and attaches to
 *   no number;
 * - an assumption: the nearest marker after it on its line is
 *   [assumption: <source>], and the source has words;
 * - derived: the result of a line of arithmetic (a = b, a ≈ b, or a → b for
 *   rounding up, down or to nearest at the result's last significant digit)
 *   whose operands are all accounted for, at least one of them not a
 *   conversion constant, and whose result the checker recomputes and finds
 *   equal within the rounding of the digits written, either with units
 *   carried or as plain numbers exactly as written;
 * - a repeat of a number accounted for anywhere in the answer, with the same
 *   value, as its digits round it (fewer digits allowed: 33300 for 33269.9),
 *   and the same dimensions, a count of requests aside; a time after it in
 *   prose ("216000000 an hour") may be read as its unit or not.
 *
 * A count of things per unit of time carries as a rate ("10000000 GETs per
 * day", "33269.9 writes/s"), and a unit per thing as that unit ("30.06 µs per
 * write"): the reciprocal of a time per thing is a rate of things.
 *
 * Each first cause is reported once: a number that fails only because it uses
 * or repeats another unaccounted number is counted against that one, not
 * reported again. Every problem says what was expected, what was found, and
 * what would fix it.
 *
 * Inside a line of arithmetic, a pure unit-conversion constant (CONSTANTS)
 * may be an operand. Anything else is a problem, and so are: a citation or
 * assumption marker that does not parse (a marker is read to its closing
 * bracket, across a line break, but not past a blank line or the next
 * marker), a quantity written in words (quantityWords: with a magnitude word,
 * or before a unit, unless every word is in the question), a Run link that is
 * neither the bare path, a relative path ending with it, its address in the
 * data API nor the Runs repository's address of it (or one that is no Run of a
 * Series the answer cites, or a file whose bytes differ from the sha256 its
 * point in the data gives), and a cited Series none of whose Runs the answer
 * links.
 *
 * Not numbers: what is inside a citation or marker; a quotation that is
 * verbatim text of a price record (its description, or the catalog words)
 * cited on the same line; Run links, price files' paths and web addresses;
 * dates (2026-11-11, November 11, 2026, 11 November 2026) and times of day;
 * ids and hashes; IPv4 addresses and address blocks (52.219.0.0/16), as the
 * breakdown of a Series of requests names them; the numbers of list items, headings and footnotes; a whole
 * number right after a label word ("Tier 1", "Step 2"); key=value text that is
 * a parameter, with its value, of a Series the answer cites; and digits
 * inside a name (c6i.8xlarge, p50, gp3, 8375C).
 *
 * A written number stands for every value that rounds to it at its last
 * written digit: $0.10 for $0.096, 112 MB/s for 112.269 MB/s, 130 for 129.5 to
 * 130.5. A range writes its unit once: an end with no unit, or with only $,
 * takes the other end's ("13.2 to 14.0 GB/s", "$92.48 to $104.72 per hour").
 * Two numbers without dimensions repeat each other only in the same unit.
 *
 * It reads numbers, not meaning: a number that is its citation's value, in its
 * unit, is cited, whatever the words around it say the figure is (a pooled
 * 99th percentile across requests called "the first Run's" passes).
 */

import { createHash } from "node:crypto";

import { citationMismatch, NUMBER_UNIT, type Resolved, resolveCitation, RUN_PATH, seriesMoment } from "./citation";
import { findRun, type LedgerData } from "./ledger-data";
import { agrees, type Dims, dimsWords, multiply, type Quantity, quantities, quantityWords, readable, sameDims } from "./quantity";
import { RUNS_REPOSITORY } from "./runs-repository";

export type NumberStatus = "question" | "cited" | "assumption" | "derived" | "repeat" | "constant" | "unaccounted";

export interface CheckedNumber {
	line: number;
	text: string;
	status: NumberStatus;
	detail: string;
}

export interface Problem {
	line: number | null;
	message: string;
}

export interface CheckedCitation {
	line: number;
	citation: string;
	resolved: string | null;
	problem: string | null;
}

export interface CheckReport {
	pass: boolean;
	problems: Problem[];
	numbers: CheckedNumber[];
	citations: CheckedCitation[];
	run_links: Array<{ line: number; link: string; path: string; problem: string | null }>;
	notes: Problem[];
}

/**
 * Pure unit-conversion constants, accepted as operands inside a line of
 * arithmetic and nowhere else: one (for a reciprocal), bits per byte, hours
 * per day, seconds per minute and minutes per hour, percent, days per year,
 * AWS's hours per month and per year, seconds per hour and per day, and the
 * decimal and binary prefixes. A ratio of units worth exactly one written
 * with its units ("1000000 µs/s", "3600 s per hour", "730 hours per month") is
 * one too; "30 days per month" is not, since it is not exactly one.
 */
export const CONSTANTS: ReadonlySet<number> = new Set([1, 8, 24, 60, 100, 365, 730, 1000, 1024, 3600, 8760, 86400, 1e6, 1e9, 1e12, 1e15, 1e18, 2 ** 20, 2 ** 30, 2 ** 40, 2 ** 50]);

/** Counts of things that are dimensions of their own (requests, I/O operations), which a question's number never names. */
const COUNTS = new Set(["req", "io"]);

/** Dimensions with the counts of things left out: how a number is matched against the question, a repeat, or a recomputed result. */
function withoutCounts(dims: Dims): Dims {
	return Object.fromEntries(Object.entries(dims).filter(([d]) => !COUNTS.has(d))) as Dims;
}

/** agrees(), with counts of things left out of both units. */
function agreesWithoutCounts(q: Quantity, value: number, dims: Dims): boolean {
	return agrees({ ...q, unit: { ...q.unit, dims: withoutCounts(q.unit.dims) } }, value, withoutCounts(dims));
}

/**
 * How a repeat in prose is matched: without counts of things, allowed fewer
 * digits (33300 for 33269.9), and with the time after it in prose or without
 * ("216000000 an hour" repeats "216000000 writes per hour").
 */
function repeats(q: Quantity, value: number, dims: Dims): boolean {
	const loose = { ...q, half: q.looseHalf };
	if (agreesWithoutCounts(loose, value, dims)) return true;
	return q.alt !== null && agreesWithoutCounts({ ...loose, unit: q.alt, value: q.written * q.alt.factor }, value, dims);
}

/** Addresses at which the Runs repository shows a Run, before its path. */
const RUNS_REPOSITORY_PREFIXES: readonly RegExp[] = [
	new RegExp(`^https://github\\.com/${RUNS_REPOSITORY}/blob/(?:main|[0-9a-f]{40})/$`),
	new RegExp(`^https://raw\\.githubusercontent\\.com/${RUNS_REPOSITORY}/(?:main|[0-9a-f]{40})/$`),
];

const MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)";

/** Spans that hold no number of the answer's. */
const MASKS: readonly RegExp[] = [
	/https?:\/\/[^\s)\]>]+/g,
	// A price file's path, in prose or under Sources.
	/(?:[\w.-]+\/)*prices\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/aws\.json/g,
	// Dates with a month's name and a year: November 11, 2026; 11 November 2026; Nov. 11 2026; November 2026.
	new RegExp(`\\b${MONTH}\\.?[ \\t]+[0-9]{1,2}(?:st|nd|rd|th)?,?[ \\t]+(?:19|20)[0-9]{2}\\b`, "g"),
	new RegExp(`\\b[0-9]{1,2}(?:st|nd|rd|th)?[ \\t]+${MONTH}\\.?,?[ \\t]+(?:19|20)[0-9]{2}\\b`, "g"),
	new RegExp(`\\b${MONTH}\\.?,?[ \\t]+(?:19|20)[0-9]{2}\\b`, "g"),
	/\b[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?Z?)?/g,
	/\b[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\b/g,
	// An IPv4 address or address block: 52.219.176.66, 3.5.0.0/16.
	/(?<![\w.])[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:\/[0-9]{1,2})?(?![\w.])/g,
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
	/\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi,
	/^\s*(?:#+\s*)?(?:[-*+]\s+)?[0-9]+[.)](?=\s)/g,
	/\[[0-9]+\]/g,
];

const SEPARATOR = /(?<![<>=!~])(?:=(?!=)|≈|→)/g;
/** Where one clause of a line ends: a semicolon, or a comma, colon or full stop followed by a space. */
const CLAUSE = /;|[,:.](?=\s)/g;
const RANGE_WORD = /^\s*(?:to|–|—|-)\s*$/;
/** A label word right before a number: "Tier 1", "Step 2", "Scenario 3". */
const LABEL = /\b(?:Tier|Step|Scenario|Option|Case|Phase|Line|Table|Figure|Section)[ \u00a0]$/i;
/** key=value, as the tool prints a Series' parameters. */
const PARAMETER = /(?<![\w.\/-])([A-Za-z_][A-Za-z0-9_]*)=([^\s,;)\]}"'`]+)/g;

/**
 * Whether what comes before a Run's path in a link is nothing, or a relative
 * path into a directory: no scheme, no leading slash, no host name first.
 */
function isRelativePrefix(prefix: string): boolean {
	if (prefix === "") return true;
	if (!prefix.endsWith("/") || prefix.includes("://") || prefix.startsWith("/")) return false;
	const first = prefix.split("/")[0] as string;
	return !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(first);
}

interface Marker {
	start: number;
	end: number;
	kind: "citation" | "assumption";
	text: string;
	inside: string;
	/** Why it is not a well-formed marker, or null. */
	malformed: string | null;
}

interface Num {
	line: number;
	q: Quantity;
	status: NumberStatus | null;
	detail: string;
	/** The value its citation resolved to, in base units, for repeats. */
	exact: number | null;
	problem: string | null;
	/** It counts Runs or boots ("3 Runs"), which only a count citation accounts for. */
	countsRuns: boolean;
	/** It is cited with a Series' count citation. */
	countCited: boolean;
	/** The problem already reporting it (its citation does not resolve or parse), which its dependants' count is added to. */
	reportedBy?: Problem;
}

type Token = { kind: "num"; num: Num } | { kind: "op"; op: string };

interface Step {
	line: number;
	/** The expression's tokens, or null for a rounding of `from`. */
	tokens: Token[] | null;
	from: Num | null;
	result: Num;
	/** "→": the result rounds the value before it up, down or to nearest. */
	rounds: boolean;
	done: boolean;
}

function blank(text: string, start: number, end: number): string {
	return text.slice(0, start) + " ".repeat(Math.max(0, end - start)) + text.slice(end);
}

/**
 * Every citation and assumption marker in the whole answer, each read to its
 * closing bracket, across a line break if need be; a marker with no closing
 * bracket before a blank line or the next marker is unclosed. A line break
 * inside a citation, which holds no spaces, is dropped; inside an assumption's
 * source it reads as a space.
 */
function findMarkers(text: string): Marker[] {
	const openings = [
		...[...text.matchAll(/\[lm:/g)].map((m) => ({ at: m.index, kind: "citation" as const })),
		...[...text.matchAll(/\[assumption\b/gi)].map((m) => ({ at: m.index, kind: "assumption" as const })),
	].sort((a, b) => a.at - b.at);
	const markers: Marker[] = [];
	for (const [k, opening] of openings.entries()) {
		const start = opening.at;
		const nextOpening = openings[k + 1]?.at ?? text.length;
		const blankLine = text.indexOf("\n\n", start);
		const limit = Math.min(nextOpening, blankLine < 0 ? text.length : blankLine);
		const close = text.indexOf("]", start);
		const closed = close >= 0 && close < limit;
		if (opening.kind === "citation") {
			const end = closed ? close + 1 : start + (/^\S*/.exec(text.slice(start))?.[0].length ?? 4);
			const inside = text.slice(start + 4, closed ? close : end).replace(/[ \t]*\n[ \t]*/g, "");
			const malformed = !closed ? "it has no closing ]" : /\s/.test(inside) ? "it holds a space" : null;
			markers.push({ start, end, kind: "citation", text: closed ? `[lm:${inside}]` : text.slice(start, end), inside, malformed });
			continue;
		}
		const lineEnd = text.indexOf("\n", start);
		const end = closed ? close + 1 : lineEnd < 0 ? text.length : lineEnd;
		const joined = text.slice(start, end).replace(/\s*\n\s*/g, " ");
		const body = /^\[assumption:\s*([^\]]*)\]$/i.exec(joined);
		const source = body?.[1]?.trim() ?? "";
		const malformed = !closed ? "it has no closing ]" : body === null ? "it is not [assumption: <source>]" : !/\p{L}{2,}/u.test(source) ? "its source has no words" : null;
		markers.push({ start, end, kind: "assumption", text: joined, inside: source, malformed });
	}
	return markers;
}

/** The whole token a Run path is written in: from the last space, (, <, quote or backtick before it. */
function linkToken(text: string, start: number, end: number): string {
	let from = start;
	while (from > 0 && !/[\s(<"'`[]/.test(text.charAt(from - 1))) from--;
	return text.slice(from, end);
}

/**
 * A number of the question, and the same number per unit of time when the
 * sentence says so after it: "10 TB … per second", "10 million objects a
 * day", "… each hour".
 */
function questionQuantities(question: string): Quantity[] {
	const out: Quantity[] = [];
	for (const q of quantities(question)) {
		out.push(q);
		const sentence = question.slice(q.end).split(/[.?!](?:\s|$)/)[0] ?? "";
		const per = /\b(?:per|an?|each|every) (second|minute|hour|day|week|month|year)\b/.exec(sentence);
		if (per !== null && q.unit.dims.s === undefined) {
			const seconds = { second: 1, minute: 60, hour: 3600, day: 86400, week: 7 * 86400, month: 730 * 3600, year: 8760 * 3600 }[per[1] as string] as number;
			const unit = { dims: multiply(q.unit.dims, { s: 1 }, -1), factor: q.unit.factor / seconds, text: `${q.unit.text} per ${per[1]}` };
			out.push({ ...q, unit, value: q.written * unit.factor });
		}
	}
	return out;
}

const isAccounted = (n: Num): boolean =>
	n.status === "question" || n.status === "cited" || n.status === "assumption" || n.status === "derived" || n.status === "repeat";

/**
 * Whether two numbers may repeat each other: any with the same dimensions, but
 * two without dimensions only in the same unit, so that a ratio such as
 * "1000 GB per TB", which is 1, is not repeated by every bare 1.
 */
function sameKind(a: Quantity, b: Quantity): boolean {
	if (Object.keys(a.unit.dims).length > 0 || Object.keys(b.unit.dims).length > 0) return true;
	return Math.abs(a.unit.factor - b.unit.factor) <= 1e-12 * Math.max(a.unit.factor, b.unit.factor);
}

function isConstant(n: Num): boolean {
	if (Object.keys(n.q.unit.dims).length > 0 || n.q.written <= 0 || n.q.unit.text === "%") return false;
	if (n.q.unit.factor === 1) return CONSTANTS.has(n.q.written);
	return n.q.unit.text !== "" && Math.abs(n.q.value - 1) <= 1e-12;
}

interface Interval {
	lo: number;
	hi: number;
	dims: Dims;
	/** Whether the dimensions held together through + and −. */
	consistent: boolean;
	wlo: number;
	whi: number;
}

function operand(n: Num): Interval {
	const exact = isConstant(n) || n.q.power;
	const half = exact ? 0 : n.q.half;
	const f = n.q.unit.factor;
	const a = (n.q.written - half) * f;
	const b = (n.q.written + half) * f;
	const wf = f === 0.01 ? 0.01 : 1;
	return { lo: Math.min(a, b), hi: Math.max(a, b), dims: n.q.unit.dims, consistent: true, wlo: (n.q.written - half) * wf, whi: (n.q.written + half) * wf };
}

function combine(x: Interval, y: Interval, op: string): Interval | null {
	const span = (f: (a: number, b: number) => number, a: [number, number], b: [number, number]): [number, number] => {
		const values = [f(a[0], b[0]), f(a[0], b[1]), f(a[1], b[0]), f(a[1], b[1])];
		return [Math.min(...values), Math.max(...values)];
	};
	switch (op) {
		case "×": {
			const [lo, hi] = span((a, b) => a * b, [x.lo, x.hi], [y.lo, y.hi]);
			const [wlo, whi] = span((a, b) => a * b, [x.wlo, x.whi], [y.wlo, y.whi]);
			return { lo, hi, wlo, whi, dims: multiply(x.dims, y.dims), consistent: x.consistent && y.consistent };
		}
		case "÷": {
			if (y.lo <= 0 && y.hi >= 0) return null;
			if (y.wlo <= 0 && y.whi >= 0) return null;
			const [lo, hi] = span((a, b) => a / b, [x.lo, x.hi], [y.lo, y.hi]);
			const [wlo, whi] = span((a, b) => a / b, [x.wlo, x.whi], [y.wlo, y.whi]);
			return { lo, hi, wlo, whi, dims: multiply(x.dims, y.dims, -1), consistent: x.consistent && y.consistent };
		}
		case "+":
		case "−": {
			const s = op === "+" ? 1 : -1;
			const lo = s > 0 ? x.lo + y.lo : x.lo - y.hi;
			const hi = s > 0 ? x.hi + y.hi : x.hi - y.lo;
			const wlo = s > 0 ? x.wlo + y.wlo : x.wlo - y.whi;
			const whi = s > 0 ? x.whi + y.whi : x.whi - y.wlo;
			return { lo, hi, wlo, whi, dims: x.dims, consistent: x.consistent && y.consistent && sameDims(x.dims, y.dims) };
		}
		case "^": {
			if (Object.keys(y.dims).length > 0 || y.lo !== y.hi || !Number.isInteger(y.lo)) return null;
			const e = y.lo;
			const [lo, hi] = [x.lo ** e, x.hi ** e].sort((a, b) => a - b) as [number, number];
			const [wlo, whi] = [x.wlo ** e, x.whi ** e].sort((a, b) => a - b) as [number, number];
			let dims: Dims = {};
			for (let i = 0; i < Math.abs(e); i++) dims = multiply(dims, x.dims, Math.sign(e));
			return { lo, hi, wlo, whi, dims, consistent: x.consistent };
		}
		default:
			return null;
	}
}

/** Evaluates tokens with the usual precedence; null when they are not an expression. */
function evaluate(tokens: Token[]): Interval | null {
	let i = 0;
	const peek = (): Token | undefined => tokens[i];
	const primary = (): Interval | null => {
		const t = peek();
		if (t === undefined) return null;
		if (t.kind === "op" && t.op === "(") {
			i++;
			const v = sum();
			const close = peek();
			if (v === null || close === undefined || close.kind !== "op" || close.op !== ")") return null;
			i++;
			return v;
		}
		if (t.kind === "num") {
			i++;
			return operand(t.num);
		}
		return null;
	};
	const power = (): Interval | null => {
		let v = primary();
		while (v !== null && peek()?.kind === "op" && (peek() as { op: string }).op === "^") {
			i++;
			const e = primary();
			v = e === null ? null : combine(v, e, "^");
		}
		return v;
	};
	const product = (): Interval | null => {
		let v = power();
		while (v !== null && peek()?.kind === "op" && ["×", "÷"].includes((peek() as { op: string }).op)) {
			const op = (peek() as { op: string }).op;
			i++;
			const w = power();
			v = w === null ? null : combine(v, w, op);
		}
		return v;
	};
	const sum = (): Interval | null => {
		let v = product();
		while (v !== null && peek()?.kind === "op" && ["+", "−"].includes((peek() as { op: string }).op)) {
			const op = (peek() as { op: string }).op;
			i++;
			const w = product();
			v = w === null ? null : combine(v, w, op);
		}
		return v;
	};
	const v = sum();
	return v !== null && i === tokens.length ? v : null;
}

/** The numbers and operators of one segment of a line, words skipped. */
function tokenize(masked: string, from: number, to: number, nums: Num[]): Token[] {
	const tokens: Token[] = [];
	let i = from;
	while (i < to) {
		const num = nums.find((n) => n.q.start === i);
		if (num !== undefined) {
			tokens.push({ kind: "num", num });
			i = num.q.end;
			continue;
		}
		const c = masked.charAt(i);
		const spaced = masked.charAt(i - 1) === " " && masked.charAt(i + 1) === " ";
		if ("×*·".includes(c) || (c === "x" && spaced)) tokens.push({ kind: "op", op: "×" });
		else if ("÷/".includes(c)) tokens.push({ kind: "op", op: "÷" });
		else if (c === "+") tokens.push({ kind: "op", op: "+" });
		else if (c === "−" || ((c === "-" || c === "–") && spaced)) tokens.push({ kind: "op", op: "−" });
		else if (c === "^") tokens.push({ kind: "op", op: "^" });
		else if (c === "(" || c === ")") tokens.push({ kind: "op", op: c });
		i++;
	}
	// Brackets around words only ("(p50)") are not part of the expression.
	return tokens.filter((t, k) => !(t.kind === "op" && t.op === "(" && tokens[k + 1]?.kind === "op" && (tokens[k + 1] as { op: string }).op === ")") && !(t.kind === "op" && t.op === ")" && tokens[k - 1]?.kind === "op" && (tokens[k - 1] as { op: string }).op === "("));
}

function arithmeticSteps(line: number, masked: string, nums: Num[]): Step[] {
	const steps: Step[] = [];
	let clauseStart = 0;
	for (const clauseEnd of [...[...masked.matchAll(CLAUSE)].map((m) => m.index), masked.length]) {
		const clause = masked.slice(clauseStart, clauseEnd);
		const seps = [...clause.matchAll(SEPARATOR)].map((m) => ({ at: clauseStart + m.index, rounds: m[0] === "→" }));
		if (seps.length > 0) {
			const bounds = [{ at: clauseStart - 1, rounds: false }, ...seps, { at: clauseEnd, rounds: false }];
			let previous: { tokens: Token[] | null; single: Num | null } = { tokens: null, single: null };
			for (let s = 0; s + 1 < bounds.length; s++) {
				const from = (bounds[s] as { at: number }).at + 1;
				const to = (bounds[s + 1] as { at: number }).at;
				const inSegment = nums.filter((n) => n.q.start >= from && n.q.end <= to);
				const tokens = tokenize(masked, from, to, inSegment);
				const isExpression = tokens.some((t) => t.kind === "op" && !"()".includes(t.op)) && inSegment.length >= 2;
				const single = inSegment.length === 1 && !isExpression ? (inSegment[0] as Num) : null;
				const rounds = (bounds[s] as { rounds: boolean }).rounds;
				if (s > 0 && single !== null) {
					if (previous.tokens !== null) steps.push({ line, tokens: previous.tokens, from: null, result: single, rounds, done: false });
					else if (rounds && previous.single !== null) steps.push({ line, tokens: null, from: previous.single, result: single, rounds, done: false });
				}
				previous = { tokens: isExpression ? tokens : null, single };
			}
		}
		clauseStart = clauseEnd + 1;
	}
	return steps;
}

function describe(resolved: Resolved): string {
	if (!resolved.ok) return resolved.reason;
	switch (resolved.kind) {
		case "measured":
			return `${resolved.stat} of ${resolved.number}${resolved.group === null ? "" : ` (group ${resolved.group})`} of Series ${resolved.series.id} (${resolved.series.benchmark} on ${resolved.series.instance_type}) as of ${resolved.moment}: ${resolved.value}${resolved.stat === "count" ? " counted Runs" : ` ${NUMBER_UNIT[resolved.number].unit}`}`;
		case "requests": {
			const scope = resolved.group !== null ? ` (group ${resolved.group})` : resolved.by !== null ? ` (requests with ${resolved.by.fact} ${resolved.by.value})` : "";
			const what = resolved.phase === null ? resolved.stat : `${resolved.stat} of ${resolved.phase}`;
			const unit = resolved.unit === "ns" ? " ns" : resolved.stat === "runs" ? " counted Runs" : " requests";
			return `${what}${scope} of the requests of Series ${resolved.series.id} (${resolved.series.benchmark} on ${resolved.series.instance_type}) as of ${resolved.moment}, Method requests v1: ${resolved.value}${unit}`;
		}
		case "param":
			return `parameter ${resolved.key} of Series ${resolved.series.id}: ${String(resolved.value)}`;
		case "price":
			return `${resolved.usd} USD per ${resolved.awsUnit} ("${resolved.description}"), price file of ${resolved.date}`;
		case "attribute":
			return `${resolved.name} of SKU ${resolved.sku}: "${resolved.text}", price file of ${resolved.date}`;
		case "range":
			return `${resolved.end} of rate ${resolved.rateCode}: ${resolved.text} ${resolved.awsUnit}, price file of ${resolved.date}`;
		case "benchmark":
			return `the description of benchmark ${resolved.name}`;
	}
}

/** A recomputed interval as a person reads it: "about X", with the range its operands' rounding leaves when that is wide. */
function about(lo: number, hi: number): string {
	const mid = (lo + hi) / 2;
	const wide = Math.abs(hi - lo) > 1e-3 * Math.max(Math.abs(mid), 1e-300);
	return wide ? `about ${readable(mid)} (${readable(lo)} to ${readable(hi)}, given how its operands are rounded)` : `about ${readable(mid)}`;
}

/** What a line's operands give, both ways the checker accepts, beside the result as written. */
function expectedOf(computed: Interval | null, r: Quantity): string {
	if (computed === null) return "an expression the checker can compute, but its operators and numbers do not form one (check for a stray operator, or a number in its label)";
	const digits = about(computed.wlo, computed.whi);
	if (!computed.consistent) return `${digits} from the numbers as written (with their units they cannot be added, being of different kinds)`;
	if (sameDims(withoutCounts(computed.dims), withoutCounts(r.unit.dims))) {
		const lo = computed.lo / r.unit.factor;
		const hi = computed.hi / r.unit.factor;
		const unit = r.unit.text === "" ? "" : ` ${r.unit.text}`;
		const same = Math.abs(lo - computed.wlo) <= 1e-9 * Math.max(Math.abs(lo), 1e-300) && Math.abs(hi - computed.whi) <= 1e-9 * Math.max(Math.abs(hi), 1e-300);
		return same ? `${digits}${unit}, from the numbers as written and with their units` : `${digits} from the numbers as written, or ${about(lo, hi)}${unit} with their units`;
	}
	return `${digits} from the numbers as written, or with their units a value in ${dimsWords(computed.dims)}, where the result is written in ${r.unit.text === "" ? "no unit" : dimsWords(r.unit.dims)}`;
}

/**
 * Settles every number still unaccounted for, and reports each first cause
 * once. A number that fails only because it uses another unaccounted number
 * (an operand of the line that computes it) or would repeat one is that
 * number's dependant: it is not reported again, and the first cause says how
 * many depend on it.
 */
function reportUnaccounted(all: Num[], steps: Step[], problems: Problem[]): void {
	const operandsOf = (s: Step): Num[] => (s.tokens ?? []).filter((t): t is { kind: "num"; num: Num } => t.kind === "num").map((t) => t.num);
	const stepOf = new Map<Num, Step>(steps.map((s) => [s.result, s]));
	const stepWithOperand = new Map<Num, Step>(steps.flatMap((s) => operandsOf(s).map((o) => [o, s] as [Num, Step])));
	const unaccounted = (n: Num): boolean => n.status === null || n.status === "unaccounted";
	const dependsOn = new Map<Num, Num>();
	const roots = new Set<Num>();

	for (const n of all) {
		if (n.status === "unaccounted") {
			// It failed on its own: arithmetic that does not give it, a citation that does not match, resolve or parse, a marker with no source.
			roots.add(n);
			continue;
		}
		if (n.status !== null) continue;
		n.status = "unaccounted";
		const step = stepOf.get(n);
		const operands = step === undefined ? [] : step.tokens === null ? [step.from as Num] : operandsOf(step);
		if (n.countsRuns) {
			n.detail = "a count of Runs or boots is accounted for only by a Series' count citation, or as a repeat of a number cited by one";
			n.problem = `"${n.q.text.trim()}" counts Runs or boots: expected a Series' count citation right after it, or the same count cited elsewhere; found neither. To fix, cite it with the count citation the tool prints.`;
			roots.add(n);
			continue;
		}
		if (step !== undefined && step.tokens !== null && operands.every(isConstant)) {
			n.detail = "the result of arithmetic whose operands are only conversion constants";
			n.problem = `"${n.q.text.trim()}" is computed only from conversion constants: expected at least one operand that is cited, assumed, from the question or computed above; found none. To fix, cite or assume the quantity being converted.`;
			roots.add(n);
			continue;
		}
		const blocking = operands.find((o) => !isConstant(o) && unaccounted(o));
		if (step !== undefined && blocking !== undefined) {
			n.detail = "the result of arithmetic whose operands are not all accounted for";
			dependsOn.set(n, blocking);
			continue;
		}
		const owner = stepWithOperand.get(n);
		if (isConstant(n) && owner !== undefined) {
			n.detail = "a conversion constant in arithmetic that has no accounted operand";
			const other = operandsOf(owner).find((o) => o !== n && !isConstant(o) && unaccounted(o)) ?? owner.result;
			dependsOn.set(n, other);
			continue;
		}
		// A number that would repeat another unaccounted one depends on it; a computed one first.
		const like = all.filter((k) => k !== n && unaccounted(k) && sameKind(n.q, k.q) && repeats(n.q, k.q.value, k.q.unit.dims));
		const source = like.find((k) => stepOf.has(k)) ?? like.find((k) => all.indexOf(k) < all.indexOf(n));
		n.detail = `no citation or assumption after it; not in the question; not the result of arithmetic; not a repeat of a number accounted for${stepWithOperand.has(n) ? " (an operand of arithmetic)" : ""}`;
		if (source !== undefined) {
			dependsOn.set(n, source);
			continue;
		}
		n.problem = `"${n.q.text.trim()}" is not accounted for: nothing cites it, marks it as an assumption or computes it, and the same value and unit is neither in the question nor stated by a number accounted for. To fix, put a citation or [assumption: <source>] right after it, or show the arithmetic that gives it.`;
		roots.add(n);
	}

	const rootOf = (n: Num): Num => {
		const seen = new Set<Num>();
		let at = n;
		while (!roots.has(at) && dependsOn.has(at) && !seen.has(at)) {
			seen.add(at);
			at = dependsOn.get(at) as Num;
		}
		return at;
	};
	const dependants = new Map<Num, Num[]>();
	for (const n of all) {
		if (n.status !== "unaccounted" || roots.has(n)) continue;
		const root = rootOf(n);
		if (root === n) {
			// A circle of numbers that only repeat one another: the first of them is the cause.
			n.problem = `"${n.q.text.trim()}" is not accounted for: it only repeats numbers that are themselves not accounted for. To fix, cite, assume or compute one of them.`;
			roots.add(n);
			continue;
		}
		roots.add(root);
		dependants.set(root, [...(dependants.get(root) ?? []), n]);
		n.detail = `${n.detail}; it depends on "${root.q.text.trim()}" (line ${root.line}), which is not accounted for`;
	}
	for (const root of all.filter((n) => roots.has(n))) {
		const later = dependants.get(root) ?? [];
		const lines = [...new Set(later.map((n) => n.line))].sort((a, b) => a - b);
		const shown = lines.length > 8 ? `${lines.slice(0, 8).join(", ")}, …` : lines.join(", ");
		const suffix = later.length === 0 ? "" : ` ${later.length} other number${later.length === 1 ? " depends" : "s depend"} on it and ${later.length === 1 ? "is" : "are"} not reported separately (line${lines.length === 1 ? "" : "s"} ${shown}).`;
		if (root.reportedBy !== undefined) {
			root.reportedBy.message += suffix;
			continue;
		}
		const message = root.problem ?? `"${root.q.text.trim()}" is not accounted for: ${root.detail}`;
		problems.push({ line: root.line, message: message + suffix });
	}
}

export async function checkAnswer(answer: string, data: LedgerData, question = ""): Promise<CheckReport> {
	const problems: Problem[] = [];
	const notes: Problem[] = [];
	const citations: CheckedCitation[] = [];
	const runLinks: CheckReport["run_links"] = [];
	const all: Num[] = [];
	const steps: Step[] = [];
	const citedSeries = new Map<string, number>();
	const given = questionQuantities(question);

	const text = answer.replace(/\r\n?/g, "\n");
	const lines = text.split("\n");
	const lineStarts: number[] = [];
	for (let i = 0, at = 0; i < lines.length; at += (lines[i] as string).length + 1, i++) lineStarts.push(at);
	const lineOf = (offset: number): number => {
		let i = 0;
		while (i + 1 < lineStarts.length && (lineStarts[i + 1] as number) <= offset) i++;
		return i;
	};

	// Markers, read to their closing brackets, blanked wherever they run, and resolved once.
	const maskedLines = [...lines];
	const markersByLine = new Map<number, Marker[]>();
	const resolvedOf = new Map<Marker, Resolved>();
	for (const marker of findMarkers(text)) {
		const first = lineOf(marker.start);
		const last = lineOf(Math.max(marker.start, marker.end - 1));
		for (let i = first; i <= last; i++) {
			const from = i === first ? marker.start - (lineStarts[i] as number) : 0;
			const to = i === last ? marker.end - (lineStarts[i] as number) : (lines[i] as string).length;
			maskedLines[i] = blank(maskedLines[i] as string, from, to);
		}
		const onLine = { ...marker, start: marker.start - (lineStarts[first] as number), end: first === last ? marker.end - (lineStarts[first] as number) : (lines[first] as string).length };
		markersByLine.set(first, [...(markersByLine.get(first) ?? []), onLine]);
		if (marker.kind === "citation" && marker.malformed === null) resolvedOf.set(onLine, await resolveCitation(marker.inside, data));
	}
	// The parameters of every Series the answer cites: "size_bytes=32768" quoted from the tool is their text.
	const citedParams = new Map<string, Set<string>>();
	for (const resolved of resolvedOf.values()) {
		if (!resolved.ok || (resolved.kind !== "measured" && resolved.kind !== "param" && resolved.kind !== "requests")) continue;
		for (const [key, value] of Object.entries(resolved.series.params)) citedParams.set(key, new Set([...(citedParams.get(key) ?? []), String(value)]));
	}
	const questionWords = new Set((question.toLowerCase().match(/[a-z]+/g) ?? []) as string[]);

	for (const index of lines.keys()) {
		const line = index + 1;
		let masked = maskedLines[index] as string;
		const markers = markersByLine.get(index) ?? [];

		// A quotation verbatim from a price record cited on this line is AWS's words, not numbers of the answer.
		const recordTexts = markers.flatMap((marker) => {
			const resolved = resolvedOf.get(marker);
			if (resolved === undefined || !resolved.ok) return [];
			if (resolved.kind === "price" || resolved.kind === "range") return [resolved.description];
			if (resolved.kind === "attribute") return [resolved.text];
			return [];
		});
		for (const m of masked.matchAll(/"([^"]+)"|“([^”]+)”/g)) {
			const quoted = (m[1] ?? m[2] ?? "").trim();
			if (/[\p{L}\p{N}]/u.test(quoted) && recordTexts.some((record) => record.includes(quoted))) masked = blank(masked, m.index, m.index + m[0].length);
		}
		for (const m of masked.matchAll(RUN_PATH)) {
			const token = linkToken(masked, m.index, m.index + m[0].length);
			const prefix = token.slice(0, token.length - m[0].length);
			const ok =
				isRelativePrefix(prefix) ||
				RUNS_REPOSITORY_PREFIXES.some((p) => p.test(prefix)) ||
				token === `${data.treeBase}/${m[0]}` ||
				(data.location.isUrl && token === data.location.link(m[0]));
			runLinks.push({
				line,
				link: token,
				path: m[0],
				problem: ok
					? null
					: `${token} is neither the bare path ${m[0]}, a relative path ending with it, its address in the data API (${data.treeBase}/${m[0]}) nor its address in the Runs repository (https://github.com/${RUNS_REPOSITORY}/blob/main/${m[0]})`,
			});
			masked = blank(masked, m.index - prefix.length, m.index + m[0].length);
		}
		for (const m of masked.matchAll(PARAMETER)) {
			if (citedParams.get(m[1] as string)?.has(m[2] as string)) masked = blank(masked, m.index, m.index + m[0].length);
		}
		for (const pattern of MASKS) for (const m of masked.matchAll(pattern)) masked = blank(masked, m.index, m.index + m[0].length);

		const nums: Num[] = quantities(masked)
			// A plain whole number right after a label word ("Tier 1", "Step 2") is the label's.
			.filter((q) => !(q.unit.text === "" && q.written > 0 && Number.isInteger(q.written) && !q.text.includes(".") && LABEL.test(masked.slice(0, q.start))))
			.map((q) => ({
				line,
				q,
				status: null,
				detail: "",
				exact: null,
				problem: null,
				countsRuns: /^\s*(?:counted\s+)?(?:Runs?|boots?)\b/i.test(masked.slice(q.end)),
				countCited: false,
			}));
		for (const phrase of quantityWords(masked)) {
			if (nums.some((n) => phrase.start >= n.q.start && phrase.start < n.q.end)) continue;
			if (phrase.words.every((w) => questionWords.has(w))) continue;
			problems.push({ line, message: `"${phrase.phrase}" states a quantity in words; write it in digits, so it can be checked` });
		}
		// A range writes its unit once: "13.2 to 14.0 GB/s", "68–77 instances", "$92.48 to $104.72 per hour".
		for (const [k, n] of nums.entries()) {
			const next = nums[k + 1];
			if (next === undefined || next.q.unit.text === "") continue;
			const bareDollar = n.q.unit.text === "$" && next.q.unit.dims.USD === 1;
			if (n.q.unit.text !== "" && !bareDollar) continue;
			if (!RANGE_WORD.test(masked.slice(n.q.end, next.q.start))) continue;
			const unit = next.q.unit;
			n.q = { ...n.q, unit, value: n.q.written * unit.factor };
		}

		// Markers: each belongs to the nearest number before it, after the marker before it.
		let previousEnd = 0;
		for (const marker of markers) {
			// A benchmark citation describes what is measured: it attaches to no number, and numbers before it are judged by the other rules.
			const described = resolvedOf.get(marker);
			if (described !== undefined && described.ok && described.kind === "benchmark") {
				citations.push({ line, citation: marker.text, resolved: describe(described), problem: null });
				continue;
			}
			const target = nums.filter((n) => n.q.start >= previousEnd && n.q.end <= marker.start).pop();
			previousEnd = marker.end;
			if (marker.kind === "assumption") {
				const malformed = marker.malformed === null ? undefined : { line, message: `${marker.text}: ${marker.malformed}. To fix, close it and say where the number comes from: [assumption: <source>].` };
				if (malformed !== undefined) problems.push(malformed);
				if (target === undefined) {
					notes.push({ line, message: `${marker.text} follows no number on its line` });
					continue;
				}
				if (marker.malformed === null) {
					target.status = "assumption";
					target.detail = `assumption: ${marker.inside}`;
				} else {
					target.status = "unaccounted";
					target.detail = "its assumption marker gives no source";
					target.reportedBy = malformed;
				}
				continue;
			}
			if (marker.malformed !== null) {
				const problem = { line, message: `${marker.text} is not a citation: ${marker.malformed}` };
				problems.push(problem);
				citations.push({ line, citation: marker.text, resolved: null, problem: marker.malformed });
				if (target !== undefined) {
					target.status = "unaccounted";
					target.detail = `its citation ${marker.text} does not parse`;
					target.reportedBy = problem;
				}
				continue;
			}
			const resolved = resolvedOf.get(marker) as Resolved;
			const checked: CheckedCitation = { line, citation: marker.text, resolved: resolved.ok ? describe(resolved) : null, problem: null };
			citations.push(checked);
			let unresolved: Problem | undefined;
			if (!resolved.ok) {
				checked.problem = resolved.reason;
				unresolved = { line, message: `${marker.text} does not resolve: ${resolved.reason}` };
				problems.push(unresolved);
			} else if (resolved.kind === "measured" || resolved.kind === "param" || resolved.kind === "requests") {
				if (!citedSeries.has(resolved.series.id)) citedSeries.set(resolved.series.id, line);
				if ((resolved.kind === "measured" || resolved.kind === "requests") && resolved.asOf === "earlier") {
					notes.push({
						line,
						message: `${marker.text} is of Series ${resolved.series.id} as of ${resolved.moment}; the data loaded go to ${seriesMoment(resolved.series)}, so it was checked against the ${resolved.runs} counted Runs that started by ${resolved.moment}`,
					});
				}
			}
			if (target === undefined) {
				// Words cite no number: AWS's catalog words that hold none, or a tier's end AWS writes as "Inf".
				const words =
					resolved.ok &&
					((resolved.kind === "attribute" && quantities(resolved.text).length === 0) || (resolved.kind === "range" && !Number.isFinite(Number(resolved.text))));
				if (!words) notes.push({ line, message: `${marker.text} follows no number on its line` });
				continue;
			}
			if (!resolved.ok) {
				target.status = "unaccounted";
				target.detail = `its citation ${marker.text} does not resolve`;
				target.reportedBy = unresolved;
				continue;
			}
			const runsCount = (resolved.kind === "measured" && resolved.stat === "count") || (resolved.kind === "requests" && resolved.countsRuns);
			const mismatch =
				target.countsRuns && !runsCount ? "a count of Runs or boots is cited with the Series' count citation" : citationMismatch(resolved, target.q);
			if (mismatch !== null) {
				target.status = "unaccounted";
				target.detail = `${marker.text}: ${mismatch}`;
				// A mismatch that already says what to do (a rescaled price, AWS's word "Inf", catalog words) keeps its own advice.
				const fix = /\. [A-Z]/.test(mismatch) ? "." : ". To fix, write the cited value in its unit, or cite the figure you mean.";
				target.problem = `"${target.q.text.trim()}" does not match its citation ${marker.text}: ${mismatch}${fix}`;
				checked.problem = mismatch;
				continue;
			}
			target.status = "cited";
			target.detail = `${marker.text} = ${describe(resolved)}`;
			if (resolved.kind === "measured") target.exact = resolved.stat === "count" ? resolved.value : resolved.value * NUMBER_UNIT[resolved.number].toBase;
			if (resolved.kind === "requests") target.exact = resolved.unit === "ns" ? resolved.value * 1e-9 : resolved.value;
			target.countCited = runsCount;
		}

		for (const n of nums) {
			if (n.status !== null || n.countsRuns) continue;
			const match = given.find((g) => agreesWithoutCounts(n.q, g.value, g.unit.dims) || (n.q.alt !== null && agreesWithoutCounts({ ...n.q, unit: n.q.alt }, g.value, g.unit.dims)));
			if (match !== undefined) {
				n.status = "question";
				n.detail = `in the question: "${match.text.trim()}"`;
			}
		}
		steps.push(...arithmeticSteps(line, masked, nums));
		all.push(...nums);
	}

	// Derived and repeated numbers, until nothing more is accounted for.
	for (let changed = true; changed; ) {
		changed = false;
		for (const step of steps) {
			if (step.done || step.result.status !== null || step.result.countsRuns) continue;
			let computed: Interval | null;
			if (step.tokens !== null) {
				const operands = step.tokens.filter((t): t is { kind: "num"; num: Num } => t.kind === "num").map((t) => t.num);
				const ready = operands.every((o) => isAccounted(o) || (isConstant(o) && o.status === null));
				if (!ready || !operands.some((o) => isAccounted(o))) continue;
				for (const o of operands) if (o.status === null) {
					o.status = "constant";
					o.detail = "a unit-conversion constant, as an operand of arithmetic";
				}
				computed = evaluate(step.tokens);
			} else {
				const from = step.from as Num;
				if (!isAccounted(from)) continue;
				computed = operand(from);
			}
			step.done = true;
			changed = true;
			const r = step.result;
			const rf = r.q.unit.factor;
			// A rounding (→) may be to fewer digits: up, down or to nearest at the result's last significant digit.
			const room = step.rounds ? 2 * r.q.looseHalf : r.q.half;
			// The result's rounding interval, open at its ends, meets the recomputed interval.
			const near = (lo: number, hi: number, value: number, half: number, scale: number): boolean => {
				const noise = 1e-12 * Math.max(Math.abs(lo), Math.abs(hi), Math.abs(value));
				const reach = half * (1 - 1e-9) * Math.abs(scale);
				return value + reach > lo - noise && value - reach < hi + noise;
			};
			// Either with units carried, or as plain numbers exactly as written: a line whose numbers are right is not rejected for how its units are worded.
			const byUnits = computed !== null && computed.consistent && sameDims(withoutCounts(computed.dims), withoutCounts(r.q.unit.dims)) && near(computed.lo, computed.hi, r.q.value, room, rf);
			const byDigits = computed !== null && near(computed.wlo, computed.whi, r.q.written, room, 1);
			if (byUnits || byDigits) {
				r.status = "derived";
				r.detail = step.rounds ? "a rounding, shown with →, of the value before it" : "the result of arithmetic on its line, recomputed";
			} else {
				r.status = "unaccounted";
				const expected = expectedOf(computed, r.q);
				r.detail = `its arithmetic does not give it: expected ${expected}`;
				r.problem = `"${r.q.text.trim()}" does not follow from the arithmetic on its line: expected ${expected}; found ${r.q.text.trim()}. To fix, write the result its operands give, or correct the operand that is wrong.`;
			}
		}
		for (const n of all) {
			if (n.status !== null) continue;
			const known = all.find((k) => k !== n && isAccounted(k) && (!n.countsRuns || k.countCited) && sameKind(n.q, k.q) && (repeats(n.q, k.exact ?? k.q.value, k.q.unit.dims) || repeats(n.q, k.q.value, k.q.unit.dims)));
			if (known !== undefined) {
				n.status = "repeat";
				n.detail = `the same as "${known.q.text.trim()}" (line ${known.line}, ${known.status})`;
				changed = true;
			}
		}
	}

	reportUnaccounted(all, steps, problems);

	// Run links: each a Run of a Series the answer cites, with the bytes its point in the data gives.
	const linkedSeries = new Set<string>();
	const cited = [...citedSeries.keys()];
	for (const link of runLinks) {
		if (link.problem === null) {
			const bytes = await data.runFile(link.path);
			const found = bytes === null ? null : await findRun(data, cited, link.path);
			if (bytes === null) link.problem = `no Run file ${link.path} at ${data.location.base}`;
			else if (found === null) link.problem = `${link.path} is not a Run of any Series the answer cites${cited.length === 0 ? " (it cites none)" : ` (${cited.join(", ")})`}`;
			else if (createHash("sha256").update(bytes).digest("hex") !== found.point.sha256) link.problem = `${link.path} is not the file the Derivation cites (sha256 differs)`;
			else linkedSeries.add(found.series);
		}
		if (link.problem !== null) problems.push({ line: link.line, message: `Run link: ${link.problem}` });
	}
	for (const [series, line] of citedSeries) {
		if (!linkedSeries.has(series)) problems.push({ line, message: `Series ${series} is cited, but the answer links none of its Runs (runs/<yyyy>/<mm>/<dd>/<id>.json)` });
	}

	problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
	return {
		pass: problems.length === 0,
		problems,
		numbers: all.map((n) => ({ line: n.line, text: n.q.text.trim(), status: n.status as NumberStatus, detail: n.detail })),
		citations,
		run_links: runLinks,
		notes,
	};
}

export function reportText(report: CheckReport, options: { answer: string; data: string; verbose: boolean }): string {
	const counts = new Map<NumberStatus, number>();
	for (const n of report.numbers) counts.set(n.status, (counts.get(n.status) ?? 0) + 1);
	const lines = [
		`${options.answer}, against ${options.data}: ${report.numbers.length} numbers (${[...counts].map(([status, n]) => `${n} ${status}`).join(", ") || "none"}), ${report.citations.length} citations, ${report.run_links.length} Run links.`,
		report.pass ? "PASS" : `FAIL: ${report.problems.length} problem${report.problems.length === 1 ? "" : "s"}`,
	];
	if (report.problems.length > 0) {
		lines.push("", "Problems:");
		for (const problem of report.problems) lines.push(`  ${problem.line === null ? "" : `line ${problem.line}: `}${problem.message}`);
	}
	if (report.notes.length > 0) {
		lines.push("", "Notes:");
		for (const note of report.notes) lines.push(`  ${note.line === null ? "" : `line ${note.line}: `}${note.message}`);
	}
	if (options.verbose) {
		lines.push("", "Every number:");
		for (const n of report.numbers) lines.push(`  line ${n.line}: "${n.text}" ${n.status}: ${n.detail}`);
		lines.push("", "Every citation:");
		for (const c of report.citations) lines.push(`  line ${c.line}: ${c.citation} ${c.problem === null ? `resolves to ${c.resolved}` : `: ${c.problem}`}`);
	}
	return `${lines.join("\n")}\n`;
}

