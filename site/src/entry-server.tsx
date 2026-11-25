// The server entry the build renders the site with (scripts/build.ts): each page, its Document
// around it, rendered once to static HTML with Solid's server renderer, from one tree of the data
// API. Nothing hydrates: the HTML is the page, and it reads the same with JavaScript off.
import { renderToString } from "@solidjs/web";
import type { JSX } from "@solidjs/web";
import { siteData } from "./data";
import type { Tree } from "./data/tree";
import DocsPage from "./docs/Page";
import Document from "./Document";
import HomePage from "./home/Page";
import { DOCS, HOME, type SitePage } from "./pages.text";

export type RenderedSite = {
	/** Each page's HTML, by its file in the built site, in the order of PAGES. */
	pages: { page: SitePage; html: string }[];
	/** What the tree lacks and the pages leave out, one line each (siteData's notes). */
	notes: readonly string[];
};

export function render(tree: Tree): RenderedSite {
	const data = siteData(tree);
	const page = (meta: SitePage, body: () => JSX.Element) => ({
		page: meta,
		html: renderToString(() => (
			<Document title={meta.title} description={meta.description} flags={meta.flags}>
				{body()}
			</Document>
		)),
	});
	return {
		pages: [page(HOME, () => <HomePage data={data} />), page(DOCS, () => <DocsPage data={data} />)],
		notes: data.notes,
	};
}
