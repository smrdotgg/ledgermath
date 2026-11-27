/**
 * The Build Output API's config.json for a built site (deploy.sh writes it beside the files):
 * Vercel serves the files as they are, and these routes add, for the documentation's pages:
 *
 *  - each page's Markdown, which the build writes beside it (docs/glossary.md beside
 *    docs/glossary/index.html; docs/api/index.md in docs/api/), served as text/markdown;
 *  - the same Markdown at the page's own address when the request asks for it with
 *    `Accept: text/markdown` at full weight (no q, or q=1), as an agent does; any other Accept
 *    (a browser's, any type at all, text/markdown at a lower weight than HTML) gets the HTML;
 *  - Vary: Accept on every answer at a page's address, so that a cache keeps the two apart.
 *
 * One route per page, read from the files: a page's address may end in a slash or not, and only
 * the files say which Markdown is its. A page without its Markdown would answer an agent's request
 * with 404, so a documentation page without one stops the deploy (exit 1). An earlier experiment on
 * a prebuilt Vercel deployment found the rest: Vary has to be added by a route, and Vercel honours
 * `has` on the Accept header with a regular expression.
 *
 *     bun site/deploy/vercel-config.ts SITE_DIR > config.json
 *
 * Self-contained, with no import from the site, so that deploy.sh's tests can copy it beside it.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Accept asking for Markdown at full weight: text/markdown, alone or first in a list, with no q or q=1. */
export const ACCEPTS_MARKDOWN = "text/markdown\\s*(?:;\\s*q\\s*=\\s*1(?:\\.0*)?\\s*)?(?:,|$)";

const MARKDOWN_TYPE = "text/markdown; charset=utf-8";

type Route = Record<string, unknown>;

/** A string as a regular expression that matches it alone. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function files(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
}

/** Each documentation page of the site in SITE: its address and its Markdown's; and each page that has no Markdown. */
export function documentationPages(site: string): { pages: { address: string; markdown: string }[]; missing: string[] } {
	const all = new Set(files(site).map((file) => relative(site, file).split(sep).join("/")));
	const pages: { address: string; markdown: string }[] = [];
	const missing: string[] = [];
	for (const file of [...all].sort()) {
		const match = /^(docs(?:\/.+)?)\/index\.html$/.exec(file);
		if (!match) continue;
		const directory = match[1]!;
		// /docs/api/ has docs/api/index.md in it; /docs/glossary has docs/glossary.md beside it.
		if (all.has(`${directory}/index.md`)) pages.push({ address: `/${directory}/`, markdown: `/${directory}/index.md` });
		else if (all.has(`${directory}.md`)) pages.push({ address: `/${directory}`, markdown: `/${directory}.md` });
		else missing.push(file);
	}
	return { pages, missing };
}

/** The address of a page in every form the host serves it at: /docs/api, /docs/api/ and /docs/api/index.html. */
const forms = (address: string) => {
	const bare = address.replace(/\/$/, "");
	return `${literal(bare)}(?:/|/index\\.html)?`;
};

/** The config.json for the documentation's PAGES. */
export function vercelConfig(pages: readonly { address: string; markdown: string }[]): { version: 3; routes: Route[] } {
	const routes: Route[] = [];
	if (pages.length > 0) {
		routes.push({ src: "^/docs/.+\\.md$", headers: { "Content-Type": MARKDOWN_TYPE }, continue: true });
		routes.push({ src: `^(?:${pages.map((page) => forms(page.address)).join("|")})$`, headers: { Vary: "Accept" }, continue: true });
		for (const page of pages) {
			routes.push({
				src: `^${forms(page.address)}$`,
				has: [{ type: "header", key: "accept", value: { re: ACCEPTS_MARKDOWN } }],
				dest: page.markdown,
				headers: { "Content-Type": MARKDOWN_TYPE, Vary: "Accept" },
			});
		}
	}
	return { version: 3, routes };
}

if (import.meta.main) {
	const site = process.argv[2];
	if (!site || !existsSync(join(site, "index.html"))) {
		console.error("usage: bun site/deploy/vercel-config.ts SITE_DIR (a built site, with its index.html)");
		process.exit(2);
	}
	const { pages, missing } = documentationPages(site);
	if (missing.length > 0) {
		console.error(`these documentation pages have no Markdown beside them, and would answer Accept: text/markdown with 404: ${missing.join(", ")}`);
		process.exit(1);
	}
	console.log(JSON.stringify(vercelConfig(pages), null, 2));
}
