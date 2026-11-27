// The server entry the build renders the site with (scripts/build.ts): each page, the application
// (src/app.tsx) at the page's address inside its Document, rendered once to static HTML with
// Solid's server renderer. The HTML is the whole page, and it reads the same with JavaScript off;
// in the browser the application hydrates it (src/entry-client.tsx) and does the navigation from
// then on. What the pages show is compiled into this bundle as into the browser's (pageData, and
// the documentation's pages, virtual:ledgermath-docs).
//
// A documentation page's body is a lazy() component (src/app.tsx). Every one is loaded before
// any page is rendered, so the render is the plain synchronous one; and the render is given the
// browser's build manifest (virtual:solid-manifest, from Solid's Vite plugin), so that it names in
// the page the chunk its body is in: a modulepreload in <head>, and the module hydration imports
// before it takes the page over.
import { renderToString } from "@solidjs/web";
import manifest from "virtual:solid-manifest";
import { DOC_BODIES, DOC_PAGES } from "virtual:ledgermath-docs";
import { App, docSitePage } from "./app";
import Document from "./Document";
import { PAGES, type SitePage } from "./pages.text";

/** Each page's HTML: the pages of PAGES, then the documentation's, in its navigation's order. */
export type RenderedSite = { page: SitePage; html: string }[];

export async function render(): Promise<RenderedSite> {
	await Promise.all(Object.values(DOC_BODIES).map((body) => body.preload()));
	return [...PAGES, ...DOC_PAGES.map(docSitePage)].map((page) => ({
		page,
		html: renderToString(
			() => (
				<Document flags={page.flags}>
					<App url={page.path} />
				</Document>
			),
			{ manifest },
		),
	}));
}
