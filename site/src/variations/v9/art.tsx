// The art beside the headline's second line, which fills the line to the end of the first, as the
// daisies and the church fill the last line on smr.gg. Two pictures, drawn on the font's grid (see
// ./dots.ts): clouds drifting over a ruler, and a caliper that closes on one cloud after another.
// A flag, ART_SHARE, says how often a visitor sees each.
import { Dots } from "./dots";

// ---------------------------------------------------------------- the flag

export type ArtName = "ruler" | "caliper";

/**
 * The feature flag: of every 100 loads of the page, how many draw each picture. Whole numbers that
 * add up to 100. Both pictures are always in the page; a short script in <head> (CHOOSE_ART) draws
 * lots on each load and names the winner on <html data-art="…">, which page.css reads.
 *
 * To see one picture whatever the flag says, add ?art=ruler or ?art=caliper to the address.
 */
export const ART_SHARE: Record<ArtName, number> = { ruler: 100, caliper: 0 };

const names = Object.keys(ART_SHARE) as ArtName[];
for (const name of names) if (!Number.isInteger(ART_SHARE[name]) || ART_SHARE[name] < 0) throw new Error(`ART_SHARE.${name} must be a whole number, 0 or more`);
if (names.reduce((sum, name) => sum + ART_SHARE[name], 0) !== 100) throw new Error("the shares in ART_SHARE must add up to 100");

/** The picture drawn where the script does not run (JavaScript off): the one with the largest share. */
export const DEFAULT_ART: ArtName = names.reduce((most, name) => (ART_SHARE[name] > ART_SHARE[most] ? name : most));

/** The script for <head>: the address's ?art= if it names a picture, or else a draw by ART_SHARE. It runs before the first paint. */
export const CHOOSE_ART = `(()=>{const s=${JSON.stringify(ART_SHARE)},q=new URLSearchParams(location.search).get("art");let a=Object.keys(s).includes(q)?q:"",r=Math.random()*100;if(!a)for(const k in s)if((r-=s[k])<0){a=k;break}if(a)document.documentElement.dataset.art=a})()`;

// ---------------------------------------------------------------- what both pictures share

/**
 * The art's width in dots. The headline's first line is 229 dots wide and "Benchmarks" 149; a gap of
 * 7 dots (the margin in page.css), then the art, then 2 dots beside it bring the second line to the
 * same 229, with the art's last dot under the last dot of the "d" above.
 */
const W = 71;

/** The ruler along the baseline: a line, a mark on every second dot, a longer mark on every tenth. */
function rule(): Dots {
	const d = new Dots().fill(0, 0, W, 1);
	for (let x = 0; x < W; x += 2) d.fill(x, 1, 1, x % 10 === 0 ? 4 : 2);
	return d;
}

// ---------------------------------------------------------------- 1: clouds over a ruler

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

function Ruler() {
	return (
		<svg class="art ruler" viewBox={`0 -19 ${W} 19`} aria-hidden="true">
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
			<path d={rule().path()} />
		</svg>
	);
}

// ---------------------------------------------------------------- 2: a cloud in a caliper

/** The caliper's fixed jaw stands on columns 7 and 8; a cloud it holds starts one empty column on, at 10. */
const held = (w: number, h: number): Dots => {
	const cloud = new Dots().cloud(0, 7, w, h);
	return cloud.moved(10 - cloud.span().left);
};
const wide = held(33, 12);
const narrow = held(24, 10);
/** The sliding jaw's first column when it holds the wide cloud: one empty column after the cloud. */
const jawAt = wide.span().right + 2;
// page.css moves the jaw: 5 dots open, then shut on the narrow cloud, 9 dots short of where it holds the wide one.
if (narrow.span().right + 2 - jawAt !== -9) throw new Error("the caliper's clouds have changed width: change the 9 dots in page.css's v9-jaw to match");

function Caliper() {
	return (
		<svg class="art caliper" viewBox={`0 -19 ${W} 19`} aria-hidden="true">
			<path class="near wide" d={wide.path()} />
			<path class="near narrow" d={narrow.path()} />
			<path d={rule().fill(7, 5, 2, 15).fill(4, 5, 3, 2).path()} />
			<path class="jaw" d={new Dots().fill(jawAt, 5, 2, 15).fill(jawAt + 2, 5, 8, 2).path()} />
		</svg>
	);
}

/** Both pictures; page.css shows the one named on <html data-art>. */
export function HeadlineArt() {
	return (
		<>
			<Ruler />
			<Caliper />
		</>
	);
}
