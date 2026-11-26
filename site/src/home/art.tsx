// The art beside the headline's second line, which fills the line to the end of the first, as the
// daisies and the church fill the last line on smr.gg: a strip chart feeding past over a ruler,
// drawn on the font's grid (see ./dots.ts). It is a drawing, not data: no figure of the tree is
// in it, and the page hides it from readers.
import { Dots } from "./dots";

/**
 * The art's width in dots. The headline's first line is 233 dots wide and "Math" 60; a gap of
 * 7 dots (the margin in site.css), then the art, then 2 dots beside it bring the second line to the
 * same 233, with the art's last dot under the last dot of the "n" above.
 */
const W = 164;

/** The ruler along the baseline: a line, a mark on every second dot, a longer mark on every tenth. */
const rule = new Dots().fill(0, 0, W, 1);
for (let x = 0; x < W; x += 2) rule.fill(x, 1, 1, x % 10 === 0 ? 4 : 2);

/**
 * The chart, as a benchmark's rounds would draw it: one round every PITCH dots, each a whisker two
 * dots wide with its median lit on it, two dots high. The rounds hold a level with a little noise,
 * step up for fifteen rounds, as when a machine changes, and step back, so the chart ends at the
 * level it began at and can come round again without a seam.
 */
const PITCH = 4;
/** The row of each round's median, counted from its level. */
const NOISE = [0, 0, 1, 0, -1, 0, 0, 1, 0, 0, -1, 1, 0, 0, 0, -1, 0, 1, 0, 0, 1, 0, -1, 0, 0, 1, 0, 0, -1, 0, 0, 1, 0, -1, 0, 0, 0, 1, -1, 0];
/** How many rows each round's whisker reaches above its median. It reaches one row below it. */
const ABOVE = [1, 2, 1, 1, 3, 1, 2, 1, 1, 2, 1, 1, 4, 1, 2, 1, 1, 2, 1, 3, 1, 1, 2, 1, 1, 1, 2, 1, 3, 1, 1, 2, 1, 1, 5, 1, 2, 1, 1, 2];
/** The level a round stands at: the lower row of its median before its noise. */
const level = (round: number) => (round >= 14 && round < 29 ? 12 : 8);

/**
 * How far the chart travels before it repeats, in dots. It is a strip this long, drawn twice end
 * to end, which site.css moves to the left one dot at a time (the 160 in v9-feed and in its steps).
 */
const LOOP = PITCH * NOISE.length;
const medians = new Dots();
const whiskers = new Dots();
for (let round = 0; round < NOISE.length; round++) {
	const x = round * PITCH + 1;
	const y = level(round) + NOISE[round]!;
	medians.fill(x, y, 2, 2);
	whiskers.fill(x, y - 1, 2, 1).fill(x, y + 2, 2, ABOVE[round]!);
}
/** How many dots at each end of the chart the rounds fade over, so that none appears or ends at an edge. */
const FADE = 7;

const strip = (rounds: Dots) => rounds.path() + rounds.moved(LOOP).path();

export function HeadlineArt() {
	return (
		<svg class="art" viewBox={`0 -19 ${W} 19`} aria-hidden="true">
			<defs>
				<linearGradient id="v9-strip-fade" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={W} y2="0">
					<stop offset="0" stop-color="#000" />
					<stop offset={FADE / W} stop-color="#fff" />
					<stop offset={1 - FADE / W} stop-color="#fff" />
					<stop offset="1" stop-color="#000" />
				</linearGradient>
				<mask id="v9-strip" maskUnits="userSpaceOnUse" x="0" y="-24" width={W} height="24">
					<rect x="0" y="-24" width={W} height="24" fill="url(#v9-strip-fade)" stroke="none" />
				</mask>
			</defs>
			<g class="strip" mask="url(#v9-strip)">
				<path class="far" d={strip(whiskers)} />
				<path d={strip(medians)} />
			</g>
			<path d={rule.path()} />
		</svg>
	);
}
