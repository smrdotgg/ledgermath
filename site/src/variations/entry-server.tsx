// The server entry every page of the variations is built from (scripts/variations/lib.ts):
// "@slot" is the directory being built (src/variations/v<n>/, or src/picker/). It renders the
// slot's Document around its Page once, at build time, to static HTML; nothing hydrates.
import { renderToString } from "@solidjs/web";
import Document from "@slot/Document";
import Page from "@slot/Page";

export function render(): string {
	return renderToString(() => (
		<Document>
			<Page />
		</Document>
	));
}
