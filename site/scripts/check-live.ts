/**
 * Checks the site as it is served: fetches each page (src/pages.text.ts) under BASE, the home
 * page and the documentation's placeholder, and fails unless each answers 200, without a
 * redirect, with HTML that holds each of the page's fixed words in its body outside any script
 * or style, the same test `bun run check` makes of the built files (missingText in
 * check-output.ts). So the pages are up, are this site's, and read with JavaScript off. The
 * figures change with every tree, so they are not what it looks for.
 * .github/workflows/site.yml runs it after each production deploy.
 *
 *     bun scripts/check-live.ts [BASE]     (BASE defaults to https://ledgermath.com/)
 *
 * A failed attempt is tried again, three attempts in all, ten seconds apart,
 * so a dropped connection, before the answer or while its body is read, does
 * not fail a deploy. Exit 0 when every page passes, 1 when one does not.
 */

import { PAGES } from "../src/pages.text";
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
	// The media type is what comes before any `;` parameter, and is case-insensitive.
	if (type.split(";", 1)[0]!.trim().toLowerCase() !== "text/html") {
		return [`${url} answered with Content-Type ${JSON.stringify(type)}, not text/html`];
	}
	let body: string;
	try {
		body = await response.text();
	} catch (error) {
		return [`${url}: reading the body: ${error instanceof Error ? error.message : String(error)}`];
	}
	return missingText(body, texts).map(
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

/** The address of each of PAGES under BASE: "https://ledgermath.com/" and "https://ledgermath.com/docs/". */
export function pageUrls(base: string, pages: readonly { path: string; text: readonly string[] }[] = PAGES): { url: string; text: readonly string[] }[] {
	const root = base.endsWith("/") ? base : `${base}/`;
	return pages.map((page) => ({ url: new URL(page.path.replace(/^\//, ""), root).href, text: page.text }));
}

if (import.meta.main) {
	const base = process.argv[2] ?? SITE_URL;
	let failed = false;
	for (const { url, text } of pageUrls(base)) {
		const problems = await checkLive(url, text);
		if (problems.length > 0) {
			failed = true;
			for (const problem of problems) console.error(problem);
		} else {
			console.log(`${url}: 200, and its HTML holds all ${text.length} of the page's fixed words outside any script`);
		}
	}
	if (failed) process.exit(1);
}
