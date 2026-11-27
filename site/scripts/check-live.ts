/**
 * Checks the site as it is served under BASE, and fails unless each answer is 200, without a
 * redirect, of the media type it should be:
 *
 *  - the home page: HTML holding each of its fixed words (src/pages.text.ts) in its body outside
 *    any script or style, the same test `bun run check` makes of the built files (missingText in
 *    check-output.ts). So the page is up, is this site's, and reads with JavaScript off. The
 *    figures change with every tree, so they are not what it looks for;
 *  - the documentation's first page as Markdown, /docs/index.md (text/markdown), starting with its
 *    title: the host serves the Markdown beside the page;
 *  - /docs/ as HTML holding the header's and footer's words and that Markdown's title and
 *    description: the page is the one rendered from it;
 *  - /docs/ asked for with Accept: text/markdown: the same Markdown, with Vary: Accept, so that no
 *    cache gives a reader the one for the other (site/deploy/vercel-config.ts);
 *  - /llms.txt, the index for agents, starting with the site's name.
 *
 * .github/workflows/site.yml and the runs workflow's site job run it after each production deploy.
 *
 *     bun scripts/check-live.ts [BASE]     (BASE defaults to https://ledgermath.com/)
 *
 * A failed attempt is tried again, three attempts in all, ten seconds apart,
 * so a dropped connection, before the answer or while its body is read, does
 * not fail a deploy. Exit 0 when every check passes, 1 when one does not.
 */

import { documentTitle } from "../src/docs/sections";
import { HEADER_AND_FOOTER, HOME } from "../src/pages.text";
import { missingText } from "./check-output";
import { describeMarkdown } from "./docs";

export const SITE_URL = "https://ledgermath.com/";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * One thing to ask of the site: an address, the media type of the answer, and the words it must
 * hold (for HTML, in its body outside any script; for Markdown or text, anywhere), asked for with
 * Accept: text/markdown when `markdown` is set, which also wants Vary: Accept.
 */
export type LiveCheck = { url: string; type: "text/html" | "text/markdown" | "text/plain"; text: readonly string[]; markdown?: boolean };

/** What is wrong with the answer to CHECK, once; empty when it passes. */
export async function checkLiveOnce(check: LiveCheck, get: Fetch = fetch): Promise<string[]> {
	const { url, type: wanted, text: texts } = check;
	const where = check.markdown ? `${url} (Accept: text/markdown)` : url;
	let response: Response;
	try {
		response = await get(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(20_000), headers: check.markdown ? { accept: "text/markdown" } : {} });
	} catch (error) {
		return [`${where}: ${error instanceof Error ? error.message : String(error)}`];
	}
	if (response.status !== 200) {
		const location = response.headers.get("location");
		return [`${where} answered ${response.status}${location ? ` (Location: ${location})` : ""}, not 200`];
	}
	const type = response.headers.get("content-type") ?? "";
	// The media type is what comes before any `;` parameter, and is case-insensitive.
	if (type.split(";", 1)[0]!.trim().toLowerCase() !== wanted) {
		return [`${where} answered with Content-Type ${JSON.stringify(type)}, not ${wanted}`];
	}
	const problems: string[] = [];
	if (check.markdown && !(response.headers.get("vary") ?? "").split(",").some((name) => name.trim().toLowerCase() === "accept")) {
		problems.push(`${where} answered without Vary: Accept, so a cache could give it to a reader who asked for HTML`);
	}
	let body: string;
	try {
		body = await response.text();
	} catch (error) {
		return [`${where}: reading the body: ${error instanceof Error ? error.message : String(error)}`];
	}
	if (wanted === "text/html") problems.push(...missingText(body, texts).map((text) => `${where} does not hold, in its body outside any script: ${JSON.stringify(text)}`));
	else problems.push(...texts.filter((text) => !body.includes(text)).map((text) => `${where} does not hold ${JSON.stringify(text)}`));
	return problems;
}

/** checkLiveOnce, up to ATTEMPTS times, WAIT ms apart; the last attempt's problems, or none. */
export async function checkLive(check: LiveCheck, { attempts = 3, wait = 10_000, get = fetch as Fetch } = {}): Promise<string[]> {
	let problems: string[] = [];
	for (let attempt = 1; attempt <= attempts; attempt++) {
		problems = await checkLiveOnce(check, get);
		if (problems.length === 0) return [];
		if (attempt < attempts) {
			console.error(`attempt ${attempt} of ${attempts}: ${problems.join("; ")}`);
			await Bun.sleep(wait);
		}
	}
	return problems;
}

/** BASE with a trailing slash. */
const rooted = (base: string) => (base.endsWith("/") ? base : `${base}/`);

/** The home page's check under BASE. */
export const homeCheck = (base: string): LiveCheck => ({ url: rooted(base), type: "text/html", text: HOME.text });

/** The documentation's first page as Markdown, under BASE: /docs/index.md. */
export const docsMarkdownUrl = (base: string): string => new URL("docs/index.md", rooted(base)).href;

/**
 * The checks of the documentation under BASE, from MARKDOWN, /docs/index.md as served: the
 * Markdown again (it must start with its title), the page rendered from it, the page asked for as
 * Markdown, and llms.txt.
 */
export function docsChecks(base: string, markdown: string): LiveCheck[] {
	const { title, description } = describeMarkdown(markdown, docsMarkdownUrl(base));
	const docs = new URL("docs/", rooted(base)).href;
	const heading = `# ${title}\n`;
	return [
		{ url: docsMarkdownUrl(base), type: "text/markdown", text: [heading] },
		{ url: docs, type: "text/html", text: [...HEADER_AND_FOOTER, title, description] },
		{ url: docs, type: "text/markdown", text: [heading], markdown: true },
		{ url: new URL("llms.txt", rooted(base)).href, type: "text/plain", text: ["# LedgerMath\n", docsMarkdownUrl(SITE_URL)] },
	];
}

if (import.meta.main) {
	const base = process.argv[2] ?? SITE_URL;
	let failed = false;
	const run = async (check: LiveCheck) => {
		const problems = await checkLive(check);
		if (problems.length > 0) {
			failed = true;
			for (const problem of problems) console.error(problem);
		} else {
			console.log(`${check.url}${check.markdown ? " (Accept: text/markdown)" : ""}: 200, ${check.type}, holding all ${check.text.length} of its words`);
		}
	};
	await run(homeCheck(base));
	// /docs/'s words come from its Markdown as served, which is checked first.
	let markdown: string | null = null;
	for (let attempt = 1; attempt <= 3 && markdown === null; attempt++) {
		markdown = await fetch(docsMarkdownUrl(base), { cache: "no-store", signal: AbortSignal.timeout(20_000) })
			.then((response) => (response.ok ? response.text() : null))
			.catch(() => null);
		if (markdown === null && attempt < 3) await Bun.sleep(10_000);
	}
	if (markdown === null) {
		failed = true;
		console.error(`${docsMarkdownUrl(base)} could not be read, so /docs/ was not checked`);
	} else {
		for (const check of docsChecks(base, markdown)) await run(check);
		console.log(`/docs/ is ${JSON.stringify(documentTitle(describeMarkdown(markdown).title))}`);
	}
	if (failed) process.exit(1);
}
