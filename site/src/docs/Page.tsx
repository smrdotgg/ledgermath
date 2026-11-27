// Around every documentation page (src/app.tsx's /docs layout, which stays while the reader goes
// from page to page): the site's header and footer, where the page is, the two controls, the page's
// body (its HTML, rendered from its Markdown at build time: a lazy() component, the route's
// child), and every other page by section. All of it reads with JavaScript off but "Copy page",
// which needs the application: it is shown only once the application has taken the page over
// (data-hydrated on <html>, src/app.tsx; site.css), so the page as the build wrote it, or left
// static when its script cannot be loaded, never offers a button that does nothing.
//
// The page's body comes first in the document and the list of pages after it, which on a wide
// screen stands beside it (site.css): the keyboard and a screen reader meet the page before the
// list, and a phone shows the page at once, the list below it. "Docs" in the breadcrumb leads to
// /docs/, which lists every page too.
//
// No element here carries an id: the body's headings do (their anchors), and none may clash.
import { useLocation, useRouteMatches } from "@solidjs/router";
import { createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { DOC_PAGES } from "virtual:ledgermath-docs";
import { Footer, Header } from "../chrome";
import type { PageData } from "../data";
import { DOCS_HOME, SECTIONS } from "./sections";

/** Copies the Markdown at ADDRESS: fetched when asked, the one request the documentation makes after its first load but a chunk's. */
async function copyMarkdown(address: string): Promise<void> {
	const text = () =>
		fetch(address).then((response) => {
			if (!response.ok) throw new Error(`${address} answered ${response.status}`);
			return response.text();
		});
	// A ClipboardItem may hold a promise, which keeps the click's permission to write while the
	// Markdown is fetched (Safari requires that); where it cannot, the text once it has come.
	if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
		try {
			await navigator.clipboard.write([new ClipboardItem({ "text/plain": text().then((markdown) => new Blob([markdown], { type: "text/plain" })) })]);
			return;
		} catch {}
	}
	await navigator.clipboard.writeText(await text());
}

/** What "Copy page" says from the click until the copy has come to something. */
const COPYING = "Copying…";

export default function DocsShell(props: { data: PageData; children?: JSX.Element }) {
	const links = props.data.links;
	const location = useLocation();
	const matches = useRouteMatches();
	const meta = () => {
		const address = matches().at(-1)?.route.info?.page?.path as string | undefined;
		return DOC_PAGES.find((page) => page.address === address) ?? DOC_PAGES[0]!;
	};
	const section = () => SECTIONS.find((s) => s.id === meta().section)!;
	// What the copy is doing or came to, for the page it was asked on: said, and gone with the page.
	const [copied, setCopied] = createSignal<{ path: string; said: string } | null>(null);
	const copy = () => {
		// One copy a page: once anything is said, copying is disabled until another page;
		// aria-disabled keeps the button focused.
		if (said()) return;
		const path = location.pathname;
		// Said at the click, before the Markdown has been fetched: the click is answered at once.
		setCopied({ path, said: COPYING });
		// What it came to replaces that, unless a copy asked on another page has taken its place.
		const came = (said: string) => setCopied((now) => (now?.path === path ? { path, said } : now));
		copyMarkdown(meta().markdown).then(
			() => came("Copied the page's Markdown."),
			() => came("Could not copy: View as Markdown shows it."),
		);
	};
	const said = () => (copied()?.path === location.pathname ? copied()!.said : "");

	return (
		<>
			<Header links={links} />

			<div class="wrap docs">
				<main class="doc">
					<div class="doc-top">
						<nav class="crumbs" aria-label="Breadcrumb">
							<a href={DOCS_HOME}>Docs</a>
							<span>{section().title}</span>
						</nav>
						<p class="doc-actions">
							<a href={meta().markdown} target="_self">
								View as Markdown
							</a>
							<button type="button" class="copy" onClick={copy} aria-disabled={said() ? "true" : undefined}>
								Copy page
							</button>
							{/* A status, which a screen reader reads out when it changes; not an aria-live of its own beside Layout's (src/app.tsx). */}
							<span class="said" role="status">
								{said()}
							</span>
						</p>
					</div>
					{props.children}
				</main>

				<nav class="pages" aria-label="Documentation">
					{SECTIONS.map((s) => (
						<div class="pages-section">
							<p class="pages-title">{s.title}</p>
							<ul>
								{DOC_PAGES.filter((page) => page.section === s.id).map((page) => (
									<li>
										<a href={page.address}>{page.title}</a>
									</li>
								))}
							</ul>
						</div>
					))}
				</nav>
			</div>

			<Footer links={links} />
		</>
	);
}
