/**
 * Checks that every figure on the built pages is one the tree holds, exactly.
 *
 *     bun scripts/check-figures.ts [DIR] --tree TREE     (or LEDGERMATH_TREE=TREE; DIR defaults to dist/client)
 *
 * TREE must be the tree DIR was built from. The check reads each page's HTML (src/pages.text.ts)
 * and goes back from what it shows to the tree, rather than rendering the page again:
 *
 *  - Each link to a Series file is a figure. Its Series must be in the tree's Series list, must
 *    be the one the headline selection names for the row and the machine type it stands under
 *    (src/data/headline.ts), and must have the figure the row leads with. Its `title` gives the
 *    median, the 5th and 95th percentiles and the count of Runs in the row's unit: each is moved
 *    back into the tree's own unit (bytes per second, or nanoseconds of one repetition, times
 *    the repetition's count for a time per part), digit by digit, and must be the tree's number
 *    exactly; a percentile the tree gives as null must be said to be "infinite or undefined".
 *    The figure shown must be that median rounded to four significant digits, the data
 *    module's rule, and the row's unit must be the unit in the titles.
 *  - A cell without a figure shows a dash, only where the headline selection has none, with
 *    the data module's reason in its title.
 *  - Every cell of the headline selection, in the table and in each graph, holds exactly one
 *    figure or one dash: none is blank. The table has a row for every headline choice, and the
 *    table's columns and each graph's lines are the machine types, in the data's order.
 *  - The home page has exactly the graphs it is meant to have (GRAPH_BENCHMARKS in
 *    src/data/headline.ts), by their headings, in that order: a graph missing whole, one more,
 *    or two swapped, is a problem, though no figure on the page is wrong.
 *  - Each price is the newest price file's On-Demand price for its machine type, and each
 *    machine type's title gives the price file's facts and AWS's description of the price.
 *  - "Latest runs" is there only when the table of contents gives recent_rounds, and each round
 *    it lists says the round's start, boots, Runs and failed Runs as the tree gives them.
 *  - The region is the price file's.
 *  - Anything else on a page that holds a digit, in its text or in a `title`, must be one of the
 *    page's fixed words (a benchmark's label or description, a machine type's name): otherwise it
 *    is a figure this check does not know, and fails. So a new figure on a page needs a rule here.
 *
 * Exit 0 when every figure is the tree's, 1 when one is not (each problem listed), 2 with no tree.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	DURATION_UNITS,
	formatCount,
	formatMoment,
	GRAPH_BENCHMARKS,
	HEADLINE_CHOICES,
	type HeadlineChoice,
	NO_PERCENTILE,
	plain,
	powerOfTen,
	roundSignificant,
	SI_BYTES,
	shift,
	siteData,
	trim,
} from "../src/data";
import { readTree, type Tree } from "../src/data/tree";
import { HOME, PAGES } from "../src/pages.text";
import { NO_TREE, treeArgument } from "./build";
import { decodeEntities } from "./check-output";

// ---------------------------------------------------------------- reading the HTML the build wrote

export type Element = { tag: string; attributes: Map<string, string>; children: Node[]; parent: Element | null };
export type Text = { text: string; parent: Element };
export type Node = Element | Text;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const isElement = (node: Node): node is Element => "tag" in node;

/** The HTML as a tree of elements and text: enough for the well-formed HTML Solid's server renderer writes, no more. */
export function parseHtml(html: string): Element {
	const root: Element = { tag: "#document", attributes: new Map(), children: [], parent: null };
	let current = root;
	const token =
		/<!--[\s\S]*?-->|<!doctype[^>]*>|<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>|<\/([a-z][\w:-]*)\s*>|<([a-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/gi;
	for (const m of html.matchAll(token)) {
		if (m[1]) {
			// A script or style: an element whose content is not text a reader sees.
			current.children.push({ tag: m[1].toLowerCase(), attributes: attributesOf(m[2] ?? ""), children: [], parent: current });
		} else if (m[4]) {
			const tag = m[4].toLowerCase();
			let open: Element | null = current;
			while (open && open.tag !== tag) open = open.parent;
			if (!open || open === root) throw new Error(`the HTML closes a <${tag}> that is not open`);
			current = open.parent!;
		} else if (m[5]) {
			const element: Element = { tag: m[5].toLowerCase(), attributes: attributesOf(m[6] ?? ""), children: [], parent: current };
			current.children.push(element);
			if (!VOID.has(element.tag) && !/\/\s*$/.test(m[6] ?? "")) current = element;
		} else if (m[7] !== undefined) {
			current.children.push({ text: decodeEntities(m[7]), parent: current });
		}
	}
	return root;
}

function attributesOf(text: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const a of text.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
		found.set((a[1] ?? "").toLowerCase(), decodeEntities(a[2] ?? a[3] ?? a[4] ?? ""));
	}
	return found;
}

function* walk(node: Element): Generator<Node> {
	for (const child of node.children) {
		yield child;
		if (isElement(child)) yield* walk(child);
	}
}

const elements = (node: Element, match: (element: Element) => boolean) => [...walk(node)].filter((n): n is Element => isElement(n) && match(n));
const hasClass = (element: Element, name: string) => (element.attributes.get("class") ?? "").split(/\s+/).includes(name);
const textOf = (node: Node): string => (isElement(node) ? node.children.map(textOf).join("") : node.text);
const ownText = (element: Element) => element.children.filter((n): n is Text => !isElement(n)).map((n) => n.text).join("");
const children = (element: Element, tag: string) => element.children.filter((n): n is Element => isElement(n) && n.tag === tag);

function closest(node: Node, match: (element: Element) => boolean): Element | null {
	let at: Element | null = node.parent;
	while (at && !match(at)) at = at.parent;
	return at;
}

function describe(node: Node): string {
	const element = isElement(node) ? node : node.parent;
	const cls = element.attributes.get("class");
	return `<${element.tag}${cls ? ` class="${cls}"` : ""}>`;
}

// ---------------------------------------------------------------- what the tree says

type Price = { usd: string; description: string; vcpu: string; memory: string; processor: string };

/** Every On-Demand Linux price in the price file, by machine type. */
function pricesOf(tree: Tree): Map<string, Price[]> {
	const found = new Map<string, Price[]>();
	for (const source of tree.prices.sources) {
		for (const product of Object.values(source.products)) {
			const a = product.attributes;
			if (!a.instanceType || a.operatingSystem !== "Linux") continue;
			for (const term of Object.values(source.terms.OnDemand[product.sku] ?? {})) {
				for (const dimension of Object.values(term.priceDimensions)) {
					const list = found.get(a.instanceType) ?? [];
					list.push({ usd: dimension.pricePerUnit.USD, description: dimension.description, vcpu: a.vcpu ?? "", memory: a.memory ?? "", processor: a.physicalProcessor ?? "" });
					found.set(a.instanceType, list);
				}
			}
		}
	}
	return found;
}

/** A figure's full text in the row's unit, moved back into the tree's own unit: the inverse of the data module's formatters. */
function backToTree(full: string, unit: string, choice: HeadlineChoice): string | null {
	if (!/^-?\d+(\.\d+)?$/.test(full)) return null;
	if (choice.lead === "rate") {
		const bytes = unit.replace(/\/s$/, "");
		if (!unit.endsWith("/s") || !(bytes in SI_BYTES)) return null;
		return shift(full, SI_BYTES[bytes as keyof typeof SI_BYTES]);
	}
	if (!(unit in DURATION_UNITS)) return null;
	const ns = shift(full, -DURATION_UNITS[unit as keyof typeof DURATION_UNITS]);
	return choice.per ? shift(ns, powerOfTen(choice.per.count)) : ns;
}

const TITLE = /^Median (\S+) (\S+)\. 5th percentile (.+?), 95th (.+?)\. ([\d,]+) Runs\.$/;

// ---------------------------------------------------------------- the check

export type FiguresResult = { problems: string[]; figures: number; prices: number; rounds: number; dashes: number };

/**
 * Checks the figures of one page's HTML against TREE; see the comment at the top. PAGE names the
 * page in problems; `home` says it is the page that shows "Latest runs" when the tree gives rounds.
 */
export function checkFigures(html: string, tree: Tree, page = "index.html", { home = page === "index.html" } = {}): FiguresResult {
	const problems: string[] = [];
	const say = (what: string) => problems.push(`${page}: ${what}`);
	const doc = parseHtml(html);
	const body = elements(doc, (e) => e.tag === "body")[0];
	if (!body) return { problems: [`${page}: has no <body>`], figures: 0, prices: 0, rounds: 0, dashes: 0 };

	const data = siteData(tree);
	const rows = new Map(tree.seriesList.series.map((row) => [row.url, row]));
	const choices = new Map(HEADLINE_CHOICES.map((choice) => [choice.benchmark, choice]));
	const byLabel = new Map(HEADLINE_CHOICES.map((choice) => [choice.label, choice]));
	const prices = pricesOf(tree);
	const measured = new Set(tree.prices.measured.instance_types);
	const seriesPrefix = new URL("v1/series/", tree.base).href;

	/** Elements and text nodes the check has accounted for: their digits are the tree's, or fixed words. */
	const claimed = new Set<Node>();
	const claimedTitles = new Set<Element>();
	const claim = (node: Node) => claimed.add(node);

	/** The machine type and headline choice a figure or dash stands for, from where it is on the page; null when it is in neither the table nor a graph. */
	const placeOf = (node: Node): { type: string | undefined; choice: HeadlineChoice | undefined; where: string } | null => {
		const td = closest(node, (e) => e.tag === "td");
		const tr = td && closest(td, (e) => e.tag === "tr");
		const table = tr && closest(tr, (e) => e.tag === "table");
		if (td && tr && table) {
			const head = elements(table, (e) => e.tag === "thead")[0];
			const columns = head ? elements(head, (e) => e.tag === "th" && e.attributes.get("scope") === "col") : [];
			const index = children(tr, "td").indexOf(td);
			const rowHead = children(tr, "th").find((e) => e.attributes.get("scope") === "row");
			const label = rowHead ? elements(rowHead, (e) => e.tag === "a")[0] : undefined;
			const type = columns[index] ? ownText(columns[index]!).trim() : undefined;
			const choice = label ? byLabel.get(textOf(label).trim()) : undefined;
			return { type, choice, where: `the table's row ${JSON.stringify(label ? textOf(label) : "?")}, column ${JSON.stringify(type ?? "?")}` };
		}
		const li = closest(node, (e) => e.tag === "li");
		const graph = li && closest(li, (e) => hasClass(e, "graph"));
		if (li && graph) {
			const machine = elements(li, (e) => hasClass(e, "machine"))[0];
			const heading = elements(graph, (e) => e.tag === "h2")[0];
			const type = machine ? ownText(machine).trim() : undefined;
			const choice = heading ? byLabel.get(textOf(heading).trim()) : undefined;
			return { type, choice, where: `the graph ${JSON.stringify(heading ? textOf(heading) : "?")}, machine ${JSON.stringify(type ?? "?")}` };
		}
		return null;
	};

	const expectedCell = (choice: HeadlineChoice | undefined, type: string | undefined) =>
		data.headline.find((row) => row.choice === choice)?.cells.find((cell) => cell.machine.instanceType === type);

	// Each row's unit, from its figures' titles, to compare with the unit the row states.
	const unitOf = new Map<Element, string>();

	// 1. Figures: each link to a Series file.
	let figures = 0;
	for (const a of elements(body, (e) => e.tag === "a")) {
		const href = a.attributes.get("href") ?? "";
		if (!href.startsWith(seriesPrefix) && !rows.has(href)) continue;
		figures += 1;
		const row = rows.get(href);
		const shown = textOf(a).trim();
		if (!row) {
			say(`the figure ${JSON.stringify(shown)} links to ${href}, a Series the tree does not hold`);
			continue;
		}
		const choice = choices.get(row.benchmark);
		const place = placeOf(a);
		if (!choice) {
			say(`the figure ${JSON.stringify(shown)} is of Series ${row.id}, whose benchmark ${row.benchmark} has no headline choice`);
			continue;
		}
		if (!place) say(`the figure ${JSON.stringify(shown)} (Series ${row.id}) is in neither the table nor a graph`);
		else {
			if (place.choice !== choice) say(`the figure ${JSON.stringify(shown)} in ${place.where} is of Series ${row.id}, a ${row.benchmark} Series`);
			if (place.type !== row.instance_type) say(`the figure ${JSON.stringify(shown)} in ${place.where} is of Series ${row.id}, which ran on ${row.instance_type}`);
			const expected = expectedCell(place.choice, place.type);
			if (expected && expected.series?.id !== row.id) say(`the figure in ${place.where} is of Series ${row.id}, not ${expected.series?.id ?? "none"}, the one the headline selection names`);
		}
		const p = row.derivations.series_v1.percentiles[choice.lead === "rate" ? "bytes_per_second" : "time_per_repetition_ns"];
		if (!p || p.p50 === null) {
			say(`the figure ${JSON.stringify(shown)} is of Series ${row.id}, which has no ${choice.lead} median`);
			continue;
		}
		const title = a.attributes.get("title") ?? "";
		const m = TITLE.exec(title);
		if (!m) {
			say(`the figure ${JSON.stringify(shown)} of Series ${row.id} has a title that does not give its median, percentiles and Runs: ${JSON.stringify(title)}`);
			continue;
		}
		const [, median = "", unit = "", p5 = "", p95 = "", runs = ""] = m;
		for (const [name, text, value] of [
			["median", median, p.p50],
			["5th percentile", p5, p.p5],
			["95th percentile", p95, p.p95],
		] as const) {
			// A percentile the tree gives as null is said to be infinite or undefined, and nothing else is.
			if (value === null || text === NO_PERCENTILE) {
				if (value !== null) say(`the ${name} of Series ${row.id} is said to be ${NO_PERCENTILE}; the tree holds ${plain(value)}`);
				else if (text !== NO_PERCENTILE) say(`the ${name} of Series ${row.id} is shown as ${text} ${unit}; the tree gives it as null`);
				continue;
			}
			const back = backToTree(text, unit, choice);
			const tree = shift(plain(value), 0);
			if (back === null) say(`the ${name} of Series ${row.id} is shown as ${JSON.stringify(`${text} ${unit}`)}, which does not read as a ${choice.lead}`);
			else if (shift(back, 0) !== tree) say(`the ${name} of Series ${row.id} is shown as ${text} ${unit}, which is ${shift(back, 0)} in the tree's unit; the tree holds ${tree}`);
		}
		if (runs.replaceAll(",", "") !== String(p.count) || runs !== formatCount(p.count).full) say(`Series ${row.id}'s figure says ${runs} Runs; the tree counts ${p.count}`);
		const short = roundSignificant(median, 4);
		if (shown !== short) say(`Series ${row.id}'s figure shows ${JSON.stringify(shown)}; its median ${median} ${unit} to four significant digits is ${short}`);
		const owner = (place && (closest(a, (e) => e.tag === "tr" && !!closest(e, (t) => t.tag === "tbody")) ?? closest(a, (e) => hasClass(e, "graph")))) || null;
		if (owner) {
			const rowUnit = choice.per ? `${unit} per ${choice.per.of}` : unit;
			const before = unitOf.get(owner);
			if (before !== undefined && before !== rowUnit) say(`the figures of ${place!.where.split(",")[0]} are in ${before} and in ${rowUnit}`);
			unitOf.set(owner, rowUnit);
		}
		claim(a);
		claimedTitles.add(a);
	}

	// The unit each row and graph states, against its figures'.
	for (const [owner, unit] of unitOf) {
		const stated = elements(owner, (e) => hasClass(e, "unit"))[0];
		const text = stated ? textOf(stated).trim() : "";
		if (owner.tag === "tr" ? text !== unit : !text.startsWith(`${unit} · `)) say(`a row's figures are in ${unit}, but it says ${JSON.stringify(text)}`);
	}

	// 2. Dashes: a cell or graph line without a figure.
	let dashes = 0;
	for (const node of walk(body)) {
		if (isElement(node) || node.text.trim() !== "—") continue;
		const place = placeOf(node);
		if (!place) continue;
		dashes += 1;
		const expected = expectedCell(place.choice, place.type);
		const title = node.parent.attributes.get("title") ?? "";
		if (!expected) say(`a dash in ${place.where}, which is not a cell of the headline selection`);
		else if (expected.figure) say(`a dash in ${place.where}, where the tree has a figure (Series ${expected.series!.id})`);
		else if (title !== `No figure: ${expected.absent}.`) say(`the dash in ${place.where} says ${JSON.stringify(title)}; why the tree gives no figure there is ${JSON.stringify(expected.absent)}`);
		claim(node);
		claimedTitles.add(node.parent);
	}

	// 2b. Every cell the headline selection has, in the table and in each graph, holds exactly one
	// figure or one dash: none is blank, none holds two. And the columns and graph lines are the
	// machine types, in the order of the data.
	if (home) {
		const types = data.machines.map((m) => m.instanceType);
		const holds = (cell: Element, where: string) => {
			const figuresIn = elements(cell, (e) => e.tag === "a" && rows.has(e.attributes.get("href") ?? "")).length;
			const dashesIn = [...walk(cell)].filter((n) => !isElement(n) && n.text.trim() === "—").length;
			if (figuresIn + dashesIn !== 1) say(`${where} holds ${figuresIn} figure${figuresIn === 1 ? "" : "s"} and ${dashesIn} dash${dashesIn === 1 ? "" : "es"}, not exactly one figure or one dash`);
		};
		const table = elements(body, (e) => e.tag === "table")[0];
		if (!table) say("the page has no table of benchmarks");
		else {
			const head = elements(table, (e) => e.tag === "thead")[0];
			const columns = head ? elements(head, (e) => e.tag === "th" && e.attributes.get("scope") === "col").map((th) => ownText(th).trim()) : [];
			if (columns.join(" ") !== types.join(" ")) say(`the table's columns are ${JSON.stringify(columns)}; the machine types are ${JSON.stringify(types)}`);
			const seen: HeadlineChoice[] = [];
			for (const tr of elements(table, (e) => e.tag === "tr" && !!closest(e, (t) => t.tag === "tbody") && !hasClass(e, "section"))) {
				const rowHead = children(tr, "th").find((e) => e.attributes.get("scope") === "row");
				const label = rowHead ? textOf(elements(rowHead, (e) => e.tag === "a")[0] ?? rowHead).trim() : "";
				const choice = byLabel.get(label);
				if (!choice) {
					say(`the table has a row ${JSON.stringify(label)}, which is no headline choice`);
					continue;
				}
				if (seen.includes(choice)) say(`the table has the row ${JSON.stringify(label)} twice`);
				seen.push(choice);
				const cells = children(tr, "td");
				if (cells.length !== types.length) say(`the table's row ${JSON.stringify(label)} has ${cells.length} cells for ${types.length} machine types`);
				cells.forEach((td, i) => holds(td, `the table's row ${JSON.stringify(label)}, column ${JSON.stringify(columns[i] ?? "?")}`));
			}
			for (const choice of HEADLINE_CHOICES) if (!seen.includes(choice)) say(`the table has no row for ${JSON.stringify(choice.label)}`);
		}
		// The graphs the page is meant to have, by their headings, in order: each line of a graph
		// is checked below, but a graph missing whole leaves no line to check.
		const graphs = elements(body, (e) => hasClass(e, "graph"));
		const headings = graphs.map((graph) => {
			const heading = elements(graph, (e) => e.tag === "h2")[0];
			return heading ? textOf(heading).trim() : "";
		});
		const meant = GRAPH_BENCHMARKS.map((benchmark) => choices.get(benchmark)?.label ?? `(no headline choice for ${benchmark})`);
		if (headings.join("\n") !== meant.join("\n")) say(`the page's graphs are ${JSON.stringify(headings)}; it is meant to have ${JSON.stringify(meant)}, in that order`);
		for (const graph of graphs) {
			const heading = elements(graph, (e) => e.tag === "h2")[0];
			const label = heading ? textOf(heading).trim() : "";
			if (!byLabel.has(label)) say(`a graph is headed ${JSON.stringify(label)}, which is no headline choice`);
			const lines = elements(graph, (e) => e.tag === "li");
			const lineTypes = lines.map((li) => {
				const machine = elements(li, (e) => hasClass(e, "machine"))[0];
				return machine ? ownText(machine).trim() : "";
			});
			if (lineTypes.join(" ") !== types.join(" ")) say(`the graph ${JSON.stringify(label)} has lines for ${JSON.stringify(lineTypes)}; the machine types are ${JSON.stringify(types)}`);
			lines.forEach((li, i) => holds(li, `the graph ${JSON.stringify(label)}, machine ${JSON.stringify(lineTypes[i] ?? "?")}`));
		}
	}

	// 3. Prices and machine types.
	let priceCount = 0;
	for (const span of elements(body, (e) => hasClass(e, "price"))) {
		priceCount += 1;
		const holder = span.parent!;
		const type = ownText(holder).trim();
		const text = textOf(span).trim();
		const known = prices.get(type) ?? [];
		const m = /^\$(\d+(?:\.\d+)?)\/h$/.exec(text);
		if (!measured.has(type)) say(`the price ${JSON.stringify(text)} stands beside ${JSON.stringify(type)}, which the price file does not measure`);
		else if (!m || !known.some((price) => trim(price.usd) === m[1])) say(`${type}'s price is shown as ${JSON.stringify(text)}; the price file gives ${known.map((p) => `$${trim(p.usd)}/h`).join(" or ") || "none"}`);
		claim(span);
	}
	for (const node of walk(body)) {
		if (!isElement(node) && measured.has(node.text.trim())) claim(node);
	}
	for (const th of elements(body, (e) => e.tag === "th" && e.attributes.get("scope") === "col")) {
		const type = ownText(th).trim();
		const title = th.attributes.get("title") ?? "";
		const facts = (prices.get(type) ?? []).map((p) => `${p.vcpu} vCPU, ${p.memory}, ${p.processor}. ${p.description}.`);
		if (!facts.includes(title)) say(`${type}'s title is ${JSON.stringify(title)}; the price file gives ${JSON.stringify(facts[0] ?? "nothing")}`);
		claimedTitles.add(th);
	}

	// 4. Fixed words: each benchmark's label, and its row's title (what it measures, its settings).
	for (const node of walk(body)) {
		if (!isElement(node) && byLabel.has(node.text.trim())) claim(node);
	}
	for (const th of elements(body, (e) => e.tag === "th" && e.attributes.get("scope") === "row")) {
		const label = elements(th, (e) => e.tag === "a")[0];
		const choice = label && byLabel.get(textOf(label).trim());
		if (choice && th.attributes.get("title") === `${choice.what} ${choice.setting}.`) claimedTitles.add(th);
	}

	// 5. The latest rounds.
	const latest = elements(body, (e) => hasClass(e, "latest"));
	const rounds = tree.index.recent_rounds?.rounds ?? [];
	let roundCount = 0;
	if (rounds.length === 0 && latest.length > 0) say(`"Latest runs" is on the page, but the tree gives ${tree.index.recent_rounds ? "no round" : "no recent_rounds"}`);
	if (home && rounds.length > 0 && latest.length === 0) say(`the tree gives recent_rounds, but the page has no "Latest runs"`);
	for (const section of latest) {
		const items = elements(section, (e) => e.tag === "li");
		if (items.length !== Math.min(3, rounds.length)) say(`"Latest runs" lists ${items.length} rounds; the tree gives ${rounds.length}, of which the page shows the newest 3`);
		items.forEach((li, i) => {
			const round = rounds[i];
			const time = elements(li, (e) => e.tag === "time")[0];
			const span = elements(li, (e) => e.tag === "span")[0];
			if (!round || !time || !span) {
				say(`"Latest runs" item ${i + 1} is not a round the tree gives`);
				return;
			}
			roundCount += 1;
			const at = formatMoment(round.started_at);
			const date = `${at.longDate.replace(/^(\d+ [A-Za-z]{3})[a-z]*/, "$1")}, ${at.minute} UTC`;
			if (time.attributes.get("datetime") !== round.started_at || textOf(time).trim() !== date || time.attributes.get("title") !== at.full) {
				say(`"Latest runs" item ${i + 1} says ${JSON.stringify(textOf(time))} (${time.attributes.get("datetime")}); the tree's round started at ${round.started_at}`);
			}
			const counts = `${formatCount(round.boots).full} machines · ${formatCount(round.runs).full} Runs · ${formatCount(round.failed_runs).full} failed`;
			if (textOf(span).trim() !== counts) say(`"Latest runs" item ${i + 1} says ${JSON.stringify(textOf(span).trim())}; the tree gives ${JSON.stringify(counts)}`);
			claim(li);
			claimedTitles.add(time);
		});
	}

	// 6. The region.
	for (const note of elements(body, (e) => hasClass(e, "note"))) {
		const text = textOf(note).trim();
		if (!text.startsWith(`AWS, ${tree.prices.measured.region}. `)) say(`the note says ${JSON.stringify(text)}; the price file's region is ${tree.prices.measured.region}`);
		claim(note);
	}

	// 7. Anything else with a digit is a figure this check does not know.
	const accounted = (node: Node): boolean => {
		for (let at: Node | null = node; at; at = at.parent) if (claimed.has(at)) return true;
		return false;
	};
	for (const node of walk(body)) {
		if (isElement(node)) {
			if (node.tag === "script" || node.tag === "style") continue;
			const title = node.attributes.get("title");
			if (title && /\d/.test(title) && !claimedTitles.has(node)) say(`a title this check does not know holds a digit, on ${describe(node)}: ${JSON.stringify(title)}`);
			continue;
		}
		if (/\d/.test(node.text) && !accounted(node)) say(`a figure this check does not know, in ${describe(node)}: ${JSON.stringify(node.text.trim())}`);
	}

	return { problems, figures, prices: priceCount, rounds: roundCount, dashes };
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const treeDir = treeArgument(argv);
	if (!treeDir) {
		console.error(`${NO_TREE}\nThe figures are checked against the tree the site was built from.`);
		process.exit(2);
	}
	const words = argv.filter((arg, i) => !arg.startsWith("--tree") && argv[i - 1] !== "--tree");
	const dir = resolve(words[0] ?? join(import.meta.dir, "..", "dist", "client"));
	const tree = readTree(treeDir);
	const problems: string[] = [];
	const lines: string[] = [];
	for (const page of PAGES) {
		const path = join(dir, page.file);
		if (!existsSync(path)) {
			problems.push(`${page.file} is missing (run \`bun run build\` first)`);
			continue;
		}
		const result = checkFigures(readFileSync(path, "utf8"), tree, page.file, { home: page === HOME });
		problems.push(...result.problems);
		lines.push(`${page.file}: ${result.figures} figures, ${result.dashes} dashes, ${result.prices} prices, ${result.rounds} rounds`);
	}
	if (problems.length > 0) {
		for (const problem of problems) console.error(problem);
		process.exit(1);
	}
	console.log(`${lines.join("; ")}: every one as the tree at ${treeDir} holds it (newest Run ${tree.index.newest_run_started_at})`);
}
