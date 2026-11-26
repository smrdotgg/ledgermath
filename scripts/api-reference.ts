/**
 * Writes the data API's reference, as Markdown, into a directory (scripts/lib/api-reference.ts):
 *
 *     bun scripts/api-reference.ts --out DIR
 *
 * DIR/docs/api/index.md (the overview), DIR/docs/api/<page>.md (one page per kind of file,
 * from its schema, with an example from the fixed sample in docs/api-sample/) and
 * DIR/docs/machines.md (from schedule.json). The pages are generated, never kept in the
 * repository: the site's build writes them. Nothing is written when any of the files is already
 * there. Same input, same bytes.
 *
 * Exit 0 when written, 1 when not (with why), 2 on a bad command line.
 */

import { writeApiReference } from "./lib/api-reference";

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const at = argv.indexOf("--out");
	const out = at === -1 ? undefined : argv[at + 1];
	if (out === undefined || out === "" || out.startsWith("--")) {
		console.error("usage: bun scripts/api-reference.ts --out DIR");
		process.exit(2);
	}
	try {
		const files = writeApiReference(out);
		console.log(`wrote ${files.length} pages under ${out}: ${files.join(", ")}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
