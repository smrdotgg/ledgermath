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
	const last = s.ticks.length - 1;
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
			{s.ticks.map((t, i) =>
				t.label === "" ? null : (
					<text class={i === 0 ? "tl first" : "tl"} x={at(s, t.value)} y={base + 16} text-anchor={i === 0 ? "start" : i === last ? "end" : "middle"}>
						{t.label}
					</text>
				),
			)}
			{s.zoomed ? <path class="break" d={`M -5 ${base + 4} l 3 -8 m 3 8 l 3 -8`} /> : null}
		</svg>
	);
}

/** From zero, where the zoomed window sits: the whole scale, the window as a box, the five medians as dots. */
function Strip(props: { inst: Instrument; zoom: Scale }) {
	const z = props.inst.zero;
	return (
		<svg class="strip" aria-hidden="true" width="100%" height="14">
			<line class="axis" x1="0" x2="100%" y1="7.5" y2="7.5" />
			<line class="axis" x1="0.5" x2="0.5" y1="3" y2="12" />
			<line class="axis" x1="100%" x2="100%" y1="3" y2="12" />
			<rect class="window" x={at(z, props.zoom.lo)} width={width(z, props.zoom.lo, props.zoom.hi)} y="1" height="13" />
			{props.inst.marks.map((m) => (
				<circle class="median small" cx={at(z, m.p50.value)} cy="7.5" r="2" />
			))}
		</svg>
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
	if (benchmark === "disk_read_io_uring") return "The root gp3 volume's IOPS limit: this row measures the volume, the same kind on all five.";
	if (benchmark === "disk_read_sequential") return "The root gp3 volume's throughput limit: this row measures the volume, the same kind on all five.";
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
				<span class="meta">
					<span class="dir" title={c.lead === "rate" ? "More is faster" : "Less is faster"}>
						{c.lead === "rate" ? "→" : "←"}
					</span>
					<span class="unit">{unit}</span>
				</span>
			</header>
			<div class="chart" style={`--n:${inst.marks.length}`}>
				<Plot inst={inst} scale={scale} />
				{inst.marks.map((m, i) => (
					<>
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
			</div>
			{zoom || limit ? (
				<p class="tags">
					{zoom ? (
						<span class="zoom">
							<span class="tag" title={`The axis starts at ${zoom.ticks[0]!.label} ${inst.unit}. From zero, all five sit inside the box.`}>
								zoomed
							</span>
							<Strip inst={inst} zoom={zoom} />
							<span class="zmax">{inst.zero.ticks[inst.zero.ticks.length - 1]!.label}</span>
						</span>
					) : null}
					{limit ? (
						<a class="tag lim" href={c.readme} title={limit}>
							gp3 volume limit
						</a>
					) : null}
				</p>
			) : null}
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

/** The four boots a day, UTC. */
const BOOTS = ["04:10", "10:10", "16:10", "22:10"] as const;

/** A 24-hour dial with the four boots marked. */
function Clock() {
	const r = 20;
	const pos = (hhmm: string, radius: number) => {
		const [h, m] = hhmm.split(":").map(Number) as [number, number];
		const a = ((h + m / 60) / 24) * 2 * Math.PI - Math.PI / 2;
		return { x: 24 + radius * Math.cos(a), y: 24 + radius * Math.sin(a) };
	};
	return (
		<svg class="clock" viewBox="0 0 48 48" width="44" height="44" aria-hidden="true">
			<circle cx="24" cy="24" r={r} class="clock-ring" />
			{Array.from({ length: 24 }, (_, h) => {
				const a = (h / 24) * 2 * Math.PI - Math.PI / 2;
				const len = h % 6 === 0 ? 4 : 2;
				return <line class="clock-tick" x1={24 + r * Math.cos(a)} y1={24 + r * Math.sin(a)} x2={24 + (r - len) * Math.cos(a)} y2={24 + (r - len) * Math.sin(a)} />;
			})}
			{BOOTS.map((t) => {
				const p = pos(t, r);
				return <circle cx={p.x} cy={p.y} r="3" class="median" />;
			})}
		</svg>
	);
}

/** The charts in three panels, each beside one column of machine names: the machines and four, then five and five. */
const BANDS = [
	[0, 1, 2, 3],
	[4, 5, 6, 7, 8],
	[9, 10, 11, 12, 13],
] as const;

export default function Page() {
	const instruments = headline.map(instrument);
	// One column of names serves every chart in a panel, so every chart must list the machines in the same order.
	const order = machines.map((m) => m.instanceType).join(" ");
	for (const inst of instruments) {
		if (inst.marks.map((m) => m.instanceType).join(" ") !== order) throw new Error(`${inst.row.choice.benchmark}: marks not in the machines' order`);
	}
	if (BANDS.flat().length !== instruments.length) throw new Error("BANDS must place every chart once");
	const newest = formatMoment(snapshot.newestRunStartedAt);
	const runs = formatCount(snapshot.runCount).full;
	const failed = formatCount(snapshot.failedRuns).full;
	const shown = headline.length * machines.length;
	const prices = machines.map((m) => formatUsd(m.price.usdPerHour, { per: "hour" }));
	const priceScale = zeroScale(Math.max(...prices.map((p) => p.value)), 3);

	return (
		<>
			<header class="top">
				<div class="wrap top-in">
					<a class="brand" href="#top" aria-label="LedgerMath, top of the page">
						<Mark />
						<span>LedgerMath</span>
					</a>
				</div>
			</header>

			<main id="top">
				<section class="hero wrap" aria-labelledby="h1">
					<h1 id="h1">Server benchmarks: five AWS machines, measured four times a day.</h1>
					<div class="hero-r">
						<div class="cmd">
							<span class="prompt" aria-hidden="true">$</span>
							<code data-copy tabindex="0">curl {links.index}</code>
						</div>
						<p class="note">Static JSON. Every figure links to its Runs and their evidence.</p>
					</div>
				</section>

				<section class="facts" aria-labelledby="h-fresh">
					<div class="wrap line">
						<h2 id="h-fresh" class="vh">Freshness and provenance</h2>
						<Clock />
						<p>
							<span>
								Newest Run{" "}
								<time datetime={newest.iso} title={`${newest.full}; boots at ${BOOTS.join(", ")} UTC`}>
									<b>{newest.minute}</b> UTC {newest.date}
								</time>
							</span>
							<span>
								<a href={links.seriesList}>
									<b>{runs}</b> Runs
								</a>
								, {failed} failed
							</span>
							<span>
								Prices <a href={links.prices}>{snapshot.priceDate}</a>
							</span>
							<span>
								<a href={links.docs}>Docs</a>
							</span>
						</p>
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
								<span class="dir" aria-hidden="true">← →</span>
								faster
							</span>
							<span>
								<svg width="16" height="12" aria-hidden="true">
									<path class="break" d="M 3 11 l 3 -9 m 3 9 l 3 -9" />
								</svg>
								axis not from 0
							</span>
						</p>
					</div>
					{BANDS.map((band, k) => (
						<div class="mx" role="region" tabindex="0" aria-label={`Benchmarks ${pad(band[0]!)} to ${pad(band[band.length - 1]!)}`}>
							<div class="rail">
								<ul aria-label="Machines, in the order every chart beside them lists them">
									{machines.map((m) => (
										<li title={m.processor}>{m.instanceType}</li>
									))}
								</ul>
							</div>
							{k === 0 ? (
								<article class="card price" id="machines" aria-labelledby="h-machines">
									<header class="card-h">
										<span class="idx">$</span>
										<h3 id="h-machines">
											<a href={links.prices}>On-Demand</a>
										</h3>
									</header>
									<div class="pt">
										{machines.map((m, i) => (
											<span class="pr" style={`grid-row:${i + 1}`} title={`${m.instanceType}: ${m.vcpu} vCPU, ${m.memory}, ${m.price.description}; ${m.price.path.pointer}`}>
												<span>{m.vcpu}</span>
												<span>{m.memory.replace(/ GiB$/, "")}</span>
												<svg class="pbar" aria-hidden="true" width="100%" height="10">
													<rect class="bar" x="0" y="2" width={width(priceScale, 0, prices[i]!.value)} height="6" />
												</svg>
												<b>${prices[i]!.full}</b>
											</span>
										))}
										<span class="pr ph">
											<span>vCPU</span>
											<span>GiB</span>
											<span />
											<span>$ / hour</span>
										</span>
									</div>
								</article>
							) : null}
							{band.map((i) => (
								<Card inst={instruments[i]!} index={i} />
							))}
						</div>
					))}

					<details class="every" id="digits">
						<summary>
							Every digit <span class="dim">· {shown} × p5 · median · p95</span>
						</summary>
						<div class="scroll" tabindex="0" role="region" aria-label="Every digit">
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
									{instruments.map((inst) => {
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
													</td>
												))}
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					</details>
				</section>

			</main>

			<footer class="foot">
				<div class="wrap foot-in">
					<span class="brand small">
						<Mark />
						<span>LedgerMath</span>
					</span>
					<p>
						<a href={links.index}>api.ledgermath.com</a> · <a href="third-party-notices.txt">Notices</a>
					</p>
				</div>
			</footer>
		</>
	);
}
