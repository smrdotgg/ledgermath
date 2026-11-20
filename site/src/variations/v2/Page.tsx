// Experiment dt-terminal: LedgerMath as a trading-desk terminal that takes itself far too seriously.
// Dense panes, a command line, a function-key bar, colour codes, and a chart drawn by the Datatype
// font in every cell. Every figure comes from ../../data exactly as the snapshot holds it; the
// charts are scaled in code from those figures (zero-based unless the drawing says ZOOMED).
import "./page.css";
import {
	type ByteUnit,
	type DurationUnit,
	durationUnit,
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
	perUnit,
	seriesFileContents,
	type Shown,
	snapshot,
} from "../../data";
import sampleFile from "../../../data/snapshot/v1/series/c2d748916b19.json";

const API_HOST = new URL(links.index).host;
const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const fetched = formatMoment(snapshot.pricesFetchedAt);
/** The four times a day LedgerMath boots its machines, UTC. */
const SCHEDULE = ["04:10", "10:10", "16:10", "22:10"];
const path = (url: string) => decodeURI(new URL(url).pathname);

// ---------------------------------------------------------------- charts

/** A figure on the font's 0–100 scale, against the largest of its chart (zero-based). */
const scale = (value: number, max: number) => Math.max(0, Math.min(100, Math.round((value / max) * 100)));

/** A chart the Datatype font draws: hidden from assistive technology, described by its wrapper. */
function Chart(props: { kind: "b" | "l" | "p"; values: number[]; label: string; class?: string }) {
	return (
		<span class={`dt ${props.class ?? ""}`} role="img" aria-label={props.label}>
			<span aria-hidden="true">{`{${props.kind}:${props.values.join(",")}}`}</span>
		</span>
	);
}

// ---------------------------------------------------------------- figures

type Fig = (value: number) => Shown;
/** One unit per row: the unit its smallest figure would take. Mutex is shown per critical section. */
function rowFigure(row: HeadlineRow): Fig {
	const c = row.choice;
	const least = Math.min(...row.cells.map((cell) => leadFigure(c, cell.series).p50));
	if (c.lead === "rate") {
		const unit = formatRate(least).unit.replace("/s", "") as ByteUnit;
		return (v) => formatRate(v, { unit });
	}
	if (c.per) {
		const per = c.per;
		const unit: DurationUnit = durationUnit(Number(perUnit(least, per.count)));
		return (v) => formatDurationPerUnit(v, per, { unit });
	}
	const unit: DurationUnit = durationUnit(least);
	return (v) => formatDuration(v, { unit });
}

const TICKERS: Record<string, string> = {
	memory_read: "MEMRD",
	memory_read_random: "MEMRND",
	memory_write: "MEMWR",
	compressed_memory_read: "UNPK8",
	hash: "SHA256",
	sort: "SORT",
	syscall: "SYSCL",
	mutex: "MUTEX",
	tcp_echo: "TCPECH",
	disk_read_sequential: "DSKSEQ",
	disk_read_random: "DSKRND",
	disk_read_io_uring: "URING",
	disk_write: "DSKWR",
	http_get: "S3GET",
};

const rows = headline.map((row) => {
	const fig = rowFigure(row);
	const cells = row.cells.map((cell) => {
		const f = leadFigure(row.choice, cell.series);
		return { machine: cell.machine, series: cell.series, f, p5: fig(f.p5), p50: fig(f.p50), p95: fig(f.p95) };
	});
	const maxP95 = Math.max(...cells.map((c) => c.f.p95));
	const maxP50 = Math.max(...cells.map((c) => c.f.p50));
	return { row, fig, cells, maxP95, maxP50, unit: cells[0]!.p50.unit + (row.choice.per ? `/${row.choice.per.of}` : "") };
});

// ---------------------------------------------------------------- the mutex

const mutex = rows.find((r) => r.row.choice.benchmark === "mutex")!;
const per = mutex.row.choice.per!;

type Point = { started_at: string; counted: boolean; time_per_repetition_ns: number | null; run: string };
const points = (sampleFile as unknown as { derivations: { series_v1: { points: Point[] } } }).derivations.series_v1.points;
const sample = seriesFileContents.sample;
const ticks = points.map((p) => ({ ...p, ns: p.time_per_repetition_ns ?? 0, each: formatDurationPerUnit(p.time_per_repetition_ns ?? 0, per, { unit: "ns" }) }));
const tickMax = Math.max(...ticks.map((t) => t.ns));
const tickMin = Math.min(...ticks.map((t) => t.ns));
const zeroBars = ticks.map((t) => scale(t.ns, tickMax));
const zoomed = ticks.map((t) => Math.round(((t.ns - tickMin) / (tickMax - tickMin)) * 100));
const lo = formatDurationPerUnit(tickMin, per, { unit: "ns" });
const hi = formatDurationPerUnit(tickMax, per, { unit: "ns" });

/** Up to 20 values a chart: longer rows are drawn as charts side by side; a sparkline repeats its seam point. */
function chunks(values: number[], overlap: boolean): number[][] {
	const out: number[][] = [];
	for (let i = 0; i < values.length; ) {
		out.push(values.slice(i, i + 20));
		i += overlap ? 19 : 20;
		if (overlap && i >= values.length - 1) break;
	}
	return out;
}

// ---------------------------------------------------------------- the page

const command = `GET ${links.index}`;

function Quote(props: { s: Shown; class?: string }) {
	return (
		<span class={props.class} title={`${props.s.full} ${props.s.unit}`}>
			{props.s.short}
		</span>
	);
}

export default function Page() {
	return (
		<div class="term">
			<header class="top">
				<div class="bar">
					<h1>
						<span class="logo">LEDGERMATH</span> <span class="sub">TERMINAL</span>
					</h1>
					<span class="desk">DESK: NANOSECONDS</span>
					<span class="rec" title="This page is a snapshot. The figures are recorded, not streamed.">
						<span class="dot" aria-hidden="true">●</span> REC
					</span>
					<span class="sess">
						<span class="lbl">SESSIONS UTC</span>
						{SCHEDULE.map((t) => {
							const [h, m] = t.split(":").map(Number) as [number, number];
							return (
								<span class="s">
									<Chart kind="p" values={[scale(h * 60 + m, 24 * 60)]} label={`Clock face at ${t} UTC`} class="pie" />
									{t}
								</span>
							);
						})}
					</span>
				</div>
				<div class="cmd" id="cmd">
					<label class="prompt" for="cmdline">
						LM&gt;
					</label>
					<input id="cmdline" class="cmd-text" readonly value={command} aria-label="The API's table of contents" />
					<a class="go" href={links.index}>
						EXEC
					</a>
				</div>
				<p class="tape">
					<span>AWS {snapshot.region}</span>
					<span>{snapshot.machineCount} MACHINE TYPES</span>
					<span>{snapshot.benchmarkCount} BENCHMARKS</span>
					<span>BOOTED FRESH {SCHEDULE.join(" · ")} UTC</span>
					<span>{formatCount(snapshot.runCount).full} RUNS KEPT WITH EVIDENCE</span>
					<span>STATIC JSON AT {API_HOST}</span>
				</p>
			</header>

			<main class="panes">
				<section class="pane mon" id="monitor" aria-labelledby="mon-h">
					<h2 id="mon-h" class="ph">
						<span class="fk">F2</span> MONITOR <span class="dim">14 INSTRUMENTS × 5 ISSUERS · MID = p50 · BID = p5 · ASK = p95</span>
					</h2>
					<div class="scroll">
						<table>
							<thead>
								<tr>
									<th scope="col" class="ins">INSTR</th>
									<th scope="col" class="cross">X-SECT</th>
									{machines.map((m) => (
										<th scope="col" class="mh">
											<span class="tk">{m.instanceType}</span>
											<span class="cpn" title={m.price.description}>
												{formatUsd(m.price.usdPerHour).full}/HR
											</span>
										</th>
									))}
									<th scope="col" class="chg">CHG</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((r) => (
									<tr>
										<th scope="row" class="ins">
											<a href={r.row.choice.readme} class="sym">
												{TICKERS[r.row.choice.benchmark]}
											</a>
											<span class="nm">{r.row.choice.label}</span>
											<span class="un">{r.unit}</span>
										</th>
										<td class="cross">
											<Chart
												kind="b"
												values={r.cells.map((c) => scale(c.f.p50, r.maxP50))}
												label={`Bars from zero, p50 on each machine type, cheapest first: ${r.cells.map((c) => `${c.machine.instanceType} ${c.p50.short} ${c.p50.unit}`).join("; ")}`}
											/>
										</td>
										{r.cells.map((c) => (
											<td class="q" title={`${c.machine.instanceType} · p5 ${c.p5.full} · p50 ${c.p50.full} · p95 ${c.p95.full} ${c.p50.unit} · ${c.f.count} Runs`}>
												<div class="qq">
													<span class="m">{c.machine.instanceType}</span>
													<span class="mid">{c.p50.short}</span>
													<span class="strip" role="img" aria-label={`Bars from zero: p5, p50, p95`}>
														<span aria-hidden="true" class="dt b5">{`{b:${scale(c.f.p5, r.maxP95)}}`}</span>
														<span aria-hidden="true" class="dt b50">{`{b:${scale(c.f.p50, r.maxP95)}}`}</span>
														<span aria-hidden="true" class="dt b95">{`{b:${scale(c.f.p95, r.maxP95)}}`}</span>
													</span>
													<span class="ba">
														<span class="bid">{c.p5.short}</span> <span class="ask">{c.p95.short}</span>
													</span>
												</div>
											</td>
										))}
										<td class="chg">n/a</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<p class="foot">
						<span class="b5">▮ BID p5</span> <span class="b50">▮ MID p50</span> <span class="b95">▮ ASK p95</span> · BARS FROM ZERO · ROW'S LARGEST = FULL · HOVER A QUOTE FOR EVERY DIGIT · CHG n/a: MEASURED, NOT TRADED
					</p>
				</section>

				<section class="pane des" id="mutex" aria-labelledby="des-h">
					<h2 id="des-h" class="ph">
						<span class="fk">F3</span> MUTEX <span class="dim">DES · SECURITY DESCRIPTION</span>
					</h2>
					<p class="desc">
						{mutex.row.choice.label}. {mutex.row.choice.what} <span class="dim">QUOTED PER {per.of.toUpperCase()}: ONE REPETITION IS {formatCount(per.count).full}.</span>
					</p>
					<table class="full">
						<thead>
							<tr>
								<th scope="col">ISSUER</th>
								<th scope="col">MID p50, ns, EVERY DIGIT</th>
								<th scope="col">VOL</th>
							</tr>
						</thead>
						<tbody>
							{mutex.cells.map((c) => {
								const exact = formatDurationPerUnit(c.f.p50, per, { unit: "ns" });
								return (
									<tr>
										<th scope="row" class="tk">
											{c.machine.instanceType}
										</th>
										<td class="dig">
											<span class="dt one" aria-hidden="true">{`{b:${scale(c.f.p50, mutex.maxP50)}}`}</span>
											{exact.full}
										</td>
										<td class="vol" title="Runs">
											{c.series.runs}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
					<p class="rating">
						RATING <b>N/R</b> <span class="dim">LEDGERMATH MEASURES. IT DOES NOT RATE.</span>
					</p>
				</section>

				<section class="pane intra" id="ticks" aria-labelledby="intra-h">
					<h2 id="intra-h" class="ph">
						<span class="fk">F4</span> INTRADAY <span class="dim">MUTEX · {sample.instanceType} · {sample.points} RUNS</span>
					</h2>
					<div class="chartrow">
						<span class="axis">0</span>
						<span class="dt flat" role="img" aria-label={`Bars from zero, one per Run, ${sample.points} Runs, from ${lo.full} to ${hi.full} ns per critical section`}>
							{chunks(zeroBars, false).map((c) => (
								<span aria-hidden="true">{`{b:${c.join(",")}}`}</span>
							))}
						</span>
						<span class="note">FROM ZERO</span>
					</div>
					<div class="chartrow zoom">
						<span class="axis">
							<span title={`${hi.full} ns`}>{hi.short}</span>
							<span title={`${lo.full} ns`}>{lo.short}</span>
						</span>
						<span class="dt spark" role="img" aria-label={`Zoomed sparkline, one point per Run, between ${lo.full} and ${hi.full} ns per critical section`}>
							{chunks(zoomed, true).map((c) => (
								<span aria-hidden="true">{`{l:${c.join(",")}}`}</span>
							))}
						</span>
						<span class="note stamp">ZOOMED</span>
					</div>
					<p class="foot">
						{formatMoment(ticks[0]!.started_at).date} → {formatMoment(ticks[ticks.length - 1]!.started_at).date} · ns PER CRITICAL SECTION ·{" "}
						<a href={sample.url}>{path(sample.url)}</a>
					</p>
					<details>
						<summary>TICK DATA ({ticks.length})</summary>
						<table class="tickdata">
							<thead>
								<tr>
									<th scope="col">RUN STARTED, UTC</th>
									<th scope="col">ns PER CRITICAL SECTION</th>
								</tr>
							</thead>
							<tbody>
								{ticks.map((t) => (
									<tr>
										<td>{formatMoment(t.started_at).full.replace(" UTC", "")}</td>
										<td class="dig">{t.each.full}</td>
									</tr>
								))}
							</tbody>
						</table>
					</details>
				</section>

				<section class="pane iss" id="issuers" aria-labelledby="iss-h">
					<h2 id="iss-h" class="ph">
						<span class="fk">F6</span> ISSUERS <span class="dim">AWS ON-DEMAND, LINUX, {snapshot.region}</span>
					</h2>
					<table>
						<thead>
							<tr>
								<th scope="col">TYPE</th>
								<th scope="col">vCPU</th>
								<th scope="col">MEM</th>
								<th scope="col">COUPON USD/HR</th>
							</tr>
						</thead>
						<tbody>
							{machines.map((m) => (
								<tr>
									<th scope="row" class="tk">
										{m.instanceType}
										<span class="proc">{m.processor}</span>
									</th>
									<td>{m.vcpu}</td>
									<td>{m.memory}</td>
									<td class="dig">
										<a href={links.prices} title={m.price.path.pointer}>
											{formatUsd(m.price.usdPerHour).full}
										</a>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					<p class="foot">MATURITY: ON DEMAND · PRICE LIST {snapshot.priceDate}</p>
				</section>

				<section class="pane news" id="news" aria-labelledby="news-h">
					<h2 id="news-h" class="ph">
						<span class="fk">F7</span> NEWS <span class="dim">FROM THE DATA</span>
					</h2>
					<ul>
						<li>
							<time datetime={newest.iso}>{newest.minute}</time> NEWEST RUN STARTED {newest.full}
						</li>
						<li>
							<time datetime={snapshot.pricesFetchedAt}>{fetched.minute}</time> AWS PRICE LIST FETCHED
						</li>
						<li>
							<time datetime={oldest.iso}>{oldest.date.slice(5)}</time> OLDEST RUN ON FILE
						</li>
						<li>
							<span class="t">——</span> {formatCount(snapshot.runCount).full} RUNS ON FILE. {formatCount(snapshot.failedRuns).full} FAILED. NONE DROPPED.
						</li>
						<li>
							<span class="t">——</span> MUTEX: NOBODY CONTENDS FOR IT. BY DESIGN.
						</li>
						<li>
							<span class="t">——</span> NO FORECASTS. NO TARGETS. NO RATINGS.
						</li>
					</ul>
				</section>

				<section class="pane api" id="api" aria-labelledby="api-h">
					<h2 id="api-h" class="ph">
						<span class="fk">F8</span> ROUTES <span class="dim">FOR AGENTS · EVERY FIGURE WITH A SOURCE</span>
					</h2>
					<ul class="routes">
						<li>
							<a href={links.index}>{links.index}</a>
						</li>
						<li>
							<a href={links.seriesList}>{path(links.seriesList)}</a> <span class="dim">{snapshot.seriesCount} SERIES</span>
						</li>
						<li>
							<span>{path(links.seriesFilePattern)}</span> <span class="dim">EACH RUN + EVIDENCE</span>
						</li>
						<li>
							<a href={links.prices}>{path(links.prices)}</a> <span class="dim">AWS PRICES</span>
						</li>
					</ul>
				</section>
			</main>

			<footer class="bottom">
				<div class="crawl" aria-hidden="true">
					<div class="belt">
						{[0, 1].map(() => (
							<span class="loop">
								{rows.map((r) => (
									<span class="it">
										<b>{TICKERS[r.row.choice.benchmark]}</b> {r.cells.map((c) => c.p50.short).join(" · ")} <i>{r.unit}</i> <span class="cn">CHG n/a</span>
									</span>
								))}
							</span>
						))}
					</div>
				</div>
				<nav class="fkeys" aria-label="Function keys">
					<a href="#monitor">
						<span>F2</span>MON
					</a>
					<a href="#mutex">
						<span>F3</span>MUTEX
					</a>
					<a href="#ticks">
						<span>F4</span>TICKS
					</a>
					<span class="dead" title="The figures refresh four times a day, at 04:10, 10:10, 16:10 and 22:10 UTC.">
						<span>F5</span>REFRESH 4×/DAY
					</span>
					<a href="#issuers">
						<span>F6</span>ISSUERS
					</a>
					<a href="#news">
						<span>F7</span>NEWS
					</a>
					<a href={links.index}>
						<span>F8</span>API
					</a>
					<a href={links.prices}>
						<span>F9</span>PRICES
					</a>
					<a href="#cmd" class="copy-key">
						<span>F10</span>COPY
					</a>
					<a href={links.docs}>
						<span>F11</span>DOCS
					</a>
					<a href="third-party-notices.txt">
						<span>F12</span>FONT LICENCE
					</a>
				</nav>
			</footer>
		</div>
	);
}
