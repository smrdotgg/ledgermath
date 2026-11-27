/**
 * What words LedgerMath publishes may not name: anything a reader of the published words alone
 * cannot fetch (ADR-0030, rule 5). Their first readers are agents with no repository, no
 * README: so no published word may send them to a file of this repository, a document section,
 * an issue, a pull request, an ADR, a function of the code or a program's option.
 *
 * The one set of rules, held to the data API's words by tests/api-words.test.ts and to the
 * hand-written documentation pages by the tests of those pages.
 */

import { readdirSync } from "node:fs";

import { API_SCHEMAS } from "./api";

export interface WordRules {
	/** Each kind of reference a reader cannot follow, with a pattern that finds it. */
	references: ReadonlyArray<{ kind: string; pattern: RegExp }>;
	/** A schema file named in words that is not one of the tree's: schemas/events.schema.json lives in the repository, not under v1/schemas/. */
	otherSchemas: (text: string) => string[];
	/** Each reference a text makes that a reader cannot follow: its kind and the words. */
	referencesIn: (text: string) => Array<{ kind: string; text: string }>;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The rules for a checkout at `root`: its own top-level directories and files are what a path must not name. */
export function wordRules(root: string): WordRules {
	const top = readdirSync(root, { withFileTypes: true }).filter((entry) => ![".git", "node_modules", "local"].includes(entry.name));
	const directories = top.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	const rootFiles = top.filter((entry) => entry.isFile()).map((entry) => entry.name);
	const treeSchemas = new Set<string>(API_SCHEMAS.map(({ name }) => name));

	const references: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
		// scripts/check-events.py, runner/, docs/dev-log.md: not after a / or a word, so v1/schemas/… is not one.
		{ kind: "a path in the repository", pattern: new RegExp(`(?<![\\w./-])(?:${directories.map(escape).join("|")})/`, "g") },
		{ kind: "a file at the repository's root", pattern: new RegExp(`(?<![\\w./-])(?:${rootFiles.map(escape).join("|")})(?![\\w-])`, "g") },
		// ./schedule.json, ../docs/dev-log.md, /runner/: a file or directory of the repository, from somewhere in it or from its root.
		{
			kind: "a relative path to a file of the repository",
			pattern: new RegExp(`(?<![\\w.-])(?:(?:\\.\\.?/)+|/)(?:(?:${directories.map(escape).join("|")})/|(?:${rootFiles.map(escape).join("|")})(?![\\w-]))`, "g"),
		},
		{ kind: "a source or document file", pattern: /(?<![\w./-])[\w./-]*[\w-]\.(?:py|ts|tsx|js|mjs|cjs|md|c|h|sh|toml|ya?ml|lock)(?![\w-])/g },
		{ kind: "a README", pattern: /\breadme\b/gi },
		{ kind: "an ADR", pattern: /\bADR[- ]?\d+/gi },
		{ kind: "an issue or pull request", pattern: /(?<![\w&/#])#\d+\b|\b(?:issue|pull request|PR)s?\s+#?\d+/gi },
		{ kind: "a numbered section of a document", pattern: /\bsection\s+\d+(?:\.\d+)*\b/gi },
		{ kind: "the dev log", pattern: /\bdev[- ]log\b/gi },
		{ kind: "a function of the code", pattern: /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\)/g },
		{ kind: "a program's command-line option", pattern: /(?<![\w-])--[A-Za-z][\w-]*/g },
		{ kind: "the repository on GitHub", pattern: /github\.com|\bsmrdotgg\b/gi },
	];

	const otherSchemas = (text: string): string[] =>
		[...text.matchAll(/(?<![\w-])([\w-]+)\.schema\.json/g)].filter((match) => !treeSchemas.has(match[1] as string)).map((match) => match[0]);

	const referencesIn = (text: string): Array<{ kind: string; text: string }> => [
		...references.flatMap(({ kind, pattern }) => [...text.matchAll(pattern)].map((match) => ({ kind, text: match[0] }))),
		...otherSchemas(text).map((name) => ({ kind: "a schema the tree does not serve", text: name })),
	];

	return { references, otherSchemas, referencesIn };
}
