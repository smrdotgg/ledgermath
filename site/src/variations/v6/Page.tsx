// Design v6, "Instrument panel": every headline figure drawn to exact scale beside the others,
// one small chart per benchmark, the exact figure printed beside each mark.
import "./page.css";
import type { JSX } from "@solidjs/web";
import {
	formatCount,
	formatMoment,
	benchmarks,
	formatUsd,
	headline,
	links,
	machines,
	seriesFileContents,
	snapshot,
} from "../../data";
import { headTail, padFor } from "./digits";
import { at, instrument, type Instrument, type Mark as InstMark, type Scale, width, zeroScale } from "./scale";

const ROW = 24;
const AXIS = 26;

type DialRow = {
	label: string;
	href?: string;
	kind: "interval" | "bar";
	value: number;
	from?: number;
	to?: number;
	text: string;
	title: string;
	/** Counted Runs behind the figure, printed in the chart's last column. */
	runs?: number;
};

function Plot(props: { rows: DialRow[]; scale: Scale; row?: number; annotate?: { index: number; p5: string; p50: string; p95: string } }) {
	const rowH = props.row ?? ROW;
	const n = props.rows.length;
	const base = n * rowH;
	const s = props.scale;
	const last = s.ticks.length - 1;
	return (
		<svg class="plot" aria-hidden="true" width="100%" height={base + AXIS} style={`grid-row: 1 / span ${n + 1}`}>
			{s.ticks.map((t) => (
				<line class={t.value === 0 ? "grid zero" : "grid"} x1={at(s, t.value)} x2={at(s, t.value)} y1="0" y2={base} />
			))}
			{props.rows.map((r, i) => {
				const y = i * rowH + rowH / 2;
				return (
					<g class="mark">
						<title>{r.title}</title>
						<line class="track" x1="0" x2="100%" y1={y} y2={y} />
						{r.kind === "bar" ? (
							<rect class="bar" x={at(s, s.lo)} width={width(s, s.lo, r.value)} y={y - 5} height="10" />
						) : (
							<>
								<rect class="range" x={at(s, r.from!)} width={width(s, r.from!, r.to!)} y={y - 1.5} height="3" />
								<line class="cap" x1={at(s, r.from!)} x2={at(s, r.from!)} y1={y - 5} y2={y + 5} />
								<line class="cap" x1={at(s, r.to!)} x2={at(s, r.to!)} y1={y - 5} y2={y + 5} />
								<circle class="median" cx={at(s, r.value)} cy={y} r="4.75" />
							</>
						)}
						{props.annotate && props.annotate.index === i ? (
							<>
								<text class="note" x={at(s, r.from!)} dx="2" y={y + 17} text-anchor="end">
									{props.annotate.p5}
								</text>
								<text class="note" x={at(s, r.to!)} dx="-2" y={y + 17} text-anchor="start">
									{props.annotate.p95}
								</text>
								<text class="note strong" x={at(s, r.value)} y={y - 11} text-anchor="middle">
									{props.annotate.p50}
								</text>
							</>
						) : null}
					</g>
				);
			})}
			<line class="axis" x1="0" x2="100%" y1={base + 0.5} y2={base + 0.5} />
			{s.ticks.map((t) => (
				<line class="tick" x1={at(s, t.value)} x2={at(s, t.value)} y1={base} y2={base + 5} />
			))}
			{s.ticks.map((t, i) =>
				t.label === "" ? null : (
				<text class={i === 0 ? "tl first" : "tl"} x={at(s, t.value)} y={base + 18} text-anchor={i === 0 ? "start" : i === last ? "end" : "middle"}>
					{t.label}
				</text>
				),
			)}
			{s.zoomed ? <path class="break" d={`M -5 ${base + 5} l 3 -9 m 3 9 l 3 -9`} /> : null}
		</svg>
	);
}

function Dial(props: {
	rows: DialRow[];
	scale: Scale;
	figCaption: JSX.Element;
	labelCaption?: string;
	size?: "lg";
	annotate?: { index: number; p5: string; p50: string; p95: string };
}) {
	const rowH = props.size === "lg" ? 42 : ROW;
	const runs = props.rows.some((r) => r.runs !== undefined);
	return (
		<div class={`dial${props.size === "lg" ? " lg" : ""}${runs ? " runs" : ""}`}>
			<div class="dial-cap" aria-hidden="true">
				<span class="c-m">{props.labelCaption ?? ""}</span>
				<span class="c-f">{props.figCaption}</span>
				{runs ? <span class="c-n">n</span> : null}
			</div>
			<div class="dial-grid" style={`--n:${props.rows.length};--row:${rowH}px;--axis:${AXIS}px`}>
				<Plot rows={props.rows} scale={props.scale} row={rowH} annotate={props.annotate} />
				{props.rows.map((r, i) => {
					// Right-aligned and padded to the widest fraction, so the five figures line up on the point.
					const style = `grid-row:${i + 1};${padFor(r.text, props.rows.map((x) => x.text))}`;
					return (
						<>
							<span class="m" style={`grid-row:${i + 1}`}>
								{r.label}
							</span>
							{r.href ? (
								<a class="v" href={r.href} title={r.title} style={style}>
									{r.text}
								</a>
							) : (
								<span class="v" title={r.title} style={style}>
									{r.text}
								</span>
							)}
							{r.runs !== undefined ? (
								<span class="n" style={`grid-row:${i + 1}`} title={`${r.runs} counted Runs behind the ${r.label} figure`}>
									{r.runs}
								</span>
							) : null}
						</>
					);
				})}
			</div>
		</div>
	);
}

function intervalRows(inst: Instrument, scale: Scale): DialRow[] {
	return inst.marks.map((m) => ({
		label: m.instanceType,
		href: m.url,
		kind: "interval" as const,
		value: m.p50.value,
		from: m.p5.value,
		to: m.p95.value,
		text: m.p50.short,
		runs: m.runs,
		title: `${m.instanceType}: median ${m.p50.full} ${inst.unit} (5th percentile ${m.p5.full}, 95th ${m.p95.full}) across ${m.runs} counted Runs. As the snapshot holds it: ${m.p50.source}`,
	}));
}

/** JSON text split into tokens for colouring: keys, strings, numbers; the text itself is unchanged. */
function tokens(json: string): { kind: "" | "k" | "s" | "n"; text: string }[] {
	const out: { kind: "" | "k" | "s" | "n"; text: string }[] = [];
	const re = /("(?:[^"\\]|\\.)*")(?=\s*:)|("(?:[^"\\]|\\.)*")|(-?\d[\d.eE+-]*)|([^"\d-]+|-)/g;
	for (const m of json.matchAll(re)) {
		const [text, key, str, num] = m;
		out.push({ kind: key ? "k" : str ? "s" : num ? "n" : "", text });
	}
	return out;
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

/** A figure's 5th percentile, median and 95th percentile and its Run count, every digit, lined up on the point with `all`; low to high, as the charts draw them. */
function Exact(props: { m: InstMark; all: readonly string[]; labels?: boolean }) {
	const m = props.m;
	const lb = (text: string) => (props.labels === false ? <span class="vh">{text} </span> : <span class="lb">{text}</span>);
	return (
		<span class="exact-fig">
			<span class="ln">
				{lb("p5")}
				<span class="nm" style={padFor(m.p5.full, props.all)}>
					<Digits text={m.p5.full} />
				</span>
			</span>
			<span class="ln med">
				{lb("p50")}
				<a class="nm" href={m.url} title={`${m.instanceType}: the Series' file, with each Run's figure and a link to its evidence`} style={padFor(m.p50.full, props.all)}>
					<Digits text={m.p50.full} />
				</a>
			</span>
			<span class="ln">
				{lb("p95")}
				<span class="nm" style={padFor(m.p95.full, props.all)}>
					<Digits text={m.p95.full} />
				</span>
			</span>
			<span class="ln n" title={`${m.runs} counted Runs`}>
				<span class="nm">{m.runs}</span>
			</span>
		</span>
	);
}

const allFigures = (inst: Instrument) => inst.marks.flatMap((m) => [m.p5.full, m.p50.full, m.p95.full]);

/**
 * Where a row measures the volume rather than the machine. The data module says so in the reason for
 * disk_read_io_uring's settings: random 4 KiB reads reach the volume's IOPS limit, and its throughput
 * limit is what disk_read_sequential's row shows. All five machines read the same kind of volume (root
 * EBS gp3); the card says what the row measures, in those words, and draws no conclusion from the
 * figures. When the module stops saying so, the note goes.
 */
function limitOf(benchmark: string): string | null {
	const reason = headline.find((r) => r.choice.benchmark === "disk_read_io_uring")?.choice.reason ?? "";
	if (!/IOPS limit/.test(reason) || !/throughput limit is what disk_read_sequential/.test(reason)) return null;
	if (benchmark === "disk_read_io_uring") return "64 reads in flight reach the root gp3 volume's IOPS limit: this row measures the volume, the same on all five.";
	if (benchmark === "disk_read_sequential") return "The root gp3 volume's throughput limit: this row measures the volume, the same on all five.";
	return null;
}

/** Every headline setting ends in ", static build": said once above the charts, not on each one. */
const STATIC = ", static build";
const allStatic = headline.every((r) => r.choice.setting.endsWith(STATIC));
const settingText = (s: string) => (allStatic ? s.slice(0, -STATIC.length) : s);

function InstrumentCard(props: { inst: Instrument; index: number }) {
	const inst = props.inst;
	const c = inst.row.choice;
	const zoom = inst.zoom;
	const limit = limitOf(c.benchmark);
	const scale = zoom ?? inst.zero;
	return (
		<article class={zoom ? "inst zoomed" : "inst"} id={`b-${c.benchmark}`} aria-labelledby={`h-${c.benchmark}`}>
			<div class="inst-top">
				<span class="idx">{pad(props.index)}</span>
				<span class="sec">{c.section}</span>
				<span class="kind" title={c.lead === "rate" ? "More is faster" : "Less is faster"}>
					{c.lead === "rate" ? "faster →" : "← faster"}
				</span>
			</div>
			<h3 id={`h-${c.benchmark}`}>
				<a href={c.readme}>{c.label}</a>
			</h3>
			<p class="what">{c.what}</p>
			<p class="set">{settingText(c.setting)}</p>
			{zoom || limit ? (
				<div class="context">
					{limit ? (
						<p class="limit-note">
							<span class="badge lim">Volume limit</span> {limit}
						</p>
					) : null}
					{zoom ? (
						<>
							<p class="zoom-note">
								<span class="badge">Zoomed</span> Axis from {zoom.ticks[0]!.label}. The whole scale:
							</p>
							<div class="strip-grid">
								<span class="m">from 0</span>
								<svg class="strip" aria-hidden="true" width="100%" height="20">
									<line class="axis" x1="0" x2="100%" y1="10.5" y2="10.5" />
									<line class="axis" x1="0.5" x2="0.5" y1="6" y2="15" />
									<line class="axis" x1="100%" x2="100%" y1="6" y2="15" />
									<rect class="window" x={at(inst.zero, zoom.lo)} width={width(inst.zero, zoom.lo, zoom.hi)} y="3" height="15" />
									{inst.marks.map((m) => (
										<circle class="median small" cx={at(inst.zero, m.p50.value)} cy="10.5" r="2.5" />
									))}
								</svg>
								<span class="v dimv">
									{inst.zero.ticks[inst.zero.ticks.length - 1]!.label} {inst.unit}
								</span>
							</div>
						</>
					) : null}
				</div>
			) : (
				<div class="context empty" />
			)}
			<Dial rows={intervalRows(inst, scale)} scale={scale} figCaption={c.per ? `${inst.unit} / ${c.per.of}` : inst.unit} />
		</article>
	);
}

function PriceCard() {
	const prices = machines.map((m) => formatUsd(m.price.usdPerHour, { per: "hour" }));
	const scale = zeroScale(Math.max(...prices.map((p) => p.value)), 3);
	const rows: DialRow[] = machines.map((m, i) => ({
		label: m.instanceType,
		kind: "bar",
		value: prices[i]!.value,
		text: `$${prices[i]!.full}`,
		title: `${m.price.description} (as the price file writes it: ${m.price.usdPerHour} USD per hour)`,
	}));
	return (
		<article class="inst key" id="prices" aria-labelledby="h-prices">
			<div class="inst-top">
				<span class="idx">00</span>
				<span class="sec">Machines</span>
				<span class="kind">{snapshot.region}</span>
			</div>
			<h3 id="h-prices">
				<a href={links.prices}>Hourly On-Demand price</a>
			</h3>
			<p class="what">AWS's Linux price, copied {snapshot.priceDate}. Every chart lists the machines in this order, cheapest first.</p>
			<p class="set">
				<a href="#machines">Each machine's specification and price source</a>
			</p>
			<div class="context empty" />
			<Dial rows={rows} scale={scale} figCaption="$ / hour" />
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

function ScheduleDial() {
	const times = BOOTS;
	const r = 46;
	const pos = (hhmm: string, radius: number) => {
		const [h, m] = hhmm.split(":").map(Number) as [number, number];
		const a = ((h + m / 60) / 24) * 2 * Math.PI - Math.PI / 2;
		return { x: 60 + radius * Math.cos(a), y: 60 + radius * Math.sin(a) };
	};
	const hours = Array.from({ length: 24 }, (_, h) => h);
	return (
		<svg class="clock" viewBox="-14 -14 148 148" width="148" height="148" role="img" aria-label="A 24-hour dial with the four boots marked: 04:10, 10:10, 16:10 and 22:10 UTC">
			<circle cx="60" cy="60" r={r} class="clock-ring" />
			{hours.map((h) => {
				const a = (h / 24) * 2 * Math.PI - Math.PI / 2;
				const len = h % 6 === 0 ? 6 : 3;
				return <line class="clock-tick" x1={60 + r * Math.cos(a)} y1={60 + r * Math.sin(a)} x2={60 + (r - len) * Math.cos(a)} y2={60 + (r - len) * Math.sin(a)} />;
			})}
			{["00", "06", "12", "18"].map((h, i) => {
				const p = pos(`${h}:00`, r - 15);
				return (
					<text class="clock-h" x={p.x} y={p.y} dy="0.35em" text-anchor="middle">
						{h}
					</text>
				);
			})}
			{times.map((t) => {
				const p = pos(t, r);
				const q = pos(t, r + 16);
				return (
					<>
						<circle cx={p.x} cy={p.y} r="4.5" class="median" />
						<text class="clock-t" x={q.x} y={q.y} dy="0.35em" text-anchor="middle">
							{t}
						</text>
					</>
				);
			})}
			<text class="clock-c" x="60" y="57" text-anchor="middle">
				UTC
			</text>
			<text class="clock-c2" x="60" y="70" text-anchor="middle">
				4 boots
			</text>
		</svg>
	);
}

/**
 * The definition of "counted", one long sentence in the API's own words, set as a list: the
 * conditions, and the order rules under the last. The words are the API's; only the commas and
 * "and"s between the items go. When the text does not have the expected shape, it is printed whole.
 */
function Counted(props: { text: string }) {
	const text = props.text;
	const m = /^(A Run counts when )(.+?): (.+?)\. (Any other Run .+)$/.exec(text);
	if (!m) return <>{text}</>;
	const [, lead, conditions, rules, rest] = m as unknown as [string, string, string, string, string];
	const items = conditions.split(/, (?:and )?/);
	const ruleItems = rules.split(/, (?:and )?/);
	// Put the sentence back together from the pieces; if it does not come out the same, print it whole.
	const join = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`);
	if (`${lead}${join(items)}: ${join(ruleItems)}. ${rest}` !== text) return <>{text}</>;
	return (
		<>
			{lead.trim()}:
			<ul class="counted">
				{items.map((item, i) =>
					i === items.length - 1 ? (
						<li>
							{item}:
							<ul>
								{ruleItems.map((r) => (
									<li>{r}</li>
								))}
							</ul>
						</li>
					) : (
						<li>{item}</li>
					),
				)}
			</ul>
			{rest}
		</>
	);
}

export default function Page() {
	const instruments = headline.map(instrument);
	const newest = formatMoment(snapshot.newestRunStartedAt);
	const oldest = formatMoment(snapshot.oldestRunStartedAt);
	const runs = formatCount(snapshot.runCount).full;
	const seriesCount = formatCount(snapshot.seriesCount).full;
	const counted = formatCount(snapshot.countedRuns).full;
	const failed = formatCount(snapshot.failedRuns).full;
	const methods = snapshot.methods;
	const shown = headline.length * machines.length;
	// The boot the newest Run followed: the last of the day's four boot times at or before its start.
	const hhmm = newest.iso.slice(11, 16);
	const boot = [...BOOTS].reverse().find((t) => t <= hhmm) ?? BOOTS[BOOTS.length - 1]!;
	const seriesMethod = methods.find((m) => m.key === "series_v1")!;

	// The hero's chart: the first benchmark, with one row's percentiles written out to teach the marks.
	const hero = instruments[0]!;
	const heroScale = hero.zoom ?? hero.zero;
	const spread = hero.marks.map((m) => (m.p95.value - m.p5.value) / (heroScale.hi - heroScale.lo));
	const teach = spread.indexOf(Math.max(...spread));
	const taught = hero.marks[teach]!;
	const exampleSeries = hero.marks[teach]!.url;
	// One row of series.json, written as the API writes it (JSON.stringify), a few fields left out.
	const row = hero.row.cells[teach]!.series;
	const d = row.derivations.series_v1;
	const excerpt = JSON.stringify(
		{
			benchmark: row.benchmark,
			params: row.params,
			build: row.build,
			instance_type: row.instance_type,
			runs: row.runs,
			newest_run_started_at: row.newest_run_started_at,
			derivations: { series_v1: { counted_runs: d.counted_runs, failed_runs: d.failed_runs, percentiles: { bytes_per_second: d.percentiles.bytes_per_second } } },
		},
		null,
		2,
	)
		// Short objects that hold no other object go on one line, so the excerpt reads at a glance.
		.replace(/\{\n\s+([^{}]*?)\n\s*\}/g, (whole: string, body: string) => {
			const line = `{ ${body.split(/,\n\s*/).join(", ")} }`;
			return line.length <= 64 ? line : whole;
		})
		// Closing braces share a line, so the excerpt stays short.
		.replace(/\n\s*\}(?:\n\s*\})+/g, (run: string) => ` ${run.replace(/\s+/g, " ").trim()}`);

	const heroAll = [taught.p5.full, taught.p50.full, taught.p95.full];
	const point = seriesFileContents.point;
	const run = point.example;
	// The schema's words for a field, to the first semicolon: the rest of boot_summary's speaks of where Runs are stored.
	const fieldWords = (name: string) => (point.fields.find((f) => f.name === name)?.what ?? "").split(";")[0]!;
	const sample = seriesFileContents.sample;
	const sampleChoice = instruments.find((inst) => inst.row.choice.benchmark === sample.benchmark)?.row.choice;
	const requestsMethod = methods.find((m) => m.key === "requests_v1");
	const commands = [
		{ comment: "What exists", url: links.index },
		{ comment: "Every Series", url: links.seriesList },
		{ comment: `One Series: ${hero.row.choice.benchmark}, ${taught.instanceType}`, url: exampleSeries },
		{ comment: `Prices, ${snapshot.priceDate}`, url: links.prices },
	];
	// Words to hand an agent: what the API holds and how to cite it, nothing it does not say.
	const agentPrompt: (string | { url: string })[] = [
		`LedgerMath measures ${machines.length} AWS EC2 machine types in ${snapshot.region}, ${headline.length} benchmarks each, four times a day, and publishes the figures with AWS's On-Demand prices as static JSON. Start at `,
		{ url: links.index },
		`: it says what exists and how it is versioned. `,
		{ url: links.seriesList },
		` lists every Series (benchmark, params, build, instance type) with its p5, p50 and p95. Prices for ${snapshot.priceDate}: `,
		{ url: links.prices },
		`. When you use a figure, cite its Series file, `,
		{ url: links.seriesFilePattern },
		`, which lists each Run behind it with a link to its evidence. Do not state a figure the API does not give.`,
	];

	return (
		<>
			<header class="top">
				<div class="wrap top-in">
					<a class="brand" href="#top" aria-label="LedgerMath, top of the page">
						<Mark />
						<span>LedgerMath</span>
					</a>
					<nav aria-label="On this page">
						<a href="#instruments">Instruments</a>
						<a href="#machines">Machines</a>
						<a href="#api">API</a>
						<a href="#method">Method</a>
					</nav>
				</div>
			</header>

			<main id="top">
				<section class="hero wrap" aria-labelledby="h1">
					<div class="hero-copy">
						<p class="eyebrow">Server benchmarks · AWS {snapshot.region}</p>
						<h1 id="h1">Five AWS machines, measured four times a day, every figure with its evidence.</h1>
					</div>
					<div class="hero-more">
						<p class="lede lead">
							The figures, their evidence and AWS's On-Demand prices, as a static JSON API, so that an AI agent can choose infrastructure from measured numbers, with a source for each.
						</p>
						<div class="cmd">
							<span class="prompt" aria-hidden="true">$</span>
							<code data-copy tabindex="0">curl {links.index}</code>
						</div>
						<p class="hero-links">
							<a href="#agent" class="btn">A prompt for your agent</a>
						</p>
					</div>

					<figure class="hero-fig" aria-labelledby="hero-cap">
						<div class="hero-panel">
							<div class="inst-top">
								<span class="idx">01</span>
								<span class="sec">{hero.row.choice.section}</span>
								<span class="kind">How to read the charts</span>
							</div>
							<p class="hero-title" id={`b-${hero.row.choice.benchmark}`}>
								<a href={hero.row.choice.readme}>{hero.row.choice.label}</a>
							</p>
							<Dial
								rows={intervalRows(hero, heroScale)}
								scale={heroScale}
								figCaption={hero.unit}
								size="lg"
								annotate={{ index: teach, p5: `p5 ${taught.p5.short}`, p50: `median ${taught.p50.short}`, p95: `p95 ${taught.p95.short}` }}
							/>
							<div class="hero-read">
								<p class="hr-head">
									<span class="m">{taught.instanceType}</span>
									<span>
										every digit, {hero.unit}, from <strong>{taught.runs} counted Runs</strong>
									</span>
								</p>
								<div class="hr-figs">
									<span class="ln med">
										<span class="lb">median</span>
										<span class="nm" style={padFor(taught.p50.full, heroAll)}>
											<Digits text={taught.p50.full} />
										</span>
									</span>
									<span class="ln">
										<span class="lb">p5</span>
										<span class="nm" style={padFor(taught.p5.full, heroAll)}>
											<Digits text={taught.p5.full} />
										</span>
									</span>
									<span class="ln">
										<span class="lb">p95</span>
										<span class="nm" style={padFor(taught.p95.full, heroAll)}>
											<Digits text={taught.p95.full} />
										</span>
									</span>
								</div>
								<p class="hr-link">
									<a href={exampleSeries}>Its Series file: each Run, and its evidence</a>
								</p>
							</div>
							<ul class="legend">
								<li>
									<svg width="18" height="12" aria-hidden="true">
										<circle class="median" cx="9" cy="6" r="4.75" />
									</svg>
									Median of a Series' counted Runs, printed to four significant digits
								</li>
								<li>
									<span class="lg-n" aria-hidden="true">
										{taught.runs}
									</span>
									n, the counted Runs behind it
								</li>
								<li>
									<svg width="30" height="12" aria-hidden="true">
										<rect class="range" x="2" y="4.5" width="26" height="3" />
										<line class="cap" x1="2" x2="2" y1="1" y2="11" />
										<line class="cap" x1="28" x2="28" y1="1" y2="11" />
									</svg>
									5th to 95th percentile
								</li>
								<li>
									<svg width="18" height="12" aria-hidden="true">
										<line class="axis" x1="2" x2="18" y1="9.5" y2="9.5" />
										<line class="axis" x1="2.5" x2="2.5" y1="3" y2="12" />
									</svg>
									<span>
										Scales start at zero, unless marked <span class="badge">Zoomed</span>
									</span>
								</li>
							</ul>
						</div>
						<figcaption id="hero-cap">
							{hero.row.choice.what} {settingText(hero.row.choice.setting)}.
						</figcaption>
					</figure>
				</section>

				<section class="readouts" aria-labelledby="h-fresh">
					<div class="wrap">
						<h2 id="h-fresh" class="vh">Freshness and provenance</h2>
						<dl class="ro">
							<div class="ro-cell wide">
								<dt>Newest Run started</dt>
								<dd>
									<time datetime={newest.iso}>
										<span class="big">{newest.minute}</span> <span class="unit">UTC</span> <span class="date">{newest.longDate}</span>
									</time>
									<span class="exact">
										{newest.full}, after the {boot} boot
									</span>
								</dd>
							</div>
							<div class="ro-cell">
								<dt>Runs kept</dt>
								<dd>
									<span class="big">{runs}</span>
									<span class="exact">
										<span class="nw">{counted} counted,</span> <span class="nw">{failed} failed</span>
									</span>
								</dd>
							</div>
							<div class="ro-cell">
								<dt>Series</dt>
								<dd>
									<span class="big">{seriesCount}</span>
									<span class="exact">
										{shown} drawn here, all in <a href={links.seriesList}>series.json</a>
									</span>
								</dd>
							</div>
							<div class="ro-cell">
								<dt>Oldest Run started</dt>
								<dd>
									<time datetime={oldest.iso} class="big sm">
										{oldest.date}
									</time>
									<span class="exact">{oldest.full.slice(oldest.date.length + 1)}</span>
								</dd>
							</div>
							<div class="ro-cell">
								<dt>Prices copied</dt>
								<dd>
									<a class="big sm" href={links.prices}>
										{snapshot.priceDate}
									</a>
									<span class="exact">
										AWS On-Demand, <span class="nw">{snapshot.region}</span>
									</span>
								</dd>
							</div>
						</dl>
						<p class="ro-note">
							Methods:{" "}
							{methods.map((m, i) => (
								<>
									{i > 0 ? " and " : ""}
									<a href="#method">
										<code>{m.name}</code> v{m.version}
									</a>
								</>
							))}
							.
						</p>
					</div>
				</section>

				<section class="wrap block" id="instruments" aria-labelledby="h-inst">
					<div class="block-head">
						<h2 id="h-inst">
							The instruments <span class="dim">· {headline.length} benchmarks × {machines.length} machine types</span>
						</h2>
						<p>
							One chart per benchmark, drawn as the key above. Each draws one setting, chosen by a written rule{allStatic ? ", of a static build" : ""}; every setting and build
							is in <a href={links.seriesList}>series.json</a>.
						</p>
					</div>
					<div class="grid">
						<PriceCard />
						{instruments.slice(1).map((inst, i) => (
							<InstrumentCard inst={inst} index={i + 1} />
						))}
					</div>
				</section>

				<section class="wrap block digits-block" aria-labelledby="h-digits">
					<h2 id="h-digits" class="vh">
						Every digit
					</h2>
					<details class="every-all" id="digits">
						<summary>
							Every digit <span class="dim">· {shown} medians with p5, p95 and n, the counted Runs</span>
						</summary>
					<div class="scroll" tabindex="0" role="region" aria-label="Every digit: the headline figures in full">
						<table class="digits">
							<thead>
								<tr>
									<th scope="col">Benchmark</th>
									<td class="lbs" aria-hidden="true" />
									{machines.map((m) => (
										<th scope="col">{m.instanceType}</th>
									))}
								</tr>
							</thead>
							<tbody>
								{instruments.map((inst) => {
									const all = allFigures(inst);
									const c = inst.row.choice;
									return (
										<tr>
											<th scope="row">
												<a href={`#b-${c.benchmark}`}>{c.label}</a>
												<span class="q">{c.per ? `${inst.unit} / ${c.per.of}` : inst.unit}</span>
											</th>
											<td class="lbs" aria-hidden="true">
												<span>p5</span>
												<span class="med">p50</span>
												<span>p95</span>
												<span>n</span>
											</td>
											{inst.marks.map((m) => (
												<td>
													<Exact m={m} all={all} labels={false} />
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

				<section class="wrap block" id="machines" aria-labelledby="h-machines">
					<div class="block-head">
						<h2 id="h-machines">The machines</h2>
						<p>
							Five EC2 instance types in {snapshot.region}, as AWS's price list describes them, priced from <a href={links.prices}>the price file of {snapshot.priceDate}</a>.
						</p>
					</div>
					<div class="scroll mtab-wrap" tabindex="0" role="region" aria-label="Each machine's specification and hourly price">
						<table class="mtab">
							<thead>
								<tr>
									<th scope="col">Machine</th>
									<th scope="col" class="r">
										$ / hour
									</th>
									<th scope="col" class="r">
										vCPU
									</th>
									<th scope="col" class="r">
										Memory
									</th>
									<th scope="col">Processor</th>
									<th scope="col">Clock</th>
									<th scope="col">Storage</th>
									<th scope="col">Network</th>
								</tr>
							</thead>
							<tbody>
								{machines.map((m) => {
									const price = formatUsd(m.price.usdPerHour, { per: "hour" });
									return (
										<tr>
											<th scope="row">
												<span class="m-name">{m.instanceType}</span>
												<span class="m-fam">{m.family}</span>
											</th>
											<td class="r m-price">
												<a href={links.prices} title={`${m.price.description}; ${m.price.path.pointer}`}>
													${price.full}
												</a>
											</td>
											<td class="r">{m.vcpu}</td>
											<td class="r">{m.memory}</td>
											<td>{m.processor}</td>
											<td>{m.clockSpeed}</td>
											<td>{m.storage}</td>
											<td>{m.network}</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</section>

				<section class="api-band" id="api" aria-labelledby="h-api">
					<div class="wrap api">
						<div class="api-copy">
							<p class="eyebrow">For agents and developers</p>
							<h2 id="h-api">The way in: static JSON, one file per question</h2>
							<p>An agent starts at the index, which says what exists and how it is versioned. Each kind of file has a JSON schema.</p>
							<details class="agent" id="agent">
								<summary class="agent-h">A prompt for your agent</summary>
								<p class="agent-t" data-copy tabindex="0">
									{agentPrompt.map((part) => (typeof part === "string" ? part : <Url text={part.url} />))}
								</p>
							</details>
							<p class="quote">“{snapshot.versioning.split(". ")[0]}.”</p>
							<ul class="schemas">
								{links.schemas.map((s) => (
									<li>
										<a href={s.url}>
											<code>{s.name}</code>
										</a>{" "}
										<span>{s.describes}</span>
									</li>
								))}
								<li>
									<a href={links.docs}>The API's documentation</a>
								</li>
							</ul>
							<dl class="carries">
								<div>
									<dt>Settings</dt>
									<dd>Benchmark, params, build, instance type, zone</dd>
								</div>
								<div>
									<dt>Runs</dt>
									<dd>Kept, counted, failed</dd>
								</div>
								<div>
									<dt>Percentiles</dt>
									<dd>
										p5, p50, p95, by <code>{seriesMethod.name}</code> v{seriesMethod.version}
									</dd>
								</div>
								<div>
									<dt>Evidence</dt>
									<dd>Every Run's figure and its Run file, in the Series' file</dd>
								</div>
							</dl>
						</div>
						<div class="term" role="group" aria-label="Commands">
							<div class="term-bar" aria-hidden="true">
								<span />
								<span />
								<span />
								<em>api.ledgermath.com</em>
							</div>
							<ul class="cmds">
								{commands.map((c) => (
									<li>
										<p class="c"># {c.comment}</p>
										<div class="cmd-row">
											<code data-copy tabindex="0">
											curl <Url text={c.url} />
										</code>
										</div>
									</li>
								))}
							</ul>
							<div class="term-out">
								<p class="term-label">
									One row of <code>series.json</code>, some fields left out. Its <code>p50</code> is the {taught.p50.short} {hero.unit} above.
								</p>
								<pre tabindex="0" role="region" aria-label="One row of series.json">
									<code>
										{tokens(excerpt).map((t) => (t.kind === "" ? t.text : <span class={t.kind}>{t.text}</span>))}
									</code>
								</pre>
							</div>
						</div>
					</div>
				</section>

				<section class="wrap block" id="method" aria-labelledby="h-method">
					<div class="block-head">
						<h2 id="h-method">How a figure is made</h2>
						<p>Nothing here is estimated. Each mark goes back through a Method to its Runs, and each Run to its evidence.</p>
					</div>
					<div class="method">
						<ol class="chain">
							<li>
								<span class="step">Boot</span>
								<ScheduleDial />
								<p>A fresh machine of each type, four times a day.</p>
							</li>
							<li>
								<span class="step">Run</span>
								<div class="chain-n">a Run</div>
								<p>Each execution of a benchmark, kept with what it printed and what was recorded about the machine. Failed ones too.</p>
							</li>
							<li>
								<span class="step">Series</span>
								<div class="chain-n">a Series</div>
								<p>The Runs of one benchmark, parameter set, build, instance type and zone.</p>
							</li>
							<li>
								<span class="step">Method</span>
								<div class="chain-n">
									<code>
										{seriesMethod.name} v{seriesMethod.version}
									</code>
								</div>
								<p>Turns a Series' counted Runs into percentiles. A new version is published beside the old.</p>
							</li>
						</ol>

						<div class="onerun">
							<div class="onerun-copy">
								<h3>One Run, as its Series' file holds it</h3>
								<p>
									The first of {sample.points} Runs of {sampleChoice ? <a href={`#b-${sample.benchmark}`}>{sampleChoice.label}</a> : sample.benchmark} on{" "}
									<span class="mono">{sample.instanceType}</span>. Its <code>evidence</code> file names the binary, the streams and the dumps by hash.
								</p>
								<p>
									<a href={sample.url}>The whole Series file</a> · <a href={run.evidence}>This Run's evidence</a>
								</p>
							</div>
							<dl class="fields">
								{point.key.map((k) => {
									const value = run[k as keyof typeof run];
									const text = value === null ? "null" : String(value);
									return (
										<div>
											<dt title={fieldWords(k)}>
												<code>{k}</code>
											</dt>
											<dd>
												{k === "evidence" || k === "boot_summary" ? (
													<a class="val" href={text}>
														{text}
													</a>
												) : (
													<span class="val">{text}</span>
												)}
											</dd>
										</div>
									);
								})}
							</dl>
						</div>

						<div class="defs">
							<h3 class="defs-title">
								Method <code>{seriesMethod.name}</code> v{seriesMethod.version}: which Runs count, and the percentiles
							</h3>
							<details class="defs-more">
								<summary>In the API's own words</summary>
								<dl>
									{(["counted", "percentiles"] as const).map((k) =>
										seriesMethod.definitions[k] ? (
											<div>
												<dt>
													<code>{k}</code>
												</dt>
												<dd>{k === "counted" ? <Counted text={seriesMethod.definitions[k]!} /> : seriesMethod.definitions[k]}</dd>
											</div>
										) : null,
									)}
								</dl>
							</details>
						</div>
					</div>
				</section>
			</main>

			<footer class="foot">
				<div class="wrap foot-in">
					<div class="brand small">
						<Mark />
						<span>LedgerMath</span>
					</div>
					<p>
						<a href={links.index}>api.ledgermath.com</a> · <a href={links.docs}>Documentation</a> · <a href="third-party-notices.txt">Notices</a>
					</p>
				</div>
			</footer>
		</>
	);
}
