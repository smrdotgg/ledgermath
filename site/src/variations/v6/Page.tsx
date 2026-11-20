// Design v6, "Instrument panel", in its smallest form: every headline figure drawn to exact scale
// beside the others, one small chart per benchmark, the exact figure printed beside each mark, and
// almost no words. A chart's number opens what it measures; a figure opens its machine and every digit.
import type { JSX } from "@solidjs/web";
import "./page.css";
import { formatMoment, formatUsd, headline, links, machines, snapshot } from "../../data";
import { headTail, padFor, trimZeros } from "./digits";
import { at, instrument, type Instrument, type Mark as Point, type Scale, width, zeroScale } from "./scale";

const ROW = 24;
const AXIS = 22;
/** Of the plot's width, how far a cap may sit from the median and still lie under its dot (4 px of a ~200 px plot). */
const HIDDEN = 0.02;

/** The plot of one chart: gridlines, a track per machine, the p5–p95 bar with caps and the median dot. */
function Plot(props: { inst: Instrument; scale: Scale }) {
	const s = props.scale;
	const n = props.inst.marks.length;
	const base = n * ROW;
	return (
		<svg class="plot" aria-hidden="true" width="100%" height={base + AXIS}>
			{s.ticks.map((t) => (
				<line class={t.value === 0 ? "grid zero" : "grid"} x1={at(s, t.value)} x2={at(s, t.value)} y1="0" y2={base} />
			))}
			{props.inst.marks.map((m, i) => {
				const y = i * ROW + ROW / 2;
				// A p5–p95 that the median's dot covers is not drawn: its caps would only fleck the dot's edge.
				const span = s.hi - s.lo;
				const hidden = (m.p50.value - m.p5.value) / span < HIDDEN && (m.p95.value - m.p50.value) / span < HIDDEN;
				return (
					<g class={`mark r${i + 1}`}>
						<line class="track" x1="0" x2="100%" y1={y} y2={y} />
						{hidden ? null : (
							<>
								<rect class="range" x={at(s, m.p5.value)} width={width(s, m.p5.value, m.p95.value)} y={y - 1.5} height="3" />
								<line class="cap" x1={at(s, m.p5.value)} x2={at(s, m.p5.value)} y1={y - 4.5} y2={y + 4.5} />
								<line class="cap" x1={at(s, m.p95.value)} x2={at(s, m.p95.value)} y1={y - 4.5} y2={y + 4.5} />
							</>
						)}
						<circle class="median" cx={at(s, m.p50.value)} cy={y} r="4.25" />
					</g>
				);
			})}
			<line class="axis" x1="0" x2="100%" y1={base + 0.5} y2={base + 0.5} />
			{s.ticks.map((t) => (
				<line class="tick" x1={at(s, t.value)} x2={at(s, t.value)} y1={base} y2={base + 4} />
			))}
			{s.zoomed ? <path class="break" d={`M -5 ${base + 4} l 3 -8 m 3 8 l 3 -8`} /> : null}
		</svg>
	);
}

/**
 * The axis's figures, each centred on its tick, the unit set tight against the last one (a figure with
 * its unit, as the chart's own label), so the chart says what it counts without a word.
 */
function Axis(props: { scale: Scale; unit: string; prefix?: string }) {
	const labelled = props.scale.ticks.filter((t) => t.label !== "");
	const last = labelled[labelled.length - 1];
	return (
		<span class="ax">
			{labelled.map((t) => (
				<>
					<span class="tl" style={`left:${at(props.scale, t.value)};transform:translateX(-${((props.prefix ?? "") + t.label).length / 2}ch)`}>
						{`${props.prefix ?? ""}${t.label}${t === last ? props.unit : ""}`}
					</span>{" "}
				</>
			))}
		</span>
	);
}

/**
 * From zero, where the zoomed window sits: the whole scale, the window as a box (never thinner than
 * the eye can see), the five medians as dots, and two lines opening from the box to the ends of the
 * zoomed axis above, so the strip reads as the chart's magnifier without a caption.
 */
function Strip(props: { inst: Instrument; zoom: Scale }) {
	const z = props.inst.zero;
	const lo = at(z, props.zoom.lo);
	const hi = at(z, props.zoom.hi);
	const mid = at(z, (props.zoom.lo + props.zoom.hi) / 2);
	const thin = (props.zoom.hi - props.zoom.lo) / (z.hi - z.lo) < 0.03;
	const Y = 14;
	return (
		<svg class="strip" aria-hidden="true" width="100%" height={Y + 8}>
			<line class="lens" x1="0" x2={thin ? mid : lo} y1="0" y2={Y - 5} />
			<line class="lens" x1="100%" x2={thin ? mid : hi} y1="0" y2={Y - 5} />
			<line class="axis" x1="0" x2="100%" y1={Y + 0.5} y2={Y + 0.5} />
			<line class="axis" x1="0.5" x2="0.5" y1={Y - 3} y2={Y + 4} />
			<line class="axis" x1="100%" x2="100%" y1={Y - 3} y2={Y + 4} />
			{thin ? (
				// A window narrower than a pixel or two is drawn as a narrow tick, not a box that would widen it.
				<svg x={mid} y={Y - 5} width="1" height="11" overflow="visible">
					<rect class="window thin" x="-1" width="2" y="0" height="11" />
				</svg>
			) : (
				<rect class="window" x={lo} width={width(z, props.zoom.lo, props.zoom.hi)} y={Y - 5} height="11" />
			)}
			{props.inst.marks.map((m) => (
				<circle class="median small" cx={at(z, m.p50.value)} cy={Y + 0.5} r="2" />
			))}
		</svg>
	);
}

/** A machine's name as its family (in ink) and its size (lighter), whole at every width. */
function Name(props: { type: string }) {
	const dot = props.type.indexOf(".");
	return dot < 0 ? (
		<>{props.type}</>
	) : (
		<>
			<span class="fam">{props.type.slice(0, dot)}</span>
			<span class="sz">{props.type.slice(dot)}</span>
		</>
	);
}

const pad = (i: number) => String(i + 1).padStart(2, "0");

/** Significant digits in a figure as shown ("0.0175" has 3, "858" has 3, "10.00" has 4). */
const significantIn = (text: string) => text.replace(/[^\d]/g, "").replace(/^0+/, "").length;

/** Every digit of a figure, the ones the chart prints in full ink and the rest lighter. */
function Digits(props: { text: string; shown: string }) {
	const [head, tail] = headTail(props.text, Math.max(1, significantIn(props.shown)));
	return (
		<>
			<span class="hd">{head}</span>
			{tail ? <span class="tt">{tail}</span> : null}
		</>
	);
}

/**
 * Where a row measures the volume rather than the machine, as the data module's reason for
 * disk_read_io_uring's settings says: its tag, in the data's own words (the volume is "gp3" in each
 * choice's `what`), and the reason in full for its title.
 */
function limitOf(benchmark: string): { tag: string; title: string } | null {
	const reason = headline.find((r) => r.choice.benchmark === "disk_read_io_uring")?.choice.reason ?? "";
	if (!/IOPS limit/.test(reason) || !/throughput limit is what disk_read_sequential/.test(reason)) return null;
	if (benchmark === "disk_read_io_uring" || benchmark === "disk_read_sequential") return { tag: "gp3 limit", title: reason };
	return null;
}

/**
 * One median, rounded to the chart's decimals; opened, its machine, every digit of its p5, median and
 * p95, and the Runs counted, which link to its Series file (each Run with its evidence). Only one is open at a time.
 */
function Figure(props: { m: Point; row: number; unit: string; pad: string; last: boolean }) {
	const m = props.m;
	const all = [m.p5.full, m.p50.full, m.p95.full];
	const cells: [string, string, string][] = [
		["p95", m.p95.full, m.p95.short],
		["p50", m.p50.full, m.p50.short],
		["p5", m.p5.full, m.p5.short],
	];
	return (
		<details class={props.last ? `fig up r${props.row}` : `fig r${props.row}`} name="fig" style={`grid-row:${props.row}`}>
			<summary class="v" style={props.pad} title={`${m.instanceType}, ${props.unit}: median ${m.p50.full}, ${m.runs} Runs`}>
				{trimZeros(m.p50.short)}
			</summary>{" "}
			<div class="pop">
				<span class="pm">
					<Name type={m.instanceType} />
				</span>{" "}
				{cells.map(([k, v, shown]) => (
					<>
						<span class="k">{k}</span>{" "}
						<span class={k === "p50" ? "x med" : "x"} style={padFor(v, all)}>
							<Digits text={v} shown={shown} />
						</span>{" "}
					</>
				))}
				<span class="k">n</span>{" "}
				<a class="x go" href={m.url} aria-label={`${m.runs} Runs: its Series file, every Run with its evidence`} style={padFor(String(m.runs), all)}>
					{m.runs}{" "}
					<span class="arr" aria-hidden="true">
						↗
					</span>
				</a>
			</div>
		</details>
	);
}

/** A chart's number, which opens to what the chart measures, in the data's words, with a link to its documentation. */
function Label(props: { idx: string; children: JSX.Element; ariaLabel: string }) {
	return (
		<details class="lbl" name="lbl">
			<summary class="idx" aria-label={props.ariaLabel}>
				{props.idx}
			</summary>{" "}
			<div class="lpop">{props.children}</div>
		</details>
	);
}

function Card(props: { inst: Instrument; index: number }) {
	const inst = props.inst;
	const c = inst.row.choice;
	const zoom = inst.zoom;
	const scale = zoom ?? inst.zero;
	const limit = limitOf(c.benchmark);
	const texts = inst.marks.map((m) => trimZeros(m.p50.short));
	const unit = c.per ? `${inst.unit} / ${c.per.of}` : inst.unit;
	const runs = inst.marks.map((m) => m.runs);
	const fewest = Math.min(...runs);
	const most = Math.max(...runs);
	const id = `h-${c.benchmark}`;
	return (
		<article class="card" id={`b-${c.benchmark}`} aria-labelledby={id}>
			<header class="card-h">
				<Label idx={pad(props.index)} ariaLabel={`${pad(props.index)}: ${c.label}`}>
					<h2 id={id}>
						<a href={c.readme} title={`${c.what} ${c.setting}.`}>
							{c.label}
						</a>
					</h2>{" "}
					{c.per || limit ? (
						<span class="lm">
							{c.per ? <span class="lu">{unit}</span> : null}{" "}
							{limit ? (
								<a class="lim" href={c.readme} title={limit.title}>
									{limit.tag}
								</a>
							) : null}
						</span>
					) : null}
				</Label>{" "}
				<span class="n" title={`Runs counted: ${inst.marks.map((m) => `${m.instanceType} ${m.runs}`).join(", ")}`}>
					n {fewest === most ? fewest : `${fewest}–${most}`}
				</span>{" "}
				<span class="dir" role="img" aria-label={c.lead === "rate" ? "More is faster" : "Less is faster"} title={c.lead === "rate" ? "More is faster" : "Less is faster"}>
					{c.lead === "rate" ? "→" : "←"}
				</span>
			</header>
			<div class={zoom ? "chart zoomed" : "chart"} style={`--n:${inst.marks.length}`}>
				<Plot inst={inst} scale={scale} />
				{inst.marks.map((m, i) => (
					<>
						<Figure m={m} row={i + 1} unit={unit} pad={padFor(texts[i]!, texts)} last={i >= inst.marks.length - 2} />{" "}
					</>
				))}
				<Axis scale={scale} unit={inst.unit} />
				{zoom ? (
					<span class="zoom" title={`The axis starts at ${zoom.ticks[0]!.label} ${inst.unit}. From zero, all five sit inside the box.`}>
						<span class="z0">0</span> <Strip inst={inst} zoom={zoom} />{" "}
						<span class="zmax">{`${inst.zero.ticks[inst.zero.ticks.length - 1]!.label}${inst.unit}`}</span>
					</span>
				) : null}
			</div>
		</article>
	);
}

/** The machines, cheapest first, in the order every chart's rows take: each price drawn from zero, and opened, the machine. */
function Prices() {
	const prices = machines.map((m) => formatUsd(m.price.usdPerHour, { per: "hour" }));
	const scale = zeroScale(Math.max(...prices.map((p) => p.value)), 3);
	const texts = prices.map((p) => `$${p.full}`);
	return (
		<article class="card price" id="machines" aria-labelledby="h-machines">
			<header class="card-h">
				<Label idx="$" ariaLabel="Machines, AWS On-Demand prices">
					<h2 id="h-machines">
						<a href={links.prices}>AWS On-Demand prices</a>
					</h2>{" "}
					<span class="lm">
						<a href={links.prices}>{snapshot.priceDate}</a>
					</span>
				</Label>
			</header>
			<div class="chart" style={`--n:${machines.length}`}>
				<svg class="plot" aria-hidden="true" width="100%" height={machines.length * ROW + AXIS}>
					{scale.ticks.map((t) => (
						<line class={t.value === 0 ? "grid zero" : "grid"} x1={at(scale, t.value)} x2={at(scale, t.value)} y1="0" y2={machines.length * ROW} />
					))}
					{prices.map((p, i) => (
						<g class={`mark r${i + 1}`}>
							<line class="track" x1="0" x2="100%" y1={i * ROW + ROW / 2} y2={i * ROW + ROW / 2} />
							<rect class="bar" x="0" y={i * ROW + ROW / 2 - 3} width={width(scale, 0, p.value)} height="6" />
						</g>
					))}
					<line class="axis" x1="0" x2="100%" y1={machines.length * ROW + 0.5} y2={machines.length * ROW + 0.5} />
					{scale.ticks.map((t) => (
						<line class="tick" x1={at(scale, t.value)} x2={at(scale, t.value)} y1={machines.length * ROW} y2={machines.length * ROW + 4} />
					))}
				</svg>
				{machines.map((m, i) => (
					<details class={i >= machines.length - 2 ? `fig up r${i + 1}` : `fig r${i + 1}`} name="fig" style={`grid-row:${i + 1}`}>
						<summary class="v" style={padFor(texts[i]!, texts)} title={`${m.instanceType}: ${m.price.description}`}>
							${prices[i]!.full}
						</summary>{" "}
						<div class="pop">
							<span class="pm">
								<Name type={m.instanceType} />
							</span>{" "}
							<span class="x sp">{`${m.vcpu}vCPU`}</span> <span class="x sp">{`${m.memory.replace(/ GiB$/, "")}GiB`}</span>{" "}
							<a class="x go sp" href={links.prices} title={m.price.path.pointer} aria-label={`$${prices[i]!.full}/hour: ${m.instanceType} in the price file of ${snapshot.priceDate}`}>
								{`$${prices[i]!.full}/hour`}{" "}
								<span class="arr" aria-hidden="true">
									↗
								</span>
							</a>
						</div>
					</details>
				))}
				<Axis scale={scale} unit="/hour" prefix="$" />
			</div>
		</article>
	);
}

function Mark() {
	return (
		<svg class="logo" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
			<rect x="0.5" y="0.5" width="27" height="27" rx="6" class="logo-box" />
			<line x1="6" x2="22" y1="10" y2="10" class="logo-range" />
			<line x1="6" x2="6" y1="7" y2="13" class="logo-range" />
			<line x1="22" x2="22" y1="7" y2="13" class="logo-range" />
			<circle cx="15" cy="10" r="3" class="logo-dot" />
			<line x1="4" x2="24" y1="20.5" y2="20.5" class="logo-axis" />
			<line x1="4" x2="4" y1="18" y2="23" class="logo-axis" />
			<line x1="14" x2="14" y1="19" y2="22" class="logo-axis" />
			<line x1="24" x2="24" y1="19" y2="22" class="logo-axis" />
		</svg>
	);
}

export default function Page() {
	const instruments = headline.map(instrument);
	const newest = formatMoment(snapshot.newestRunStartedAt);

	return (
		<>
			<main id="top">
				<section class="hero wrap" aria-labelledby="h1">
					<div class="brand">
						<Mark />
						<h1 id="h1">LedgerMath</h1>
					</div>
					<div class="hero-r">
						<div class="cmd">
							<span class="prompt" aria-hidden="true">
								$
							</span>
							<code data-copy tabindex="0">
								curl {links.index}
							</code>
						</div>
						<a class="when" href={links.seriesList} aria-label={`${newest.date} ${newest.minute}UTC, the newest Run: every Series, each listing its Runs with their evidence`}>
							<svg class="clock" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
								<circle cx="7" cy="7" r="6" />
								<path d="M7 3.5V7l2.5 1.5" />
							</svg>
							<time datetime={newest.iso} title={newest.full}>
								{newest.date} <b>{`${newest.minute}UTC`}</b>
							</time>
						</a>
					</div>
				</section>

				<section class="wrap block" aria-label="Every headline figure">
					<p class="key">
						<span class="dir" aria-hidden="true">
							→
						</span>{" "}
						faster
					</p>
					<div class="board">
						<Prices />
						{instruments.map((inst, i) => (
							<Card inst={inst} index={i} />
						))}
					</div>
				</section>
			</main>

			<footer class="foot">
				<div class="wrap foot-in">
					<a class="notice" href="third-party-notices.txt" aria-label="Third-party notices">
						©
					</a>
				</div>
			</footer>
		</>
	);
}
