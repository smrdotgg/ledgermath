// The napkin beside the home page's closing note (Page.tsx), which credits Napkin Math: a
// cocktail napkin, a square stood on its corner, with an embossed edge and a sum written on it,
// drawn on the font's grid as the headline's art is (./dots.ts). The sum is true of this site:
// four rounds a day for a year is 1,460 rounds, about 1.5k.
import { Dots } from "./dots";

/** The napkin's width and height in dots, and the column and row of its middle. */
const N = 43;
const C = (N - 1) / 2;

/**
 * The sum's figures, top row first: 3 dots wide and 5 tall, but for the point (1 wide) and the
 * sign for "about" (5 wide). "x" is the sign for "times".
 */
const FIGURES: Record<string, readonly string[]> = {
	"1": [".#.", "##.", ".#.", ".#.", "###"],
	"3": ["###", "..#", ".##", "..#", "###"],
	"4": ["#.#", "#.#", "###", "..#", "..#"],
	"5": ["###", "#..", "###", "..#", "###"],
	"6": ["###", "#..", "###", "#.#", "###"],
	k: ["#..", "#.#", "##.", "#.#", "#.#"],
	x: ["...", "#.#", ".#.", "#.#", "..."],
	".": [".", ".", ".", ".", "#"],
	"~": [".....", ".#...", "#.#.#", "...#.", "....."],
};

/** Writes WORD in FIGURES, one empty column between its letters: its first column x, its top row `top`. */
function write(dots: Dots, word: string, x: number, top: number): void {
	for (const letter of word) {
		const figure = FIGURES[letter];
		if (!figure) throw new Error(`no figure for ${JSON.stringify(letter)}`);
		figure.forEach((row, j) => {
			for (let i = 0; i < row.length; i++) if (row[i] === "#") dots.dot(x + i, top - j);
		});
		x += figure[0]!.length + 1;
	}
}

// The edge is every cell C steps from the middle, counted along rows and columns; the embossing
// is every second cell 3 steps inside it.
const edge = new Dots();
const emboss = new Dots();
for (let y = 0; y < N; y++) {
	for (let x = 0; x < N; x++) {
		const steps = Math.abs(x - C) + Math.abs(y - C);
		if (steps === C) edge.dot(x, y);
		if (steps === C - 3 && (x - C) % 2 === 0) emboss.dot(x, y);
	}
}

// Two lines of five figures, each 19 dots wide, with a rule between them, in the napkin's middle.
const sum = new Dots().fill(12, 21, 19, 1);
write(sum, "4x365", 12, 28);
write(sum, "~1.5k", 12, 18);

export function Napkin() {
	return (
		<svg class="nap" viewBox={`0 ${-N} ${N} ${N}`} aria-hidden="true">
			<path class="far" d={emboss.path()} />
			<path d={edge.path() + sum.path()} />
		</svg>
	);
}
