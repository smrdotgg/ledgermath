// A stub: the shared data, shown plainly, so the slot builds and passes its checks before a
// design exists. Replace all of it with the design; keep to the rules in ../README.md.
import "./page.css";
import {
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
	type Shown,
} from "../../data";

function Figure(props: { shown: Shown }) {
	return (
		<span title={`${props.shown.full} ${props.shown.unit} (exact: ${props.shown.source})`}>
			{props.shown.short} {props.shown.unit}
		</span>
	);
}

export default function Page() {
	const newest = formatMoment(snapshot.newestRunStartedAt);
	return (
		<main>
			<h1>LedgerMath</h1>
			<p>
				Cloud server benchmarks: {formatCount(snapshot.benchmarkCount).full} benchmarks on {formatCount(snapshot.machineCount).full} AWS machine types,
				run four times a day, every Run kept with its evidence.
			</p>
			<p>
				{formatCount(snapshot.seriesCount).full} Series, {formatCount(snapshot.runCount).full} Runs. Newest Run started{" "}
				<time datetime={newest.iso} title={newest.full}>
					{newest.date} {newest.minute} UTC
				</time>
				.
			</p>

			<h2>The home table</h2>
			<p>The median of each Series' counted Runs. Hover a figure for every digit.</p>
			<div class="scroll" tabindex="0" role="region" aria-label="The home table">
				<table>
					<thead>
						<tr>
							<th scope="col">Operation</th>
							{machines.map((m) => (
								<th scope="col">{m.instanceType}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{headline.map((row) => (
							<tr>
								<th scope="row">{row.choice.label}</th>
								{row.cells.map((cell) => {
									const f = leadFigure(row.choice, cell.series);
									const shown = f.kind === "rate" ? formatRate(f.p50) : formatDuration(f.p50);
									return (
										<td>
											<a href={links.seriesFile(cell.series)}>
												<Figure shown={shown} />
											</a>
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<h2>The machines</h2>
			<ul>
				{machines.map((m) => {
					const price = formatUsd(m.price.usdPerHour, { per: "hour" });
					return (
						<li>
							{m.instanceType}: {m.vcpu} vCPU, {m.memory}, {m.processor}; ${price.full} an hour On-Demand ({m.region})
						</li>
					);
				})}
			</ul>

			<h2>The data</h2>
			<ul>
				<li>
					<a href={links.index}>{links.index}</a>
				</li>
				<li>
					<a href={links.seriesList}>{links.seriesList}</a>
				</li>
				<li>
					<a href={links.prices}>{links.prices}</a>
				</li>
			</ul>
		</main>
	);
}
