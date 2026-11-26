// The header and footer every page has, as design v9 draws them (src/home/Page.tsx). Their
// links come from the data module's `links`: the site's own pages and the API's addresses.
//
// The router marks every link to the page on screen with aria-current="page" (and data-active),
// in the built HTML and after each click, so the header's "Docs" says it is the page on /docs/
// without a word here. A link that is not a page change carries target="_self", which tells the
// router to leave it to the browser (src/app.tsx; `bun run check` holds every such link to it).
import { useLocation } from "@solidjs/router";
import type { PageData } from "./data";

export function Header(props: { links: PageData["links"] }) {
	// "Numbers" is a place on the home page. While the address on screen is that page's own (the
	// same path and query, only the fragment to come), it is the browser's jump, which moves the
	// reader and the keyboard focus to the table as on any page; from anywhere else (/docs/, or
	// /?napkin, which is another address) it is a page change like any other link. (The router's
	// useLinkState says the same, but brings its pending-navigation state, 7 KB, for one boolean.)
	const location = useLocation();
	const inPage = () => location.pathname + location.search === props.links.numbers.split("#")[0];
	return (
		<header class="wrap">
			<a class="mark" href={props.links.home}>
				LedgerMath
			</a>
			<nav aria-label="Site">
				<a href={props.links.numbers} target={inPage() ? "_self" : undefined}>
					Numbers
				</a>
				<a href={props.links.docs}>Docs</a>
				<a href={props.links.index}>API</a>
			</nav>
		</header>
	);
}

// "Licences" is a text file, not a page: target="_self" leaves it to the browser too.
export function Footer(props: { links: PageData["links"] }) {
	return (
		<footer class="wrap">
			<a href={props.links.docs}>Docs</a>
			<a href={props.links.index}>API</a>
			<a href={props.links.prices}>Prices</a>
			<a href={props.links.licences} target="_self">
				Licences
			</a>
		</footer>
	);
}
