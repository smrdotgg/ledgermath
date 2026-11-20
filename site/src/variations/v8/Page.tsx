// dt-wild: a ransom note. LedgerMath takes five machines four times a day, times them, puts them back,
// and leaves the evidence. Every figure comes from src/data as the snapshot holds it; see ../README.md.
// Charts are drawn by the Datatype font ({b:…}); bar heights are scaled in code, from zero, the row's
// largest value at 100, so machines that differ by little look alike.
import "./page.css";
import type { JSX } from "@solidjs/web";
import {
	type DurationUnit,
	durationUnit,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	headline,
	type HeadlineRow,
	leadFigure,
	links,
	type Machine,
	machines,
	type Shown,
	snapshot,
} from "../../data";

// ------------------------------------------------------------------ the cut-out letters

/** A small seeded generator, so the collage is the same on every build. */
function rng(seed: string) {
	let h = 1779033703 ^ seed.length;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	return () => {
		h = Math.imul(h ^ (h >>> 16), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		h ^= h >>> 16;
		return (h >>> 0) / 4294967296;
	};
}

// Paper and ink, each pair at least 4.5:1.
const PAPERS = [
	["#f4f1e8", "#111"],
	["#ffffff", "#000"],
	["#ffd23f", "#111"],
	["#ff9eb5", "#111"],
	["#111111", "#fff"],
	["#b3121d", "#fff"],
	["#16325c", "#fff"],
	["#cdb083", "#111"],
	["#7fd1b9", "#111"],
	["#e8e2d0", "#7a0a10"],
] as const;
const FAMILIES = ["dt", "serif", "sans", "dt", "serif", "sans", "slab"] as const;

/** Text cut letter by letter from different papers. `keep` keeps the letters' case (data words: machine names, the Region). */
function Cutout(props: { text: string; seed?: string; keep?: boolean; class?: string }): JSX.Element {
	const r = rng(props.seed ?? props.text);
	const words = props.text.split(" ");
	return (
		<span class={`cut ${props.class ?? ""}`} aria-hidden="true">
			{words.map((word, wi) => (
				<>
					<span class="w">
						{[...word].map((ch) => {
							const [bg, fg] = PAPERS[Math.floor(r() * PAPERS.length)]!;
							const fam = FAMILIES[Math.floor(r() * FAMILIES.length)]!;
							const rot = (r() * 14 - 7).toFixed(1);
							const dy = (r() * 0.16 - 0.08).toFixed(2);
							const size = (0.82 + r() * 0.36).toFixed(2);
							const bold = r() > 0.45;
							const italic = fam === "serif" && r() > 0.7;
							const flip = !props.keep && /[a-z]/i.test(ch) && r() > 0.72;
							const letter = flip ? (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) : ch;
							return (
								<span
									class={`l f-${fam}${bold ? " b" : ""}${italic ? " i" : ""}`}
									style={{ background: bg, color: fg, transform: `translateY(${dy}em) rotate(${rot}deg)`, "font-size": `${size}em` }}
								>
									{letter}
								</span>
							);
						})}
					</span>
					{wi < words.length - 1 ? " " : ""}
				</>
			))}
		</span>
	);
}

/** A line of the note: the cut-out letters for the eye, the plain words for a screen reader. */
function Line(props: { text: string; say?: string; keep?: boolean; class?: string; seed?: string }) {
	return (
		<p class={`line ${props.class ?? ""}`}>
			<span class="sr">{props.say ?? props.text}</span>
			<Cutout text={props.text} keep={props.keep} seed={props.seed} />
		</p>
	);
}

// ------------------------------------------------------------------ figures

const runs = formatCount(snapshot.runCount);
const newest = formatMoment(snapshot.newestRunStartedAt);
const API = links.index;

/** The unit a row is shown in: the one its smallest figure reads at least 1 in, so the five compare digit for digit. */
type RowUnit = { kind: "rate"; unit: string } | { kind: "time"; unit: DurationUnit; per?: { count: number; of: string } };

function rowUnit(row: HeadlineRow): RowUnit {
	const per = row.choice.per;
	const least = Math.min(...row.cells.map((c) => leadFigure(row.choice, c.series).p50));
	if (row.choice.lead === "rate") return { kind: "rate", unit: formatRate(least).unit.replace("/s", "") };
	if (per) return { kind: "time", unit: formatDurationPerUnit(least, per).unit as DurationUnit, per };
	return { kind: "time", unit: durationUnit(least) };
}

function show(value: number, u: RowUnit): Shown {
	if (u.kind === "rate") return formatRate(value, { unit: u.unit as "GB" });
	if (u.per) return formatDurationPerUnit(value, u.per, { unit: u.unit });
	return formatDuration(value, { unit: u.unit });
}

/** Bar heights for the font, 0 to 100: from zero, the largest value at 100, the others in proportion. */
function heights(values: number[]): number[] {
	const max = Math.max(...values);
	return values.map((v) => Math.round((v / max) * 100));
}

function newestRun(m: Machine) {
	return formatMoment(m.series.map((s) => s.newest_run_started_at).sort().at(-1)!);
}

/** "c8i.2xlarge" as its family and its size; the bars are labelled by family (the five differ), no word added. */
function splitType(t: string): [string, string] {
	const i = t.indexOf(".");
	return [t.slice(0, i), t.slice(i)];
}

// ------------------------------------------------------------------ parts

function Polaroid(props: { m: Machine; i: number }) {
	const m = props.m;
	const run = newestRun(m);
	const price = formatUsd(m.price.usdPerHour);
	const fraction = run.full.slice(19, -4);
	return (
		<li class="polaroid" style={{ "--tilt": `${[-3, 2, -1.5, 3, -2.5][props.i]}deg` }}>
			<div class="photo">
				<p class="who">{m.instanceType}</p>
				<span class="box" aria-hidden="true" />
				<div class="paper" role="group" aria-label={`Holding the newest Run: ${run.full}`}>
					<p class="masthead" aria-hidden="true">The Newest Run</p>
					<p class="pdate" aria-hidden="true">{run.date}</p>
					<p class="ptime" aria-hidden="true">
						{run.second}
						<br />
						{fraction} UTC
					</p>
				</div>
			</div>
			<p class="caption">
				{m.vcpu} vCPU · {m.memory} · {m.processor}
			</p>
			<p class="demand">
				<span class="dl">On-Demand</span> <span class="nw">
					<span class="dv" title={`${m.price.description}; the price file writes ${m.price.usdPerHour}`}>${price.full}</span>
					<span class="du">/hr</span>
				</span>
			</p>
		</li>
	);
}

function unitLine(row: HeadlineRow, u: RowUnit): string {
	if (u.kind === "rate") return `median, ${u.unit}/s`;
	if (u.per) return `median, ${u.unit} per ${u.per.of}`;
	return `median, ${u.unit} each`;
}

function Clipping(props: { row: HeadlineRow; i: number }) {
	const row = props.row;
	const u = rowUnit(row);
	const figs = row.cells.map((c) => leadFigure(row.choice, c.series));
	const hs = heights(figs.map((f) => f.p50));
	return (
		<li class="clip" style={{ "--tilt": `${((props.i * 37) % 7) - 3}deg` }}>
			<span class="tape" aria-hidden="true" />
			<p class="sect">{row.choice.section}</p>
			<h3>{row.choice.label}</h3>
			<p class="unit">{unitLine(row, u)}</p>
			<ol class="bars">
				{row.cells.map((c, k) => {
					const s = show(figs[k]!.p50, u);
					const [fam] = splitType(c.machine.instanceType);
					return (
						<li>
							<span class="bar" role="img" aria-label={`${c.machine.instanceType}: ${s.full} ${s.unit}`}>
								<span class="dt-chart" aria-hidden="true">{`{b:${hs[k]}}`}</span>
							</span>
							<span class="fig" title={`${s.full} ${s.unit}`} aria-hidden="true">
								{s.short}
							</span>
							<span class="mt" aria-hidden="true" title={c.machine.instanceType}>
								<b>{fam}</b>
							</span>
						</li>
					);
				})}
			</ol>
			<details>
				<summary>every digit</summary>
				<p class="rep">One repetition: {row.choice.repetition}</p>
				<table>
					<thead>
						<tr>
							<th scope="col">machine</th>
							<th scope="col">p5</th>
							<th scope="col">p50</th>
							<th scope="col">p95</th>
							<th scope="col">Runs</th>
						</tr>
					</thead>
					<tbody>
						{row.cells.map((c, k) => (
							<tr>
								<th scope="row">
									<a href={links.seriesFile(c.series)}>{c.machine.instanceType}</a>
								</th>
								<td>{show(figs[k]!.p5, u).full}</td>
								<td>{show(figs[k]!.p50, u).full}</td>
								<td>{show(figs[k]!.p95, u).full}</td>
								<td>{formatCount(figs[k]!.count).full}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p class="rep">
					In {u.kind === "rate" ? `${u.unit}/s` : u.per ? `${u.unit} per ${u.per.of}` : u.unit}. <a href={row.choice.readme}>How it is measured</a>
				</p>
			</details>
		</li>
	);
}

// The proof the note carries: one row, typed out, which the font turns into a chart.
const proofRow = headline[0]!;
const proofUnit = rowUnit(proofRow);
const proofFigs = proofRow.cells.map((c) => show(leadFigure(proofRow.choice, c.series).p50, proofUnit));
const proofChart = `{b:${heights(proofRow.cells.map((c) => leadFigure(proofRow.choice, c.series).p50)).join(",")}}`;

// ------------------------------------------------------------------ the page

export default function Page() {
	return (
		<>
			<header class="top">
				<p class="mark">
					<b>LedgerMath</b> <span>cloud servers, measured</span>
				</p>
				<a class="toapi" href={API}>
					the API
				</a>
			</header>
			<main>
				<section class="note-wrap" aria-labelledby="h1">
					<div class="note">
						<h1 id="h1">
							<span class="sr">We have your machines. Signed, LedgerMath.</span>
							<Cutout text="WE HAVE YOUR" seed="a1" class="huge" />
							<br />
							<Cutout text="MACHINES" seed="m3" class="huge xl" />
						</h1>
						<Line text="5 of them. us-east-2." seed="b2" keep />
						<Line text="we wake them at" seed="c1" />
						<p class="line times">
							<span class="sr">04:10, 10:10, 16:10 and 22:10 UTC.</span>
							<Cutout text="04:10 10:10 16:10 22:10" seed="t9" keep class="big" />
							<Cutout text="UTC" seed="u1" keep />
						</p>
						<Line text="we time them 14 ways" seed="d4" />
						<Line text="then we PUT THEM BACK" seed="e5" />
						<Line text={`we keep every Run: ${runs.full}`} seed="f2" />
						<p class="sig">
							<span class="sr">Signed, LedgerMath</span>
							<Cutout text="— LedgerMath" seed="g8" keep class="big" />
						</p>
					</div>

					<div class="slip">
						<p class="slip-h">Send your agent. Come alone.</p>
						<p class="cmd" data-copy={API}>
							<code>{API}</code>
						</p>
						<p class="slip-f">No rounding. No averages. Every figure with its evidence.</p>
					</div>

					<figure class="proof">
						<figcaption>
							P.S. proof we were there: <span class="pc">{proofRow.choice.label}</span>, median, {proofFigs[0]!.unit}
						</figcaption>
						<div class="typed" role="img" aria-label={`${proofRow.choice.label}: ${proofRow.cells.map((c, k) => `${c.machine.instanceType} ${proofFigs[k]!.full}`).join(", ")}`}>
							<span class="dt-chart" aria-hidden="true" data-type-in>
								{proofChart}
							</span>
						</div>
						<ol class="pf" aria-hidden="true">
							{proofRow.cells.map((c, k) => (
								<li title={`${proofFigs[k]!.full} ${proofFigs[k]!.unit}`}>
									<b>{proofFigs[k]!.short}</b> {c.machine.instanceType}
								</li>
							))}
						</ol>
					</figure>
				</section>

				<section class="pol-wrap" aria-labelledby="h-pol">
					<h2 id="h-pol">
						<span class="sr">Proof of life</span>
						<Cutout text="PROOF OF LIFE" seed="p0" class="big" />
					</h2>
					<p class="hint">Each one holding the newest Run. Their demands: AWS's On-Demand price, per hour.</p>
					<ul class="polaroids">
						{machines.map((m, i) => (
							<Polaroid m={m} i={i} />
						))}
					</ul>
				</section>

				<section class="ev-wrap" aria-labelledby="h-ev">
					<h2 id="h-ev">
						<span class="sr">The evidence</span>
						<Cutout text="THE EVIDENCE" seed="v7" class="big" />
					</h2>
					<p class="hint">
						14 tests. Bars start at zero; the largest figure fills its bar. Left to right: {machines.map((m) => m.instanceType).join(", ")}.
					</p>
					<ol class="clips">
						{headline.map((row, i) => (
							<Clipping row={row} i={i} />
						))}
						<li class="rest">
							<h3 class="rest-h">The rest of the evidence</h3>
							<p>
								{formatCount(snapshot.seriesCount).full} Series, {runs.full} Runs. Each Series file holds each Run's figure and a link to its evidence:
							</p>
							<p class="cmd">
								<code>{links.seriesFilePattern}</code>
							</p>
						</li>
					</ol>
				</section>
			</main>
			<footer class="fine">
				<p>
					Figures: the median (p50) of each Series' counted Runs, by Method series v1, on freshly booted machines in {snapshot.region}. Newest Run{" "}
					{newest.full}. Prices: AWS On-Demand Linux, price file {snapshot.priceDate}.
				</p>
				<p class="flinks">
					<a href={links.index}>index.json</a> <a href={links.seriesList}>series.json</a> <a href={links.prices}>prices</a> <a href={links.docs}>docs</a>{" "}
					<a href="third-party-notices.txt">font: Datatype (OFL)</a>
				</p>
			</footer>
		</>
	);
}
