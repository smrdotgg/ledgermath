// The server entry the build renders the site with (scripts/build.ts): each page, the application
// (src/app.tsx) at the page's address inside its Document, rendered once to static HTML with
// Solid's server renderer. The HTML is the whole page, and it reads the same with JavaScript off;
// in the browser the application hydrates it (src/entry-client.tsx) and does the navigation from
// then on. What the pages show is compiled into this bundle as into the browser's (pageData).
import { renderToString } from "@solidjs/web";
import { App } from "./app";
import Document from "./Document";
import { PAGES, type SitePage } from "./pages.text";

/** Each page's HTML, in the order of PAGES. */
export type RenderedSite = { page: SitePage; html: string }[];

export function render(): RenderedSite {
	return PAGES.map((page) => ({
		page,
		html: renderToString(() => (
			<Document flags={page.flags}>
				<App url={page.path} />
			</Document>
		)),
	}));
}
