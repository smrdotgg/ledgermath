/**
 * The answer checker (scripts/check-answer.ts): reads an answer an agent
 * wrote with the skill (skills/ledgermath/SKILL.md) and reports
 *
 * - every number that is not accounted for: it has no citation and no
 *   [assumption: …] marker after it, is not in the question, is not the
 *   result of arithmetic shown on its line, and is not a number already
 *   accounted for elsewhere in the answer (written again, or in another unit);
 * - every citation that does not resolve in the data, and every cited number
 *   that is not the value its citation resolves to;
 * - every cited Series none of whose Runs the answer links, and every Run link
 *   that names no Run of the data, or a Run file whose bytes differ from the
 *   ones the Derivation cites;
 * - every [assumption] marker that does not say where the number comes from.
 *
 * A number's citation follows it on the same line, with no other number in
 * between. Arithmetic is a line with "=" (or "≈", "→"): the numbers after the
 * last separator, and in any segment between separators that holds one number
 * and no operator, are results; the others are its operands, which must be
 * accounted for like any number, except unit-conversion constants (1000, 1024,
 * 3600, 730, …). It reads numbers, not reasoning: it does not check the
 * arithmetic, or whether a measured number is used for what it measured.
 */

import { createHash } from "node:crypto";

import { ASSUMPTION, CITATION, citedValueMatches, NUMBER_UNIT, type Resolved, resolveCitation, RUN_LINK } from "./citation";
import type { LedgerData } from "./ledger-data";
import { type Quantity, quantities, sameQuantity } from "./quantity";

export type NumberStatus = "cited" | "assumption" | "given" | "derived" | "reused" | "constant" | "count" | "unit" | "unaccounted";

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
	run_links: Array<{ line: number; path: string; problem: string | null }>;
	notes: Problem[];
}

/** Unit-conversion constants an arithmetic operand written without a unit may be, without a citation. */
const CONSTANTS: ReadonlySet<number> = new Set([
	1, 8, 10, 12, 24, 30, 31, 60, 100, 365, 720, 730, 744, 1000, 1024, 3600, 86400, 1e6, 1e9, 1e12, 1e15, 1e18, 2 ** 20, 2 ** 30, 2 ** 40, 2 ** 50,
]);

/** Spans that hold no number of the answer's: addresses, dates, times, ids, hashes, ordinals, list and footnote marks. */
const MASKS: readonly RegExp[] = [
	/https?:\/\/[^\s)\]>]+/g,
	/\]\([^)]*\)/g,
	/\b[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9:.]+Z?)?/g,
	/\b[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\b/g,
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
	/\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi,
	/\b[0-9]+(?:st|nd|rd|th)\b/g,
	/^\s*(?:#+\s*)?(?:[-*+]\s+)?[0-9]+[.)](?=\s)/g,
	/\[[0-9]+\]/g,
];

const SEPARATOR = /(?<![<>=!])(?:=(?!=)|≈|→)/g;
/** Where one clause of a line ends: a semicolon, or a comma, colon or full stop followed by a space. */
const CLAUSE = /;|[,:.](?=\s)/g;
const OPERATOR = /[×*·÷+−]|\s[x/\-–]\s|\^/;

interface Marker {
	start: number;
	end: number;
	kind: "citation" | "assumption";
	inside: string;
}

interface Found {
	line: number;
	quantity: Quantity;
	status: NumberStatus | null;
	detail: string;
	operand: boolean;
}

function blank(text: string, start: number, end: number): string {
	return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

function maskLine(text: string): { masked: string; markers: Marker[]; runs: string[] } {
	let masked = text;
	const markers: Marker[] = [];
	for (const match of text.matchAll(CITATION)) {
		markers.push({ start: match.index, end: match.index + match[0].length, kind: "citation", inside: match[1] ?? "" });
	}
	for (const match of text.matchAll(ASSUMPTION)) {
		markers.push({ start: match.index, end: match.index + match[0].length, kind: "assumption", inside: (match[1] ?? "").trim() });
	}
	markers.sort((a, b) => a.start - b.start);
	for (const marker of markers) masked = blank(masked, marker.start, marker.end);
	const runs: string[] = [];
	for (const match of text.matchAll(RUN_LINK)) {
		runs.push(match[1] as string);
		masked = blank(masked, match.index, match.index + match[0].length);
	}
	for (const pattern of MASKS) {
		for (const match of masked.matchAll(pattern)) masked = blank(masked, match.index, match.index + match[0].length);
	}
	return { masked, markers, runs };
}

function describe(resolved: Resolved): string {
	if (!resolved.ok) return resolved.reason;
	switch (resolved.kind) {
		case "measured":
			return `${resolved.stat} of ${resolved.number}${resolved.group === null ? "" : ` (group ${resolved.group})`} of Series ${resolved.series.series.id} (${resolved.series.series.benchmark} on ${resolved.series.series.instance_type}): ${resolved.value}${resolved.stat === "count" ? " Runs" : ` ${NUMBER_UNIT[resolved.number].unit}`}`;
		case "param":
			return `parameter ${resolved.key} of Series ${resolved.series.series.id}: ${String(resolved.value)}`;
		case "price":
			return `${resolved.usd} USD per ${resolved.unit} ("${resolved.description}"), price file of ${resolved.date}`;
		case "attribute":
			return `${resolved.name} of SKU ${resolved.sku}: "${resolved.text}", price file of ${resolved.date}`;
		case "benchmark":
			return `the note on benchmark ${resolved.name}`;
	}
}

/** Whether a range word joins two numbers: "20 to 50 GB", "20–50 GB". */
const RANGE_JOIN = /^\s*(?:to|–|—|-|and|or)\s*$/;

export async function checkAnswer(answer: string, data: LedgerData, question = ""): Promise<CheckReport> {
	const problems: Problem[] = [];
	const notes: Problem[] = [];
	const found: Found[] = [];
	const citations: CheckedCitation[] = [];
	const runLinks: CheckReport["run_links"] = [];
	const citedSeries = new Map<string, number>();
	const knownValues: Array<Pick<Quantity, "written" | "dimension" | "value" | "digits">> = [];
	const given = quantities(question);

	const lines = answer.split(/\r?\n/);
	for (const [index, text] of lines.entries()) {
		const line = index + 1;
		const { masked, markers, runs } = maskLine(text);
		for (const path of runs) runLinks.push({ line, path, problem: null });
		const numbers: Found[] = quantities(masked).map((quantity) => ({ line, quantity, status: null, detail: "", operand: false }));

		// Counts of Runs and boots describe evidence; a number after "per" is part of a unit ("per 1,000 requests").
		for (const n of numbers) {
			const after = masked.slice(n.quantity.end);
			const before = masked.slice(0, n.quantity.start);
			if (/^\s*(?:counted\s+)?(?:Runs?|boots?|box(?:es)?|groups?)\b/i.test(after)) {
				n.status = "count";
				n.detail = "a count of Runs, boots, boxes or groups";
			} else if (/\bper\s*$/i.test(before)) {
				n.status = "unit";
				n.detail = 'part of a unit, after "per"';
			}
		}

		// Arithmetic, clause by clause: results after separators; operands elsewhere.
		const clauseEnds = [...masked.matchAll(CLAUSE)].map((match) => match.index);
		let clauseStart = 0;
		for (const clauseEnd of [...clauseEnds, masked.length]) {
			const clause = masked.slice(clauseStart, clauseEnd);
			const separators = [...clause.matchAll(SEPARATOR)].map((match) => clauseStart + match.index);
			if (separators.length > 0) {
				const bounds = [clauseStart - 1, ...separators, clauseEnd];
				for (let s = 0; s + 1 < bounds.length; s++) {
					const from = (bounds[s] as number) + 1;
					const to = bounds[s + 1] as number;
					const inSegment = numbers.filter((n) => n.quantity.start >= from && n.quantity.end <= to && n.status === null);
					const isExpression = OPERATOR.test(masked.slice(from, to));
					for (const n of inSegment) {
						if (s > 0 && !isExpression && inSegment.length === 1) {
							n.status = "derived";
							n.detail = "the result of arithmetic on its line";
						} else n.operand = true;
					}
				}
			}
			clauseStart = clauseEnd + 1;
		}

		// Markers: each covers the number before it, after the previous marker.
		let previousEnd = 0;
		for (const marker of markers) {
			const candidates = numbers.filter((n) => n.quantity.end <= marker.start && n.quantity.start >= previousEnd && n.status !== "count" && n.status !== "unit");
			previousEnd = marker.end;
			if (marker.kind === "assumption") {
				if (marker.inside.length < 3) problems.push({ line, message: `an [assumption] marker that does not say where the number comes from: ${text.slice(marker.start, marker.end)}` });
				const nearest = candidates[candidates.length - 1];
				if (nearest === undefined) {
					notes.push({ line, message: `an assumption marker with no number before it on its line` });
					continue;
				}
				const covered = [nearest];
				const before = candidates[candidates.length - 2];
				if (before !== undefined && RANGE_JOIN.test(masked.slice(before.quantity.end, nearest.quantity.start))) covered.push(before);
				for (const n of covered) {
					n.status = "assumption";
					n.detail = `assumption: ${marker.inside}`;
				}
				continue;
			}
			const citation = `[lm:${marker.inside}]`;
			const resolved = await resolveCitation(marker.inside, data);
			const checked: CheckedCitation = { line, citation, resolved: resolved.ok ? describe(resolved) : null, problem: null };
			citations.push(checked);
			if (!resolved.ok) {
				checked.problem = `does not resolve: ${resolved.reason}`;
				problems.push({ line, message: `${citation} does not resolve: ${resolved.reason}` });
			} else if (resolved.kind === "measured" || resolved.kind === "param") {
				if (!citedSeries.has(resolved.series.series.id)) citedSeries.set(resolved.series.series.id, line);
			}
			if (candidates.length === 0) {
				notes.push({ line, message: `${citation} has no number before it on its line` });
				continue;
			}
			const matching = resolved.ok ? [...candidates].reverse().find((n) => citedValueMatches(resolved, n.quantity)) : undefined;
			const target = matching ?? (candidates[candidates.length - 1] as Found);
			target.status = "cited";
			target.detail = `${citation}${resolved.ok ? ` = ${describe(resolved)}` : ""}`;
			if (resolved.ok && matching === undefined) {
				const message = `"${target.quantity.text.trim()}" is not the value its citation ${citation} resolves to: ${describe(resolved)}`;
				checked.problem = message;
				problems.push({ line, message });
			}
			if (resolved.ok && resolved.kind === "measured") {
				const { dimension } = NUMBER_UNIT[resolved.number];
				const value = resolved.stat === "count" ? resolved.value : dimension === "seconds" ? resolved.value * 1e-9 : resolved.value;
				knownValues.push({ written: resolved.value, dimension: resolved.stat === "count" ? "none" : dimension, value, digits: 15 });
			}
		}

		// The question's numbers.
		for (const n of numbers) {
			if (n.status !== null) continue;
			const match = given.find((g) => sameQuantity(n.quantity, g));
			if (match !== undefined) {
				n.status = "given";
				n.detail = `in the question: "${match.text.trim()}"`;
			}
		}
		found.push(...numbers);
	}

	// Numbers accounted for anywhere in the answer may be written again, in any unit.
	for (const n of found) {
		if (n.status === "cited" || n.status === "assumption" || n.status === "given" || n.status === "derived") knownValues.push(n.quantity);
	}
	for (const n of found) {
		if (n.status !== null) continue;
		const known = knownValues.find((k) => k !== n.quantity && sameQuantity(n.quantity, k));
		if (known !== undefined) {
			n.status = "reused";
			n.detail = `the same as ${"text" in known ? `"${(known as Quantity).text.trim()}"` : "a cited value"}`;
		} else if (n.operand && n.quantity.dimension === "none" && CONSTANTS.has(n.quantity.written)) {
			n.status = "constant";
			n.detail = "a unit-conversion constant in arithmetic";
		} else {
			n.status = "unaccounted";
			n.detail = "no citation, no [assumption: …] marker; not in the question, not a result of arithmetic on its line, not a number used elsewhere";
			problems.push({ line: n.line, message: `"${n.quantity.text.trim()}" is not accounted for: ${n.detail}` });
		}
	}

	// Run links: each must be a Run of the data, with the bytes the Derivation cites.
	const runsByPath = new Map<string, { series: string; sha256: string }>();
	for (const derivation of data.derivations.derivations) {
		for (const run of derivation.runs) runsByPath.set(run.path, { series: derivation.series.id, sha256: run.sha256 });
	}
	const linkedSeries = new Set<string>();
	for (const link of runLinks) {
		const cited = runsByPath.get(link.path);
		const bytes = await data.location.read(link.path);
		if (bytes === null) link.problem = `no Run file ${link.path} at ${data.location.base}`;
		else if (cited === undefined) link.problem = `${link.path} is in no Series of ${data.derivationsFrom}`;
		else if (createHash("sha256").update(bytes).digest("hex") !== cited.sha256) link.problem = `${link.path} is not the file the Derivation cites (sha256 differs)`;
		if (cited !== undefined) linkedSeries.add(cited.series);
		if (link.problem !== null) problems.push({ line: link.line, message: `Run link: ${link.problem}` });
	}
	for (const [series, line] of citedSeries) {
		if (!linkedSeries.has(series)) problems.push({ line, message: `Series ${series} is cited, but the answer links none of its Runs (runs/<yyyy>/<mm>/<dd>/<id>.json)` });
	}

	problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
	return {
		pass: problems.length === 0,
		problems,
		numbers: found.map((n) => ({ line: n.line, text: n.quantity.text.trim(), status: n.status as NumberStatus, detail: n.detail })),
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
		for (const c of report.citations) lines.push(`  line ${c.line}: ${c.citation} ${c.problem ?? `resolves to ${c.resolved}`}`);
	}
	return `${lines.join("\n")}\n`;
}
