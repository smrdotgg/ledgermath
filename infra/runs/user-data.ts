/**
 * The user-data a box of a `-runs` stage boots with: a few variables, a marker
 * line, then runner/box.sh without its first line. The box checks that what
 * follows the marker is runner/box.sh in the source archive it fetched.
 *
 * Shared by the launch Lambda and scripts/box-in-container.sh, so the
 * container test boots exactly what a box would.
 */

/** EC2 rejects user-data larger than this, before base64. */
export const USER_DATA_LIMIT_BYTES = 16384;

/** Must equal MARKER in runner/box.sh. */
export const BOX_MARKER = "# ---- runner/box.sh follows ----";

export interface BoxVariables {
	bucket: string;
	stage: string;
	sourceKey: string;
	sourceCommit: string;
	region: string;
	/** The s3_fixtures Service, as runner/run.py gives it to a benchmark (infra/runs/fixtures.ts). */
	fixtures: {
		/** LM_SERVICE_ENDPOINT: https://<fixtures bucket>.s3.<region>.amazonaws.com on a box. */
		endpoint: string;
		/** LM_SERVICE_REGION. */
		region: string;
		/** The role run.py assumes for the keys. */
		role: string;
	};
}

/** Characters that need no quoting in a shell word. */
const SHELL_SAFE = /^[A-Za-z0-9._/:-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;

export function buildUserData(boxScript: string, variables: BoxVariables): string {
	if (!boxScript.startsWith("#!")) {
		throw new Error("runner/box.sh must start with a #! line");
	}
	if (!COMMIT.test(variables.sourceCommit)) {
		throw new Error(
			`sourceCommit must be a full git commit id, got ${JSON.stringify(variables.sourceCommit)}`,
		);
	}
	const assignments: Array<[string, string]> = [
		["LEDGERMATH_BUCKET", variables.bucket],
		["LEDGERMATH_STAGE", variables.stage],
		["LEDGERMATH_SOURCE_KEY", variables.sourceKey],
		["LEDGERMATH_SOURCE_COMMIT", variables.sourceCommit],
		["AWS_DEFAULT_REGION", variables.region],
		["LEDGERMATH_FIXTURES_ENDPOINT", variables.fixtures.endpoint],
		["LEDGERMATH_FIXTURES_REGION", variables.fixtures.region],
		["LEDGERMATH_FIXTURES_ROLE", variables.fixtures.role],
	];
	for (const [name, value] of assignments) {
		if (!SHELL_SAFE.test(value)) {
			throw new Error(`${name} is not safe to put in a shell script: ${JSON.stringify(value)}`);
		}
	}

	const header = [
		"#!/usr/bin/env bash",
		...assignments.map(([name, value]) => `export ${name}=${value}`),
		BOX_MARKER,
	].join("\n");
	const body = boxScript.slice(boxScript.indexOf("\n") + 1);
	const userData = `${header}\n${body}`;

	const size = Buffer.byteLength(userData, "utf8");
	if (size > USER_DATA_LIMIT_BYTES) {
		throw new Error(`user-data is ${size} bytes; EC2 accepts at most ${USER_DATA_LIMIT_BYTES}`);
	}
	return userData;
}
