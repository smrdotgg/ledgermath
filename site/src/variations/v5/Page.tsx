// Design v5, form "dt-vitals": a hospital ward of five bedside monitors, one per AWS machine type.
// Every figure comes from ../../data exactly as the snapshot holds it (see ../README.md). Every
// chart is drawn by the Datatype font from those figures, scaled here in code, never by hand.
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
	snapshot,
	type DurationUnit,
	type HeadlineRow,
	type Machine,
	type Section,
	type Shown,
} from "../../data";
// The one Series whose every Run the snapshot keeps (mutex on c8i.2xlarge): the only Run-by-Run trace there is.
import { seriesFileSample } from "../../data/snapshot";

// ---------------------------------------------------------------- figures

type RowUnit = { kind: "rate"; unit: "B" | "kB" | "MB" | "GB" | "TB" } | { kind: "time"; unit: DurationUnit };

/** One unit for a whole headline row, the one its largest p50 takes, so five figures read against each other. */
function rowUnit(row: HeadlineRow): RowUnit {
	const largest = Math.max(...row.cells.map((cell) => leadFigure(row.choice, cell.series).p50));
	if (row.choice.lead === "rate") return { kind: "rate", unit: formatRate(largest).unit.replace("/s", "") as "GB" };
	if (row.choice.per) return { kind: "time", unit: formatDurationPerUnit(largest, row.choice.per).unit as DurationUnit };
	return { kind: "time", unit: durationUnit(largest) };
}

/** A figure of the row in the row's unit: the time of one unit of work where the row has `per` (mutex). */
function show(row: HeadlineRow, value: number): Shown {
	const u = rowUnit(row);
	if (u.kind === "rate") return formatRate(value, { unit: u.unit });
	if (row.choice.per) return formatDurationPerUnit(value, row.choice.per, { unit: u.unit });
	return formatDuration(value, { unit: u.unit });
}

const unitOf = (row: HeadlineRow) => show(row, leadFigure(row.choice, row.cells[0]!.series).p50).unit;
const rowOf = (benchmark: string) => {
	const row = headline.find((r) => r.choice.benchmark === benchmark);
	if (!row) throw new Error(`no headline row for ${benchmark}`);
	return row;
};
const cellOf = (row: HeadlineRow, m: Machine) => row.cells.find((cell) => cell.machine === m)!;

/** Heights from zero for a chart that compares machines: the row's largest is 100, the others in proportion. */
function fromZero(values: number[]): number[] {
	const largest = Math.max(...values);
	return values.map((v) => Math.round((100 * v) / largest));
}

/** Heights between a set's lowest and highest value (0 to 100): a zoomed chart, which must say so on itself. */
function zoomed(values: number[]): number[] {
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	return values.map((v) => (hi === lo ? 50 : Math.round((100 * (v - lo)) / (hi - lo))));
}

const line = (values: number[]) => `{l:${values.join(",")}}`;
const bars = (values: number[]) => `{b:${values.join(",")}}`;
const pie = (value: number) => `{p:${value}}`;

/** A figure as a short form, with every digit one hover away. */
function Fig(props: { s: Shown; unit?: boolean; class?: string }) {
	return (
		<span class={props.class} title={`${props.s.full} ${props.s.unit}`}>
			{props.s.short}
			{props.unit === false ? "" : ` ${props.s.unit}`}
		</span>
	);
}

/** A chart drawn by the font: a picture to a screen reader, with a short text alternative. */
function Chart(props: { code: string | string[]; label: string; class?: string }) {
	const codes = Array.isArray(props.code) ? props.code : [props.code];
	return (
		<span class={`chart ${props.class ?? ""}`} role="img" aria-label={props.label}>
			{codes.map((code) => (
				<span class="dt" aria-hidden="true">
					{code}
				</span>
			))}
		</span>
	);
}

// ---------------------------------------------------------------- the ward

const ROUNDS = ["04:10", "10:10", "16:10", "22:10"];
const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const shortDay = (m: ReturnType<typeof formatMoment>) => m.longDate.replace(/ \d{4}$/, "").replace(/(\w{3})\w+$/, "$1");

/** The five numbers a bedside monitor shows big, each a headline row, in a monitor's own colours. */
const VITALS: { benchmark: string; tag: string; sub: string; tone: string }[] = [
	{ benchmark: "hash", tag: "HASH", sub: "SHA-256 · 64 B", tone: "green" },
	{ benchmark: "syscall", tag: "SYS", sub: "one getpid", tone: "red" },
	{ benchmark: "disk_read_io_uring", tag: "SAT", sub: "4 KiB read · 64 queued", tone: "cyan" },
	{ benchmark: "http_get", tag: "RESP", sub: "GET 4 KiB from S3", tone: "yellow" },
	{ benchmark: "memory_read", tag: "MEM", sub: "read 1 GiB in order", tone: "magenta" },
];

const mutexRow = rowOf("mutex");
const samplePoints = seriesFileSample.derivations.series_v1.points.filter((p) => p.time_per_repetition_ns !== null);
const sampleTimes = samplePoints.map((p) => p.time_per_repetition_ns!);
const sampleZoom = zoomed(sampleTimes);
// The font draws at most 20 points a line: 33 Runs as two lines that share the Run where they meet.
const half = Math.ceil(sampleZoom.length / 2);
const sampleCodes = [line(sampleZoom.slice(0, half)), line(sampleZoom.slice(half - 1))];
const sampleLo = formatDurationPerUnit(Math.min(...sampleTimes), mutexRow.choice.per!);
const sampleHi = formatDurationPerUnit(Math.max(...sampleTimes), mutexRow.choice.per!);

function Monitor(props: { m: Machine; bed: number }) {
	const m = props.m;
	const runs = m.series.reduce((t, r) => t + r.runs, 0);
	const counted = m.series.reduce((t, r) => t + r.derivations.series_v1.counted_runs, 0);
	const failed = m.series.reduce((t, r) => t + r.derivations.series_v1.failed_runs, 0);
	const admitted = formatMoment(m.series.map((r) => r.oldest_run_started_at).sort()[0]!);
	const last = formatMoment(m.series.map((r) => r.newest_run_started_at).sort().at(-1)!);
	const beat = headline.map((row) => fromZero(row.cells.map((cell) => leadFigure(row.choice, cell.series).p50))[row.cells.indexOf(cellOf(row, m))]!);
	const mutexCell = cellOf(mutexRow, m);
	const hasSample = mutexCell.series.id === seriesFileSample.id;
	const id = `bed-${props.bed}`;
	const price = formatUsd(m.price.usdPerHour);

	return (
		<section class="bed" aria-labelledby={id}>
			<div class="monitor">
				<div class="topbar">
					<h2 id={id}>
						<span class="bedno">BED {props.bed}</span> <span class="who">{m.instanceType}</span>
					</h2>
					<span class="dims">
						{m.vcpu} vCPU · {m.memory}
					</span>
					<span class="clock" title={last.full}>
						LAST OBS {last.minute}
					</span>
				</div>

				<div class="channel ecg">
					<p class="chlabel">
						<span class="tone-green">LEADS 1–14</span> <span>each benchmark’s p50 · ward’s largest = top</span>
					</p>
					<div class="trace">
						<Chart
							class="tone-green"
							code={[line(beat), line(beat)]}
							label={`Bed ${props.bed}'s 14 headline figures, one point per benchmark in the chart's order, each as a share of the largest of the five machines (drawn twice). Exact figures are in the chart at the foot of the bed.`}
						/>
					</div>
				</div>

				<div class="channel pleth">
					{hasSample ? (
						<>
							<p class="chlabel">
								<span class="tone-cyan">MUTEX · EACH RUN</span> <span>{samplePoints.length} Runs, {shortDay(formatMoment(samplePoints[0]!.started_at))}–{shortDay(formatMoment(samplePoints.at(-1)!.started_at))}</span>{" "}
								<span class="zoom">
									ZOOMED <Fig s={sampleLo} unit={false} />–<Fig s={sampleHi} /> per critical section
								</span>
							</p>
							<div class="trace">
								<Chart
									class="tone-cyan"
									code={sampleCodes}
									label={`Every Run of this Series, oldest first: the time of one critical section, zoomed between its lowest, ${sampleLo.full} ns, and its highest, ${sampleHi.full} ns.`}
								/>
							</div>
						</>
					) : (
						<p class="leadoff">
							<span class="tone-cyan">MUTEX · EACH RUN</span> <span class="off">LEAD OFF</span>{" "}
							<a href={links.seriesFile(mutexCell.series)}>trace at /v1/series/{mutexCell.series.id}.json</a>
						</p>
					)}
				</div>

				<div class="params">
					{VITALS.map((v) => {
						const row = rowOf(v.benchmark);
						const f = leadFigure(row.choice, cellOf(row, m).series);
						return (
							<div class={`param tone-${v.tone}`}>
								<div class="ptag">
									{v.tag} {v.tone === "green" ? <span class="pulse" aria-hidden="true" /> : null}
									<span class="punit">p50 · {unitOf(row)}</span>
								</div>
								<div class="pval">
									<Fig s={show(row, f.p50)} unit={false} />
								</div>
								<div class="plim">
									<span>
										p95 <Fig s={show(row, f.p95)} unit={false} />
									</span>
									<span>
										p5 <Fig s={show(row, f.p5)} unit={false} />
									</span>
								</div>
								<div class="psub">{v.sub}</div>
							</div>
						);
					})}
					<div class="param tone-white kept">
						<div class="ptag">KEPT</div>
						<div class="pval">
							<Chart class="pie" code={pie(Math.round((100 * counted) / runs))} label={`${formatCount(counted).full} of ${formatCount(runs).full} Runs counted`} />
							<span>{formatCount(runs).full}</span>
						</div>
						<div class="plim">
							<span>counted {formatCount(counted).full}</span>
							<span>failed {formatCount(failed).full}</span>
						</div>
						<div class="psub">Runs on file</div>
					</div>
				</div>

				<p class="statusbar">
					<span>ADMITTED {shortDay(admitted)} {admitted.minute} UTC</span>
					<span>CYCLE AUTO 6 h</span>
					<span>ALARMS: NONE SET</span>
				</p>
			</div>

			<details class="clip">
				<summary>
					<span class="clipbar" aria-hidden="true" />
					Chart at the foot of the bed
				</summary>
				<div class="paper">
					<dl class="band">
						<div>
							<dt>Patient</dt>
							<dd>{m.instanceType}</dd>
						</div>
						<div>
							<dt>Processor</dt>
							<dd>
								{m.processor}, {m.clockSpeed}
							</dd>
						</div>
						<div>
							<dt>Storage</dt>
							<dd>{m.storage}</dd>
						</div>
						<div>
							<dt>Network</dt>
							<dd>{m.network}</dd>
						</div>
						<div>
							<dt>Ward</dt>
							<dd>
								{m.region}, {m.availabilityZoneIds.join(", ")}
							</dd>
						</div>
						<div>
							<dt>Charges</dt>
							<dd title={m.price.description}>
								{price.full} USD per hour, On-Demand <a href={links.prices}>price file {snapshot.priceDate}</a>
							</dd>
						</div>
						<div>
							<dt>Admitted</dt>
							<dd>{admitted.full}</dd>
						</div>
						<div>
							<dt>Last obs</dt>
							<dd>{last.full}</dd>
						</div>
					</dl>
					<div class="obs" role="region" aria-label={`Bed ${props.bed}'s figures`} tabindex="0">
						<table>
							<thead>
								<tr>
									<th scope="col">Lead</th>
									<th scope="col">Benchmark</th>
									<th scope="col">p50</th>
									<th scope="col">p5</th>
									<th scope="col">p95</th>
									<th scope="col">Runs</th>
								</tr>
							</thead>
							<tbody>
								{headline.map((row, i) => {
									const cell = cellOf(row, m);
									const f = leadFigure(row.choice, cell.series);
									const unit = show(row, f.p50).unit;
									return (
										<tr>
											<td>{i + 1}</td>
											<th scope="row">
												<a href={links.seriesFile(cell.series)}>{row.choice.label}</a>
											</th>
											<td>
												{show(row, f.p50).full} {unit}
											</td>
											<td>{show(row, f.p5).full}</td>
											<td>{show(row, f.p95).full}</td>
											<td>{formatCount(cell.series.runs).full}</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
					<p class="sig">Times are one repetition (mutex: one critical section). Each benchmark name opens its Series in the API.</p>
				</div>
			</details>
		</section>
	);
}

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];

function Station() {
	return (
		<section class="station" aria-labelledby="station">
			<h2 id="station">
				Central station <span>all five beds, one benchmark at a time · bars from zero</span>
			</h2>
			{SECTIONS.map((section) => (
				<div class="ward-section">
					<h3>{section}</h3>
					<div class="tiles">
						{headline
							.filter((row) => row.choice.section === section)
							.map((row) => {
								const p50s = row.cells.map((cell) => leadFigure(row.choice, cell.series).p50);
								const unit = unitOf(row);
								return (
									<div class="tile">
										<p class="tlabel">
											{row.choice.label}
											{row.choice.per ? " (one critical section)" : ""} <span class="tunit">{unit}, p50</span>
										</p>
										<div class="tbody">
											<Chart
												class="tone-green bars"
												code={bars(fromZero(p50s))}
												label={`${row.choice.label}, p50 on beds 1 to 5, from zero: ${row.cells.map((cell, i) => `${cell.machine.instanceType} ${show(row, p50s[i]!).full} ${unit}`).join("; ")}`}
											/>
											<ol class="tfigs">
												{row.cells.map((cell, i) => (
													<li>
														<span class="tbed">{i + 1}</span> <Fig s={show(row, p50s[i]!)} unit={false} />
													</li>
												))}
											</ol>
										</div>
									</div>
								);
							})}
					</div>
				</div>
			))}
			<p class="legend">
				Beds:{" "}
				{machines.map((m, i) => (
					<span>
						<b>{i + 1}</b> {m.instanceType}{" "}
					</span>
				))}
				· Taller means more bytes per second, or a longer time.
			</p>
		</section>
	);
}

export default function Page() {
	return (
		<>
			<header class="ward">
				<p class="sign">
					<span>WARD</span> {snapshot.region} · {machines[0]!.availabilityZoneIds.join(", ")}
				</p>
				<h1>LedgerMath</h1>
				<p class="lede">
					Five AWS machines under observation. Each booted fresh four times a day, measured by {snapshot.benchmarkCount} benchmarks, every Run kept with its evidence.
				</p>
				<p class="notice">The monitor reports. It does not diagnose.</p>
				<div class="desk">
					<p class="deskhead">Records desk · open to agents at any hour</p>
					<p class="addr" data-copy={links.index}>
						<a href={links.index}>{links.index.replace("https://", "")}</a>
					</p>
				</div>
				<div class="board">
					<p>
						<span class="bk">ROUNDS</span> {ROUNDS.join(" · ")} UTC
					</p>
					<p>
						<span class="bk">ON FILE</span> {formatCount(snapshot.runCount).full} Runs · {formatCount(snapshot.failedRuns).full} failed
					</p>
					<p>
						<span class="bk">SINCE</span> <span title={oldest.full}>{oldest.longDate}</span>
					</p>
					<p>
						<span class="bk">LAST OBS</span>{" "}
						<span title={newest.full}>
							{newest.longDate} {newest.minute} UTC
						</span>
					</p>
					<p>
						<span class="bk">DIAGNOSIS</span> <span class="blank">not given</span>
					</p>
				</div>
			</header>

			<main>
				<div class="beds">
					{machines.map((m, i) => (
						<Monitor m={m} bed={i + 1} />
					))}
					<section class="bed vacant" aria-labelledby="bed-6">
						<div class="monitor standby">
							<div class="topbar">
								<h2 id="bed-6">
									<span class="bedno">BED 6</span> <span class="who">vacant</span>
								</h2>
							</div>
							<div class="nopatient">
								<div class="np">NO PATIENT</div>
								<p>
									{snapshot.machineCount} machine types are measured. This bed stays empty.
								</p>
								<p class="nextround">
									ROUNDS <b>{ROUNDS.join("  ")}</b> UTC
								</p>
								<p>A fresh boot each round, {snapshot.benchmarkCount} benchmarks on it, every Run kept.</p>
							</div>
						</div>
					</section>
				</div>
				<Station />
			</main>

			<footer class="foot">
				<p>
					<a href={links.index}>index.json</a> · <a href={links.seriesList}>series.json</a> ({formatCount(snapshot.seriesCount).full} Series) · <a href={links.prices}>prices {snapshot.priceDate}</a> ·{" "}
					<a href={links.docs}>docs</a>
				</p>
				<p>
					Snapshot of {newest.longDate}. Prices: AWS On-Demand, Linux, {snapshot.region}. Type: <a href="third-party-notices.txt">Datatype</a>.
				</p>
			</footer>
		</>
	);
}
