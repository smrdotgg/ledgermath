/**
 * Checks the site as it is served: fetches URL and fails unless it answers
 * 200, without a redirect, with HTML that holds each line of the page's text
 * (src/App.text.ts) in its body outside any script or style, the same test
 * `bun run check` makes of the built index.html (missingText in
 * check-output.ts). So the page is up and reads with JavaScript off.
 * .github/workflows/site.yml runs it after each production deploy.
 *
 *     bun scripts/check-live.ts [URL]     (URL defaults to https://ledgermath.com/)
 *
 * A failed attempt is tried again, three attempts in all, ten seconds apart,
 * so a dropped connection does not fail a deploy. Exit 0 when an attempt
 * passes, 1 when none does.
 */

import { PAGE_TEXT } from "../src/App.text";
import { missingText } from "./check-output";

export const SITE_URL = "https://ledgermath.com/";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** What is wrong with URL as served, once; empty when it passes. */
export async function checkLiveOnce(url: string, texts: readonly string[], get: Fetch = fetch): Promise<string[]> {
	let response: Response;
	try {
		response = await get(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(20_000) });
	} catch (error) {
		return [`${url}: ${error instanceof Error ? error.message : String(error)}`];
	}
	if (response.status !== 200) {
		const location = response.headers.get("location");
		return [`${url} answered ${response.status}${location ? ` (Location: ${location})` : ""}, not 200`];
	}
	const type = response.headers.get("content-type") ?? "";
	if (!type.startsWith("text/html")) return [`${url} answered with Content-Type ${JSON.stringify(type)}, not text/html`];
	return missingText(await response.text(), texts).map(
		(text) => `${url} does not hold, in its body outside any script: ${JSON.stringify(text)}`,
	);
}

/** checkLiveOnce, up to ATTEMPTS times, WAIT ms apart; the last attempt's problems, or none. */
export async function checkLive(
	url: string,
	texts: readonly string[],
	{ attempts = 3, wait = 10_000, get = fetch as Fetch } = {},
): Promise<string[]> {
	let problems: string[] = [];
	for (let attempt = 1; attempt <= attempts; attempt++) {
		problems = await checkLiveOnce(url, texts, get);
		if (problems.length === 0) return [];
		if (attempt < attempts) {
			console.error(`attempt ${attempt} of ${attempts}: ${problems.join("; ")}`);
			await Bun.sleep(wait);
		}
	}
	return problems;
}

if (import.meta.main) {
	const url = process.argv[2] ?? SITE_URL;
	const problems = await checkLive(url, PAGE_TEXT);
	if (problems.length > 0) {
		for (const problem of problems) console.error(problem);
		process.exit(1);
	}
	console.log(`${url}: 200, and its HTML holds all ${PAGE_TEXT.length} lines of the page's text outside any script`);
}
