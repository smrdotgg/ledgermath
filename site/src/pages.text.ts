// The site's pages: where each is built, its title, and its fixed words, the text it shows
// whatever the tree it is built from. `bun run check` (scripts/check-output.ts) fails unless
// each page's built HTML holds every one of its words in its body, outside any script, which
// shows the prerender ran and the page reads with JavaScript off; scripts/check-live.ts asks
// the same of the pages as served. Change these with the pages.
//
// Plain TypeScript with no JSX, so the scripts can import it without the build.

import { HEADLINE_CHOICES } from "./data/headline";

export type SitePage = {
	/** The address the page is served at. */
	path: string;
	/** Its file in the built site. */
	file: string;
	title: string;
	description: string;
	/** Its fixed words. */
	text: readonly string[];
};

const HEADER_AND_FOOTER = ["LedgerMath", "Numbers", "Docs", "API", "Prices", "Licences"];

export const HOME: SitePage = {
	path: "/",
	file: "index.html",
	title: "LedgerMath: independent cloud benchmarks",
	description: "Open-source benchmarks, run on real cloud machines every day. Every number links to the Runs behind it.",
	text: [
		...HEADER_AND_FOOTER,
		"Independent Cloud",
		"Benchmarks",
		"Open-source benchmarks, run on real cloud machines every day.",
		"All benchmarks",
		"Each number is a median and links to the Runs behind it.",
		...new Set(HEADLINE_CHOICES.map((choice) => choice.section)),
		...HEADLINE_CHOICES.map((choice) => choice.label),
	],
};

export const DOCS: SitePage = {
	path: "/docs/",
	file: "docs/index.html",
	title: "LedgerMath: documentation",
	description: "LedgerMath's documentation is being written. Until it is here, the data API describes itself.",
	text: [
		...HEADER_AND_FOOTER,
		"Documentation",
		"The documentation is being written.",
		"Until it is here, the data API describes itself.",
		"The data API's table of contents",
		"Back to the home page",
	],
};

/** Every page the build writes, in order. */
export const PAGES: readonly SitePage[] = [HOME, DOCS];
