/**
 * The addresses of LedgerMath's documentation pages at https://ledgermath.com: the one list a
 * link from one page to another is held to (tests/api-reference.test.ts holds every generated
 * page to it). The API reference's pages are generated (scripts/lib/api-reference.ts); the
 * others are written by hand. A page added later is added here first.
 */

export const DOCS_ADDRESSES = [
	"/docs/",
	"/docs/api/",
	"/docs/api/table-of-contents",
	"/docs/api/series-list",
	"/docs/api/benchmark-list",
	"/docs/api/series",
	"/docs/api/series-month",
	"/docs/api/prices",
	"/docs/api/run",
	"/docs/api/events",
	"/docs/machines",
	"/docs/methods",
	"/docs/prices",
	"/docs/glossary",
] as const;

/** A benchmark's page: /docs/benchmarks/<benchmark>, the benchmark's name as its Runs give it. */
export const DOCS_BENCHMARK_ADDRESS = /^\/docs\/benchmarks\/[a-z][a-z0-9_]*$/;

/** Whether a link's target, without its #fragment, is a documentation page's address. */
export function isDocsAddress(target: string): boolean {
	const address = target.split("#")[0] ?? "";
	return (DOCS_ADDRESSES as readonly string[]).includes(address) || DOCS_BENCHMARK_ADDRESS.test(address);
}
