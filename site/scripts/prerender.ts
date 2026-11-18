/**
 * Prerenders the site after `vite build`: asks the server bundle that build
 * wrote (dist/server/server.js) for each page once, writes the HTML into
 * dist/client, then removes dist/server. dist/client is then the whole site,
 * plain files for any static host.
 *
 *     bun scripts/prerender.ts
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PAGES = ["/"];

const site = join(import.meta.dir, "..", "dist");
const client = join(site, "client");
const server = join(site, "server", "server.js");

const { handleRequest } = (await import(server)) as {
	handleRequest(request: Request): Promise<Response>;
};

for (const page of PAGES) {
	const response = await handleRequest(new Request(new URL(page, "http://localhost")));
	if (response.status !== 200) throw new Error(`${page}: the server bundle answered ${response.status}`);
	const file = join(client, page.endsWith("/") ? `${page}index.html` : `${page}.html`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, await response.text());
	console.log(`prerendered ${page} -> ${file.slice(site.length + 1)}`);
}

rmSync(join(site, "server"), { recursive: true });
