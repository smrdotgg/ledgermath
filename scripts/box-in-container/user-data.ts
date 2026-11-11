// Prints the user-data a box would boot with, built by the same function the
// launch Lambda uses. For scripts/box-in-container/run.sh.
//
//   bun scripts/box-in-container/user-data.ts <box.sh> <bucket> <stage> <source key> <commit> <region> \
//       <fixtures endpoint> <fixtures region> <fixtures role>

import { readFileSync } from "node:fs";

import { buildUserData } from "../../infra/runs/user-data";

const [boxPath, bucket, stage, sourceKey, sourceCommit, region, endpoint, fixturesRegion, role] = process.argv.slice(2);
if (!boxPath || !bucket || !stage || !sourceKey || !sourceCommit || !region || !endpoint || !fixturesRegion || !role) {
	console.error(
		"usage: user-data.ts <box.sh> <bucket> <stage> <source key> <commit> <region> <fixtures endpoint> <fixtures region> <fixtures role>",
	);
	process.exit(2);
}
process.stdout.write(
	buildUserData(readFileSync(boxPath, "utf8"), {
		bucket,
		stage,
		sourceKey,
		sourceCommit,
		region,
		fixtures: { endpoint, region: fixturesRegion, role },
	}),
);
