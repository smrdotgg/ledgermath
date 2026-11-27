// The site as one Solid application: the same component the build renders each page with
// (src/entry-server.tsx) and the browser hydrates (src/entry-client.tsx). Solid Router
// (@solidjs/router 2) does the navigation: a click on a link to another page of the site renders
// that page here, with no request, from what the application already holds; with JavaScript off
// the same link is an ordinary link to a complete page (ADR-0036).
//
// What the home page shows is in the application's one script: its components, and the figures,
// which are compiled in at build time (__PAGE_DATA__, src/data's pageData, the JSON every page was
// rendered from). The documentation's pages are routes of the same application, each page's body
// (its HTML, rendered from its Markdown at build time) a lazy() component in a chunk of its own
// (virtual:ledgermath-docs, ADR-0037). The router loads those chunks ahead: every link's on the
// page once it has loaded and the browser is idle (eagerPreload, which a reader who asks to save
// data, or is on a 2g connection, is spared), and a link's at once when the pointer rests on it,
// it takes the focus or a touch starts on it (intentPreload). So a click finds the next page
// already held, and fetches nothing. A chunk not yet loaded when its link is clicked is fetched
// then, and the page on screen stays until it has come; one that cannot be fetched sends the click
// to the browser, which loads the page whole (Layout's useBeforeLeave).
//
// What a page shows after a click is the build the tab loaded, figures included, until the reader
// loads a page again.
//
// The router leaves some links to the browser: those to another origin, with a target, with
// download, or clicked with a modifier key or another button than the first. The site gives
// target="_self" to its links that are not page changes (a place on the same page, a file that
// is not a page), and `bun run check` holds every such link to it (scripts/check-output.ts).
import { createRouter, eagerPreload, intentPreload, useBeforeLeave, useLocation, useRouteMatches } from "@solidjs/router";
import { createEffect, onSettled, untrack } from "solid-js";
import { isServer, type JSX, useHead } from "@solidjs/web";
import { DOC_BODIES, DOC_PAGES, LOADED } from "virtual:ledgermath-docs";
import type { PageData } from "./data";
import DocsShell from "./docs/Page";
import type { DocMeta } from "./docs/sections";
import HomePage from "./home/Page";
import { HOME, PAGES, type SitePage } from "./pages.text";

/** What the pages render: scripts/build.ts compiles it in (Vite's `define`) from the tree the site is built from. */
declare const __PAGE_DATA__: PageData;
const data: PageData = __PAGE_DATA__;

/** A page's route: its address, and its file, which the host serves at its own address too (/docs/index.html). */
const route = (page: SitePage, component: () => JSX.Element) => ({ path: [page.path, `/${page.file}`], component, info: { page } });

/** What Layout knows of a documentation page, as of any other: its address, its <title> and description, and its Markdown. */
export const docSitePage = (meta: DocMeta): SitePage => ({
	path: meta.address,
	file: meta.file,
	title: meta.documentTitle,
	description: meta.description,
	text: [],
	markdown: meta.markdown,
});

/** A documentation page's route, under /docs: its address and its file's (/glossary, /glossary/index.html), its body the lazy() component of its chunk. */
const docRoute = (meta: DocMeta) => ({
	path: [meta.address.slice("/docs".length), `/${meta.file.slice("docs/".length)}`],
	component: DOC_BODIES[meta.address]!,
	info: { page: docSitePage(meta) },
});

export const Router = createRouter({
	routes: [
		route(HOME, () => <HomePage data={data} />),
		// The documentation: one layout, the header, the navigation and the footer, which stays while
		// the reader goes from page to page, around each page's body.
		{ path: "/docs", component: (props: { children?: JSX.Element }) => <DocsShell data={data}>{props.children}</DocsShell>, children: DOC_PAGES.map(docRoute) },
	],
	// Each link's chunk, ahead of its click: see the comment at the top.
	preloadLinks: [eagerPreload({ all: true }), intentPreload()],
	// Back and forward restore the scroll position as the browser does for any page: a page here
	// renders in the same task as its address changes, so the browser's own restoration finds it.
	// The router's (on by default) saves a position only from a scroll event, so going back to a
	// page the reader never scrolled left it where the page after it was (ADR-0036).
	scrollRestoration: false,
});

/** Every feature flag of every page (pages.text.ts). */
const FLAGS = [...new Set(PAGES.flatMap((page) => page.flags ?? []))];

/**
 * The element an address's #fragment names, as the browser finds it (the id as written, then
 * decoded), or null. An address is anyone's to write: a fragment that does not decode (/#%)
 * names no element, and must not stop the navigation it comes with.
 */
function named(hash: string): HTMLElement | null {
	const raw = hash.slice(1);
	if (!raw) return null;
	const found = document.getElementById(raw);
	if (found) return found;
	try {
		return document.getElementById(decodeURIComponent(raw));
	} catch {
		return null;
	}
}

/**
 * Around every page: what a page load would give and a page change inside the application does
 * not, by itself.
 */
function Layout(props: { children?: JSX.Element }) {
	const location = useLocation();
	const matches = useRouteMatches();
	const page = (): SitePage | undefined => matches().at(-1)?.route.info?.page;

	// The page's <title> and description, and a documentation page's Markdown (llms.txt's
	// convention: an alternate of type text/markdown): Solid's own head registry, which the build's
	// render writes into the HTML and which changes them in the browser with the page.
	useHead(() => {
		const p = page();
		return p
			? [
					{ tag: "title", props: { children: p.title } },
					{ tag: "meta", props: { name: "description", content: p.description } },
					...(p.markdown ? [{ tag: "link" as const, props: { rel: "alternate", type: "text/markdown", href: p.markdown } }] : []),
				]
			: [];
	});

	// When the application has taken the page over (the mark scripts/check-browser.ts and
	// measure-navigation.ts wait for): once the first render has settled, which, on a documentation
	// page, is after its body's chunk has loaded (src/entry-client.tsx).
	onSettled(() => {
		performance.mark("hydrated");
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

	// After a page change, the keyboard focus starts again where a page load would start it: at the
	// element the address's #fragment names, else at the top of the page; and a screen reader is
	// told the new page's title, which a page load would read out. (Solid Router has no answer of
	// its own for this; this is SvelteKit's.) A change of the fragment alone is left as the browser
	// leaves it when it makes one (its own jump, for a link with target="_self", moves the focus;
	// back and forward between such entries do not); one made by the router is seen before it
	// happens, below.
	let announcer!: HTMLParagraphElement;
	const arrive = (hash: string = location.hash) => {
		announcer.textContent = page()?.title ?? "";
		const place = named(hash) || document.body;
		// Made focusable for the call when it is not (a heading, the body), as the browser treats a
		// fragment's target: the body gives it back at once, any other element when the focus leaves.
		const lent = !place.hasAttribute("tabindex") && place.tabIndex < 0;
		if (lent) place.tabIndex = -1;
		place.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
		if (lent && place === document.body) place.removeAttribute("tabindex");
		else if (lent) place.addEventListener("blur", () => place.removeAttribute("tabindex"), { once: true });
	};
	createEffect(() => location.pathname + location.search, () => arrive(), { defer: true });

	// The documentation page the application took over has its body loaded: hydration imported it.
	const landed = untrack(page);
	if (landed?.markdown && !isServer) LOADED.add(landed.path);

	useBeforeLeave((e) => {
		if (typeof e.to !== "string") return;
		const matched = Router.match(e.to);
		// An address no route knows (a link that should have had target="_self", say) goes to the
		// browser, which loads whatever the host has there, instead of an empty page here.
		if (matched.length === 0) {
			e.preventDefault();
			window.location.assign(e.to);
			return;
		}
		// A documentation page whose body this tab has not loaded yet (the router loads them ahead,
		// so only a click that came first, or a reader who asked to save data, meets one): it is
		// loaded first, the page on screen staying as it is, and the click then goes on; if it cannot
		// be loaded (a deploy since this tab opened has replaced it, or the network is down), the
		// browser loads the page whole, rather than the router stopping on the failed import.
		const target = matched.at(-1)?.info?.page as SitePage | undefined;
		if (target?.markdown && !LOADED.has(target.path)) {
			e.preventDefault();
			const to = e.to;
			DOC_BODIES[target.path]!.preload().then(
				() => e.retry(true),
				() => window.location.assign(to),
			);
			return;
		}
		const here = location.pathname + location.search;
		const cut = e.to.indexOf("#");
		const [path, hash] = cut < 0 ? [e.to, ""] : [e.to.slice(0, cut), e.to.slice(cut)];
		if (path !== here) return;
		if (hash === location.hash) {
			// A link to the address on screen, which the router leaves as it is: a document
			// navigation would load the page again, at its top (or its #fragment), with the focus there.
			const place = named(hash);
			if (place) place.scrollIntoView();
			else window.scrollTo(0, 0);
		}
		// The same page at another fragment, or at none (LedgerMath on /#numbers): the router scrolls
		// there, and the focus goes with it, where a document navigation would put it.
		arrive(hash);
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
