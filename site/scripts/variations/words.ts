/**
 * How many words a visitor can read on a built page, so the maintainer can pick a design by
 * how dense it is. Ported from the orchestrator's tools/words.py:
 *
 *  - Words are the whitespace-separated pieces of the page's text, outside <head>, <script>,
 *    <style>, <svg> and <template> (and comments).
 *  - A word is a figure, not prose, when it is essentially a number with an optional short unit:
 *    "1,234", "$0.0416", "3.2", "12%", "4.5GB/s", "~10", "128ns", "2026-11-19". A word is prose
 *    when it holds two letters in a row and is not a figure.
 *  - Prose inside a closed <details> (one without `open`), outside that details' <summary>, is
 *    counted apart as folded: hidden until the visitor opens it.
 *
 * Two departures from words.py, both towards what its own description says: <head> (the title)
 * is not counted, being no part of the page a visitor reads; and a figure must hold a digit
 * (words.py's pattern also matched every word of three letters or fewer, "the", "API", as a figure).
 */

export type WordCount = {
	/** Every word, figures included. */
	all: number;
	/** Words that are not figures (prose), folded ones included. */
	prose: number;
	/** Of those, the ones inside a closed <details>. */
	folded: number;
	/** prose - folded: the words a visitor reads without opening anything. */
	visible: number;
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", times: "×", micro: "µ", hellip: "…" };

function decode(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
		if (name[0] === "#") {
			const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
			return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
}

// Punctuation that wraps a word without being part of it: "(12 ms)," is the figure 12 and the unit ms.
const WRAPPING = /^[\s"'“”‘’()[\]{}«»,;:.!?…*]+|[\s"'“”‘’()[\]{}«»,;:.!?…*]+$/g;
// A number: an optional sign or approximation or currency, digits with separators, maybe a range or a ratio.
const NUMBER = String.raw`[~≈<>≤≥±+\-−–$€£]*\d[\d.,:/\-–−]*`;
// An optional short unit: up to four letters (µ counts as one), maybe per something short ("GB/s", "ns/op"), or %, ×, x.
const UNIT = String.raw`(?:[%×x]|\p{L}{1,4}(?:\/\p{L}{1,3})?)?`;
const FIGURE = new RegExp(String.raw`^${NUMBER}${UNIT}(?:[×x]|${NUMBER}${UNIT})?$`, "u");
const TWO_LETTERS = /\p{L}{2,}/u;

/** Whether WORD (one whitespace-separated piece of text) is a figure: essentially a number with an optional short unit. */
export function isFigure(word: string): boolean {
	const bare = word.replace(WRAPPING, "");
	return /\d/.test(bare) && FIGURE.test(bare);
}

/** Whether WORD counts as prose: two letters in a row, and not a figure. */
export function isProse(word: string): boolean {
	return TWO_LETTERS.test(word) && !isFigure(word);
}

const SKIPPED = new Set(["head", "script", "style", "svg", "template"]);
const RAW_TEXT = new Set(["script", "style", "template", "textarea", "title"]);

/** Counts the words of an HTML page; see the comment at the top. */
export function countWords(html: string): WordCount {
	const count: WordCount = { all: 0, prose: 0, folded: 0, visible: 0 };
	let skip = 0;
	// One frame per <details> we are inside: whether it is open, and how deep in its own <summary> we are.
	const details: { open: boolean; summary: number }[] = [];
	const text = (chunk: string) => {
		if (skip > 0) return;
		const folded = details.some((d) => !d.open && d.summary === 0);
		for (const word of decode(chunk).split(/\s+/)) {
			if (word === "") continue;
			count.all += 1;
			if (!isProse(word)) continue;
			count.prose += 1;
			if (folded) count.folded += 1;
		}
	};
	const token = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
	let at = 0;
	for (let match = token.exec(html); match; match = token.exec(html)) {
		text(html.slice(at, match.index));
		at = token.lastIndex;
		const name = match[2]?.toLowerCase();
		if (!name) continue; // a comment, doctype or CDATA
		const closing = match[1] === "/";
		const attributes = match[3] ?? "";
		const selfClosing = /\/\s*$/.test(attributes);
		if (!closing && RAW_TEXT.has(name) && !selfClosing) {
			// Its content is text up to its own end tag, never markup.
			const end = new RegExp(`</${name}\\s*>`, "ig");
			end.lastIndex = at;
			const found = end.exec(html);
			const inner = html.slice(at, found ? found.index : html.length);
			at = found ? end.lastIndex : html.length;
			token.lastIndex = at;
			if (!SKIPPED.has(name) && name !== "title") text(inner);
			continue;
		}
		if (SKIPPED.has(name)) {
			if (closing) skip = Math.max(0, skip - 1);
			else if (!selfClosing) skip += 1;
		} else if (name === "details") {
			if (closing) details.pop();
			else details.push({ open: /(^|\s)open(\s|=|\/|$)/i.test(attributes), summary: 0 });
		} else if (name === "summary" && details.length > 0) {
			const frame = details[details.length - 1]!;
			frame.summary = Math.max(0, frame.summary + (closing ? -1 : 1));
		}
	}
	text(html.slice(at));
	count.visible = count.prose - count.folded;
	return count;
}

/** "412 words (+90 folded)": a count as the picker and check:variation show it. */
export function describeWords(count: WordCount): string {
	return `${count.visible.toLocaleString("en")} word${count.visible === 1 ? "" : "s"}${count.folded > 0 ? ` (+${count.folded.toLocaleString("en")} folded)` : ""}`;
}
