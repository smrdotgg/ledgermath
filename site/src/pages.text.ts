// The site's pages that are not documentation: where each is built, its title, and its fixed
// words, the text it shows whatever the tree it is built from. `bun run check`
// (scripts/check-output.ts) fails unless each page's built HTML holds every one of its words in its
// body, outside any script, which shows the prerender ran and the page reads with JavaScript off;
// scripts/check-live.ts asks the same of the pages as served. Change these with the pages. The
// documentation's pages are made from Markdown at build time (scripts/docs.ts); their fixed words
// are the header's and footer's (HEADER_AND_FOOTER), their title and their description, read back
// from the built site (scripts/site-pages.ts).
//
// And where a link may leave the site: the data API (API_ORIGIN), the repository's files on GitHub
// (REPOSITORY_FILES), which the documentation links to, and the addresses OUTSIDE_LINKS names
// whole. The same check fails on a link anywhere else.
//
// And each page's feature flags (`flags`): parts it shows only when its address asks for them.
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
	/**
	 * Its feature flags. A flag is a part of the page that is in its HTML but not shown: with
	 * ?NAME in the page's address, Document.tsx's script sets data-NAME on <html>, and site.css
	 * shows the part. To show the part to everyone, remove the rule that hides it and the flag.
	 */
	flags?: readonly string[];
	/** A documentation page's Markdown, which the host serves at this address. */
	markdown?: string;
};

/** The data API: a page may link to any address under it. */
export const API_ORIGIN = "https://api.ledgermath.com/";

/** The repository on GitHub. */
export const REPOSITORY_URL = "https://github.com/smrdotgg/ledgermath";

/**
 * A file or a directory of the repository, on main, as GitHub shows it: a documentation page links
 * the files it describes (a benchmark's README links its sources relatively, and the build makes
 * each such link one of these), and a page may link to any address under these two, of a file
 * the repository has.
 */
export const REPOSITORY_FILES: readonly string[] = [`${REPOSITORY_URL}/blob/main/`, `${REPOSITORY_URL}/tree/main/`];

/** Napkin Math, by Simon Eskildsen: the project LedgerMath began from, which the home page credits. */
export const NAPKIN_MATH = "https://github.com/sirupsen/napkin-math";

/**
 * Every other address outside the site that a page may link to, each whole: a link anywhere else
 * than these, the data API and the repository's files, fails `bun run check`.
 */
export const OUTSIDE_LINKS: readonly string[] = [NAPKIN_MATH];

/** The words of the header and footer every page has. */
export const HEADER_AND_FOOTER: readonly string[] = ["LedgerMath", "Numbers", "Docs", "API", "Prices", "Licences"];

export const HOME: SitePage = {
	path: "/",
	file: "index.html",
	title: "LedgerMath: independent cloud benchmarks",
	description: "Open-source benchmarks, run on real cloud machines every day. Every number links to the Runs behind it.",
	text: [
		...HEADER_AND_FOOTER,
		"Continuous Napkin",
		"Math",
		"Open-source benchmarks, run on real cloud machines every day.",
		"Inspired by Simon Eskildsen's Napkin Math",
		"All benchmarks",
		"Each number is a median and links to the Runs behind it.",
		...new Set(HEADLINE_CHOICES.map((choice) => choice.section)),
		...HEADLINE_CHOICES.map((choice) => choice.label),
		"LedgerMath began as a port of Simon Eskildsen's Napkin Math",
	],
	// napkin: the closing note under the table, with a napkin drawn beside it (home/napkin.tsx).
	flags: ["napkin"],
};

/** The pages that are not documentation, which the build renders besides the documentation's, and whose figures `bun run check` holds to the tree (scripts/check-figures.ts). */
export const PAGES: readonly SitePage[] = [HOME];
