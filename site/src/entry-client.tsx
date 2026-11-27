// The browser's entry (scripts/build.ts writes it as the page's one <script type="module">, which
// runs once the HTML is parsed): Solid takes over the page the build rendered, without rendering
// it again (the body is the application's island; Document.tsx), and from then on Solid Router
// does the navigation (src/app.tsx).
//
// It takes over only once the reader has seen the page: after the browser reports the page's
// first contentful paint (painted() says what it waits for where the browser cannot report it).
// Hydration takes the main thread for its whole length (tens of milliseconds on a phone), so
// started any earlier it would put off the first frame the reader sees (ADR-0036).
// Until it has run, a link is an ordinary link. The marks "hydrate" and "hydrated" say when it
// started and ended (scripts/check-browser.ts and measure-navigation.ts read them).
import { hydrate } from "@solidjs/web";
import { App } from "./app";

/** Resolves once the body is shown: when the inline script in <head> (Document.tsx) has taken away its class "font-loading", or at once if it never set it. */
function shown(): Promise<void> {
	return new Promise((resolve) => {
		const root = document.documentElement;
		if (!root.classList.contains("font-loading")) return resolve();
		const observer = new MutationObserver(() => {
			if (root.classList.contains("font-loading")) return;
			observer.disconnect();
			resolve();
		});
		observer.observe(root, { attributes: true, attributeFilter: ["class"] });
	});
}

/**
 * Resolves once the page has had its first contentful paint. In a browser without Paint Timing,
 * once a frame has been painted with the page's text: the text waits for the font of the reader's
 * colour scheme (font-display: block in site.css; the face is chosen as Document.tsx chooses it)
 * and for the body to be shown; then a callback of the frame after the next (an animation frame
 * asked for inside one) runs only once the next has been painted.
 */
function painted(): Promise<void> {
	return new Promise((resolve) => {
		if (performance.getEntriesByName("first-contentful-paint").length > 0) return resolve();
		if (!PerformanceObserver.supportedEntryTypes?.includes("paint")) {
			const face = matchMedia("(prefers-color-scheme: light)").matches ? "Square" : "Circle";
			return void document.fonts
				.load(`1em "Geist Pixel ${face}"`)
				.catch(() => [])
				.then(shown)
				.then(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		}
		const observer = new PerformanceObserver((list) => {
			if (list.getEntriesByName("first-contentful-paint").length === 0) return;
			observer.disconnect();
			resolve();
		});
		observer.observe({ type: "paint", buffered: true });
	});
}

painted().then(() => {
	performance.mark("hydrate");
	hydrate(() => <App />, document.body);
	performance.mark("hydrated");
});
