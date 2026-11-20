// Design v8, "Editorial landing", in its tiny forms: the one figure the design traces, set large, and the way in.
// Every figure comes from src/data as the snapshot holds it; see ../README.md. A figure's unit shares its text node
// with its last digits, so the unit is part of the figure, never a word of its own.
import "./tiny.css";
import { type DurationUnit, formatDurationPerUnit, formatMoment, headline, leadFigure, links, seriesFileContents } from "../../data";

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
