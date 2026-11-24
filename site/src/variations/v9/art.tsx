// The art beside the headline's second line, which fills the line to the end of the first, as the
// daisies and the church fill the last line on smr.gg: clouds drifting over a ruler, drawn on the
// font's grid (see ./dots.ts).
import { Dots } from "./dots";

/**
 * The art's width in dots. The headline's first line is 229 dots wide and "Benchmarks" 149; a gap of
 * 7 dots (the margin in page.css), then the art, then 2 dots beside it bring the second line to the
 * same 229, with the art's last dot under the last dot of the "d" above.
 */
const W = 71;

/** The ruler along the baseline: a line, a mark on every second dot, a longer mark on every tenth. */
const rule = new Dots().fill(0, 0, W, 1);
for (let x = 0; x < W; x += 2) rule.fill(x, 1, 1, x % 10 === 0 ? 4 : 2);

/**
 * How far the sky travels before it repeats, in dots. Each layer of clouds is a strip this long,
 * drawn twice end to end, which page.css moves one dot at a time (the 96 in v9-drift and in its
 * steps). The far layer moves more slowly than the near one, and the near clouds pass in front.
 */
const SKY = 96;
const far = new Dots().cloud(5, 9, 22, 9).cloud(74, 12, 17, 7);
const near = new Dots().cloud(35, 8, 33, 12);
/** How many dots at each end of the sky the clouds fade over, so that none appears or ends at an edge. */
const FADE = 5;

const strip = (clouds: Dots) => clouds.path() + clouds.moved(-SKY).path();

export function HeadlineArt() {
	return (
		<svg class="art" viewBox={`0 -19 ${W} 19`} aria-hidden="true">
			<defs>
				<linearGradient id="v9-sky-fade" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={W} y2="0">
					<stop offset="0" stop-color="#000" />
					<stop offset={FADE / W} stop-color="#fff" />
					<stop offset={1 - FADE / W} stop-color="#fff" />
					<stop offset="1" stop-color="#000" />
				</linearGradient>
				<mask id="v9-sky" maskUnits="userSpaceOnUse" x="0" y="-24" width={W} height="24">
					<rect x="0" y="-24" width={W} height="24" fill="url(#v9-sky-fade)" stroke="none" />
				</mask>
			</defs>
			<g class="sky" mask="url(#v9-sky)">
				<path class="far" d={strip(far)} />
				<path class="near" d={strip(near)} />
			</g>
			<path d={rule.path()} />
		</svg>
	);
}
