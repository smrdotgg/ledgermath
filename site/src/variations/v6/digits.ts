// Typesetting helpers for figures: nothing here changes a digit. They say how wide a figure's
// fraction is (so a column can line its figures up on the decimal point) and where its first four
// significant digits end (so the rest can be set lighter, every digit still printed).

/** Characters from the decimal point to the end, the point included; 0 when there is no point. */
export function fracWidth(text: string): number {
	const point = text.indexOf(".");
	return point < 0 ? 0 : text.length - point;
}

/** Right padding, in `ch`, that lines `text` up on its decimal point in a right-aligned column of `texts`. */
export function padFor(text: string, texts: readonly string[]): string {
	const widest = Math.max(...texts.map(fracWidth));
	const pad = widest - fracWidth(text);
	return pad > 0 ? `padding-right:${pad}ch` : "";
}

/** The text split after its fourth significant digit: [the digits a reader compares, the rest]. */
export function headTail(text: string, significant = 4): [string, string] {
	let seen = 0;
	let started = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (ch >= "0" && ch <= "9") {
			if (ch !== "0") started = true;
			if (started) seen++;
			if (seen === significant) return [text.slice(0, i + 1), text.slice(i + 1)];
		}
	}
	return [text, ""];
}
