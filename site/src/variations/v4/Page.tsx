// Design v4, "Departure board": the home page as a station board. What it is first, then the
// clock (the newest Run, the four daily rounds, the day's price file), then the board itself:
// fourteen rows, five machine types, every figure exact, each with its spread drawn like a
// platform strip. Rendered once at build time; client.ts only adds copy buttons.
import "./page.css";
import {
	type ByteUnit,
	type DurationUnit,
	type HeadlineRow,
	type Section,
	type Shown,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	group,
	headline,
	headlineSeries,
	leadFigure,
	links,
	machines,
	roundSignificant,
	seriesFileContents,
	snapshot,
} from "../../data";

const ROUNDS = ["04:10", "10:10", "16:10", "22:10"] as const;

const SECTION_CODE: Record<Section, string> = {
	Memory: "MEM",
	Compute: "CPU",
	"Operating system": "OS",
	Disk: "DSK",
	Network: "NET",
};
const SECTION_CLASS: Record<Section, string> = {
	Memory: "s-mem",
	Compute: "s-cpu",
	"Operating system": "s-os",
	Disk: "s-dsk",
	Network: "s-net",
};

/** Minutes after midnight UTC, for placing a moment on the 24-hour strip (drawing only). */
function dayPercent(hhmm: string): number {
	const [h, m] = hhmm.split(":").map(Number);
	return ((h! * 60 + m!) / 1440) * 100;
}

function exactTitle(shown: Shown): string {
	return `${shown.full} ${shown.unit} exactly (as the API holds it: ${shown.source})`;
}

/**
 * A curl command whose only break is between the host and the path, so a narrow screen puts
 * "v1/…" on a line of its own instead of breaking inside it. The text copies exactly.
 */
function Curl(props: { href: string }) {
	const cut = props.href.indexOf("/", "https://".length) + 1;
	return (
		<>
			<span class="u-host">curl {props.href.slice(0, cut)}</span>
			<span class="u-path">{props.href.slice(cut)}</span>
		</>
	);
}

/** Split-flap tiles for a short text such as "17:07". */
function Flaps(props: { text: string; class?: string }) {
	return (
		<span class={`flaps ${props.class ?? ""}`} aria-hidden="true">
			{[...props.text].map((ch) =>
				ch === ":" ? (
					<span class="flap-colon">:</span>
				) : (
					<span class="flap">
						<span>{ch}</span>
					</span>
				),
			)}
		</span>
	);
}

function sectionsInOrder() {
	const out: { section: Section; rows: HeadlineRow[] }[] = [];
	for (const row of headline) {
		const last = out[out.length - 1];
		if (last && last.section === row.choice.section) last.rows.push(row);
		else out.push({ section: row.choice.section, rows: [row] });
	}
	return out;
}

/**
 * One board row, prepared for printing: one unit for the whole row (the one its largest figure
 * reads in, so no cell switches unit), and as many significant digits as it takes to tell the
 * row's five figures apart (at least four). Bar lengths are the figures themselves, drawn on a
 * scale that ends at the row's largest 95th percentile: a drawing, not a statistic.
 */
function prepareRow(row: HeadlineRow) {
	const c = row.choice;
	const figs = row.cells.map((cell) => leadFigure(c, cell.series));
	const largest = figs.reduce((a, b) => (b.p50 > a.p50 ? b : a));
	const scaleEnd = Math.max(...figs.map((f) => f.p95));
	const fmt =
		c.lead === "rate"
			? (() => {
					const unit = formatRate(largest.p50).unit.replace("/s", "") as ByteUnit;
					return (n: number, significant = 4) => formatRate(n, { unit, significant });
				})()
			: (() => {
					const unit: DurationUnit = formatDuration(largest.p50).unit as DurationUnit;
					return (n: number, significant = 4) => formatDuration(n, { unit, significant });
				})();
	const fulls = figs.map((f) => fmt(f.p50).full);
	let digits = 4;
	for (; digits < 9; digits++) {
		const shorts = fulls.map((full) => roundSignificant(full, digits));
		const clash = shorts.some((s, i) => shorts.some((t, j) => j > i && s === t && fulls[i] !== fulls[j]));
		if (!clash) break;
	}
	return {
		unit: fmt(largest.p50).unit,
		digits,
		cells: row.cells.map((cell, i) => {
			const f = figs[i]!;
			return {
				cell,
				f,
				p50: fmt(f.p50, digits),
				p5: fmt(f.p5, digits),
				p95: fmt(f.p95, digits),
				at: (n: number) => (n / scaleEnd) * 100,
			};
		}),
	};
}

type PreparedCell = ReturnType<typeof prepareRow>["cells"][number];

/**
 * The key: one real cell of the board (its first), each line labelled. Drawn twice, in the
 * board's corner on wide screens and above the cards on a phone; the board's footnote says the
 * same in prose, so the key itself is hidden from screen readers.
 */
function Key(props: { cell: PreparedCell; code: string; class: string }) {
	const k = props.cell;
	const t = formatMoment(k.cell.series.newest_run_started_at);
	return (
		<span class={`key ${props.class}`} aria-hidden="true">
			<span class="key-title">
				Reading a cell <span class="key-src">{props.code}, {k.cell.machine.instanceType}</span>
			</span>
			<span class="key-grid">
				<span class="key-s key-n">
					<b>{k.p50.short}</b> {k.p50.unit}
				</span>
				<span class="key-l">median, rounded to tell its row apart</span>
				<span class="key-s key-full">{group(k.p50.full, ",", " ")}</span>
				<span class="key-l">every digit the API holds</span>
				<span class="key-s">
					<span class="key-bar">
						<i class="fig-fill" style={{ width: `${k.at(k.f.p50)}%` }} />
						<i class="fig-whisk" style={{ left: `${k.at(k.f.p5)}%`, width: `${k.at(k.f.p95) - k.at(k.f.p5)}%` }} />
					</span>
				</span>
				<span class="key-l">drawn to its row's scale</span>
				<span class="key-s key-range">
					p5–p95 {k.p5.short}–{k.p95.short}
				</span>
				<span class="key-l">5th to 95th percentile of its Runs</span>
				<span class="key-s key-meta">
					{formatCount(k.cell.series.runs).full} Runs · newest {t.minute}
				</span>
				<span class="key-l">Runs; newest Run's start, UTC</span>
			</span>
		</span>
	);
}

export default function Page() {
	const newest = formatMoment(snapshot.newestRunStartedAt);
	const oldest = formatMoment(snapshot.oldestRunStartedAt);
	const fetched = formatMoment(snapshot.pricesFetchedAt);
	const runs = formatCount(snapshot.runCount).full;
	const seriesCount = formatCount(snapshot.seriesCount).full;
	const onBoard = formatCount(headlineSeries.length).full;
	const counted = formatCount(snapshot.countedRuns).full;
	const failed = formatCount(snapshot.failedRuns).full;
	const benchmarksN = formatCount(snapshot.benchmarkCount).full;
	const machinesN = formatCount(snapshot.machineCount).full;
	const seriesV1 = snapshot.methods.find((m) => m.key === "series_v1")!;
	const requestsV1 = snapshot.methods.find((m) => m.key === "requests_v1");
	const sections = sectionsInOrder();
	let rowNumber = 0;

	// The sample Series file the snapshot keeps: which board row and machine it is.
	const sample = seriesFileContents.sample;
	const point = seriesFileContents.point.example;
	const sampleRowIndex = headline.findIndex((r) => r.cells.some((cell) => cell.series.id === sample.id));
	const sampleRow = headline[sampleRowIndex];
	const sampleCode = sampleRow ? `${SECTION_CODE[sampleRow.choice.section]} ${String(sampleRowIndex + 1).padStart(2, "0")}` : "";
	const samplePrepared = sampleRow ? prepareRow(sampleRow).cells.find((p) => p.cell.series.id === sample.id) : undefined;
	const pointStart = formatMoment(point.started_at);
	const pointTime = formatDuration(point.time_per_repetition_ns!);
	const J = (v: unknown) => JSON.stringify(v);
	// The key under the board's head shows the board's own first cell.
	const keyCell = prepareRow(headline[0]!).cells[0]!;
	const keyCode = `${SECTION_CODE[headline[0]!.choice.section]} 01`;
	const rowCode = (benchmark: string) => {
		const i = headline.findIndex((r) => r.choice.benchmark === benchmark);
		return `${SECTION_CODE[headline[i]!.choice.section]} ${String(i + 1).padStart(2, "0")}`;
	};

	return (
		<>
			<a class="skip" href="#board">
				Skip to the board
			</a>
			<header class="band">
				<div class="band-in">
					<a class="brand" href="#top" aria-label="LedgerMath, top of the page">
						<span class="brand-mark" aria-hidden="true">
							<i />
							<i />
							<i />
						</span>
						<span class="brand-name">LedgerMath</span>
					</a>
					<nav aria-label="On this page">
						<a href="#board">Board</a>
						<a href="#machines">Machines</a>
						<a href="#api">API</a>
						<a href="#method">Method</a>
					</nav>
					<span class="band-region">
						AWS <b>{snapshot.region}</b> · all times UTC
					</span>
				</div>
			</header>

			<main id="top">
				{/* ------------------------------------------------ the board's head: what this is, then the clock */}
				<section class="head" aria-labelledby="title">
					<div class="head-in">
						<div class="head-id">
							<p class="kicker">
								<span class="dot" aria-hidden="true" />
								LedgerMath · server benchmarks on AWS
							</p>
							<h1 id="title">
								<span class="h1-a">Fresh AWS machines,</span> <span class="h1-hi">measured four times a day.</span>
							</h1>
							<p class="fresh-line">
								<span class="fresh-label">Newest Run started</span>
								<time datetime={newest.iso} class="fresh-time">
									<Flaps text={newest.minute} class="flaps-sm" />
									<span class="fresh-utc">UTC</span>
									<span class="sr">
										{newest.minute} UTC, {newest.longDate}
									</span>
								</time>
								<span class="fresh-meta" aria-hidden="true">
									{`${newest.longDate} · AWS ${snapshot.region}`}
								</span>
							</p>
							<p class="lede">
								LedgerMath runs {benchmarksN} benchmarks on {machinesN} freshly booted machine types at every round, keeps every Run with its evidence,
								and derives each figure by a published Method. A static JSON API serves it all beside AWS's On-Demand prices, so AI agents can choose
								infrastructure from measured numbers, with a source for each.
							</p>
							<div class="cmd" data-copy-wrap>
								<code data-copy>
									<Curl href={links.index} />
								</code>
							</div>
						</div>

						<div class="panel">
							<div class="clock" role="group" aria-labelledby="clock-label">
								<p class="panel-row clock-head">
									<span class="clock-label" id="clock-label">
										Newest Run started
									</span>
									<span class="panel-status">
										<span class="dot" aria-hidden="true" />
										{`${newest.longDate} · AWS ${snapshot.region}`}
									</span>
								</p>
								<p class="clock-time">
									<time datetime={newest.iso}>
										<Flaps text={newest.minute} />
										<span class="sr">
											{newest.minute} UTC, {newest.longDate}
										</span>
									</time>
									<span class="clock-utc" aria-hidden="true">
										UTC
									</span>
									<span class="clock-full">
										<span class="clock-full-l">to the nanosecond</span>
										{newest.full}
									</span>
								</p>
							</div>

							<div class="rounds" role="group" aria-labelledby="rounds-label">
								<p class="panel-row">
									<span class="panel-label" id="rounds-label">
										Daily rounds, UTC
									</span>
									<span class="panel-note">A freshly booted machine each round · {benchmarksN} benchmarks</span>
								</p>
								<ol class="round-list">
									{ROUNDS.map((t, i) => (
										<li class="round">
											<span class="round-n">Round {i + 1}</span>
											<span class="round-t">{t}</span>
										</li>
									))}
								</ol>
								<div class="strip" aria-hidden="true">
									<div class="strip-track">
										{ROUNDS.map((t) => (
											<span class="strip-round" style={{ left: `${dayPercent(t)}%` }} />
										))}
										<span class="strip-newest" style={{ left: `${dayPercent(newest.minute)}%` }} />
									</div>
								</div>
							</div>

							<dl class="tally">
								<div>
									<dt>Runs kept</dt>
									<dd>{runs}</dd>
								</div>
								<div>
									<dt>Failed Runs</dt>
									<dd>{failed}</dd>
								</div>
								<div>
									<dt>Series in the API</dt>
									<dd>{seriesCount}</dd>
								</div>
								<div>
									<dt>Oldest Run</dt>
									<dd class="tally-date" title={oldest.full}>
										{oldest.date}
									</dd>
								</div>
							</dl>

							<p class="panel-prices">
								<span class="panel-label">Prices</span>
								<span>
									AWS On-Demand, copied {snapshot.priceDate} {fetched.minute} UTC:{" "}
									<a href={links.prices} title={fetched.full}>
										prices/{snapshot.priceDate}.json
									</a>
								</span>
							</p>
						</div>
					</div>
				</section>
				{/* ------------------------------------------------ the board */}
				<section class="board-sec" id="board" aria-labelledby="board-title">
					<div class="sec-head">
						<h2 id="board-title">
							<span class="h2-code">01</span> The board
						</h2>
						<p class="sec-sub">
							{benchmarksN} benchmarks × {machinesN} machine types: {onBoard} of the API's {seriesCount} Series, one setting per benchmark by a written
							rule. The rest are the same benchmarks at other settings: thread counts, object sizes, builds, the instance-store disk. Each figure is the
							median of one Series' counted Runs and links to its file.
						</p>
					</div>

					<div class="board-tools">
						<nav class="jump" aria-label="Board sections">
							{sections.map((g) => (
								<a href={`#b-${SECTION_CLASS[g.section]}`} class={SECTION_CLASS[g.section]}>
									<span class="badge">{SECTION_CODE[g.section]}</span>
									<span class="jump-name">{g.section}</span>
								</a>
							))}
						</nav>
					</div>
					<Key cell={keyCell} code={keyCode} class="key-phone" />

					<div class="board-wrap" role="region" aria-label="The board: headline figures" tabindex="0">
						<table class="board">
							<caption class="sr">
								Headline figures: {benchmarksN} benchmarks on {machinesN} AWS machine types, the median of each Series' counted Runs with its 5th and
								95th percentiles, the time each Series' newest Run started and how many Runs it has.
							</caption>
							<thead>
								<tr>
									<th scope="col" class="col-what">
										<span class="sr">Benchmark</span>
										<Key cell={keyCell} code={keyCode} class="key-head" />
									</th>
									{machines.map((m) => {
										const price = formatUsd(m.price.usdPerHour, { per: "hour" });
										return (
											<th scope="col" class="col-m">
												<span class="col-m-name">{m.instanceType}</span>
												<span class="col-m-spec">
													{m.vcpu} vCPU · {m.memory}
												</span>
												<span class="col-m-price" title={`${m.price.description} (${price.source})`}>
													${price.full}
													<small>/h</small>
												</span>
											</th>
										);
									})}
								</tr>
							</thead>
							{sections.map((g) => (
								<tbody class={SECTION_CLASS[g.section]} id={`b-${SECTION_CLASS[g.section]}`}>
									<tr class="sec-row">
										<th scope="colgroup" colspan={1}>
											<span class="badge">{SECTION_CODE[g.section]}</span>
											{g.section}
										</th>
										{machines.map((m) => (
											<td class="sec-m" aria-hidden="true">
												{m.instanceType}
											</td>
										))}
									</tr>
									{g.section === "Disk" && (
										<tr class="sec-note">
											<td colspan={machines.length + 1}>
												<b>These rows measure the volume as much as the machine.</b> Every disk row uses each machine's root EBS gp3 volume, the same kind of volume on
												all five. Random 4 KiB reads ({rowCode("disk_read_io_uring")}) reach the volume's IOPS limit; its throughput limit is what{" "}
												{rowCode("disk_read_sequential")} shows.
											</td>
										</tr>
									)}
									{g.rows.map((row) => {
										rowNumber += 1;
										const n = String(rowNumber).padStart(2, "0");
										const c = row.choice;
										const p = prepareRow(row);
										return (
											<tr class="row">
												<th scope="row" class="what">
													<span class="what-top">
														<span class="badge">
															{SECTION_CODE[c.section]} {n}
														</span>
														<span class="what-kind">
															{c.lead === "rate" ? "Median rate" : "Median time"} · <span class="what-unit">{p.unit}</span>
														</span>
														<span class={`what-dir ${c.lead === "rate" ? "up" : "down"}`}>
															{c.lead === "rate" ? "higher is faster" : "lower is faster"}
														</span>
													</span>
													<span class="what-label">{c.label}</span>
													<span class="what-desc">{c.what}</span>
													<span class="what-set">
														{c.lead === "time" && (
															<>
																<b>One repetition:</b> {c.repetition.replace(/\.$/, "")} ·{" "}
															</>
														)}
														{c.setting}
													</span>
												</th>
												{p.cells.map(({ cell, f, p50, p5, p95, at }) => {
													const t = formatMoment(cell.series.newest_run_started_at);
													const per = c.per && f.kind === "time" ? formatDurationPerUnit(f.p50, c.per) : undefined;
													return (
														<td class="fig">
															<a href={links.seriesFile(cell.series)} title={exactTitle(p50)}>
																<span class="fig-m" aria-hidden="true">
																	{cell.machine.instanceType}
																</span>
																<span class="fig-main">
																	<span class="fig-n">{p50.short}</span>
																	<span class="fig-u">{p50.unit}</span>
																</span>
																<span class="fig-full">
																	<span class="sr">exactly </span>
																	{group(p50.full, ",", " ")}
																</span>
																{per && (
																	<span class="fig-per" title={`${per.full} ${per.unit} per ${per.per.of}, exactly`}>
																		{per.short} {per.unit} / section
																	</span>
																)}
																<span class="fig-bar" aria-hidden="true">
																	<i class="fig-fill" style={{ width: `${at(f.p50)}%` }} />
																	<i class="fig-whisk" style={{ left: `${at(f.p5)}%`, width: `${at(f.p95) - at(f.p5)}%` }} />
																</span>
																<span class="fig-range" title={`5th percentile ${p5.full} ${p5.unit}, 95th ${p95.full} ${p95.unit}, exactly`}>
																	<span class="fig-range-l" aria-hidden="true">
																		p5–p95{" "}
																	</span>
																	<span class="sr">5th to 95th percentile: </span>
																	{p5.short}–{p95.short}
																</span>
																<span class="fig-meta">
																	{formatCount(cell.series.runs).full} Runs<span aria-hidden="true"> · </span>
																	<span class="sr">, the newest started at </span>
																	<span class="fig-meta-l" aria-hidden="true">
																		newest{" "}
																	</span>
																	<time datetime={t.iso} title={t.full}>
																		{t.minute}
																	</time>
																	<span class="sr"> UTC</span>
																</span>
															</a>
														</td>
													);
												})}
											</tr>
										);
									})}
								</tbody>
							))}
						</table>
					</div>
					<p class="board-foot">
						Each bar is its figure drawn to its own row's scale, which ends at the row's largest 95th percentile; rows are not drawn to one scale. The
						thin line spans the 5th to the 95th percentile of the Series' counted Runs, printed beneath it. “Newest” is the start of the Series' newest
						Run, {newest.date}, UTC.
					</p>
				</section>

				{/* ------------------------------------------------ the machines */}
				<section class="machines-sec" id="machines" aria-labelledby="machines-title">
					<div class="sec-head">
						<h2 id="machines-title">
							<span class="h2-code">02</span> The machines
						</h2>
						<p class="sec-sub">
							{machinesN} instance types in {snapshot.region}, cheapest first. Hourly On-Demand Linux prices from AWS's public price list, copied daily;
							this one on {snapshot.priceDate}, fetched at {fetched.second} UTC.
						</p>
					</div>
					<ol class="gates">
						{machines.map((m, i) => {
							const price = formatUsd(m.price.usdPerHour, { per: "hour" });
							return (
								<li class="gate">
									<span class="gate-n" aria-hidden="true">
										{String.fromCharCode(65 + i)}
									</span>
									<h3 class="gate-name">{m.instanceType}</h3>
									<div class="gate-price" title={price.source}>
										<span class="gate-usd">${price.full}</span>
										<span class="gate-per">per hour</span>
									</div>
									<dl class="gate-spec">
										<div>
											<dt>vCPU</dt>
											<dd>{m.vcpu}</dd>
										</div>
										<div>
											<dt>Memory</dt>
											<dd>{m.memory}</dd>
										</div>
										<div>
											<dt>Processor</dt>
											<dd>{m.processor}</dd>
										</div>
										<div>
											<dt>Storage</dt>
											<dd>{m.storage}</dd>
										</div>
										<div>
											<dt>Network</dt>
											<dd>{m.network}</dd>
										</div>
									</dl>
									<p class="gate-aws">
										AWS's words: “{m.price.description}”
										<span class="gate-ptr" title={`In ${links.prices}, at the JSON Pointer ${m.price.path.pointer}`}>
											SKU <code>{m.price.sku}</code> · rate code <code>{m.price.rateCode.split(".").pop()}</code>
										</span>
									</p>
								</li>
							);
						})}
					</ol>
					<ul class="fleet">
						{machines.map((m, i) => {
							const price = formatUsd(m.price.usdPerHour, { per: "hour" });
							return (
								<li>
									<details>
										<summary>
											<span class="fleet-n" aria-hidden="true">
												{String.fromCharCode(65 + i)}
											</span>
											<span class="fleet-name">{m.instanceType}</span>
											<span class="fleet-spec">
												{m.vcpu} vCPU · {m.memory}
											</span>
											<span class="fleet-usd" title={price.source}>
												${price.full}
												<small> per hour</small>
											</span>
										</summary>
										<dl class="gate-spec fleet-more">
											<div>
												<dt>Processor</dt>
												<dd>{m.processor}</dd>
											</div>
											<div>
												<dt>Storage</dt>
												<dd>{m.storage}</dd>
											</div>
											<div>
												<dt>Network</dt>
												<dd>{m.network}</dd>
											</div>
										</dl>
										<p class="gate-aws">
											AWS's words: “{m.price.description}”
											<span class="gate-ptr">
												SKU <code>{m.price.sku}</code> · rate code <code>{m.price.rateCode.split(".").pop()}</code>
											</span>
											<span class="gate-ptr">
												JSON Pointer <code>{m.price.path.pointer}</code>
											</span>
										</p>
									</details>
								</li>
							);
						})}
					</ul>
					<p class="board-foot">
						Price file: <a href={links.prices}>{links.prices}</a> · each machine names the SKU and rate code its price is read from.
					</p>
				</section>

				{/* ------------------------------------------------ the API */}
				<section class="api-sec" id="api" aria-labelledby="api-title">
					<div class="sec-head">
						<h2 id="api-title">
							<span class="h2-code">03</span> For agents and developers
						</h2>
						<p class="sec-sub">
							Everything on this page is a static JSON file at <b>api.ledgermath.com</b>, made for AI agents that make infrastructure decisions. An
							agent reads the table of contents, takes the Series it needs, and cites each figure by its Series' address, beside the day's AWS prices.
						</p>
					</div>

					<div class="api-grid">
						<div class="api-main">
							<div class="term">
								<p class="term-bar" aria-hidden="true">
									<i />
									<i />
									<i />
									<span>shell</span>
								</p>
								<ol class="term-lines">
									<li data-copy-wrap>
										<span class="term-c"># the table of contents: newest Run, Series, prices, schemas</span>
										<code data-copy>
											<Curl href={links.index} />
										</code>
									</li>
									<li data-copy-wrap>
										<span class="term-c"># every Series ({seriesCount}): percentiles, Run counts, its own file</span>
										<code data-copy>
											<Curl href={links.seriesList} />
										</code>
									</li>
									<li data-copy-wrap>
										<span class="term-c">
											# one Series: {sampleCode} on {sample.instanceType}, each Run's figure and a link to its evidence
										</span>
										<code data-copy>
											<Curl href={sample.url} />
										</code>
									</li>
									<li data-copy-wrap>
										<span class="term-c"># AWS On-Demand prices, copied {snapshot.priceDate}</span>
										<code data-copy>
											<Curl href={links.prices} />
										</code>
									</li>
								</ol>
							</div>

							<figure class="resp">
								<figcaption class="resp-head">
									<span class="resp-file">
										<code>v1/series/{sample.id}.json</code>
									</span>
									<span class="resp-what">
										One of its {formatCount(sample.points).full} Runs, an excerpt of the file as it is
									</span>
								</figcaption>
								<pre class="resp-body">
									<code>
										<span class="j-d">{"{"}</span>
										{"\n  "}
										<span class="j-k">"id"</span>: <span class="j-s">{J(sample.id)}</span>,{"\n  "}
										<span class="j-k">"benchmark"</span>: <span class="j-s">{J(sample.benchmark)}</span>,{"\n  "}
										<span class="j-k">"instance_type"</span>: <span class="j-s">{J(sample.instanceType)}</span>,{"\n  "}
										<span class="j-d">…</span>
										{"\n  "}
										<span class="j-k">"derivations"</span>: {"{ "}
										<span class="j-k">"series_v1"</span>: {"{ "}
										<span class="j-k">"points"</span>: {"[ {"}
										{"\n    "}
										<span class="j-k">"run"</span>: <span class="j-s">{J(point.run)}</span>,{"\n    "}
										<span class="j-k">"started_at"</span>: <span class="j-s">{J(point.started_at)}</span>,{"\n    "}
										<span class="j-k">"group"</span>: <span class="j-s">{J(point.group)}</span>,{"\n    "}
										<span class="j-k">"counted"</span>: <span class="j-n">{J(point.counted)}</span>,{"\n    "}
										<span class="j-k">"samples"</span>: [<span class="j-d"> … </span>],{"\n    "}
										<span class="j-k">"time_per_repetition_ns"</span>: <mark class="j-n">{J(point.time_per_repetition_ns)}</mark>,{"\n    "}
										<span class="j-k">"evidence"</span>: <span class="j-s">{J(point.evidence)}</span>,{"\n    "}
										<span class="j-k">"boot_summary"</span>: <span class="j-s">{J(point.boot_summary)}</span>
										{"\n  "}
										{"}, "}
										<span class="j-d">…</span>
										{" ] } }"}
										{"\n"}
										{"}"}
									</code>
								</pre>
								<p class="resp-foot">
									This Run started {pointStart.full} and took <b>{group(pointTime.full, ",", " ")} {pointTime.unit}</b> per repetition.
									{samplePrepared && (
										<>
											{" "}
											Its Series' figure, the {sample.instanceType} cell of row {sampleCode} on the board, is{" "}
											<b>
												{group(samplePrepared.p50.full, ",", " ")} {samplePrepared.p50.unit}
											</b>
											: the median of all its counted Runs, not this one Run's time.
										</>
									)}
								</p>
								<div class="ev">
									<p class="ev-l">
										Follow it down: the <code>evidence</code> address is this Run's own file.{" "}
										<a href={point.evidence}>Open the Run file</a>
									</p>
									<div class="cmd cmd-ev" data-copy-wrap>
										<code data-copy>
											<Curl href={point.evidence} />
										</code>
									</div>
								</div>
							</figure>
						</div>

						<div class="api-side">
							<table class="files">
								<caption class="sr">The data API's files and their JSON schemas</caption>
								<thead>
									<tr>
										<th scope="col">File</th>
										<th scope="col">JSON schema</th>
									</tr>
								</thead>
								<tbody>
									{links.schemas.map((s) => (
										<tr>
											<th scope="row">
												<code>{s.describes}</code>
											</th>
											<td>
												<a href={s.url}>{s.name}</a>
											</td>
										</tr>
									))}
								</tbody>
							</table>
							<dl class="api-facts">
								<div>
									<dt>Versioning</dt>
									<dd>{snapshot.versioning.split(":")[0]}.</dd>
								</div>
								<div>
									<dt>Evidence</dt>
									<dd>
										Each Run file names its binary, streams and dumps by hash; each is a blob at <code>{links.evidenceBlobTemplate}</code>.
									</dd>
								</div>
								<div>
									<dt>Price files</dt>
									<dd>
										One a day, {formatCount(links.priceFiles.length).full} so far, at <code>{links.priceFilePattern.replace("https://api.ledgermath.com/", "")}</code>.
									</dd>
								</div>
							</dl>
							<p class="api-docs">
								<a href={links.docs}>Read the data API's documentation →</a>
							</p>
						</div>
					</div>
				</section>

				{/* ------------------------------------------------ the method */}
				<section class="method-sec" id="method" aria-labelledby="method-title">
					<div class="sec-head">
						<h2 id="method-title">
							<span class="h2-code">04</span> Behind every figure
						</h2>
						<p class="sec-sub">
							{runs} Runs in {seriesCount} Series, from {oldest.date} {oldest.minute} to {newest.date} {newest.minute} UTC. {counted} were counted,{" "}
							{failed} failed; failed Runs are kept and shown, never dropped.
						</p>
					</div>

					<ol class="route">
						<li>
							<span class="route-n">1</span>
							<h3>Boot</h3>
							<p>A freshly booted AWS machine for every round, at 04:10, 10:10, 16:10 and 22:10 UTC.</p>
						</li>
						<li>
							<span class="route-n">2</span>
							<h3>Run</h3>
							<p>{benchmarksN} benchmarks on each machine. Each execution of one is a Run.</p>
						</li>
						<li>
							<span class="route-n">3</span>
							<h3>Keep</h3>
							<p>Every Run is kept with its evidence: what the benchmark printed, and what was recorded about the machine.</p>
						</li>
						<li>
							<span class="route-n">4</span>
							<h3>Derive</h3>
							<p>
								A versioned Method turns a Series' Runs into its figures: <code>series v{seriesV1.version}</code>
								{requestsV1 && (
									<>
										{" "}
										and <code>requests v{requestsV1.version}</code>
									</>
								)}
								.
							</p>
						</li>
						<li>
							<span class="route-n">5</span>
							<h3>Publish</h3>
							<p>Static JSON with a schema for each kind of file, beside AWS's prices for the day.</p>
						</li>
					</ol>

					<div class="defs">
						<h3 class="defs-title">
							Method <code>series v{seriesV1.version}</code>, in its own words
						</h3>
						<dl>
							{(["time_per_repetition", "bytes_per_second", "percentiles"] as const).map((k) => (
								<div>
									<dt>
										<code>{k}</code>
									</dt>
									<dd>{seriesV1.definitions[k]}</dd>
								</div>
							))}
						</dl>
						<p class="defs-more">
							Every definition of both Methods, word for word, is in <a href={links.seriesList}>series.json</a> under <code>methods</code>.
						</p>
						<p class="defs-figures">
							<b>Rounding.</b> In the API nothing is rounded: every number is as the Methods' Derivations hold it. On the board, the large figure is
							shortened for reading, to as many digits as tell its row apart; the line beneath it, and its title, keep every digit.
						</p>
					</div>
				</section>
			</main>

			<footer class="foot">
				<div class="foot-in">
					<div class="foot-brand">
						<span class="brand-mark" aria-hidden="true">
							<i />
							<i />
							<i />
						</span>
						LedgerMath
					</div>
					<p>
						Figures from the data API as of the newest Run, {newest.full}. Prices: AWS's public On-Demand price list for {snapshot.region}, copied{" "}
						{snapshot.priceDate}.
					</p>
					<p class="foot-links">
						<a href={links.index}>index.json</a>
						<a href={links.seriesList}>series.json</a>
						<a href={links.prices}>prices</a>
						<a href={links.docs}>docs</a>
						<a href="third-party-notices.txt">Font licences</a>
					</p>
				</div>
			</footer>
		</>
	);
}
