import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

// Start mode with ssr: `vite build` writes the client to dist/client and a
// server bundle to dist/server. scripts/prerender.ts then renders the page
// once with that bundle into dist/client/index.html and removes dist/server,
// so what is left is static files.
export default defineConfig({
	plugins: [solid({ start: true, ssr: true })],
});
