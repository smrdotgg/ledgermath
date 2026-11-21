/**
 * Reads the report `bun test --reporter=junit --reporter-outfile FILE` writes:
 * one entry per test case, with whether it failed. A test that runs `bun test`
 * in a child process counts results from this file, never from the console's
 * printed lines, whose form changes with the environment (under GitHub
 * Actions, Bun prints each failure a second time in a recap).
 */

export interface TestCase {
	file: string;
	/** The innermost describe's name, as Bun writes it. */
	classname: string;
	name: string;
	failed: boolean;
	skipped: boolean;
}

const decode = (text: string): string =>
	text
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#10;/g, "\n")
		.replace(/&amp;/g, "&");

/** Every test case of a JUnit report, in the order it lists them. */
export function readJunit(xml: string): TestCase[] {
	if (!xml.includes("<testsuites")) throw new Error(`not a JUnit report: ${xml.slice(0, 200)}`);
	const cases: TestCase[] = [];
	for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
		const attributes = Object.fromEntries([...(match[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)].map((attribute) => [attribute[1], decode(attribute[2] ?? "")]));
		const body = match[2] ?? "";
		cases.push({
			file: attributes.file ?? "",
			classname: attributes.classname ?? "",
			name: attributes.name ?? "",
			failed: /<(failure|error)\b/.test(body),
			skipped: /<skipped\b/.test(body),
		});
	}
	return cases;
}

/** The distinct failed test cases of a report, each once, as "<file> > <classname> > <name>". */
export function failedTests(xml: string): string[] {
	return [...new Set(readJunit(xml).filter((entry) => entry.failed).map((entry) => `${entry.file} > ${entry.classname} > ${entry.name}`))].sort();
}
