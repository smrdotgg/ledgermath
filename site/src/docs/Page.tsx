// The documentation's placeholder, at /docs/: the documentation is not written yet, and every
// link to it (the header's and footer's "Docs", each benchmark's name on the home page) comes
// here until it is (see src/data/headline.ts). It is meant to look like a placeholder: the
// site's header, type and colours, a heading, and plain sentences that are true, with no date
// and no list of sections that do not exist. Its words are in ../pages.text.ts too.
import type { PageData } from "../data";
import { Footer, Header } from "../chrome";

export default function DocsPage(props: { data: PageData }) {
	const links = props.data.links;
	return (
		<>
			<Header links={links} />

			<main class="wrap">
				<div class="hero">
					<div class="claim">
						<h1>
							<span class="line">Documentation</span>
						</h1>
						<p class="sub">The documentation is being written.</p>
						<p class="sub">Until it is here, the data API describes itself.</p>
						{/* Each link a paragraph of its own: the design's links are quiet until pointed at, so none sits inside a sentence. */}
						<p class="sub">
							<a href={links.index}>The data API's table of contents</a>
						</p>
						<p class="sub">
							<a href={links.home}>Back to the home page</a>
						</p>
					</div>
				</div>
			</main>

			<Footer links={links} />
		</>
	);
}
