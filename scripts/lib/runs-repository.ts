/**
 * The Runs repository: every Run file and boot summary, byte for byte as the
 * box uploaded them, under the paths they have in the bucket. Private until
 * step 7 of the plan (#36).
 */

export const RUNS_REPOSITORY = "smrdotgg/ledgermath-runs";

/** Where a file of the Runs repository is shown, by its path in the repository. */
export const RUNS_REPOSITORY_BLOB_URL = `https://github.com/${RUNS_REPOSITORY}/blob/main/`;

/** The region of the -runs stage's bucket (sst.config.ts). */
export const RUNS_BUCKET_REGION = "us-east-2";
