// Design v3, form "dt-weather": LedgerMath as the local television weather report for us-east-2.
// Five machine types are five towns on the map; each town's "temperature" is a real median read
// out like a presenter would; the five-day strip looks back at Runs that happened (the data has no
// forecast, and neither does the page); the pressure chart is the hourly price. Every figure comes
// from ../../data exactly as the snapshot holds it. Charts are drawn by the Datatype font, scaled
// in code: comparisons from zero (the largest is 100), the one zoomed sparkline says so on itself.
import "./page.css";
import {
	durationUnit,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	headline,
	leadFigure,
	links,
	machines,
	seriesFileContents,
	snapshot,
	type ByteUnit,
	type DurationUnit,
	type HeadlineRow,
	type Section,
	type Shown,
} from "../../data";
import { seriesFileSample } from "../../data/snapshot";

// ---------------------------------------------------------------- drawing helpers

/** A share of `max`, from zero, as the whole number 0–100 the font draws. */
const share = (value: number, max: number) => Math.max(0, Math.min(100, Math.round((value / max) * 100)));

/** A chart drawn by the font: hidden from assistive technology; the element around it carries the words. */
function Chart(props: { code: string; class?: string }) {
	return (
		<span class={`dt ${props.class ?? ""}`} aria-hidden="true">
			{props.code}
		</span>
	);
}

/**
 * One bar from zero, in a tube: a faint full bar (the scale's top, the largest of the row) with the
 * figure's bar over it. `across` lays it on its side (writing-mode), so it grows left to right.
 */
function Bar(props: { value: number; class?: string; across?: boolean }) {
	return (
		<span class={`bar ${props.across ? "across" : ""} ${props.class ?? ""}`} aria-hidden="true">
			<span class="dt bar-track">{"{b:100}"}</span>
			<span class="dt bar-fill">{`{b:${props.value}}`}</span>
		</span>
	);
}

/** A figure in its short form, with every digit one hover away and for assistive technology. */
function Fig(props: { s: Shown; unit?: boolean }) {
	return (
		<span class="fig" title={`${props.s.full} ${props.s.unit}`}>
			{props.s.short}
			{props.unit === false ? "" : <small> {props.s.unit}</small>}
		</span>
	);
}

// ---------------------------------------------------------------- the presenter's voice

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function wholeWords(n: number): string {
	if (n < 20) return ONES[n]!;
	if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : "");
	if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${wholeWords(n % 100)}` : ""}`;
	return `${wholeWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${wholeWords(n % 1000)}` : ""}`;
}
/** "46.14" read aloud as a presenter reads it: "forty-six point one four". The digits are the figure's, nothing rounded further. */
function spoken(decimal: string): string {
	const [whole = "0", frac] = decimal.split(".");
	const digits = frac ? ` point ${[...frac].map((d) => (d === "0" ? "oh" : ONES[Number(d)])).join(" ")}` : "";
	return wholeWords(Number(whole)) + digits;
}

// ---------------------------------------------------------------- the map: memory_read as the temperature

const mapRow = headline.find((row) => row.choice.benchmark === "memory_read")!;
const mapFigures = mapRow.cells.map((cell) => ({ cell, f: leadFigure(mapRow.choice, cell.series) }));
const mapMax = Math.max(...mapFigures.map(({ f }) => f.p50));
const mapUnit = formatRate(Math.min(...mapFigures.map(({ f }) => f.p50))).unit.replace("/s", "") as ByteUnit;
const mapStart = formatMoment(mapRow.cells.map((c) => c.series.oldest_run_started_at).sort()[0]!);
const mapEnd = formatMoment(mapRow.cells.map((c) => c.series.newest_run_started_at).sort().at(-1)!);

// Where each town sits, in machines' order (cheapest first): desktop x/y and phone x/y, in % of the map.
const PLACES = [
	{ x: 14, y: 62, mx: 32, my: 26 },
	{ x: 34, y: 34, mx: 68, my: 41 },
	{ x: 55, y: 66, mx: 32, my: 56 },
	{ x: 72, y: 34, mx: 68, my: 71 },
	{ x: 86, y: 70, mx: 34, my: 87 },
];
const towns = mapFigures.map(({ cell, f }, i) => {
	const p50 = formatRate(f.p50, { unit: mapUnit });
	const sv = cell.series.derivations.series_v1;
	return {
		name: cell.machine.instanceType,
		p50,
		bar: share(f.p50, mapMax),
		heat: Math.min(4, Math.floor(share(f.p50, mapMax) / 20.0001)),
		runs: cell.series.runs,
		counted: sv.counted_runs,
		failed: sv.failed_runs,
		place: PLACES[i]!,
		pressure: i === 0 ? ("L" as const) : i === machines.length - 1 ? ("H" as const) : undefined,
	};
});
const captions = towns.map((t) => `${spoken(t.p50.short)} in ${t.name}`);

// ---------------------------------------------------------------- the five-day lookback: one Series' Runs

const sample = seriesFileContents.sample;
const sampleRow = headline.flatMap((row) => row.cells.map((cell) => ({ row, cell }))).find(({ cell }) => cell.series.id === sample.id);
const lookChoice = sampleRow?.row.choice ?? headline.find((r) => r.choice.benchmark === sample.benchmark)!.choice;
const per = lookChoice.per;
const runFigure = (ns: number): Shown => (per ? formatDurationPerUnit(ns, per, { unit: "ns" }) : formatDuration(ns));
const points = [...seriesFileSample.derivations.series_v1.points]
	.filter((p) => p.counted && p.time_per_repetition_ns !== null)
	.sort((a, b) => a.started_at.localeCompare(b.started_at));
const dayKeys = [...new Set(points.map((p) => p.started_at.slice(0, 10)))].slice(-5);
const windowPoints = points.filter((p) => dayKeys.includes(p.started_at.slice(0, 10)));
const lowNs = Math.min(...windowPoints.map((p) => p.time_per_repetition_ns!));
const highNs = Math.max(...windowPoints.map((p) => p.time_per_repetition_ns!));
const zoom = (ns: number) => Math.round(((ns - lowNs) / (highNs - lowNs)) * 100);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BOOTS = ["04:10", "10:10", "16:10", "22:10"];
const newest = formatMoment(snapshot.newestRunStartedAt);
const days = dayKeys.map((key) => {
	const date = new Date(`${key}T00:00:00Z`);
	const runs = windowPoints.filter((p) => p.started_at.startsWith(key));
	// Boots of the newest day that come after the snapshot's newest Run: not measured, so not shown.
	const later = key === newest.date ? BOOTS.filter((b) => b > newest.minute) : [];
	return {
		key,
		weekday: WEEKDAYS[date.getUTCDay()]!,
		day: date.getUTCDate(),
		month: MONTHS[date.getUTCMonth()]!,
		runs: runs.map((p) => ({ at: formatMoment(p.started_at).minute, f: runFigure(p.time_per_repetition_ns!), z: zoom(p.time_per_repetition_ns!) })),
		later,
	};
});

// The day after the snapshot's newest Run: the one a forecast would be about.
const tomorrowDate = new Date(Date.parse(`${newest.date}T00:00:00Z`) + 86_400_000);
const tomorrow = { weekday: WEEKDAYS[tomorrowDate.getUTCDay()]!, day: tomorrowDate.getUTCDate(), month: MONTHS[tomorrowDate.getUTCMonth()]! };

// ---------------------------------------------------------------- the pressure chart: the hourly price

const priceMax = Math.max(...machines.map((m) => Number(m.price.usdPerHour)));
const pressure = machines.map((m, i) => ({
	m,
	usd: formatUsd(m.price.usdPerHour, { per: "hour" }),
	bar: share(Number(m.price.usdPerHour), priceMax),
	mark: i === 0 ? "L" : i === machines.length - 1 ? "H" : "",
}));

// ---------------------------------------------------------------- the almanac: all fourteen readings

type Reading = { row: HeadlineRow; unit: string; cells: { name: string; s: Shown; bar: number; url: string }[] };
const readings: Reading[] = headline.map((row) => {
	const figures = row.cells.map((cell) => ({ cell, f: leadFigure(row.choice, cell.series) }));
	const least = Math.min(...figures.map(({ f }) => f.p50));
	const most = Math.max(...figures.map(({ f }) => f.p50));
	const p = row.choice.per;
	let show: (x: number) => Shown;
	if (p) show = (x) => formatDurationPerUnit(x, p, { unit: "ns" });
	else if (row.choice.lead === "rate") {
		const u = formatRate(least).unit.replace("/s", "") as ByteUnit;
		show = (x) => formatRate(x, { unit: u });
	} else {
		const u: DurationUnit = durationUnit(least);
		show = (x) => formatDuration(x, { unit: u });
	}
	const cells = figures.map(({ cell, f }) => ({ name: cell.machine.instanceType, s: show(f.p50), bar: share(f.p50, most), url: cell.series.url }));
	return { row, unit: cells[0]!.s.unit + (p ? ` per ${p.of}` : ""), cells };
});
const WEATHER: Record<Section, string> = {
	Memory: "Temperatures",
	Compute: "Sunshine",
	"Operating system": "Winds",
	Disk: "Precipitation",
	Network: "Visibility",
};
const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];

const runs = formatCount(snapshot.runCount);
const priceDay = formatMoment(`${snapshot.priceDate}T00:00:00Z`);

// ---------------------------------------------------------------- the page

function Crawl() {
	const items = [
		<>
			<b>Weather warnings: none.</b> {formatCount(snapshot.failedRuns).full} failed Runs of {runs.full}
		</>,
		<>Fresh boots at {BOOTS.join(", ")} UTC</>,
		<>
			{snapshot.benchmarkCount} benchmarks × {snapshot.machineCount} machine types · {snapshot.seriesCount} Series
		</>,
		<>Prices: AWS On-Demand, {snapshot.region}, {priceDay.longDate}</>,
		<>Forecasts issued: none</>,
		<>Data feed: api.ledgermath.com</>,
	];
	const line = (hidden: boolean) => (
		<p class="crawl-line" aria-hidden={hidden ? "true" : undefined}>
			{items.map((item) => (
				<span class="crawl-item">{item}</span>
			))}
		</p>
	);
	return (
		<div class="crawl" role="region" aria-label="Ticker">
			<span class="crawl-tag">Bulletin</span>
			<div class="crawl-track">
				<div class="crawl-move">
					{line(false)}
					{line(true)}
				</div>
			</div>
		</div>
	);
}

export default function Page() {
	return (
		<>
			<header class="station">
				<div class="bug">
					<span class="bug-sun dt" aria-hidden="true">
						{"{p:100}"}
					</span>
					<span class="bug-name">LedgerMath</span>
					<span class="bug-weather">Weather</span>
				</div>
				<div class="station-right">
					<span class="onair">
						<span class="dot" aria-hidden="true" /> Measured, not live
					</span>
					<time class="clock" datetime={newest.iso} title={newest.full}>
						{newest.minute} <small>UTC</small> · {WEEKDAYS[newest.value.getUTCDay()]} {newest.value.getUTCDate()} {MONTHS[newest.value.getUTCMonth()]}
					</time>
				</div>
			</header>

			<main>
				<section class="intro" aria-labelledby="title">
					<h1 id="title">
						<span class="kicker">{snapshot.region}</span> Measured weather
					</h1>
					<p class="deck">
						{snapshot.machineCount} AWS machines, booted fresh at {BOOTS.join(", ")} UTC, {snapshot.benchmarkCount} benchmarks each. Every Run kept. <strong>Nothing here is a forecast.</strong>
					</p>
					<div class="tune-in">
						<span class="tune-label">Data feed · JSON</span>
						<pre data-copy={links.index}>
							<code>{links.index}</code>
						</pre>
					</div>
				</section>

				<section class="map-block" aria-labelledby="map-title">
					<h2 id="map-title" class="lower-third">
						<span class="lt-a">Across the Region</span>
						<span class="lt-b">{mapRow.choice.label}</span>
					</h2>
					<figure class="map-fig">
						<div class="map">
						<svg class="land" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
							<rect class="l-field" width="1000" height="600" />
							<path class="l-lake" d="M0 0H1000V95C930 120 860 80 790 105S650 150 560 118 420 70 330 112 160 140 90 110 20 90 0 100Z" />
							<path class="l-shore" d="M0 100C20 90 60 100 90 110S240 150 330 112 470 85 560 118 720 130 790 105 930 120 1000 95" />
							<path class="l-hill" d="M-20 600C80 470 200 440 300 520S420 600 420 600Z" />
							<path class="l-hill" d="M560 600C640 500 760 470 860 520S1020 560 1020 600Z" />
							<path class="l-hill2" d="M180 330C240 280 320 290 360 330S300 370 250 360 150 360 180 330Z" />
							<path class="l-hill2" d="M640 250C700 210 780 220 810 260S740 290 700 285 610 280 640 250Z" />
							<path class="l-river" d="M520 110C500 180 560 220 520 290S440 380 500 450 560 540 520 600" />
							<path class="l-road" d="M0 420C200 400 300 470 500 430S800 380 1000 410" />
							<path class="l-road" d="M300 120C330 260 260 420 330 600" />
						</svg>
						<span class="region-name" aria-hidden="true">
							use2-az3
						</span>
						<ul class="towns">
							{towns.map((t) => (
								<li
									class={`town heat-${t.heat}`}
									style={{ "--x": `${t.place.x}%`, "--y": `${t.place.y}%`, "--mx": `${t.place.mx}%`, "--my": `${t.place.my}%` }}
								>
									{t.pressure ? (
										<span class={`hl hl-${t.pressure}`}>
											<span aria-hidden="true">{t.pressure}</span>
											<span class="sr">{t.pressure === "H" ? "Highest hourly price" : "Lowest hourly price"}</span>
										</span>
									) : null}
									<span class="town-name">
										<span class="sun dt" aria-hidden="true">{`{p:${share(t.counted, t.runs)}}`}</span>
										{t.name}
									</span>
									<span class="tag">
										<Bar value={t.bar} class="thermo" />
										<span class="temp" title={`${t.p50.full} ${t.p50.unit}`}>
											{t.p50.short}
											<small>{t.p50.unit}</small>
										</span>
									</span>
									<span class="sr">
										, {t.counted} of {t.runs} Runs counted
									</span>
								</li>
							))}
						</ul>
						<div class="scale" aria-hidden="true">
							<span>Scale</span>
							<span class="scale-bar" />
							<span>one Availability Zone</span>
						</div>
						</div>
						<figcaption class="cc">
							<span class="cc-mark" aria-hidden="true">
								CC
							</span>
							<span class="sr">The presenter reads: </span>
							{captions.map((c, i) => (
								<span class="cc-line">
									&gt;&gt; {i === 0 ? c.charAt(0).toUpperCase() + c.slice(1) : c}
									{i === 0 ? ` gigabytes a second` : ""}.
								</span>
							))}
						</figcaption>
					</figure>
					<p class="map-key">
						<span>
							Median (p50) of each machine's Runs, {mapStart.value.getUTCDate()}–{mapEnd.value.getUTCDate()} {MONTHS[mapEnd.value.getUTCMonth()]}. Bars from zero.
						</span>
						<span>
							<b class="hl-key">H</b> <b class="hl-key l">L</b> highest and lowest hourly price.
						</span>
						<span>
							<span class="dt key-sun" aria-hidden="true">
								{"{p:100}"}
							</span>{" "}
							Clear skies: {formatCount(snapshot.failedRuns).full} failed Runs of {runs.full}.
						</span>
					</p>
				</section>

				<Crawl />

				<section class="lookback" aria-labelledby="lookback-title">
					<h2 id="lookback-title" class="lower-third">
						<span class="lt-a">
							The 5-day <s>forecast</s> <ins>lookback</ins>
						</span>
						<span class="lt-b">
							{sample.instanceType} · {lookChoice.label}
							{per ? `, one ${per.of}` : ""}
						</span>
					</h2>
					<ol class="days">
						{days.map((d) => (
							<li class="day">
								<span class="day-name">
									{d.weekday} <b>{d.day}</b> {d.month}
								</span>
								<span class="day-icon" role="img" aria-label={`Each Run of the day, zoomed: ${d.runs.map((r) => `${r.at} ${r.f.short} ns`).join(", ")}`}>
									<Chart code={`{l:${d.runs.map((r) => r.z).join(",")}}`} class="spark" />
									<span class="zoom-chip" aria-hidden="true">
										zoomed
									</span>
								</span>
								<ul class="day-runs">
									{d.runs.map((r) => (
										<li>
											<span class="at">{r.at}</span> <Fig s={r.f} unit={false} />
										</li>
									))}
									{d.later.map((b) => (
										<li class="later">
											<span class="at">{b}</span> <span>not yet</span>
										</li>
									))}
								</ul>
							</li>
						))}
						<li class="day tomorrow">
							<span class="day-name">
								{tomorrow.weekday} <b>{tomorrow.day}</b> {tomorrow.month}
							</span>
							<span class="qmark" aria-hidden="true">
								?
							</span>
							<span class="tomorrow-say">No forecast. Ask us once it has happened.</span>
						</li>
					</ol>
					<p class="zoom-note">
						<span class="zoom-tag">Zoomed</span> every line runs from {runFigure(lowNs).short} ns (bottom) to {runFigure(highNs).short} ns (top). One figure per Run.
					</p>
				</section>

				<section class="pressure" aria-labelledby="pressure-title">
					<h2 id="pressure-title" class="lower-third">
						<span class="lt-a">Pressure chart</span>
						<span class="lt-b">
							AWS On-Demand Linux, per hour, {priceDay.longDate}
						</span>
					</h2>
					<ul class="baro">
						{pressure.map((p) => (
							<li class={p.mark ? `mark-${p.mark}` : ""}>
								<span class="baro-mark" aria-hidden="true">
									{p.mark}
								</span>
								<Bar value={p.bar} class="baro-bar" />
								<span class="baro-usd" title={p.m.price.description}>
									${p.usd.full}
								</span>
								<span class="baro-name">{p.m.instanceType}</span>
								<span class="baro-spec">
									{p.m.vcpu} vCPU · {p.m.memory}
								</span>
							</li>
						))}
					</ul>
					<p class="pressure-say">
						High pressure over {pressure.at(-1)!.m.instanceType}. Low pressure over {pressure[0]!.m.instanceType}.
					</p>
				</section>

				<section class="almanac" aria-labelledby="almanac-title">
					<h2 id="almanac-title" class="lower-third">
						<span class="lt-a">The almanac</span>
						<span class="lt-b">All {headline.length} readings · median (p50)</span>
					</h2>
					{SECTIONS.map((section) => (
						<section class="season" aria-labelledby={`s-${section.replace(/\W/g, "")}`}>
							<h3 id={`s-${section.replace(/\W/g, "")}`}>
								{WEATHER[section]} <small>{section}</small>
							</h3>
							<div class="cards">
								{readings
									.filter((r) => r.row.choice.section === section)
									.map((r) => (
										<article class="card">
											<h4>
												<a href={r.row.choice.readme}>{r.row.choice.label}</a>
											</h4>
											<p class="card-unit">{r.unit}</p>
											<ul class="card-rows">
												{r.cells.map((c) => (
													<li>
														<a class="card-name" href={c.url}>
															{c.name}
														</a>
														<Fig s={c.s} unit={false} />
														<Bar value={c.bar} class="mini" across />
													</li>
												))}
											</ul>
										</article>
									))}
							</div>
						</section>
					))}
				</section>

				<section class="feed" aria-labelledby="feed-title">
					<h2 id="feed-title" class="lower-third">
						<span class="lt-a">The data feed</span>
						<span class="lt-b">For you, and for your agent</span>
					</h2>
					<div class="feed-box">
						<pre data-copy={links.index}>
							<code>{links.index}</code>
						</pre>
						<p>Every figure above, each Run behind it with its evidence, and AWS's prices. Static JSON.</p>
						<ul class="feed-links">
							<li>
								<a href={links.seriesList}>All {snapshot.seriesCount} Series</a>
							</li>
							<li>
								<a href={links.prices}>Prices, {snapshot.priceDate}</a>
							</li>
							<li>
								<a href={links.docs}>Documentation</a>
							</li>
						</ul>
					</div>
				</section>
			</main>

			<footer class="credits">
				<p>
					LedgerMath · {runs.full} Runs, {snapshot.seriesCount} Series, newest {newest.full} · charts drawn by the font{" "}
					<a href="third-party-notices.txt">Datatype</a>
				</p>
			</footer>
		</>
	);
}
