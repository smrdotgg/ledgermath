import {
	type ByteUnit,
	type DurationUnit,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	type HeadlineRow,
	headline,
	leadFigure,
	links,
	machines,
	type Shown,
	seriesFileContents,
	snapshot,
} from "../../data";
import { seriesFileSample } from "../../data/snapshot";
import "./page.css";

// ---------------------------------------------------------------- the market data, prepared at build time

/** A machine type as a ticker symbol: the instance type in capitals, "xlarge" shortened to XL and "large" to L. */
const symbol = (instanceType: string) => instanceType.toUpperCase().replace("XLARGE", "XL").replace(/\.LARGE$/, ".L");

/** The font's chart syntax. Every value is a whole number from 0 to 100, scaled here in code, never typed. */
const bars = (values: number[]) => `{b:${values.join(",")}}`;
const line = (values: number[]) => `{l:${values.join(",")}}`;
const pie = (value: number) => `{p:${value}}`;
/** From zero: the largest becomes 100, the others in proportion. */
const fromZero = (values: number[]) => {
	const max = Math.max(...values);
	return values.map((v) => Math.round((v / max) * 100));
};
/** Zoomed: the lowest becomes 0 and the highest 100. A chart drawn with this says ZOOMED on itself. */
const zoomed = (values: number[]) => {
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	return values.map((v) => Math.round(((v - lo) / (hi - lo)) * 100));
};

type Cell = { sym: string; type: string; p50: Shown; p5: Shown; p95: Shown; count: number };
type Row = { id: string; row: HeadlineRow; unit: string; cells: Cell[]; chart: string; kind: "rate" | "time" };

/** One headline row, every machine's figure in one unit (the one the smallest figure reads at least 1 in). */
function prepare(row: HeadlineRow): Row {
	const figs = row.cells.map((c) => ({ c, f: leadFigure(row.choice, c.series) }));
	const smallest = Math.min(...figs.map((x) => x.f.p50));
	const per = row.choice.per;
	let fmt: (n: number) => Shown;
	if (row.choice.lead === "rate") {
		const unit = formatRate(smallest).unit.replace("/s", "") as ByteUnit;
		fmt = (n) => formatRate(n, { unit });
	} else if (per) {
		const unit = formatDurationPerUnit(smallest, per).unit as DurationUnit;
		fmt = (n) => formatDurationPerUnit(n, per, { unit });
	} else {
		const unit = formatDuration(smallest).unit as DurationUnit;
		fmt = (n) => formatDuration(n, { unit });
	}
	const cells = figs.map(({ c, f }) => ({ sym: symbol(c.machine.instanceType), type: c.machine.instanceType, p50: fmt(f.p50), p5: fmt(f.p5), p95: fmt(f.p95), count: f.count }));
	return {
		id: `row-${row.choice.benchmark}`,
		row,
		unit: cells[0]!.p50.unit,
		cells,
		chart: bars(fromZero(figs.map((x) => x.f.p50))),
		kind: row.choice.lead,
	};
}

const rows = headline.map(prepare);
const rowOf = (benchmark: string) => rows.find((r) => r.row.choice.benchmark === benchmark)!;

const newest = formatMoment(snapshot.newestRunStartedAt);
const runs = formatCount(snapshot.runCount);
const counted = formatCount(snapshot.countedRuns);
const failed = formatCount(snapshot.failedRuns);

const quotes = machines.map((m) => ({
	m,
	sym: symbol(m.instanceType),
	price: formatUsd(m.price.usdPerHour, { per: "hour" }),
	runs: formatCount(m.series.reduce((total, s) => total + s.runs, 0)),
}));

// The volatility segment: the one Series whose every Run the snapshot keeps (mutex on c8i.2xlarge), its 20 newest Runs.
const sample = seriesFileContents.sample;
const samplePer = rowOf(sample.benchmark).row.choice.per!;
const samplePoints = seriesFileSample.derivations.series_v1.points.filter((p) => p.time_per_repetition_ns !== null).slice(-20);
const sampleNs = samplePoints.map((p) => p.time_per_repetition_ns!);
const each = (ns: number) => formatDurationPerUnit(ns, samplePer, { unit: "ns" });
const sampleHi = each(Math.max(...sampleNs));
const sampleLo = each(Math.min(...sampleNs));
const sampleZoomed = line(zoomed(sampleNs));
const sampleFromZero = line(fromZero(sampleNs));

// ---------------------------------------------------------------- pieces

/** A chart drawn by the font: a picture to a screen reader, with a short text alternative. */
function Chart(props: { text: string; alt: string; class?: string }) {
	return (
		<span class={`chart ${props.class ?? ""}`} role="img" aria-label={props.alt}>
			<span class="dt" aria-hidden="true">
				{props.text}
			</span>
		</span>
	);
}

function Fig(props: { s: Shown; unit?: boolean }) {
	return (
		<span class="fig" title={`${props.s.full} ${props.s.unit}`}>
			{props.s.short}
			{props.unit ? <span class="u"> {props.s.unit}</span> : null}
		</span>
	);
}

function barsAlt(r: Row) {
	return `Bar chart from zero, ${r.row.choice.label}: ${r.cells.map((c) => `${c.type} ${c.p50.short} ${r.unit}`).join(", ")}`;
}

function Panel(props: { href: string; title: string; unit: string; children: unknown; note?: string; class?: string }) {
	return (
		<a class={`screen ${props.class ?? ""}`} href={props.href}>
			<span class="screen-title">{props.title}</span>
			<span class="screen-chart">{props.children as never}</span>
			<span class="screen-unit">{props.unit}</span>
			{props.note ? <span class="screen-note">{props.note}</span> : null}
		</a>
	);
}

function CrawlItems() {
	const priceItem = (
		<li class="crawl-item">
			<span class="crawl-head">PRICES · USD/hour · AWS On-Demand</span>
			{quotes.map((q) => (
				<span class="crawl-q">
					<b>{q.sym}</b> {q.price.full}
				</span>
			))}
		</li>
	);
	return (
		<>
			<li class="crawl-item crawl-brand">LEDGERMATH</li>
			{rows.map((r, i) => (
				<>
					<li class="crawl-item">
						<span class="crawl-head">
							{r.row.choice.label} <span class="crawl-unit">{r.unit}</span>
						</span>
						<span class="dt crawl-chart">{r.chart}</span>
						{r.cells.map((c) => (
							<span class="crawl-q">
								<b>{c.sym}</b> {c.p50.short}
							</span>
						))}
					</li>
					{i === 3 ? priceItem : null}
					{i === 7 ? <li class="crawl-item crawl-gag">CHANGE SINCE YESTERDAY: not a number we have</li> : null}
					{i === 10 ? <li class="crawl-item crawl-gag">WEATHER IN {snapshot.region.toUpperCase()}: not measured</li> : null}
				</>
			))}
			<li class="crawl-item crawl-gag">
				{runs.full} RUNS · {failed.full} FAILED · api.ledgermath.com
			</li>
		</>
	);
}

// ---------------------------------------------------------------- the page

export default function Page() {
	const memory = rowOf("memory_read");
	const syscall = rowOf("syscall");
	const uring = rowOf("disk_read_io_uring");
	return (
		<>
			<header class="topbar">
				<div class="bug">
					<span class="bug-mark" aria-hidden="true">
						LM
					</span>
					<span class="bug-name">LedgerMath</span>
				</div>
				<p class="live">
					<span class="live-dot" aria-hidden="true" />
					LIVE<a href="#asterisk">*</a>
					<span class="live-from">from {snapshot.region}</span>
				</p>
				<p class="clock">
					<span class="clock-time" title={newest.full}>
						{newest.second}
						<span class="clock-ns">{newest.full.slice(19, 29)}</span>
					</span>
					<span class="clock-zone">UTC</span>
				</p>
			</header>

			<main>
				<section class="studio" aria-labelledby="headline">
					<div class="wall">
						<Panel href={`#${memory.id}`} title="Read memory" unit={`${memory.unit} · from zero`}>
							<Chart text={memory.chart} alt={barsAlt(memory)} />
						</Panel>
						<div class="screen screen-logo">
							<span class="show-name">
								The Opening <b>Boot</b>
							</span>
							<span class="show-sub">14 benchmarks · 5 machines · fresh boots</span>
						</div>
						<Panel href={`#${syscall.id}`} title="System call" unit={`${syscall.unit} · from zero`}>
							<Chart text={syscall.chart} alt={barsAlt(syscall)} />
						</Panel>
						<Panel class="screen-wide" href="#volatility" title={`Mutex · ${sample.instanceType} · 20 newest Runs`} unit={`ns per ${samplePer.of}`} note="ZOOMED">
							<Chart class="hot" text={sampleZoomed} alt={`Sparkline, zoomed between ${sampleLo.short} and ${sampleHi.short} ns: mutex on ${sample.instanceType}, its 20 newest Runs`} />
						</Panel>
						<Panel href="#tune-in" title="Runs" unit={`${counted.full} counted · ${failed.full} failed`}>
							<Chart text={pie(Math.round((snapshot.countedRuns / snapshot.runCount) * 100))} alt={`Pie: ${counted.full} of ${runs.full} Runs counted`} />
							<Chart class="pie-empty" text={pie(Math.round((snapshot.failedRuns / snapshot.runCount) * 100))} alt={`Pie: ${failed.full} of ${runs.full} Runs failed`} />
						</Panel>
						<Panel class="screen-extra" href={`#${uring.id}`} title="4 KiB reads ×64" unit={`${uring.unit} · from zero`}>
							<Chart text={uring.chart} alt={barsAlt(uring)} />
						</Panel>
					</div>

					<div class="set" aria-hidden="true">
						<svg class="chair" viewBox="0 0 200 220" role="presentation">
							<rect x="52" y="6" width="96" height="30" rx="14" class="chair-head" />
							<rect x="40" y="40" width="120" height="120" rx="26" class="chair-back" />
							<rect x="58" y="56" width="84" height="88" rx="16" class="chair-seam" />
							<rect x="18" y="118" width="26" height="62" rx="10" class="chair-arm" />
							<rect x="156" y="118" width="26" height="62" rx="10" class="chair-arm" />
							<rect x="34" y="156" width="132" height="34" rx="14" class="chair-seat" />
							<rect x="94" y="190" width="12" height="30" class="chair-stem" />
						</svg>
						<span class="nameplate">
							ANCHOR: <i>none</i>
						</span>
						<div class="desk">
							<span class="desk-front">LEDGERMATH</span>
						</div>
					</div>

					<div class="lower-third">
						<h1 id="headline">
							<span class="lt-tag">LedgerMath</span> <span class="lt-h">Fresh AWS machines, benchmarked four times a day</span>
						</h1>
						<p class="lt-sub">
							{snapshot.benchmarkCount} benchmarks · {snapshot.machineCount} machine types · {runs.full} Runs, each kept with its evidence
						</p>
						<p class="lt-api">
							<span class="lt-api-label">For agents</span>
							<code>{links.index}</code>
							<button type="button" data-copy={links.index} hidden>
								Copy
							</button>
						</p>
					</div>

					<div class="crawl">
						<span class="crawl-label">MARKETS</span>
						<div class="crawl-window" tabindex={0}>
							<div class="crawl-track">
								<ul class="crawl-list" aria-label="Ticker">
									<CrawlItems />
								</ul>
								<ul class="crawl-list" aria-hidden="true">
									<CrawlItems />
								</ul>
							</div>
						</div>
					</div>
				</section>

				<section class="board" aria-labelledby="board-title">
					<h2 id="board-title" class="slate">
						The big board <span class="slate-sub">p50 of every counted Run · bars from zero</span>
					</h2>
					<div class="board-grid">
						<div class="b-row b-head">
							<span class="b-label">Symbol · last price</span>
							{quotes.map((q) => (
								<span class="b-cell b-sym">
									<b>{q.sym}</b>
									<span class="b-price">${q.price.full}/h</span>
								</span>
							))}
						</div>
						{rows.map((r) => (
							<div class="b-row" id={r.id}>
								<span class="b-label">
									<span class="b-section">{r.row.choice.section}</span>
									<a class="b-name" href={r.row.choice.readme}>
										{r.row.choice.label}
									</a>
									<span class="b-unit">
										{r.unit}
										{r.row.choice.per ? ` per ${r.row.choice.per.of}` : r.kind === "time" ? " each" : ""}
									</span>
								</span>
								<Chart class="b-chart" text={r.chart} alt={barsAlt(r)} />
								{r.cells.map((c) => (
									<span class="b-cell">
										<Fig s={c.p50} />
									</span>
								))}
								<details class="b-exact">
									<summary>exact</summary>
									<p class="b-exact-what">
										{r.row.choice.setting}. {r.row.choice.repetition}
									</p>
									<table aria-label={`${r.row.choice.label}, exact figures in ${r.unit}`}>
										<thead>
											<tr>
												<th scope="col">Machine</th>
												<th scope="col">p5</th>
												<th scope="col">p50</th>
												<th scope="col">p95</th>
												<th scope="col">Runs</th>
											</tr>
										</thead>
										<tbody>
											{r.cells.map((c) => (
												<tr>
													<th scope="row">{c.type}</th>
													<td>{c.p5.full}</td>
													<td>{c.p50.full}</td>
													<td>{c.p95.full}</td>
													<td>{c.count}</td>
												</tr>
											))}
										</tbody>
									</table>
									<p class="b-exact-unit">In {r.unit}.</p>
								</details>
							</div>
						))}
					</div>
				</section>

				<section class="volatility" id="volatility" aria-labelledby="vol-title">
					<h2 id="vol-title" class="slate slate-red">Volatility watch</h2>
					<p class="vol-sub">
						Mutex on {sample.instanceType}, one lock and unlock, its 20 newest Runs. Same data, both screens.
					</p>
					<div class="vol-pair">
						<figure class="vol-screen vol-tv">
							<figcaption class="vol-cap">WILD SWINGS?!</figcaption>
							<span class="vol-axis vol-hi">{sampleHi.short} ns</span>
							<Chart class="vol-chart hot" text={sampleZoomed} alt={`Sparkline zoomed between ${sampleLo.short} and ${sampleHi.short} ns`} />
							<span class="vol-axis vol-lo">{sampleLo.short} ns</span>
							<span class="stamp">ZOOMED</span>
						</figure>
						<figure class="vol-screen vol-zero">
							<figcaption class="vol-cap">FROM ZERO</figcaption>
							<span class="vol-axis vol-hi">{sampleHi.short} ns</span>
							<Chart class="vol-chart" text={sampleFromZero} alt={`The same sparkline from 0 to ${sampleHi.short} ns: a flat line`} />
							<span class="vol-axis vol-lo">0 ns</span>
							<span class="vol-verdict">…no.</span>
						</figure>
					</div>
					<details class="vol-exact">
						<summary>The 20 Runs, exact</summary>
						<ol>
							{samplePoints.map((p) => (
								<li>
									<span>{formatMoment(p.started_at).full}</span> <span>{each(p.time_per_repetition_ns!).full} ns</span>
								</li>
							))}
						</ol>
					</details>
				</section>

				<section class="quotes" aria-labelledby="quotes-title">
					<h2 id="quotes-title" class="slate">Symbol lookup</h2>
					<ul class="quote-list">
						{quotes.map((q) => (
							<li class="quote">
								<span class="q-sym">{q.sym}</span>
								<span class="q-type">{q.m.instanceType}</span>
								<span class="q-price">
									<span class="q-dollar">$</span>
									{q.price.full}
									<span class="q-per">/hour</span>
								</span>
								<span class="q-chg">
									CHG <b>n/a</b>
								</span>
								<span class="q-facts">
									{q.m.vcpu} vCPU · {q.m.memory} · {q.m.processor}
								</span>
								<span class="q-vol">VOL {q.runs.full} Runs</span>
							</li>
						))}
					</ul>
					<p class="quotes-note">
						Prices: AWS On-Demand, Linux, {snapshot.region}, price file of {snapshot.priceDate}. Change since yesterday: not a number we have.
					</p>
				</section>

				<section class="tune-in" id="tune-in" aria-labelledby="tune-title">
					<h2 id="tune-title" class="slate">How to tune in</h2>
					<p class="tune-lead">Static JSON, made for agents. Every figure with its Runs; every Run with its evidence.</p>
					<ul class="channels">
						<li>
							<span class="ch">CH 1</span>
							<a href={links.index}>{links.index}</a>
							<button type="button" data-copy={links.index} hidden>
								Copy
							</button>
						</li>
						<li>
							<span class="ch">CH 2</span>
							<a href={links.seriesList}>{links.seriesList}</a>
						</li>
						<li>
							<span class="ch">CH 3</span>
							<a href={links.prices}>{links.prices}</a>
						</li>
						<li>
							<span class="ch">CH 4</span>
							<a href={links.docs}>{links.docs}</a>
						</li>
					</ul>
					<p class="schedule">
						Boots at <b>04:10</b> <b>10:10</b> <b>16:10</b> <b>22:10</b> UTC
					</p>
					<p class="asterisk" id="asterisk">
						*Not live. Recorded: the newest Run started {newest.full}.
					</p>
				</section>
			</main>

			<footer class="sign-off">
				<p>No anchor. No forecast. No opinions. Just Runs.</p>
				<p class="credits">
					Charts and type: Datatype, by Frank Tisellano · <a href="third-party-notices.txt">licence</a>
				</p>
			</footer>

		</>
	);
}
