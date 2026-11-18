/**
 * Serves the built site (dist/client) as a static host would: each file as it
 * is, a directory's index.html for the directory, 404 for anything else. For
 * looking at the build locally; nothing else.
 *
 *     bun scripts/serve.ts [PORT]
 */

import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

const root = join(import.meta.dir, "..", "dist", "client");
const port = Number(process.argv[2] ?? 4173);

const server = Bun.serve({
	port,
	hostname: "127.0.0.1",
	fetch(request) {
		const path = normalize(decodeURIComponent(new URL(request.url).pathname));
		let file = join(root, path);
		if (file !== root && !file.startsWith(root + "/")) return new Response("Not found", { status: 404 });
		if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
		if (!existsSync(file)) return new Response("Not found", { status: 404 });
		return new Response(Bun.file(file));
	},
});

console.log(`serving ${root} at ${server.url}`);
