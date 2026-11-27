/**
 * The Build Output API's config.json for a built site (deploy.sh writes it beside the files):
 * Vercel serves the files as they are, and these routes add, for the documentation's pages:
 *
 *  - each page's Markdown, which the build writes beside it (docs/glossary.md beside
 *    docs/glossary/index.html; docs/api/index.md in docs/api/), served as text/markdown;
 *  - the same Markdown at the page's own address when the request's Accept names text/markdown
 *    at full weight (ACCEPTS_MARKDOWN: with any parameters but a q below 1), as an agent does; any
 *    other Accept (a browser's, any type at all, text/markdown at a lower weight) gets the HTML;
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

/**
 * An Accept header that asks for Markdown at full weight: one of its media ranges, wherever it
 * stands in the list, is text/markdown (in any case) with any parameters (charset=utf-8 among
 * them) but a weight below 1: no q, or q=1, 1., 1.0, 1.00 or 1.000. Parameters as RFC 9110
 * writes them (sections 5.6.6 and 12.5.1): white space allowed around each ";" and none around a
 * parameter's "=" (text/markdown; charset = utf-8 gets the HTML), and a ";" with no parameter
 * after it allowed (text/markdown; and text/markdown; charset=utf-8; ask for Markdown); a value
 * is a quoted string or any run of other characters up to the next ";", "," or space. A media range starts after
 * a comma outside a quoted string: the expression reads the header from its start, range by
 * range, each a run of characters and quoted strings up to a comma, so text/markdown inside a
 * parameter's quoted value (note="text/markdown, plain") is no media range.
 *
 * Written with what any regular-expression engine has (no look-ahead), since the host matches it,
 * and so that no text can be matched by it in two ways, since it runs on every request: each
 * repeated part starts with a character that the part before it cannot end with (a range after a
 * comma, a parameter after a ";"), white space is matched only after a ";", after text/markdown
 * and after a parameter's value, where nothing else can take it, and alternatives start apart (a
 * quoted string with '"', which nothing else takes; a parameter named q with q alone before "=").
 * A header that would make a backtracking engine try many ways fails at once
 * (vercel-config.test.ts).
 */
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]";
const TOKEN_NOT_Q = "[!#$%&'*+.^_`|~0-9A-PR-Za-pr-z-]";
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';
const PARAMETER_NOT_Q = `(?:${TOKEN}{2,}|${TOKEN_NOT_Q})=(?:${QUOTED}|[^;,"\\s]*)`;
const FULL_WEIGHT = "[qQ]=1(?:\\.0{0,3})?";
export const ACCEPTS_MARKDOWN = `^(?:(?:[^",]|${QUOTED})*,)*\\s*[tT][eE][xX][tT]/[mM][aA][rR][kK][dD][oO][wW][nN]\\s*(?:;\\s*(?:(?:${FULL_WEIGHT}|${PARAMETER_NOT_Q})\\s*)?)*(?:,|$)`;

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
