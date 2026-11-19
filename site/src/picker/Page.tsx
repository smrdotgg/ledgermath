// The picker at /: a tool for looking at the eight designs, not a ninth design. It lists each
// design (its meta.json), whether it builds, its frozen checkpoints, and the judges' scores per
// round (site/variations/scores.json, written by scripts/variations-publish.ts).
import "./picker.css";
import { formatMoment, snapshot } from "../data";
import { asScores, readInput, type ScoresFile } from "./input";
import { PICKER_TEXT } from "./picker.text";

const REFERENCE = /^ref:/;
// Short column heads for the scores table; the category's full name is the abbreviation's title.
const SHORT: Record<string, string> = {
	first_ten_seconds: "First 10 s",
	numbers: "Numbers",
	trust_and_provenance: "Trust",
	agents_and_developers: "Agents",
	typography_and_hierarchy: "Type",
	colour_and_contrast: "Colour",
	phone_layout: "Phone",
	craft_and_distinctiveness: "Craft",
};

function subjectsOf(round: ScoresFile["rounds"][number]): string[] {
	const all = new Set<string>();
	for (const bySubject of Object.values(round.judgements)) for (const subject of Object.keys(bySubject)) all.add(subject);
	return [...all].sort((a, b) => Number(REFERENCE.test(a)) - Number(REFERENCE.test(b)) || a.localeCompare(b, "en", { numeric: true }));
}

function stats(values: number[]): { lowest: string; mean: string } {
	if (values.length === 0) return { lowest: "–", mean: "–" };
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	return { lowest: String(Math.min(...values)), mean: mean.toFixed(2) };
}

function Round(props: { round: ScoresFile["rounds"][number]; categories: ScoresFile["categories"] }) {
	const judges = props.round.judges;
	const subjects = subjectsOf(props.round);
	return (
		<section aria-labelledby={`round-${props.round.round}`}>
			<h3 id={`round-${props.round.round}`}>Round {props.round.round}</h3>
			<p class="muted">
				Each cell gives every judge's score in this order: {judges.join(", ")}.
				{props.round.new_checkpoints.length > 0
					? ` New checkpoints: ${props.round.new_checkpoints.map((c) => `${c.design} at ${c.level}`).join(", ")}.`
					: " No new checkpoint."}
			</p>
			<div class="scroll" tabindex="0" role="region" aria-label={`Scores of round ${props.round.round}`}>
				<table>
					<thead>
						<tr>
							<th scope="col">Subject</th>
							{props.categories.map((c) => (
								<th scope="col">
									<abbr title={c.name}>{SHORT[c.key] ?? c.name}</abbr>
								</th>
							))}
							<th scope="col">Lowest</th>
							<th scope="col">Mean</th>
						</tr>
					</thead>
					<tbody>
						{subjects.map((subject) => {
							const perJudge = judges.map((judge) => props.round.judgements[judge]?.[subject]);
							return (
								<tr>
									<th scope="row">{subject.replace(REFERENCE, "")}</th>
									{props.categories.map((c) => (
										<td>{perJudge.map((j) => (j ? String(j.scores[c.key] ?? "–") : "–")).join(" / ")}</td>
									))}
									<td>{perJudge.map((j) => stats(j ? Object.values(j.scores) : []).lowest).join(" / ")}</td>
									<td>{perJudge.map((j) => stats(j ? Object.values(j.scores) : []).mean).join(" / ")}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</section>
	);
}

export default function Page() {
	const input = readInput();
	const scores = asScores(input.scores);
	const newest = formatMoment(snapshot.newestRunStartedAt);
	const rounds = scores ? [...scores.rounds].sort((a, b) => b.round - a.round) : [];
	return (
		<main>
			<h1>{PICKER_TEXT[0]}</h1>
			<p>{PICKER_TEXT[1]}</p>
			<p class="muted">
				Every design shows the same snapshot of the data API: {snapshot.seriesCount} Series, {snapshot.runCount} Runs, the newest started {newest.full}.
				{input.commit ? ` Built from commit ${input.commit.slice(0, 12)}.` : ""}
			</p>

			<h2>The designs</h2>
			<ol class="designs">
				{input.designs.map((design) => {
					const saved = input.checkpoints.filter((c) => c.design === design.slot);
					return (
						<li>
							<h3>
								{design.builds === false ? (
									<span>
										{design.slot}: {design.name}
									</span>
								) : (
									<a href={`/${design.slot}/`}>
										{design.slot}: {design.name}
									</a>
								)}
							</h3>
							{design.idea ? <p>{design.idea}</p> : null}
							{design.builds === false ? (
								<details>
									<summary class="bad">Does not build</summary>
									<pre>{design.error}</pre>
								</details>
							) : design.builds === null ? (
								<p class="muted">Whether it builds is not known (the picker was built on its own).</p>
							) : null}
							{design.metaProblem ? <p class="bad">{design.metaProblem}</p> : null}
							<p class="muted">
								{saved.length === 0 ? "No checkpoint yet." : "Checkpoints: "}
								{saved.map((c, i) => (
									<>
										{i > 0 ? ", " : ""}
										<a href={c.path}>{c.level}</a>
									</>
								))}
							</p>
						</li>
					);
				})}
			</ol>

			<h2>Scores</h2>
			{input.scoresProblem ? <p class="bad">{input.scoresProblem}</p> : null}
			{rounds.length === 0 ? (
				<p>No round has been judged yet.</p>
			) : (
				rounds.map((round) => <Round round={round} categories={scores!.categories} />)
			)}
			{scores && scores.checkpoints.length > 0 ? (
				<>
					<h2>Checkpoints reached</h2>
					<ul>
						{scores.checkpoints.map((c) => (
							<li>
								<a href={c.path}>
									{c.design} at {c.level}
								</a>
								: round {c.round}, commit {c.commit.slice(0, 12)}, tag {c.tag}
							</li>
						))}
					</ul>
				</>
			) : null}
		</main>
	);
}
