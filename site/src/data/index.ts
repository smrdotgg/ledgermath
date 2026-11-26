/**
 * LedgerMath's figures for the site's pages: one tree of the data API (./tree.ts), read at
 * build time, turned into what the pages show by siteData.
 *
 * RULES FOR EVERY PAGE THAT USES THIS MODULE
 *
 * 1. Every figure shown comes from here, exactly as the tree holds it. No page invents,
 *    estimates or computes a statistic: no averages across machines, no ratios (price per
 *    GB/s, "3.2× faster"), no rankings presented as findings, no trends, no "typical" values.
 *    The only arithmetic allowed is a change of unit (bytes to GB, nanoseconds to
 *    milliseconds), and the helpers in ./figures do it exactly, on the decimal text. One
 *    division is allowed, because it is a change of unit too: a figure of one repetition
 *    divided by a headline choice's `per.count` when that is a power of ten (one repetition of
 *    mutex is 10,000 critical sections), with `perUnit` or `formatDurationPerUnit`. No other
 *    division, by anything.
 * 2. Figures are exact. A helper's `short` form is rounded for scanning; when a page shows
 *    it, the page gives `full` too (a `title` attribute, a second line, a footnote). Nothing
 *    is rounded silently.
 * 3. "The home table" is the headline selection (./headline): one Series per benchmark and
 *    machine type, chosen by a written rule. A page may show more Series beside it, never
 *    other figures for its rows. A cell whose Series the tree lacks shows no figure, and
 *    says so; it is never filled from elsewhere.
 * 4. Links go to the addresses in `links`: the API's, which the tree itself gives (each
 *    row's `url` too), and the site's own (the home page, its table, the notices, and the
 *    documentation, a placeholder at /docs/ for now: see ./headline). Nothing else comes from
 *    this module: it names no other project, and no link of its goes to the source repository.
 *    A link that leaves the site is named in ../pages.text (OUTSIDE_LINKS) and used by the page
 *    that has it, and `bun run check` fails on any link that is neither inside the site, nor
 *    under https://api.ledgermath.com/, nor exactly one of those.
 * 5. siteData runs at build time only, on the build's side (scripts/build.ts). What the pages
 *    render goes through pageData, which keeps only what they show, as plain JSON: the build
 *    renders every page from that JSON, and compiles the same JSON into the application the
 *    browser loads (src/app.tsx), so a page the browser renders after a click is the page the
 *    build wrote, figure for figure. Nothing else of the tree reaches the browser.
 */

import { benchmarkDocsUrl, DOCS_URL, HEADLINE_CHOICES, type HeadlineChoice } from "./headline";
import type { PriceFile, SeriesRow, Tree } from "./tree";

export * from "./figures";
export { benchmarkDocsUrl, DOCS_URL, GRAPH_BENCHMARKS, HEADLINE_CHOICES, plannedBenchmarkDocsUrl } from "./headline";
export type { HeadlineChoice, Section } from "./headline";
export type { Percentiles, SeriesRow, Tree } from "./tree";

// ---------------------------------------------------------------- what siteData gives

export type Machine = {
	/** "m5.large" */
	instanceType: string;
	/** The facts AWS's price list gives for the type, as text, exactly as the price file holds them. */
	vcpu: string;
	memory: string;
	processor: string;
	/** The hourly On-Demand Linux price, from the newest price file. */
	price: {
		/** As the price file writes it: "0.0960000000" (US dollars per hour). See formatUsd. */
		usdPerHour: string;
		/** AWS's own words: "$0.096 per On Demand Linux m5.large Instance Hour". */
		description: string;
		unit: string;
		sku: string;
		rateCode: string;
		effectiveDate: string;
	};
	/** Every Series of the tree measured on this type. */
	series: SeriesRow[];
};

/**
 * The figure that leads a headline cell (./headline's `lead`): the median rate, or the median
 * time of one repetition, with its 5th and 95th percentiles and how many Runs they rest on. A
 * percentile the tree gives as null (infinite or undefined) is null here too.
 */
export type LeadFigure = { kind: "rate" | "time"; p5: number | null; p50: number; p95: number | null; count: number };

export type HeadlineCell = {
	machine: Machine;
	/** The one Series the choice selects on this machine type, or null when the tree has none. */
	series: SeriesRow | null;
	/** The Series' lead figure, or null when the cell has none to show. */
	figure: LeadFigure | null;
	/** Why the cell has no figure, in words the page puts in the dash's title; null when it has one. */
	absent: string | null;
};

export type HeadlineRow = {
	choice: HeadlineChoice;
	/** One cell per machine type, in the order of `machines`. */
	cells: HeadlineCell[];
};

/** One round of boots, newest first, as the table of contents' recent_rounds gives it. */
export type Round = {
	/** When the round's first boot started (UTC, to the nanosecond). */
	startedAt: string;
	/** Boots in the round: one machine each. */
	boots: number;
	runs: number;
	failedRuns: number;
};

export type SiteLinks = {
	/** The site's own pages and files. */
	home: string;
	/** The home page's table. */
	numbers: string;
	/** The notices of what the site ships (public/third-party-notices.txt). */
	licences: string;
	/** The documentation (./headline). */
	docs: string;
	/** Where a benchmark's name links (./headline). */
	benchmarkDocs: (benchmark: string) => string;
	/** The API's table of contents, as the tree gives its own address. */
	index: string;
	/** Every Series in one file. */
	seriesList: string;
	/** The newest price file. */
	prices: string;
	/** One Series' own file (each row's `url`). */
	seriesFile: (row: SeriesRow) => string;
};

export type SiteData = {
	/** Every Series in the tree, as its Series list gives them. */
	series: readonly SeriesRow[];
	/** The machine types the newest price file names, cheapest first by their hourly price (an ordering, not a statistic). */
	machines: readonly Machine[];
	/** The home table: one row per headline choice, each with one cell per machine type. */
	headline: readonly HeadlineRow[];
	/** The latest rounds of boots, newest first; null when the tree's table of contents gives none. */
	rounds: readonly Round[] | null;
	/** The region the price file was cut for, and the Series ran in. */
	region: string;
	/** When the tree's newest Run started (UTC, to the nanosecond); null when the tree has no Series. */
	newestRunStartedAt: string | null;
	/** The newest price file's date. */
	priceDate: string;
	links: SiteLinks;
	/** What the build should say about the tree: what the page leaves out, and why. One line each. */
	notes: readonly string[];
};

// ---------------------------------------------------------------- helpers

/** True when the row's params include every one of `params`, with the same value. */
export function hasParams(row: SeriesRow, params: Record<string, unknown>): boolean {
	return Object.entries(params).every(([key, value]) => row.params[key] === value);
}

/** How a page says a percentile the data give as null (the schema's words for what null means). */
export const NO_PERCENTILE = "infinite or undefined";

/** The figure that leads a headline cell, as the rule in ./headline names it, or null when the Series has no median to show. */
export function leadFigure(choice: HeadlineChoice, row: SeriesRow): LeadFigure | null {
	const p = row.derivations.series_v1.percentiles;
	const figure = choice.lead === "rate" ? p.bytes_per_second : p.time_per_repetition_ns;
	if (!figure || figure.p50 === null) return null;
	return { kind: choice.lead, p5: figure.p5, p50: figure.p50, p95: figure.p95, count: figure.count };
}

/**
 * Why a Series has no lead figure, in the schema's own terms (series-list.schema.json): the time
 * is null when no Run counts; the rate when no counted Run observed bytes per repetition; a
 * median when it is infinite or undefined. Null when it has one.
 */
export function whyNoFigure(choice: HeadlineChoice, row: SeriesRow): string | null {
	const p = row.derivations.series_v1.percentiles;
	const figure = choice.lead === "rate" ? p.bytes_per_second : p.time_per_repetition_ns;
	if (!figure) return choice.lead === "rate" ? "no counted Run of this Series observed bytes per repetition" : "no Run of this Series counts yet";
	if (figure.p50 === null) return "the data give this Series' median as null: infinite or undefined";
	return null;
}

function machine(prices: PriceFile, instanceType: string, series: readonly SeriesRow[]): Machine {
	const file = "the newest price file";
	const source = prices.sources.find((s) =>
		s.selections.some((selection) => selection.rule === "ec2-instance-on-demand-linux" && selection.skus.some((sku) => s.products[sku]?.attributes.instanceType === instanceType)),
	);
	if (!source) throw new Error(`${file} has no On-Demand Linux product for ${instanceType}`);
	const products = Object.values(source.products).filter((p) => p.attributes.instanceType === instanceType && p.attributes.operatingSystem === "Linux");
	if (products.length !== 1) throw new Error(`${file} has ${products.length} Linux products for ${instanceType}, not one`);
	const product = products[0]!;
	const terms = Object.values(source.terms.OnDemand[product.sku] ?? {});
	const dimensions = terms.flatMap((term) => Object.values(term.priceDimensions).map((dimension) => ({ term, dimension })));
	if (dimensions.length !== 1) throw new Error(`${instanceType} has ${dimensions.length} On-Demand price dimensions in ${file}, not one`);
	const { term, dimension } = dimensions[0]!;
	if (dimension.unit !== "Hrs") throw new Error(`${instanceType}'s On-Demand price is per ${dimension.unit} in ${file}, not per hour`);
	if (typeof dimension.pricePerUnit?.USD !== "string" || !/^\d+(\.\d+)?$/.test(dimension.pricePerUnit.USD)) {
		throw new Error(`${instanceType}'s On-Demand price in ${file} is not a decimal in US dollars: ${JSON.stringify(dimension.pricePerUnit?.USD)}`);
	}
	const a = product.attributes;
	return {
		instanceType,
		vcpu: a.vcpu ?? "",
		memory: a.memory ?? "",
		processor: a.physicalProcessor ?? "",
		price: {
			usdPerHour: dimension.pricePerUnit.USD,
			description: dimension.description,
			unit: dimension.unit,
			sku: product.sku,
			rateCode: dimension.rateCode,
			effectiveDate: term.effectiveDate,
		},
		series: series.filter((row) => row.instance_type === instanceType),
	};
}

// ---------------------------------------------------------------- siteData

/** Everything the pages show, from TREE. Throws when the tree contradicts itself; see `notes` for what it lacks. */
export function siteData(tree: Tree): SiteData {
	const notes: string[] = [];
	const series = tree.seriesList.series;

	for (const row of series) {
		if (!row.url.startsWith(tree.base)) throw new Error(`Series ${row.id}'s address ${row.url} is not under the tree's base ${tree.base}`);
	}

	const machines = tree.prices.measured.instance_types
		.map((type) => machine(tree.prices, type, series))
		.sort((a, b) => Number(a.price.usdPerHour) - Number(b.price.usdPerHour) || a.instanceType.localeCompare(b.instanceType));
	for (const m of machines) if (m.series.length === 0) notes.push(`no Series ran on ${m.instanceType}: its column shows a dash in every cell`);
	const unpriced = [...new Set(series.flatMap((row) => (row.instance_type === null ? [] : [row.instance_type])))].filter((type) => !machines.some((m) => m.instanceType === type)).sort();
	if (unpriced.length > 0) notes.push(`Series ran on ${unpriced.join(", ")}, which the newest price file does not price: the table leaves them out`);
	const untyped = series.filter((row) => row.instance_type === null);
	if (untyped.length > 0) notes.push(`${untyped.length} Series name no instance type (${untyped.map((row) => row.id).join(", ")}): they stand under no machine type, and the table leaves them out`);

	const unchosen = [...new Set(series.map((row) => row.benchmark))].filter((name) => !HEADLINE_CHOICES.some((c) => c.benchmark === name)).sort();
	if (unchosen.length > 0) notes.push(`no headline choice in src/data/headline.ts for ${unchosen.join(", ")}: the table leaves them out`);

	const headline = HEADLINE_CHOICES.map((choice): HeadlineRow => ({
		choice,
		cells: machines.map((m): HeadlineCell => {
			const found = m.series.filter((row) => row.benchmark === choice.benchmark && row.build === choice.build && hasParams(row, choice.params));
			if (found.length > 1) {
				throw new Error(`headline ${choice.benchmark} on ${m.instanceType}: ${found.length} Series match its settings (${found.map((row) => row.id).join(", ")}), so the rule in src/data/headline.ts no longer says which to show`);
			}
			const row = found[0] ?? null;
			const figure = row ? leadFigure(choice, row) : null;
			const absent = row ? whyNoFigure(choice, row) : `the data have no Series for this on ${m.instanceType}`;
			if (!row) notes.push(`no Series for ${choice.benchmark} on ${m.instanceType}: its cell shows no figure`);
			else if (!figure) notes.push(`Series ${row.id} (${choice.benchmark} on ${m.instanceType}) has no ${choice.lead} median (${absent}): its cell shows none`);
			else if (figure.p5 === null || figure.p95 === null) notes.push(`Series ${row.id} (${choice.benchmark} on ${m.instanceType}) has a percentile given as null: its title says so`);
			return { machine: m, series: row, figure, absent: figure ? null : absent };
		}),
	}));

	const recent = tree.index.recent_rounds;
	let rounds: Round[] | null = null;
	if (!recent) notes.push(`${tree.paths.index} has no recent_rounds: the page is built without "Latest runs"`);
	else if (recent.rounds.length === 0) notes.push(`${tree.paths.index} lists no round in recent_rounds: the page is built without "Latest runs"`);
	else rounds = recent.rounds.map((r) => ({ startedAt: r.started_at, boots: r.boots, runs: r.runs, failedRuns: r.failed_runs }));

	return {
		series,
		machines,
		headline,
		rounds,
		region: tree.prices.measured.region,
		newestRunStartedAt: tree.index.newest_run_started_at,
		priceDate: tree.index.prices.newest.date,
		links: {
			home: "/",
			numbers: "/#numbers",
			licences: "/third-party-notices.txt",
			docs: DOCS_URL,
			benchmarkDocs: benchmarkDocsUrl,
			index: tree.index.url,
			seriesList: tree.index.series.url,
			prices: tree.index.prices.newest.url,
			seriesFile: (row) => row.url,
		},
		notes,
	};
}

// ---------------------------------------------------------------- what the pages render

/** A machine type as the pages show it: its name, its facts, its hourly price. */
export type PageMachine = Pick<Machine, "instanceType" | "vcpu" | "memory" | "processor"> & { price: Pick<Machine["price"], "usdPerHour" | "description"> };

/** A headline cell as the pages show it: the Series' own file instead of the whole Series. */
export type PageCell = {
	machine: PageMachine;
	/** The address of the Series the cell's figure comes from (its row's `url`), or null when the cell has no Series. */
	seriesUrl: string | null;
	figure: LeadFigure | null;
	absent: string | null;
};

export type PageRow = { choice: HeadlineChoice; cells: PageCell[] };

/**
 * Everything the pages render, and nothing else, as plain JSON (rule 5 above): the build renders
 * every page from it and compiles the same JSON into the application the browser loads.
 */
export type PageData = {
	machines: PageMachine[];
	headline: PageRow[];
	rounds: Round[] | null;
	region: string;
	links: Pick<SiteLinks, "home" | "numbers" | "licences" | "docs" | "index" | "prices">;
};

/** What the pages render of DATA, as plain JSON: JSON.parse(JSON.stringify(pageData(data))) is the same value. */
export function pageData(data: SiteData): PageData {
	const machine = (m: Machine): PageMachine => ({
		instanceType: m.instanceType,
		vcpu: m.vcpu,
		memory: m.memory,
		processor: m.processor,
		price: { usdPerHour: m.price.usdPerHour, description: m.price.description },
	});
	const { home, numbers, licences, docs, index, prices } = data.links;
	return {
		machines: data.machines.map(machine),
		headline: data.headline.map((row) => ({
			choice: row.choice,
			cells: row.cells.map((cell) => ({ machine: machine(cell.machine), seriesUrl: cell.series ? data.links.seriesFile(cell.series) : null, figure: cell.figure, absent: cell.absent })),
		})),
		rounds: data.rounds ? data.rounds.map((round) => ({ ...round })) : null,
		region: data.region,
		links: { home, numbers, licences, docs, index, prices },
	};
}
