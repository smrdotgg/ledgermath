/**
 * The three rounds of boots that ended with the snapshot's newest Run, for the "Latest runs"
 * list. The data module does not give rounds (the API has no file for them yet), so these were
 * counted by hand from the boot records of the Runs data: the 15 files under boots/2026/11/19/
 * whose boot started at or before the snapshot's newest Run, at the Runs data's commit 96c45f2.
 *
 *   startedAt  the `started_at` of the round's first boot
 *   machines   how many boot records the round has (one per machine type)
 *   runs       the sum of the lengths of their `runs` lists (37 + 35 + 37 + 36 + 42)
 *
 * Every one of those Runs exited with code 0. The page says "0 failed" only while the snapshot's
 * own count of failed Runs is 0 (Page.tsx checks it at build time).
 *
 * When the API publishes its recent rounds, read them from there and delete this file.
 */
export type Round = { startedAt: string; machines: number; runs: number };

/** Newest first. */
export const ROUNDS: readonly Round[] = [
	{ startedAt: "2026-11-19T16:11:43.513987246Z", machines: 5, runs: 187 },
	{ startedAt: "2026-11-19T10:11:03.050566699Z", machines: 5, runs: 187 },
	{ startedAt: "2026-11-19T04:11:03.680646285Z", machines: 5, runs: 187 },
];
