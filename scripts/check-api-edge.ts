/**
 * Before the publish job uploads the data API's tree: asks the public edge
 * for one file of each kind the tree holds, at the tree's own address, and
 * stops when the edge refuses a kind (scripts/lib/api-edge.ts):
 *
 *     bun scripts/check-api-edge.ts --tree DIR [--edge URL]
 *
 * (--edge: a stand-in for the edge, asked in place of the tree's address; the
 * tests use it.)
 *
 * Exits 1, naming each kind refused, when the edge answers with its own 404,
 * so that a tree linking a kind of file the deployed edge does not serve yet
 * is never uploaded: production-runs is to be deployed first (README,
 * "Deploy", "A new kind of file in the data API"). Exits 0 on any other
 * answer, the edge being down or unreachable included, and when the tree is
 * not served publicly, asking nothing. Writes the outcome to the step's
 * summary ($GITHUB_STEP_SUMMARY) when there is one.
 */

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { probeEdge } from "./lib/api-edge";

const USAGE = "usage: bun scripts/check-api-edge.ts --tree DIR [--edge URL]";

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { tree: { type: "string" }, edge: { type: "string" } } });
	if (!values.tree) {
		console.error(USAGE);
		process.exit(2);
	}
	const probe = await probeEdge(values.tree, values.edge === undefined ? {} : { edge: values.edge });
	const lines = probe.answers.map((answer) => `- ${answer.kind}: ${answer.url} answered ${answer.detail}${answer.verdict === "unknown" ? " (the upload goes on: an edge that is down or slow never stops a publish)" : ""}`);
	const outcome = !probe.asked
		? `The edge was not asked: ${probe.why}.`
		: probe.refused.length === 0
			? `The public edge serves every kind of file in the tree (${probe.answers.length} asked, one file of each): the upload may go on.`
			: `Not uploaded: the public edge refuses ${probe.refused.map((answer) => answer.kind).join(", ")} with its own 404, so a reader would find no such file where the tree links it. Deploy production-runs from main first, so that the edge serves every kind of file the build writes (README, "Deploy", "A new kind of file in the data API"); then run this job again.`;
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### The public edge against the tree's kinds of file\n\n${outcome}\n${lines.length === 0 ? "" : `\n${lines.join("\n")}\n`}`);
	if (probe.refused.length > 0) {
		for (const line of lines) console.error(line);
		console.error(outcome);
		process.exit(1);
	}
	for (const line of lines) console.log(line);
	console.log(outcome);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
