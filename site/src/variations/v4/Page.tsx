// Design v4, "Departure board": the home page as a station board. Freshness first (the newest
// Run, the four daily rounds), then the board itself: fourteen rows, five machine types, every
// figure exact. Rendered once at build time; client.ts only adds copy buttons.
import "./page.css";
import {
	type Section,
	type Shown,
	formatCount,
	formatDuration,
	formatMoment,
	formatRate,
	formatUsd,
	headline,
	leadFigure,
	links,
	machines,
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

/** A URL with break opportunities after its slashes, so it wraps at a path boundary, never inside a word. */
function Url(props: { href: string }) {
	const [scheme, rest] = props.href.split("://");
	const parts = rest!.split("/");
	return (
		<>
			{scheme}://
			{parts.map((part, i) => (
				<>
					{i > 0 && (
						<>
							/<wbr />
						</>
					)}
					{part}
				</>
			))}
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
	const out: { section: Section; rows: (typeof headline)[number][] }[] = [];
	for (const row of headline) {
		const last = out[out.length - 1];
		if (last && last.section === row.choice.section) last.rows.push(row);
		else out.push({ section: row.choice.section, rows: [row] });
	}
	return out;
}

export default function Page() {
	const newest = formatMoment(snapshot.newestRunStartedAt);
	const oldest = formatMoment(snapshot.oldestRunStartedAt);
	const fetched = formatMoment(snapshot.pricesFetchedAt);
	const runs = formatCount(snapshot.runCount).full;
	const seriesCount = formatCount(snapshot.seriesCount).full;
	const counted = formatCount(snapshot.countedRuns).full;
	const failed = formatCount(snapshot.failedRuns).full;
	const benchmarksN = formatCount(snapshot.benchmarkCount).full;
	const machinesN = formatCount(snapshot.machineCount).full;
	const seriesV1 = snapshot.methods.find((m) => m.key === "series_v1")!;
	const requestsV1 = snapshot.methods.find((m) => m.key === "requests_v1");
	const sections = sectionsInOrder();
	let rowNumber = 0;

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
				{/* ------------------------------------------------ the board's head: name, clock, rounds */}
				<section class="head" aria-labelledby="title">
					<div class="head-in">
						<div class="head-id">
							<p class="kicker">
								<span class="dot" aria-hidden="true" />
								Server benchmarks · measured on AWS
							</p>
							<h1 id="title">LedgerMath</h1>
							<p class="lede">
								Four times a day, fresh AWS machines are booted and put through {benchmarksN} benchmarks. Every Run is kept with its evidence, every
								figure is derived by a published Method, and all of it is a static JSON API that AI agents can read and cite.
							</p>
							<div class="cmd" data-copy-wrap>
								<span class="cmd-prompt" aria-hidden="true">
									$
								</span>
								<code data-copy>
									curl <Url href={links.index} />
								</code>
							</div>
							<dl class="tally">
								<div>
									<dt>Runs kept</dt>
									<dd>{runs}</dd>
								</div>
								<div>
									<dt>Series</dt>
									<dd>{seriesCount}</dd>
								</div>
								<div>
									<dt>Failed Runs</dt>
									<dd>{failed}</dd>
								</div>
								<div>
									<dt>Oldest Run</dt>
									<dd class="tally-date" title={oldest.full}>
										{oldest.date}
									</dd>
								</div>
							</dl>
						</div>

						<div class="panel">
							<div class="clock" aria-labelledby="clock-label">
								<p class="panel-row">
									<span class="panel-label" id="clock-label">
										Newest Run started
									</span>
									<span class="panel-status">
										<span class="dot" aria-hidden="true" />
										{newest.longDate}
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
								</p>
								<p class="clock-full">{newest.full}</p>
							</div>

							<div class="rounds" aria-labelledby="rounds-label">
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
										<span class="strip-newest" style={{ left: `${dayPercent(newest.minute)}%` }}>
											<span class="strip-flag">Newest Run {newest.second}</span>
										</span>
									</div>
									<div class="strip-scale">
										<span>00:00</span>
										<span>06:00</span>
										<span>12:00</span>
										<span>18:00</span>
										<span>24:00</span>
									</div>
								</div>
							</div>
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
							{benchmarksN} benchmarks × {machinesN} machine types. Each figure is the median (p50) of one Series' counted Runs: the rate where the
							benchmark moves bytes, otherwise the time of one repetition. The large figure is rounded; the line under it has every digit. Each figure
							links to its Series' file, with the Runs behind it.
						</p>
					</div>

					<div class="board-wrap" role="region" aria-label="The board: headline figures" tabindex="0">
						<table class="board">
							<caption class="sr">
								Headline figures: {benchmarksN} benchmarks on {machinesN} AWS machine types, the median of each Series' counted Runs, with the time each
								Series' newest Run started and how many Runs it has.
							</caption>
							<thead>
								<tr>
									<th scope="col" class="col-what">
										<span class="col-what-in">
											<span>Measured</span>
											<span class="col-what-hint">Median · newest Run · Runs</span>
										</span>
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
							{sections.map((group) => (
								<tbody class={SECTION_CLASS[group.section]}>
									<tr class="sec-row">
										<th scope="colgroup" colspan={machines.length + 1}>
											<span class="badge">{SECTION_CODE[group.section]}</span>
											{group.section}
										</th>
									</tr>
									{group.rows.map((row) => {
										rowNumber += 1;
										const n = String(rowNumber).padStart(2, "0");
										const c = row.choice;
										return (
											<tr class="row">
												<th scope="row" class="what">
													<span class="what-top">
														<span class="badge">
															{SECTION_CODE[c.section]} {n}
														</span>
														<span class="what-kind">{c.lead === "rate" ? "Median rate" : "Median time"}</span>
													</span>
													<span class="what-label">{c.label}</span>
													<span class="what-desc">{c.what}</span>
													{c.lead === "time" && (
														<span class="what-rep">
															<b>One repetition:</b> {c.repetition}
														</span>
													)}
													<span class="what-set">{c.setting}</span>
												</th>
												{row.cells.map((cell) => {
													const f = leadFigure(c, cell.series);
													const shown = f.kind === "rate" ? formatRate(f.p50) : formatDuration(f.p50);
													const t = formatMoment(cell.series.newest_run_started_at);
													return (
														<td class="fig">
															<a href={links.seriesFile(cell.series)} title={exactTitle(shown)}>
																<span class="fig-m" aria-hidden="true">
																	{cell.machine.instanceType}
																</span>
																<span class="fig-main">
																	<span class="fig-n">{shown.short}</span>
																	<span class="fig-u">{shown.unit}</span>
																</span>
																<span class="fig-full">
																	<span class="sr">exactly </span>
																	{shown.full}
																</span>
																<span class="fig-meta">
																	<time datetime={t.iso} title={t.full}>
																		{t.minute}
																	</time>
																	<span class="sr"> UTC newest Run, </span>
																	<span aria-hidden="true"> · </span>
																	{formatCount(cell.series.runs).full} Runs
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
						Times under each figure: when that Series' newest Run started, {newest.date}, UTC. Hover or focus a figure for the value exactly as the API
						holds it.
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
									<p class="gate-aws">“{m.price.description}”</p>
								</li>
							);
						})}
					</ol>
					<p class="board-foot">
						Price file: <a href={links.prices}>{links.prices}</a>
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
							agent reads the table of contents, takes the Series it needs, and can cite every figure by its Series' address, beside the day's AWS
							prices.
						</p>
					</div>

					<div class="api-grid">
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
									curl <Url href={links.index} />
								</code>
								</li>
								<li data-copy-wrap>
									<span class="term-c">
										# every Series ({seriesCount}): percentiles, Run counts, its own file
									</span>
									<code data-copy>
									curl <Url href={links.seriesList} />
								</code>
								</li>
								<li data-copy-wrap>
									<span class="term-c"># AWS On-Demand prices, copied {snapshot.priceDate}</span>
									<code data-copy>
									curl <Url href={links.prices} />
								</code>
								</li>
							</ol>
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
							<blockquote class="quote">
								<p>{snapshot.versioning.split(":")[0]}.</p>
								<p class="quote-src">The API, on versioning</p>
							</blockquote>
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
							<span class="h2-code">04</span> Where every figure comes from
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
						<blockquote class="defs-figures">
							<p>“{snapshot.figures.split(":")[0]}.”</p>
						</blockquote>
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
