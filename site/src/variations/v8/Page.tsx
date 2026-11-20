// Design v8, "Editorial landing", in its tiny forms: the one figure the design traces, set large, and the way in.
// Every figure comes from src/data as the snapshot holds it; see ../README.md. A figure's unit shares its text node
// with its last digits, so the unit is part of the figure, never a word of its own.
import "./tiny.css";
import { type DurationUnit, formatDurationPerUnit, formatMoment, formatUsd, headline, leadFigure, links, seriesFileContents } from "../../data";

// ------------------------------------------------------------------ the traced figure

/** The headline figure whose Series file the snapshot keeps as a sample, so it can be followed to one Run's evidence. */
const row = headline.find((r) => r.cells.some((c) => c.series.id === seriesFileContents.sample.id)) ?? headline[0]!;
const cell = row.cells.find((c) => c.series.id === seriesFileContents.sample.id) ?? row.cells[0]!;
const per = row.choice.per!;
const lead = leadFigure(row.choice, cell.series);
const p50 = formatDurationPerUnit(lead.p50, per);
const unit = p50.unit as DurationUnit;
const p5 = formatDurationPerUnit(lead.p5, per, { unit });
const p95 = formatDurationPerUnit(lead.p95, per, { unit });
const point = seriesFileContents.point.example;
const runAt = formatMoment(point.started_at);
const oldest = formatMoment(cell.series.oldest_run_started_at);
const newest = formatMoment(cell.series.newest_run_started_at);

/** Where the median's digits stop agreeing with p5 and p95: the head is what all three share. */
function split(mid: string, lo: string, hi: string): [string, string] {
	let n = 0;
	while (n < mid.length && lo[n] === mid[n] && hi[n] === mid[n]) n++;
	if (mid[n - 1] === ".") n--;
	return [mid.slice(0, n), mid.slice(n)];
}
const [head, tail] = split(p50.full, p5.full, p95.full);

/** p5 to p95 on a zoomed scale, the median's dot between; the break at the axis's left end says it does not start at 0. */
function Strip() {
	const lo = lead.p5;
	const hi = lead.p95;
	const pad = (hi - lo) * 0.5;
	const at = (v: number) => `${(((v - (lo - pad)) / (hi - lo + 2 * pad)) * 100).toFixed(2)}%`;
	return (
		<div class="strip" style={{ "--p5": at(lo), "--p50": at(lead.p50), "--p95": at(hi) }}>
			<span class="st-break" role="img" aria-label="zoomed, not from 0" title="zoomed, not from 0" />
			<span class="st-draw" aria-hidden="true">
				<span class="st-axis" />
				<span class="st-span" />
				<span class="st-tick st-t5" />
				<span class="st-tick st-t95" />
				<span class="st-dot" />
			</span>
			<span class="st-l st-l5" title={`5th percentile: ${p5.full} ${p5.unit} per ${per.of}`}>
				<span class="pct">p5</span> {p5.full}
			</span>
			<span class="st-l st-l95" title={`95th percentile: ${p95.full} ${p95.unit} per ${per.of}`}>
				<span class="pct">p95</span> {p95.full}
			</span>
		</div>
	);
}

/**
 * Every digit of a figure, the integer part right-aligned so the decimal points of a column line up; the digits its
 * p5 and p95 share in ink, the rest quieter. The unit joins the last digits in one text node.
 */
function Exact(props: { full: string; lo: string; hi: string; unit: string }) {
	const [int = "", frac] = props.full.split(".");
	const [h] = split(props.full, props.lo, props.hi);
	const fracText = frac === undefined ? "" : `.${frac}`;
	const headInt = h.slice(0, int.length);
	const tailInt = int.slice(headInt.length);
	const headFrac = h.length > int.length ? h.slice(int.length) : "";
	const tailFrac = fracText.slice(headFrac.length);
	const last = tailFrac ? "tf" : headFrac ? "hf" : tailInt ? "ti" : "hi";
	const u = (part: string, text: string) => (part === last ? `${text}${props.unit}` : text);
	return (
		<span class="exact">
			<span class="x-int">
				{headInt ? <span class="x-head">{u("hi", headInt)}</span> : null}
				{tailInt ? <span class="x-tail">{u("ti", tailInt)}</span> : null}
			</span>
			<span class="x-frac">
				{headFrac ? <span class="x-head">{u("hf", headFrac)}</span> : null}
				{tailFrac ? <span class="x-tail">{u("tf", tailFrac)}</span> : null}
			</span>
		</span>
	);
}

/** The traced benchmark on every machine: hourly price, every digit, and the median as a bar from 0 with its p5 to p95. */
function Machines() {
	const figures = row.cells.map((c) => leadFigure(row.choice, c.series));
	const max = Math.max(...figures.map((f) => f.p95));
	const shown = figures.map((f) => ({
		p50: formatDurationPerUnit(f.p50, per, { unit }),
		p5: formatDurationPerUnit(f.p5, per, { unit }),
		p95: formatDurationPerUnit(f.p95, per, { unit }),
	}));
	const iw = Math.max(...shown.map((s) => s.p50.full.split(".")[0]!.length));
	const fw = Math.max(...shown.map((s) => (s.p50.full.split(".")[1] ?? "").length + 1)) + unit.length;
	const at = (v: number) => `${((v / max) * 100).toFixed(2)}%`;
	return (
		<ul class="mx" style={{ "--iw": `${iw}ch`, "--fw": `${fw}ch` }}>
			{row.cells.map((c, i) => {
				const f = figures[i]!;
				const s = shown[i]!;
				const price = formatUsd(c.machine.price.usdPerHour).full;
				return (
					<li class={c === cell ? "is-traced" : undefined}>
						<span class="mx-m mono">{c.machine.instanceType}</span>
						<span class="mx-p mono" title={`${c.machine.price.description}. In the price file at ${c.machine.price.path.pointer}`}>
							{`$${price}/h`}
						</span>
						<a class="mx-v" href={links.seriesFile(c.series)} title={`${row.choice.label} on ${c.machine.instanceType}: ${s.p50.full} ${unit} per ${per.of}, the median of ${f.count} counted runs. 5th percentile ${s.p5.full}, 95th ${s.p95.full}.`}>
							<Exact full={s.p50.full} lo={s.p5.full} hi={s.p95.full} unit={unit} />
						</a>
						<span
							class="mx-bar"
							role="img"
							aria-label={`Bar: median ${s.p50.full} ${unit}, drawn from 0. Whisker: 5th to 95th percentile, ${s.p5.full} to ${s.p95.full} ${unit}`}
							title={`bar: median from 0 · whisker: p5 ${s.p5.full} to p95 ${s.p95.full}`}
							style={{ "--p5": at(f.p5), "--p50": at(f.p50), "--p95": at(f.p95) }}>
							<span class="mx-fill" />
							<span class="mx-whisk" />
						</span>
					</li>
				);
			})}
		</ul>
	);
}

function Traced() {
	return (
		<figure class="traced" aria-labelledby="traced-what">
			<p class="what" id="traced-what">
				<span class="dot" aria-hidden="true" />
				<a href={row.choice.readme} title={`${row.choice.label}: ${row.choice.what}`}>
					mutex
				</a>
				<span class="mono">{cell.machine.instanceType}</span>
			</p>
			<div class="big" title={`${p50.full} ${p50.unit} per ${per.of}, the median of ${lead.count} counted runs. As the Series holds it: ${p50.source}`}>
				<span class="b-head">{head}</span>
				<span class="b-tail">{`${tail}${p50.unit}`}</span>
			</div>
			<Strip />
			<Machines />
			<p class="trail">
				<a href={links.seriesFile(cell.series)} class="tr-stop" title={`Series ${cell.series.id}: every run of this figure, ${oldest.date} to ${newest.date}`}>
					<span class="tr-dot" aria-hidden="true" />
					<span class="tr-text">
						<span class="mono">{cell.series.id}</span>
						<span class="tr-sub">
							<time datetime={oldest.iso}>{oldest.date}</time> – <time datetime={newest.iso}>{newest.date}</time>
						</span>
					</span>
				</a>
				<span class="tr-line" aria-hidden="true" />
				<a href={point.evidence} class="tr-stop" title={`One run’s evidence: run ${point.run}, started ${runAt.date} ${runAt.minute} UTC`}>
					<span class="tr-dot tr-end" aria-hidden="true" />
					<span class="tr-text">
						<span class="mono">
							<time datetime={runAt.iso}>{runAt.date}</time>
						</span>
						<span class="tr-sub">
							<time datetime={runAt.iso}>{runAt.minute}</time>
						</span>
					</span>
				</a>
			</p>
		</figure>
	);
}

// ------------------------------------------------------------------ the page

function Mark() {
	return (
		<svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
			<rect x="2.5" y="2.5" width="19" height="19" rx="4" class="mark-box" />
			<line x1="7" x2="17" y1="8.5" y2="8.5" class="mark-line" />
			<line x1="7" x2="17" y1="12" y2="12" class="mark-line" />
			<line x1="7" x2="12.5" y1="15.5" y2="15.5" class="mark-accent" />
		</svg>
	);
}

function Way() {
	return (
		<div class="way" data-copy={links.index}>
			{/* one text node, so an address is one word; a zero-width space lets a phone break it after the host */}
			<a class="addr mono" href={links.index}>
				{links.index.replace("https://api.ledgermath.com/", "https://api.ledgermath.com/​")}
			</a>
		</div>
	);
}

export default function Page() {
	return (
		<>
			<main class="stage">
				<div class="wrap">
					<h1 class="name">
						<Mark />
						LedgerMath
					</h1>
					<Traced />
					<Way />
				</div>
			</main>
			<footer class="foot">
				<div class="wrap">
					<a class="notice" href="third-party-notices.txt" aria-label="Font licences" title="Font licences">
						<span aria-hidden="true">©</span>
					</a>
				</div>
			</footer>
		</>
	);
}
