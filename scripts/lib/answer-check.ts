/**
 * The answer checker (scripts/check-answer.ts). One rule: every number in an
 * answer, code blocks and tables included, is exactly one of
 *
 * - from the question: the same value and unit as a number in the question;
 * - cited: the nearest citation after it on its line resolves, and the number
 *   is the cited value, in the cited unit (a measured number may be written
 *   with another prefix or time unit of the same dimensions; a price only in
 *   AWS's own unit);
 * - an assumption: the nearest marker after it on its line is
 *   [assumption: <source>], and the source has words;
 * - derived: the result of a line of arithmetic (a = b, a ≈ b, or a → b for
 *   rounding up, down or to nearest) whose operands are all accounted for,
 *   at least one of them not a conversion constant, and whose result the
 *   checker recomputes and finds equal within the rounding of the digits
 *   written;
 * - a repeat of a number accounted for anywhere in the answer, with the same
 *   value, as its digits round it, and the same dimensions.
 *
 * Inside a line of arithmetic, a pure unit-conversion constant (CONSTANTS)
 * may be an operand. Anything else is a problem, and so are: a citation or
 * assumption marker that does not parse, a number written in words, a Run
 * link that is neither the bare path nor the Runs repository's address of it
 * (or one that names no Run of the data, or a file whose bytes differ from
 * the Derivation's), and a cited Series none of whose Runs the answer links.
 *
 * Not numbers: what is inside a citation or marker, Run links and other web
 * addresses, dates and times of day (2026-11-11, 04:10), ids and hashes,
 * the numbers of list items, headings and footnotes, and digits inside a
 * name (c6i.8xlarge, p50, gp3, 8375C).
 *
 * A written number stands for every value that rounds to it at its last
 * written digit: $0.10 for $0.096, 112 MB/s for 112.269 MB/s, 130 for 129.5 to
 * 130.5. A number with no unit before a range word and a number with one
 * ("13.2 to 14.0 GB/s") takes that unit.
 */

import { createHash } from "node:crypto";

import { citationMismatch, NUMBER_UNIT, type Resolved, resolveCitation, RUN_PATH, seriesMoment } from "./citation";
import type { LedgerData } from "./ledger-data";
import { agrees, type Dims, dimsText, multiply, numberWords, type Quantity, quantities, sameDims } from "./quantity";
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
 * arithmetic and nowhere else: bits per byte, hours per day, seconds per
 * minute and minutes per hour, percent, days per year, AWS's hours per month
 * and per year, seconds per hour and per day, and the decimal and binary
 * prefixes.
 */
export const CONSTANTS: ReadonlySet<number> = new Set([8, 24, 60, 100, 365, 730, 1000, 1024, 3600, 8760, 86400, 1e6, 1e9, 1e12, 1e15, 1e18, 2 ** 20, 2 ** 30, 2 ** 40, 2 ** 50]);

/** Addresses at which the Runs repository shows a Run, before its path. */
const RUNS_REPOSITORY_PREFIXES: readonly RegExp[] = [
	new RegExp(`^https://github\\.com/${RUNS_REPOSITORY}/blob/(?:main|[0-9a-f]{40})/$`),
	new RegExp(`^https://raw\\.githubusercontent\\.com/${RUNS_REPOSITORY}/(?:main|[0-9a-f]{40})/$`),
];

/** Spans that hold no number of the answer's. */
const MASKS: readonly RegExp[] = [
	/https?:\/\/[^\s)\]>]+/g,
	/\b[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?Z?)?/g,
	/\b[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\b/g,
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
	/\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi,
	/^\s*(?:#+\s*)?(?:[-*+]\s+)?[0-9]+[.)](?=\s)/g,
	/\[[0-9]+\]/g,
];

const SEPARATOR = /(?<![<>=!~])(?:=(?!=)|≈|→)/g;
/** Where one clause of a line ends: a semicolon, or a comma, colon or full stop followed by a space. */
const CLAUSE = /;|[,:.](?=\s)/g;
const RANGE_WORD = /^\s*(?:to|–|—|-)\s*$/;

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

function findMarkers(text: string): Marker[] {
	const markers: Marker[] = [];
	for (const m of text.matchAll(/\[lm:/g)) {
		const close = text.indexOf("]", m.index);
		const end = close < 0 ? m.index + (/^\S*/.exec(text.slice(m.index))?.[0].length ?? 4) : close + 1;
		const inside = close < 0 ? text.slice(m.index + 4, end) : text.slice(m.index + 4, close);
		const malformed = close < 0 ? "it has no closing ]" : /\s/.test(inside) ? "it holds a space" : null;
		markers.push({ start: m.index, end, kind: "citation", text: text.slice(m.index, end), inside, malformed });
	}
	for (const m of text.matchAll(/\[assumption\b/gi)) {
		const close = text.indexOf("]", m.index);
		const end = close < 0 ? text.length : close + 1;
		const body = /^\[assumption:\s*([^\]]*)\]$/i.exec(text.slice(m.index, end));
		const source = body?.[1]?.trim() ?? "";
		const malformed = close < 0 ? "it has no closing ]" : body === null ? "it is not [assumption: <source>]" : !/\p{L}{2,}/u.test(source) ? "its source has no words" : null;
		markers.push({ start: m.index, end, kind: "assumption", text: text.slice(m.index, end), inside: source, malformed });
	}
	return markers.sort((a, b) => a.start - b.start);
}

/** The whole token a Run path is written in: from the last space, (, <, quote or backtick before it. */
function linkToken(text: string, start: number, end: number): string {
	let from = start;
	while (from > 0 && !/[\s(<"'`[]/.test(text.charAt(from - 1))) from--;
	return text.slice(from, end);
}

/** A number of the question, and the same number per unit of time when the sentence says "per second" after it. */
function questionQuantities(question: string): Quantity[] {
	const out: Quantity[] = [];
	for (const q of quantities(question)) {
		out.push(q);
		const sentence = question.slice(q.end).split(/[.?!](?:\s|$)/)[0] ?? "";
		const per = /\bper (second|minute|hour|day|month|year)\b/.exec(sentence);
		if (per !== null && q.unit.dims.s === undefined) {
			const seconds = { second: 1, minute: 60, hour: 3600, day: 86400, month: 730 * 3600, year: 8760 * 3600 }[per[1] as string] as number;
			const unit = { dims: multiply(q.unit.dims, { s: 1 }, -1), factor: q.unit.factor / seconds, text: `${q.unit.text} per ${per[1]}` };
			out.push({ ...q, unit, value: q.written * unit.factor });
		}
	}
	return out;
}

const isAccounted = (n: Num): boolean =>
	n.status === "question" || n.status === "cited" || n.status === "assumption" || n.status === "derived" || n.status === "repeat";

function isConstant(n: Num): boolean {
	return Object.keys(n.q.unit.dims).length === 0 && n.q.unit.factor === 1 && n.q.written > 0 && CONSTANTS.has(n.q.written);
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
			return `${resolved.stat} of ${resolved.number}${resolved.group === null ? "" : ` (group ${resolved.group})`} of Series ${resolved.series.series.id} (${resolved.series.series.benchmark} on ${resolved.series.series.instance_type}) as of ${resolved.moment}: ${resolved.value}${resolved.stat === "count" ? " counted Runs" : ` ${NUMBER_UNIT[resolved.number].unit}`}`;
		case "param":
			return `parameter ${resolved.key} of Series ${resolved.series.series.id}: ${String(resolved.value)}`;
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

export async function checkAnswer(answer: string, data: LedgerData, question = ""): Promise<CheckReport> {
	const problems: Problem[] = [];
	const notes: Problem[] = [];
	const citations: CheckedCitation[] = [];
	const runLinks: CheckReport["run_links"] = [];
	const all: Num[] = [];
	const steps: Step[] = [];
	const citedSeries = new Map<string, number>();
	const given = questionQuantities(question);

	for (const [index, text] of answer.split(/\r?\n/).entries()) {
		const line = index + 1;
		let masked = text;
		const markers = findMarkers(text);
		for (const marker of markers) masked = blank(masked, marker.start, marker.end);
		for (const m of masked.matchAll(RUN_PATH)) {
			const token = linkToken(masked, m.index, m.index + m[0].length);
			const prefix = token.slice(0, token.length - m[0].length);
			const ok = prefix === "" || RUNS_REPOSITORY_PREFIXES.some((p) => p.test(prefix)) || (data.location.isUrl && token === data.location.link(m[0]));
			runLinks.push({ line, link: token, path: m[0], problem: ok ? null : `${token} is neither the bare path ${m[0]} nor its address in the Runs repository (https://github.com/${RUNS_REPOSITORY}/blob/main/${m[0]})` });
			masked = blank(masked, m.index - prefix.length, m.index + m[0].length);
		}
		for (const pattern of MASKS) for (const m of masked.matchAll(pattern)) masked = blank(masked, m.index, m.index + m[0].length);

		const nums: Num[] = quantities(masked).map((q) => ({
			line,
			q,
			status: null,
			detail: "",
			exact: null,
			problem: null,
			countsRuns: /^\s*(?:counted\s+)?(?:Runs?|boots?)\b/i.test(masked.slice(q.end)),
			countCited: false,
		}));
		for (const word of numberWords(masked)) {
			if (nums.some((n) => word.start >= n.q.start && word.start < n.q.end)) continue;
			problems.push({ line, message: `"${word.word}" is a number written in words; write it in digits, so it can be checked` });
		}
		// A number with no unit before a range word and a number with one takes that unit.
		for (const [k, n] of nums.entries()) {
			const next = nums[k + 1];
			if (next === undefined || n.q.unit.text !== "" || next.q.unit.text === "") continue;
			const between = masked.slice(n.q.end, next.q.start);
			if (!RANGE_WORD.test(between)) continue;
			const unit = next.q.unit;
			n.q = { ...n.q, unit, value: n.q.written * unit.factor };
		}

		// Markers: each belongs to the nearest number before it, after the marker before it.
		let previousEnd = 0;
		for (const marker of markers) {
			const target = nums.filter((n) => n.q.start >= previousEnd && n.q.end <= marker.start).pop();
			previousEnd = marker.end;
			if (marker.kind === "assumption") {
				if (marker.malformed !== null) problems.push({ line, message: `${marker.text}: ${marker.malformed}` });
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
				}
				continue;
			}
			if (marker.malformed !== null) {
				problems.push({ line, message: `${marker.text} is not a citation: ${marker.malformed}` });
				citations.push({ line, citation: marker.text, resolved: null, problem: marker.malformed });
				if (target !== undefined) {
					target.status = "unaccounted";
					target.detail = `its citation ${marker.text} does not parse`;
				}
				continue;
			}
			const resolved = await resolveCitation(marker.inside, data);
			const checked: CheckedCitation = { line, citation: marker.text, resolved: resolved.ok ? describe(resolved) : null, problem: null };
			citations.push(checked);
			if (!resolved.ok) {
				checked.problem = resolved.reason;
				problems.push({ line, message: `${marker.text} does not resolve: ${resolved.reason}` });
			} else if (resolved.kind === "measured" || resolved.kind === "param") {
				if (!citedSeries.has(resolved.series.series.id)) citedSeries.set(resolved.series.series.id, line);
				if (resolved.kind === "measured" && resolved.asOf === "earlier") {
					notes.push({
						line,
						message: `${marker.text} is of Series ${resolved.series.series.id} as of ${resolved.moment}; the data loaded go to ${seriesMoment(resolved.series)}, so it was checked against the ${resolved.runs} counted Runs that started by ${resolved.moment}`,
					});
				}
			}
			if (target === undefined) {
				if (!(resolved.ok && resolved.kind === "benchmark")) notes.push({ line, message: `${marker.text} follows no number on its line` });
				continue;
			}
			if (!resolved.ok) {
				target.status = "unaccounted";
				target.detail = `its citation ${marker.text} does not resolve`;
				continue;
			}
			const mismatch =
				target.countsRuns && !(resolved.kind === "measured" && resolved.stat === "count")
					? "a count of Runs or boots is cited with the Series' count citation"
					: citationMismatch(resolved, target.q);
			if (mismatch !== null) {
				target.status = "unaccounted";
				target.detail = `${marker.text}: ${mismatch}`;
				target.problem = `"${target.q.text.trim()}" is not what its citation ${marker.text} says: ${mismatch}`;
				checked.problem = mismatch;
				continue;
			}
			target.status = "cited";
			target.detail = `${marker.text} = ${describe(resolved)}`;
			if (resolved.kind === "measured") target.exact = resolved.stat === "count" ? resolved.value : resolved.value * NUMBER_UNIT[resolved.number].toBase;
			target.countCited = resolved.kind === "measured" && resolved.stat === "count";
		}

		for (const n of nums) {
			if (n.status !== null || n.countsRuns) continue;
			const match = given.find((g) => agrees(n.q, g.value, g.unit.dims));
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
			let constants = false;
			if (step.tokens !== null) {
				const operands = step.tokens.filter((t): t is { kind: "num"; num: Num } => t.kind === "num").map((t) => t.num);
				constants = operands.some(isConstant);
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
			const room = step.rounds ? 2 * r.q.half : r.q.half;
			// The result's rounding interval, open at its ends, meets the recomputed interval.
			const near = (lo: number, hi: number, value: number, half: number, scale: number): boolean => {
				const noise = 1e-12 * Math.max(Math.abs(lo), Math.abs(hi), Math.abs(value));
				const reach = half * (1 - 1e-9) * Math.abs(scale);
				return value + reach > lo - noise && value - reach < hi + noise;
			};
			const byUnits = computed !== null && computed.consistent && sameDims(computed.dims, r.q.unit.dims) && near(computed.lo, computed.hi, r.q.value, room, rf);
			const byDigits = computed !== null && constants && near(computed.wlo, computed.whi, r.q.written, room, 1);
			if (byUnits || byDigits) {
				r.status = "derived";
				r.detail = step.rounds ? "a rounding, shown with →, of the value before it" : "the result of arithmetic on its line, recomputed";
			} else {
				r.status = "unaccounted";
				const got = computed === null ? "operands that do not combine" : `${computed.lo === computed.hi ? computed.lo : `${computed.lo} to ${computed.hi}`} ${dimsText(computed.dims)}`;
				r.detail = `its arithmetic does not give it: recomputed ${got}${computed !== null && !sameDims(computed.dims, r.q.unit.dims) ? `, not ${dimsText(r.q.unit.dims)}` : ""}`;
				r.problem = `"${r.q.text.trim()}" does not follow from the arithmetic on its line: recomputed ${got}${computed !== null && !sameDims(computed.dims, r.q.unit.dims) ? `, where it is ${dimsText(r.q.unit.dims)}` : ""}`;
			}
		}
		for (const n of all) {
			if (n.status !== null) continue;
			const known = all.find((k) => k !== n && isAccounted(k) && (!n.countsRuns || k.countCited) && (agrees(n.q, k.exact ?? k.q.value, k.q.unit.dims) || agrees(n.q, k.q.value, k.q.unit.dims)));
			if (known !== undefined) {
				n.status = "repeat";
				n.detail = `the same as "${known.q.text.trim()}" (line ${known.line}, ${known.status})`;
				changed = true;
			}
		}
	}

	const numsOf = (s: Step): Num[] => (s.tokens ?? []).filter((t): t is { kind: "num"; num: Num } => t.kind === "num").map((t) => t.num);
	const operandOf = new Set(steps.flatMap(numsOf));
	const onlyConstants = new Set(steps.filter((s) => s.tokens !== null && numsOf(s).every(isConstant)).map((s) => s.result));
	const resultOf = new Set(steps.map((s) => s.result));
	for (const n of all) {
		if (n.status === null && onlyConstants.has(n)) {
			n.status = "unaccounted";
			n.detail = "the result of arithmetic whose operands are only conversion constants: at least one must be accounted for";
		}
		if (n.status === null && operandOf.has(n) && isConstant(n)) {
			n.status = "unaccounted";
			n.detail = "a conversion constant in arithmetic that has no accounted operand";
		}
	}
	for (const n of all) {
		if (n.status === null) {
			n.status = "unaccounted";
			n.detail = n.countsRuns
				? "a count of Runs or boots is accounted for only by a Series' count citation, or as a repeat of a number cited by one"
				: resultOf.has(n)
				? "the result of arithmetic whose operands are not all accounted for"
				: `no citation or assumption after it; not in the question; not the result of arithmetic; not a repeat of a number accounted for${operandOf.has(n) ? " (an operand of arithmetic)" : ""}`;
			n.problem = `"${n.q.text.trim()}" is not accounted for: ${n.detail}`;
		}
		if (n.status === "unaccounted") problems.push({ line: n.line, message: n.problem ?? `"${n.q.text.trim()}" is not accounted for: ${n.detail}` });
	}

	// Run links: each a Run of the data, with the bytes the Derivation cites.
	const runsByPath = new Map<string, { series: string; sha256: string }>();
	for (const derivation of data.derivations.derivations) for (const run of derivation.runs) runsByPath.set(run.path, { series: derivation.series.id, sha256: run.sha256 });
	const linkedSeries = new Set<string>();
	for (const link of runLinks) {
		if (link.problem === null) {
			const cited = runsByPath.get(link.path);
			const bytes = await data.location.read(link.path);
			if (bytes === null) link.problem = `no Run file ${link.path} at ${data.location.base}`;
			else if (cited === undefined) link.problem = `${link.path} is in no Series of ${data.derivationsFrom}`;
			else if (createHash("sha256").update(bytes).digest("hex") !== cited.sha256) link.problem = `${link.path} is not the file the Derivation cites (sha256 differs)`;
			else linkedSeries.add(cited.series);
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

