// The site as one Solid application: the same component the build renders each page with
// (src/entry-server.tsx) and the browser hydrates (src/entry-client.tsx). Solid Router
// (@solidjs/router 2) does the navigation: a click on a link to another page of the site renders
// that page here, with no request, from what the application already holds; with JavaScript off
// the same link is an ordinary link to a complete page (ADR-0036).
//
// Everything a page shows is in the application: the components, and the figures, which are
// compiled in at build time (__PAGE_DATA__, src/data's pageData, the JSON every page was
// rendered from). So nothing is fetched after the first load, and a tab open across a deploy
// keeps working: it never asks for a file the deploy took away. What it shows after a click is
// the build it loaded, figures included, until the reader loads a page again.
//
// The router leaves some links to the browser: those to another origin, with a target, with
// download, or clicked with a modifier key or another button than the first. The site gives
// target="_self" to its links that are not page changes (a place on the same page, a file that
// is not a page), and `bun run check` holds every such link to it (scripts/check-output.ts).
import { createRouter, useBeforeLeave, useLocation, useRouteMatches } from "@solidjs/router";
import { createEffect } from "solid-js";
import { type JSX, useHead } from "@solidjs/web";
import type { PageData } from "./data";
import DocsPage from "./docs/Page";
import HomePage from "./home/Page";
import { DOCS, HOME, PAGES, type SitePage } from "./pages.text";

/** What the pages render: scripts/build.ts compiles it in (Vite's `define`) from the tree the site is built from. */
declare const __PAGE_DATA__: PageData;
const data: PageData = __PAGE_DATA__;

/** A page's route: its address, and its file, which the host serves at its own address too (/docs/index.html). */
const route = (page: SitePage, component: () => JSX.Element) => ({ path: [page.path, `/${page.file}`], component, info: { page } });

export const Router = createRouter({
	routes: [route(HOME, () => <HomePage data={data} />), route(DOCS, () => <DocsPage data={data} />)],
	// Back and forward restore the scroll position as the browser does for any page: a page here
	// renders in the same task as its address changes, so the browser's own restoration finds it.
	// The router's (on by default) saves a position only from a scroll event, so going back to a
	// page the reader never scrolled left it where the page after it was (ADR-0036).
	scrollRestoration: false,
});

/** Every feature flag of every page (pages.text.ts). */
const FLAGS = [...new Set(PAGES.flatMap((page) => page.flags ?? []))];

/**
 * Around every page: what a page load would give and a page change inside the application does
 * not, by itself.
 */
function Layout(props: { children?: JSX.Element }) {
	const location = useLocation();
	const matches = useRouteMatches();
	const page = (): SitePage | undefined => matches().at(-1)?.route.info?.page;

	// The page's <title> and description: Solid's own head registry, which the build's render
	// writes into the HTML and which changes them in the browser with the page.
	useHead(() => {
		const p = page();
		return p
			? [
					{ tag: "title", props: { children: p.title } },
					{ tag: "meta", props: { name: "description", content: p.description } },
				]
			: [];
	});

	// The page's feature flags (pages.text.ts), as the inline script in Document.tsx sets them on a
	// page load: data-NAME on <html> when the page has the flag and its address asks for it.
	createEffect(
		() => [page()?.flags ?? [], location.search] as const,
		([flags, search]) => {
			const query = new URLSearchParams(search);
			for (const flag of FLAGS) {
				if (flags.includes(flag) && query.has(flag)) document.documentElement.dataset[flag] = "";
				else delete document.documentElement.dataset[flag];
			}
		},
	);

	// After a page change, the keyboard focus starts again at the top of the page, as after a page
	// load, and a screen reader is told the new page's title, which a page load would read out.
	// (Solid Router has no answer of its own for this; this is SvelteKit's.)
	let announcer!: HTMLParagraphElement;
	createEffect(
		() => location.pathname,
		() => {
			announcer.textContent = page()?.title ?? "";
			const body = document.body;
			body.tabIndex = -1;
			body.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
			body.removeAttribute("tabindex");
		},
		{ defer: true },
	);

	// An address no route knows (a link that should have had target="_self", say) goes to the
	// browser, which loads whatever the host has there, instead of an empty page here.
	useBeforeLeave((e) => {
		if (typeof e.to === "string" && Router.match(e.to).length === 0) {
			e.preventDefault();
			window.location.assign(e.to);
		}
	});

	return (
		<>
			{props.children}
			<p class="announcer" aria-live="polite" ref={announcer} />
		</>
	);
}

/** The application: on the server, rendered for URL; in the browser, at the browser's address. */
export function App(props: { url?: string }) {
	return <Router url={props.url}>{(route) => <Layout>{route.children}</Layout>}</Router>;
}
