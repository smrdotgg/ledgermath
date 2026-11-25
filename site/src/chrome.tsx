// The header and footer every page has, as design v9 draws them (src/home/Page.tsx). Their
// links come from the data module's `links`: the site's own pages and the API's addresses.
import type { SiteLinks } from "./data";

export function Header(props: { links: SiteLinks; current?: "docs" }) {
	return (
		<header class="wrap">
			<a class="mark" href={props.links.home}>
				LedgerMath
			</a>
			<nav aria-label="Site">
				<a href={props.links.numbers}>Numbers</a>
				<a href={props.links.docs} aria-current={props.current === "docs" ? "page" : undefined}>
					Docs
				</a>
				<a href={props.links.index}>API</a>
			</nav>
		</header>
	);
}

export function Footer(props: { links: SiteLinks }) {
	return (
		<footer class="wrap">
			<a href={props.links.docs}>Docs</a>
			<a href={props.links.index}>API</a>
			<a href={props.links.prices}>Prices</a>
			<a href={props.links.licences}>Licences</a>
		</footer>
	);
}
