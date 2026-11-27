/**
 * The documentation's pages of a built site, read back from what the build wrote: llms.txt lists
 * each page by its Markdown, and the Markdown gives its title and description. The checks
 * (check-output.ts, check-browser.ts) know the documentation this way, from the site itself,
 * since the pages are made from Markdown at build time and are not listed in src/pages.text.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { documentTitle } from "../src/docs/sections";
import { HEADER_AND_FOOTER, type SitePage } from "../src/pages.text";
import { describeMarkdown, pageFile, readLlmsTxt, SITE_ORIGIN } from "./docs";

/** The index of the documentation for agents, at the site's root. */
export const LLMS_TXT = "llms.txt";

/** A page's address from its Markdown file's: docs/glossary.md is /docs/glossary, docs/api/index.md /docs/api/. */
export const addressOfMarkdown = (file: string): string => (file.endsWith("/index.md") ? `/${file.slice(0, -"index.md".length)}` : `/${file.slice(0, -".md".length)}`);

/**
 * Each documentation page of the site in DIR, in llms.txt's order, as SitePage: its address, file,
 * <title>, description, its fixed words (the header's and footer's, its title and its
 * description) and its Markdown's address; and what is wrong with the listing.
 */
export function docsPages(dir: string): { pages: SitePage[]; problems: string[] } {
	const problems: string[] = [];
	const llms = join(dir, LLMS_TXT);
	if (!existsSync(llms)) return { pages: [], problems: [`${LLMS_TXT} is missing: the build writes it, with the documentation`] };
	const pages: SitePage[] = [];
	for (const { title: listed, url } of readLlmsTxt(readFileSync(llms, "utf8"))) {
		if (!url.startsWith(`${SITE_ORIGIN}/`)) continue; // checkDocs says so
		const markdown = url.slice(SITE_ORIGIN.length);
		const file = markdown.slice(1);
		if (!existsSync(join(dir, file))) {
			problems.push(`${LLMS_TXT} lists ${url}, and the site has no ${file}`);
			continue;
		}
		const described = describeMarkdown(readFileSync(join(dir, file), "utf8"), file);
		problems.push(...described.problems);
		if (described.title !== listed) problems.push(`${LLMS_TXT} calls ${file} ${JSON.stringify(listed)}, and its title is ${JSON.stringify(described.title)}`);
		const address = addressOfMarkdown(file);
		pages.push({
			path: address,
			file: pageFile(address),
			title: documentTitle(described.title),
			description: described.description,
			text: [...HEADER_AND_FOOTER, described.title, described.description],
			markdown,
		});
	}
	return { pages, problems };
}
