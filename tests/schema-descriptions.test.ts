/**
 * Every field of every schema this repository keeps carries words of its own,
 * so that a reference generated from the schemas (a page per kind of file, a
 * table of every field with its type and its description) has no empty cell.
 * The rule:
 *
 * - The schemas are every file named *.schema.json under schemas/, found by
 *   directory, so a schema added later is held to the rule with no change
 *   here.
 * - Each has a title and a description at its root.
 * - A field is a member a schema declares for an object: each entry of
 *   properties and of patternProperties, and additionalProperties (or
 *   unevaluatedProperties) when it is a schema, which declares the members of
 *   every other name. Each field is described: it has a description of its
 *   own, a string with more than white space in it, or, having no description
 *   at all, it is a $ref within its file to a schema described by this same
 *   rule. A field whose own description is empty is not described, whatever
 *   its $ref points at: a reader would be shown the empty one.
 * - A boolean schema (true or false) under properties is no field: it allows
 *   or forbids a member that is declared, with its words, elsewhere, and JSON
 *   Schema gives it no place for words.
 * - Fields are looked for wherever a schema can declare them: under each
 *   field; under items, prefixItems, contains and unevaluatedItems (an
 *   array's elements); under each branch of anyOf, oneOf and allOf, and under
 *   then and else; under each entry of dependentSchemas; and under each entry
 *   of $defs. These places are not fields, and need no words of their own: the
 *   field that holds the array, the choice or the reference carries them. if,
 *   not and propertyNames are not looked in: they test a value, and declare
 *   no member.
 * - Every name a schema lists in required is declared at that level, as a
 *   field the rule above holds to words: under properties, as a schema (not a
 *   boolean), or matched by a patternProperties pattern. "That level" is every
 *   schema that applies to the same value: the one holding required, the
 *   schemas it sits under as a branch (anyOf, oneOf, allOf, then, else,
 *   dependentSchemas), and, for each of those, the schema its $ref names and
 *   its allOf branches, which always apply. So a oneOf branch may require a
 *   member its parent declares, with its words. additionalProperties does not
 *   count: it is the schema of the names an object does not declare, so a
 *   required name only it covers is a name the schema never declares, whose
 *   row in a reference would have the words for every other name, not its own.
 * - So is every name an if's own required list holds, by the same rule, in the
 *   schema around the if: the predicate needs no words, but with else false
 *   every valid value must hold such a name, and a reference must say what it
 *   is.
 *
 * When it fails it names every gap at once, by file and field path.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCHEMAS = join(ROOT, "schemas");

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Each place a field is declared: the keyword, and how a member under it is named in a path. */
const FIELD_MAPS = { properties: (name: string) => name, patternProperties: (pattern: string) => `/${pattern}/` } as const;
/** The keywords whose schema declares the members of every other name. */
const OTHER_MEMBERS = ["additionalProperties", "unevaluatedProperties"] as const;
/** The keywords whose schema is an array's element. */
const ELEMENTS = ["items", "contains", "unevaluatedItems"] as const;
/** The keywords whose schemas are branches, each applying to the same value. */
const BRANCH_LISTS = ["anyOf", "oneOf", "allOf"] as const;
const BRANCHES = ["then", "else"] as const;
const DEFINITION_MAPS = ["$defs", "definitions"] as const;

/** One segment of a field path: a member's name, or a step into an element, a branch or a definition. */
type Step = { name: string } | { step: string };

/** A field path as a reader writes it: $defs.split_fact.fact, schemas[].name, params.*, exit.oneOf[0].code. */
function render(path: readonly Step[]): string {
	let out = "";
	for (const segment of path) {
		if ("step" in segment) out += segment.step;
		else out += /^(?:[A-Za-z_$][A-Za-z0-9_$]*|\*)$/.test(segment.name) ? `${out === "" ? "" : "."}${segment.name}` : `[${JSON.stringify(segment.name)}]`;
	}
	return out;
}

/** The schema a local $ref names within its file, or undefined when it names none. */
function resolve(root: Json, ref: string): unknown {
	if (!ref.startsWith("#")) return undefined;
	let at: unknown = root;
	for (const part of ref.slice(1).split("/").filter((piece) => piece !== "")) {
		const key = decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~");
		if (Array.isArray(at)) at = at[Number(key)];
		else if (isObject(at)) at = at[key];
		else return undefined;
	}
	return at;
}

/** Why a field is not described, or undefined when it is. */
function whyUndescribed(node: Json, root: Json, seen: ReadonlySet<Json> = new Set([node])): string | undefined {
	if ("description" in node) {
		const words = node.description;
		if (typeof words !== "string") return "a description that is not a string";
		if (words === "") return "an empty description";
		if (words.trim() === "") return "a description of white space alone";
		return undefined;
	}
	if (typeof node.$ref !== "string") return "no description";
	const target = resolve(root, node.$ref);
	if (!isObject(target)) return `no description, and its $ref ${node.$ref} is to no schema in this file`;
	if (seen.has(target)) return `no description, and its $ref ${node.$ref} goes round in a circle`;
	return whyUndescribed(target, root, new Set([...seen, target])) === undefined ? undefined : `no description, and its $ref ${node.$ref} is to a schema with none`;
}

/**
 * Every schema that applies to the same value as these: each of them, the
 * schema its $ref names, and its allOf branches, which always apply, followed
 * as far as they go.
 */
function applying(schemas: readonly Json[], root: Json): Json[] {
	const found: Json[] = [];
	const add = (node: unknown): void => {
		if (!isObject(node) || found.includes(node)) return;
		found.push(node);
		if (typeof node.$ref === "string") add(resolve(root, node.$ref));
		if (Array.isArray(node.allOf)) for (const branch of node.allOf) add(branch);
	};
	for (const schema of schemas) add(schema);
	return found;
}

/** Why a name in required is not declared at its level, or undefined when it is: under properties as a schema, or by a matching patternProperties pattern. */
function whyUndeclared(name: string, level: readonly Json[]): string | undefined {
	let boolean = false;
	for (const schema of level) {
		const properties = schema.properties;
		if (isObject(properties) && Object.hasOwn(properties, name)) {
			if (isObject(properties[name])) return undefined;
			boolean = true;
		}
		const patterns = schema.patternProperties;
		if (isObject(patterns)) for (const [pattern, member] of Object.entries(patterns)) if (isObject(member) && new RegExp(pattern, "u").test(name)) return undefined;
	}
	return boolean
		? `requires ${name}, but declares it only by a boolean schema, which has no words`
		: `requires ${name}, but no properties or patternProperties of that object declare it`;
}

/**
 * Every gap in one schema, as "path: why": the root's title or description
 * missing, each field without words, and each name in required that its level
 * does not declare.
 */
function undescribedFields(schema: unknown): string[] {
	if (!isObject(schema)) return ["(root): not a JSON object"];
	const gaps: string[] = [];
	for (const keyword of ["title", "description"] as const) {
		const words = schema[keyword];
		if (typeof words !== "string" || words.trim() === "") gaps.push(`(root): no ${keyword}`);
	}
	const field = (node: unknown, path: Step[]): void => {
		if (typeof node === "boolean") return;
		if (!isObject(node)) {
			gaps.push(`${render(path)}: not a schema`);
			return;
		}
		const why = whyUndescribed(node, schema);
		if (why !== undefined) gaps.push(`${render(path)}: ${why}`);
		walk(node, path, []);
	};
	/** `above`: the schemas this one is a branch of, which apply to the same value; empty for a field, an element or a definition. */
	const walk = (node: unknown, path: Step[], above: readonly Json[]): void => {
		if (!isObject(node)) return;
		/** A step named by a keyword: after a dot, unless it starts the path. */
		const keywordStep = (word: string): Step => ({ step: `${path.length === 0 ? "" : "."}${word}` });
		/** Each name of a required list declared at this schema's level, or a gap at `where`. */
		const declared = (required: unknown, where: string): void => {
			if (!Array.isArray(required)) return;
			const level = applying([node, ...above], schema);
			for (const name of required) {
				if (typeof name !== "string") continue;
				const why = whyUndeclared(name, level);
				if (why !== undefined) gaps.push(`${where}: ${why}`);
			}
		};
		declared(node.required, path.length === 0 ? "(root)" : render(path));
		// An if's own required: the predicate needs no words, but a name it requires may be one every valid value must hold (else false), so it is declared around it.
		if (isObject(node.if)) declared(node.if.required, render([...path, keywordStep("if")]));
		const branchAbove = [...above, node];
		for (const [keyword, nameOf] of Object.entries(FIELD_MAPS)) {
			const members = node[keyword];
			if (isObject(members)) for (const [name, member] of Object.entries(members)) field(member, [...path, { name: nameOf(name) }]);
		}
		for (const keyword of OTHER_MEMBERS) if (isObject(node[keyword])) field(node[keyword], [...path, { name: "*" }]);
		for (const keyword of ELEMENTS) if (isObject(node[keyword])) walk(node[keyword], [...path, keyword === "items" ? { step: "[]" } : keywordStep(keyword)], []);
		if (Array.isArray(node.prefixItems)) node.prefixItems.forEach((item, i) => walk(item, [...path, { step: `[${i}]` }], []));
		for (const keyword of BRANCH_LISTS) {
			const list = node[keyword];
			if (Array.isArray(list)) list.forEach((item, i) => walk(item, [...path, keywordStep(`${keyword}[${i}]`)], branchAbove));
		}
		for (const keyword of BRANCHES) if (isObject(node[keyword])) walk(node[keyword], [...path, keywordStep(keyword)], branchAbove);
		if (isObject(node.dependentSchemas)) for (const [name, item] of Object.entries(node.dependentSchemas)) walk(item, [...path, { name: "dependentSchemas" }, { name }], branchAbove);
		for (const keyword of DEFINITION_MAPS) {
			const definitions = node[keyword];
			if (isObject(definitions)) for (const [name, item] of Object.entries(definitions)) walk(item, [...path, { name: keyword }, { name }], []);
		}
	};
	walk(schema, [], []);
	return gaps;
}

/** Every *.schema.json under schemas/, by its path from the repository's root, in path order. */
function schemaFiles(): string[] {
	return readdirSync(SCHEMAS, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".schema.json"))
		.map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();
}

describe("every schema this repository keeps", () => {
	test("is found by directory: every *.schema.json under schemas/, the eight kept today among them", () => {
		const found = schemaFiles();
		for (const kept of [
			"schemas/api/v1/benchmark.schema.json",
			"schemas/api/v1/index.schema.json",
			"schemas/api/v1/series-list.schema.json",
			"schemas/api/v1/series-month.schema.json",
			"schemas/api/v1/series.schema.json",
			"schemas/events.schema.json",
			"schemas/prices.schema.json",
			"schemas/run.schema.json",
		]) {
			expect(found).toContain(kept);
		}
	});

	test("has a title and a description, and a description for every field", () => {
		const gaps = schemaFiles().flatMap((file) => undescribedFields(JSON.parse(readFileSync(join(ROOT, file), "utf8"))).map((gap) => `${file}: ${gap}`));
		expect(gaps).toEqual([]);
	});
});

describe("the check", () => {
	/** A schema with a title and a description at its root, around the given members. */
	const schema = (members: Json): Json => ({ title: "A schema", description: "What it describes.", type: "object", ...members });

	test("refuses a field with no description, an empty one, or one of white space alone", () => {
		expect(undescribedFields(schema({ properties: { a: { type: "string" } } }))).toEqual(["a: no description"]);
		expect(undescribedFields(schema({ properties: { a: { description: "", type: "string" } } }))).toEqual(["a: an empty description"]);
		expect(undescribedFields(schema({ properties: { a: { description: " \n\t", type: "string" } } }))).toEqual(["a: a description of white space alone"]);
		expect(undescribedFields(schema({ properties: { a: { description: 3, type: "string" } } }))).toEqual(["a: a description that is not a string"]);
	});

	test("refuses a $ref to a definition with no description, or to none", () => {
		expect(undescribedFields(schema({ properties: { a: { $ref: "#/$defs/x" } }, $defs: { x: { type: "string" } } }))).toEqual(["a: no description, and its $ref #/$defs/x is to a schema with none"]);
		expect(undescribedFields(schema({ properties: { a: { $ref: "#/$defs/y" } }, $defs: {} }))).toEqual(["a: no description, and its $ref #/$defs/y is to no schema in this file"]);
		// A definition that only refers to itself has no words anywhere, and the check ends.
		expect(undescribedFields(schema({ properties: { a: { $ref: "#/$defs/x" } }, $defs: { x: { $ref: "#/$defs/x" } } }))).toEqual(["a: no description, and its $ref #/$defs/x is to a schema with none"]);
		expect(undescribedFields(schema({ properties: { a: { $ref: "#/properties/a" } } }))).toEqual(["a: no description, and its $ref #/properties/a goes round in a circle"]);
		// An empty description of its own is what a reader would be shown: it is not excused by its $ref.
		expect(undescribedFields(schema({ properties: { a: { description: "", $ref: "#/$defs/x" } }, $defs: { x: { description: "An x.", type: "string" } } }))).toEqual(["a: an empty description"]);
	});

	test("refuses a gap nested under items, under an anyOf branch, under then, and inside a definition", () => {
		const items = { description: "A list.", type: "array", items: { type: "object", properties: { b: { type: "string" } } } };
		expect(undescribedFields(schema({ properties: { list: items } }))).toEqual(["list[].b: no description"]);
		const choice = { description: "An object or null.", anyOf: [{ type: "object", properties: { d: { type: "string" } } }, { type: "null" }] };
		expect(undescribedFields(schema({ properties: { c: choice } }))).toEqual(["c.anyOf[0].d: no description"]);
		const conditional = { allOf: [{ if: { properties: { kind: { const: "e" } } }, then: { properties: { e: { type: "integer" } } } }] };
		expect(undescribedFields(schema(conditional))).toEqual(["allOf[0].then.e: no description"]);
		expect(undescribedFields(schema({ $defs: { x: { description: "An x.", type: "object", properties: { y: { type: "string" } } } } }))).toEqual(["$defs.x.y: no description"]);
		expect(undescribedFields(schema({ properties: { pair: { description: "A pair.", prefixItems: [{ type: "object", properties: { f: { type: "string" } } }] } } }))).toEqual(["pair[0].f: no description"]);
	});

	test("refuses a member of every other name, or of a pattern, with no description", () => {
		expect(undescribedFields(schema({ properties: { map: { description: "A map.", type: "object", additionalProperties: { type: "string" } } } }))).toEqual(["map.*: no description"]);
		expect(undescribedFields(schema({ patternProperties: { "^x_": { type: "string" } } }))).toEqual(['["/^x_/"]: no description']);
	});

	test("refuses a name in required that its level does not declare, declares only by a boolean schema, or covers only by additionalProperties", () => {
		const nowhere = (name: string): string => `requires ${name}, but no properties or patternProperties of that object declare it`;
		expect(undescribedFields(schema({ required: ["duration_ns"] }))).toEqual([`(root): ${nowhere("duration_ns")}`]);
		expect(undescribedFields(schema({ required: ["a"], properties: { a: true } }))).toEqual(["(root): requires a, but declares it only by a boolean schema, which has no words"]);
		expect(undescribedFields(schema({ required: ["a"], additionalProperties: { description: "Any member.", type: "string" } }))).toEqual([`(root): ${nowhere("a")}`]);
		// Nested, and in a branch whose parent does not declare it either; a sibling branch's declaration does not apply.
		expect(undescribedFields(schema({ $defs: { x: { description: "An x.", type: "array", items: { type: "object", required: ["b"] } } } }))).toEqual([`$defs.x[]: ${nowhere("b")}`]);
		expect(undescribedFields(schema({ anyOf: [{ required: ["z"] }, { properties: { z: { description: "A z.", type: "string" } } }] }))).toEqual([`anyOf[0]: ${nowhere("z")}`]);
	});

	test("refuses a name an if requires that the schema around it does not declare, and passes one it declares", () => {
		const then = { required: ["a"], properties: { a: { description: "An a.", type: "string" } } };
		// With else false, every valid object holds status; the predicate's own words would not be shown.
		expect(undescribedFields(schema({ if: { required: ["status"] }, then, else: false }))).toEqual(["if: requires status, but no properties or patternProperties of that object declare it"]);
		expect(undescribedFields(schema({ properties: { x: { description: "An x.", type: "object", if: { required: ["status"], properties: { status: { type: "string" } } }, then } } }))).toEqual([
			"x.if: requires status, but no properties or patternProperties of that object declare it",
		]);
		expect(undescribedFields(schema({ properties: { status: { description: "Its status.", type: "string" } }, if: { required: ["status"] }, then, else: false }))).toEqual([]);
	});

	test("passes a name in required declared at its level: in properties, by a pattern, by the parent of a branch, by an allOf branch or by the schema a $ref names", () => {
		const a = { description: "An a.", type: "string" };
		expect(undescribedFields(schema({ required: ["a"], properties: { a } }))).toEqual([]);
		expect(undescribedFields(schema({ required: ["x_a"], patternProperties: { "^x_": { description: "A member named x_ and more.", type: "string" } } }))).toEqual([]);
		// The Run schema's two shapes: a oneOf branch requires a member its parent declares, and allows it by a boolean schema.
		expect(undescribedFields(schema({ properties: { a }, oneOf: [{ description: "The one shape.", required: ["a"], properties: { a: true } }] }))).toEqual([]);
		expect(undescribedFields(schema({ required: ["a"], allOf: [{ properties: { a } }] }))).toEqual([]);
		expect(undescribedFields(schema({ properties: { f: { description: "An f.", $ref: "#/$defs/base", required: ["a"] } }, $defs: { base: { type: "object", properties: { a } } } }))).toEqual([]);
	});

	test("refuses a schema with no title or no description of its own", () => {
		expect(undescribedFields({ type: "object" })).toEqual(["(root): no title", "(root): no description"]);
		expect(undescribedFields({ title: " ", description: "", type: "object" })).toEqual(["(root): no title", "(root): no description"]);
	});

	test("names every gap at once", () => {
		const many = schema({
			properties: { a: { type: "string" }, b: { description: "A b.", type: "object", properties: { c: { type: "string" }, "p99.9": { type: "number" } } } },
			$defs: { x: { type: "object", properties: { y: { type: "string" } } } },
		});
		expect(undescribedFields(many)).toEqual(["a: no description", "b.c: no description", 'b["p99.9"]: no description', "$defs.x.y: no description"]);
	});

	test("passes the described forms", () => {
		const described = schema({
			properties: {
				// Words of its own.
				a: { description: "An a.", type: "string" },
				// A $ref to a definition with words, directly or through another.
				b: { $ref: "#/$defs/described" },
				c: { $ref: "#/$defs/through" },
				// Words of its own beside a $ref to a definition with none.
				d: { description: "A d.", $ref: "#/$defs/bare" },
				// An array and a choice: their elements and branches need no words, only the fields inside them.
				e: { description: "An e.", type: "array", items: { type: "object", properties: { f: { description: "An f.", type: "string" } } } },
				g: { description: "A g.", anyOf: [{ type: "string" }, { type: "null" }] },
				// Members of every other name, and of a pattern, with words.
				h: { description: "An h.", type: "object", additionalProperties: { description: "One member of h.", type: "string" } },
				// A boolean schema is no field.
				i: true,
			},
			patternProperties: { "^x_": { description: "A member named x_ and more.", type: "string" } },
			// A shape choosing which fields are allowed, by boolean schemas.
			oneOf: [{ description: "The one shape.", required: ["a"], properties: { a: true, z: false } }],
			// What if tests is not looked in: it declares nothing.
			if: { properties: { a: { const: "x" } } },
			then: { properties: { j: { description: "A j.", type: "string" } } },
			$defs: {
				described: { description: "A described thing.", type: "string" },
				through: { $ref: "#/$defs/described" },
				bare: { type: "string" },
			},
		});
		expect(undescribedFields(described)).toEqual([]);
	});
});
