// Design v6, "Instrument panel": every headline figure drawn to exact scale beside the others,
// one small chart per benchmark, the exact figure printed beside each mark. Words are kept to
// labels; the figures, the marks and the links carry the page.
import "./page.css";
import { formatCount, formatMoment, formatUsd, headline, links, machines, snapshot } from "../../data";
import { headTail, padFor } from "./digits";
import { at, instrument, type Instrument, type Scale, width, zeroScale } from "./scale";

const ROW = 24;
const AXIS = 22;

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
				return (
					<g class="mark">
						<line class="track" x1="0" x2="100%" y1={y} y2={y} />
						<rect class="range" x={at(s, m.p5.value)} width={width(s, m.p5.value, m.p95.value)} y={y - 1.5} height="3" />
						<line class="cap" x1={at(s, m.p5.value)} x2={at(s, m.p5.value)} y1={y - 4.5} y2={y + 4.5} />
						<line class="cap" x1={at(s, m.p95.value)} x2={at(s, m.p95.value)} y1={y - 4.5} y2={y + 4.5} />
						<circle class="median" cx={at(s, m.p50.value)} cy={y} r="4.25" />
					</g>
				);
			})}
			<line class="axis" x1="0" x2="100%" y1={base + 0.5} y2={base + 0.5} />
			{s.ticks.map((t) => (
				<line class="tick" x1={at(s, t.value)} x2={at(s, t.value)} y1={base} y2={base + 4} />
			))}
			{/* Every label centred on its own tick, the end ones included: the plot lets them overhang its edges. */}
			{s.ticks.map((t) =>
				t.label === "" ? null : (
					<text class="tl" x={at(s, t.value)} y={base + 16} text-anchor="middle">
						{t.label}
					</text>
				),
			)}
			{s.zoomed ? <path class="break" d={`M -5 ${base + 4} l 3 -8 m 3 8 l 3 -8`} /> : null}
		</svg>
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
	const Y = 22;
	return (
		<svg class="strip" aria-hidden="true" width="100%" height={Y + 8}>
			<line class="lens" x1="0" x2={thin ? mid : lo} y1="0" y2={Y - 6} />
			<line class="lens" x1="100%" x2={thin ? mid : hi} y1="0" y2={Y - 6} />
			<line class="axis" x1="0" x2="100%" y1={Y + 0.5} y2={Y + 0.5} />
			<line class="axis" x1="0.5" x2="0.5" y1={Y - 4} y2={Y + 5} />
			<line class="axis" x1="100%" x2="100%" y1={Y - 4} y2={Y + 5} />
			{thin ? (
				<svg x={mid} y={Y - 6} width="1" height="13" overflow="visible">
					<rect class="window" x="-5" width="10" y="0" height="13" />
				</svg>
			) : (
				<rect class="window" x={lo} width={width(z, props.zoom.lo, props.zoom.hi)} y={Y - 6} height="13" />
			)}
			{props.inst.marks.map((m) => (
				<circle class="median small" cx={at(z, m.p50.value)} cy={Y + 0.5} r="2" />
			))}
		</svg>
	);
}

/** An address that may break only after a slash, never inside a name or a hash; the text is unchanged. */
function Url(props: { text: string }) {
	const parts = props.text.split(/(?<=[^:/]\/)/);
	return (
		<>
			{parts.map((p, i) => (
				<>
					{p}
					{i < parts.length - 1 ? <wbr /> : null}
				</>
			))}
		</>
	);
}

const pad = (i: number) => String(i + 1).padStart(2, "0");

/** Every digit of a figure, the first four significant ones in full ink and the rest lighter. */
function Digits(props: { text: string }) {
	const [head, tail] = headTail(props.text);
	return (
		<>
			<span class="hd">{head}</span>
			{tail ? <span class="tt">{tail}</span> : null}
		</>
	);
}

/** Where a row measures the volume rather than the machine, as the data module's reason for disk_read_io_uring's settings says. */
function limitOf(benchmark: string): string | null {
	const reason = headline.find((r) => r.choice.benchmark === "disk_read_io_uring")?.choice.reason ?? "";
	if (!/IOPS limit/.test(reason) || !/throughput limit is what disk_read_sequential/.test(reason)) return null;
	if (benchmark === "disk_read_io_uring") return "The root gp3 volume's IOPS limit: this chart measures the volume, the same kind on all five.";
	if (benchmark === "disk_read_sequential") return "The root gp3 volume's throughput limit: this chart measures the volume, the same kind on all five.";
	return null;
}

function Card(props: { inst: Instrument; index: number }) {
	const inst = props.inst;
	const c = inst.row.choice;
	const zoom = inst.zoom;
	const scale = zoom ?? inst.zero;
	const limit = limitOf(c.benchmark);
	const texts = inst.marks.map((m) => m.p50.short);
	const unit = c.per ? `${inst.unit} / ${c.per.of}` : inst.unit;
	return (
		<article class="card" id={`b-${c.benchmark}`} aria-labelledby={`h-${c.benchmark}`}>
			<header class="card-h">
				<span class="idx">{pad(props.index)}</span>
				<h3 id={`h-${c.benchmark}`}>
					<a href={c.readme} title={`${c.what} ${c.setting}.`}>
						{c.label}
					</a>
				</h3>
				{limit ? (
					<a class="lim" href={c.readme} title={limit}>
						gp3 limit
					</a>
				) : null}
				<span class="unit" title={unit}>
					{inst.unit}
				</span>
			</header>
			<div class="chart" style={`--n:${inst.marks.length}`}>
				<Plot inst={inst} scale={scale} />
				{inst.marks.map((m, i) => (
					<>
						<span class="m" style={`grid-row:${i + 1}`}>
							{m.instanceType}
						</span>
						<a
							class="v"
							href={m.url}
							style={`grid-row:${i + 1};${padFor(m.p50.short, texts)}`}
							title={`${m.instanceType}, ${unit}: median ${m.p50.full}, p5 ${m.p5.full}, p95 ${m.p95.full}, ${m.runs} counted Runs`}
						>
							{m.p50.short}
						</a>
					</>
				))}
				<span class="dir" title={c.lead === "rate" ? "More is faster" : "Less is faster"}>
					{c.lead === "rate" ? "faster →" : "← faster"}
				</span>
				{zoom ? (
					<span class="zoom" title={`The axis starts at ${zoom.ticks[0]!.label} ${inst.unit}. From zero, all five sit inside the box.`}>
						<span class="z0">0</span>
						<Strip inst={inst} zoom={zoom} />
						<span class="zmax">{inst.zero.ticks[inst.zero.ticks.length - 1]!.label}</span>
					</span>
				) : null}
			</div>
		</article>
	);
}

/** Every figure in full: p5, median (a link to its Series file) and p95, and the Runs counted, per machine. */
function Every(props: { instruments: Instrument[] }) {
	return (
		<details class="every" id="digits">
			<summary>
Exact percentiles and Run counts</summary>
			<div class="scroll" tabindex="0" role="region" aria-label="Exact figures">
				<table class="digits">
					<thead>
						<tr>
							<th scope="col">
								<span class="vh">Benchmark</span>
							</th>
							{machines.map((m) => (
								<th scope="col">{m.instanceType}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{props.instruments.map((inst) => {
							const all = inst.marks.flatMap((m) => [m.p5.full, m.p50.full, m.p95.full]);
							const c = inst.row.choice;
							return (
								<tr>
									<th scope="row">
										<a href={`#b-${c.benchmark}`}>{c.label}</a> <span class="u">{c.per ? `${inst.unit} / ${c.per.of}` : inst.unit}</span>
									</th>
									{inst.marks.map((m) => (
										<td>
											<span style={padFor(m.p5.full, all)}>
												<Digits text={m.p5.full} />
											</span>
											<a class="med" href={m.url} style={padFor(m.p50.full, all)}>
												<Digits text={m.p50.full} />
											</a>
											<span style={padFor(m.p95.full, all)}>
												<Digits text={m.p95.full} />
											</span>
											<span class="n">n={m.runs}</span>
										</td>
									))}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</details>
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

/** The four boots a day, UTC. */
const BOOTS = ["04:10", "10:10", "16:10", "22:10"] as const;

export default function Page() {
	const instruments = headline.map(instrument);
	const newest = formatMoment(snapshot.newestRunStartedAt);
	const runs = formatCount(snapshot.runCount).full;
	const failed = formatCount(snapshot.failedRuns).full;
	const prices = machines.map((m) => formatUsd(m.price.usdPerHour, { per: "hour" }));
	const priceScale = zeroScale(Math.max(...prices.map((p) => p.value)), 3);

	// The API example: the first chart's c8i.2xlarge Series, its row of series.json, a few fields kept.
	const hero = instruments[0]!;
	const ex = hero.marks.findIndex((m) => m.instanceType === "c8i.2xlarge");
	const exMark = hero.marks[ex < 0 ? 0 : ex]!;
	const row = hero.row.cells[ex < 0 ? 0 : ex]!.series;
	const d = row.derivations.series_v1;
	// One object of that row, as the file holds it: the figure's percentiles in bytes per second.
	const excerpt = `"bytes_per_second": ${JSON.stringify(d.percentiles.bytes_per_second, null, 2)}`;
	const tokens = [...excerpt.matchAll(/("(?:[^"\\]|\\.)*")(?=\s*:)|("(?:[^"\\]|\\.)*")|(-?\d[\d.eE+-]*)|([^"\d-]+|-)/g)].map(([text, key, str, num]) => ({
		kind: key ? "k" : str ? "s" : num ? "n" : "",
		text,
	}));

	const agentPrompt = `LedgerMath measures ${machines.length} AWS EC2 machine types in ${snapshot.region}, ${headline.length} benchmarks each, four times a day, and publishes the figures with AWS's On-Demand prices as static JSON. Start at ${links.index}. ${links.seriesList} lists every Series with its p5, p50 and p95. Prices: ${links.prices}. Cite each figure's Series file (${links.seriesFilePattern}), which lists every Run behind it with a link to its evidence. Do not state a figure the API does not give.`;

	return (
		<>
			<header class="top">
				<div class="wrap top-in">
					<a class="brand" href="#top" aria-label="LedgerMath, top of the page">
						<Mark />
						<span>LedgerMath</span>
					</a>
					<nav aria-label="On this page">
						<a href="#charts">Charts</a>
						<a href="#machines">Machines</a>
						<a href="#api">API</a>
					</nav>
				</div>
			</header>

			<main id="top">
				<section class="hero wrap" aria-labelledby="h1">
					<h1 id="h1">Five AWS machine types, measured four times a day, every figure with its evidence.</h1>
					<div class="hero-r">
						<p class="lede">{headline.length} benchmarks on each freshly booted machine, published with AWS's prices as a static JSON API for AI agents.</p>
						<div class="cmd">
							<span class="prompt" aria-hidden="true">$</span>
							<code data-copy tabindex="0">
								curl <Url text={links.index} />
							</code>
						</div>
					</div>
				</section>

				<section class="facts" aria-labelledby="h-fresh">
					<div class="wrap">
						<h2 id="h-fresh" class="vh">Freshness and provenance</h2>
						<dl class="ro">
							<div>
								<dt>Newest Run</dt>
								<dd>
									<time datetime={newest.iso} title={newest.full}>
										<b>{newest.minute}</b> UTC {newest.date}
									</time>
								</dd>
							</div>
							<div class="boots">
								<dt>Boots, UTC</dt>
								<dd>{BOOTS.join(" ")}</dd>
							</div>
							<div>
								<dt>Runs</dt>
								<dd>
									<a href={links.seriesList} title="Every Series, each listing its Runs">
										<b>{runs}</b>
									</a>{" "}
									{failed} failed
								</dd>
							</div>
							<div>
								<dt>Region</dt>
								<dd>
									<b>{snapshot.region}</b>
								</dd>
							</div>
							<div>
								<dt>Prices</dt>
								<dd>
									<a href={links.prices}>{snapshot.priceDate}</a>
								</dd>
							</div>
							<div>
								<dt>Methods</dt>
								<dd>
									{snapshot.methods.map((m, i) => (
										<>
											{i > 0 ? " " : ""}
											<a href={links.docs}>
												{m.name} v{m.version}
											</a>
										</>
									))}
								</dd>
							</div>
						</dl>
					</div>
				</section>

				<section class="wrap block" id="charts" aria-labelledby="h-charts">
					<div class="block-head">
						<h2 id="h-charts">
							{headline.length} benchmarks <span class="x">×</span> {machines.length} machines
						</h2>
						<p class="key">
							<span>
								<svg width="14" height="12" aria-hidden="true">
									<circle class="median" cx="7" cy="6" r="4.25" />
								</svg>
								median
							</span>
							<span>
								<svg width="26" height="12" aria-hidden="true">
									<rect class="range" x="2" y="4.5" width="22" height="3" />
									<line class="cap" x1="2" x2="2" y1="1.5" y2="10.5" />
									<line class="cap" x1="24" x2="24" y1="1.5" y2="10.5" />
								</svg>
								p5–p95
							</span>
							<span>
								<svg width="16" height="12" aria-hidden="true">
									<path class="break" d="M 3 11 l 3 -9 m 3 9 l 3 -9" />
								</svg>
								axis not from 0
							</span>
						</p>
					</div>
					<Every instruments={instruments} />
					<div class="grid">
						<article class="card price" id="machines" aria-labelledby="h-machines">
							<header class="card-h">
								<span class="idx">$</span>
								<h3 id="h-machines">
									<a href={links.prices}>Machines, On-Demand</a>
								</h3>
							</header>
							<table class="mt">
								<thead>
									<tr>
										<th scope="col">
											<span class="vh">Machine</span>
										</th>
										<th scope="col">vCPU</th>
										<th scope="col">GiB</th>
										<th scope="col">$ / hour</th>
										<th scope="col" class="pb">
											<span class="vh">Price drawn to scale</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{machines.map((m, i) => (
										<tr>
											<th scope="row" title={m.processor}>
												{m.instanceType}
											</th>
											<td>{m.vcpu}</td>
											<td>{m.memory.replace(/ GiB$/, "")}</td>
											<td class="pc" title={`${m.price.description} · ${m.price.path.pointer}`}>
												<span style={padFor(prices[i]!.full, prices.map((p) => p.full))}>${prices[i]!.full}</span>
											</td>
											<td class="pb">
												<svg class="pbar" aria-hidden="true" width="100%" height="10">
													<rect class="bar" x="0" y="2" width={width(priceScale, 0, prices[i]!.value)} height="6" />
												</svg>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</article>
						{instruments.map((inst, i) => (
							<Card inst={inst} index={i} />
						))}
					</div>
				</section>

				<section class="band" id="api" aria-labelledby="h-api">
					<div class="wrap api">
						<div class="api-l">
							<div class="api-h">
								<h2 id="h-api">The API</h2>
								<a href={links.docs}>Docs</a>
							</div>
							<p>Static JSON. Each figure links to its Series file: every Run, with its evidence.</p>
							<p class="schemas">
								<span class="lbl">Schemas</span>
								{links.schemas.map((s) => (
									<a href={s.url}>
										<code>{s.name}</code>
									</a>
								))}
							</p>
							<details class="agent" id="agent">
								<summary>Prompt for your agent</summary>
								<p data-copy tabindex="0">
									{agentPrompt}
								</p>
							</details>
						</div>
						<div class="term" role="group" aria-label="Commands">
							<ul class="cmds">
								<li>
									<p class="c"># every Series, with p5, p50, p95</p>
									<div class="line">
										<code data-copy tabindex="0">
											curl <Url text={links.seriesList} />
										</code>
									</div>
									<figure class="sample">
										<figcaption>
											<a href={`#b-${hero.row.choice.benchmark}`}>
												{pad(0)} {exMark.instanceType} <b>{exMark.p50.short}</b> {hero.unit}
											</a>
										</figcaption>
										<pre tabindex="0" role="region" aria-label={`From series.json: ${row.benchmark} on ${row.instance_type}`}>
											<code>{tokens.map((t) => (t.kind === "" ? t.text : <span class={t.kind}>{t.text}</span>))}</code>
										</pre>
									</figure>
								</li>
								<li>
									<p class="c">
										# {pad(0)} {exMark.instanceType}: each Run, its evidence
									</p>
									<div class="line">
										<code data-copy tabindex="0">
											curl <Url text={exMark.url} />
										</code>
									</div>
								</li>
								<li>
									<p class="c"># prices, {snapshot.priceDate}</p>
									<div class="line">
										<code data-copy tabindex="0">
											curl <Url text={links.prices} />
										</code>
									</div>
								</li>
							</ul>
						</div>
					</div>
				</section>
			</main>

			<footer class="foot">
				<div class="wrap foot-in">
					<span class="brand small">
						<Mark />
						<span>LedgerMath</span>
					</span>
					<p>
						<a href={links.index}>api.ledgermath.com</a> · <a href={links.docs}>Docs</a> · <a href="third-party-notices.txt">Notices</a>
					</p>
				</div>
			</footer>
		</>
	);
}
